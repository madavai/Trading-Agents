import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deskServer } from '../src/tools/server.js';
import { driftOf, lastReset, noteReset, RESET_AGAIN_MS, resetAgainWords, resetAgentFiles, shippedAgentFiles, teamVersionOf } from '../src/desk/agent-files.js';
import { agentDrift, agentsLine, NO_VERSION, teamLine, TWO_LINES } from '../src/check/desk-check.js';
import { UPDATED_NOTE } from '../src/desk/freshness.js';
import { awayHome } from './away.js';

const repo = process.cwd();
const AG = '.claude/agents';

/** A folder holding a copy of this project's agent files, as a clone would. */
function clone(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-agents-'));
  fs.cpSync(path.join(repo, AG), path.join(root, AG), { recursive: true });
  return root;
}

/** What a save in Madav's Agent Studio might leave behind: a member with a tool it was never given, the line-up in steps,
 *  a member gone; and an agent of the person's own beside them. */
function saveInMadav(root: string): void {
  const bull = path.join(root, AG, 'bull-researcher.md');
  fs.writeFileSync(bull, fs.readFileSync(bull, 'utf8').replace('SendMessage', 'SendMessage, Bash'));
  fs.writeFileSync(path.join(root, AG, 'trading-desk.team.json'), '{"members":[],"steps":true}\n');
  fs.rmSync(path.join(root, AG, 'trader.md'));
  fs.writeFileSync(path.join(root, AG, 'my-own.md'), 'mine');
}

test('a clone\'s agent files are the project\'s version, and the desk check says so of the files in this folder alone', async () => {
  const drift = await agentDrift(clone(), repo);
  assert.deepEqual(drift, { changed: [], missing: [] });
  assert.deepEqual(agentsLine(drift), { ok: true, text: 'The desk\'s agent files in this folder (its thirteen agents, the team\'s file and its line-up) are as the project ships them' });
  // the words name what was compared: thirteen agents, the team's file and its line-up
  const shipped = await shippedAgentFiles(repo);
  assert.equal(shipped.size, 15);
  assert.equal([...shipped.keys()].filter((p) => !p.startsWith(`${AG}/trading-desk.`)).length, 13);
  assert.ok(shipped.has(`${AG}/trading-desk.md`) && shipped.has(`${AG}/trading-desk.team.json`));
});

test('the desk check names each agent file a save changed, and the reset puts back only the desk\'s own', async () => {
  const root = clone(), shipped = await shippedAgentFiles(repo);
  saveInMadav(root);
  const drift = driftOf(root, shipped);
  assert.deepEqual(drift, { changed: [`${AG}/bull-researcher.md`, `${AG}/trading-desk.team.json`], missing: [`${AG}/trader.md`] });
  const line = agentsLine(drift);
  assert.equal(line.ok, false);
  assert.match(line.text, /^3 of the desk's agent files in this folder differ from the project's version \(bull-researcher, the team's line-up and trader\)\. An edit, or an older version of Madav, can do this\. Ask the desk to reset the team/);
  assert.match(agentsLine({ changed: [`${AG}/trader.md`], missing: [] }).text, /^One of the desk's agent files in this folder differs from the project's version \(trader\)\. /);

  assert.deepEqual(resetAgentFiles(root, shipped), [`${AG}/bull-researcher.md`, `${AG}/trading-desk.team.json`, `${AG}/trader.md`]);
  assert.deepEqual(driftOf(root, shipped), { changed: [], missing: [] });
  for (const [p, text] of shipped) assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), text, p);
  assert.equal(fs.readFileSync(path.join(root, AG, 'my-own.md'), 'utf8'), 'mine', 'the person\'s own agent is left alone');
  // Madav keeps Agent Studio's changes inside itself and returns to the project's version when a file is written after
  // them: so even with nothing differing on disk, a reset writes every desk file again.
  const old = new Date('2026-01-01T00:00:00Z');
  for (const p of shipped.keys()) fs.utimesSync(path.join(root, p), old, old);
  fs.utimesSync(path.join(root, AG, 'my-own.md'), old, old);
  assert.deepEqual(resetAgentFiles(root, shipped), [], 'a second reset finds nothing differing');
  for (const p of shipped.keys()) assert.ok(fs.statSync(path.join(root, p)).mtimeMs > old.getTime(), `${p} is written again all the same`);
  assert.equal(fs.statSync(path.join(root, AG, 'my-own.md')).mtimeMs, old.getTime(), 'and the person\'s own agent is still not touched');
});

test('a line ending turned by a Windows checkout is not a change', async () => {
  const root = clone(), shipped = await shippedAgentFiles(repo), market = path.join(root, AG, 'market-analyst.md');
  fs.writeFileSync(market, fs.readFileSync(market, 'utf8').replace(/\r?\n/g, '\r\n'));
  assert.deepEqual(driftOf(root, shipped), { changed: [], missing: [] });
});

test('reset_team acts only on the person\'s confirmation, says what it put back, and that Madav goes back to the project\'s team too', async () => {
  const root = clone();
  saveInMadav(root);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, undefined, repo, awayHome()).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (args: Record<string, unknown>) => {
    try { return ((await client.callTool({ name: 'reset_team', arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text; } catch (e) { return (e as Error).message; }
  };

  await call({});
  await call({ confirmed: false });
  assert.equal(driftOf(root, await shippedAgentFiles(repo)).changed.length, 2, 'without a confirmation nothing is written');

  assert.equal(lastReset(root), undefined, 'a refused call is no reset');
  const done = await call({ confirmed: true });
  assert.match(done, /^Put back as the project ships them: bull-researcher, the team's line-up and trader; the others were written again too\./);
  assert.match(done, /take effect from the next conversation or run/);
  assert.match(done, /Madav goes back to the project's version of the team too, in place of changes made in its Agent Studio; the model, permissions and effort chosen there stay as they are/);
  assert.doesNotMatch(done, /do not press Save/, 'a save in Agent Studio no longer writes these files');
  assert.deepEqual(driftOf(root, await shippedAgentFiles(repo)), { changed: [], missing: [] });
  // half an hour later, with nothing differing, a reset writes every file again all the same
  noteReset(root, new Date(Date.now() - RESET_AGAIN_MS - 60_000));
  assert.match(await call({ confirmed: true }), /^The desk's agent files already matched the project's version on this computer; each was written again as the project ships it\.\nMadav goes back/);
  await client.close();
});

/** A whole project folder in a temporary place: the agent files, the source they are written from, the skills and a
 *  built tool server, so a test can change the desk's code as an update would. */
function project(): string {
  const root = clone();
  for (const d of ['scripts', '.claude/skills']) fs.cpSync(path.join(repo, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'desk-tools.mjs'), '// the desk tools as built before the update\n');
  return root;
}

const reachable: typeof fetch = async () => new Response('{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date', { status: 200 });

async function serve(root: string, source = root) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, reachable, source, awayHome()).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { client, call };
}

const mtimes = (root: string, shipped: Map<string, string>) => [...shipped.keys()].map((p) => fs.statSync(path.join(root, p)).mtimeMs);

test('a reset asked for again soon after one writes nothing and says firmly not to call it again (7 Nov: dozens of resets in seven minutes)', async () => {
  const root = clone(), shipped = await shippedAgentFiles(repo);
  const { client, call } = await serve(root, repo);
  assert.equal(RESET_AGAIN_MS, 30 * 60_000);
  assert.match(await call('reset_team', { confirmed: true }), /^The desk's agent files already matched/);
  const at = lastReset(root)!;
  assert.ok(Date.now() - at.getTime() < 5_000, 'the reset is noted in desk-data');
  const old = new Date('2026-01-01T00:00:00Z');
  for (const p of shipped.keys()) fs.utimesSync(path.join(root, p), old, old);

  const again = await call('reset_team', { confirmed: true });
  assert.equal(again, resetAgainWords(at));
  assert.match(again, new RegExp(`^ALREADY RESET: the team was already put back as the project ships it at ${at.toISOString().slice(11, 16)} UTC, and its files still match the project's version, so nothing was written now and nothing needs doing again\\.\\nDo not call reset_team again: tell the person in one plain line`));
  assert.match(again, /If they did not ask for a reset, say that too, and that this conversation has no step for what they asked/);
  assert.match(again, new RegExp(`can be asked for after ${new Date(at.getTime() + RESET_AGAIN_MS).toISOString().slice(11, 16)} UTC\\.$`));
  for (let i = 0; i < 5; i++) assert.match(await call('reset_team', { confirmed: true }), /^ALREADY RESET: /);
  assert.ok(mtimes(root, shipped).every((t) => t === old.getTime()), 'no file was written again: Madav is not told to pause the routines again');
  assert.equal(lastReset(root)!.getTime(), at.getTime(), 'a refused reset is not a new reset');

  // a file that differs on disk is put back, even soon after: a reset that changes something is never refused
  fs.rmSync(path.join(root, AG, 'trader.md'));
  assert.match(await call('reset_team', { confirmed: true }), /^Put back as the project ships them: trader;/);
  assert.match(await call('reset_team', { confirmed: true }), /^ALREADY RESET: /);
  await client.close();
});

test('tools started before the desk was updated say so in every answer, never reset the team, and the desk check compares nothing from them', async () => {
  const root = project(), shipped = await shippedAgentFiles(root);
  const { client, call } = await serve(root);
  assert.doesNotMatch(await call('read_queue'), /DESK UPDATED/, 'nothing is said while the folder holds the code these tools started with');
  const before = await call('desk_check');
  assert.doesNotMatch(before, /DESK UPDATED|not compared with the project's version|updated after/);
  assert.match(before, /- --  This conversation's steps for the team were not compared with the ones in this folder: no version was given\n/);

  fs.appendFileSync(path.join(root, 'dist', 'desk-tools.mjs'), '// and after it\n');   // an update, as a pull writes it
  for (const name of ['read_queue', 'list_settlements', 'end_backtest']) {
    const answer = await call(name);
    assert.ok(answer.startsWith(`${UPDATED_NOTE}\n\n`), `${name}: ${answer.slice(0, 80)}`);
  }
  assert.match(UPDATED_NOTE, /^DESK UPDATED: the desk in this folder was updated after the desk's tools in this conversation started, so this conversation still has the old desk tools, and most likely the old steps\. Tell the person in one plain line to start a new conversation in Madav/);

  const old = new Date('2026-01-01T00:00:00Z');
  for (const p of shipped.keys()) fs.utimesSync(path.join(root, p), old, old);
  fs.rmSync(path.join(root, AG, 'trader.md'));
  const reset = await call('reset_team', { confirmed: true });
  assert.match(reset, /Not reset: the desk in this folder was updated after the desk's tools in this conversation started, so they could write the team back as it was before the update\. Nothing was written\. Do not call reset_team again here/);
  assert.equal(fs.existsSync(path.join(root, AG, 'trader.md')), false, 'nothing was written');
  assert.ok([...shipped.keys()].filter((p) => !p.endsWith('trader.md')).every((p) => fs.statSync(path.join(root, p)).mtimeMs === old.getTime()));
  assert.equal(lastReset(root), undefined);

  const check = await call('desk_check', { team_version: teamVersionOf(shipped) });
  assert.ok(check.startsWith(`${UPDATED_NOTE}\n\nTrading Agents desk check`));
  assert.match(check, /\nThis computer:\n- --  This conversation's steps for the team were not compared with the ones in this folder: the desk in this folder was updated after the desk's tools in this conversation started\n/, 'said plainly, first, even with a version given');
  assert.match(check, /- NO  The desk's agent files in this folder were not compared with the project's version: the desk in this folder was updated after the desk's tools in this conversation started\. Start a new conversation in Madav and check this computer there; reset nothing from this one/);
  assert.doesNotMatch(check, /differs from the project's version|steps for the team are the ones|are as the project ships them/, 'tools from before the update hold the old source: they say nothing about the files');
  await client.close();
});

test('a change to the team\'s source or to a skill is an update too; a person\'s edit of an agent file is not', async () => {
  for (const f of ['scripts/team-src.mjs', '.claude/skills/settle/SKILL.md']) {
    const root = project();
    const { client, call } = await serve(root);
    fs.appendFileSync(path.join(root, AG, 'trader.md'), 'one more word\n');
    assert.doesNotMatch(await call('read_queue'), /DESK UPDATED/, 'an edit of an agent file is the desk check\'s and the reset\'s to see');
    fs.appendFileSync(path.join(root, f), '\n');
    assert.match(await call('read_queue'), /^DESK UPDATED: /, f);
    await client.close();
  }
  // a folder with no built tools or source to look at (a test's own) never says so
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-agents-'));
  const { client, call } = await serve(empty);
  assert.doesNotMatch(await call('read_queue'), /DESK UPDATED/);
  await client.close();
});

test('the desk check says whether this conversation\'s steps for the team are the folder\'s, from the version the team\'s file gives it, and plainly when it did not compare them', async () => {
  const root = clone(), shipped = await shippedAgentFiles(repo), now = teamVersionOf(shipped)!;
  assert.match(now, /^[0-9a-f]{8}$/);
  const { client, call } = await serve(root, repo);
  const filesLine = "- OK  The desk's agent files in this folder (its thirteen agents, the team's file and its line-up) are as the project ships them\n";
  const two = `\n${TWO_LINES}\n\nFree data sources:\n`;
  assert.match(TWO_LINES, /^Pass on the line about this conversation's steps for the team and the line about the desk's agent files in this folder as they are written\. Only the first can say whether this conversation's steps are the folder's, and only with a version shown; the second is about the files alone\. Never take one for the other\.$/);

  // the version this conversation's steps give, the folder's: it is shown and said to match
  const same = await call('desk_check', { team_version: now });
  assert.match(same, new RegExp(`\\nThis computer:\\n- OK  This conversation's steps for the team are the ones in this folder \\(version ${now}\\)\\n`));
  assert.ok(same.includes(filesLine) && same.includes(two), 'the files line, then how to pass on the two');
  const computer = (check: string) => check.split('\nFree data sources:\n')[0];   // the sources' timings vary
  assert.equal(computer(await call('desk_check', { team_version: ` ${now} ` })), computer(same), 'spaces around it do not matter');

  // an older version: not the folder's, first, with both versions
  const old = await call('desk_check', { team_version: '0badc0de' });
  assert.match(old, new RegExp(`\\nThis computer:\\n- NO  This conversation's steps for the team \\(version 0badc0de\\) are not the ones in this folder now \\(version ${now}\\): this conversation began before the desk was updated\\. Start a new conversation in Madav, where the new steps load, and check this computer there; reset nothing from this one\\n`), 'the first line under This computer');
  assert.ok(old.includes(filesLine), 'the files in the folder can match while this conversation\'s steps do not: one never stands for the other');

  // no version (8 Nov 2026: steps that gave none, and a team that then read the files line as its own steps): said plainly,
  // in a line of its own, first, marked neither OK nor NO, and true in a plain chat too
  for (const [given, why] of [[{}, NO_VERSION], [{ team_version: '' }, NO_VERSION], [{ team_version: '   ' }, NO_VERSION], [{ team_version: 'the latest' }, 'what was given is not a version'], [{ team_version: '446FC181X' }, 'what was given is not a version']] as const) {
    const none = await call('desk_check', given);
    assert.match(none, new RegExp(`\\nThis computer:\\n- --  This conversation's steps for the team were not compared with the ones in this folder: ${why}\\n- OK  Node `), JSON.stringify(given));
    assert.doesNotMatch(none, /steps for the team are the ones|\(version [0-9a-f]{8}\)/, `${JSON.stringify(given)}: no match and no version is claimed`);
    assert.ok(none.includes(filesLine) && none.includes(two), JSON.stringify(given));
  }
  assert.equal(NO_VERSION, 'no version was given');
  assert.deepEqual(teamLine(undefined, now), { ok: false, unchecked: true, text: "This conversation's steps for the team were not compared with the ones in this folder: no version was given" });
  assert.equal(teamLine('0badc0de', undefined).ok, false);
  assert.match(teamLine('0badc0de', undefined).text, /^This conversation's steps for the team \(version 0badc0de\) could not be compared: the team's file in this folder carries no version$/);
  assert.equal(teamLine(now, now, true).unchecked, true, 'tools started before an update compare nothing, a version given or not');
  await client.close();
});

test('a folder without the project\'s source says the agents could not be compared, and the reset changes nothing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-agents-'));
  const line = agentsLine(await agentDrift(empty));
  assert.equal(line.ok, false);
  assert.match(line.text, /^The desk's agent files in this folder could not be compared with the project's version: /);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(empty, undefined, empty, awayHome()).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const r = (await client.callTool({ name: 'reset_team', arguments: { confirmed: true } })) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /^The team could not be reset: .*Nothing was changed\.$/s);
  assert.equal(fs.existsSync(path.join(empty, AG)), false);
  await client.close();
});
