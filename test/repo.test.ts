import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deskServer } from '../src/tools/server.js';
import { isOrderTool } from '../src/robinhood/connect.js';
import { DEFAULT_CAPS } from '../src/settings.js';

const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('trading ships switched off; the caps ship small and are not in the settings file, which anything in this folder could edit', () => {
  const s = json('desk-settings.json');
  assert.equal(s.trading.enabled, false);
  assert.equal(s.trading.caps, undefined, 'the caps are the person\'s own, kept beside the trading switch in their private folder');
  assert.deepEqual(DEFAULT_CAPS, { perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 3 });
  assert.equal(s.scoring.holdingPeriodDays, 5);
  assert.equal(s.scoring.benchmarks[''], 'SPY');
});

test('the /terminal skill opens the dashboard with the desk\'s own tool, which every agent has, never with a shell, a background task or another agent', () => {
  const skill = fs.readFileSync('.claude/skills/terminal/SKILL.md', 'utf8');
  assert.match(skill, /^1\. Call the desk tool `open_dashboard`\./m);
  assert.doesNotMatch(skill, /in the background|subagent|general-purpose/);
  assert.match(skill, /do not start the dashboard with a shell command, a background task or another agent/);
  assert.match(skill, /opens a page without its key/, 'the page the tool opened is the one with the key');
});

test('the folder refuses agents the sign-in folder and runs the guard before every tool', () => {
  const s = json('.claude/settings.json');
  assert.ok(s.permissions.deny.includes('Read(~/.trading-agents/**)'));
  assert.ok(s.permissions.deny.includes('Edit(~/.trading-agents/**)'));
  const hook = s.hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*');
  assert.match(hook.hooks[0].command, /\.claude\/hooks\/guard\.mjs/);
  for (const rule of s.permissions.allow as string[]) assert.ok(!isOrderTool(rule), rule);
});

test('the tool server Madav starts is the prebuilt one in the repository', () => {
  const m = json('.mcp.json');
  assert.deepEqual(m.mcpServers['trading-desk'].args, ['dist/desk-tools.mjs']);
  for (const f of ['dist/desk-tools.mjs', 'dist/robinhood.mjs']) assert.ok(fs.existsSync(f), `${f} is built and committed`);
});

test('the desk tool server offers the desk check, and no tool that trades', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const fake: typeof fetch = async () => new Response('{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date', { status: 200 });
  await deskServer(process.cwd(), fake).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'desk_check'));
  assert.ok(tools.every((t) => !isOrderTool(t.name)));
  const result = await client.callTool({ name: 'desk_check', arguments: {} }) as { content: Array<{ text: string }> };
  assert.match(result.content[0]!.text, /Trading Agents desk check/);
  await client.close();
});

test('the instructions every chat in this folder reads stay short', () => {
  assert.ok(fs.readFileSync('CLAUDE.md', 'utf8').split('\n').length <= 60);
});
