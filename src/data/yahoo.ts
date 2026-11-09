// Daily prices from Yahoo Finance's public chart service (no key), as the desk reads them: one row per trading day, in
// the exchange's own calendar, adjusted for splits and dividends so averages do not jump, with rows missing a price
// left out rather than filled in. A day the service lists with its prices still blank (for a while after a session ends,
// until its end-of-day figures are filled in) is named in `unfilled`, and one blank among the rows in `missing`, so the
// desk can say so instead of skipping it. A volume the service does not give is null, never a zero. Each answer carries
// when it was read (`fetchedAt`), and is kept in memory no longer than on disk, so a run that goes on past the close
// reads the close, not the price of the afternoon.
import { addDays, daysBetween } from './dates.js';
import { priceMarket, type PriceMarket } from './delay.js';
import { getJsonAt, keepFor, NoData } from './http.js';
import { normalizeSymbol } from './symbols.js';

/** `volume` is null when the source does not give it: never counted as a zero. */
export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number | null }
export interface Meta {
  symbol: string; currency?: string; exchange?: string; type?: string; name?: string; price?: number; timezone?: string;
  /** The current or latest regular session the service knows of: its day in the exchange's calendar, its opening and close (ms). */
  session?: { date: string; start: number; end: number };
  /** The market the prices are from, for how late they may be (data/delay.ts): a US stock or fund on a checked exchange, a
   *  coin, or any other. */
  market?: PriceMarket;
}
/** A dividend: its ex-dividend day in the exchange's calendar, and the amount per share as the chart service gives it
 *  (in the quote currency, adjusted for later splits, so it is on the same footing as today's price). */
export interface Dividend { date: string; amount: number }
/** `unfilled`: days after the last row that the service lists with blank prices (their figures not filled in yet).
 *  `dividends`: those that went ex-dividend in the range, oldest first. `traded`: the same days at the prices the stock
 *  traded at (adjusted for later splits only, as an exchange's own history shows them), for a chart a person compares with
 *  prices quoted anywhere: `bars` lowers every day before a dividend by it, so a five-year low there is a price never traded. */
export interface Series {
  meta: Meta; bars: Bar[]; unfilled?: string[]; dividends?: Dividend[]; traded?: Bar[];
  /** Days among the rows (after the first) that the service lists with blank prices: a session whose prices are missing. */
  missing?: string[];
  /** Days the service gave no dividend-adjusted close for: those rows are adjusted for splits only. */
  unadjusted?: string[];
  /** When the answer was read from the source (ms), or from the desk's kept copy of it. */
  fetchedAt?: number;
}

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
const cache = new Map<string, { at: number; series: Promise<Series> }>();

const epoch = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A time's day in the exchange's own calendar. By its time zone's name when the answer gives one, so each row keeps its
 *  own summer or winter time: the answer's offset is only the one in force when it was read, and a row stamped at the
 *  exchange's midnight (futures at New York's, currencies at London's) would land a day early across a change. */
function dayIn(zone: string | undefined, offset: number): (ts: number) => string {
  const byOffset = (ts: number) => new Date((ts + offset) * 1000).toISOString().slice(0, 10);
  if (!zone) return byOffset;
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return (ts) => f.format(new Date(ts * 1000));
  } catch { return byOffset; }   // a zone this computer does not know
}

/** Turns the chart service's answer into rows. Exported for the tests. */
export function parseChart(json: ChartJson, symbol: string): Series {
  const r = json.chart?.result?.[0];
  if (!r) throw new NoData(`Yahoo Finance has no prices for ${symbol}${json.chart?.error?.description ? ` (${json.chart.error.description})` : ''}`);
  const m = r.meta ?? {}, q = r.indicators?.quote?.[0] ?? {}, adj = r.indicators?.adjclose?.[0]?.adjclose;
  const dayOf = dayIn(m.exchangeTimezoneName, m.gmtoffset ?? 0);
  const rows: Array<{ bar: Bar; traded: Bar; adjusted: boolean }> = [], blank: string[] = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const open = num(q.open?.[i]), high = num(q.high?.[i]), low = num(q.low?.[i]), close = num(q.close?.[i]);
    if (open === null || high === null || low === null || close === null || close <= 0) { blank.push(dayOf(ts)); return; }
    const a = num(adj?.[i]), k = a !== null ? a / close : 1, date = dayOf(ts), v = num(q.volume?.[i]), volume = v !== null && v >= 0 ? v : null;
    rows.push({ bar: { date, open: open * k, high: high * k, low: low * k, close: close * k, volume }, traded: { date, open, high, low, close, volume }, adjusted: a !== null });
  });
  const seen = new Set<string>();   // one row a day: the chart service can repeat today's row
  const kept = rows.filter((x) => (seen.has(x.bar.date) ? false : (seen.add(x.bar.date), true)));
  const unique = kept.map((x) => x.bar);
  const firstDay = unique[0]?.date ?? '', lastDay = unique.at(-1)?.date ?? '', unfilled = [...new Set(blank.filter((d) => d > lastDay))];
  const missing = [...new Set(blank.filter((d) => d > firstDay && d < lastDay && !seen.has(d)))].sort();
  const reg = m.currentTradingPeriod?.regular, session = reg?.start && reg.end ? { date: dayOf(reg.start), start: reg.start * 1000, end: reg.end * 1000 } : undefined;
  const paid = new Map<string, number>();   // one a day: the service keys them by time, and a day is the dividend
  for (const d of Object.values(r.events?.dividends ?? {})) {
    const amount = num(d.amount);
    if (amount !== null && amount > 0 && typeof d.date === 'number' && Number.isFinite(d.date)) paid.set(dayOf(d.date), amount);
  }
  return {
    meta: { symbol: m.symbol ?? symbol, currency: m.currency, exchange: m.fullExchangeName ?? m.exchangeName, type: m.instrumentType, name: m.longName ?? m.shortName, price: m.regularMarketPrice, timezone: m.exchangeTimezoneName, session, market: priceMarket(m) },
    bars: unique, unfilled, missing, dividends: [...paid].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
    traded: kept.map((x) => x.traded), unadjusted: kept.filter((x) => !x.adjusted).map((x) => x.bar.date),
  };
}

async function fetchDaily(symbol: string, from: string, to: string): Promise<Series> {
  const qs = `period1=${epoch(from)}&period2=${epoch(addDays(to, 1))}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  let last: unknown;
  for (const host of HOSTS) {
    try { const { value, at } = await getJsonAt<ChartJson>(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`); return { ...parseChart(value, symbol), fetchedAt: at }; }
    catch (e) { if (e instanceof NoData) throw e; last = e; }
  }
  throw last;
}

/** How long a series is kept in memory: as long as the disk keeps the chart service's answer, and no longer. */
const KEEP_MS = keepFor(`${HOSTS[0]}/v8/finance/chart/`);

/** Daily rows for a symbol from `from` to `to` (both included), never after `to`. */
export async function daily(raw: string, from: string, to: string): Promise<Series> {
  const symbol = normalizeSymbol(raw), key = `${symbol}|${from}|${to}`, hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= KEEP_MS) {
    const series = fetchDaily(symbol, from, to), kept = { at: Date.now(), series };
    cache.set(key, kept);
    // Its five minutes run from when the source was read: the answer may be the disk copy, already minutes old.
    series.then((s) => { if (s.fetchedAt !== undefined) kept.at = s.fetchedAt; }, () => { if (cache.get(key)?.series === series) cache.delete(key); });
  }
  const s = await cache.get(key)!.series;
  const within = (b: Bar) => b.date >= from && b.date <= to;
  const bars = s.bars.filter(within), firstDay = bars[0]?.date ?? '', lastDay = bars.at(-1)?.date ?? '';
  return {
    meta: s.meta, bars, unfilled: (s.unfilled ?? []).filter((d) => d > lastDay && d <= to), missing: (s.missing ?? []).filter((d) => d > firstDay && d < lastDay),
    dividends: (s.dividends ?? []).filter((d) => d.date >= from && d.date <= to), unadjusted: (s.unadjusted ?? []).filter((d) => d >= from && d <= to),
    ...(s.traded ? { traded: s.traded.filter(within) } : {}), ...(s.fetchedAt !== undefined ? { fetchedAt: s.fetchedAt } : {}),
  };
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
