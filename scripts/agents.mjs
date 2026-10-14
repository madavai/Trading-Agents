// Writes .claude/agents/*.md from scripts/agents-src.mjs. `npm run agents` writes; with --check it only compares.
import fs from 'node:fs';
import { AGENTS, render } from './agents-src.mjs';

const dir = new URL('../.claude/agents/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
let stale = 0;
for (const a of AGENTS) {
  const file = new URL(`${a.file}.md`, dir), text = render(a);
  if (process.argv.includes('--check')) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { stale++; console.error(`${a.file}.md differs from scripts/agents-src.mjs`); } }
  else fs.writeFileSync(file, text);
}
if (stale) process.exit(1);
console.log(process.argv.includes('--check') ? `${AGENTS.length} agent files match` : `wrote ${AGENTS.length} agent files`);
