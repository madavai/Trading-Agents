// How numbers and words are written on the page. A number that is missing is a dash, never a zero.
import { GLOSSARY, isTerm, means } from './glossary.js';
import { LATE, type PriceMarket } from '../../data/delay.js';

const MINUS = '−';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const num = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** A quantity of shares or coins as Robinhood counts it: a whole number plainly ("12"), a fraction in full ("0.18",
 *  "0.000123"), never rounded to a whole share or to four places. Up to eight decimals, the finest a coin is counted in. */
export const qty = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 8 });

export const money = (n: number | null | undefined, currency = 'USD'): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n), sym = currency === 'USD' ? '$' : '';
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 && /[1-9]/.test(body) ? MINUS : '';   // what rounds to $0.00 is written without a minus
  return `${sign}${sym}${body}${sym ? '' : ` ${currency}`}`;
};

/** A change in percent (1.2 is 1.2%) with its sign, to `d` decimals; what rounds to zero is plain "0.00%", never "−0.00%". */
export const pct = (n: number | null | undefined, d = 2): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const body = Math.abs(n).toFixed(d);
  return `${Number(body) === 0 ? '' : n > 0 ? '+' : MINUS}${body}%`;
};

export const tone = (n: number | null | undefined): '' | 'ok' | 'danger' => (n === null || n === undefined || !Number.isFinite(n) ? '' : n >= 0 ? 'ok' : 'danger');

export const ratingTone = (r: string): '' | 'ok' | 'danger' | 'warn' =>
  r === 'Buy' || r === 'Overweight' ? 'ok' : r === 'Underweight' || r === 'Sell' ? 'danger' : r === 'Hold' ? '' : 'warn';

/** A rating's meaning in one plain line, from the glossary, with what its ticket (and paper) does as shipped; '' for one
 *  the desk does not use. */
export const ratingMeaning = (r: string): string => (isTerm(r) && GLOSSARY[r].group === GLOSSARY.Buy.group ? means(r) : '');

/** What a rating claims its stock does against the index, in words: "beats", "trails", or '' for no direction; for a call
 *  scored on its own return, "rises" or "falls". */
const claimOf = (rating: string, own = false): string => (ratingTone(rating) === 'ok' ? (own ? 'rises' : 'beats') : ratingTone(rating) === 'danger' ? (own ? 'falls' : 'trails') : '');
const article = (word: string): string => (/^[AEIOU]/i.test(word) ? 'An' : 'A');

/** What a call is scored by, in words: "SPY over the 5 trading days after the call". */
export const scoredOver = (c: { yardstick: string; window: string }): string => `${c.yardstick} over the ${c.window} after the call`;
/** How a call is measured, in words: "against SPY over the 5 trading days after the call", or for a call scored on its
 *  own return (one on its yardstick, or a fund that copies the same index) "on its own return over the 5 trading days
 *  after the call". */
export const againstOver = (c: { yardstick: string; window: string; own?: boolean }): string =>
  (c.own ? `on its own return over the ${c.window} after the call` : `against ${scoredOver(c)}`);
/** Why a call has its yardstick, as a sentence after the rest; '' when there is nothing to add. */
export const yardstickWhy = (c: { yardstick: string; why: string; own?: boolean }): string =>
  (c.why ? (c.own ? ` Scored on its own return: ${c.why}.` : ` Against ${c.yardstick}: ${c.why}.`) : '');
/** A scored call's figure, named as what it is: its alpha, or for a call scored on its own return, its return. */
export const scoreWords = (c: { alpha: string | null; own?: boolean }): string => `${c.own ? 'its return' : 'alpha'} ${c.alpha ?? '—'}`;
/** Its first check named, and that it is not the horizon: "It is a first-week check, not the call's own time horizon." */
export const notHorizon = (c: { check: string }): string => `It is ${c.check}, not the call's own time horizon.`;

/** A scored call's result as the page shows it: its colour, its words, why (when pointed at) and its verdict in a few
 *  words. All follow whether the call went the way its rating said (`worked`, which the desk works out with the
 *  scorecard's own rule), never the alpha's sign alone: an Underweight whose stock trailed its yardstick worked, though
 *  its alpha is below zero. A call that claims no direction (a Hold) is plain, and says so. The call's own window and
 *  yardstick are named, and that its score is a first check, not its time horizon. */
export function resultOf(c: { rating: string; alpha: string | null; worked: boolean | null; yardstick: string; window: string; check: string; why: string; own?: boolean; noun?: 'stock' | 'coin' | 'fund' }): { tone: '' | 'ok' | 'danger'; words: string; why: string; verdict: string } {
  const alpha = scoreWords(c), claim = claimOf(c.rating, c.own), over = c.own ? `over the ${c.window} after the call` : scoredOver(c), noun = `the ${c.noun ?? 'stock'}`;
  const tail = ` ${notHorizon(c)}${yardstickWhy(c)}`;
  if (c.worked === null || !claim) {
    return c.rating === 'Hold'
      ? { tone: '', words: alpha, verdict: 'a Hold claims no direction', why: `A Hold claims no direction, so it neither worked nor failed: ${c.own ? `its return only says how ${noun} did ${over}` : `its ${alpha} only says how ${noun} did against ${over}`}.${tail}` }
      : { tone: '', words: alpha, verdict: '', why: `${c.own ? `Its return over the ${c.window} after the call: it is scored on its own return, not against ${c.yardstick}.` : means('alpha')}${tail}` };
  }
  const how = `${article(c.rating)} ${c.rating} works when ${noun} ${claim} ${over}.`;
  return c.worked
    ? { tone: 'ok', words: `worked · ${alpha}`, verdict: 'the call worked', why: `${how} It did (${alpha}): the call worked.${tail}` }
    : { tone: 'danger', words: `did not work · ${alpha}`, verdict: 'the call did not work', why: `${how} It did not (${alpha}): the call did not work.${tail}` };
}

/** One rating's average alpha on the scorecard: green when, on average, its calls went the way the rating said, red when
 *  they went against it, plain for a Hold (no direction) or an average that rounds to zero; and why, in words. */
export function averageOf(rating: string, s: { direction: number; meanAlpha: number }): { tone: '' | 'ta-up' | 'ta-down'; why: string } {
  const shown = Math.round(s.meanAlpha * 1000) / 10, by = `${Math.abs(shown).toFixed(1)}%`;   // as the scorecard prints it, to 0.1 of a point
  if (!s.direction) return { tone: '', why: `${article(rating)} ${rating} claims no direction: its average alpha only says how what the desk rated ${rating} did against its yardstick in each call's first check.` };
  if (shown === 0) return { tone: '', why: `On average, what the desk rated ${rating} ended level with its yardstick in each call's first check.` };
  const beat = shown > 0, good = (shown > 0) === (s.direction > 0);
  return { tone: good ? 'ta-up' : 'ta-down', why: `On average, what the desk rated ${rating} ${beat ? 'beat' : 'trailed'} its yardstick by ${by} in each call's first check: on average these calls ${good ? 'worked' : 'did not work'} so far.` };
}

/** The scorecard's line for the calls scored on their own return, which its averages against the yardstick leave out:
 *  their return is how far the fund rose or fell, not how far it beat anything. `ratings` in the scorecard's order. */
export function ownReturnLine(own: Record<string, { count: number; worked: number | null; meanReturn: number }>, ratings: string[]): string {
  const n = ratings.reduce((s, r) => s + (own[r]?.count ?? 0), 0), calls = (k: number) => `${k} ${k === 1 ? 'call' : 'calls'}`;
  const parts = ratings.filter((r) => own[r]).map((r) => {
    const o = own[r]!;
    return `${r}: ${calls(o.count)}, ${o.worked === null ? 'no direction claimed' : `${o.worked} of ${o.count} worked`}, average return ${pct(o.meanReturn * 100, 1)}`;
  });
  return `Left out of the table: ${calls(n)} on the yardstick itself or a fund that copies the same index, scored on ${n === 1 ? 'its' : 'their'} own return rather than against it. ${parts.join('; ')}.`;
}

/** Why a mark is there, each in one plain line. The trading words themselves are in the glossary (glossary.ts). */
export const NOTES = {
  coinOnPaper: "Robinhood's agent doorway trades stocks and funds, so a coin never gets an order ticket.",
  noTicket: 'No order ticket: Robinhood\'s agent doorway trades stocks and funds, and among crypto the desk follows only Bitcoin and Ether on paper.',
  noView: "No view yet: the desk has not analysed it. Ask it to (the robot); in the Agentic account, Monday's morning routine rates it.",
  stopWatch: "A stop is the desk's trader's, watched against Yahoo Finance's price only while this page is open in a browser. With the page closed nothing watches it: the evening wrap-up names any holding whose last close is below its stop, but only when it runs (your routines switched on in Madav, or asked for in a chat). It only reports.",
} as const;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-09 as "9 Oct 2026". */
export const dayText = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : iso;
};
/** The shortest chart range that reaches back to `day` from `today` (with a week to spare, so the close before the call
 *  is in it too, across a weekend or a holiday): a call of last week reads the month, one of last year the five years. */
export function rangeFor(day: string, today: string): '1M' | '3M' | '6M' | '1Y' | '5Y' {
  const ago = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000 + 7;
  return ago <= 31 ? '1M' : ago <= 92 ? '3M' : ago <= 183 ? '6M' : ago <= 366 ? '1Y' : '5Y';   // the chart's spans, in days
}
/** 2026-10-09 as "9 Oct". */
export const shortDay = (iso: string): string => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso); return m ? `${Number(m[2])} ${MON[Number(m[1]) - 1]}` : iso; };
export const clock = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 2026-11-06 as "Fri 6 Nov". */
export const weekDay = (day: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m ? `${WEEKDAY[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).getUTCDay()]} ${Number(m[3])} ${MON[Number(m[2]) - 1]}` : day;
};
/** The day an instant falls on in New York, the desk's day and the US market's ("2026-11-06"); '' for no instant. */
export const nyDay = (at: string | number | Date): string => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
/** The trading day a price's move belongs to, when it is not today in New York ("2026-11-06"); '' when it is today's.
 *  On a Saturday, a quote's "day" is Friday's session: the page names it rather than calling it today. */
export const moveDayOf = (asOf: string, now: Date = new Date()): string => { const d = nyDay(asOf); return d && d !== nyDay(now) ? d : ''; };
/** A past trading day, short, for a chip: its weekday within the last six days ("Fri"), else its date ("6 Nov"). */
export const chipDay = (day: string, now: Date = new Date()): string => {
  const ago = (Date.parse(`${nyDay(now)}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000;
  return ago > 0 && ago < 7 ? weekDay(day).split(' ')[0]! : shortDay(day);
};
/** A time the page shows: the clock alone when it is today, else with its day ("Sat 24 Oct, 12:54 AM"), and its year
 *  when another year's. Times are the person's own, as their computer keeps them. */
export const when = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (local(d) === local(now)) return clock(iso);
  return `${d.getFullYear() === now.getFullYear() ? weekDay(local(d)) : `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`}, ${clock(iso)}`;
};
/** A price and its move in words, saying which day they are: while the market is open, "$188.08 (+1.20% today) on Yahoo
 *  Finance, real-time" (how late it may be, as far as that is known: data/delay.ts); after today's close, "$188.08,
 *  today's close (+1.20% today)"; on a weekend or before the open, "$188.08, the close of Fri 6 Nov (+1.20% that day)",
 *  never "today". A close is final, so nothing is said of lateness beside one. */
export const priceDayWords = (price: string, move: string | null, q: { open: boolean; asOf: string; market?: PriceMarket }, now: Date = new Date()): string => {
  if (q.open) return `${price}${move ? ` (${move} today)` : ''} on Yahoo Finance, ${LATE[q.market ?? 'other']}`;
  const day = moveDayOf(q.asOf, now);
  return day ? `${price}, the close of ${weekDay(day)}${move ? ` (${move} that day)` : ''}, from Yahoo Finance`
    : `${price}, today's close${move ? ` (${move} today)` : ''}, from Yahoo Finance`;
};
/** A change in a rate that is itself a percent (a bond's yield), in percentage points: 4.84% to 4.86% is "+0.02 points",
 *  never "+0.41%", which would be a percent of a percent. */
export const points = (n: number | null | undefined, d = 2): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const body = Math.abs(n).toFixed(d);
  return `${Number(body) === 0 ? '' : n > 0 ? '+' : MINUS}${body} ${Number(body) === 1 ? 'point' : 'points'}`;
};

export const SECTION_NAMES: Record<string, string> = {
  market: 'Market report', sentiment: 'Sentiment report', news: 'News report', fundamentals: 'Fundamentals report', fact_check: 'Fact check',
  bull: 'Bull case', bear: 'Bear case', research_plan: 'Research plan', trader: "Trader's proposal",
  aggressive: 'Aggressive risk voice', conservative: 'Conservative risk voice', neutral: 'Neutral risk voice', decision: "Portfolio manager's decision",
};

/** The agents' markdown as plain words: headings, bold, slanting, code, list marks and table rows taken out, lines joined. */
export const plain = (md: string): string => md.replace(/\r\n/g, '\n')
  .replace(/^\s*\|.*$/gm, '').replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1')
  .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/\s+/g, ' ').trim();

/** A labelled line of the portfolio manager's decision ("**Price Target**: ..."), in plain words; '' when it is not there. */
export function labelled(md: string, label: string): string {
  const m = new RegExp(`\\*\\*${label}:?\\*\\*:?[ \\t]*([^\\n]+)`, 'i').exec(md);
  return m ? plain(m[1]!) : '';
}

/** A report's opening, as a preview: its first sentence in plain words, at most n characters. Headings are left out,
 *  and so are headings written in bold: a line that is only bold words, and a bold lead-in that is a sentence of its own
 *  ("**Data note and verification.** Instrument confirmed ...", which would preview as the label alone). A bold label
 *  that introduces a value ("**Rating**: Overweight") stays. */
export function opening(md: string, n = 160): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s{0,3}#/.test(l));
  const body = lines.filter((l) => !/^\s*(?:[-*+]\s+)?\*\*[^*\n]+\*\*[\s:.]*$/.test(l)).map((l) => l.replace(/^(\s*(?:[-*+]\s+)?)\*\*[^*\n]*[.!?]\*\*\s*/, '$1'));
  const text = plain(body.join('\n')) || plain(lines.join('\n'));
  const s = /^(.{12,}?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The last daily bar on or before a day (YYYY-MM-DD), from bars in date order; null when the bars start after it. */
export function barOn<T extends { date: string }>(bars: readonly T[], day: string): T | null {
  let hit: T | null = null;
  for (const b of bars) { if (b.date.slice(0, 10) <= day) hit = b; else break; }
  return hit;
}
