// Two or three analyses side by side in one run: the person's "At once" choice on Analysis status (1 as shipped, up to
// 3). One run still takes stocks from the waiting list at a time; within it, up to that many are analysed at once. Each
// test uses made-up data, and nothing starts Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { Journal } from '../src/desk/journal.js';
import { AT_ONCE, enqueue, QueueRefusal, readQueue, startItem } from '../src/desk/queue.js';
import { morningBrief, morningList } from '../src/desk/routine.js';
import { readNotes } from '../src/desk/loop-notes.js';
import { addWatch, setFavourite } from '../src/terminal/store.js';
import { cleanPrefs, readPrefs, savePrefs } from '../src/terminal/prefs.js';
import { AT_ONCE_CHOICES, atOnceToast, paceWords } from '../src/terminal/ui/analyses.js';
import { stateOf } from '../src/terminal/state.js';
import { deskServer } from '../src/tools/server.js';

const desk = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-side-')); fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json')); return { root, dir: path.join(root, 'desk-data') }; };
const noRoute = async () => new Response('no route', { status: 404 });
const recordCall = (dir: string, sym: string, day: string, rating = 'Buy') => new Journal(path.join(dir, 'journal.md')).storeDecision(sym, day, `**Rating**: ${rating}\n\n**Executive Summary**: ${sym}.`);
const refusal = (run: () => unknown): QueueRefusal => { try { run(); } catch (e) { if (e instanceof QueueRefusal) return e; throw e; } return assert.fail('not refused'); };

/** One conversation's copy of the desk's tools: what a run calls. */
async function conversation(root: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, noRoute).connect(a);
  const client = new Client({ name: 'pretend run', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { call, close: () => client.close() };
}

const DAY = '2026-11-10';   // a Tuesday, New York's market open, no Monday re-rating

test('the choice is 1, 2 or 3, one at a time as shipped, and the page offers the same three', () => {
  assert.deepEqual([...AT_ONCE], [1, 2, 3]);
  assert.deepEqual([...AT_ONCE_CHOICES], [...AT_ONCE], 'the page offers what the desk accepts');
  assert.deepEqual([1, 2, 3, 0, 4, '2', 2.5, null].map((v) => cleanPrefs({ atOnce: v }).atOnce), [1, 2, 3, undefined, undefined, undefined, undefined, undefined], 'anything else is dropped, never stored');
  const { root, dir } = desk();
  assert.equal(stateOf(root, DAY).analyses.atOnce, 1, 'one at a time until the person chooses otherwise');
  savePrefs(dir, { atOnce: 2 });
  assert.equal(stateOf(root, DAY).analyses.atOnce, 2);
  assert.equal(paceWords(1, 5), 'One stock at a time, at most 5 a run.');
  assert.equal(paceWords(2, 5), 'Up to 2 side by side, at most 5 a run.');
  assert.match(atOnceToast(3), /^Up to 3 side by side: a run keeps up to 3 stocks going at once/);
  assert.match(atOnceToast(1), /^One at a time:/);
});

test('one run holds up to its number of stocks; one more is refused until it finishes one, and another run takes none', () => {
  const { dir } = desk();
  for (const [i, s] of ['AAPL', 'MSFT', 'NVDA'].entries()) enqueue(dir, s, `2026-11-10T13:00:0${i}Z`);
  const run = { runner: 'run-a' }, other = { runner: 'run-b' };
  assert.equal(startItem(dir, 'AAPL', DAY, new Date(), run, 2).state, 'running');
  assert.equal(startItem(dir, 'MSFT', DAY, new Date(), run, 2).state, 'running');
  const full = refusal(() => startItem(dir, 'NVDA', DAY, new Date(), run, 2));
  assert.equal(full.code, 'UNFINISHED');
  assert.equal(full.message, "AAPL and MSFT, which this run started, are not finished yet, and this run analyses at most 2 side by side (the person's choice): call finish_queue_item for one of them (done once its call is recorded, or failed with why) before starting another");
  assert.equal(startItem(dir, 'MSFT', DAY, new Date(), run, 2).runner, 'run-a', 'the same run asking again for its own stock is answered as before, even at its number');
  const busy = refusal(() => startItem(dir, 'NVDA', DAY, new Date(), other, 3));
  assert.deepEqual([busy.code, busy.message], ['BUSY', 'AAPL is being analysed now by another run: one run takes stocks from the waiting list at a time'], 'another run starts nothing while this one has stocks going, whatever its own number');
  assert.equal(refusal(() => startItem(dir, 'MSFT', DAY, new Date(), other, 3)).code, 'BUSY', 'and never takes one of them');
  // Lowered to 1 while two are going: nothing more starts until one is left
  const lowered = refusal(() => startItem(dir, 'NVDA', DAY, new Date(), run, 1));
  assert.equal(lowered.code, 'UNFINISHED');
  assert.deepEqual(readQueue(dir).map((i) => [i.symbol, i.state]), [['AAPL', 'running'], ['MSFT', 'running'], ['NVDA', 'waiting']]);
});

test('one at a time, as shipped: a second stock of the same run is refused with the same words as before', () => {
  const { dir } = desk();
  enqueue(dir, 'AAPL', '2026-11-10T13:00:00Z'); enqueue(dir, 'MSFT', '2026-11-10T13:00:01Z');
  startItem(dir, 'AAPL', DAY, new Date(), { runner: 'run-a' });
  const e = refusal(() => startItem(dir, 'MSFT', DAY, new Date(), { runner: 'run-a' }));
  assert.deepEqual([e.code, e.message], ['UNFINISHED', 'AAPL, which this run started, is not finished yet: call finish_queue_item for it (done once its call is recorded, or failed with why) before starting another']);
});

test('the run\'s tools: the list says how many side by side, each stock is started and finished on its own, and the run\'s end fails every one it left', async (t) => {
  const { root, dir } = desk();
  process.env.TRADING_AGENTS_TODAY = DAY;
  configure({ fetch: noRoute, secEmail: '' });
  const run = await conversation(root), chat = await conversation(root);
  t.after(async () => { await run.close(); await chat.close(); });
  for (const [i, s] of ['AAPL', 'MSFT', 'NVDA', 'AMD'].entries()) enqueue(dir, s, `2026-11-10T13:00:0${i}Z`);

  assert.match(await run.call('read_queue'), /^4 waiting, in the order to run them; one run analyses at most 5:\n1\. AAPL/, 'one at a time until chosen: the words as before');
  assert.match(await run.call('read_queue'), /\nFor each, in order: start_queue_item, the analysis, then finish_queue_item\. At the end, end_queue_run\.$/);

  savePrefs(dir, { atOnce: 2 });
  const list = await run.call('read_queue');
  assert.match(list, /^4 waiting, in the order to run them; one run analyses at most 5, up to 2 side by side \(the person's choice\):\n1\. AAPL/);
  assert.match(list, /\nKeep up to 2 of them going side by side, in this order, as the playbook's waiting list says: start_queue_item for each, their steps in rounds, finish_queue_item for each once its call is recorded, then the next waiting one in its place\. At the end, end_queue_run\.$/);

  assert.match(await run.call('start_queue_item', { symbol: 'AAPL' }), /^START: AAPL/);
  assert.match(await run.call('read_queue'), /^Being analysed now by this run: AAPL \(started \d\d:\d\d UTC\)\. Finish it with finish_queue_item \(done once its call is recorded, or failed with why\)\.\n/, 'one of two going: it may start another');
  assert.match(await run.call('start_queue_item', { symbol: 'MSFT' }), /^START: MSFT/);
  assert.match(await run.call('read_queue'), /^Being analysed now by this run: AAPL \(started \d\d:\d\d UTC\), MSFT \(started \d\d:\d\d UTC\)\. Finish each with finish_queue_item \(done once its call is recorded, or failed with why\) before starting another\.\n/);
  assert.match(await run.call('start_queue_item', { symbol: 'NVDA' }), /^UNFINISHED: AAPL and MSFT, which this run started, are not finished yet, and this run analyses at most 2 side by side/);

  // another conversation (a chat, a routine) finds the list taken and stops, naming both
  assert.match(await chat.call('read_queue'), /^Being analysed now by another run: AAPL \(started \d\d:\d\d UTC\), MSFT \(started \d\d:\d\d UTC\)\. One run takes stocks from the waiting list at a time: stop this run and say so\. Do not call end_queue_run: the run analysing AAPL and MSFT asks for the next run itself when it finishes\.\nWaiting behind them, left to that run: NVDA, AMD\.$/);
  assert.match(await chat.call('start_queue_item', { symbol: 'NVDA' }), /^BUSY: AAPL is being analysed now by another run/);

  // AAPL's call is recorded: it is finished, and the next waiting stock takes its place
  recordCall(dir, 'AAPL', DAY);
  assert.match(await run.call('finish_queue_item', { symbol: 'AAPL' }), /^Marked done: AAPL, Buy/);
  assert.match(await run.call('start_queue_item', { symbol: 'NVDA' }), /^START: NVDA/);

  // the run stops with MSFT and NVDA unfinished: its end fails both, and asks for another run for AMD
  assert.equal(await run.call('end_queue_run'), "Marked failed: MSFT, NVDA, which this run left unfinished without saying why. 1 still waiting: another run was asked for. On the dashboard's list: 1 done, 2 failed.");
  assert.deepEqual(readQueue(dir).map((i) => [i.symbol, i.state]), [['AAPL', 'done'], ['MSFT', 'failed'], ['NVDA', 'failed'], ['AMD', 'waiting']]);
  assert.equal(readPrefs(dir).atOnce, 2, 'the choice stays as the person left it');
});

test('the morning routine: side by side when chosen, and never a starred stock another run is analysing beside another', () => {
  const { dir } = desk();
  for (const s of ['AAPL', 'MSFT', 'TSLA', 'AMD']) { addWatch(dir, s, '2026-11-01'); setFavourite(dir, s, true); }
  // another run has two stocks going side by side; MSFT is starred as well
  enqueue(dir, 'AAPL', '2026-11-10T12:00:00Z'); enqueue(dir, 'MSFT', '2026-11-10T12:00:01Z'); enqueue(dir, 'NVDA', '2026-11-10T12:00:02Z');
  startItem(dir, 'AAPL', DAY, new Date(), { runner: 'run-a' }, 2); startItem(dir, 'MSFT', DAY, new Date(), { runner: 'run-a' }, 2);
  const m = morningList(dir, DAY, 5);
  assert.deepEqual(m.running, ['AAPL', 'MSFT']);
  assert.deepEqual(m.leftToRun, ['NVDA']);
  assert.deepEqual(m.analyse.map((a) => a.symbol), ['TSLA', 'AMD'], 'MSFT is being analysed by the other run: the morning never starts it again because it is starred');
  const brief = morningBrief(dir, DAY, 5, undefined, undefined, 2);
  assert.match(brief, /AAPL and MSFT are being analysed now by another run: leave them alone\. Waiting on the dashboard, left to that run \(one run takes stocks from the waiting list at a time\): NVDA\./);
  assert.match(brief, /\n2\. Analyse in this order \(2 of at most 5 a morning\), up to 2 side by side \(the person's choice\), each by the \/analyse playbook with today's date, as its section 7 \("Side by side"\) says:\n {3}1\. TSLA/);
  assert.match(morningBrief(dir, DAY, 5), /\n2\. Analyse, one after another, in this order \(2 of at most 5 a morning\)/, 'one at a time as shipped');
});

test('two runs scoring at once never drop each other\'s counts in the scoring notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-notes-')), journal = path.join(dir, 'journal.md');
  // Two separate programs, as two runs are, each counting 40 saved lessons in the same scoring.
  const child = `import { noteStep } from ${JSON.stringify(new URL('../src/desk/loop-notes.js', import.meta.url).href)};
    for (let i = 0; i < 40; i++) noteStep({ file: ${JSON.stringify(journal)} }, 'settle-check', Date.now(), { ticker: 'X' + i, date: '2026-11-10' });`;
  const runs = [0, 1].map(() => new Promise<number | null>((done) => spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: 'ignore' }).on('close', done)));
  assert.deepEqual(await Promise.all(runs), [0, 0]);
  assert.equal(readNotes({ file: journal } as Journal, 'settle-check', Date.now()).saved, 80, 'every save of both runs is counted');
  assert.ok(!fs.existsSync(path.join(dir, 'settle-check.json.lock')), 'no lock is left behind');
});

test('the playbook and the team say how to work side by side, and the analysts do not message each other then', () => {
  const skill = fs.readFileSync('.claude/skills/analyse/SKILL.md', 'utf8'), lead = fs.readFileSync('.claude/agents/trading-desk.md', 'utf8');
  assert.match(skill, /\n## 7\. Side by side\nWhen `read_queue` or a routine's brief says up to N stocks side by side, keep up to N of them going at once/);
  assert.match(skill, /UNFINISHED: this run already has as many stocks going as it may: finish one first\./);
  assert.match(skill, /"Several stocks are analysed side by side in this run: do not message the other analysts\."/);
  assert.match(lead, /\n### 7\. Side by side\n/, 'the team carries the same steps');
  assert.doesNotMatch(skill + lead, /one stock runs at a time/i);
  for (const a of ['market-analyst', 'sentiment-analyst', 'news-analyst', 'fundamentals-analyst']) {
    assert.match(fs.readFileSync(`.claude/agents/${a}.md`, 'utf8'), /\n- None when the request says several stocks are analysed side by side in this run: two analysts of the same name may then be working on other stocks, and a message could reach the wrong one\. You may still ask the lead\.\n/, a);
  }
  assert.match(fs.readFileSync('.claude/skills/routine/SKILL.md', 'utf8'), /one after another \(or side by side, when the brief says so, as the \/analyse playbook's section 7 says\)/);
});

test('the Analysis status page shows the choice and the words that go with it', () => {
  const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');
  assert.match(page, /\. \$\{paceWords\(d\.analyses\.atOnce, d\.analyses\.perRun\)\}`/, 'the line under the heading says how many at once');
  assert.match(page, /role="radiogroup" aria-label="How many stocks a run analyses at once">\$\{AT_ONCE_CHOICES\.map/);
  assert.match(page, /case 'q-together': \{ const n = Number\(el\.dataset\.n\); if \(!S\.desk \|\| !isAtOnceChoice\(n\) \|\| n === S\.desk\.analyses\.atOnce\) break; remember\(\{ atOnce: n \}\);/);
  assert.doesNotMatch(page, /One stock at a time, at most \$\{d\.analyses\.perRun\} a run/);
});
