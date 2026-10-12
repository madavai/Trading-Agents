// Economic figures from FRED (the St. Louis Fed), through its public download (no key): rates, yields, inflation, jobs,
// growth, for the US and the euro area. For a past analysis date, an observation is kept only if it would have been
// published by then (a conservative release lag by how often the series is reported), so a figure released later never
// reaches an analysis of an earlier day. The download serves today's revised values; that is said with them.
// The series names are TradingAgents' (tradingagents/dataflows/vendors/fred.py), Apache License 2.0.
import { addDays, analysisDate, isHistorical } from './dates.js';
import { getText, NoData } from './http.js';

export const SERIES: Record<string, [id: string, title: string]> = {
  fed_funds_rate: ['FEDFUNDS', 'Federal funds effective rate (percent)'],
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

/** Days after an observation's date before it is published, by how often the series is reported (conservative). */
export function releaseLag(obs: Obs[]): number {
  const gaps = obs.slice(1).map((o, i) => (Date.parse(o.date) - Date.parse(obs[i]!.date)) / 86_400_000).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 1;
  return median <= 3 ? 1 : median <= 10 ? 6 : median <= 45 ? 45 : 120;
}

export async function economicSeries(indicator: string, analysis: string, lookBackDays = 365): Promise<string> {
  const day = analysisDate(analysis), key = indicator.trim().toLowerCase(), known = SERIES[key];
  const id = known?.[0] ?? indicator.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(id)) throw new Error(`"${indicator}" is not a series name or a FRED series id`);
  const from = addDays(day, -Math.max(30, Math.min(3650, lookBackDays)) - 130);
  let obs = parseCsv(await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}&coed=${day}`)).filter((o) => o.date <= day);
  const past = isHistorical(day), lag = releaseLag(obs);
  if (past) obs = obs.filter((o) => addDays(o.date, lag) <= day);
  obs = obs.filter((o) => o.date >= addDays(day, -Math.max(30, Math.min(3650, lookBackDays))));
  if (!obs.length) throw new NoData(`FRED has no ${id} values published by ${day} in this window`);
  const first = obs[0]!, last = obs[obs.length - 1]!, change = last.value - first.value, pct = first.value ? (change / Math.abs(first.value)) * 100 : 0;
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toFixed(2));
  const lines = [
    `## ${known?.[1] ?? id} - FRED series ${id}`, '',
    `- Latest value known by ${day}: ${fmt(last.value)} (for ${last.date})`,
    `- Change since ${first.date}: ${change >= 0 ? '+' : ''}${fmt(change)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
    past ? `- A past analysis date: values are kept only if published by ${day} (a ${lag}-day release lag for this series), and are today's revised figures; first releases may have differed slightly.` : '- Values as published today, revisions included.',
    '', 'Date | Value', '---|---:', ...obs.slice(-40).map((o) => `${o.date} | ${fmt(o.value)}`),
  ];
  if (!known) lines.push('', `Names this desk knows: ${Object.keys(SERIES).join(', ')}.`);
  return lines.join('\n');
}
