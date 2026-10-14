// Backtesting: the same team run over a grid of stocks and past dates into a journal of its own, then the calls whose holding
// window has traded are scored by rating. One run gives one decision, which cannot say whether the desk decides well; the
// aggregate can. It judges decision quality only and is not a portfolio simulator: turning a rating into a filled order
// needs a quantity, a fill price and a cash ledger, none of which exist here, and inventing them would put an execution
// model behind an evaluation tool. Cells are independent.
// Adapted from TradingAgents (tradingagents/backtest.py), Apache License 2.0; rewritten in TypeScript.
import { addDays, parseDate, today } from '../data/dates.js';
import { safeSymbol } from '../data/symbols.js';
import type { Entry } from './journal.js';
import { REVIEW } from './rating.js';

export const MAX_CELLS = 100;
export const MAX_SYMBOLS = 10;

/** Analysis dates from `start` every `every` days, never past today: a future day has no outcome to score. */
export function iterGrid(start: string, end: string, every: number): string[] {
  const s = parseDate(start, 'start date'), e = parseDate(end, 'end date');
  if (!Number.isInteger(every) || every < 1) throw new Error('every must be a whole number of days, at least 1');
  if (e < s) throw new Error(`the grid ends before it starts: ${e} is before ${s}`);
  const last = e < today() ? e : today(), out: string[] = [];
  for (let d = s; d <= last; d = addDays(d, every)) out.push(d);
  if (!out.length) throw new Error(`the grid starts after today (${today()}): there is nothing to analyse yet`);
  return out;
}

export interface Cell { symbol: string; date: string }

/** Every stock on every date, a stock at a time. A stock or date given twice is one cell. */
export function cells(symbols: string[], dates: string[]): Cell[] {
  const syms = [...new Set(symbols.map((s) => safeSymbol(s)))];
  if (!syms.length) throw new Error('name at least one stock');
  if (syms.length > MAX_SYMBOLS) throw new Error(`${syms.length} stocks is more than a sweep takes (${MAX_SYMBOLS}): run them in separate sweeps`);
  const all = syms.flatMap((symbol) => [...new Set(dates)].map((date) => ({ symbol, date })));
  if (all.length > MAX_CELLS) throw new Error(`${all.length} cells is more than a sweep takes (${MAX_CELLS}); every cell is a full team run. Use fewer stocks, a shorter span or a longer step`);
  return all;
}

// What each rating claims will happen, so an outcome can be scored against it. Hold claims no direction, so nothing about
// alpha proves it right or wrong.
const DIRECTION: Record<string, number> = { Buy: 1, Overweight: 1, Hold: 0, Underweight: -1, Sell: -1 };

export interface RatingScore { count: number; hitRate: number | null; meanAlpha: number }
export interface Summary { resolved: number; pending: number; unscored: number; byRating: Record<string, RatingScore>; holding: string }

/** A settled entry's alpha as a fraction ("+7.1%" is 0.071), or null when it has none. The journal keeps one decimal of a
 *  percentage point, so aggregates are accurate to 0.1 of a point, not to the raw quote. */
const alphaOf = (e: Entry): number | null => {
  const t = (e.alpha ?? '').trim().replace(/%$/, '');
  const v = /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(v) ? v / 100 : null;
};

/** Scores the settled calls by rating. A call with no readable rating has no direction, so it counts neither for nor against
 *  the desk: it is reported as unscored. */
export function summarize(entries: Entry[]): Summary {
  const resolved = entries.filter((e) => !e.pending && e.rating !== REVIEW).map((e) => ({ e, a: alphaOf(e) })).filter((x): x is { e: Entry; a: number } => x.a !== null);
  const byRating: Record<string, RatingScore> = {};
  for (const rating of new Set(resolved.map((x) => x.e.rating))) {
    const alphas = resolved.filter((x) => x.e.rating === rating).map((x) => x.a), dir = DIRECTION[rating] ?? 0;
    byRating[rating] = { count: alphas.length, hitRate: dir ? alphas.filter((a) => a * dir > 0).length / alphas.length : null, meanAlpha: alphas.reduce((s, a) => s + a, 0) / alphas.length };
  }
  const unscored = entries.filter((e) => e.rating === REVIEW).length;
  const windows = [...new Set(resolved.map((x) => x.e.holding).filter((h): h is string => !!h && h.endsWith('d')).map((h) => `${h.slice(0, -1)} trading days`))].sort();
  return { resolved: resolved.length, pending: entries.length - resolved.length - unscored, unscored, byRating, holding: windows.join(', ') || 'the configured window' };
}

const pctText = (v: number) => `${v >= 0 ? '+' : '-'}${(Math.abs(v) * 100).toFixed(2)}%`;

export function renderSummary(s: Summary): string {
  const lines = [`Resolved cells: ${s.resolved} · pending: ${s.pending}${s.unscored ? ` · unscored: ${s.unscored}` : ''}`];
  for (const [rating, sc] of Object.entries(s.byRating)) {
    lines.push(`- ${rating}: n=${sc.count}, ${sc.hitRate !== null ? `called the direction ${Math.round(sc.hitRate * 100)}%` : 'no direction claimed'}, mean alpha ${pctText(sc.meanAlpha)} vs the benchmark`);
  }
  lines.push('');
  if (s.pending) lines.push('Pending cells are not scored above; settle them when their window has traded.');
  if (s.unscored) lines.push('Unscored cells had no readable rating (Needs review): they count neither for nor against the desk.');
  lines.push(`Alpha is measured over ${s.holding} after each analysis date. One model sampling per cell, and text feeds are not archived, so these figures are indicative rather than repeatable. A handful of cells proves nothing: a hit rate over fewer than about 30 calls per rating is noise.`);
  return lines.join('\n');
}
