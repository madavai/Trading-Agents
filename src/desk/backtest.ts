// Backtesting: the same team run over a grid of stocks and past dates into a journal of its own, then the calls whose holding
// window has traded are scored by rating. One run gives one decision, which cannot say whether the desk decides well; the
// aggregate can. It judges decision quality only and is not a portfolio simulator: turning a rating into a filled order
// needs a quantity, a fill price and a cash ledger, none of which exist here, and inventing them would put an execution
// model behind an evaluation tool. Cells are independent.
// Adapted from TradingAgents (tradingagents/backtest.py), Apache License 2.0; rewritten in TypeScript.
import { addDays, parseDate, today } from '../data/dates.js';
import { isCrypto, safeSymbol } from '../data/symbols.js';
import { ownReturn, windowWords } from './scoring.js';
import { signedPct } from '../numbers.js';
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

/** What a rating claims about its stock against its yardstick: 1 that it beats it, -1 that it trails it, 0 no direction (a
 *  Hold, or a rating the desk does not use). */
export const directionOf = (rating: string): number => DIRECTION[rating] ?? 0;

/** Whether a scored call went the way its rating said: true when the stock beat its yardstick after a Buy or Overweight, or
 *  trailed it after an Underweight or Sell; false when it did not (level with it included); null for a call that
 *  claims no direction or has no alpha. It is the scorecard's "called the direction", call by call, so the page's colours
 *  and words agree with the scorecard's count. The alpha's sign alone never says it: an Underweight that worked has an
 *  alpha below zero. */
export function worked(rating: string, alpha: number | null): boolean | null {
  const dir = directionOf(rating);
  return !dir || alpha === null || !Number.isFinite(alpha) ? null : alpha * dir > 0;
}

export interface RatingScore { count: number; direction: number; hitRate: number | null; meanAlpha: number }
/** One rating's calls scored on their own return (a call on the yardstick itself, or on a fund copying its index): how
 *  many, how many worked (null for a rating with no direction) and their average return, which is not a beat of anything. */
export interface OwnScore { count: number; worked: number | null; meanReturn: number }
/** `byRating`: the calls measured against a yardstick only; `ownReturn`: those scored on their own return, kept apart so
 *  no average against the yardstick is made of a return. `resolved` counts both. `holding`: the windows the scored calls
 *  were measured over, in words; `yardsticks`: those their entries keep. */
export interface Summary { resolved: number; pending: number; unscored: number; byRating: Record<string, RatingScore>; ownReturn: Record<string, OwnScore>; holding: string; yardsticks: string }

/** A settled entry's alpha as a fraction ("+7.1%" is 0.071), or null when it has none. The journal keeps one decimal of a
 *  percentage point, so aggregates are accurate to 0.1 of a point, not to the raw quote. */
export const alphaOf = (e: Pick<Entry, 'alpha'>): number | null => {
  const t = (e.alpha ?? '').trim().replace(/%$/, '');
  const v = /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(v) ? v / 100 : null;
};

/** Scores the settled calls by rating. A call with no readable rating has no direction, so it counts neither for nor against
 *  the desk: it is reported as unscored. */
export function summarize(entries: Entry[]): Summary {
  const resolved = entries.filter((e) => !e.pending && e.rating !== REVIEW).map((e) => ({ e, a: alphaOf(e) })).filter((x): x is { e: Entry; a: number } => x.a !== null);
  const byRating: Record<string, RatingScore> = {}, own: Record<string, OwnScore> = {};
  const isOwn = (e: Entry) => e.rules !== null && ownReturn(e.rules);   // an old call with no rules kept was scored against its yardstick
  for (const rating of new Set(resolved.map((x) => x.e.rating))) {
    const of = (mine: boolean) => resolved.filter((x) => x.e.rating === rating && isOwn(x.e) === mine).map((x) => x.a), dir = directionOf(rating);
    const mean = (xs: number[]) => xs.reduce((s, a) => s + a, 0) / xs.length;
    const alphas = of(false), returns = of(true);
    if (alphas.length) byRating[rating] = { count: alphas.length, direction: dir, hitRate: dir ? alphas.filter((a) => worked(rating, a)).length / alphas.length : null, meanAlpha: mean(alphas) };
    if (returns.length) own[rating] = { count: returns.length, worked: dir ? returns.filter((a) => worked(rating, a)).length : null, meanReturn: mean(returns) };
  }
  const unscored = entries.filter((e) => e.rating === REVIEW).length;
  // Each scored call's window, in its own unit (a coin's is calendar days, kept or as it was scored before the desk kept
  // them), and its yardstick when its entry keeps it.
  const windows = [...new Set(resolved.map(({ e }) => {
    const days = Number(/^(\d+)d$/.exec(e.holding ?? '')?.[1]);
    return days > 0 ? windowWords({ days, unit: e.rules?.unit ?? (isCrypto(e.ticker) ? 'calendar' : 'trading') }) : '';
  }).filter(Boolean))].sort();
  const yardsticks = [...new Set(resolved.map(({ e }) => e.rules?.yardstick ?? '').filter(Boolean))].sort();
  return { resolved: resolved.length, pending: entries.length - resolved.length - unscored, unscored, byRating, ownReturn: own, holding: windows.join(', ') || 'the configured window', yardsticks: yardsticks.join(', ') };
}

const pctText = (v: number) => signedPct(v, 2);

export function renderSummary(s: Summary): string {
  const lines = [`Resolved cells: ${s.resolved} · pending: ${s.pending}${s.unscored ? ` · unscored: ${s.unscored}` : ''}`];
  for (const [rating, sc] of Object.entries(s.byRating)) {
    lines.push(`- ${rating}: n=${sc.count}, ${sc.hitRate !== null ? `called the direction ${Math.round(sc.hitRate * 100)}%` : 'no direction claimed'}, mean alpha ${pctText(sc.meanAlpha)} vs the yardstick`);
  }
  const own = Object.entries(s.ownReturn);
  if (own.length) lines.push(`- On their own return, not in the lines above (a call on the yardstick itself or a fund that copies the same index): ${own.map(([rating, o]) => `${rating} n=${o.count}, ${o.worked === null ? 'no direction claimed' : `worked ${o.worked}`}, mean return ${pctText(o.meanReturn)}`).join('; ')}`);
  lines.push('');
  if (s.pending) lines.push('Pending cells are not scored above; settle them when their window has traded.');
  if (s.unscored) lines.push('Unscored cells had no readable rating (Needs review): they count neither for nor against the desk.');
  lines.push(`Alpha is measured over the first ${s.holding} after each analysis date, against each call's yardstick${s.yardsticks ? ` (${s.yardsticks})` : ''}: a short first check, not the calls' own time horizons. One model sampling per cell, and text feeds are not archived, so these figures are indicative rather than repeatable. A handful of cells proves nothing: a hit rate over fewer than about 30 calls per rating is noise.`);
  return lines.join('\n');
}
