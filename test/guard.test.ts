import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isOrderTool, isPositionsRead } from '../src/robinhood/connect.js';

const GUARD = path.resolve('.claude/hooks/guard.mjs');
const guard = await import(pathToFileURL(GUARD).href) as { verdict: (call: unknown) => string | null; TRADE_WORDS: RegExp };
const mcp = (server: string, tool: string, input: unknown = {}) => ({ tool_name: `mcp__${server}__${tool}`, tool_input: input });

test('every tool of a broker connection is refused, reads included (fail closed)', () => {
  const servers = ['robinhood', 'rh-trading', 'claude_ai_Robinhood', 'alpaca', 'schwab', 'coinbase'];
  const tools = ['get_equity_positions', 'get_equity_quotes', 'place_equity_order', 'create_crypto_order', 'anything_new'];
  for (const s of servers) for (const t of tools) assert.match(guard.verdict(mcp(s, t)) ?? '', /never use a broker connection/, `${s} ${t}`);
});

test('a broker connection the person named anything is still known by its tools', () => {
  for (const t of ['get_equity_positions', 'get_portfolio', 'get_buying_power', 'list_crypto_holdings', 'get_positions']) {
    assert.match(guard.verdict(mcp('rh', t)) ?? '', /never use a broker connection/, t);
  }
});

test('a tool anywhere that speaks of trading or moving money is refused, however it is named', () => {
  for (const t of ['create_order', 'new_order', 'submitOrder', 'buy_stock', 'sell_shares', 'execute_trade', 'liquidate_all', 'close_position', 'transfer_funds', 'withdraw', 'make_payment']) {
    assert.match(guard.verdict(mcp('some-server', t)) ?? '', /never (place, change or cancel orders or move money|use a broker connection)/, t);
  }
});

test('the desk\'s own tools and Madav\'s tools pass', () => {
  for (const [s, t] of [['trading-desk', 'desk_check'], ['madav', 'publish_document'], ['madav', 'create_scheduled_task'], ['madav', 'browse_read'], ['madav', 'send_message']] as const) {
    assert.equal(guard.verdict(mcp(s, t)), null, `${s} ${t}`);
  }
});

test('an analysis of Robinhood\'s own stock can quote its address; no other tool may reach it, and the private folder is never named', () => {
  const text = { text: 'Robinhood Markets (HOOD) said on https://newsroom.robinhood.com/q3 that funded customers grew.' };
  assert.equal(guard.verdict(mcp('trading-desk', 'save_run_section', text)), null);
  for (const tool of ['WebFetch', 'Bash', 'mcp__madav__browse_read']) assert.match(guard.verdict({ tool_name: tool, tool_input: { url: 'https://robinhood.com/stocks/HOOD' } }) ?? '', /never open Robinhood's site/, tool);
  assert.match(guard.verdict(mcp('trading-desk', 'save_run_section', { text: 'see ~/.trading-agents/robinhood.json' })) ?? '', /private to them/);
  assert.match(guard.verdict(mcp('trading-desk', 'save_run_section', { text: 'the refresh_token is' })) ?? '', /private to them/);
});

test('the guard and the Robinhood client name trading tools the same way', () => {
  for (const t of ['place_equity_order', 'review_equity_order', 'create_crypto_order', 'get_equity_positions', 'get_equity_quotes', 'buy', 'list_accounts']) {
    assert.equal(guard.TRADE_WORDS.test(t), isOrderTool(t), t);
  }
  assert.equal(isPositionsRead('get_equity_positions'), true);
  assert.equal(isPositionsRead('close_position'), false);
  assert.equal(isPositionsRead('place_position_order'), false);
});

test('the private sign-in folder, its file and its contents are refused to every tool', () => {
  const refused = [
    { tool_name: 'Bash', tool_input: { command: 'cat ~/.trading-agents/robinhood.json' } },
    { tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\ann\\.trading-agents\\robinhood.json' } },
    { tool_name: 'Grep', tool_input: { pattern: 'refresh_token', path: '/home/ann' } },
    { tool_name: 'Bash', tool_input: { command: 'find ~ -name robinhood.json' } },
    { tool_name: 'Bash', tool_input: { command: 'echo $TRADING_AGENTS_HOME' } },
    { tool_name: 'Glob', tool_input: { pattern: '**/.trading-agents/*' } },
  ];
  for (const call of refused) assert.match(guard.verdict(call) ?? '', /private to them/, JSON.stringify(call));
});

test('agents never open Robinhood\'s site', () => {
  assert.match(guard.verdict(mcp('madav', 'navigate', { url: 'https://robinhood.com/stocks/NVDA' })) ?? '', /never open Robinhood/);
  assert.match(guard.verdict({ tool_name: 'Bash', tool_input: { command: 'curl https://agent.robinhood.com/mcp/trading' } }) ?? '', /never open Robinhood/);
});

test('agents never reach the dashboard: its address, its order ticket or its trading switch, by shell, fetch or browser', () => {
  const refused = [
    { tool_name: 'Bash', tool_input: { command: 'curl -s http://127.0.0.1:47615/api/state' } },
    { tool_name: 'Bash', tool_input: { command: 'node -e "fetch(\'http://localhost:47625/\')"' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Invoke-WebRequest http://[::1]:47619/' } },
    { tool_name: 'WebFetch', tool_input: { url: 'http://localhost:47620/api/ticket/place' } },
    { tool_name: 'Bash', tool_input: { command: 'curl -X POST http://some-host/api/trading -d on=true' } },
    mcp('madav', 'navigate', { url: 'http://127.0.0.1:47616/' }),
  ];
  for (const call of refused) assert.match(guard.verdict(call) ?? '', /never use the Trading Agents dashboard/, JSON.stringify(call));
  const passing = [
    { tool_name: 'Bash', tool_input: { command: 'node dist/terminal.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'curl http://127.0.0.1:47660/' } },                     // another port
    { tool_name: 'Edit', tool_input: { file_path: 'src/terminal/server.ts', new_string: "p === '/api/ticket/place'" } },   // the editor cannot reach a web address
    mcp('trading-desk', 'save_run_section', { text: 'the desk is at http://127.0.0.1:47615/' }),
  ];
  for (const call of passing) assert.equal(guard.verdict(call), null, JSON.stringify(call));
});

test('ordinary work in the repository passes', () => {
  const allowed = [
    { tool_name: 'Read', tool_input: { file_path: '/home/ann/trading-agents/desk-data/journal.md' } },
    { tool_name: 'Bash', tool_input: { command: 'node dist/robinhood.mjs connect' } },
    { tool_name: 'Bash', tool_input: { command: 'cd ~/code/trading-agents && git status' } },
  ];
  for (const call of allowed) assert.equal(guard.verdict(call), null, JSON.stringify(call));
});

test('as a hook it answers Claude Code with a deny, and with nothing when the call may pass', () => {
  const run = (call: unknown) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(call), encoding: 'utf8' });
  const denied = run(mcp('robinhood', 'place_equity_order', { symbol: 'NVDA' }));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout) as { hookSpecificOutput: { permissionDecision: string; hookEventName: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  const passed = run(mcp('trading-desk', 'desk_check'));
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, '');
  assert.equal(run('not json').stdout, '');
});
