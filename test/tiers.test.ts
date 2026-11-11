import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATINGS, REVIEW } from '../src/desk/rating.js';
import { SECTOR_FUNDS } from '../src/desk/sectors.js';
import { cleanMarket, marketSymbol, MAX_MARKET, PLAIN, SHIPPED_MARKET, START_NAMES, TIER_WORDS, TIERS, tierOf, tiersOf } from '../src/terminal/tiers.js';
import { ratingMeaning } from '../src/terminal/ui/fmt.js';
import { GLOSSARY, means, type TermKey } from '../src/terminal/ui/glossary.js';
import type { WatchItem } from '../src/terminal/store.js';
import { MARKETS } from '../src/terminal/quotes.js';
import { parseSearch } from '../src/terminal/search.js';
import { FUND_KINDS, marketOffer } from '../src/terminal/ui/marketpick.js';

const watch = (symbol: string, favourite = false): WatchItem => ({ symbol, favourite, addedOn: '2026-10-01' });

test('each symbol has its tier: crypto, a sector fund, the whole market (a broad fund, one the person chose, an index), else a single name', () => {
  assert.deepEqual(['SPY', 'VOO', 'BND', '^GSPC', 'XLK', 'XLRE', 'BTC-USD', 'DOGE-USD', 'NVDA', 'TSLT', 'SCHD'].map((s) => tierOf(s)),
    ['market', 'market', 'market', 'market', 'sectors', 'sectors', 'crypto', 'crypto', 'names', 'names', 'names']);
  assert.equal(tierOf('SCHD', ['SPY', 'SCHD']), 'market', 'a fund the person put in the whole market is counted there');
  assert.deepEqual(TIERS, ['market', 'sectors', 'names', 'crypto'], 'broadest first');
});

test('the whole-market list holds funds and stocks only, each once, at most eight: crypto, indices and sector funds are refused in words', () => {
  assert.equal(marketSymbol(' spy '), 'SPY');
  for (const [raw, why] of [['BTC-USD', /crypto, which has a tier of its own/], ['btcusd', /crypto/], ['^GSPC', /index, a future or a currency/], ['GC=F', /cannot be held/],
    ['XLK', /sector fund, already among the sectors/], ['../x', /not a ticker/], [5, /a ticker is a word/]] as const) assert.throws(() => marketSymbol(raw), why, String(raw));
  assert.deepEqual(cleanMarket(['vti', 'VTI', 'BTC-USD', 'XLE', '^DJI', 7, 'bnd']), ['VTI', 'BND'], 'what is not a market ticker is left out, and each is kept once');
  assert.equal(cleanMarket(Array.from({ length: 12 }, (_, i) => `F${i}`))!.length, MAX_MARKET);
  assert.deepEqual(cleanMarket([]), [], 'an empty list is the person\'s choice, kept as empty');
  assert.equal(cleanMarket('SPY'), undefined, 'not a list: nothing');
});

test('the search list offers "Show in The whole market" for exactly the funds the desk\'s own check would keep, and says when it is in the row or the row is full', () => {
  // The page cannot load marketSymbol, so its rule (ui/marketpick.ts) is held to it here: every kind Yahoo gives, read by the search itself.
  const sectors = new Set(tiersOf([], SHIPPED_MARKET, []).startHere.find((t) => t.tier === 'sectors')!.items.map((i) => i.symbol));
  assert.deepEqual([...sectors], Object.keys(SECTOR_FUNDS), 'the page learns the sector funds from the sectors tier the desk sends');
  assert.deepEqual(FUND_KINDS, ['ETF', 'Fund'], "Yahoo's ETF and mutual fund, as the search names them");
  const types = ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY'];
  const symbols = ['SPY', 'VOO', 'VFIAX', 'VT', 'XLK', 'XLRE', 'AAPL', 'BTC-USD', 'DOGE-USD', '^GSPC', '^TNX', 'EURUSD=X', 'GC=F', 'BRK-B'];
  // one reading for each kind (the search lists a symbol once)
  const matches = types.flatMap((quoteType) => parseSearch({ quotes: symbols.map((symbol) => ({ symbol, quoteType, shortname: symbol })) }, 500));
  assert.ok(matches.length >= symbols.length, 'the search reads them');
  let offered = 0;
  for (const m of matches) {
    let takes = true;
    try { marketSymbol(m.symbol); } catch { takes = false; }
    const should: boolean = takes && FUND_KINDS.includes(m.kind);
    assert.equal(marketOffer(m, [], sectors, MAX_MARKET) !== 'none', should, `${m.symbol} (${m.kind})`);
    if (should) offered++;
  }
  assert.ok(offered >= 8, 'funds such as SPY and VOO are offered, as an ETF and as a fund');
  const spy = { symbol: 'SPY', kind: 'ETF' };
  assert.equal(marketOffer(spy, ['QQQ'], sectors, MAX_MARKET), 'show');
  assert.equal(marketOffer(spy, ['QQQ', 'SPY'], sectors, MAX_MARKET), 'in', 'a fund in the row says so, even in a full row');
  assert.equal(marketOffer(spy, Array.from({ length: MAX_MARKET }, (_, i) => `F${i}`), sectors, MAX_MARKET), 'full');
  assert.equal(marketOffer(spy, Array.from({ length: MAX_MARKET - 1 }, (_, i) => `F${i}`), sectors, MAX_MARKET), 'show', 'room for one more');
  assert.equal(marketOffer({ symbol: 'SPY' }, [], sectors, MAX_MARKET), 'none', 'a match of no known kind (one remembered as recent) is never offered');
});

test('Start here: the whole market and the eleven sectors always, the person\'s own names starred first, crypto when watched, each with the latest call', () => {
  const list = [watch('NVDA'), watch('AAPL', true), watch('SPY'), watch('XLE'), watch('BTC-USD'), watch('DOGE-USD')];
  const calls = [{ ticker: 'NVDA', date: '2026-10-09', rating: 'Hold' }, { ticker: 'XLK', date: '2026-10-01', rating: 'Overweight' }, { ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }];
  const { startHere, watch: tiers } = tiersOf(list, SHIPPED_MARKET, calls);
  assert.deepEqual(startHere.map((t) => [t.tier, t.items.map((i) => i.symbol)]), [
    ['market', ['SPY', 'QQQ', 'VT', 'BND']],
    ['sectors', ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC']],
    ['names', ['AAPL', 'NVDA']],
    ['crypto', ['BTC-USD', 'DOGE-USD']],
  ]);
  const item = (s: string) => startHere.flatMap((t) => t.items).find((i) => i.symbol === s)!;
  assert.deepEqual(item('NVDA').call, { rating: 'Hold', date: '2026-10-09' }, 'the latest call, whatever order the journal lists them in');
  assert.deepEqual(item('XLK').call, { rating: 'Overweight', date: '2026-10-01' });
  assert.equal(item('QQQ').call, null, 'no call yet is null, never a made-up rating');
  assert.deepEqual([item('SPY').watched, item('QQQ').watched, item('AAPL').favourite], [true, false, true]);
  assert.deepEqual([item('SPY').name, item('SPY').meaning], ['S&P 500 fund', 'copies the S&P 500 index: about 500 large US companies, chosen by S&P']);
  // Round 1 (7 Nov 2026): the watchlist's "S&P 500" was SPY at $735.29 while the Markets card's "S&P 500" was the index
  // at 7,377. A fund that copies an index is named as a fund, never with an index's own name.
  const cards = new Map(MARKETS.map((m) => [m.name, m.symbol]));
  for (const [sym, p] of Object.entries(PLAIN)) {
    assert.ok(!cards.has(p.name) || cards.get(p.name) === sym, `${sym} is named "${p.name}", like the Markets card for ${cards.get(p.name)}`);
    if (/S&P 500|Nasdaq|Dow|Russell/.test(p.name)) assert.match(p.name, / fund$/, `${sym}: a fund named after its index says it is a fund`);
  }
  assert.deepEqual([item('XLY').name, item('NVDA').name], ['Consumer discretionary', undefined], 'a company is named as the market names it');
  assert.deepEqual(['SPY', 'XLE', 'NVDA', 'BTC-USD', 'DOGE-USD'].map((s) => [item(s).ticket, item(s).paper]), [[true, true], [true, true], [true, true], [true, true], [false, false]],
    'among coins, Bitcoin and Ether alone open a ticket, and paper follows them only');
  assert.deepEqual(tiers.map((t) => [t.tier, t.name, t.items.map((i) => i.symbol)]), [
    ['market', 'The whole market', ['SPY']], ['sectors', 'Sectors', ['XLE']], ['names', 'Single names', ['NVDA', 'AAPL']], ['crypto', 'Crypto', ['BTC-USD', 'DOGE-USD']],
  ], 'the watchlist by tier, in its own order');
});

test('with an empty watchlist, Start here still shows the whole market and the sectors, an empty row of names and no crypto; a long list shows how many more', () => {
  const empty = tiersOf([], ['VTI'], []);
  assert.deepEqual(empty.startHere.map((t) => [t.tier, t.items.length]), [['market', 1], ['sectors', 11], ['names', 0]]);
  assert.deepEqual(empty.watch, [], 'a watchlist tier with nothing in it is not drawn');
  assert.deepEqual(tiersOf([], [], []).startHere[0]!.items, [], 'the person may choose no whole-market funds');
  const many = tiersOf(Array.from({ length: START_NAMES + 3 }, (_, i) => watch(`S${i}`, i === 14)), SHIPPED_MARKET, []);
  const names = many.startHere[2]!;
  assert.deepEqual([names.items.length, names.more, names.items[0]!.symbol], [START_NAMES, 3, 'S14'], 'starred first, the rest counted');
  assert.equal(many.watch[0]!.items.length, START_NAMES + 3, 'the watchlist itself shows them all');
});

test('every word "Start here" uses has a one-line meaning: each tier, each broad and sector fund, each rating', () => {
  for (const t of TIERS) assert.ok(TIER_WORDS[t].name && TIER_WORDS[t].meaning.length > 20, t);
  for (const s of [...Object.keys(SECTOR_FUNDS), ...SHIPPED_MARKET, 'BTC-USD', 'ETH-USD']) assert.ok(PLAIN[s]?.name && PLAIN[s]!.meaning, s);
  for (const r of [...RATINGS, REVIEW]) assert.match(ratingMeaning(r), new RegExp(`^${r}: `), r);
  assert.equal(ratingMeaning('Maybe'), '', 'a rating the desk does not use has no meaning made up for it');
  for (const k of Object.keys(GLOSSARY) as TermKey[]) assert.match(means(k), /^[^:]+: \S/, k);
});
