// Audit 3, group C (9 Nov 2026): scores, the paper record, coins and ticker spellings. Each test reproduces one finding
// with made-up journals and made-up price rows (no network, no Robinhood, no private folder).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { isCrypto, normalizeSymbol } from '../src/data/symbols.js';
import { checkWords, legacyRules, measure, rulesFor } from '../src/desk/scoring.js';
import { brokerSymbol } from '../src/data/symbols.js';
import { parseSearch } from '../src/terminal/search.js';
import { openSession } from '../src/robinhood/connect.js';
import { accountTools, fakeRobinhood } from './fake-robinhood.js';
import net from 'node:net';
import { followed, paperBook, type Closes } from '../src/desk/paper.js';
import { Journal } from '../src/desk/journal.js';
import { dueSettlements, settleOne } from '../src/desk/settle.js';
import { readHoldings, renderHoldings } from '../src/desk/holdings.js';
import { deskSymbol, dueForRerate, rerateWeekly } from '../src/desk/care.js';
import { finishItem, startItem } from '../src/desk/queue.js';
import { morningList } from '../src/desk/routine.js';
import { worked } from '../src/desk/backtest.js';
import { ticketable } from '../src/terminal/tiers.js';
import { shareHoldings, startTerminal, type Assets, type Terminal } from '../src/terminal/server.js';
import { nounOf, stateOf } from '../src/terminal/state.js';
import { againstOver, averageOf, rangeFor, resultOf } from '../src/terminal/ui/fmt.js';
import { Link } from '../src/robinhood/link.js';
import type { AccountView } from '../src/robinhood/account.js';
import { DEFAULT_CAPS, DEFAULTS } from '../src/settings.js';
import { chartFetch, chartJson, type Row } from './chart.js';

const S = DEFAULTS.scoring, T = DEFAULTS.trading, C = DEFAULT_CAPS;
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ta-c-${name}-`));
const weekdaysFrom = (from: string, n: number, skip: readonly string[] = []): string[] => {
  const out: string[] = [], d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) { const day = d.toISOString().slice(0, 10); if (d.getUTCDay() % 6 !== 0 && !skip.includes(day)) out.push(day); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};
const daysFrom = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const rowsOn = (days: string[], close: (i: number) => number): Row[] => days.map((date, i) => ({ date, o: close(i), h: close(i), l: close(i), c: close(i), v: 1000 }));
const closesOn = (pairs: Array<[string, number]>) => pairs.map(([date, close]) => ({ date, close }));
const decision = (rating: string, gist = 'A call.') => `**Rating**: ${rating}\n\n**Executive Summary**: ${gist}`;

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-11-09'; clearCache(); });
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const approves = (url: URL) => { void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };

// ---------- coins beyond the eleven the symbol list knew (prices-1, scoring-4) ----------
test('any coin Yahoo spells as a dollar pair is a coin: scored over 7 calendar days, not followed on paper, never given a ticket', () => {
  for (const s of ['SHIB-USD', 'BNB-USD', 'XLM-USD', 'PEPE24478-USD', 'UNI7083-USD', 'shib-usdt']) assert.equal(isCrypto(s), true, `${s} is a coin`);
  assert.equal(normalizeSymbol('shib-usdt'), 'SHIB-USD');
  for (const s of ['EUR-USD', 'XAU-USD', 'NVDA', 'BRK-B', 'SHIBUSD']) assert.equal(isCrypto(s), false, `${s} is not taken for a coin`);
  assert.equal(normalizeSymbol('BTCUSD'), 'BTC-USD', 'the compact spelling still works for the coins the list knows');
  assert.deepEqual(rulesFor('XLM-USD', S), { days: 7, unit: 'calendar', yardstick: 'SPY', basis: 'coin' });
  assert.equal(followed('BNB-USD'), false, 'among coins, paper follows Bitcoin and Ether only');
  assert.equal(ticketable('SHIB-USD'), false, "Robinhood's agent doorway trades stocks and funds only");
  const b = paperBook([{ ticker: 'XLM-USD', date: '2026-09-01', rating: 'Buy' }], { 'XLM-USD': closesOn([['2026-09-01', 0.1], ['2026-09-02', 0.1]]), SPY: closesOn([['2026-09-01', 500], ['2026-09-02', 500]]) }, { startUsd: 10_000, trading: T, caps: C, today: '2026-09-02' });
  assert.deepEqual([b.trades[0]!.status, b.trades[0]!.why], ['skipped', 'Among crypto, paper follows Bitcoin and Ether for now.']);
});

// ---------- ticker spellings between Yahoo, Robinhood and the desk (prices-4, broker-8, page-5, routines-8) ----------
const view = (key: string, agentic: boolean, held: Array<[string, number, ('stock' | 'crypto')?]>): AccountView => ({
  account: { key, last4: '0000', label: agentic ? 'Desk' : 'Individual account', agentic, isDefault: !agentic, deactivated: false },
  portfolio: null, holdings: held.map(([symbol, quantity, kind = 'stock']) => ({ symbol, quantity, averageCost: null, price: null, value: null, gainPct: null, kind })),
  unread: 0, orders: null, approvals: null, problems: [],
});

test('a US share class is asked of Yahoo as Yahoo spells it (BRK-B), and one-letter exchanges keep their dot', () => {
  assert.equal(normalizeSymbol('BRK.B'), 'BRK-B');
  assert.equal(normalizeSymbol('brk.a'), 'BRK-A');
  assert.equal(normalizeSymbol('BF.B'), 'BF-B');
  for (const s of ['VOD.L', '7203.T', 'RY.TO', 'SAP.DE', 'ABC.V', 'XYZ.F']) assert.equal(normalizeSymbol(s), s, `${s} is an exchange suffix`);
});

test("Robinhood's symbols are the desk's: a share class, a coin and a stock whose ticker is also a chart-site nickname", () => {
  assert.equal(deskSymbol('BRK.B', 'stock'), 'BRK-B');
  assert.equal(deskSymbol('WTI', 'stock'), 'WTI', 'W&T Offshore trades as WTI in New York: never crude oil futures');
  assert.equal(deskSymbol('USDC', 'crypto'), 'USDC-USD');
  assert.equal(deskSymbol('SHIB', 'crypto'), 'SHIB-USD');
  assert.equal(deskSymbol('BTC', 'crypto'), 'BTC-USD');
  const { dir } = { dir: path.join(tmp('hold'), 'desk-data') };
  assert.equal(shareHoldings(dir, { at: '2026-11-09T15:00:00Z', views: [view('ag', true, [['WTI', 40], ['BRK.B', 3], ['SHIB', 1000, 'crypto']])] }, '2026-11-09'), true);
  assert.deepEqual(readHoldings(dir)?.positions.map((p) => p.ticker), ['WTI', 'BRK-B', 'SHIB-USD']);
  const block = renderHoldings(readHoldings(dir), normalizeSymbol('BRK.B'));
  assert.match(block, /position in BRK-B: 3 units/, 'the agents analysing BRK-B see the holding Robinhood calls BRK.B');
});

test("an order ticket on BRK-B reads Robinhood's BRK.B holding and price, and asks Robinhood about BRK.B (broker-8)", async () => {
  const o = { reviewed: [] as Array<Record<string, unknown>>, agenticPositions: [{ symbol: 'BRK.B', quantity: '3.0000', average_buy_price: '480.00' }] as unknown[] };
  const fake = await fakeRobinhood((calls) => accountTools(calls, o));
  try {
    const port = await freePort(), file = path.join(tmp('rh'), 'sign-in.json');
    await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
    const link = new Link(file, { url: fake.url, port });
    const { accounts } = await link.accounts();
    await link.choose(accounts.filter((a) => !a.deactivated).map((a) => a.key));
    const c = await link.ticketContext('BRK-B');
    assert.deepEqual([c.held, c.price, c.positions?.map((p) => p.symbol)], [3, 1, ['BRK-B']], 'the holding and the price Robinhood gives for BRK.B');
    await link.review({ symbol: 'BRK-B', side: 'sell', quantity: 1, limitPrice: 1, timeInForce: 'gfd' });
    assert.equal(o.reviewed[0]?.symbol, 'BRK.B', "Robinhood is asked in its own spelling");
  } finally { await fake.close(); }
  assert.equal(brokerSymbol('BRK-B'), 'BRK.B');
  assert.equal(brokerSymbol('NVDA'), 'NVDA');
});

test('a search offers a coin only in dollars, never one in another currency as a stock', () => {
  const found = parseSearch({ quotes: [{ symbol: 'BTC-EUR', quoteType: 'CRYPTOCURRENCY', shortname: 'Bitcoin EUR' }, { symbol: 'SHIB-USD', quoteType: 'CRYPTOCURRENCY', shortname: 'Shiba Inu USD' }, { symbol: 'BRK-B', quoteType: 'EQUITY', shortname: 'Berkshire Hathaway' }] });
  assert.deepEqual(found.map((m) => [m.symbol, m.kind]), [['SHIB-USD', 'Crypto'], ['BRK-B', 'Stock']]);
});

test('a holding whose re-rating left no call goes after those with a real view the next Monday, and the brief says why', () => {
  const root = tmp('rerate'), dir = path.join(root, 'desk-data');
  shareHoldings(dir, { at: '2026-10-24T15:00:00Z', views: [view('ag', true, [['ZZZZ', 1], ['AAPL', 1], ['MSFT', 1], ['AMD', 1], ['TSLA', 1]])] }, '2026-10-24');
  const j = new Journal(path.join(dir, 'journal.md'));
  for (const [t, d] of [['AAPL', '2026-10-12'], ['MSFT', '2026-10-13'], ['AMD', '2026-10-14'], ['TSLA', '2026-10-15']] as const) j.storeDecision(t, d, decision('Hold'));
  const first = rerateWeekly(dir, '2026-10-26', new Date('2026-10-26T12:00:00Z'));
  assert.deepEqual(first.map((s) => s.symbol), ['ZZZZ', 'AAPL', 'MSFT'], 'a holding with no view goes first');
  // the analyses of AAPL and MSFT recorded calls; ZZZZ's left none (Yahoo has no such stock)
  const ran = new Date('2026-10-26T14:00:00Z');
  startItem(dir, 'ZZZZ', '2026-10-26', ran); finishItem(dir, 'ZZZZ', { reason: 'Yahoo Finance has no prices for ZZZZ' }, ran);
  for (const t of ['AAPL', 'MSFT']) { startItem(dir, t, '2026-10-26', ran); j.storeDecision(t, '2026-10-26', decision('Hold')); finishItem(dir, t, { rating: 'Hold' }, ran); }
  const due = dueForRerate(dir, '2026-11-02', new Date('2026-11-02T12:00:00Z'));
  assert.deepEqual(due.map((s) => s.symbol), ['AMD', 'TSLA', 'AAPL', 'MSFT', 'ZZZZ'], 'ZZZZ, tried last Monday with no call since, waits behind every holding with a real view (a view is due again after 7 days)');
  assert.equal(due.find((s) => s.symbol === 'ZZZZ')!.tried, '2026-10-26');
  assert.deepEqual(rerateWeekly(dir, '2026-11-02', new Date('2026-11-02T12:00:00Z')).map((s) => s.symbol), ['AMD', 'TSLA', 'AAPL']);
  assert.equal(dueForRerate(dir, '2026-11-09', new Date('2026-11-09T12:00:00Z')).at(-1)?.tried, '2026-10-26', 'still known as tried a week later');

  // when it is put on the list again, the morning brief says why it may have no view
  const small = path.join(tmp('rerate2'), 'desk-data'), k = new Journal(path.join(small, 'journal.md'));
  shareHoldings(small, { at: '2026-10-24T15:00:00Z', views: [view('ag', true, [['ZZZZ', 1], ['AAPL', 1]])] }, '2026-10-24');
  k.storeDecision('AAPL', '2026-10-12', decision('Hold'));
  rerateWeekly(small, '2026-10-26', ran);
  startItem(small, 'ZZZZ', '2026-10-26', ran); finishItem(small, 'ZZZZ', { reason: 'Yahoo Finance has no prices for ZZZZ' }, ran);
  startItem(small, 'AAPL', '2026-10-26', ran); k.storeDecision('AAPL', '2026-10-26', decision('Hold')); finishItem(small, 'AAPL', { rating: 'Hold' }, ran);
  assert.deepEqual(rerateWeekly(small, '2026-11-02', new Date('2026-11-02T12:00:00Z')).map((s) => s.symbol), ['AAPL', 'ZZZZ']);
  const why = morningList(small, '2026-11-02', 10).analyse.find((a) => a.symbol === 'ZZZZ')?.why ?? '';
  assert.match(why, /the desk has no view of it yet: the re-rating of 2026-10-26 left no call on it, so it may not be one the desk can analyse/);
});

// ---------- the paper record ----------
const book = (calls: Array<{ ticker: string; date: string; rating: string; recorded?: string }>, closes: Closes, today = '2026-09-04') =>
  paperBook(calls, closes, { startUsd: 10_000, trading: T, caps: { ...C, minHoldDays: 0 }, today });

test("when SPY's closes cannot be read, the paper record is withheld, never a total frozen at the last fill day (scoring-1)", () => {
  const closes: Closes = { NVDA: closesOn([['2026-09-01', 100], ['2026-09-02', 110], ['2026-09-08', 150]]) };
  const b = book([{ ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }], closes, '2026-09-08');
  assert.deepEqual([b.missing, b.value, b.returnPct, b.series, b.positions], [['SPY'], null, null, [], []]);
  assert.equal(b.trades[0]!.why, "Not worked out just now: the paper record needs the closing prices of SPY, which could not be read, and every order on paper is sized from the whole paper account, valued on SPY's trading days and measured against it.");
});

test('paper counts only the orders it placed that day: calls that place none leave room for a later buy (scoring-3)', () => {
  const closes: Closes = {
    NVDA: closesOn([['2026-09-01', 100], ['2026-09-02', 110]]), AAPL: closesOn([['2026-09-01', 200], ['2026-09-02', 201]]),
    MSFT: closesOn([['2026-09-01', 400], ['2026-09-02', 401]]), TSLA: closesOn([['2026-09-01', 300], ['2026-09-02', 301]]),
    SPY: closesOn([['2026-09-01', 500], ['2026-09-02', 505]]),
  };
  const b = book(['AAPL', 'MSFT', 'TSLA'].map((t) => ({ ticker: t, date: '2026-09-01', rating: 'Sell' })).concat([{ ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }]), closes, '2026-09-02');
  const nvda = b.trades.find((t) => t.ticker === 'NVDA')!;
  assert.equal(nvda.status, 'filled', nvda.why);
  for (const t of ['AAPL', 'MSFT', 'TSLA']) assert.match(b.trades.find((x) => x.ticker === t)!.why, /holds none to sell/);
});

test('a coin bought twice on paper is held in whole steps of 0.000001, never with float noise (page-14)', () => {
  const d = daysFrom('2026-09-01', 4);
  const closes: Closes = { 'BTC-USD': closesOn([[d[0]!, 500_000], [d[1]!, 556_173.53], [d[2]!, 557_413.6], [d[3]!, 557_413.6]]), SPY: closesOn(d.map((x) => [x, 500] as [string, number])) };
  // two buys of 0.000898 and 0.000897: the plain sum is 0.0017950000000000002
  const b = paperBook([{ ticker: 'BTC-USD', date: d[0]!, rating: 'Overweight' }, { ticker: 'BTC-USD', date: d[1]!, rating: 'Overweight' }], closes,
    { startUsd: 10_000, trading: T, caps: { ...C, cryptoPercent: 20, perStockPercent: 50, minHoldDays: 0 }, today: d[3]! });
  assert.deepEqual(b.trades.map((t) => t.quantity), [0.000897, 0.000898]);
  assert.equal(b.positions.find((p) => p.ticker === 'BTC-USD')!.quantity, 0.001795);
});

test('an analysis dated in the past does not move the paper record\'s start, and paper does not follow it (scoring-8)', () => {
  const root = tmp('late'), dir = path.join(root, 'desk-data');
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const j = new Journal(path.join(dir, 'journal.md'));
  j.storeDecision('NVDA', '2026-11-06', decision('Buy'), undefined, undefined, new Date('2026-11-06T21:10:00Z'));   // on its day, after the close
  j.storeDecision('MSFT', '2026-06-01', decision('Buy'), undefined, undefined, new Date('2026-11-09T14:00:00Z'));   // /analyse MSFT 2026-06-01, run today
  j.storeDecision('AAPL', '2026-11-06', decision('Buy'), undefined, undefined, new Date('2026-11-09T20:30:00Z'));   // Monday 3:30 p.m. New York: before the close it fills at
  j.storeDecision('AMD', '2026-11-05', decision('Buy'), undefined, undefined, new Date('2026-11-06T21:30:00Z'));    // Friday 4:30 p.m.: after the close it would fill at
  j.storeDecision('BTC-USD', '2026-11-01', decision('Buy'), undefined, undefined, new Date('2026-11-09T14:00:00Z')); // a coin's past-dated call
  const state = stateOf(root, '2026-11-09'), record = state.paper;
  assert.deepEqual([record.since, record.weeks, record.calls], ['2026-11-06', 0, 2]);
  // the call list says which calls paper follows, and a late Bitcoin call says why it is not, not "only Bitcoin and Ether"
  const callOn = (t: string) => state.calls.find((c) => c.ticker === t)!;
  assert.deepEqual(['NVDA', 'AAPL', 'MSFT', 'AMD', 'BTC-USD'].map((t) => callOn(t).paper), [true, true, false, false, false]);
  assert.equal(callOn('NVDA').late, undefined);
  assert.match(callOn('BTC-USD').late ?? '', /^Recorded on 2026-11-09, after the close of 2026-11-02 it would have filled at/);
  const closes: Closes = Object.fromEntries(['MSFT', 'NVDA', 'AAPL', 'AMD', 'SPY'].map((t) => [t, closesOn(weekdaysFrom('2026-05-25', 120).map((d) => [d, 100] as [string, number]))]));
  const b = book(j.load().map((e) => ({ ticker: e.ticker, date: e.date, rating: e.rating, ...(e.recorded ? { recorded: e.recorded } : {}) })), closes, '2026-11-09');
  const msft = b.trades.find((t) => t.ticker === 'MSFT')!;
  assert.equal(msft.status, 'skipped');
  assert.match(msft.why, /^Recorded on 2026-11-09, after the close of 2026-06-02 it would have filled at: paper follows a call only from when it was made/);
  assert.equal(b.trades.find((t) => t.ticker === 'AMD')!.status, 'skipped', 'recorded after the close of 6 Nov, its fill day');
  assert.equal(b.since, '2026-11-06');
  assert.equal(j.load().find((e) => e.ticker === 'MSFT')!.recorded, '2026-11-09T14:00Z');
});

// ---------- scoring ----------
test('a call on SPY, the yardstick itself, is not scored against itself: a Buy on a rising SPY works (scoring-5)', async () => {
  const days = weekdaysFrom('2026-10-01', 25), spy = rowsOn(days, (i) => 600 + i);
  configure({ fetch: chartFetch((s) => (s === 'SPY' || s === 'VOO' ? spy : [])) });
  const r = rulesFor('SPY', S), o = (await measure('SPY', '2026-10-23', r))!;
  assert.ok(o.raw > 0);
  assert.ok(Math.abs(o.alpha - o.raw) < 1e-12, 'its score is its own return');
  assert.equal(worked('Buy', Math.round(o.alpha * 1000) / 1000), true);
  assert.deepEqual([r.basis, rulesFor('VOO', S).basis, rulesFor('IVV', S).basis, rulesFor('QQQ', S).basis, rulesFor('NVDA', S).basis], ['same', 'same', 'same', 'us', 'us']);
  assert.equal(checkWords('SPY', r), 'a first-week check on its own return (SPY is the yardstick itself, so against it the alpha would always be zero), over the 5 trading days after the call');
  assert.match(checkWords('VOO', rulesFor('VOO', S)), /^a first-week check on its own return \(VOO copies the same index as SPY, so against it the alpha would be about zero whatever happened\)/);
  // the journal keeps why, and an old SPY call (no rules kept) keeps its old rules: scored against SPY as then
  const j = new Journal(path.join(tmp('own'), 'journal.md'));
  j.storeDecision('SPY', '2026-10-23', decision('Buy'), undefined, r);
  assert.deepEqual(j.load()[0]!.rules, r);
  assert.equal(legacyRules('SPY', S).basis, 'us');
  const listing = await dueSettlements(j, S, undefined, Date.parse('2026-11-09T08:00:00Z'));
  assert.match(listing, /READY: SPY \+[\d.]+% from 2026-10-23 to 2026-10-30 \(5 trading days\); scored on its own return, not against SPY: score \+[\d.]+%/);
  assert.match(listing, /THIS SCORE IS A FIRST-WEEK CHECK: the 5 trading days after the call on its own return \(SPY is the yardstick itself/);
  assert.doesNotMatch(listing, /SPY \+0\.0%|SPY 0\.0%/, 'no yardstick figure is made up for it');
});

test('record_decision keeps the rating the decision states: a different one passed is refused, and none stated is Needs review (scoring-6)', () => {
  const j = new Journal(path.join(tmp('rating'), 'journal.md'));
  assert.throws(() => j.storeDecision('NVDA', '2026-11-06', decision('Hold'), 'Buy'), /states Hold.*Buy|Buy.*states Hold/);
  assert.equal(j.load().length, 0);
  j.storeDecision('NVDA', '2026-11-06', 'We like it a lot.', 'Buy');
  assert.equal(j.load()[0]!.rating, 'Needs review');
});

test('a lesson written when the window\'s rows could not be read is never marked as written from them (scoring-9)', async () => {
  const dir = tmp('rows'), j = new Journal(path.join(dir, 'journal.md'));
  const nvda = rowsOn(weekdaysFrom('2026-09-01', 30), (i) => 100 + i), spy = rowsOn(weekdaysFrom('2026-08-20', 40), (i) => 500 + i);
  j.storeDecision('NVDA', '2026-09-01', decision('Buy'), undefined, { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'us' });
  let rowsDown = false;
  const feed = chartFetch((s) => (s === 'NVDA' ? nvda : s === 'SPY' ? spy : []));
  // the window's rows read a long history (for the indicators), from 2025: that one read fails while Yahoo is busy
  const historyRead = (url: string) => Number(/chart\/NVDA\?period1=(\d+)/.exec(url)?.[1] ?? Infinity) < Date.parse('2026-01-01T00:00:00Z') / 1000;
  configure({ fetch: async (input, init) => (rowsDown && historyRead(String(input)) ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } }) : feed(input, init)) });
  const t0 = Date.parse('2026-11-09T08:00:00Z');
  rowsDown = true;
  const listing = await dueSettlements(j, S, undefined, t0);
  assert.match(listing, /READY/);
  assert.match(listing, /Write the lesson from the outcome line alone/);
  rowsDown = false; clearCache();
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', 'Alpha was positive. The call held.', t0 + 60_000), /^Settled: /);
  assert.equal(j.load()[0]!.lesson, 'no-prices');
});

test('a call whose stock stopped trading for a week inside its window is scored once the later sessions come, not "not yet" for ever (scoring-10)', async () => {
  const closed = weekdaysFrom('2026-02-16', 7);   // 16 to 24 Feb: seven weekdays without trading
  const stock = rowsOn(weekdaysFrom('2026-02-09', 40, closed), (i) => 100 + i), spy = rowsOn(weekdaysFrom('2026-02-01', 60), (i) => 500 + i);
  configure({ fetch: chartFetch((s) => (s === 'ABC' ? stock : s === 'SPY' ? spy : [])) });
  const o = await measure('ABC', '2026-02-12', { days: 5, unit: 'trading', yardstick: 'SPY' });
  assert.ok(o, 'scored');
  assert.deepEqual([o!.entry, o!.exit], ['2026-02-12', '2026-03-02']);
  // a stock with no session since, two sessions into its window: said plainly, never "not yet" for ever
  clearCache();
  const stopped = rowsOn(['2026-09-01', '2026-09-02', '2026-09-03'], () => 50);
  configure({ fetch: chartFetch((s) => (s === 'GONE' ? stopped : s === 'SPY' ? spy : [])) });
  await assert.rejects(measure('GONE', '2026-09-01', { days: 5, unit: 'trading', yardstick: 'SPY' }), /no price for GONE after 2026-09-03, 2 sessions into its 5 trading days window: it may have stopped trading or been halted/);
});

test('a journal saved with Windows line ends, or with a blank line taken out at a separator, keeps every entry apart (scoring-11)', () => {
  const file = path.join(tmp('crlf'), 'journal.md'), j = new Journal(file);
  j.storeDecision('NVDA', '2026-10-01', decision('Buy'));
  j.storeDecision('AAPL', '2026-10-02', decision('Hold'));
  j.storeDecision('MSFT', '2026-10-03', decision('Sell'));
  const lf = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, lf.replace(/\n/g, '\r\n'));
  assert.deepEqual(j.load().map((e) => e.ticker), ['NVDA', 'AAPL', 'MSFT']);
  assert.equal(j.storeDecision('AAPL', '2026-10-02', decision('Hold')), 'exists');
  assert.equal(j.recordOutcome('NVDA', '2026-10-01', 0.01, 0.005, 5, 'The lesson.', '2026-10-08', 'prices'), true);
  assert.equal(j.load().find((e) => e.ticker === 'NVDA')!.reflection, 'The lesson.');
  assert.ok(fs.readFileSync(file, 'utf8').includes('\r\n') && !/[^\r]\n/.test(fs.readFileSync(file, 'utf8')), 'written back with its own line ends');
  fs.writeFileSync(file, lf.replace('\n\n<!-- ENTRY_END -->\n\n', '\n<!-- ENTRY_END -->\n'));
  assert.deepEqual(j.load().map((e) => e.ticker), ['NVDA', 'AAPL', 'MSFT']);
});

// ---------- the words a person reads (coordinator-1) ----------
test('a coin\'s result says the coin, a fund\'s the fund, and the scorecard names no stock for what it averages', () => {
  const base = { rating: 'Buy', alpha: '+1.2%', worked: true, yardstick: 'SPY', window: '7 calendar days', check: 'a first-week check', why: '' };
  assert.match(resultOf({ ...base, noun: 'coin' } as Parameters<typeof resultOf>[0]).why, /A Buy works when the coin beats SPY over the 7 calendar days after the call/);
  assert.match(resultOf({ ...base, rating: 'Hold', worked: null, noun: 'fund' } as Parameters<typeof resultOf>[0]).why, /how the fund did against SPY/);
  assert.doesNotMatch(averageOf('Buy', { direction: 1, meanAlpha: 0.012 }).why, /stock/);
  const own = resultOf({ ...base, rating: 'Buy', alpha: '+2.0%', window: '5 trading days', noun: 'fund', own: true, why: 'SPY is the yardstick itself, so against it the alpha would always be zero' });
  assert.equal(own.words, 'worked · its return +2.0%');
  assert.match(own.why, /^A Buy works when the fund rises over the 5 trading days after the call\. It did \(its return \+2\.0%\): the call worked\. It is a first-week check, not the call's own time horizon\. Scored on its own return: SPY is the yardstick itself/);
  assert.equal(againstOver({ yardstick: 'SPY', window: '5 trading days', own: true }), 'on its own return over the 5 trading days after the call');
  assert.equal(nounOf('BTC-USD'), 'coin'); assert.equal(nounOf('XLK'), 'fund'); assert.equal(nounOf('VOO'), 'fund'); assert.equal(nounOf('NVDA'), 'stock');
});

test("a call's window on the stock page reads a range that reaches back to the call, never always six months (page-13)", () => {
  assert.equal(rangeFor('2026-11-02', '2026-11-09'), '1M');
  assert.equal(rangeFor('2026-09-01', '2026-11-09'), '3M');
  assert.equal(rangeFor('2026-06-01', '2026-11-09'), '6M');
  assert.equal(rangeFor('2026-03-02', '2026-11-09'), '1Y');
  assert.equal(rangeFor('2025-06-02', '2026-11-09'), '5Y');
});

// ---------- the dashboard's own paper read (scoring-2) ----------
let term: Terminal | null = null;
afterEach(async () => { await term?.close(); term = null; });

test('during market hours, paper never fills a call at the still-moving price of today as "the close" (scoring-2)', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-09';
  const root = tmp('live'), dir = path.join(root, 'desk-data');
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const days = weekdaysFrom('2026-10-01', 28);   // to Mon 9 Nov 2026, today: its row is still trading
  const open = { currentTradingPeriod: { regular: { start: Date.parse('2026-11-09T14:30:00Z') / 1000, end: Math.floor(Date.now() / 1000) + 3600 } } };
  configure({ secEmail: '', fetch: async (input) => {
    const m = /\/v8\/finance\/chart\/([^?]+)/.exec(String(input));
    if (!m) return new Response('not found', { status: 404 });
    const sym = decodeURIComponent(m[1]!);
    return new Response(JSON.stringify(chartJson(sym, rowsOn(days, (i) => (sym === 'SPY' ? 600 : 170 + i)), open)), { status: 200 });
  } });
  new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', '2026-11-06', decision('Buy'));
  term = await startTerminal({ root, assets: new Map() as Assets, port: 0, keyFile: path.join(root, 'keys.json'), robinhood: new Link(path.join(root, 'rh', 'sign-in.json')) });
  const r = await fetch(`${term.url}api/paper`, { headers: { 'x-desk-token': term.token } });
  const t = ((await r.json()) as { trades: Array<{ ticker: string; status: string; fillDate?: string }> }).trades.find((x) => x.ticker === 'NVDA')!;
  assert.equal(t.status, 'waiting', `not filled at today's live price (${JSON.stringify(t)})`);
});
