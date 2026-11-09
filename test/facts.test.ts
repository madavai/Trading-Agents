import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { weekday, withWeekday } from '../src/data/dates.js';
import { priceFactsText } from '../src/data/facts.js';
import { clearCache, type Bar, type Series } from '../src/data/yahoo.js';
import { deskServer } from '../src/tools/server.js';
import { chartFetch, series, weekdays } from './chart.js';

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-30'; clearCache(); });

/** Rows on the weekdays ending `last`, one close each (high and low a cent either side unless given). */
function rows(last: string, closes: number[], extra: Partial<Record<number, Partial<Bar>>> = {}): Series {
  const days = weekdays(last, closes.length);
  return { meta: { symbol: 'ACME' }, bars: closes.map((c, i) => ({ date: days[i]!, open: c, high: c + 0.01, low: c - 0.01, close: c, volume: 1_000_000 + i, ...extra[i] })) };
}
const line = (text: string, start: string) => text.split('\n').find((l) => l.startsWith(start)) ?? '';

test('a date carries its weekday', () => {
  assert.equal(weekday('2026-10-31'), 'Sat');
  assert.equal(withWeekday('2026-10-30'), '2026-10-30 (Fri)');
});

test('a run is counted to the latest row, with what the session before it did and a tally of the month', () => {
  const t = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', [10, 11, 12, 13, 12, 11, 10, 9]));
  assert.equal(line(t, '- Close:'), '- Close: down on each of the last 4 sessions, 2026-10-27 (Tue) to 2026-10-30 (Fri), from 13.00 to 9.00; on 2026-10-26 (Mon) it closed up. Over the last 7 sessions it closed up on 3 and closed down on 4.');
  const up = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', [10, 11, 12, 11, 12]));
  assert.match(line(up, '- Close:'), /^- Close: up on the latest session, 2026-10-30 \(Fri\), from 11\.00 to 12\.00; on 2026-10-29 \(Thu\) it closed down\./);
  // A window longer than the record is the whole record, and says so.
  assert.match(t, /the last 8 sessions \(all on record\) from 2026-10-21 \(Wed\)/);
  assert.match(t, /Quote a fact as it stands here, naming its window/);
});

test('sides, crossings and counts come from every session, so "the only one" and "the first since" can be checked', () => {
  // A year and more of a rising price with one dip below the 200-day average and one high far above the band.
  const closes = Array.from({ length: 460 }, (_, i) => 100 + i * 0.5);
  for (let i = 400; i < 404; i++) closes[i] = 150;            // four closes well below the 200 SMA (about 250 there)
  const s = rows('2026-10-30', closes, { 450: { high: 400 } });
  const t = priceFactsText('ACME', '2026-10-30', s);
  const dip = s.bars[400]!.date, back = s.bars[404]!.date, spike = s.bars[450]!.date;
  assert.equal(line(t, '- Close above the 200 SMA'), `- Close above the 200 SMA on each of the last 56 closes, since ${withWeekday(back)}; the last close below it was ${withWeekday(s.bars[403]!.date)} (150.00 against ${(closes.slice(204, 404).reduce((a, b) => a + b, 0) / 200).toFixed(2)}). Crossings in the last 252 sessions (2 in all, newest first): above on ${withWeekday(back)}; below on ${withWeekday(dip)}.`);
  assert.equal(line(t, 'Closes below the 200 SMA'), `Closes below the 200 SMA | 0 | 4, first ${withWeekday(dip)} | 4, first ${withWeekday(dip)} | 4, first ${withWeekday(dip)} | ${withWeekday(s.bars[403]!.date)}`);
  assert.match(line(t, 'Highs above the upper Bollinger band'), new RegExp(`^Highs above the upper Bollinger band \\| 1, first ${withWeekday(spike).replace(/[()]/g, '\\$&')} \\|`));
  assert.match(line(t, 'Closes above the upper Bollinger band'), /^Closes above the upper Bollinger band \| 0 \|/, 'the close stayed inside: only the high pierced it');
  // The 200 SMA has a value only from its 200th session: a window reaching before it says how many sessions had one.
  const short = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', closes.slice(0, 300)));
  assert.match(line(short, 'Closes below the 200 SMA'), / \| 0 of 101 sessions with a value \| /);
});

test('the highest and lowest of each window are ranked, a tie the latest first, with each move\'s size', () => {
  const closes = [100, 104, 101, 106, 100, 103, 99, 105];
  const t = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', closes, { 2: { volume: 9e6 }, 6: { volume: 9e6 }, 4: { volume: 8e6 } }));
  assert.equal(line(t, 'Highest closes'), 'Highest closes | 106.00 on 2026-10-26 (Mon) | 105.00 on 2026-10-30 (Fri) | 104.00 on 2026-10-22 (Thu)');
  assert.equal(line(t, 'Biggest daily falls'), 'Biggest daily falls | -5.66% (-6.00) on 2026-10-27 (Tue) | -3.88% (-4.00) on 2026-10-29 (Thu) | -2.88% (-3.00) on 2026-10-23 (Fri)');
  assert.equal(line(t, 'Heaviest volume on a down close'), 'Heaviest volume on a down close | 9,000,000 (close -3.88%) on 2026-10-29 (Thu) | 9,000,000 (close -2.88%) on 2026-10-23 (Fri) | 8,000,000 (close -5.66%) on 2026-10-27 (Tue)');
  assert.equal(line(t, 'Heaviest volume on an up close'), 'Heaviest volume on an up close | 1,000,007 (close +6.06%) on 2026-10-30 (Fri) | 1,000,005 (close +3.00%) on 2026-10-28 (Wed) | 1,000,003 (close +4.95%) on 2026-10-26 (Mon)');
});

test('the latest row is set against the past: the lowest since when, the distance from the extremes, the change over each window', () => {
  const closes = [50, 40, 45, 44, 43, 42, 41.5];
  const t = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', closes));
  assert.equal(line(t, '- Close 41.50'), '- Close 41.50 on 2026-10-30 (Fri): the lowest close since 2026-10-23 (Fri) (40.00), 5 sessions before.');
  assert.equal(line(t, '- Daily move'), '- Daily move -1.19% on 2026-10-30 (Fri): the biggest daily fall since 2026-10-29 (Thu) (-2.33%), 1 session before.');
  const fall = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', [50, 40, 45, 44, 43, 42, 30]));
  assert.equal(line(fall, '- Close 30.00'), '- Close 30.00 on 2026-10-30 (Fri): the lowest close of all 7 sessions on record.');
  assert.match(t, /- 1 session -1\.19% \(from 42\.00 on 2026-10-29 \(Thu\)\); 5 sessions \+3\.75% \(from 40\.00 on 2026-10-23 \(Fri\)\)/);
});

test('the server offers the price facts, held to the analysis date', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), chartFetch(() => series('2026-10-30', 500))).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'get_price_facts'));
  const r = await client.callTool({ name: 'get_price_facts', arguments: { symbol: 'acme', analysis_date: '2026-10-23' } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /^## Price facts for ACME, worked out by the desk\n\n- Analysis date: 2026-10-23 \(Fri\)\. Latest row: 2026-10-23 \(Fri\)\./);
  assert.doesNotMatch(r.content[0]!.text, /2026-10-2[6-9]|2026-10-30/, 'nothing after the analysis date');
  await client.close();
  configure({ fetch: globalThis.fetch });
});

// Audit 3 prices-3 (9 Nov 2026): half an hour into a session, its volume so far is a fraction of a day's, and the facts
// ranked it "the lightest volume of all 500 sessions on record" in every window, for the agents to quote.
test('while the latest session is still trading, its volume so far is in no volume fact; once it is final, it is', () => {
  const s = rows('2026-10-30', Array.from({ length: 300 }, (_, i) => 100 + (i % 7)), { 299: { volume: 110_000 } });
  const live: Series = { ...s, meta: { ...s.meta, timezone: 'America/New_York', session: { date: '2026-10-30', start: Date.now() - 30 * 60_000, end: Date.now() + 6 * 3_600_000 } } };
  const t = priceFactsText('ACME', '2026-10-30', live);
  assert.doesNotMatch(t, /110,000/, 'not ranked, not set against the past');
  assert.match(t, /\n- The latest row, 2026-10-30 \(Fri\), is not a finished session: its volume so far is not a whole day's, so it is left out of every volume fact here\.\n/);
  assert.match(line(t, 'Lightest volume'), /^Lightest volume \| 1,000,280 on 2026-10-05 \(Mon\) \|/, 'the lightest of the 19 finished sessions');
  assert.equal(line(t, '- Volume '), '');
  const done = priceFactsText('ACME', '2026-10-30', s);
  assert.match(line(done, 'Lightest volume'), /^Lightest volume \| 110,000 on 2026-10-30 \(Fri\)/, 'a finished session\'s volume is ranked');
  assert.match(done, /- Volume 110,000 on 2026-10-30 \(Fri\): the lightest volume of all 300 sessions on record\./);
  assert.doesNotMatch(done, /is not a finished session/);
});

// Audit 3 prices-7: a coin has a row every calendar day, so "the last 252 sessions (about a year)" was eight months.
test('for a coin, which trades every day, the windows are counted in days: a month is 30, a year 365', () => {
  const days = Array.from({ length: 700 }, (_, i) => new Date(Date.parse('2026-10-30T00:00:00Z') - (699 - i) * 86_400_000).toISOString().slice(0, 10));
  const coin: Series = { meta: { symbol: 'BTC-USD', type: 'CRYPTOCURRENCY' }, bars: days.map((date, i) => ({ date, open: 100 + (i % 9), high: 101 + (i % 9), low: 99 + (i % 9), close: 100 + (i % 9), volume: 1_000_000 + i })) };
  const t = priceFactsText('BTC-USD', '2026-10-30', coin);
  for (const [n, words, from] of [[30, 'about a month', '2026-10-01 (Thu)'], [91, 'about three months', '2026-08-01 (Sat)'], [182, 'about six months', '2026-05-02 (Sat)'], [365, 'about a year', '2025-10-31 (Fri)']] as const) {
    assert.match(t, new RegExp(`\nLast ${n} sessions \(${words}, from ${from.replace(/[()]/g, '\$&')}\) \| First \| Second \| Third\n`), `${n} days`);
  }
  assert.doesNotMatch(t, /Last 252 sessions|Last 20 sessions|Last 63 sessions|Last 126 sessions/);
  assert.match(t, /A coin trades every day, so a session here is a calendar day; every date carries its weekday\./);
  assert.match(t, /Fact \| Last 30 sessions \| Last 91 sessions \| Last 182 sessions \| Last 365 sessions \| Latest in the last year/);
  assert.match(t, /Crossings in the last 365 sessions|No crossing in the last 365 sessions/);
  const stock = priceFactsText('ACME', '2026-10-30', rows('2026-10-30', Array.from({ length: 300 }, (_, i) => 100 + (i % 9))));
  assert.match(stock, /\nLast 252 sessions \(about a year, from /, 'a stock keeps its trading-day windows');
  assert.doesNotMatch(stock, /A coin trades every day/);
});
