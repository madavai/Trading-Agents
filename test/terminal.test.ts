import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { Journal } from '../src/desk/journal.js';
import { saveSection } from '../src/desk/runs.js';
import { saveContactEmail } from '../src/contact.js';
import { deskServer } from '../src/tools/server.js';
import { clearQuotes, parseQuote } from '../src/terminal/quotes.js';
import { summaryOf } from '../src/terminal/state.js';
import { startTerminal, type Assets, type Terminal } from '../src/terminal/server.js';
import { enqueue, MAX_QUEUE, MAX_WATCH, addWatch } from '../src/terminal/store.js';
import { chartJson, series } from './chart.js';

const NOW = Date.parse('2026-10-12T15:00:00Z') / 1000;
const intraday = (symbol: string, price: number | undefined, prev: number | undefined, extra: Record<string, unknown> = {}) => ({
  chart: { result: [{ meta: { symbol, currency: 'USD', longName: `${symbol} Corp`, regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: NOW - 60, currentTradingPeriod: { regular: { start: NOW - 3600, end: NOW + 3600 } }, ...extra }, timestamp: [NOW - 600, NOW - 300, NOW - 60], indicators: { quote: [{ close: [101, null, 102] }] } }], error: null },
});

/** A fetch standing in for Yahoo: a one-day answer for the quote address, daily rows for the history address, and no data for ZZZZ. */
const yahoo: typeof fetch = async (input) => {
  const url = String(input), m = /\/v8\/finance\/chart\/([^?]+)\?(.*)/.exec(url);
  if (!m) return new Response('no route', { status: 404 });
  const symbol = decodeURIComponent(m[1]!);
  if (symbol === 'ZZZZ') return new Response(JSON.stringify({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }), { status: 200 });
  if (symbol === 'DOWN') return new Response('down', { status: 503, headers: { 'retry-after': '0' } });
  if (m[2]!.includes('range=1d')) return new Response(JSON.stringify(intraday(symbol, 102, 100)));
  return new Response(JSON.stringify(chartJson(symbol, series('2026-10-09', 420))));
};

const ASSETS: Assets = new Map([
  ['/index.html', { type: 'text/html; charset=utf-8', body: '<!doctype html><meta name="desk-token" content="__DESK_TOKEN__"><p>page</p>' }],
  ['/app.js', { type: 'text/javascript; charset=utf-8', body: 'console.log(1)' }],
]);

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: () => any }
/** A request made the low-level way, so the test can set the Host and Origin headers a browser would. */
const call = (t: Terminal, method: string, p: string, o: { headers?: Record<string, string>; body?: unknown; token?: boolean } = {}): Promise<Reply> => new Promise((resolve, reject) => {
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${t.port}`, ...(o.token === false ? {} : { 'x-desk-token': t.token }), ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...o.headers };
  const req = http.request({ host: '127.0.0.1', port: t.port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, json: () => JSON.parse(b) }));
  });
  req.on('error', reject); if (payload !== undefined) req.write(payload); req.end();
});

let root = '', term: Terminal;
const dir = () => path.join(root, 'desk-data');
beforeEach(async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  clearCache(); clearQuotes(); configure({ fetch: yahoo, secEmail: '' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-term-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  term = await startTerminal({ root, assets: ASSETS, port: 0 });
});
afterEach(async () => { await term.close(); });

test('the page is served with the token and strict headers, and only the files it has', async () => {
  const r = await call(term, 'GET', '/', { token: false });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(`content="${term.token}"`) && !r.body.includes('__DESK_TOKEN__'));
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call(term, 'GET', '/app.js', { token: false })).status, 200);
  for (const p of ['/etc/passwd', '/../package.json', '/%2e%2e/package.json', '/fonts/../../package.json', '/desk-data/journal.md', '/src/terminal/server.ts']) assert.equal((await call(term, 'GET', p, { token: false })).status, 404, p);
});

test('it answers only to this computer\'s own name and port', async () => {
  for (const host of ['evil.example', `evil.example:${term.port}`, `127.0.0.1:${term.port + 1}`, '127.0.0.1', `127.0.0.1.evil.example:${term.port}`]) assert.equal((await call(term, 'GET', '/', { headers: { host }, token: false })).status, 421, host);
  assert.equal((await call(term, 'GET', '/', { headers: { host: `localhost:${term.port}` }, token: false })).status, 200);
});

test('every call to the data needs the token the page was given; a change must come from the page\'s own address and be JSON', async () => {
  assert.equal((await call(term, 'GET', '/api/state', { token: false })).status, 403);
  assert.equal((await call(term, 'GET', '/api/state', { headers: { 'x-desk-token': 'nope' } })).status, 403);
  assert.equal((await call(term, 'GET', '/api/state')).status, 200);
  const add = { body: { symbol: 'NVDA' } };
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, token: false })).status, 403);
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(term, 'POST', '/api/watchlist', { headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, headers: { origin: `http://127.0.0.1:${term.port}` } })).status, 200);
  assert.equal((await call(term, 'PUT', '/api/watchlist', add)).status, 405);
  assert.equal(fs.existsSync(path.join(dir(), 'watchlist.json')), true);
  assert.equal((await call(term, 'GET', '/api/ping', { token: false })).json().app, 'trading-agents');
  const big = await call(term, 'POST', '/api/queue', { body: { symbol: 'A'.repeat(6000) } });
  assert.equal(big.status, 413);
});

test('a stock is added only if it has a price, can be starred and removed, and the list is kept in desk-data', async () => {
  assert.deepEqual((await call(term, 'POST', '/api/watchlist', { body: { symbol: 'nvda' } })).json().watchlist.map((w: any) => [w.symbol, w.favourite]), [['NVDA', false]]);
  await call(term, 'POST', '/api/watchlist', { body: { symbol: 'AAPL' } });
  assert.equal((await call(term, 'POST', '/api/watchlist', { body: { symbol: 'NVDA' } })).json().watchlist.length, 2);       // no duplicate
  assert.equal((await call(term, 'POST', '/api/watchlist', { body: { symbol: 'ZZZZ' } })).status, 422);                         // Yahoo has nothing for it
  assert.equal((await call(term, 'POST', '/api/watchlist', { body: { symbol: '../../x' } })).status, 400);
  assert.equal((await call(term, 'POST', '/api/watchlist', { body: { symbol: 'DOWN' } })).status, 200);                         // Yahoo down: it cannot be checked, so it is allowed and shown unavailable
  assert.deepEqual((await call(term, 'POST', '/api/favourite', { body: { symbol: 'AAPL', favourite: true } })).json().watchlist.map((w: any) => [w.symbol, w.favourite]), [['NVDA', false], ['AAPL', true], ['DOWN', false]]);
  assert.equal((await call(term, 'POST', '/api/favourite', { body: { symbol: 'TSLA', favourite: true } })).status, 400);
  assert.deepEqual((await call(term, 'DELETE', '/api/watchlist?symbol=DOWN')).json().watchlist.map((w: any) => w.symbol), ['NVDA', 'AAPL']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir(), 'watchlist.json'), 'utf8')).length, 2);
  for (let i = 0; i < MAX_WATCH; i++) { try { addWatch(dir(), `S${i}`, '2026-10-12'); } catch { /* full */ } }
  assert.throws(() => addWatch(dir(), 'LAST', '2026-10-12'), /holds 50 stocks/);
});

test('an analysis asked for on the page waits in a queue the desk\'s own tools can read and clear', async () => {
  assert.deepEqual((await call(term, 'POST', '/api/queue', { body: { symbol: 'nvda' } })).json().queue.map((q: any) => q.symbol), ['NVDA']);
  assert.equal((await call(term, 'POST', '/api/queue', { body: { symbol: 'NVDA' } })).json().queue.length, 1);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, yahoo).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const tool = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(await tool('read_queue'), /^1 analysis request\(s\) waiting, oldest first:\n1\. NVDA \(asked /);
  assert.match(await tool('finish_queue_item', { symbol: 'NVDA' }), /0 left/);
  assert.match(await tool('read_queue'), /Nothing is waiting/);
  assert.equal((await call(term, 'GET', '/api/state')).json().queue.length, 0);
  for (let i = 0; i < MAX_QUEUE; i++) enqueue(dir(), `Q${i}`, '2026-10-12T10:00:00Z');
  assert.equal((await call(term, 'POST', '/api/queue', { body: { symbol: 'ONEMORE' } })).status, 400);
  await client.close();
});

const BUY = '**Rating**: Overweight\n\n**Executive Summary**: Add gradually on a close above 229.\n\n**Investment Thesis**: The trend is up.';

test('the page\'s state is the desk\'s own files: calls, how they turned out, and nothing invented', async () => {
  const empty = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual([empty.calls, empty.watchlist, empty.queue, empty.desk.emailSaved, empty.desk.tradingEnabled, empty.record.summary.resolved], [[], [], [], false, false, 0]);
  const j = new Journal(path.join(dir(), 'journal.md'));
  j.storeDecision('NVDA', '2026-09-01', BUY); j.recordOutcome('NVDA', '2026-09-01', 0.1, 0.075, 5, 'Alpha +7.5%.', '2026-09-08');
  j.storeDecision('AAPL', '2026-10-09', '**Rating**: Sell\n\n**Executive Summary**: Trim.');
  saveSection(dir(), 'NVDA', '2026-09-01', 'decision', BUY);
  saveContactEmail(root, 'jane@mail.com');
  const s = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual(s.calls.map((c: any) => [c.ticker, c.rating, c.pending, c.raw, c.alpha, c.summary]), [['AAPL', 'Sell', true, null, null, 'Trim.'], ['NVDA', 'Overweight', false, '+10.0%', '+7.5%', 'Add gradually on a close above 229.']]);
  assert.equal(s.desk.emailSaved, true);
  assert.ok(!JSON.stringify(s).includes('jane@mail.com'), 'the email must not reach the page');
  assert.equal(s.record.summary.byRating.Overweight.count, 1);
  assert.match(s.record.text, /Overweight: n=1, called the direction 100%, mean alpha \+7\.50%/);
  assert.match(s.record.benchmarkNote, /after 5 trading days against its market's index/);
  const one = (await call(term, 'GET', '/api/call?symbol=nvda&date=2026-09-01')).json();
  assert.match(one.decision, /Overweight/); assert.deepEqual(Object.keys(one.sections), ['decision']);
  assert.equal((await call(term, 'GET', '/api/call?symbol=NVDA&date=2020-01-01')).status, 404);
});

test('the page asks "did anything change?" cheaply, and the answer changes when a desk file does', async () => {
  const v1 = (await call(term, 'GET', '/api/version')).json().version;
  assert.equal((await call(term, 'GET', '/api/version')).json().version, v1);
  await new Promise((r) => setTimeout(r, 20));
  new Journal(path.join(dir(), 'journal.md')).storeDecision('NVDA', '2026-09-01', BUY);
  assert.notEqual((await call(term, 'GET', '/api/version')).json().version, v1);
  const v2 = (await call(term, 'GET', '/api/version')).json().version;
  await new Promise((r) => setTimeout(r, 20));
  saveSection(dir(), 'NVDA', '2026-09-01', 'market', 'M');
  assert.notEqual((await call(term, 'GET', '/api/version')).json().version, v2);
});

test('a call\'s summary is the decision\'s own, else its first words', () => {
  assert.equal(summaryOf(BUY), 'Add gradually on a close above 229.');
  assert.equal(summaryOf('No labels here, only a plain sentence.'), 'No labels here, only a plain sentence.');
  assert.ok(summaryOf('x'.repeat(900)).length <= 320);
});

test('a quote is read from Yahoo\'s answer; what it lacks is left out, never filled with a zero', () => {
  const q = parseQuote(intraday('NVDA', 102, 100), 'NVDA', NOW);
  assert.deepEqual([q.price, q.previousClose, q.change, q.open, q.points], [102, 100, 2, true, [101, 102]]);
  assert.ok(Math.abs(q.changePct! - 2) < 1e-9);
  const noPrev = parseQuote(intraday('X', 50, undefined), 'X', NOW);
  assert.deepEqual([noPrev.change, noPrev.changePct], [null, null]);
  assert.equal(parseQuote(intraday('X', 50, 49), 'X', NOW + 7200).open, false);                                                       // after the session
  assert.equal(parseQuote(intraday('BTC-USD', 50, 49, { instrumentType: 'CRYPTOCURRENCY' }), 'BTC-USD', NOW + 7200).open, true);        // a coin never closes
  assert.equal(parseQuote(intraday('X', undefined, 49), 'X', NOW).price, 102);                                                           // falls back to the last point
  assert.throws(() => parseQuote({ chart: { result: null, error: { description: 'No data found' } } }, 'ZZZZ'), /no price for ZZZZ \(No data found\)/);
});

test('prices: markets, quotes and unavailable symbols are told apart, and Yahoo is asked once for a burst', async () => {
  const m = (await call(term, 'GET', '/api/markets')).json().markets;
  assert.deepEqual(m.map((x: any) => x.symbol), ['^GSPC', '^IXIC', '^DJI', '^VIX', '^TNX', 'BTC-USD']);
  assert.ok(m.every((x: any) => x.quote.price === 102));
  const q = (await call(term, 'GET', '/api/quotes?symbols=NVDA,ZZZZ,DOWN,not%20a%20ticker')).json().quotes;
  assert.deepEqual(q.map((x: any) => x.error ?? 'ok'), ['ok', 'no-data', 'unavailable', 'no-data']);
  let asked = 0;
  configure({ fetch: async (u, i) => { asked++; return yahoo(u, i); } });
  clearQuotes();
  await Promise.all([1, 2, 3].map(() => call(term, 'GET', '/api/quotes?symbols=MSFT')));
  assert.equal(asked, 1);
});

test('history comes with 50- and 200-day averages that are whole at the left edge of the range', async () => {
  const h = (await call(term, 'GET', '/api/history?symbol=NVDA&range=1M')).json();
  assert.ok(h.bars.length > 15 && h.bars.length < 30, String(h.bars.length));
  assert.ok(h.bars.every((b: any) => b.date >= '2026-09-11' && b.date <= '2026-10-09'));
  assert.equal(h.ma50.length, h.bars.length);
  assert.ok(h.ma50[0] !== null && h.ma200[0] !== null, 'averages start at the range\'s first day');
  assert.ok(Math.abs(h.ma50[h.ma50.length - 1] - h.bars.slice(-1)[0].close) < 30);
  assert.equal((await call(term, 'GET', '/api/history?symbol=NVDA&range=10Y')).status, 400);
  assert.equal((await call(term, 'GET', '/api/history?symbol=ZZZZ&range=1M')).status, 404);
});
