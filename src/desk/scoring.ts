// Scoring a call: once its window after the analysis date has passed, the stock's return over it, the return of its
// yardstick over the same dates, and the difference (alpha). The numbers come from price rows only - never from an agent -
// and a window that has not finished is "not yet", never a partial figure. A call is scored only when a scoring runs
// (/settle, an analysis or a routine) after its window, not by itself.
//
// It is a first check, not the call's own time horizon: as shipped, a stock or fund is scored over the 5 trading days
// after the call (its own sessions), its first week. A coin trades every day, so its window is the same span of the
// calendar: 7 days for 5 trading days (`coinDays`). A coin's yardstick, SPY as shipped (the settings name none for coins),
// trades only on New York's market days: its start and end are its close on the coin's first and last day, or, when New
// York's market was closed that day (a weekend or one of its holidays, data/holidays.ts), its last close before it. A
// coin's day on Yahoo Finance ends at midnight UTC, SPY's session at 4 p.m. New York time, so "the same dates" are the
// same calendar days, not the same minutes.
//
// A call's window and yardstick are its own: `rulesFor` gives them when the call is recorded, the journal keeps them in
// its entry, and scoring reads them from there, so a later change to the settings never re-scores a call. A call recorded
// before the journal kept them (no window in its entry) keeps the rules it was made under (`legacyRules`): the settings'
// count of price rows (trading days for a stock; for a coin, which has a row every day, calendar days) and its yardstick
// by exchange, as the desk scored it then.
// Adapted from TradingAgents (tradingagents/memory/settlement.py), Apache License 2.0; rewritten in TypeScript.
import { addDays, today } from '../data/dates.js';
import { isMarketDay } from '../data/holidays.js';
import { isCrypto, normalizeSymbol } from '../data/symbols.js';
import { daily, type Bar } from '../data/yahoo.js';

export interface Scoring { holdingPeriodDays: number; benchmark: string; benchmarks: Record<string, string> }

/** How a window is counted: in the stock's own trading days (sessions), or in calendar days (a coin, which trades daily). */
export type Unit = 'trading' | 'calendar';
/** Why a call has its yardstick: a US listing (the settings' default), a coin (the settings name none for coins, so the
 *  default), a stock on an exchange the settings do not list (so the default), the index the settings give its exchange,
 *  or the one yardstick the person set for every call. */
export type Basis = 'us' | 'coin' | 'unlisted' | 'market' | 'chosen';
/** A call's window and yardstick, as its journal entry keeps them. */
export interface Rules { days: number; unit: Unit; yardstick: string; basis: Basis }

/** A coin's window for a stock's `tradingDays`: the same span of the calendar (5 trading days are a week, 7 days). */
export const coinDays = (tradingDays: number): number => Math.max(1, Math.round((tradingDays * 7) / 5));

/** The exchange suffix of a symbol as Yahoo Finance spells it (".MC" for Madrid, ".TWO" for Taipei's OTC market), or null
 *  for a US listing. One letter after a dot is a US share class (BRK.B), except Yahoo's one-letter exchanges (.T Tokyo,
 *  .L London, .V TSX Venture, .F Frankfurt). */
export function exchangeOf(ticker: string): string | null {
  const m = /\.([A-Z]{2,3}|[TLVF])$/.exec(normalizeSymbol(ticker));
  return m ? `.${m[1]}` : null;
}

/** The yardstick a call on `ticker` gets now, and why: the person's one choice when set, else by the exchange suffix
 *  (.T -> Nikkei), else the default (SPY as shipped) - for a US listing, a coin, or an exchange the settings do not list.
 *  A dotted US ticker such as BRK.B takes the default, since no suffix matches. */
export function yardstickFor(ticker: string, s: Pick<Scoring, 'benchmark' | 'benchmarks'>): { yardstick: string; basis: Basis } {
  if (s.benchmark.trim()) return { yardstick: normalizeSymbol(s.benchmark), basis: 'chosen' };
  const sym = normalizeSymbol(ticker);
  const suffix = Object.keys(s.benchmarks).filter(Boolean).sort((a, b) => b.length - a.length).find((x) => sym.endsWith(x.toUpperCase()));
  if (suffix) return { yardstick: normalizeSymbol(s.benchmarks[suffix]!), basis: 'market' };
  return { yardstick: normalizeSymbol(s.benchmarks[''] ?? 'SPY'), basis: isCrypto(sym) ? 'coin' : exchangeOf(sym) ? 'unlisted' : 'us' };
}

/** The index a stock is judged against (`yardstickFor`, without the why). */
export const resolveBenchmark = (ticker: string, s: Pick<Scoring, 'benchmark' | 'benchmarks'>): string => yardstickFor(ticker, s).yardstick;

/** The window and yardstick a call on `ticker` made now is scored by: the settings' trading days for a stock or fund, the
 *  same span of the calendar for a coin. Kept in the call's journal entry when it is recorded. */
export function rulesFor(ticker: string, s: Scoring): Rules {
  const coin = isCrypto(ticker);
  return { days: coin ? coinDays(s.holdingPeriodDays) : s.holdingPeriodDays, unit: coin ? 'calendar' : 'trading', ...yardstickFor(ticker, s) };
}

/** The rules a call recorded before the journal kept them is scored by, as the desk scored such calls then: the days its
 *  entry gives ("5d", once scored) or else the settings', counted as price rows (a coin has one every day), and its
 *  yardstick by exchange. */
export function legacyRules(ticker: string, s: Scoring, holding?: string | null): Rules {
  const kept = Number(/^(\d+)d$/.exec(holding ?? '')?.[1]);
  return { days: kept > 0 ? kept : s.holdingPeriodDays, unit: isCrypto(ticker) ? 'calendar' : 'trading', ...yardstickFor(ticker, s) };
}

// ---------- the rules in words, for the desk's answers and the dashboard ----------
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** "5 trading days", "7 calendar days". */
export const windowWords = (r: Pick<Rules, 'days' | 'unit'>): string => plural(r.days, `${r.unit} day`);
/** "a first-week check" for a week's window (5 trading days, 7 calendar days), else "a check over its first 3 trading days". */
export const checkName = (r: Pick<Rules, 'days' | 'unit'>): string =>
  (r.unit === 'trading' ? r.days === 5 : r.days === 7) ? 'a first-week check' : `a check over its first ${windowWords(r)}`;
/** A yardstick by its ticker and, for the shipped one, what it is: "SPY, the fund that copies the S&P 500". */
export const yardstickName = (y: string): string => (y === 'SPY' ? 'SPY, the fund that copies the S&P 500' : y);
/** Why a call has its yardstick, in words; '' for a US listing scored against the shipped SPY. */
export function basisWords(ticker: string, r: Pick<Rules, 'yardstick' | 'basis'>): string {
  const ex = exchangeOf(ticker);
  switch (r.basis) {
    case 'us': return r.yardstick === 'SPY' ? '' : "the desk's yardstick for US listings";
    case 'coin': return "the desk's settings name no yardstick for coins, so a coin is scored against the one for US listings";
    case 'unlisted': return `its exchange${ex ? `, ${ex},` : ''} had no index in the desk's settings when the call was made, so it is scored against the one for US listings`;
    case 'market': return `the index the desk's settings give its exchange${ex ? `, ${ex}` : ''}`;
    case 'chosen': return "the one yardstick the desk's settings set for every call";
  }
}
/** The yardstick named, and why it is that one: "SPY, the fund that copies the S&P 500", "SPY, the fund that copies the
 *  S&P 500 (the desk's settings name no yardstick for coins, ...)". */
export function yardstickWords(ticker: string, r: Pick<Rules, 'yardstick' | 'basis'>): string {
  const why = basisWords(ticker, r);
  return `${yardstickName(r.yardstick)}${why ? ` (${why})` : ''}`;
}
/** The whole check in one phrase: "a first-week check against SPY, the fund that copies the S&P 500, over the 5 trading
 *  days after the call". */
export const checkWords = (ticker: string, r: Rules): string => `${checkName(r)} against ${yardstickWords(ticker, r)}, over the ${windowWords(r)} after the call`;
/** For a coin: how its yardstick's closes are taken. Empty for a stock. */
export const COIN_YARDSTICK_WORDS = "A coin trades every day, so its window is calendar days; its yardstick trades only on New York's market days, so it is taken at its close on the coin's first and last day, or at its last close before that day when New York's market was closed (a weekend or a New York holiday).";
/** What the score is not, said wherever it is shown or described. */
export const NOT_HORIZON = "It is not the call's own time horizon, which its decision states.";
/** When a call is scored: only when a scoring runs, never by itself. */
export const WHEN_SCORED = 'A call is scored when a scoring runs after its window (/settle, an analysis or a routine), not by itself.';

// ---------- measuring ----------
export interface Outcome {
  raw: number; alpha: number; benchmarkReturn: number; holdingDays: number; unit: Unit; entry: string; exit: string; benchmark: string;
  /** The yardstick's closes the return is worked out from: the last on or before the entry and the exit. */
  benchFrom: string; benchTo: string;
}

const rowOn = (bars: Bar[], date: string): Bar | undefined => [...bars].reverse().find((b) => b.date <= date);

/** New York's last market day on or before `day`. */
function lastMarketDay(day: string): string {
  let d = day;
  while (!isMarketDay(d)) d = addDays(d, -1);
  return d;
}

/** The outcome of a call by its rules, or null when its window has not finished trading. Throws when prices could not be
 *  had, or a price the window needs is missing from the source. */
export async function measure(ticker: string, tradeDate: string, r: Pick<Rules, 'days' | 'unit' | 'yardstick'>): Promise<Outcome | null> {
  return r.unit === 'calendar' ? measureCalendar(ticker, tradeDate, r) : measureTrading(ticker, tradeDate, r);
}

/** A stock's window: its own sessions, the entry's close to the close `days` sessions later. */
async function measureTrading(ticker: string, tradeDate: string, r: Pick<Rules, 'days' | 'yardstick'>): Promise<Outcome | null> {
  // days counts trading days: ask for the calendar span they occupy (about 7 for every 5) plus a week of holidays.
  const end = addDays(tradeDate, Math.round((r.days * 7) / 5) + 7);
  const stock = (await daily(ticker, tradeDate, end)).bars;
  if (stock.length <= r.days) return null;
  const entry = stock[0]!.date, exit = stock[r.days]!.date;
  // The exit session must be over: today's bar may still move.
  if (exit >= today()) return null;
  const bench = (await daily(r.yardstick, addDays(tradeDate, -7), end)).bars;
  // From a week earlier, so the index has a close on or before entry; and it must have traded through the exit.
  if (!bench.length || bench[0]!.date > entry || bench[bench.length - 1]!.date < exit) return null;
  const from = rowOn(bench, entry)!, to = rowOn(bench, exit)!;
  const raw = stock[r.days]!.close / stock[0]!.close - 1, benchmarkReturn = to.close / from.close - 1;
  return { raw, alpha: raw - benchmarkReturn, benchmarkReturn, holdingDays: r.days, unit: 'trading', entry, exit, benchmark: r.yardstick, benchFrom: from.date, benchTo: to.date };
}

/** A coin's window: calendar days, from its close on the entry day to its close `days` days later; the yardstick over the
 *  same dates, at its last close on or before each. */
async function measureCalendar(ticker: string, tradeDate: string, r: Pick<Rules, 'days' | 'yardstick'>): Promise<Outcome | null> {
  const stock = (await daily(ticker, tradeDate, addDays(tradeDate, r.days + 7))).bars;
  if (!stock.length) return null;
  const entry = stock[0]!.date, exit = addDays(entry, r.days);
  // The exit day must be over: today's row may still move.
  if (exit >= today()) return null;
  const last = stock.find((b) => b.date === exit);
  if (!last) throw new Error(`Yahoo Finance gives no ${normalizeSymbol(ticker)} close for ${exit}, the last day of its ${plural(r.days, 'calendar day')} window${stock.at(-1)!.date < exit ? ' yet' : ''}`);
  // A week past the exit too, so a row after it shows the yardstick's last close before the exit is final.
  const later = addDays(exit, 7), bench = (await daily(r.yardstick, addDays(entry, -7), later < today() ? later : today())).bars;
  const from = rowOn(bench, entry), to = rowOn(bench, exit);
  if (!from || !to) return null;
  // New York's last market day on or before the exit: its close must be in the answer, unless a later row shows the
  // yardstick did not trade that day after all.
  const due = lastMarketDay(exit);
  if (to.date < due && !bench.some((b) => b.date > exit)) throw new Error(`Yahoo Finance gives no ${r.yardstick} close for ${due} yet, the last New York market day of the window`);
  const raw = last.close / stock[0]!.close - 1, benchmarkReturn = to.close / from.close - 1;
  return { raw, alpha: raw - benchmarkReturn, benchmarkReturn, holdingDays: r.days, unit: 'calendar', entry, exit, benchmark: r.yardstick, benchFrom: from.date, benchTo: to.date };
}
