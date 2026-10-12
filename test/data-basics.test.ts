import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cryptoBase, normalizeSymbol, safeSymbol } from '../src/data/symbols.js';
import { analysisDate, asOf, parseDate, window } from '../src/data/dates.js';
import { atr, bollinger, ema, macd, mfi, rsi, sma, vwma } from '../src/data/indicators.js';

test('broker and chart-site symbols map to the ones the data uses', () => {
  const cases: Record<string, string> = { XAUUSD: 'GC=F', 'xauusd+': 'GC=F', EURUSD: 'EURUSD=X', BTCUSD: 'BTC-USD', 'BTC-USDT': 'BTC-USD', SPX500: '^GSPC', '09992.HK': '9992.HK', '700.HK': '0700.HK', '600519.SH': '600519.SS', nvda: 'NVDA', '7203.T': '7203.T', 'GC=F': 'GC=F' };
  for (const [typed, want] of Object.entries(cases)) assert.equal(normalizeSymbol(typed), want, typed);
  assert.equal(cryptoBase('ETHUSDC'), 'ETH');
  assert.equal(cryptoBase('NVDA'), null);
  assert.throws(() => safeSymbol('../../etc/passwd'), /not a ticker symbol/);
});

test('dates are held to the analysis date, and a future analysis is refused', () => {
  process.env.TRADING_AGENTS_TODAY = '2026-10-12';
  assert.equal(analysisDate('2026-10-09'), '2026-10-09');
  assert.throws(() => analysisDate('2026-10-13'), /in the future/);
  assert.throws(() => parseDate('2026-02-30'), /not a date/);
  assert.equal(asOf('2026-12-01', '2026-10-09'), '2026-10-09');
  assert.deepEqual(window('2026-09-01', '2026-12-01', '2026-10-09'), ['2026-09-01', '2026-10-09']);
  assert.deepEqual(window('2026-11-01', '2026-11-08', '2026-10-09'), ['2026-10-02', '2026-10-09']);
  delete process.env.TRADING_AGENTS_TODAY;
});

const near = (a: number | null | undefined, b: number, tol = 0.01, msg = '') => assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test('RSI matches the textbook worked example (StockCharts, Wilder smoothing)', () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  const r = rsi(closes);
  assert.equal(r[13], null);
  [70.53, 66.32, 66.55, 69.41, 66.36, 57.97].forEach((want, k) => near(r[14 + k], want, 0.02, `RSI day ${15 + k}`));
});

test('averages and bands', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4], 3);   // weights 1, 0.5, 0.25 ... over all rows so far
  assert.equal(e[1], null);
  near(e[2], (3 + 0.5 * 2 + 0.25 * 1) / (1 + 0.5 + 0.25), 1e-9);
  const flat = bollinger(Array(25).fill(10));
  assert.equal(flat.mid[24], 10); assert.equal(flat.upper[24], 10); assert.equal(flat.lower[24], 10);
  const b = bollinger([1, 2, 3, 4, 5], 5, 2);   // sample sd of 1..5 is sqrt(2.5)
  near(b.upper[4], 3 + 2 * Math.sqrt(2.5), 1e-9);
  const m = macd(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.ok((m.macd[59] ?? 0) > 0);
  near(m.hist[59], (m.macd[59] ?? 0) - (m.signal[59] ?? 0), 1e-9);
});

test('ATR, VWMA and MFI from rows', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, open: 10, high: 11, low: 9, close: 10, volume: 100 }));
  near(atr(bars)[13], 2, 1e-9);   // every true range is 2
  near(vwma(bars)[13], 10, 1e-9);
  const up = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, open: i, high: i + 1, low: i - 1, close: i, volume: 100 }));
  assert.equal(mfi(up)[19], 100);   // money flowing in every day
  assert.equal(mfi(up)[13], null);
});
