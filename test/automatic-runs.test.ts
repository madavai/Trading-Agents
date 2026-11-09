// Audit 3, group B: the automatic runs and the waiting list. Each test replays a finding with made-up data: two copies of the
// desk's tools stand for two conversations (two runs), a pretend listener follows the playbook, and nothing starts Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { Journal } from '../src/desk/journal.js';
import { enqueue, QUIET_MS, readDoorbell, readListener, readQueue, ringDoorbell, startItem, writeListener } from '../src/desk/queue.js';
import { saveSection } from '../src/desk/runs.js';
import { morningBrief, morningList, eveningBrief } from '../src/desk/routine.js';
import { queueTop, readScreen, type Screen } from '../src/desk/screen.js';
import { saveHoldings } from '../src/desk/holdings.js';
import { rerateWeekly } from '../src/desk/care.js';
import { addWatch, setFavourite } from '../src/terminal/store.js';
import { guideOf } from '../src/terminal/guide.js';
import { teamLine } from '../src/check/desk-check.js';
import { deskServer } from '../src/tools/server.js';
import { watch } from '../src/watch/watcher.js';
import { startTerminal, type Assets, type Terminal } from '../src/terminal/server.js';
import { readPrefs, savePrefs } from '../src/terminal/prefs.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) assert.fail('timed out waiting'); await sleep(10); } };
const desk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-runs-')); fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json')); return { root, dir: path.join(root, 'desk-data') }; };
const quick = { settleMs: 80, pollMs: 15, beatMs: 60_000, graceMs: 50 };
const noRoute = async () => new Response('no route', { status: 404 });
const recordCall = (dir: string, sym: string, day: string, rating = 'Buy') => new Journal(path.join(dir, 'journal.md')).storeDecision(sym, day, `**Rating**: ${rating}\n\n**Executive Summary**: ${sym}.`);
/** A process id that has ended: a run whose conversation is over. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

/** One conversation's copy of the desk's tools: what a run (a routine, a listener's run, a chat) calls. */
async function conversation(root: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, noRoute).connect(a);
  const client = new Client({ name: 'pretend run', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { call, close: () => client.close() };
}

const DAY = '2026-11-09';   // a Monday, New York's market open

test('routines-1, server-1, server-2: a run that finds another run analysing stops without asking for another, so a listener never goes round in a loop', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const routine = await conversation(root), listener = await conversation(root);
  try {
    // 13:30: the morning routine (Madav's schedule) is analysing AAPL from the waiting list; MSFT waits behind it
    enqueue(dir, 'AAPL', '2026-11-09T13:00:00Z'); enqueue(dir, 'MSFT', '2026-11-09T13:00:01Z');
    assert.match(await routine.call('start_queue_item', { symbol: 'AAPL' }), /^START/);
    // the person presses Analyse for NVDA: the doorbell rings, and a listener that runs on every ring starts a run
    enqueue(dir, 'NVDA', '2026-11-09T13:30:00Z'); ringDoorbell(dir, 'press');
    let owed = 0;
    for (let run = 1; run <= 5; run++) {
      const bell = readDoorbell(dir)?.at;
      await sleep(5);
      const list = await listener.call('read_queue');
      assert.match(list, /AAPL/);
      await listener.call('end_queue_run');   // the playbook: once, at the end, however the run stopped
      if (readDoorbell(dir)?.at === bell) break;
      owed++;   // a ring during the run: one more run is owed, and it finds the same thing
    }
    assert.equal(owed, 0, 'the listener\'s run asked for no other run while AAPL is another run\'s');
    const list = await listener.call('read_queue');
    assert.match(list, /^Being analysed now by another run: AAPL \(started \d\d:\d\d UTC\)\. One stock runs at a time: stop this run and say so\. Do not call end_queue_run: the run analysing AAPL asks for the next run itself when it finishes\./);
    assert.match(await listener.call('end_queue_run'), /^AAPL is being analysed by another run, which asks for the next run itself when it finishes: no run was asked for here\. 2 still waiting\./);
    assert.match(await listener.call('start_queue_item', { symbol: 'MSFT' }), /^BUSY: AAPL is being analysed now by another run: one stock runs at a time/);
    // the routine's own run finishes AAPL and ends: then, and only then, the next run is asked for
    recordCall(dir, 'AAPL', DAY);
    assert.match(await routine.call('finish_queue_item', { symbol: 'AAPL' }), /^Marked done: AAPL, Buy/);
    const before = readDoorbell(dir)?.at;
    await sleep(5);
    assert.match(await routine.call('end_queue_run'), /^2 still waiting: another run was asked for\./);
    assert.notEqual(readDoorbell(dir)?.at, before);
  } finally { await routine.close(); await listener.close(); }
});

test('routines-1, server-2: the desk\'s own listener starts no run while another run analyses a stock, and starts one as soon as the list is free', async (t) => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const routine = await conversation(root);
  t.after(() => routine.close());
  enqueue(dir, 'AAPL', '2026-11-09T13:00:00Z');
  assert.match(await routine.call('start_queue_item', { symbol: 'AAPL' }), /^START/);
  let runs = 0;
  const w = watch({ dir, listener: 'Claude Code', pid: 701, ...quick, run: async () => { runs++; } });
  t.after(() => w.stop());
  enqueue(dir, 'NVDA', '2026-11-09T13:30:00Z'); ringDoorbell(dir, 'press');
  await sleep(400);
  assert.equal(runs, 0, 'no run while AAPL is another run\'s: it would only stop at once');
  recordCall(dir, 'AAPL', DAY);
  await routine.call('finish_queue_item', { symbol: 'AAPL' });
  await until(() => runs === 1);
  w.stop(); await w.done;
});

test('routines-2, server-3: with two runners, a stock is never marked failed while its own run analyses it, and two runs never take the same stock', async (t) => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const routine = await conversation(root), chat = await conversation(root);
  t.after(async () => { await routine.close(); await chat.close(); });
  enqueue(dir, 'AAPL', '2026-11-09T13:00:00Z');
  assert.match(await routine.call('start_queue_item', { symbol: 'AAPL' }), /^START/);
  assert.match(await chat.call('start_queue_item', { symbol: 'AAPL' }), /^BUSY: AAPL is being analysed now by another run/, 'a second run never takes the same stock');
  assert.match(await routine.call('start_queue_item', { symbol: 'AAPL' }), /^START/, 'the same run asking again is answered as before');
  recordCall(dir, 'AAPL', DAY); await routine.call('finish_queue_item', { symbol: 'AAPL' });

  // the desk's own listener runs while the morning routine starts MSFT: at the end of the listener's run, MSFT is left alone
  enqueue(dir, 'MSFT', '2026-11-09T14:00:00Z'); enqueue(dir, 'NVDA', '2026-11-09T14:00:01Z');
  const w = watch({ dir, listener: 'Claude Code', pid: 702, ...quick, run: async () => { await routine.call('start_queue_item', { symbol: 'MSFT' }); } });
  t.after(() => w.stop());
  await until(() => !!readListener(dir)?.lastRun);
  const msft = readQueue(dir).find((i) => i.symbol === 'MSFT')!;
  assert.equal(msft.state, 'running', `the routine is still analysing MSFT: ${msft.reason ?? ''}`);
  assert.equal(readListener(dir)!.lastRun!.result, '0 analysed, 0 failed', 'the listener counts only its own run');
  w.stop(); await w.done;
  // any listener's note that its run ended (Madav's, with an end time) leaves alone a stock another live run started in it
  writeListener(dir, { listener: 'Madav', since: '2026-11-09T13:00:00Z', beat: new Date().toISOString(), lastRun: { started: new Date(Date.now() - 60_000).toISOString(), at: new Date(Date.now() + 1000).toISOString(), result: '0 analysed' } });
  assert.equal(readQueue(dir).find((i) => i.symbol === 'MSFT')!.state, 'running');
  recordCall(dir, 'MSFT', DAY, 'Hold');
  assert.match(await routine.call('finish_queue_item', { symbol: 'MSFT' }), /^Marked done: MSFT, Hold/, 'its call reaches the list');
  // a stock whose run has ended (its process is gone) and that the note's run left running still reads as failed at once
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')) as Array<Record<string, unknown>>;
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(list.map((i) => (i.symbol === 'NVDA' ? { ...i, state: 'running', date: DAY, startedAt, runner: 'gone-run', pid: deadPid() } : i))));
  const nvda = readQueue(dir).find((i) => i.symbol === 'NVDA')!;
  assert.deepEqual([nvda.state, nvda.reason], ['failed', "Madav's run ended before this stock was finished: 0 analysed"]);
});

test('routines-3, scoring-7: while a backtest runs, the live desk\'s own work stays live, and nothing a routine does ends the backtest', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  configure({ fetch: noRoute, secEmail: '' });
  const sweep = await conversation(root), live = await conversation(root);
  try {
    await sweep.call('set_contact_email', { email: 'jane@mail.com' });
    assert.match(await sweep.call('start_backtest', { symbols: ['NVDA'], start_date: '2026-08-31', end_date: '2026-09-07', sweep_id: 'june' }), /^Backtest sweep june: 2 cell/);
    // a cell of the sweep, from any copy of the tools (a member with its own connection), goes to the sweep
    assert.match(await live.call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-08-31', analysts: ['market'] }), /^\[Backtest sweep june:/);
    await live.call('save_run_section', { symbol: 'NVDA', analysis_date: '2026-08-31', section: 'decision', text: '**Rating**: Buy\n\nAdd.' });
    await live.call('record_decision', { symbol: 'NVDA', analysis_date: '2026-08-31' });
    // the live desk's own analysis of today, during the sweep, is recorded with the person's calls
    const plan = await live.call('plan_analysis', { symbol: 'AAPL', analysis_date: '2026-10-12', analysts: ['market'] });
    assert.doesNotMatch(plan, /Backtest sweep/, 'a live analysis is never the sweep\'s');
    await live.call('save_run_section', { symbol: 'AAPL', analysis_date: '2026-10-12', section: 'decision', text: '**Rating**: Hold\n\nWait.' });
    await live.call('record_decision', { symbol: 'AAPL', analysis_date: '2026-10-12' });
    assert.deepEqual(new Journal(path.join(dir, 'journal.md')).load().map((e) => e.ticker), ['AAPL'], 'the live call is in the live journal');
    assert.deepEqual(new Journal(path.join(dir, 'backtest', 'june', 'journal.md')).load().map((e) => e.ticker), ['NVDA'], 'and only the sweep\'s cell is in the sweep\'s');
    // the routine's scoring reads the live journal; the backtest's names its sweep
    assert.doesNotMatch(await live.call('list_settlements'), /NVDA/);
    assert.match(await sweep.call('list_settlements', { sweep_id: 'june' }), /NVDA/);
    // the waiting list runs beside a backtest, and asking it never keeps an abandoned sweep alive
    const active = path.join(dir, 'backtest', 'active.json'), was = Date.now() - 110 * 60_000;
    fs.writeFileSync(active, JSON.stringify({ sweep: 'june', at: was }));
    enqueue(dir, 'MSFT', '2026-10-12T10:00:00Z');
    assert.match(await live.call('start_queue_item', { symbol: 'MSFT' }), /^START/);
    await live.call('read_queue'); await live.call('end_queue_run'); await live.call('plan_analysis', { symbol: 'MSFT', analysis_date: '2026-10-12' });
    assert.equal((JSON.parse(fs.readFileSync(active, 'utf8')) as { at: number }).at, was, 'only the sweep\'s own cells keep it alive');
    // the playbook no longer tells a routine or a chat to end a backtest it did not start
    assert.doesNotMatch(fs.readFileSync('.claude/skills/analyse/SKILL.md', 'utf8'), /call `end_backtest`/);
    // and the desk itself keeps it running: ending one names its sweep, which only the conversation that started it is given
    assert.match(await live.call('end_backtest').catch((e: unknown) => String(e)), /sweep_id/);
    assert.match(await live.call('end_backtest', { sweep_id: 'july' }), /^NOT ENDED: the backtest running is not july/);
    assert.equal((JSON.parse(fs.readFileSync(active, 'utf8')) as { sweep: string }).sweep, 'june', 'still running');
    assert.match(await sweep.call('end_backtest', { sweep_id: 'june' }), /^Backtest sweep june ended\./);
  } finally { await sweep.close(); await live.close(); }
});

test('server-4: the depth chosen on the dashboard decides the rounds when a stopped run is resumed', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const run = await conversation(root);
  try {
    await run.call('set_contact_email', { email: 'jane@mail.com' });
    enqueue(dir, 'NVDA', '2026-11-09T13:00:00Z', 'deep');
    assert.match(await run.call('start_queue_item', { symbol: 'NVDA' }), /depth deep/);
    assert.match(await run.call('plan_analysis', { symbol: 'NVDA', analysis_date: DAY, debate_rounds: 5, risk_rounds: 5 }), /Debate rounds: 5/);
    await run.call('save_run_section', { symbol: 'NVDA', analysis_date: DAY, section: 'market', text: 'Market report' });
    await run.call('finish_queue_item', { symbol: 'NVDA', failed_because: "the model's usage limit was reached" });
    // later the same day the person asks again, at Shallow, to spend less
    enqueue(dir, 'NVDA', '2026-11-09T15:00:00Z', 'shallow');
    assert.match(await run.call('start_queue_item', { symbol: 'NVDA' }), /depth shallow \(debate_rounds 1 and risk_rounds 1\)/);
    const plan = await run.call('plan_analysis', { symbol: 'NVDA', analysis_date: DAY, debate_rounds: 1, risk_rounds: 1 });
    assert.match(plan, /Debate rounds: 1 \(bull and bear each speak 1 time\(s\)\); risk rounds: 1/, plan);
    assert.match(plan, /Steps \(resuming\): \[done\] market -> /);
    assert.match(plan, /Note: NVDA was asked for again on the dashboard at shallow depth, so the run resumes with 1 debate and 1 risk round\(s\), not the 5 and 5 it started with\./);
  } finally { await run.close(); }
});

test('server-7: a stock whose call was recorded, though its run stopped before finishing it on the list, shows done with that call', async (t) => {
  const { dir } = desk();
  enqueue(dir, 'NVDA', '2026-11-09T13:00:00Z');
  startItem(dir, 'NVDA', DAY, new Date('2026-11-09T13:00:00Z'));
  recordCall(dir, 'NVDA', DAY, 'Overweight');
  const late = readQueue(dir, new Date(Date.parse('2026-11-09T13:00:00Z') + QUIET_MS + 60_000))[0]!;
  assert.deepEqual([late.state, late.rating], ['done', 'Overweight'], 'not "failed: nothing was saved" for a call that is in the journal');
  // the desk's own listener: its run recorded the call and stopped before finish_queue_item
  const other = desk().dir;
  enqueue(other, 'AAPL', '2026-11-09T13:00:00Z');
  const w = watch({ dir: other, listener: 'Claude Code', pid: 703, ...quick, run: async () => { startItem(other, 'AAPL', DAY); recordCall(other, 'AAPL', DAY, 'Hold'); return "Claude Code's usage limit was reached"; } });
  t.after(() => w.stop());
  await until(() => !!readListener(other)?.lastRun);
  const aapl = readQueue(other)[0]!;
  assert.deepEqual([aapl.state, aapl.rating], ['done', 'Hold']);
  w.stop(); await w.done;
});

test('routines-4: starred stocks over the morning\'s limit take turns, oldest call first, so every one is analysed', () => {
  const { dir } = desk();
  const starred = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA'];
  for (const s of starred) { addWatch(dir, s, '2026-11-02'); setFavourite(dir, s, true); }
  const seen = new Set<string>();
  for (const day of ['2026-11-09', '2026-11-10', '2026-11-11']) {
    const m = morningList(dir, day, 5);
    for (const a of m.analyse) { seen.add(a.symbol); recordCall(dir, a.symbol, day); }
  }
  assert.deepEqual(starred.filter((s) => !seen.has(s)), [], 'none starved');
  const brief = morningBrief(dir, '2026-11-12', 5);
  assert.match(brief, /Left for another morning, over the limit of 5: [A-Z, ]+\. Starred stocks take turns: the ones whose latest call is oldest go first\./);
});

test('routines-5: a morning that starts while another run analyses leaves the waiting list to that run and analyses the starred stocks', () => {
  const { dir } = desk();
  addWatch(dir, 'NVDA', '2026-11-02'); setFavourite(dir, 'NVDA', true);
  enqueue(dir, 'AAPL', '2026-11-09T12:00:00Z'); enqueue(dir, 'MSFT', '2026-11-09T12:00:01Z');
  startItem(dir, 'AAPL', DAY, new Date(), { runner: 'listener-run', pid: process.pid });
  const brief = morningBrief(dir, DAY, 5);
  assert.match(brief, /AAPL is being analysed now by another run: leave it alone\. Waiting on the dashboard, left to that run \(one stock runs at a time\): MSFT\. Do not start them from this routine\./);
  assert.match(brief, /2\. Analyse, one after another, in this order \(1 of at most 5 a morning\), each by the \/analyse playbook with today's date:\n {3}1\. NVDA \(a starred watchlist stock\)\n/);
  assert.doesNotMatch(brief, /end_queue_run/);
});

test('routines-6: a request already called today is marked done by the morning brief, never left waiting to be analysed again', () => {
  const { dir } = desk();
  enqueue(dir, 'NVDA', '2026-11-09T12:00:00Z', 'medium');
  recordCall(dir, 'NVDA', DAY, 'Hold');   // the person ran /analyse NVDA in a chat
  const brief = morningBrief(dir, DAY, 5);
  assert.match(brief, /Already called today, so not analysed again: NVDA \(it was waiting on the dashboard: marked done there, with that call's rating\)\./);
  const nvda = readQueue(dir)[0]!;
  assert.deepEqual([nvda.state, nvda.rating, nvda.already], ['done', 'Hold', true]);
  assert.deepEqual(morningList(dir, '2026-11-10', 5).analyse, [], 'the next morning does not analyse it again');
});

test('routines-7: the brief says "analysed in step 2" only of the re-rated holdings and the switch\'s picks that step 2 lists', () => {
  const { dir } = desk();
  saveHoldings(dir, { positions: [{ ticker: 'KO', quantity: 5 }, { ticker: 'PEP', quantity: 5 }] }, DAY);
  enqueue(dir, 'AAPL', '2026-11-09T11:00:00Z'); enqueue(dir, 'MSFT', '2026-11-09T11:00:01Z');
  rerateWeekly(dir, DAY);
  const brief = morningBrief(dir, DAY, 2);
  assert.doesNotMatch(brief, /They are analysed in step 2/, brief);
  assert.match(brief, /KO \(the desk has no view of it yet\), PEP \(the desk has no view of it yet\) were put on the waiting list at shallow depth, for a view under 7 days old \(at most 3 a week\)\. Over today's limit of 2, so they wait on the dashboard: KO, PEP\./);
  // the switch's picks, already analysed by the listener before the routine
  const other = desk().dir;
  for (const s of ['TSLA', 'AMD']) recordCall(other, s, DAY);
  const screen: Screen = { day: DAY, at: '2026-11-09T12:00:00Z', looked: 18, unavailable: [], picks: [], queued: { day: DAY, symbols: ['TSLA', 'AMD'] } };
  const look = morningBrief(other, DAY, 5, { screen, on: true });
  assert.doesNotMatch(look, /are analysed in step 2/);
  assert.match(look, /TSLA, AMD were put on the waiting list at shallow depth; already called today, so not analysed again: TSLA, AMD/);
});

test('routines-9: the chat\'s Robinhood test is given the five minutes the sign-in may take', () => {
  const skill = fs.readFileSync('.claude/skills/desk-check/SKILL.md', 'utf8');
  assert.match(skill, /run `node dist\/robinhood\.mjs connect` in this folder with a time limit of at least six minutes/);
});

test('routines-10: the desk check never says this conversation\'s steps are the folder\'s; changes made in Agent Studio cannot be told', () => {
  const line = teamLine('007e5dc9', '007e5dc9', false, ['007e5dc9']);
  assert.doesNotMatch(line.text, /are the ones in this folder/);
  assert.equal(line.text, "This conversation began with the team's steps of version 007e5dc9, the version in this folder. A change made to the team in Madav's Agent Studio cannot be told from here: it keeps that version. If the team was changed there, ask the desk to reset the team to go back to the project's steps");
});

test('routines-11: the routines\' times are this computer\'s clock, and the brief names New York\'s day when the computer\'s is another', () => {
  const routines = JSON.parse(fs.readFileSync('.claude/routines.json', 'utf8')) as { routines: Array<{ name: string; description: string }> };
  for (const r of routines.routines.filter((x) => x.name !== 'analyse-when-asked')) assert.match(r.description, /this computer's clock/, r.name);
  const { dir } = desk();
  // 8:00 on a Monday in Dubai is still Sunday evening in New York
  const brief = morningBrief(dir, '2026-11-08', 5, undefined, { now: new Date('2026-11-09T04:00:00Z'), zone: 'Asia/Dubai' });
  assert.match(brief, /^MORNING ROUTINE for Sunday 2026-11-08\.\nThe desk's day is New York's: there it is Sunday 2026-11-08, 23:00, while on this computer it is already Monday 2026-11-09\./);
  const evening = eveningBrief(dir, DAY, new Date('2026-11-09T06:00:00Z'));   // 17:00 in Sydney
  assert.match(evening, /New York's market has not closed yet today: it is 01:00 there\./);
});

test('server-10: a screen whose names could not be read does not use up the morning switch\'s day', () => {
  const { dir } = desk();
  const morning = new Date('2026-11-09T13:00:00Z');   // 8:00 in New York
  const blank: Screen = { day: DAY, at: morning.toISOString(), looked: 18, unavailable: ['SPY', 'QQQ', 'DIA', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC'], picks: [] };
  assert.deepEqual(queueTop(dir, blank, DAY, false, morning), []);
  assert.equal(readScreen(dir)?.queued, undefined, 'the day is not marked: the next look tries again');
  const read: Screen = { day: DAY, at: '2026-11-09T14:00:00Z', looked: 18, unavailable: [], picks: [{ symbol: 'TSLA', signals: [{ kind: 'move', words: 'fell 5.0%' }], movePct: -5, why: 'Fell 5.0%', session: '2026-11-06' }] };
  assert.deepEqual(queueTop(dir, read, DAY, false, new Date('2026-11-09T14:00:00Z')), ['TSLA']);
});

test('server-9: "Run automatically with Claude Code" is said to run only while something listens', () => {
  const record = { since: null, weeks: 0, calls: 0 } as unknown as Parameters<typeof guideOf>[0]['record'];
  const g = guideOf({ email: '', watchlist: [], market: [], queue: [{ symbol: 'NVDA' }], calls: [], listener: null, autorun: true, readCall: false, record });
  assert.equal(g.analyse.automatic, '', 'switched on, but nothing listens now');
});

/** The dashboard, started with no page open: it answers only the requests a test makes. */
const PAGE: Assets = new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]);
const dashboard = (root: string, more: Partial<Parameters<typeof startTerminal>[0]> = {}): Promise<Terminal> =>
  startTerminal({ root, assets: PAGE, port: 0, keyFile: path.join(root, 'private', 'dashboard.json'), ...more });
const ask = (t: Terminal, method: string, p: string, body?: unknown): Promise<{ status: number; json: () => any }> => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: t.port, path: p, method, headers: { host: `127.0.0.1:${t.port}`, 'x-desk-token': t.token, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(b) }));
  });
  req.on('error', reject); if (payload) req.write(payload); req.end();
});

test('server-6: with the morning switch on, the dashboard puts the top picks on the waiting list itself on a market morning, with no page open', async (t) => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const morning = new Date('2026-11-09T13:00:00Z');   // 8:00 in New York, a Monday
  savePrefs(dir, { morning: true, morningFrom: DAY });
  fs.mkdirSync(dir, { recursive: true });
  const screen: Screen = { day: DAY, at: morning.toISOString(), looked: 18, unavailable: [], picks: ['TSLA', 'AMD'].map((symbol) => ({ symbol, signals: [{ kind: 'move', words: 'fell 5.0%' }], movePct: -5, why: 'Fell 5.0%', session: '2026-11-06' })) } as Screen;
  fs.writeFileSync(path.join(dir, 'screen.json'), JSON.stringify(screen));   // worked out this hour, so no price is fetched
  const term = await dashboard(root, { keepMs: 20, now: () => morning });
  t.after(() => term.close());
  await until(() => readQueue(dir).length === 2);
  assert.deepEqual(readQueue(dir).map((q) => [q.symbol, q.state, q.depth]), [['TSLA', 'waiting', 'shallow'], ['AMD', 'waiting', 'shallow']]);
  assert.equal(readDoorbell(dir)?.why, 'press', 'it rings for whoever listens');
  assert.deepEqual(readScreen(dir)?.queued, { day: DAY, symbols: ['TSLA', 'AMD'] }, 'once that day');
});

test('server-9: with "Run automatically with Claude Code" left on, the dashboard starts its listener again once nothing has listened for a while', async (t) => {
  const { root, dir } = desk();
  savePrefs(dir, { autorun: true });
  let started = 0;
  const term = await dashboard(root, { keepMs: 15, listen: { start: () => { started++; }, claude: () => true } });
  t.after(() => term.close());
  assert.equal(started, 1, 'started with the dashboard');
  await until(() => started === 2);   // its listener never wrote that it listens: started again after five looks
  const now = new Date().toISOString();
  writeListener(dir, { listener: 'Madav', since: now, beat: now });
  let was = started; await sleep(250);
  assert.equal(started, was, 'someone listens: nothing is started beside it');
  savePrefs(dir, { autorun: false }); fs.rmSync(path.join(dir, 'listener.json'), { force: true });
  was = started; await sleep(250);
  assert.equal(started, was, 'switched off: never started');
  assert.equal(readPrefs(dir).autorun, false);
});

test("server-11: an analysis asked for with no depth runs the settings' own rounds, never a depth rounded from them", async (t) => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'desk-settings.json'), 'utf8'));
  settings.analysis.debateRounds = 2; settings.analysis.riskRounds = 3;
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify(settings));
  const term = await dashboard(root);
  t.after(() => term.close());
  assert.deepEqual((await ask(term, 'GET', '/api/state')).json().analyses.rounds, { debate: 2, risk: 3 }, "the page is told the settings' rounds");
  const queue = (await ask(term, 'POST', '/api/queue', { symbol: 'NVDA' })).json().queue;
  assert.deepEqual(queue.map((q: any) => [q.symbol, q.depth]), [['NVDA', undefined]]);
  const run = await conversation(root);
  t.after(() => run.close());
  assert.match(await run.call('start_queue_item', { symbol: 'NVDA' }), /depth the settings' depth \(leave the rounds out\)/);
  await run.call('set_contact_email', { email: 'jane@mail.com' });
  assert.match(await run.call('plan_analysis', { symbol: 'NVDA', analysis_date: DAY }), /Debate rounds: 2 \(bull and bear each speak 2 time\(s\)\); risk rounds: 3/);
  assert.equal(readQueue(dir)[0]!.state, 'running');
});
