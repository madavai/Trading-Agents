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

export interface Fact { start?: string; end: string; val: number; filed: string; form?: string; accn?: string }
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

/** Every XBRL fact a filer has filed: its accounts (us-gaap) and its cover page (dei: shares outstanding). */
export const companyFacts = (cik: string) => cached<{ facts?: { 'us-gaap'?: Facts; dei?: Facts } }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 45_000);

/** A statement of a US filer as filed with the SEC on or before `asOf`. */
export async function secStatement(symbol: string, kind: Statement, freq: Frequency, asOf: string): Promise<Table> {
  const cik = await cikFor(symbol);
  if (!cik) throw new NoData(`${symbol} is not in the SEC's list of US filers`);
  const usGaap = (await companyFacts(cik)).facts?.['us-gaap'];
  if (!usGaap) throw new NoData(`${symbol} files with the SEC but not in US GAAP terms`);
  return filedStatement(usGaap, kind, freq, asOf);
}

// ---------- a filer's own record: its name, industry code and filings ----------
export interface Submissions {
  name?: string; sic?: string; sicDescription?: string; fiscalYearEnd?: string;
  filings?: { recent?: { accessionNumber?: string[]; filingDate?: string[]; reportDate?: string[]; form?: string[]; primaryDocument?: string[] } };
}
/** The filer's record at the SEC: name, industry code, fiscal year end and its latest thousand filings. */
export const submissions = (cik: string) => cached<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`, 30_000);

/** The eleven sectors (by the names Yahoo Finance and the S&P sector funds use) an SEC industry code (SIC) falls in. The
 *  SEC's codes are older and coarser than the market's sectors, so this is approximate: a search engine files as "computer
 *  programming" and lands in Technology, not Communication Services. Null for a code that names no industry. */
export function sectorOfSic(raw: string | number | undefined): string | null {
  const c = Number(raw);
  if (!Number.isInteger(c) || c < 100) return null;
  const in_ = (lo: number, hi: number) => c >= lo && c <= hi;
  if (in_(100, 999)) return 'Consumer Defensive';
  if (in_(1000, 1099) || in_(1400, 1499)) return 'Basic Materials';
  if (in_(1200, 1399)) return 'Energy';
  if (in_(1500, 1799)) return 'Industrials';
  if (in_(2000, 2199)) return 'Consumer Defensive';
  if (in_(2200, 2399) || in_(2500, 2599)) return 'Consumer Cyclical';
  if (in_(2400, 2499) || in_(2600, 2699)) return 'Basic Materials';
  if (in_(2700, 2799)) return 'Communication Services';
  if (in_(2830, 2836)) return 'Healthcare';
  if (in_(2840, 2844)) return 'Consumer Defensive';
  if (in_(2800, 2899)) return 'Basic Materials';
  if (in_(2900, 2999)) return 'Energy';
  if (in_(3000, 3099) || in_(3200, 3399)) return 'Basic Materials';
  if (in_(3100, 3199) || in_(3630, 3639) || in_(3710, 3716) || in_(3750, 3751) || in_(3900, 3999)) return 'Consumer Cyclical';
  if (in_(3570, 3579) || in_(3660, 3679)) return 'Technology';
  if (in_(3840, 3851)) return 'Healthcare';
  if (in_(3800, 3899)) return 'Technology';
  if (in_(3400, 3799)) return 'Industrials';
  if (in_(4000, 4799)) return 'Industrials';
  if (in_(4800, 4899)) return 'Communication Services';
  if (in_(4950, 4959)) return 'Industrials';
  if (in_(4900, 4999)) return 'Utilities';
  if (c === 5122 || c === 5047) return 'Healthcare';
  if (in_(5140, 5149) || in_(5400, 5499) || c === 5331 || c === 5912) return 'Consumer Defensive';
  if (in_(5000, 5199)) return 'Industrials';
  if (in_(5200, 5999)) return 'Consumer Cyclical';
  if (c === 6798 || in_(6500, 6599)) return 'Real Estate';
  if (in_(6000, 6799)) return 'Financial Services';
  if (in_(7000, 7299) || in_(7500, 7599) || in_(7900, 7999)) return 'Consumer Cyclical';
  if (in_(7310, 7319) || in_(7800, 7899)) return 'Communication Services';
  if (in_(7370, 7379)) return 'Technology';
  if (in_(7300, 7399)) return 'Industrials';
  if (in_(8000, 8099)) return 'Healthcare';
  if (in_(8200, 8299)) return 'Consumer Defensive';
  if (in_(7600, 8999)) return 'Industrials';
  return null;
}

/** The funds the SEC lists by ticker (mutual funds and most ETFs, each with its series and class), as a set of tickers. */
export async function fundTickers(): Promise<ReadonlySet<string>> {
  const t = await cached<{ fields?: string[]; data?: unknown[][] }>('https://www.sec.gov/files/company_tickers_mf.json', 30_000);
  const at = t.fields?.indexOf('symbol') ?? 3;
  return new Set((t.data ?? []).map((r) => String(r[at] ?? '').toUpperCase()).filter(Boolean));
}

// ---------- figures as filed, for valuation ----------
const ANNUAL = (f: Fact) => ANNUAL_FORMS.some((p) => (f.form ?? '').startsWith(p));
const span = (f: Fact) => (f.start ? daysBetween(f.start, f.end) : 0);
/** Of the facts filed by `asOf`, the latest filing of each one period (a restatement replaces what it restates). */
function knownBy(list: readonly Fact[], asOf: string): Fact[] {
  const best = new Map<string, Fact>();
  for (const f of list) {
    if (f.filed > asOf) continue;
    const key = `${f.start ?? ''}|${f.end}`, seen = best.get(key);
    if (!seen || f.filed >= seen.filed) best.set(key, f);
  }
  return [...best.values()];
}

/** The last twelve months of a flow (diluted EPS, dividends per share) as filed by `asOf`: the last full year, plus this
 *  year to date, less the same span a year before (no filing gives twelve months that end mid-year). With no year to date
 *  filed since the last full year, that year itself. `parts` says which filed figures it came from. */
export function trailingYear(list: readonly Fact[], asOf: string): { value: number; parts: string } | null {
  const known = knownBy(list, asOf).filter((f) => f.start);
  const year = known.filter((f) => ANNUAL(f) && span(f) >= YEAR[0] && span(f) <= YEAR[1]).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!year) return null;
  const after = known.filter((f) => f.end > year.end && daysBetween(year.end, f.start!) >= 0 && daysBetween(year.end, f.start!) <= 7 && span(f) >= 60 && span(f) <= 290)
    .sort((a, b) => b.end.localeCompare(a.end) || span(b) - span(a))[0];
  const round = (n: number) => Number(n.toFixed(6));
  if (!after) return { value: round(year.val), parts: `the full year to ${year.end}, ${year.val}` };
  const before = known.find((f) => Math.abs(daysBetween(f.end, after.end) - 365) <= 10 && Math.abs(span(f) - span(after)) <= 10);
  if (!before) return { value: round(year.val), parts: `the full year to ${year.end}, ${year.val} (the same span a year before ${after.end} was not filed, so the year to date cannot be added)` };
  return { value: round(year.val + after.val - before.val), parts: `the full year to ${year.end}, ${year.val}, plus ${after.start} to ${after.end}, ${after.val}, less ${before.start} to ${before.end}, ${before.val}` };
}

/** The latest balance (a figure at a date, like equity) filed by `asOf`. */
export function latestBalance(list: readonly Fact[], asOf: string): Fact | null {
  return knownBy(list, asOf).filter((f) => !f.start).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0] ?? null;
}

/** In place of a cover-page count: the weighted average diluted shares of the latest quarter filed by `asOf` (of the
 *  latest year, when no quarter was filed). The SEC's data leaves out the counts a filer with more than one class of
 *  shares gives class by class on its cover page (Meta, Alphabet), and this figure from its accounts is always there. */
export function averageDilutedShares(list: readonly Fact[], asOf: string): { shares: number; start: string; end: string; filed: string } | null {
  const known = knownBy(list, asOf).filter((f) => f.start && f.val > 0), quarters = known.filter((f) => span(f) >= 80 && span(f) <= 100);
  const top = (quarters.length ? quarters : known).sort((a, b) => b.end.localeCompare(a.end) || span(a) - span(b))[0];
  return top ? { shares: top.val, start: top.start!, end: top.end, filed: top.filed } : null;
}

/** Shares outstanding as the latest cover page filed by `asOf` gives them, each class added (a filer with classes A, B
 *  and C files one count for each, on the same date in the same filing). */
export function sharesOutstanding(list: readonly Fact[], asOf: string): { shares: number; end: string; filed: string } | null {
  const known = list.filter((f) => f.filed <= asOf).sort((a, b) => b.filed.localeCompare(a.filed) || b.end.localeCompare(a.end));
  const top = known[0];
  if (!top) return null;
  const same = known.filter((f) => f.filed === top.filed && f.end === top.end && (f.accn ?? '') === (top.accn ?? ''));
  return { shares: same.reduce((a, f) => a + f.val, 0), end: top.end, filed: top.filed };
}
