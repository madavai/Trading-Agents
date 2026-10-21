// The desk's agent files - the twelve agents, the trading-desk team's file and its line-up - against the project's own
// version of them. Madav keeps what the person changes in Agent Studio inside Madav, and goes back to the project's
// version of a file whenever that file is written after the change; so reset_team writes every one of them again, even
// one that already matches, and Madav's runs return to the project's version too. The desk check still says when a file
// on disk differs (an edit by hand, or an older Madav that wrote into them). The project's version comes from its own
// source (scripts/team-files.mjs and the skills, what `npm run agents` writes), so nothing here keeps a second copy.
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

/** Writes the project's version of every desk agent file again, those that match too (a fresh write is what tells Madav
 *  to go back to the project's version), and nothing else; returns the ones that differed or were missing. */
export function resetAgentFiles(root: string, shipped: AgentFiles): string[] {
  const { changed, missing } = driftOf(root, shipped);
  for (const [p, text] of shipped) {
    const file = path.join(root, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return [...changed, ...missing];
}

/** A file's name as a person reads it: the agent's name, or "the team's line-up". */
export function plainName(p: string): string {
  const base = path.basename(p);
  return base.endsWith('.team.json') ? "the team's line-up" : base.replace(/\.md$/, '');
}

/** Names said as one person says them: "a", "a and b", "a, b and c". */
export const listed = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
