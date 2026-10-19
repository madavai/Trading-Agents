// Starting the dashboard from outside it: the desk's own tool `open_dashboard` (so a team in Madav's Agent Studio can
// show the person their dashboard without being given a shell) and `/terminal`. It holds none of the dashboard's server,
// its Robinhood link or its order door: the agents' tool server imports this file, and a test checks that its built bundle
// contains no order tool. The dashboard is started as its own program and opens itself in the person's browser.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PORTS = [47615, 47625] as const;
/** Which desk a running dashboard belongs to: a short fingerprint of its folder. */
export const deskIdOf = (root: string): string => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);

/** The port on which this desk's dashboard answers, or null. */
export async function runningOn(root: string, timeoutMs = 700): Promise<number | null> {
  const ask = (port: number) => new Promise<boolean>((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { const j = JSON.parse(b) as { app?: string; desk?: string }; resolve(j.app === 'trading-agents' && j.desk === deskIdOf(root)); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
  });
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (await ask(p)) return p;
  return null;
}

/** Starts this desk's dashboard (or finds the one already running) and says where it is. It opens itself in the browser. */
export async function openDashboard(root: string, opts: { waitMs?: number; noOpen?: boolean } = {}): Promise<string> {
  const already = await runningOn(root);
  const words = (port: number, started: boolean) => `The dashboard ${started ? 'has started and opened' : 'was already running and has opened'} in the person's browser (http://127.0.0.1:${port}/ , this computer only). The page it opened is the one to use: it was given the dashboard's key, and the address typed into another browser opens a page without one. It stays open until the person presses Stop on it. Everything on it - connecting Robinhood, choosing accounts, the trading switch and caps, and every order's Review, Place and Confirm - is the person's own to press: never press it for them or reach the page yourself.`;
  if (already) {
    if (!opts.noOpen) spawn(process.execPath, [path.join(root, 'dist', 'terminal.mjs')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    return words(already, false);
  }
  const child = spawn(process.execPath, [path.join(root, 'dist', 'terminal.mjs'), ...(opts.noOpen ? ['--no-open'] : [])], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  const end = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < end) {
    const port = await runningOn(root, 400);
    if (port) return words(port, true);
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'DATA_UNAVAILABLE: the dashboard did not answer within 15 seconds. Ask the person to run /terminal, or `node dist/terminal.mjs` in this folder, and to tell you what it prints.';
}
