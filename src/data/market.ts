// What the market tools answer, as text an agent reads: the instrument's identity, price rows, indicator windows and
// the checked price table every exact number must come from. Everything is held to the analysis date.
// The checked price table and its rules are adapted from TradingAgents (tradingagents/dataflows/vendors/yahoo/
// snapshot.py and agents/context.py), Apache License 2.0.
import { analysisDate, addDays, isHistorical, today, window } from './dates.js';
import { compute, INDICATORS, INDICATOR_NAMES, isIndicator, type IndicatorName } from './indicators.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';
import { daily, history, type Bar, type Series } from './yahoo.js';

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : v.toFixed(2));
const vol = (v: number) => Math.round(v).toLocaleString('en-US');
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
  lines.push(state.open ? `Latest trading day on or before it: ${last.date}, still trading: latest price ${f2(last.close)} (not a close)` : `Latest trading day on or before it: ${last.date}, close ${f2(last.close)}`);
  lines.push(...state.lines.map((l) => l.replace(/^- /, '')));
  lines.push('', `Refer to it by this exact ticker in every report, keeping any exchange suffix. Do not substitute a different company or ticker unless a tool result disproves this identity.${kind === 'crypto asset' ? ' It is a crypto asset, not a company: do not assume company fundamentals exist.' : ''}`);
  return lines.join('\n');
}

/** A time of day in the exchange's own zone, as a person reads it. */
const clock = (ms: number, zone = 'UTC'): string => {
  try { return `${new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone })} ${zone} time`; } catch { return `${new Date(ms).toISOString().slice(11, 16)} UTC`; }
};

/** What the latest row of a series (held to `upTo`) is: a session still trading, a finished one, one not open yet, or
 * followed by a session the source lists with blank prices. The lines say so plainly, so an agent never calls a price
 * still moving "the close", never hedges a final row as partial, and never says a session that happened had no trading. */
export function latestState(s: Series, upTo: string, now = Date.now()): { open: boolean; lines: string[] } {
  const last = s.bars[s.bars.length - 1]!, unfilled = s.unfilled?.at(-1), session = s.meta.session;
  const open = !!session && session.date === last.date && now >= session.start && now < session.end;
  if (unfilled) return { open: false, lines: [`- **The source lists a session on ${unfilled}, but its prices are not filled in yet (this happens for a while after a session ends). Every figure here is as of ${last.date}. Do not call ${last.date} the latest session, and do not say ${unfilled} had no trading: say its prices were not available yet.**`] };
  if (open) return { open, lines: [`- **The latest row, ${last.date}, is a session still trading (it closes at ${clock(session!.end, s.meta.timezone)}). Its "close" is the latest price so far, not a close; its high, low, volume and every indicator on it will change. Call it the latest price, never the close, and do not treat a level as broken or held on this row alone.**`] };
  if (session && session.date === last.date) return { open, lines: [`- The latest row, ${last.date}, is a finished session: its figures are final.`] };
  if (session && session.date > last.date && session.date <= upTo && now < session.start) return { open, lines: [`- ${session.date}'s session has not opened yet (it opens at ${clock(session.start, s.meta.timezone)}): the latest row, ${last.date}, is the latest finished session.`] };
  if (!session && last.date === today()) return { open, lines: ['- **The latest row is today\'s session. If the market is still open it is partial: its close, high, low and volume are the latest so far, and every indicator on it will change by the close. Do not treat a level as broken or held on this row alone.**'] };
  return { open, lines: [] };
}

const MAX_ROWS = 260;

export async function priceHistory(raw: string, analysis: string, start: string, end: string): Promise<string> {
  const day = analysisDate(analysis), [s, e] = window(start, end, day);
  const series = await daily(raw, s, e);
  if (!series.bars.length) return `No trading rows for ${resolved(raw)} from ${s} to ${e}.`;
  const rows = series.bars.slice(-MAX_ROWS), notes = latestState(series, e).lines;
  const head = [`Daily prices for ${resolved(raw)} from ${s} to ${e} (${series.bars.length} trading days${series.bars.length > MAX_ROWS ? `, the last ${MAX_ROWS} shown` : ''}; adjusted for splits and dividends${series.meta.currency ? `; ${series.meta.currency}` : ''})`, '', 'Date | Open | High | Low | Close | Volume', '---|---:|---:|---:|---:|---:'];
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
    ...state.lines, `- Prices adjusted for splits and dividends${s.meta.currency ? `, in ${s.meta.currency}` : ''}.`, '',
    '### Latest row', '', '| Field | Value |', '|---|---:|',
    `| Open | ${f2(last.open)} |`, `| High | ${f2(last.high)} |`, `| Low | ${f2(last.low)} |`, `| ${state.open ? 'Latest price (still trading)' : 'Close'} | ${f2(last.close)} |`, `| Volume | ${vol(last.volume)} |`, '',
    '### Indicators on the latest row', '', '| Indicator | Value |', '|---|---:|',
    ...SNAPSHOT_INDICATORS.map((n) => `| ${n} | ${f2(compute(n, bars).at(-1))} |`), '',
    `### The last ${recent.length} closes`, '', '| Date | Close |', '|---|---:|',
    ...recent.map((b) => `| ${b.date} | ${f2(b.close)} |`), '',
    'Use this table as the source of truth for every exact price, level and indicator value. If another tool disagrees with it, say so rather than inventing a reconciled number. Do not claim historical validation, support or resistance bounces, or exact percentage moves unless a tool result shows them with dates and prices.',
  ];
  return lines.join('\n');
}
