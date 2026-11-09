import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { Journal } from '../src/desk/journal.js';
import { checkName, checkWords, exchangeOf, legacyRules, measure, resolveBenchmark, rulesFor, type Rules } from '../src/desk/scoring.js';
import { dueSettlements, settleOne } from '../src/desk/settle.js';
import { DEFAULTS } from '../src/settings.js';
import { chartFetch, type Row } from './chart.js';

const S = DEFAULTS.scoring;
const TRADING5 = { yardstick: 'SPY', days: 5, unit: 'trading' } as const;
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
  const o = (await measure('NVDA', '2026-09-01', TRADING5))!;
  assert.deepEqual([o.entry, o.exit, o.holdingDays], ['2026-09-01', '2026-09-08', 5]);
  assert.ok(Math.abs(o.raw - 0.10) < 1e-9);                  // 100 -> 110
  assert.ok(Math.abs(o.benchmarkReturn - 0.03) < 1e-9);       // the index: 200 -> 206
  assert.ok(Math.abs(o.alpha - 0.07) < 1e-9);
});

test('a window that has not finished trading is not yet, never a partial figure', async () => {
  configure({ fetch: feed() });
  assert.equal(await measure('NVDA', '2026-09-01', { ...TRADING5, days: 10 }), null);                 // only 7 rows after entry
  process.env.TRADING_AGENTS_TODAY = '2026-09-08';                                     // the exit session is today's, still moving
  assert.equal(await measure('NVDA', '2026-09-01', TRADING5), null);
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  configure({ fetch: feed({ SPY: SPY.slice(0, 9) }) });                               // the index has not traded through the exit
  clearCache();
  assert.equal(await measure('NVDA', '2026-09-01', TRADING5), null);
});

const journalWith = () => { const j = new Journal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-s-')), 'journal.md')); j.storeDecision('NVDA', '2026-09-01', '**Rating**: Buy\n\nAdd.'); return j; };

test('pending calls are listed with their measured outcome, or why not', async () => {
  const j = journalWith();
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  configure({ fetch: feed({ LATE: rows('2026-10-09', 3, [10, 11, 12]) }) });
  const t = await dueSettlements(j, S);
  assert.match(t, /2 pending call\(s\), 1 ready/);
  assert.match(t, /\[2026-09-01 \| NVDA \| Buy\] READY: NVDA \+10\.0% from 2026-09-01 to 2026-09-08 \(5 trading days\); SPY \+3\.0%; alpha \+7\.0%\nTHIS SCORE IS A FIRST-WEEK CHECK: the 5 trading days after the call against SPY, not the call's own time horizon \(its decision states that\)\. Say in the lesson how much a window this short can show about the thesis\.\nDECISION:\n\*\*Rating\*\*: Buy/);
  assert.match(t, /\[2026-10-10 \| LATE \| Sell\] NOT YET: its window, the 5 trading days after 2026-10-10 \(against SPY\), has not finished\. Leave it pending\./);
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

// Audit 1, F1: once a dividend has gone ex since the window, its adjusted rows sit below what the market printed, so a
// level the decision named is checked against the prices as traded, shown beside them; with no dividend, the rows say so.
test('the window rows show the prices as traded beside the adjusted ones once a dividend has lowered them, and say when none has', async () => {
  const j = journalWith();
  configure({ fetch: feed() });
  const plain = await dueSettlements(j, S);
  assert.match(plain, /These prices are also the prices as traded \(no dividend has lowered them\), so a price level the decision named can be checked against them\./);
  assert.doesNotMatch(plain, /as traded \|/);
  assert.match(plain, /prices adjusted for splits and dividends \(the call is scored on these, so its return counts any dividend\)/);
  clearCache();
  // A 1% dividend went ex after the window: every row of the window is 1% lower adjusted than printed.
  configure({ fetch: feed({ NVDA: NVDA.map((r) => ({ ...r, adj: r.c * 0.99 })) }) });
  const t = await dueSettlements(j, S), table = t.slice(t.indexOf('WHAT HAPPENED IN THE WINDOW'));
  assert.match(table, /A dividend has gone ex since some of these days, so their adjusted prices sit below what the market printed then\. The last three columns are the high, low and close as traded: check every price level the decision named \(an entry, a stop, a target\) against those, never against the adjusted prices\./);
  assert.match(table, /\nSession \| Date \| Open \| High \| Low \| Close \| Change \| Volume \| RSI \| MACD histogram \| 10 EMA \| 50 SMA \| SPY close \| High as traded \| Low as traded \| Close as traded\n/);
  assert.match(table, /\n5 \| 2026-09-08 \| 108\.90 \| 108\.90 \| 108\.90 \| 108\.90 \| \+5\.77% \| 1,000 \| .* \| 206\.00 \| 110\.00 \| 110\.00 \| 110\.00\n/, 'adjusted 108.90, as traded 110.00');
  assert.match(table, /\nAS TRADED, IN SESSIONS 1 TO 5: highest close 110\.00 on 2026-09-08; lowest close 101\.00 on 2026-09-02; highest high 110\.00 on 2026-09-08; lowest low 101\.00 on 2026-09-02\./);
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

// 8 Nov 2026: a score is a first-week check against a named yardstick, never the call's own horizon. Each new call keeps
// its window and yardstick in its journal tag; a call recorded before keeps the rules it was made under.
test('a new call gets its window and yardstick by what it is: a US listing, a coin, a listed or an unlisted exchange, or the one choice', () => {
  assert.deepEqual(rulesFor('NVDA', S), { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'us' });
  assert.deepEqual(rulesFor('BRK.B', S), { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'us' }, 'a US share class is not an exchange');
  assert.deepEqual(rulesFor('BTC-USD', S), { days: 7, unit: 'calendar', yardstick: 'SPY', basis: 'coin' }, 'a coin: the same week, in calendar days');
  assert.deepEqual(rulesFor('7203.T', S), { days: 5, unit: 'trading', yardstick: '^N225', basis: 'market' }, 'the foreign indexes in the settings stay');
  assert.deepEqual(rulesFor('AMXL.MX', S), { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'unlisted' }, 'an exchange the settings do not list is scored against SPY, and says so');
  assert.deepEqual(rulesFor('NVDA', { ...S, benchmark: 'qqq' }), { days: 5, unit: 'trading', yardstick: 'QQQ', basis: 'chosen' });
  assert.deepEqual([exchangeOf('BRK.B'), exchangeOf('7203.T'), exchangeOf('6488.TWO'), exchangeOf('NVDA')], [null, '.T', '.TWO', null]);
  assert.equal(checkWords('BTC-USD', rulesFor('BTC-USD', S)), "a first-week check against SPY, the fund that copies the S&P 500 (the desk's settings name no yardstick for coins, so a coin is scored against the one for US listings), over the 7 calendar days after the call");
  assert.equal(checkWords('AMXL.MX', rulesFor('AMXL.MX', S)), "a first-week check against SPY, the fund that copies the S&P 500 (its exchange, .MX, had no index in the desk's settings when the call was made, so it is scored against the one for US listings), over the 5 trading days after the call");
  assert.deepEqual([checkName({ days: 3, unit: 'trading' }), checkName({ days: 5, unit: 'calendar' })], ['a check over its first 3 trading days', 'a check over its first 5 calendar days']);
});

test('a call recorded before the desk kept its window is scored as such calls were then: its stored days, and a coin in calendar days', () => {
  assert.deepEqual(legacyRules('BTC-USD', S, '5d'), { days: 5, unit: 'calendar', yardstick: 'SPY', basis: 'coin' });
  assert.deepEqual(legacyRules('NVDA', S, null), { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'us' });
  assert.equal(legacyRules('NVDA', { ...S, holdingPeriodDays: 3 }, '5d').days, 5, 'a scored call keeps the days it was scored over');
});

test('a call keeps its window and yardstick in its tag, through a settle, and a later change to the settings does not change them', async () => {
  const j = new Journal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-s-')), 'journal.md'));
  j.storeDecision('NVDA', '2026-09-01', '**Rating**: Buy\n\nAdd.', undefined, rulesFor('NVDA', S));
  assert.match(fs.readFileSync(j.file, 'utf8'), /^\[2026-09-01 \| NVDA \| Buy \| pending \| window:5 trading days \| yardstick:SPY \(us\)\]\n/);
  assert.deepEqual(j.load()[0]!.rules, { days: 5, unit: 'trading', yardstick: 'SPY', basis: 'us' });
  configure({ fetch: feed() });
  const later = { ...S, holdingPeriodDays: 3 };   // the person changes the settings after the call
  assert.match(await dueSettlements(j, later), /READY: NVDA \+10\.0% from 2026-09-01 to 2026-09-08 \(5 trading days\)/);
  assert.match(await settleOne(j, later, 'NVDA', '2026-09-01', 'Alpha was +7.0%. The thesis held.'), /^Settled: NVDA \+10\.0% .* alpha \+7\.0%/);
  assert.match(fs.readFileSync(j.file, 'utf8'), /^\[2026-09-01 \| NVDA \| Buy \| \+10\.0% \| \+7\.0% \| 5d \| resolved:2026-09-08 \| window:5 trading days \| yardstick:SPY \(us\) \| lesson:prices\]\n/);
  const e = j.load()[0]!;
  assert.deepEqual([e.rules?.days, e.lesson, e.holding], [5, 'prices', '5d']);
  assert.match(j.pastContext('NVDA'), /\[2026-09-01 \| NVDA \| Buy \| return \+10\.0% \| alpha \+7\.0% \| a first-week check: against SPY over the 5 trading days after the call, not the call's own time horizon\]/);
  // a hand-made tag with a window the journal cannot keep reads as none, and storeDecision refuses one
  assert.throws(() => j.storeDecision('AMD', '2026-09-01', 'x', 'Hold', { days: 0, unit: 'trading', yardstick: 'SPY', basis: 'us' }), /a window of 0 days/);
  assert.throws(() => j.storeDecision('AMD', '2026-09-01', 'x', 'Hold', { days: 5, unit: 'trading', yardstick: 'S P Y', basis: 'us' }), /is not a ticker the journal can keep/);
});

// A coin trades every day; SPY only on New York's market days. 2026-09-05 is a Saturday, 2026-09-07 Labor Day.
const everyDay = (from: string, to: string): string[] => { const out: string[] = []; for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const COIN_DAYS = everyDay('2026-08-24', '2026-09-30');
const BTC: Row[] = COIN_DAYS.map((date, i) => ({ date, o: 1000 + i * 10, h: 1000 + i * 10, l: 1000 + i * 10, c: 1000 + i * 10, v: 5 }));
const NY_DAYS = COIN_DAYS.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0 && d !== '2026-09-07');
const SPY_NY: Row[] = NY_DAYS.map((date, i) => ({ date, o: 600 + i, h: 600 + i, l: 600 + i, c: 600 + i, v: 1000 }));
const closeOf = (rows: Row[], d: string) => rows.find((r) => r.date === d)!.c;
const COIN7: Rules = { days: 7, unit: 'calendar', yardstick: 'SPY', basis: 'coin' };
const coinFeed = (o: { btc?: Row[]; spy?: Row[] } = {}) => chartFetch((sym) => (({ 'BTC-USD': o.btc ?? BTC, SPY: o.spy ?? SPY_NY }) as Record<string, Row[]>)[sym] ?? []);

test("a coin's week is 7 calendar days, against SPY over the same dates: SPY's close on a weekend day is its Friday's", async () => {
  configure({ fetch: coinFeed() });
  const o = (await measure('BTC-USD', '2026-09-05', COIN7))!;                        // Saturday to Saturday
  assert.deepEqual([o.entry, o.exit, o.holdingDays, o.unit, o.benchFrom, o.benchTo], ['2026-09-05', '2026-09-12', 7, 'calendar', '2026-09-04', '2026-09-11']);
  assert.ok(Math.abs(o.raw - (closeOf(BTC, '2026-09-12') / closeOf(BTC, '2026-09-05') - 1)) < 1e-12);
  assert.ok(Math.abs(o.benchmarkReturn - (closeOf(SPY_NY, '2026-09-11') / closeOf(SPY_NY, '2026-09-04') - 1)) < 1e-12);
  assert.ok(Math.abs(o.alpha - (o.raw - o.benchmarkReturn)) < 1e-12);
});

test("a coin's window that ends on a New York holiday takes SPY's last close before it", async () => {
  configure({ fetch: coinFeed() });
  const o = (await measure('BTC-USD', '2026-08-31', COIN7))!;                        // Monday to Labor Day
  assert.deepEqual([o.entry, o.exit, o.benchFrom, o.benchTo], ['2026-08-31', '2026-09-07', '2026-08-31', '2026-09-04']);
});

test("a coin's window is not scored while SPY's close for New York's last market day of it is missing, or the coin's own last day is", async () => {
  configure({ fetch: coinFeed({ spy: SPY_NY.filter((r) => r.date <= '2026-09-03') }) });
  await assert.rejects(measure('BTC-USD', '2026-08-28', COIN7), /Yahoo Finance gives no SPY close for 2026-09-04 yet, the last New York market day of the window/);
  clearCache();
  configure({ fetch: coinFeed({ btc: BTC.filter((r) => r.date !== '2026-09-12') }) });
  await assert.rejects(measure('BTC-USD', '2026-09-05', COIN7), /Yahoo Finance gives no BTC-USD close for 2026-09-12, the last day of its 7 calendar days window/);
  clearCache();
  process.env.TRADING_AGENTS_TODAY = '2026-09-12';                                      // its last day is today's, still moving
  configure({ fetch: coinFeed() });
  assert.equal(await measure('BTC-USD', '2026-09-05', COIN7), null);
});

test("a coin's ready call names its window, SPY's two closes and how they are taken", async () => {
  const j = new Journal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-s-')), 'journal.md'));
  j.storeDecision('BTC-USD', '2026-09-05', '**Rating**: Buy\n\nAdd.', undefined, rulesFor('BTC-USD', S));
  configure({ fetch: coinFeed() });
  const t = await dueSettlements(j, S);
  assert.match(t, /READY: BTC-USD [+-]\d+\.\d% from 2026-09-05 to 2026-09-12 \(7 calendar days\); SPY [+-]\d+\.\d% \(its close of 2026-09-04 to its close of 2026-09-11\); alpha /);
  assert.match(t, /THIS SCORE IS A FIRST-WEEK CHECK: the 7 calendar days after the call against SPY, not the call's own time horizon .* A coin trades every day, so its window is calendar days; its yardstick trades only on New York's market days/);
});
