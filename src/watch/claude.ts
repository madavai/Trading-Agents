// Claude Code, for the desk's watcher: where it is on this computer, and one run of the trading-desk team with it.
// What runs is fixed here, in code: the program, the team, the words and the permission mode. Nothing in the project's
// files can change it, so a file an agent could write never chooses what this program starts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Command { command: string; args: string[] }

/** The words the team is started with: the analyse playbook's waiting list. */
export const RUN_WORDS = 'Analyse what is waiting on the dashboard.';

/** The run: as the trading-desk team itself (its own tools, members and guard, as Madav runs it), printing its last
 *  answer, and refusing, never asking, anything the project's settings do not already allow. Never with permission
 *  checks bypassed. */
export const RUN_ARGS: readonly string[] = ['--agent', 'trading-desk', '--permission-mode', 'dontAsk', '--allowedTools', 'Agent,mcp__trading-desk', '--output-format', 'text', '-p', RUN_WORDS];

/** Claude Code on this computer, to be run without a shell: its program on the PATH (on Windows, the real program behind
 *  npm's claude.cmd), or in the folder its own installer uses. Null when it is not installed. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = (p) => fs.existsSync(p)): Command | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  if (platform === 'win32') {
    for (const d of [...dirs, p.join(home, '.local', 'bin')]) {
      if (exists(p.join(d, 'claude.exe'))) return { command: p.join(d, 'claude.exe'), args: [] };
      if (!exists(p.join(d, 'claude.cmd'))) continue;
      const pkg = p.join(d, 'node_modules', '@anthropic-ai', 'claude-code');
      if (exists(p.join(pkg, 'bin', 'claude.exe'))) return { command: p.join(pkg, 'bin', 'claude.exe'), args: [] };
      if (exists(p.join(pkg, 'cli.js'))) return { command: process.execPath, args: [p.join(pkg, 'cli.js')] };
    }
    return null;
  }
  for (const d of [...dirs, p.join(home, '.local', 'bin'), p.join(home, '.claude', 'local')]) if (exists(p.join(d, 'claude'))) return { command: p.join(d, 'claude'), args: [] };
  return null;
}

/** One run of the team in `root`. Its words go to `log`; a run longer than `timeoutMs` (three hours) is stopped. */
export function runClaude(cmd: Command, root: string, log: (text: string) => void, timeoutMs = 3 * 60 * 60_000, args: readonly string[] = RUN_ARGS): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(cmd.command, [...cmd.args, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => log(c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => log(c.toString('utf8')));
    child.on('error', (e) => { clearTimeout(timer); log(`Claude Code could not be started: ${e.message}\n`); resolve({ code: null, timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}
