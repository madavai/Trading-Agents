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

/** What a rating claims its stock does against the index, in words: "beats", "trails", or '' for no direction. */
const claimOf = (rating: string): string => (ratingTone(rating) === 'ok' ? 'beats' : ratingTone(rating) === 'danger' ? 'trails' : '');
const article = (word: string): string => (/^[AEIOU]/i.test(word) ? 'An' : 'A');

/** A scored call's result as the page shows it: its colour, its words, why (when pointed at) and its verdict in a few
 *  words. All follow whether the call went the way its rating said (`worked`, which the desk works out with the
 *  scorecard's own rule), never the alpha's sign alone: an Underweight whose stock trailed its index worked, though its
 *  alpha is below zero. A call that claims no direction (a Hold) is plain, and says so. `days` is its holding window. */
export function resultOf(c: { rating: string; alpha: string | null; worked: boolean | null }, days: number): { tone: '' | 'ok' | 'danger'; words: string; why: string; verdict: string } {
  const alpha = `alpha ${c.alpha ?? '—'}`, claim = claimOf(c.rating);
  if (c.worked === null || !claim) {
    return c.rating === 'Hold'
      ? { tone: '', words: alpha, verdict: 'a Hold claims no direction', why: `A Hold claims no direction, so it neither worked nor failed: its ${alpha} only says how the stock did against its market's index over the ${days} trading days after the call.` }
      : { tone: '', words: alpha, verdict: '', why: means('alpha') };
  }
  const how = `${article(c.rating)} ${c.rating} works when the stock ${claim} its market's index over the ${days} trading days after the call.`;
  return c.worked
    ? { tone: 'ok', words: `worked · ${alpha}`, verdict: 'the call worked', why: `${how} It did (${alpha}): the call worked.` }
    : { tone: 'danger', words: `did not work · ${alpha}`, verdict: 'the call did not work', why: `${how} It did not (${alpha}): the call did not work.` };
}

/** One rating's average alpha on the scorecard: green when, on average, its calls went the way the rating said, red when
 *  they went against it, plain for a Hold (no direction) or an average that rounds to zero; and why, in words. */
export function averageOf(rating: string, s: { direction: number; meanAlpha: number }): { tone: '' | 'ta-up' | 'ta-down'; why: string } {
  const shown = Math.round(s.meanAlpha * 1000) / 10, by = `${Math.abs(shown).toFixed(1)}%`;   // as the scorecard prints it, to 0.1 of a point
  if (!s.direction) return { tone: '', why: `${article(rating)} ${rating} claims no direction: its average alpha only says how its stocks did against their index.` };
  if (shown === 0) return { tone: '', why: `On average the stocks rated ${rating} ended level with their index.` };
  const beat = shown > 0, good = (shown > 0) === (s.direction > 0);
  return { tone: good ? 'ta-up' : 'ta-down', why: `On average the stocks rated ${rating} ${beat ? 'beat' : 'trailed'} their index by ${by}: on average these calls ${good ? 'worked' : 'did not work'}.` };
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
