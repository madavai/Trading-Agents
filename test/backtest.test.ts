import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cells, iterGrid, MAX_CELLS, renderSummary, summarize } from '../src/desk/backtest.js';
import type { Entry } from '../src/desk/journal.js';
import { clearCache } from '../src/data/yahoo.js';
import { deskServer } from '../src/tools/server.js';
import { isOrderTool } from '../src/robinhood/connect.js';
import { chartFetch, type Row } from './chart.js';

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearCache(); });

test('the grid runs from the start every few days and stops at today', () => {
  assert.deepEqual(iterGrid('2026-06-01', '2026-06-22', 7), ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']);
  assert.deepEqual(iterGrid('2026-10-01', '2027-01-01', 5), ['2026-10-01', '2026-10-06', '2026-10-11']);   // never past today
  assert.deepEqual(iterGrid('2026-10-12', '2026-10-12', 1), ['2026-10-12']);
  assert.throws(() => iterGrid('2026-06-10', '2026-06-01', 7), /ends before it starts/);
  assert.throws(() => iterGrid('2026-11-01', '2026-12-01', 7), /starts after today/);
  assert.throws(() => iterGrid('2026-06-01', '2026-06-22', 0), /whole number of days/);
  assert.throws(() => iterGrid('June', '2026-06-22', 7), /YYYY-MM-DD/);
});

test('cells are a stock at a time, with a stock or date given twice counted once, and a sweep has limits', () => {
  assert.deepEqual(cells(['nvda', 'AAPL', 'NVDA'], ['2026-06-01', '2026-06-08', '2026-06-01']).map((c) => `${c.symbol} ${c.date}`), ['NVDA 2026-06-01', 'NVDA 2026-06-08', 'AAPL 2026-06-01', 'AAPL 2026-06-08']);
  assert.throws(() => cells([], ['2026-06-01']), /at least one stock/);
  assert.throws(() => cells(Array.from({ length: 11 }, (_, i) => `S${i}`), ['2026-06-01']), /more than a sweep takes \(10\)/);
  assert.throws(() => cells(['A', 'B'], Array.from({ length: MAX_CELLS }, (_, i) => `2025-01-${String(i % 28 + 1).padStart(2, '0')}-${i}`).map((_, i) => `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`)), /more than a sweep takes \(100\)/);
  assert.throws(() => cells(['../x'], ['2026-06-01']), /not a ticker/);
});

const e = (rating: string, alpha: string | null, pending = false, holding = '5d'): Entry => ({ date: '2026-06-01', ticker: 'X', rating, pending, raw: pending ? null : '+1.0%', alpha: pending ? null : alpha, holding: pending ? null : holding, resolved: null, decision: '', reflection: '' });

test('calls are scored by rating: direction hit rate for Buy and Sell, none for Hold, and unreadable ratings left out', () => {
  const s = summarize([e('Buy', '+7.0%'), e('Buy', '-2.0%'), e('Overweight', '+1.0%'), e('Sell', '-4.0%'), e('Sell', '+3.0%'), e('Hold', '+0.5%'), e('Hold', '-0.5%'), e('Needs review', '+9.0%'), e('Buy', null, true), e('Sell', 'n/a')]);
  assert.deepEqual([s.resolved, s.pending, s.unscored, s.holding], [7, 2, 1, '5 trading days']);
  assert.deepEqual([s.byRating['Buy']!.count, s.byRating['Buy']!.hitRate], [2, 0.5]);
  assert.ok(Math.abs(s.byRating['Buy']!.meanAlpha - 0.025) < 1e-12);
  assert.equal(s.byRating['Overweight']!.hitRate, 1);
  assert.deepEqual([s.byRating['Sell']!.count, s.byRating['Sell']!.hitRate], [2, 0.5]);
  assert.ok(Math.abs(s.byRating['Sell']!.meanAlpha + 0.005) < 1e-12);
  assert.deepEqual([s.byRating['Hold']!.hitRate, s.byRating['Hold']!.meanAlpha], [null, 0]);
  assert.equal(s.byRating['Needs review'], undefined);
  assert.deepEqual(Object.keys(s.byRating), ['Buy', 'Overweight', 'Sell', 'Hold']);
});

test('the summary says what it is and is not', () => {
  const t = renderSummary(summarize([e('Buy', '+7.0%'), e('Needs review', null), e('Sell', null, true)]));
  assert.match(t, /^Resolved cells: 1 · pending: 1 · unscored: 1\n- Buy: n=1, called the direction 100%, mean alpha \+7\.00% vs the benchmark/);
  assert.match(t, /Pending cells are not scored above/);
  assert.match(t, /Unscored cells had no readable rating/);
  assert.match(t, /measured over 5 trading days/);
  assert.match(t, /fewer than about 30 calls per rating is noise/);
  assert.match(renderSummary(summarize([])), /Resolved cells: 0 · pending: 0/);
});

const forward = (from: string, n: number): string[] => { const out: string[] = []; const d = new Date(`${from}T00:00:00Z`); while (out.length < n) { if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
const rows = (from: string, closes: number[]): Row[] => forward(from, closes.length).map((date, i) => ({ date, o: closes[i]!, h: closes[i]!, l: closes[i]!, c: closes[i]!, v: 1000 }));
const feed = chartFetch((s) => (s === 'NVDA' ? rows('2026-08-31', [100, 101, 102, 103, 104, 110, 111, 112, 113, 114, 115]) : rows('2026-08-24', Array.from({ length: 20 }, (_, i) => 195 + i))));

async function connect() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-b-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, feed).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { root, client, call };
}

test('a sweep records into its own journal and runs, never the live ones, and can be resumed', async () => {
  const { root, client, call } = await connect();
  const live = path.join(root, 'desk-data');
  const args = { symbols: ['NVDA'], start_date: '2026-08-31', end_date: '2026-09-07', every_days: 7 };
  assert.match(await call('start_backtest', args), /^NEEDS_EMAIL: /);
  await call('set_contact_email', { email: 'jane@mail.com' });
  const started = await call('start_backtest', { ...args, sweep_id: 'june' });
  assert.match(started, /^Backtest sweep june: 2 cell\(s\) \(1 stock\(s\) on 2 date\(s\), every 7 day\(s\), 2026-08-31 to 2026-09-07\); 0 already recorded, 2 to run\./);
  assert.match(started, /1\. NVDA 2026-08-31\n2\. NVDA 2026-09-07/);
  assert.match(started, /news, posts, odds, the company profile and insider trades exist only for recent days/);

  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-31', analysts: ['market'] }), /^\[Backtest sweep june: this run is recorded in the sweep's own journal, not the live one\.\]\nAnalysis plan for NVDA/);
  await call('save_run_section', { symbol: 'NVDA', analysis_date: '2026-08-31', section: 'decision', text: '**Rating**: Buy\n\nAdd.' });
  assert.match(await call('record_decision', { symbol: 'NVDA', analysis_date: '2026-08-31' }), /^Recorded: NVDA on 2026-08-31, Buy, pending/);
  assert.ok(fs.existsSync(path.join(live, 'backtest', 'june', 'journal.md')));
  assert.ok(!fs.existsSync(path.join(live, 'journal.md')), 'the live journal was touched');
  assert.ok(!fs.existsSync(path.join(live, 'runs')), 'the live runs were touched');

  assert.match(await call('list_settlements'), /1 pending call\(s\), 1 ready[\s\S]*SPY \+2\.5%; alpha \+7\.5%/);
  assert.match(await call('record_outcome', { symbol: 'NVDA', trade_date: '2026-08-31', lesson: 'Alpha +7.5%, thesis held.' }), /^Settled: NVDA \+10\.0%/);
  const summary = await call('backtest_summary');
  assert.match(summary, /^Backtest sweep june: 1 call\(s\) recorded of 2 planned\n\nResolved cells: 1 · pending: 0\n- Buy: n=1, called the direction 100%, mean alpha \+7\.50%/);

  assert.match(await call('end_backtest'), /Backtest sweep june ended\. The desk is back on the live journal\./);
  assert.match(await call('list_settlements'), /No pending calls: every call in the journal is settled\./);       // the live journal is empty
  assert.doesNotMatch(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-31', restart: true }), /Backtest sweep/);
  assert.match(await call('backtest_summary', { sweep_id: 'june' }), /1 call\(s\) recorded/);
  assert.match(await call('end_backtest'), /No backtest was running/);

  assert.match(await call('start_backtest', { ...args, sweep_id: 'june' }), /2 cell\(s\).*1 already recorded, 1 to run\.[\s\S]*1\. NVDA 2026-09-07/);     // resumed: the recorded cell is skipped
  await client.close();
});

test('every copy of the tool server routes the same way, and an abandoned sweep lapses', async () => {
  const { root, call } = await connect();
  await call('set_contact_email', { email: 'jane@mail.com' });
  await call('start_backtest', { symbols: ['NVDA'], start_date: '2026-08-31', end_date: '2026-09-07', sweep_id: 'shared' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, feed).connect(a);                    // a second copy, as if an agent had its own connection
  const other = new Client({ name: 'other', version: '0' });
  await other.connect(b);
  const second = async (name: string, args: Record<string, unknown>) => ((await other.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(await second('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-31' }), /^\[Backtest sweep shared:/);
  await second('save_run_section', { symbol: 'NVDA', analysis_date: '2026-08-31', section: 'decision', text: '**Rating**: Hold\n\nx' });
  await second('record_decision', { symbol: 'NVDA', analysis_date: '2026-08-31' });
  assert.ok(fs.existsSync(path.join(root, 'desk-data', 'backtest', 'shared', 'journal.md')));
  assert.ok(!fs.existsSync(path.join(root, 'desk-data', 'journal.md')));
  const active = path.join(root, 'desk-data', 'backtest', 'active.json');       // idle for more than two hours: the sweep has lapsed
  fs.writeFileSync(active, JSON.stringify({ sweep: 'shared', at: Date.now() - 3 * 3_600_000 }));
  assert.doesNotMatch(await second('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-30' }), /Backtest sweep/);
  fs.writeFileSync(active, '{not json');
  assert.doesNotMatch(await second('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-29' }), /Backtest sweep/);
  await other.close();
});

test('a sweep refuses what it cannot run, and its tools cannot order', async () => {
  const { call, client } = await connect();
  await call('set_contact_email', { email: 'jane@mail.com' });
  assert.match(await call('start_backtest', { symbols: ['NVDA'], start_date: '2026-09-07', end_date: '2026-09-01' }), /^INPUT_ERROR: the grid ends before it starts/);
  assert.match(await call('start_backtest', { symbols: ['NVDA'], start_date: '2026-09-01', end_date: '2026-09-07', sweep_id: '../live' }), /^INPUT_ERROR: .* is not a sweep name/);
  assert.match(await call('backtest_summary'), /^INPUT_ERROR: no backtest is running/);
  assert.match(await call('backtest_summary', { sweep_id: 'nothing' }), /^INPUT_ERROR: sweep nothing has no recorded calls yet/);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['start_backtest', 'end_backtest', 'backtest_summary']) assert.ok(names.includes(n), n);
  assert.deepEqual(names.filter(isOrderTool), []);
  await client.close();
});

test('/backtest asks before spending, keeps the live journal out, and reports only the summary\'s figures', () => {
  const t = fs.readFileSync('.claude/skills/backtest/SKILL.md', 'utf8');
  for (const tool of ['start_backtest', 'end_backtest', 'backtest_summary', 'record_decision', 'list_settlements', 'record_outcome', 'set_contact_email']) assert.ok(t.includes(tool), tool);
  assert.match(t, /more than 3 cells, \*\*ask whether to go ahead and wait for a yes\*\*/);
  assert.match(t, /live journal is never touched/);
  assert.match(t, /Never work out a return, alpha or hit rate yourself/);
  assert.match(fs.readFileSync('.claude/skills/analyse/SKILL.md', 'utf8'), /Inside a backtest .* skip the summary/);
});
