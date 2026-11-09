// The paper book: what following every one of the desk's calls would have done, with no money at stake. Each call is
// sized exactly as its order ticket would size it (the rating, a full position, the person's caps), must pass the same
// checks, and is filled at the first closing price after the call's day, as the market printed it: a price the person
// could really have had, nothing from hindsight (a dividend-adjusted close would lower it after every later dividend).
// Each dividend is paid into paper cash on its ex-dividend day for the shares held at the start of that day, as an
// account receives it; the benchmark's line is bought at the same start and paid its own dividends the same way. No
// costs are counted (Robinhood charges no commission). It is worked out afresh from the journal and daily closing prices
// every time, so it can never drift from the calls; only the starting money is kept.
//
// A figure of the book is shown only when every price it needs was read. When a stock the book needs (one with a call
// that asks for a buy) has no closing prices just now, its calls would change the cash, and every order is sized from the
// whole paper account, so no figure is known: the book is WITHHELD, with no total, no chart and no positions, and names
// each such stock (`missing`). A held stock is valued only at a close of its own, never at what it cost. The benchmark's
// closes are needed as much: the account is valued on its trading days and measured against it, so when they cannot be
// read the book is withheld too, never shown with a total stopped at the last fill.
//
// Paper follows a call only from the time it was made. A call recorded after the close it would have filled at (an
// analysis dated in the past, outside a back-test) is not followed: following it would buy at a price already known, and
// its date would move the record's start back, adding weeks of record that were never kept. It stays in the journal and
// is scored like any call. A call recorded before the desk kept its time is followed as it always was.
//
// Quantities are kept in whole steps of the order ticket's (a millionth of a coin, a whole share), so two buys of a coin
// add up to what they are, never a figure with a long tail of float noise.
import fs from 'node:fs';
import path from 'node:path';
import { addDays, daysBetween } from '../data/dates.js';
import { nextMarketDay } from '../data/holidays.js';
import { isCrypto } from '../data/symbols.js';
import { writeWhole } from './lock.js';
import { listed } from './agent-files.js';
import { actionOf, check, passes, propose, type TicketContext } from './ticket.js';
import type { Caps, Trading } from '../settings.js';
import { tradingDaysBetween } from './orders.js';
import type { Sectors } from './sectors.js';

/** A call as paper reads it; `recorded` is when the desk recorded it (an ISO time, kept in its journal entry since 9 Nov
 *  2026), absent for a call recorded before. */
export interface PaperCall { ticker: string; date: string; rating: string; recorded?: string }
/** Closing prices by symbol as the market printed them, oldest first. A symbol missing here could not be read; an empty
 *  list has no prices. */
export type Closes = Record<string, ReadonlyArray<{ date: string; close: number }>>;
/** Dividends by symbol: each ex-dividend day and the amount a share, on the same footing as the closes. */
export type Dividends = Record<string, ReadonlyArray<{ date: string; amount: number }>>;
/** A dividend paid into paper cash. */
export interface PaperDividend { ticker: string; date: string; perShare: number; quantity: number; usd: number }

export interface PaperTrade {
  ticker: string; callDate: string; rating: string;
  /** filled: bought or sold on paper; none: the call asks for no order, or its order would not pass the checks;
   *  waiting: its first close after the call has not come yet; unavailable: its prices could not be read; skipped: not
   *  followed on paper (an index, crypto other than Bitcoin and Ether, or a call recorded after the close it would have
   *  filled at); withheld: its own prices were read, but the
   *  book is withheld (another stock's could not be), so what it did on paper is not known just now. */
  status: 'filled' | 'none' | 'waiting' | 'unavailable' | 'skipped' | 'withheld';
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
  /** The stocks the book needs whose closing prices could not be read just now. When any is named, the book is withheld:
   *  cash, value, the dividends' total and both returns are null, and there are no positions and no chart. */
  missing: string[];
  cash: number | null; value: number | null; positions: PaperPosition[];
  /** The paper book's value at each close since the first call, beside the benchmark's, both starting at startUsd. */
  series: Array<{ date: string; value: number; benchmark: number | null }>;
  trades: PaperTrade[];
  /** The dividends paid into paper cash, oldest first, and their total. */
  dividends: PaperDividend[]; dividendsUsd: number | null;
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

/** New York's early closes (1:00 p.m.), as data/holidays.ts names them: the day after Thanksgiving, and Christmas Eve or
 *  the day before Independence Day when the NYSE lists one. */
const EARLY_CLOSES: ReadonlySet<string> = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
/** An instant as New York's clock shows it: "2026-11-09 15:04". */
const nyClock = (ms: number): string => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const v = (t: string) => f.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}`;
};
/** Why paper does not follow a call recorded after the close it would have filled at, or null when it follows it (or the
 *  call was recorded before the desk kept its time). A stock fills at the close of the market day after its call (4 p.m.
 *  New York time, 1 p.m. on an early close); a coin at the close of the day after its call (midnight UTC). */
export function lateWhy(c: PaperCall): string | null {
  const at = c.recorded ? Date.parse(c.recorded) : NaN;
  if (!Number.isFinite(at)) return null;
  if (isCrypto(c.ticker)) {
    const fill = addDays(c.date, 1), closes = Date.parse(`${addDays(c.date, 2)}T00:00:00Z`);
    return at < closes ? null : `Recorded on ${new Date(at).toISOString().slice(0, 10)}, after the close of ${fill} it would have filled at: paper follows a call only from when it was made, so an analysis dated in the past is not followed.`;
  }
  const fill = nextMarketDay(c.date), seen = nyClock(at);
  return seen < `${fill} ${EARLY_CLOSES.has(fill) ? '13:00' : '16:00'}` ? null
    : `Recorded on ${seen.slice(0, 10)}, after the close of ${fill} it would have filled at: paper follows a call only from when it was made, so an analysis dated in the past is not followed.`;
}

export function recordOf(calls: readonly PaperCall[], today: string): PaperRecord {
  const mine = calls.filter((c) => followed(c.ticker) && !lateWhy(c) && c.date <= today);
  const since = mine.map((c) => c.date).sort()[0] ?? null;
  return { since, weeks: since ? Math.floor(daysBetween(since, today) / 7) : 0, calls: mine.length };
}

/** The last close on or before `date`, or null. */
const closeOn = (rows: Closes[string] | undefined, date: string): number | null => {
  let last: number | null = null;
  for (const r of rows ?? []) { if (r.date > date) break; last = r.close; }
  return last;
};

/** A held stock with no close of its own on or before a day the book needs it: the book is withheld rather than value it
 *  at what it cost. */
class NoClose extends Error { constructor(readonly ticker: string) { super(`no close for ${ticker}`); } }

/** The prices the book needs that could not be read: the stocks with a followed call asking for a buy (a stock only ever
 *  sold on paper never holds anything, so it changes nothing), and the benchmark's once any call is followed, since the
 *  account is valued on its trading days. */
const missingFrom = (calls: readonly PaperCall[], closes: Closes, trading: Trading, benchmark: string): string[] => {
  const stocks = calls.filter((c) => followed(c.ticker) && !closes[c.ticker] && actionOf(c.rating, trading).startsWith('buy')).map((c) => c.ticker);
  const bench = calls.some((c) => followed(c.ticker)) && !closes[benchmark]?.length ? [benchmark] : [];
  return [...new Set([...stocks, ...bench])].sort();
};

/** Why a call's paper trade is not known while the book is withheld. */
export const withheldWhy = (missing: readonly string[], benchmark = 'SPY'): string =>
  `Not worked out just now: the paper record needs the closing prices of ${listed([...missing])}, which could not be read, and every order on paper is sized from the whole paper account${missing.includes(benchmark) ? `, valued on ${benchmark}'s trading days and measured against it` : ''}.`;

/** A quantity in whole steps of the order ticket's (a millionth of a coin), so sums carry no float noise. */
const units = (n: number): number => Math.round(n * 1e6) / 1e6;

/** sectors: where each ticker's sector comes from, for the sector limit (without it, each stock counts as its own).
 *  dividends: each symbol's dividends, paid on paper for the shares held (the benchmark's too). */
export function paperBook(calls: readonly PaperCall[], closes: Closes, o: { startUsd: number; trading: Trading; caps: Caps; today: string; benchmark?: string; sectors?: Pick<Sectors, 'context'>; dividends?: Dividends }): PaperBook {
  const benchmark = o.benchmark ?? 'SPY';
  const ordered = [...calls].filter((c) => c.date <= o.today).sort((a, b) => a.date.localeCompare(b.date));
  const trades: PaperTrade[] = [];
  // Each call's fill: the first close of its own stock after the call's day.
  const fills: Array<{ trade: PaperTrade; date: string; price: number }> = [];
  for (const c of ordered) {
    const base = { ticker: c.ticker, callDate: c.date, rating: c.rating };
    if (!followed(c.ticker)) { trades.push({ ...base, status: 'skipped', why: notFollowed(c.ticker) }); continue; }
    const late = lateWhy(c);
    if (late) { trades.push({ ...base, status: 'skipped', why: late }); continue; }
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
  const since = ordered.find((c) => followed(c.ticker) && !lateWhy(c))?.date ?? null;

  // Withheld: no total, no chart, no positions; each call that would have filled says why it is not known.
  const withheld = (missing: string[]): PaperBook => {
    for (const { trade: t } of fills) {
      delete t.side; delete t.quantity; delete t.price; delete t.fillDate; delete t.sincePct;
      Object.assign(t, { status: 'withheld', why: withheldWhy(missing, benchmark) });
    }
    return { startUsd: o.startUsd, since, missing, cash: null, value: null, positions: [], series: [], trades: [...trades].reverse(),
      dividends: [], dividendsUsd: null, returnPct: null, benchmarkPct: null, benchmark };
  };
  const missing = missingFrom(ordered.filter((c) => !lateWhy(c)), closes, o.trading, benchmark);
  if (missing.length) return withheld(missing);

  let cash = o.startUsd;
  const held = new Map<string, { quantity: number; cost: number }>(), boughtOn = new Map<string, string>();
  /** A held stock's last close on or before the day; never its cost (NoClose withholds the book instead). */
  const priceOf = (ticker: string, date: string): number => {
    const p = closeOn(closes[ticker], date);
    if (p === null) throw new NoClose(ticker);
    return p;
  };
  const worth = (date: string): number => {
    let v = cash;
    for (const [ticker, h] of held) v += h.quantity * priceOf(ticker, date);
    return v;
  };
  /** Fills one call's order on paper, if it passes; true when it placed one (which counts towards that day's orders). */
  const apply = (f: (typeof fills)[number], ordersThatDay: number): boolean => {
    const h = held.get(f.trade.ticker) ?? { quantity: 0, cost: 0 };
    const positions = [...held].map(([ticker, x]) => ({ symbol: ticker, quantity: x.quantity, price: priceOf(ticker, f.date) }));
    const bought = boughtOn.get(f.trade.ticker);
    const cryptoHeldUsd = cents(positions.filter((x) => isCrypto(x.symbol)).reduce((a, x) => a + x.quantity * (x.price ?? 0), 0));
    const context: TicketContext = { symbol: f.trade.ticker, rating: f.trade.rating, callDate: f.trade.callDate, accountValue: cents(worth(f.date)), buyingPower: cents(cash), held: h.quantity, price: f.price, ordersToday: ordersThatDay, positions, cryptoHeldUsd,
      ...(o.sectors ? { sector: o.sectors.context(f.trade.ticker, positions) } : {}), ...(bought && h.quantity > 0 ? { boughtOn: bought, heldDays: tradingDaysBetween(bought, f.date) } : {}) };
    const p = propose(context, o.trading, o.caps);
    if (!p.order) { f.trade.why = p.why.at(-1) ?? 'No order.'; return false; }
    const failing = check(p.order, context, o.trading, o.caps);
    if (!passes(failing)) { f.trade.why = `Its order would not pass: ${failing.filter((x) => !x.ok).map((x) => x.words).join('; ')}.`; return false; }
    const { side, quantity, limitPrice } = p.order, amount = cents(quantity * limitPrice);
    if (side === 'buy') { cash = cents(cash - amount); held.set(f.trade.ticker, { quantity: units(h.quantity + quantity), cost: cents(h.cost + amount) }); boughtOn.set(f.trade.ticker, f.date); }
    else {
      const left = units(h.quantity - quantity);
      cash = cents(cash + amount);
      if (left > 0) held.set(f.trade.ticker, { quantity: left, cost: cents(h.cost * (left / h.quantity)) }); else held.delete(f.trade.ticker);
    }
    Object.assign(f.trade, { status: 'filled', side, quantity, price: limitPrice, fillDate: f.date, why: `${side === 'buy' ? 'Bought' : 'Sold'} ${quantity} at the close of ${f.date}.` });
    return true;
  };
  // The orders placed on paper each day: a call that places none (a Sell of nothing held) leaves room for another.
  const placed = new Map<string, number>();
  const fill = (f: (typeof fills)[number]): void => { const n = placed.get(f.date) ?? 0; if (apply(f, n)) placed.set(f.date, n + 1); };

  // Dividends, oldest first: one goes ex on its day to the shares held at the start of that day, so it is paid before that
  // day's fills (a buy at that close is too late for it; a sale at that close still had it).
  const due = Object.entries(o.dividends ?? {}).flatMap(([ticker, list]) => list.map((x) => ({ ticker, ...x }))).sort((a, b) => a.date.localeCompare(b.date));
  const dividends: PaperDividend[] = [];
  let nextDividend = 0;
  const payUpTo = (date: string): void => {
    for (; nextDividend < due.length && due[nextDividend]!.date <= date; nextDividend++) {
      const x = due[nextDividend]!, h = held.get(x.ticker);
      if (!h || h.quantity <= 0 || !(x.amount > 0)) continue;
      const usd = cents(h.quantity * x.amount);
      cash = cents(cash + usd);
      dividends.push({ ticker: x.ticker, date: x.date, perShare: x.amount, quantity: h.quantity, usd });
    }
  };

  // Day by day from the first call, on the benchmark's trading days: the dividends and fills of that day, then the day's
  // value. The benchmark is bought with the starting money at the first day's close and is paid its dividends in cash.
  const bench = closes[benchmark] ?? [], benchDividends = o.dividends?.[benchmark] ?? [];
  const days = since ? [...new Set([...bench.map((r) => r.date), ...fills.map((f) => f.date)])].filter((d) => d >= since && d <= o.today).sort() : [];
  const benchStart = since ? closeOn(bench, days[0] ?? since) : null;
  const benchValue = (d: string): number | null => {
    const b = closeOn(bench, d);
    if (b === null || !benchStart) return null;
    const shares = o.startUsd / benchStart, paid = benchDividends.filter((x) => x.date > days[0]! && x.date <= d).reduce((a, x) => a + x.amount, 0);
    return cents(shares * (b + paid));
  };
  const series: PaperBook['series'] = [];
  let positions: PaperPosition[] = [], latest = o.today;
  try {
    let next = 0;
    for (const d of days) {
      payUpTo(d);
      while (next < fills.length && fills[next]!.date <= d) fill(fills[next++]!);
      series.push({ date: d, value: cents(worth(d)), benchmark: benchValue(d) });
    }
    while (next < fills.length) { payUpTo(fills[next]!.date); fill(fills[next++]!); }   // fills after the benchmark's last day
    payUpTo(o.today);

    latest = series.at(-1)?.date ?? o.today;
    positions = [...held].map(([ticker, h]) => {
      const price = priceOf(ticker, latest);
      return { ticker, quantity: h.quantity, cost: h.cost, price, value: cents(h.quantity * price) };
    });
  } catch (e) {
    if (e instanceof NoClose) return withheld([e.ticker]);
    throw e;
  }
  for (const t of trades) if (t.status === 'filled' && t.side === 'buy' && t.price) {
    const now = closeOn(closes[t.ticker], latest);
    if (now !== null) t.sincePct = now / t.price - 1;
  }
  const value = cents(cash + positions.reduce((a, p) => a + p.value, 0));
  const lastBench = series.at(-1)?.benchmark ?? null;
  return {
    startUsd: o.startUsd, since, missing: [], cash, value, positions, series, trades: trades.reverse(),   // newest call first, as the page lists them
    dividends, dividendsUsd: cents(dividends.reduce((a, x) => a + x.usd, 0)),
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
