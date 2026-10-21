import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { Journal } from '../src/desk/journal.js';
import { enqueue, finishItem, readListener, readQueue, ringDoorbell, startItem, STALE_MS, writeListener } from '../src/desk/queue.js';
import { deskServer } from '../src/tools/server.js';
import { startTerminal, type Assets } from '../src/terminal/server.js';
import { findClaude, RUN_ARGS, RUN_WORDS, runClaude, stopReason } from '../src/watch/claude.js';
import { AlreadyListening, watch } from '../src/watch/watcher.js';

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
  assert.deepEqual(await runClaude({ command: process.execPath, args: [script] }, cwd, (t) => { out += t; }), { code: 0, timedOut: false });
  const seen = JSON.parse(out) as { args: string[]; cwd: string };
  assert.deepEqual(seen.args, [...RUN_ARGS]);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd), 'run in the project folder');
  assert.equal((await runClaude({ command: process.execPath, args: [script] }, cwd, () => {}, 10_000, ['--fail'])).code, 1);
  fs.writeFileSync(script, 'setTimeout(() => {}, 60_000)');
  assert.deepEqual(await runClaude({ command: process.execPath, args: [script] }, cwd, () => {}, 200), { code: null, timedOut: true }, 'a run that hangs is stopped');
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
  assert.equal(stopReason('API Error: 500 Internal server error'), "Claude's service answered with an error (500): press Retry in a while.");
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
  startItem(dir, 'AAPL', '2026-10-12', new Date('2026-10-12T10:00:00Z'));
  assert.equal(readQueue(dir, new Date(Date.parse('2026-10-12T10:00:00Z') + STALE_MS - 1000)).find((i) => i.symbol === 'AAPL')?.state, 'running');
  const late = readQueue(dir, new Date(Date.parse('2026-10-12T10:00:00Z') + STALE_MS + 1000)).find((i) => i.symbol === 'AAPL');
  assert.deepEqual([late?.state, /did not finish/.test(late?.reason ?? '')], ['failed', true]);
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
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, async () => new Response('no route', { status: 404 })).connect(a);
  const client = new Client({ name: 'pretend team', version: '0' });
  await client.connect(b);
  const tool = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  const lines: string[] = [];
  const team = async () => {
    const list = await tool('read_queue'), max = Number(/at most (\d+)/.exec(list)?.[1]);
    for (const sym of readQueue(dir).filter((i) => i.state === 'waiting').map((i) => i.symbol).slice(0, max)) {
      const started = await tool('start_queue_item', { symbol: sym });
      assert.match(started, /^START/);
      new Journal(path.join(dir, 'journal.md')).storeDecision(sym, '2026-10-12', `**Rating**: ${sym === 'TSLA' ? 'Sell' : 'Buy'}\n\n**Executive Summary**: ${sym}.`);
      lines.push(await tool('finish_queue_item', { symbol: sym }));
    }
    lines.push(await tool('end_queue_run'));
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
  } finally { w.stop(); await w.done; await client.close(); await term.close(); }
});
