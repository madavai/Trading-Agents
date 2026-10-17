// The desk's agent files - the twelve agents, the trading-desk team's file and its line-up - against the project's own
// version of them. Madav's Agent Studio writes into a team's files when the person saves it, so the desk check says when
// they differ and reset_team writes the project's version back. The project's version comes from its own source
// (scripts/team-files.mjs and the skills, what `npm run agents` writes), so nothing here keeps a second copy to drift.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type AgentFiles = Map<string, string>;

/** The agent files as the project ships them, from the source under `source` (the project folder). */
export async function shippedAgentFiles(source: string): Promise<AgentFiles> {
  const mod = await import(pathToFileURL(path.join(source, 'scripts', 'team-files.mjs')).href) as { deskAgentFiles: () => AgentFiles };
  return mod.deskAgentFiles();
}

export interface Drift { changed: string[]; missing: string[] }

/** Which of the desk's agent files under `root` differ from the project's version, and which are missing. Line endings
 *  do not count (a checkout on Windows may turn them). Any other file in the folder is the person's own and not looked at. */
export function driftOf(root: string, shipped: AgentFiles): Drift {
  const changed: string[] = [], missing: string[] = [];
  for (const [p, text] of shipped) {
    const file = path.join(root, p);
    if (!fs.existsSync(file)) missing.push(p);
    else if (fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text) changed.push(p);
  }
  return { changed, missing };
}

/** Writes the project's version back over the desk's agent files that differ or are missing, and nothing else; returns
 *  the ones it wrote. */
export function resetAgentFiles(root: string, shipped: AgentFiles): string[] {
  const { changed, missing } = driftOf(root, shipped), wrote = [...changed, ...missing];
  for (const p of wrote) {
    const file = path.join(root, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, shipped.get(p)!);
  }
  return wrote;
}

/** A file's name as a person reads it: the agent's name, or "the team's line-up". */
export function plainName(p: string): string {
  const base = path.basename(p);
  return base.endsWith('.team.json') ? "the team's line-up" : base.replace(/\.md$/, '');
}

/** Names said as one person says them: "a", "a and b", "a, b and c". */
export const listed = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
