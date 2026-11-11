import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATINGS, REVIEW } from '../src/desk/rating.js';
import { SECTOR_FUNDS } from '../src/desk/sectors.js';
import { PLAIN, SHIPPED_MARKET, TIER_WORDS, TIERS, tierOf, tiersOf } from '../src/terminal/tiers.js';
import { ratingMeaning } from '../src/terminal/ui/fmt.js';
import { GLOSSARY, means, type TermKey } from '../src/terminal/ui/glossary.js';
import type { WatchItem } from '../src/terminal/store.js';
import { MARKETS } from '../src/terminal/quotes.js';

const watch = (symbol: string, favourite = false): WatchItem => ({ symbol, favourite, addedOn: '2026-10-01' });

test('each symbol has its tier: crypto, a sector fund, the whole market (a broad fund the desk lists, or an index), else a single name', () => {
  assert.deepEqual(['SPY', 'VOO', 'BND', '^GSPC', 'XLK', 'XLRE', 'BTC-USD', 'DOGE-USD', 'NVDA', 'TSLT', 'SCHD'].map(tierOf),
    ['market', 'market', 'market', 'market', 'sectors', 'sectors', 'crypto', 'crypto', 'names', 'names', 'names']);
  assert.deepEqual(TIERS, ['market', 'sectors', 'names', 'crypto'], 'broadest first');
  for (const s of SHIPPED_MARKET) assert.equal(tierOf(s), 'market', `${s}, one of the four an older version showed, is still filed under the whole market on the watchlist`);
});

test('Sectors: the eleven sector funds and nothing else, each with the latest call; the watchlist holds the rest, grouped by tier', () => {
  const list = [watch('NVDA'), watch('AAPL', true), watch('SPY'), watch('XLE'), watch('BTC-USD'), watch('DOGE-USD')];
  const calls = [{ ticker: 'NVDA', date: '2026-10-09', rating: 'Hold' }, { ticker: 'XLK', date: '2026-10-01', rating: 'Overweight' }, { ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }];
  const { startHere, watch: tiers } = tiersOf(list, calls);
  assert.deepEqual(startHere.map((t) => [t.tier, t.name, t.items.map((i) => i.symbol)]), [
    ['sectors', 'Sectors', ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC']],
  ], 'no whole-market row, no single names and no coins: the watchlist has those');
  const item = (s: string) => [...startHere, ...tiers].flatMap((t) => t.items).find((i) => i.symbol === s)!;
  assert.deepEqual(item('XLK').call, { rating: 'Overweight', date: '2026-10-01' });
  assert.equal(item('XLF').call, null, 'no call yet is null, never a made-up rating');
  assert.deepEqual(item('NVDA').call, { rating: 'Hold', date: '2026-10-09' }, 'the latest call, whatever order the journal lists them in');
  assert.deepEqual([item('XLE').watched, item('XLF').watched, item('AAPL').favourite], [true, false, true]);
  assert.deepEqual([item('SPY').name, item('SPY').meaning], ['S&P 500 fund', 'copies the S&P 500 index: about 500 large US companies, chosen by S&P']);
  // Round 1 (7 Nov 2026): the watchlist's "S&P 500" was SPY at $735.29 while the Markets card's "S&P 500" was the index
  // at 7,377. A fund that copies an index is named as a fund, never with an index's own name.
  const cards = new Map(MARKETS.map((m) => [m.name, m.symbol]));
  for (const [sym, p] of Object.entries(PLAIN)) {
    assert.ok(!cards.has(p.name) || cards.get(p.name) === sym, `${sym} is named "${p.name}", like the Markets card for ${cards.get(p.name)}`);
    if (/S&P 500|Nasdaq|Dow|Russell/.test(p.name)) assert.match(p.name, / fund$/, `${sym}: a fund named after its index says it is a fund`);
  }
  assert.deepEqual([item('XLY').name, item('NVDA').name], ['Consumer discretionary', undefined], 'a company is named as the market names it');
  assert.deepEqual(['SPY', 'XLE', 'NVDA', 'BTC-USD', 'DOGE-USD'].map((s) => [item(s).ticket, item(s).paper]), [[true, true], [true, true], [true, true], [false, true], [false, false]],
    'a coin never opens a ticket; paper follows Bitcoin and Ether only');
  assert.deepEqual(tiers.map((t) => [t.tier, t.name, t.items.map((i) => i.symbol)]), [
    ['market', 'The whole market', ['SPY']], ['sectors', 'Sectors', ['XLE']], ['names', 'Single names', ['NVDA', 'AAPL']], ['crypto', 'Crypto', ['BTC-USD', 'DOGE-USD']],
  ], 'the watchlist by tier, in its own order, with every name on it (none is left for "more")');
});

test('with an empty watchlist, Sectors still shows the eleven funds, and the watchlist draws no tier; a long watchlist is shown whole', () => {
  const empty = tiersOf([], []);
  assert.deepEqual(empty.startHere.map((t) => [t.tier, t.items.length]), [['sectors', 11]]);
  assert.deepEqual(empty.watch, [], 'a watchlist tier with nothing in it is not drawn');
  const many = tiersOf(Array.from({ length: 30 }, (_, i) => watch(`S${i}`, i === 14)), []);
  assert.equal(many.watch[0]!.items.length, 30, 'the watchlist itself shows them all');
  assert.ok(!('more' in many.startHere[0]!), 'no "more on your watchlist" count: Sectors holds no names');
});

test('every word the dashboard uses for a tile has a one-line meaning: each tier, each broad and sector fund, each rating', () => {
  for (const t of TIERS) assert.ok(TIER_WORDS[t].name && TIER_WORDS[t].meaning.length > 20, t);
  for (const s of [...Object.keys(SECTOR_FUNDS), ...SHIPPED_MARKET, 'BTC-USD', 'ETH-USD']) assert.ok(PLAIN[s]?.name && PLAIN[s]!.meaning, s);
  for (const r of [...RATINGS, REVIEW]) assert.match(ratingMeaning(r), new RegExp(`^${r}: `), r);
  assert.equal(ratingMeaning('Maybe'), '', 'a rating the desk does not use has no meaning made up for it');
  for (const k of Object.keys(GLOSSARY) as TermKey[]) assert.match(means(k), /^[^:]+: \S/, k);
});
