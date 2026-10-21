// How numbers and words are written on the page. A number that is missing is a dash, never a zero.
import { GLOSSARY, isTerm, means } from './glossary.js';

const MINUS = '−';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const num = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const money = (n: number | null | undefined, currency = 'USD'): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? MINUS : '', abs = Math.abs(n);
  const sym = currency === 'USD' ? '$' : '';
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${sym}${body}${sym ? '' : ` ${currency}`}`;
};

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : MINUS}${Math.abs(n).toFixed(2)}%`;

export const tone = (n: number | null | undefined): '' | 'ok' | 'danger' => (n === null || n === undefined || !Number.isFinite(n) ? '' : n >= 0 ? 'ok' : 'danger');

export const ratingTone = (r: string): '' | 'ok' | 'danger' | 'warn' =>
  r === 'Buy' || r === 'Overweight' ? 'ok' : r === 'Underweight' || r === 'Sell' ? 'danger' : r === 'Hold' ? '' : 'warn';

/** A rating's meaning in one plain line, from the glossary, with what its ticket (and paper) does as shipped; '' for one
 *  the desk does not use. */
export const ratingMeaning = (r: string): string => (isTerm(r) && GLOSSARY[r].group === GLOSSARY.Buy.group ? means(r) : '');

/** Why a mark is there, each in one plain line. The trading words themselves are in the glossary (glossary.ts). */
export const NOTES = {
  coinOnPaper: "Robinhood's agent doorway trades stocks and funds, so a coin never gets an order ticket.",
  noTicket: 'No order ticket: Robinhood\'s agent doorway trades stocks and funds, and among crypto the desk follows only Bitcoin and Ether on paper.',
  noView: "No view yet: the desk has not analysed it. Ask it to (the robot); in the Agentic account, Monday's morning routine rates it.",
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

export const SECTION_NAMES: Record<string, string> = {
  market: 'Market report', sentiment: 'Sentiment report', news: 'News report', fundamentals: 'Fundamentals report',
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

/** A report's opening, as a preview: its first sentence in plain words (headings left out), at most n characters. */
export function opening(md: string, n = 160): string {
  const text = plain(md.split('\n').filter((l) => !/^\s{0,3}#/.test(l)).join('\n'));
  const s = /^(.{12,}?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The last daily bar on or before a day (YYYY-MM-DD), from bars in date order; null when the bars start after it. */
export function barOn<T extends { date: string }>(bars: readonly T[], day: string): T | null {
  let hit: T | null = null;
  for (const b of bars) { if (b.date.slice(0, 10) <= day) hit = b; else break; }
  return hit;
}
