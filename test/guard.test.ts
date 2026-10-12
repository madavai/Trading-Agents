import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isOrderTool } from '../src/robinhood/connect.js';

const GUARD = path.resolve('.claude/hooks/guard.mjs');
const guard = await import(pathToFileURL(GUARD).href) as { verdict: (call: unknown) => string | null; ORDER_TOOL: RegExp };

const ORDER_TOOLS = ['place_equity_order', 'place_option_order', 'cancel_order', 'cancel_equity_order', 'submitOrder', 'replace_order', 'modify-order', 'order_place', 'execute_order'];
const OTHER_TOOLS = ['get_equity_positions', 'get_equity_quotes', 'review_equity_order', 'get_orders', 'list_order_history', 'desk_check', 'get_account'];

test('every order tool on any broker connection is refused', () => {
  for (const t of ORDER_TOOLS) {
    for (const server of ['robinhood', 'rh-trading', 'alpaca']) {
      assert.match(guard.verdict({ tool_name: `mcp__${server}__${t}`, tool_input: {} }) ?? '', /never place, change or cancel orders/, `${server} ${t}`);
    }
  }
});

test('reading, quoting and reviewing pass', () => {
  for (const t of OTHER_TOOLS) assert.equal(guard.verdict({ tool_name: `mcp__robinhood__${t}`, tool_input: {} }), null, t);
});

test('the guard and the Robinhood client name order tools the same way', () => {
  for (const t of [...ORDER_TOOLS, ...OTHER_TOOLS]) assert.equal(guard.ORDER_TOOL.test(t), isOrderTool(t), t);
});

test('the private sign-in folder is refused to every tool, the repository folder is not', () => {
  const refused = [
    { tool_name: 'Bash', tool_input: { command: 'cat ~/.trading-agents/robinhood.json' } },
    { tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\ann\\.trading-agents\\robinhood.json' } },
    { tool_name: 'Grep', tool_input: { pattern: 'token', path: '/home/ann/.trading-agents' } },
    { tool_name: 'Bash', tool_input: { command: 'ls "$HOME/.trading-agents"' } },
  ];
  for (const call of refused) assert.match(guard.verdict(call) ?? '', /private to them/, JSON.stringify(call));
  const allowed = [
    { tool_name: 'Read', tool_input: { file_path: '/home/ann/trading-agents/desk-data/journal.md' } },
    { tool_name: 'Bash', tool_input: { command: 'node dist/robinhood.mjs connect' } },
    { tool_name: 'Bash', tool_input: { command: 'cd ~/code/trading-agents && git status' } },
  ];
  for (const call of allowed) assert.equal(guard.verdict(call), null, JSON.stringify(call));
});

test('as a hook it answers Claude Code with a deny, and with nothing when the call may pass', () => {
  const run = (call: unknown) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(call), encoding: 'utf8' });
  const denied = run({ tool_name: 'mcp__robinhood__place_equity_order', tool_input: { symbol: 'NVDA' } });
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout) as { hookSpecificOutput: { permissionDecision: string; hookEventName: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  const passed = run({ tool_name: 'mcp__trading-desk__desk_check', tool_input: {} });
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, '');
  assert.equal(run('not json').stdout, '');
});
