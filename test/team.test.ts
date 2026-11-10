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
import { teamVersionOf } from '../src/desk/agent-files.js';

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
  // the thirteen, and the trading-desk team for Madav's Agent Studio with its line-up (agent-studio.test.ts)
  assert.deepEqual(fs.readdirSync('.claude/agents').sort(), [...src.AGENTS.map((a) => `${a.file}.md`), 'trading-desk.md', 'trading-desk.team.json'].sort());
});

test('the team is the original\'s twelve and a fact checker, one agent for each step the plan can ask for', () => {
  assert.equal(src.AGENTS.length, 13);
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

test('the agents who size or decide read the holdings from the desk, never from the lead\'s request (round 1: "Holdings: not provided")', () => {
  const readers = ['trader', 'aggressive-risk-analyst', 'conservative-risk-analyst', 'neutral-risk-analyst', 'portfolio-manager'];
  for (const agent of src.AGENTS) {
    const { text } = front(agent.file), reads = readers.includes(agent.file);
    assert.equal(/read_run \(sections [^)]*\bholdings\b/.test(text), reads, `${agent.file} ${reads ? 'does not read' : 'reads'} section holdings`);
    assert.equal(text.includes('What the person holds is in section holdings of read_run'), reads, agent.file);
    assert.doesNotMatch(text, /The request gives what the person holds/, `${agent.file} still expects the lead to pass the holdings`);
    if (reads) assert.match(text, /never say they were not provided\. When it says none are saved, say that, and never assume a flat book/, agent.file);
  }
  // the trader opens with what it sized to, so every saved run shows it; the portfolio manager reads the lessons too
  assert.match(front('trader').text, /Start your work with one line, "Holdings: ", saying in a few words what section holdings gives/);
  assert.match(front('portfolio-manager').text, /read_run \(sections research_plan, trader, risk_debate, holdings, lessons\)/);
  // the research manager plans against a standard allocation: the position is the trader's and the portfolio manager's
  assert.match(front('research-manager').text, /You do not see the person's holdings/);
  // and the lead is never asked to copy them into a request
  for (const file of ['.claude/skills/analyse/SKILL.md', '.claude/agents/trading-desk.md']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /holdings block|word for word\. \|/, `${file} still relays the holdings`);
    assert.match(text, /read what the person holds, and the portfolio manager the lessons, from the desk \(`read_run`\)/, file);
  }
});

// Debate speed (9 Nov 2026): the real NVDA run spent 112 minutes on six bull and bear turns, about two steps for every
// sum in their words. A figure a fact-checked report gives is quoted, not looked up or worked out again; a new one still
// needs a desk tool, all of a turn's sums go in one call, the price facts are read once, and the run is read in one call.
test('after the fact check a checked figure is quoted with whose it is, and only a new one goes to a desk tool, all in one call', () => {
  const after = ['bull-researcher', 'bear-researcher', 'research-manager', 'trader', 'aggressive-risk-analyst', 'conservative-risk-analyst', 'neutral-risk-analyst', 'portfolio-manager'];
  for (const agent of src.AGENTS) {
    const { text } = front(agent.file), checked = after.includes(agent.file);
    assert.equal(text.includes('quote it exactly as the report gives it, with whose it is, and do not look it up or work it out again'), checked, agent.file);
    if (!checked) continue;
    assert.match(text, /A desk tool is needed only for a new figure: one of your own, or one from another agent that no report gives \(work it out again with the others, in your one call\)\. A claim section fact_check lists as not checked is the analyst's alone: say so when you lean on it\./, agent.file);
    assert.match(text, /a mark \[corrected: was "\.\.\."\] is its correction, so use the corrected words/, agent.file);
  }
  // the 7 Nov rules stay whole: no number from memory, every sum by the calculator, every streak or record from the price facts
  for (const rule of ['never from memory and never estimated', 'never do arithmetic in your head', 'come only from get_price_facts, quoted with the window it names; never count them by eye in a table',
    'work them all out in one call (up to 40); call it again only for one you could not foresee, never once for each figure',
    'Before you repeat such a claim from another agent, check it there, unless an analyst\'s report the fact checker has already checked gives it; when the tool disagrees, say so and use the tool\'s',
    'One answer of get_price_facts holds every such fact for its symbol: call it once, never again for each claim',
    'ask for every section you need in one call and read each part of its answer once, in order; never read a section twice']) assert.ok(src.COMMON.includes(rule), rule);
  // the debaters and the managers read everything they need in one call, the fact check with it
  const reads: Array<[string, string]> = [['bull-researcher', 'market, sentiment, news, fundamentals, fact_check and investment_debate'], ['bear-researcher', 'market, sentiment, news, fundamentals, fact_check and investment_debate'],
    ['research-manager', 'investment_debate, market, sentiment, news, fundamentals and fact_check'], ['neutral-risk-analyst', 'trader, market, sentiment, news, fundamentals, fact_check, holdings, risk_debate']];
  for (const [file, sections] of reads) {
    assert.ok(front(file).text.includes(`with read_run (sections ${sections}), in one call`), file);
  }
});

test('every agent carries the desk\'s rules and saves the section the plan expects', () => {
  for (const agent of src.AGENTS) {
    const { text } = front(agent.file);
    assert.ok(text.includes(src.COMMON), agent.file);
    for (const rule of ['never from memory and never estimated', 'Never place, change or cancel an order', 'Nothing here is investment advice', 'save your work with save_run_section']) assert.ok(text.includes(rule), `${agent.file}: ${rule}`);
    assert.match(agent.body, new RegExp(`section "${agent.section}"`), agent.file);
  }
});

test('the team talks only with a reason: analysts tell each other what to weigh (at most two, noted in their report), anyone stuck asks the lead, and the lead answers without a figure', () => {
  const s = src as unknown as { ANALYST_TALK: string; ANALYSTS: string[] };
  assert.deepEqual(s.ANALYSTS, ['market-analyst', 'sentiment-analyst', 'news-analyst', 'fundamentals-analyst']);
  for (const agent of src.AGENTS) {
    const { text } = front(agent.file), analyst = s.ANALYSTS.includes(agent.file);
    assert.equal(text.includes(s.ANALYST_TALK), analyst, `${agent.file}: only the analysts, who read at the same time, are given reasons to message each other`);
    assert.match(text, /If you are stuck .* do not guess: ask the lead, the agent that started you, one short question with SendMessage, write the same question into your work/, agent.file);
    assert.match(text, /Never send a message without a purpose: no greetings, progress reports or summaries/, agent.file);
    assert.match(text, /If you have no SendMessage tool, the team does not talk in this run/, `${agent.file}: with the talk switch off, silence`);
  }
  for (const rule of ['At most two in this run', 'never carries a figure of your own', 'Only to an analyst the request names', 'under "Told the other analysts"', 'say in one line of your report what you did with it']) assert.ok(s.ANALYST_TALK.includes(rule), rule);
  const lead = front('trading-desk').text;
  assert.match(lead, /## When a member asks you\n\nA member may message you while it works, when it is stuck/);
  assert.match(lead, /never with a figure of your own: figures come only from desk tools/);
  assert.match(lead, /name in each request the analysts working in this run, so they can tell each other what to weigh/, 'the lead names who is reading, so analysts know whom to tell');
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

test('the lead never resets unasked, never stands one tool in for another, and never goes round in a loop (7 Nov: "Re-check the lessons" became dozens of resets)', () => {
  const lead = front('trading-desk').text;
  const loop = /\n## Never go round in a loop\n\n([\s\S]*?)\n\n## /.exec(lead)?.[1] ?? '';
  for (const rule of [
    'When the person asks for something no part below covers, never use another tool in its place: say in one plain line that this conversation has no step for it, and that if the desk was updated since this conversation began, a new conversation in Madav has the newer steps.',
    '- If a step names a tool you do not have, stop and tell the person in one plain line that this conversation started before the desk was updated, and that they should start a new conversation in Madav. Never use another tool in its place.',
    '- If a desk answer starts with DESK UPDATED, tell the person in one plain line to start a new conversation in Madav, and start nothing new here.',
    '- If the same tool gives the same answer twice in a row, stop and tell the person what happened. Never go round in a loop.',
  ]) assert.ok(loop.includes(rule), rule);
  assert.ok(lead.indexOf('## Never go round in a loop') < lead.indexOf('## Run a routine'), 'read before every playbook');

  const reset = /\n## Reset the team\n\n([\s\S]*?)\n\n## /.exec(lead)?.[1] ?? '';
  assert.match(reset, /^Only when the person asked in words, in this conversation, for the team to be reset or put back as the project ships it, or said yes to your offer after the desk check\. Never call `reset_team` in place of any other request/);
  assert.match(reset, /2\. Only on their yes, call `reset_team` once, with confirmed set to true/);
  assert.match(reset, /3\. If it answers ALREADY RESET or "Not reset", never call it again: tell the person in one line what it says\./);
  const check = /\n## Check this computer\n\n([\s\S]*?)\n\n## /.exec(lead)?.[1] ?? '';
  assert.match(check, /^These are your steps whenever the person asks to check this computer \(or types \/desk-check\); where any other desk-check steps differ, follow these\.\n\n1\. Call `desk_check` with team_version "[0-9a-f]{8}", copied exactly: it is the version of these steps, so the desk can tell whether this conversation began before the desk was updated, and the check compares nothing without it\. If its answer starts with TEAM VERSION NEEDED, call `desk_check` once more with the team_version this step gives and go on with that answer; never a third time\./);
  assert.match(check, /If the check starts with DESK UPDATED, or says this conversation's steps for the team are not the ones in this folder, say that first, in one line: this conversation began before the desk was updated, so they should start a new conversation in Madav and check this computer there\. Offer no reset in this conversation\./);

  // every member stops too, and the Claude Code desk check
  for (const agent of src.AGENTS) assert.match(front(agent.file).text, /If the same tool gives you the same answer twice in a row, do not call it a third time: note in your work what happened and go on with what you can\. Never go round in a loop\. If a desk answer starts with DESK UPDATED, end your one-line reply to the lead with the words "DESK UPDATED"\./, agent.file);
  const deskCheck = fs.readFileSync('.claude/skills/desk-check/SKILL.md', 'utf8');
  assert.match(deskCheck, /If it starts with DESK UPDATED, .*offer no reset in this one/);
  assert.match(deskCheck, /call the desk's `reset_team` tool once .*if it answers ALREADY RESET or "Not reset", never call it again/);
  const recheck = fs.readFileSync('.claude/skills/recheck-lessons/SKILL.md', 'utf8');
  assert.match(recheck, /if it answers LEFT, it has refused that lesson twice: leave it, go on with the next, and name it at the end\. If it answers STOP for a lesson, it was sent again after it was left: leave it too, and never send it again in this re-check\. If `recheck_lessons` answers STOP, .*stop at once, call neither tool again, and tell the person what it says\./);
});

test('scoring never goes round in a loop either: a call record_outcome answers LEFT or STOP for is left pending, the team goes on, and names it at the end with why (8 Nov: the desk began refusing lessons of more than four sentences)', () => {
  const settle = fs.readFileSync('.claude/skills/settle/SKILL.md', 'utf8'), lead = front('trading-desk').text;
  const step = /If `record_outcome` refuses a lesson \(INPUT_ERROR\), correct what it says once and send it again: a lesson with too many sentences is refused with how the desk counts them and where it cut\. If it answers LEFT, it has failed to settle that call twice: leave it, go on with the next READY call, and name it at the end with the reason it gave\. If it answers STOP for a call, it was sent again after it was left: leave it too, and never send it again in this scoring\. A call `list_settlements` shows as LEFT is left the same way\. A call left stays pending and unscored, with no lesson; a later scoring, started an hour or more after `record_outcome` was last used, tries it again\./;
  assert.match(settle, step);
  assert.match(settle, /each call left \(date, ticker, the reason `record_outcome` gave, and that a later scoring tries it again\)/);
  assert.match(lead, step, 'the lead carries the /settle playbook as it is');
});

test('whichever desk-check steps run, the version comes from the team\'s own steps, and the check\'s two lines are passed on as given, never one for the other (8 Nov: steps without a version, and "verified by comparison")', () => {
  const lead = front('trading-desk').text, skill = fs.readFileSync('.claude/skills/desk-check/SKILL.md', 'utf8').replace(/\r\n/g, '\n');
  const check = /\n## Check this computer\n\n([\s\S]*?)\n\n## /.exec(lead)?.[1] ?? '';
  // 8 Nov 2026: a team that compared nothing still closed with "Nothing needs fixing"
  const report = '5. Pass on the check\'s line about this conversation\'s steps for the team and its line about the desk\'s agent files in this folder as the check words them, version included. Say this conversation\'s steps match the folder\'s only when the check says so with a version. If it says they were not compared, say exactly that, as something not checked, and never sum up that nothing needs fixing or that everything is ready or checked. Never take one line for the other: the agent files line is about the files in this folder, not about this conversation. Open your answer as the check\'s HOW TO SUM UP line says: it is worked out from every line, so it is the only summing up to give.';
  assert.ok(check.includes(`\n${report}\n`), 'the team\'s own steps');
  assert.ok(skill.includes(`\n${report}\n`), 'the desk-check skill, the same words');
  // the skill sends the team to the version in its own instructions, the copy this conversation began with: a copy of the
  // version in the skill could be read afresh from the folder and would always match, even in an old conversation
  // team_version is required (8 Nov 2026: left out twice by the team), so the skill says what anyone else passes, and both
  // say to call once more, and only once, when the answer asks for the team's version
  assert.match(skill, /\n1\. Call the desk's `desk_check` tool \(the trading-desk server\)\. It needs team_version\. If you are the trading-desk team, copy it exactly from step 1 of your own "Check this computer" steps: they are in your own instructions, the ones this conversation began with, and they are yours to follow\. Anywhere else, pass "none": the check then says this conversation's steps were not compared\. Never read a version from a file and never make one up\. If its answer starts with TEAM VERSION NEEDED, do what that line says: the trading-desk team calls once more with the version from its own step 1, and never a third time; anyone else passes the answer on as it is\./);
  assert.doesNotMatch(skill, /leave team_version out/);
  assert.doesNotMatch(skill, /team_version "|\b[0-9a-f]{8}\b|@@TEAM_VERSION@@/, 'the skill carries no version of its own');
  assert.deepEqual([...skill.matchAll(/^(\d)\. /gm)].map((m) => m[1]), ['1', '2', '3', '4', '5', '6', '7'], 'the skill\'s steps are numbered in order');
  assert.deepEqual([...check.matchAll(/^(\d)\. /gm)].map((m) => m[1]), ['1', '2', '3', '4', '5', '6'], 'and the team\'s');
});

test('the team\'s file carries the version of its own steps, worked out from them, which the desk check reads', async () => {
  const team = await import(pathToFileURL(path.resolve('scripts/team-src.mjs')).href) as { VERSION_MARK: string; versionOf: (s: string) => string; team: () => { text: string } };
  const text = fs.readFileSync('.claude/agents/trading-desk.md', 'utf8').replace(/\r\n/g, '\n');
  const v = teamVersionOf(new Map([['.claude/agents/trading-desk.md', text]]))!;
  assert.match(v, /^[0-9a-f]{8}$/);
  assert.equal(text.split(v).length, 2, 'it is in the file once');
  assert.equal(team.versionOf(text.replace(`team_version "${v}"`, `team_version "${team.VERSION_MARK}"`)), v, 'the SHA-256 of the steps with the mark in its place');
  assert.notEqual(team.versionOf(text.replace(v, team.VERSION_MARK).replace('Never go round in a loop', 'Never loop')), v, 'any change to the steps changes it');
});

test('/recheck-lessons rewrites a lesson under /settle\'s rules, from the window\'s rows, and never changes a call, its rating or its score; the lead does it when asked in words', () => {
  const settle = fs.readFileSync('.claude/skills/settle/SKILL.md', 'utf8'), recheck = fs.readFileSync('.claude/skills/recheck-lessons/SKILL.md', 'utf8');
  const shared = settle.split('\n').filter((l) => /^ {3}- (exactly 2 to 4 sentences|in this order: \(1\)|specific and terse)/.test(l));
  assert.equal(shared.length, 3);
  for (const rule of [...shared, 'Say a level was reached, held or broken, or a trigger fired or not, only when a row shows it, and name that row\'s date and figure.']) assert.ok(recheck.includes(rule), `/recheck-lessons keeps /settle's rule: ${rule}`);
  assert.match(recheck, /Write only from the rows, the decision and the score shown, never from the lesson as it stands/);
  assert.match(recheck, /never changes the call, its rating or its score/);
  for (const t of ['recheck_lessons', 'correct_lesson', 'what_was_wrong', 'UNRELIABLE', 'Nothing here is investment advice']) assert.ok(recheck.includes(t), t);
  const lead = front('trading-desk');
  assert.match(lead.text, /\n## Re-check old lessons\n\nWhen the person asks to re-check, correct or fix the desk's lessons \(for example "re-check the lessons"\), or says that one of them is wrong:\n\n[^\n]+\n\n1\. Call `recheck_lessons`/);
  // a lesson is flagged as wrong only on the person's own words, confirmed, and never by a routine, a member or a check
  for (const text of [recheck, lead.text]) {
    assert.match(text, /A lesson the person says is wrong\n\nOnly on the person's own words in this conversation, naming for each lesson the stock, the call's date and what is wrong[\s\S]*?Never because a check of yours, or of a member, found that a lesson is wrong/);
    assert.match(text, /Only on their yes, call `flag_lesson` once for each lesson, .*confirmed set to true\. If it answers ALREADY FLAGGED, do not call it again for that lesson\./);
  }
  assert.match(lead.text, /- Never call `flag_lesson` unless the person said in words, in this conversation, that a lesson is wrong, and confirmed it: a routine, a member or a check of yours never flags one\./);
  for (const t of ['recheck_lessons', 'correct_lesson', 'flag_lesson']) {
    assert.ok(lead.fields.tools!.includes(`mcp__trading-desk__${t}`), `the lead has ${t}`);
    for (const agent of src.AGENTS) assert.ok(!front(agent.file).fields.tools!.includes(`mcp__trading-desk__${t}`), `${agent.file} cannot change a lesson`);
  }
});
