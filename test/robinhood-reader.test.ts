import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Reader, Refused } from '../src/robinhood/reader.js';
import { argsOf, kindOf, masked, shapeLines } from '../src/robinhood/rules.js';
import { discover, shapeOfRead } from '../src/robinhood/discover.js';
import { ACCOUNT, BUYING_POWER, HELD, fakeTools } from './fake-robinhood.js';

async function connected(calls: string[]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fakeTools(calls).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { reader: new Reader(client, (await client.listTools()).tools), close: () => client.close() };
}

const named = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();

test('a tool is a read only when Robinhood labels it read-only and its name is a read; a name that speaks of orders is never one', () => {
  const t = (name: string, readOnlyHint?: boolean) => ({ name, annotations: readOnlyHint === undefined ? undefined : { readOnlyHint } });
  assert.equal(kindOf(t('get_equity_positions', true)), 'read');
  assert.equal(kindOf(t('list_accounts', true)), 'read');
  assert.equal(kindOf(t('get_equity_positions')), 'other');            // no label: not trusted
  assert.equal(kindOf(t('get_equity_positions', false)), 'other');
  assert.equal(kindOf(t('set_account_nickname', true)), 'other');      // labelled, but not named like a read
  for (const name of ['place_equity_order', 'cancel_equity_order', 'review_equity_order', 'close_position', 'withdraw_funds', 'transfer_cash']) assert.equal(kindOf(t(name, true)), 'order', `${name}, even labelled read-only`);
  assert.equal(kindOf(t('list_orders', true)), 'order', 'a name that speaks of orders is not a read unless it is on the named list');
  for (const name of ['get_equity_orders', 'get_trade_approvals', 'get_trade_approval_setting', 'get_pnl_trade_history']) {
    assert.equal(kindOf(t(name, true)), 'read', `${name}: on the named list and labelled read-only`);
    assert.equal(kindOf(t(name, false)), 'order', `${name}: on the list, but not labelled read-only, so never called`);
    assert.equal(kindOf(t(name)), 'order', `${name}: no label`);
  }
  for (const name of ['place_equity_order', 'review_equity_order', 'decline_trade_approval', 'get_politician_trades']) assert.equal(kindOf(t(name, true)), 'order', `${name} is not on the list`);
});

test('the reader reaches only the read tools: every order or changing tool is refused before Robinhood is asked', async () => {
  const calls: string[] = [], { reader, close } = await connected(calls);
  const kinds = reader.byKind();
  assert.deepEqual(named(kinds.read), ['get_account_activity', 'get_accounts', 'get_equity_positions']);
  assert.deepEqual(named(kinds.order), ['cancel_equity_order', 'place_equity_order', 'review_equity_order']);
  assert.deepEqual(named(kinds.other), ['get_sneaky', 'set_account_nickname']);

  const accounts = await reader.read('get_accounts');
  assert.equal(accounts.failed, false);
  assert.equal((accounts.data as { accounts: Array<{ account_number: string }> }).accounts[0]!.account_number, ACCOUNT);
  assert.match(accounts.text, /agentic/);

  for (const name of [...named(kinds.order), ...named(kinds.other)]) await assert.rejects(reader.read(name, {}), Refused, name);
  await assert.rejects(reader.read('place_equity_order', { symbol: HELD, quantity: '1' }), /never calls it/);
  await assert.rejects(reader.read('no_such_tool'), /offers no tool called no_such_tool/);
  assert.deepEqual(calls, ['get_accounts'], 'only the one read reached Robinhood');
  await close();
});

test('a shape names the fields and the kinds of value, and never a value', () => {
  const answer = { accounts: [{ account_number: ACCOUNT, type: 'agentic', buying_power: BUYING_POWER, updated_at: '2026-10-12T15:00:00Z', nickname: null }, { account_number: 'ACC1', type: 'agentic', buying_power: '0', extra: 3 }], count: 2, live: true, id: '123e4567-e89b-12d3-a456-426614174000', ratio: 0.5 };
  const shown = shapeLines(answer).join('\n');
  for (const word of ['accounts: list of 2', 'each: object', 'account_number: text', 'buying_power: text that is a number', 'updated_at?: text that is a date', 'nickname?: null', 'extra?: whole number', 'count: whole number', 'live: boolean', 'id: text that is an id', 'ratio: number']) assert.ok(shown.includes(word), `${word}\n${shown}`);
  for (const value of [ACCOUNT, BUYING_POWER, 'ACC1', 'agentic', '2026-10-12', '123e4567']) assert.ok(!shown.includes(value), `${value} leaked`);
  const withWords = shapeLines(answer, true).join('\n');
  assert.match(withWords, /type: text \(words seen: agentic\)/);
  for (const value of [ACCOUNT, BUYING_POWER, '123e4567']) assert.ok(!withWords.includes(value), `${value} leaked with words on`);
  assert.deepEqual(shapeLines(null), ['answer: null']);
  assert.deepEqual(shapeLines([]), ['answer: list of 0']);
});

test('discover lists every tool with its arguments and the shape of the safe reads, and nothing from the account', async () => {
  const calls: string[] = [], { reader, close } = await connected(calls);
  const out = (await discover(reader)).join('\n');
  assert.match(out, /offers 8 tools: 3 that only read, 3 that order, review or move money, 2 others/);
  for (const name of ['get_accounts', 'get_equity_positions', 'place_equity_order', 'review_equity_order', 'set_account_nickname']) assert.ok(out.includes(`* ${name}`), name);
  assert.match(out, /buying_power: text that is a number/);
  assert.match(out, /get_account_activity[\s\S]*not called here: it needs account_number/);
  assert.match(out, /review_equity_order[\s\S]*labelled read-only by Robinhood: yes/);
  assert.match(out, /Nothing was ordered, changed or cancelled/);
  for (const value of [ACCOUNT, BUYING_POWER, HELD, '141.20', '198.50']) assert.ok(!out.includes(value), `${value} leaked into discover`);
  assert.deepEqual(calls, ['get_accounts', 'get_equity_positions'], 'only the safe reads that need nothing were called');
  await close();
});

test('shape asks one read tool with the arguments the person gave, refuses an order tool, and hides long numbers in a failure', async () => {
  const calls: string[] = [], { reader, close } = await connected(calls);
  assert.deepEqual(await shapeOfRead(reader, 'get_account_activity', { account_number: ACCOUNT }), ['answer: object', '  activity: list of 0']);
  await assert.rejects(shapeOfRead(reader, 'place_equity_order', { symbol: HELD, quantity: '1' }), Refused);
  assert.deepEqual(calls, ['get_account_activity']);
  assert.equal(masked(`no account 123456789 and   ${'x'.repeat(400)}`).length <= 300, true);
  assert.match(masked('account 123456789 not found'), /account ##### not found/);
  await close();
});

test('only the reader calls a Robinhood tool: no other file in src does', () => {
  const files = (fs.readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\\/g, '/'));
  assert.ok(files.includes('robinhood/reader.ts'));
  const callers = files.filter((f) => /\.callTool\(/.test(fs.readFileSync(path.join('src', f), 'utf8')));
  assert.deepEqual(callers, ['robinhood/reader.ts']);
  assert.deepEqual(argsOf({ inputSchema: { type: 'object', properties: { side: { enum: ['buy', 'sell'] }, n: { type: 'integer', description: 'How many' } }, required: ['n'] } }).map((a) => [a.name, a.type, a.required]), [['side', 'one of "buy" | "sell"', false], ['n', 'integer', true]]);
});
