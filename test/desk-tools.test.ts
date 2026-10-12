import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isOrderTool } from '../src/robinhood/connect.js';
import { clearCache } from '../src/data/yahoo.js';
import { deskServer } from '../src/tools/server.js';
import { chartFetch, type Row } from './chart.js';

const forward = (from: string, n: number): string[] => { const out: string[] = []; const d = new Date(`${from}T00:00:00Z`); while (out.length < n) { if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
const rows = (from: string, closes: number[]): Row[] => forward(from, closes.length).map((date, i) => ({ date, o: closes[i]!, h: closes[i]!, l: closes[i]!, c: closes[i]!, v: 1000 }));
const feed = chartFetch((s) => (s === 'NVDA' ? rows('2026-09-01', [100, 101, 102, 103, 104, 110, 111]) : rows('2026-08-25', [195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 206, 207])));

async function connect() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-t-'));
  fs.copyFileSync('desk-settings.json', path.join(root, 'desk-settings.json'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root, feed).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  return { root, client, call };
}
beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearCache(); });

test('the desk tools are offered, and none of them can order', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['plan_analysis', 'save_run_section', 'read_run', 'write_report', 'record_decision', 'list_settlements', 'record_outcome', 'set_holdings', 'clear_holdings']) assert.ok(names.includes(n), n);
  assert.deepEqual(names.filter(isOrderTool), []);
  await client.close();
});

test('a whole analysis, as the agents will run it: plan, write, report, record, then settle', async () => {
  const { call, client } = await connect();
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /^NEEDS_EMAIL: .*set_contact_email/);
  await call('set_contact_email', { email: 'jane@mail.com' });
  assert.match(await call('set_holdings', { positions: [{ ticker: 'NVDA', quantity: 10, average_price: 95 }], cash: 5000, currency: 'USD' }), /Saved 1 position\(s\) and cash 5000/);

  const plan = await call('plan_analysis', { symbol: 'nvda', analysis_date: '2026-09-01', analysts: ['market', 'news'] });
  assert.match(plan, /^Analysis plan for NVDA on 2026-09-01 \(a past day/);
  assert.match(plan, /Analysts: market, news/);
  assert.match(plan, /Judged after 5 trading days against SPY/);
  assert.match(plan, /Current position in NVDA: 10 units, average price 95.00/);
  assert.match(plan, /Next step: market/);

  assert.match(await call('save_run_section', { symbol: 'NVDA', analysis_date: '2026-09-01', section: 'market', text: 'Market report' }), /Saved market/);
  assert.match(await call('read_run', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /Written so far for NVDA on 2026-09-01: market \(1\)/);
  assert.match(await call('read_run', { symbol: 'NVDA', analysis_date: '2026-09-01', sections: ['market', 'news'] }), /## Market Analyst\nMarket report\n\n\(No News Analyst yet/);
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /Steps \(resuming\): \[done\] market -> news/);

  assert.match(await call('write_report', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /^INPUT_ERROR: the portfolio manager's decision is not saved yet/);
  assert.match(await call('record_decision', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /^INPUT_ERROR: the portfolio manager's decision is not saved yet/);
  await call('save_run_section', { symbol: 'NVDA', analysis_date: '2026-09-01', section: 'decision', text: '**Rating**: Overweight\n\n**Executive Summary**: Add gradually.' });
  const report = await call('write_report', { symbol: 'NVDA', analysis_date: '2026-09-01' });
  assert.match(report, /Report written: .*complete_report\.md\nRating: Overweight/);
  const file = /Report written: (.*)\n/.exec(report)![1]!;
  assert.match(fs.readFileSync(file, 'utf8'), /- Analysts: market, news; research debate rounds 1, risk debate rounds 1; language English/);
  assert.match(await call('record_decision', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /^Recorded: NVDA on 2026-09-01, Overweight, pending\. It is scored after 5 trading days\./);
  assert.match(await call('record_decision', { symbol: 'NVDA', analysis_date: '2026-09-01' }), /already in the journal/);

  assert.match(await call('list_settlements'), /1 pending call\(s\), 1 ready[\s\S]*READY: NVDA \+10\.0%[\s\S]*alpha \+7\.0%/);
  assert.match(await call('record_outcome', { symbol: 'NVDA', trade_date: '2026-09-01', lesson: 'Alpha was +7.0%: the call was right; hold the size.' }), /^Settled: NVDA \+10\.0%/);
  assert.match(await call('list_settlements'), /No pending calls: every call in the journal is settled\./);
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-10-12', restart: true }), /Lessons from past calls:\nPast analyses of NVDA[\s\S]*Alpha was \+7\.0%/);

  assert.match(await call('clear_holdings'), /Forgotten/);
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-10-12', restart: true }), /Portfolio context: not provided/);
  await client.close();
});

test('a wrong request says what to correct, and a number is never accepted from an agent', async () => {
  const { call, client } = await connect();
  await call('set_contact_email', { email: 'jane@mail.com' });
  assert.match(await call('plan_analysis', { symbol: 'BTC-USD', analysis_date: '2026-10-12', analysts: ['fundamentals'] }), /^INPUT_ERROR: .*no company accounts\. Correct it and call again\./);
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2027-01-01' }), /^INPUT_ERROR: .*in the future/);
  assert.match(await call('set_holdings', { positions: [{ ticker: 'NVDA', quantity: 0 }] }), /^INPUT_ERROR: .*quantity of 0/);
  const schema = (await client.listTools()).tools.find((t) => t.name === 'record_outcome')!.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(schema).sort(), ['lesson', 'symbol', 'trade_date']);       // no field takes a return, an alpha or a price
  assert.match(await call('record_outcome', { symbol: 'NVDA', trade_date: '2026-09-01', lesson: 'x' }), /^INPUT_ERROR: there is no pending call on NVDA/);
  await client.close();
});
