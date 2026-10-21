// The desk check: what this computer needs for the desk, said in plain words. It reads no secret: of the Robinhood
// sign-in it only says whether one is saved and when.
import fs from 'node:fs';
import path from 'node:path';
import { deskDataDir, homeDir, robinhoodFile } from '../paths.js';
import { lockState } from '../private.js';
import { probeAll, type ProbeResult } from './probes.js';
import { VERSION } from '../version.js';
import { readSettings } from '../settings.js';
import { readContactEmail } from '../contact.js';
import { driftOf, listed, plainName, shippedAgentFiles, type Drift } from '../desk/agent-files.js';

export interface Line { ok: boolean; text: string }

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
  if (!fs.existsSync(file)) return { ok: true, text: 'Robinhood: not connected yet (only needed for trading; analysis works without it)' };
  const when = fs.statSync(file).mtime;
  return { ok: true, text: `Robinhood: a sign-in is saved (last refreshed ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC)` };
}

/** Who can open the person's private folder (the sign-in, the trading switch and caps, the dashboard's key). It is locked to
 *  their own account whenever the dashboard or the sign-in writes there; this only looks, and reads nothing in it. */
export function privateFolderLine(dir = homeDir()): Line {
  if (!fs.existsSync(dir)) return { ok: true, text: 'Your private folder: not made yet. It is made, locked to your own account, when you connect Robinhood or open the dashboard' };
  const state = lockState(dir);
  if (state === 'locked') return { ok: true, text: `Your private folder: locked to your own account${process.platform === 'win32' ? ' and the system' : ''}. No other account on this computer can open it` };
  if (state === 'open') return { ok: false, text: 'Your private folder: other accounts on this computer may be able to open it. Open the dashboard once: that locks it to your own account' };
  return { ok: true, text: 'Your private folder: who can open it could not be told (a drive without access lists?). It is as protected as your other files' };
}

export function contactLine(email: string): Line {
  return email
    ? { ok: true, text: `Contact email for the SEC: ${email} (sent to sec.gov alone, kept in desk-data)` }
    : { ok: false, text: 'Contact email for the SEC: not given yet. The desk needs it before the first analysis: the SEC asks everyone who reads its filings for one. Ask the person for their own email and save it with set_contact_email' };
}

/** Whether the desk's agents and the team are as the project ships them; a string when they could not be compared. */
export function agentsLine(drift: Drift | string): Line {
  if (typeof drift === 'string') return { ok: false, text: `The desk's agents could not be compared with the project's version: ${drift}` };
  const off = [...drift.changed, ...drift.missing].map(plainName);
  if (!off.length) return { ok: true, text: "The desk's agents and the trading-desk team are as the project ships them" };
  return { ok: false, text: `${off.length === 1 ? 'One of the desk\'s agent files differs' : `${off.length} of the desk's agent files differ`} from the project's version (${listed(off)}). An edit, or an older version of Madav, can do this. Ask the desk to reset the team to put them back` };
}

export function render(lines: Line[], sources: ProbeResult[]): string {
  const mark = (ok: boolean) => (ok ? 'OK ' : 'NO ');
  const out = [`Trading Agents desk check (version ${VERSION})`, '', 'This computer:'];
  for (const l of lines) out.push(`- ${mark(l.ok)} ${l.text}`);
  out.push('', 'Free data sources:');
  for (const s of sources) out.push(`- ${mark(s.ok)} ${s.name}: ${s.detail}`);
  const down = sources.filter((s) => !s.ok).length;
  out.push('', down === 0 ? 'Everything the desk reads is reachable.' : `${down} source(s) could not be reached. The desk will report them as unavailable, never as "no news".`);
  return out.join('\n');
}

/** The desk's agent files under `root` against the project's version from the source under `source`. */
export async function agentDrift(root: string, source: string = root): Promise<Drift | string> {
  try { return driftOf(root, await shippedAgentFiles(source)); } catch (e) { return (e as Error).message; }
}

export async function deskCheck(root: string = process.cwd(), fetchImpl: typeof fetch = fetch, source: string = root): Promise<string> {
  const settings = readSettings(root), email = readContactEmail(root);
  const sources = await probeAll(settings.sources.contact, email, fetchImpl);
  return render([nodeLine(), dataLine(root), contactLine(email), robinhoodLine(), privateFolderLine(), agentsLine(await agentDrift(root, source))], sources);
}
