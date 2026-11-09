// What the market tools answer, as text an agent reads: the instrument's identity, price rows, indicator windows and
// the checked price table every exact number must come from. Everything is held to the analysis date.
// The checked price table and its rules are adapted from TradingAgents (tradingagents/dataflows/vendors/yahoo/
// snapshot.py and agents/context.py), Apache License 2.0.
import { analysisDate, addDays, isHistorical, today, window } from './dates.js';
import { NoData } from './http.js';
import { compute, INDICATORS, INDICATOR_NAMES, isIndicator, type IndicatorName } from './indicators.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';
import { daily, history, type Bar, type Series } from './yahoo.js';

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : v.toFixed(2));
/** A volume as the tables show it: one the source does not give is "not given", never a zero. */
export const vol = (v: number | null): string => (v === null ? 'not given' : Math.round(v).toLocaleString('en-US'));
const listDays = (days: string[]) => (days.length <= 6 ? days.join(', ') : `${days.slice(0, 5).join(', ')} and ${days.length - 5} more`);

/** How the rows are adjusted, as the tables say it: "adjusted for splits and dividends" only when every row is. */
export function adjustedWords(s: Pick<Series, 'bars' | 'unadjusted'>): string {
  const shown = new Set(s.bars.map((b) => b.date)), plain = (s.unadjusted ?? []).filter((d) => shown.has(d));
  if (!plain.length) return 'adjusted for splits and dividends';
  if (plain.length === shown.size) return 'adjusted for splits only: the source gave no dividend-adjusted closes, so a dividend shows as a fall on its ex-dividend day';
  return `adjusted for splits and dividends, except ${plain.length === 1 ? 'the row' : `${plain.length} rows`} the source gave no dividend-adjusted close for (${listDays(plain)}), which ${plain.length === 1 ? 'is' : 'are'} adjusted for splits only`;
}
const typeWord = (t: string | undefined, raw: string) => (cryptoBase(raw) || t === 'CRYPTOCURRENCY' ? 'crypto asset' : ({ EQUITY: 'stock', ETF: 'fund (ETF)', MUTUALFUND: 'fund', INDEX: 'index', FUTURE: 'future', CURRENCY: 'currency pair' } as Record<string, string>)[t ?? ''] ?? 'instrument');
const resolved = (raw: string) => { const s = normalizeSymbol(raw); return s === raw.trim().toUpperCase() ? s : `${s} (from ${raw.trim()})`; };

export async function instrument(raw: string, analysis: string): Promise<string> {
  const day = analysisDate(analysis), s = await history(raw, day, 30), last = s.bars[s.bars.length - 1]!;
  const kind = typeWord(s.meta.type, raw), old = isHistorical(day), state = latestState(s, day);
  const lines = [`Instrument: ${resolved(raw)}`, `Kind: ${kind}`];
  if (s.meta.name) lines.push(old ? `Name: ${s.meta.name} (its current name, given only to identify it; on ${day} it may have been named differently)` : `Name: ${s.meta.name}`);
  if (!old && s.meta.exchange) lines.push(`Exchange: ${s.meta.exchange}`);
  if (s.meta.currency) lines.push(`Quote currency: ${s.meta.currency}`);
  lines.push(`Analysis date: ${day}${old ? ' (a past day: use only what was known by then)' : ''}`);
  lines.push(`Latest trading day on or before it: ${last.date}, ${state.inline} ${f2(last.close)}${state.open ? ' (not a close)' : ''}`);
  lines.push(...state.lines.map((l) => l.replace(/^- /, '')));
  lines.push('', `Refer to it by this exact ticker in every report, keeping any exchange suffix. Do not substitute a different company or ticker unless a tool result disproves this identity.${kind === 'crypto asset' ? ' It is a crypto asset, not a company: do not assume company fundamentals exist.' : ''}`);
  return lines.join('\n');
}

/** A time of day in the exchange's own zone, as a person reads it. */
export const clock =(ms: number, zone = 'UTC'): string => {
  try { return `${new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone })} ${zone} time`; } catch { return `${new Date(ms).toISOString().slice(11, 16)} UTC`; }
};

/** How long after a session ends its figures are taken as final at the source: a margin of 15 minutes, so a row read sooner
 *  than that after the close is not called final. (How late Yahoo's live prices may be is said in data/delay.ts.) */
export const SETTLE_MS = 15 * 60_000;

/** What the latest row is. `open`: its close is not a final close; `label`: what the checked price table calls it;
 *  `inline`: the words before it in a sentence; `lines`: what the tools say about it, and about any session the rows lack. */
export interface LatestState { open: boolean; label: string; inline: string; lines: string[] }

/** The sessions the source lists with no prices among the rows: named, never skipped as if no trading happened. */
function gapLines(s: Series): string[] {
  const days = s.missing ?? [];
  if (!days.length) return [];
  const one = days.length === 1;
  return [`- **The source lists ${one ? 'a session' : 'sessions'} on ${listDays(days)} with no prices: ${one ? 'it is' : 'they are'} missing from these rows, so every average, count and change here skips ${one ? 'it' : 'them'} (a change across ${one ? 'it' : 'them'} spans two sessions). Do not say ${listDays(days)} had no trading: say ${one ? 'its' : 'their'} prices are not available from the source.**`];
}

/** What the latest row of a series (held to `upTo`) is: a session still trading, one read before its close was final, a
 * finished one, one not open yet, followed by a session the source lists with blank prices, or behind a session the
 * source's own record says has happened. "Final" is judged by when the rows were read (`fetchedAt`), not by the clock:
 * rows read at 13:00 are the 13:00 price however late they are shown. The lines say so plainly, so an agent never calls
 * a price still moving "the close", never hedges a final row as partial, and never says a session that happened had no
 * trading. */
export function latestState(s: Series, upTo: string, now = Date.now()): LatestState {
  const last = s.bars[s.bars.length - 1]!, unfilled = s.unfilled?.at(-1), session = s.meta.session, zone = s.meta.timezone, read = s.fetchedAt ?? now;
  const said = (st: Omit<LatestState, 'lines'>, lines: string[]): LatestState => ({ ...st, lines: [...lines, ...gapLines(s)] });
  const final = { open: false, label: 'Close', inline: 'close' };
  if (unfilled) return said(final, [`- **The source lists a session on ${unfilled}, but its prices are not filled in yet (this happens for a while after a session ends). Every figure here is as of ${last.date}. Do not call ${last.date} the latest session, and do not say ${unfilled} had no trading: say its prices were not available yet.**`]);
  if (session && session.date === last.date) {
    if (now < session.end) return said({ open: true, label: 'Latest price (still trading)', inline: 'still trading: latest price' }, [`- **The latest row, ${last.date}, is a session still trading (it closes at ${clock(session.end, zone)}). Its "close" is the latest price so far, not a close; its high, low, volume and every indicator on it will change. Call it the latest price, never the close, and do not treat a level as broken or held on this row alone.**`]);
    if (read < session.end + SETTLE_MS) {
      const at = clock(read, zone);
      return said({ open: true, label: `Latest price (read at ${at}, not the close)`, inline: `latest price as read at ${at}` }, [`- **The latest row, ${last.date}, was read at ${at}, ${read < session.end ? 'while its session was still trading' : 'just after its session ended'} (it ended at ${clock(session.end, zone)}, and its figures are taken as final ${SETTLE_MS / 60_000} minutes after). Its "close" is the latest price as read then, not the close; its high, low, volume and every indicator on it may still change. Call it the latest price as read at ${at}, never the close, and do not treat a level as broken or held on this row alone.**`]);
    }
    return said(final, [`- The latest row, ${last.date}, is a finished session: its figures are final.`]);
  }
  if (session && session.date > last.date && session.date <= upTo) {
    if (now < session.start) return said(final, [`- ${session.date}'s session has not opened yet (it opens at ${clock(session.start, zone)}): the latest row, ${last.date}, is the latest finished session.`]);
    return said(final, [`- **The source's own record shows a session on ${session.date}${now < session.end ? ', trading now' : ', which has ended'}, but its rows stop at ${last.date}: it has no prices yet for ${session.date}, nor for any session between ${last.date} and it. Every figure here is as of ${last.date}. Do not call ${last.date} the latest session, and do not say the days after it had no trading: say their prices are not available from the source yet.**`]);
  }
  if (!session && last.date === today()) return said(final, ['- **The latest row is today\'s session. If the market is still open it is partial: its close, high, low and volume are the latest so far, and every indicator on it will change by the close. Do not treat a level as broken or held on this row alone.**']);
  return said(final, []);
}

/** The last final close of a symbol on or before `upTo`, for the evening wrap-up's stops: the latest row, or the one before
 *  it when the latest is still trading or was read before its close was final. As traded (split-adjusted only), the price
 *  printed that day. */
export async function lastClose(raw: string, upTo: string, now = Date.now()): Promise<{ date: string; close: number }> {
  const s = await daily(raw, addDays(upTo, -14), upTo), rows = s.traded?.length === s.bars.length ? s.traded : s.bars;
  if (!rows.length) throw new NoData(`Yahoo Finance has no prices for ${normalizeSymbol(raw)} in the two weeks to ${upTo}`);
  const last = latestState(s, upTo, now).open ? rows.at(-2) : rows.at(-1);
  if (!last) throw new NoData(`Yahoo Finance has no finished session for ${normalizeSymbol(raw)} in the two weeks to ${upTo}`);
  return { date: last.date, close: last.close };
}

const MAX_ROWS = 260;

export async function priceHistory(raw: string, analysis: string, start: string, end: string): Promise<string> {
  const day = analysisDate(analysis), [s, e] = window(start, end, day);
  const series = await daily(raw, s, e);
  if (!series.bars.length) {
    // A session the source lists with its prices still blank is not a day with no trading.
    const blank = [...new Set([...(series.unfilled ?? []), ...(series.missing ?? [])])].filter((d) => d >= s && d <= e).sort(), one = blank.length === 1;
    if (!blank.length) return `No trading rows for ${resolved(raw)} from ${s} to ${e}.`;
    return `No prices yet for ${resolved(raw)} from ${s} to ${e}: the source lists ${one ? 'a session' : 'sessions'} on ${listDays(blank)}, but ${one ? 'its' : 'their'} prices are not filled in yet (this happens for a while after a session ends). Do not say ${listDays(blank)} had no trading: say ${one ? 'its' : 'their'} prices were not available yet.`;
  }
  const rows = series.bars.slice(-MAX_ROWS), notes = latestState(series, e).lines;
  const head = [`Daily prices for ${resolved(raw)} from ${s} to ${e} (${series.bars.length} trading days${series.bars.length > MAX_ROWS ? `, the last ${MAX_ROWS} shown` : ''}; ${adjustedWords(series)}${series.meta.currency ? `; ${series.meta.currency}` : ''})`, '', 'Date | Open | High | Low | Close | Volume', '---|---:|---:|---:|---:|---:'];
  return head.concat(rows.map((b) => `${b.date} | ${f2(b.open)} | ${f2(b.high)} | ${f2(b.low)} | ${f2(b.close)} | ${vol(b.volume)}`), notes.length ? ['', ...notes] : []).join('\n');
}

/** Indicator names from a model's words: one or several, comma separated, any case. */
export function indicatorList(input: string | string[]): { ok: IndicatorName[]; unknown: string[] } {
  const parts = (Array.isArray(input) ? input : input.split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { ok: [...new Set(parts.filter(isIndicator))], unknown: parts.filter((p) => !isIndicator(p)) };
}

export async function indicatorWindow(raw: string, analysis: string, names: string | string[], lookBackDays = 30): Promise<string> {
  const day = analysisDate(analysis), { ok, unknown } = indicatorList(names);
  if (!ok.length) return `None of "${[names].flat().join(', ')}" is an indicator this desk computes. Use: ${INDICATOR_NAMES.join(', ')}.`;
  const days = Math.max(5, Math.min(120, Math.round(lookBackDays))), from = addDays(day, -days);
  const s = await history(raw, day), out: string[] = [];
  for (const name of ok) {
    const values = compute(name, s.bars);
    const rows = s.bars.map((b, i) => [b, values[i]] as const).filter(([b]) => b.date >= from);
    out.push(`## ${name} for ${resolved(raw)}, ${from} to ${day} (trading days only)`, ...rows.map(([b, v]) => `${b.date}: ${f2(v)}`), '', INDICATORS[name], '');
    if ((name === 'vwma' || name === 'mfi') && rows.some(([, v]) => v === null)) out.push(`${name} is N/A on a day whose window has a session with no volume given by the source, or with no volume traded at all: a volume-weighted reading from no volume would be made up. Do not read N/A as a level.`, '');
  }
  out.push(...latestState(s, day).lines);
  if (unknown.length) out.push(`Not computed (unknown names): ${unknown.join(', ')}. Use: ${INDICATOR_NAMES.join(', ')}.`);
  return out.join('\n').trim();
}

export const SNAPSHOT_INDICATORS: IndicatorName[] = ['close_10_ema', 'close_50_sma', 'close_200_sma', 'rsi', 'boll', 'boll_ub', 'boll_lb', 'macd', 'macds', 'macdh', 'atr'];

export async function verifiedSnapshot(raw: string, analysis: string, lookBack = 30): Promise<string> {
  const day = analysisDate(analysis), s = await history(raw, day), bars: Bar[] = s.bars, last = bars[bars.length - 1]!, state = latestState(s, day);
  const recent = bars.slice(-Math.max(1, Math.min(30, Math.round(lookBack))));
  const lines = [
    `## Checked price table for ${resolved(raw)}`, '',
    `- Analysis date: ${day}`, `- Latest trading row used: ${last.date}`, '- Rows after the analysis date are excluded.',
    ...state.lines, `- Prices ${adjustedWords(s)}${s.meta.currency ? `, in ${s.meta.currency}` : ''}.`, '',
    '### Latest row', '', '| Field | Value |', '|---|---:|',
    `| Open | ${f2(last.open)} |`, `| High | ${f2(last.high)} |`, `| Low | ${f2(last.low)} |`, `| ${state.label} | ${f2(last.close)} |`, `| Volume | ${vol(last.volume)} |`, '',
    '### Indicators on the latest row', '', '| Indicator | Value |', '|---|---:|',
    ...SNAPSHOT_INDICATORS.map((n) => `| ${n} | ${f2(compute(n, bars).at(-1))} |`), '',
    `### The last ${recent.length} closes`, '', '| Date | Close |', '|---|---:|',
    ...recent.map((b) => `| ${b.date} | ${f2(b.close)} |`), '',
    'Use this table as the source of truth for every exact price, level and indicator value. If another tool disagrees with it, say so rather than inventing a reconciled number. Do not claim historical validation, support or resistance bounces, or exact percentage moves unless a tool result shows them with dates and prices.',
  ];
  return lines.join('\n');
}
