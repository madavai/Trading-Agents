import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deskDataDir } from '../src/paths.js';
import { doorbellFile, enqueue, listenerFile, readListener, readQueue, startItem, writeListener } from '../src/desk/queue.js';
import { RUN_WORDS } from '../src/watch/claude.js';
import { AlreadyListening, watch, type Watcher } from '../src/watch/watcher.js';
import { listenerOf } from '../src/terminal/state.js';

const repo = process.cwd();
const AGENTS = path.join(repo, '.claude', 'agents');
const posix = (p: string) => p.split(path.sep).join('/');

interface Routine { name?: unknown; title?: unknown; description?: unknown; agent?: unknown; prompt?: unknown; cron?: unknown; watch?: unknown; listener?: unknown; [k: string]: unknown }
const routines = (): Routine[] => (JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'routines.json'), 'utf8')) as { routines: Routine[] }).routines;

test("the routines shipped to Madav are complete, the desk's own team's, and leave the person's choices to the person", () => {
  const list = routines();
  assert.deepEqual(list.map((r) => r.name), ['analyse-when-asked', 'morning-routine', 'evening-wrap-up']);
  const agents = new Set(fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
  for (const r of list) {
    assert.match(String(r.name), /^[a-z0-9]+(-[a-z0-9]+)*$/, `${r.name}: a short name Madav can keep`);
    for (const k of ['title', 'prompt'] as const) assert.ok(typeof r[k] === 'string' && (r[k] as string).trim(), `${r.name}: ${k}`);
    assert.ok(!String(r.title).includes('\n'), 'a title is one line');
    assert.equal(r.agent, 'trading-desk', `${r.name} runs as the desk's own team`);
    assert.ok(agents.has(String(r.agent)));
    for (const k of ['on', 'enabled', 'model', 'permissionMode', 'permissions', 'effort', 'budget', 'cwd', 'folder']) assert.ok(!(k in r), `${r.name}: ${k} is the person's, never the project's`);
    if (r.cron !== undefined) assert.match(String(r.cron), /^\S+ \S+ \S+ \S+ \S+$/, `${r.name}: five fields`);
    for (const k of ['watch', 'listener'] as const) if (r[k] !== undefined) {
      const p = String(r[k]);
      assert.ok(!path.isAbsolute(p) && !p.split('/').includes('..') && !p.includes('\\'), `${r.name}: ${k} stays inside the project, with forward slashes`);
      assert.ok(!p.startsWith('.claude/') && p !== '.mcp.json' && p !== 'CLAUDE.md', `${r.name}: what a run writes never lives where Madav's approval looks`);
    }
  }
  const asked = list.find((r) => r.name === 'analyse-when-asked')!;
  assert.equal(asked.prompt, RUN_WORDS, "the same words as the desk's own listener for Claude Code");
  assert.equal(asked.watch, posix(path.relative(repo, doorbellFile(deskDataDir(repo)))), 'it watches the doorbell the dashboard rings');
  assert.equal(asked.listener, posix(path.relative(repo, listenerFile(deskDataDir(repo)))), 'and keeps its note where the dashboard reads who listens');
  assert.equal(asked.cron, undefined, 'it runs when asked, not on a clock');
});

test('the agent files set no permission mode and give each agent its name in one file only', () => {
  const names = new Map<string, string>();
  for (const f of fs.readdirSync(AGENTS, { recursive: true }) as string[]) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(AGENTS, f), 'utf8'), head = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
    assert.doesNotMatch(head, /^permissionMode:/m, `${f}: the permission is the person's, chosen in Madav`);
    const name = /^name:\s*(\S+)/m.exec(head)?.[1];
    assert.ok(name, `${f} has a name`);
    assert.ok(!names.has(name!), `${name} is named in ${names.get(name!)} and ${f}`);
    names.set(name!, f);
  }
  assert.ok(names.size >= 13);
});

// Madav's listening note, as its routine writes it (the shape Madav's own documentation gives).
const madav = (o: Record<string, unknown> = {}) => ({ listening: 'Madav', routine: 'analyse-when-asked', since: '2026-10-21T09:00:12.000Z', checked: '2026-10-21T10:41:00.000Z', running: false, ...o });

test("Madav's note is read like the desk's own: who listens, the heartbeat, the last run; a stock its run left running fails at once only when Madav says when the run ended", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-madav-')), dir = deskDataDir(root);
  const now = new Date('2026-10-21T10:42:00.000Z');
  fs.mkdirSync(dir, { recursive: true });
  const put = (v: unknown) => fs.writeFileSync(listenerFile(dir), JSON.stringify(v));
  put(madav());
  assert.deepEqual(readListener(dir, now), { listener: 'Madav', since: '2026-10-21T09:00:12.000Z', beat: '2026-10-21T10:41:00.000Z', fresh: true });
  assert.deepEqual(listenerOf(dir, now), { listener: 'Madav', since: '2026-10-21T09:00:12.000Z' }, 'the dashboard says Madav is listening');
  assert.equal(readListener(dir, new Date('2026-10-21T10:44:30.000Z'))!.fresh, false, 'checked over three minutes ago: Madav was closed without tidying up');
  put(madav({ lastRun: { at: '2026-10-21T10:32:05.000Z', ended: 'finished', result: '2 analysed, 0 failed' } }));
  assert.deepEqual(readListener(dir, now)!.lastRun, { at: '2026-10-21T10:32:05.000Z', result: '2 analysed, 0 failed' });
  put(madav({ lastRun: { at: '2026-10-21T10:32:05.000Z', ended: 'stopped', result: '' } }));
  assert.equal(readListener(dir, now)!.lastRun!.result, 'stopped');

  enqueue(dir, 'NVDA', '2026-10-21T10:30:00.000Z');
  startItem(dir, 'NVDA', '2026-10-21', new Date('2026-10-21T10:33:00.000Z'));
  put(madav({ lastRun: { at: '2026-10-21T10:32:05.000Z', ended: 'failed', result: "Claude's usage limit was reached" } }));
  assert.equal(readQueue(dir, now)[0]!.state, 'running', 'without an end time, a chat may have started it since: the two-hour rule decides');
  put(madav({ lastRun: { at: '2026-10-21T10:32:05.000Z', ended: 'failed', endedAt: '2026-10-21T10:38:00.000Z', result: "Claude's usage limit was reached" } }));
  const nvda = readQueue(dir, now)[0]!;
  assert.deepEqual([nvda.state, nvda.reason], ['failed', "Madav's run ended before this stock was finished: failed: Claude's usage limit was reached"]);
});

test("the desk's own listener never starts beside Madav's, and makes way when Madav takes over", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-madav-')), dir = deskDataDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(listenerFile(dir), JSON.stringify(madav({ since: new Date().toISOString(), checked: new Date().toISOString() })));
  let stray: Watcher | undefined;
  t.after(() => { stray?.stop(); w.stop(); });   // a listener that should not have started is still stopped
  assert.throws(() => { stray = watch({ dir, listener: 'Claude Code', run: async () => {}, pid: 501, settleMs: 50, pollMs: 10 }); }, AlreadyListening);
  fs.rmSync(listenerFile(dir));
  const w = watch({ dir, listener: 'Claude Code', run: async () => {}, pid: 502, settleMs: 50, pollMs: 10 });
  writeListener(dir, { listener: 'Claude Code', since: new Date().toISOString(), beat: new Date().toISOString(), pid: 502 });
  fs.writeFileSync(listenerFile(dir), JSON.stringify(madav({ since: new Date().toISOString(), checked: new Date().toISOString() })));
  assert.equal(await w.done, 'off', "Madav's note in its place: switched off");
  assert.equal(readListener(dir)!.listener, 'Madav', "and Madav's note is left as it is");
});
