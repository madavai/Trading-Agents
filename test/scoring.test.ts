import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { Journal } from '../src/desk/journal.js';
import { measure, resolveBenchmark } from '../src/desk/scoring.js';
import { dueSettlements, settleOne } from '../src/desk/settle.js';
import { DEFAULTS } from '../src/settings.js';
import { chartFetch, type Row } from './chart.js';

const S = DEFAULTS.scoring;
const forward = (from: string, n: number): string[] => { const out: string[] = []; const d = new Date(`${from}T00:00:00Z`); while (out.length < n) { if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
const rows = (from: string, n: number, closes: number[]): Row[] => forward(from, n).map((date, i) => ({ date, o: closes[i]!, h: closes[i]!, l: closes[i]!, c: closes[i]!, v: 1000 }));
// 2026-09-01 is a Tuesday: its 5th trading day after is 2026-09-08.
const NVDA = rows('2026-09-01', 8, [100, 101, 102, 103, 104, 110, 111, 112]);
const SPY = rows('2026-08-25', 15, [195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 206, 207, 208, 209, 210]);
const feed = (extra: Record<string, Row[]> = {}) => chartFetch((sym) => ({ NVDA, SPY, ...extra })[sym] ?? []);

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearCache(); });

test('a stock is judged against its own market\'s index, or the person\'s one choice', () => {
  assert.equal(resolveBenchmark('NVDA', S), 'SPY');
  assert.equal(resolveBenchmark('BRK.B', S), 'SPY');            // a dotted US ticker matches no exchange suffix
  assert.equal(resolveBenchmark('7203.T', S), '^N225');
  assert.equal(resolveBenchmark('6488.TWO', S), '^TWII');       // Taipei OTC
  assert.equal(resolveBenchmark('293490.KQ', S), '^KQ11');      // KOSDAQ
  assert.equal(resolveBenchmark('2330.TW', S), '^TWII');
  assert.equal(resolveBenchmark('700.HK', S), '^HSI');          // the bare Hong Kong code is mapped first
  assert.equal(resolveBenchmark('NVDA', { ...S, benchmark: 'qqq' }), 'QQQ');
  assert.equal(resolveBenchmark('7203.T', { ...S, benchmark: 'xauusd' }), 'GC=F');   // the choice beats the suffix, aliases mapped
});

test('the outcome is the stock\'s return and the index\'s over the same dates, from price rows alone', async () => {
  configure({ fetch: feed() });
  const o = (await measure('NVDA', '2026-09-01', 'SPY', 5))!;
  assert.deepEqual([o.entry, o.exit, o.holdingDays], ['2026-09-01', '2026-09-08', 5]);
  assert.ok(Math.abs(o.raw - 0.10) < 1e-9);                  // 100 -> 110
  assert.ok(Math.abs(o.benchmarkReturn - 0.03) < 1e-9);       // the index: 200 -> 206
  assert.ok(Math.abs(o.alpha - 0.07) < 1e-9);
});

test('a window that has not finished trading is not yet, never a partial figure', async () => {
  configure({ fetch: feed() });
  assert.equal(await measure('NVDA', '2026-09-01', 'SPY', 10), null);                 // only 7 rows after entry
  process.env.TRADING_AGENTS_TODAY = '2026-09-08';                                     // the exit session is today's, still moving
  assert.equal(await measure('NVDA', '2026-09-01', 'SPY', 5), null);
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  configure({ fetch: feed({ SPY: SPY.slice(0, 9) }) });                               // the index has not traded through the exit
  clearCache();
  assert.equal(await measure('NVDA', '2026-09-01', 'SPY', 5), null);
});

const journalWith = () => { const j = new Journal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-s-')), 'journal.md')); j.storeDecision('NVDA', '2026-09-01', '**Rating**: Buy\n\nAdd.'); return j; };

test('pending calls are listed with their measured outcome, or why not', async () => {
  const j = journalWith();
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  configure({ fetch: feed({ LATE: rows('2026-10-09', 3, [10, 11, 12]) }) });
  const t = await dueSettlements(j, S);
  assert.match(t, /2 pending call\(s\), 1 ready/);
  assert.match(t, /\[2026-09-01 \| NVDA \| Buy\] READY: NVDA \+10\.0% from 2026-09-01 to 2026-09-08 \(5 trading days\); SPY \+3\.0%; alpha \+7\.0%\nDECISION:\n\*\*Rating\*\*: Buy/);
  assert.match(t, /\[2026-10-10 \| LATE \| Sell\] NOT YET: the 5-trading-day window/);
  assert.match(await dueSettlements(j, S, 'ZZZ'), /No pending calls on ZZZ/);
});

test('a source that cannot answer leaves the call pending and says so', async () => {
  const j = journalWith();
  configure({ fetch: async () => { throw new TypeError('fetch failed'); } });
  const t = await dueSettlements(j, S);
  assert.match(t, /DATA_UNAVAILABLE: prices to settle NVDA on 2026-09-01/);
  assert.equal(j.pending().length, 1);
});

test('settling keeps the desk\'s own figures with the lesson, once', async () => {
  const j = journalWith();
  configure({ fetch: feed() });
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%, so the thesis held; size up next time.'), /^Settled: NVDA \+10\.0% .* alpha \+7\.0%/);
  const e = j.load()[0]!;
  assert.deepEqual([e.pending, e.raw, e.alpha, e.holding, e.resolved], [false, '+10.0%', '+7.0%', '5d', '2026-09-08']);
  await assert.rejects(settleOne(j, S, 'NVDA', '2026-09-01', 'again'), /no pending call on NVDA for 2026-09-01/);
  await assert.rejects(settleOne(journalWith(), S, 'NVDA', '2026-09-01', '  '), /the lesson is empty/);
  await assert.rejects(settleOne(journalWith(), S, 'NVDA', '2026-09-01', 'x'.repeat(1300)), /keep it under 1200/);
});

test('a call whose window is open stays pending when settling is tried', async () => {
  const j = journalWith();
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  configure({ fetch: feed({ LATE: rows('2026-10-09', 3, [10, 11, 12]) }) });
  assert.match(await settleOne(j, S, 'LATE', '2026-10-10', 'Too early.'), /^NOT_YET: /);
  assert.equal(j.pending().length, 2);
});
