import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { clearSecCache, filedStatement, splitsIn, type Facts } from '../src/data/sec.js';
import { clearYahooSession, companyOverview, financialStatement, fundProfile, insiderTransactions, renderTable, withWorkedRows, yahooTable } from '../src/data/company.js';
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
/** The SEC's list of US filers, read, with no such company in it: Yahoo is asked only then (a list that cannot be read is
 *  the SEC's outage, never "not a filer"). */
const NOT_AT_THE_SEC: [RegExp, (url: string) => Response] = [/company_tickers\.json/, () => json({})];

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
  assert.deepEqual(cash.columns, ['2025-06-30 (derived)', '2025-03-31']);
  assert.deepEqual(cash.rows[0]!.cells, [40e6, 30e6]);                 // filed only to date: the six months less the first quarter
  assert.deepEqual(cash.notes, ['The quarter to 2025-06-30 is derived (no filing states it): the six months to 2025-06-30 less the quarter to 2025-03-31.']);
  const early = filedStatement(FACTS, 'cashflow', 'quarterly', '2025-07-01');
  assert.deepEqual([early.columns, early.rows[0]!.cells], [['2025-03-31'], [30e6]]);
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

// A filer whose fiscal year ends in January: three quarters filed, the year filed, the cash flows only to date; a
// 10-for-1 split between its May 2024 and February 2025 filings, which refiled earlier periods on the new basis.
const YEARS: Facts = {
  Revenues: { units: { USD: [
    q('2024-01-29', '2024-04-28', 26e9, '2024-05-29'), q('2024-04-29', '2024-07-28', 30e9, '2024-08-28'), q('2024-07-29', '2024-10-27', 35e9, '2024-11-20'),
    q('2024-01-29', '2025-01-26', 130e9, '2025-02-26', '10-K'), q('2025-01-27', '2025-04-27', 44e9, '2025-05-28'),
    q('2023-01-30', '2023-04-30', 7e9, '2023-05-26'), q('2023-01-30', '2024-01-28', 61e9, '2024-02-21', '10-K'), q('2023-04-30', '2023-07-30', 13.5e9, '2023-08-30'),
  ] } },
  OperatingIncomeLoss: { units: { USD: [q('2024-01-29', '2024-04-28', 17e9, '2024-05-29'), q('2025-01-27', '2025-04-27', 22e9, '2025-05-28'), q('2024-01-29', '2025-01-26', 81e9, '2025-02-26', '10-K')] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
    q('2024-01-29', '2024-04-28', 15e9, '2024-05-29'), q('2024-01-29', '2024-07-28', 29e9, '2024-08-28'), q('2024-01-29', '2024-10-27', 47e9, '2024-11-20'),
    q('2024-01-29', '2025-01-26', 64e9, '2025-02-26', '10-K'), q('2025-01-27', '2025-04-27', 27e9, '2025-05-28'),
  ] } },
  PaymentsToAcquireProductiveAssets: { units: { USD: [q('2024-01-29', '2024-04-28', 0.4e9, '2024-05-29'), q('2024-01-29', '2024-07-28', 1.4e9, '2024-08-28')] } },
  EarningsPerShareDiluted: { units: { 'USD/shares': [
    q('2021-02-01', '2022-01-30', 3.85, '2024-02-21', '10-K'), q('2022-01-31', '2023-01-29', 1.74, '2024-02-21', '10-K'), q('2023-01-30', '2024-01-28', 11.93, '2024-02-21', '10-K'),
    q('2022-01-31', '2023-01-29', 0.17, '2025-02-26', '10-K'), q('2023-01-30', '2024-01-28', 1.19, '2025-02-26', '10-K'), q('2024-01-29', '2025-01-26', 2.94, '2025-02-26', '10-K'),
    q('2024-01-29', '2024-04-28', 5.98, '2024-05-29'), q('2024-01-29', '2024-04-28', 0.598, '2025-05-28'), q('2024-04-29', '2024-07-28', 0.67, '2024-08-28'),
  ] } },
};

test('a quarter no filing states is derived from two filed figures of the same year, marked, and never per share', () => {
  const t = filedStatement(YEARS, 'income_statement', 'quarterly', '2025-06-01');
  assert.deepEqual(t.columns.slice(0, 5), ['2025-04-27', '2025-01-26 (derived)', '2024-10-27', '2024-07-28', '2024-04-28']);
  assert.deepEqual(t.rows[0]!.cells.slice(0, 5), [44e9, 39e9, 35e9, 30e9, 26e9]);   // the year less its three quarters
  assert.equal(t.rows.find((r) => r.label === 'Operating Income')!.cells[1], null); // its quarters are not all filed: no guess
  assert.equal(t.rows.find((r) => r.label === 'Diluted EPS')!.cells[1], null);      // a per-share figure never adds up
  assert.ok(t.notes!.includes('The quarter to 2025-01-26 is derived (no filing states it): the year to 2025-01-26 less its 3 quarters to 2024-10-27.'), String(t.notes));
  const cash = filedStatement(YEARS, 'cashflow', 'quarterly', '2025-06-01');
  assert.deepEqual(cash.columns.slice(0, 5), ['2025-04-27', '2025-01-26 (derived)', '2024-10-27 (derived)', '2024-07-28 (derived)', '2024-04-28']);
  assert.deepEqual(cash.rows[0]!.cells.slice(0, 5), [27e9, 17e9, 18e9, 14e9, 15e9]);
  assert.ok(cash.notes!.includes('The quarter to 2025-01-26 is derived (no filing states it): the year to 2025-01-26 less the nine months to 2024-10-27.'), String(cash.notes));
  // Before the annual report is filed, its quarter is not there to derive.
  assert.equal(filedStatement(YEARS, 'income_statement', 'quarterly', '2025-02-01').columns[0], '2024-10-27');
});

test('per-share figures filed before a share split are put on the later basis, and say so', () => {
  const eps = YEARS.EarningsPerShareDiluted!.units!['USD/shares']!;
  assert.deepEqual(splitsIn(eps, '2025-06-01'), [{ factor: 10, old: '2024-05-29', from: '2025-02-26' }]);
  assert.deepEqual(splitsIn(eps, '2025-01-01'), []);   // not yet seen: nothing to adjust
  const t = filedStatement(YEARS, 'income_statement', 'annual', '2025-06-01');
  assert.deepEqual(t.columns, ['2025-01-26', '2024-01-28', '2023-01-29', '2022-01-30']);
  assert.deepEqual(t.rows.find((r) => r.label === 'Diluted EPS')!.cells, [2.94, 1.19, 0.17, 0.385]);
  assert.ok(t.notes!.some((n) => /^Diluted EPS for the year to 2022-01-30 was filed on 2024-02-21 as 3\.85, before the 10-for-1 split the filings show between 2024-05-29 and 2025-02-26; shown here on the basis of the later filings: 0\.385\.$/.test(n)), String(t.notes));
  // One restatement is not a split; two splits seen at once in one refiling are not a third.
  const one = [q('2020-01-01', '2020-12-31', 2.0, '2021-02-01', '10-K'), q('2020-01-01', '2020-12-31', 1.0, '2022-02-01', '10-K')];
  assert.deepEqual(splitsIn(one, '2023-01-01'), []);
  const two = [
    q('2018-01-01', '2018-12-31', 8, '2019-02-01', '10-K'), q('2018-01-01', '2018-12-31', 2, '2020-02-01', '10-K'),
    q('2019-01-01', '2019-03-31', 12, '2019-05-01'), q('2019-01-01', '2019-03-31', 3, '2020-05-01'), q('2019-01-01', '2019-03-31', 0.3, '2022-05-01'),
    q('2020-01-01', '2020-12-31', 5, '2021-02-01', '10-K'), q('2020-01-01', '2020-12-31', 0.5, '2022-02-01', '10-K'),
    q('2017-01-01', '2017-12-31', 40, '2019-02-01', '10-K'), q('2017-01-01', '2017-12-31', 1, '2022-02-01', '10-K'),
  ];
  assert.deepEqual(splitsIn(two, '2023-01-01').map((s) => s.factor), [4, 10]);
});

test('the desk works out margins, growth only between neighbouring periods, free cash flow and balance ratios', () => {
  const income = withWorkedRows(filedStatement(YEARS, 'income_statement', 'quarterly', '2025-06-01'), 'income_statement', 'quarterly');
  const row = (t: typeof income, start: string) => t.rows.find((r) => r.label.startsWith(start))!;
  assert.equal(row(income, 'Operating margin').cells[0]!.toFixed(1), '50.0');                     // 22 of 44
  assert.deepEqual(row(income, 'Revenue growth on the quarter just before').cells.slice(0, 4).map((c) => c?.toFixed(1)), ['12.8', '11.4', '16.7', '15.4']);
  assert.deepEqual(row(income, 'Revenue growth on the same quarter a year before').cells.slice(0, 2).map((c) => c?.toFixed(1)), ['69.2', undefined]);
  const yearly = withWorkedRows(filedStatement(YEARS, 'income_statement', 'annual', '2025-06-01'), 'income_statement', 'annual');
  assert.equal(row(yearly, 'Revenue growth on the year before').cells[0]!.toFixed(1), '113.1');
  const cash = withWorkedRows(filedStatement(YEARS, 'cashflow', 'quarterly', '2025-06-01'), 'cashflow', 'quarterly');
  const fcf = row(cash, 'Free cash flow');
  assert.deepEqual([fcf.worked, fcf.cells.slice(3, 5)], ['money', [13e9, 14.6e9]]);               // the quarter's spending, not the six months'
  assert.equal(row(cash, 'Capital expenditure as a share').cells[3]!.toFixed(1), '7.1');
  const text = renderTable(cash, 'Cash flow', '');
  assert.match(text, /Free cash flow \(worked out: operating cash flow less capital expenditure\) \| – \| – \| – \| 13,000\.0 \| 14,600\.0/);
  assert.match(text, /Capital expenditure as a share of operating cash flow \(worked out\) \| – \| – \| – \| 7\.1% \| 2\.7%/);
  assert.match(text, /quote them rather than working your own/);
  const balance = withWorkedRows({ columns: ['2025-06-30'], rows: [
    { label: 'Current Assets', unit: 'USD', cells: [500e6] }, { label: 'Cash and Equivalents', unit: 'USD', cells: [100e6] },
    { label: 'Total Liabilities', unit: 'USD', cells: [300e6] }, { label: 'Current Liabilities', unit: 'USD', cells: [200e6] },
    { label: 'Stockholders Equity', unit: 'USD', cells: [600e6] },
  ] }, 'balance_sheet', 'quarterly');
  assert.deepEqual(balance.rows.slice(5).map((r) => [r.label.split(' (')[0], r.cells[0]]), [['Current ratio', 2.5], ['Liabilities to equity', 0.5], ['Non-current liabilities', 100e6], ['Current assets other than cash', 400e6]]);
});

// Apple's year to 26 Sep 2026 and its nine months to 27 Jun 2026, as filed (millions). In the run of 11 Nov 2026 the
// statement had only the financing cash flow, and the debate called all of its 127,446 "dividends and buybacks": they
// were 102,111, the rest debt repaid, commercial paper and tax paid on employee share awards.
const year = (v: number) => q('2025-09-28', '2026-09-26', v * 1e6, '2026-11-03', '10-K');
const nine = (v: number) => q('2025-09-28', '2026-06-27', v * 1e6, '2026-07-31');
const flow = (y: number, n: number) => ({ units: { USD: [year(y), nine(n)] } });
const held = (v: number) => ({ units: { USD: [at('2026-09-26', v * 1e6, '2026-11-03', '10-K')] } });
const APPLE: Facts = {
  NetCashProvidedByUsedInOperatingActivities: flow(145097, 116996), PaymentsToAcquirePropertyPlantAndEquipment: flow(9041, 6799),
  NetCashProvidedByUsedInFinancingActivities: flow(-127446, -94575), PaymentsForRepurchaseOfCommonStock: flow(86390, 62094),
  PaymentsOfDividends: flow(15721, 11778), ProceedsFromIssuanceOfLongTermDebt: flow(0, 0), RepaymentsOfLongTermDebt: flow(12396, 8146),
  ProceedsFromRepaymentsOfCommercialPaper: flow(-5911, -5911), PaymentsRelatedToTaxWithholdingForShareBasedCompensation: flow(6793, 6462),
  ProceedsFromPaymentsForOtherFinancingActivities: flow(-235, -184),   // no line of the desk's: part of what is not itemized
  AssetsCurrent: held(173857), CashAndCashEquivalentsAtCarryingValue: held(36305), MarketableSecuritiesCurrent: held(20417),
  AccountsReceivableNetCurrent: held(43817), NontradeReceivablesCurrent: held(39896), InventoryNet: held(14541),
  OtherAssetsCurrent: held(18881),                                      // no line of the desk's either
};
const PARTS = ['Financing Cash Flow', 'Share Buybacks', 'Dividends Paid', 'Debt Issued', 'Debt Repaid', 'Commercial Paper (net)', 'Tax Paid on Employee Share Awards'];

test("a company's financing cash flow comes with its parts as filed, so it is never taken for buybacks and dividends", async () => {
  const t = filedStatement(APPLE, 'cashflow', 'annual', '2026-11-11');
  const cells = (tt: typeof t, label: string) => tt.rows.find((r) => r.label === label)?.cells;
  assert.deepEqual(PARTS.map((l) => cells(t, l)), [[-127446e6], [86390e6], [15721e6], [0], [12396e6], [-5911e6], [6793e6]]);
  // A fourth quarter is derived for the parts as for every flow; a part filed only to date fills the column the others have.
  const quarters = filedStatement(APPLE, 'cashflow', 'quarterly', '2026-11-11');
  assert.deepEqual(quarters.columns, ['2026-09-26 (derived)', '2026-06-27 (9 months to date)']);
  assert.deepEqual(PARTS.map((l) => cells(quarters, l)), [[-32871e6, -94575e6], [24296e6, 62094e6], [3943e6, 11778e6], [0, 0], [4250e6, 8146e6], [0, -5911e6], [331e6, 6462e6]]);
  // The parts of current assets, each as filed; what they and cash leave (Apple's other current assets) has no line.
  const balance = filedStatement(APPLE, 'balance_sheet', 'annual', '2026-11-11');
  assert.deepEqual(['Current Assets', 'Cash and Equivalents', 'Marketable Securities (current)', 'Accounts Receivable', 'Other Receivables', 'Inventory'].map((l) => cells(balance, l)),
    [[173857e6], [36305e6], [20417e6], [43817e6], [39896e6], [14541e6]]);
  // The tool's words: the parts and their signs, and that the rest is not itemized.
  process.env.TRADING_AGENTS_TODAY = '2026-11-11';
  configure({ fetch: route([[/company_tickers\.json/, () => json({ 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } })], [/CIK0000320193\.json/, () => json({ facts: { 'us-gaap': APPLE } })]]) });
  const text = await financialStatement('AAPL', 'cashflow', 'annual', '2026-11-11');
  assert.match(text, /\nFinancing Cash Flow \| -127,446\.0\nShare Buybacks \| 86,390\.0\nDividends Paid \| 15,721\.0\nDebt Issued \| 0\.0\nDebt Repaid \| 12,396\.0\nCommercial Paper \(net\) \| -5,911\.0\nTax Paid on Employee Share Awards \| 6,793\.0\n/);
  assert.match(text, /share buybacks, dividends paid, debt repaid and tax paid on employee share awards are cash paid out, shown as positive figures/);
  assert.match(text, /what they do not cover is not itemized: never call the whole of it buybacks and dividends\./);
  assert.match(text, /"–" means the filings give no figure for that period: not known, never zero\./);
  const assets = await financialStatement('AAPL', 'balance_sheet', 'annual', '2026-11-11');
  assert.match(assets, /\nMarketable Securities \(current\) \| 20,417\.0\nAccounts Receivable \| 43,817\.0\nOther Receivables \| 39,896\.0\nInventory \| 14,541\.0\n/);
  assert.match(assets, /what they and cash do not cover is not itemized here, so never say what it is\./);
});

// NVIDIA's 10-Qs of 2026 split its marketable securities into debt and equity securities under other tags, and it
// raised debt in its second quarter only: the six months to date are filed, nothing for the first quarter.
const NVIDIA: Facts = {
  AssetsCurrent: { units: { USD: [at('2026-07-26', 197412e6, '2026-08-26'), at('2025-10-26', 116492e6, '2025-11-19')] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [at('2026-07-26', 22443e6, '2026-08-26'), at('2025-10-26', 11486e6, '2025-11-19')] } },
  MarketableSecuritiesCurrent: { units: { USD: [at('2025-10-26', 49122e6, '2025-11-19')] } },
  DebtSecuritiesCurrent: { units: { USD: [at('2026-07-26', 34143e6, '2026-08-26')] } },
  EquitySecuritiesFvNi: { units: { USD: [at('2026-07-26', 42783e6, '2026-08-26')] } },
  AccountsReceivableNetCurrent: { units: { USD: [at('2026-07-26', 63059e6, '2026-08-26'), at('2025-10-26', 33391e6, '2025-11-19')] } },
  InventoryNet: { units: { USD: [at('2026-07-26', 31575e6, '2026-08-26'), at('2025-10-26', 19784e6, '2025-11-19')] } },
  NetCashProvidedByUsedInFinancingActivities: { units: { USD: [q('2026-01-26', '2026-04-26', -21283e6, '2026-05-20'), q('2026-01-26', '2026-07-26', -27459e6, '2026-08-26')] } },
  PaymentsForRepurchaseOfCommonStock: { units: { USD: [q('2026-01-26', '2026-04-26', 19312e6, '2026-05-20'), q('2026-01-26', '2026-07-26', 39044e6, '2026-08-26')] } },
  ProceedsFromDebtNetOfIssuanceCosts: { units: { USD: [q('2026-01-26', '2026-07-26', 24896e6, '2026-08-26')] } },
};

test('a part the filings do not give whole is no figure, never a piece of it or a zero, and one filed only to date is a note', async () => {
  const balance = filedStatement(NVIDIA, 'balance_sheet', 'quarterly', '2026-11-09');
  assert.deepEqual(balance.columns, ['2026-07-26', '2025-10-26']);
  assert.deepEqual(balance.rows.find((r) => r.label === 'Marketable Securities (current)')!.cells, [null, 49122e6]);   // never the debt securities' 34,143 alone
  const cash = filedStatement(NVIDIA, 'cashflow', 'quarterly', '2026-11-09');
  assert.deepEqual(cash.columns, ['2026-07-26 (derived)', '2026-04-26']);                                           // no column of six months for one line
  assert.deepEqual(cash.rows.find((r) => r.label === 'Share Buybacks')!.cells, [19732e6, 19312e6]);
  assert.deepEqual(cash.rows.find((r) => r.label === 'Debt Issued'), { label: 'Debt Issued', unit: 'USD', cells: [null, null], noted: true });
  assert.ok(cash.notes!.includes('Debt Issued for the quarter to 2026-07-26 is not derived: its filings give the six months to 2026-07-26 (24,896.0 million USD, filed 2026-08-26) and no figure of it for the months before, so its quarter is not known; never take the six months for it.'), String(cash.notes));
  process.env.TRADING_AGENTS_TODAY = '2026-11-11';
  configure({ fetch: route([[/company_tickers\.json/, () => json({ 0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' } })], [/CIK0001045810\.json/, () => json({ facts: { 'us-gaap': NVIDIA } })]]) });
  const assets = await financialStatement('NVDA', 'balance_sheet', 'quarterly', '2026-11-09');
  assert.match(assets, /\nMarketable Securities \(current\) \| – \| 49,122\.0\n/);
  assert.match(assets, /\n\nNo figure in the company's SEC filings' data for: Total Assets, Other Receivables, Total Liabilities, Current Liabilities, Stockholders Equity\. The company may have none of it, or file it under a name of its own or in pieces, which the desk does not add up: never take another line for it, and never read it as zero\./);
  const flows = await financialStatement('NVDA', 'cashflow', 'quarterly', '2026-11-09');
  assert.match(flows, /\nDebt Issued \| – \| –\n/);
  assert.match(flows, /No figure in the company's SEC filings' data for: Operating Cash Flow, Investing Cash Flow, Capital Expenditure, Dividends Paid, Debt Repaid, Commercial Paper \(net\), Tax Paid on Employee Share Awards\./);
});

test('the tool serves a US filer from the SEC, in millions, with the email sent to the SEC alone', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  configure({ contact: 'ta (+x)', secEmail: 'me@example.com', fetch: route(SEC, seen) });
  const t = await financialStatement('acme', 'income_statement', 'quarterly', '2025-09-01');
  assert.match(t, /^Income statement for ACME \(quarterly\), as filed with the SEC on or before 2025-09-01/);
  assert.match(t, /Line \| 2025-06-30 \| 2025-03-31 \| 2024-06-30/);
  assert.match(t, /Revenue \| 120\.0 \| 100\.0 \| 95\.0/);
  assert.match(t, /Diluted EPS \(USD per share\) \| 1\.23 \| – \| –/);
  assert.match(t, /No figure in the company's SEC filings' data for: Cost of Revenue, Gross Profit, Operating Income, Net Income\. The company may have none of it/);
  assert.match(t, /a quarter no filing states .* is derived from two filed figures of the same year, its column marked "\(derived\)"/);
  assert.match(t, /Revenue growth on the quarter just before \(worked out\) \| 20\.0% \| – \| –/);      // 120 on 100; never across the gap to 2024
  assert.match(t, /Revenue growth on the same quarter a year before \(worked out\) \| 26\.3% \| – \| –/);
  assert.match(t, /quote them rather than working your own/);
  const sec = seen.filter((s) => /\.sec\.gov\//.test(s.url)), other = seen.filter((s) => !sec.includes(s));
  assert.ok(sec.length && sec.every((s) => s.headers['User-Agent'] === 'ta me@example.com'), 'both SEC hosts get the name and the email, with no bracketed address');
  assert.ok(other.every((s) => /finance\/chart\/ACME\?.*events=split/.test(s.url) && !JSON.stringify(s.headers).includes('me@example.com')), 'the price source is asked only for its record of splits, never sent the email');
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
  assert.match(now, /Money in millions of JPY unless the row says otherwise; "–" means no figure for that period\./);
  assert.match(now, /Total Assets \| 90,000,000\.0/);
  // Yahoo is read for the lines it was read for before, in its own words; the parts of a total are the SEC's only.
  assert.match(now, /\n\nNot reported by this source: Current Assets, Cash and Equivalents, Total Liabilities, Current Liabilities, Stockholders Equity\.$/);
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
  configure({ fetch: route([NOT_AT_THE_SEC, ...YAHOO_SESSION, [/quoteSummary/, () => json(SUMMARY)]], seen) });
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
  configure({ fetch: route([NOT_AT_THE_SEC, ...YAHOO_SESSION, [/quoteSummary/, () => json(SUMMARY)]]) });
  const t = await insiderTransactions('ACME', '2026-10-12');
  assert.match(t, /- 2026-10-01 · JOHN DOE \(Chief Executive Officer\): no description · 75,000 shares · held indirectly\n- 2026-09-10 · JANE ROE \(Director\): Sale at price 180\.00 per share\. · 5,000 shares · value 900,000/);
  assert.match(await insiderTransactions('ACME', '2026-10-01'), /withheld for 2026-10-01/);
});

// The shape Yahoo gives a sector fund (field names and kinds of values as it answered for XLK on 21 Oct 2026; figures made up).
const FUND = { quoteSummary: { result: [{
  price: { longName: 'Tech Sector Fund', currency: 'USD' },
  quoteType: { quoteType: 'ETF' },
  fundProfile: { family: 'Example Advisors', categoryName: 'Technology', feesExpensesInvestment: { annualReportExpenseRatio: { raw: 0.000945, fmt: '0.09%' }, netExpRatio: {}, annualHoldingsTurnover: { raw: 0.03 } } },
  topHoldings: {
    stockPosition: { raw: 0.9997 }, bondPosition: { raw: 0 }, cashPosition: { raw: 0.0004 },
    holdings: [{ symbol: 'NVDA', holdingName: 'NVIDIA Corp', holdingPercent: { raw: 0.154659 } }, { symbol: 'AAPL', holdingName: 'Apple Inc', holdingPercent: { raw: 0.136004 } }, { symbol: 'MSFT', holdingName: 'Microsoft Corp', holdingPercent: { raw: 0.10657679 } }],
    sectorWeightings: [{ realestate: { raw: 0 } }, { technology: { raw: 0.9811 } }, { communication_services: { raw: 0.0189 } }],
    equityHoldings: { priceToEarnings: { raw: 0.03121, fmt: '0.03' } },
  },
  summaryDetail: { totalAssets: { raw: 127297691648 }, yield: { raw: 0.0062 } },
  defaultKeyStatistics: { fundInceptionDate: { raw: Date.parse('1998-12-16T00:00:00Z') / 1000 }, annualReportExpenseRatio: {}, beta3Year: { raw: 1.21 } },
}], error: null } };

test("a fund the SEC does not list is read from Yahoo: what it holds and what it costs, unavailable when not given; withheld for a past day", async () => {
  // Neither SEC list knows these tickers (a fund outside the US), so the fund tool falls back to Yahoo, today only.
  const unlisted: Array<[RegExp, () => Response]> = [[/company_tickers_mf\.json/, () => json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] })], [/company_tickers\.json/, () => json({})]];
  configure({ fetch: route([...unlisted, ...YAHOO_SESSION, [/quoteSummary\/XLK/, () => json(FUND)], [/quoteSummary\/ACME/, () => json({ quoteSummary: { result: [{ ...SUMMARY.quoteSummary.result[0], quoteType: { quoteType: 'EQUITY' } }] } })], [/quoteSummary\/BARE/, () => json({ quoteSummary: { result: [{ quoteType: { quoteType: 'ETF' }, price: { currency: 'USD' } }] } })]]) });
  const t = await fundProfile('XLK', '2026-10-12');
  assert.match(t, /^Fund profile for XLK, from Yahoo Finance as it stands today \(2026-10-12\)/);
  assert.match(t, /Kind: an exchange-traded fund \(ETF\)\nFamily: Example Advisors\nCategory: Technology\nStarted: 1998-12-16/);
  assert.match(t, /Net assets \(its size\): 127,297,691,648 USD/);
  assert.match(t, /Yearly cost \(expense ratio, taken from the fund's value each year\): 0\.0945%/, 'three figures, so its cost on 1,000 dollars can be worked out');
  assert.match(t, /Held in: stocks 99\.97%, bonds 0\.00%, cash 0\.04%/);
  assert.match(t, /Top 3 holdings \(39\.72% of the fund together\):\n- NVDA NVIDIA Corp: 15\.47%\n- AAPL Apple Inc: 13\.60%\n- MSFT Microsoft Corp: 10\.66%/);
  assert.match(t, /By sector: Technology 98\.11%, Communication services 1\.89%$/m, 'largest first, nothing at zero');
  assert.doesNotMatch(t, /price to earnings|0\.03/i, "Yahoo's odd averages for a fund's stocks are left out");
  const bare = await fundProfile('BARE', '2026-10-12');
  assert.match(bare, /Net assets \(its size\): unavailable/);
  assert.match(bare, /Yearly cost .*: unavailable/);
  assert.match(bare, /Top holdings: unavailable/);
  await assert.rejects(fundProfile('ACME', '2026-10-12'), /ACME is not a fund \(Yahoo Finance lists it as equity\): use the company tools instead/);
  await assert.rejects(fundProfile('BTC-USD', '2026-10-12'), /is not a company/);
  assert.match(await fundProfile('XLK', '2026-10-01'), /withheld for 2026-10-01: Yahoo Finance serves it only as it stands today/);
});

test('an expired session key is renewed once', async () => {
  let crumbs = 0;
  configure({ fetch: route([NOT_AT_THE_SEC,
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
  for (const n of ['get_company_overview', 'get_financial_statement', 'get_insider_transactions', 'get_fund_profile']) assert.ok(names.includes(n), n);
  const r = await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: '2025-09-01', statement: 'balance_sheet' } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /Balance sheet for ACME \(quarterly\), as filed with the SEC on or before 2025-09-01/);
  // the three statements, quarterly and annual, in one call: one step for the fact checker where six were
  const all = await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: '2025-09-01', statement: 'all', frequency: 'both' } }) as { content: Array<{ text: string }> };
  const heads = [...all.content[0]!.text.matchAll(/^(Income statement|Balance sheet|Cash flow statement) for ACME \((quarterly|annual)\)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(heads, ['Income statement quarterly', 'Income statement annual', 'Balance sheet quarterly', 'Balance sheet annual', 'Cash flow statement quarterly']);
  // no annual cash flow statement was filed by then: that one part says so, and the other five still come
  assert.match(all.content[0]!.text, /\n\nCash flow statement for ACME is withheld for 2025-09-01: no annual cash flow statement was filed with the SEC by 2025-09-01/);
  const one = await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: '2025-09-01', statement: 'income_statement', frequency: 'both' } }) as { content: Array<{ text: string }> };
  assert.equal([...one.content[0]!.text.matchAll(/^Income statement for ACME \((quarterly|annual)\)/gm)].length, 2);
  const bad = await client.callTool({ name: 'get_insider_transactions', arguments: { symbol: 'BTC-USD', analysis_date: '2026-10-12' } }) as { content: Array<{ text: string }> };
  assert.match(bad.content[0]!.text, /^NO_DATA_AVAILABLE: insider transactions of BTC-USD: BTC-USD is not a company/);
  await client.close();
});
