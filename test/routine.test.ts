import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eveningBrief, morningBrief, morningList } from '../src/desk/routine.js';
import { logOrder, ordersOn, placedToday } from '../src/desk/orders.js';
import { saveAccountHoldings, saveHoldings } from '../src/desk/holdings.js';
import { Journal } from '../src/desk/journal.js';
import { addWatch, setFavourite } from '../src/terminal/store.js';
import { enqueue, readQueue, startItem } from '../src/desk/queue.js';
import { chartFetch, series } from './chart.js';
import { readSettings } from '../src/settings.js';
import { deskServer } from '../src/tools/server.js';

const desk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-routine-')); return { root, dir: path.join(root, 'desk-data') }; };
const call = (dir: string, ticker: string, date: string, rating = 'Buy') => new Journal(path.join(dir, 'journal.md')).storeDecision(ticker, date, `**Rating**: ${rating}\n\n**Executive Summary**: ${ticker} on ${date}.`);
const sent = (at: string, symbol: string, approvalRequired: boolean | null, answered = true) => ({ at, symbol, side: 'buy' as const, quantity: 1, limitPrice: 182.4, call: { date: '2026-10-16', rating: 'Buy' }, robinhood: { answered, approvalRequired, orderId: answered ? 'abc' : null, state: answered ? 'queued' : null, error: answered ? null : 'Market closed.' } });

test('the morning analyses what was asked for on the dashboard first, then the starred watchlist, never twice in a day, within the limit', () => {
  const { dir } = desk();
  for (const s of ['AAPL', 'MSFT', 'TSLA', 'AMD', 'NVDA', '^GSPC']) addWatch(dir, s, '2026-10-16');
  for (const s of ['AAPL', 'MSFT', 'TSLA', 'AMD', '^GSPC']) setFavourite(dir, s, true);
  enqueue(dir, 'NVDA', '2026-10-16T12:00:00Z', 'deep'); enqueue(dir, 'AAPL', '2026-10-16T12:01:00Z');
  call(dir, 'MSFT', '2026-10-19'); call(dir, 'TSLA', '2026-10-16');   // MSFT already called today; TSLA's call is old
  const m = morningList(dir, '2026-10-19', 3);
  assert.deepEqual(m.analyse, [{ symbol: 'NVDA', why: 'asked for on the dashboard, deep depth', queued: true }, { symbol: 'AAPL', why: "asked for on the dashboard, the settings' depth", queued: true }, { symbol: 'TSLA', why: 'a starred watchlist stock', queued: false }]);
  assert.deepEqual(m.later, ['AMD'], 'over the limit, left for another morning; an index is never analysed');
  assert.deepEqual(m.calledToday, ['MSFT']);
  const brief = morningBrief(dir, '2026-10-19', 3);
  assert.match(brief, /^MORNING ROUTINE for Monday 2026-10-19\./);
  assert.match(brief, /1\. Score past calls first/);
  assert.match(brief, /3 of at most 3 a morning[\s\S]*1\. NVDA \(asked for on the dashboard, deep depth\)[\s\S]*3\. TSLA/);
  assert.match(brief, /start_queue_item first \(it gives the depth\)/);
  assert.match(brief, /call end_queue_run once/);
  assert.match(brief, /Left for another morning, over the limit of 3: AMD/);
  assert.match(brief, /Already called today, so not analysed again: MSFT/);
  assert.match(brief, /Holdings: not provided/);
  assert.match(brief, /only the person's own Confirm there places an order/);
  assert.match(brief, /do not wait for an answer/);
  // a stock being analysed by another run is left alone
  startItem(dir, 'NVDA', '2026-10-19');
  const busy = morningList(dir, '2026-10-19', 3);
  assert.equal(busy.running, 'NVDA');
  assert.deepEqual(busy.analyse.map((a) => a.symbol), ['AAPL', 'TSLA', 'AMD']);
  assert.match(morningBrief(dir, '2026-10-19', 3), /NVDA is being analysed now by another run: leave it alone/);
});

test('on a weekend the morning only scores past calls; holdings are said to be as the dashboard last read them, never fresher', () => {
  const { dir } = desk();
  assert.match(morningBrief(dir, '2026-10-17', 5), /US markets do not open on a Saturday: score past calls \(step 1\), then stop/);
  assert.match(morningBrief(dir, '2026-10-19', 5), /2\. Nothing to analyse/);
  saveAccountHoldings(dir, [{ label: 'Desk', tradable: true, positions: [] }], '2026-10-16');
  assert.match(morningBrief(dir, '2026-10-19', 5), /as the dashboard last read them from Robinhood, on 2026-10-16\. The team never reads Robinhood itself/);
  saveHoldings(dir, { positions: [] }, '2026-10-18');
  assert.match(morningBrief(dir, '2026-10-19', 5), /as the person gave them, on 2026-10-18/);
});

test('the evening reports today\'s calls and the orders the dashboard sent, with what Robinhood answered then, and never guesses what came after', () => {
  const { dir } = desk();
  call(dir, 'NVDA', '2026-10-19', 'Overweight'); call(dir, 'AAPL', '2026-10-16', 'Hold');
  const now = new Date('2026-10-19T21:00:00Z');
  logOrder(dir, sent('2026-10-19T14:05:00Z', 'NVDA', true));
  logOrder(dir, sent('2026-10-19T15:00:00Z', 'AMD', null, false));
  logOrder(dir, sent('2026-10-16T14:00:00Z', 'TSLA', false));                       // another day
  fs.appendFileSync(path.join(dir, 'orders.jsonl'), 'not json\n');
  assert.equal(placedToday(dir, now), 2);
  assert.deepEqual(ordersOn(dir, now).map((o) => o.symbol), ['NVDA', 'AMD']);
  const brief = eveningBrief(dir, '2026-10-19', now);
  assert.match(brief, /^EVENING WRAP-UP for Monday 2026-10-19\./);
  assert.match(brief, /The desk's calls today \(1\): NVDA Overweight/);
  assert.match(brief, /Buy 1 NVDA at limit 182\.40, 14:05 UTC, from the Buy call of 2026-10-16: taken, waiting for the person's approval on their phone \(state then: queued\)\./);
  assert.match(brief, /Buy 1 AMD at limit 182\.40, 15:00 UTC.*: refused: Market closed\./);
  assert.ok(!brief.includes('TSLA'));
  assert.match(brief, /the team does not read Robinhood\. Say so; do not guess/);
  assert.match(brief, /Calls still waiting to be scored: 2\./);
  assert.match(eveningBrief(desk().dir, '2026-10-19', now), /made no call today[\s\S]*sent no order today/);
});

test('the routine brief is a desk tool that changes nothing but what the person\'s morning switch asks, and the morning limit is the person\'s setting, held between 1 and 20', async () => {
  const { root, dir } = desk();
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify({ routines: { maxAnalyses: 1 } }));
  for (const s of ['AAPL', 'MSFT']) { addWatch(dir, s, '2026-10-16'); setFavourite(dir, s, true); }
  process.env.TRADING_AGENTS_TODAY = '2026-10-19';
  const asked: string[] = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, chartFetch(() => series('2026-10-19', 300), asked)).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  const tool = (await client.listTools()).tools.find((t) => t.name === 'routine_brief')!;
  assert.deepEqual([tool.annotations?.readOnlyHint, tool.annotations?.openWorldHint], [false, true], 'it reads prices, and may put the top three on the waiting list');
  const text = ((await client.callTool({ name: 'routine_brief', arguments: { kind: 'morning' } })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(text, /1 of at most 1 a morning[\s\S]*1\. AAPL[\s\S]*over the limit of 1: MSFT/);
  assert.match(text, /Worth a look today, from Yahoo Finance's prices at \d\d:\d\d UTC \(figures only, never a forecast; 17 looked at\)/);
  assert.match(text, /is off: this list is for the person to read, not for you to analyse/);
  assert.ok(asked.some((u) => u.includes('/chart/XLK')), 'the same list the dashboard shows: the sectors too');
  assert.equal(readQueue(dir).length, 0, 'with the switch off, nothing goes on the waiting list');
  await client.close();
  assert.equal(readSettings('.').routines.maxAnalyses, 5);
  for (const [v, want] of [[0, 5], [50, 5], [2.5, 5], [20, 20]] as const) { fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify({ routines: { maxAnalyses: v } })); assert.equal(readSettings(root).routines.maxAnalyses, want, String(v)); }
});

test('the trading-desk team and the /routine command share one playbook for both routines', () => {
  const team = fs.readFileSync('.claude/agents/trading-desk.md', 'utf8');
  assert.match(team, /## Run a routine[\s\S]*### Morning routine[\s\S]*### Evening wrap-up/);
  assert.match(team, /mcp__trading-desk__routine_brief/);
  assert.ok(fs.readFileSync('.claude/skills/routine/SKILL.md', 'utf8').includes('Call `routine_brief` with kind `morning`'));
});
