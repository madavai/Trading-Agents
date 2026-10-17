import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deskServer } from '../src/tools/server.js';
import { isOrderTool } from '../src/robinhood/connect.js';
import { openDashboard } from '../src/terminal/launch.js';

const AGENTS = '.claude/agents';
const header = (f: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(m, `${f} has a header`);
  return Object.fromEntries(m![1]!.split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
};
const toolsOf = (f: string) => header(f).tools!.replace(/Agent\(([^)]*)\)/, 'Agent').split(',').map((s) => s.trim());

test('a clone carries the desk for Agent Studio: the twelve agents and the trading-desk team with its line-up beside it, all from one source', () => {
  const r = spawnSync(process.execPath, ['scripts/agents.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync('.madav'), false, 'Agent Studio reads .claude/agents; there is no second copy to drift');
  const members = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md') && f !== 'trading-desk.md').map((f) => f.replace(/\.md$/, '')).sort();
  assert.equal(members.length, 12);
  // the line-up, in the shape Madav keeps a team in (its team.ts): members once each, the lead deciding the order
  const lineUp = JSON.parse(fs.readFileSync(path.join(AGENTS, 'trading-desk.team.json'), 'utf8')) as { members: string[]; steps: boolean; together: string[]; gates: string[]; talk: boolean };
  assert.deepEqual([...lineUp.members].sort(), members);
  assert.equal(new Set(lineUp.members).size, lineUp.members.length);
  assert.ok(lineUp.members.every((m) => /^[a-z0-9][a-z0-9-]*$/i.test(m)));
  assert.deepEqual([lineUp.steps, lineUp.together, lineUp.gates, lineUp.talk], [false, [], [], true]);
  // members may talk: each lists SendMessage itself, so saving the team in Madav has nothing to add to the project's files
  for (const m of members) assert.ok(toolsOf(path.join(AGENTS, `${m}.md`)).includes('SendMessage'), `${m} cannot message the others`);
  assert.ok(lineUp.members.length <= 20, 'Madav holds twenty agents in a team at most');
  // the team's own file names the same members it may start
  const named = /Agent\(([^)]*)\)/.exec(header(path.join(AGENTS, 'trading-desk.md')).tools!)![1]!.split(',').map((s) => s.trim());
  assert.deepEqual(named, lineUp.members);
});

test('every agent has only its desk tools; the team gets no shell, no web and no Robinhood or order tool', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-studio-'))).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  const desk = new Set((await client.listTools()).tools.map((t) => `mcp__trading-desk__${t.name}`));
  await client.close();
  for (const f of fs.readdirSync(AGENTS).filter((x) => x.endsWith('.md'))) {
    for (const t of toolsOf(path.join(AGENTS, f))) {
      assert.ok(!isOrderTool(t) && !/robinhood/i.test(t), `${f}: ${t}`);
      if (t.startsWith('mcp__')) assert.ok(desk.has(t), `${f}: ${t} is one of the desk's own tools`);
    }
  }
  const team = path.join(AGENTS, 'trading-desk.md');
  assert.ok(toolsOf(team).includes('mcp__trading-desk__open_dashboard'));
  assert.ok(!toolsOf(team).some((t) => /^(Bash|PowerShell|WebFetch|WebSearch|Write|Edit)$/.test(t)), 'the team gets no shell, web or editing');
  assert.match(header(team).disallowedTools!, /Bash.*WebFetch/);
  const playbook = fs.readFileSync(team, 'utf8');
  for (const part of ['## Analyse a stock', '## Score past calls', '## Test the desk over past dates', '## Check this computer', '## Reset the team', '## Show the dashboard', 'only their own Confirm']) assert.ok(playbook.includes(part), part);
  assert.ok(toolsOf(team).includes('mcp__trading-desk__reset_team'), 'the team can put its own files back, on the person\'s yes');
});

test('the dashboard tool says plainly when the dashboard cannot be started, and never claims it opened', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-launch-'));
  assert.match(await openDashboard(empty, { waitMs: 600, noOpen: true }), /^DATA_UNAVAILABLE: the dashboard did not answer/);
});
