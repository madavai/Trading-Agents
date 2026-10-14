// `node dist/terminal.mjs`: starts the dashboard on this computer and opens it in the browser. If this desk's dashboard is
// already running, it opens that one instead of starting a second. Stop it with Ctrl+C or by closing its window.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { configure } from '../data/http.js';
import { deskIdOf, loadAssets, PORTS, startTerminal } from './server.js';

const root = process.cwd();
const noOpen = process.argv.includes('--no-open');

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

for (let p = PORTS[0]; p <= PORTS[1]; p++) {
  if (await running(p)) {
    console.log(`The Trading Agents dashboard is already running: http://127.0.0.1:${p}/`);
    if (!noOpen) open(`http://127.0.0.1:${p}/`);
    process.exit(0);
  }
}

configure({ spacingMs: 250 });   // Yahoo is asked politely: one request at a time per host every quarter second
const t = await startTerminal({ root, assets: loadAssets() });
console.log(`The Trading Agents dashboard is running: ${t.url}`);
console.log('It works on this computer only. Leave this window open while you use it; press Ctrl+C to stop it.');
if (!noOpen) open(t.url);
const stop = () => { void t.close().then(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
