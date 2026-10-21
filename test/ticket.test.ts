import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { check, passes, propose, proposeOwn, type Order, type TicketContext } from '../src/desk/ticket.js';
import { capsFrom, capsOf, DEFAULT_CAPS, DEFAULTS, readSettings, tradingOf } from '../src/settings.js';
import { Sectors } from '../src/desk/sectors.js';
import { parseReview, Reviewer } from '../src/robinhood/review.js';
import { Refused } from '../src/robinhood/reader.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { Journal } from '../src/desk/journal.js';
import { startTerminal, type Assets } from '../src/terminal/server.js';
import { accountTools, AGENTIC, fakeRobinhood, MAIN, type Fake } from './fake-robinhood.js';

const T = DEFAULTS.trading, C = DEFAULT_CAPS;   // full position 10%; caps $500 an order, 10% a stock, 3 orders a day
const ctx = (o: Partial<TicketContext> = {}): TicketContext => ({ symbol: 'NVDA', rating: 'Buy', callDate: '2026-10-15', accountValue: 2500, buyingPower: 2500, held: 0, price: 182.4, ordersToday: 0, ...o });

test('the trading settings are read and checked: out of range falls back to what ships, and an unreadable call never trades', () => {
  const t = tradingOf({ enabled: true, fullPositionPercent: 500, caps: { perOrderUsd: 100_000 }, ratingToOrder: { Hold: 'buy a full position', 'Needs review': 'sell everything held', Buy: 'yolo' }, orderDefaults: { timeInForce: 'day' } });
  assert.deepEqual([t.enabled, t.fullPositionPercent, t.orderDefaults.timeInForce], [true, 10, 'gfd']);
  assert.ok(!('caps' in t), 'the caps are not in the settings file: the dashboard keeps them beside the trading switch');
  assert.deepEqual([t.ratingToOrder.Hold, t.ratingToOrder['Needs review'], t.ratingToOrder.Buy], ['buy a full position', 'no order', 'buy a full position']);
  assert.deepEqual(readSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-set-'))).trading, T);
  assert.equal(readSettings('.').trading.enabled, false, 'trading ships switched off');
  assert.ok(!('caps' in (JSON.parse(fs.readFileSync('desk-settings.json', 'utf8')) as { trading: object }).trading), 'the shipped settings file carries no caps');
});

test('the caps and guard rails as kept fall back to the shipped ones, never larger; as typed they are all taken or all refused', () => {
  assert.deepEqual(capsOf({ perOrderUsd: -5, perStockPercent: 20, ordersPerDay: 2.5 }), { ...C, perStockPercent: 20 }, 'an older file with three caps: the guard rails are the shipped ones');
  assert.deepEqual(capsOf(undefined), C);
  assert.deepEqual(C, { perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 3, perSectorPercent: 30, cryptoPercent: 5, weeklyLossPercent: 5, minHoldDays: 5 });
  assert.deepEqual(capsOf({ perOrderUsd: 100_001, perStockPercent: 101, ordersPerDay: 51, perSectorPercent: 0, cryptoPercent: 101, weeklyLossPercent: 51, minHoldDays: 2.5 }), C);
  assert.deepEqual(capsFrom({ ...C, perOrderUsd: 300.456, perStockPercent: 7.25, ordersPerDay: 2, cryptoPercent: 0, minHoldDays: 0 }), { ...C, perOrderUsd: 300.46, perStockPercent: 7.3, ordersPerDay: 2, cryptoPercent: 0, minHoldDays: 0 }, 'no crypto at all, and no shortest hold, are choices too');
  for (const bad of [{ perOrderUsd: 300, perStockPercent: 10, ordersPerDay: 3 }, { ...C, perOrderUsd: 0 }, { ...C, ordersPerDay: 2.5 }, { ...C, perOrderUsd: '300' }, { ...C, perOrderUsd: 100_001 }, { ...C, perSectorPercent: 0 }, { ...C, weeklyLossPercent: 60 }, { ...C, minHoldDays: 1.5 }, null]) assert.equal(capsFrom(bad), null, JSON.stringify(bad));
});

test('a sector comes from the fund tables or the company\'s own profile; anything unknown counts on its own, and a failed lookup is asked again', async () => {
  let asked = 0, down = true;
  const s = new Sectors(async (sym) => { asked++; if (sym === 'FAIL' && down) throw new Error('Yahoo did not answer'); return sym === 'ARKK' ? { sector: null, fund: true } : { sector: sym === 'FAIL' ? 'Energy' : 'Technology', fund: false }; });
  assert.deepEqual([await s.of('XLK'), await s.of('SPY'), await s.of('AAPL'), await s.of('ARKK'), await s.of('BTC-USD')].map((g) => g.name), ['Technology', null, 'Technology', 'own:ARKK', 'Crypto']);
  assert.equal(asked, 2, 'the sector and market funds, and crypto, are known without asking');
  assert.equal((await s.of('FAIL')).name, 'own:FAIL', 'a lookup that fails counts on its own');
  down = false;
  assert.equal((await s.of('FAIL')).name, 'Energy', 'and is asked again next time');
  await s.of('AAPL'); assert.equal(asked, 4, 'a sector found is remembered');
  const c = s.context('AAPL', [{ symbol: 'XLK', quantity: 10, price: 200 }, { symbol: 'AAPL', quantity: 2, price: 250 }, { symbol: 'SPY', quantity: 1, price: 600 }, { symbol: 'NEW', quantity: 5, price: 10 }]);
  assert.deepEqual(c, { name: 'Technology', label: 'Technology', heldUsd: 2_500 }, 'a sector fund counts towards its sector; a whole-market fund and a stock not looked up do not');
  assert.equal(s.context('SPY', [{ symbol: 'SPY', quantity: 1, price: 600 }]).heldUsd, 0);
});

test('the guard rails on a ticket: one sector, crypto, and the shortest hold, each said in plain words', () => {
  const buy: Order = { symbol: 'NVDA', side: 'buy', quantity: 2, limitPrice: 182.4, timeInForce: 'gfd' };
  const big = ctx({ accountValue: 10_000, buyingPower: 10_000 });
  const words = (o: Order, c: TicketContext) => check(o, c, T, C).map((x) => x.words).join(' | ');
  assert.match(words(buy, { ...big, sector: { name: 'Technology', label: 'Technology', heldUsd: 2_500 } }), /Sector Technology would be 28\.6% of the account; your limit is 30%/);
  assert.equal(passes(check(buy, { ...big, sector: { name: 'Technology', label: 'Technology', heldUsd: 2_800 } }, T, C)), false, 'over 30% in one sector');
  assert.match(words(buy, big), /Sector NVDA.*counted on its own|Sector not known, so counted as a sector of its own would be 3\.6%/, 'a sector not known counts as its own');
  assert.match(words({ ...buy, symbol: 'SPY' }, { ...big, symbol: 'SPY', sector: { name: null, label: 'a whole-market fund', heldUsd: 0 } }), /SPY is a whole-market fund: it counts towards no sector/);
  assert.equal(passes(check({ ...buy, symbol: 'BTC-USD', limitPrice: 182.4 }, { ...big, symbol: 'BTC-USD', cryptoHeldUsd: 300 }, T, C)), false, 'crypto at most 5%: $300 held and $364.80 more is 6.6%');
  assert.match(words({ ...buy, symbol: 'BTC-USD' }, { ...big, symbol: 'BTC-USD', cryptoHeldUsd: 100 }), /Crypto would be 4\.6% of the account; your limit is 5%/);
  assert.doesNotMatch(words({ ...buy, symbol: 'BTC-USD' }, { ...big, symbol: 'BTC-USD', cryptoHeldUsd: 100 }), /Sector/, 'crypto has its own limit in place of a sector');
  // Crypto, sized for paper only: in fractions, within what the crypto limit leaves, never under a dollar.
  const btc = propose({ ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 200 }, T, C);
  assert.deepEqual(btc.order, { symbol: 'BTC-USD', side: 'buy', quantity: 0.003658, limitPrice: 82_000, timeInForce: 'gfd' }, '5% of $10,000 less the $200 held leaves $300: 0.003658 BTC');
  assert.match(btc.why.join(' '), /Your crypto limit of 5% of the account leaves \$300\.00, so at most that\..*rounded down to six decimal places: 0\.003658 unit\(s\)/);
  assert.equal(passes(check(btc.order!, { ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 200 }, T, C)), true);
  assert.match(propose({ ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 499.5 }, T, C).why.at(-1)!, /\$0\.50 is under \$1\.00, the smallest crypto order/);
  assert.equal(propose({ ...big, symbol: 'BTC-USD', price: 82_000, held: 0.003658, rating: 'Underweight' }, T, C).order?.quantity, 0.001829, 'half of what is held, to six decimal places');
  assert.equal(passes(check({ ...buy, symbol: 'BTC-USD', quantity: 0.0000001 }, { ...big, symbol: 'BTC-USD' }, T, C)), false, 'no finer than six decimal places');
  assert.equal(passes(check({ ...buy, quantity: 0.5 }, big, T, C)), false, 'a stock is still bought in whole shares');
  const sell: Order = { ...buy, side: 'sell', quantity: 1 };
  const young = { ...big, held: 2, boughtOn: '2026-10-13', heldDays: 2 };
  const early = check(sell, young, T, C);
  assert.equal(passes(early), true, 'your own early sell still works');
  assert.deepEqual(early.filter((x) => x.ask).map((x) => x.words), ['NVDA was bought here on 2026-10-13, 2 trading day(s) ago, under your shortest hold of 5: selling it now takes one more press']);
  assert.equal(check(sell, { ...young, heldDays: 5 }, T, C).some((x) => x.ask), false, 'held five trading days: nothing more to press');
  assert.equal(propose({ ...young, rating: 'Sell' }, T, C).order, null, 'the desk proposes no sell under the shortest hold');
  assert.match(propose({ ...young, rating: 'Sell' }, T, C).why.at(-1)!, /bought here on 2026-10-13, 2 trading day\(s\) ago: your shortest hold is 5, so the desk proposes no sell yet/);
  assert.equal(propose({ ...young, rating: 'Sell', heldDays: 6 }, T, C).order?.quantity, 2);
  assert.equal(propose({ ...young, rating: 'Sell' }, T, { ...C, minHoldDays: 0 }).order?.quantity, 2, 'a shortest hold of 0 is no hold');
});

test('the person\'s own ticket starts at one whole share at the live price, sells only what is held, and is held to every check', () => {
  const own = (o: Partial<TicketContext>, side: 'buy' | 'sell') => proposeOwn(ctx({ rating: '', callDate: '', ...o }), side, T);
  const buy = own({}, 'buy');
  assert.equal(buy.action, 'your own buy');
  assert.deepEqual(buy.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });
  assert.match(buy.why[0]!, /^Your own order: one whole share to start, at Robinhood's live price of \$182\.40\./);
  assert.equal(own({ price: null }, 'buy').order, null, 'no live price, no order');
  assert.match(own({}, 'sell').why[0]!, /holds no NVDA to sell/);
  assert.equal(own({ held: 0.4 }, 'sell').order, null, 'a limit order sells whole shares only');
  const sell = own({ held: 3 }, 'sell');
  assert.deepEqual([sell.action, sell.order?.side, sell.order?.quantity], ['your own sell', 'sell', 1]);
  // the same checks as a call's ticket: a person's own order is no way around the caps
  const c = ctx({ rating: '', callDate: '' });
  assert.equal(passes(check(buy.order!, c, T, C)), true);
  assert.equal(passes(check({ ...buy.order!, quantity: 3 }, c, T, C)), false, '$547.20 is over the $500 cap');
  assert.equal(passes(check({ ...sell.order!, quantity: 4 }, ctx({ held: 3 }), T, C)), false, 'only three are held');
  assert.equal(passes(check(buy.order!, ctx({ ordersToday: 3 }), T, C)), false, 'three orders a day');
});

test('a buy is sized from the account, then held to the caps and buying power, in whole shares', () => {
  const full = propose(ctx(), T, C);
  assert.deepEqual(full.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });   // 10% of $2,500 is $250: one share at $182.40
  assert.match(full.why.join(' '), /A full position: 10% of the account's \$2,500\.00 is \$250\.00\..*\$250\.00 ÷ \$182\.40, rounded down: 1 share/);
  assert.equal(propose(ctx({ accountValue: 20_000 }), T, C).order?.quantity, 2, '10% is $2,000, the $500 cap makes it $500: two shares');
  assert.match(propose(ctx({ accountValue: 20_000 }), T, C).why.join(' '), /Your cap of \$500\.00 an order makes it \$500\.00/);
  assert.equal(propose(ctx({ accountValue: 20_000, buyingPower: 200 }), T, C).order?.quantity, 1);
  const half = propose(ctx({ rating: 'Overweight' }), T, C);
  assert.equal(half.order, null, '5% of $2,500 is $125, less than one share');
  assert.match(half.why.at(-1)!, /buys less than one share at \$182\.40/);
  assert.equal(propose(ctx({ price: null }), T, C).order, null);
  assert.match(propose(ctx({ accountValue: null }), T, C).why.at(-1)!, /no total value/);
  assert.match(propose(ctx({ rating: 'Hold' }), T, C).why[0]!, /place no order for that rating/);
  assert.equal(propose(ctx({ rating: 'Needs review' }), T, C).order, null);
});

test('a sell is what is held, halved or whole, never more, in whole shares', () => {
  assert.equal(propose(ctx({ rating: 'Sell' }), T, C).order, null, 'nothing held, nothing to sell');
  assert.deepEqual(propose(ctx({ rating: 'Sell', held: 7.5 }), T, C).order, { symbol: 'NVDA', side: 'sell', quantity: 7, limitPrice: 182.4, timeInForce: 'gfd' });
  assert.equal(propose(ctx({ rating: 'Underweight', held: 7 }), T, C).order?.quantity, 3);
  assert.equal(propose(ctx({ rating: 'Underweight', held: 1 }), T, C).order, null);
});

test('every check an order must pass, each said in plain words', () => {
  const buy: Order = { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' };
  assert.equal(passes(check(buy, ctx(), T, C)), true);
  const failing = (o: Partial<Order>, c: Partial<TicketContext> = {}) => check({ ...buy, ...o }, ctx(c), T, C).filter((x) => !x.ok).map((x) => x.words).join(' | ');
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
  assert.equal(passes(check({ ...buy, side: 'sell', quantity: 1 }, ctx({ held: 1 }), T, C)), true);
  assert.equal(passes([]), false);
});

test('Robinhood\'s check is read into its alerts, its approval flag and its own words; the account number is never repeated', () => {
  const r = parseReview({ failed: false, text: '', data: { data: { order_checks: [{ message: 'Not enough buying power.' }, { detail: { title: 'Halted' } }], customer_approval_required: true, account_number: '5RH88004321', estimated_cost: '182.40', quote: { last_trade_price: '182.40' } } } });
  assert.deepEqual(r.alerts, ['Not enough buying power.', 'Halted']);
  assert.equal(r.approvalRequired, true);
  assert.deepEqual(r.facts, [['estimated cost', '182.40'], ['quote · last trade price', '182.40']]);
  assert.equal(parseReview({ failed: true, text: 'account 5RH88004321 is not agentic', data: null }).error, 'account ##### is not agentic', 'the whole account number is hidden, letters and all');
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
  new Journal(path.join(root, 'desk-data', 'journal.md')).storeDecision('BTC-USD', '2026-10-15', '**Rating**: Buy\n\n**Executive Summary**: Buy, on paper.');
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]) as Assets, port: 0, robinhood: link, keyFile: path.join(path.dirname(file), 'dashboard.json') });
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
    const coin = await ask('/api/ticket', { symbol: 'BTC-USD', date: '2026-10-15' });
    assert.deepEqual([coin.status, coin.json().error], [400, "Robinhood's agent doorway trades stocks and funds only: BTC-USD is crypto, which the desk follows on paper"], 'a crypto call never opens a ticket: it is refused before Robinhood is asked');
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
