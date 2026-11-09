import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DELAY_SENTENCE, DELAY_SHORT, LATE, priceMarket, US_CHECK, US_EXCHANGES } from '../src/data/delay.js';
import { parseQuote } from '../src/terminal/quotes.js';

// Audit 1 F2 (8 Nov 2026): every market said "up to 15 minutes late", where Yahoo's own list gives 20 and 30 minutes for
// markets the desk maps. A US stock or fund and a coin say what Yahoo's list and the desk's own check of its feed say;
// any other market only that it may be late, with no number.

test('a price\'s market comes from Yahoo\'s own description of it: a coin, a US stock or fund on a checked exchange, or any other', () => {
  assert.equal(priceMarket({ instrumentType: 'EQUITY', exchangeName: 'NMS' }), 'us', 'NVIDIA, on Nasdaq');
  assert.equal(priceMarket({ instrumentType: 'EQUITY', exchangeName: 'NYQ' }), 'us', 'Coca-Cola, on the New York Stock Exchange');
  assert.equal(priceMarket({ instrumentType: 'ETF', exchangeName: 'PCX' }), 'us', 'SPY, on NYSE Arca');
  assert.equal(priceMarket({ instrumentType: 'ETF', exchangeName: 'NGM' }), 'us');
  assert.equal(priceMarket({ instrumentType: 'CRYPTOCURRENCY', exchangeName: 'CCC' }), 'coin');
  for (const other of [
    { instrumentType: 'EQUITY', exchangeName: 'JPX' },     // Tokyo: 20 minutes on Yahoo's list, 15 on the feed
    { instrumentType: 'EQUITY', exchangeName: 'LSE' },     // London: 20 minutes
    { instrumentType: 'EQUITY', exchangeName: 'PNK' },     // the OTC markets: 15 minutes
    { instrumentType: 'EQUITY', exchangeName: 'ASE' },     // NYSE American: not checked
    { instrumentType: 'INDEX', exchangeName: 'SNP' },      // an index is neither a stock, a fund nor a coin
    { instrumentType: 'INDEX', exchangeName: 'CXI' },      // the VIX: Cboe's indices are 15 minutes
    { instrumentType: 'EQUITY' }, {},                      // nothing said: nothing claimed
  ]) assert.equal(priceMarket(other), 'other', JSON.stringify(other));
  assert.deepEqual([...US_EXCHANGES], ['NMS', 'NGM', 'NCM', 'NYQ', 'PCX']);
});

test('how late is said only as far as it is known: never a minute figure for a market not checked, and the feed check is recorded', () => {
  assert.equal(LATE.other, 'may be late');
  for (const words of Object.values(LATE)) assert.doesNotMatch(words, /15|up to/, 'no figure left over from "up to 15 minutes late"');
  assert.doesNotMatch(LATE.other, /\d/, 'any other market: no number');
  assert.notEqual(US_CHECK, 'PENDING', 'the US words rest on a check of the desk\'s own feed, written down in data/delay.ts');
  assert.match(DELAY_SENTENCE, /^Prices come from Yahoo Finance: .*any other market's price may be late\. A close is final\.$/);
  assert.match(DELAY_SHORT, /others may be late$/);
});

test('the dashboard says it in the desk\'s words, filled from data/delay.ts, and a quote carries its market', () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  assert.doesNotMatch(html, /15 min|minutes late/i, 'no single figure for every market');
  const spans = [...html.matchAll(/<span[^>]*data-delay="(short|sentence)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.ok(spans.length >= 3, 'the side list, the header chip and the footer');
  for (const [kind, text] of spans) assert.equal(text, kind === 'short' ? DELAY_SHORT : DELAY_SENTENCE, `the page's first paint says what the script fills in (${kind})`);
  const main = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');
  assert.match(main, /querySelectorAll<HTMLElement>\('\[data-delay\]'\)/, 'the script fills every place from data/delay.ts');
  for (const f of ['src/terminal/ui/main.ts', 'src/terminal/ui/fmt.ts', 'src/terminal/ui/glossary.ts', '.claude/skills/terminal/SKILL.md', 'README.md', 'docs/inside-the-trading-desk.html']) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /up to 15 min/i, `${f} says no single figure for every market`);
  }

  const chart = (meta: Record<string, unknown>) => ({ chart: { result: [{ meta: { regularMarketPrice: 10, chartPreviousClose: 9, regularMarketTime: 1_700_000_000, ...meta }, timestamp: [1_700_000_000], indicators: { quote: [{ close: [10] }] } }] } });
  assert.equal(parseQuote(chart({ instrumentType: 'EQUITY', exchangeName: 'NMS' }), 'NVDA').market, 'us');
  assert.equal(parseQuote(chart({ instrumentType: 'CRYPTOCURRENCY', exchangeName: 'CCC' }), 'BTC-USD').market, 'coin');
  assert.equal(parseQuote(chart({ instrumentType: 'EQUITY', exchangeName: 'JPX' }), '7203.T').market, 'other');
});
