// Care for what the person holds: each holding joined with the desk's latest view of it, and what that view asks of the
// person. The Agentic account, the one account the desk may trade in, gets the care: the trader's proposed stop watched
// against the price, and a Sell or Underweight call marked "the desk says sell" with a ticket. Every other account shows
// the view as information only. Nothing here sells: a stop is never an order, and a sell is only ever the person's own
// Confirm on a ticket. Each Monday the morning routine re-rates the holdings whose view is a week old or more, at most
// three, at shallow depth, through the waiting list, so the dashboard shows them as re-rating meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import { daysBetween } from '../data/dates.js';
import { normalizeSymbol } from '../data/symbols.js';
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

/** The desk's name for what Robinhood lists: a coin is followed as its dollar pair (BTC is BTC-USD), a stock as itself. */
export const deskSymbol = (symbol: string, kind: 'stock' | 'crypto'): string => (kind === 'crypto' ? normalizeSymbol(/USD/i.test(symbol) ? symbol : `${symbol}-USD`) : symbol);

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
   *  Finance's, up to 15 minutes late), and whether the price is below it. */
  stop: (Stop & { date: string }) | null;
  price: { value: number; asOf: string } | null;
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
export function watched(care: readonly HoldingCare[], prices: ReadonlyMap<string, { value: number; asOf: string }>): HoldingCare[] {
  return care.map((c) => {
    const level = c.agentic ? c.stop?.level ?? null : null, p = level === null ? undefined : prices.get(c.desk);
    return p && level !== null ? { ...c, price: p, below: p.value < level } : c;
  });
}

// ---------- Monday's re-rating ----------
/** What Monday's routine put on the waiting list, so it does so once a Monday and the brief can say why each is there. */
export interface Rerate { day: string; symbols: Array<{ symbol: string; called: string | null; rating: string | null }> }

const rerateFile = (dir: string) => path.join(dir, 'rerate.json');

export function readRerate(dir: string): Rerate | null {
  try {
    const v = JSON.parse(fs.readFileSync(rerateFile(dir), 'utf8')) as Rerate;
    if (typeof v.day !== 'string' || !Array.isArray(v.symbols)) return null;
    const dayOrNull = (x: unknown) => x === null || typeof x === 'string';
    return { day: v.day, symbols: v.symbols.filter((s) => typeof s?.symbol === 'string' && dayOrNull(s.called) && dayOrNull(s.rating)) };
  } catch { return null; }
}

const isMonday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 1;

/** The holdings due for a fresh view: those the desk sizes trades to (the Agentic account as the dashboard last read it,
 *  or what the person said they hold), with no view or one a week old or more, not on the waiting list already, the
 *  stalest first. Indices are never analysed. */
export function dueForRerate(dir: string, today: string, now: Date = new Date()): Rerate['symbols'] {
  const held = readHoldings(dir)?.positions ?? [];
  if (!held.length) return [];
  const calls = new Journal(path.join(dir, 'journal.md')).load();
  const busy = new Set(readQueue(dir, now).filter((q) => q.state === 'waiting' || q.state === 'running').map((q) => q.symbol));
  return [...new Set(held.map((p) => p.ticker))]
    .filter((s) => !/[\^=]/.test(s) && !busy.has(s))
    .map((symbol) => ({ symbol, view: viewOf(calls, symbol, today) }))
    .filter((x) => isStale(x.view))
    .sort((a, b) => (a.view?.date ?? '').localeCompare(b.view?.date ?? ''))
    .map((x) => ({ symbol: x.symbol, called: x.view?.date ?? null, rating: x.view?.rating ?? null }));
}

/** Monday's re-rating, once a Monday: the stalest holdings, at most three, go on the waiting list at shallow depth. The
 *  routine analyses what waits itself, so no doorbell rings. Returns what it put on the list today (also when it already
 *  did, earlier this Monday); nothing on any other day. */
export function rerateWeekly(dir: string, today: string, now: Date = new Date()): Rerate['symbols'] {
  if (!isMonday(today)) return [];
  fs.mkdirSync(dir, { recursive: true });
  return withLock(rerateFile(dir), () => {
    const kept = readRerate(dir);
    if (kept?.day === today) return kept.symbols;
    const queued: Rerate['symbols'] = [];
    for (const due of dueForRerate(dir, today, now)) {
      if (queued.length >= RERATE_MAX) break;
      try { enqueue(dir, due.symbol, now.toISOString(), 'shallow', now); queued.push(due); } catch (e) { if (!(e instanceof QueueRefusal)) throw e; break; }   // a full list takes no more
    }
    writeWhole(rerateFile(dir), JSON.stringify({ day: today, symbols: queued }, null, 2) + '\n');
    return queued;
  });
}
