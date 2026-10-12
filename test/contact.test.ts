import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { checkEmail, readContactEmail, saveContactEmail } from '../src/contact.js';
import { contactLine, deskCheck } from '../src/check/desk-check.js';
import { deskServer } from '../src/tools/server.js';

const folder = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-')); fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json')); return root; };

test('only an address that can reach a person is accepted', () => {
  assert.equal(checkEmail('  Jane.Roe+desk@mail.co.uk '), 'Jane.Roe+desk@mail.co.uk');
  for (const bad of ['', 'jane', 'jane@', 'jane@mail', 'jane roe@mail.com', 'jane@mail.com\r\nX-Evil: 1', '<jane@mail.com>']) assert.throws(() => checkEmail(bad), /is not an email address/, bad);
  for (const fake of ['me@example.com', 'me@mail.example.org', 'me@host.test', 'me@localhost.invalid']) assert.throws(() => checkEmail(fake), /made-up example address/, fake);
});

test('the address is kept in desk-data, which git ignores, and read back', () => {
  const root = folder();
  assert.equal(readContactEmail(root), '');
  saveContactEmail(root, 'jane@mail.com');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'desk-data', 'contact.json'), 'utf8')), { email: 'jane@mail.com' });
  assert.equal(readContactEmail(root), 'jane@mail.com');
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /^desk-data\/?$/m);
  fs.writeFileSync(path.join(root, 'desk-data', 'contact.json'), '{"email":"me@example.com"}');
  assert.equal(readContactEmail(root), '');                 // a made-up address counts as none
});

test('the desk check says plainly when the email is missing', async () => {
  assert.equal(contactLine('').ok, false);
  assert.match(contactLine('').text, /not given yet\. The desk needs it before the first analysis.*set_contact_email/);
  const root = folder(), seen = new Map<string, string>();
  const f: typeof fetch = async (url, init) => { seen.set(new URL(String(url)).hostname, String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('{"chart":1,"news":1,"messages":1,"ticker":1} <feed observation_date'); };
  assert.match(await deskCheck(root, f), /NO  Contact email for the SEC: not given yet/);
  saveContactEmail(root, 'jane@mail.com');
  assert.match(await deskCheck(root, f), /OK  Contact email for the SEC: jane@mail\.com \(sent to sec\.gov alone/);
  for (const [host, ua] of seen) assert.equal(ua.includes('jane@mail.com'), host === 'www.sec.gov', host);
});

test('the person gives the email through the desk tool, and from then on only the SEC sees it', async () => {
  const root = folder(), seen = new Map<string, string>();
  const f: typeof fetch = async (url, init) => { seen.set(new URL(String(url)).hostname, String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('{}'); };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, f).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (email: string) => ((await client.callTool({ name: 'set_contact_email', arguments: { email } })) as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(await call('me@example.com'), /^INPUT_ERROR: me@example\.com is a made-up example address/);
  assert.equal(readContactEmail(root), '');
  assert.match(await call('jane@mail.com'), /^Saved\. The SEC will see jane@mail\.com/);
  assert.equal(readContactEmail(root), 'jane@mail.com');
  await client.callTool({ name: 'get_prediction_markets', arguments: { topic: 'Fed rate cut', analysis_date: new Date().toISOString().slice(0, 10) } });
  await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: new Date().toISOString().slice(0, 10), statement: 'balance_sheet' } });
  assert.ok(seen.size >= 2);
  for (const [host, ua] of seen) assert.equal(ua.includes('jane@mail.com'), host.endsWith('sec.gov'), host);
  await client.close();
});
