// Company accounts as they were filed, from SEC EDGAR's public XBRL facts (no key; the SEC asks every caller for a
// contact email). EDGAR dates every figure by the day it was filed, so an analysis of a past day reads exactly what was
// on file then, with a restatement counted only from the day it was filed. US filers only.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/sec_edgar.py), Apache License 2.0; rewritten in TypeScript.
import { daysBetween } from './dates.js';
import { getJson, NoData } from './http.js';

export type Statement = 'balance_sheet' | 'income_statement' | 'cashflow';
export type Frequency = 'quarterly' | 'annual';

/** The line items of each statement, each with the tags filers use for it, best first. A period takes the first tag that
 *  reports it; values are never added across tags, which would count a figure twice. */
export const STATEMENTS: Record<Statement, { title: string; lines: Array<[string, string[]]> }> = {
  balance_sheet: { title: 'Balance sheet', lines: [
    ['Total Assets', ['Assets']],
    ['Current Assets', ['AssetsCurrent']],
    ['Cash and Equivalents', ['CashAndCashEquivalentsAtCarryingValue']],
    ['Total Liabilities', ['Liabilities']],
    ['Current Liabilities', ['LiabilitiesCurrent']],
    ['Stockholders Equity', ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']],
  ] },
  income_statement: { title: 'Income statement', lines: [
    ['Revenue', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']],
    ['Cost of Revenue', ['CostOfRevenue', 'CostOfGoodsAndServicesSold']],
    ['Gross Profit', ['GrossProfit']],
    ['Operating Income', ['OperatingIncomeLoss']],
    ['Net Income', ['NetIncomeLoss']],
    ['Diluted EPS', ['EarningsPerShareDiluted']],
  ] },
  cashflow: { title: 'Cash flow statement', lines: [
    ['Operating Cash Flow', ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations']],
    ['Investing Cash Flow', ['NetCashProvidedByUsedInInvestingActivities']],
    ['Financing Cash Flow', ['NetCashProvidedByUsedInFinancingActivities']],
    ['Capital Expenditure', ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']],
  ] },
};

/** A statement as a table: columns are periods, newest first; a row's unit is USD, another currency, or per share. */
export interface Table { columns: string[]; rows: Array<{ label: string; unit: string; cells: Array<number | null> }> }

export interface Fact { start?: string; end: string; val: number; filed: string; form?: string }
export type Facts = Record<string, { units?: Record<string, Fact[]> }>;

// A quarter covers about 90 days and a year about 365. One filing reports the quarter and the year to date under the same
// end date, so the span is checked: a match on the end date alone could report half a year as a quarter.
const QUARTER: [number, number] = [60, 115], YEAR: [number, number] = [300, 400];
// A 10-Q's cash flows are often filed only for the year to date. A quarterly table shows that span, named in its
// column; it never subtracts one filing from another, which would give a figure no filing states.
const YEAR_TO_DATE: Array<[number, number, number]> = [[150, 200, 6], [240, 290, 9]];
// A year is what an annual report covers: a 10-Q's balance has no span to reject, and some 10-Qs report twelve-month
// totals that pass the span check.
const ANNUAL_FORMS = ['10-K', '20-F', '40-F'];
export const SHOWN: Record<Frequency, number> = { quarterly: 8, annual: 5 };

/** Which span a fact covers (0 for a balance, which has none), or null when it covers none of them. */
function spanIndex(f: Fact, spans: Array<[number, number]>): number | null {
  if (!f.start) return 0;
  const days = daysBetween(f.start, f.end);
  const i = spans.findIndex(([lo, hi]) => days >= lo && days <= hi);
  return i < 0 ? null : i;
}

/** The figures of one line as known on `asOf`: each period's latest filing on or before that day. */
function lineAsOf(facts: Facts, tags: string[], asOf: string, spans: Array<[number, number]>, forms: string[]): { values: Map<string, number>; unit: string } {
  const values = new Map<string, number>();
  let unit = 'USD';
  for (const tag of tags) {
    for (const [u, list] of Object.entries(facts[tag]?.units ?? {})) {
      const latest = new Map<string, Fact>(), covered = new Set<string>();
      for (const f of list) {
        const i = spanIndex(f, spans), key = `${f.end}|${i}`;
        if (i === null || f.filed > asOf || values.has(key)) continue;
        if (!forms.length || forms.some((p) => (f.form ?? '').startsWith(p))) covered.add(key);
        const seen = latest.get(key);
        if (!seen || f.filed >= seen.filed) latest.set(key, f);
      }
      let any = false;
      for (const [key, f] of latest) if (covered.has(key)) { values.set(key, f.val); any = true; }
      if (any) unit = u;
    }
  }
  return { values, unit };
}

/** One statement from a filer's us-gaap facts, as filed on or before `asOf`. Exported for the tests. */
export function filedStatement(usGaap: Facts, kind: Statement, freq: Frequency, asOf: string): Table {
  const quarterly = freq === 'quarterly';
  const spans: Array<[number, number]> = quarterly ? [QUARTER, ...YEAR_TO_DATE.map(([lo, hi]) => [lo, hi] as [number, number])] : [YEAR];
  const names = quarterly ? ['', ...YEAR_TO_DATE.map(([, , m]) => ` (${m} months to date)`)] : [''];
  const lines = STATEMENTS[kind].lines.map(([label, tags]) => ({ label, ...lineAsOf(usGaap, tags, asOf, spans, quarterly ? [] : ANNUAL_FORMS) }));
  // Each row shows a period at the shortest span it was filed for; a column is one span of one period.
  const chosen = lines.map((l) => {
    const m = new Map<string, number>();
    for (const key of l.values.keys()) { const [end, i] = key.split('|') as [string, string]; m.set(end, Math.min(Number(i), m.get(end) ?? Number(i))); }
    return m;
  });
  const ends = [...new Set(chosen.flatMap((m) => [...m.keys()]))].sort().reverse().slice(0, SHOWN[freq]);
  const periods = ends.flatMap((end) => [...new Set(chosen.map((m) => m.get(end)).filter((i) => i !== undefined))].sort().map((i) => ({ end, i: i! })));
  if (!periods.length) throw new NoData(`no ${freq} ${STATEMENTS[kind].title.toLowerCase()} was filed with the SEC by ${asOf}`);
  return {
    columns: periods.map((p) => p.end + names[p.i]),
    rows: lines.map((l, n) => ({ label: l.label, unit: l.unit, cells: periods.map((p) => (chosen[n]!.get(p.end) === p.i ? l.values.get(`${p.end}|${p.i}`) ?? null : null)) })),
  };
}

const DAY_MS = 86_400_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** A filing history changes only when something new is filed, so one fetch a day serves every question about it. */
function cached<T>(url: string, timeoutMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.value as Promise<T>;
  const value = getJson<T>(url, { timeoutMs });
  cache.set(url, { at: Date.now(), value });
  value.catch(() => cache.delete(url));
  return value;
}

export function clearSecCache(): void { cache.clear(); }

/** The filer's CIK, or null when the ticker is not a US SEC filer. */
export async function cikFor(symbol: string): Promise<string | null> {
  const table = await cached<Record<string, { cik_str: number; ticker: string }>>('https://www.sec.gov/files/company_tickers.json', 30_000);
  const hit = Object.values(table).find((e) => e.ticker?.toUpperCase() === symbol.toUpperCase());
  return hit ? String(hit.cik_str).padStart(10, '0') : null;
}

/** A statement of a US filer as filed with the SEC on or before `asOf`. */
export async function secStatement(symbol: string, kind: Statement, freq: Frequency, asOf: string): Promise<Table> {
  const cik = await cikFor(symbol);
  if (!cik) throw new NoData(`${symbol} is not in the SEC's list of US filers`);
  const facts = await cached<{ facts?: { 'us-gaap'?: Facts } }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 45_000);
  const usGaap = facts.facts?.['us-gaap'];
  if (!usGaap) throw new NoData(`${symbol} files with the SEC but not in US GAAP terms`);
  return filedStatement(usGaap, kind, freq, asOf);
}
