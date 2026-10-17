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

const STUDIO = '.madav/agents';
const header = (f: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(m, `${f} has a header`);
  return Object.fromEntries(m![1]!.split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
};

test('a clone carries the desk for Agent Studio: the twelve agents and the trading-desk team, written from the same source as the chat agents', () => {
  const r = spawnSync(process.execPath, ['scripts/agents.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const chat = fs.readdirSync('.claude/agents').map((f) => f.replace(/\.md$/, '')).sort();
  const studio = fs.readdirSync(STUDIO).sort();
  assert.deepEqual(studio, [...chat, 'trading-desk'].sort());
  for (const name of studio) {
    assert.ok(fs.existsSync(path.join(STUDIO, name, 'v1.md')) && fs.existsSync(path.join(STUDIO, name, 'record.json')), name);
    const rec = JSON.parse(fs.readFileSync(path.join(STUDIO, name, 'record.json'), 'utf8')) as { versions: Array<{ n: number; bytes: number }> };
    assert.equal(rec.versions[0]!.n, 1);
    assert.equal(rec.versions[0]!.bytes, Buffer.byteLength(fs.readFileSync(path.join(STUDIO, name, 'v1.md'), 'utf8')), `${name}: the record names the file's real size`);
    assert.equal(header(path.join(STUDIO, name, 'v1.md')).name, name);
  }
  const rec = JSON.parse(fs.readFileSync(path.join(STUDIO, 'trading-desk', 'record.json'), 'utf8')) as { team: { kind: string; members: string[] } };
  assert.equal(rec.team.kind, 'managed');
  assert.deepEqual([...rec.team.members].sort(), chat);
});

test('in Agent Studio every member has only its own desk tools, as in chat, and no one on the team has a Robinhood or order tool', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-studio-'))).connect(a);
  const client = new Client({ name: 'test', version: '0' }); await client.connect(b);
  const desk = new Set((await client.listTools()).tools.map((t) => `mcp__trading-desk__${t.name}`));
  await client.close();
  for (const name of fs.readdirSync(STUDIO)) {
    const tools = header(path.join(STUDIO, name, 'v1.md')).tools!.replace(/Agent\([^)]*\)/, 'Agent').split(',').map((s) => s.trim());
    for (const t of tools) {
      assert.ok(!isOrderTool(t) && !/robinhood/i.test(t), `${name}: ${t}`);
      if (t.startsWith('mcp__')) assert.ok(desk.has(t), `${name}: ${t} is one of the desk's own tools`);
    }
    if (name !== 'trading-desk') {
      assert.equal(tools.filter((t) => !t.startsWith('mcp__trading-desk__')).length, 0, `${name} has only desk tools`);
      const chat = header(`.claude/agents/${name}.md`).tools!.split(',').map((s) => s.trim());
      assert.deepEqual(tools, chat, `${name}: the same tools in Agent Studio as in chat`);
    }
  }
  const team = header(path.join(STUDIO, 'trading-desk', 'v1.md')).tools!;
  assert.match(team, /mcp__trading-desk__open_dashboard/);
  assert.ok(!/\bBash\b|PowerShell|WebFetch/.test(team), 'the team gets no shell and no web fetch');
  const playbook = fs.readFileSync(path.join(STUDIO, 'trading-desk', 'v1.md'), 'utf8');
  for (const part of ['## Analyse a stock', '## Score past calls', '## Test the desk over past dates', '## Check this computer', '## Show the dashboard', 'only their own Confirm']) assert.ok(playbook.includes(part), part);
});

test('the dashboard tool says plainly when the dashboard cannot be started, and never claims it opened', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-launch-'));
  const words = await openDashboard(empty, { waitMs: 600, noOpen: true });
  assert.match(words, /^DATA_UNAVAILABLE: the dashboard did not answer/);
});
