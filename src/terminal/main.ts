// `node dist/terminal.mjs`: starts the dashboard on this computer and opens it in the browser. If this desk's dashboard is
// already running, it opens that one instead of starting a second. Stop it with Ctrl+C, by closing its window, or with
// Stop on the page. After an update, Restart on the page starts it again on the same address (`--port=N`, without
// opening the browser again), so the open page reloads into the new version where the person left it.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configure } from '../data/http.js';
import { deskIdOf, loadAssets, PORTS, startTerminal, type Terminal, type TerminalOptions } from './server.js';

const root = process.cwd();
const noOpen = process.argv.includes('--no-open');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const wanted = portArg ? Number(portArg.slice('--port='.length)) : NaN;
const again = Number.isInteger(wanted) && wanted >= PORTS[0] && wanted <= PORTS[1];

function open(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the address is printed too */ }
}

/** Whether a dashboard of this very desk already answers on a port. */
const running = (port: number): Promise<boolean> => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 700 }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { const j = JSON.parse(b) as { app?: string; desk?: string }; resolve(j.app === 'trading-agents' && j.desk === deskIdOf(root)); } catch { resolve(false); } });
  });
  req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
});

if (!again) {
  for (let p = PORTS[0]; p <= PORTS[1]; p++) {
    if (await running(p)) {
      console.log(`The Trading Agents dashboard is already running: http://127.0.0.1:${p}/`);
      if (!noOpen) open(`http://127.0.0.1:${p}/`);
      process.exit(0);
    }
  }
}

// The dashboard's own code: this program and the page's files. When an update changes them, the page offers Restart.
const self = fileURLToPath(import.meta.url);
const code = [self, ...['index.html', 'app.js', 'app.css'].map((f) => path.join(path.dirname(self), 'terminal', f))];

let t: Terminal | null = null;
const quit = () => { void (t?.close() ?? Promise.resolve()).then(() => process.exit(0)); };
const restart = () => {
  const port = t?.port;
  void (t?.close() ?? Promise.resolve()).then(() => {
    spawn(process.execPath, [self, '--no-open', ...(port ? [`--port=${port}`] : [])], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    setTimeout(() => process.exit(0), 200);
  });
};

configure({ spacingMs: 250 });   // Yahoo is asked politely: one request at a time per host every quarter second
// For the tests only: how often to look for an update (normally every 15 seconds).
const quick = Number(process.env.TRADING_AGENTS_UPDATE_MS) || undefined;
const base: TerminalOptions = { root, assets: loadAssets(), code, restart, stop: quit, ...(quick ? { updateCheckMs: quick } : {}) };
/** On a restart the old dashboard has only just let go of its address, so it is asked for a few times before any other. */
async function start(): Promise<Terminal> {
  if (again) for (let i = 0; i < 20; i++) {
    try { return await startTerminal({ ...base, port: wanted }); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return startTerminal(base);
}
t = await start();
console.log(`The Trading Agents dashboard is running: ${t.url}`);
console.log('It works on this computer only. Leave this window open while you use it; press Ctrl+C to stop it.');
if (!noOpen) open(t.url);
process.on('SIGINT', quit); process.on('SIGTERM', quit);
