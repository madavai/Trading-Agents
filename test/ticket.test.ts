import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { check, edit, passes, propose, proposeOwn, type Order, type TicketContext } from '../src/desk/ticket.js';
import { cryptoOrderArgs, equityOrderArgs, masked } from '../src/robinhood/rules.js';
import { capsFrom, capsOf, DEFAULT_CAPS, DEFAULTS, readSettings, tradingOf } from '../src/settings.js';
import { Sectors } from '../src/desk/sectors.js';
import { parsePreview, parseReview, Reviewer } from '../src/robinhood/review.js';
import { Refused } from '../src/robinhood/reader.js';
import { Link } from '../src/robinhood/link.js';
import { openSession } from '../src/robinhood/connect.js';
import { Journal } from '../src/desk/journal.js';
import { startTerminal, type Assets } from '../src/terminal/server.js';
import { accountTools, AGENTIC, fakeRobinhood, MAIN, type Fake } from './fake-robinhood.js';

const T = DEFAULTS.trading, C = DEFAULT_CAPS;   // full position 10%; caps $500 an order, 10% a stock, 3 orders a day
const ctx = (o: Partial<TicketContext> = {}): TicketContext => ({ symbol: 'NVDA', rating: 'Buy', callDate: '2026-10-15', accountValue: 2500, buyingPower: 2500, held: 0, price: 182.4, ordersToday: 0, ...o });

test('a real coin ticket: on Robinhood\'s own steps and bounds, good till cancelled, with coin buys not yet filled counted as if filled', () => {
  const rules = { quantityStep: 1e-8, priceStep: 0.01, minQuantity: 0.000001, maxQuantity: 20 };
  const btc = (o: Partial<TicketContext> = {}): TicketContext => ctx({ symbol: 'BTC-USD', price: 82_000.004, cryptoHeldUsd: 0, coin: { rules, openUsd: 0 }, ...o });
  const p = propose(btc(), T, C);
  assert.deepEqual(p.order, { symbol: 'BTC-USD', side: 'buy', quantity: 0.00152439, limitPrice: 82_000, timeInForce: 'gtc' }, '5% of $2,500 is $125, at the live price put on its cent step');
  assert.match(p.why.join(' '), /rounded down to BTC-USD's step of 0\.00000001 BTC: 0\.00152439 BTC/);
  assert.match(p.why.join(' '), /stays open until it fills or you cancel it in Robinhood's app, for at most 90 days/);
  // One open buy of 3% ($75) leaves 2% ($50); two of 3% each ($150) are over the 5% limit, so a third coin buy is refused.
  const one = propose(btc({ cryptoHeldUsd: 75, coin: { rules, openUsd: 75 } }), T, C);
  assert.equal(one.order?.quantity, 0.00060975);
  assert.match(one.why.join(' '), /Your crypto limit of 5% of the account leaves \$50\.00, counting \$75\.00 in coin buys not yet filled, so at most that\./);
  const two = btc({ cryptoHeldUsd: 150, coin: { rules, openUsd: 150 } });
  assert.equal(propose(two, T, C).order, null);
  assert.ok(check({ ...p.order!, quantity: 0.00001 }, two, T, C).some((x) => !x.ok && /^Crypto would be 6\.0% of the account, counting \$150\.00 in coin buys not yet filled; your limit is 5%$/.test(x.words)));
  // The coin's own cap counts the amount waiting in buys not yet filled, as a stock's does.
  const wide = { ...C, cryptoPercent: 100 }, waiting = btc({ open: { buy: 0.002, sell: 0 }, cryptoHeldUsd: 164, coin: { rules, openUsd: 164 } });
  assert.ok(check({ ...p.order!, quantity: 0.002 }, waiting, T, wide).some((x) => !x.ok && /^BTC-USD would be 13\.1% of the account, counting 0\.002 BTC in orders not yet filled; your cap is 10%$/.test(x.words)));
  // Robinhood's steps and bounds, and its price step.
  const fails = (x: Partial<Order>) => check({ ...p.order!, ...x }, btc(), T, C).filter((k) => !k.ok).map((k) => k.words).join(' | ');
  assert.equal(fails({}), '');
  for (const q of [0.000000015, 0.0000005, 21]) assert.equal(fails({ quantity: q }), "The amount must be in steps of 0.00000001 BTC, from 0.000001 to 20 BTC (Robinhood's rules for BTC-USD)");
  assert.match(fails({ limitPrice: 82_000.005 }), /The limit price must be above zero, in dollars and cents/);
  assert.match(fails({ market: true }), /BTC-USD is crypto: the desk sizes it at a limit price, never at the market price/);
  // Nothing proposed when Robinhood says no, or when the crypto limit cannot be checked.
  for (const unusable of ['Robinhood has halted trading in BTC-USD for now.', "Robinhood says no crypto account is open yet: open one in Robinhood's app, then try again."]) {
    const x = propose(btc({ coin: { rules, unusable } }), T, C);
    assert.deepEqual([x.order, x.why.at(-1)], [null, unusable]);
    assert.ok(check(p.order!, btc({ coin: { rules, unusable } }), T, C).some((k) => !k.ok && unusable.startsWith(k.words)));
  }
  assert.match(propose(btc({ coin: { rules, openUsd: 0, unchecked: ['Robinhood gave no live price for ETH-USD'] } }), T, C).why.at(-1)!, /^Your crypto limit cannot be checked: Robinhood gave no live price for ETH-USD\.$/);
  // A sell: on the step, at least the least Robinhood takes.
  assert.deepEqual(propose(btc({ rating: 'Sell', held: 0.001234567 }), T, C).order, { symbol: 'BTC-USD', side: 'sell', quantity: 0.00123456, limitPrice: 82_000, timeInForce: 'gtc' });
  assert.match(propose(btc({ rating: 'Underweight', held: 0.0000015 }), T, C).why.at(-1)!, /half of that is less than the smallest order Robinhood takes for it, 0\.000001 BTC/);
  // The person's own coin order starts at the least Robinhood takes, at least a dollar's worth, on the step.
  const own = proposeOwn(btc(), 'buy', T, C);
  assert.deepEqual(own.order, { symbol: 'BTC-USD', side: 'buy', quantity: 0.00001220, limitPrice: 82_000, timeInForce: 'gtc' });
  assert.equal(edit(own.order!, btc(), T, { quantity: 0.0001, limitPrice: 81_000 }).timeInForce, 'gtc', 'a coin stays good till cancelled whatever is typed');
});

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
  assert.deepEqual(c, { name: 'Technology', label: 'Technology', heldUsd: 2_500, openUsd: 0, unpriced: [] }, 'a sector fund counts towards its sector; a whole-market fund and a stock not looked up do not');
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
  // Crypto as paper sizes it (no coin rules from Robinhood): in fractions, within what the crypto limit leaves, never under
  // a dollar; a coin limit order is always good till cancelled, as Robinhood takes it.
  const btc = propose({ ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 200 }, T, C);
  assert.deepEqual(btc.order, { symbol: 'BTC-USD', side: 'buy', quantity: 0.003658, limitPrice: 82_000, timeInForce: 'gtc' }, '5% of $10,000 less the $200 held leaves $300: 0.003658 BTC');
  assert.match(btc.why.join(' '), /Your crypto limit of 5% of the account leaves \$300\.00, so at most that\..*rounded down to six decimal places: 0\.003658 BTC/);
  assert.equal(passes(check(btc.order!, { ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 200 }, T, C)), true);
  assert.match(propose({ ...big, symbol: 'BTC-USD', price: 82_000, cryptoHeldUsd: 499.5 }, T, C).why.at(-1)!, /\$0\.50 is under \$1\.00, the smallest crypto order/);
  assert.equal(propose({ ...big, symbol: 'BTC-USD', price: 82_000, held: 0.003658, rating: 'Underweight' }, T, C).order?.quantity, 0.001829, 'half of what is held, to six decimal places');
  assert.equal(passes(check({ ...buy, symbol: 'BTC-USD', quantity: 0.0000001 }, { ...big, symbol: 'BTC-USD' }, T, C)), false, 'no finer than six decimal places');
  assert.equal(passes(check({ ...buy, quantity: 0.5 }, big, T, C)), false, 'a limit order of a stock is still whole shares: a part of one is a market order');
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
  const own = (o: Partial<TicketContext>, side: 'buy' | 'sell', caps = C) => proposeOwn(ctx({ rating: '', callDate: '', ...o }), side, T, caps);
  const buy = own({}, 'buy');
  assert.equal(buy.action, 'your own buy');
  assert.deepEqual(buy.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });
  assert.match(buy.why[0]!, /^Your own order: one whole share to start, at Robinhood's live price of \$182\.40\./);
  assert.equal(own({ price: null }, 'buy').order, null, 'no live price, no order');
  assert.match(own({}, 'sell').why[0]!, /holds no NVDA to sell/);
  // Less than one share held: it sells all of it, as a part-share at the market price, the only way Robinhood takes one.
  assert.deepEqual(own({ held: 0.4 }, 'sell').order, { symbol: 'NVDA', side: 'sell', quantity: 0.4, limitPrice: 182.4, timeInForce: 'gfd', market: true });
  assert.match(own({ held: 0.4 }, 'sell').why.join(' '), /holds 0\.4 of a share of NVDA, so it sells all of it, a part-share at the market price\. A part-share is a market order/);
  // One share dearer than the cap or the buying power: it starts as the smallest part-share, which the person changes.
  const dear = own({ symbol: 'META', price: 648.85 }, 'buy');
  assert.deepEqual(dear.order, { symbol: 'META', side: 'buy', quantity: 0.001541, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 1 });
  assert.match(dear.why[0]!, /^Your own order: one share of META costs \$648\.85, more than your cap of \$500\.00 an order, so it starts as a part-share of \$1\.00 at the market price\./);
  assert.match(own({ symbol: 'META', price: 648.85, buyingPower: 300 }, 'buy', { ...C, perOrderUsd: 1000 }).why[0]!, /more than the buying power of \$300\.00/);
  const sell = own({ held: 3 }, 'sell');
  assert.deepEqual([sell.action, sell.order?.side, sell.order?.quantity], ['your own sell', 'sell', 1]);
  // the same checks as a call's ticket: a person's own order is no way around the caps
  const c = ctx({ rating: '', callDate: '' });
  assert.equal(passes(check(buy.order!, c, T, C)), true);
  assert.equal(passes(check({ ...buy.order!, quantity: 3 }, c, T, C)), false, '$547.20 is over the $500 cap');
  assert.equal(passes(check({ ...sell.order!, quantity: 4 }, ctx({ held: 3 }), T, C)), false, 'only three are held');
  assert.equal(passes(check(buy.order!, ctx({ ordersToday: 3 }), T, C)), false, 'three orders a day');
});

test('a buy is sized from the account, then held to the caps and buying power, in whole shares when one fits', () => {
  const full = propose(ctx(), T, C);
  assert.deepEqual(full.order, { symbol: 'NVDA', side: 'buy', quantity: 1, limitPrice: 182.4, timeInForce: 'gfd' });   // 10% of $2,500 is $250: one share at $182.40
  assert.match(full.why.join(' '), /A full position: 10% of the account's \$2,500\.00 is \$250\.00\..*\$250\.00 ÷ \$182\.40, rounded down: 1 share/);
  assert.equal(propose(ctx({ accountValue: 20_000 }), T, C).order?.quantity, 2, '10% is $2,000, the $500 cap makes it $500: two shares');
  assert.match(propose(ctx({ accountValue: 20_000 }), T, C).why.join(' '), /Your cap of \$500\.00 an order makes it \$500\.00/);
  assert.equal(propose(ctx({ accountValue: 20_000, buyingPower: 200 }), T, C).order?.quantity, 1);
  const half = propose(ctx({ rating: 'Overweight' }), T, C);
  assert.deepEqual(half.order, { symbol: 'NVDA', side: 'buy', quantity: 0.685307, limitPrice: 182.4, timeInForce: 'gfd', market: true, dollars: 125 }, '5% of $2,500 is $125, less than one share: a part of one');
  assert.match(half.why.join(' '), /One share costs \$182\.40, more than \$125\.00, so a part of a share: \$125\.00 of NVDA, about 0\.685307 of a share at Robinhood's live price\. A part-share is a market order/);
  assert.doesNotMatch(half.why.join(' '), /Limit price/, 'a part-share has no limit price');
  assert.equal(propose(ctx({ price: null }), T, C).order, null);
  assert.match(propose(ctx({ accountValue: null }), T, C).why.at(-1)!, /no total value/);
  assert.match(propose(ctx({ rating: 'Hold' }), T, C).why[0]!, /place no order for that rating/);
  assert.equal(propose(ctx({ rating: 'Needs review' }), T, C).order, null);
});

test('a sell is what is held, halved or whole, never more: whole shares when they do the job, else a part-share', () => {
  assert.equal(propose(ctx({ rating: 'Sell' }), T, C).order, null, 'nothing held, nothing to sell');
  assert.deepEqual(propose(ctx({ rating: 'Sell', held: 7 }), T, C).order, { symbol: 'NVDA', side: 'sell', quantity: 7, limitPrice: 182.4, timeInForce: 'gfd' }, 'everything held, in whole shares at a limit price');
  const all = propose(ctx({ rating: 'Sell', held: 7.5 }), T, C);
  assert.deepEqual(all.order, { symbol: 'NVDA', side: 'sell', quantity: 7.5, limitPrice: 182.4, timeInForce: 'gfd', market: true }, 'everything held, the part of a share included: a market order');
  assert.match(all.why.join(' '), /Everything held: 7\.5 share\(s\), a part of a share included, so a part-share sold at the market price, about \$1,368\.00 now/);
  assert.equal(propose(ctx({ rating: 'Underweight', held: 7 }), T, C).order?.quantity, 3, 'half of seven, in whole shares');
  assert.deepEqual(propose(ctx({ rating: 'Underweight', held: 1 }), T, C).order, { symbol: 'NVDA', side: 'sell', quantity: 0.5, limitPrice: 182.4, timeInForce: 'gfd', market: true }, 'half of one share: a part-share');
  assert.equal(propose(ctx({ rating: 'Underweight', held: 0.770594, symbol: 'META', price: 648.85 }), T, C).order?.quantity, 0.385297, 'half of a part-share, to six decimal places');
  assert.match(propose(ctx({ rating: 'Underweight', held: 0.004, price: 182.4 }), T, C).why.at(-1)!, /worth about \$0\.36, under \$1\.00, the smallest part-share order/);
});

test('a share dearer than the order may spend is bought in part, at the market price: the desk\'s META call of 21 Oct', () => {
  // Paper's $10,000: an Overweight is half a position, 5%, $500, and the cap is $500; META closed at $648.85 on 22 Oct.
  const meta = ctx({ symbol: 'META', rating: 'Overweight', accountValue: 10_000, buyingPower: 10_000, price: 648.85 });
  const p = propose(meta, T, C);
  assert.deepEqual(p.order, { symbol: 'META', side: 'buy', quantity: 0.770594, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 500 });
  assert.equal(passes(check(p.order!, meta, T, C)), true);
  const words = check(p.order!, meta, T, C).map((x) => x.words);
  assert.deepEqual(words.slice(0, 2), ['$500.00 of META, about 0.770594 of a share at Robinhood\'s live price', "A market order: it fills at the market's price at that moment, about $648.85 a share now; Robinhood's check shows only an estimate"]);
  assert.ok(words.includes('$500.00 is within your cap of $500.00 an order'), 'the cap is checked on the dollar amount, which a market buy fixes');
  assert.ok(!words.some((w) => /from Robinhood's live price/.test(w)), 'no limit price, so no check of one');
  // A whole share that fits keeps a limit order.
  assert.equal(propose({ ...meta, price: 480 }, T, C).order?.market, undefined);
  assert.equal(propose({ ...meta, accountValue: 10, buyingPower: 0.5 }, T, C).why.at(-1), '$0.50 is under $1.00, the smallest part-share order.');
});

test('a part-share is checked as Robinhood takes one: in regular hours, a dollar amount of at least $1, six decimal places', () => {
  const meta = ctx({ symbol: 'META', accountValue: 10_000, buyingPower: 10_000, price: 648.85 });
  const buy: Order = { symbol: 'META', side: 'buy', quantity: 0.770594, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 500 };
  const failing = (o: Partial<Order>, c: Partial<TicketContext> = {}) => check({ ...buy, ...o }, { ...meta, ...c }, T, C).filter((x) => !x.ok).map((x) => x.words).join(' | ');
  assert.equal(failing({}, { session: { open: true, opens: '' } }), '');
  assert.ok(check(buy, { ...meta, session: { open: true, opens: '' } }, T, C).some((x) => x.ok && x.words === 'The US market is open, so a part-share can be sent now'));
  assert.equal(failing({}, { session: { open: false, opens: 'Monday 2026-11-16 at 9:30 a.m. New York time' } }), 'A part-share is sent only while the US market is open, 9:30 a.m. to 4 p.m. New York time: it opens Monday 2026-11-16 at 9:30 a.m. New York time');
  assert.match(failing({ dollars: 0.5 }), /dollar amount in dollars and cents, at least \$1\.00/);
  assert.match(failing({ dollars: 10.005 }), /dollars and cents/);
  assert.match(failing({ dollars: undefined }), /dollar amount/);
  assert.match(failing({ dollars: 600, quantity: 0.924713 }), /\$600\.00 is over your cap of \$500\.00 an order/);
  assert.match(failing({}, { price: null }), /no live price for META to estimate the order with/);
  assert.match(failing({}, { held: 1 }), /META would be 11\.5% of the account; your cap is 10%/, 'what is held counts at the live price, the part-share at its dollar amount');
  const sell: Order = { symbol: 'META', side: 'sell', quantity: 0.5, limitPrice: 648.85, timeInForce: 'gfd', market: true };
  assert.equal(passes(check(sell, { ...meta, held: 0.770594 }, T, C)), true);
  assert.match(check({ ...sell, quantity: 0.0000001 }, { ...meta, held: 0.770594 }, T, C).filter((x) => !x.ok)[0]!.words, /six decimal places/);
  assert.match(check({ ...sell, quantity: 0.001 }, { ...meta, held: 0.770594 }, T, C).filter((x) => !x.ok)[0]!.words, /About \$0\.65: a part-share order is at least \$1\.00, unless it sells everything held/);
  assert.equal(passes(check({ ...sell, quantity: 0.001 }, { ...meta, held: 0.001 }, T, C)), true, 'everything held may be less than $1');
  assert.match(check({ ...sell, quantity: 0.8 }, { ...meta, held: 0.770594 }, T, C).filter((x) => !x.ok)[0]!.words, /Only 0\.770594 share\(s\) are held/);
  assert.equal(passes(check({ ...buy, symbol: 'BTC-USD' }, { ...meta, symbol: 'BTC-USD' }, T, C)), false, 'crypto is never a market order here');
});

test('the person switches a ticket between whole shares and a part-share; never its stock or side', () => {
  const meta = ctx({ symbol: 'META', price: 648.853 });
  const limit: Order = { symbol: 'META', side: 'buy', quantity: 1, limitPrice: 648.85, timeInForce: 'gtc' };
  assert.deepEqual(edit(limit, meta, T, { market: true, dollars: 250, symbol: 'TSLA', side: 'sell' }), { symbol: 'META', side: 'buy', quantity: 0.385297, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 250 });
  assert.deepEqual(edit(limit, meta, T, { quantity: 2, limitPrice: 640 }), { symbol: 'META', side: 'buy', quantity: 2, limitPrice: 640, timeInForce: 'gtc' }, 'a limit order keeps its own time in force');
  const part = edit(limit, meta, T, { market: true, dollars: 250 });
  assert.deepEqual(edit(part, meta, T, { quantity: 1, limitPrice: 648.85 }), { symbol: 'META', side: 'buy', quantity: 1, limitPrice: 648.85, timeInForce: 'gfd' }, 'back to whole shares, at the time in force of the person\'s settings');
  assert.deepEqual(edit({ ...limit, side: 'sell' }, meta, T, { market: true, quantity: 0.25 }), { symbol: 'META', side: 'sell', quantity: 0.25, limitPrice: 648.85, timeInForce: 'gfd', market: true });
  assert.ok(Number.isNaN(edit(limit, meta, T, { market: true, dollars: '250' }).dollars!), 'a figure must be a number');
  assert.equal(edit({ ...limit, symbol: 'BTC-USD' }, meta, T, { market: true, quantity: 0.1, limitPrice: 80_000 }).market, undefined, 'crypto stays a limit order');
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

test('the reviewer asks only for Robinhood\'s check, only on the Agentic account, only for an order the desk sends', async () => {
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
  // A part-share: a market order in regular hours, a buy as a dollar amount, never with a limit price.
  await rv.review({ accountNumber: AGENTIC, agentic: true }, { symbol: 'META', side: 'buy', quantity: 0.770594, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 500 });
  assert.deepEqual(reviewed[1], { account_number: AGENTIC, symbol: 'META', side: 'buy', type: 'market', dollar_amount: '500.00', time_in_force: 'gfd', market_hours: 'regular_hours' });
  await assert.rejects(rv.review({ accountNumber: AGENTIC, agentic: true }, { symbol: 'META', side: 'buy', quantity: 0.0015, limitPrice: 648.85, timeInForce: 'gfd', market: true, dollars: 0.99 }), /not complete/, 'under a dollar: not sent');
  await client.close();
});

test('what the two order doors send is Robinhood\'s own rules: whole shares at a limit, or a part-share at the market in regular hours', () => {
  const o = (x: Partial<Order>): Order => ({ symbol: 'META', side: 'buy', quantity: 1, limitPrice: 648.85, timeInForce: 'gtc', ...x });
  assert.deepEqual(equityOrderArgs('A1', o({})), { account_number: 'A1', symbol: 'META', side: 'buy', type: 'limit', quantity: '1', limit_price: '648.85', time_in_force: 'gtc', market_hours: 'regular_hours' });
  assert.deepEqual(equityOrderArgs('A1', o({ market: true, dollars: 500, quantity: 0.770594 })), { account_number: 'A1', symbol: 'META', side: 'buy', type: 'market', dollar_amount: '500.00', time_in_force: 'gfd', market_hours: 'regular_hours' }, 'a buy is a dollar amount, good for the day, whatever the settings say');
  assert.deepEqual(equityOrderArgs('A1', o({ side: 'sell', market: true, quantity: 0.5 })), { account_number: 'A1', symbol: 'META', side: 'sell', type: 'market', quantity: '0.5', time_in_force: 'gfd', market_hours: 'regular_hours' });
  assert.equal(equityOrderArgs('A1', o({ side: 'sell', market: true, quantity: 0.770594 }))!.quantity, '0.770594');
  assert.equal(equityOrderArgs('A1', o({ side: 'sell', market: true, quantity: 3 }))!.quantity, '3');
  for (const bad of [o({ quantity: 0.5 }), o({ quantity: 0 }), o({ limitPrice: 0 }), o({ market: true }), o({ market: true, dollars: 0.5 }), o({ market: true, dollars: 10.001 }), o({ side: 'sell', market: true, quantity: 0.0000001 }), o({ side: 'sell', market: true, quantity: -1 }), o({ side: 'hold' as 'buy' })]) assert.equal(equityOrderArgs('A1', bad), null, JSON.stringify(bad));
});

test('a coin order is sent as Robinhood\'s rules for it say: a limit order, good till cancelled, on the coin\'s steps, in plain digits', () => {
  const rules = { quantityStep: 1e-8, priceStep: 0.01, minQuantity: 0.000001, maxQuantity: 20 };
  const o = (x: Partial<Order>): Order => ({ symbol: 'BTC-USD', side: 'buy', quantity: 0.0000123, limitPrice: 82_000, timeInForce: 'gtc', ...x });
  assert.deepEqual(cryptoOrderArgs('881004321', o({}), rules), { rhs_account_number: '881004321', symbol: 'BTC-USD', side: 'buy', type: 'limit', quantity: '0.0000123', limit_price: '82000.00', time_in_force: 'gtc' }, 'never 1.23e-5');
  assert.equal(cryptoOrderArgs('881004321', o({ quantity: 0.12345678, side: 'sell' }), rules)!.quantity, '0.12345678');
  assert.equal(cryptoOrderArgs('881004321', o({ limitPrice: 0.000123 }), { ...rules, priceStep: 0.000001 })!.limit_price, '0.000123', 'a coin priced under a cent keeps its own price step');
  assert.equal(cryptoOrderArgs('881004321', o({ timeInForce: 'gfd' }), rules)!.time_in_force, 'gtc', 'a coin limit order is always good till cancelled');
  for (const bad of [o({ quantity: 0.000000015 }), o({ quantity: 0.0000005 }), o({ quantity: 21 }), o({ quantity: 0 }), o({ limitPrice: 82_000.005 }), o({ limitPrice: 0 }), o({ market: true, dollars: 50 }), o({ side: 'hold' as 'buy' })]) assert.equal(cryptoOrderArgs('881004321', bad, rules), null, JSON.stringify(bad));
  assert.equal(cryptoOrderArgs('', o({}), rules), null, 'no crypto account number, no order');
});

test('Robinhood\'s coin check counts only when it names the same order back; its problems and a rounding are shown; otherwise it is not checked', () => {
  const o = { side: 'buy', quantity: 0.0015 } as const;
  const clean = parsePreview({ failed: false, text: '', data: { data: { order: { side: 'buy', quantity: '0.00150000', type: 'limit' }, estimated_cost: '121.50', fees: '0.00', rhs_account_number: '881004321' } } }, o);
  assert.deepEqual([clean.answered, clean.unclear, clean.alerts, clean.error], [true, false, [], null]);
  assert.ok(!JSON.stringify(clean).includes('881004321'), 'the crypto account number is never repeated');
  const flagged = parsePreview({ failed: false, text: '', data: { data: { side: 'buy', quantity: '0.0015', errors: [{ message: 'Insufficient buying power.' }], requested_quantity: '0.00150001' } } }, o);
  assert.equal(flagged.answered, true);
  assert.deepEqual(flagged.alerts, ['Insufficient buying power.', "Robinhood would round the amount (0.00150001 asked): its order tool refuses an amount off the coin's step, so change it"]);
  for (const data of [{ data: { ok: true } }, { data: { side: 'buy', quantity: '0.0016' } }, { data: { side: 'sell', quantity: '0.0015' } }, null]) {
    const r = parsePreview({ failed: false, text: 'fine', data }, o);
    assert.deepEqual([r.answered, r.unclear], [false, true], JSON.stringify(data));
    assert.match(r.error!, /^Robinhood's coin check did not name this order back, so it counts as not checked and cannot be placed\./);
  }
  assert.equal(parsePreview({ failed: true, text: 'account 881004321 has no crypto', data: null }, o).error, 'account ##### has no crypto');
  // A coin's price and amount keep every digit; an account or order number beside them is still hidden.
  assert.equal(masked('Limit 82000.00 for 0.00150001 BTC on 881004321 (5RH88004321).'), 'Limit 82000.00 for 0.00150001 BTC on ##### (#####).');
  assert.deepEqual(parsePreview({ failed: false, text: '', data: { data: { side: 'buy', quantity: '0.00150000', price: '82000.00', ref: '7004321998' } } }, o).facts, [['side', 'buy'], ['quantity', '0.00150000'], ['price', '82000.00'], ['ref', '#####']]);
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
  new Journal(path.join(root, 'desk-data', 'journal.md')).storeDecision('SHIB-USD', '2026-10-15', '**Rating**: Buy\n\n**Executive Summary**: Buy, followed nowhere.');
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
    const coin = await ask('/api/ticket', { symbol: 'SHIB-USD', date: '2026-10-15' });
    assert.deepEqual([coin.status, coin.json().error], [400, 'among coins, the order ticket trades only Bitcoin (BTC-USD) and Ether (ETH-USD), not SHIB-USD'], 'a call on another coin never opens a ticket: it is refused before Robinhood is asked');
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
