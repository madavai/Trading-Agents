import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paperBook, readPaperStart, recordOf, savePaperStart, type Closes } from '../src/desk/paper.js';
import { DEFAULT_CAPS, DEFAULTS } from '../src/settings.js';

const T = DEFAULTS.trading, C = DEFAULT_CAPS;   // a full position is 10%; $500 an order, 10% a stock, 3 orders a day
const rows = (...pairs: Array<[string, number]>) => pairs.map(([date, close]) => ({ date, close }));
const closes: Closes = {
  NVDA: rows(['2026-09-01', 100], ['2026-09-02', 110], ['2026-09-03', 120], ['2026-09-04', 90]),
  AAPL: rows(['2026-09-01', 200], ['2026-09-02', 201], ['2026-09-03', 202], ['2026-09-04', 203]),
  MSFT: rows(['2026-09-01', 400], ['2026-09-02', 401], ['2026-09-03', 402], ['2026-09-04', 403]),
  SPY: rows(['2026-09-01', 500], ['2026-09-02', 505], ['2026-09-03', 510], ['2026-09-04', 495]),
};
const book = (calls: Array<{ ticker: string; date: string; rating: string }>, o: Partial<{ caps: typeof C; startUsd: number; c: Closes }> = {}) =>
  paperBook(calls, o.c ?? closes, { startUsd: o.startUsd ?? 10_000, trading: T, caps: o.caps ?? C, today: '2026-09-04' });

test('every call is followed as its ticket would size it, filled at the first close after its day, against the S&P 500 from the same start', () => {
  const b = book([
    { ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }, { ticker: 'AAPL', date: '2026-09-01', rating: 'Hold' },
    { ticker: 'BTC-USD', date: '2026-09-01', rating: 'Buy' }, { ticker: 'TSLA', date: '2026-09-01', rating: 'Buy' },
    { ticker: 'NVDA', date: '2026-09-03', rating: 'Sell' }, { ticker: 'MSFT', date: '2026-09-04', rating: 'Buy' },
  ]);
  const of = (t: string, d: string) => b.trades.find((x) => x.ticker === t && x.callDate === d)!;
  assert.deepEqual([of('NVDA', '2026-09-01').status, of('NVDA', '2026-09-01').quantity, of('NVDA', '2026-09-01').price, of('NVDA', '2026-09-01').fillDate], ['filled', 4, 110, '2026-09-02'], "10% of $10,000 is $1,000; the $500 cap makes it $500: four shares at the next day's close of $110");
  assert.ok(Math.abs(of('NVDA', '2026-09-01').sincePct! - (90 / 110 - 1)) < 1e-12, 'and how it has done since, at the latest close');
  assert.deepEqual([of('NVDA', '2026-09-03').side, of('NVDA', '2026-09-03').quantity, of('NVDA', '2026-09-03').price], ['sell', 4, 90], 'a Sell sells everything held, at the next close');
  assert.deepEqual([of('AAPL', '2026-09-01').status, of('AAPL', '2026-09-01').why], ['none', 'A Hold call asks for no order.']);
  assert.equal(of('BTC-USD', '2026-09-01').status, 'skipped', 'crypto comes later, with its own cap');
  assert.equal(of('TSLA', '2026-09-01').status, 'unavailable', 'prices that could not be read are said as unavailable, never as nothing');
  assert.equal(of('MSFT', '2026-09-04').status, 'waiting', 'no close after the call yet');
  assert.deepEqual(b.series.map((p) => [p.date, p.value, p.benchmark]), [['2026-09-01', 10_000, 10_000], ['2026-09-02', 10_000, 10_100], ['2026-09-03', 10_040, 10_200], ['2026-09-04', 9_920, 9_900]]);
  assert.deepEqual([b.cash, b.value, b.positions], [9_920, 9_920, []]);
  assert.ok(Math.abs(b.returnPct! + 0.008) < 1e-12 && Math.abs(b.benchmarkPct! + 0.01) < 1e-12);
  assert.deepEqual([b.since, b.startUsd, b.benchmark], ['2026-09-01', 10_000, 'SPY']);
  assert.equal(b.trades[0]!.ticker, 'MSFT', 'newest call first, as the page lists them');
});

test('paper takes no order the real ticket would refuse: your caps, the orders a day, what is held to sell', () => {
  const twice = book([{ ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }, { ticker: 'NVDA', date: '2026-09-02', rating: 'Buy' }], { caps: { ...C, perStockPercent: 5 } });
  const second = twice.trades.find((t) => t.callDate === '2026-09-02')!;
  assert.equal(second.status, 'none');
  assert.match(second.why, /^Its order would not pass: NVDA would be \d+\.\d% of the account; your cap is 5%\.$/);
  const busy = book(['NVDA', 'AAPL', 'MSFT', 'AMD'].map((ticker) => ({ ticker, date: '2026-09-01', rating: 'Overweight' })), { c: { ...closes, AMD: rows(['2026-09-01', 50], ['2026-09-02', 51]) } });
  assert.deepEqual(busy.trades.filter((t) => t.status === 'filled').length, 3);
  assert.match(busy.trades.find((t) => t.status === 'none')!.why, /3 of your 3 orders a day used/);
  assert.match(book([{ ticker: 'NVDA', date: '2026-09-01', rating: 'Sell' }]).trades[0]!.why, /holds none to sell/);
  assert.deepEqual(book([]).series, [], 'no calls, no record');
  assert.equal(book([]).returnPct, null);
});

test('the record counts weeks and calls on stocks and funds since the first; the paper money is kept in whole dollars and checked', () => {
  const calls = [{ ticker: 'NVDA', date: '2026-09-01', rating: 'Buy' }, { ticker: 'BTC-USD', date: '2026-08-01', rating: 'Buy' }, { ticker: 'AAPL', date: '2026-09-20', rating: 'Hold' }];
  assert.deepEqual(recordOf(calls, '2026-09-30'), { since: '2026-09-01', weeks: 4, calls: 2 });
  assert.deepEqual(recordOf(calls, '2026-09-27'), { since: '2026-09-01', weeks: 3, calls: 2 });
  assert.deepEqual(recordOf([], '2026-09-30'), { since: null, weeks: 0, calls: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-paper-'));
  assert.equal(readPaperStart(dir), 10_000, 'ships at $10,000');
  assert.equal(savePaperStart(dir, 25_000), 25_000);
  assert.equal(readPaperStart(dir), 25_000);
  for (const bad of [99, 10_000_001, 2500.5, '5000', null]) assert.throws(() => savePaperStart(dir, bad), /whole number of dollars from \$100 to \$10,000,000/, String(bad));
  fs.writeFileSync(path.join(dir, 'paper.json'), '{"startUsd": -4}');
  assert.equal(readPaperStart(dir), 10_000, 'a bad value falls back to what ships');
});
