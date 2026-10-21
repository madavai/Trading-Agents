// The paper book: what following every one of the desk's calls would have done, with no money at stake. Each call is
// sized exactly as its order ticket would size it (the rating, a full position, the person's caps), must pass the same
// checks, and is filled at the first closing price after the call's day: a price the person could really have had,
// nothing from hindsight. No costs are counted (Robinhood charges no commission). It is worked out afresh from the
// journal and daily closing prices every time, so it can never drift from the calls; only the starting money is kept.
import fs from 'node:fs';
import path from 'node:path';
import { daysBetween } from '../data/dates.js';
import { isCrypto } from '../data/symbols.js';
import { writeWhole } from './lock.js';
import { actionOf, check, passes, propose, type TicketContext } from './ticket.js';
import type { Caps, Trading } from '../settings.js';
import { tradingDaysBetween } from './orders.js';
import type { Sectors } from './sectors.js';

export interface PaperCall { ticker: string; date: string; rating: string }
/** Closing prices by symbol, oldest first. A symbol missing here could not be read; an empty list has no prices. */
export type Closes = Record<string, ReadonlyArray<{ date: string; close: number }>>;

export interface PaperTrade {
  ticker: string; callDate: string; rating: string;
  /** filled: bought or sold on paper; none: the call asks for no order, or its order would not pass the checks;
   *  waiting: its first close after the call has not come yet; unavailable: its prices could not be read; skipped: not
   *  followed on paper (an index, or crypto other than Bitcoin and Ether). */
  status: 'filled' | 'none' | 'waiting' | 'unavailable' | 'skipped';
  side?: 'buy' | 'sell'; quantity?: number; price?: number; fillDate?: string;
  /** For a paper buy: how its stock has done since, at the latest close. */
  sincePct?: number;
  why: string;
}
export interface PaperPosition { ticker: string; quantity: number; cost: number; price: number; value: number }
export interface PaperBook {
  startUsd: number;
  /** The day of the first call the paper book follows, or null before there is one. */
  since: string | null;
  cash: number; value: number; positions: PaperPosition[];
  /** The paper book's value at each close since the first call, beside the benchmark's, both starting at startUsd. */
  series: Array<{ date: string; value: number; benchmark: number | null }>;
  trades: PaperTrade[];
  returnPct: number | null; benchmarkPct: number | null;
  benchmark: string;
}
/** How much record the desk has: since its first followed call, in whole weeks, and how many calls. */
export interface PaperRecord { since: string | null; weeks: number; calls: number }

export const PAPER_START_USD = 10_000, PAPER_MIN = 100, PAPER_MAX = 10_000_000;
/** Under this many weeks of record, switching trading on asks for one extra press. The paper time before the money step:
 *  the dashboard's first-month guide, the trading switch and the docs all say it as RECORD_WORDS. */
export const RECORD_WEEKS: number = 4;
export const RECORD_WORDS = `${['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][RECORD_WEEKS] ?? RECORD_WEEKS} ${RECORD_WEEKS === 1 ? 'week' : 'weeks'}`;
const cents = (n: number) => Math.round(n * 100) / 100;

/** The crypto followed on paper, to start: Bitcoin and Ether, within the crypto limit. Never sent to Robinhood. */
export const PAPER_CRYPTO: ReadonlySet<string> = new Set(['BTC-USD', 'ETH-USD']);
/** Followed on paper: stocks, funds, and Bitcoin and Ether. An index, a future or a currency cannot be bought. */
export const followed = (ticker: string): boolean => !/[\^=]/.test(ticker) && (!isCrypto(ticker) || PAPER_CRYPTO.has(ticker));
/** Why a call is not followed on paper, in plain words. */
const notFollowed = (ticker: string): string => (isCrypto(ticker)
  ? 'Among crypto, paper follows Bitcoin and Ether for now.'
  : 'An index, a future or a currency cannot be bought: paper follows stocks, funds, Bitcoin and Ether.');

export function recordOf(calls: readonly PaperCall[], today: string): PaperRecord {
  const mine = calls.filter((c) => followed(c.ticker) && c.date <= today);
  const since = mine.map((c) => c.date).sort()[0] ?? null;
  return { since, weeks: since ? Math.floor(daysBetween(since, today) / 7) : 0, calls: mine.length };
}

/** The last close on or before `date`, or null. */
const closeOn = (rows: Closes[string] | undefined, date: string): number | null => {
  let last: number | null = null;
  for (const r of rows ?? []) { if (r.date > date) break; last = r.close; }
  return last;
};

/** sectors: where each ticker's sector comes from, for the sector limit (without it, each stock counts as its own). */
export function paperBook(calls: readonly PaperCall[], closes: Closes, o: { startUsd: number; trading: Trading; caps: Caps; today: string; benchmark?: string; sectors?: Pick<Sectors, 'context'> }): PaperBook {
  const benchmark = o.benchmark ?? 'SPY';
  const ordered = [...calls].filter((c) => c.date <= o.today).sort((a, b) => a.date.localeCompare(b.date));
  const trades: PaperTrade[] = [];
  // Each call's fill: the first close of its own stock after the call's day.
  const fills: Array<{ trade: PaperTrade; date: string; price: number }> = [];
  for (const c of ordered) {
    const base = { ticker: c.ticker, callDate: c.date, rating: c.rating };
    if (!followed(c.ticker)) { trades.push({ ...base, status: 'skipped', why: notFollowed(c.ticker) }); continue; }
    if (actionOf(c.rating, o.trading) === 'no order') { trades.push({ ...base, status: 'none', why: `A ${c.rating} call asks for no order.` }); continue; }
    const rows = closes[c.ticker];
    if (!rows) { trades.push({ ...base, status: 'unavailable', why: `Prices for ${c.ticker} could not be read just now.` }); continue; }
    const next = rows.find((r) => r.date > c.date && r.date <= o.today);
    if (!next) { trades.push({ ...base, status: 'waiting', why: 'Waits for the first closing price after the call.' }); continue; }
    const t: PaperTrade = { ...base, status: 'none', why: '' };
    trades.push(t);
    fills.push({ trade: t, date: next.date, price: next.close });
  }
  fills.sort((a, b) => a.date.localeCompare(b.date));

  let cash = o.startUsd;
  const held = new Map<string, { quantity: number; cost: number }>(), boughtOn = new Map<string, string>();
  const worth = (date: string): number => {
    let v = cash;
    for (const [ticker, h] of held) v += h.quantity * (closeOn(closes[ticker], date) ?? (h.cost / (h.quantity || 1)));
    return v;
  };
  const apply = (f: (typeof fills)[number], ordersThatDay: number): void => {
    const h = held.get(f.trade.ticker) ?? { quantity: 0, cost: 0 };
    const positions = [...held].map(([ticker, x]) => ({ symbol: ticker, quantity: x.quantity, price: closeOn(closes[ticker], f.date) }));
    const bought = boughtOn.get(f.trade.ticker);
    const cryptoHeldUsd = cents(positions.filter((x) => isCrypto(x.symbol)).reduce((a, x) => a + x.quantity * (x.price ?? 0), 0));
    const context: TicketContext = { symbol: f.trade.ticker, rating: f.trade.rating, callDate: f.trade.callDate, accountValue: cents(worth(f.date)), buyingPower: cents(cash), held: h.quantity, price: f.price, ordersToday: ordersThatDay, positions, cryptoHeldUsd,
      ...(o.sectors ? { sector: o.sectors.context(f.trade.ticker, positions) } : {}), ...(bought && h.quantity > 0 ? { boughtOn: bought, heldDays: tradingDaysBetween(bought, f.date) } : {}) };
    const p = propose(context, o.trading, o.caps);
    if (!p.order) { f.trade.why = p.why.at(-1) ?? 'No order.'; return; }
    const failing = check(p.order, context, o.trading, o.caps);
    if (!passes(failing)) { f.trade.why = `Its order would not pass: ${failing.filter((x) => !x.ok).map((x) => x.words).join('; ')}.`; return; }
    const { side, quantity, limitPrice } = p.order, amount = cents(quantity * limitPrice);
    if (side === 'buy') { cash = cents(cash - amount); held.set(f.trade.ticker, { quantity: h.quantity + quantity, cost: cents(h.cost + amount) }); boughtOn.set(f.trade.ticker, f.date); }
    else {
      const left = h.quantity - quantity;
      cash = cents(cash + amount);
      if (left > 0) held.set(f.trade.ticker, { quantity: left, cost: cents(h.cost * (left / h.quantity)) }); else held.delete(f.trade.ticker);
    }
    Object.assign(f.trade, { status: 'filled', side, quantity, price: limitPrice, fillDate: f.date, why: `${side === 'buy' ? 'Bought' : 'Sold'} ${quantity} at the close of ${f.date}.` });
  };

  // Day by day from the first call, on the benchmark's trading days: the fills of that day, then the day's value.
  const since = ordered.find((c) => followed(c.ticker))?.date ?? null;
  const bench = closes[benchmark] ?? [];
  const days = since ? [...new Set([...bench.map((r) => r.date), ...fills.map((f) => f.date)])].filter((d) => d >= since && d <= o.today).sort() : [];
  const benchStart = since ? closeOn(bench, days[0] ?? since) : null;
  const series: PaperBook['series'] = [];
  let next = 0;
  for (const d of days) {
    let that = 0;
    while (next < fills.length && fills[next]!.date <= d) apply(fills[next++]!, that++);
    const b = closeOn(bench, d);
    series.push({ date: d, value: cents(worth(d)), benchmark: b !== null && benchStart ? cents((o.startUsd * b) / benchStart) : null });
  }
  while (next < fills.length) apply(fills[next++]!, 0);   // fills after the benchmark's last day

  const latest = series.at(-1)?.date ?? o.today;
  const positions: PaperPosition[] = [...held].map(([ticker, h]) => {
    const price = closeOn(closes[ticker], latest) ?? h.cost / h.quantity;
    return { ticker, quantity: h.quantity, cost: h.cost, price, value: cents(h.quantity * price) };
  });
  for (const t of trades) if (t.status === 'filled' && t.side === 'buy' && t.price) {
    const now = closeOn(closes[t.ticker], latest);
    if (now !== null) t.sincePct = now / t.price - 1;
  }
  const value = cents(cash + positions.reduce((a, p) => a + p.value, 0));
  const lastBench = series.at(-1)?.benchmark ?? null;
  return {
    startUsd: o.startUsd, since, cash, value, positions, series, trades: trades.reverse(),   // newest call first, as the page lists them
    returnPct: since ? value / o.startUsd - 1 : null, benchmarkPct: lastBench !== null ? lastBench / o.startUsd - 1 : null, benchmark,
  };
}

// ---------- the starting money, the one thing kept ----------
const paperFile = (dir: string) => path.join(dir, 'paper.json');
const whole = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= PAPER_MIN && (v as number) <= PAPER_MAX ? (v as number) : null);

export function readPaperStart(dir: string): number {
  try { return whole((JSON.parse(fs.readFileSync(paperFile(dir), 'utf8')) as { startUsd?: unknown }).startUsd) ?? PAPER_START_USD; } catch { return PAPER_START_USD; }
}

/** The paper money to start with, in whole dollars from $100 to $10,000,000; anything else is refused. */
export function savePaperStart(dir: string, raw: unknown): number {
  const v = whole(raw);
  if (v === null) throw new Error(`the paper money is a whole number of dollars from $${PAPER_MIN} to $${PAPER_MAX.toLocaleString('en-US')}`);
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(paperFile(dir), JSON.stringify({ startUsd: v }, null, 2) + '\n');
  return v;
}
