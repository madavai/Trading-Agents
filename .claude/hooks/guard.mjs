#!/usr/bin/env node
// The guard: Claude Code runs it before every tool call in this folder (.claude/settings.json, PreToolUse). It refuses
// two things, whatever an agent was told or read:
//   1. any tool that places, changes or cancels an order, on any broker connection - orders come only from the person's
//      Confirm in the dashboard;
//   2. anything that touches the person's own Trading Agents folder (~/.trading-agents), where the Robinhood sign-in is.
// Everything else passes untouched. The order rule is the same as isOrderTool in src/robinhood/connect.ts (a test keeps
// them in step).

export const ORDER_TOOL = /(place|submit|cancel|replace|modify|amend|send|execute)[\w-]*order|order[\w-]*(place|submit|cancel|replace|modify|amend|send|execute)/i;
export const PRIVATE_FOLDER = /(^|[\\/~"'\s=:])\.trading-agents([\\/"'\s]|$)/;

/** The refusal for one tool call, or null to let it pass. */
export function verdict(call) {
  const name = String(call?.tool_name ?? '');
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join('__');
    if (ORDER_TOOL.test(tool)) return 'Agents never place, change or cancel orders. The person does that in the Trading Agents dashboard, after reviewing and confirming the exact order.';
  }
  if (PRIVATE_FOLDER.test(JSON.stringify(call?.tool_input ?? {}))) {
    return 'The ~/.trading-agents folder holds the person\'s Robinhood sign-in and is private to them. Agents never open, read, copy or change it.';
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let call;
  try { call = JSON.parse(raw); } catch { return; }
  const reason = verdict(call);
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('guard.mjs')) await main();
