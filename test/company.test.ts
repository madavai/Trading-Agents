import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { clearSecCache, filedStatement, type Facts } from '../src/data/sec.js';
import { clearYahooSession, companyOverview, financialStatement, insiderTransactions, yahooTable } from '../src/data/company.js';
import { deskServer } from '../src/tools/server.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const q = (start: string, end: string, val: number, filed: string, form = '10-Q') => ({ start, end, val, filed, form });
const at = (end: string, val: number, filed: string, form = '10-Q') => ({ end, val, filed, form });

/** A fetch that answers by address and records each address with the headers it was asked with. */
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: Array<{ url: string; headers: Record<string, string> }> = []): typeof fetch {
  return async (input, init) => {
    const url = String(input); seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

// A filer with a calendar fiscal year, its revenue tag renamed in 2025, cash flows filed only to date, and its 2024
// balance restated in September 2025.
const FACTS: Facts = {
  RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
    q('2025-01-01', '2025-03-31', 100e6, '2025-05-01'), q('2025-04-01', '2025-06-30', 120e6, '2025-08-01'),
    q('2025-01-01', '2025-06-30', 220e6, '2025-08-01'), q('2024-04-01', '2024-06-30', 95e6, '2025-08-01'),
    q('2024-07-01', '2025-06-30', 450e6, '2025-08-01'),   // twelve months in a 10-Q: never a fiscal year
  ] } },
  Revenues: { units: { USD: [q('2024-04-01', '2024-06-30', 90e6, '2024-08-01'), q('2024-01-01', '2024-12-31', 400e6, '2025-02-15', '10-K')] } },
  EarningsPerShareDiluted: { units: { 'USD/shares': [q('2025-04-01', '2025-06-30', 1.23, '2025-08-01')] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [q('2025-01-01', '2025-03-31', 30e6, '2025-05-01'), q('2025-01-01', '2025-06-30', 70e6, '2025-08-01')] } },
  Assets: { units: { USD: [at('2024-12-31', 1000e6, '2025-02-15', '10-K'), at('2025-06-30', 1100e6, '2025-08-01'), at('2024-12-31', 950e6, '2025-09-15', '10-K/A')] } },
};

const SEC: Array<[RegExp, (url: string) => Response]> = [
  [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME', title: 'ACME CORP' } })],
  [/companyfacts\/CIK0000001234\.json/, () => json({ facts: { 'us-gaap': FACTS } })],
];
const YAHOO_SESSION: Array<[RegExp, (url: string) => Response]> = [
  [/fc\.yahoo\.com/, () => new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Domain=.yahoo.com; Path=/; Secure' } })],
  [/getcrumb/, () => new Response('crumb1')],
];

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearSecCache(); clearYahooSession(); configure({ secEmail: '' }); });

test('a statement is read as filed by the analysis date: tag order, quarters apart from the year to date', () => {
  const before = filedStatement(FACTS, 'income_statement', 'quarterly', '2025-06-01');
  assert.deepEqual(before.columns, ['2025-03-31', '2024-06-30']);
  assert.deepEqual(before.rows[0]!.cells, [100e6, 90e6]);              // the old tag's figure, the new one not yet filed
  const after = filedStatement(FACTS, 'income_statement', 'quarterly', '2025-09-01');
  assert.deepEqual(after.columns, ['2025-06-30', '2025-03-31', '2024-06-30']);
  assert.deepEqual(after.rows[0]!.cells, [120e6, 100e6, 95e6]);        // the quarter, never the six months; the new tag first
  assert.equal(after.rows.find((r) => r.label === 'Diluted EPS')!.unit, 'USD/shares');
  const cash = filedStatement(FACTS, 'cashflow', 'quarterly', '2025-09-01');
  assert.deepEqual(cash.columns, ['2025-06-30 (6 months to date)', '2025-03-31']);
  assert.deepEqual(cash.rows[0]!.cells, [70e6, 30e6]);                 // filed only to date: shown so, never subtracted
});

test('a restatement counts from the day it was filed, and a year is what an annual report covers', () => {
  assert.deepEqual(filedStatement(FACTS, 'balance_sheet', 'quarterly', '2025-09-01').rows[0]!.cells, [1100e6, 1000e6]);
  assert.deepEqual(filedStatement(FACTS, 'balance_sheet', 'quarterly', '2025-10-01').rows[0]!.cells, [1100e6, 950e6]);
  const annual = filedStatement(FACTS, 'balance_sheet', 'annual', '2025-09-01');
  assert.deepEqual(annual.columns, ['2024-12-31']);                    // the 10-Q balance is not a fiscal year
  const revenue = filedStatement(FACTS, 'income_statement', 'annual', '2025-09-01');
  assert.deepEqual([revenue.columns, revenue.rows[0]!.cells], [['2024-12-31'], [400e6]]);
  assert.throws(() => filedStatement(FACTS, 'cashflow', 'annual', '2025-09-01'), /no annual cash flow statement was filed with the SEC by 2025-09-01/);
});

test('the tool serves a US filer from the SEC, in millions, with the email sent to the SEC alone', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  configure({ contact: 'ta (+x)', secEmail: 'me@example.com', fetch: route(SEC, seen) });
  const t = await financialStatement('acme', 'income_statement', 'quarterly', '2025-09-01');
  assert.match(t, /^Income statement for ACME \(quarterly\), as filed with the SEC on or before 2025-09-01/);
  assert.match(t, /Line \| 2025-06-30 \| 2025-03-31 \| 2024-06-30/);
  assert.match(t, /Revenue \| 120\.0 \| 100\.0 \| 95\.0/);
  assert.match(t, /Diluted EPS \(USD per share\) \| 1\.23 \| – \| –/);
  assert.match(t, /Not reported by this source: Cost of Revenue, Gross Profit, Operating Income, Net Income\./);
  assert.match(t, /A fourth quarter is never derived/);
  assert.ok(seen.every((s) => s.headers['User-Agent'] === 'ta me@example.com'), 'both SEC hosts get the name and the email, with no bracketed address');
});

test('when the SEC refuses, today falls back to Yahoo and a past day is told why', async () => {
  const TS = { timeseries: { result: [
    { meta: { type: ['quarterlyTotalRevenue'] }, quarterlyTotalRevenue: [{ asOfDate: '2026-03-31', currencyCode: 'USD', reportedValue: { raw: 200e6 } }, { asOfDate: '2026-06-30', currencyCode: 'USD', reportedValue: { raw: 210e6 } }] },
    { meta: { type: ['quarterlyDilutedEPS'] }, quarterlyDilutedEPS: [null, { asOfDate: '2026-06-30', currencyCode: 'USD', reportedValue: { raw: 0.5 } }] },
    { meta: { type: ['quarterlyNetIncome'] } },
  ] } };
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  configure({ fetch: route([[/sec\.gov/, () => new Response('Forbidden', { status: 403 })], ...YAHOO_SESSION, [/fundamentals-timeseries/, () => json(TS)]], seen) });
  const now = await financialStatement('ACME', 'income_statement', 'quarterly', '2026-10-12');
  assert.match(now, /from Yahoo Finance as it stands today/);
  assert.match(now, /ask the person for their own email \(never invent one\) and save it with set_contact_email/);
  assert.match(now, /Revenue \| 210\.0 \| 200\.0/);
  assert.match(now, /Diluted EPS \(USD per share\) \| 0\.50 \| –/);
  const ts = seen.find((s) => /fundamentals-timeseries/.test(s.url))!;
  assert.match(ts.url, /crumb=crumb1/);
  assert.equal(ts.headers.Cookie, 'A3=abc');
  await assert.rejects(financialStatement('ACME', 'income_statement', 'quarterly', '2026-09-01'), /the SEC, the only source of accounts as filed by 2026-09-01, could not answer .*set_contact_email/);
});

test('a company the SEC does not list is withheld for a past day and served by Yahoo today', async () => {
  const TS = { timeseries: { result: [{ meta: { type: ['annualTotalAssets'] }, annualTotalAssets: [{ asOfDate: '2026-03-31', currencyCode: 'JPY', reportedValue: { raw: 9e13 } }] }] } };
  configure({ fetch: route([...SEC, ...YAHOO_SESSION, [/fundamentals-timeseries/, () => json(TS)]]) });
  assert.match(await financialStatement('7203.T', 'balance_sheet', 'annual', '2026-06-01'), /^Balance sheet for 7203\.T is withheld for 2026-06-01: 7203\.T is not in the SEC's list of US filers, and .*cannot show which figures were public/);
  const now = await financialStatement('7203.T', 'balance_sheet', 'annual', '2026-10-12');
  assert.match(now, /Money in millions of JPY/);
  assert.match(now, /Total Assets \| 90,000,000\.0/);
});

const SUMMARY = { quoteSummary: { result: [{
  price: { longName: 'Acme Corporation', currency: 'USD', marketCap: { raw: 4.2e12, fmt: '4.2T' } },
  summaryProfile: { sector: 'Technology', industry: 'Semiconductors' },
  summaryDetail: { trailingPE: { raw: 52.31234 }, dividendYield: { raw: 0.0002 }, fiftyTwoWeekHigh: { raw: 212.19 } },
  defaultKeyStatistics: { trailingEps: { raw: 3.51 }, netIncomeToCommon: { raw: 9.9e10 } },
  financialData: { financialCurrency: 'USD', profitMargins: { raw: 0.5285 }, debtToEquity: { raw: 10.6 }, currentRatio: {} },
  insiderTransactions: { transactions: [
    { filerName: 'JANE ROE', filerRelation: 'Director', transactionText: 'Sale at price 180.00 per share.', ownership: 'D', startDate: { raw: Date.parse('2026-09-10T00:00:00Z') / 1000 }, shares: { raw: 5000 }, value: { raw: 900000 } },
    { filerName: 'JOHN DOE', filerRelation: 'Chief Executive Officer', transactionText: '', ownership: 'I', startDate: { raw: Date.parse('2026-10-01T00:00:00Z') / 1000 }, shares: { raw: 75000 } },
  ] },
}], error: null } };

test('profile and ratios come from Yahoo with its session, each in its own unit; withheld for a past day', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  configure({ fetch: route([...YAHOO_SESSION, [/quoteSummary/, () => json(SUMMARY)]], seen) });
  const t = await companyOverview('acme', '2026-10-12');
  assert.match(t, /Name: Acme Corporation\nSector: Technology\nIndustry: Semiconductors\nMarket Cap: 4,200,000,000,000 USD\nPE Ratio \(TTM\): 52\.3123/);
  assert.match(t, /Dividend Yield: 0\.02%/);
  assert.match(t, /Profit Margin: 52\.85%/);
  assert.match(t, /Debt to Equity: 10\.6% \(0\.11x\)/);
  assert.doesNotMatch(t, /Current Ratio|Forward PE/);                 // what Yahoo does not give is left out
  assert.match(seen.find((s) => /quoteSummary/.test(s.url))!.url, /modules=price,summaryProfile.*&crumb=crumb1/);
  assert.match(await companyOverview('ACME', '2026-10-01'), /withheld for 2026-10-01: Yahoo Finance serves them only as they stand today/);
});

test('insider trades come newest first; withheld for a past day', async () => {
  configure({ fetch: route([...YAHOO_SESSION, [/quoteSummary/, () => json(SUMMARY)]]) });
  const t = await insiderTransactions('ACME', '2026-10-12');
  assert.match(t, /- 2026-10-01 · JOHN DOE \(Chief Executive Officer\): no description · 75,000 shares · held indirectly\n- 2026-09-10 · JANE ROE \(Director\): Sale at price 180\.00 per share\. · 5,000 shares · value 900,000/);
  assert.match(await insiderTransactions('ACME', '2026-10-01'), /withheld for 2026-10-01/);
});

test('an expired session key is renewed once', async () => {
  let crumbs = 0;
  configure({ fetch: route([
    [/fc\.yahoo\.com/, () => new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } })],
    [/getcrumb/, () => new Response(`crumb${++crumbs}`)],
    [/quoteSummary.*crumb=crumb1/, () => new Response('Unauthorized', { status: 401 })],
    [/quoteSummary.*crumb=crumb2/, () => json(SUMMARY)],
  ]) });
  assert.match(await companyOverview('ACME', '2026-10-12'), /Name: Acme Corporation/);
  assert.equal(crumbs, 2);
});

test('a crypto asset, an index or a currency pair has no company accounts', async () => {
  for (const s of ['BTC-USD', '^GSPC', 'EURUSD']) await assert.rejects(financialStatement(s, 'balance_sheet', 'annual', '2026-10-12'), /is not a company/);
  assert.throws(() => yahooTable({ timeseries: { result: [] } }, 'cashflow', 'annual'), /Yahoo Finance has no annual cash flow statement/);
});

test('the server offers the company tools', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), route(SEC)).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['get_company_overview', 'get_financial_statement', 'get_insider_transactions']) assert.ok(names.includes(n), n);
  const r = await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: '2025-09-01', statement: 'balance_sheet' } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /Balance sheet for ACME \(quarterly\), as filed with the SEC on or before 2025-09-01/);
  const bad = await client.callTool({ name: 'get_insider_transactions', arguments: { symbol: 'BTC-USD', analysis_date: '2026-10-12' } }) as { content: Array<{ text: string }> };
  assert.match(bad.content[0]!.text, /^NO_DATA_AVAILABLE: insider transactions of BTC-USD: BTC-USD is not a company/);
  await client.close();
});
