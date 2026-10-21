import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { deskServer } from '../src/tools/server.js';
import { driftOf, resetAgentFiles, shippedAgentFiles } from '../src/desk/agent-files.js';
import { agentDrift, agentsLine } from '../src/check/desk-check.js';

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

test('a clone\'s agent files are the project\'s version, and the desk check says so', async () => {
  const drift = await agentDrift(clone(), repo);
  assert.deepEqual(drift, { changed: [], missing: [] });
  assert.deepEqual(agentsLine(drift), { ok: true, text: 'The desk\'s agents and the trading-desk team are as the project ships them' });
});

test('the desk check names each agent file a save changed, and the reset puts back only the desk\'s own', async () => {
  const root = clone(), shipped = await shippedAgentFiles(repo);
  saveInMadav(root);
  const drift = driftOf(root, shipped);
  assert.deepEqual(drift, { changed: [`${AG}/bull-researcher.md`, `${AG}/trading-desk.team.json`], missing: [`${AG}/trader.md`] });
  const line = agentsLine(drift);
  assert.equal(line.ok, false);
  assert.match(line.text, /^3 of the desk's agent files differ from the project's version \(bull-researcher, the team's line-up and trader\)\. An edit, or an older version of Madav, can do this\. Ask the desk to reset the team/);

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
  await deskServer(root, undefined, repo).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (args: Record<string, unknown>) => {
    try { return ((await client.callTool({ name: 'reset_team', arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text; } catch (e) { return (e as Error).message; }
  };

  await call({});
  await call({ confirmed: false });
  assert.equal(driftOf(root, await shippedAgentFiles(repo)).changed.length, 2, 'without a confirmation nothing is written');

  const done = await call({ confirmed: true });
  assert.match(done, /^Put back as the project ships them: bull-researcher, the team's line-up and trader; the others were written again too\./);
  assert.match(done, /take effect from the next conversation or run/);
  assert.match(done, /Madav goes back to the project's version of the team too, in place of changes made in its Agent Studio; the model, permissions and effort chosen there stay as they are/);
  assert.doesNotMatch(done, /do not press Save/, 'a save in Agent Studio no longer writes these files');
  assert.deepEqual(driftOf(root, await shippedAgentFiles(repo)), { changed: [], missing: [] });
  assert.match(await call({ confirmed: true }), /^The desk's agent files already matched the project's version on this computer; each was written again as the project ships it\.\nMadav goes back/);
  await client.close();
});

test('a folder without the project\'s source says the agents could not be compared, and the reset changes nothing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-agents-'));
  const line = agentsLine(await agentDrift(empty));
  assert.equal(line.ok, false);
  assert.match(line.text, /^The desk's agents could not be compared with the project's version: /);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(empty).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const r = (await client.callTool({ name: 'reset_team', arguments: { confirmed: true } })) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /^The team could not be reset: .*Nothing was changed\.$/s);
  assert.equal(fs.existsSync(path.join(empty, AG)), false);
  await client.close();
});
