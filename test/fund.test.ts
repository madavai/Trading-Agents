import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, NoData } from '../src/data/http.js';
import { clearSecCache } from '../src/data/sec.js';
import { latestReport, parseReport, renderReport } from '../src/data/nport.js';
import { fundProfile } from '../src/data/company.js';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const xml = (s: string) => new Response(s, { status: 200, headers: { 'content-type': 'text/xml' } });
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

// The SEC's answers as served on 2026-10-22, cut to a few lines each: the fields, nesting and figures are the real ones.
const LINE = (name: string, title: string, pct: number, asset: string, issuer: string, country: string, debt = '') => `
      <invstOrSec>
        <name>${name}</name>
        <lei>N/A</lei>
        <title>${title}</title>
        <cusip>000000000</cusip>
        <identifiers><isin value="US0000000000"/></identifiers>
        <balance>1.00000000</balance>
        <units>NS</units>
        <curCd>USD</curCd>
        <valUSD>1.00000000</valUSD>
        <pctVal>${pct}</pctVal>
        <payoffProfile>Long</payoffProfile>
        ${asset.startsWith('<') ? asset : `<assetCat>${asset}</assetCat>`}
        ${issuer.startsWith('<') ? issuer : `<issuerCat>${issuer}</issuerCat>`}
        <invCountry>${country}</invCountry>
        <isRestrictedSec>N</isRestrictedSec>
        <fairValLevel>1</fairValLevel>${debt}
      </invstOrSec>`;
const REPORT = (o: { series: string; reg: string; seriesId: string; asOf: string; net: string; lines: string; returns: string }) => `<?xml version="1.0" encoding="UTF-8"?><edgarSubmission xmlns="http://www.sec.gov/edgar/nport" xmlns:com="http://www.sec.gov/edgar/common" xmlns:ncom="http://www.sec.gov/edgar/nportcommon" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sec.gov/edgar/nport eis_NPORT_Filer.xsd">
  <headerData>
    <submissionType>NPORT-P</submissionType>
    <isConfidential>false</isConfidential>
    <filerInfo><filer><issuerCredentials><cik>0001064641</cik><ccc>XXXXXXXX</ccc></issuerCredentials></filer><seriesClassInfo><seriesId>${o.seriesId}</seriesId></seriesClassInfo></filerInfo>
  </headerData>
  <formData>
    <genInfo>
      <regName>${o.reg}</regName>
      <regFileNumber>811-08837</regFileNumber>
      <seriesName>${o.series}</seriesName>
      <seriesId>${o.seriesId}</seriesId>
      <repPdEnd>2026-09-30</repPdEnd>
      <repPdDate>${o.asOf}</repPdDate>
      <isFinalFiling>N</isFinalFiling>
    </genInfo>
    <fundInfo>
      <totAssets>124102423225.59</totAssets>
      <totLiabs>189848003.57</totLiabs>
      <netAssets>${o.net}</netAssets>
      <returnInfo><monthlyTotReturns>${o.returns}</monthlyTotReturns></returnInfo>
    </fundInfo>
    <invstOrSecs>${o.lines}
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

const XLK = REPORT({
  series: 'State Street(R) Technology Select Sector SPDR(R) ETF', reg: 'SELECT SECTOR SPDR TRUST', seriesId: 'S000006415', asOf: '2026-06-30', net: '123912575222.02',
  returns: '<monthlyTotReturn classId="C000017601" rtn1="19.92000000" rtn2="19.80000000" rtn3="-0.13000000"/>',
  lines: [
    LINE('NVIDIA Corp', 'NVIDIA Corp', 14.65033005212, 'EC', 'CORP', 'US'),
    LINE('Apple Inc', 'Apple Inc', 12.84756055497, 'EC', 'CORP', 'US'),
    LINE('Microsoft Corp', 'Microsoft Corp', 8.376601875041, 'EC', 'CORP', 'US'),
    LINE('State Street Global Advisors', 'State Street Navigator Securities Lending Portfolio II', 0.141371196334, 'STIV', 'RF', 'US'),
    LINE('Chicago Mercantile Exchange', 'XAK TECHNOLOGY SEP26', -0.00060720229, 'DE', '<issuerConditional desc="derivative" issuerCat="OTHER"/>', 'US'),
  ].join(''),
});
// Vanguard Total World Stock (VT): Alphabet's two classes are two lines; Taiwan Semiconductor is held in Taiwan.
const VT = REPORT({
  series: 'VANGUARD TOTAL WORLD STOCK INDEX FUND', reg: 'VANGUARD INTERNATIONAL EQUITY INDEX FUNDS', seriesId: 'S000022482', asOf: '2026-07-31', net: '97884325411.12',
  returns: '<monthlyTotReturn classId="C000065038" rtn1="4.62068052" rtn2="-0.34779590" rtn3="-0.62448225"/><monthlyTotReturn classId="C000065039" rtn1="4.61897507" rtn2="-0.34810740" rtn3="-0.62714509"/>',
  lines: [
    LINE('Apple Inc', 'APPLE INC', 3.867481321238, 'EC', 'CORP', 'US'),
    LINE('Alphabet Inc', 'ALPHABET INC-A', 1.827319077374, 'EC', 'CORP', 'US'),
    LINE('Taiwan Semiconductor Manufacturing Co Ltd', 'TSMC', 1.558598920682, 'EC', 'CORP', 'TW'),
    LINE('Alphabet Inc', 'ALPHABET INC-C', 1.438580190023, 'EC', 'CORP', 'US'),
  ].join(''),
});
// Vanguard Total Bond Market (BND): a Treasury note and a Freddie Mac pool, each with its maturity and rate.
const DEBT = (maturity: string, rate: string) => `
        <debtSec><maturityDt>${maturity}</maturityDt><couponKind>Fixed</couponKind><annualizedRt>${rate}</annualizedRt><isDefault>N</isDefault></debtSec>`;
const BND = REPORT({
  series: 'VANGUARD TOTAL BOND MARKET INDEX FUND', reg: 'VANGUARD BOND INDEX FUNDS', seriesId: 'S000002564', asOf: '2026-06-30', net: '397107296566.89', returns: '',
  lines: [
    LINE('United States Treasury Note/Bond', 'US TREASURY N/B', 0.350083896238, 'DBT', 'UST', 'US', DEBT('2032-05-15', '2.87500000')),
    LINE('United States Treasury Note/Bond', 'US TREASURY N/B', 0.25, 'DBT', 'UST', 'US', DEBT('2028-06-30', '4.00000000')),
    LINE('Freddie Mac Pool', 'FR QO0699', 0.4, 'ABS-MBS', 'USGSE', 'US', DEBT('2037-08-01', '3.00000000')),
  ].join(''),
});

// The fund list (company_tickers_mf.json), the company list, and XLK's reports listed for its series, as the SEC serves them.
const FUNDS = { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1064641, 'S000006415', 'C000017601', 'XLK'], [857489, 'S000022482', 'C000065038', 'VT']] };
const COMPANIES = { 0: { cik_str: 884394, ticker: 'SPY', title: 'SPDR S&P 500 ETF TRUST' }, 1: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' } };
const ENTRY = (acc: string, filed: string, type = 'NPORT-P') => `
    <entry>
      <category label="form type" scheme="https://www.sec.gov/" term="${type}" />
      <content type="text/xml">
        <accession-number>${acc}</accession-number>
        <act>40</act>
        <filing-date>${filed}</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1064641/${acc.replace(/-/g, '')}/${acc}-index.htm</filing-href>
        <filing-type>${type}</filing-type>
        <form-name>Monthly Portfolio Investments Report on Form N-PORT (Public)</form-name>
      </content>
      <title>${type}  - Monthly Portfolio Investments Report on Form N-PORT (Public)</title>
    </entry>`;
const FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <company-info><cik>0001064641</cik><conformed-name>SELECT SECTOR SPDR TRUST</conformed-name></company-info>${ENTRY('0001410368-26-089672', '2026-08-28')}${ENTRY('0001410368-26-071111', '2026-08-30', 'NPORT-P/A')}${ENTRY('0001410368-26-055331', '2026-05-28')}${ENTRY('0001410368-26-020063', '2026-02-26')}
  </feed>`;
const SPY_RECORD = { name: 'SPDR S&P 500 ETF TRUST', sic: '', filings: { recent: {
  accessionNumber: ['0001410368-26-089410', '0001410368-26-080000', '0001410368-26-055357'], filingDate: ['2026-08-28', '2026-08-01', '2026-05-28'],
  reportDate: ['2026-06-30', '', '2026-03-31'], form: ['NPORT-P', '497K', 'NPORT-P'], primaryDocument: ['xslFormNPORT-P_X01/primary_doc.xml', 'x.htm', 'xslFormNPORT-P_X01/primary_doc.xml'],
} } };
const NVDA_RECORD = { name: 'NVIDIA CORP', sic: '3674', filings: { recent: { accessionNumber: ['0001045810-26-000101'], filingDate: ['2026-08-27'], reportDate: ['2026-07-27'], form: ['10-Q'], primaryDocument: ['nvda.htm'] } } };

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-21'; clearSecCache(); });

const sec = (seen: string[] = [], report = XLK) => configure({ fetch: route([
  [/company_tickers_mf\.json/, () => json(FUNDS)],
  [/company_tickers\.json/, () => json(COMPANIES)],
  [/browse-edgar\?action=getcompany&CIK=S000006415&type=NPORT-P/, () => xml(FEED)],
  [/submissions\/CIK0000884394\.json/, () => json(SPY_RECORD)],
  [/submissions\/CIK0001045810\.json/, () => json(NVDA_RECORD)],
  [/Archives\/edgar\/data\/\d+\/\d{18}\/primary_doc\.xml/, (u) => xml(u.includes('055331') ? report.replace('<repPdDate>2026-06-30', '<repPdDate>2026-03-31') : report)],
], seen) });

test('a portfolio report is read as filed: the fund, the day it speaks for, its size, every line and its own returns', () => {
  const r = parseReport(XLK, 'C000017601');
  assert.deepEqual([r.series, r.registrant, r.asOf, r.netAssets, r.holdings.length], ['State Street Technology Select Sector SPDR ETF', 'SELECT SECTOR SPDR TRUST', '2026-06-30', 123912575222.02, 5]);
  assert.deepEqual(r.holdings[4], { name: 'Chicago Mercantile Exchange', pct: -0.00060720229, asset: 'DE', issuer: 'OTHER', country: 'US', maturity: null, coupon: null }, 'a derivative names its issuer kind in an attribute');
  assert.deepEqual(r.returns, [19.92, 19.8, -0.13]);
  assert.deepEqual(parseReport(VT, 'C000065039').returns, [4.61897507, -0.3481074, -0.62714509], 'the share class asked for');
  assert.equal(parseReport(VT, 'C000999999').returns, null, 'several classes and none of them this one: no returns, not another class\'s');
  assert.throws(() => parseReport('<html>busy</html>', null), /not a fund's portfolio report/);
});

test('the report in words: size, what it holds, issuers added up, countries, its own returns, and the cost named unavailable', () => {
  const t = renderReport('XLK', '2026-10-21', { ...parseReport(XLK, 'C000017601'), filed: '2026-08-28' });
  assert.match(t, /^Fund profile for XLK, from its portfolio report to the SEC \(form N-PORT, filed 2026-08-28\): what it held on 2026-06-30, 113 days before 2026-10-21\./);
  assert.match(t, /\nName: State Street Technology Select Sector SPDR ETF\nFiled by: SELECT SECTOR SPDR TRUST\nNet assets \(its size\): 123,912,575,222 USD on 2026-06-30\nHoldings: 5 lines\n/);
  assert.match(t, /\nHeld in: stocks 35\.87%, cash and money-market funds 0\.14%\n/, 'a futures contract worth nothing to two decimal places is left out');
  assert.match(t, /\nIssued by: companies 35\.87%, other funds 0\.14%\n/);
  assert.match(t, /\nCountries: United States 36\.02% \(outside the US together: 0\.00%\)\n/);
  assert.match(t, /\nIts own total return by month, as it reported it: April 2026 \+19\.92%, May 2026 \+19\.80%, June 2026 -0\.13%\n/);
  assert.match(t, /\nYearly cost \(expense ratio\): unavailable/);
  assert.match(t, /\nTop 4 holdings, by issuer \(36\.02% of the fund together;[^\n]*\):\n- NVIDIA Corp: 14\.65%\n- Apple Inc: 12\.85%\n- Microsoft Corp: 8\.38%\n- State Street Global Advisors: 0\.14%$/);
  const vt = renderReport('VT', '2026-10-21', { ...parseReport(VT, 'C000065038'), filed: '2026-09-28' });
  assert.match(vt, /\n- Alphabet Inc \(2 lines\): 3\.27%\n/, 'two classes of one company are one issuer');
  assert.match(vt, /\nCountries: United States 7\.13%, Taiwan 1\.56% \(outside the US together: 1\.56%\)\n/);
  assert.match(vt, /May 2026 \+4\.62%, June 2026 -0\.35%, July 2026 -0\.62%/);
  const bnd = renderReport('BND', '2026-10-21', { ...parseReport(BND, null), filed: '2026-08-28' });
  assert.match(bnd, /\nHeld in: bonds and other debt 0\.60%, mortgage-backed bonds 0\.40%\n/);
  assert.match(bnd, /\nIssued by: the US Treasury 0\.60%, US government-sponsored enterprises \(such as Fannie Mae\) 0\.40%\n/);
  // (0.35 × 5.88 + 0.25 × 2.00 + 0.4 × 11.09) ÷ 1.00 = 6.99 years; (0.35 × 2.875 + 0.25 × 4 + 0.4 × 3) ÷ 1.00 = 3.21%
  assert.match(bnd, /\nBonds \(1\.00% of the fund\): on average 7\.0 years to repayment and 3\.21% yearly interest, weighted by value/);
  assert.match(bnd, /\nIts own monthly returns: not in this report\n/);
  assert.match(bnd, /\n- United States Treasury Note\/Bond \(2 lines\): 0\.60%\n- Freddie Mac Pool: 0\.40%$/);
});

test('a fund\'s latest report public by the analysis day: never a later one, so a past day reads what was known then', async () => {
  const seen: string[] = [];
  sec(seen);
  const now = await latestReport('xlk', '2026-10-21');
  assert.equal(now?.filed, '2026-08-28');
  assert.ok(seen.some((u) => u.endsWith('/Archives/edgar/data/1064641/000141036826089672/primary_doc.xml')), 'the registrant\'s folder and the report\'s own number');
  assert.ok(!seen.some((u) => u.includes('071111')), 'an amendment is not read: its period cannot be told from the list');
  seen.length = 0;
  assert.equal((await latestReport('XLK', '2026-08-27'))?.filed, '2026-05-28', 'the day before the August report: May\'s');
  assert.ok(seen.some((u) => u.includes('000141036826055331')));
  await assert.rejects(latestReport('XLK', '2026-01-15'), (e: Error) => e instanceof NoData && /first portfolio report to the SEC \(form N-PORT\) was filed on 2026-02-26, after 2026-01-15/.test(e.message));
});

test('an ETF set up as a trust (SPY) reports under its own number; a company files none, so it is not read as a fund', async () => {
  const seen: string[] = [];
  sec(seen);
  assert.equal((await latestReport('SPY', '2026-10-21'))?.filed, '2026-08-28');
  assert.ok(seen.some((u) => u.endsWith('/Archives/edgar/data/884394/000141036826089410/primary_doc.xml')));
  assert.equal(await latestReport('NVDA', '2026-10-21'), null);
  assert.equal(await latestReport('7203.T', '2026-10-21'), null, 'not a US filer');
});

test('the fund tool reads the SEC first, for today and for a past day alike', async () => {
  sec();
  const t = await fundProfile('XLK', '2026-10-21');
  assert.match(t, /^Fund profile for XLK, from its portfolio report to the SEC/);
  assert.doesNotMatch(t, /Yahoo/);
  const past = await fundProfile('XLK', '2026-07-01');
  assert.match(past, /form N-PORT, filed 2026-05-28/);
  assert.doesNotMatch(past, /withheld/);
});
