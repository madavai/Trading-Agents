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
import { clearSearches, parseSearch } from '../src/terminal/search.js';
import { MAX_RECENT, readPrefs, savePrefs } from '../src/terminal/prefs.js';
import { summaryOf } from '../src/terminal/state.js';
import { lockState } from '../src/private.js';
import { startTerminal, type Assets, type Terminal } from '../src/terminal/server.js';
import { MAX_WATCH, addWatch } from '../src/terminal/store.js';
import { enqueue, MAX_OPEN, readDoorbell, writeListener } from '../src/desk/queue.js';
import { chartJson, series, weekdays, type Row } from './chart.js';
import { readScreen } from '../src/desk/screen.js';

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
  ['/index.html', { type: 'text/html; charset=utf-8', body: '<!doctype html><p>page</p>' }],
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
/** A stand-in for the person's private folder, where a running dashboard keeps its key. */
const KEYS = () => path.join(root, 'private', 'dashboard.json');
beforeEach(async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  clearCache(); clearQuotes(); configure({ fetch: yahoo, secEmail: '' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-term-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  term = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS() });
});
afterEach(async () => { await term.close(); });

test('the page is served without any key, with strict headers, and only the files it has', async () => {
  const r = await call(term, 'GET', '/', { token: false });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<p>page</p>') && !r.body.includes(term.token), 'a program that reads the page gets no key');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call(term, 'GET', '/app.js', { token: false })).status, 200);
  for (const p of ['/etc/passwd', '/../package.json', '/%2e%2e/package.json', '/fonts/../../package.json', '/desk-data/journal.md', '/src/terminal/server.ts']) assert.equal((await call(term, 'GET', p, { token: false })).status, 404, p);
});

test('it answers only to this computer\'s own name and port', async () => {
  for (const host of ['evil.example', `evil.example:${term.port}`, `127.0.0.1:${term.port + 1}`, '127.0.0.1', `127.0.0.1.evil.example:${term.port}`]) assert.equal((await call(term, 'GET', '/', { headers: { host }, token: false })).status, 421, host);
  assert.equal((await call(term, 'GET', '/', { headers: { host: `localhost:${term.port}` }, token: false })).status, 200);
});

test('every call to the data needs the key; a change must come from the page\'s own address and be JSON', async () => {
  assert.equal((await call(term, 'GET', '/api/state', { token: false })).status, 401);
  const refused = await call(term, 'GET', '/api/state', { headers: { 'x-desk-token': 'nope' } });
  assert.deepEqual([refused.status, refused.json().error], [401, 'this page has no key to the dashboard: open the dashboard again']);
  assert.equal((await call(term, 'GET', '/api/state')).status, 200);
  const add = { body: { symbol: 'NVDA' } };
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, token: false })).status, 401);
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(term, 'POST', '/api/watchlist', { headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await call(term, 'POST', '/api/watchlist', { ...add, headers: { origin: `http://127.0.0.1:${term.port}` } })).status, 200);
  assert.equal((await call(term, 'PUT', '/api/watchlist', add)).status, 405);
  assert.equal(fs.existsSync(path.join(dir(), 'watchlist.json')), true);
  assert.equal((await call(term, 'GET', '/api/ping', { token: false })).json().app, 'trading-agents');
  const big = await call(term, 'POST', '/api/queue', { body: { symbol: 'A'.repeat(6000) } });
  assert.equal(big.status, 413);
});

test('the key reaches the page by a one-time link: swapped once, within its time, from the page\'s own address; a program with the key can ask for a fresh link', async () => {
  const t = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), claimMs: 300 });
  try {
    const link = `${t.url}#open=${t.claim()}`, claim = link.split('#open=')[1]!;
    assert.match(claim, /^[0-9a-f]{36}$/);
    assert.ok(!link.includes(t.token), 'the link carries a claim, never the key');
    assert.equal((await call(t, 'POST', '/api/claim', { body: { claim: 'nope' }, token: false })).status, 403);
    assert.equal((await call(t, 'POST', '/api/claim', { body: { claim: t.claim() }, headers: { origin: 'https://evil.example' }, token: false })).status, 403, 'another web page cannot claim it');
    const got = await call(t, 'POST', '/api/claim', { body: { claim }, token: false });
    assert.deepEqual([got.status, got.json().key], [200, t.token]);
    assert.equal((await call(t, 'POST', '/api/claim', { body: { claim }, token: false })).status, 403, 'once');
    const late = t.claim();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call(t, 'POST', '/api/claim', { body: { claim: late }, token: false })).status, 403, 'expired');
    assert.equal((await call(t, 'POST', '/api/claim/new', { body: {}, token: false })).status, 401, 'a fresh link needs the key');
    const fresh = (await call(t, 'POST', '/api/claim/new', { body: {} })).json().claim;
    assert.equal((await call(t, 'POST', '/api/claim', { body: { claim: fresh }, token: false })).json().key, t.token);
  } finally { await t.close(); }
});

test('while it runs, the key is kept in the private folder for opening the page again, one entry per desk, and taken out when it stops; a restart keeps the key it is handed', async () => {
  const file = KEYS(), keys = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { port: number; key: string }>;
  assert.deepEqual(keys(), { [term.deskId]: { port: term.port, key: term.token } });
  assert.equal(lockState(file), 'locked');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-term2-')), other = await startTerminal({ root: elsewhere, assets: ASSETS, port: 0, keyFile: file });
  try { assert.deepEqual(Object.keys(keys()).sort(), [term.deskId, other.deskId].sort(), 'one entry per desk'); } finally { await other.close(); }
  assert.deepEqual(Object.keys(keys()), [term.deskId]);
  const key = term.token;
  await term.close();
  assert.equal(fs.existsSync(file), false, 'nothing is left when no dashboard runs');
  const again = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: file, key });
  try {
    assert.equal(again.token, key, 'the restarted dashboard answers to the key the page already holds');
    assert.equal((await call(again, 'GET', '/api/state')).status, 200);
  } finally { await again.close(); }
  term = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: file, key: 'short' });
  assert.match(term.token, /^[0-9a-f]{48}$/, 'anything but a whole key is ignored: a fresh one is made');
  assert.notEqual(term.token, 'short');
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

test('an analysis asked for on the page waits at its depth, rings for whoever listens, and the desk\'s tools take it from waiting to running to done', async () => {
  const first = (await call(term, 'POST', '/api/queue', { body: { symbol: 'nvda' } })).json().queue;
  assert.deepEqual(first.map((q: any) => [q.symbol, q.state, q.depth]), [['NVDA', 'waiting', 'shallow']], "the settings' depth when none is chosen");
  const bell = readDoorbell(dir());
  assert.deepEqual([bell?.why, bell?.waiting], ['press', 1], 'the press rings the doorbell');
  assert.deepEqual((await call(term, 'POST', '/api/queue', { body: { symbol: 'NVDA', depth: 'deep' } })).json().queue.map((q: any) => [q.symbol, q.depth]), [['NVDA', 'deep']], 'asked again while waiting: the new depth stands');
  assert.equal((await call(term, 'POST', '/api/queue', { body: { symbol: 'AAPL', depth: 'deepest' } })).status, 400);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, yahoo).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const tool = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(await tool('read_queue'), /^1 waiting, in the order to run them; one run analyses at most 5:\n1\. NVDA, depth deep \(debate_rounds 5 and risk_rounds 5\)/);
  assert.match(await tool('start_queue_item', { symbol: 'NVDA' }), /^START: NVDA is marked as being analysed\. Plan it with analysis date 2026-10-12, depth deep/);
  const running = (await call(term, 'GET', '/api/state')).json().queue[0];
  assert.deepEqual([running.state, running.date, running.progress], ['running', '2026-10-12', 'starting']);
  assert.equal((await call(term, 'DELETE', '/api/queue?symbol=NVDA')).status, 409, 'a stock being analysed stays on the list');
  await call(term, 'POST', '/api/queue', { body: { symbol: 'AAPL' } });
  assert.match(await tool('start_queue_item', { symbol: 'AAPL' }), /^BUSY: NVDA is being analysed now: one stock runs at a time/);
  assert.match(await tool('finish_queue_item', { symbol: 'NVDA' }), /^INPUT_ERROR: no call for NVDA on 2026-10-12 is recorded yet/);
  new Journal(path.join(dir(), 'journal.md')).storeDecision('NVDA', '2026-10-12', '**Rating**: Buy\n\n**Executive Summary**: Buy.');
  assert.match(await tool('finish_queue_item', { symbol: 'NVDA' }), /^Marked done: NVDA, Buy/);
  assert.match(await tool('finish_queue_item', { symbol: 'NVDA' }), /^FINISHED: NVDA is already done/);
  assert.match(await tool('start_queue_item', { symbol: 'AAPL' }), /^START/);
  assert.match(await tool('finish_queue_item', { symbol: 'AAPL', failed_because: 'Yahoo Finance did not answer: press Retry later' }), /^Marked failed: AAPL/);
  const after = (await call(term, 'GET', '/api/state')).json().queue;
  assert.deepEqual(after.map((q: any) => [q.symbol, q.state, q.rating ?? q.reason]), [['AAPL', 'failed', 'Yahoo Finance did not answer: press Retry later'], ['NVDA', 'done', 'Buy']]);
  assert.match((await call(term, 'POST', '/api/queue', { body: { symbol: 'NVDA' } })).json().error, /NVDA was already analysed today \(Buy\): its call is in the journal/);
  assert.equal((await call(term, 'POST', '/api/queue/run', { body: {} })).status, 409, 'nothing is waiting to run');
  assert.deepEqual((await call(term, 'POST', '/api/queue', { body: { symbol: 'AAPL' } })).json().queue.map((q: any) => [q.symbol, q.state]), [['AAPL', 'waiting'], ['NVDA', 'done']], 'Retry: a failed stock waits afresh');
  assert.equal((await call(term, 'POST', '/api/queue/run', { body: {} })).status, 200, 'Run now rings again');
  assert.equal((await call(term, 'DELETE', '/api/queue?symbol=NVDA')).status, 200, 'a finished stock can be taken off');
  assert.equal(await tool('end_queue_run'), "1 still waiting: another run was asked for. On the dashboard's list: 0 done, 0 failed.");
  assert.equal(readDoorbell(dir())?.why, 'more');
  for (let i = 0; i < MAX_OPEN; i++) { try { enqueue(dir(), `Q${i}`, '2026-10-12T10:00:00Z'); } catch { /* full */ } }
  assert.match((await call(term, 'POST', '/api/queue', { body: { symbol: 'ONEMORE' } })).json().error, /20 analyses are already waiting/);
  await client.close();
});

test('the paper record: every call followed at its ticket size from the closing prices, the starting money changeable, the record on the page', async () => {
  const empty = (await call(term, 'GET', '/api/paper')).json();
  assert.deepEqual([empty.since, empty.series, empty.record], [null, [], { since: null, weeks: 0, calls: 0 }]);
  new Journal(path.join(dir(), 'journal.md')).storeDecision('NVDA', '2026-09-01', '**Rating**: Buy\n\n**Executive Summary**: Buy.');
  new Journal(path.join(dir(), 'journal.md')).storeDecision('AAPL', '2026-09-02', '**Rating**: Hold\n\n**Executive Summary**: Hold.');
  const book = (await call(term, 'GET', '/api/paper')).json();
  assert.equal(book.since, '2026-09-01');
  const nvda = book.trades.find((t: any) => t.ticker === 'NVDA');
  assert.deepEqual([nvda.status, nvda.side], ['filled', 'buy']);
  assert.ok(nvda.fillDate > '2026-09-01', 'filled at the first close after the call');
  assert.equal(book.trades.find((t: any) => t.ticker === 'AAPL').status, 'none');
  assert.ok(book.series.length > 20 && book.series[0].benchmark === 10_000, 'a value a day since the first call, the S&P 500 from the same start');
  assert.deepEqual(book.record, { since: '2026-09-01', weeks: 5, calls: 2 });
  const state = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual(state.paper, { since: '2026-09-01', weeks: 5, calls: 2, startUsd: 10_000, minWeeks: 4 }, 'the page has the record without asking for prices');
  assert.match((await call(term, 'POST', '/api/paper', { body: { startUsd: 50 } })).json().error, /whole number of dollars from \$100/);
  assert.equal((await call(term, 'POST', '/api/paper', { body: { startUsd: 20_000 } })).json().startUsd, 20_000);
  assert.equal((await call(term, 'GET', '/api/state')).json().paper.startUsd, 20_000);
  assert.equal((await call(term, 'GET', '/api/paper', { token: false })).status, 401);
});

test('"Run automatically with Claude Code": started and stopped from the page, remembered across starts, and never over another listener', async () => {
  assert.equal((await call(term, 'POST', '/api/listen', { body: { on: true } })).status, 404, 'a dashboard given no way to start it has no switch');
  let started = 0, claude = true;
  const own = () => { started++; writeListener(dir(), { listener: 'Claude Code', since: new Date().toISOString(), beat: new Date().toISOString(), pid: 4242 }); };
  const t = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), listen: { start: own, claude: () => claude } });
  try {
    claude = false;
    assert.match((await call(t, 'POST', '/api/listen', { body: { on: true } })).json().error, /Claude Code is not installed on this computer/);
    claude = true;
    assert.equal((await call(t, 'POST', '/api/listen', { body: { on: true } })).json().listener.listener, 'Claude Code');
    assert.deepEqual([started, readPrefs(dir()).autorun], [1, true]);
    assert.equal((await call(t, 'GET', '/api/state')).json().analyses.listener.listener, 'Claude Code');
    assert.equal((await call(t, 'POST', '/api/prefs', { body: { autorun: false, theme: 'light' } })).json().autorun, true, "the page's other choices never change the switch");
    assert.equal((await call(t, 'POST', '/api/listen', { body: { on: false } })).json().listener, null);
    assert.deepEqual([fs.existsSync(path.join(dir(), 'listener.json')), readPrefs(dir()).autorun], [false, false], 'off: the note is taken away, and the listener ends after the run in hand');
    writeListener(dir(), { listener: 'Madav', since: new Date().toISOString(), beat: new Date().toISOString() });
    assert.match((await call(t, 'POST', '/api/listen', { body: { on: true } })).json().error, /Madav is already listening/);
    assert.match((await call(t, 'POST', '/api/listen', { body: { on: false } })).json().error, /Madav is listening, not Claude Code: switch it off there/);
    writeListener(dir(), { listener: 'Madav', since: '2026-10-01T09:00:00Z', beat: '2026-10-01T09:00:00Z' });
    assert.equal((await call(t, 'GET', '/api/state')).json().analyses.listener, null, 'a listener whose heartbeat stopped is not believed');
  } finally { await t.close(); }
  savePrefs(dir(), { autorun: true });
  started = 0;
  const again = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), listen: { start: own, claude: () => true } });
  try { assert.equal(started, 1, 'left on: started again with the dashboard'); } finally { await again.close(); }
  const third = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), listen: { start: own, claude: () => true } });
  try { assert.equal(started, 1, 'not twice: someone already listens'); } finally { await third.close(); }
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
  // the summary written as a heading, as the portfolio manager sometimes does: plain words, no marks
  const heading = '# TSLA Final Decision — Portfolio Manager, analysis date 2026-10-17\n\n**Rating**: Underweight\n\n## Executive Summary\nTrim **TSLA** into strength; the trend is *down*.\n\n## Investment Thesis\nThe 50-day average is falling.';
  assert.equal(summaryOf(heading), 'Trim TSLA into strength; the trend is down.');
  assert.equal(summaryOf('**Executive Summary:** Stay flat.\n\n**Rating**: Hold'), 'Stay flat.');
  assert.equal(summaryOf('# NVDA\n\n**Rating**: Hold\n\nKeep the position at its size. No new buying.'), 'Keep the position at its size. No new buying.', 'without a summary: the first plain sentences, no heading or rating line');
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

const TESLA = { quotes: [
  { symbol: 'TSLA', shortname: 'Tesla, Inc.', longname: 'Tesla, Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY', isYahooFinance: true },
  { symbol: 'STSLA=F', shortname: 'Tesla Inc Single Stock futures', exchDisp: 'Chicago Mercantile Exchange', quoteType: 'FUTURE', isYahooFinance: true },
  { symbol: 'TSLA.TO', shortname: 'TESLA CDR (CAD HEDGED)', longname: 'Tesla, Inc.', exchDisp: 'Toronto', quoteType: 'EQUITY', isYahooFinance: true },
  { symbol: 'TSLT', shortname: 'T-REX 2X Long Tesla Daily Targe', longname: 'T-REX 2X Long Tesla Daily Target ETF', exchDisp: 'BATS Trading', quoteType: 'ETF', isYahooFinance: true },
  { symbol: 'TSLA261218C00400000', quoteType: 'OPTION', isYahooFinance: true },
  { shortname: 'Tesla Energy (private)', quoteType: 'EQUITY', isYahooFinance: false },
  { symbol: '<img src=x>', shortname: 'bad', quoteType: 'EQUITY', isYahooFinance: true },
] };

test('a name or a ticker finds what Yahoo lists: ticker, name, market and kind, and never futures, options or a bad ticker', async () => {
  assert.deepEqual(parseSearch(TESLA).map((m) => [m.symbol, m.name, m.exchange, m.kind]), [
    ['TSLA', 'Tesla, Inc.', 'NASDAQ', 'Stock'], ['TSLA.TO', 'Tesla, Inc.', 'Toronto', 'Stock'], ['TSLT', 'T-REX 2X Long Tesla Daily Target ETF', 'BATS Trading', 'ETF'],
  ]);
  const asked: string[] = [];
  configure({ fetch: async (u, i) => { const url = String(u); if (url.includes('/v1/finance/search')) { asked.push(url); return new Response(JSON.stringify(TESLA)); } return yahoo(u, i); } });
  clearSearches();
  const r = await call(term, 'GET', '/api/search?q=Tesla');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json().matches.map((m: any) => m.symbol), ['TSLA', 'TSLA.TO', 'TSLT']);
  assert.match(asked[0]!, /\/v1\/finance\/search\?q=Tesla&quotesCount=12&newsCount=0/);
  await call(term, 'GET', '/api/search?q=tesla');
  assert.equal(asked.length, 1, 'the same words are asked of Yahoo once');
  for (const q of ['', '%20', 'a'.repeat(41), '%3Cb%3E', 'x%22y']) assert.equal((await call(term, 'GET', `/api/search?q=${q}`)).status, 400, q);
  assert.equal((await call(term, 'GET', '/api/search?q=Tesla', { token: false })).status, 401);
  configure({ fetch: async () => new Response('down', { status: 503, headers: { 'retry-after': '0' } }) });
  clearSearches();
  const down = await call(term, 'GET', '/api/search?q=Apple');
  assert.equal(down.status, 502);
  assert.match(down.json().error, /search did not answer: type the ticker instead/);
});

test('what the person chose is remembered in desk-data, each in its own shape, and nothing about an order', async () => {
  assert.deepEqual((await call(term, 'GET', '/api/prefs')).json(), {});
  const saved = (await call(term, 'POST', '/api/prefs', { body: {
    theme: 'dark', side: 'folded', view: 'account', symbol: 'nvda', range: '1Y', kind: 'candles', layers: { ma50: false, ma200: true, vol: true },
    recent: [{ symbol: 'tsla', name: 'Tesla, <b>Inc.</b>' }, { symbol: 'TSLA', name: 'again' }, { symbol: '../x', name: 'bad' }, { symbol: 'AAPL' }],
    ticket: { quantity: 5 }, confirm: 'Buy 5 NVDA at $1.00', trading: true,
  } })).json();
  assert.deepEqual(saved, { theme: 'dark', side: 'folded', view: 'account', symbol: 'NVDA', range: '1Y', kind: 'candles', layers: { ma50: false, ma200: true, vol: true }, recent: [{ symbol: 'TSLA', name: 'Tesla, Inc.' }, { symbol: 'AAPL', name: 'AAPL' }] });
  const next = (await call(term, 'POST', '/api/prefs', { body: { theme: 'purple', range: '10Y', side: 'open', layers: { ma50: 'yes' } } })).json();
  assert.deepEqual([next.theme, next.range, next.side, next.layers.ma50], ['dark', '1Y', 'open', false], 'a value it does not know leaves the one before');
  const file = JSON.parse(fs.readFileSync(path.join(dir(), 'dashboard.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['kind', 'layers', 'range', 'recent', 'side', 'symbol', 'theme', 'view']);
  const again = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS() });   // another start, or another browser, finds it as it was left
  try { assert.equal((await call(again, 'GET', '/api/prefs')).json().symbol, 'NVDA'); } finally { await again.close(); }
  const many = Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, name: '' }));
  assert.equal((await call(term, 'POST', '/api/prefs', { body: { recent: many } })).json().recent.length, MAX_RECENT);
  assert.equal((await call(term, 'POST', '/api/prefs', { body: { theme: 'light' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(term, 'POST', '/api/prefs', { body: { theme: 'light' }, token: false })).status, 401);
});

test('Start here is in the page\'s state: the whole market, the eleven sectors and the person\'s own names, each with the desk\'s latest call; and the watchlist by tier', async () => {
  const empty = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual(empty.startHere.map((t: any) => [t.tier, t.items.length]), [['market', 4], ['sectors', 11], ['names', 0]]);
  assert.deepEqual(empty.watchTiers, []);
  assert.deepEqual(empty.market, { symbols: ['SPY', 'QQQ', 'VT', 'BND'], asShipped: true, shipped: ['SPY', 'QQQ', 'VT', 'BND'], max: 8 });
  for (const s of ['NVDA', 'XLE', 'BTC-USD', 'SPY']) await call(term, 'POST', '/api/watchlist', { body: { symbol: s } });
  const j = new Journal(path.join(dir(), 'journal.md'));
  j.storeDecision('XLE', '2026-10-09', '**Rating**: Underweight\n\n**Executive Summary**: Lighten up.');
  j.storeDecision('BTC-USD', '2026-10-09', '**Rating**: Buy\n\n**Executive Summary**: A small coin position.');
  const s = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual(s.startHere.map((t: any) => t.tier), ['market', 'sectors', 'names', 'crypto']);
  const xle = s.startHere[1].items.find((i: any) => i.symbol === 'XLE');
  assert.deepEqual([xle.name, xle.call, xle.watched], ['Energy', { rating: 'Underweight', date: '2026-10-09' }, true]);
  assert.equal(s.startHere[0].items.find((i: any) => i.symbol === 'QQQ').call, null, 'no call yet: none, never made up');
  assert.deepEqual(s.watchTiers.map((t: any) => [t.tier, t.items.map((i: any) => i.symbol)]), [['market', ['SPY']], ['sectors', ['XLE']], ['names', ['NVDA']], ['crypto', ['BTC-USD']]]);
  const coin = s.calls.find((c: any) => c.ticker === 'BTC-USD');
  assert.deepEqual([coin.ticket, coin.paper], [false, true], 'a call on a coin offers no order ticket: it is followed on paper');
  assert.deepEqual(s.calls.filter((c: any) => c.ticker === 'XLE').map((c: any) => c.ticket), [true]);
});

test('the whole-market funds are the person\'s to change, each a fund Yahoo prices, checked before it is kept; only Change… sets them', async () => {
  const set = (symbols: unknown, o: Parameters<typeof call>[3] = {}) => call(term, 'POST', '/api/tiers/market', { body: { symbols }, ...o });
  for (const [symbols, status, why] of [
    [['SPY', 'BTC-USD'], 400, /BTC-USD is crypto/], [['XLK'], 400, /XLK is a sector fund/], [['^GSPC'], 400, /cannot be held/], [['../x'], 400, /not a ticker/],
    [Array.from({ length: 9 }, (_, i) => `F${i}`), 400, /up to 8 funds/], ['SPY', 400, /up to 8 funds/], [['SPY', 'ZZZZ'], 422, /no price for ZZZZ/],
  ] as const) {
    const r = await set(symbols);
    assert.deepEqual([r.status, why.test(r.json().error)], [status, true], JSON.stringify(symbols));
  }
  assert.equal(fs.existsSync(path.join(dir(), 'dashboard.json')), false, 'nothing refused is kept');
  assert.equal((await set(['VTI'], { token: false })).status, 401);
  assert.equal((await set(['VTI'], { headers: { origin: 'https://evil.example' } })).status, 403);
  const v1 = (await call(term, 'GET', '/api/version')).json().version;
  const ok = await set(['vti', 'VT', 'vti', 'DOWN']);
  assert.deepEqual([ok.status, ok.json().market.symbols, ok.json().market.asShipped], [200, ['VTI', 'VT', 'DOWN'], false], 'each once; Yahoo down cannot be checked, so it is kept and shown unavailable');
  assert.notEqual((await call(term, 'GET', '/api/version')).json().version, v1, 'the page hears of the change');
  const s = (await call(term, 'GET', '/api/state')).json();
  assert.deepEqual(s.startHere[0].items.map((i: any) => [i.symbol, i.name ?? null]), [['VTI', 'The whole US market'], ['VT', 'The whole world'], ['DOWN', null]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir(), 'dashboard.json'), 'utf8')).market, ['VTI', 'VT', 'DOWN']);
  await call(term, 'POST', '/api/prefs', { body: { market: ['BND'], theme: 'light' } });
  assert.deepEqual((await call(term, 'GET', '/api/prefs')).json().market, ['VTI', 'VT', 'DOWN'], 'the page\'s other choices never change the whole market');
  assert.deepEqual((await set([])).json().market.symbols, [], 'none at all is the person\'s choice');
  const back = (await set(['SPY', 'QQQ', 'VT', 'BND'])).json().market;
  assert.deepEqual([back.symbols, back.asShipped], [['SPY', 'QQQ', 'VT', 'BND'], true]);
  const kept = JSON.parse(fs.readFileSync(path.join(dir(), 'dashboard.json'), 'utf8'));
  assert.deepEqual(['market' in kept, kept.theme], [false, 'light'], 'the shipped four are kept as no list, so a later version\'s four reach the person');
});

test('which tiers of the watchlist are folded away is remembered, each one a tier the page knows', async () => {
  const saved = (await call(term, 'POST', '/api/prefs', { body: { folded: ['names', 'stocks', 'market', 'names', 3] } })).json();
  assert.deepEqual(saved.folded, ['market', 'names']);
  assert.deepEqual((await call(term, 'POST', '/api/prefs', { body: { folded: [] } })).json().folded, [], 'every tier open again');
  assert.deepEqual((await call(term, 'POST', '/api/prefs', { body: { folded: 'all' } })).json().folded, [], 'not a list: what was kept stays');
  assert.deepEqual(readPrefs(dir()).folded, []);
  savePrefs(dir(), { folded: ['crypto'] });
  assert.deepEqual(readPrefs(dir()).folded, ['crypto']);
});

/** 300 weekday rows to 2026-10-12, rising gently from 100; the last day's close is `times` the one before, a narrow day. */
const drifting = (times = 1, low?: number): Row[] => weekdays('2026-10-12', 300).map((date, i, all) => {
  const c = 100 + i * 0.02;
  if (i < all.length - 1) return { date, o: c, h: c + 1, l: c - 1, c, v: 1_000_000 };
  const close = (100 + (i - 1) * 0.02) * times;
  return { date, o: close, h: close + 0.2, l: low ?? close - 0.2, c: close, v: 1_000_000 };
});
/** Yahoo for "Worth a look today": XLE jumps 6%, TSLA falls 5% to a year's low, NVDA is quiet but in the news today, DOWN does not answer. */
const looking = (asked: string[]): typeof fetch => async (input) => {
  const url = String(input); asked.push(url);
  if (url.includes('/v1/finance/search')) {
    const at = Date.parse('2026-10-12T15:00:00Z') / 1000;
    return new Response(JSON.stringify({ news: url.includes('q=NVDA') ? [{ title: 'NVDA news', publisher: 'Wire', link: 'https://example.com/a', providerPublishTime: at, relatedTickers: ['NVDA'] }, { title: 'Older', publisher: 'Wire', providerPublishTime: at - 4 * 86_400, relatedTickers: ['NVDA'] }] : [] }));
  }
  const symbol = decodeURIComponent(/\/v8\/finance\/chart\/([^?]+)/.exec(url)?.[1] ?? '');
  if (symbol === 'DOWN') return new Response('down', { status: 503, headers: { 'retry-after': '0' } });
  return new Response(JSON.stringify(chartJson(symbol, symbol === 'XLE' ? drifting(1.06) : symbol === 'TSLA' ? drifting(0.95, 90) : drifting(1.001))));
};

test('"Worth a look today" is worked out from figures at most once an hour, kept for the morning routine, and the person\'s morning switch alone puts the top three on the waiting list', async () => {
  const asked: string[] = [];
  configure({ fetch: looking(asked) });
  for (const s of ['NVDA', 'TSLA']) addWatch(dir(), s, '2026-10-12');
  addWatch(dir(), 'DOWN', '2026-10-12');
  const first = (await call(term, 'GET', '/api/screen')).json();
  assert.deepEqual(first.screen.picks.map((p: any) => [p.symbol, p.why]), [
    ['TSLA', 'Fell 5.0%, a new 52-week low, crossed below its 50-day average, crossed below its 200-day average'],
    ['XLE', 'Rose 6.0%, a new 52-week high'], ['NVDA', 'In the news today (1 article)'],
  ]);
  assert.deepEqual([first.screen.looked, first.screen.unavailable, first.screen.day], [18, ['DOWN'], '2026-10-12'], 'the four whole-market funds, the eleven sectors and the watchlist; one that does not answer is said to be unavailable');
  assert.deepEqual([first.morning, first.queued], [{ on: false, top: 3 }, []], 'off as shipped: nothing goes on the waiting list');
  assert.deepEqual(readScreen(dir())!.picks.map((p) => p.symbol), ['TSLA', 'XLE', 'NVDA'], 'kept for the morning routine');
  assert.ok(!asked.some((u) => u.includes('/search') && /q=(XLE|SPY)\b/.test(u)), 'news is read for companies and coins, not funds');
  const before = asked.length;
  await call(term, 'GET', '/api/screen');
  assert.equal(asked.length, before, 'within the hour, Yahoo is not asked again');
  assert.deepEqual((await call(term, 'GET', '/api/state')).json().queue, [], 'nothing was asked for');

  const sw = (on: unknown, o: Parameters<typeof call>[3] = {}) => call(term, 'POST', '/api/screen/morning', { body: { on }, ...o });
  assert.equal((await sw('yes')).status, 400);
  assert.equal((await sw(true, { token: false })).status, 401);
  assert.equal((await sw(true, { headers: { origin: 'https://evil.example' } })).status, 403);
  await call(term, 'POST', '/api/prefs', { body: { morning: true } });
  assert.equal(readPrefs(dir()).morning, undefined, "the page's other choices never switch it on");
  new Journal(path.join(dir(), 'journal.md')).storeDecision('XLE', '2026-10-12', '**Rating**: Hold\n\n**Executive Summary**: x.');
  const on = (await sw(true)).json();
  assert.deepEqual([on.morning, on.queued], [{ on: true, top: 3 }, ['TSLA', 'NVDA']], 'switched on: today\'s top three at once, but not XLE, already called today');
  assert.deepEqual((await call(term, 'GET', '/api/state')).json().queue.map((q: any) => [q.symbol, q.state, q.depth]), [['TSLA', 'waiting', 'shallow'], ['NVDA', 'waiting', 'shallow']]);
  assert.ok(readDoorbell(dir()), 'the doorbell rings for whoever listens');
  assert.deepEqual((await call(term, 'GET', '/api/screen')).json().queued, [], 'once a day');
  assert.deepEqual((await sw(false)).json(), { morning: { on: false, top: 3 }, queued: [] });
  assert.equal(readPrefs(dir()).morning, false);
});

test('"Market weather": the trend, the mood and the rates, each from figures, and a source that fails leaves its own line unavailable', async () => {
  const rows = (closes: number[]): Row[] => weekdays('2026-10-12', closes.length).map((date, i) => ({ date, o: closes[i]!, h: closes[i]! + 1, l: closes[i]! - 1, c: closes[i]!, v: 0 }));
  const events = { events: [{ title: 'Fed Decision in October?', endDate: '2026-10-29T03:59:00Z', closed: false, markets: [{ groupItemTitle: 'No change', outcomePrices: '["0.875", "0.125"]' }, { groupItemTitle: '25 bps increase', outcomePrices: '["0.115", "0.885"]' }] }] };
  let polymarket = true;
  configure({ fetch: async (input) => {
    const url = String(input);
    if (url.includes('polymarket')) return polymarket ? new Response(JSON.stringify(events)) : new Response('down', { status: 503, headers: { 'retry-after': '0' } });
    const symbol = decodeURIComponent(/\/v8\/finance\/chart\/([^?]+)/.exec(url)?.[1] ?? '');
    return new Response(JSON.stringify(chartJson(symbol, symbol === '^VIX' ? rows([18, 27.3]) : rows(Array.from({ length: 260 }, (_, i) => 5000 + i * 5)))));
  } });
  const w = (await call(term, 'GET', '/api/weather')).json().weather;
  assert.deepEqual(w.lines.map((l: any) => [l.name, l.state, l.tone]), [['Trend', 'Rising', 'ok'], ['Mood', 'Wild', 'bad'], ['Rates', 'No change', '']]);
  assert.match(w.lines[2].words, /by 28 Oct 2026, Polymarket's crowd puts no change at 88% and a rise of 0\.25% at 12%/);
  assert.ok(w.lines.every((l: any) => l.meaning.length > 40), 'every line says what it means');
  polymarket = false;
  const kept = (await call(term, 'GET', '/api/weather')).json().weather;
  assert.equal(kept.at, w.at, 'worked out once an hour');
  const t = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS() });
  try {
    const down = (await call(t, 'GET', '/api/weather')).json().weather;
    assert.deepEqual(down.lines.map((l: any) => l.state), ['Rising', 'Wild', null]);
    assert.match(down.lines[2].words, /^Unavailable: Polymarket did not answer\.$/);
  } finally { await t.close(); }
});

test('Stop on the page stops the dashboard, from the page alone; a dashboard given no way to stop has no such door', async () => {
  assert.equal((await call(term, 'POST', '/api/stop', { body: {} })).status, 404);
  let stopped = 0;
  const t = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), stop: () => { stopped++; } });
  try {
    assert.equal((await call(t, 'POST', '/api/stop', { body: {}, token: false })).status, 401);
    assert.equal((await call(t, 'POST', '/api/stop', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(t, 'GET', '/api/stop')).status, 404);
    assert.equal(stopped, 0);
    assert.equal((await call(t, 'POST', '/api/stop', { body: {} })).json().stopping, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stopped, 1);
  } finally { await t.close(); }
});

test('after an update changes its code, the page is offered Restart; it restarts only on the person\'s press, and no ticket opens meanwhile', async () => {
  const code = path.join(root, 'code.js');
  fs.writeFileSync(code, 'one');
  let restarts = 0;
  const t = await startTerminal({ root, assets: ASSETS, port: 0, keyFile: KEYS(), code: [code], restart: () => { restarts++; }, updateCheckMs: 25 });
  const version = async () => (await call(t, 'GET', '/api/version')).json();
  try {
    const { build } = (await call(t, 'GET', '/api/ping', { token: false })).json();
    assert.match(build, /^[0-9a-f]{12}$/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await version()).update, false, 'nothing changed, nothing is offered');
    assert.equal((await call(t, 'POST', '/api/restart', { body: {} })).status, 409, 'no update, no restart');
    fs.writeFileSync(code, 'two');
    for (const until = Date.now() + 3000; !(await version()).update && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([(await version()).update, (await version()).restarting], [true, false]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(restarts, 0, 'new code on disk never runs by itself');
    assert.equal((await call(t, 'POST', '/api/restart', { body: {}, token: false })).status, 401);
    assert.equal((await call(t, 'POST', '/api/restart', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(t, 'POST', '/api/restart', { body: {} })).json().restarting, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(restarts, 1);
    assert.equal((await version()).restarting, true);
    assert.equal((await call(t, 'POST', '/api/ticket/own', { body: { symbol: 'NVDA', side: 'buy' } })).status, 503);
  } finally { await t.close(); }
});
