import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { connect, NotSignedIn, openSession, waitForCode } from '../src/robinhood/connect.js';
import { Link } from '../src/robinhood/link.js';
import { startTerminal, type Assets, type Terminal } from '../src/terminal/server.js';
import { ACCOUNT, BUYING_POWER, fakeRobinhood, type Fake } from './fake-robinhood.js';

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const until = async (done: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) assert.fail('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };

let fake: Fake, dir: string, file: string, port: number, opened: string[];
/** The person's browser: opens Robinhood's page, approves, and is sent back to the desk with the code. */
const approves = (url: URL) => { opened.push(url.origin); void (async () => { const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); })(); };
/** The person's browser, refusing on Robinhood's page. */
const refuses = (url: URL) => { opened.push(url.origin); void fetch(`${url.searchParams.get('redirect_uri')}?error=access_denied`); };
const at = (where: 'approve' | 'nobody') => ({ url: fake.url, port, open: where === 'approve' ? approves : (u: URL) => { opened.push(u.origin); } });

beforeEach(async () => {
  fake = await fakeRobinhood(); opened = []; port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-link-')); file = path.join(dir, 'sign-in.json');
});
afterEach(async () => { await fake.close(); });

test('signing in sends the person to Robinhood once, saves the sign-in, and later sessions need no browser', async () => {
  const first = await openSession(file, { signIn: true, url: fake.url, port, open: approves });
  assert.equal(opened.length, 1);
  assert.equal(first.reader.byKind().read.length, 3);
  await first.close();
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fake.calls, [], 'signing in and listing the tools call no tool');

  const again = await openSession(file, { signIn: false, url: fake.url, port, open: () => assert.fail('a quiet session must not open a browser') });
  assert.equal(again.reader.tools.length, 8);
  await again.close();
  assert.equal(opened.length, 1);
});

test('a quiet session with no saved sign-in, or with one Robinhood no longer accepts, fails without a browser and without registering anything', async () => {
  await assert.rejects(openSession(file, { signIn: false, url: fake.url, port }), NotSignedIn);
  assert.equal(fake.hits.mcp, 0, 'with nothing saved Robinhood is not even asked');
  assert.equal(fs.existsSync(file), false);

  await (await openSession(file, { signIn: true, url: fake.url, port, open: approves })).close();
  const before = fs.readFileSync(file, 'utf8');
  fake.refuseAll = true;
  await assert.rejects(openSession(file, { signIn: false, url: fake.url, port, open: () => assert.fail('no browser') }), NotSignedIn);
  assert.ok(fake.hits.turnedAway >= 1);
  assert.equal(opened.length, 1, 'still only the one sign-in');
  assert.ok(fs.readFileSync(file, 'utf8').length > 0 && before.length > 0);
});

test('the connection test lists the kinds of tool and reads the positions through the reader, never an order tool', async () => {
  const c = await connect(file, { url: fake.url, port, open: approves });
  assert.equal(c.tools.length, 8);
  assert.deepEqual(c.tools.filter((t) => t.kind === 'order').map((t) => t.name).sort(), ['cancel_equity_order', 'place_equity_order', 'review_equity_order']);
  assert.equal(c.positions, 'get_equity_positions answered: positions: 2');
  assert.deepEqual(fake.calls, ['get_equity_positions']);
});

test('the link tells the dashboard where Robinhood stands: none, waiting, connected, failed, and none again after disconnecting', async () => {
  const link = new Link(file, { ...at('approve'), now: () => new Date('2026-10-12T15:00:00Z') });
  assert.equal(link.info().state, 'none');
  assert.equal((await link.check()).state, 'none');
  assert.equal(fake.hits.mcp, 0, 'a check with no sign-in saved asks Robinhood nothing');

  assert.equal(link.startSignIn().state, 'waiting');
  assert.equal(link.startSignIn().state, 'waiting', 'a second press does not start a second sign-in');
  await until(() => link.info().state !== 'waiting');
  const connected = link.info();
  assert.equal(connected.state, 'connected');
  assert.deepEqual(connected.tools, { read: 3, order: 3, other: 2 });
  assert.equal(connected.checkedAt, '2026-10-12T15:00:00.000Z');
  assert.match(connected.message, /Robinhood offers 8 tools: 3 that only read, 3 that order or move money \(this page never uses them\) and 2 others/);
  assert.equal(opened.length, 1);
  assert.deepEqual(fake.calls, []);

  assert.equal((await link.check()).state, 'connected');
  assert.equal(new Link(file, at('nobody')).info().state, 'saved', 'a new run of the dashboard knows a sign-in is saved, but has not checked it');

  fake.refuseAll = true;
  const lost = await link.check();
  assert.equal(lost.state, 'failed');
  assert.match(lost.message, /asks you to sign in again/);
  assert.equal(opened.length, 1, 'a check never sends the person to Robinhood');

  assert.equal(link.forget().state, 'none');
  assert.equal(fs.existsSync(file), false);
});

test('the way back from Robinhood closes its connection after every answer, so a later sign-in in the same program is not sent to a finished one', async () => {
  const w = waitForCode(port, () => 'good-state', 10_000);
  await new Promise((r) => setTimeout(r, 50));
  for (const [query, status] of [['code=x&state=bad', 400], ['code=the-code&state=good-state', 200]] as const) {
    const r = await fetch(`http://127.0.0.1:${port}/callback?${query}`);
    assert.equal(r.status, status);
    assert.equal(r.headers.get('connection'), 'close');
  }
  assert.equal(await w.code, 'the-code');
});

test('a refusal on Robinhood\'s page, or Robinhood not answering, is reported in plain words', async () => {
  const refused = new Link(file, { url: fake.url, port, open: refuses });
  refused.startSignIn();
  await until(() => refused.info().state !== 'waiting');
  assert.equal(refused.info().state, 'failed');
  assert.equal(refused.info().message, 'Robinhood refused the sign-in: access_denied');
  assert.equal(new Link(file, at('nobody')).info().state, 'none', 'a refused sign-in leaves nothing that counts as a connection');

  const link = new Link(file, { ...at('approve') });
  link.startSignIn();
  await until(() => link.info().state === 'connected');
  await fake.close();
  const down = await link.check();
  assert.equal(down.state, 'failed');
  assert.match(down.message, /^Robinhood did not answer as expected: /);
  assert.ok(down.message.length < 260);
  // Robinhood's own words can carry an account number: the message keeps the words and hides the number.
  const loud = http.createServer((_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('account 5RH88004321 is locked'); });
  await new Promise<void>((resolve) => loud.listen(0, '127.0.0.1', resolve));
  try {
    const said = await new Link(file, { url: `http://127.0.0.1:${(loud.address() as { port: number }).port}/mcp`, port }).check();
    assert.equal(said.state, 'failed');
    assert.match(said.message, /locked/);
    assert.ok(!said.message.includes('88004321'), said.message);
  } finally { loud.close(); }
});

// ---------- through the dashboard's server ----------
const ASSETS: Assets = new Map([['/index.html', { type: 'text/html; charset=utf-8', body: '<meta name="desk-token" content="__DESK_TOKEN__">' }]]);

test('the dashboard connects, checks and disconnects Robinhood on the page\'s own token, and shows nothing of the sign-in or the account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-term-rh-'));
  const link = new Link(file, at('approve'));
  const term: Terminal = await startTerminal({ root, assets: ASSETS, port: 0, robinhood: link });
  const bodies: string[] = [];
  const ask = async (method: string, p: string, o: { token?: boolean; headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${term.url.slice(0, -1)}${p}`, { method, headers: { ...(o.token === false ? {} : { 'x-desk-token': term.token }), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...o.headers }, body: method === 'POST' ? '{}' : undefined });
    const text = await res.text(); bodies.push(text);
    return { status: res.status, json: () => JSON.parse(text) as { state: string; tools: { read: number; order: number; other: number } | null; message: string } };
  };
  try {
    assert.equal((await ask('GET', '/api/robinhood', { token: false })).status, 403);
    assert.equal((await ask('POST', '/api/robinhood/connect', { token: false })).status, 403);
    assert.equal((await ask('POST', '/api/robinhood/connect', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(opened.length, 0, 'a refused call sends nobody to Robinhood');
    assert.equal((await ask('GET', '/api/robinhood')).json().state, 'none');

    assert.equal((await ask('POST', '/api/robinhood/connect')).json().state, 'waiting');
    await until(() => link.info().state !== 'waiting');
    const now = (await ask('GET', '/api/robinhood')).json();
    assert.equal(now.state, 'connected');
    assert.deepEqual(now.tools, { read: 3, order: 3, other: 2 });
    assert.equal((await ask('POST', '/api/robinhood/check')).json().state, 'connected');

    // nothing the page was told contains a pass, the client's id, or any figure of the account
    const saved = fs.readFileSync(file, 'utf8'), secrets = saved.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    assert.ok(secrets.length >= 1, 'the sign-in file holds ids that must stay in it');
    for (const body of bodies) for (const secret of [...secrets, ACCOUNT, BUYING_POWER, os.homedir()]) assert.ok(!body.includes(secret), `${secret} leaked into ${body}`);

    assert.equal((await ask('DELETE', '/api/robinhood')).json().state, 'none');
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fake.calls, [], 'the dashboard called no Robinhood tool at all');
  } finally { await term.close(); }
});
