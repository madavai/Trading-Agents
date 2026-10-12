// Scoring a call: once the holding window after the analysis date has fully traded, the stock's return over it, the return
// of its market's index over the same dates, and the difference (alpha). The numbers come from price rows only - never from
// an agent - and a window that has not finished is "not yet", never a partial figure.
// Adapted from TradingAgents (tradingagents/memory/settlement.py), Apache License 2.0; rewritten in TypeScript.
import { addDays, today } from '../data/dates.js';
import { normalizeSymbol } from '../data/symbols.js';
import { daily, type Bar } from '../data/yahoo.js';

export interface Scoring { holdingPeriodDays: number; benchmark: string; benchmarks: Record<string, string> }

/** The index a stock is judged against: the person's one choice when set, else by the exchange suffix (.T -> Nikkei), else
 *  the default (SPY) for US listings. A dotted US ticker such as BRK.B takes the default, since no suffix matches. */
export function resolveBenchmark(ticker: string, s: Pick<Scoring, 'benchmark' | 'benchmarks'>): string {
  if (s.benchmark.trim()) return normalizeSymbol(s.benchmark);
  const sym = normalizeSymbol(ticker);
  const suffix = Object.keys(s.benchmarks).filter(Boolean).sort((a, b) => b.length - a.length).find((x) => sym.endsWith(x.toUpperCase()));
  return suffix ? s.benchmarks[suffix]! : s.benchmarks[''] ?? 'SPY';
}

export interface Outcome { raw: number; alpha: number; benchmarkReturn: number; holdingDays: number; entry: string; exit: string; benchmark: string }

const closeOn = (bars: Bar[], date: string): number => [...bars].reverse().find((b) => b.date <= date)!.close;

/** The outcome of a call, or null when its window has not finished trading. Throws when prices could not be had. */
export async function measure(ticker: string, tradeDate: string, benchmark: string, holdingDays: number): Promise<Outcome | null> {
  // holdingDays counts trading days: ask for the calendar span they occupy (about 7 for every 5) plus a week of holidays.
  const end = addDays(tradeDate, Math.round((holdingDays * 7) / 5) + 7);
  const stock = (await daily(ticker, tradeDate, end)).bars;
  if (stock.length <= holdingDays) return null;
  const entry = stock[0]!.date, exit = stock[holdingDays]!.date;
  // The exit session must be over: today's bar may still move.
  if (exit >= today()) return null;
  const bench = (await daily(benchmark, addDays(tradeDate, -7), end)).bars;
  // From a week earlier, so the index has a close on or before entry; and it must have traded through the exit.
  if (!bench.length || bench[0]!.date > entry || bench[bench.length - 1]!.date < exit) return null;
  const raw = stock[holdingDays]!.close / stock[0]!.close - 1;
  const benchmarkReturn = closeOn(bench, exit) / closeOn(bench, entry) - 1;
  return { raw, alpha: raw - benchmarkReturn, benchmarkReturn, holdingDays, entry, exit, benchmark };
}
