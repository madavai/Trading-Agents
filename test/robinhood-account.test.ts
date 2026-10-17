import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { figure, keyOf, parseAccounts, parsePortfolio, parsePositions, readAccount, sortAccounts } from '../src/robinhood/account.js';
import { Reader } from '../src/robinhood/reader.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { shareHoldings, startTerminal, type Assets } from '../src/terminal/server.js';
import { readHoldings, renderHoldings } from '../src/desk/holdings.js';
import { accountTools, AGENTIC, AGENTIC_RHS, CLOSED, fakeRobinhood, MAIN, MAIN_RHS, type Fake } from './fake-robinhood.js';

const NUMBERS = [MAIN, MAIN_RHS, AGENTIC, AGENTIC_RHS, CLOSED];
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };

async function inMemory(calls: string[], o?: Parameters<typeof accountTools>[1]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await accountTools(calls, o).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { reader: new Reader(client, (await client.listTools()).tools), close: () => client.close() };
}

test('a figure is read only when Robinhood gave a number; anything else is a dash, never a zero', () => {
  assert.deepEqual(['12.50', '-3', 7, '', 'not a number', null, undefined, '1e5', NaN].map(figure), [12.5, -3, 7, null, null, null, null, null, null]);
  const p = parsePortfolio({ data: { total_value: '100.00', cash: 'n/a', buying_power: { buying_power: '40.5' } } });
  assert.deepEqual([p.total, p.cash, p.buyingPower, p.equities, p.currency], [100, null, 40.5, null, 'USD']);
  assert.deepEqual(parsePositions({ data: { positions: [{ symbol: 'nvda', quantity: '2', average_buy_price: '1.5' }, { symbol: 'X', quantity: '0' }, { quantity: '3' }] } }), [{ symbol: 'NVDA', quantity: 2, averageCost: 1.5 }]);
  assert.deepEqual(parsePositions({ positions: [{ symbol: 'NVDA', quantity: '2' }] }), [], 'only what is under data counts: the guide is never read as facts');
});

test('accounts are known by a key and the last four characters, the default first and the Agentic one second', () => {
  const found = parseAccounts({ data: { accounts: [{ account_number: 'B2', agentic_allowed: true, nickname: 'Desk' }, { account_number: 'A1', is_default: true, brokerage_account_type: 'ira_roth' }, { account_number: 'C3', type: 'margin' }, { nickname: 'no number' }] } });
  const sorted = sortAccounts(found);
  assert.deepEqual(sorted.map((a) => [a.label, a.last4, a.agentic, a.isDefault]), [['Roth IRA account', 'A1', false, true], ['Desk', 'B2', true, false], ['Margin account', 'C3', false, false]]);
  assert.equal(found[0]!.key, keyOf('B2'));
  assert.match(found[0]!.key, /^[0-9a-f]{16}$/);
  assert.ok(!found[0]!.key.includes('B2'));
});

test('an account is read whole: priced at Robinhood\'s live quotes, a missing price left as a dash, and orders and phone approvals for the Agentic account only', async () => {
  const calls: string[] = [], { reader, close } = await inMemory(calls);
  const accounts = parseAccounts((await reader.read('get_accounts')).data), main = accounts.find((a) => a.isDefault)!, agentic = accounts.find((a) => a.agentic)!;
  const m = await readAccount(reader, main, main.ids);
  assert.deepEqual([m.portfolio?.total, m.portfolio?.cash, m.portfolio?.buyingPower], [9112.5, 3103, 3103]);
  assert.deepEqual(m.holdings.map((h) => [h.symbol, h.quantity, h.price, h.value]), [['NVDA', 20, 182.4, 3648], ['AAPL', 10, null, null]]);
  assert.ok(Math.abs(m.holdings[0]!.gainPct! - (182.4 / 141.2 - 1) * 100) < 1e-9);
  assert.equal(m.holdings[1]!.gainPct, null, 'no price, so no gain: a dash, never a zero');
  assert.equal(m.orders, null); assert.equal(m.approvals, null);
  const g = await readAccount(reader, agentic, agentic.ids);
  assert.deepEqual([g.portfolio?.total, g.portfolio?.buyingPower, g.holdings.length], [2500, null, 0]);
  assert.deepEqual(g.orders, { orders: [], count: 0 });
  assert.deepEqual(g.approvals, { required: true, pending: 0 });
  assert.ok(!calls.includes('place_equity_order'));
  assert.ok(!calls.some((c) => c === 'get_equity_orders' && calls.indexOf(c) < calls.indexOf('get_portfolio')), 'orders are read only for the Agentic account, after its value');
  await close();
});

let fake: Fake, file: string, port: number;
beforeEach(async () => { fake = await fakeRobinhood((calls) => accountTools(calls, { orders: [{ symbol: 'nvda', side: 'buy', type: 'limit', state: 'filled', quantity: '2', average_price: '180.10', created_at: '2026-10-15T14:00:00Z' }] })); port = await freePort(); file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-acct-')), 'sign-in.json'); });
afterEach(async () => { await fake.close(); });

const signedIn = async () => { await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close(); return new Link(file, { url: fake.url, port, open: () => assert.fail('no browser') }); };

test('the person ticks which accounts to show; only a live account Robinhood listed can be chosen, and the choice is kept beside the sign-in as keys', async () => {
  const link = await signedIn();
  const { accounts, chosen } = await link.accounts();
  assert.deepEqual(accounts.map((a) => [a.label, a.agentic, a.isDefault, a.deactivated]), [['Individual account', false, true, false], ['Desk', true, false, false], ['Individual account', false, false, true]]);
  assert.deepEqual(chosen, []);
  const [main, agentic, closed] = accounts as [typeof accounts[0], typeof accounts[0], typeof accounts[0]];
  await assert.rejects(link.choose([main.key, '0123456789abcdef']), /not one of your Robinhood accounts/);
  await assert.rejects(link.choose([closed.key]), /not one of your Robinhood accounts/);
  assert.deepEqual(await link.choose([main.key, agentic.key, main.key]), [main.key, agentic.key]);
  const kept = fs.readFileSync(path.join(path.dirname(file), 'accounts.json'), 'utf8');
  assert.deepEqual(JSON.parse(kept), { show: [main.key, agentic.key] });
  for (const n of NUMBERS) assert.ok(!kept.includes(n), 'no account number is written');

  const snap = await link.refresh();
  assert.deepEqual(snap.views.map((v) => v.account.label), ['Individual account', 'Desk']);
  assert.deepEqual(snap.views[1]!.orders?.orders[0], { symbol: 'NVDA', side: 'buy', type: 'limit', state: 'filled', quantity: 2, price: 180.1, at: '2026-10-15T14:00:00Z' });
  assert.equal(link.snapshot(), snap);
  assert.ok(!fake.calls.includes('place_equity_order'));
  link.forget();
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'accounts.json')), false, 'disconnecting forgets the choice too');
  assert.equal(link.snapshot(), null);
});

test('the dashboard lists, keeps and reads the accounts on the page\'s token, and never shows an account number', async () => {
  const link = await signedIn();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-acct-term-')), dir = path.join(root, 'desk-data');
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<meta name="desk-token" content="__DESK_TOKEN__">' }]]) as Assets, port: 0, robinhood: link });
  const bodies: string[] = [];
  const ask = async (method: string, p: string, body?: unknown, token = true) => {
    const res = await fetch(`${term.url.slice(0, -1)}${p}`, { method, headers: { ...(token ? { 'x-desk-token': term.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await res.text(); bodies.push(t); return { status: res.status, json: () => JSON.parse(t) };
  };
  try {
    assert.equal((await ask('GET', '/api/robinhood/accounts', undefined, false)).status, 403);
    const listed = (await ask('GET', '/api/robinhood/accounts')).json();
    assert.equal(listed.accounts.length, 3);
    assert.deepEqual((await ask('GET', '/api/robinhood/snapshot')).json(), { snapshot: null, chosen: [] });
    for (const bad of [{ show: 'all' }, { show: ['../x'] }, { show: Array(11).fill('0123456789abcdef') }]) assert.equal((await ask('POST', '/api/robinhood/accounts', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await ask('POST', '/api/robinhood/accounts', { show: ['0123456789abcdef'] })).status, 400);
    const keys = listed.accounts.filter((a: { deactivated: boolean }) => !a.deactivated).map((a: { key: string }) => a.key);
    assert.deepEqual((await ask('POST', '/api/robinhood/accounts', { show: keys })).json().chosen, keys);
    const read = (await ask('POST', '/api/robinhood/refresh', {})).json();
    assert.equal(read.snapshot.views.length, 2);
    assert.equal(read.snapshot.views[0].holdings[0].value, 3648);
    assert.equal((await ask('GET', '/api/robinhood/snapshot')).json().snapshot.at, read.snapshot.at);

    // the agents are given the holdings: each account apart, by label, saying which one the desk may trade in
    assert.equal(read.holdingsShared, true);
    const kept = fs.readFileSync(path.join(dir, 'holdings.json'), 'utf8');
    for (const n of NUMBERS) assert.ok(!kept.includes(n), 'no account number reaches the agents');
    const h = readHoldings(dir)!;
    assert.deepEqual([h.source, h.accounts?.map((a) => [a.label, a.tradable]), h.cash, h.positions], ['robinhood', [['Individual account', false], ['Desk', true]], 2500, []]);
    const words = renderHoldings(h, 'NVDA');
    assert.ok(words.startsWith('Portfolio as read from Robinhood on ') && words.includes('Size any trade to the tradable account'), words);
    assert.ok(words.includes('\n- Individual account (view only: the desk never trades in it): position in NVDA: 20 units, average price 141.20; cash 3,103.00 USD; buying power 3,103.00 USD; other positions: AAPL 10\n'), words);
    assert.ok(words.endsWith("\n- Desk (the only account the desk may trade in, and only on the person's Confirm): no position in NVDA; cash 2,500.00 USD"), words);
    for (const b of bodies) for (const n of NUMBERS) assert.ok(!b.includes(n), `an account number reached the page: ${b.slice(0, 120)}`);
    fake.refuseAll = true;
    const lost = await ask('POST', '/api/robinhood/refresh', {});
    assert.equal(lost.status, 502);
    assert.match(lost.json().error, /sign in again: press Connect/);
  } finally { await term.close(); }
});

test('a read in which some holdings could not be read is not given to the agents: they keep the last complete one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-share-'));
  const account = { key: 'k', last4: '1234', label: 'Desk', agentic: true, isDefault: false, deactivated: false };
  const view = { account, portfolio: null, holdings: [], unread: 0, orders: null, approvals: null, problems: [] as string[] };
  assert.equal(shareHoldings(dir, { at: 'now', views: [{ ...view, problems: ['the stocks held: Robinhood reported an error'] }] }, '2026-10-16'), false);
  assert.equal(shareHoldings(dir, { at: 'now', views: [{ ...view, unread: 1 }] }, '2026-10-16'), false);
  assert.equal(shareHoldings(dir, { at: 'now', views: [] }, '2026-10-16'), false);
  assert.equal(readHoldings(dir), null);
  assert.equal(shareHoldings(dir, { at: 'now', views: [{ ...view, problems: ['the value and buying power: Robinhood reported an error'] }] }, '2026-10-16'), true, 'a missing value does not hide a holding');
  assert.ok(renderHoldings(readHoldings(dir), 'NVDA').endsWith("\n- Desk (the only account the desk may trade in, and only on the person's Confirm): no position in NVDA"));
});
