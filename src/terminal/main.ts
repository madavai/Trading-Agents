// `node dist/terminal.mjs`: starts the dashboard on this computer and opens it in the browser, on a one-time link that
// gives the page its key (the key is in no page the dashboard serves). If this desk's dashboard is already running, it
// opens that one instead of starting a second, again on a one-time link: the running dashboard's key is read from the
// person's private folder, where only their own programs can. Stop it with Ctrl+C, by closing its window, or with Stop
// on the page. After an update, Restart on the page starts it again on the same address (`--port=N`, without opening
// the browser again) with the same key, handed over in the new program's own environment and never on a command line,
// so the open page reloads into the new version where the person left it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configure } from '../data/http.js';
import { dashboardKeyFile } from '../paths.js';
import { deskIdOf, loadAssets, PORTS, startTerminal, type Terminal, type TerminalOptions } from './server.js';

const root = process.cwd();
const noOpen = process.argv.includes('--no-open');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const wanted = portArg ? Number(portArg.slice('--port='.length)) : NaN;
const again = Number.isInteger(wanted) && wanted >= PORTS[0] && wanted <= PORTS[1];
// The key handed over by the dashboard this one restarts from: taken out of the environment at once, so nothing this
// program starts (a browser, Robinhood's sign-in page) inherits it.
const HANDED = 'TRADING_AGENTS_RESTART_KEY';
const handed = process.env[HANDED];
delete process.env[HANDED];

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

/** A one-time link into the dashboard already running on `port`: its key, read from the person's private folder, is
 *  swapped for a fresh claim, and the browser is opened on that. The key itself never reaches a command line. Without
 *  the key (a folder that could not be written, an older dashboard), the plain address is opened and the page says so. */
async function openingLink(port: number): Promise<string> {
  const plain = `http://127.0.0.1:${port}/`;
  try {
    const keys = JSON.parse(fs.readFileSync(dashboardKeyFile(), 'utf8')) as Record<string, { port?: unknown; key?: unknown } | undefined>;
    const mine = keys[deskIdOf(root)];
    if (!mine || mine.port !== port || typeof mine.key !== 'string') return plain;
    const r = await fetch(`${plain}api/claim/new`, { method: 'POST', headers: { 'x-desk-token': mine.key, 'content-type': 'application/json' }, body: '{}' });
    const { claim } = (await r.json()) as { claim?: unknown };
    return r.ok && typeof claim === 'string' ? `${plain}#open=${claim}` : plain;
  } catch { return plain; }
}

if (!again) {
  for (let p = PORTS[0]; p <= PORTS[1]; p++) {
    if (await running(p)) {
      console.log(`The Trading Agents dashboard is already running: http://127.0.0.1:${p}/`);
      const link = await openingLink(p);
      if (noOpen) console.log(`Open it with this link, which works once, within two minutes: ${link}`);
      else open(link);
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
  const port = t?.port, key = t?.token;
  void (t?.close() ?? Promise.resolve()).then(() => {
    spawn(process.execPath, [self, '--no-open', ...(port ? [`--port=${port}`] : [])], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(key ? { [HANDED]: key } : {}) } }).on('error', () => {}).unref();
    setTimeout(() => process.exit(0), 200);
  });
};

configure({ spacingMs: 250 });   // Yahoo is asked politely: one request at a time per host every quarter second
// For the tests only: how often to look for an update (normally every 15 seconds).
const quick = Number(process.env.TRADING_AGENTS_UPDATE_MS) || undefined;
// "Run automatically with Claude Code": the desk's own listener, a program of its own beside this one, which outlives a
// restart of the dashboard and is switched off from the page.
const listen = { start: () => { spawn(process.execPath, [path.join(path.dirname(self), 'watch.mjs')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } };
const base: TerminalOptions = { root, assets: loadAssets(), code, restart, stop: quit, listen, ...(quick ? { updateCheckMs: quick } : {}) };
/** On a restart the old dashboard has only just let go of its address, so it is asked for a few times before any other. */
async function start(): Promise<Terminal> {
  if (again) for (let i = 0; i < 20; i++) {
    try { return await startTerminal({ ...base, port: wanted, ...(handed ? { key: handed } : {}) }); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return startTerminal(base);
}
t = await start();
console.log(`The Trading Agents dashboard is running: ${t.url}`);
console.log('It works on this computer only. Leave this window open while you use it; press Ctrl+C to stop it.');
if (!again) {
  const link = `${t.url}#open=${t.claim()}`;
  if (noOpen) console.log(`Open it with this link, which works once, within two minutes: ${link}`);
  else { console.log('If no browser opened, open it yourself with this link, which works once, within two minutes:'); console.log(link); open(link); }
}
process.on('SIGINT', quit); process.on('SIGTERM', quit);
