// Audit 3, group F: company filings and economic figures. Each test is one finding of the audit (filings-1 to 10),
// written first as a failing test. No network: every answer is made up in the shape the real source gives it (the SEC's
// company facts and Form 4s, the price source's split record, FRED's archive, N-PORT reports), with nothing personal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, NoData } from '../src/data/http.js';
import { clearSecCache, filedStatement, type Facts } from '../src/data/sec.js';
import { clearYahooSession, companyOverview, financialStatement, insiderTransactions, renderTable, withWorkedRows } from '../src/data/company.js';
import { parseForm4 } from '../src/data/insiders.js';
import { economicSeries } from '../src/data/macro.js';
import { parseReport, renderReport } from '../src/data/nport.js';
import { checkEmail } from '../src/contact.js';
import { userAgentFor } from '../src/check/probes.js';
import { clearCache } from '../src/data/yahoo.js';
import { chartJson, series } from './chart.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

beforeEach(() => { clearSecCache(); clearYahooSession(); clearCache(); configure({ secEmail: '' }); });

const TICKERS: [RegExp, (url: string) => Response] = [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME', title: 'ACME CORP' } })];
const record = (forms: Array<[string, string]> = []) => ({
  name: 'ACME CORP', sic: '3674', sicDescription: 'Semiconductors & Related Devices', fiscalYearEnd: '0128',
  filings: { recent: { accessionNumber: forms.map((_, i) => `0001234-26-00000${i}`), filingDate: forms.map(([, d]) => d), reportDate: forms.map(([, d]) => d), form: forms.map(([f]) => f), primaryDocument: forms.map(() => 'a.htm') } },
});

// ---------- filings-1: the valuation across a share split ----------

// NVIDIA's own figures around its 10-for-1 split of June 2024, as the SEC serves them today (each figure as first filed,
// and the earlier periods refiled on the new basis after the split). The prices are on today's basis, as the price
// source gives every past price: 82.28 on 2024-03-01, a day it traded at about 822.
const eps = (start: string, end: string, val: number, filed: string, form = '10-Q') => ({ start, end, val, filed, form });
const SPLIT_FACTS = { facts: {
  dei: { EntityCommonStockSharesOutstanding: { units: { shares: [
    { end: '2024-02-16', val: 2.5e9, filed: '2024-02-21', accn: 'k24', form: '10-K' },
    { end: '2024-05-17', val: 2.464e9, filed: '2024-05-29', accn: 'q1', form: '10-Q' },
    { end: '2024-08-16', val: 24.53e9, filed: '2024-08-28', accn: 'q2', form: '10-Q' },
  ] } } },
  'us-gaap': {
    EarningsPerShareDiluted: { units: { 'USD/shares': [
      eps('2022-01-31', '2023-01-29', 1.74, '2023-02-24', '10-K'),
      eps('2023-01-30', '2023-04-30', 0.82, '2023-05-26'), eps('2023-01-30', '2023-07-30', 3.3, '2023-08-30'),
      eps('2023-01-30', '2024-01-28', 11.93, '2024-02-21', '10-K'),
      eps('2024-01-29', '2024-04-28', 5.98, '2024-05-29'), eps('2023-01-30', '2023-04-30', 0.82, '2024-05-29'),
      eps('2024-01-29', '2024-07-28', 1.27, '2024-08-28'), eps('2023-01-30', '2023-07-30', 0.33, '2024-08-28'),
      eps('2023-01-30', '2024-01-28', 1.19, '2025-02-26', '10-K'),
    ] } },
    StockholdersEquity: { units: { USD: [
      { end: '2024-01-28', val: 42.978e9, filed: '2024-02-21', form: '10-K' }, { end: '2024-04-28', val: 49.1e9, filed: '2024-05-29', form: '10-Q' },
      { end: '2024-07-28', val: 58.2e9, filed: '2024-08-28', form: '10-Q' },
    ] } },
  },
} };
/** The price source's record of splits, keyed as it keys them, in an answer of monthly rows. */
const splitAnswer = (splits: Array<[string, number, number]>) => {
  const j = chartJson('ACME', series('2026-11-02', 3));
  const events = { splits: Object.fromEntries(splits.map(([d, n, m]) => { const at = Date.parse(`${d}T13:30:00Z`) / 1000; return [String(at - 86400 * 9), { date: at, numerator: n, denominator: m, splitRatio: `${n}:${m}` }]; })) };
  return { chart: { ...j.chart, result: [{ ...j.chart.result[0]!, events }] } };
};
const NVDA_SPLITS: Array<[string, number, number]> = [['2021-07-20', 4, 1], ['2024-06-10', 10, 1]];
function splitDesk(day: string, close: number, adj = close, splits = NVDA_SPLITS, seen: string[] = []) {
  const rows = series(day, 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: close, adj } : r));
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record())],
    [/companyfacts\/CIK0000001234\.json/, () => json(SPLIT_FACTS)],
    [/v8\/finance\/chart\/ACME\?[^ ]*interval=1mo/, () => json(splitAnswer(splits))],
    [/v8\/finance\/chart\/ACME\?/, () => json(chartJson('ACME', rows))],
  ], seen) });
}

test('filings-1: a past day before a later split values the company on one share basis, without naming the later split', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  splitDesk('2024-03-01', 82.28, 82.1);
  const t = await companyOverview('ACME', '2024-03-01');
  // NVIDIA on 2024-03-01: about 2.06 trillion dollars, 69 times its earnings and 48 times its book.
  assert.match(t, /\nClose: 82\.28 USD on 2024-03-01 \(the price it traded at that day, on the price source's share basis of today: it adjusts every past price for any share split since, and the filed per-share figures and share counts below are put on that same basis; the checked price table shows 82\.10 for that day, lowered by the dividends paid since\)\n/);
  assert.match(t, /\nMarket value \(derived: shares × close\): 2,057,000,000,000 USD\n/);
  assert.match(t, /\nDiluted EPS, last twelve months \(derived from the full year to 2024-01-28, 1\.193\): 1\.19 USD\nPrice to earnings \(derived: close ÷ that\): 68\.97\n/);
  assert.match(t, /\nBook value per share \(derived: equity ÷ shares\): 1\.72 USD\nPrice to book \(derived: close ÷ that\): 47\.86\n/);
  assert.doesNotMatch(t, /2024-06-10|10-for-1|11\.93|2,500,000,000/, 'a split after the analysis day is never named, nor the figures as filed before it');
});

test('filings-1: today, after a split no filing shows yet, every filed figure is put on the price\'s basis and the split is named', async () => {
  process.env.TRADING_AGENTS_TODAY = '2024-07-01';
  splitDesk('2024-07-01', 124.3);
  const t = await companyOverview('ACME', '2024-07-01');
  assert.match(t, /\nShares outstanding: 24,640,000,000 \(counted on 2024-05-17, filed 2024-05-29 as 2,464,000,000, before the 10-for-1 split of 2024-06-10\)\nMarket value \(derived: shares × close\): 3,062,752,000,000 USD\n/);
  assert.match(t, /\nDiluted EPS, last twelve months \(derived from the full year to 2024-01-28, 1\.193 \(11\.93 as filed, before the 10-for-1 split of 2024-06-10\), plus 2024-01-29 to 2024-04-28, 0\.598 \(5\.98 as filed, before the 10-for-1 split of 2024-06-10\), less 2023-01-30 to 2023-04-30, 0\.082 \(0\.82 as filed, before the 10-for-1 split of 2024-06-10\)\): 1\.71 USD\nPrice to earnings \(derived: close ÷ that\): 72\.73\n/);
});

test('filings-1: after the first filing on the new basis, the last full year filed before the split is not mixed into the twelve months', async () => {
  process.env.TRADING_AGENTS_TODAY = '2024-09-03';
  splitDesk('2024-09-03', 108);
  const t = await companyOverview('ACME', '2024-09-03');
  assert.match(t, /\nDiluted EPS, last twelve months \(derived from the full year to 2024-01-28, 1\.193 \(11\.93 as filed, before the 10-for-1 split of 2024-06-10\), plus 2024-01-29 to 2024-07-28, 1\.27, less 2023-01-30 to 2023-07-30, 0\.33\): 2\.13 USD\nPrice to earnings \(derived: close ÷ that\): 50\.63\n/);
  assert.match(t, /\nShares outstanding: 24,530,000,000 \(counted on 2024-08-16, filed 2024-08-28\)\nMarket value \(derived: shares × close\): 2,649,240,000,000 USD\n/);
});

test('filings-1: the statement table of a past day puts per-share figures on the prices\' basis too, without naming a later split', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const seen: string[] = [];
  splitDesk('2024-07-01', 124.3, 124.3, NVDA_SPLITS, seen);
  const t = await financialStatement('ACME', 'income_statement', 'annual', '2024-07-01');
  assert.match(t, /\nDiluted EPS \(USD per share\) \| 1\.19 \| 0\.17\n/, 'the year to January 2024 (11.93 as filed) and 2023 (1.74), on the prices\' share basis');
  assert.match(t, /Per-share figures are on the price source's share basis of today/);
  assert.doesNotMatch(t, /2024-06-10|10-for-1|11\.93/);
  assert.ok(seen.filter((u) => /finance\/chart/.test(u)).every((u) => /interval=1mo&events=split/.test(u)), 'only the record of splits is asked of the price source');
});

test('filings-1: when the price source\'s record of splits cannot be read, no multiple is worked out from figures that may be on another basis', async () => {
  process.env.TRADING_AGENTS_TODAY = '2024-07-01';
  const rows = series('2024-07-01', 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: 124.3 } : r));
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record())],
    [/companyfacts\/CIK0000001234\.json/, () => json(SPLIT_FACTS)],
    [/v8\/finance\/chart\/ACME\?[^ ]*interval=1mo/, () => new Response('busy', { status: 403 })],
    [/v8\/finance\/chart\/ACME\?/, () => json(chartJson('ACME', rows))],
  ]) });
  const t = await companyOverview('ACME', '2024-07-01');
  assert.match(t, /\nMarket value, price to earnings and price to book: unavailable\. The price source's record of share splits could not be read \(.*refused \(HTTP 403\).*\), so the filed figures cannot be put on the share basis of its prices: a split since a figure was filed would put a multiple off by its ratio\.\n/);
  assert.doesNotMatch(t, /Market value \(derived|Price to earnings \(derived|Price to book \(derived/);
});

// ---------- filings-3: a foreign filer's cover count is of its ordinary shares ----------

test('filings-3: no market value or per-share multiple is worked out from a 20-F cover count, and the reason is given', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const facts = { facts: {
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-12-31', val: 25932524521, filed: '2026-04-16', accn: 'f', form: '20-F' }] } } },
    'us-gaap': {
      EarningsPerShareDiluted: { units: { 'USD/shares': [eps('2025-01-01', '2025-12-31', 1.5, '2026-04-16', '20-F')] } },
      StockholdersEquity: { units: { USD: [{ end: '2025-12-31', val: 100e9, filed: '2026-04-16', form: '20-F' }] } },
    },
  } };
  const rows = series('2026-11-05', 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: 290 } : r));
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record([['6-K', '2026-10-30'], ['20-F', '2026-04-16']]))],
    [/companyfacts\/CIK0000001234\.json/, () => json(facts)],
    [/v8\/finance\/chart\/ACME\?/, () => json(chartJson('ACME', rows))],
  ]) });
  const t = await companyOverview('ACME', '2026-11-06');
  assert.match(t, /\nShares outstanding: 25,932,524,521 ordinary shares \(counted on 2025-12-31, filed 2026-04-16\)\n/);
  assert.match(t, /\nMarket value, price to earnings and price to book: not worked out\. ACME files with the SEC as a foreign company \(its yearly report is a form 20-F\): the count on its cover and any per-share figure in its accounts are of its ordinary shares, and its US listing may be depositary shares \(ADS\) that each stand for several of them, a ratio its SEC filings do not give in a form the desk can read\. A multiple from these figures and the price of one US share could be off by that ratio\.\n/);
  assert.match(t, /\nDiluted EPS, last twelve months, per ordinary share \(derived from the full year to 2025-12-31, 1\.5\): 1\.50 USD\n/);
  assert.doesNotMatch(t, /Market value \(derived|Price to earnings \(derived|Book value per share|Price to book \(derived/);
});

// ---------- filings-7: EPS and shares filed as one "basic and diluted" figure ----------

test('filings-7: EPS and average shares filed as one basic-and-diluted figure are read, and a missing EPS is not blamed on its currency', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const combined: Facts = {
    EarningsPerShareBasicAndDiluted: { units: { 'USD/shares': [eps('2025-01-01', '2025-12-31', 2.5, '2026-02-20', '10-K'), eps('2025-07-01', '2025-09-30', 0.6, '2025-10-30')] } },
    WeightedAverageNumberOfShareOutstandingBasicAndDiluted: { units: { shares: [eps('2025-10-01', '2025-12-31', 40e6, '2026-02-20', '10-K')] } },
    StockholdersEquity: { units: { USD: [{ end: '2025-12-31', val: 800e6, filed: '2026-02-20', form: '10-K' }] } },
  };
  const rows = series('2026-11-05', 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: 50 } : r));
  const desk = (us: Facts) => configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record())],
    [/companyfacts\/CIK0000001234\.json/, () => json({ facts: { 'us-gaap': us } })],
    [/v8\/finance\/chart\/ACME\?/, () => json(chartJson('ACME', rows))],
  ]) });
  desk(combined);
  const t = await companyOverview('ACME', '2026-11-06');
  assert.match(t, /\nDiluted EPS, last twelve months \(derived from the full year to 2025-12-31, 2\.5\): 2\.50 USD\nPrice to earnings \(derived: close ÷ that\): 20\.00\n/);
  assert.match(t, /In its place, the weighted average shares from its accounts \(one figure, filed as both basic and diluted\) for 2025-10-01 to 2025-12-31: 40,000,000 \(filed 2026-02-20\)/);
  const table = filedStatement(combined, 'income_statement', 'quarterly', '2026-11-06');
  assert.deepEqual(table.rows.find((r) => r.label === 'Diluted EPS')!.cells.filter((c) => c !== null), [0.6]);
  clearSecCache(); clearCache();
  desk({ StockholdersEquity: combined.StockholdersEquity! });
  const none = await companyOverview('ACME', '2026-11-06');
  assert.match(none, /\nDiluted EPS, last twelve months: unavailable \(no full year of it in US dollars among its filed figures by then\)\n/);
  assert.doesNotMatch(none, /not filed in US dollars/);
});

// ---------- filings-4: a fourth quarter across a recast ----------

test('filings-4: a quarter is not derived from a recast year and a nine months filed before the recast', () => {
  // A business spun off in the fourth quarter: the annual report shows the year without it and refiles the year before
  // without it; the nine months were filed with it (millions; continuing business about 3,400 a quarter).
  const f = (start: string, end: string, val: number, filed: string, form = '10-Q') => ({ start, end, val: val * 1e6, filed, form });
  const facts: Facts = { Revenues: { units: { USD: [
    f('2024-01-01', '2024-03-31', 4000, '2024-05-02'), f('2024-04-01', '2024-06-30', 4100, '2024-08-01'), f('2024-01-01', '2024-06-30', 8100, '2024-08-01'),
    f('2024-07-01', '2024-09-30', 4000, '2024-10-31'), f('2024-01-01', '2024-09-30', 12100, '2024-10-31'), f('2024-01-01', '2024-12-31', 16200, '2025-02-20', '10-K'),
    f('2025-01-01', '2025-03-31', 4200, '2025-05-01'), f('2025-04-01', '2025-06-30', 4300, '2025-07-31'), f('2025-01-01', '2025-06-30', 8500, '2025-07-31'),
    f('2025-07-01', '2025-09-30', 4200, '2025-10-30'), f('2025-01-01', '2025-09-30', 12700, '2025-10-30'),
    // The third quarter's report gives the same months a year before, unchanged: the business was still in it then.
    f('2024-07-01', '2024-09-30', 4000, '2025-10-30'), f('2024-01-01', '2024-09-30', 12100, '2025-10-30'),
    f('2025-01-01', '2025-12-31', 13600, '2026-02-19', '10-K'), f('2024-01-01', '2024-12-31', 12900, '2026-02-19', '10-K'),
  ] } } };
  const t = filedStatement(facts, 'income_statement', 'quarterly', '2026-03-01');
  assert.ok(!t.columns.some((c) => c.startsWith('2025-12-31') || c.startsWith('2024-12-31')), String(t.columns));
  assert.ok(t.notes!.includes('Revenue for the quarter to 2025-12-31 is not derived: the year to 2025-12-31 (filed 2026-02-19) and the nine months to 2025-09-30 (filed 2025-10-30) are on different bases, since a filing of 2026-02-19 restated an earlier figure of it (the year to 2024-12-31, first filed as 16,200.0 million USD, refiled then as 12,900.0 million), as when a business is sold or spun off. The one less the other would not be a quarter.'), String(t.notes));
  const text = renderTable(withWorkedRows(t, 'income_statement', 'quarterly'), 'Revenue', '');
  assert.doesNotMatch(text, /-78\.6%|425\.0%|\| 900\.0/);
  // Before the recast, the same year less its nine months is a quarter as ever.
  const before = filedStatement(facts, 'income_statement', 'quarterly', '2025-06-01');
  assert.equal(before.rows[0]!.cells[before.columns.indexOf('2024-12-31 (derived)')], 4100e6);
});

test('filings-4: a spin-off refiles the earlier periods over a year; only quarters whose figures fall either side of it are refused', () => {
  // As GE did around its spin-off of April 2024: the first quarter's report still holds the business spun off (and
  // refiles the quarter a year before unchanged); from the second quarter on, each report refiles the same months a year
  // before without it (millions; 4,000 a quarter with it, about 3,000 without).
  const f = (start: string, end: string, val: number, filed: string, form = '10-Q') => ({ start, end, val: val * 1e6, filed, form });
  const old = [
    f('2023-01-01', '2023-03-31', 4000, '2023-04-25'), f('2023-04-01', '2023-06-30', 4000, '2023-07-25'), f('2023-01-01', '2023-06-30', 8000, '2023-07-25'),
    f('2023-07-01', '2023-09-30', 4000, '2023-10-24'), f('2023-01-01', '2023-09-30', 12000, '2023-10-24'), f('2023-01-01', '2023-12-31', 16000, '2024-02-02', '10-K'),
  ];
  const after = [
    f('2024-04-01', '2024-06-30', 3100, '2024-07-23'), f('2024-01-01', '2024-06-30', 6200, '2024-07-23'), f('2023-04-01', '2023-06-30', 3000, '2024-07-23'), f('2023-01-01', '2023-06-30', 6000, '2024-07-23'),
    f('2024-07-01', '2024-09-30', 3100, '2024-10-22'), f('2024-01-01', '2024-09-30', 9300, '2024-10-22'), f('2023-07-01', '2023-09-30', 3000, '2024-10-22'), f('2023-01-01', '2023-09-30', 9000, '2024-10-22'),
    f('2024-01-01', '2024-12-31', 12400, '2025-02-03', '10-K'), f('2023-01-01', '2023-12-31', 12000, '2025-02-03', '10-K'),
  ];
  const q1 = [f('2024-01-01', '2024-03-31', 4100, '2024-04-23'), f('2023-01-01', '2023-03-31', 4000, '2024-04-23')];
  const facts: Facts = { Revenues: { units: { USD: [...old, ...q1, ...after] } } };
  const cell = (asOf: string, col: string) => { const t = filedStatement(facts, 'income_statement', 'quarterly', asOf); return t.rows[0]!.cells[t.columns.indexOf(col)]; };
  // In August 2024 the year 2023 and its nine months were both filed before the change: their difference is a quarter.
  assert.equal(cell('2024-08-01', '2023-12-31 (derived)'), 4000e6);
  // By November the nine months are refiled without the business, the year not yet: no quarter, and why.
  const nov = filedStatement(facts, 'income_statement', 'quarterly', '2024-11-01');
  assert.ok(!nov.columns.includes('2023-12-31 (derived)'), String(nov.columns));
  assert.ok(nov.notes!.some((n) => /^Revenue for the quarter to 2023-12-31 is not derived: the year to 2023-12-31 \(filed 2024-02-02\) and the nine months to 2023-09-30 \(filed 2024-10-22\) are on different bases, since a filing of 2024-07-23 restated an earlier figure of it/.test(n)), String(nov.notes));
  // The year 2024 and its nine months were both filed after the change: a quarter as ever.
  assert.equal(cell('2025-03-01', '2024-12-31 (derived)'), 3100e6);
  // Without the first quarter's report, nothing shows the change came after the nine months were filed: it may have.
  const unsure = filedStatement({ Revenues: { units: { USD: [...old, ...after] } } }, 'income_statement', 'quarterly', '2024-08-01');
  assert.ok(unsure.notes!.some((n) => /^Revenue for the quarter to 2023-12-31 is not derived: the year to 2023-12-31 \(filed 2024-02-02\) and the nine months to 2023-09-30 \(filed 2023-10-24\) may be on different bases: a filing of 2024-07-23 restated an earlier figure of it \([^)]*\), as when a business is sold or spun off, and the filings show only that the change came after 2023-07-25 and by 2024-07-23\. The one less the other may not be a quarter\.$/.test(n)), String(unsure.notes));
});

// ---------- filings-2 and 6: insider trades ----------

const FORM4 = (o: { issuer?: string; issuerName?: string; owner: string; plan: string; rows: string; footnotes?: string }) => `<?xml version="1.0"?>
<ownershipDocument><schemaVersion>X0609</schemaVersion><documentType>4</documentType><periodOfReport>2026-10-16</periodOfReport>
<issuer><issuerCik>${o.issuer ?? '0000001234'}</issuerCik><issuerName>${o.issuerName ?? 'ACME CORP'}</issuerName><issuerTradingSymbol>X</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0000005555</rptOwnerCik><rptOwnerName>${o.owner}</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner><isOther>0</isOther></reportingOwnerRelationship></reportingOwner>
<aff10b5One>${o.plan}</aff10b5One>
<nonDerivativeTable>${o.rows}</nonDerivativeTable>${o.footnotes ? `<footnotes>${o.footnotes}</footnotes>` : ''}
</ownershipDocument>`;
const LINE4 = (code: string, shares: number, price: number, note = '') => `<nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle>
<transactionDate><value>2026-10-16</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved>${note}</transactionCoding>
<transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === 'P' ? 'A' : 'D'}</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>600000000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>`;
const insiderDesk = (docs: Record<string, string>) => {
  const names = Object.keys(docs);
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json({ name: 'ACME CORP', filings: { recent: {
      accessionNumber: names.map((_, i) => `0000005555-26-00000${i}`), filingDate: names.map(() => '2026-10-20'), reportDate: names.map(() => '2026-10-16'),
      form: names.map(() => '4'), primaryDocument: names.map((n) => `xslF345X05/${n}.xml`) } } })],
    [/Archives\/edgar\/data\/1234\/\d+\/(\w+)\.xml$/, (u) => new Response(docs[/\/(\w+)\.xml$/.exec(u)![1]!]!)],
  ]) });
};

test("filings-2: a Form 4 the company filed as the owner of another company's shares is not read as its insiders' trade", async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const other = FORM4({ issuer: '0009999999', issuerName: 'OTHERCO INC', owner: 'ACME CORP', plan: '0', rows: LINE4('S', 69e6, 15) });
  const own = FORM4({ owner: 'ROE JANE', plan: '0', rows: LINE4('P', 1000, 20) });
  insiderDesk({ other, own });
  const t = await insiderTransactions('ACME', '2026-11-06');
  assert.match(t, /\(2 of 2 filings read, newest first; one is ACME's own trade in another company's shares \(OTHERCO INC\), filed as that company's large owner, and is left out\)/);
  assert.match(t, /bought \(code P\) 1 \(1,000 shares, about 20,000 USD at their own prices\); sold \(code S\) none;/);
  assert.doesNotMatch(t, /69,000,000/);
  clearSecCache();
  insiderDesk({ other });
  const none = await insiderTransactions('ACME', '2026-11-06');
  assert.match(none, /: none by its own insiders\. The one Form 4 filing in its SEC list for these days is ACME's own trade in another company's shares \(OTHERCO INC\), filed as that company's large owner: not a trade in ACME, so it is left out\. That is a fact from the SEC/);
});

test('filings-6: the 10b5-1 box marks only the trades its footnotes tie to the plan; without such a footnote, purchases and sales are hedged', () => {
  const notes = '<footnote id="F1">Represents shares withheld by the Issuer to satisfy taxes due on the vesting of restricted stock units.</footnote><footnote id="F3">The reported transaction was effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on June 16, 2026.</footnote>';
  const t = parseForm4(FORM4({ owner: 'KRESS', plan: '1', rows: LINE4('F', 40747, 212.17, '<footnoteId id="F1"/>') + LINE4('S', 20369, 219, '<footnoteId id="F3"/>'), footnotes: notes }), '2026-10-20');
  assert.deepEqual(t.map((x) => [x.code, x.plan, x.planBox ?? false]), [['F', false, false], ['S', true, false]]);
  const bare = parseForm4(FORM4({ owner: 'KRESS', plan: '1', rows: LINE4('G', 10, 1) + LINE4('S', 5, 2) }), '2026-10-20');
  assert.deepEqual(bare.map((x) => [x.code, x.plan, x.planBox ?? false]), [['G', false, false], ['S', false, true]]);
});

test('filings-6: the tool says which trades the box covers', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const notes = '<footnote id="F1">Shares withheld for taxes.</footnote><footnote id="F3">Effected pursuant to a Rule 10b5-1 trading plan.</footnote>';
  insiderDesk({
    a: FORM4({ owner: 'KRESS', plan: '1', rows: LINE4('F', 40747, 212.17, '<footnoteId id="F1"/>') + LINE4('S', 20369, 219, '<footnoteId id="F3"/>'), footnotes: notes }),
    b: FORM4({ owner: 'ROE', plan: '1', rows: LINE4('S', 100, 10) }),
  });
  const t = await insiderTransactions('ACME', '2026-11-06');
  assert.match(t, /sold \(code S\) 2 \([^)]*; 1 under a pre-arranged 10b5-1 plan; 1 more in a filing whose 10b5-1 box covers at least one of its trades without saying which\)/);
  assert.match(t, /KRESS \(owner of over 10%\): handed back, for tax or the exercise price, 40,747 shares at 212\.17 · holds 600,000,000 after$/m);
  assert.match(t, /KRESS \(owner of over 10%\): sold 20,369 shares at 219 · holds 600,000,000 after · under a 10b5-1 plan$/m);
  assert.match(t, /ROE \(owner of over 10%\): sold 100 shares at 10 · holds 600,000,000 after · its filing's 10b5-1 box is ticked: at least one trade in that filing was under a plan, and the filing does not say which$/m);
});

// ---------- filings-5: economic figures as they were known on a past day ----------

test("filings-5: a past day reads FRED's archive as it stood that day: no figure published later, and none revised since", async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  const seen: string[] = [];
  // As FRED's archive held core PCE on 2026-09-24: July's figure is the latest (August's came out on the 26th).
  const then = 'observation_date,PCEPILFE_20260924\n2025-07-01,124.10\n2025-08-01,124.30\n2026-06-01,127.00\n2026-07-01,127.20\n';
  const now = 'observation_date,PCEPILFE\n2025-07-01,124.20\n2025-08-01,124.40\n2026-06-01,127.10\n2026-07-01,127.35\n2026-08-01,127.60\n2026-09-01,127.90\n';
  configure({ fetch: route([[/alfredgraph\.csv\?id=PCEPILFE&vintage_date=2026-09-24&/, () => new Response(then)], [/fredgraph\.csv\?id=PCEPILFE&/, () => new Response(now)]], seen) });
  const past = await economicSeries('core_pce', '2026-09-24');
  assert.match(past, /- Latest value known by 2026-09-24: 127\.20 \(for July 2026\)/);
  assert.match(past, /- Year over year, from 124\.10 for July 2025: \+3\.10 \(\+2\.5%\)/);
  assert.match(past, /- A past analysis date: these are the figures as FRED's archive of past releases \(ALFRED\) held them on 2026-09-24: only what was published by then, before any later revision\./);
  assert.doesNotMatch(past, /release lag|127\.60|127\.35/);
  assert.ok(seen.every((u) => /alfred/.test(u)), 'a past day never reads today\'s figures');
  assert.match(await economicSeries('core_pce', '2026-11-06'), /Latest value known by 2026-11-06: 127\.90 \(for September 2026\)/, 'today reads FRED as it stands');
  configure({ fetch: route([[/fred\.stlouisfed\.org\/graph\/fredgraph\.csv/, () => new Response(now)]]) });
  await assert.rejects(economicSeries('core_pce', '2015-06-01'), (e: Error) => e instanceof NoData && /FRED's archive of past releases \(ALFRED\) does not hold PCEPILFE as it stood on 2015-06-01/.test(e.message) && /today's revised figures are not given for a past day/.test(e.message));
});

// ---------- filings-8: an email the SEC can be sent ----------

test('filings-8: an invisible mark pasted with the email is dropped; a letter no request can carry is refused in plain words', () => {
  assert.equal(checkEmail('person​@mail.com'), 'person@mail.com');
  assert.equal(checkEmail('﻿jane@mail.com⁠'), 'jane@mail.com');
  for (const bad of ['名前@mail.com', 'josé@mail.com', 'jane@mäil.de']) {
    assert.throws(() => checkEmail(bad), /cannot be sent to the SEC: it has "[^"]+", and the SEC can only be sent an address written with the letters a to z, digits and marks such as \. _ - \+/, bad);
  }
  const ua = userAgentFor('https://www.sec.gov/files/company_tickers.json', 'trading-agents', checkEmail('person​@mail.com'));
  assert.doesNotThrow(() => new Headers({ 'User-Agent': ua }));
});

// ---------- filings-9 and 10: a fund's size and its derivatives ----------

const NPORT = (o: { returns: string; lines: string; net?: string }) => `<?xml version="1.0" encoding="UTF-8"?><edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <formData><genInfo><regName>FUND TRUST</regName><seriesName>FUND ONE</seriesName><seriesId>S000000001</seriesId><repPdDate>2026-08-31</repPdDate></genInfo>
  <fundInfo><netAssets>${o.net ?? '1935680054.35'}</netAssets><returnInfo><monthlyTotReturns>${o.returns}</monthlyTotReturns></returnInfo></fundInfo>
  <invstOrSecs>${o.lines}</invstOrSecs></formData></edgarSubmission>`;
const HOLD = (name: string, pct: number, asset: string, deriv = '') => `<invstOrSec><name>${name}</name><title>${name}</title><balance>1</balance><curCd>USD</curCd><valUSD>1</valUSD><pctVal>${pct}</pctVal>
  <assetCat>${asset}</assetCat><issuerCat>OTHER</issuerCat><invCountry>US</invCountry><fairValLevel>2</fairValLevel>${deriv}</invstOrSec>`;
const RET = (cls: string) => `<monthlyTotReturn classId="${cls}" rtn1="0.1" rtn2="0.3" rtn3="0.2"/>`;

test("filings-9: a fund with several share classes gives its size for all of them, and says the ETF is one of them", () => {
  const r = parseReport(NPORT({ returns: ['C000170279', 'C000007063', 'C000046844'].map(RET).join(''), lines: HOLD('US TREASURY N/B', 100, 'DBT') }), 'C000046844');
  const t = renderReport('BND', '2026-11-06', { ...r, filed: '2026-10-28' });
  assert.match(t, /\nNet assets \(its size\): 1,935,680,054 USD on 2026-08-31, for the whole fund: all its 3 share classes together, of which BND is one; the report does not give BND's own part\n/);
  const one = renderReport('XLK', '2026-11-06', { ...parseReport(NPORT({ returns: RET('C000017601'), lines: HOLD('NVIDIA', 100, 'EC') }), 'C000017601'), filed: '2026-10-28' });
  assert.match(one, /\nNet assets \(its size\): 1,935,680,054 USD on 2026-08-31\n/);
});

const SWAP = (notional: string) => `<derivativeInfo><swapDeriv derivCat="SWP"><counterparties><counterpartyName>Bank</counterpartyName></counterparties>
  <descRefInstrmnt><indexBasketInfo><indexName>NASDAQ-100 Index</indexName><indexIdentifier>NDX</indexIdentifier></indexBasketInfo></descRefInstrmnt>
  <floatingRecDesc curCd="USD" fixedOrFloating="Floating" floatingRtIndex="FEDL01"/><terminationDt>2028-01-06</terminationDt><pmntCurCd>USD</pmntCurCd>
  <notionalAmt>${notional}</notionalAmt><curCd>USD</curCd><unrealizedAppr>1.0</unrealizedAppr></swapDeriv></derivativeInfo>`;
const FUTURE = (notional: string) => `<derivativeInfo><futrDeriv derivCat="FUT"><counterparties><counterpartyName>CME</counterpartyName></counterparties><payOffProf>Short</payOffProf>
  <descRefInstrmnt><indexBasketInfo><indexName>Nasdaq 100 E-Mini Index</indexName></indexBasketInfo></descRefInstrmnt><expDate>2026-09-18</expDate>
  <notionalAmt>${notional}</notionalAmt><curCd>USD</curCd><unrealizedAppr>1.0</unrealizedAppr></futrDeriv></derivativeInfo>`;

test('filings-10: a fund that gets its exposure from derivatives says how large their notional amounts are, not just their value', () => {
  // ProShares UltraPro Short QQQ (SQQQ) as it reported 31 Aug 2026, cut to a few lines: swaps and a future on the
  // Nasdaq-100 whose notional amounts add up to about three times the fund; Treasury bills and repurchase agreements.
  const lines = HOLD('N/A', -25.06, 'DE', SWAP('-3000000000')) + HOLD('N/A', 0.28, 'DE', SWAP('-2694000000')) + HOLD('N/A', 0.19, 'DE', FUTURE('-239645560'))
    + HOLD('U.S. Treasury Bills', 54.4, 'STIV') + HOLD('Repurchase Agreement', 9.5, 'RA') + HOLD('ProShares GENIUS Money Market ETF', 60.69, 'OTHER');
  const r = parseReport(NPORT({ returns: RET('C000074099'), lines }), 'C000074099');
  const t = renderReport('SQQQ', '2026-11-06', { ...r, filed: '2026-10-28' });
  assert.match(t, /\nHeld in: [^\n]*repurchase agreements 9\.50%/);
  assert.match(t, /\nDerivatives: 3 lines \(2 swaps, 1 future\), tied to: NASDAQ-100 Index, Nasdaq 100 E-Mini Index\. The shares above count a derivative only at its value \(its gain or loss so far\), not at the exposure it gives, which is its notional amount\. As the report gives them, their notional amounts add up to -5,933,645,560 USD \(-306\.54% of its net assets\); counted without their signs, 5,933,645,560 USD \(306\.54%\)\. Added up here from the report's figures; whether each is long or short is not worked out\.\n/);
  const plain = renderReport('XLK', '2026-11-06', { ...parseReport(NPORT({ returns: RET('C000017601'), lines: HOLD('NVIDIA', 100, 'EC') }), 'C000017601'), filed: '2026-10-28' });
  assert.doesNotMatch(plain, /Derivatives:/);
});
