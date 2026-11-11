import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configure } from '../src/data/http.js';
import { clearSecCache } from '../src/data/sec.js';
import { clearYahooSession, companyOverview } from '../src/data/company.js';
import { firstSession, releasesIn } from '../src/data/results.js';
import { clearCache } from '../src/data/yahoo.js';
import { chartJson, series, type Row } from './chart.js';

// A company's results dates, from its own filings with the SEC (form 8-K, item 2.02). The runs of 9 and 10 Nov 2026 had no
// such source: agents dated NVIDIA's results by a prediction market's closing date (2026-11-18; NVIDIA reports on the 17th)
// and Meta's next ones "near 2027-01-22" from the spacing of its filings, and priced Meta's four results days, its biggest
// moves of the year, as a 1-in-252 chance. The filings below are NVIDIA's, Meta's and Berkshire Hathaway's as the SEC
// lists them (read on 11 Nov 2026); the prices are made up.

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

type F = { form: string; filed: string; dated?: string; at: string; items?: string };
/** A list of filings in the SEC's shape (one column per field, newest first). */
const columns = (fs: F[]) => ({
  accessionNumber: fs.map((f) => `${f.form}|${f.at}`), filingDate: fs.map((f) => f.filed), reportDate: fs.map((f) => f.dated ?? f.filed),
  acceptanceDateTime: fs.map((f) => f.at), form: fs.map((f) => f.form), items: fs.map((f) => f.items ?? ''), primaryDocument: fs.map(() => 'x.htm'),
});
const record = (fs: F[], extra: Record<string, unknown> = {}) => ({ name: 'ACME CORP', sic: '3674', fiscalYearEnd: '0125', filings: { recent: columns(fs), ...extra } });
const TICKERS: [RegExp, (url: string) => Response] = [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME' } })];
const NO_FUNDS: [RegExp, (url: string) => Response] = [/company_tickers_mf\.json/, () => json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] })];
const FACTS: [RegExp, (url: string) => Response] = [/companyfacts\/CIK0000001234\.json/, () => json({ facts: { 'us-gaap': {} } })];

/** Weekday prices to `last`, with the closes given set on their days. */
function prices(last: string, set: Record<string, number>): Row[] {
  return series(last, 300).map((r) => (set[r.date] !== undefined ? { ...r, c: set[r.date]! } : r));
}
function desk(filings: unknown, rows: Row[], more: Array<[RegExp, (url: string) => Response]> = [], seen: string[] = [], meta: Record<string, unknown> = {}) {
  configure({ fetch: route([TICKERS, NO_FUNDS, FACTS, ...more,
    [/submissions\/CIK0000001234\.json/, () => json(filings)],
    [/v8\/finance\/chart\/ACME/, () => json(chartJson('ACME', rows, meta))],
  ], seen) });
}
/** The results section of an overview: from its first line to the end. */
const section = (t: string) => t.slice(t.indexOf('\nResults releases') + 1);

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-11-11'; clearSecCache(); clearYahooSession(); clearCache(); configure({ secEmail: '' }); });

// NVIDIA's filings around the run of 9 Nov 2026: four results releases in the year, each after the close.
const NVDA: F[] = [
  { form: '8-K', filed: '2026-09-03', dated: '2026-09-02', at: '2026-09-03T12:03:56.000Z', items: '8.01' },
  { form: '10-Q', filed: '2026-08-26', dated: '2026-07-26', at: '2026-08-26T20:36:00.000Z' },
  { form: '8-K', filed: '2026-08-26', at: '2026-08-26T20:21:19.000Z', items: '2.02,9.01' },
  { form: '8-K', filed: '2026-05-20', at: '2026-05-20T20:21:19.000Z', items: '2.02,9.01' },
  { form: '8-K/A', filed: '2026-03-02', at: '2026-03-02T21:00:00.000Z', items: '2.02' },   // made up: an amendment is never a release
  { form: '8-K', filed: '2026-02-25', at: '2026-02-25T21:31:25.000Z', items: '2.02,9.01' },
  { form: '8-K', filed: '2025-11-19', at: '2025-11-19T21:20:44.000Z', items: '2.02,9.01' },
  { form: '8-K', filed: '2025-08-27', at: '2025-08-27T20:22:14.000Z', items: '2.02,9.01' },  // more than a year before
];

test("NVIDIA's results releases of the year, each with the session that first traded it and how it closed; the next date is not known", async () => {
  desk(record(NVDA), prices('2026-11-09', { '2025-11-19': 186.07, '2025-11-20': 180.21, '2026-02-25': 195.1, '2026-02-26': 184.46, '2026-05-20': 222.96, '2026-05-21': 219.01, '2026-08-26': 209.43, '2026-08-27': 227.73 }));
  const s = section(await companyOverview('ACME', '2026-11-09'));
  assert.match(s, /^Results releases filed from 2025-11-10 to 2026-11-09, oldest first: each is a form 8-K with item 2\.02 \("Results of Operations and Financial Condition"\)/);
  assert.match(s, /\n- 2025-11-19, accepted at 16:20 New York time, after the close: first traded 2025-11-20, which closed 3\.15% lower \(186\.07 on 2025-11-19 to 180\.21 on 2025-11-20\)\n- 2026-02-25, accepted at 16:31 New York time, after the close: first traded 2026-02-26, which closed 5\.45% lower \(195\.10 on 2026-02-25 to 184\.46 on 2026-02-26\)\n- 2026-05-20, accepted at 16:21 New York time, after the close: first traded 2026-05-21, which closed 1\.77% lower \(222\.96 on 2026-05-20 to 219\.01 on 2026-05-21\)\n- 2026-08-26, accepted at 16:21 New York time, after the close: first traded 2026-08-27, which closed 8\.74% higher \(209\.43 on 2026-08-26 to 227\.73 on 2026-08-27\)\nNext results date: not known\./);
  assert.match(s, /Next results date: not known\. The desk reads no date for it: a company announces when it will report in a press release, which it does not file with the SEC, and the desk has no other source for it\. Do not work one out from the spacing of the dates above or its other filings, and do not take one from a prediction market's closing date \(when the market stops trading\) or from a news article\.$/);
  assert.doesNotMatch(s, /2025-08-27|2026-03-02|2026-09-03|2026-11-1[78]/, 'a release before the year, an amendment and an 8-K of another item are left out, and no next date is given');
});

test("Meta's results days stand out as the scheduled moves they are; a filing that also reports an earlier event does not date the release; the day's own release trades after it", async () => {
  const META: F[] = [
    { form: '8-K', filed: '2026-10-29', dated: '2026-10-26', at: '2026-10-29T21:08:00.000Z', items: '1.01,3.03,5.03,9.01' },
    { form: '10-Q', filed: '2026-10-22', dated: '2026-09-30', at: '2026-10-22T00:00:08.000Z' },
    { form: '8-K', filed: '2026-10-21', dated: '2026-10-19', at: '2026-10-21T20:03:35.000Z', items: '1.01,2.02,8.01,9.01' },
    { form: '8-K', filed: '2026-07-29', at: '2026-07-29T20:03:23.000Z', items: '2.02,9.01' },
    { form: '8-K', filed: '2026-04-29', at: '2026-04-29T20:05:41.000Z', items: '2.02,9.01' },
    { form: '10-K', filed: '2026-01-29', dated: '2025-12-31', at: '2026-01-29T00:13:46.000Z' },
    { form: '8-K', filed: '2026-01-28', at: '2026-01-28T21:04:20.000Z', items: '2.02,9.01' },
    { form: '8-K', filed: '2025-10-29', at: '2025-10-29T20:08:34.000Z', items: '2.02,9.01' },
  ];
  desk(record(META), prices('2026-11-10', { '2026-01-28': 667.01, '2026-01-29': 736.41, '2026-04-29': 667.97, '2026-04-30': 610.86, '2026-07-29': 585.15, '2026-07-30': 538.6, '2026-10-21': 697.52, '2026-10-22': 648.85 }));
  const s = section(await companyOverview('ACME', '2026-11-10'));
  assert.match(s, /\n- 2026-01-28, accepted at 16:04 New York time, after the close: first traded 2026-01-29, which closed 10\.40% higher \(667\.01 on 2026-01-28 to 736\.41 on 2026-01-29\)\n- 2026-04-29, accepted at 16:05 New York time, after the close: first traded 2026-04-30, which closed 8\.55% lower/);
  // 538.60 / 585.15 - 1 = -7.955%: worked out from the closes as shown, so a sum on them agrees.
  assert.match(s, /\n- 2026-07-29, accepted at 16:03 New York time, after the close: first traded 2026-07-30, which closed 7\.96% lower \(585\.15 on 2026-07-29 to 538\.60 on 2026-07-30\)/);
  assert.match(s, /\n- 2026-10-21, accepted at 16:03 New York time, after the close: first traded 2026-10-22, which closed 6\.98% lower \(697\.52 on 2026-10-21 to 648\.85 on 2026-10-22\)\. Its filing also reports another event, dated 2026-10-19, so it does not date the release itself: this is the first session after the filing, and the release may have come out before it\n/);
  assert.doesNotMatch(s, /2025-10-29|2027-01-22|2026-01-29, accepted/, 'not the year before, never a cadence date, and a yearly report is not a results release');

  // An analysis of the day of a release made after the close: it is known that evening, and trades the next session.
  clearSecCache(); clearCache();
  desk(record(META.slice(6)), prices('2026-11-10', {}));
  const day = section(await companyOverview('ACME', '2026-01-28'));
  assert.match(day, /\n- 2026-01-28, accepted at 16:04 New York time, after the close: first session 2026-01-29, after the analysis date\n/);
  assert.match(day, /^Results releases filed from 2025-01-29 to 2026-01-28/);
});

test('a company that publishes its results on a Saturday and files them later is dated by its filing\'s own date of the release', async () => {
  // Berkshire Hathaway's: the release dated a Saturday, filed on the Monday or days later.
  const BRK: F[] = [
    { form: '8-K', filed: '2026-11-09', dated: '2026-11-07', at: '2026-11-09T11:10:14.000Z', items: '2.02,9.01' },
    { form: '8-K', filed: '2026-08-11', dated: '2026-08-08', at: '2026-08-11T19:52:27.000Z', items: '2.02,9.01' },
    { form: '8-K', filed: '2026-06-05', dated: '2026-06-03', at: '2026-06-05T20:00:00.000Z', items: '2.02' },   // made up: dated a market day, filed later
  ];
  desk(record(BRK), prices('2026-11-10', { '2026-08-07': 521.8, '2026-08-10': 529.42, '2026-11-06': 570.89, '2026-11-09': 575.25 }));
  const s = section(await companyOverview('ACME', '2026-11-10'));
  assert.match(s, /\n- 2026-06-05, accepted at 16:00 New York time, after the close; the filing dates the release 2026-06-03, a market day, without its time: first traded 2026-06-03 or the session after, so how it closed is not worked out\n/);
  assert.match(s, /\n- 2026-08-11, accepted at 15:52 New York time, during the session; the filing dates the release 2026-08-08 \(a Saturday\), before it was filed: first traded 2026-08-10, which closed 1\.46% higher \(521\.80 on 2026-08-07 to 529\.42 on 2026-08-10\)\n/);
  assert.match(s, /\n- 2026-11-09, accepted at 06:10 New York time, before the open; the filing dates the release 2026-11-07 \(a Saturday\), before it was filed: first traded 2026-11-09, which closed 0\.76% higher \(570\.89 on 2026-11-06 to 575\.25 on 2026-11-09\)\n/);
});

test('the first session after a filing: before the open, during it, after the close (1 p.m. on an early close), and on a day with no session', () => {
  const at = (iso: string) => Date.parse(iso);
  // JPMorgan files its results at 06:30 New York time: that session trades them.
  assert.deepEqual(firstSession(at('2026-10-13T10:30:38Z'), []), { day: '2026-10-13', time: '06:30', when: 'before the open', session: '2026-10-13' });
  assert.deepEqual(firstSession(at('2026-11-27T17:00:00Z'), []), { day: '2026-11-27', time: '12:00', when: 'during the session', session: '2026-11-27' });
  assert.deepEqual(firstSession(at('2026-11-27T18:30:00Z'), []), { day: '2026-11-27', time: '13:30', when: 'after the close', session: '2026-11-30' }, 'the day after Thanksgiving closes at 1 p.m.');
  assert.deepEqual(firstSession(at('2026-11-26T15:00:00Z'), []), { day: '2026-11-26', time: '10:00', when: 'on a day with no session (Thanksgiving Day)', session: '2026-11-27' });
  assert.deepEqual(firstSession(at('2026-11-07T15:00:00Z'), []), { day: '2026-11-07', time: '10:00', when: 'on a day with no session (a Saturday)', session: '2026-11-09' });
  // Within the price table, its own sessions decide: a day it has no row for had none.
  assert.equal(firstSession(at('2025-11-26T21:30:00Z'), ['2025-11-25', '2025-11-26', '2025-11-28', '2025-12-01']).session, '2025-11-28');
  // Accepted after 5:30 p.m., a filing is dated the next day: the line says when it was accepted.
  assert.equal(firstSession(at('2026-01-28T22:45:00Z'), []).day, '2026-01-28');
});

test('a release still trading has no close yet; a filing accepted after 5:30 p.m. says the day it was accepted', async () => {
  const session = { start: Date.parse('2026-11-11T14:30:00Z') / 1000, end: Math.floor(Date.now() / 1000) + 3600 };
  desk(record([
    { form: '8-K', filed: '2026-11-10', at: '2026-11-10T21:05:00.000Z', items: '2.02,9.01' },
    { form: '8-K', filed: '2026-08-06', at: '2026-08-05T21:45:00.000Z', items: '2.02,9.01' },
  ]), prices('2026-11-11', {}), [], [], { currentTradingPeriod: { regular: session } });
  const s = section(await companyOverview('ACME', '2026-11-11'));
  assert.match(s, /\n- 2026-08-06, accepted at 17:45 New York time on 2026-08-05, after the close: first traded 2026-08-06, which closed/);
  assert.match(s, /\n- 2026-11-10, accepted at 16:05 New York time, after the close: first traded 2026-11-11, a session still trading: no close yet\n/);
});

test('a heavy filer whose latest list does not reach back a year: the older pages are read, and one that cannot be is said', async () => {
  const recent = [{ form: '8-K', filed: '2026-10-13', at: '2026-10-13T10:30:38.000Z', items: '2.02,9.01' }, { form: '424B2', filed: '2026-06-01', at: '2026-06-01T15:00:00.000Z' }];
  const files = [
    { name: 'CIK0000001234-submissions-001.json', filingFrom: '2025-06-01', filingTo: '2026-05-31' },
    { name: 'CIK0000001234-submissions-002.json', filingFrom: '2020-01-01', filingTo: '2025-05-31' },
  ];
  const seen: string[] = [];
  desk(record(recent, { files }), prices('2026-11-10', {}), [
    [/submissions-001\.json/, () => json(columns([{ form: '8-K', filed: '2026-04-14', at: '2026-04-14T10:32:42.000Z', items: '2.02,9.01' }, { form: '8-K', filed: '2026-01-13', at: '2026-01-13T11:41:09.000Z', items: '2.02,9.01' }]))],
  ], seen);
  const s = section(await companyOverview('ACME', '2026-11-10'));
  assert.deepEqual([...s.matchAll(/^- (\S+), accepted at (\S+) New York time, before the open: first traded (\S+),/gm)].map((m) => m.slice(1).join(' ')),
    ['2026-01-13 06:41 2026-01-13', '2026-04-14 06:32 2026-04-14', '2026-10-13 06:30 2026-10-13']);
  assert.ok(!seen.some((u) => /submissions-002/.test(u)), 'a page wholly before the year is not read');

  clearSecCache(); clearCache();
  desk(record(recent, { files }), prices('2026-11-10', {}));
  const short = section(await companyOverview('ACME', '2026-11-10'));
  assert.match(short, /^Results releases filed from 2025-11-11 to 2026-11-10, oldest first \(the SEC's older pages of its filings could not be read \(.+\), so releases filed before 2026-06-01 are not listed\):/);
});

test('a fund, a foreign filer, a company with no release, one that does not file with the SEC and a coin: each says so plainly, never a date', async () => {
  configure({ fetch: route([TICKERS, FACTS, [/company_tickers_mf\.json/, () => json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1234, 'S000000001', 'C000000001', 'ACME']] })],
    [/submissions\/CIK0000001234\.json/, () => json(record([]))], [/v8\/finance\/chart\/ACME/, () => json(chartJson('ACME', prices('2026-11-10', {})))]]) });
  assert.match(section(await companyOverview('ACME', '2026-11-10')), /^Results releases: none\. ACME is a fund, and a fund has no results releases or results dates: what it holds, which get_fund_profile reads, is its fundamentals\.$/);

  clearSecCache(); clearCache();
  desk(record([{ form: '20-F', filed: '2026-04-16', dated: '2025-12-31', at: '2026-04-16T10:00:00.000Z' }, { form: '6-K', filed: '2026-10-16', at: '2026-10-16T10:00:00.000Z' }]), prices('2026-11-10', {}));
  assert.match(section(await companyOverview('ACME', '2026-11-10')), /^Results releases: not known from its filings\. ACME files with the SEC as a foreign company \(its yearly report is a form 20-F\), and such a company files its results on form 6-K, which names no items, so the desk cannot tell its results from its other reports\. Next results date: not known\./);

  clearSecCache(); clearCache();
  desk(record([{ form: '10-Q', filed: '2026-08-06', dated: '2026-06-30', at: '2026-08-06T20:00:00.000Z' }]), prices('2026-11-10', {}));
  assert.match(section(await companyOverview('ACME', '2026-11-10')), /^Results releases: none filed from 2025-11-11 to 2026-11-10 \(form 8-K, item 2\.02\)\. A company may publish its results only in its quarterly and yearly reports \(forms 10-Q and 10-K\), which get_financial_statement reads; the days those were filed are not results dates\. Next results date: not known\./);

  clearSecCache(); clearCache();
  configure({ fetch: route([[/company_tickers\.json/, () => json({})]]) });
  assert.match(await companyOverview('ACME', '2026-10-01'), /withheld for 2026-10-01[\s\S]*\n\nResults releases and the next results date: not known\. The desk reads them from a company's SEC filings, and ACME does not file with the SEC; do not work them out from anything else\.$/);

  await assert.rejects(companyOverview('BTC-USD', '2026-11-10'), /BTC-USD is not a company: a crypto asset, index, future or currency pair has no company accounts and no results releases or results dates/);
});

test('releasesIn keeps each release once, in its window, oldest first, with the date its filing gives it', () => {
  const page = columns([{ form: '8-K', filed: '2026-11-09', dated: '2026-11-07', at: '2026-11-09T11:10:14.000Z', items: '2.02, 9.01' }]);
  const list = releasesIn([page, page, columns([{ form: '8-K', filed: '2025-01-02', at: 'not a time', items: '2.02' }])], '2025-01-01', '2026-11-10');
  assert.deepEqual(list, [
    { filed: '2025-01-02', accepted: null, items: ['2.02'], dated: '2025-01-02' },
    { filed: '2026-11-09', accepted: Date.parse('2026-11-09T11:10:14.000Z'), items: ['2.02', '9.01'], dated: '2026-11-07' },
  ]);
  assert.deepEqual(releasesIn([page], '2026-11-10', '2026-11-11'), [], 'before the window');
  assert.deepEqual(releasesIn([page], '2026-01-01', '2026-11-08'), [], 'filed after the analysis date');
});

test('every agent dates results only from the company overview, says the next date is not known, and never prices a results day as an ordinary one', async () => {
  const src = await import(pathToFileURL(path.resolve('scripts/agents-src.mjs')).href) as { AGENTS: Array<{ file: string; body: string }>; COMMON: string };
  assert.ok(src.COMMON.includes('- A company\'s results dates come only from get_company_overview, or a checked report that quotes it: the results releases it filed in the year to the analysis date, each with the first session that could trade on it and how that session closed. It gives no next results date: write "the next results date is not known", and never work one out from the spacing of past releases or filings, a prediction market\'s closing date or a news article. A fund, a crypto asset and an index have no results releases. A results session is a scheduled event: never price a move on one as the chance of an ordinary session (1 in 252).'));
  const body = (f: string) => src.AGENTS.find((a) => a.file === f)!.body;
  assert.match(body('fundamentals-analyst'), /Give the results releases get_company_overview lists, each with the first session that traded on it and how that session closed, and say that the next results date is not known, as it says\./);
  assert.match(body('fundamentals-analyst'), /A fund has no results releases, so no results dates: say so\./);
  assert.match(body('fact-checker'), /each results date, and the session said to have traded on it, against get_company_overview's results releases \(a next results date is wrong, since the company overview says it is not known: the right words are "the next results date is not known"\)/);
});
