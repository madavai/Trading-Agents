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
  for (const n of ['plan_analysis', 'save_run_section', 'correct_report', 'read_run', 'write_report', 'record_decision', 'list_settlements', 'record_outcome', 'recheck_lessons', 'correct_lesson', 'flag_lesson', 'set_holdings', 'clear_holdings']) assert.ok(names.includes(n), n);
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

  // the fact checker corrects a report word for word through the desk, and nothing else in it changes
  const at = { symbol: 'NVDA', analysis_date: '2026-09-01' };
  await call('save_run_section', { ...at, section: 'market', text: 'Close 110 on volume 1,000. Up 10% in a week, the first time since May: a breakout. Volume 1,000 again.' });
  const fixed = await call('correct_report', { ...at, section: 'market', corrections: [
    { was: 'Up 10% in a week', now: 'Up 10% in five sessions' },
    { was: 'the first time since May', now: 'the first time in 63 sessions' },
    { was: '1,000', now: '1,200' },
    { was: 'Close 111', now: 'Close 110' },
  ], flag_after: ['a breakout'] });
  assert.match(fixed, /^The market report for NVDA on 2026-09-01:\n- corrected: "Up 10% in a week" now reads "Up 10% in five sessions"/);
  assert.match(fixed, /- not applied: "1,000" is in the market report 2 times; give more of the words around the one to correct, or set every/);
  assert.match(fixed, /- not applied: "Close 111" is not in the market report word for word/);
  assert.match(fixed, /- flagged the conclusion ending "a breakout"/);
  assert.match(await call('correct_report', { ...at, section: 'market', corrections: [{ was: '1,000', now: '1,200', every: true }] }), /corrected in 2 places: "1,000" now reads "1,200"/);
  assert.equal((await call('read_run', { ...at, sections: ['market'] })).split('\n').slice(1).join('\n'),
    'Close 110 on volume 1,200 [corrected: was "1,000"]. Up 10% in five sessions [corrected: was "Up 10% in a week"], the first time in 63 sessions [corrected: was "the first time since May"]: a breakout [the fact it rested on was corrected: see the fact check]. Volume 1,200 [corrected: was "1,000"] again.');
  assert.match(await call('correct_report', { ...at, section: 'news', corrections: [{ was: 'a', now: 'b' }] }), /^INPUT_ERROR: this run has no news report to correct/);
  await call('save_run_section', { ...at, section: 'bull', text: 'Bull turn' });
  assert.match(await call('correct_report', { ...at, section: 'market', corrections: [{ was: 'Close 110', now: 'Close 109' }] }), /^INPUT_ERROR: the debate has begun/);
  assert.match(await call('save_run_section', { ...at, section: 'market', text: 'Market report' }), /Saved market/);

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
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: '2026-10-12', restart: true }), /Portfolio context: none saved/);
  await client.close();
});

test('the trader, the risk voices and the portfolio manager read the holdings and lessons from the desk, as the plan saved them', async () => {
  const { call, client } = await connect();
  await call('set_contact_email', { email: 'jane@mail.com' });
  await call('set_holdings', { positions: [{ ticker: 'AAPL', quantity: 4 }], cash: 250, currency: 'USD' });
  const at = { symbol: 'NVDA', analysis_date: '2026-10-12' };
  const plan = await call('plan_analysis', at);
  assert.match(plan, /Saved with this run: the holdings and the lessons below\. The trader, the risk voices and the portfolio manager read them from the desk themselves \(read_run, sections holdings and lessons\): do not copy them into their requests\./);
  // what the trader reads: the saved holdings, word for word as the plan showed them, whatever its request carried
  const read = await call('read_run', { ...at, sections: ['holdings', 'lessons'] });
  assert.equal(read, '## Holdings\nPortfolio as given by the person on 2026-10-12 (it may have changed since):\n- No current position in NVDA\n- Cash available: 250.00 USD\n- Other positions: AAPL 4\n\n## Lessons\nLessons from past calls: none yet (no earlier call has been settled).');
  assert.ok(plan.includes(read.split('\n').slice(1, 5).join('\n')), 'the plan and the run say the same');
  // a run planned again (resumed) works from the latest holdings
  await call('save_run_section', { ...at, section: 'market', text: 'Market report' });
  await call('set_holdings', { positions: [{ ticker: 'NVDA', quantity: 3, average_price: 180 }], cash: 40, currency: 'USD' });
  assert.match(await call('plan_analysis', at), /Steps \(resuming\)/);
  assert.match(await call('read_run', { ...at, sections: ['holdings'] }), /^## Holdings\n.*\n- Current position in NVDA: 3 units, average price 180\.00\n- Cash available: 40\.00 USD$/);
  await call('clear_holdings');
  await call('plan_analysis', at);
  assert.match(await call('read_run', { ...at, sections: ['holdings'] }), /^## Holdings\nPortfolio context: none saved\./);
  assert.match(await call('save_run_section', { ...at, section: 'holdings' as never, text: 'Holds 1,000 NVDA' }), /^MCP error|Input validation error|Invalid/, 'no agent can write the holdings');
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

test('an old lesson is re-checked and corrected through the desk tools, and no field takes a number', async () => {
  const { root, call, client } = await connect();
  fs.mkdirSync(path.join(root, 'desk-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desk-data', 'journal.md'), '[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08]\n\nDECISION:\n**Rating**: Buy\n\nAdd on a close above 103.50.\n\nREFLECTION:\nNVDA never closed above 103.50.\n\n<!-- ENTRY_END -->\n\n');
  assert.match(await call('recheck_lessons'), /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*TO REWRITE[\s\S]*LESSON AS IT STANDS:\nNVDA never closed above 103\.50\.[\s\S]*WHAT HAPPENED IN THE WINDOW/);
  const schema = (await client.listTools()).tools.find((t) => t.name === 'correct_lesson')!.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(schema).sort(), ['lesson', 'symbol', 'trade_date', 'what_was_wrong']);   // no field takes a return, an alpha or a price
  const sorted = 'Contradicted: "never closed above 103.50": the 2026-09-07 row closed at 104.00. Not known from the prices: none. Right: none.';
  assert.match(await call('correct_lesson', { symbol: 'nvda', trade_date: '2026-09-01', lesson: 'Alpha of +7.0% backs the Buy. NVDA closed at 104.00 on 2026-09-07, above 103.50.', what_was_wrong: sorted }),
    /^Corrected: the lesson of the Buy call on NVDA for 2026-09-01, from its window 2026-09-01 to 2026-09-08\. Only the lesson changed/);
  assert.match(await call('recheck_lessons'), /^No lessons to re-check/);
  assert.match(await call('correct_lesson', { symbol: 'NVDA', trade_date: '2026-09-01', lesson: 'x', what_was_wrong: sorted }), /^INPUT_ERROR: the lesson of NVDA on 2026-09-01 was corrected on 2026-10-12 already; it is rewritten again only after the person says it is wrong \(flag_lesson\)\. Correct it and call again\.$/);
  // refused a second time, the desk says to leave it, never to call again
  const left = await call('correct_lesson', { symbol: 'NVDA', trade_date: '2026-09-01', lesson: 'x', what_was_wrong: sorted });
  assert.match(left, /^LEFT: correct_lesson has now refused the new lesson of NVDA on 2026-09-01 2 times in this re-check \(this time: the lesson of NVDA on 2026-09-01 was corrected on 2026-10-12 already; it is rewritten again only after the person says it is wrong \(flag_lesson\)\)\. Leave it: do not send it again/);
  assert.doesNotMatch(left, /call again/);
  assert.match(await call('recheck_lessons'), /^No lessons to re-check[\s\S]*LATER RE-CHECKS \(tell the person only this about them\): asking for a re-check again does not re-check a corrected lesson, nor one written from its window's prices\. If the person finds one of them wrong, they can say so/);
  await client.close();
});

test('a lesson the person says is wrong is flagged through the desk only when confirmed, then listed and rewritten keeping its earlier words; no field takes a number', async () => {
  const { root, call, client } = await connect();
  const file = path.join(root, 'desk-data', 'journal.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08 | lesson:corrected:2026-10-01]\n\nDECISION:\n**Rating**: Buy\n\nAdd on a close above 103.50.\n\nREFLECTION:\nNVDA stayed flat all week.\n\nLESSON CHECK:\n2026-10-01: rewritten from the window.\n\nFIRST LESSON:\nNVDA never closed above 103.50.\n\n<!-- ENTRY_END -->\n\n');
  const schema = (await client.listTools()).tools.find((t) => t.name === 'flag_lesson')!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['confirmed', 'symbol', 'trade_date', 'what_is_wrong']);   // no field takes a return, an alpha or a price
  assert.ok(schema.required?.includes('confirmed'), 'the person\'s confirmation is required');
  const said = { symbol: 'NVDA', trade_date: '2026-09-01', what_is_wrong: 'It says NVDA stayed flat, but it rose 10% in the window.' };
  assert.match(await call('flag_lesson', said), /^MCP error|Input validation error|Invalid/, 'never without the person\'s confirmation');
  assert.match(await call('flag_lesson', { ...said, confirmed: false }), /^MCP error|Input validation error|Invalid/);
  assert.match(await call('recheck_lessons'), /^No lessons to re-check/, 'nothing was flagged');
  assert.match(await call('flag_lesson', { ...said, confirmed: true }), /^Flagged: the lesson of the Buy call on NVDA for 2026-09-01, on the person's word that it is wrong\. Later analyses stop reading it now\. Its words, its check and its first lesson stay in the journal/);
  assert.match(await call('flag_lesson', { ...said, confirmed: true }), /^ALREADY FLAGGED: /);
  assert.match(fs.readFileSync(file, 'utf8'), /\| lesson:flagged:2026-10-12\]/);
  const listing = await call('recheck_lessons');
  assert.match(listing, /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*WHAT THE PERSON SAID IS WRONG[^\n]*\nIt says NVDA stayed flat, but it rose 10% in the window\./);
  assert.match(await call('correct_lesson', { symbol: 'NVDA', trade_date: '2026-09-01', lesson: 'Alpha of +7.0% backs the Buy. NVDA closed at 104.00 on 2026-09-07, above 103.50.', what_was_wrong: 'Contradicted: "stayed flat all week": the 2026-09-08 row closed at 110.00, from 100.00 at entry. Not known from the prices: none. Right: none.' }),
    /^Corrected: [\s\S]*The first lesson and the corrected lesson this replaces, with its check, are kept word for word/);
  const kept = fs.readFileSync(file, 'utf8');
  assert.match(kept, /\| lesson:corrected:2026-10-12\]/);
  assert.match(kept, /EARLIER CORRECTIONS:\nLesson replaced on 2026-10-12:\nNVDA stayed flat all week\./);
  assert.match(kept, /FIRST LESSON:\nNVDA never closed above 103\.50\./);
  assert.match(kept, /^\[2026-09-01 \| NVDA \| Buy \| \+10\.0% \| \+7\.0% \| 5d \| resolved:2026-09-08 \|/, 'the call, its rating and its score never change');
  await client.close();
});

test('a lesson too long for the desk is refused by the desk itself, in plain words, so a second refusal leaves it (a real journal: the input rules refused it first, uncounted)', async () => {
  const { root, call, client } = await connect();
  fs.mkdirSync(path.join(root, 'desk-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desk-data', 'journal.md'), '[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08]\n\nDECISION:\n**Rating**: Buy\n\nAdd on a close above 103.50.\n\nREFLECTION:\nNVDA never closed above 103.50.\n\n<!-- ENTRY_END -->\n\n');
  const at = { symbol: 'NVDA', trade_date: '2026-09-01', what_was_wrong: 'Contradicted: "never closed above 103.50": the 2026-09-07 row closed at 104.00. Not known from the prices: none. Right: none.' };
  assert.match(await call('correct_lesson', { ...at, lesson: 'x'.repeat(1250) }), /^INPUT_ERROR: the lesson is 1250 characters; keep it under 1200\. Correct it and call again\.$/);
  assert.match(await call('correct_lesson', { ...at, lesson: 'Alpha +7.0%.', what_was_wrong: 'w'.repeat(1000) }), /^LEFT: correct_lesson has now refused the new lesson of NVDA on 2026-09-01 2 times in this re-check \(this time: what_was_wrong is 1000 characters; keep it under 900\)/);
  assert.match(await call('recheck_lessons'), /^1 lesson\(s\) to re-check: 0 to rewrite below, 1 left after two refusals\.[\s\S]*\] LEFT: [\s\S]*LATER RE-CHECKS/);
  assert.equal(fs.readFileSync(path.join(root, 'desk-data', 'journal.md'), 'utf8').includes('NVDA never closed above 103.50.'), true, 'its lesson stays as it stands');
  await client.close();
});
