// Audit 2 (7 Nov 2026), "no made-up data": the price tools' failures replayed with made-up rows shaped like the audit's
// drills (handoff notes, drills P6-P12 and K1-K2). Each test names its drill.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, keepFor, readWords } from '../src/data/http.js';
import { clearCache, parseChart, type Series } from '../src/data/yahoo.js';
import { indicatorWindow, instrument, latestState, priceHistory, verifiedSnapshot } from '../src/data/market.js';
import { priceFacts } from '../src/data/facts.js';
import { mfi, vwma } from '../src/data/indicators.js';
import { workOut } from '../src/data/workout.js';
import { economicSeries } from '../src/data/macro.js';
import { clearSecCache } from '../src/data/sec.js';
import { insiderTransactions } from '../src/data/company.js';
import { chartJson, series, type Row } from './chart.js';

const DAY = '2026-11-06';   // a Friday
// Friday's regular session in New York: 9:30 to 16:00 (14:30 to 21:00 UTC).
const OPEN = Date.parse('2026-11-06T14:30:00Z'), CLOSE = Date.parse('2026-11-06T21:00:00Z');
const realNow = Date.now;
const at = (iso: string) => { Date.now = () => Date.parse(iso); };

/** The chart service's answer for these rows, with Friday's session in its record. */
const answer = (rows: Array<Row | null>, edit: (j: ReturnType<typeof chartJson>) => void = () => {}) => {
  const j = chartJson('NVDA', rows, { currentTradingPeriod: { regular: { start: OPEN / 1000, end: CLOSE / 1000 } } });
  edit(j);
  return j;
};
const serve = (make: () => unknown, seen: string[] = []): typeof fetch => async (input) => { seen.push(String(input)); return new Response(JSON.stringify(make()), { status: 200 }); };
/** A weekday row listed with its prices blank (JSON writes NaN as null). */
const blank = (date: string): Row => ({ date, o: NaN, h: NaN, l: NaN, c: NaN, v: NaN });

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = DAY; clearCache(); clearSecCache(); configure({ cacheDir: null, secEmail: '' }); });
afterEach(() => { Date.now = realNow; });

// ---------- A: prices stay fresh inside a run, and "final" only when read after the close (P12, K0) ----------

test('audit 2 P12: the same tool server read at 13:00 and again at 17:00 shows the close at 17:00, never the 13:00 price called final', async () => {
  const rows = series(DAY, 300);
  let last = 180.01;   // the price at 13:00; the session closes at 186.64
  configure({ fetch: serve(() => answer(rows.map((r, i) => (i === rows.length - 1 ? { ...r, c: last, h: Math.max(r.h, last) } : r)))) });
  at('2026-11-06T18:00:00Z');   // 13:00 New York time
  const first = await verifiedSnapshot('NVDA', DAY);
  assert.match(first, /The latest row, 2026-11-06, is a session still trading/);
  assert.match(first, /\| Latest price \(still trading\) \| 180\.01 \|/);
  last = 186.64;
  at('2026-11-06T22:00:00Z');   // 17:00, the same tool server, the source now has the close
  const second = await verifiedSnapshot('NVDA', DAY);
  assert.match(second, /- The latest row, 2026-11-06, is a finished session: its figures are final\./);
  assert.match(second, /\n\| Close \| 186\.64 \|/);
  assert.doesNotMatch(second, /180\.01/, 'the 13:00 price is gone once its kept copy is older than the source\'s own five minutes');
});

test('audit 2 P12: rows read before the close was final are the latest price as read, whenever they are shown; final once read 15 minutes after it', () => {
  const s: Series = { meta: { symbol: 'NVDA', timezone: 'America/New_York', session: { date: DAY, start: OPEN, end: CLOSE } }, bars: [{ date: DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }] };
  const after = CLOSE + 60 * 60_000;   // shown at 17:00
  const during = latestState({ ...s, fetchedAt: Date.parse('2026-11-06T18:00:00Z') }, DAY, after);
  assert.equal(during.open, true);
  assert.equal(during.label, 'Latest price (read at 13:00 America/New_York time, not the close)');
  assert.match(during.lines[0]!, /^- \*\*The latest row, 2026-11-06, was read at 13:00 America\/New_York time, while its session was still trading \(it ended at 16:00 America\/New_York time, and its figures are taken as final 15 minutes after\)\. Its "close" is the latest price as read then, not the close/);
  const soon = latestState({ ...s, fetchedAt: CLOSE + 5 * 60_000 }, DAY, after);
  assert.equal(soon.open, true);
  assert.match(soon.lines[0]!, /was read at 16:05 America\/New_York time, just after its session ended/);
  const settled = latestState({ ...s, fetchedAt: CLOSE + 20 * 60_000 }, DAY, after);
  assert.deepEqual([settled.open, settled.label, settled.lines], [false, 'Close', ['- The latest row, 2026-11-06, is a finished session: its figures are final.']]);
});

test('audit 2 P12: a price series is kept in memory no longer than on disk, and says when it was read', async () => {
  const seen: string[] = [];
  configure({ fetch: serve(() => answer(series(DAY, 30)), seen) });
  at('2026-11-06T22:00:00Z');
  await verifiedSnapshot('NVDA', DAY); await verifiedSnapshot('NVDA', DAY);
  assert.equal(seen.length, 1, 'one read serves the questions of the same few minutes');
  at('2026-11-06T22:04:59Z'); await verifiedSnapshot('NVDA', DAY);
  assert.equal(seen.length, 1);
  at('2026-11-06T22:05:00Z'); await verifiedSnapshot('NVDA', DAY);
  assert.equal(seen.length, 2, 'five minutes on, it is read again');
  assert.equal(keepFor('https://query1.finance.yahoo.com/v8/finance/chart/NVDA'), 5 * 60_000);
});

// ---------- D: a missing volume is never a zero (P6, P7) ----------

test('audit 2 P6: with every volume missing, the tables say "not given", MFI and VWMA have no value, and no volume fact is made up', async () => {
  configure({ fetch: serve(() => answer(series(DAY, 300).map((r) => ({ ...r, v: NaN })))) });
  at('2026-11-06T22:00:00Z');
  assert.match(await verifiedSnapshot('NVDA', DAY), /\| Volume \| not given \|/);
  assert.match(await priceHistory('NVDA', DAY, '2026-11-02', DAY), /^2026-11-06 \| [\d.]+ \| [\d.]+ \| [\d.]+ \| [\d.]+ \| not given$/m);
  const ind = await indicatorWindow('NVDA', DAY, 'mfi, vwma', 7);
  assert.doesNotMatch(ind, /: 100\.00/, 'never MFI 100, "overbought", from no volume');
  assert.match(ind, /2026-11-06: N\/A/);
  assert.match(ind, /mfi is N\/A on a day whose window has a session with no volume given by the source/);
  const facts = await priceFacts('NVDA', DAY);
  assert.match(facts, /- The source gives no volume for these rows \(or none traded\): there are no volume facts here, and VWMA has no value\./);
  assert.doesNotMatch(facts, /Heaviest volume \| \d|Lightest volume \| \d|- Volume /);
});

test('audit 2 P7: the latest row with no volume is left out of the volume facts, never "lightest volume 0"', async () => {
  const rows = series(DAY, 300);
  configure({ fetch: serve(() => answer(rows.map((r, i) => (i === rows.length - 1 ? { ...r, v: NaN } : r)))) });
  at('2026-11-06T22:00:00Z');
  const facts = await priceFacts('NVDA', DAY);
  assert.match(facts, /- The source gives no volume for 1 session \(2026-11-06 \(Fri\)\): it is left out of every volume fact/);
  assert.doesNotMatch(facts, /Lightest volume \| 0 /);
  assert.doesNotMatch(facts, /Lightest volume \| [\d,]+ on 2026-11-06/);
  assert.doesNotMatch(facts, /^- Volume /m, 'the latest row has no volume to compare');
});

test('audit 2 P6: a genuine zero volume (a currency pair\'s) gives MFI and VWMA no value either', () => {
  const bars = series(DAY, 30).map((r) => ({ date: r.date, open: r.o, high: r.h, low: r.l, close: r.c, volume: 0 }));
  assert.ok(mfi(bars).every((v) => v === null) && vwma(bars).every((v) => v === null));
  const s = parseChart(chartJson('EURUSD=X', [{ date: DAY, o: 1, h: 1, l: 1, c: 1, v: NaN }]), 'EURUSD=X');
  assert.equal(s.bars[0]!.volume, null, 'a volume the source leaves blank is null, never 0');
});

// ---------- E: a missing or late session is named, never "did not trade" (P8, P9, P10b, P11) ----------

test('audit 2 P8: a source two sessions behind its own record says so, and the old close is not called the latest', async () => {
  configure({ fetch: serve(() => answer(series('2026-11-04', 300))) });   // 5 and 6 Nov absent; its record says 6 Nov happened
  at('2026-11-07T15:00:00Z');
  const t = await verifiedSnapshot('NVDA', DAY);
  assert.match(t, /Latest trading row used: 2026-11-04/);
  assert.match(t, /- \*\*The source's own record shows a session on 2026-11-06, which has ended, but its rows stop at 2026-11-04: it has no prices yet for 2026-11-06, nor for any session between 2026-11-04 and it\. Every figure here is as of 2026-11-04\. Do not call 2026-11-04 the latest session/);
  assert.match(await instrument('NVDA', DAY), /Latest trading day on or before it: 2026-11-04, close [\d.]+\n\*\*The source's own record shows a session on 2026-11-06/);
  const w = await workOut(DAY, [], [{ date: '2026-11-05', symbol: 'NVDA' }, { date: DAY, symbol: 'NVDA' }]);
  assert.match(w, /- 2026-11-05 is a Thursday\. Whether NVDA traded that day is not known from the source: its own record shows a session on 2026-11-06, but its prices stop at 2026-11-04 \(Wed\)\. Do not say NVDA did not trade that day\./);
  assert.doesNotMatch(w, /is a \w+day\. NVDA did not trade/);
});

test('audit 2 P9: a session listed blank among the rows is named in the tables, and the calculator never says it had no trading', async () => {
  const rows = series(DAY, 300).map((r) => (r.date === '2026-11-03' ? blank(r.date) : r));
  configure({ fetch: serve(() => answer(rows)) });
  at('2026-11-07T15:00:00Z');
  const snap = await verifiedSnapshot('NVDA', DAY);
  assert.match(snap, /- \*\*The source lists a session on 2026-11-03 with no prices: it is missing from these rows, so every average, count and change here skips it \(a change across it spans two sessions\)\. Do not say 2026-11-03 had no trading/);
  assert.match(await priceHistory('NVDA', DAY, '2026-10-30', DAY), /The source lists a session on 2026-11-03 with no prices/);
  const w = await workOut(DAY, [], [{ date: '2026-11-03', symbol: 'NVDA' }, { from: '2026-10-30', to: DAY, symbol: 'NVDA' }]);
  assert.match(w, /- 2026-11-03 is a Tuesday\. The source lists 2026-11-03 as a session of NVDA but gives no prices for it \(yet\): its prices are not available \(the latest session with prices before it: 2026-11-02 \(Mon\)\)\. Do not say NVDA did not trade that day\./);
  assert.match(w, /NVDA has prices on 4 sessions after 2026-10-30 up to and including 2026-11-06 .* The source lists 2026-11-03 \(Tue\) as a session with no prices: not counted here, so the true count may be higher\./);
  assert.doesNotMatch(w, /NVDA traded on 4 sessions/);
});

test('audit 2 P10b: the latest session listed blank (its figures not filled in yet) is not a day without trading for the calculator', async () => {
  const rows = series(DAY, 300).map((r) => (r.date === DAY ? blank(r.date) : r));
  configure({ fetch: serve(() => answer(rows)) });
  at('2026-11-06T21:10:00Z');
  const w = await workOut(DAY, [], [{ date: DAY, symbol: 'NVDA' }]);
  assert.match(w, /- 2026-11-06 is a Friday\. The source lists 2026-11-06 as a session of NVDA but gives no prices for it \(yet\): its prices are not available \(the latest session with prices before it: 2026-11-05 \(Thu\)\)\. Do not say NVDA did not trade that day\./);
});

test('audit 2 P11: "adjusted for splits and dividends" only when the rows are', async () => {
  configure({ fetch: serve(() => answer(series(DAY, 300), (j) => { delete (j.chart.result[0]!.indicators as { adjclose?: unknown }).adjclose; })) });
  at('2026-11-07T15:00:00Z');
  const t = await priceHistory('NVDA', DAY, '2026-11-02', DAY);
  assert.match(t, /; adjusted for splits only: the source gave no dividend-adjusted closes, so a dividend shows as a fall on its ex-dividend day; USD\)/);
  assert.doesNotMatch(t, /adjusted for splits and dividends/);
  clearCache();
  configure({ fetch: serve(() => answer(series(DAY, 300), (j) => { const a = j.chart.result[0]!.indicators.adjclose[0]!.adjclose; a[a.length - 2] = null; })) });
  assert.match(await priceHistory('NVDA', DAY, '2026-11-02', DAY), /adjusted for splits and dividends, except the row the source gave no dividend-adjusted close for \(2026-11-05\), which is adjusted for splits only/);
  assert.match(await verifiedSnapshot('NVDA', DAY), /- Prices adjusted for splits and dividends, except the row the source gave no dividend-adjusted close for \(2026-11-05\)/);
});

// ---------- I: say how old a kept answer is (K1, K2) ----------

const FRED = 'observation_date,DGS10\n2026-11-03,4.12\n2026-11-04,4.15\n2026-11-05,4.11\n2026-11-06,4.09\n';

test('audit 2 K2: an economic figure says when it was read from FRED, a kept copy by its own time, and a copy is kept an hour, not six', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-prices-'));
  let calls = 0;
  configure({ cacheDir, fetch: async () => { calls++; return new Response(FRED); } });
  const fresh = await economicSeries('10y_treasury', DAY, 365);
  assert.match(fresh, /- Read from FRED at \d\d:\d\d New York time on \d{4}-\d\d-\d\d \(the desk keeps a read for up to an hour\): a figure released after that is not here\./);
  assert.doesNotMatch(fresh, /as published today/);
  // The kept copy, 50 minutes old: served, with its own time.
  const file = path.join(cacheDir, fs.readdirSync(cacheDir)[0]!), then = new Date(realNow() - 50 * 60_000);
  fs.utimesSync(file, then, then);
  const kept = await economicSeries('10y_treasury', DAY, 365);
  assert.equal(calls, 1);
  assert.ok(kept.includes(`- Read from FRED at ${readWords(fs.statSync(file).mtimeMs)} (`), 'the time of the kept copy, not now');
  // Seventy minutes old (drill K2 kept one 5 h 50 min): read again.
  const older = new Date(realNow() - 70 * 60_000);
  fs.utimesSync(file, older, older);
  await economicSeries('10y_treasury', DAY, 365);
  assert.equal(calls, 2);
  assert.equal(keepFor('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10'), 60 * 60_000);
  configure({ cacheDir: null });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const TICKERS = { 0: { cik_str: 1234, ticker: 'ACME' } };
const LIST = (filed: string[]) => ({ name: 'ACME CORP', filings: { recent: { accessionNumber: filed.map((_, i) => `0000000000-26-00000${i}`), filingDate: filed, reportDate: filed, form: filed.map(() => '4'), primaryDocument: filed.map(() => 'form4.xml') } } });

test('audit 2 K1: the SEC\'s list of filings is read again after an hour, not a day, and "none" says when the list was read', async () => {
  let lists = 0, filed: string[] = [];
  configure({ fetch: async (input) => {
    const url = String(input);
    if (/company_tickers\.json/.test(url)) return new Response(JSON.stringify(TICKERS));
    if (/submissions\/CIK0000001234\.json/.test(url)) { lists++; return new Response(JSON.stringify(LIST(filed))); }
    return new Response('no route', { status: 404 });
  } });
  at('2026-11-06T14:00:00Z');   // 09:00 New York time
  const first = await insiderTransactions('ACME', DAY);
  assert.match(first, /: none\. No director, officer or large owner reported a trade in these 90 days\. That is a fact from the SEC \(the SEC's list of filings as read at 09:00 New York time on 2026-11-06\), not a gap in the data\./);
  filed = ['2026-11-06'];   // a Form 4 made public later that morning
  at('2026-11-06T14:59:00Z');
  await insiderTransactions('ACME', DAY);
  assert.equal(lists, 1, 'within the hour the same list serves');
  at('2026-11-06T15:00:00Z');
  const later = await insiderTransactions('ACME', DAY);
  assert.equal(lists, 2, 'an hour on, the list is read again (it was kept a day)');
  assert.match(later, /only filings public by 2026-11-06 are shown \(the SEC's list of filings as read at 10:00 New York time on 2026-11-06\)\./);
  assert.equal(keepFor('https://data.sec.gov/submissions/CIK0000001234.json'), 60 * 60_000);
  assert.equal(keepFor('https://data.sec.gov/api/xbrl/companyfacts/CIK0000001234.json'), 24 * 60 * 60_000, 'filed figures and documents still a day');
});
