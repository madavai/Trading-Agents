// Writes .claude/agents/ from scripts/agents-src.mjs and the desk's skills: the thirteen agents, read by a chat in this
// folder and listed by Madav's Agent Studio, and the trading-desk team's file with its line-up beside it (team-src.mjs).
// `npm run agents` writes, and adds the team's version to scripts/team-versions.json when it is new; with --check it
// only compares, and a test runs that check.
import fs from 'node:fs';
import { deskAgentFiles } from './team-files.mjs';

const root = new URL('../', import.meta.url), check = process.argv.includes('--check');
const files = deskAgentFiles();

let stale = 0;
for (const [p, text] of files) {
  const file = new URL(p, root);
  if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { stale++; console.error(`${p} differs from scripts/agents-src.mjs and the skills: run npm run agents`); } }
  else { fs.mkdirSync(new URL('./', file), { recursive: true }); fs.writeFileSync(file, text); }
}
// Nothing else may sit in .claude/agents: a file left over from an older version would still be listed as an agent.
const dir = new URL('.claude/agents/', root);
for (const f of fs.readdirSync(dir)) if (!files.has(`.claude/agents/${f}`)) { stale++; console.error(`.claude/agents/${f} is not one of the desk's agents`); }
// Every version the team's steps have had (scripts/team-versions.json): the new one is added, none is ever removed.
const versionsFile = new URL('scripts/team-versions.json', root), list = JSON.parse(fs.readFileSync(versionsFile, 'utf8'));
const version = /team_version "([0-9a-f]{8})"/.exec(files.get('.claude/agents/trading-desk.md') ?? '')?.[1];
if (!version) { stale++; console.error('the team\'s file carries no version'); }
else if (!list.versions.includes(version)) {
  if (check) { stale++; console.error(`scripts/team-versions.json lacks the team's version ${version}: run npm run agents`); }
  else { list.versions.push(version); fs.writeFileSync(versionsFile, JSON.stringify(list, null, 1) + '\n'); }
}
if (stale) process.exit(1);
console.log(check ? `${files.size} agent files match` : `wrote ${files.size} agent files`);
