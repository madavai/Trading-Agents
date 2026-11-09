// Care for what the person holds: each holding joined with the desk's latest view of it, and what that view asks of the
// person. The Agentic account, the one account the desk may trade in, gets the care: the trader's proposed stop watched
// against the price, and a Sell or Underweight call marked "the desk says sell" with a ticket. Every other account shows
// the view as information only. Nothing here sells: a stop is never an order, and a sell is only ever the person's own
// Confirm on a ticket. Each Monday (the Tuesday when Monday is a New York market holiday: the week's first market day) the
// morning routine re-rates the holdings whose view is a week old or more, at most three, at shallow depth, through the
// waiting list, so the dashboard shows them as re-rating meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import { daysBetween } from '../data/dates.js';
import type { PriceMarket } from '../data/delay.js';
import { firstMarketDayOfWeek } from '../data/holidays.js';
import { deskSymbol } from '../data/symbols.js';
import type { Caps, Trading } from '../settings.js';
import type { AccountView } from '../robinhood/account.js';
import { readHoldings } from './holdings.js';
import { Journal } from './journal.js';
import { withLock, writeWhole } from './lock.js';
import { enqueue, QueueRefusal, readQueue, type QueueItem } from './queue.js';
import { sectionsOf } from './runs.js';
import { actionOf } from './ticket.js';

/** A view is due again once it is this many days old; Monday's routine re-rates at most this many holdings. */
export const RERATE_DAYS = 7, RERATE_MAX = 3;

/** The desk's latest view of a stock: its rating, the day of the call, how many days ago that was, in words. */
export interface View { rating: string; date: string; days: number; ago: string }

export const agoWords = (days: number): string => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

/** The latest call on a symbol, as a view on `today`; null when the desk has never called it. */
export function viewOf(calls: ReadonlyArray<{ ticker: string; date: string; rating: string }>, symbol: string, today: string): View | null {
  let latest: { date: string; rating: string } | null = null;
  for (const c of calls) if (c.ticker === symbol && (!latest || c.date >= latest.date)) latest = c;
  if (!latest) return null;
  const days = Math.max(0, daysBetween(latest.date, today));
  return { rating: latest.rating, date: latest.date, days, ago: agoWords(days) };
}

/** No view, or one a week old or more: Monday's routine re-rates it. */
export const isStale = (v: View | null): boolean => !v || v.days >= RERATE_DAYS;

/** The two ratings that say to sell (all, or half). */
export const saysSell = (rating: string): boolean => rating === 'Sell' || rating === 'Underweight';

/** The desk's name for what Robinhood lists (data/symbols.ts): a coin as its dollar pair, a share class as Yahoo spells it. */
export { deskSymbol };

/** The trader's proposed stop: the labelled line "**Stop Loss**: 185.30" of its plan. `level` is the price, or null when
 *  the trader gave none ("not provided") or wrote something that is not one plain price level, which is never guessed at
 *  (a sum, a percentage, a distance in ATRs); `words` is the line as written, for the page to show. */
export interface Stop { level: number | null; words: string }

export function stopOf(text: string): Stop | null {
  const m = /\*\*Stop[ -]?Loss:?\*\*:?[ \t]*([^\n]*)/i.exec(text);
  if (!m) return null;
  const words = m[1]!.replace(/\*\*/g, '').replace(/`/g, '').trim().slice(0, 200);
  const n = /^(?:US)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/.exec(words);
  if (!n) return { level: null, words };
  // A number that starts a sum, a percentage or a distance is not a price level.
  const rest = words.slice(n[0].length).trim();
  if (/^(?:[%×*+/=−]|[-–]\s*\d|x\s*\d|x\s|times\b|atr\b)/i.test(rest)) return { level: null, words };
  const level = Number(`${n[1]!.replace(/,/g, '')}${n[2] ?? ''}`);
  return Number.isFinite(level) && level > 0 && level < 1e7 ? { level, words } : { level: null, words };
}

/** The stop the trader proposed in the run of one call, or null when the run or its line is not there. */
export function stopIn(dir: string, ticker: string, date: string): Stop | null {
  try { const t = sectionsOf(dir, ticker, date).trader?.at(-1); return t ? stopOf(t) : null; } catch { return null; }
}

/** A price a stop is watched against: Yahoo Finance's, when it is from, whether its market is open (a closed one's price is
 *  its close), and the market it is from, for how late a live one may be. */
export interface WatchPrice { value: number; asOf: string; open?: boolean; market?: PriceMarket }

/** What the dashboard shows beside one holding. */
export interface HoldingCare {
  /** The account's key (never its number), and whether it is the Agentic account. */
  account: string; agentic: boolean;
  /** As Robinhood lists it, and as the desk calls it. */
  symbol: string; desk: string;
  view: View | null; stale: boolean;
  /** On the waiting list: waiting to be re-rated, or being analysed now. */
  rerating: 'waiting' | 'running' | null;
  /** The Agentic account only: the stop the trader proposed in the latest call, the price it is watched against (Yahoo
   *  Finance's, with whether its market is open and which market it is, for how late it may be: data/delay.ts), and
   *  whether the price is below it. Watched only while the dashboard page is open; the evening wrap-up's brief names a
   *  holding whose last close is below its stop (`stopsAtClose`). */
  stop: (Stop & { date: string }) | null;
  price: WatchPrice | null;
  below: boolean;
  /** The Agentic account only, for a Sell or Underweight call: what the person's settings make of it, whether a ticket can
   *  be opened (a coin's cannot), and when the stock was bought here under the shortest hold. */
  sell: { action: string; ticket: boolean; early: { boughtOn: string; heldDays: number; minHoldDays: number } | null } | null;
}

export interface CareInput {
  views: readonly AccountView[];
  calls: ReadonlyArray<{ ticker: string; date: string; rating: string }>;
  queue: readonly QueueItem[];
  today: string;
  trading: Trading; caps: Caps;
  stop: (ticker: string, date: string) => Stop | null;
  bought: (symbol: string) => { boughtOn: string; heldDays: number } | null;
  ticketable: (symbol: string) => boolean;
}

/** Every holding of the accounts shown, with the desk's view of it. Prices are not looked at here: see `watched`. */
export function careOf(o: CareInput): HoldingCare[] {
  const open = new Map(o.queue.filter((q) => q.state === 'waiting' || q.state === 'running').map((q) => [q.symbol, q.state as 'waiting' | 'running']));
  return o.views.flatMap((v) => v.holdings.map((h): HoldingCare => {
    const desk = deskSymbol(h.symbol, h.kind), view = viewOf(o.calls, desk, o.today), agentic = v.account.agentic;
    const stop = agentic && view ? o.stop(desk, view.date) : null;
    let sell: HoldingCare['sell'] = null;
    if (agentic && view && saysSell(view.rating)) {
      const b = o.bought(desk);
      sell = { action: actionOf(view.rating, o.trading), ticket: o.ticketable(desk), early: b && b.heldDays < o.caps.minHoldDays ? { ...b, minHoldDays: o.caps.minHoldDays } : null };
    }
    return { account: v.account.key, agentic, symbol: h.symbol, desk, view, stale: isStale(view), rerating: open.get(desk) ?? null,
      stop: stop && view ? { ...stop, date: view.date } : null, price: null, below: false, sell };
  }));
}

/** The symbols whose stop is to be watched: the Agentic account's holdings with a stop at a price level. */
export const toWatch = (care: readonly HoldingCare[]): string[] => [...new Set(care.filter((c) => c.agentic && c.stop?.level != null).map((c) => c.desk))];

/** The stop watch: each watched holding with its price, and below its stop when the price is under the trader's level. A
 *  price that could not be had leaves the holding unwatched for now, never marked. */
export function watched(care: readonly HoldingCare[], prices: ReadonlyMap<string, WatchPrice>): HoldingCare[] {
  return care.map((c) => {
    const level = c.agentic ? c.stop?.level ?? null : null, p = level === null ? undefined : prices.get(c.desk);
    return p && level !== null ? { ...c, price: p, below: p.value < level } : c;
  });
}

// ---------- the stops at the last close, for the evening wrap-up ----------
// The dashboard watches a stop only while its page is open in a browser. So the evening wrap-up's brief checks each stop
// against the holding's last close and names any below it: Madav's evening routine (when the person switched the routines
// on) then reports it. It only reports: nothing is ever sold by itself.

/** A session's final close, as the desk's tools read it: its day and the price traded at. */
export interface Close { date: string; close: number }

/** One holding's stop against its last close: `close` null when the close could not be read (`why`). */
export interface StopAtClose { symbol: string; level: number; called: string; close: Close | null; why?: string }

/** The stops at the last close of the holdings the desk sizes trades to (the Agentic account as the dashboard last read
 *  it, or what the person said they hold), or why none could be checked. Only a holding with a call whose trader gave a
 *  stop at a price level is checked; a close that could not be read is said to be unavailable, never taken as above. */
export type StopsAtClose =
  | { state: 'unknown' } | { state: 'no-agentic' } | { state: 'nothing-held' }
  | { state: 'checked'; held: number; stops: StopAtClose[] };

export async function stopsAtClose(dir: string, today: string, closeOf: (symbol: string) => Promise<Close>): Promise<StopsAtClose> {
  const held = readHoldings(dir);
  if (!held) return { state: 'unknown' };
  if (held.source === 'robinhood' && !held.accounts?.some((a) => a.tradable)) return { state: 'no-agentic' };
  const symbols = [...new Set(held.positions.map((p) => p.ticker))].filter((s) => !/[\^=]/.test(s));
  if (!symbols.length) return { state: 'nothing-held' };
  const calls = new Journal(path.join(dir, 'journal.md')).load(), stops: StopAtClose[] = [];
  for (const symbol of symbols) {
    const view = viewOf(calls, symbol, today), level = view ? stopIn(dir, symbol, view.date)?.level ?? null : null;
    if (!view || level === null) continue;
    try { stops.push({ symbol, level, called: view.date, close: await closeOf(symbol) }); } catch (e) { stops.push({ symbol, level, called: view.date, close: null, why: (e as Error).message }); }
  }
  return { state: 'checked', held: symbols.length, stops };
}

// ---------- Monday's re-rating ----------
/** What the week's re-rating put on the waiting list, so it does so once a week and the brief can say why each is there;
 *  `full` when the waiting list refused one, so the brief can say that, and only then, was the reason. Each holding an
 *  earlier re-rating put on the list that has had no call since is kept in `tried`, with the day it was first put there:
 *  its analysis left no call (it failed, or the desk cannot analyse it), and `tried` on a symbol says so to the brief. */
export interface Rerate { day: string; symbols: Array<{ symbol: string; called: string | null; rating: string | null; tried?: string }>; full?: true; tried?: Record<string, string> }

const rerateFile = (dir: string) => path.join(dir, 'rerate.json');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readRerate(dir: string): Rerate | null {
  try {
    const v = JSON.parse(fs.readFileSync(rerateFile(dir), 'utf8')) as Rerate;
    if (typeof v.day !== 'string' || !Array.isArray(v.symbols)) return null;
    const dayOrNull = (x: unknown) => x === null || typeof x === 'string';
    const tried = Object.fromEntries(Object.entries(v.tried && typeof v.tried === 'object' ? v.tried : {}).filter(([, d]) => typeof d === 'string' && DAY.test(d)));
    return { day: v.day, symbols: v.symbols.filter((s) => typeof s?.symbol === 'string' && dayOrNull(s.called) && dayOrNull(s.rating)).map((s) => ({ symbol: s.symbol, called: s.called, rating: s.rating, ...(typeof s.tried === 'string' && DAY.test(s.tried) ? { tried: s.tried } : {}) })),
      ...(v.full === true ? { full: true as const } : {}), ...(Object.keys(tried).length ? { tried } : {}) };
  } catch { return null; }
}

/** The holdings an earlier re-rating put on the waiting list with no call on them since, each with the day it first did:
 *  their analysis left no call. A call recorded on one since takes it off. */
function leftNoCall(kept: Rerate | null, calls: ReadonlyArray<{ ticker: string; date: string }>, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!kept) return out;
  const add = (symbol: string, day: string) => {
    if (day >= today || calls.some((c) => c.ticker === symbol && c.date >= day) || (out[symbol] !== undefined && out[symbol]! <= day)) return;
    out[symbol] = day;
  };
  for (const [symbol, day] of Object.entries(kept.tried ?? {})) add(symbol, day);
  for (const s of kept.symbols) add(s.symbol, kept.day);
  return out;
}

/** The day of the week's re-rating: its first market day, a Monday unless that is a New York market holiday. */
export const isRerateDay = (day: string): boolean => firstMarketDayOfWeek(day) === day;

/** The holdings due for a fresh view: those the desk sizes trades to (the Agentic account as the dashboard last read it,
 *  or what the person said they hold), with no view or one a week old or more, not on the waiting list already, the
 *  stalest first. A holding an earlier re-rating left with no call (`tried`) comes after those with a real view, so one
 *  the desk cannot analyse never takes the first place every Monday. Indices are never analysed. */
export function dueForRerate(dir: string, today: string, now: Date = new Date()): Rerate['symbols'] {
  const held = readHoldings(dir)?.positions ?? [];
  if (!held.length) return [];
  const calls = new Journal(path.join(dir, 'journal.md')).load(), tried = leftNoCall(readRerate(dir), calls, today);
  const busy = new Set(readQueue(dir, now).filter((q) => q.state === 'waiting' || q.state === 'running').map((q) => q.symbol));
  return [...new Set(held.map((p) => p.ticker))]
    .filter((s) => !/[\^=]/.test(s) && !busy.has(s))
    .map((symbol) => ({ symbol, view: viewOf(calls, symbol, today), tried: tried[symbol] }))
    .filter((x) => isStale(x.view))
    .sort((a, b) => Number(a.tried !== undefined) - Number(b.tried !== undefined) || (a.view?.date ?? '').localeCompare(b.view?.date ?? '') || (a.tried ?? '').localeCompare(b.tried ?? ''))
    .map((x) => ({ symbol: x.symbol, called: x.view?.date ?? null, rating: x.view?.rating ?? null, ...(x.tried ? { tried: x.tried } : {}) }));
}

/** Monday's re-rating, once a week on its first market day (`isRerateDay`): the stalest holdings, at most three, go on the
 *  waiting list at shallow depth. The routine analyses what waits itself, so no doorbell rings. Returns what it put on
 *  the list today (also when it already did, earlier that day); nothing on any other day. */
export function rerateWeekly(dir: string, today: string, now: Date = new Date()): Rerate['symbols'] {
  if (!isRerateDay(today)) return [];
  fs.mkdirSync(dir, { recursive: true });
  return withLock(rerateFile(dir), () => {
    const kept = readRerate(dir);
    if (kept?.day === today) return kept.symbols;
    const tried = leftNoCall(kept, new Journal(path.join(dir, 'journal.md')).load(), today), queued: Rerate['symbols'] = [];
    let full = false;
    for (const due of dueForRerate(dir, today, now)) {
      if (queued.length >= RERATE_MAX) break;
      try { enqueue(dir, due.symbol, now.toISOString(), 'shallow', now); queued.push(due); } catch (e) { if (!(e instanceof QueueRefusal)) throw e; full = true; break; }   // a full list takes no more
    }
    writeWhole(rerateFile(dir), JSON.stringify({ day: today, symbols: queued, ...(full ? { full: true } : {}), ...(Object.keys(tried).length ? { tried } : {}) }, null, 2) + '\n');
    return queued;
  });
}
