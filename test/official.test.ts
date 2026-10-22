import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, NoData } from '../src/data/http.js';
import { averageDilutedShares, clearSecCache, sectorOfSic, sharesOutstanding, trailingYear, type Fact } from '../src/data/sec.js';
import { clearYahooSession, companyOverview, insiderTransactions, profileSector } from '../src/data/company.js';
import { parseForm4 } from '../src/data/insiders.js';
import { chartJson, series } from './chart.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

// A Form 4 in the shape the SEC files them (the fields and nesting of NVIDIA's of 9 Oct 2026; people and figures made up).
const FORM4 = (owner: string, rows: string, plan = '1') => `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0609</schemaVersion><documentType>4</documentType><periodOfReport>2026-10-07</periodOfReport>
  <issuer><issuerCik>0000001234</issuerCik><issuerName>ACME CORP</issuerName><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0000009999</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>EVP &amp; Chief Financial Officer</officerTitle><isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther></reportingOwnerRelationship>
  </reportingOwner>
  <aff10b5One>${plan}</aff10b5One>
  <nonDerivativeTable>${rows}
    <nonDerivativeHolding><securityTitle><value>Common</value></securityTitle><postTransactionAmounts><sharesOwnedFollowingTransaction><value>57378</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeHolding>
  </nonDerivativeTable>
  <derivativeTable></derivativeTable>
</ownershipDocument>`;
const ROW = (date: string, code: string, shares: number, price: number | null, ad: 'A' | 'D', after: number, how: 'D' | 'I' = 'D') => `
    <nonDerivativeTransaction>
      <securityTitle><value>Common</value></securityTitle>
      <transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved><footnoteId id="F1"/></transactionCoding>
      <transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare>${price === null ? '<footnoteId id="F2"/>' : `<value>${price}</value>`}</transactionPricePerShare><transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>${how}</value></directOrIndirectOwnership>${how === 'I' ? '<natureOfOwnership><value>By Trust</value></natureOfOwnership>' : ''}</ownershipNature>
    </nonDerivativeTransaction>`;

/** A filer's SEC record with these filings, newest first, as the submissions file lists them. */
const record = (filings: Array<{ form: string; filed: string; acc: string; doc: string }>, extra: Record<string, unknown> = {}) => ({
  name: 'ACME CORP', sic: '3674', sicDescription: 'Semiconductors & Related Devices', fiscalYearEnd: '0131', ...extra,
  filings: { recent: { accessionNumber: filings.map((f) => f.acc), filingDate: filings.map((f) => f.filed), reportDate: filings.map((f) => f.filed), form: filings.map((f) => f.form), primaryDocument: filings.map((f) => f.doc) } },
});
const TICKERS: [RegExp, (url: string) => Response] = [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME' } })];

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-21'; clearSecCache(); clearYahooSession(); configure({ secEmail: '' }); });

test('a Form 4 read from the filing itself: who, their role, each trade, the price, what is held after and how, and a pre-arranged plan', () => {
  const t = parseForm4(FORM4('KRESS COLETTE', ROW('2026-09-17', 'S', 20369, 219.0172, 'D', 774971) + ROW('2026-10-07', 'G', 500000, null, 'D', 23671360, 'I')), '2026-10-09');
  assert.deepEqual(t[0], { owner: 'KRESS COLETTE', role: 'EVP & Chief Financial Officer', filed: '2026-10-09', plan: true, date: '2026-09-17', code: 'S', shares: 20369, price: 219.0172, acquired: false, after: 774971, indirect: null });
  assert.deepEqual([t[1]!.code, t[1]!.price, t[1]!.indirect], ['G', null, 'By Trust'], 'a gift has no price; held by a trust is held indirectly');
  assert.equal(t.length, 2, 'a holding with no trade is not a trade');
  assert.equal(parseForm4(FORM4('X', ROW('2026-09-17', 'P', 10, 5, 'A', 10), '0'), '2026-09-18')[0]!.plan, false);
});

test("a US filer's insider trades come from its Form 4s at the SEC, only those made public by the analysis date, past days included", async () => {
  const filings = [
    { form: '4', filed: '2026-10-22', acc: '0000009999-26-000003', doc: 'xslF345X06/late.xml' },    // after the analysis date
    { form: '4', filed: '2026-10-09', acc: '0000009999-26-000002', doc: 'xslF345X06/gift.xml' },
    { form: '8-K', filed: '2026-09-30', acc: '0001234-26-000050', doc: 'a8k.htm' },
    { form: '4', filed: '2026-09-18', acc: '0000009999-26-000001', doc: 'xslF345X06/sale.xml' },
    { form: '4', filed: '2026-05-01', acc: '0000009999-26-000000', doc: 'xslF345X06/old.xml' },      // before the 90 days
  ];
  const seen: string[] = [];
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record(filings))],
    [/Archives\/edgar\/data\/1234\/000000999926000002\/gift\.xml$/, () => new Response(FORM4('COXE TENCH', ROW('2026-10-07', 'G', 500000, null, 'D', 23671360, 'I')))],
    [/Archives\/edgar\/data\/1234\/000000999926000001\/sale\.xml$/, () => new Response(FORM4('KRESS COLETTE', ROW('2026-09-17', 'S', 20369, 219.0172, 'D', 774971) + ROW('2026-09-17', 'P', 100, 200, 'A', 774071), '0'))],
  ], seen) });
  const t = await insiderTransactions('ACME', '2026-10-21');
  assert.match(t, /^Insider trades in ACME, from the Form 4 filings with the SEC made public from 2026-07-24 to 2026-10-21 \(2 of 2 filings read, newest first\)/);
  assert.match(t, /bought \(code P\) 1 \(100 shares, about 20,000 USD at their own prices\); sold \(code S\) 1 \(20,369 shares, about 4,461,161 USD at their own prices\); other kinds .* 1\./);
  assert.match(t, /- 2026-10-07 \(made public 2026-10-09\) · COXE TENCH \(EVP & Chief Financial Officer\): gave away 500,000 shares, no price · holds 23,671,360 after · indirectly \(By Trust\) · under a 10b5-1 plan/);
  assert.match(t, /- 2026-09-17 \(made public 2026-09-18\) · KRESS COLETTE \(EVP & Chief Financial Officer\): sold 20,369 shares at 219\.0172 · holds 774,971 after$/m);
  assert.ok(!seen.some((u) => /late\.xml|old\.xml|a8k/.test(u)), 'a filing made public after the day, one from before the window and an 8-K are never read');
  assert.ok(seen.some((u) => /\/gift\.xml$/.test(u)), 'the filing itself, not its formatted page');
  const past = await insiderTransactions('ACME', '2026-09-20');
  assert.match(past, /made public from 2026-06-23 to 2026-09-20 \(1 of 1 filings read/, 'a past day reads what was public then');
  assert.doesNotMatch(past, /COXE/);
  assert.match(await insiderTransactions('ACME', '2026-01-10'), /: none\. No director, officer or large owner reported a trade in these 90 days\. That is a fact from the SEC/);
});

test('when the SEC\'s list of recent filings does not reach back far enough, "none" is never said', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ form: '8-K', filed: `2026-10-${String(20 - (i % 10)).padStart(2, '0')}`, acc: `0001234-26-${i}`, doc: 'x.htm' }));
  configure({ fetch: route([TICKERS, [/submissions/, () => json(record(many))]]) });
  await assert.rejects(insiderTransactions('ACME', '2026-10-21'), (e: Error) => e instanceof NoData && /recent list of ACME's filings starts on 2026-10-11, after 2026-07-24/.test(e.message));
});

test('the last twelve months from filings that never give them: the full year, plus the year to date, less the same span a year before', () => {
  const f = (start: string, end: string, val: number, filed: string, form = '10-Q'): Fact => ({ start, end, val, filed, form });
  const eps = [
    f('2025-01-27', '2026-01-25', 4.9, '2026-02-25', '10-K'), f('2024-01-29', '2025-01-26', 2.94, '2025-02-26', '10-K'),
    f('2025-01-27', '2025-04-27', 0.76, '2025-05-28'), f('2025-01-27', '2025-07-27', 1.84, '2025-08-27'),
    f('2026-01-26', '2026-04-26', 2.39, '2026-05-20'), f('2026-01-26', '2026-07-26', 4.85, '2026-08-26'), f('2026-04-27', '2026-07-26', 2.46, '2026-08-26'),
  ];
  assert.deepEqual(trailingYear(eps, '2026-10-21'), { value: 7.91, parts: 'the full year to 2026-01-25, 4.9, plus 2026-01-26 to 2026-07-26, 4.85, less 2025-01-27 to 2025-07-27, 1.84' }, 'the six months to date, never the quarter alone');
  assert.equal(trailingYear(eps, '2026-06-01')!.value, 6.53, 'as filed by then: the first quarter only (4.9 + 2.39 - 0.76)');
  assert.deepEqual(trailingYear(eps, '2026-03-01'), { value: 4.9, parts: 'the full year to 2026-01-25, 4.9' }, 'just after a full year: that year');
  assert.match(trailingYear(eps.filter((x) => x.end !== '2025-07-27'), '2026-10-21')!.parts, /the same span a year before 2026-07-26 was not filed/);
  assert.equal(trailingYear(eps, '2025-02-01'), null, 'no full year filed by then');
  const restated = [...eps, f('2025-01-27', '2026-01-25', 5.0, '2026-09-01', '10-K/A')];
  assert.equal(trailingYear(restated, '2026-10-21')!.value, 8.01, 'a restatement counts from the day it was filed');
  assert.equal(trailingYear(restated, '2026-08-30')!.value, 7.91);
});

test('shares outstanding from the latest cover page, every class added; the sector from the SEC industry code', () => {
  const s = (end: string, val: number, filed: string, accn: string): Fact => ({ end, val, filed, accn });
  const multi = [s('2026-04-20', 5.8e9, '2026-04-25', 'q1'), s('2026-07-20', 5.79e9, '2026-07-25', 'q2'), s('2026-07-20', 0.86e9, '2026-07-25', 'q2'), s('2026-07-20', 5.47e9, '2026-07-25', 'q2')];
  assert.deepEqual(sharesOutstanding(multi, '2026-10-21'), { shares: 12.12e9, end: '2026-07-20', filed: '2026-07-25' }, 'classes A, B and C on one cover page');
  assert.deepEqual(sharesOutstanding(multi, '2026-05-01'), { shares: 5.8e9, end: '2026-04-20', filed: '2026-04-25' });
  assert.equal(sharesOutstanding(multi, '2026-01-01'), null);
  const cases: Record<string, string | null> = {
    3674: 'Technology', 7372: 'Technology', 3571: 'Technology', 2834: 'Healthcare', 3841: 'Healthcare', 8062: 'Healthcare',
    6021: 'Financial Services', 6311: 'Financial Services', 6798: 'Real Estate', 1311: 'Energy', 2911: 'Energy', 4911: 'Utilities',
    4813: 'Communication Services', 7812: 'Communication Services', 2080: 'Consumer Defensive', 5331: 'Consumer Defensive', 5411: 'Consumer Defensive',
    3711: 'Consumer Cyclical', 5961: 'Consumer Cyclical', 5812: 'Consumer Cyclical', 3721: 'Industrials', 4512: 'Industrials', 4953: 'Industrials',
    2800: 'Basic Materials', 1040: 'Basic Materials', 9995: null, 0: null,
  };
  for (const [sic, sector] of Object.entries(cases)) assert.equal(sectorOfSic(sic), sector, `SIC ${sic}`);
  assert.equal(sectorOfSic(undefined), null);
});

const FACTS = { facts: {
  dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2026-08-21', val: 24.1e9, filed: '2026-08-26', accn: 'q2' }] } } },
  'us-gaap': {
    EarningsPerShareDiluted: { units: { 'USD/shares': [
      { start: '2025-01-27', end: '2026-01-25', val: 4.9, filed: '2026-02-25', form: '10-K' },
      { start: '2025-01-27', end: '2025-07-27', val: 1.84, filed: '2025-08-27', form: '10-Q' },
      { start: '2026-01-26', end: '2026-07-26', val: 4.85, filed: '2026-08-26', form: '10-Q' },
    ] } },
    StockholdersEquity: { units: { USD: [{ end: '2026-07-26', val: 228.984e9, filed: '2026-08-26', form: '10-Q' }] } },
  },
} };

test("a US filer's profile and valuation from its SEC filings and the checked close, every multiple derived and shown with its parts", async () => {
  const closes = series('2026-10-20', 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: 216.47 } : r));
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record([]))],
    [/companyfacts\/CIK0000001234\.json/, () => json(FACTS)],
    [/v8\/finance\/chart\/ACME/, () => json(chartJson('ACME', closes))],
  ]) });
  const t = await companyOverview('ACME', '2026-10-21');
  assert.match(t, /^Company profile and valuation for ACME, from its SEC filings as they stood on 2026-10-21 and the desk's checked closing price/);
  assert.match(t, /Name: ACME CORP\nIndustry \(the SEC's code 3674\): Semiconductors & Related Devices\nSector \(worked out from that code, so approximate\): Technology\nFiscal year ends: 31 January/);
  assert.match(t, /Close: 216\.47 USD on 2026-10-20/);
  assert.match(t, /Shares outstanding: 24,100,000,000 \(counted on 2026-08-21, filed 2026-08-26\)\nMarket value \(derived: shares × close\): 5,216,927,000,000 USD/);
  assert.match(t, /Diluted EPS, last twelve months \(derived from the full year to 2026-01-25, 4\.9, plus 2026-01-26 to 2026-07-26, 4\.85, less 2025-01-27 to 2025-07-27, 1\.84\): 7\.91 USD\nPrice to earnings \(derived: close ÷ that\): 27\.37/);
  assert.match(t, /Book value per share \(derived: equity ÷ shares\): 9\.50 USD\nPrice to book \(derived: close ÷ that\): 22\.78/);
  assert.match(t, /Dividends per share: not among its filed figures/);
  assert.match(t, /Unavailable from official free sources: forward estimates/);
  const past = await companyOverview('ACME', '2026-08-01');
  assert.doesNotMatch(past, /withheld/, 'a past day has its own valuation, from what was filed by then');
  assert.match(past, /Shares outstanding: unavailable/, 'the cover page of 21 August was not filed by 1 August');
  assert.match(past, /Diluted EPS, last twelve months \(derived from the full year to 2026-01-25, 4\.9\): 4\.90 USD/);
});

// Meta's own figures as the SEC served them on 2026-10-22: no cover-page count (classes A and B), the quarters' diluted shares.
const DILUTED = [
  { start: '2026-04-01', end: '2026-06-30', val: 2566000000, filed: '2026-07-30', form: '10-Q' },
  { start: '2026-01-01', end: '2026-09-30', val: 2568000000, filed: '2026-10-22', form: '10-Q' },
  { start: '2026-07-01', end: '2026-09-30', val: 2573000000, filed: '2026-10-22', form: '10-Q' },
];

test('a company with two classes of shares is valued on the average diluted shares from its accounts, and says so', async () => {
  assert.deepEqual(averageDilutedShares(DILUTED, '2026-10-21'), { shares: 2566e6, start: '2026-04-01', end: '2026-06-30', filed: '2026-07-30' });
  assert.equal(averageDilutedShares(DILUTED, '2026-10-22')?.shares, 2573e6, 'the latest quarter, not the nine months that end with it');
  assert.equal(averageDilutedShares(DILUTED, '2026-07-01'), null);
  const closes = series('2026-10-20', 300).map((r, i, all) => (i === all.length - 1 ? { ...r, c: 216.47 } : r));
  const facts = { facts: { 'us-gaap': { ...FACTS.facts['us-gaap'], WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: DILUTED } } } } };
  configure({ fetch: route([TICKERS,
    [/submissions\/CIK0000001234\.json/, () => json(record([]))],
    [/companyfacts\/CIK0000001234\.json/, () => json(facts)],
    [/v8\/finance\/chart\/ACME/, () => json(chartJson('ACME', closes))],
  ]) });
  const t = await companyOverview('ACME', '2026-10-21');
  assert.match(t, /Shares outstanding: no single count on a cover page filed by then .* In its place, the weighted average diluted shares from its accounts for 2026-04-01 to 2026-06-30: 2,566,000,000 \(filed 2026-07-30\), so the figures worked out from it are close, not exact\nMarket value \(derived: average diluted shares × close\): 555,462,020,000 USD/);
  assert.match(t, /Book value per share \(derived: equity ÷ average diluted shares\): 89\.24 USD/);
});

test('the sector limit learns a sector and a fund from the SEC; a company that does not file with it stays unknown', async () => {
  configure({ fetch: route([
    [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME' }, 1: { cik_str: 5678, ticker: 'BANK' } })],
    [/company_tickers_mf\.json/, () => json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1064641, 'S000006415', 'C000017601', 'XLK'], [1067839, 'S000101292', 'C000271435', 'QQQ']] })],
    [/submissions\/CIK0000001234\.json/, () => json(record([]))],
    [/submissions\/CIK0000005678\.json/, () => json(record([], { sic: '6021', sicDescription: 'National Commercial Banks' }))],
  ]) });
  assert.deepEqual(await profileSector('ACME'), { sector: 'Technology', fund: false });
  assert.deepEqual(await profileSector('BANK'), { sector: 'Financial Services', fund: false });
  assert.deepEqual(await profileSector('QQQ'), { sector: null, fund: true });
  assert.deepEqual(await profileSector('ASML.AS'), { sector: null, fund: false });
});
