// Daily prices from Yahoo Finance's public chart service (no key), as the desk reads them: one row per trading day, in
// the exchange's own calendar, adjusted for splits and dividends so averages do not jump, with rows missing a price
// left out rather than filled in.
import { addDays, daysBetween } from './dates.js';
import { getJson, NoData } from './http.js';
import { normalizeSymbol } from './symbols.js';

export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
export interface Meta { symbol: string; currency?: string; exchange?: string; type?: string; name?: string; price?: number; timezone?: string }
export interface Series { meta: Meta; bars: Bar[] }

interface ChartJson {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; currency?: string; exchangeName?: string; fullExchangeName?: string; instrumentType?: string; longName?: string; shortName?: string; regularMarketPrice?: number; gmtoffset?: number; exchangeTimezoneName?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>; adjclose?: Array<{ adjclose?: Array<number | null> }> };
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
  const offset = m.gmtoffset ?? 0;
  const bars: Bar[] = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const open = num(q.open?.[i]), high = num(q.high?.[i]), low = num(q.low?.[i]), close = num(q.close?.[i]);
    if (open === null || high === null || low === null || close === null || close <= 0) return;
    const a = num(adj?.[i]), k = a !== null ? a / close : 1;
    bars.push({ date: new Date((ts + offset) * 1000).toISOString().slice(0, 10), open: open * k, high: high * k, low: low * k, close: close * k, volume: num(q.volume?.[i]) ?? 0 });
  });
  const seen = new Set<string>();   // one row a day: the chart service can repeat today's row
  const unique = bars.filter((b) => (seen.has(b.date) ? false : (seen.add(b.date), true)));
  return {
    meta: { symbol: m.symbol ?? symbol, currency: m.currency, exchange: m.fullExchangeName ?? m.exchangeName, type: m.instrumentType, name: m.longName ?? m.shortName, price: m.regularMarketPrice, timezone: m.exchangeTimezoneName },
    bars: unique,
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
  return { meta: s.meta, bars: s.bars.filter((b) => b.date >= from && b.date <= to) };
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
