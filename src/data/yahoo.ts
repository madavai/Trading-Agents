// Daily prices from Yahoo Finance's public chart service (no key), as the desk reads them: one row per trading day, in
// the exchange's own calendar, adjusted for splits and dividends so averages do not jump, with rows missing a price
// left out rather than filled in. A day the service lists with its prices still blank (for a while after a session ends,
// until its end-of-day figures are filled in) is named in `unfilled`, so the desk can say so instead of skipping it.
import { addDays, daysBetween } from './dates.js';
import { getJson, NoData } from './http.js';
import { normalizeSymbol } from './symbols.js';

export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
export interface Meta {
  symbol: string; currency?: string; exchange?: string; type?: string; name?: string; price?: number; timezone?: string;
  /** The current or latest regular session the service knows of: its day in the exchange's calendar, its opening and close (ms). */
  session?: { date: string; start: number; end: number };
}
/** A dividend: its ex-dividend day in the exchange's calendar, and the amount per share as the chart service gives it
 *  (in the quote currency, adjusted for later splits, so it is on the same footing as today's price). */
export interface Dividend { date: string; amount: number }
/** `unfilled`: days after the last row that the service lists with blank prices (their figures not filled in yet).
 *  `dividends`: those that went ex-dividend in the range, oldest first. `traded`: the same days at the prices the stock
 *  traded at (adjusted for later splits only, as an exchange's own history shows them), for a chart a person compares with
 *  prices quoted anywhere: `bars` lowers every day before a dividend by it, so a five-year low there is a price never traded. */
export interface Series { meta: Meta; bars: Bar[]; unfilled?: string[]; dividends?: Dividend[]; traded?: Bar[] }

interface ChartJson {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; currency?: string; exchangeName?: string; fullExchangeName?: string; instrumentType?: string; longName?: string; shortName?: string; regularMarketPrice?: number; gmtoffset?: number; exchangeTimezoneName?: string; currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>; adjclose?: Array<{ adjclose?: Array<number | null> }> };
      events?: { dividends?: Record<string, { amount?: number; date?: number }> };
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

export const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const cache = new Map<string, Promise<Series>>();

const epoch = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turns the chart service's answer into rows. Exported for the tests. */
export function parseChart(json: ChartJson, symbol: string): Series {
  const r = json.chart?.result?.[0];
  if (!r) throw new NoData(`Yahoo Finance has no prices for ${symbol}${json.chart?.error?.description ? ` (${json.chart.error.description})` : ''}`);
  const m = r.meta ?? {}, q = r.indicators?.quote?.[0] ?? {}, adj = r.indicators?.adjclose?.[0]?.adjclose;
  const offset = m.gmtoffset ?? 0, dayOf = (ts: number) => new Date((ts + offset) * 1000).toISOString().slice(0, 10);
  const rows: Array<{ bar: Bar; traded: Bar }> = [], blank: string[] = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const open = num(q.open?.[i]), high = num(q.high?.[i]), low = num(q.low?.[i]), close = num(q.close?.[i]);
    if (open === null || high === null || low === null || close === null || close <= 0) { blank.push(dayOf(ts)); return; }
    const a = num(adj?.[i]), k = a !== null ? a / close : 1, date = dayOf(ts), volume = num(q.volume?.[i]) ?? 0;
    rows.push({ bar: { date, open: open * k, high: high * k, low: low * k, close: close * k, volume }, traded: { date, open, high, low, close, volume } });
  });
  const seen = new Set<string>();   // one row a day: the chart service can repeat today's row
  const kept = rows.filter((x) => (seen.has(x.bar.date) ? false : (seen.add(x.bar.date), true)));
  const unique = kept.map((x) => x.bar);
  const lastDay = unique.at(-1)?.date ?? '', unfilled = [...new Set(blank.filter((d) => d > lastDay))];
  const reg = m.currentTradingPeriod?.regular, session = reg?.start && reg.end ? { date: dayOf(reg.start), start: reg.start * 1000, end: reg.end * 1000 } : undefined;
  const paid = new Map<string, number>();   // one a day: the service keys them by time, and a day is the dividend
  for (const d of Object.values(r.events?.dividends ?? {})) {
    const amount = num(d.amount);
    if (amount !== null && amount > 0 && typeof d.date === 'number' && Number.isFinite(d.date)) paid.set(dayOf(d.date), amount);
  }
  return {
    meta: { symbol: m.symbol ?? symbol, currency: m.currency, exchange: m.fullExchangeName ?? m.exchangeName, type: m.instrumentType, name: m.longName ?? m.shortName, price: m.regularMarketPrice, timezone: m.exchangeTimezoneName, session },
    bars: unique, unfilled, dividends: [...paid].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
    traded: kept.map((x) => x.traded),
  };
}

async function fetchDaily(symbol: string, from: string, to: string): Promise<Series> {
  const qs = `period1=${epoch(from)}&period2=${epoch(addDays(to, 1))}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  let last: unknown;
  for (const host of HOSTS) {
    try { return parseChart(await getJson<ChartJson>(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`), symbol); }
    catch (e) { if (e instanceof NoData) throw e; last = e; }
  }
  throw last;
}

/** Daily rows for a symbol from `from` to `to` (both included), never after `to`. */
export async function daily(raw: string, from: string, to: string): Promise<Series> {
  const symbol = normalizeSymbol(raw), key = `${symbol}|${from}|${to}`;
  if (!cache.has(key)) {
    const p = fetchDaily(symbol, from, to);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  const s = await cache.get(key)!;
  const within = (b: Bar) => b.date >= from && b.date <= to;
  const bars = s.bars.filter(within), lastDay = bars.at(-1)?.date ?? '';
  return { meta: s.meta, bars, unfilled: (s.unfilled ?? []).filter((d) => d > lastDay && d <= to), dividends: (s.dividends ?? []).filter((d) => d.date >= from && d.date <= to), ...(s.traded ? { traded: s.traded.filter(within) } : {}) };
}

/** Daily rows up to the analysis date with enough history before it for the slowest average (200 trading days). */
export async function history(raw: string, analysis: string, calendarDays = 420): Promise<Series> {
  const s = await daily(raw, addDays(analysis, -calendarDays), analysis);
  if (!s.bars.length) throw new NoData(`Yahoo Finance has no prices for ${normalizeSymbol(raw)} on or before ${analysis}`);
  const lastDate = s.bars[s.bars.length - 1]!.date, gap = daysBetween(lastDate, analysis);
  if (gap > 7) throw new NoData(`the latest price for ${normalizeSymbol(raw)} is from ${lastDate}, ${gap} days before ${analysis}: the symbol may be delisted or not traded`);
  return s;
}

/** For the tests: forget what was fetched. */
export const clearCache = (): void => cache.clear();
