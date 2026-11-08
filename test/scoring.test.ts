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

test('a ready call lists its window day by day, so the lesson is written from what happened, not guessed', async () => {
  const j = journalWith();
  configure({ fetch: feed() });
  const t = await dueSettlements(j, S);
  assert.match(t, /find it in that call's window rows: say what happened only as a row shows it, naming its date/);
  const table = t.slice(t.indexOf('WHAT HAPPENED IN THE WINDOW'));
  assert.match(table, /^WHAT HAPPENED IN THE WINDOW: NVDA's finished sessions from 2026-09-01 \(entry\) to 2026-09-08 \(exit\)/);
  assert.match(table, /\nSession \| Date \| Open \| High \| Low \| Close \| Change \| Volume \| RSI \| MACD histogram \| 10 EMA \| 50 SMA \| SPY close\n/);
  const rows = table.split('\n').filter((l) => /^(entry|\d+) \| \d{4}-\d{2}-\d{2} \|/.test(l));
  assert.deepEqual(rows.map((r) => r.split(' | ').slice(0, 2).join(' ')), ['entry 2026-09-01', '1 2026-09-02', '2 2026-09-03', '3 2026-09-04', '4 2026-09-07', '5 2026-09-08']);   // entry to exit, nothing after
  // the entry row is the close the call is scored from, not a session of the window: its own move is left out
  assert.match(rows[0]!, /^entry \| 2026-09-01 \| 100\.00 \| 100\.00 \| 100\.00 \| 100\.00 \| left out \| 1,000 \| .* \| 200\.00$/);
  assert.match(rows[5]!, /^5 \| 2026-09-08 \| 110\.00 \| 110\.00 \| 110\.00 \| 110\.00 \| \+5\.77% \| 1,000 \| .* \| 206\.00$/);   // 104 -> 110; the index's close beside it
  assert.ok(t.indexOf('WHAT HAPPENED') > t.indexOf('DECISION:'));   // what was decided, then what happened
});

test('a window whose rows cannot be fetched says so, and the lesson may then say nothing about any day', async () => {
  const j = journalWith(), base = feed();
  const longAgo = (url: string) => Number(new URL(url).searchParams.get('period1')) < Date.parse('2026-08-01') / 1000;
  configure({ fetch: async (input, init) => { const url = String(input); if (url.includes('/NVDA?') && longAgo(url)) throw new TypeError('fetch failed'); return base(input, init); } });
  const t = await dueSettlements(j, S);
  assert.match(t, /READY: NVDA \+10\.0%/);   // the outcome is still measured from its own rows
  assert.match(t, /WHAT HAPPENED IN THE WINDOW: DATA_UNAVAILABLE: the day-by-day rows of NVDA's window: .* say nothing about what happened on any day of the window\./);
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

// 8 Nov 2026: the desk began refusing lessons of more than four sentences, and the routines score calls with no one
// watching. A team refused again and again must not go round in a loop, as one did with reset_team on 7 Nov.
const FIVE = 'One. Two. Three. Four. Five.';
const LATER = 'A later scoring, started an hour or more after record_outcome was last used, tries it again.';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a call record_outcome fails to settle twice is LEFT: it stays pending, the listing names it without its rows, and sent again with nothing settled since it answers STOP', async () => {
  const j = journalWith();
  j.storeDecision('AMD', '2026-09-01', '**Rating**: Hold\n\nWait.');
  configure({ fetch: feed({ AMD: NVDA }) });
  const t0 = Date.parse('2026-10-12T08:00:00Z');
  await assert.rejects(settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0), /^Error: the lesson has 5 sentences; write 2 to 4\./, 'the first time, said as a refusal to correct');
  const left = await settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 1000);
  assert.match(left, new RegExp(`^LEFT: record_outcome has now failed to settle NVDA on 2026-09-01 2 times in this scoring \\(this time: the lesson has 5 sentences; write 2 to 4\\. .*\\)\\. Leave it: do not send it again in this scoring\\. It stays pending, unscored\\. Go on with the next READY call, and at the end tell the person it was left, and why\\. ${esc(LATER)}$`));
  assert.deepEqual(j.pending().map((e) => e.ticker), ['NVDA', 'AMD'], 'nothing settled');

  const listing = await dueSettlements(j, S, undefined, t0 + 2000);
  assert.match(listing, /^2 pending call\(s\), 1 ready to settle, 1 left in this scoring after 2 failed tries\. /);
  assert.match(listing, new RegExp(`\\[2026-09-01 \\| NVDA \\| Buy\\] LEFT: record_outcome failed to settle it 2 times in this scoring \\(the last time: the lesson has 5 sentences; .*\\)\\. Leave it pending, unscored: do not send it again in this scoring\\. Name it to the person at the end, with that reason\\. ${esc(LATER)}`));
  assert.doesNotMatch(listing, /\[2026-09-01 \| NVDA \| Buy\] READY/, 'its rows are not shown again');
  assert.match(listing, /\[2026-09-01 \| AMD \| Hold\] READY: /);

  const stop = await settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 3000);
  assert.match(stop, new RegExp(`^STOP: record_outcome has now failed to settle NVDA on 2026-09-01 3 times in this scoring \\(this time: the lesson has 5 sentences; .*\\)\\. It was left after 2 failed tries, and no call has been settled since, so the scoring is going round in a loop\\. Do not send it again now: it stays pending, unscored\\. Go on with any other READY call, and at the end tell the person it was left, and why\\. ${esc(LATER)}$`));
  assert.equal(j.pending().length, 2);

  // once another call is settled, the team is not going round: a failure is LEFT again; a lesson the desk can keep is kept
  assert.match(await settleOne(j, S, 'AMD', '2026-09-01', 'Alpha was +7.0%. The Hold was too careful.', t0 + 4000), /^Settled: AMD /);
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 5000), /^LEFT: .* 4 times in this scoring/);
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%. The add trigger fired.', t0 + 6000), /^Settled: NVDA /);
  assert.match(await dueSettlements(j, S, undefined, t0 + 7000), /^No pending calls/);
});

test('an hour after record_outcome was last used, a scoring starts afresh and shows the call it left in full; the listing writes nothing, and a call that is not pending is never counted', async () => {
  const j = journalWith(), notes = path.join(path.dirname(j.file), 'settle-check.json');
  configure({ fetch: feed() });
  const t0 = Date.parse('2026-10-12T08:00:00Z'), hour = 60 * 60_000;
  assert.match(await dueSettlements(j, S, undefined, t0), /\[2026-09-01 \| NVDA \| Buy\] READY/);
  assert.ok(!fs.existsSync(notes), 'list_settlements only reads');
  await assert.rejects(settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 1000));
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 2000), /^LEFT: /);
  assert.match(await dueSettlements(j, S, undefined, t0 + 2000 + hour - 1), /LEFT: record_outcome failed to settle it 2 times/);
  const later = await dueSettlements(j, S, undefined, t0 + 2000 + hour);
  assert.match(later, /^1 pending call\(s\), 1 ready to settle\. /);
  assert.match(later, /\[2026-09-01 \| NVDA \| Buy\] READY: [\s\S]*WHAT HAPPENED IN THE WINDOW/);
  await assert.rejects(settleOne(j, S, 'NVDA', '2026-09-01', FIVE, t0 + 2000 + hour + 1), /the lesson has 5 sentences/, 'its first failure is said as one again');

  // a call that is not pending has nothing to go round on: it is said as it is, every time
  for (const t of [1, 2, 3]) await assert.rejects(settleOne(j, S, 'ZZZ', '2026-09-01', 'Alpha was +1.0%. Hold.', t0 + 3 * hour + t), /there is no pending call on ZZZ for 2026-09-01/);
});

test('a call whose window is open stays pending when settling is tried', async () => {
  const j = journalWith();
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  configure({ fetch: feed({ LATE: rows('2026-10-09', 3, [10, 11, 12]) }) });
  assert.match(await settleOne(j, S, 'LATE', '2026-10-10', 'Too early.'), /^NOT_YET: /);
  assert.equal(j.pending().length, 2);
});
