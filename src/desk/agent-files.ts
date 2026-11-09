// The desk's agent files - the thirteen agents, the trading-desk team's file and its line-up - against the project's own
// version of them. Madav keeps what the person changes in Agent Studio inside Madav, and goes back to the project's
// version of a file whenever that file is written after the change; so reset_team writes every one of them again, even
// one that already matches, and Madav's runs return to the project's version too. The desk check still says when a file
// on disk differs (an edit by hand, or an older Madav that wrote into them). The project's version comes from its own
// source (scripts/team-files.mjs and the skills, what `npm run agents` writes), so nothing here keeps a second copy.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deskDataDir } from '../paths.js';
import { writeWhole } from './lock.js';

export type AgentFiles = Map<string, string>;

/** The team's own file, whose steps a conversation keeps from when it began. */
export const TEAM_FILE = '.claude/agents/trading-desk.md';

/** The version of the team's steps, as the team's file carries it (written by `npm run agents` from the steps' own text,
 *  scripts/team-src.mjs); undefined when the file carries none. */
export function teamVersionOf(shipped: AgentFiles): string | undefined {
  return /team_version "([0-9a-f]{8})"/.exec(shipped.get(TEAM_FILE) ?? '')?.[1];
}

/** Every version the team's steps have had, oldest first, relative to the project folder: `npm run agents` adds each new
 *  one and none is ever removed, so the desk check can tell a version a conversation kept from before an update from one
 *  that was never the steps' (made up, or not copied from them). */
export const VERSIONS_FILE = 'scripts/team-versions.json';

/** The versions in VERSIONS_FILE under `source`; undefined when it cannot be read or holds anything but versions. */
export function knownTeamVersions(source: string): string[] | undefined {
  try {
    const versions = (JSON.parse(fs.readFileSync(path.join(source, VERSIONS_FILE), 'utf8')) as { versions?: unknown }).versions;
    return Array.isArray(versions) && versions.length && versions.every((v) => typeof v === 'string' && /^[0-9a-f]{8}$/.test(v)) ? versions as string[] : undefined;
  } catch { return undefined; }
}

/** How soon after a reset another one, with the files still matching, is refused: half an hour. A reset takes effect from
 *  the next conversation or run, so a second one soon after cannot add anything the first did not, unless the team was
 *  changed in Agent Studio in between; and a team that has lost its way calls it again within minutes (in a chat on 7 Nov
 *  2026, dozens of times in seven minutes). Half an hour stops such a loop while one reset in it is still under way, and
 *  a person who really changed the team again waits no longer than that. */
export const RESET_AGAIN_MS = 30 * 60_000;

const resetFile = (root: string) => path.join(deskDataDir(root), 'team-reset.json');

/** When the team was last put back in this folder, if it was; kept in desk-data, never under .claude, so writing it never
 *  pauses the routines, and read by every copy of the tool server. */
export function lastReset(root: string): Date | undefined {
  try {
    const at = (JSON.parse(fs.readFileSync(resetFile(root), 'utf8')) as { at?: unknown }).at;
    const d = typeof at === 'string' ? new Date(at) : undefined;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  } catch { return undefined; }
}

export function noteReset(root: string, at: Date = new Date()): void {
  fs.mkdirSync(path.dirname(resetFile(root)), { recursive: true });
  writeWhole(resetFile(root), JSON.stringify({ at: at.toISOString() }));
}

/** "21:42 UTC", as the desk's other answers say a time. */
export const utcTime = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;

/** The answer to a reset asked for again soon after one, with the files still matching: nothing is written. */
export function resetAgainWords(last: Date): string {
  return [
    `ALREADY RESET: the team was already put back as the project ships it at ${utcTime(last)}, and its files still match the project's version, so nothing was written now and nothing needs doing again.`,
    `Do not call reset_team again: tell the person in one plain line that the team was put back at ${utcTime(last)}. If they did not ask for a reset, say that too, and that this conversation has no step for what they asked: a new conversation in Madav has the desk's newest steps.`,
    `Only a change made in Madav's Agent Studio since then would need another reset, and that can be asked for after ${utcTime(new Date(last.getTime() + RESET_AGAIN_MS))}.`,
  ].join('\n');
}

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
