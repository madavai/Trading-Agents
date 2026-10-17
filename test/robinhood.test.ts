import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FileAuth, readSaved } from '../src/robinhood/store.js';
import { isOrderTool, redirectFor, summarise, waitForCode } from '../src/robinhood/connect.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-rh-')), 'robinhood.json');
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

test('the sign-in keeps what Robinhood gives back, in a file only the person can read', () => {
  const file = tmpFile();
  const auth = new FileAuth(file, redirectFor(47613), () => {});
  assert.equal(auth.tokens(), undefined);
  auth.saveClientInformation({ client_id: 'abc' });
  auth.saveTokens({ access_token: 'secret-a', token_type: 'Bearer', refresh_token: 'secret-r' });
  auth.saveCodeVerifier('v1');
  assert.equal(auth.clientInformation()?.client_id, 'abc');
  assert.equal(auth.tokens()?.access_token, 'secret-a');
  assert.equal(auth.codeVerifier(), 'v1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  auth.invalidateCredentials('tokens');
  assert.equal(auth.tokens(), undefined);
  assert.equal(auth.clientInformation()?.client_id, 'abc');
  auth.invalidateCredentials('all');
  assert.deepEqual(Object.keys(readSaved(file)), ['savedAt']);
  assert.throws(() => auth.codeVerifier(), /lost its place/);
});

test('the registration asks only for a public client that comes back to this computer', () => {
  const auth = new FileAuth(tmpFile(), redirectFor(47613), () => {});
  assert.deepEqual(auth.clientMetadata.redirect_uris, ['http://127.0.0.1:47613/callback']);
  assert.equal(auth.clientMetadata.token_endpoint_auth_method, 'none');
  const state = auth.state();
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.equal(auth.expectedState(), state);
});

test('the way back from Robinhood takes the code only with the right state', async () => {
  const port = await freePort();
  const w = waitForCode(port, () => 'good-state', 10_000);
  await new Promise((r) => setTimeout(r, 50));
  const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=bad`);
  assert.equal(wrong.status, 400);
  const right = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=good-state`);
  assert.equal(right.status, 200);
  assert.match(await right.text(), /Signed in to Robinhood/);
  assert.equal(await w.code, 'the-code');
});

test('with no state kept for the sign-in, no way back is accepted at all (it fails closed)', async () => {
  const port = await freePort();
  const w = waitForCode(port, () => undefined, 10_000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=anything`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=`)).status, 400);
  w.close();
});

test('a refusal on Robinhood\'s page ends the wait with its reason', async () => {
  const port = await freePort();
  const w = waitForCode(port, () => 's', 10_000);
  const refused = assert.rejects(w.code, /Robinhood refused the sign-in: access_denied/);
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
  await refused;
});

test('a read is summarised by counts, never repeated', () => {
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
  assert.equal(summarise(text('[{"symbol":"NVDA"},{"symbol":"AAPL"}]')), '2 item(s)');
  assert.equal(summarise(text('{"positions":[1,2,3],"next":null}')), 'positions: 3');
  assert.equal(summarise(text('{"buying_power":"10"}')), 'fields: buying_power');
  assert.equal(summarise(text('plain words')), '11 characters of text');
});

test('trading tools are named as such, reads are not', () => {
  assert.equal(isOrderTool('place_equity_order'), true);
  assert.equal(isOrderTool('cancel_order'), true);
  assert.equal(isOrderTool('review_equity_order'), true);   // a review names an order: agents never call it either
  assert.equal(isOrderTool('get_equity_positions'), false);
});
