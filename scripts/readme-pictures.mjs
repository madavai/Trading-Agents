// The README's pictures: each part of the visual guide (docs/inside-the-trading-desk.html), photographed in its light
// and its dark face by a hidden Chrome or Edge on this computer, into docs/readme. Run it after the guide changes:
//   node scripts/readme-pictures.mjs
// It needs Chrome or Edge, and the internet for the guide's two fonts. Nothing is downloaded or installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const guide = pathToFileURL(path.join(root, 'docs', 'inside-the-trading-desk.html')).href;
const out = path.join(root, 'docs', 'readme');

/** The parts photographed: the opening banner and each chapter but the notice, which the README gives in words. */
const PARTS = [['hero', '.hero'], ...['glance', 'sources', 'agents', 'journey', 'kept', 'robinhood', 'dashboard'].map((id) => [id, `#${id}`])];
const WIDTH = 1040, SCALE = 1.5, QUALITY = 86;

/** For a still picture: no moving dots, no buttons that would do nothing in a picture, and each part a card of its own. */
const STILL = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .pulse, .hero-tools, .bar { display: none !important; }
  html, body { background: transparent !important; }
  .shot { box-sizing: border-box; background: var(--canvas); padding: 28px; border-radius: 18px; }
  .hero.shot { padding: 0; }
`;

const BROWSERS = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
const browser = process.env.BROWSER_PATH ?? BROWSERS.find((b) => fs.existsSync(b));
if (!browser) throw new Error('No Chrome or Edge found; set BROWSER_PATH to one.');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-pictures-'));
const proc = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

try {
  const port = await new Promise((resolve, reject) => {
    const file = path.join(profile, 'DevToolsActivePort'), until = Date.now() + 20_000;
    const look = () => {
      if (fs.existsSync(file)) { const [p] = fs.readFileSync(file, 'utf8').split('\n'); if (p) return resolve(Number(p)); }
      if (Date.now() > until) return reject(new Error('The browser did not start.'));
      setTimeout(look, 100);
    };
    look();
  });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not reach the browser.')); });

  let next = 0;
  const waiting = new Map(), events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg.method);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1000, deviceScaleFactor: SCALE, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: guide });
  for (const until = Date.now() + 30_000; !events.includes('Page.loadEventFired'); ) {
    if (Date.now() > until) throw new Error('The guide did not load.');
    await new Promise((r) => setTimeout(r, 100));
  }
  await run(`(async () => {
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(STILL)}; document.head.append(s);
    ${JSON.stringify(PARTS.map(([, sel]) => sel))}.forEach((sel) => document.querySelector(sel).classList.add('shot'));
    await document.fonts.ready;
  })()`);

  fs.mkdirSync(out, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    await new Promise((r) => setTimeout(r, 300));
    for (const [name, sel] of PARTS) {
      const box = await run(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      const shot = await send('Page.captureScreenshot', { format: 'webp', quality: QUALITY, captureBeyondViewport: true, clip: { ...box, scale: 1 } });
      const file = path.join(out, `${name}-${theme}.webp`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`${path.relative(root, file)}  ${Math.round(box.width)}x${Math.round(box.height)}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  }
  ws.close();
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
