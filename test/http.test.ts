import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure, getJson, getText, Unavailable } from '../src/data/http.js';
import { clearSecCache } from '../src/data/sec.js';
import { deskServer } from '../src/tools/server.js';
import { financialStatement } from '../src/data/company.js';

afterEach(() => { configure({ fetch: fetch, secEmail: '', spacingMs: 0, cacheDir: null }); clearSecCache(); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta-h-'));

test('the email is looked up when a request is made, so a copy of the server that began without it still sends it', async () => {
  const seen: string[] = [];
  let email = '';
  configure({ contact: 'ta (+x)', secEmail: () => email, fetch: async (_u, init) => { seen.push(String((init?.headers as Record<string, string>)['User-Agent'])); return new Response('ok'); } });
  await getText('https://data.sec.gov/a');
  email = 'jane@mail.com';                                  // saved after this copy started
  await getText('https://data.sec.gov/b');
  await getText('https://query1.finance.yahoo.com/c');
  assert.deepEqual(seen, ['ta (+x)', 'ta jane@mail.com', 'ta (+x)']);   // the SEC is told the name and the email, no bracketed address
});

test('a server started before the email was saved still sends it to the SEC (the first real run\'s fundamentals failure)', async () => {
  const root = tmp();
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const seen: string[] = [];
  const f: typeof fetch = async (url, init) => { seen.push(`${new URL(String(url)).hostname} ${(init?.headers as Record<string, string>)['User-Agent']}`); return new Response('{}'); };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, f).connect(a);                      // started: no email anywhere yet
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  fs.mkdirSync(path.join(root, 'desk-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desk-data', 'contact.json'), JSON.stringify({ email: 'jane@mail.com' }));   // another copy saved it
  await client.callTool({ name: 'get_financial_statement', arguments: { symbol: 'ACME', analysis_date: '2026-09-01', statement: 'balance_sheet' } });
  assert.ok(seen.some((s) => s.startsWith('www.sec.gov') && s.endsWith('jane@mail.com')), seen.join(' | '));
  await client.close();
});

test('a refusal says what the source said, and whether an email was sent', async () => {
  configure({ secEmail: '', fetch: async () => new Response('<html><body><h1>Your Request Originates from an Undeclared Automated Tool</h1></body></html>', { status: 403 }) });
  await assert.rejects(getText('https://data.sec.gov/x'), /data\.sec\.gov refused \(HTTP 403\), saying "Your Request Originates from an Undeclared Automated Tool" \[no contact email was sent\]/);
  configure({ secEmail: 'jane@mail.com' });
  await assert.rejects(getText('https://data.sec.gov/x'), /\[a contact email was sent\]$/);
  await assert.rejects(getText('https://query1.finance.yahoo.com/x'), (e: Error) => !/contact email/.test(e.message) && /refused \(HTTP 403\)/.test(e.message));
});

test('only a refusal with no email sent asks the person for one; with one sent, the SEC\'s own words stand', async () => {
  const sec = (email: string) => { configure({ secEmail: email, fetch: async (u) => (/company_tickers/.test(String(u)) ? new Response('Forbidden', { status: 403 }) : new Response('x', { status: 500 })) }); clearSecCache(); };
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  sec('');
  await assert.rejects(financialStatement('ACME', 'balance_sheet', 'annual', '2026-09-01'), /\[no contact email was sent\]: the SEC asks every program that reads its filings for a contact email/);
  sec('jane@mail.com');
  await assert.rejects(financialStatement('ACME', 'balance_sheet', 'annual', '2026-09-01'), (e: Error) => /\[a contact email was sent\]/.test(e.message) && !/asks every program that reads/.test(e.message));
});

test('a busy source is asked again, as long as it says, up to three times; then it is named as rate-limiting', async () => {
  let calls = 0;
  configure({ fetch: async () => (++calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok')) });
  assert.equal(await getText('https://query1.finance.yahoo.com/a'), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  configure({ fetch: async () => { calls++; return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } }); } });
  await assert.rejects(getText('https://query1.finance.yahoo.com/b'), (e: Error) => e instanceof Unavailable && /refused \(HTTP 429\), saying "Too Many Requests"; it is rate-limiting this computer/.test(e.message));
  assert.equal(calls, 3);
});

test('requests to one host are spaced; another host is not held up', async () => {
  const starts: Array<[string, number]> = [];
  configure({ spacingMs: 80, fetch: async (u) => { starts.push([new URL(String(u)).hostname, Date.now()]); return new Response('ok'); } });
  await Promise.all([getText('https://y.test/1'), getText('https://y.test/2'), getText('https://y.test/3'), getText('https://other.test/1')]);
  const y = starts.filter(([h]) => h === 'y.test').map(([, t]) => t);
  // Each start waits for the one before it to have really started, then the whole gap: a stall makes gaps longer, never
  // shorter, and two waiting requests never go together. The gap is kept from the moment the wait ends; the test notes the
  // time a moment later, on a clock that counts whole milliseconds, so 2 ms is allowed (no spacing would be about 0).
  assert.ok(y[1]! - y[0]! >= 78 && y[2]! - y[1]! >= 78, y.join());
  assert.ok(starts.find(([h]) => h === 'other.test')![1] - y[0]! < 60, 'another host waited');
});

test('answers are kept on disk and shared; a failure is never kept; the crumb is not part of the key', async () => {
  const cacheDir = path.join(tmp(), 'cache');
  let calls = 0, fail = true;
  configure({ cacheDir, fetch: async () => { calls++; return fail ? new Response('down', { status: 400 }) : new Response('{"v":' + calls + '}'); } });
  await assert.rejects(getText('https://query1.finance.yahoo.com/q?x=1&crumb=abc'));
  fail = false;
  assert.equal(await getText('https://query1.finance.yahoo.com/q?x=1&crumb=abc'), '{"v":2}');         // the failure was not kept
  assert.equal(await getText('https://query1.finance.yahoo.com/q?x=1&crumb=OTHER'), '{"v":2}');         // a new session key finds the same answer
  assert.equal(await getText('https://query1.finance.yahoo.com/q?x=2'), '{"v":3}');                       // a different question is asked
  assert.equal(calls, 3);
  configure({ cacheDir: null });
  configure({ cacheDir });                                                                                 // another copy of the server reads the same files
  assert.equal(await getText('https://query1.finance.yahoo.com/q?x=1&crumb=zzz'), '{"v":2}');
  assert.equal(calls, 3);
});

test('answers expire: five minutes for most sources, a day for the SEC, and old files are cleared', async () => {
  const cacheDir = path.join(tmp(), 'cache');
  let calls = 0;
  configure({ cacheDir, fetch: async () => { calls++; return new Response('n' + calls); } });
  await getText('https://query1.finance.yahoo.com/a'); await getText('https://data.sec.gov/b');
  const age = (minutes: number) => { for (const f of fs.readdirSync(cacheDir)) { const t = new Date(Date.now() - minutes * 60_000); fs.utimesSync(path.join(cacheDir, f), t, t); } };
  age(2 * 60);                                                                                              // two hours old
  assert.equal(await getText('https://query1.finance.yahoo.com/a'), 'n3');                                  // Yahoo's is stale
  assert.equal(await getText('https://data.sec.gov/b'), 'n2');                                              // the SEC's still stands
  age(4 * 24 * 60);
  configure({ cacheDir });                                                                                  // clearing happens when the cache is opened
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

// Audit 3 prices-6 (9 Nov 2026): a 200 answer that was a web page ("will be right back") was kept on disk before it was
// found not to be data, so every copy of the tool server said the prices were unavailable for five minutes without asking
// the source again, although it was back.
test('an answer that is not data is never kept, and one kept by an older desk is not served: the source is asked again', async () => {
  const cacheDir = path.join(tmp(), 'cache'), url = 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d';
  let calls = 0, page = true;
  configure({ cacheDir, fetch: async () => { calls++; return new Response(page ? '<html>Will be right back</html>' : `{"v":${calls}}`); } });
  await assert.rejects(getJson(url), (e: Error) => e instanceof Unavailable && /answered with something that is not data/.test(e.message));
  assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [], 'nothing kept');
  page = false;
  assert.deepEqual(await getJson(url), { v: 2 }, 'asked again at once');
  assert.deepEqual(await getJson(url), { v: 2 }, 'the good answer is kept');
  assert.equal(calls, 2);
  for (const f of fs.readdirSync(cacheDir)) fs.writeFileSync(path.join(cacheDir, f), '<html>kept by an older desk</html>');
  assert.deepEqual(await getJson(url), { v: 3 }, 'a kept page is not served as data');
  assert.equal(await getText('https://www.sec.gov/Archives/x.htm'), '{"v":4}', 'a page asked for as text is still kept as before');
});
