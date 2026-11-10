// Economic figures from FRED (the St. Louis Fed), through its public download (no key): rates, yields, inflation, jobs,
// growth, for the US and the euro area. For a past analysis date they come from FRED's archive of past releases (ALFRED),
// as it stood that day: only what had been published by then, at the values first given (or as revised by then). A
// figure released later, or a revision made later, never reaches an analysis of an earlier day; when the archive does
// not hold a series for that day, nothing is given, never today's revised figures. A figure is named by the period it
// stands for ("August 2026", not the first day FRED dates it on), and the change over a year is worked out from the same
// period a year earlier, so a change over a shorter window is never read as a yearly rate.
// The series names are TradingAgents' (tradingagents/dataflows/vendors/fred.py), Apache License 2.0.
import { addDays, analysisDate, isHistorical } from './dates.js';
import { getTextAt, NoData, readWords, Unavailable } from './http.js';
import { signed } from '../numbers.js';

export const SERIES: Record<string, [id: string, title: string]> = {
  fed_funds_rate: ['DFF', 'Federal funds effective rate, daily (percent)'],
  '2y_treasury': ['DGS2', '2-year Treasury yield (percent)'],
  '10y_treasury': ['DGS10', '10-year Treasury yield (percent)'],
  '30y_treasury': ['DGS30', '30-year Treasury yield (percent)'],
  yield_curve: ['T10Y2Y', '10-year minus 2-year Treasury spread (percentage points)'],
  cpi: ['CPIAUCSL', 'Consumer price index, all items (index)'],
  core_cpi: ['CPILFESL', 'Consumer price index, less food and energy (index)'],
  pce: ['PCEPI', 'PCE price index (index)'],
  core_pce: ['PCEPILFE', 'PCE price index, less food and energy (index)'],
  inflation_expectations: ['T10YIE', '10-year breakeven inflation (percent)'],
  real_gdp: ['GDPC1', 'Real GDP (billions of chained dollars, annual rate)'],
  gdp: ['GDP', 'GDP (billions of dollars, annual rate)'],
  industrial_production: ['INDPRO', 'Industrial production (index)'],
  unemployment: ['UNRATE', 'Unemployment rate (percent)'],
  payrolls: ['PAYEMS', 'Nonfarm payrolls (thousands of persons)'],
  initial_claims: ['ICSA', 'Initial jobless claims (number)'],
  m2: ['M2SL', 'M2 money supply (billions of dollars)'],
  vix: ['VIXCLS', 'VIX volatility index'],
  dollar_index: ['DTWEXBGS', 'Broad US dollar index'],
  consumer_sentiment: ['UMCSENT', 'University of Michigan consumer sentiment (index)'],
  housing_starts: ['HOUST', 'Housing starts (thousands of units, annual rate)'],
  retail_sales: ['RSAFS', 'Retail sales (millions of dollars)'],
  ecb_deposit_rate: ['ECBDFR', 'ECB deposit facility rate (percent)'],
  euro_hicp: ['CP0000EZ19M086NEST', 'Euro area harmonised consumer prices (index)'],
  germany_10y: ['IRLTLT01DEM156N', 'Germany 10-year government bond yield (percent)'],
  eur_usd: ['DEXUSEU', 'US dollars per euro'],
};

export interface Obs { date: string; value: number }
/** How many values the table shows, and how many months' last values the line above it lists before it lists quarters. */
const SHOWN = 40, MAX_MONTHS = 25;

/** Whether an answer is FRED's data download: its first line is the header, "observation_date,PCEPILFE" from FRED and
 *  "observation_date,PCEPILFE_20260924" from its archive (ALFRED); "DATE," in its older downloads. */
const isCsv = (text: string): boolean => /^\s*(observation_date|DATE)\s*,/i.test(text);

/** FRED's CSV download as rows, missing values ('.') left out. Exported for the tests. */
export function parseCsv(csv: string): Obs[] {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => line.split(',')).filter((c) => c.length >= 2 && c[1] !== '.' && c[1] !== '')
    .map(([d, v]) => ({ date: d!.trim(), value: Number(v) })).filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Number.isFinite(o.value));
}

type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** How often a series is reported, from the median gap between its observations. */
export function frequency(obs: Obs[]): Frequency {
  const gaps = obs.slice(1).map((o, i) => (Date.parse(o.date) - Date.parse(obs[i]!.date)) / 86_400_000).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 1;
  return median <= 3 ? 'daily' : median <= 10 ? 'weekly' : median <= 45 ? 'monthly' : median <= 120 ? 'quarterly' : 'yearly';
}

/** The period an observation stands for, as people name it: FRED dates a month's or a quarter's figure on its first day. */
export function periodOf(date: string, freq: Frequency): string {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7));
  if (freq === 'monthly') return `${new Date(Date.UTC(Number(y), m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
  if (freq === 'quarterly') return `the ${['first', 'second', 'third', 'fourth'][Math.floor((m - 1) / 3)]} quarter of ${y}`;
  if (freq === 'yearly') return y;
  return date;
}

/** The observation for the same period a year before `date` (for a daily or weekly series, the last one within ten days before it). */
function yearBefore(obs: Obs[], date: string): Obs | undefined {
  const target = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`, floor = addDays(target.replace(/-02-29$/, '-02-28'), -10);
  return [...obs].reverse().find((o) => o.date <= target && o.date >= floor);
}

export async function economicSeries(indicator: string, analysis: string, lookBackDays = 365): Promise<string> {
  const day = analysisDate(analysis), key = indicator.trim().toLowerCase(), known = SERIES[key];
  const id = known?.[0] ?? indicator.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(id)) throw new Error(`"${indicator}" is not a series name or a FRED series id`);
  const window = Math.max(30, Math.min(3650, lookBackDays));
  // Asked from far enough back that the same period a year before the latest one is there, even for a quarterly series.
  const from = addDays(day, -Math.max(window, 365) - 400), past = isHistorical(day);
  // A past day reads the series as the archive held it that day; today's download would carry every later release and
  // revision into it.
  const url = past ? `https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=${id}&vintage_date=${day}&cosd=${from}&coed=${day}`
    : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}&coed=${day}`;
  let read: { text: string; at: number };
  // Only FRED's data download is kept for the hour: a web page it answers with in its place (maintenance, a refusal) is
  // read as an outage below, and the next ask goes to FRED again rather than reading that page back.
  try { read = await getTextAt(url, { usable: isCsv }); } catch (e) {
    if (past && e instanceof NoData) throw new NoData(`FRED's archive of past releases (ALFRED) does not hold ${id} as it stood on ${day} (${(e as Error).message}); today's revised figures are not given for a past day, since they would carry what was published or revised later into it`);
    throw e;
  }
  const { text: csv, at } = read;
  if (!isCsv(csv)) throw new Unavailable(`${past ? "FRED's archive (ALFRED)" : 'FRED'} answered with something other than its data download (it may be down for maintenance)`);
  const all = parseCsv(csv).filter((o) => o.date <= day), freq = frequency(all);
  const obs = all.filter((o) => o.date >= addDays(day, -window));
  if (!obs.length) throw new NoData(`FRED has no ${id} values published by ${day} in this window`);
  const first = obs[0]!, last = obs[obs.length - 1]!, ago = yearBefore(all, last.date);
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toFixed(2));
  const plusMinus = (v: number) => { const t = fmt(Math.abs(v)); return Number(t.replace(/,/g, '')) === 0 ? t : `${v > 0 ? '+' : '-'}${t}`; };
  // A rate or a spread changes by percentage points; a level or an index changes by a percentage of itself as well. A
  // series asked by its FRED id is of units the desk does not know (a rate's percent change would be a percent of a
  // percent), so its change is in its own units alone; and nothing has a percentage change from zero.
  const points = /\((percent|percentage points)\)/.test(known?.[1] ?? '');
  const changeOf = (from: Obs) => {
    const d = last.value - from.value;
    if (points) return `${plusMinus(d)} percentage points`;
    if (!known) return `${plusMinus(d)} in the series' own units (no percentage change: the desk does not know this series' units)`;
    return from.value ? `${plusMinus(d)} (${signed((d / Math.abs(from.value)) * 100, 1)}%)` : `${plusMinus(d)} (no percentage change from zero)`;
  };
  // The table holds the last 40 values; a daily series has some 250 in a year. What came before the table is summed up,
  // so a move just before it is not hidden: the news analyst called the Fed's rate "flat all window" from 40 days of
  // 3.88, eleven days after it rose from 3.63 (NVDA, 9 Nov 2026).
  const shown = obs.slice(-SHOWN);
  const whole = obs.length > shown.length ? [(() => {
    const hi = obs.reduce((a, o) => (o.value > a.value ? o : a)), lo = obs.reduce((a, o) => (o.value < a.value ? o : a));
    const ends = new Map<string, Obs>();
    for (const o of obs) ends.set(o.date.slice(0, 7), o);
    const all = [...ends.entries()], quarters = all.length > MAX_MONTHS;
    const kept = quarters ? all.filter(([m], i) => Number(m.slice(5)) % 3 === 0 || i === all.length - 1) : all;
    const month = (m: string) => `${new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${m.slice(0, 4)}`;
    return `- The table below shows only the last ${shown.length} of the ${obs.length} values in the look-back window, from ${shown[0]!.date}; a level that held through it may not have held before it. Over the whole window, from ${first.date}: highest ${fmt(hi.value)} on ${hi.date}, lowest ${fmt(lo.value)} on ${lo.date}. The last value in ${quarters ? 'March, June, September and December of each year, and in the latest month' : 'each month'} (the latest month's so far): ${kept.map(([m, o]) => `${month(m)} ${fmt(o.value)}`).join('; ')}.`;
  })()] : [];
  const lines = [
    `## ${known?.[1] ?? id} - FRED series ${id}`, '',
    `- Latest value known by ${day}: ${fmt(last.value)} (for ${periodOf(last.date, freq)})`,
    ago ? `- Year over year, from ${fmt(ago.value)} for ${periodOf(ago.date, freq)}: ${changeOf(ago)}` : `- Year over year: not available (no value for ${periodOf(`${Number(last.date.slice(0, 4)) - 1}${last.date.slice(4)}`, freq)} in FRED's data). Do not work one out from other rows.`,
    `- Change over the look-back window, from ${periodOf(first.date, freq)} to ${periodOf(last.date, freq)}: ${changeOf(first)}${first.date !== ago?.date ? ' (not a yearly rate)' : ''}`,
    past ? `- A past analysis date: these are the figures as FRED's archive of past releases (ALFRED) held them on ${day}: only what was published by then, before any later revision.` : '- Values as FRED published them, revisions included.',
    past ? `- Read from FRED's archive at ${readWords(at)}.` : `- Read from FRED at ${readWords(at)} (the desk keeps a read for up to an hour): a figure released after that is not here.`,
    ...whole,
    '', freq === 'monthly' || freq === 'quarterly' ? 'Date (the first day of the period it stands for) | Value' : 'Date | Value', '---|---:', ...shown.map((o) => `${o.date} | ${fmt(o.value)}`),
  ];
  if (!known) lines.push('', `Names this desk knows: ${Object.keys(SERIES).join(', ')}.`);
  return lines.join('\n');
}
