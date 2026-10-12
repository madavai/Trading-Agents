import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, probeAll, SOURCES, userAgent } from '../src/check/probes.js';
import { dataLine, deskCheck, nodeLine, robinhoodLine } from '../src/check/desk-check.js';

const answer = (status: number, body: string): typeof fetch => async () => new Response(body, { status });
const source = SOURCES.find((s) => s.name === 'SEC EDGAR')!;

test('a source that answers with its data is ready', async () => {
  const r = await probe(source, 'ua', answer(200, '{"0":{"ticker":"AAPL"}}'));
  assert.equal(r.ok, true);
  assert.match(r.detail, /^answered in \d+ ms$/);
});

test('a refusal is reported as a refusal, with what to do for the SEC', async () => {
  const r = await probe(source, 'ua', answer(403, 'Forbidden'));
  assert.equal(r.ok, false);
  assert.match(r.detail, /refused \(HTTP 403\): the SEC asks every caller for a contact email/);
});

test('an answer without the expected data is not counted as ready', async () => {
  const r = await probe(source, 'ua', answer(200, '<html>consent page</html>'));
  assert.equal(r.ok, false);
  assert.match(r.detail, /not with the data the desk reads/);
});

test('silence and network failures read as unreachable, never as no data', async () => {
  const timeout: typeof fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  assert.match((await probe(source, 'ua', timeout)).detail, /unreachable \(no answer within 8 s\)/);
  const down: typeof fetch = async () => { throw new TypeError('fetch failed'); };
  assert.match((await probe(source, 'ua', down)).detail, /unreachable \(fetch failed\)/);
});

test('every source is asked, with the contact as the user agent', async () => {
  const seen: string[] = [];
  const f: typeof fetch = async (_url, init) => { seen.push(String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date', { status: 200 }); };
  const all = await probeAll('trading-agents (+x)', 'me@example.com', f);
  assert.equal(all.length, SOURCES.length);
  assert.ok(seen.every((u) => u === 'trading-agents (+x) me@example.com'));
  assert.equal(userAgent('c', '  '), 'c');
});

test('the machine lines say what is missing in plain words', () => {
  assert.equal(nodeLine('22.4.0').ok, true);
  assert.match(nodeLine('20.11.1').text, /too old: install Node 22/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  assert.equal(dataLine(root).ok, true);
  assert.ok(fs.existsSync(path.join(root, 'desk-data')));
  assert.match(robinhoodLine(path.join(root, 'none.json')).text, /not connected yet/);
  fs.writeFileSync(path.join(root, 'rh.json'), '{}');
  assert.match(robinhoodLine(path.join(root, 'rh.json')).text, /a sign-in is saved/);
});

test('the desk check reads the settings and reports every source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const text = await deskCheck(root, answer(200, '{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date'));
  assert.match(text, /^Trading Agents desk check/);
  for (const s of SOURCES) assert.match(text, new RegExp(`OK  ${s.name.replace(/[()]/g, '\\$&')}`));
  assert.match(text, /Everything the desk reads is reachable\./);
});
