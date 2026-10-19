import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ping = async (url: string): Promise<string | null> => { try { return ((await (await fetch(`${url}api/ping`)).json()) as { build?: string }).build ?? null; } catch { return null; } };
/** The one-time link the program prints (and opens the browser on): the page's only way to its key. */
const linkIn = (out: string): string => /(http:\/\/127\.0\.0\.1:\d+\/#open=[0-9a-f]{36})/.exec(out)?.[1] ?? '';
/** What the page does with that link: swaps the claim for the key, once. */
const claim = async (link: string): Promise<string> => {
  const [url, c] = link.split('#open=');
  const r = await fetch(`${url}api/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: c }) });
  return r.ok ? ((await r.json()) as { key?: string }).key ?? '' : '';
};
let key = '';
const press = async (url: string, what: 'stop' | 'restart'): Promise<number> =>
  (await fetch(`${url}api/${what}`, { method: 'POST', headers: { 'x-desk-token': key, 'content-type': 'application/json' }, body: '{}' })).status;
const stopAt = (url: string) => press(url, 'stop');
const version = async (url: string): Promise<{ status: number; update?: boolean }> => { try { const r = await fetch(`${url}api/version`, { headers: { 'x-desk-token': key } }); return { status: r.status, ...((await r.json()) as { update?: boolean }) }; } catch { return { status: 0 }; } };
const offered = async (url: string): Promise<boolean> => (await version(url)).update === true;

/** The built program, started on a throwaway desk with a throwaway home folder (it never sees anyone's real Robinhood
 *  sign-in), its words gathered. */
function program(app: string, root: string, home: string): { child: ReturnType<typeof spawn>; out: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [path.join(app, 'terminal.mjs'), '--no-open'], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, TRADING_AGENTS_UPDATE_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
  return { child, out: () => out, exited: new Promise<number | null>((resolve) => child.on('exit', resolve)) };
}

// The built program itself, copied to a folder of its own (so an "update" can be written to it).
test('the dashboard program opens on a one-time link, keeps its key for a second opening, offers an update, restarts into it on the person\'s press on the same address with the same key, and Stop on the page ends it', { timeout: 60_000 }, async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-app-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-desk-')), home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-home-'));
  fs.copyFileSync('dist/terminal.mjs', path.join(app, 'terminal.mjs'));
  fs.cpSync('dist/terminal', path.join(app, 'terminal'), { recursive: true });
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const first = program(app, root, home);
  let url = '';
  try {
    for (const until = Date.now() + 15_000; !url && Date.now() < until; await sleep(50)) url = /running: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(first.out())?.[1] ?? '';
    assert.ok(url, `the dashboard did not start: ${first.out()}`);
    let link = '';
    for (const until = Date.now() + 5_000; !link && Date.now() < until; await sleep(50)) link = linkIn(first.out());
    assert.ok(link.startsWith(url), `a one-time link is printed: ${first.out()}`);
    assert.ok(!(await (await fetch(url)).text()).includes('#open='), 'the page carries no key and no link');
    key = await claim(link);
    assert.match(key, /^[0-9a-f]{48}$/, 'the link gives the page its key');
    assert.equal(await claim(link), '', 'once');
    assert.equal((await version(url)).status, 200);
    const build = await ping(url);
    assert.match(String(build), /^[0-9a-f]{12}$/);

    // started again while it runs: the program finds it and prints a fresh link into it, from the key kept in the home folder
    const second = program(app, root, home);
    let again = '';
    for (const until = Date.now() + 15_000; !again && Date.now() < until; await sleep(50)) again = linkIn(second.out());
    assert.equal(await second.exited, 0, 'the second start ends: one dashboard per desk');
    assert.ok(again.startsWith(url) && again !== link, `a fresh link into the running dashboard: ${second.out()}`);
    assert.equal(await claim(again), key, 'the same key, so the page it opens works');
    assert.deepEqual(fs.readdirSync(home).length, 1, 'the key is kept in the private folder the program made in the home folder');

    fs.appendFileSync(path.join(app, 'terminal', 'app.css'), '\n/* an update */\n');
    let seen = false;
    for (const until = Date.now() + 15_000; !seen && Date.now() < until; await sleep(100)) seen = await offered(url);
    assert.ok(seen, 'the page is offered the update');
    await sleep(300);
    assert.equal(await ping(url), build, 'and nothing restarts until the person presses Restart');
    assert.equal(await press(url, 'restart'), 200);
    let next: string | null = null;
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(100)) { next = await ping(url); if (next && next !== build) break; }
    assert.ok(next && next !== build, 'a new dashboard answers on the same address, with the new code');
    assert.equal(await first.exited, 0, 'the old one has ended');
    assert.equal((await version(url)).status, 200, 'the page keeps working on the key it holds: the restart handed it over');

    assert.equal(await stopAt(url), 200);
    let gone = false;
    for (const until = Date.now() + 10_000; !gone && Date.now() < until; await sleep(100)) gone = (await ping(url)) === null;
    assert.ok(gone, 'Stop ends it');
  } finally {
    first.child.kill();
    if (url && (await ping(url))) await stopAt(url).catch(() => 0);   // a test that failed half-way leaves nothing running
  }
});
