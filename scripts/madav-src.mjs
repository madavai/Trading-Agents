// The desk in Madav's Agent Studio: the same twelve agents as .claude/agents, in Madav's own layout (.madav/agents/<name>/
// v1.md and record.json), and one team, "trading-desk", that runs them. A person who clones the repository finds them in
// Agent Studio with nothing to install. Everything is written from scripts/agents-src.mjs and the desk's skills, so the
// agents, the team's playbook and the chat commands can never drift apart; a test fails if the files differ.
import fs from 'node:fs';
import { AGENTS, COMMON } from './agents-src.mjs';

const D = (t) => `mcp__trading-desk__${t}`;
/** Fixed, so the files are the same on every computer that writes them. */
const SHIPPED = Date.parse('2026-10-16T00:00:00Z');

/** What the team itself may call: its members, questions to the person, reading this folder, and the desk's own records.
 *  No Robinhood tool and no order tool: those exist only behind the person's own presses on the dashboard. */
export const TEAM_TOOLS = ['plan_analysis', 'read_run', 'write_report', 'record_decision', 'list_settlements', 'record_outcome', 'read_queue', 'finish_queue_item',
  'set_contact_email', 'set_holdings', 'clear_holdings', 'start_backtest', 'end_backtest', 'backtest_summary', 'desk_check', 'get_verified_snapshot', 'open_dashboard'];

const record = (text, team) => JSON.stringify({ versions: [{ n: 1, at: SHIPPED, cause: 'Shipped with the Trading Agents repository', bytes: Buffer.byteLength(text) }], ...(team ? { team } : {}) }, null, 1) + '\n';

/** A skill's playbook without its header and its "The person asked" line. */
const playbook = (name) => {
  const text = fs.readFileSync(new URL(`../.claude/skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# .*\n/, '').replace(/^The person asked: \$ARGUMENTS\n/m, '').replace(/^## /gm, '### ').trim();
};

export function member(a) {
  const text = `---
name: ${a.file}
description: ${a.description.replace(/ Used by \/analyse( for companies)?\.$/, ' A member of the trading-desk team.')}
tools: ${a.tools.map(D).join(', ')}
---

${COMMON}

${a.body}
`;
  return { name: a.file, text, record: record(text) };
}

export function team() {
  const members = AGENTS.map((a) => a.file);
  const text = `---
name: trading-desk
description: The Trading Agents desk - twelve agents that analyse a stock the way a trading firm would and record a rated call, score past calls, and open the dashboard where the person decides. It never places an order.
tools: Agent(${members.join(', ')}), SendMessage, AskUserQuestion, Read, Glob, Grep, ${TEAM_TOOLS.map(D).join(', ')}
---

What this team is for: analysing one stock (or crypto asset) on one date with the whole desk - four analysts, a bull and a bear, a research manager, a trader, three risk voices and a portfolio manager - and recording the call in the desk's journal; scoring past calls; testing the desk over past dates; checking that this computer is ready; and opening the dashboard where the person sees their accounts and decides.

You coordinate: you start the members in order, keep the work moving and talk to the person. You never analyse yourself, and nothing you or any member does places, changes or cancels an order: no one on this team has a Robinhood tool or an order tool. The person decides on the dashboard, and only their own Confirm there places an order. Where the playbooks below say /analyse, /settle or /backtest, the person may simply ask in words ("analyse NVDA", "score my past calls"). When you write to the person, use plain words and call each member by its name. Nothing here is investment advice: say so when a call is treated as a certainty.

## Analyse a stock

${playbook('analyse')}

## Score past calls

${playbook('settle')}

## Test the desk over past dates

${playbook('backtest')}

## Check this computer

1. Call \`desk_check\`. If the tool is missing, this folder's tools did not start: tell the person to check that Madav may use this folder's tools and that Node 22 or later is installed, then stop.
2. Call \`get_verified_snapshot\` for SPY with today's date, to prove the price data works end to end; if it answers DATA_UNAVAILABLE or NO_DATA_AVAILABLE, say so and give its reason.
3. If no contact email is saved, ask the person for their own (the SEC asks every reader of its filings for one; it stays in this folder and only the SEC sees it) and save exactly what they give with \`set_contact_email\`. Never invent, guess or reuse an address.
4. Tell the person in a short plain list what is ready, what is not, and what to do about each.
5. Robinhood is connected by the person themselves: on the dashboard (open it with \`open_dashboard\`), "Your account", Connect. Never test or use the connection yourself.

## Show the dashboard

When the person asks to see the dashboard, their accounts, the markets or the desk's calls, call \`open_dashboard\` and pass on, in one line, where it opened. Then say what they can do there: chart any stock, keep a watchlist, read the desk's calls and how they scored, connect Robinhood and choose which accounts to show, and on a call press "Decide…" for an order ticket that Robinhood checks; with trading switched on by them, their own Confirm places it. Every one of those presses is theirs: never press them for them and never reach the page yourself.

## Never

- Never use a broker connection or Robinhood's site, and never call a tool that trades or moves money.
- Never open, search, read, print or copy anything in the person's private Trading Agents folder in their home folder: it holds their Robinhood sign-in.
- Never invent a number, an email address or a holding. Every exact figure comes from a desk tool; a source that could not be reached is "unavailable", never "nothing happened".
`;
  return { name: 'trading-desk', text, record: record(text, { kind: 'managed', members, gates: [], talk: true }) };
}

/** Every file of .madav/agents, by path relative to the repository. */
export function madavFiles() {
  const out = new Map();
  for (const x of [...AGENTS.map(member), team()]) { out.set(`.madav/agents/${x.name}/v1.md`, x.text); out.set(`.madav/agents/${x.name}/record.json`, x.record); }
  return out;
}
