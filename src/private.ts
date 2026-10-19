// The person's private folder (paths.ts homeDir): the Robinhood sign-in, the accounts they chose, the trading switch and
// caps, the fingerprint secret and the dashboard's key live there, and every one of them is written through here, so
// that only the person's own account can open them. On Linux and macOS the file mode does it (0700 for the folder,
// 0600 for a file). Windows ignores modes, so there the folder and each file get an access list of their own, naming
// the person's own account and the system alone (icacls): nothing is inherited from the folder above, and another
// account on this computer cannot open them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYSTEM = '*S-1-5-18';
let owner: string | null = null;
/** Windows' own tool of that name, by its full path: a shell's tool of the same name (Git's whoami) may come first on the PATH. */
const windowsTool = (exe: string): string => path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', exe);

/** The person's own Windows account as its SID (one spelling, where a name has many), or their user name if Windows will not say. */
export function ownerOnWindows(): string {
  if (owner) return owner;
  const r = spawnSync(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(r.stdout ?? '')?.[1];
  owner = sid ? `*${sid}` : os.userInfo().username;
  return owner;
}

/** What icacls is told: inherit nothing from above, and grant the person and the system alone. A folder passes its list
 *  on to whatever is made inside it. */
export const lockArgs = (target: string, folder: boolean, who: string): string[] => {
  const rights = folder ? '(OI)(CI)F' : 'F';
  return [target, '/inheritance:r', '/grant:r', `${who}:${rights}`, `${SYSTEM}:${rights}`];
};

/** Makes `target` (a file or a folder) the person's alone. False when it could not be done: the path is not there, or the
 *  drive keeps no access lists (a USB stick). */
export function lockDown(target: string): boolean {
  let folder: boolean;
  try { folder = fs.statSync(target).isDirectory(); } catch { return false; }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(target, folder ? 0o700 : 0o600); return true; } catch { return false; }
  }
  const icacls = (args: string[]) => spawnSync(windowsTool('icacls.exe'), args, { stdio: 'ignore', windowsHide: true, timeout: 15_000 }).status === 0;
  // /reset first drops any grant made by hand, so the list ends with exactly the two names below.
  return icacls([target, '/reset']) && icacls(lockArgs(target, folder, ownerOnWindows()));
}

/** Who can open `target`: locked (the person alone, with the system on Windows), open (others on this computer may), or unknown. */
export function lockState(target: string): 'locked' | 'open' | 'unknown' {
  try {
    if (process.platform !== 'win32') return (fs.statSync(target).mode & 0o077) === 0 ? 'locked' : 'open';
    const r = spawnSync(windowsTool('icacls.exe'), [target], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status !== 0) return 'unknown';
    const aces = r.stdout.split(/\r?\n/).filter((l) => /:\(/.test(l));
    return aces.length === 2 && aces.every((l) => !/\(I\)/.test(l)) ? 'locked' : 'open';
  } catch { return 'unknown'; }
}

const lockedFolders = new Set<string>();

/** Writes a private file whole: its folder made and locked (once a run), the text written beside the file and moved into
 *  place, then the file locked. Nothing half-written is ever in place. */
export function writePrivate(file: string, text: string): void {
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lockedFolders.has(folder)) { lockDown(folder); lockedFolders.add(folder); }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  lockDown(file);
}
