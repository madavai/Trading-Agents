import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agoWords, careOf, deskSymbol, dueForRerate, isStale, readRerate, rerateWeekly, stopIn, stopOf, toWatch, viewOf, watched, type CareInput, type HoldingCare, type Stop } from '../src/desk/care.js';
import { readHoldings, saveHoldings } from '../src/desk/holdings.js';
import { Journal } from '../src/desk/journal.js';
import { saveSection } from '../src/desk/runs.js';
import { enqueue, MAX_OPEN, readQueue } from '../src/desk/queue.js';
import { morningBrief, morningList } from '../src/desk/routine.js';
import { Sectors } from '../src/desk/sectors.js';
import { configure } from '../src/data/http.js';
import { DEFAULT_CAPS, readSettings } from '../src/settings.js';
import { ticketable } from '../src/terminal/tiers.js';
import { clearQuotes } from '../src/terminal/quotes.js';
import { shareHoldings, startTerminal, type Assets } from '../src/terminal/server.js';
import { deskServer } from '../src/tools/server.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import type { AccountView } from '../src/robinhood/account.js';
import { accountTools, fakeRobinhood, type Fake } from './fake-robinhood.js';
import { chartFetch, chartJson, series } from './chart.js';

const desk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-care-')); return { root, dir: path.join(root, 'desk-data') }; };
const call = (dir: string, ticker: string, date: string, rating: string) => new Journal(path.join(dir, 'journal.md')).storeDecision(ticker, date, `**Rating**: ${rating}\n\n**Executive Summary**: ${ticker} on ${date}.`);
/** One account as the dashboard reads it from Robinhood, with only what care looks at. */
const account = (key: string, agentic: boolean, held: Array<[string, number, ('stock' | 'crypto')?]>): AccountView => ({
  account: { key, last4: '0000', label: agentic ? 'Desk' : 'Individual account', agentic, isDefault: !agentic, deactivated: false },
  portfolio: null, holdings: held.map(([symbol, quantity, kind = 'stock']) => ({ symbol, quantity, averageCost: null, price: null, value: null, gainPct: null, kind })),
  unread: 0, orders: null, approvals: null, problems: [],
});
const input = (o: Partial<CareInput>): CareInput => ({ views: [], calls: [], queue: [], today: '2026-10-21', trading: readSettings('.').trading, caps: DEFAULT_CAPS, stop: () => null, bought: () => null, ticketable, ...o });
const find = (care: readonly HoldingCare[], account: string, symbol: string): HoldingCare => care.find((c) => c.account === account && c.symbol === symbol)!;

test('each holding shows the desk\'s latest view and its age; another account shows it as information, with no stop and no sell', () => {
  const calls = [{ ticker: 'NVDA', date: '2026-10-12', rating: 'Buy' }, { ticker: 'NVDA', date: '2026-10-18', rating: 'Overweight' }, { ticker: 'BTC-USD', date: '2026-10-20', rating: 'Hold' }, { ticker: 'AAPL', date: '2026-10-21', rating: 'Sell' }];
  const care = careOf(input({ calls, views: [account('ag', true, [['NVDA', 3], ['BTC', 0.01, 'crypto'], ['AMD', 2]]), account('main', false, [['NVDA', 20], ['AAPL', 10]])], stop: () => ({ level: 170, words: '170.00' }) }));
  assert.deepEqual(find(care, 'ag', 'NVDA').view, { rating: 'Overweight', date: '2026-10-18', days: 3, ago: '3 days ago' }, 'the latest call, not the first');
  assert.equal(find(care, 'ag', 'NVDA').stale, false);
  assert.deepEqual([find(care, 'ag', 'BTC').desk, find(care, 'ag', 'BTC').view?.ago], ['BTC-USD', 'yesterday'], 'a coin is called as its dollar pair');
  assert.deepEqual([find(care, 'ag', 'AMD').view, find(care, 'ag', 'AMD').stale], [null, true], 'no view yet is due one');
  assert.equal(find(care, 'ag', 'NVDA').stop?.level, 170);
  const aapl = find(care, 'main', 'AAPL');
  assert.deepEqual([aapl.view?.rating, aapl.view?.ago, aapl.agentic, aapl.sell, aapl.stop], ['Sell', 'today', false, null, null], 'view only: information, never a proposal');
  assert.equal(find(care, 'main', 'NVDA').stop, null);
  assert.deepEqual([agoWords(0), agoWords(1), agoWords(8)], ['today', 'yesterday', '8 days ago']);
  assert.equal(isStale(viewOf(calls, 'NVDA', '2026-10-25')), true, 'a week old is due again');
  assert.equal(isStale(viewOf(calls, 'NVDA', '2026-10-24')), false);
  // on the waiting list: re-rating, waiting or being analysed now
  const queued = careOf(input({ calls, views: [account('ag', true, [['NVDA', 3], ['AMD', 2]])], queue: [{ symbol: 'AMD', requestedAt: '2026-10-21T08:00:00Z', state: 'waiting' }, { symbol: 'NVDA', requestedAt: '2026-10-21T08:00:00Z', state: 'running' }, { symbol: 'TSLA', requestedAt: '2026-10-21T08:00:00Z', state: 'done' }] }));
  assert.deepEqual(queued.map((c) => c.rerating), ['running', 'waiting']);
  assert.deepEqual([deskSymbol('ETH', 'crypto'), deskSymbol('BTCUSD', 'crypto'), deskSymbol('BRK.B', 'stock')], ['ETH-USD', 'BTC-USD', 'BRK.B']);
});

test('the trader\'s stop is its labelled line, one price level alone; a sum, a percentage or "not provided" is never taken for one', () => {
  const plan = (line: string) => `**Action**: Buy\n\n**Reasoning**: Support at 186; 189.50 - 1.5 x 2.80 = 185.30.\n\n**Entry Price**: 189.50\n${line}\n**Position Sizing**: 2% of the account`;
  assert.deepEqual(stopOf(plan('**Stop Loss**: 185.30')), { level: 185.3, words: '185.30' });
  assert.equal(stopOf(plan('- **Stop Loss**: $1,185.30 (1.5 ATR below the entry)'))?.level, 1185.3);
  assert.equal(stopOf(plan('**Stop-Loss:** 185 USD'))?.level, 185);
  for (const bad of ['**Stop Loss**: not provided', '**Stop Loss**: 189.50 − 4.20 = 185.30', '**Stop Loss**: 1.5 × ATR below the entry', '**Stop Loss**: 2% below the entry', '**Stop Loss**: 189.50 - 4.20', '**Stop Loss**: below 185', '**Stop Loss**: 0']) {
    const s = stopOf(plan(bad));
    assert.equal(s?.level, null, bad);
    assert.ok(s?.words, 'the words stay, for the page to show');
  }
  assert.equal(stopOf('**Action**: Hold\n\n**Reasoning**: Wait.'), null, 'no line: no stop, never made up');
  // the dashboard reads it from the trader's part of the call's run
  const { dir } = desk();
  saveSection(dir, 'NVDA', '2026-10-19', 'trader', plan('**Stop Loss**: 185.30'));
  assert.equal(stopIn(dir, 'NVDA', '2026-10-19')?.level, 185.3);
  assert.equal(stopIn(dir, 'NVDA', '2026-10-20'), null, 'no run that day');
  // and the trader is asked to write it that way
  const trader = fs.readFileSync('.claude/agents/trader.md', 'utf8');
  assert.match(trader, /\*\*Stop Loss\*\*: one price level alone, below the price now, for example 185\.30, or "not provided"/);
  assert.match(trader, /the dashboard watches the price and tells the person when it falls below it \(it never sells by itself\)/);
  assert.match(trader, /\*\*Entry Price\*\*: one price level alone/);
});

test('the stop watch: a price under the trader\'s level marks the holding, a price at or above it does not, and a price that cannot be had marks nothing', () => {
  const views = [account('ag', true, [['NVDA', 3], ['AMD', 2], ['TSLA', 1], ['META', 1]]), account('main', false, [['NVDA', 20]])];
  const calls = ['NVDA', 'AMD', 'TSLA', 'META'].map((ticker) => ({ ticker, date: '2026-10-20', rating: 'Hold' }));
  const stops: Record<string, Stop> = { NVDA: { level: 185.3, words: '185.30' }, AMD: { level: 150, words: '150' }, TSLA: { level: null, words: 'not provided' }, META: { level: 600, words: '600' } };
  const care = careOf(input({ views, calls, stop: (ticker) => stops[ticker] ?? null }));
  assert.deepEqual(toWatch(care), ['NVDA', 'AMD', 'META'], 'the Agentic account\'s alone, and only a stop at a price level');
  const at = '2026-10-21T15:00:00Z', w = watched(care, new Map([['NVDA', { value: 182.4, asOf: at }], ['AMD', { value: 150, asOf: at }]]));
  assert.deepEqual([find(w, 'ag', 'NVDA').below, find(w, 'ag', 'NVDA').price], [true, { value: 182.4, asOf: at }]);
  assert.equal(find(w, 'ag', 'AMD').below, false, 'at the stop is not below it');
  assert.deepEqual([find(w, 'ag', 'META').below, find(w, 'ag', 'META').price], [false, null], 'no price: unwatched for now, never marked');
  assert.deepEqual([find(w, 'ag', 'TSLA').below, find(w, 'ag', 'TSLA').stop?.words], [false, 'not provided']);
  assert.deepEqual([find(w, 'main', 'NVDA').below, find(w, 'main', 'NVDA').price], [false, null], 'view only: no stop is watched');
  assert.equal(find(care, 'ag', 'NVDA').below, false, 'the care it was given is left as it was');
});

test('a Sell or Underweight on a holding of the Agentic account says "the desk says sell", sized by the rating, within the shortest hold; elsewhere it is information only', () => {
  const views = [account('ag', true, [['NVDA', 4], ['AMD', 2], ['TSLA', 1], ['BTC', 0.1, 'crypto']]), account('main', false, [['AMD', 10]])];
  const calls = [{ ticker: 'NVDA', date: '2026-10-20', rating: 'Underweight' }, { ticker: 'AMD', date: '2026-10-21', rating: 'Sell' }, { ticker: 'TSLA', date: '2026-10-21', rating: 'Hold' }, { ticker: 'BTC-USD', date: '2026-10-21', rating: 'Sell' }];
  const care = careOf(input({ views, calls, caps: { ...DEFAULT_CAPS, minHoldDays: 3 }, bought: (s) => (s === 'AMD' ? { boughtOn: '2026-10-20', heldDays: 1 } : null) }));
  assert.deepEqual(find(care, 'ag', 'NVDA').sell, { action: 'sell half of what is held', ticket: true, early: null });
  assert.deepEqual(find(care, 'ag', 'AMD').sell, { action: 'sell everything held', ticket: true, early: { boughtOn: '2026-10-20', heldDays: 1, minHoldDays: 3 } });
  assert.equal(find(care, 'ag', 'TSLA').sell, null, 'a Hold asks for no sale');
  assert.equal(find(care, 'ag', 'BTC').sell?.ticket, false, 'a coin gets no ticket: Robinhood\'s agent doorway trades stocks and funds');
  assert.equal(find(care, 'main', 'AMD').sell, null, 'another account: information only');
  const held3 = careOf(input({ views, calls, caps: { ...DEFAULT_CAPS, minHoldDays: 1 }, bought: () => ({ boughtOn: '2026-10-20', heldDays: 1 }) }));
  assert.equal(find(held3, 'ag', 'AMD').sell?.early, null, 'held as long as the shortest hold: no longer early');
});

test('each Monday the morning routine re-rates the Agentic account\'s holdings with no view or one a week old, the stalest first, at most three, once, at shallow depth', () => {
  const { dir } = desk();
  // what the dashboard shares with the agents: the Agentic account's holdings are the book; a coin is named as the desk calls it
  assert.equal(shareHoldings(dir, { at: '2026-10-24T15:00:00Z', views: [
    account('ag', true, [['AAPL', 1], ['MSFT', 1], ['AMD', 1], ['NVDA', 1], ['TSLA', 1], ['META', 1], ['BTC', 0.1, 'crypto']]),
    account('main', false, [['GOOG', 5]]),
  ] }, '2026-10-24'), true);
  assert.deepEqual(readHoldings(dir)?.positions.map((p) => p.ticker), ['AAPL', 'MSFT', 'AMD', 'NVDA', 'TSLA', 'META', 'BTC-USD']);
  call(dir, 'AAPL', '2026-10-24', 'Buy');        // 2 days old on Monday: fresh
  call(dir, 'MSFT', '2026-10-19', 'Hold');       // 7 days: due
  call(dir, 'AMD', '2026-10-16', 'Hold');        // 10 days: due
  call(dir, 'TSLA', '2026-10-18', 'Overweight'); // 8 days: due
  call(dir, 'BTC-USD', '2026-10-23', 'Hold');    // 3 days: fresh
  enqueue(dir, 'META', '2026-10-25T20:00:00Z');  // asked for on the dashboard already: not twice
  assert.deepEqual(dueForRerate(dir, '2026-10-26').map((d) => d.symbol), ['NVDA', 'AMD', 'TSLA', 'MSFT'], 'no view first, then the oldest; GOOG is in a view-only account');

  assert.deepEqual(rerateWeekly(dir, '2026-10-27'), [], 'a Tuesday re-rates nothing');
  const now = new Date('2026-10-26T12:00:00Z');
  const queued = rerateWeekly(dir, '2026-10-26', now);
  assert.deepEqual(queued, [{ symbol: 'NVDA', called: null, rating: null }, { symbol: 'AMD', called: '2026-10-16', rating: 'Hold' }, { symbol: 'TSLA', called: '2026-10-18', rating: 'Overweight' }]);
  assert.deepEqual(readQueue(dir, now).map((q) => [q.symbol, q.state, q.depth ?? 'settings']), [['META', 'waiting', 'settings'], ['NVDA', 'waiting', 'shallow'], ['AMD', 'waiting', 'shallow'], ['TSLA', 'waiting', 'shallow']]);
  assert.deepEqual(rerateWeekly(dir, '2026-10-26', now), queued, 'once a Monday: asked again, it puts nothing more on the list');
  assert.equal(readQueue(dir, now).length, 4);
  assert.equal(readRerate(dir)?.day, '2026-10-26');

  const brief = morningBrief(dir, '2026-10-26', 5);
  assert.match(brief, /Monday's re-rating, of the holdings the desk sizes trades to: NVDA \(the desk has no view of it yet\), AMD \(its latest view: Hold on 2026-10-16\), TSLA \(its latest view: Overweight on 2026-10-18\) were put on the waiting list at shallow depth, for a view under 7 days old \(at most 3 a Monday\)/);
  assert.match(brief, /Due as well, left for next Monday: MSFT\./);
  assert.match(brief, /4 of at most 5 a morning[\s\S]*1\. META \(asked for on the dashboard, the settings' depth\)[\s\S]*2\. NVDA \(a holding re-rated this Monday \(the desk has no view of it yet\), shallow depth\)/);
  assert.match(brief, /for a re-rated holding, its new rating beside its last one/);
  assert.match(brief, /"the desk says sell", with a Sell button that opens a ticket: nothing is ever sold by itself/);
  assert.deepEqual(morningList(dir, '2026-10-26', 3).later, ['TSLA'], 'within the routine\'s limit: the rest wait for another run');
  assert.ok(!morningBrief(dir, '2026-10-27', 5).includes("Monday's re-rating"), 'only on a Monday');

  // holdings not known, a flat book, a full waiting list, and what the person said they hold
  assert.match(morningBrief(desk().dir, '2026-10-26', 5), /Monday's re-rating, of the holdings the desk sizes trades to: they are not known/);
  const flat = desk().dir; saveHoldings(flat, { positions: [] }, '2026-10-24');
  assert.match(morningBrief(flat, '2026-10-26', 5), /nothing is held, so there is nothing to re-rate/);
  const full = desk().dir; saveHoldings(full, { positions: [{ ticker: 'NVDA', quantity: 2 }] }, '2026-10-24');
  for (let i = 0; i < MAX_OPEN; i++) enqueue(full, `S${String(i).padStart(2, '0')}`, '2026-10-25T20:00:00Z');
  assert.deepEqual(rerateWeekly(full, '2026-10-26', now), []);
  assert.match(morningBrief(full, '2026-10-26', 5), /NVDA is due, but the waiting list is full, so nothing went on it/);
  const said = desk().dir; saveHoldings(said, { positions: [{ ticker: 'NVDA', quantity: 2 }] }, '2026-10-24');
  assert.match(morningBrief(said, '2026-10-26', 5), /NVDA is due, but the re-rating could not put it on the waiting list today/, 'a re-rating that did not run is said, never taken for a full list');
  assert.deepEqual(rerateWeekly(said, '2026-10-26', now).map((s) => s.symbol), ['NVDA'], 'what the person said they hold is cared for too');
  const noAgentic = desk().dir;
  assert.equal(shareHoldings(noAgentic, { at: '2026-10-24T15:00:00Z', views: [account('main', false, [['GOOG', 5]])] }, '2026-10-24'), true);
  assert.match(morningBrief(noAgentic, '2026-10-26', 5), /the Agentic account is not among the accounts shown on the dashboard, so nothing was re-rated/);
  assert.match(morningBrief(said, '2026-10-26', 5), /NVDA \(the desk has no view of it yet\) was put on the waiting list[\s\S]*It is analysed in step 2/);
});

test('the routine brief re-rates on a Monday through the desk tool, before the morning switch, and rings no doorbell', async () => {
  const { root, dir } = desk();
  saveHoldings(dir, { positions: [{ ticker: 'NVDA', quantity: 2 }, { ticker: 'AMD', quantity: 1 }] }, '2026-10-24');
  call(dir, 'AMD', '2026-10-25', 'Hold');
  process.env.TRADING_AGENTS_TODAY = '2026-10-26';
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, chartFetch(() => series('2026-10-26', 300))).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  try {
    const text = ((await client.callTool({ name: 'routine_brief', arguments: { kind: 'morning' } })) as { content: Array<{ text: string }> }).content[0]!.text;
    assert.match(text, /^MORNING ROUTINE for Monday 2026-10-26\./);
    assert.match(text, /NVDA \(the desk has no view of it yet\) was put on the waiting list at shallow depth/);
    assert.match(text, /1\. NVDA \(a holding re-rated this Monday/);
    assert.deepEqual(readQueue(dir).map((q) => [q.symbol, q.depth]), [['NVDA', 'shallow']], 'AMD was called yesterday: fresh');
    assert.equal(fs.existsSync(path.join(dir, 'doorbell.json')), false, 'the routine analyses what waits itself');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'routine_brief')!;
    assert.match(tool.description ?? '', /on a Monday, up to three holdings with no view or one a week old or more go on it at shallow depth/);
  } finally { await client.close(); delete process.env.TRADING_AGENTS_TODAY; }
});

// ---------- through the dashboard ----------
let fake: Fake | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };
/** Yahoo's one-day answer at a price for each symbol given, and no data for any other. */
const yahooAt = (prices: Record<string, number>): typeof fetch => async (input) => {
  const m = /\/v8\/finance\/chart\/([^?]+)/.exec(String(input)), symbol = m ? decodeURIComponent(m[1]!) : '';
  if (!(symbol in prices)) return new Response(JSON.stringify({ chart: { result: null, error: { description: 'No data found' } } }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(chartJson(symbol, [{ date: '2026-10-21', o: prices[symbol]!, h: prices[symbol]!, l: prices[symbol]!, c: prices[symbol]!, v: 1000 }], { regularMarketPrice: prices[symbol], regularMarketTime: Date.parse('2026-10-21T15:00:00Z') / 1000 })), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('on the dashboard: each holding with the desk\'s view, the Agentic account\'s stop watched at Yahoo\'s price, and Sell… opening the ticket its rating sizes, nothing sent', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-10-21';
  const o = { placed: [] as Array<Record<string, unknown>>, agenticBuyingPower: '2500.00', agenticPositions: [{ symbol: 'NVDA', quantity: '4.0000', average_buy_price: '170.00' }, { symbol: 'AMD', quantity: '2.0000', average_buy_price: '150.00' }] };
  fake = await fakeRobinhood((calls) => accountTools(calls, o));
  const port = await freePort(), file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-care-rh-')), 'sign-in.json');
  await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
  const link = new Link(file, { url: fake.url, port });
  await link.choose((await link.accounts()).accounts.filter((a) => !a.deactivated).map((a) => a.key));
  const { root, dir } = desk();
  call(dir, 'NVDA', '2026-10-20', 'Underweight'); call(dir, 'AMD', '2026-10-11', 'Hold'); call(dir, 'AAPL', '2026-10-21', 'Sell');
  saveSection(dir, 'NVDA', '2026-10-20', 'trader', '**Action**: Sell\n\n**Stop Loss**: 185.30');
  saveSection(dir, 'AMD', '2026-10-11', 'trader', '**Action**: Hold\n\n**Stop Loss**: 120.00');
  clearQuotes(); configure({ fetch: yahooAt({ NVDA: 182.4, AMD: 140 }) });
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]) as Assets, port: 0, robinhood: link, keyFile: path.join(path.dirname(file), 'dashboard.json'), sectors: new Sectors(async () => ({ sector: 'Technology', fund: false })) });
  const get = async (p: string) => (await fetch(`${term.url}${p.slice(1)}`, { headers: { 'x-desk-token': term.token } })).json() as Promise<{ at: string | null; holdings: HoldingCare[] }>;
  const post = async (p: string, body: unknown) => { const r = await fetch(`${term.url}${p.slice(1)}`, { method: 'POST', headers: { 'x-desk-token': term.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as Record<string, any> }; };
  try {
    assert.deepEqual(await get('/api/care'), { at: null, holdings: [] }, 'nothing read from Robinhood yet: nothing said');
    assert.equal((await post('/api/robinhood/refresh', {})).status, 200);
    const { holdings, at } = await get('/api/care'), of = (agentic: boolean, symbol: string) => holdings.find((c) => c.agentic === agentic && c.symbol === symbol)!;
    assert.ok(at);
    const nvda = of(true, 'NVDA');
    assert.deepEqual([nvda.view?.rating, nvda.view?.ago, nvda.stop?.level, nvda.price?.value, nvda.below], ['Underweight', 'yesterday', 185.3, 182.4, true]);
    assert.deepEqual(nvda.sell, { action: 'sell half of what is held', ticket: true, early: null });
    const amd = of(true, 'AMD');
    assert.deepEqual([amd.view?.ago, amd.stale, amd.stop?.level, amd.price?.value, amd.below, amd.sell], ['10 days ago', true, 120, 140, false, null]);
    const aapl = of(false, 'AAPL');
    assert.deepEqual([aapl.view?.rating, aapl.sell, aapl.stop, aapl.below], ['Sell', null, null, false], 'the default account is view only: the view, never a proposal');
    assert.deepEqual([of(false, 'NVDA').stop, of(false, 'NVDA').below], [null, false]);
    // Sell… opens the call's own ticket: half of the four held, at Robinhood's live price, and nothing is sent
    const t = await post('/api/ticket', { symbol: 'NVDA', date: '2026-10-20' });
    assert.equal(t.status, 200);
    assert.deepEqual([t.json.proposal.action, t.json.proposal.order.side, t.json.proposal.order.quantity, t.json.proposal.order.limitPrice], ['sell half of what is held', 'sell', 2, 182.4]);
    assert.deepEqual(o.placed, []);
    // on the waiting list, the holding shows as re-rating
    enqueue(dir, 'AMD', new Date().toISOString(), 'shallow');
    assert.equal((await get('/api/care')).holdings.find((c) => c.agentic && c.symbol === 'AMD')?.rerating, 'waiting');
  } finally { await term.close(); delete process.env.TRADING_AGENTS_TODAY; }
});
