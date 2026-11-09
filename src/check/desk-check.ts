// The desk check: what this computer needs for the desk, said in plain words, and only what it looked at. It reads no
// secret: of the Robinhood sign-in it only says whether one is saved and when, and the contact email is shown masked, as
// the dashboard shows it. All it writes is a test file in desk-data, removed at once.
import fs from 'node:fs';
import path from 'node:path';
import { deskDataDir, homeDir, robinhoodFile } from '../paths.js';
import { lockState } from '../private.js';
import { NOT_PROBED, probeAll, type ProbeResult } from './probes.js';
import { VERSION } from '../version.js';
import { readSettings } from '../settings.js';
import { maskEmail, readContactEmail, WHY_EMAIL } from '../contact.js';
import { driftOf, knownTeamVersions, listed, plainName, shippedAgentFiles, teamVersionOf, type Drift } from '../desk/agent-files.js';

/** One line of the check. `unchecked`: the check did not look at this, and says so (marked "--", neither OK nor NO). */
export interface Line { ok: boolean; text: string; unchecked?: true }

export function nodeLine(version = process.versions.node): Line {
  const major = Number(version.split('.')[0]);
  return major >= 22 ? { ok: true, text: `Node ${version}` } : { ok: false, text: `Node ${version} is too old: install Node 22 or later from nodejs.org` };
}

export function dataLine(root: string): Line {
  const dir = deskDataDir(root);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-check');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    return { ok: true, text: `Desk data folder ${dir} (writable)` };
  } catch (e) {
    return { ok: false, text: `Desk data folder ${dir} cannot be written: ${(e as Error).message}` };
  }
}

export function robinhoodLine(file = robinhoodFile()): Line {
  if (!fs.existsSync(file)) return { ok: true, text: 'Robinhood: not connected yet (it is for your accounts on the dashboard, and for trading; analysis works without it)' };
  const when = fs.statSync(file).mtime;
  return { ok: true, text: `Robinhood: a sign-in is saved (last refreshed ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC)` };
}

/** Who can open the person's private folder (the sign-in, the trading switch and caps, the dashboard's key). It is locked to
 *  their own account whenever the dashboard or the sign-in writes there; this only looks, and reads nothing in it. */
export function privateFolderLine(dir = homeDir()): Line {
  if (!fs.existsSync(dir)) return { ok: true, text: 'Your private folder: not made yet. It is made, locked to your own account, when you connect Robinhood or open the dashboard' };
  const state = lockState(dir);
  if (state === 'locked') return { ok: true, text: `Your private folder: locked to your own account${process.platform === 'win32' ? ' and the system' : ''}` };
  if (state === 'open') return { ok: false, text: 'Your private folder: other accounts on this computer may be able to open it. Open the dashboard once: that locks it to your own account' };
  return { ok: true, text: 'Your private folder: who can open it could not be told (a drive without access lists?). It is as protected as your other files' };
}

export function contactLine(email: string): Line {
  return email
    ? { ok: true, text: `Contact email for the SEC: ${maskEmail(email)} (shown masked; sent to sec.gov alone, kept in desk-data)` }
    : { ok: false, text: `Contact email for the SEC: not given yet. The desk needs it before the first analysis: ${WHY_EMAIL}. Ask the person for their own email and save it with set_contact_email` };
}

/** Whether the desk's agent files in this folder are as the project ships them; a string when they could not be compared.
 *  It is about the files on disk only, never about the steps a conversation holds (that is `teamLine`), so it names them. */
export function agentsLine(drift: Drift | string): Line {
  if (typeof drift === 'string') return { ok: false, text: `The desk's agent files in this folder could not be compared with the project's version: ${drift}` };
  const off = [...drift.changed, ...drift.missing].map(plainName);
  if (!off.length) return { ok: true, text: "The desk's agent files in this folder (its thirteen agents, the team's file and its line-up) are as the project ships them" };
  return { ok: false, text: `${off.length === 1 ? 'One of the desk\'s agent files in this folder differs' : `${off.length} of the desk's agent files in this folder differ`} from the project's version (${listed(off)}). An edit, or an older version of Madav, can do this. Ask the desk to reset the team to put them back` };
}

/** Why tools started before the desk in the folder was updated compare nothing: they hold the team's source as it was then. */
export const UPDATED_WHY = "the desk in this folder was updated after the desk's tools in this conversation started";

/** Tools started before the desk in the folder was updated hold the team's source as it was then, so they cannot say
 *  whether the files match the project's version now; a reset from them could write the old team back. */
export const NOT_COMPARED: Line = { ok: false, text: `The desk's agent files in this folder were not compared with the project's version: ${UPDATED_WHY}. Start a new conversation in Madav and check this computer there; reset nothing from this one` };

/** Why this conversation's steps were not compared when it passed no version: true in Madav and in a plain chat alike, and
 *  plain about who can compare them (8 Nov 2026: in a plain chat the line read as a fault to fix). */
export const NO_VERSION = 'no version was given. Only the trading-desk team\'s own steps carry a version, so a check from any other chat, or from a terminal, compares nothing here';

/** What a caller that is not the trading-desk team passes as team_version (the desk check's tool needs one, so leaving the
 *  version out is never a quiet slip): read like no version at all. */
export const NONE = 'none';

/** The team's line, and whether the team should call once more with the version its own steps give (`askAgain`). */
export type TeamLine = Line & { askAgain?: true };

/** Whether this conversation began with the folder's version of the team's steps (the version it passed, from its own
 *  copy of the team's file, the one it began with). A change made to the team in Agent Studio keeps that version, so it
 *  cannot be told from here: a match is said as the version it began with, never as "the same steps". Always a line, the
 *  first under "This computer": nothing else in the check is about this conversation's steps, so without a version it says plainly that they were not compared. `updated`: these tools
 *  started before the folder was updated, so they hold the old source and cannot tell the folder's version. `known`: every
 *  version the team's steps have had (scripts/team-versions.json), so only a real earlier one is said to show that this
 *  conversation began before the update; a version never had is not compared, and the team is asked again. */
export function teamLine(given: string | undefined, folder: string | undefined, updated = false, known?: readonly string[]): TeamLine {
  const v = given?.trim() ?? '';
  const not = (why: string, askAgain = true): TeamLine => ({ ok: false, unchecked: true, text: `This conversation's steps for the team were not compared with the ones in this folder: ${why}`, ...(askAgain ? { askAgain } : {}) });
  if (updated) return not(UPDATED_WHY, false);
  if (!v || v.toLowerCase() === NONE) return not(NO_VERSION);
  if (!/^[0-9a-f]{8}$/.test(v)) return not('what was given is not a version');
  if (!folder) return { ok: false, text: `This conversation's steps for the team (version ${v}) could not be compared: the team's file in this folder carries no version` };
  if (v === folder) return { ok: true, text: `This conversation began with the team's steps of version ${folder}, the version in this folder. A change made to the team in Madav's Agent Studio cannot be told from here: it keeps that version. If the team was changed there, ask the desk to reset the team to go back to the project's steps` };
  if (known && !known.includes(v)) return not(`${v} is not a version the team's steps have ever had`);
  const why = known ? 'this conversation began before the desk was updated' : `this conversation began before the desk was updated, or ${v} was not copied from the team's steps (the list of the steps' earlier versions could not be read)`;
  return { ok: false, text: `This conversation's steps for the team (version ${v}) are not the ones in this folder now (version ${folder}): ${why}. Start a new conversation in Madav, where the new steps load, and check this computer there; reset nothing from this one` };
}

/** What the answer opens with, through the desk's tool, when the team's line compared nothing for want of a real version
 *  (8 Nov 2026: in Madav the team twice called the check without the version its own step 1 names). The team has the
 *  version in the steps it began with, so it is asked once to call again with it; anyone else passes the answer on. */
export const ASK_AGAIN = 'TEAM VERSION NEEDED: this answer did not compare this conversation\'s steps for the team with the ones in this folder. If you are the trading-desk team and have not yet called desk_check again in this check, call it once more now, with team_version copied exactly from step 1 of your own "Check this computer" steps (in the instructions this conversation began with), and pass on that answer instead of this one. Otherwise (you are not the trading-desk team, your steps give no version, or you already called again) pass this answer on as it is, and never say this conversation\'s steps match.';

/** Under the lines: how to pass on the two that sound alike, whichever steps the reader followed (8 Nov 2026: a team that
 *  passed no version read the agent-files line as saying its own steps were the folder's). */
export const TWO_LINES = "Pass on the line about this conversation's steps for the team and the line about the desk's agent files in this folder as they are written. Only the first is about this conversation's steps, and only with a version shown; the second is about the files alone. Never take one for the other.";

/** The first words of the report, worked out from every line, for an agent that passes the check on (8 Nov 2026: a plain
 *  chat in Madav opened "Everything is ready" over a check that compared none of its steps, against its own step 5). Said
 *  once, above the lines, so it is read before the report is written; it is the whole summing up, so none is added at the
 *  end either (in a test, one report opened as told and still closed "Nothing needs fixing"). A check read in a terminal
 *  goes without it. */
export function sumUp(lines: Line[], sources: ProbeResult[]): string {
  const not = lines.filter((l) => !l.ok && !l.unchecked).length, down = sources.filter((s) => !s.ok).length;
  const unchecked = lines.some((l) => l.unchecked);
  const only = 'That opening is the whole summing up: add no other, at the start or at the end (never "everything is ready", "all checked", "nothing needs fixing" or the like)';
  if (not || down) {
    const what = [not ? 'each line marked NO' : '', down ? 'each data source that could not be reached' : ''].filter(Boolean).join(', and ');
    return `HOW TO SUM UP: open your answer with what is not ready (${what}) and what to do about each${unchecked ? ', then say that this conversation\'s steps for the team were not compared' : ''}. ${only}.`;
  }
  if (unchecked) return `HOW TO SUM UP: open your answer with "Ready, except one thing this check did not compare: whether this conversation's steps for the team are the ones in this folder", then pass on that line as it is written. ${only}, since the line marked -- was not checked.`;
  return 'HOW TO SUM UP: everything this check looked at is ready. You may say so, and name what it does not check (its last line).';
}

export function render(lines: Line[], sources: ProbeResult[], how?: string): string {
  const mark = (ok: boolean, unchecked?: true) => (unchecked ? '-- ' : ok ? 'OK ' : 'NO ');
  const out = [`Trading Agents desk check (version ${VERSION})`, ...(how ? [how] : []), '', 'This computer:'];
  for (const l of lines) out.push(`- ${mark(l.ok, l.unchecked)} ${l.text}`);
  out.push(TWO_LINES);
  out.push('', 'Free data sources:');
  for (const s of sources) out.push(`- ${mark(s.ok)} ${s.name}: ${s.detail}`);
  const down = sources.filter((s) => !s.ok).length;
  out.push('', down === 0 ? 'Every source checked here is reachable.' : `${down} source(s) could not be reached. The desk will report them as unavailable, never as "no news".`);
  out.push(`Not checked here: ${NOT_PROBED}.`);
  return out.join('\n');
}

/** The desk's agent files under `root` against the project's version from the source under `source`. */
export async function agentDrift(root: string, source: string = root): Promise<Drift | string> {
  try { return driftOf(root, await shippedAgentFiles(source)); } catch (e) { return (e as Error).message; }
}

/** What the desk check knows of the conversation asking: whether the desk was updated after its tools started, the version
 *  of the team's steps it passed, and whether it asked through the desk's tool (an agent, which may be the team and can
 *  call again). A check from a terminal knows none of these. */
export interface Asker { updated?: boolean; teamVersion?: string; viaTool?: boolean }

/** Where the person's private folder and the sign-in in it are: the real ones, except in a test, which never looks at them. */
export interface Home { folder: string; signIn: string }
export const realHome = (): Home => ({ folder: homeDir(), signIn: robinhoodFile() });

export async function deskCheck(root: string = process.cwd(), fetchImpl: typeof fetch = fetch, source: string = root, asker: Asker = {}, home: Home = realHome()): Promise<string> {
  const settings = readSettings(root), email = readContactEmail(root);
  const sources = await probeAll(settings.sources.contact, email, fetchImpl);
  const lines = [nodeLine(), dataLine(root), contactLine(email), robinhoodLine(home.signIn), privateFolderLine(home.folder)];
  let folder: string | undefined;
  if (asker.updated) lines.push(NOT_COMPARED);
  else {
    lines.push(agentsLine(await agentDrift(root, source)));
    try { folder = teamVersionOf(await shippedAgentFiles(source)); } catch { /* the agents line says they could not be compared */ }
  }
  const team = teamLine(asker.teamVersion, folder, asker.updated, knownTeamVersions(source));
  lines.unshift(team);   // the first thing to read: an old conversation's other answers may not hold
  return `${team.askAgain && asker.viaTool ? `${ASK_AGAIN}\n\n` : ''}${render(lines, sources, asker.viaTool ? sumUp(lines, sources) : undefined)}`;
}
