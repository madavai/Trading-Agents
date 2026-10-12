// The desk check: what this computer needs for the desk, said in plain words. It reads no secret: of the Robinhood
// sign-in it only says whether one is saved and when.
import fs from 'node:fs';
import path from 'node:path';
import { deskDataDir, robinhoodFile } from '../paths.js';
import { probeAll, type ProbeResult } from './probes.js';
import { VERSION } from '../version.js';
import { readSettings } from '../settings.js';
import { readContactEmail } from '../contact.js';

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

export function contactLine(email: string): Line {
  return email
    ? { ok: true, text: `Contact email for the SEC: ${email} (sent to sec.gov alone, kept in desk-data)` }
    : { ok: false, text: 'Contact email for the SEC: not given yet. The desk needs it before the first analysis: the SEC asks everyone who reads its filings for one. Ask the person for their own email and save it with set_contact_email' };
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

export async function deskCheck(root: string = process.cwd(), fetchImpl: typeof fetch = fetch): Promise<string> {
  const settings = readSettings(root), email = readContactEmail(root);
  const sources = await probeAll(settings.sources.contact, email, fetchImpl);
  return render([nodeLine(), dataLine(root), contactLine(email), robinhoodLine()], sources);
}
