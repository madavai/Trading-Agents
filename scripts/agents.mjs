// Writes .claude/agents/ from scripts/agents-src.mjs and the desk's skills: the twelve agents, read by a chat in this
// folder and listed by Madav's Agent Studio, and the trading-desk team's file with its line-up beside it (team-src.mjs).
// `npm run agents` writes; with --check it only compares, and a test runs that check.
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
if (stale) process.exit(1);
console.log(check ? `${files.size} agent files match` : `wrote ${files.size} agent files`);
