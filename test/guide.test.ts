import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideOf, maskEmail, NAMES_TO_PICK, type GuideFacts } from '../src/terminal/guide.js';
import { RECORD_WEEKS, RECORD_WORDS } from '../src/desk/paper.js';
import { SHIPPED_MARKET } from '../src/terminal/tiers.js';
import type { WatchItem } from '../src/terminal/store.js';

const watch = (...symbols: string[]): WatchItem[] => symbols.map((symbol) => ({ symbol, favourite: false, addedOn: '2026-10-01' }));
const none: GuideFacts = { email: '', watchlist: [], market: SHIPPED_MARKET, queue: [], calls: [], listener: null, autorun: false, readCall: false, record: { since: null, weeks: 0, calls: 0 } };
const ticks = (f: Partial<GuideFacts>) => { const g = guideOf({ ...none, ...f }); return [g.email.done, g.picks.done, g.analyse.done, g.read.done, g.paper.done]; };

test('a newcomer sees the guide by itself, with nothing ticked; the owner with calls does not, until they open it', () => {
  const g = guideOf(none);
  assert.deepEqual([g.show, g.first, g.done, g.of], [true, true, 0, 5]);
  assert.deepEqual(ticks({}), [false, false, false, false, false]);
  const calls = [{ ticker: 'NVDA', date: '2026-10-01', rating: 'Hold' }];
  assert.deepEqual([guideOf({ ...none, calls }).show, guideOf({ ...none, calls }).first], [false, false], 'out of the way for someone who already has calls');
  assert.equal(guideOf({ ...none, calls, pref: 'open' }).show, true, 'reopened from the side list');
  assert.deepEqual([guideOf({ ...none, pref: 'away' }).show, guideOf({ ...none, pref: 'away' }).first], [false, false], 'put away, it stays away');
  assert.equal(guideOf({ ...none, calls, pref: 'open' }).first, false);
});

test('step one ticks from the saved email, which the guide only ever shows masked', () => {
  const g = guideOf({ ...none, email: 'jane.roe@mail.com' });
  assert.deepEqual([g.email.done, g.email.saved], [true, 'j…@mail.com']);
  assert.ok(!JSON.stringify(g).includes('jane.roe'), 'the address never reaches the page in full');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail('a@b.co'), 'a…@b.co');
});

test('step two ticks once three names of the person\'s own, the whole market and a sector are picked: watched or asked about', () => {
  const almost = watch('NVDA', 'AAPL', 'SPY', 'XLK');
  assert.deepEqual([guideOf({ ...none, watchlist: almost }).picks.names, guideOf({ ...none, watchlist: almost }).picks.done], [2, false]);
  assert.equal(guideOf({ ...none, watchlist: [...almost, ...watch('KO')] }).picks.done, true);
  assert.equal(guideOf({ ...none, watchlist: watch('NVDA', 'AAPL', 'KO', 'XLK') }).picks.market, false, 'no whole-market fund yet');
  assert.equal(guideOf({ ...none, watchlist: watch('NVDA', 'AAPL', 'KO', '^GSPC', 'XLK') }).picks.market, false, 'an index cannot be analysed or bought: it is not a pick');
  assert.equal(guideOf({ ...none, watchlist: watch('NVDA', 'AAPL', 'KO', 'SPY') }).picks.sector, false, 'no sector fund yet');
  assert.equal(guideOf({ ...none, watchlist: watch('BTC-USD', 'ETH-USD', 'SPY', 'XLE') }).picks.names, 0, 'coins are not names');
  // the robot on Start here asks without the watchlist; a call counts too
  const asked = guideOf({ ...none, watchlist: watch('NVDA', 'AAPL', 'KO'), queue: [{ symbol: 'VT' }], calls: [{ ticker: 'XLV', date: '2026-10-01', rating: 'Hold' }] });
  assert.deepEqual([asked.picks.market, asked.picks.sector, asked.picks.done], [true, true, true]);
  assert.equal(guideOf(none).picks.need, NAMES_TO_PICK);
  assert.equal(guideOf({ ...none, market: ['VTI'], watchlist: watch('NVDA', 'AAPL', 'KO', 'VTI', 'XLK') }).picks.done, true, 'the person\'s own whole-market funds count');
});

test('step three ticks once something was asked for and analyses run by themselves', () => {
  assert.deepEqual([guideOf({ ...none, queue: [{ symbol: 'NVDA' }] }).analyse.asked, guideOf({ ...none, queue: [{ symbol: 'NVDA' }] }).analyse.done], [1, false], 'asked, but nothing listens');
  assert.equal(guideOf({ ...none, listener: 'Madav' }).analyse.done, false, 'listening, but nothing asked');
  assert.deepEqual([guideOf({ ...none, queue: [{ symbol: 'NVDA' }], listener: 'Madav' }).analyse.done, guideOf({ ...none, queue: [{ symbol: 'NVDA' }], listener: 'Madav' }).analyse.automatic], [true, 'Madav']);
  assert.equal(guideOf({ ...none, calls: [{ ticker: 'NVDA', date: '2026-10-01', rating: 'Buy' }], autorun: true }).analyse.done, true, 'the Claude Code switch on, between heartbeats');
  assert.equal(guideOf({ ...none, queue: [{ symbol: 'NVDA' }], calls: [{ ticker: 'NVDA', date: '2026-10-01', rating: 'Buy' }] }).analyse.asked, 1, 'one stock once');
});

test('step four ticks once a call was read in full, and offers the latest; step five after four weeks of paper record', () => {
  const calls = [{ ticker: 'KO', date: '2026-09-01', rating: 'Hold' }, { ticker: 'NVDA', date: '2026-10-01', rating: 'Buy' }];
  const g = guideOf({ ...none, calls });
  assert.deepEqual([g.read.done, g.read.calls, g.read.latest], [false, 2, { ticker: 'NVDA', date: '2026-10-01', rating: 'Buy' }]);
  assert.equal(guideOf({ ...none, calls, readCall: true }).read.done, true);
  const young = guideOf({ ...none, record: { since: '2026-10-01', weeks: RECORD_WEEKS - 1, calls: 2 } }).paper;
  assert.deepEqual([young.done, young.weeks, young.need, young.words], [false, RECORD_WEEKS - 1, RECORD_WEEKS, RECORD_WORDS]);
  assert.equal(guideOf({ ...none, record: { since: '2026-09-01', weeks: RECORD_WEEKS, calls: 2 } }).paper.done, true);
  assert.equal(RECORD_WORDS, 'four weeks');
});

test('the count is the steps done, whatever order they were done in', () => {
  const g = guideOf({ ...none, email: 'jane@mail.com', readCall: true, record: { since: '2026-09-01', weeks: 6, calls: 3 }, calls: [{ ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }] });
  assert.equal(g.done, 3);
});
