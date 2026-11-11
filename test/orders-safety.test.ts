import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { check, passes, type TicketContext } from '../src/desk/ticket.js';
import { DEFAULT_CAPS, DEFAULTS, type Caps } from '../src/settings.js';
import { Sectors } from '../src/desk/sectors.js';
import { parseReview } from '../src/robinhood/review.js';
import { parsePlaced } from '../src/robinhood/order.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { Journal } from '../src/desk/journal.js';
import { lastBuy, logOrder, placedToday, readOrders } from '../src/desk/orders.js';
import { renderHoldings, type Holdings } from '../src/desk/holdings.js';
import { eveningBrief } from '../src/desk/routine.js';
import { robinhoodFile } from '../src/paths.js';
import { startTerminal, type Assets, type TerminalOptions } from '../src/terminal/server.js';
import { sameFigures, typedNumber } from '../src/terminal/ui/typed.js';
import { dayText } from '../src/terminal/ui/fmt.js';
import { accountTools, fakeRobinhood, type Fake } from './fake-robinhood.js';
import { today } from '../src/data/dates.js';

// Audit 3, group A: orders, the caps and the safety around them. Each test here failed on main 4ce0b62.

const CALL_DAY = today();
const T = DEFAULTS.trading, C = DEFAULT_CAPS;

let fake: Fake | undefined;
const terms: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const t of terms.splice(0)) await t.close(); await fake?.close(); fake = undefined; });
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(ok(), 'waited too long'); };

/** A desk with a signed-in, chosen Agentic account ($2,500, all cash), a Buy call on NVDA today, and every stock in the
 *  Technology sector (no lookup at the SEC). */
async function desk(caps: Partial<Caps> = {}, more: Partial<TerminalOptions> = {}) {
  const o = { placed: [] as Array<Record<string, unknown>>, reviewed: [] as Array<Record<string, unknown>>, agenticBuyingPower: '2500.00', agenticPositions: [] as unknown[], orders: [] as unknown[],
    quotesPerCall: undefined as number | undefined, placeWait: undefined as Promise<unknown> | undefined, placeAnswer: undefined as unknown, reviewAnswer: undefined as unknown };
  fake = await fakeRobinhood((calls) => accountTools(calls, o));
  const port = await freePort(), file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-')), 'sign-in.json');
  await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
  const link = new Link(file, { url: fake.url, port });
  link.setCaps({ ...C, ...caps });
  const { accounts } = await link.accounts();
  await link.choose(accounts.filter((a) => !a.deactivated).map((a) => a.key));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-term-')), dir = path.join(root, 'desk-data');
  new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', CALL_DAY, '**Rating**: Buy\n\n**Executive Summary**: Buy.');
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]) as Assets, port: 0, robinhood: link, keyFile: path.join(path.dirname(file), 'dashboard.json'),
    sectors: new Sectors(async () => ({ sector: 'Technology', fund: false })), ...more });
  terms.push(term);
  const post = async (p: string, body: unknown) => { const r = await fetch(`${term.url}${p.slice(1)}`, { method: 'POST', headers: { 'x-desk-token': term.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, body: t, json: () => JSON.parse(t) }; };
  const ticket = async () => (await post('/api/ticket', { symbol: 'NVDA', date: CALL_DAY })).json() as { id: string; checks: Array<{ ok: boolean; words: string }>; lost: string | null; context: TicketContext };
  const words = (checks: Array<{ words: string }>) => checks.map((c) => c.words).join(' | ');
  return { o, link, file, dir, term, post, ticket, words };
}
const order = (o: Record<string, unknown>) => ({ type: 'limit', created_at: new Date().toISOString(), ...o });

test('broker-1: an order not yet filled counts towards the per-stock and sector caps, and what a sell order already promises cannot be sold again', async () => {
  const { o, post, ticket, words } = await desk();
  // one NVDA already waiting at Robinhood: a second ticket for one more is 14.6% of the account, over the 10% cap
  o.orders = [order({ symbol: 'NVDA', side: 'buy', state: 'queued', quantity: '1.00000000', cumulative_quantity: '0.00000000', price: '182.40' })];
  const t = await ticket();
  assert.match(words(t.checks), /NVDA would be 14\.6% of the account, counting 1 share\(s\) in orders not yet filled; your cap is 10%/);
  assert.equal(passes(t.checks), false);
  // a filled or cancelled order is not counted again (a filled one is in the holdings)
  o.orders = [order({ symbol: 'NVDA', side: 'buy', state: 'filled', quantity: '1', price: '182.40' }), order({ symbol: 'NVDA', side: 'buy', state: 'cancelled', quantity: '4', price: '182.40' })];
  assert.match(words((await ticket()).checks), /NVDA would be 7\.3% of the account; your cap is 10%/);
  // an open order of another stock in the same sector counts towards the sector: $600 + $182.40 of $2,500 is 31.3%
  o.orders = [order({ symbol: 'AMD', side: 'buy', state: 'confirmed', quantity: '3', price: '200.00' })];
  assert.match(words((await ticket()).checks), /Sector Technology would be 31\.3% of the account, counting orders not yet filled; your limit is 30%/);
  // an order Robinhood lists without saying whether it is still open: the caps cannot be checked, never assumed met
  o.orders = [order({ symbol: 'NVDA', side: 'buy', quantity: '1' })];
  const unread = await ticket();
  assert.match(words(unread.checks), /Robinhood listed 1 order\(s\) whose stock, side, size or state could not be read, so your per-stock and sector caps cannot be checked/);
  assert.equal(passes(unread.checks), false);
  // a sell: 3 held, 2 already in a sell order at Robinhood
  o.orders = [order({ symbol: 'NVDA', side: 'sell', state: 'queued', quantity: '2', price: '190.00' })];
  o.agenticPositions = [{ symbol: 'NVDA', quantity: '3.0000', average_buy_price: '170.00' }];
  const own = (await post('/api/ticket/own', { symbol: 'NVDA', side: 'sell' })).json();
  assert.match(words(own.checks), /Selling 1 of the 3 held, 2 more already in sell orders not yet filled/);
  const two = (await post('/api/ticket/check', { id: own.id, quantity: 2, limitPrice: 182.4 })).json();
  assert.match(words(two.checks), /Only 1 of the 3 held can be sold: 2 are in sell orders not yet filled/);
});

test('broker-1: two tickets cannot pass on the same figures: one order at a time, and the second is checked again after the first', async () => {
  const { o, post, ticket, link } = await desk({ perStockPercent: 10 });
  link.setTrading(true);
  const a = await ticket(), b = await ticket();
  await post('/api/ticket/review', { id: a.id, quantity: 1, limitPrice: 182.4 });
  await post('/api/ticket/review', { id: b.id, quantity: 1, limitPrice: 182.4 });
  let release!: () => void;
  o.placeWait = new Promise<void>((r) => { release = r; });
  const first = post('/api/ticket/place', { id: a.id, confirm: 'Buy 1 NVDA at $182.40' });
  await until(() => o.placed.length === 1);
  const second = await post('/api/ticket/place', { id: b.id, confirm: 'Buy 1 NVDA at $182.40' });
  assert.equal(second.status, 409);
  assert.match(second.json().error, /^another order is being sent to Robinhood: try again when it has been answered$/);
  release();
  assert.equal((await first).status, 200);
  // Robinhood now lists the first order as open: the second, checked again on the latest figures, is over the cap
  o.orders = [order({ symbol: 'NVDA', side: 'buy', state: 'queued', quantity: '1', price: '182.40' })];
  const again = await post('/api/ticket/place', { id: b.id, confirm: 'Buy 1 NVDA at $182.40' });
  assert.equal(again.status, 400);
  assert.match(again.json().error, /no longer passes on Robinhood's latest figures: NVDA would be 14\.6% of the account, counting 1 share\(s\) in orders not yet filled/);
  assert.equal(o.placed.length, 1);
});

test('broker-2: a holding Robinhood gave no live price for never counts $0 towards its sector; prices are asked twenty at a time', async () => {
  const { o, ticket, words } = await desk();
  o.agenticPositions = [{ symbol: 'AAPL', quantity: '30.0000', average_buy_price: '198.50' }];   // the pretend Robinhood gives AAPL no price
  const t = await ticket();
  assert.match(words(t.checks), /Sector Technology cannot be checked against your limit of 30%: Robinhood gave no live price for AAPL, held in the account/);
  assert.equal(passes(t.checks), false);
  // 25 holdings and the stock itself: Robinhood answers twenty quotes an ask, so they are asked in twenties
  o.quotesPerCall = 20;
  o.agenticPositions = Array.from({ length: 25 }, (_, i) => ({ symbol: `T${String.fromCharCode(65 + i)}`, quantity: '1.0000', average_buy_price: '1.00' }));
  const many = await ticket();
  assert.doesNotMatch(words(many.checks), /cannot be checked/);
  assert.match(words(many.checks), /Sector Technology would be 8\.3% of the account; your limit is 30%/, '$25 held at $1 each and $182.40 bought, of $2,500');
});

test('broker-2: the sector check fails, in words, when a holding in the same sector has no price', () => {
  const sectors = new Sectors(async () => ({ sector: 'Technology', fund: false }));
  return sectors.warm(['NVDA', 'AAPL', 'XOM']).then(() => {
    const positions = [{ symbol: 'AAPL', quantity: 30, price: null }, { symbol: 'XOM', quantity: 1, price: null }];
    const s = sectors.context('NVDA', positions);
    assert.deepEqual(s.unpriced, ['AAPL', 'XOM']);
    const c: TicketContext = { symbol: 'NVDA', rating: 'Buy', callDate: CALL_DAY, accountValue: 10_000, buyingPower: 10_000, held: 0, price: 200, ordersToday: 0, sector: s };
    const failing = check({ symbol: 'NVDA', side: 'buy', quantity: 2, limitPrice: 200, timeInForce: 'gfd' }, c, T, C).filter((x) => !x.ok);
    assert.deepEqual(failing.map((x) => x.words), ['Sector Technology cannot be checked against your limit of 30%: Robinhood gave no live price for AAPL, XOM, held in the account']);
  });
});

test('broker-3: an order whose answer is lost is said to have maybe gone through, is logged, counts, and its ticket sends nothing more', async () => {
  const { o, dir, post, ticket, link } = await desk();
  link.setTrading(true);
  const t = await ticket();
  await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
  fake!.lose = true;
  const r = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
  assert.equal(r.status, 200, r.body);
  const p = r.json().placed;
  assert.deepEqual([p.answered, p.unknown], [false, true]);
  assert.match(p.error, /^Robinhood's answer did not arrive \(.+\), so this order may have gone through\. Look at the Agentic account's orders in Robinhood's own app before you try again\.$/);
  assert.equal(fake!.lost.length, 1, 'it did reach Robinhood');
  const log = readOrders(dir);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.symbol, log[0]!.robinhood.answered, log[0]!.robinhood.unknown], ['NVDA', false, true]);
  assert.equal(placedToday(dir, new Date()), 1, 'it counts towards orders a day');
  assert.ok(lastBuy(dir, 'NVDA', new Date()), 'and towards the shortest hold');
  fake!.lose = false;
  assert.equal((await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).status, 409, 'that ticket sends nothing more');
  assert.equal((await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).status, 409);
  const next = await ticket();
  assert.match(next.lost ?? '', /^An order sent from here on \d{4}-\d{2}-\d{2} \(Buy 1 NVDA at \$182\.40\) got no clear answer from Robinhood, so it may have gone through\. Look in Robinhood's own app before you place another\.$/);
  assert.equal(next.context.ordersToday, 1, 'the new ticket counts it in orders today, though Robinhood does not list it');
  assert.ok(next.checks.some((c) => c.words === '1 of your 3 orders a day used'));
  // the page writes that day as it writes every other ("9 Nov 2026")
  const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');
  assert.match(page, /const daysInWords = \(said: string\): string => said\.replace\(\/\\b\\d\{4\}-\\d\{2\}-\\d\{2\}\\b\/g, dayText\);/);
  assert.match(page, /esc\(daysInWords\(t\.lost\)\)/);
  assert.match(page, /esc\(daysInWords\(TR\.state\.offBecause\.words\)\)/, 'and the weekly limit\'s reason too');
  assert.equal(dayText('2026-11-09'), '9 Nov 2026');
  assert.deepEqual(o.placed, [], 'nothing was sent twice');
  assert.match(eveningBrief(dir, today(), new Date()), /Buy 1 NVDA at limit 182\.40, [\d:]+ UTC, from the Buy call of [\d-]+: no clear answer from Robinhood, so it may have gone through/);
});

test('broker-3: the order is in the desk\'s log before it is sent, and its answer completes that one line', async () => {
  const { o, dir, post, ticket, link } = await desk();
  link.setTrading(true);
  const t = await ticket();
  await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
  let release!: () => void;
  o.placeWait = new Promise<void>((r) => { release = r; });
  const sending = post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
  await until(() => o.placed.length === 1);
  const before = readOrders(dir);
  assert.deepEqual(before.map((x) => [x.symbol, x.robinhood.unknown]), [['NVDA', true]], 'written before Robinhood answers: a dashboard stopped mid-send still knows of it');
  release();
  assert.equal((await sending).status, 200);
  const after = readOrders(dir);
  assert.equal(after.length, 1, 'one order, one entry');
  assert.deepEqual([after[0]!.robinhood.answered, after[0]!.robinhood.unknown ?? false, after[0]!.robinhood.state, after[0]!.at], [true, false, 'queued', before[0]!.at]);
  assert.equal(placedToday(dir, new Date()), 1);
});

test('broker-3: a failure before anything was sent says so', async () => {
  const { o, post, ticket, link } = await desk();
  link.setTrading(true);
  const t = await ticket();
  await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
  fake!.refuseAll = true;   // Robinhood refuses the session: the account is never read again, nothing is sent
  const r = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
  assert.equal(r.status, 502);
  assert.match(r.json().error, / Nothing was sent\.$/);
  assert.deepEqual(o.placed, []);
});

test('broker-4: Robinhood\'s dry run counts as clean only with its list of order checks', () => {
  const plain = parseReview({ failed: false, text: 'Order checks are unavailable right now', data: null });
  assert.deepEqual([plain.answered, plain.unclear, plain.alerts], [false, true, []]);
  assert.equal(plain.error, 'Robinhood answered without its list of order checks, so this order counts as not checked and cannot be placed. It said: Order checks are unavailable right now');
  assert.deepEqual([parseReview({ failed: false, text: '{}', data: { guide: 'x' } }).answered, parseReview({ failed: false, text: '', data: { data: { checks: [{ message: 'Halted' }] } } }).answered], [false, false]);
  const clean = parseReview({ failed: false, text: '', data: { data: { order_checks: [], customer_approval_required: true } } });
  assert.deepEqual([clean.answered, clean.unclear, clean.error], [true, false, null]);
  const error = parseReview({ failed: true, text: 'no', data: null });
  assert.deepEqual([error.answered, error.unclear, error.error], [false, false, 'no']);
});

test('broker-4: an order counts as taken only with Robinhood\'s order id and a state that is not a refusal', () => {
  const words = parsePlaced({ failed: false, text: 'Order rejected: not enough shares', data: null });
  assert.deepEqual([words.answered, words.unknown], [false, true]);
  assert.equal(words.error, "Robinhood answered without an order id, so it is not clear it took this order: it may have gone through. Look at the Agentic account's orders in Robinhood's own app before you try again. It said: Order rejected: not enough shares");
  const rejected = parsePlaced({ failed: false, text: '', data: { data: { order_id: 'abc', state: 'rejected', reject_reason: 'Not enough buying power' } } });
  assert.deepEqual([rejected.answered, rejected.unknown, rejected.error], [false, false, 'Robinhood marked the order rejected: Not enough buying power']);
  assert.equal(parsePlaced({ failed: false, text: '', data: { data: { state: 'failed' } } }).error, 'Robinhood marked the order failed.');
  const taken = parsePlaced({ failed: false, text: '', data: { data: { order_id: 'abc', state: 'queued' } } });
  assert.deepEqual([taken.answered, taken.unknown, taken.error], [true, false, null]);
  const approval = parsePlaced({ failed: false, text: '', data: { data: { approval_id: 'abc', customer_approval_required: true } } });
  assert.deepEqual([approval.answered, approval.unknown], [true, false], 'waiting for the person\'s approval, with its id');
  const refused = parsePlaced({ failed: true, text: 'cannot trade', data: null });
  assert.deepEqual([refused.answered, refused.unknown, refused.error], [false, false, 'cannot trade']);
});

test('broker-4: through the dashboard, a rejected order is shown as refused, logged as refused, and is no buy for the shortest hold', async () => {
  const { o, dir, post, ticket, link } = await desk();
  link.setTrading(true);
  const t = await ticket();
  await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
  o.placeAnswer = { order_id: '6f1c2b9e-0000-4000-8000-00000000abce', state: 'rejected', reject_reason: 'Market closed' };
  const p = (await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' })).json().placed;
  assert.deepEqual([p.answered, p.unknown, p.error], [false, false, 'Robinhood marked the order rejected: Market closed']);
  assert.equal(lastBuy(dir, 'NVDA', new Date()), null);
});

test('broker-4: through the dashboard, a check that comes back without its list of order checks is "not checked", and cannot be placed', async () => {
  const { o, post, ticket, link } = await desk();
  link.setTrading(true);
  const t = await ticket();
  o.reviewAnswer = { message: 'Checks are delayed' };
  const r = (await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 })).json().review;
  assert.deepEqual([r.answered, r.unclear], [false, true]);
  assert.match(r.error, /^Robinhood answered without its list of order checks, so this order counts as not checked and cannot be placed\. It said: Checks are delayed$/);
  const placed = await post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
  assert.equal(placed.status, 400);
  assert.match(placed.json().error, /did not come back clean, so it cannot be placed/);
  assert.deepEqual(o.placed, [], 'nothing was sent');
});

test('broker-5: the guard sees through wildcards, short names, split words, a port in a variable and a broker connection named anything', async () => {
  const guard = await import(pathToFileURL(path.resolve('.claude/hooks/guard.mjs')).href) as { verdict: (call: unknown) => string | null };
  const folder = ['.trading', 'agents'].join('-'), q = "'", dq = '"';
  const refusedPrivate = [
    { tool_name: 'Bash', tool_input: { command: 'cat /made/up/home/.trading-a*/*.json' } },
    { tool_name: 'Bash', tool_input: { command: 'ls ~/.t*' } },
    { tool_name: 'Bash', tool_input: { command: 'ls ~/*agents*/' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem $HOME\\* -Force' } },
    { tool_name: 'Bash', tool_input: { command: 'type C:\\made\\up\\home\\TRADIN~1\\*.json' } },
    { tool_name: 'PowerShell', tool_input: { command: `Get-ChildItem (Join-Path $HOME (${q}.trading${q} + ${q}-agents${q}))` } },
    { tool_name: 'Bash', tool_input: { command: `cat ~/${dq}.trading${dq}${dq}-agents${dq}/x` } },
    { tool_name: 'mcp__filesystem__read_text_file', tool_input: { path: 'C:\\made\\up\\home\\TRADIN~1\\dashboard.json' } },
  ];
  for (const call of refusedPrivate) assert.match(guard.verdict(call) ?? '', /private to them/, JSON.stringify(call));
  const refusedDashboard = [
    { tool_name: 'Bash', tool_input: { command: 'P=47615; curl -s http://127.0.0.1:$P/api/state' } },
    { tool_name: 'Bash', tool_input: { command: `curl -s -X POST ${dq}http://localhost:$P/api/tra${dq}${dq}ding${dq} -d ${dq}{}${dq}` } },
    { tool_name: 'Bash', tool_input: { command: `curl -s -X POST ${dq}http://some-host/api/tick${dq}${dq}et/place${dq}` } },
    { tool_name: 'Bash', tool_input: { command: 'H=127.0.0.1; curl http://$H:47615/' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Invoke-RestMethod "http://localhost:${env:P}/api/claim/new"' } },
  ];
  for (const call of refusedDashboard) assert.match(guard.verdict(call) ?? '', /never use the Trading Agents dashboard/, JSON.stringify(call));
  // The walk's H7 prompts, the ways a chat would carry them out.
  for (const call of [
    { tool_name: 'Bash', tool_input: { command: 'ls -d ~/.trad*' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem $HOME -Force -Directory -Filter .trad*' } },
    { tool_name: 'Glob', tool_input: { pattern: '.trad*', path: os.homedir() } },
  ]) assert.match(guard.verdict(call) ?? '', /private to them|never search the whole home folder/, JSON.stringify(call));
  assert.match(guard.verdict({ tool_name: 'WebFetch', tool_input: { url: 'http://127.1:47615/api/state', prompt: 'show it' } }) ?? '', /never use the Trading Agents dashboard/);
  for (const server of ['rh', 'my-money']) for (const tool of ['get_accounts', 'list_accounts', 'get_account']) assert.match(guard.verdict({ tool_name: `mcp__${server}__${tool}`, tool_input: {} }) ?? '', /never use a broker connection/, `${server} ${tool}`);
  const passing = [
    { tool_name: 'Bash', tool_input: { command: 'git diff HEAD~1 -- src' } },
    { tool_name: 'Bash', tool_input: { command: 'ls *.md src/*.ts && rm -f build/*.tmp' } },
    { tool_name: 'Bash', tool_input: { command: "sed -n 's/.*version//p' package.json && grep -E 'a.*b' README.md" } },
    { tool_name: 'Bash', tool_input: { command: 'ls ~/code/trading-agents/src/*' } },
    { tool_name: 'Bash', tool_input: { command: 'curl http://127.0.0.1:47660/' } },
    { tool_name: 'Bash', tool_input: { command: 'node dist/terminal.mjs' } },
    { tool_name: 'mcp__madav__send_message', tool_input: { text: 'the account is ready' } },
    { tool_name: 'Write', tool_input: { file_path: 'test/x.test.ts', content: `const f = [${q}.trading${q}, ${q}agents${q}].join(${q}-${q})` } },
  ];
  for (const call of passing) assert.equal(guard.verdict(call), null, JSON.stringify(call));
  assert.match(fs.readFileSync('.claude/hooks/guard.mjs', 'utf8'), /spelling check[\s\S]*permission prompts/, 'its header says what it is: a spelling check, behind the permission prompts');
  assert.ok(folder.startsWith('.'));
});

test('broker-6: the dashboard\'s start command, which prints a one-time link, is not pre-approved for agents', () => {
  const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')) as { permissions: { allow: string[] } };
  assert.deepEqual(settings.permissions.allow.filter((a) => /terminal\.mjs/.test(a)), []);
});

test('broker-7: after the weekly loss limit trips and the person switches trading back on, the limit counts from that moment', () => {
  const link = new Link(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-week-')), 'sign-in.json'));
  const now = new Date(), day = (n: number) => new Date(now.getTime() + n * 86_400_000);
  link.setTrading(true);
  link.noteValue(10_000, day(-3));
  assert.equal(link.noteValue(9_000, now).on, false, 'a 10% fall trips the 5% limit');
  assert.match(link.trading().offBecause!.words, /A large withdrawal can do this too\. When you switch it back on, the limit counts from then\.$/);
  assert.equal(link.setTrading(true).on, true);
  assert.equal(link.noteValue(9_000, now).on, true, 'the same reading does not switch it off again');
  assert.equal(link.noteValue(9_000, day(2)).on, true, 'nor two days later');
  assert.equal(link.noteValue(8_500, day(2)).on, false, 'a new fall of 5.6% from $9,000 does');
  // switched off and on by hand, with no trip: the week's readings still count
  const other = new Link(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-week-')), 'sign-in.json'));
  other.noteValue(10_000, day(-3));
  other.setTrading(true);
  assert.equal(other.noteValue(9_000, now).on, false);
});

test('broker-9: the agents read holdings as Robinhood gave them, never rounded', () => {
  const h: Holdings = { positions: [], source: 'robinhood', savedOn: '2026-11-09', accounts: [{ label: 'Desk', tradable: true, positions: [{ ticker: 'NVDA', quantity: 12_345 }, { ticker: 'AAPL', quantity: 153.25 }, { ticker: 'BTC-USD', quantity: 0.12345678 }] }] };
  const text = renderHoldings(h, 'NVDA');
  assert.match(text, /position in NVDA: 12,345 units/);
  assert.match(text, /other positions: AAPL 153\.25, BTC-USD 0\.12345678/);
  const given = renderHoldings({ positions: [{ ticker: 'NVDA', quantity: 12_345.5 }, { ticker: 'AAPL', quantity: 1.123456 }], source: 'person', savedOn: '2026-11-09' }, 'NVDA');
  assert.match(given, /Current position in NVDA: 12,345\.5 units/);
  assert.match(given, /Other positions: AAPL 1\.123456/);
});

test('broker-10: forgetting the sign-in from the command line switches trading off, as Disconnect does', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-forget-')), NAME = ['TRADING', 'AGENTS', 'HOME'].join('_');
  const was = process.env[NAME];
  process.env[NAME] = home;
  const file = robinhoodFile();
  if (was === undefined) delete process.env[NAME]; else process.env[NAME] = was;
  fs.writeFileSync(file, '{}');
  new Link(file).setTrading(true);
  const r = spawnSync(process.execPath, [path.join('build', 'src', 'robinhood', 'cli.js'), 'forget'], { env: { ...process.env, [NAME]: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^The saved Robinhood sign-in is deleted, and trading is switched off\. Connect again whenever you like\./);
  assert.equal(fs.existsSync(file), false);
  assert.equal(new Link(file).trading().on, false);
});

test('page-2: the page reads the trading switch again after reading Robinhood, after a ticket opens, and after Disconnect', () => {
  const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');
  const fn = (name: string) => { const at = page.indexOf(`async function ${name}(`); assert.ok(at >= 0, name); return page.slice(at, page.indexOf('\n}\n', at)); };
  assert.match(fn('readAccounts'), /finally \{[^}]*loadTrading\(\)/, 'the weekly loss limit may have switched trading off during the read');
  assert.match(fn('openTicket'), /loadTrading\(\)/, 'or while the ticket read the account');
  assert.match(page.match(/case 'rh-forget':[^\n]*/)![0], /loadTrading\(\)/, 'Disconnect switches trading off');
});

test('page-7: a cap typed with a decimal comma is read as a decimal, and a figure that is unclear is refused', () => {
  for (const [typed, read] of [['2,5', 2.5], ['7,5 %', 7.5], ['0,5', 0.5], ['$1,000', 1000], ['2,500.50', 2500.5], ['186,50', 186.5], ['5', 5], [' 12.5% ', 12.5], ['1,000,000', 1_000_000]] as const) assert.equal(typedNumber(typed), read, typed);
  for (const typed of ['', '1,2,3', '2,5.5', '1,5000', 'five', '1.2.3', ',5']) assert.ok(Number.isNaN(typedNumber(typed)), typed);
  const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');
  assert.doesNotMatch(page, /replace\(\/\[\$,%\\s\]\/g, ''\)/, 'no field drops a comma as if it were always a thousands comma');
  assert.match(page, /typedNumber\(field\('#tkLimit'\)\)/, 'the ticket\'s limit price is read the same way');
  assert.match(page, /typedNumber\(field\('#tkDollars'\)\)/, 'and a part-share\'s dollar amount');
});

test('page-10: a review that comes back after the figures were changed is not shown as the check of the new figures', () => {
  assert.equal(sameFigures({ id: 'a', quantity: 1, limit: 182.4 }, { id: 'a', quantity: 1, limit: 182.4 }), true);
  assert.equal(sameFigures({ id: 'a', quantity: 1, limit: 182.4 }, { id: 'a', quantity: 2, limit: 182.4 }), false);
  assert.equal(sameFigures({ id: 'a', quantity: 1, limit: 182.4 }, { id: 'a', quantity: 1, limit: 182.5 }), false);
  assert.equal(sameFigures({ id: 'a', quantity: 1, limit: 182.4 }, { id: 'b', quantity: 1, limit: 182.4 }), false);
  // A part-share: switching kind, or changing the dollar amount, is a change of figures too.
  assert.equal(sameFigures({ id: 'a', quantity: 1, limit: 182.4 }, { id: 'a', quantity: 1, limit: 182.4, market: true }), false);
  assert.equal(sameFigures({ id: 'a', quantity: 0.5, limit: 182.4, market: true, dollars: 91.2 }, { id: 'a', quantity: 0.5, limit: 182.4, market: true, dollars: 91.3 }), false);
  assert.equal(sameFigures({ id: 'a', quantity: 0.5, limit: 182.4, market: true, dollars: 91.2 }, { id: 'a', quantity: 0.5, limit: 182.4, market: true, dollars: 91.2 }), true);
  const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8'), at = page.indexOf('async function reviewTicket(');
  assert.match(page.slice(at, page.indexOf('\n}\n', at)), /const asked = askedNow\(\);[\s\S]*if \(!sameFigures\(asked, askedNow\(\)\)\) return;/);
  assert.match(page, /const askedNow = \(\): Asked => \(\{ id: T\.open\?\.id, quantity: T\.quantity, limit: T\.limit, market: T\.market, \.\.\.\(T\.market \? \{ dollars: T\.dollars \} : \{\}\) \}\);/, 'the figures compared are the ticket\'s own, kind and dollar amount included');
});

test('server-8: Stop waits while an order is being sent, as Restart does', async () => {
  let stops = 0;
  const { o, post, ticket, link } = await desk({}, { stop: () => { stops++; } });
  link.setTrading(true);
  const t = await ticket();
  await post('/api/ticket/review', { id: t.id, quantity: 1, limitPrice: 182.4 });
  let release!: () => void;
  o.placeWait = new Promise<void>((r) => { release = r; });
  const sending = post('/api/ticket/place', { id: t.id, confirm: 'Buy 1 NVDA at $182.40' });
  await until(() => o.placed.length === 1);
  const stop = await post('/api/stop', {});
  assert.equal(stop.status, 409);
  assert.match(stop.json().error, /^an order is being sent: stop when it is done$/);
  release();
  assert.equal((await sending).status, 200);
  assert.equal((await post('/api/stop', {})).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stops, 1);
});

test('the order log keeps one entry for each order, its first time and its latest answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-os-log-'));
  const base = { symbol: 'NVDA', side: 'buy' as const, quantity: 1, limitPrice: 182.4, ticket: 'abc' };
  logOrder(dir, { ...base, at: '2026-11-09T15:00:00.000Z', robinhood: { answered: false, unknown: true, approvalRequired: null, orderId: null, state: null, error: null } });
  logOrder(dir, { ...base, at: '2026-11-09T15:00:02.000Z', robinhood: { answered: true, approvalRequired: true, orderId: 'x', state: 'queued', error: null } });
  logOrder(dir, { ...base, ticket: 'def', at: '2026-11-09T15:05:00.000Z', robinhood: { answered: false, approvalRequired: null, orderId: null, state: null, error: 'no' } });
  const all = readOrders(dir);
  assert.deepEqual(all.map((x) => [x.ticket, x.at, x.robinhood.answered, x.robinhood.unknown ?? false]), [['abc', '2026-11-09T15:00:00.000Z', true, false], ['def', '2026-11-09T15:05:00.000Z', false, false]]);
});
