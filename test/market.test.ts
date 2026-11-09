import { test, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure, getText, NoData, Unavailable } from '../src/data/http.js';
import { clearCache, daily, parseChart } from '../src/data/yahoo.js';
import { history } from '../src/terminal/quotes.js';
import { indicatorWindow, instrument, lastClose, latestState, priceHistory, verifiedSnapshot } from '../src/data/market.js';
import { deskServer } from '../src/tools/server.js';
import { chartFetch, chartJson, series, type Row } from './chart.js';

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearCache(); });

test('the chart answer becomes one adjusted row a day, rows without a price left out', () => {
  const s = parseChart(chartJson('NVDA', [
    { date: '2026-10-06', o: 10, h: 12, l: 9, c: 11, v: 5, adj: 5.5 },
    null,
    { date: '2026-10-07', o: 11, h: 12, l: 10, c: 12, v: 6 },
    { date: '2026-10-07', o: 11, h: 12, l: 10, c: 12, v: 6 },
  ]), 'NVDA');
  assert.deepEqual(s.bars.map((b) => b.date), ['2026-10-06', '2026-10-07']);
  assert.deepEqual(s.unfilled, []);      // a blank row before the last priced one is a gap, not a session still being filled in
  assert.equal(s.bars[0]!.close, 5.5);   // adjusted by adjclose / close
  assert.equal(s.bars[0]!.open, 5);
  assert.deepEqual(s.traded!.map((b) => [b.date, b.open, b.low, b.close]), [['2026-10-06', 10, 9, 11], ['2026-10-07', 11, 10, 12]],
    'the same days at the prices traded, for the dashboard\'s chart: its low is one the stock really traded at');
  assert.equal(s.meta.name, 'NVDA Corporation');
  assert.throws(() => parseChart({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 'ZZZZ'), NoData);
});

// Round 1 (7 Nov 2026): the chart box's five-year low and change were dividend-adjusted, so its low was a price NVDA
// never traded at, and its change differed from what Nasdaq or a broker shows.
test("the dashboard's chart is at the prices traded: no day is lowered by a later dividend, while the desk's own rows still count it", async () => {
  const rows = series('2026-10-09', 420).map((r, i, all) => (i < all.length - 10 ? { ...r, adj: r.c * 0.98 } : r));   // a 2% dividend ten days ago
  configure({ fetch: chartFetch(() => rows) });
  const h = await history('NVDA', '1M'), first = rows.find((r) => r.date === h.bars[0]!.date)!;
  const four = (n: number) => Math.round(n * 10_000) / 10_000;
  assert.deepEqual([h.bars[0]!.close, h.bars[0]!.low], [four(first.c), four(first.l)], "the range's first close and low as traded that day");
  const s = await daily('NVDA', '2026-09-01', '2026-10-09');
  assert.ok(s.bars[0]!.close < s.traded![0]!.close, "the desk's own rows stay dividend-adjusted, where a dividend is part of the return");
});

test('a busy source is asked once more; a missing one is no data; a down one is unavailable', async () => {
  let calls = 0;
  configure({ fetch: async () => (++calls === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok')) });
  assert.equal(await getText('https://example.com/a'), 'ok');
  assert.equal(calls, 2);
  configure({ fetch: async () => new Response('nope', { status: 404 }) });
  await assert.rejects(getText('https://example.com/b'), NoData);
  configure({ fetch: async () => new Response('down', { status: 503, headers: { 'retry-after': '0' } }) });
  await assert.rejects(getText('https://example.com/c'), Unavailable);
});

test('the data tools send the SEC contact email to the SEC alone', async () => {
  const seen = new Map<string, string>();
  configure({ contact: 'ta (+x)', secEmail: 'me@example.com', fetch: async (url, init) => { seen.set(new URL(String(url)).hostname, String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('ok'); } });
  for (const u of ['https://query1.finance.yahoo.com/a', 'https://www.reddit.com/b', 'https://data.sec.gov/c']) await getText(u);
  assert.deepEqual(Object.fromEntries(seen), { 'query1.finance.yahoo.com': 'ta (+x)', 'www.reddit.com': 'ta (+x)', 'data.sec.gov': 'ta me@example.com' });
  configure({ secEmail: '' });
});

test('the checked price table says when its latest row is a session still in progress', async () => {
  configure({ fetch: chartFetch(() => series('2026-10-12', 300)) });
  assert.match(await verifiedSnapshot('nvda', '2026-10-12'), /The latest row is today's session\. If the market is still open it is partial/);
  assert.doesNotMatch(await verifiedSnapshot('nvda', '2026-10-09'), /today's session/);
});

const sec = (ms: number) => Math.floor(ms / 1000);
/** The chart service's answer with its session times and, if asked, a last day listed with its prices still blank. */
const withSession = (rows: Row[], session: { start: number; end: number }, blankDay?: string): typeof fetch => async (input) => {
  const j = chartJson(decodeURIComponent(/\/v8\/finance\/chart\/([^?]+)/.exec(String(input))![1]!), rows, { currentTradingPeriod: { regular: { start: sec(session.start), end: sec(session.end) } } });
  const r = j.chart.result[0]!, q = r.indicators.quote[0]!;
  if (blankDay) { r.timestamp.push(sec(Date.parse(`${blankDay}T13:30:00Z`))); for (const k of ['open', 'high', 'low', 'close', 'volume'] as const) q[k].push(null); r.indicators.adjclose[0]!.adjclose.push(null); }
  return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
};
const MONDAY = { start: Date.parse('2026-10-12T13:30:00Z'), end: Date.parse('2026-10-12T20:00:00Z') };   // 9:30 to 16:00 in New York

test('a session still trading is the latest price, never "the close"', async () => {
  configure({ fetch: withSession(series('2026-10-12', 300), { start: MONDAY.start, end: Date.now() + 3_600_000 }) });
  const t = await verifiedSnapshot('nvda', '2026-10-12');
  assert.match(t, /The latest row, 2026-10-12, is a session still trading \(it closes at \d\d:\d\d America\/New_York time\)\. Its "close" is the latest price so far, not a close/);
  assert.match(t, /\| Latest price \(still trading\) \| \d+\.\d\d \|/);
  assert.doesNotMatch(t, /\n\| Close \| /);   // the closes table's own header may say Close
  assert.match(await instrument('nvda', '2026-10-12'), /Latest trading day on or before it: 2026-10-12, still trading: latest price \d+\.\d\d \(not a close\)\n\*\*The latest row, 2026-10-12, is a session still trading/);
  assert.doesNotMatch(await verifiedSnapshot('nvda', '2026-10-09'), /still trading|finished session|not opened|partial/);   // a past day is simply final
});

test('the evening wrap-up\'s last close is a finished session: a day still trading gives the close before it (audit 1 F5)', async () => {
  const rows = series('2026-10-12', 30), friday = rows.at(-2)!, monday = rows.at(-1)!;
  configure({ fetch: withSession(rows, { start: MONDAY.start, end: Date.now() + 3_600_000 }) });
  assert.deepEqual(await lastClose('nvda', '2026-10-12'), { date: friday.date, close: friday.c }, 'Monday is still trading: Friday\'s close');
  clearCache();
  configure({ fetch: withSession(rows, MONDAY) });
  assert.deepEqual(await lastClose('nvda', '2026-10-12'), { date: monday.date, close: monday.c }, 'Monday has closed: its own close');
});

test('a finished session is final, with no hedge; one not open yet is named, with the last finished row', async () => {
  configure({ fetch: withSession(series('2026-10-12', 300), MONDAY) });
  const t = await verifiedSnapshot('nvda', '2026-10-12');
  assert.match(t, /- The latest row, 2026-10-12, is a finished session: its figures are final\./);
  assert.match(t, /\| Close \| \d+\.\d\d \|/);
  assert.doesNotMatch(t, /partial|still trading/);
  assert.match(await instrument('nvda', '2026-10-12'), /Latest trading day on or before it: 2026-10-12, close \d+\.\d\d\nThe latest row, 2026-10-12, is a finished session/);
  const friday = { meta: { symbol: 'NVDA', timezone: 'America/New_York', session: { date: '2026-10-12', ...MONDAY } }, bars: [{ date: '2026-10-09', open: 1, high: 1, low: 1, close: 1, volume: 1 }] };
  assert.deepEqual(latestState(friday, '2026-10-12', Date.parse('2026-10-12T12:00:00Z')).lines, ["- 2026-10-12's session has not opened yet (it opens at 09:30 America/New_York time): the latest row, 2026-10-09, is the latest finished session."]);
  assert.deepEqual(latestState(friday, '2026-10-09', Date.parse('2026-10-12T12:00:00Z')).lines, []);   // for Friday's analysis nothing is missing
});

test('a session the source lists with blank prices is named, never skipped as if it had no trading', async () => {
  configure({ fetch: withSession(series('2026-10-09', 300), MONDAY, '2026-10-12') });
  const t = await verifiedSnapshot('nvda', '2026-10-12');
  assert.match(t, /Latest trading row used: 2026-10-09/);
  assert.match(t, /The source lists a session on 2026-10-12, but its prices are not filled in yet \(this happens for a while after a session ends\)\. Every figure here is as of 2026-10-09\. Do not call 2026-10-09 the latest session, and do not say 2026-10-12 had no trading/);
  assert.match(await instrument('nvda', '2026-10-12'), /Latest trading day on or before it: 2026-10-09, close \d+\.\d\d\n\*\*The source lists a session on 2026-10-12/);
  assert.match(await priceHistory('NVDA', '2026-10-12', '2026-10-01', '2026-10-12'), /\n\n- \*\*The source lists a session on 2026-10-12/);
  assert.match(await indicatorWindow('NVDA', '2026-10-12', 'rsi', 10), /The source lists a session on 2026-10-12/);
  assert.doesNotMatch(await verifiedSnapshot('nvda', '2026-10-09'), /source lists a session/);   // a later day is no concern of a past analysis
});

test('the checked price table never uses a row after the analysis date', async () => {
  configure({ fetch: chartFetch(() => series('2026-10-09', 300)) });
  const t = await verifiedSnapshot('nvda', '2026-10-01');
  assert.match(t, /Latest trading row used: 2026-10-01/);
  assert.doesNotMatch(t, /2026-10-0[2-9]/);
  assert.match(t, /\| close_200_sma \| \d+\.\d\d \|/);
  assert.match(t, /\| rsi \| \d+\.\d\d \|/);
  assert.match(t, /The last 30 closes/);
});

test('prices are held to the analysis date and say how they are adjusted', async () => {
  configure({ fetch: chartFetch(() => series('2026-10-09', 300)) });
  const t = await priceHistory('NVDA', '2026-10-05', '2026-09-28', '2026-12-31');
  assert.match(t, /from 2026-09-28 to 2026-10-05/);
  assert.match(t, /adjusted for splits and dividends/);
  assert.doesNotMatch(t, /2026-10-0[6-9]/);
});

test('indicator windows name unknown indicators instead of guessing', async () => {
  configure({ fetch: chartFetch(() => series('2026-10-09', 300)) });
  const t = await indicatorWindow('NVDA', '2026-10-09', 'RSI, macd, stochrsi', 10);
  assert.match(t, /## rsi for NVDA/);
  assert.match(t, /## macd for NVDA/);
  assert.match(t, /Not computed \(unknown names\): stochrsi/);
  assert.match(await indicatorWindow('NVDA', '2026-10-09', 'foo'), /is an indicator this desk computes/);
});

test('identity: today it names the exchange; for a past day only the name, marked as today\'s', async () => {
  configure({ fetch: chartFetch(() => series('2026-10-09', 300)) });
  const now = await instrument('nvda', '2026-10-12');
  assert.match(now, /Instrument: NVDA/); assert.match(now, /Kind: stock/); assert.match(now, /Exchange: NasdaqGS/);
  const past = await instrument('nvda', '2026-09-01');
  assert.match(past, /its current name, given only to identify it/);
  assert.doesNotMatch(past, /Exchange:/);
  assert.match(await instrument('BTCUSD', '2026-10-12'), /Instrument: BTC-USD \(from BTCUSD\)[\s\S]*crypto asset/);
});

test('a symbol whose prices stopped long ago is reported as having no data', async () => {
  configure({ fetch: chartFetch(() => series('2026-08-01', 300)) });
  await assert.rejects(verifiedSnapshot('OLD', '2026-10-09'), /latest price for OLD is from 2026-07-31/);
});

test('the server offers the market tools, and turns failures into plain words for the agent', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), chartFetch((s) => (s === 'GONE' ? [] : series('2026-10-09', 300)))).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['desk_check', 'get_instrument', 'get_price_history', 'get_indicators', 'get_verified_snapshot']) assert.ok(names.includes(n), n);
  const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(await call('get_verified_snapshot', { symbol: 'NVDA', analysis_date: '2026-10-09' }), /Checked price table for NVDA/);
  assert.match(await call('get_verified_snapshot', { symbol: 'NVDA', analysis_date: '2027-01-01' }), /^INPUT_ERROR: the analysis date 2027-01-01 is in the future/);
  assert.match(await call('get_instrument', { symbol: 'GONE', analysis_date: '2026-10-09' }), /^NO_DATA_AVAILABLE: identity of GONE/);
  await client.close();
});

// Audit 3 prices-5 (9 Nov 2026), checked on Yahoo's real answers that day: GC=F's daily rows are stamped at 00:00 New
// York time and EURUSD=X's at 00:00 London time, and the answer carries one offset, the one in force when it is read. Read
// in November with it, every summer-time row of gold was dated the day before (Monday 29 June as Sunday 28 June).
test('rows are dated in the exchange\'s own time zone, so a row stamped at its midnight keeps its day across a summer-time change', () => {
  const at = (stamps: string[], meta: Record<string, unknown>) => {
    const j = chartJson(String(meta.symbol), stamps.map((s) => ({ date: s.slice(0, 10), o: 10, h: 11, l: 9, c: 10, v: 5 })), meta);
    j.chart.result[0]!.timestamp = stamps.map((s) => Date.parse(s) / 1000);
    return parseChart(j, String(meta.symbol));
  };
  const gold = at(['2026-06-29T04:00:00Z', '2026-06-30T04:00:00Z', '2026-10-30T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-06T05:00:00Z'], { symbol: 'GC=F', instrumentType: 'FUTURE', gmtoffset: -18000, exchangeTimezoneName: 'America/New_York' });
  assert.deepEqual(gold.bars.map((b) => b.date), ['2026-06-29', '2026-06-30', '2026-10-30', '2026-11-02', '2026-11-06']);
  const euro = at(['2026-06-28T23:00:00Z', '2026-10-22T23:00:00Z', '2026-10-30T00:00:00Z'], { symbol: 'EURUSD=X', instrumentType: 'CURRENCY', gmtoffset: 0, exchangeTimezoneName: 'Europe/London' });
  assert.deepEqual(euro.bars.map((b) => b.date), ['2026-06-29', '2026-10-23', '2026-10-30'], 'London on summer time until 25 October');
  const nvda = at(['2026-07-06T13:30:00Z', '2026-11-06T14:30:00Z'], { symbol: 'NVDA', gmtoffset: -18000, exchangeTimezoneName: 'America/New_York' });
  assert.deepEqual(nvda.bars.map((b) => b.date), ['2026-07-06', '2026-11-06'], 'US rows, stamped at the open, as before');
  const noZone = at(['2026-07-06T13:30:00Z'], { symbol: 'X', gmtoffset: -14400, exchangeTimezoneName: undefined });
  assert.deepEqual(noZone.bars.map((b) => b.date), ['2026-07-06'], 'with no zone named, the answer\'s offset');
});

// Audit 3 prices-8: the memory copy started its five minutes when it asked, while the answer could be the disk copy,
// already up to five minutes old, so a price read during the session could be nearly ten minutes old.
test('a price read is never kept past five minutes from when the source was read, even when it came from the disk copy', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-age-')), real = Date.now, base = Date.parse('2026-10-12T17:00:00Z');
  let offset = 0, reads = 0, price = 180;
  Date.now = () => base + offset;
  const touch = () => { for (const f of fs.readdirSync(cacheDir)) { const t = new Date(base + offset); fs.utimesSync(path.join(cacheDir, f), t, t); } };
  try {
    configure({ cacheDir, fetch: async () => { reads++; return new Response(JSON.stringify(chartJson('NVDA', series('2026-10-12', 30).map((r, i, a) => (i === a.length - 1 ? { ...r, c: price, h: price + 1 } : r))))); } });
    const last = async () => (await daily('NVDA', '2026-10-01', '2026-10-12')).bars.at(-1)!.close;
    assert.equal(await last(), 180); touch();                                     // 13:00 in New York: one copy of the tool server reads
    price = 183.5;
    offset = 4 * 60_000 + 50_000; clearCache();                                   // another copy, 4 min 50 s later: the disk copy
    assert.deepEqual([await last(), reads], [180, 1]);
    offset = 5 * 60_000 + 10_000;                                                 // 5 min 10 s after the source was read
    assert.deepEqual([await last(), reads], [183.5, 2], 'read again, not the 13:00 price');
  } finally { Date.now = real; configure({ cacheDir: null }); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

// Audit 3 prices-10: asked for one day the source lists with blank prices, price history said "No trading rows".
test('a window holding only a session the source lists with blank prices names it, never "No trading rows"', async () => {
  configure({ fetch: withSession(series('2026-10-09', 300), MONDAY, '2026-10-12') });
  const t = await priceHistory('NVDA', '2026-10-12', '2026-10-12', '2026-10-12');
  assert.equal(t, 'No prices yet for NVDA from 2026-10-12 to 2026-10-12: the source lists a session on 2026-10-12, but its prices are not filled in yet (this happens for a while after a session ends). Do not say 2026-10-12 had no trading: say its prices were not available yet.');
  configure({ fetch: chartFetch(() => series('2026-10-09', 300)) });
  assert.equal(await priceHistory('NVDA', '2026-10-12', '2026-10-10', '2026-10-11'), 'No trading rows for NVDA from 2026-10-10 to 2026-10-11.', 'a weekend has none');
});
