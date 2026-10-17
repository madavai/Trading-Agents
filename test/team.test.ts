import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deskServer } from '../src/tools/server.js';
import { isOrderTool } from '../src/robinhood/connect.js';
import { SECTIONS } from '../src/desk/runs.js';

interface Agent { file: string; section: string; tools: string[]; manager?: boolean; body: string }
const src = await import(pathToFileURL(path.resolve('scripts/agents-src.mjs')).href) as { AGENTS: Agent[]; COMMON: string };
const front = (file: string) => {
  const text = fs.readFileSync(path.join('.claude/agents', `${file}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)!;
  return { text, fields: Object.fromEntries(m[1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()])) };
};

test('the agent files are the ones written from their source', () => {
  const r = spawnSync(process.execPath, ['scripts/agents.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // the twelve, and the trading-desk team for Madav's Agent Studio with its line-up (agent-studio.test.ts)
  assert.deepEqual(fs.readdirSync('.claude/agents').sort(), [...src.AGENTS.map((a) => `${a.file}.md`), 'trading-desk.md', 'trading-desk.team.json'].sort());
});

test('the team is the original\'s twelve, one agent for each step the plan can ask for', () => {
  assert.equal(src.AGENTS.length, 12);
  assert.deepEqual(src.AGENTS.map((a) => a.section).sort(), [...SECTIONS].sort());
  assert.deepEqual(src.AGENTS.filter((a) => a.manager).map((a) => a.file).sort(), ['portfolio-manager', 'research-manager']);
});

test('every agent has only desk tools that exist, none of which can order, and no shell, files or web', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-team-'))).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const offered = new Set((await client.listTools()).tools.map((t) => `mcp__trading-desk__${t.name}`));
  for (const agent of src.AGENTS) {
    const { fields } = front(agent.file);
    assert.equal(fields.name, agent.file);
    const tools = fields.tools!.split(',').map((t) => t.trim());
    assert.equal(tools.at(-1), 'SendMessage', `${agent.file} cannot message the other members`);
    for (const t of tools.filter((x) => x !== 'SendMessage')) {
      assert.ok(offered.has(t), `${agent.file}: ${t} is not a desk tool`);
      assert.ok(!isOrderTool(t.replace('mcp__trading-desk__', '')), `${agent.file}: ${t}`);
    }
    assert.ok(tools.includes('mcp__trading-desk__save_run_section'), `${agent.file} cannot save its work`);
    for (const banned of ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent']) assert.ok(fields.disallowedTools!.split(',').map((s) => s.trim()).includes(banned), `${agent.file} may use ${banned}`);
    assert.ok(Number(fields.maxTurns) > 0);
    assert.ok(!tools.includes('mcp__trading-desk__set_contact_email') && !tools.includes('mcp__trading-desk__set_holdings') && !tools.includes('mcp__trading-desk__record_outcome'), `${agent.file} can change the person's records`);
  }
  await client.close();
});

test('the lead has no shell and no free file access: only its members, its questions and the desk\'s own tools', () => {
  const { fields } = front('trading-desk');
  const tools = fields.tools!.split(/,(?![^(]*\))/).map((t) => t.trim());
  assert.deepEqual(tools.filter((t) => !t.startsWith('mcp__trading-desk__') && !t.startsWith('Agent(')), ['SendMessage', 'AskUserQuestion']);
  const banned = fields.disallowedTools!.split(',').map((s) => s.trim());
  for (const t of ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(banned.includes(t), `the lead may use ${t}`);
});

test('every agent carries the desk\'s rules and saves the section the plan expects', () => {
  for (const agent of src.AGENTS) {
    const { text } = front(agent.file);
    assert.ok(text.includes(src.COMMON), agent.file);
    for (const rule of ['never from memory and never estimated', 'Never place, change or cancel an order', 'Nothing here is investment advice', 'save your work with save_run_section']) assert.ok(text.includes(rule), `${agent.file}: ${rule}`);
    assert.match(agent.body, new RegExp(`section "${agent.section}"`), agent.file);
  }
});

test('the labelled lines the journal and report read are the ones the agents are asked to write', () => {
  const body = (f: string) => src.AGENTS.find((a) => a.file === f)!.body;
  assert.match(body('portfolio-manager'), /\*\*Rating\*\*: exactly one of Buy \/ Overweight \/ Hold \/ Underweight \/ Sell/);
  assert.match(body('research-manager'), /\*\*Recommendation\*\*: exactly one of Buy \/ Overweight \/ Hold \/ Underweight \/ Sell/);
  assert.match(body('trader'), /\*\*Action\*\*: exactly one of Buy \/ Hold \/ Sell/);
  assert.match(body('trader'), /FINAL TRANSACTION PROPOSAL/);
  assert.match(body('sentiment-analyst'), /\*\*Overall Sentiment:\*\* \*\*<band>\*\* \(Score: <n\.n>\/10\)/);
});

test('/analyse names every agent, and /analyse and /settle never order and never take a number from an agent', () => {
  const analyse = fs.readFileSync('.claude/skills/analyse/SKILL.md', 'utf8'), settle = fs.readFileSync('.claude/skills/settle/SKILL.md', 'utf8');
  for (const a of src.AGENTS) assert.ok(analyse.includes(a.file), `/analyse does not name ${a.file}`);
  for (const tool of ['list_settlements', 'record_outcome', 'plan_analysis', 'read_run', 'write_report', 'record_decision', 'set_contact_email']) assert.ok(analyse.includes(tool), tool);
  assert.match(analyse, /never places an order|nothing you or any agent does places, changes or cancels an order/i);
  assert.match(settle, /never a number of your own/);
  assert.match(settle, /exactly 2 to 4 sentences/);
});
