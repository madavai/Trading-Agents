// Whether the desk in this folder was updated after this copy of the desk's tools started. An app keeps a conversation's
// tools and its copy of the team's steps from when the conversation began; after an update (a pull of the project) the
// folder holds new ones, and an old conversation can miss a tool its new steps would name, or reach for the wrong one.
// So the tool server notes, when it starts, a fingerprint of the desk's own code in its folder: the built tool server, the
// source the team's files are written from, and the skills their steps come from. When that code changes later, every
// answer says so first (`UPDATED_NOTE`). It cannot see a conversation whose tools are started afresh for each step: the
// team's version line, passed to the desk check, covers that (`teamLine` in the desk check, which says plainly when no
// version came and so nothing was compared).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The desk's own code, relative to the project folder: what an update changes and what this process ran or loaded. The
 *  skills are added by name (`codeFiles`). The agent files themselves are not among them: a person may edit those, and the
 *  desk check and reset_team look after them. */
export const CODE_FILES = ['dist/desk-tools.mjs', 'scripts/team-files.mjs', 'scripts/team-src.mjs', 'scripts/agents-src.mjs'];

/** Every file of the desk's own code under `source`, the skills included, in a fixed order. */
export function codeFiles(source: string): string[] {
  let skills: string[] = [];
  try { skills = fs.readdirSync(path.join(source, '.claude', 'skills')).sort().map((s) => `.claude/skills/${s}/SKILL.md`); } catch { /* no skills here */ }
  return [...CODE_FILES, ...skills];
}

/** A cheap look at the files (size and time written), to know when to read them again. */
const looksOf = (source: string, files: string[]): string => files.map((f) => {
  try { const s = fs.statSync(path.join(source, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:-`; }
}).join('|');

/** The fingerprint of the desk's own code under `source`: each file's name and content, a missing one as missing. */
export function codeStamp(source: string, files: string[] = codeFiles(source)): string {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    try { h.update(fs.readFileSync(path.join(source, f))); } catch { h.update('-'); }
    h.update('\0');
  }
  return h.digest('hex');
}

/** The desk's own code as this process started with it, against the folder now. Files are read again only when their
 *  size or time changed, so asking on every answer costs a look at a dozen files. */
export class Freshness {
  private readonly started: string;
  private looks: string;
  private changed = false;

  constructor(private readonly source: string) {
    this.started = codeStamp(source);
    this.looks = looksOf(source, codeFiles(source));
  }

  /** True when the desk's code in the folder is no longer what this process started with. */
  updated(): boolean {
    const files = codeFiles(this.source), looks = looksOf(this.source, files);
    if (looks !== this.looks) { this.looks = looks; this.changed = codeStamp(this.source, files) !== this.started; }
    return this.changed;
  }
}

/** What every answer starts with once the desk in the folder was updated after this process started. */
export const UPDATED_NOTE = 'DESK UPDATED: the desk in this folder was updated after the desk\'s tools in this conversation started, so this conversation still has the old desk tools, and most likely the old steps. Tell the person in one plain line to start a new conversation in Madav (in Claude Code, a new session), where the new ones load, and start nothing new here.';
