#!/usr/bin/env node
// The guard: Claude Code runs it before every tool call in this folder (.claude/settings.json, PreToolUse). Whatever an
// agent was told or read, it refuses:
//   1. every tool of a broker connection (Robinhood's or any other), known by its name or by its tools (equities,
//      positions, portfolio, buying power): agents in this folder never use one - only the person's dashboard talks
//      to Robinhood, and only the person's Confirm sends an order;
//   2. any other tool whose name speaks of trading or moving money (orders, trades, buying, selling, transfers);
//   3. anything that names the person's private Trading Agents folder, its sign-in file or what is in it, or Robinhood's
//      own site.
// It fails closed on broker connections and is defence in depth. It is a spelling check: it knows the private folder, the
// dashboard and a broker by how they are written, including the disguises below (a wildcard, a Windows short name, a word
// split by quotes, a port in a variable), but a program set on it can always spell them another way. The real wall is
// the permission prompts: agents here have no free shell or file access without the person's own approval
// (.claude/settings.json pre-approves only a few of the desk's own commands, never the dashboard's start, which prints a
// one-time link to its key), and the desk's agents are given only the desk's tools. TRADE_WORDS is the same rule as
// isOrderTool in src/robinhood/connect.ts (a test keeps them in step).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWN_SERVERS = new Set(['trading-desk']);
export const BROKER_SERVER = /robinhood|broker|trading|alpaca|schwab|ibkr|interactive.?brokers|e-?trade|fidelity|webull|tradier|tastytrade|tastyworks|coinbase|kraken|binance|public-?com/i;
/** A broker connection known by its tools, whatever the person named it: equities, positions, a portfolio, buying power,
 *  its accounts (whose numbers it gives). */
export const BROKER_TOOL = /equit(y|ies)|position|portfolio|buying.?power|brokerage|crypto|holding|(?:^|[^a-z])accounts?(?![a-z])/i;
export const TRADE_WORDS = /order|trade|buy|sell|liquidat|close.?position|transfer|withdraw|deposit|payment/i;
export const PRIVATE = /\.trading-agents|robinhood\.json|TRADING_AGENTS_HOME|access_token|refresh_token|code_verifier/i;
export const BROKER_SITE = /robinhood\.com/i;

const NO_BROKER = 'Agents in this folder never use a broker connection. Only the person\'s dashboard talks to Robinhood, and only their Confirm sends an order.';
const NO_TRADE = 'Agents never place, change or cancel orders or move money. The person does that in the Trading Agents dashboard, after reviewing and confirming the exact order.';
const NO_PRIVATE = 'The ~/.trading-agents folder holds the person\'s Robinhood sign-in and is private to them. Agents never open, search, read, copy or change it.';
const NO_SITE = 'Agents never open Robinhood\'s site or connection. The person trades in the Trading Agents dashboard.';
/** The dashboard's own address (this computer, ports 47615 to 47625) and its order ticket and trading switch: the
 *  person's alone. Refused to every tool that could reach a web address (a shell, a fetch, a browser), not to the editor. */
export const DASHBOARD = /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):476(?:1[5-9]|2[0-5])\b|\/api\/(?:ticket|trading)\b/i;
export const REACHES_WEB = /^(?:Bash|PowerShell|WebFetch|WebSearch)$|^mcp__/;
const NO_DASHBOARD = 'Agents never use the Trading Agents dashboard\'s address, its order ticket or its trading switch. Only the person uses the dashboard, and only their Confirm sends an order.';

// ---------- the disguises, checked in what a shell or another program's tool is given ----------
/** The private folder's name, put together here so that this file never spells it. */
const FOLDER = ['.trading', 'agents'].join('-');
/** A Windows short (8.3) name the private folder can have: TRADIN~1, or TR and four letters or digits, then ~1. */
export const SHORT_NAME = /(?:^|[^a-z0-9])tr[a-z0-9]{0,4}~\d/i;
/** A home folder written just before a path part: ~/, $HOME/, %USERPROFILE%\, C:\Users\name\, /home/name/, /Users/name/. */
const HOME_AT = /(?:^|[\s=(:,])(?:~|\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOMEPATH%|[a-z]:[\\/]+users[\\/]+[^\\/\s]+|\/(?:home|Users)\/[^/\s]+)[\\/]+$/i;
/** The dashboard however its address is written: a port in a variable, any address on its ports, any /api/ path on this computer. */
const DASHBOARD_TOO = /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(?!\d)|(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::[^/\s]*)?\/api\/|:476(?:1[5-9]|2[0-5])\b/i;

/** Every piece of text a tool is given. */
const texts = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []);
/** A command's words as a shell or a script puts them together: quotes that only split a word, and a + between two quoted
 *  parts, are taken out ('.tra' + 'ding', "tra""ding"). */
export const joined = (s) => s.replace(/(["'])\s*\+\s*(["'])/g, '').replace(/["'`^]/g, '');
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a wildcard path part (".t*", "*agents*", "*") could stand for the private folder's name. */
function couldName(part) {
  let re = '';
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && part.indexOf(']', i + 2) > 0) { const end = part.indexOf(']', i + 2); re += `[${part.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
    else if (c === '{' && part.indexOf('}', i) > 0) { const end = part.indexOf('}', i); re += `(?:${part.slice(i + 1, end).split(',').map(escaped).join('|')})`; i = end; }
    else re += escaped(c);
  }
  try { return new RegExp(`^${re}$`, 'i').test(FOLDER); } catch { return true; }
}
/** A wildcard that could reach the private folder: one with letters of its name (".t*", "*agents"), anywhere; a bare one
 *  ("*", ".*") only right under a home folder. */
function wildcardPrivate(text) {
  for (const m of text.matchAll(/[^\\/\s=;|&<>(),]*[*?[{][^\\/\s=;|&<>(),]*/g)) {
    const part = m[0], letters = part.replace(/\[[^\]]*\]|\{[^}]*\}|[*?]/g, '');
    if (couldName(part) && (letters.length >= 2 || HOME_AT.test(text.slice(0, m.index)))) return true;
  }
  return false;
}

/** A path as the computer knows it: a link or a short Windows name (like TRADIN~1) is followed to the real, long one, so a
 *  disguised name is seen for what it is. A part that does not exist yet is kept as written. */
export function realPath(p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, String(p));
  for (let at = abs; ; at = path.dirname(at)) {
    try { return path.join(fs.realpathSync.native(at), path.relative(at, abs)); } catch { /* not there: try the folder above */ }
    if (path.dirname(at) === at) return abs;
  }
}
const folded = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** Whether `child` is `parent` or inside it. */
export const within = (child, parent) => { const rel = path.relative(folded(parent), folded(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const FILE_TOOLS = /^(?:Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS)$/;
const WILD = /[*?[\]{}]/;
/** Where a file search starts: its path, else the fixed part of an absolute pattern, else the folder it runs in. */
function searchRoot(input, cwd) {
  if (input.path) return realPath(input.path, cwd);
  const pattern = String(input.pattern ?? '');
  if (path.isAbsolute(pattern)) { const fixed = pattern.split(/[\\/]/); const cut = fixed.findIndex((s) => WILD.test(s)); return realPath(cut < 0 ? pattern : fixed.slice(0, cut).join(path.sep) || path.sep, cwd); }
  return realPath(cwd, cwd);
}
const NO_HOME_SEARCH = 'Agents never search the whole home folder or above it: the person\'s private sign-in folder is there. Search inside the project instead.';

/** The refusal for a file tool: a path that is really the private folder (however it is spelled), or a search that
 *  starts at the home folder or above it, where a wildcard could reach the private folder. */
function fileVerdict(name, input, cwd) {
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string' && PRIVATE.test(realPath(input[key], cwd))) return NO_PRIVATE;
  if ((name === 'Glob' || name === 'Grep' || name === 'LS') && within(realPath(os.homedir(), cwd), searchRoot(input, cwd))) return NO_HOME_SEARCH;
  return null;
}

/** The refusal for one tool call, or null to let it pass. */
export function verdict(call) {
  const name = String(call?.tool_name ?? '');
  if (FILE_TOOLS.test(name)) { const r = fileVerdict(name, call?.tool_input ?? {}, String(call?.cwd ?? process.cwd())); if (r) return r; }
  let own = false;
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const tool = rest.join('__');
    own = OWN_SERVERS.has(server);
    if (!own) {
      if (BROKER_SERVER.test(server) || BROKER_TOOL.test(tool)) return NO_BROKER;
      if (TRADE_WORDS.test(tool)) return NO_TRADE;
    }
  }
  const input = JSON.stringify(call?.tool_input ?? {});
  if (PRIVATE.test(input)) return NO_PRIVATE;
  // A shell, a fetch or another program's tool: its words are also read as put together, for the disguises above.
  const words = !own && REACHES_WEB.test(name) ? texts(call?.tool_input ?? {}).map(joined) : [];
  if (words.some((w) => PRIVATE.test(w) || SHORT_NAME.test(w) || wildcardPrivate(w))) return NO_PRIVATE;
  // The desk's own tools cannot open a site, so Robinhood's address in their text is data (an analysis of Robinhood's
  // own stock quotes its news links); every other tool is refused it, since it might open the page.
  if (!own && BROKER_SITE.test(input)) return NO_SITE;
  if (!own && REACHES_WEB.test(name) && (DASHBOARD.test(input) || words.some((w) => DASHBOARD.test(w) || DASHBOARD_TOO.test(w)))) return NO_DASHBOARD;
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
