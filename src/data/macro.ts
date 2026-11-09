// Economic figures from FRED (the St. Louis Fed), through its public download (no key): rates, yields, inflation, jobs,
// growth, for the US and the euro area. For a past analysis date, an observation is kept only if it would have been
// published by then (a conservative release lag by how often the series is reported), so a figure released later never
// reaches an analysis of an earlier day. The download serves today's revised values; that is said with them. A figure is
// named by the period it stands for ("August 2026", not the first day FRED dates it on), and the change over a year is
// worked out from the same period a year earlier, so a change over a shorter window is never read as a yearly rate.
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

/** Days after an observation's date before it is published, by how often the series is reported (conservative). */
export const releaseLag = (obs: Obs[]): number => ({ daily: 1, weekly: 6, monthly: 45, quarterly: 120, yearly: 120 })[frequency(obs)];

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
  const from = addDays(day, -Math.max(window, 365) - 400);
  const { text: csv, at } = await getTextAt(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}&coed=${day}`);
  if (!/^\s*(observation_date|DATE)\s*,/i.test(csv)) throw new Unavailable(`FRED answered with something other than its data download (it may be down for maintenance)`);
  let all = parseCsv(csv).filter((o) => o.date <= day);
  const past = isHistorical(day), freq = frequency(all), lag = releaseLag(all);
  if (past) all = all.filter((o) => addDays(o.date, lag) <= day);
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
  const lines = [
    `## ${known?.[1] ?? id} - FRED series ${id}`, '',
    `- Latest value known by ${day}: ${fmt(last.value)} (for ${periodOf(last.date, freq)})`,
    ago ? `- Year over year, from ${fmt(ago.value)} for ${periodOf(ago.date, freq)}: ${changeOf(ago)}` : `- Year over year: not available (no value for ${periodOf(`${Number(last.date.slice(0, 4)) - 1}${last.date.slice(4)}`, freq)} in FRED's data). Do not work one out from other rows.`,
    `- Change over the look-back window, from ${periodOf(first.date, freq)} to ${periodOf(last.date, freq)}: ${changeOf(first)}${first.date !== ago?.date ? ' (not a yearly rate)' : ''}`,
    past ? `- A past analysis date: values are kept only if published by ${day} (a ${lag}-day release lag for this series), and are today's revised figures; first releases may have differed slightly.` : '- Values as FRED published them, revisions included.',
    `- Read from FRED at ${readWords(at)} (the desk keeps a read for up to an hour): a figure released after that is not here.`,
    '', freq === 'monthly' || freq === 'quarterly' ? 'Date (the first day of the period it stands for) | Value' : 'Date | Value', '---|---:', ...obs.slice(-40).map((o) => `${o.date} | ${fmt(o.value)}`),
  ];
  if (!known) lines.push('', `Names this desk knows: ${Object.keys(SERIES).join(', ')}.`);
  return lines.join('\n');
}
