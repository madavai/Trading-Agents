import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, probeAll, SOURCES, userAgentFor } from '../src/check/probes.js';
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
  assert.match(r.detail, /refused \(HTTP 403\): the SEC asks everyone who reads its filings for a contact email.*set_contact_email/);
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

test('every source is asked with the contact as the user agent, and only the SEC sees the email', async () => {
  const seen = new Map<string, string>();
  const f: typeof fetch = async (url, init) => { seen.set(new URL(String(url)).hostname, String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date', { status: 200 }); };
  const all = await probeAll('trading-agents (+x)', 'me@example.com', f);
  assert.equal(all.length, SOURCES.length);
  for (const [host, ua] of seen) assert.equal(ua, host === 'www.sec.gov' ? 'trading-agents me@example.com' : 'trading-agents (+x)', host);
  assert.ok(seen.has('www.sec.gov'));
  assert.equal(userAgentFor('https://data.sec.gov/x', 'c', 'me@example.com'), 'c me@example.com');
  assert.equal(userAgentFor('https://notsec.gov/x', 'c', 'me@example.com'), 'c');
  assert.equal(userAgentFor('https://www.sec.gov/x', 'c', '  '), 'c');
});

test('the SEC is told the project name and the email, never a bracketed web address, which it refuses (HTTP 403) even with the email', () => {
  const contact = 'trading-agents (+https://github.com/madavai/trading-agents)';
  assert.equal(userAgentFor('https://www.sec.gov/files/company_tickers.json', contact, 'me@mail.com'), 'trading-agents me@mail.com');
  assert.equal(userAgentFor('https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json', contact, ' me@mail.com '), 'trading-agents me@mail.com');
  assert.equal(userAgentFor('https://data.sec.gov/x', '(+only a web address)', 'me@mail.com'), 'trading-agents me@mail.com');   // nothing left of the name: the project's own
  assert.equal(userAgentFor('https://query1.finance.yahoo.com/x', contact, 'me@mail.com'), contact);                          // every other source still sees the project's name and address, never the email
  assert.equal(userAgentFor('https://www.sec.gov/x', contact, ''), contact);                                                  // no email yet: nothing more to say
});

test('when the SEC refuses with the email sent, the check does not claim the email is missing', async () => {
  const sent = await probe(source, 'ua', answer(403, 'Request Rate Threshold Exceeded'), 8000, true);
  assert.equal(sent.ok, false);
  assert.match(sent.detail, /refused \(HTTP 403\): the SEC refused even though a contact email was sent, so the email is not what is missing/);
  assert.doesNotMatch(sent.detail, /none is saved|set_contact_email/);
  const refusedAll = (await probeAll('c', 'me@mail.com', answer(403, 'no'))).find((r) => r.name === 'SEC EDGAR')!;
  assert.match(refusedAll.detail, /even though a contact email was sent/);
  const noEmail = (await probeAll('c', '', answer(403, 'no'))).find((r) => r.name === 'SEC EDGAR')!;
  assert.match(noEmail.detail, /none is saved yet.*set_contact_email/);
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
