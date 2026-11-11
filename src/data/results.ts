// When a company reports its results, from its own filings with the SEC. A US company files each results release on form
// 8-K under item 2.02 ("Results of Operations and Financial Condition"); the SEC records the minute it accepted each
// filing, and the filing gives the date of the event it reports. So the desk lists the releases a company filed in the
// year to the analysis date, the first session that could trade on each (a release after the close trades the next market
// day) and how that session closed. The date of the next release is not in the filings: a company announces it in a press
// release, which it does not file. So the desk says it is not known, rather than leave an agent to work one out. In the
// runs of 9 and 10 Nov 2026, with no such source, agents dated NVIDIA's results by a prediction market's closing date (a
// day late) and Meta's by the spacing of its filings (six days early), and priced Meta's results days, its four biggest
// moves of the year, as a 1-in-252 chance.
import { addDays, nyClock } from './dates.js';
import { closeOf, isMarketDay, marketClosed, nextMarketDay } from './holidays.js';
import { submissionsPage, type Filings, type Submissions } from './sec.js';
import type { Bar } from './yahoo.js';

/** A results release as the SEC lists it: the day it was filed, the moment the SEC accepted it (ms) when given, the date
 *  the filing gives its earliest event (`dated`, the release's own date when it reports nothing else) and its items. */
export interface Release { filed: string; accepted: number | null; dated?: string; items: string[] }

/** The results releases in these lists of filings (form 8-K with item 2.02; never an amendment, which corrects one) filed
 *  from `from` to `day`, both included, oldest first and each once. Exported for the tests. */
export function releasesIn(lists: readonly Filings[], from: string, day: string): Release[] {
  const seen = new Map<string, Release>();
  for (const l of lists) {
    (l.form ?? []).forEach((form, i) => {
      const filed = l.filingDate?.[i] ?? '', items = (l.items?.[i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (form !== '8-K' || !items.includes('2.02') || filed < from || filed > day) return;
      const at = Date.parse(l.acceptanceDateTime?.[i] ?? ''), key = l.accessionNumber?.[i] ?? `${filed}|${i}`, dated = l.reportDate?.[i];
      if (!seen.has(key)) seen.set(key, { filed, accepted: Number.isFinite(at) ? at : null, items, ...(dated && /^\d{4}-\d{2}-\d{2}$/.test(dated) ? { dated } : {}) });
    });
  }
  return [...seen.values()].sort((a, b) => a.filed.localeCompare(b.filed) || (a.accepted ?? 0) - (b.accepted ?? 0));
}

/** The filer's filings from `from` to `day`: its latest ones, and when they do not reach back that far, the pages of older
 *  ones that cover those days. `short` says why the list may start later than `from`. */
async function filingsFrom(s: Submissions, from: string, day: string): Promise<{ lists: Filings[]; short?: string }> {
  const recent = s.filings?.recent ?? {}, oldest = recent.filingDate?.at(-1);
  if (!oldest || oldest <= from) return { lists: [recent] };
  const pages = (s.filings?.files ?? []).filter((p) => p.name && (p.filingTo ?? '9999') >= from && (p.filingFrom ?? '') <= day);
  try {
    return { lists: [recent, ...await Promise.all(pages.map((p) => submissionsPage(p.name!)))] };
  } catch (e) {
    return { lists: [recent], short: `the SEC's older pages of its filings could not be read (${(e as Error).message}), so releases filed before ${oldest} are not listed` };
  }
}

/** Whether `day` had a session: by the price table's sessions (`dates`, oldest first) within them, by New York's market
 *  calendar outside them; and the first session after it. */
const hadSession = (day: string, dates: readonly string[]) => (dates.length > 0 && day >= dates[0]! && day <= dates.at(-1)! ? dates.includes(day) : isMarketDay(day));
const sessionAfter = (day: string, dates: readonly string[]) => dates.find((d) => d > day) ?? nextMarketDay(day);

/** The first session that could trade on a filing the SEC accepted at `accepted`: the same day's when it came before that
 *  day's close, else the next one. Exported for the tests. */
export function firstSession(accepted: number, dates: readonly string[]): { day: string; time: string; when: string; session: string } {
  const [day, time] = nyClock(accepted).split(' ') as [string, string];
  const open = hadSession(day, dates);
  if (open && time < '09:30') return { day, time, when: 'before the open', session: day };
  if (open && time < closeOf(day)) return { day, time, when: 'during the session', session: day };
  if (open) return { day, time, when: 'after the close', session: sessionAfter(day, dates) };
  return { day, time, when: `on a day with no session (${marketClosed(day) ?? 'none in the price table'})`, session: sessionAfter(day, dates) };
}

const pct = (n: number) => Math.abs(n).toFixed(2), cents = (n: number) => Math.round(n * 100) / 100;
const price = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What became of one release: its first session and how that session closed against the one before, from the price
 *  table (`bars`, oldest first; `open` when its last row is a session still trading). A filing that dates the release
 *  before the day it was filed (one that reports the results alone) puts it there: a company that publishes on a
 *  Saturday files on the Monday. */
function releaseLine(r: Release, bars: readonly Bar[], open: boolean, day: string): string {
  if (r.accepted === null) return `- ${r.filed}: the SEC's list gives no time for it, so the first session that could trade on it is not worked out`;
  const dates = bars.map((b) => b.date), s = firstSession(r.accepted, dates);
  let head = `- ${r.filed}, accepted at ${s.time} New York time${s.day !== r.filed ? ` on ${s.day}` : ''}, ${s.when}`, session = s.session, note = '';
  if (r.dated && r.dated < s.day) {
    if (r.items.every((i) => i === '2.02' || i === '9.01')) {
      if (hadSession(r.dated, dates)) return `${head}; the filing dates the release ${r.dated}, a market day, without its time: first traded ${r.dated} or the session after, so how it closed is not worked out`;
      head += `; the filing dates the release ${r.dated} (${marketClosed(r.dated) ?? 'a day with no session in the price table'}), before it was filed`;
      session = sessionAfter(r.dated, dates);
    } else note = `. Its filing also reports another event, dated ${r.dated}, so it does not date the release itself: this is the first session after the filing, and the release may have come out before it`;
  }
  if (session > day) return `${head}: first session ${session}, after the analysis date${note}`;
  const at = dates.indexOf(session), bar = bars[at], before = bars[at - 1];
  if (!bar && (!bars.length || session > dates.at(-1)!)) return `${head}: first session ${session}, which the price table read here does not reach yet${note}`;
  if (!bar || !before) return `${head}: first traded ${session} (the price table read here has no ${bar ? 'session before it' : 'row for it'}, so how it closed is not worked out)${note}`;
  if (open && at === bars.length - 1) return `${head}: first traded ${session}, a session still trading: no close yet${note}`;
  // Worked out from the closes as shown (to the cent), so the same sum on them gives the same change.
  const a = cents(before.close), b = cents(bar.close), change = (b / a - 1) * 100;
  const moved = Math.abs(change) < 0.005 ? 'closed unchanged' : `closed ${pct(change)}% ${change > 0 ? 'higher' : 'lower'}`;
  return `${head}: first traded ${session}, which ${moved} (${price(a)} on ${before.date} to ${price(b)} on ${bar.date})${note}`;
}

/** That the next results date is not known, and what it is never taken from. */
const next = (spacing: string) => `Next results date: not known. The desk reads no date for it: a company announces when it will report in a press release, which it does not file with the SEC, and the desk has no other source for it. Do not work one out from the spacing of ${spacing}, and do not take one from a prediction market's closing date (when the market stops trading) or from a news article.`;

/** The results section of a US filer's company overview, as known on `day`: its results releases of the year to it, with
 *  the first session that traded each and how it closed (from `bars`, the price table read for the valuation, empty when
 *  it could not be read), and that the next date is not known. A foreign filer's results come on form 6-K, which names
 *  no items, and a fund has none. */
export async function resultsLines(sym: string, s: Submissions, day: string, bars: readonly Bar[], open: boolean, kind: { foreign: string | null; fund: boolean }): Promise<string[]> {
  if (kind.fund) return [`Results releases: none. ${sym} is a fund, and a fund has no results releases or results dates: what it holds, which get_fund_profile reads, is its fundamentals.`];
  if (kind.foreign) return [`Results releases: not known from its filings. ${sym} files with the SEC as a foreign company (its yearly report is a form ${kind.foreign}), and such a company files its results on form 6-K, which names no items, so the desk cannot tell its results from its other reports. ${next('its filings')}`];
  const from = addDays(day, -364), { lists, short } = await filingsFrom(s, from, day), releases = releasesIn(lists, from, day);
  const why = short ? ` (${short})` : '';
  if (!releases.length) return [`Results releases: none filed from ${from} to ${day} (form 8-K, item 2.02)${why}. A company may publish its results only in its quarterly and yearly reports (forms 10-Q and 10-K), which get_financial_statement reads; the days those were filed are not results dates. ${next('its filings')}`];
  return [
    `Results releases filed from ${from} to ${day}, oldest first${why}: each is a form 8-K with item 2.02 ("Results of Operations and Financial Condition"), under which a US company files its results release. Each gives the minute the SEC accepted the filing (a company may send the release out before it files it; when that was on an earlier day, the filing gives that day), the first session that could trade on it (a release after the close trades the next market day), and how that session closed against the one before, from the checked price table (whose closes are lowered by any dividend paid since, so a little below the prices traded then for a company that pays one):`,
    ...releases.map((r) => releaseLine(r, bars, open, day)),
    next('the dates above or its other filings'),
  ];
}
