import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ping = async (url: string): Promise<string | null> => { try { return ((await (await fetch(`${url}api/ping`)).json()) as { build?: string }).build ?? null; } catch { return null; } };
const stopAt = async (url: string): Promise<number> => {
  const token = /name="desk-token" content="([0-9a-f]+)"/.exec(await (await fetch(url)).text())?.[1] ?? '';
  return (await fetch(`${url}api/stop`, { method: 'POST', headers: { 'x-desk-token': token, 'content-type': 'application/json' }, body: '{}' })).status;
};

// The built program itself, copied to a folder of its own (so an "update" can be written to it), run on a throwaway desk
// with a throwaway home folder: it never sees anyone's real Robinhood sign-in.
test('the dashboard program restarts itself into an update on the same address, and Stop on the page ends it', { timeout: 60_000 }, async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-app-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-desk-')), home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-home-'));
  fs.copyFileSync('dist/terminal.mjs', path.join(app, 'terminal.mjs'));
  fs.cpSync('dist/terminal', path.join(app, 'terminal'), { recursive: true });
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const child = spawn(process.execPath, [path.join(app, 'terminal.mjs'), '--no-open'], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, TRADING_AGENTS_UPDATE_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  let url = '';
  try {
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    for (const until = Date.now() + 15_000; !url && Date.now() < until; await sleep(50)) url = /running: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1] ?? '';
    assert.ok(url, `the dashboard did not start: ${out}`);
    const first = await ping(url);
    assert.match(String(first), /^[0-9a-f]{12}$/);

    fs.appendFileSync(path.join(app, 'terminal', 'app.css'), '\n/* an update */\n');
    let next: string | null = null;
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(100)) { next = await ping(url); if (next && next !== first) break; }
    assert.ok(next && next !== first, 'a new dashboard answers on the same address, with the new code');
    assert.equal(await exited, 0, 'the old one has ended');

    assert.equal(await stopAt(url), 200);
    let gone = false;
    for (const until = Date.now() + 10_000; !gone && Date.now() < until; await sleep(100)) gone = (await ping(url)) === null;
    assert.ok(gone, 'Stop ends it');
  } finally {
    child.kill();
    if (url && (await ping(url))) await stopAt(url).catch(() => 0);   // a test that failed half-way leaves nothing running
  }
});
