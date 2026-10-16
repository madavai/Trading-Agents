import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { check, passes, propose, type Order, type TicketContext } from '../src/desk/ticket.js';
import { DEFAULTS, readSettings, tradingOf } from '../src/settings.js';
import { parseReview, Reviewer } from '../src/robinhood/review.js';
import { Refused } from '../src/robinhood/reader.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { Journal } from '../src/desk/journal.js';
import { startTerminal, type Assets } from '../src/terminal/server.js';
import { accountTools, AGENTIC, fakeRobinhood, MAIN, type Fake } from './fake-robinhood.js';

const T = DEFAULTS.trading;   // full position 10%, caps $500 an order, 10% a stock, 3 orders a day
const ctx = (o: Partial<TicketContext> = {}): TicketContext => ({ symbol: 'NVDA', rating: 'Buy', callDate: '2026-10-15', accountValue: 2500, buyingPower: 2500, held: 0, price: 182.4, ordersToday: 0, ...o });

test('the trading settings are read and checked: out of range falls back to what ships, and an unreadable call never trades', () => {
  const t = tradingOf({ enabled: true, fullPositionPercent: 500, caps: { perOrderUsd: -5, perStockPercent: 20, ordersPerDay: 2.5 }, ratingToOrder: { Hold: 'buy a full position', 'Needs review': 'sell everything held', Buy: 'yolo' }, orderDefaults: { timeInForce: 'day' } });
  assert.deepEqual([t.enabled, t.fullPositionPercent, t.caps, t.orderDefaults.timeInForce], [true, 10, { perOrderUsd: 500, perStockPercent: 20, ordersPerDay: 3 }, 'gfd']);
  assert.deepEqual([t.ratingToOrder.Hold, t.ratingToOrder['Needs review'], t.ratingToOrder.Buy], ['buy a full position', 'no order', 'buy a full position']);
  assert.deepEqual(readSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-set-'))).trading, T);
  assert.equal(readSettings('.').trading.enabled, false, 'trading ships switched off');
});

test('a buy is sized from the account, then held to the caps and buying power, in whole shares', () => {
  const full = propose(ctx(), T);
  assert.deepEqual(full.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });   // 10% of $2,500 is $250: one share at $182.40
  assert.match(full.why.join(' '), /A full position: 10% of the account's \$2,500\.00 is \$250\.00\..*\$250\.00 ÷ \$182\.40, rounded down: 1 share/);
  assert.equal(propose(ctx({ accountValue: 20_000 }), T).order?.quantity, 2, '10% is $2,000, the $500 cap makes it $500: two shares');
  assert.match(propose(ctx({ accountValue: 20_000 }), T).why.join(' '), /Your cap of \$500\.00 an order makes it \$500\.00/);
  assert.equal(propose(ctx({ accountValue: 20_000, buyingPower: 200 }), T).order?.quantity, 1);
  const half = propose(ctx({ rating: 'Overweight' }), T);
  assert.equal(half.order, null, '5% of $2,500 is $125, less than one share');
  assert.match(half.why.at(-1)!, /buys less than one share at \$182\.40/);
  assert.equal(propose(ctx({ price: null }), T).order, null);
  assert.match(propose(ctx({ accountValue: null }), T).why.at(-1)!, /no total value/);
  assert.match(propose(ctx({ rating: 'Hold' }), T).why[0]!, /place no order for that rating/);
  assert.equal(propose(ctx({ rating: 'Needs review' }), T).order, null);
});

test('a sell is what is held, halved or whole, never more, in whole shares', () => {
  assert.equal(propose(ctx({ rating: 'Sell' }), T).order, null, 'nothing held, nothing to sell');
  assert.deepEqual(propose(ctx({ rating: 'Sell', held: 7.5 }), T).order, { symbol: 'NVDA', side: 'sell', quantity: 7, limitPrice: 182.4, timeInForce: 'gfd' });
  assert.equal(propose(ctx({ rating: 'Underweight', held: 7 }), T).order?.quantity, 3);
  assert.equal(propose(ctx({ rating: 'Underweight', held: 1 }), T).order, null);
});

test('every check an order must pass, each said in plain words', () => {
  const buy: Order = { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' };
  assert.equal(passes(check(buy, ctx(), T)), true);
  const failing = (o: Partial<Order>, c: Partial<TicketContext> = {}) => check({ ...buy, ...o }, ctx(c), T).filter((x) => !x.ok).map((x) => x.words).join(' | ');
  assert.match(failing({ quantity: 3 }), /\$547\.20 is over your cap of \$500\.00 an order/);
  assert.match(failing({ quantity: 1.5 }), /whole number of shares/);
  assert.match(failing({ quantity: 0 }), /whole number of shares, at least one/);
  assert.match(failing({ limitPrice: 182.456 }), /dollars and cents/);
  assert.match(failing({ limitPrice: 220 }), /20\.6% from Robinhood's live price of \$182\.40: more than 10% away/);
  assert.match(failing({}, { buyingPower: 100 }), /Buying power is \$100\.00: not enough/);
  assert.match(failing({}, { buyingPower: null }), /no buying power/);
  assert.match(failing({}, { held: 1 }), /NVDA would be 14\.6% of the account; your cap is 10%/);
  assert.match(failing({}, { ordersToday: 3 }), /3 of your 3 orders a day used/);
  assert.match(failing({}, { price: null }), /no live price/);
  assert.match(failing({ side: 'sell', quantity: 2 }, { held: 1 }), /Only 1 share\(s\) are held/);
  assert.equal(passes(check({ ...buy, side: 'sell', quantity: 1 }, ctx({ held: 1 }), T)), true);
  assert.equal(passes([]), false);
});

test('Robinhood\'s check is read into its alerts, its approval flag and its own words; the account number is never repeated', () => {
  const r = parseReview({ failed: false, text: '', data: { data: { order_checks: [{ message: 'Not enough buying power.' }, { detail: { title: 'Halted' } }], customer_approval_required: true, account_number: '5RH88004321', estimated_cost: '182.40', quote: { last_trade_price: '182.40' } } } });
  assert.deepEqual(r.alerts, ['Not enough buying power.', 'Halted']);
  assert.equal(r.approvalRequired, true);
  assert.deepEqual(r.facts, [['estimated cost', '182.40'], ['quote · last trade price', '182.40']]);
  assert.equal(parseReview({ failed: true, text: 'account 5RH88004321 is not agentic', data: null }).error, 'account 5RH88004321 is not agentic'.replace(/\d{5,}/g, '#####'));
});

test('the reviewer asks only for Robinhood\'s check, only on the Agentic account, only for a whole limit order', async () => {
  const calls: string[] = [], reviewed: Array<Record<string, unknown>> = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  await accountTools(calls, { reviewed, reviewAlerts: ['Market closed: the order would wait for the open.'] }).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  const rv = new Reviewer(client, (await client.listTools()).tools);
  const order = { symbol: 'NVDA', side: 'buy' as const, quantity: 2, limitPrice: 182.4, timeInForce: 'gfd' as const };
  await assert.rejects(rv.review({ accountNumber: MAIN, agentic: false }, order), Refused);
  await assert.rejects(rv.review({ accountNumber: AGENTIC, agentic: true }, { ...order, quantity: 0.5 }), /not complete/);
  const r = await rv.review({ accountNumber: AGENTIC, agentic: true }, order);
  assert.deepEqual(reviewed, [{ account_number: AGENTIC, symbol: 'NVDA', side: 'buy', type: 'limit', quantity: '2', limit_price: '182.40', time_in_force: 'gfd', market_hours: 'regular_hours' }]);
  assert.deepEqual(r.alerts, ['Market closed: the order would wait for the open.']);
  assert.deepEqual(calls, ['review_equity_order'], 'Robinhood\'s check alone; nothing placed');
  await client.close();
});

// ---------- through the dashboard ----------
let fake: Fake, file: string, port: number, reviewed: Array<Record<string, unknown>>;
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };
afterEach(async () => { await fake?.close(); });

async function desk(buyingPower: string) {
  reviewed = [];
  fake = await fakeRobinhood((calls) => accountTools(calls, { reviewed, agenticBuyingPower: buyingPower, orders: [{ symbol: 'AAPL', side: 'buy', state: 'filled', created_at: new Date().toISOString() }] }));
  port = await freePort(); file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-tk-')), 'sign-in.json');
  await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
  const link = new Link(file, { url: fake.url, port });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-tk-term-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  new Journal(path.join(root, 'desk-data', 'journal.md')).storeDecision('NVDA', '2026-10-15', '**Rating**: Buy\n\n**Executive Summary**: Buy on strength.');
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<meta name="desk-token" content="__DESK_TOKEN__">' }]]) as Assets, port: 0, robinhood: link });
  const ask = async (p: string, body: unknown) => { const r = await fetch(`${term.url}${p.slice(1)}`, { method: 'POST', headers: { 'x-desk-token': term.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, body: t, json: () => JSON.parse(t) }; };
  const show = async () => { const { accounts } = await link.accounts(); await link.choose(accounts.filter((a) => !a.deactivated).map((a) => a.key)); };
  return { term, ask, show };
}

test("from a call to Robinhood's check: proposed on the real figures, changed only in quantity and price, checked, then reviewed; nothing placed", async () => {
  const { term, ask, show } = await desk('2500.00');
  try {
    const early = await ask('/api/ticket', { symbol: 'NVDA', date: '2026-10-15' });
    assert.equal(early.status, 400);
    assert.match(early.json().error, /show your Agentic account on the dashboard first/);
    await show();
    assert.equal((await ask('/api/ticket', { symbol: 'NVDA', date: '2020-01-01' })).status, 404);
    const opened = await ask('/api/ticket', { symbol: 'nvda', date: '2026-10-15' });
    assert.equal(opened.status, 200, opened.body);
    const t = opened.json();
    assert.deepEqual([t.context.accountValue, t.context.buyingPower, t.context.held, t.context.price, t.context.ordersToday], [2500, 2500, 0, 182.4, 1]);
    assert.deepEqual(t.proposal.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });
    assert.ok(t.checks.every((c: { ok: boolean }) => c.ok));
    for (const n of [MAIN, AGENTIC]) assert.ok(!opened.body.includes(n), 'no account number reaches the page');

    const over = (await ask('/api/ticket/check', { id: t.id, quantity: 3, limitPrice: 182.4, symbol: 'TSLA', side: 'sell' })).json();
    assert.ok(over.checks.some((c: { ok: boolean; words: string }) => !c.ok && /over your cap/.test(c.words)));
    assert.equal((await ask('/api/ticket/review', { id: t.id, quantity: 3, limitPrice: 182.4 })).status, 400, 'over the cap: not sent to Robinhood');
    assert.deepEqual(reviewed, []);

    const r = await ask('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4, symbol: 'TSLA', side: 'sell' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().review.approvalRequired, true);
    assert.deepEqual(r.json().review.alerts, []);
    assert.deepEqual(reviewed, [{ account_number: AGENTIC, symbol: 'NVDA', side: 'buy', type: 'limit', quantity: '1', limit_price: '182.40', time_in_force: 'gfd', market_hours: 'regular_hours' }], "the stock and side are the call's, the account the Agentic one, whatever the page sends");
    assert.ok(!fake.calls.includes('place_equity_order'), 'nothing placed');
    assert.equal((await ask('/api/ticket/check', { id: 'nope', quantity: 1, limitPrice: 1 })).status, 404);
  } finally { await term.close(); }
});

test('when Robinhood gives no buying power, the ticket proposes nothing and sends nothing', async () => {
  const { term, ask, show } = await desk('not a number');
  try {
    await show();
    const t = (await ask('/api/ticket', { symbol: 'NVDA', date: '2026-10-15' })).json();
    assert.equal(t.context.buyingPower, null);
    assert.equal(t.proposal.order, null);
    assert.equal((await ask('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).status, 400);
    assert.deepEqual(reviewed, []);
  } finally { await term.close(); }
});
