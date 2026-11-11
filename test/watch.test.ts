import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { Journal } from '../src/desk/journal.js';
import { enqueue, finishItem, QUIET_MS, QUIET_REASON, readListener, readQueue, ringDoorbell, startItem, writeListener } from '../src/desk/queue.js';
import { saveSection, startRun, writeReport } from '../src/desk/runs.js';
import { deskServer } from '../src/tools/server.js';
import { startTerminal, type Assets } from '../src/terminal/server.js';
import { findClaude, RUN_ARGS, RUN_WORDS, runClaude, stopReason } from '../src/watch/claude.js';
import { AlreadyListening, STOCK_MAX_MS, stopWhy, watch } from '../src/watch/watcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) assert.fail('timed out waiting'); await sleep(10); } };
const desk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-watch-')); fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json')); return { root, dir: path.join(root, 'desk-data') }; };
const quick = { settleMs: 120, pollMs: 15, beatMs: 60_000 };

test('Claude Code is found without a shell: its own program, or the one behind npm\'s claude.cmd on Windows; nothing when it is not installed', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  const npm = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  assert.deepEqual(findClaude({ PATH: `C:\\Windows;${npm}`, USERPROFILE: 'C:\\Users\\a' }, 'win32', has(`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`)), { command: `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, args: [] });
  assert.deepEqual(findClaude({ PATH: npm, USERPROFILE: 'C:\\Users\\a' }, 'win32', has(`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`)), { command: process.execPath, args: [`${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`] });
  assert.deepEqual(findClaude({ PATH: 'C:\\Tools', USERPROFILE: 'C:\\Users\\a' }, 'win32', has('C:\\Users\\a\\.local\\bin\\claude.exe')), { command: 'C:\\Users\\a\\.local\\bin\\claude.exe', args: [] }, "its own installer's folder");
  assert.equal(findClaude({ PATH: npm, USERPROFILE: 'C:\\Users\\a' }, 'win32', has(`${npm}\\claude.cmd`)), null, 'a claude.cmd alone is never run: it would need a shell');
  assert.deepEqual(findClaude({ PATH: '/usr/bin:/opt/c', HOME: '/home/a' }, 'linux', has('/opt/c/claude')), { command: '/opt/c/claude', args: [] });
  assert.equal(findClaude({ PATH: '/usr/bin', HOME: '/home/a' }, 'darwin', has()), null);
});

test('the run is fixed in code: the trading-desk team, the waiting list, refusing what is not allowed, never with permission checks bypassed', async () => {
  assert.deepEqual(RUN_ARGS.slice(0, 4), ['--agent', 'trading-desk', '--permission-mode', 'dontAsk']);
  assert.equal(RUN_ARGS.at(-1), RUN_WORDS);
  assert.doesNotMatch(RUN_ARGS.join(' '), /bypass|dangerous|Bash|PowerShell|Write|Edit/i);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-claude-')), script = path.join(cwd, 'fake.js');
  fs.writeFileSync(script, "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(Number(process.argv.includes('--fail')))");
  let out = '';
  assert.deepEqual(await runClaude({ command: process.execPath, args: [script] }, cwd, (t) => { out += t; }), { code: 0 });
  const seen = JSON.parse(out) as { args: string[]; cwd: string };
  assert.deepEqual(seen.args, [...RUN_ARGS]);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd), 'run in the project folder');
  assert.equal((await runClaude({ command: process.execPath, args: [script] }, cwd, () => {}, { stopIf: () => null, everyMs: 20 }, ['--fail'])).code, 1, 'a check that finds nothing wrong stops nothing');
  fs.writeFileSync(script, 'setTimeout(() => {}, 60_000)');
  let asked = 0;
  const stuck = () => (++asked >= 3 ? 'nothing was saved for two hours' : null);
  assert.deepEqual(await runClaude({ command: process.execPath, args: [script] }, cwd, () => {}, { stopIf: stuck, everyMs: 30 }), { code: null, stopped: 'nothing was saved for two hours' }, 'a run that hangs is stopped, with why');
  assert.equal((await runClaude({ command: path.join(cwd, 'no-such-program'), args: [] }, cwd, (t) => { out = t; })).code, null);
  assert.match(out, /Claude Code could not be started/);
});

test('the listener: several presses make one run, a ring during a run owes one more, nothing waiting costs nothing, and off ends it after the run in hand', async (t) => {
  const { dir } = desk();
  // A pretend run, held open until the test lets it finish: like the team, it works through the list it read at its start.
  let runs = 0, holding: (() => void) | null = null;
  const run = () => new Promise<void>((resolve) => {
    runs++;
    const list = readQueue(dir).filter((i) => i.state === 'waiting').map((i) => i.symbol);
    holding = () => { for (const s of list) { startItem(dir, s, '2026-10-12'); finishItem(dir, s, { rating: 'Hold' }); } resolve(); };
  });
  const w = watch({ dir, listener: 'Claude Code', run, pid: 101, ...quick });
  t.after(() => { try { holding?.(); } catch { /* that run already finished */ } w.stop(); });
  assert.equal(readListener(dir)?.listener, 'Claude Code', 'it says that it listens');
  assert.throws(() => watch({ dir, listener: 'Claude Code', run, pid: 102, ...quick }), AlreadyListening, 'never two listeners');
  ringDoorbell(dir, 'press');   // nothing is waiting yet
  await sleep(250);
  assert.equal(runs, 0, 'a ring with nothing waiting starts no run');
  enqueue(dir, 'NVDA', '2026-10-12T10:00:00Z', 'medium'); ringDoorbell(dir, 'press');
  await sleep(40);
  enqueue(dir, 'AAPL', '2026-10-12T10:00:01Z'); ringDoorbell(dir, 'press');
  await until(() => runs === 1);
  await sleep(200);
  assert.equal(runs, 1, 'two presses close together: one run');
  enqueue(dir, 'TSLA', '2026-10-12T10:01:00Z'); ringDoorbell(dir, 'press');
  enqueue(dir, 'AMD', '2026-10-12T10:01:01Z'); ringDoorbell(dir, 'press');
  await sleep(250);
  assert.equal(runs, 1, 'never two runs at once');
  holding!();
  await until(() => runs === 2);
  assert.match(readListener(dir)?.lastRun?.result ?? '', /^2 analysed, 0 failed$/, 'its note says what the run did');
  holding!();
  await until(() => readListener(dir)?.lastRun?.result === '2 analysed, 0 failed' && readQueue(dir).every((i) => i.state === 'done'));
  await sleep(250);
  assert.equal(runs, 2, 'the two asked for during the first run got one more run, not two');
  enqueue(dir, 'MSFT', '2026-10-12T10:02:00Z'); ringDoorbell(dir, 'press');
  await until(() => runs === 3);
  writeListener(dir, { ...readListener(dir)!, pid: 999 });   // switched off and on elsewhere: the note is no longer its own
  await sleep(100);
  let ended = '';
  void w.done.then((why) => { ended = why; });
  await sleep(100);
  assert.equal(ended, '', 'it waits for the run in hand');
  holding!();
  assert.equal(await w.done, 'off');
  assert.equal(readListener(dir)?.pid, 999, 'it leaves a note that is not its own');
});

test("why Claude Code stopped, in plain words: its usage limit and when it resets, a sign-in, no credit, a busy service", () => {
  assert.equal(stopReason("Working...\nYou've hit your weekly limit · resets 6am (America/Chicago)\n"), "Claude Code's weekly usage limit was reached; it resets 6am (America/Chicago). Press Retry after that.", 'the words of the first real run');
  assert.equal(stopReason('5-hour limit reached ∙ resets 3am'), "Claude Code's 5-hour usage limit was reached; it resets 3am. Press Retry after that.");
  assert.equal(stopReason("You've hit your limit · resets Oct 24, 9am"), "Claude Code's usage limit was reached; it resets Oct 24, 9am. Press Retry after that.");
  assert.match(stopReason('Claude AI usage limit reached|1792047600')!, /^Claude Code's usage limit was reached; it resets [A-Z][a-z]{2} \d{1,2}, .+\. Press Retry after that\.$/, 'the older words, with the time as a number');
  assert.match(stopReason('Invalid API key · Please run /login')!, /not signed in/);
  assert.match(stopReason('Credit balance is too low')!, /no credit left/);
  assert.match(stopReason('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')!, /too busy/);
  assert.equal(stopReason('API Error: 500 Internal server error'), "Claude's service had a fault on its own side and could not answer: press Retry in a while.");
  assert.equal(stopReason('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'), "Claude's service turned the run away for asking too often: press Retry in a few minutes.");
  assert.equal(stopReason('API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}'), "Claude's service refused the run's request: press Retry in a while.");
  for (const code of ['400', '429', '500', '503']) assert.doesNotMatch(stopReason(`API Error: ${code} x`)!, /\d{3}|API|HTTP/, 'never a web code on the page');
  assert.equal(stopReason('Analysed NVDA: Hold.'), null, 'nothing known: the listener says so in its own words');
  assert.doesNotMatch(stopReason("You've hit your limit · resets <b>6am</b>")!, /[<>]/, 'nothing but words reaches the page');
});

test('a run that stops half way leaves no stock "running": the listener marks it failed, and a run that died long ago reads as failed everywhere', async (t) => {
  const { dir } = desk();
  enqueue(dir, 'NVDA', '2026-10-12T10:00:00Z');
  t.after(() => w.stop());
  const limit = "Claude Code's weekly usage limit was reached; it resets 6am (America/Chicago). Press Retry after that.";
  const w = watch({ dir, listener: 'Claude Code', pid: 201, ...quick, run: async () => { startItem(dir, 'NVDA', '2026-10-12'); return limit; } });
  await until(() => readQueue(dir)[0]?.state === 'failed');
  assert.equal(readQueue(dir)[0]!.reason, limit, 'the person reads why it stopped beside the stock');
  await until(() => !!readListener(dir)?.lastRun);
  assert.equal(readListener(dir)?.lastRun?.result, `0 analysed, 1 failed; ${limit}`);
  assert.ok(readListener(dir)?.lastRun?.started, 'its note says when the run started');
  w.stop();
  assert.equal(await w.done, 'stopped');
  assert.equal(readListener(dir), null, 'its note goes with it');

  enqueue(dir, 'NVDA', '2026-10-12T11:00:00Z');   // a run that ends without a word still leaves no stock running
  const w2 = watch({ dir, listener: 'Claude Code', pid: 202, ...quick, run: async () => { startItem(dir, 'NVDA', '2026-10-12'); } });
  t.after(() => w2.stop());
  await until(() => readQueue(dir)[0]?.state === 'failed');
  assert.match(readQueue(dir)[0]!.reason!, /the run stopped before this stock was finished: press Retry/);
  w2.stop(); await w2.done;

  enqueue(dir, 'AAPL', '2026-10-12T10:00:00Z');
  startItem(dir, 'AAPL', '2026-10-12', new Date('2026-10-12T10:00:00Z'));   // a run that died without a word, and saved nothing
  assert.equal(readQueue(dir, new Date(Date.parse('2026-10-12T10:00:00Z') + QUIET_MS - 1000)).find((i) => i.symbol === 'AAPL')?.state, 'running');
  const late = readQueue(dir, new Date(Date.parse('2026-10-12T10:00:00Z') + QUIET_MS + 1000)).find((i) => i.symbol === 'AAPL');
  assert.deepEqual([late?.state, late?.reason, late?.quiet, late?.endedAt], ['failed', QUIET_REASON, true, new Date(Date.parse('2026-10-12T10:00:00Z') + QUIET_MS).toISOString()], 'the same everywhere: failed once nothing was saved for two hours, dated when that was so');
  assert.match(QUIET_REASON, /^nothing was saved for this analysis for two hours, so its run has most likely stopped: press Retry\. If it was still going, it shows done once its call is recorded$/);
});

// Round 1's medium NVDA run (6 Nov 2026, in Madav): started 23:48:12 UTC, its analysts and first debate turns saved by
// 00:23, its call recorded 02:35, 2 h 47 min in all. The old rule read it as failed from 01:48 on.
const R1 = '2026-11-06', at = (hhmm: string) => new Date(`${hhmm < '12:00' ? '2026-11-07' : R1}T${hhmm}:00Z`);
/** Saves a step of the made-up run at the time it was written. */
const step = (dir: string, section: Parameters<typeof saveSection>[3], hhmm: string) => {
  saveSection(dir, 'NVDA', R1, section, `${section} for NVDA.`);
  const file = path.join(dir, 'runs', `NVDA_${R1}`, 'run.json');
  fs.utimesSync(file, at(hhmm), at(hhmm));
};
const medium: Array<[Parameters<typeof saveSection>[3], string]> = [
  ['market', '00:05'], ['sentiment', '00:07'], ['news', '00:09'], ['fundamentals', '00:12'], ['fact_check', '00:18'], ['bull', '00:21'], ['bear', '00:23'],
  ['bull', '00:36'], ['bear', '00:48'], ['bull', '01:01'], ['bear', '01:13'], ['research_plan', '01:24'], ['trader', '01:33'],
  ['aggressive', '01:41'], ['conservative', '01:48'], ['neutral', '01:55'], ['aggressive', '02:01'], ['conservative', '02:07'], ['neutral', '02:12'],
  ['aggressive', '02:17'], ['conservative', '02:22'], ['neutral', '02:27'], ['decision', '02:30']];

test('a long analysis that keeps saving its steps is never marked failed: a made-up run of 2 h 47 min stays running, then finishes', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = R1;
  configure({ fetch: async () => new Response('no route', { status: 404 }), secEmail: '' });
  enqueue(dir, 'NVDA', '2026-11-06T23:47:00Z', 'medium');
  startItem(dir, 'NVDA', R1, new Date('2026-11-06T23:48:12Z'));
  startRun(dir, 'NVDA', R1, { steps: [] }); fs.utimesSync(path.join(dir, 'runs', `NVDA_${R1}`, 'run.json'), at('23:48'), at('23:48'));
  const start = '2026-11-06T23:48:12.000Z', began = Date.parse(start);
  let pastTwoHours = 0;
  for (const [section, hhmm] of medium) {
    step(dir, section, hhmm);
    for (const now of [new Date(at(hhmm).getTime() + 60_000), new Date(at(hhmm).getTime() + 5 * 60_000)]) {
      const nvda = readQueue(dir, now)[0]!;
      assert.equal(nvda.state, 'running', `still being analysed at ${now.toISOString()} (${section} saved ${hhmm})`);
      assert.equal(stopWhy(dir, start, now), null, `the desk's listener lets it go on at ${now.toISOString()}`);
      if (now.getTime() - began > 2 * 60 * 60_000) pastTwoHours++;
    }
  }
  assert.equal(pastTwoHours, 18, 'nine of its steps were saved more than two hours after it started, when the old rule read it as failed');
  // its call is recorded at 02:35, and its own run finishes it, through the desk's tools, as the team does
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, async () => new Response('no route', { status: 404 })).connect(a);
  const client = new Client({ name: 'pretend team', version: '0' });
  await client.connect(b);
  try {
    new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', R1, '**Rating**: Overweight\n\n**Executive Summary**: NVDA.');
    writeReport(dir, 'NVDA', R1, []);
    const said = ((await client.callTool({ name: 'finish_queue_item', arguments: { symbol: 'NVDA' } })) as { content: Array<{ text: string }> }).content[0]!.text;
    assert.equal(said, 'Marked done: NVDA, Overweight. The dashboard shows it.');
    const nvda = readQueue(dir)[0]!;
    assert.deepEqual([nvda.state, nvda.rating, nvda.quiet], ['done', 'Overweight', undefined]);
  } finally { await client.close(); }
});

test('a stock read as failed because nothing was saved for two hours is put right by its own run: done once its call is recorded, or failed in the run\'s words', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = R1;
  configure({ fetch: async () => new Response('no route', { status: 404 }), secEmail: '' });
  enqueue(dir, 'NVDA', '2026-11-06T23:47:00Z', 'medium'); enqueue(dir, 'AMD', '2026-11-06T23:47:30Z');
  startItem(dir, 'NVDA', R1, new Date('2026-11-06T23:48:12Z'));
  step(dir, 'market', '00:05'); step(dir, 'bear', '00:23');
  // one step took longer than two hours (none ever has): from 02:23 the stock reads as failed, and a change to the list keeps it so
  assert.equal(readQueue(dir, at('02:22'))[0]!.state, 'running');
  enqueue(dir, 'TSLA', '2026-11-07T02:30:00Z', undefined, at('02:30'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')) as Array<Record<string, unknown>>;
  assert.deepEqual([saved[0]!.state, saved[0]!.reason, saved[0]!.quiet], ['failed', QUIET_REASON, true], 'kept as the desk\'s own guess');
  finishItem(dir, 'AMD', { rating: 'Hold' });
  assert.throws(() => finishItem(dir, 'AMD', { reason: 'late words' }), /AMD is already done/, 'any other finished stock stays finished');
  // the run was still going after all: its call is recorded at 02:35 and it finishes the stock
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, async () => new Response('no route', { status: 404 })).connect(a);
  const client = new Client({ name: 'pretend team', version: '0' });
  await client.connect(b);
  try {
    new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', R1, '**Rating**: Overweight\n\n**Executive Summary**: NVDA.');
    // once its call is recorded the list already reads it done, with that call's rating (audit 3, server-7), and its run's
    // word makes that its own
    assert.deepEqual([readQueue(dir)[0]!.state, readQueue(dir)[0]!.rating], ['done', 'Overweight']);
    const said = ((await client.callTool({ name: 'finish_queue_item', arguments: { symbol: 'NVDA' } })) as { content: Array<{ text: string }> }).content[0]!.text;
    assert.equal(said, 'Marked done: NVDA, Overweight. The dashboard shows it.');
    const nvda = readQueue(dir)[0]!;
    assert.deepEqual([nvda.state, nvda.rating, nvda.reason, nvda.quiet], ['done', 'Overweight', undefined, undefined]);
    assert.throws(() => finishItem(dir, 'NVDA', { reason: 'late words' }), /NVDA is already done/, 'and from then on it stays done');
  } finally { await client.close(); }
  // or its run says why it failed, in its own words, in place of the desk's guess
  const other = desk().dir;
  enqueue(other, 'META', '2026-11-06T20:00:00Z'); startItem(other, 'META', R1, new Date('2026-11-06T20:00:00Z'));
  enqueue(other, 'XLK', '2026-11-06T23:00:00Z', undefined, new Date('2026-11-06T23:00:00Z'));   // persists META as failed, quietly
  assert.equal(finishItem(other, 'META', { reason: "the model's 5-hour usage limit was reached" }).reason, "the model's 5-hour usage limit was reached");
  assert.equal(readQueue(other)[0]!.quiet, undefined);
});

test("the desk's own listener stops a run only when nothing was saved for two hours, or one stock ran six hours, and says why beside the stock", async (t) => {
  const { dir } = desk();
  const start = '2026-11-06T23:48:00.000Z', t0 = Date.parse(start), min = 60_000;
  assert.equal(stopWhy(dir, start, new Date(t0 + QUIET_MS - min)), null, 'a run that has not yet started a stock is given the same two hours');
  assert.match(stopWhy(dir, start, new Date(t0 + QUIET_MS + min))!, /^nothing was saved for two hours, so the desk's listener stopped the run: press Retry$/);
  enqueue(dir, 'NVDA', '2026-11-06T23:47:00Z', 'deep');
  startItem(dir, 'NVDA', R1, new Date('2026-11-06T23:48:12Z'));
  // a deep run that keeps saving every 20 minutes goes on past the old three hours...
  for (let m = 20; m <= 5 * 60 + 40; m += 20) {
    saveSection(dir, 'NVDA', R1, 'bull', `turn at ${m}`);
    const when = new Date(t0 + m * min);
    fs.utimesSync(path.join(dir, 'runs', `NVDA_${R1}`, 'run.json'), when, when);
    assert.equal(stopWhy(dir, start, new Date(when.getTime() + 10 * min)), null, `${m} minutes in, still saving`);
  }
  // ...but not past six hours on one stock, in case the team is going round in a loop that keeps saving
  const looped = new Date(Date.parse('2026-11-06T23:48:12Z') + STOCK_MAX_MS + min);
  fs.utimesSync(path.join(dir, 'runs', `NVDA_${R1}`, 'run.json'), looped, looped);
  assert.equal(stopWhy(dir, start, looped), "NVDA had been analysed for six hours, the most the desk's listener allows one stock, so it stopped the run: press Retry");

  // the listener puts its own words beside the stock, also when the waiting list already read it as failed by the quiet rule
  const quiet = desk().dir;
  enqueue(quiet, 'NVDA', '2026-11-06T23:47:00Z');
  let shift = Date.parse('2026-11-06T23:48:00Z') - Date.now();   // a clock that ticks, set to round 1's evening
  const clock = () => new Date(Date.now() + shift);
  const why = "nothing was saved for two hours, so the desk's listener stopped the run: press Retry";
  const w = watch({ dir: quiet, listener: 'Claude Code', pid: 501, ...quick, now: clock, run: async () => {
    startItem(quiet, 'NVDA', R1, clock());
    shift += QUIET_MS + 2 * min;   // the run hangs, saving nothing
    assert.equal(readQueue(quiet, clock())[0]!.reason, QUIET_REASON, 'the waiting list already reads it as failed, in general words');
    return why;
  } });
  t.after(() => w.stop());
  await until(() => !!readListener(quiet, clock())?.lastRun);
  const nvda = readQueue(quiet, clock())[0]!;
  assert.deepEqual([nvda.state, nvda.reason, nvda.quiet], ['failed', why, undefined]);
  assert.equal(readListener(quiet, clock())!.lastRun!.result, `0 analysed, 1 failed; ${why}`);
  w.stop(); await w.done;
});

test('the listener counts as analysed only the stocks it analysed: one already called today is said apart', async (t) => {
  const { dir } = desk();
  enqueue(dir, 'NVDA', '2026-10-12T10:00:00Z'); enqueue(dir, 'AAPL', '2026-10-12T10:00:01Z');
  const w = watch({ dir, listener: 'Claude Code', pid: 601, ...quick, run: async () => {
    finishItem(dir, 'NVDA', { rating: 'Buy', already: true });   // start_queue_item's ALREADY: called earlier today
    startItem(dir, 'AAPL', '2026-10-12'); finishItem(dir, 'AAPL', { rating: 'Hold' });
  } });
  t.after(() => w.stop());
  await until(() => !!readListener(dir)?.lastRun);
  assert.equal(readListener(dir)!.lastRun!.result, '1 analysed, 1 already called today, 0 failed');
  assert.deepEqual(readQueue(dir).map((i) => [i.symbol, i.state, i.already]), [['NVDA', 'done', true], ['AAPL', 'done', undefined]]);
  w.stop(); await w.done;
});

test("any listener's note that its run has ended fails the stock that run left running at once, in the listener's words", () => {
  const { dir } = desk();
  const at = new Date('2026-10-21T03:50:00Z');
  enqueue(dir, 'NVDA', '2026-10-21T03:40:00Z'); enqueue(dir, 'META', '2026-10-21T03:40:01Z');
  startItem(dir, 'NVDA', '2026-10-20', new Date('2026-10-21T03:46:44Z'));
  const note = { listener: 'Madav', since: '2026-10-21T03:00:00Z', beat: at.toISOString() };
  writeListener(dir, { ...note, lastRun: { at: '2026-10-21T03:40:00Z', result: '1 analysed, 0 failed' } });
  assert.equal(readQueue(dir, at)[0]?.state, 'running', 'an older run says nothing about this one');
  writeListener(dir, { ...note, lastRun: { at: '2026-10-21T03:51:35Z', result: "0 analysed; Claude's usage limit was reached, it resets 6am" } });
  assert.equal(readQueue(dir, at)[0]?.state, 'running', 'without when its run started, the note is not enough');
  writeListener(dir, { ...note, lastRun: { started: '2026-10-21T03:47:00Z', at: '2026-10-21T03:51:35Z', result: '0 analysed' } });
  assert.equal(readQueue(dir, at)[0]?.state, 'running', 'a run that started after this stock did not start it');
  writeListener(dir, { ...note, lastRun: { started: '2026-10-21T03:46:34Z', at: '2026-10-21T03:51:35Z', result: "0 analysed; Claude's usage limit was reached, it resets 6am" } });
  const nvda = readQueue(dir, at)[0]!;
  assert.deepEqual([nvda.state, nvda.reason, nvda.endedAt], ['failed', "Madav's run ended before this stock was finished: 0 analysed; Claude's usage limit was reached, it resets 6am", '2026-10-21T03:51:35Z']);
  assert.equal(readQueue(dir, at)[1]?.state, 'waiting', 'a stock still waiting stays waiting');
});

test('after an update the listener makes way between runs, never during one', async (t) => {
  const { dir } = desk();
  let changed = false;
  t.after(() => w.stop());
  const w = watch({ dir, listener: 'Claude Code', pid: 301, ...quick, run: async () => {}, retire: () => changed });
  await sleep(60);
  changed = true;
  assert.equal(await w.done, 'updated');
  assert.equal(readListener(dir), null);
});

test('end to end with a pretend runner: presses on the dashboard, the doorbell, the listener, the desk\'s own tools, five a run, and every stock done on the page', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  configure({ fetch: async () => new Response('no route', { status: 404 }), secEmail: '' });
  const term = await startTerminal({ root, assets: new Map([['/index.html', { type: 'text/html', body: '<p>page</p>' }]]) as Assets, port: 0, keyFile: path.join(root, 'private', 'dashboard.json') });
  const post = async (p: string, body: unknown) => (await fetch(`${term.url}${p.slice(1)}`, { method: 'POST', headers: { 'x-desk-token': term.token, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  const state = async () => (await fetch(`${term.url}api/state`, { headers: { 'x-desk-token': term.token } })).json() as Promise<any>;
  // The pretend team: what the playbook's waiting list asks, through the desk's own tools, with a recorded call per stock.
  // Each run starts its own copy of the tools with the run's id, as Claude Code started by the listener does.
  const lines: string[] = [];
  const team = async (_start: string, id: string) => {
    process.env.TRADING_AGENTS_RUN = id;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await deskServer(root, async () => new Response('no route', { status: 404 })).connect(a);
    delete process.env.TRADING_AGENTS_RUN;
    const client = new Client({ name: 'pretend team', version: '0' });
    await client.connect(b);
    const tool = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
    try {
      const list = await tool('read_queue'), max = Number(/at most (\d+)/.exec(list)?.[1]);
      for (const sym of readQueue(dir).filter((i) => i.state === 'waiting').map((i) => i.symbol).slice(0, max)) {
        const started = await tool('start_queue_item', { symbol: sym });
        assert.match(started, /^START/);
        assert.equal(readQueue(dir).find((i) => i.symbol === sym)?.runner, id, "the stock is noted as this run's");
        new Journal(path.join(dir, 'journal.md')).storeDecision(sym, '2026-10-12', `**Rating**: ${sym === 'TSLA' ? 'Sell' : 'Buy'}\n\n**Executive Summary**: ${sym}.`);
        lines.push(await tool('finish_queue_item', { symbol: sym }));
      }
      lines.push(await tool('end_queue_run'));
    } finally { await client.close(); }
  };
  const w = watch({ dir, listener: 'Claude Code', pid: 401, ...quick, settleMs: 2_000, run: team });   // seven presses, one run
  try {
    assert.equal((await state()).analyses.listener.listener, 'Claude Code', 'the page says who listens');
    for (const s of ['NVDA', 'AAPL', 'TSLA', 'AMD', 'MSFT', 'GOOG', 'META']) await post('/api/queue', { symbol: s, depth: s === 'NVDA' ? 'deep' : 'shallow' });
    await until(() => readQueue(dir).every((i) => i.state === 'done'), 15_000);
    const q = (await state()).queue;
    assert.equal(q.length, 7);
    assert.deepEqual(q.find((i: any) => i.symbol === 'TSLA').rating, 'Sell');
    assert.deepEqual(q.find((i: any) => i.symbol === 'NVDA').depth, 'deep');
    assert.equal(lines[5], "2 still waiting: another run was asked for. On the dashboard's list: 5 done, 0 failed.", `five a run; the rest rang for another: ${JSON.stringify(lines)}`);
    assert.equal(lines.at(-1), "Nothing is waiting. On the dashboard's list: 7 done, 0 failed.");
    assert.match(readListener(dir)?.lastRun?.result ?? '', /^2 analysed, 0 failed$/);
  } finally { w.stop(); await w.done; await term.close(); }
});

test('the waiting list says the real reason when nothing is waiting: empty, or only finished analyses kept for the person to see', async () => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, async () => new Response('no route', { status: 404 })).connect(a);
  const client = new Client({ name: 'pretend team', version: '0' });
  await client.connect(b);
  const read = async () => ((await client.callTool({ name: 'read_queue', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text;
  try {
    const about = (await client.listTools()).tools.find((t) => t.name === 'read_queue')!.description!;
    assert.match(about, /the stocks the person asked the desk to analyse on the dashboard, and those Monday's re-rating and the morning switch put on it/, 'not only what the person asked for one by one');
    assert.equal(await read(), 'Nothing is waiting: the list is empty.');
    enqueue(dir, 'NVDA', '2026-10-12T10:00:00Z'); enqueue(dir, 'AAPL', '2026-10-12T10:00:01Z'); enqueue(dir, 'TSLA', '2026-10-12T10:00:02Z');
    finishItem(dir, 'NVDA', { rating: 'Buy' }); finishItem(dir, 'AAPL', { reason: 'no email saved for the SEC yet' });
    startItem(dir, 'TSLA', '2026-10-12');
    const busy = await read();
    assert.match(busy, /^Being analysed now by another run: TSLA \(started \d\d:\d\d UTC\)\./);
    assert.match(busy, /\nNothing else is waiting\. The list also keeps finished analyses for the person to see, 1 done and 1 failed \(the person presses Retry on the dashboard to ask again\): none of them needs a run\.$/);
    finishItem(dir, 'TSLA', { rating: 'Sell' });
    const after = await read();
    assert.equal(after, 'Nothing is waiting. The list also keeps finished analyses for the person to see, 2 done and 1 failed (the person presses Retry on the dashboard to ask again): none of them needs a run.');
    assert.doesNotMatch(after, /has not asked/, 'never "the person has not asked for any analysis" with their analyses on the list');
  } finally { await client.close(); }
});
