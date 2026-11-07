import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure, getText, NoData, Unavailable } from '../src/data/http.js';
import { clearCache, parseChart } from '../src/data/yahoo.js';
import { indicatorWindow, instrument, latestState, priceHistory, verifiedSnapshot } from '../src/data/market.js';
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
  assert.equal(s.meta.name, 'NVDA Corporation');
  assert.throws(() => parseChart({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 'ZZZZ'), NoData);
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
