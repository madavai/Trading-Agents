import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parsePlaced, Placer } from '../src/robinhood/order.js';
import { Refused } from '../src/robinhood/reader.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { Journal } from '../src/desk/journal.js';
import { DEFAULT_CAPS, type Caps } from '../src/settings.js';
import { logOrder } from '../src/desk/orders.js';
import { confirmWords, placedToday, startTerminal, type Assets, type TerminalOptions } from '../src/terminal/server.js';
import { accountTools, AGENTIC, fakeRobinhood, MAIN, type Fake } from './fake-robinhood.js';

const ORDER = { symbol: 'NVDA', side: 'buy' as const, quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' as const };
const UUID = '0b6f6a52-2f3c-4f4e-9b1a-6a0c5e3d2a11';

test('the placer places only a whole-share limit order on the Agentic account, with Robinhood\'s duplicate protection', async () => {
  const calls: string[] = [], placed: Array<Record<string, unknown>> = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  await accountTools(calls, { placed }).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  const p = new Placer(client, (await client.listTools()).tools);
  await assert.rejects(p.place({ accountNumber: MAIN, agentic: false }, ORDER, UUID), Refused);
  await assert.rejects(p.place({ accountNumber: AGENTIC, agentic: true }, { ...ORDER, quantity: 1.5 }, UUID), /not complete/);
  await assert.rejects(p.place({ accountNumber: AGENTIC, agentic: true }, ORDER, 'not-a-uuid'), /not complete/);
  assert.deepEqual(calls, []);
  const r = await p.place({ accountNumber: AGENTIC, agentic: true }, ORDER, UUID);
  assert.deepEqual(placed, [{ account_number: AGENTIC, symbol: 'NVDA', side: 'buy', type: 'limit', quantity: '1', limit_price: '182.40', time_in_force: 'gfd', market_hours: 'regular_hours', ref_id: UUID }]);
  assert.deepEqual([r.answered, r.approvalRequired, r.orderId, r.state], [true, true, '6f1c2b9e-0000-4000-8000-00000000abcd', 'queued']);
  await client.close();
});

test('Robinhood\'s answer to an order is read into its id, state and approval flag; a refusal keeps its words, without account numbers', () => {
  assert.equal(parsePlaced({ failed: true, text: 'account 5RH88004321 cannot trade', data: null }).error, 'account ##### cannot trade');
  const r = parsePlaced({ failed: false, text: '', data: { data: { order: { id: 'abc', state: 'confirmed' }, customer_approval_required: false, account_number: '5RH88004321' } } });
  assert.deepEqual([r.orderId, r.state, r.approvalRequired], ['abc', 'confirmed', false]);
  assert.ok(!JSON.stringify(r).includes('5RH88004321'));
});

test('only three doors call Robinhood, each naming its tools; the agents\' tool server holds none of the order doors', () => {
  const files = (fs.readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\\/g, '/'));
  assert.deepEqual(files.filter((f) => /\.callTool\(/.test(fs.readFileSync(path.join('src', f), 'utf8'))).sort(), ['robinhood/order.ts', 'robinhood/reader.ts', 'robinhood/review.ts']);
  const named = (f: string) => [...new Set(fs.readFileSync(f, 'utf8').match(/\b(?:get|list|place|cancel|review|preview|replace|decline|submit|create)_[a-z_]+/g))];
  assert.deepEqual(named('src/robinhood/order.ts'), ['place_equity_order']);
  assert.deepEqual(named('src/robinhood/review.ts'), ['review_equity_order']);
  // who can run the order door: a type-only import carries no code
  const importers = files.filter((f) => /^import (?!type )[^;]*from '\.{1,2}\/(?:robinhood\/)?order\.js'/m.test(fs.readFileSync(path.join('src', f), 'utf8')));
  assert.deepEqual(importers.sort(), ['robinhood/connect.ts']);
  const tools = fs.readFileSync('dist/desk-tools.mjs', 'utf8');
  for (const word of ['place_equity_order', 'review_equity_order', 'cancel_equity_order', '/api/ticket']) assert.ok(!tools.includes(word), `the agents' tool server must not contain ${word}`);
});

// ---------- through the dashboard ----------
let fake: Fake | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };

/** A desk with a signed-in, chosen Agentic account. `caps` are set the way the person sets them, beside the switch; the
 *  project's settings file is given wide-open caps, which must never be read. */
async function desk(caps?: Partial<Caps>, more: Partial<TerminalOptions> = {}) {
  const o = { placed: [] as Array<Record<string, unknown>>, reviewed: [] as Array<Record<string, unknown>>, agenticBuyingPower: '2500.00', agenticPositions: [] as unknown[] };
  fake = await fakeRobinhood((calls) => accountTools(calls, o));
  const port = await freePort(), file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pl-')), 'sign-in.json');
  await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
  const link = new Link(file, { url: fake.url, port });
  if (caps) link.setCaps({ ...DEFAULT_CAPS, ...caps });
  const { accounts } = await link.accounts();
  await link.choose(accounts.filter((a) => !a.deactivated).map((a) => a.key));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pl-term-')), dir = path.join(root, 'desk-data');
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify({ trading: { caps: { perOrderUsd: 100_000, perStockPercent: 100, ordersPerDay: 50 } } }));
  new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', '2026-10-15', '**Rating**: Buy\n\n**Executive Summary**: Buy.');
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]) as Assets, port: 0, robinhood: link, keyFile: path.join(path.dirname(file), 'dashboard.json'), ...more });
  const post = async (p: string, body: unknown) => { const r = await fetch(`${term.url}${p.slice(1)}`, { method: 'POST', headers: { 'x-desk-token': term.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, body: t, json: () => JSON.parse(t) }; };
  const ticket = async () => (await post('/api/ticket', { symbol: 'NVDA', date: '2026-10-15' })).json() as { id: string };
  return { o, link, file, dir, term, post, ticket };
}

test('an order is placed only with trading switched on, after Robinhood\'s clean check, on a Confirm naming that exact order, once', async () => {
  const { o, file, dir, term, post, ticket } = await desk();
  try {
    const t = await ticket();
    assert.equal((await post('/api/ticket/place', { id: t.id, confirm: confirmWords(ORDER) })).status, 403, 'trading is off');
    assert.equal((await post('/api/trading', { on: true })).status, 400, 'switching on needs the page\'s confirmation');
    const young = await post('/api/trading', { on: true, confirm: 'switch trading on' });
    assert.equal(young.status, 400, 'under four weeks of record, the person sees the record and says they understand');
    assert.match(young.json().error, /^the desk has 0 weeks and 1 call of record, under four weeks: confirm on the page that you understand$/);
    assert.equal((await post('/api/trading', { on: true, confirm: 'switch trading on', understood: true })).json().on, true);
    const kept = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'trading.json'), 'utf8'));
    assert.deepEqual([kept.on, kept.caps], [true, DEFAULT_CAPS], 'the switch and the caps are kept together beside the sign-in, where agents are refused');

    assert.match((await post('/api/ticket/place', { id: t.id, confirm: confirmWords(ORDER) })).json().error, /have Robinhood check this order first/);
    const reviewed = (await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).json();
    assert.equal(reviewed.confirm, 'Buy 1 NVDA at $182.40');
    assert.match((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 2 NVDA at $182.40' })).json().error, /does not name this order/);
    assert.deepEqual(o.placed, []);

    const ok = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual([ok.json().placed.answered, ok.json().placed.approvalRequired, ok.json().placed.state], [true, true, 'queued']);
    const sent = o.placed as unknown as Array<Record<string, unknown>>;   // the earlier empty check narrowed its type
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0], ref_id: 'x' }, { account_number: AGENTIC, symbol: 'NVDA', side: 'buy', type: 'limit', quantity: '1', limit_price: '182.40', time_in_force: 'gfd', market_hours: 'regular_hours', ref_id: 'x' });
    assert.match(String(sent[0]!.ref_id), /^[0-9a-f-]{36}$/);
    for (const n of [MAIN, AGENTIC]) assert.ok(!ok.body.includes(n));

    assert.equal((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 409, 'a ticket sends one order');
    assert.equal((await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).status, 409);
    assert.equal(o.placed.length, 1);
    const log = fs.readFileSync(path.join(dir, 'orders.jsonl'), 'utf8');
    assert.equal(log.trim().split('\n').length, 1);
    for (const n of [MAIN, AGENTIC]) assert.ok(!log.includes(n), 'no account number in the desk\'s order log');
    assert.equal(placedToday(dir, new Date()), 1);
  } finally { await term.close(); }
});

test('the person\'s own order takes the same road: one share to start, stocks only, Robinhood\'s clean check, the switch, their exact Confirm', async () => {
  const { o, dir, term, post, link } = await desk();
  try {
    assert.match((await post('/api/ticket/own', { symbol: 'BTC-USD', side: 'buy' })).json().error, /stocks only/);
    assert.match((await post('/api/ticket/own', { symbol: '^GSPC', side: 'buy' })).json().error, /stocks only/);
    assert.match((await post('/api/ticket/own', { symbol: 'NVDA' })).json().error, /buy or to sell/);
    const sell = (await post('/api/ticket/own', { symbol: 'NVDA', side: 'sell' })).json();
    assert.deepEqual([sell.own, sell.proposal.order], [true, null], 'nothing held to sell, so nothing is proposed');

    const t = (await post('/api/ticket/own', { symbol: 'NVDA', side: 'buy' })).json();
    assert.deepEqual([t.own, t.proposal.action, t.proposal.order.quantity, t.proposal.order.limitPrice], [true, 'your own buy', 1, 182.4]);
    assert.equal((await post('/api/ticket/review', { id: t.id, quantity: 3, limitPrice: 182.4 })).status, 400, 'three shares are over the $500 cap: not even sent to Robinhood for its check');
    assert.equal(o.reviewed.length, 0);
    assert.equal((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 403, 'trading is off');
    link.setTrading(true);
    assert.match((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).json().error, /have Robinhood check this order first/);
    assert.equal((await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).json().confirm, 'Buy 1 NVDA at $182.40');
    assert.match((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA' })).json().error, /does not name this order/);
    const ok = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(o.placed.length, 1);
    assert.equal((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 409, 'a ticket sends one order');
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'orders.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    assert.deepEqual([line.own, line.call, line.symbol, line.side, line.quantity], [true, undefined, 'NVDA', 'buy', 1], 'logged as the person\'s own order, not a call\'s');
  } finally { await term.close(); }
});

test('the weekly loss limit: the account\'s value is noted on every read, and a fall past the limit switches trading off with its reason, even while an order is being sent', async () => {
  const { o, file, term, post, ticket, link } = await desk();
  try {
    const now = new Date(), yesterday = new Date(now.getTime() - 86_400_000);
    link.setTrading(true);
    assert.equal(link.noteValue(2_600, yesterday).on, true, 'a small fall is fine');
    assert.equal(link.noteValue(2_550, now).on, true, '1.9% below the week\'s high of $2,600: under 5%');
    const t = await ticket();
    await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
    link.noteValue(2_700, now);   // a higher reading today: the week's high is now $2,700
    const sent = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
    assert.equal(sent.status, 400, 'reading the account just before sending found $2,500, 7.4% below $2,700');
    assert.match(sent.json().error, /^trading switched itself off: The Agentic account fell 7\.4% below its highest value of the last seven days \(\$2,700\.00 on \d{4}-\d{2}-\d{2}, now \$2,500\.00\), past your weekly limit of 5%/);
    assert.deepEqual(o.placed, [], 'nothing was sent');
    const state = link.trading();
    assert.equal(state.on, false);
    assert.match(state.offBecause!.words, /A large withdrawal can do this too/);
    const kept = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'values.json'), 'utf8')) as Array<{ day: string; high: number; last: number }>;
    assert.deepEqual(kept.map((d) => [d.high, d.last]), [[2_600, 2_600], [2_700, 2_500]], 'one entry a day: its highest and its latest reading, in the private folder');
    assert.equal((await post('/api/trading', { on: true, confirm: 'switch trading on', understood: true })).json().offBecause, null, 'switching it back on clears the reason');
    link.forget();
    assert.equal(fs.existsSync(path.join(path.dirname(file), 'values.json')), false, 'disconnecting forgets the account\'s values');
  } finally { await term.close(); }
});

test('the shortest hold: the desk proposes no early sell of a stock bought here, and your own early sell takes one more press', async () => {
  const { o, dir, term, post, link } = await desk();
  try {
    o.agenticPositions = [{ symbol: 'NVDA', quantity: '3.0000', average_buy_price: '170.00' }];
    logOrder(dir, { at: new Date(Date.now() - 86_400_000).toISOString(), symbol: 'NVDA', side: 'buy', quantity: 3, limitPrice: 170, robinhood: { answered: true, approvalRequired: false, orderId: 'x', state: 'filled', error: null } });
    link.setTrading(true);
    const own = (await post('/api/ticket/own', { symbol: 'NVDA', side: 'sell' })).json();
    assert.equal(own.proposal.order.quantity, 1);
    const ask = own.checks.find((c: { ask?: boolean }) => c.ask);
    assert.match(ask.words, /^NVDA was bought here on \d{4}-\d{2}-\d{2}, [01] trading day\(s\) ago, under your shortest hold of 5: selling it now takes one more press$/);
    assert.match((await post('/api/ticket/review', { id: own.id, quantity: 1, limitPrice: 182.4 })).json().error, /bought here under your shortest hold: press "Sell anyway" to go on/);
    assert.deepEqual(o.reviewed, [], 'not even sent for Robinhood\'s check');
    assert.equal((await post('/api/ticket/review', { id: own.id, quantity: 1, limitPrice: 182.4, early: true })).status, 200);
    assert.match((await post('/api/ticket/place', { id: own.id, confirm: 'Sell 1 NVDA at $182.40' })).json().error, /press "Sell anyway"/, 'and again at Place');
    assert.equal((await post('/api/ticket/place', { id: own.id, confirm: 'Sell 1 NVDA at $182.40', early: true })).status, 200);
    assert.equal(o.placed.length, 1);
  } finally { await term.close(); }
});

test('every cap is checked again on Robinhood\'s latest figures just before sending; the desk\'s own log counts toward orders a day', async () => {
  const { o, term, post, ticket, link } = await desk({ perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 1 });
  try {
    link.setTrading(true);
    const t = await ticket();
    await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
    o.agenticBuyingPower = '100.00';   // spent elsewhere since the check
    const stale = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
    assert.equal(stale.status, 400);
    assert.match(stale.json().error, /no longer passes on Robinhood's latest figures: Buying power is \$100\.00: not enough/);
    assert.deepEqual(o.placed, []);

    o.agenticBuyingPower = '2500.00';
    const again = await ticket();
    await post('/api/ticket/review', { id: again.id, quantity: 1, limitPrice: 182.4 });
    assert.equal((await post('/api/ticket/place', { id: again.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 200);
    const third = await ticket();
    await post('/api/ticket/review', { id: third.id, quantity: 1, limitPrice: 182.4 }).catch(() => undefined);
    const over = await post('/api/ticket/place', { id: third.id, confirm: 'Buy 1 NVDA at $182.40' });
    assert.notEqual(over.status, 200, 'one order a day, already used by the desk itself');
    assert.equal(o.placed.length, 1);
  } finally { await term.close(); }
});

test('the caps are the person\'s own: kept beside the trading switch, changed only from the page, and never read from the project\'s settings file', async () => {
  const { file, term, post, link } = await desk();
  try {
    const first = (await post('/api/ticket', { symbol: 'NVDA', date: '2026-10-15' })).json();
    assert.deepEqual(first.caps, DEFAULT_CAPS, 'the shipped caps, not the wide-open ones written into desk-settings.json');
    assert.equal((await post('/api/trading', { caps: { ...DEFAULT_CAPS, perOrderUsd: 50_000_000 } })).status, 400, 'out of range');
    assert.equal((await post('/api/trading', { caps: { ...DEFAULT_CAPS, ordersPerDay: 2.5 } })).status, 400, 'orders a day are whole');
    assert.equal((await post('/api/trading', { caps: { perOrderUsd: 300 } })).status, 400, 'every limit or nothing');
    const set = (await post('/api/trading', { caps: { ...DEFAULT_CAPS, perOrderUsd: 300, ordersPerDay: 2 } })).json();
    assert.deepEqual([set.on, set.caps], [false, { ...DEFAULT_CAPS, perOrderUsd: 300, ordersPerDay: 2 }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'trading.json'), 'utf8')), { on: false, caps: { ...DEFAULT_CAPS, perOrderUsd: 300, ordersPerDay: 2 } });
    const next = (await post('/api/ticket', { symbol: 'NVDA', date: '2026-10-15' })).json();
    assert.deepEqual([next.caps.perOrderUsd, next.proposal.order.quantity], [300, 1]);
    const words = (await post('/api/ticket/check', { id: next.id, quantity: 2, limitPrice: 182.4 })).json().checks.map((c: { words: string }) => c.words).join(' | ');
    assert.match(words, /\$364\.80 is over your cap of \$300\.00 an order/);
    assert.match(words, /0 of your 2 orders a day used/);
    assert.equal((await post('/api/trading', { on: true, confirm: 'switch trading on', understood: true })).json().caps.perOrderUsd, 300, 'switching on keeps the caps');
    link.forget();
    assert.deepEqual(link.trading(), { on: false, since: null, caps: { ...DEFAULT_CAPS, perOrderUsd: 300, ordersPerDay: 2 }, offBecause: null }, 'disconnecting switches trading off and keeps the caps: they are the person\'s rules, not Robinhood\'s');
  } finally { await term.close(); }
});

test('switching off, or disconnecting, stops any order; disconnecting switches trading off', async () => {
  const { o, link, term, post, ticket } = await desk();
  try {
    assert.equal((await post('/api/trading', { on: true, confirm: 'switch trading on', understood: true })).status, 200);
    const t = await ticket();
    await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
    assert.equal((await post('/api/trading', { on: false })).json().on, false);
    assert.equal((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 403);
    link.setTrading(true); link.forget();
    assert.equal(link.trading().on, false);
    assert.deepEqual(o.placed, []);
  } finally { await term.close(); }
});

test('an update never interrupts a ticket: the dashboard keeps running it until the person presses Restart, and then opens no more', async () => {
  const code = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pl-code-')), 'code.js');
  fs.writeFileSync(code, 'one');
  let restarts = 0;
  const { term, ticket, post } = await desk(undefined, { code: [code], restart: () => { restarts++; }, updateCheckMs: 25 });
  try {
    const t = await ticket();
    fs.writeFileSync(code, 'two');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await post('/api/ticket/check', { id: t.id, quantity: 1, limitPrice: 182.4 })).status, 200, 'the ticket still works');
    assert.equal(restarts, 0, 'the update waits for the person');
    assert.equal((await post('/api/restart', {})).json().restarting, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(restarts, 1);
    assert.equal((await post('/api/ticket/check', { id: t.id, quantity: 1, limitPrice: 182.4 })).status, 503, 'while it restarts, no ticket is worked on');
  } finally { await term.close(); }
});
