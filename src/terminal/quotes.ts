// Prices for the dashboard, from Yahoo Finance's public chart service: a quote with the day's intraday points for a small
// chart, and daily history with the 50- and 200-day averages. Yahoo's free prices may be delayed by up to 15 minutes, and
// the page says so. A symbol that cannot be priced is reported as unavailable, never as a zero.
import { addDays, today } from '../data/dates.js';
import { getJson, NoData, Unavailable } from '../data/http.js';
import { compute } from '../data/indicators.js';
import { safeSymbol } from '../data/symbols.js';
import { daily, HOSTS } from '../data/yahoo.js';

export interface Quote {
  symbol: string; name?: string; currency?: string; price: number; previousClose: number | null; change: number | null; changePct: number | null;
  open: boolean; asOf: string; points: number[];
}
export type QuoteResult = Quote | { symbol: string; error: 'unavailable' | 'no-data'; message: string };

interface IntradayJson {
  chart?: { result?: Array<{
    meta?: { symbol?: string; currency?: string; longName?: string; shortName?: string; instrumentType?: string; regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; regularMarketTime?: number; currentTradingPeriod?: { regular?: { start?: number; end?: number } } };
    timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  }> | null; error?: { description?: string } | null };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Turns Yahoo's one-day answer into a quote. Exported for the tests. */
export function parseQuote(json: IntradayJson, symbol: string, nowSec = Date.now() / 1000): Quote {
  const r = json.chart?.result?.[0];
  if (!r?.meta) throw new NoData(`Yahoo Finance has no price for ${symbol}${json.chart?.error?.description ? ` (${json.chart.error.description})` : ''}`);
  const m = r.meta, points = (r.indicators?.quote?.[0]?.close ?? []).filter(finite);
  const price = finite(m.regularMarketPrice) ? m.regularMarketPrice : points[points.length - 1];
  if (!finite(price) || price <= 0) throw new NoData(`Yahoo Finance has no price for ${symbol}`);
  const previousClose = finite(m.chartPreviousClose) && m.chartPreviousClose > 0 ? m.chartPreviousClose : finite(m.previousClose) && m.previousClose > 0 ? m.previousClose : null;
  const reg = m.currentTradingPeriod?.regular;
  // A coin trades all day; anything else is open between the exchange's own session start and end.
  const open = m.instrumentType === 'CRYPTOCURRENCY' || (finite(reg?.start) && finite(reg?.end) && nowSec >= reg!.start! && nowSec <= reg!.end!);
  const t = finite(m.regularMarketTime) ? m.regularMarketTime : (r.timestamp ?? [])[Math.max(0, (r.timestamp ?? []).length - 1)];
  return {
    symbol, name: m.longName ?? m.shortName, currency: m.currency, price, previousClose,
    change: previousClose === null ? null : price - previousClose, changePct: previousClose === null ? null : (price / previousClose - 1) * 100,
    open, asOf: finite(t) ? new Date(t * 1000).toISOString() : new Date(nowSec * 1000).toISOString(), points: points.length ? points : [price],
  };
}

const memo = new Map<string, { at: number; value: Promise<QuoteResult> }>();
const MEMO_MS = 10_000;

/** A quote, asked of Yahoo at most once every ten seconds however many pages ask. */
export function quote(raw: string): Promise<QuoteResult> {
  let symbol: string;
  try { symbol = safeSymbol(raw); } catch (e) { return Promise.resolve({ symbol: raw.slice(0, 20), error: 'no-data', message: (e as Error).message }); }
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = (async (): Promise<QuoteResult> => {
    let last: unknown;
    for (const host of HOSTS) {
      try { return parseQuote(await getJson<IntradayJson>(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`), symbol); } catch (e) { if (e instanceof NoData) return { symbol, error: 'no-data', message: e.message }; last = e; }
    }
    return { symbol, error: 'unavailable', message: last instanceof Unavailable ? last.message : `Yahoo Finance did not answer for ${symbol}` };
  })();
  memo.set(symbol, { at: Date.now(), value });
  return value;
}

export const clearQuotes = (): void => memo.clear();

export const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '5Y': 1830 } as const;
export type RangeKey = keyof typeof RANGES;
export const isRange = (s: string): s is RangeKey => s in RANGES;

export interface History {
  symbol: string; name?: string; currency?: string; range: RangeKey;
  bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  ma50: Array<number | null>; ma200: Array<number | null>;
}

/** Daily prices for a range, with the 50- and 200-day averages worked out from the history before it, so they are whole at the left edge. */
export async function history(raw: string, range: RangeKey): Promise<History> {
  const symbol = safeSymbol(raw), end = today(), from = addDays(end, -(RANGES[range] + 320));
  const s = await daily(symbol, from, end);
  if (!s.bars.length) throw new NoData(`Yahoo Finance has no daily prices for ${symbol}`);
  const m50 = compute('close_50_sma', s.bars), m200 = compute('close_200_sma', s.bars), cut = addDays(end, -RANGES[range]);
  const keep = s.bars.map((b, i) => ({ b, i })).filter(({ b }) => b.date >= cut);
  const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10_000) / 10_000);
  return {
    symbol, name: s.meta.name, currency: s.meta.currency, range,
    bars: keep.map(({ b }) => ({ date: b.date, open: round(b.open)!, high: round(b.high)!, low: round(b.low)!, close: round(b.close)!, volume: b.volume })),
    ma50: keep.map(({ i }) => round(m50[i])), ma200: keep.map(({ i }) => round(m200[i])),
  };
}

/** The strip of markets at the top of the page. */
export const MARKETS: Array<{ symbol: string; name: string; unit?: '%' }> = [
  { symbol: '^GSPC', name: 'S&P 500' }, { symbol: '^IXIC', name: 'Nasdaq' }, { symbol: '^DJI', name: 'Dow' },
  { symbol: '^VIX', name: 'Volatility (VIX)' }, { symbol: '^TNX', name: 'US 10-year yield', unit: '%' }, { symbol: 'BTC-USD', name: 'Bitcoin' },
];
