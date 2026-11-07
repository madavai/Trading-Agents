import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { evaluate, shown, workOut } from '../src/data/workout.js';
import { clearCache } from '../src/data/yahoo.js';
import { deskServer } from '../src/tools/server.js';
import { chartFetch, series } from './chart.js';

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-11-06'; clearCache(); });

test('a sum is read by the desk\'s own parser: the usual order, brackets, a percent, named helpers, the signs agents write', () => {
  assert.equal(evaluate('82100 - 79735.86'), 2364.1399999999994);          // a saved call wrote "about 2,900"
  assert.equal(evaluate('214.13 - 100.00').toFixed(2), '114.13');           // another wrote 114.03
  assert.equal(evaluate('5.13 - 4.64').toFixed(2), '0.49');                 // another wrote 0.43 points
  assert.equal(evaluate('102219 / 24257').toFixed(2), '4.21');              // another wrote 4.43
  assert.equal(evaluate('change(221.97, 212.21)').toFixed(3), '-4.397');
  assert.equal(evaluate('share(22443, 196712)').toFixed(2), '11.41');
  assert.equal(evaluate('2 + 3 * 4 ^ 2 / 8'), 8);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('200 * 5%'), 10);
  assert.equal(evaluate('(1 + 2) * (3 − 1) × 2 ÷ 4'), 3);                   // the minus, times and divide signs a model may write
  assert.equal(evaluate('avg(1, 2, 3, 4) + max(1, 9) - min(4, 2) + sum(1, 1) + round(2.345, 2) + abs(-1) + sqrt(16)'), 2.5 + 9 - 2 + 2 + 2.35 + 1 + 4);
});

test('what it cannot work out is said plainly, and nothing in a sum is run as code', () => {
  const no = (e: string, why: RegExp) => assert.throws(() => evaluate(e), why, e);
  no('1,234 + 5', /a comma outside a function's brackets: write numbers without thousands commas/);
  no('change(1,234, 1,300)', /change takes 2 numbers, not 4/);
  no('5 / (3 - 3)', /divides by zero/);
  no('(1 + 2', /a bracket is not closed/);
  no('process.exit(1)', /"process" is not something it knows/);
  no('constructor(1)', /"constructor" is not something it knows/);
  no('2 +', /it ends where a number should be/);
  no('3 4', /"4" was not expected there/);
  no('10^400', /not a finite number/);
});

test('a result is shown with its sum, four decimals at most, and no minus on a zero', async () => {
  assert.deepEqual([shown(2364.1399999999994), shown(-4.396990584313197), shown(0.000123456), shown(-0.00001 + 0.00001), shown(1e9)], ['2,364.14', '-4.397', '0.0001235', '0', '1,000,000,000']);
  const t = await workOut('2026-11-06', [{ label: 'risk per unit', expression: '82100 - 79735.86' }, { expression: 'change(4.64, 5.13)' }, { label: 'bad', expression: '1,000 / 2' }]);
  assert.equal(t, [
    '## Sums, worked out by the desk', '',
    '- risk per unit: 82100 - 79735.86 = 2,364.14',
    '- change(4.64, 5.13) = 10.5603',
    '- bad: 1,000 / 2: cannot be worked out, a comma outside a function\'s brackets: write numbers without thousands commas (1234567, not 1,234,567).',
    '', 'change(a, b) is the percent change from a to b.',
    '', 'Quote a result with its sum, as written here, and round it only when you say so.',
  ].join('\n'));
  await assert.rejects(workOut('2026-11-06'), /give at least one sum or one date question/);
});

test('dates: the weekday, the days between, and the sessions a symbol traded, never past the analysis date', async () => {
  configure({ fetch: chartFetch(() => series('2026-11-06', 200)) });   // a session every weekday
  const t = await workOut('2026-11-02', [], [
    { date: '2026-10-31' }, { date: '2026-10-31', symbol: 'meta' }, { date: '2026-10-30', symbol: 'META' },
    { from: '2026-07-22', to: '2026-10-15' }, { from: '2026-10-14', to: '2026-10-22', symbol: 'NVDA' }, { from: '2026-10-30', to: '2026-11-06', symbol: 'NVDA' },
    { date: '2026-10-31', to: 'x' },
  ]);
  const lines = t.split('\n');
  assert.equal(lines[0], '## Dates, worked out by the desk');
  assert.deepEqual(lines.slice(2), [
    '- 2026-10-31 is a Saturday.',
    '- 2026-10-31 is a Saturday. META did not trade that day; its session on or before it: 2026-10-30 (Fri).',
    '- 2026-10-30 is a Friday. META traded that day.',
    '- From 2026-07-22 (Wed) to 2026-10-15 (Thu): 85 calendar days (12 weeks and 1 day); 61 weekdays after the first date up to and including the second.',
    '- From 2026-10-14 (Wed) to 2026-10-22 (Thu): 8 calendar days (1 week and 1 day); 6 weekdays after the first date up to and including the second. NVDA traded on 6 sessions after 2026-10-14 up to and including 2026-10-22 (the first 2026-10-15 (Thu), the last 2026-10-22 (Thu)); 2026-10-14 itself was a session, so both included it is 7.',
    '- From 2026-10-30 (Fri) to 2026-11-06 (Fri): 7 calendar days (1 week); 5 weekdays after the first date up to and including the second. NVDA\'s sessions after the analysis date, 2026-11-02, are not known to the desk: counted to 2026-11-02 (Mon). NVDA traded on 1 session after 2026-10-30 up to and including 2026-11-02 (the first 2026-11-02 (Mon), the last 2026-11-02 (Mon)); 2026-10-30 itself was a session, so both included it is 2.',
    '- {"date":"2026-10-31","to":"x"}: cannot be answered, give a date, or a from date and a to date.',
  ]);
});

test('the server offers the calculator to the agents', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), chartFetch(() => series('2026-11-06', 50))).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'work_out'));
  const r = await client.callTool({ name: 'work_out', arguments: { analysis_date: '2026-11-06', sums: [{ expression: 'change(100, 103)' }], dates: [{ date: '2026-11-07' }] } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /- change\(100, 103\) = 3\n[\s\S]*- 2026-11-07 is a Saturday\./);
  await client.close();
});
