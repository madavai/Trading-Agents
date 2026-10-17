// Writes .claude/agents/*.md (for chat sessions) and .madav/agents/ (for Madav's Agent Studio: the same twelve agents and
// the trading-desk team) from scripts/agents-src.mjs and the desk's skills. `npm run agents` writes; with --check it only
// compares, and a test runs that check.
import fs from 'node:fs';
import { AGENTS, render } from './agents-src.mjs';
import { madavFiles } from './madav-src.mjs';

const root = new URL('../', import.meta.url), check = process.argv.includes('--check');
const files = new Map(AGENTS.map((a) => [`.claude/agents/${a.file}.md`, render(a)]));
for (const [p, text] of madavFiles()) files.set(p, text);

let stale = 0;
for (const [p, text] of files) {
  const file = new URL(p, root);
  if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { stale++; console.error(`${p} differs from scripts/agents-src.mjs and the skills: run npm run agents`); } }
  else { fs.mkdirSync(new URL('./', file), { recursive: true }); fs.writeFileSync(file, text); }
}
// Nothing else may sit in .madav/agents: an agent left over from an older version would still show in Agent Studio.
const shipped = new Set([...files.keys()].filter((p) => p.startsWith('.madav/agents/')).map((p) => p.split('/')[2]));
const madav = new URL('.madav/agents/', root);
for (const d of fs.existsSync(madav) ? fs.readdirSync(madav) : []) if (!shipped.has(d)) { stale++; console.error(`.madav/agents/${d} is not one of the desk's agents`); }
if (stale) process.exit(1);
console.log(check ? `${files.size} agent files match` : `wrote ${files.size} agent files`);
