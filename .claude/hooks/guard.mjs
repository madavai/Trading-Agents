#!/usr/bin/env node
// The guard: Claude Code runs it before every tool call in this folder (.claude/settings.json, PreToolUse). Whatever an
// agent was told or read, it refuses:
//   1. every tool of a broker connection (Robinhood's or any other), known by its name or by its tools (equities,
//      positions, portfolio, buying power): agents in this folder never use one - only the person's dashboard talks
//      to Robinhood, and only the person's Confirm sends an order;
//   2. any other tool whose name speaks of trading or moving money (orders, trades, buying, selling, transfers);
//   3. anything that names the person's private Trading Agents folder, its sign-in file or what is in it, or Robinhood's
//      own site.
// It fails closed on broker connections and is defence in depth: the main protection is that agents here have no free
// shell or file access to the home folder without the person's own approval (.claude/settings.json), and the desk's
// agents are given only the desk's tools. TRADE_WORDS is the same rule as isOrderTool in src/robinhood/connect.ts (a
// test keeps them in step).

export const OWN_SERVERS = new Set(['trading-desk']);
export const BROKER_SERVER = /robinhood|broker|trading|alpaca|schwab|ibkr|interactive.?brokers|e-?trade|fidelity|webull|tradier|tastytrade|tastyworks|coinbase|kraken|binance|public-?com/i;
/** A broker connection known by its tools, whatever the person named it: equities, positions, a portfolio, buying power. */
export const BROKER_TOOL = /equit(y|ies)|position|portfolio|buying.?power|brokerage|crypto|holding/i;
export const TRADE_WORDS = /order|trade|buy|sell|liquidat|close.?position|transfer|withdraw|deposit|payment/i;
export const PRIVATE = /\.trading-agents|robinhood\.json|TRADING_AGENTS_HOME|access_token|refresh_token|code_verifier/i;
export const BROKER_SITE = /robinhood\.com/i;

const NO_BROKER = 'Agents in this folder never use a broker connection. Only the person\'s dashboard talks to Robinhood, and only their Confirm sends an order.';
const NO_TRADE = 'Agents never place, change or cancel orders or move money. The person does that in the Trading Agents dashboard, after reviewing and confirming the exact order.';
const NO_PRIVATE = 'The ~/.trading-agents folder holds the person\'s Robinhood sign-in and is private to them. Agents never open, search, read, copy or change it.';
const NO_SITE = 'Agents never open Robinhood\'s site or connection. The person trades in the Trading Agents dashboard.';

/** The refusal for one tool call, or null to let it pass. */
export function verdict(call) {
  const name = String(call?.tool_name ?? '');
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const tool = rest.join('__');
    if (!OWN_SERVERS.has(server)) {
      if (BROKER_SERVER.test(server) || BROKER_TOOL.test(tool)) return NO_BROKER;
      if (TRADE_WORDS.test(tool)) return NO_TRADE;
    }
  }
  const input = JSON.stringify(call?.tool_input ?? {});
  if (PRIVATE.test(input)) return NO_PRIVATE;
  if (BROKER_SITE.test(input)) return NO_SITE;
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

if (process.argv[1]?.endsWith('guard.mjs')) await main();
