// The desk's technical indicators, computed here from daily rows so every number is exact and the same each time. Each
// returns one value per row, null until it has enough rows. Definitions follow the textbook (Wilder's smoothing for RSI
// and ATR; Bollinger bands on the sample standard deviation, as the original's library computes them).
// The indicator list and descriptions are adapted from TradingAgents (market analyst and
// tradingagents/dataflows/vendors/yahoo/market.py), Apache License 2.0.
import type { Bar } from './yahoo.js';

export type Values = Array<number | null>;

export function sma(xs: number[], n: number): Values {
  const out: Values = []; let sum = 0;
  xs.forEach((x, i) => { sum += x; if (i >= n) sum -= xs[i - n]!; out.push(i >= n - 1 ? sum / n : null); });
  return out;
}

/** Exponential average weighted over all rows so far (the "adjusted" form), shown once it has n rows. */
export function ema(xs: Values, n: number): Values {
  const k = 1 - 2 / (n + 1); let numer = 0, denom = 0, seen = 0;
  return xs.map((x) => {
    if (x === null) return null;
    numer = x + k * numer; denom = 1 + k * denom; seen++;
    return seen >= n ? numer / denom : null;
  });
}

/** Wilder's smoothing: the first value the plain average of n, then (previous × (n−1) + new) ÷ n. */
function wilder(xs: number[], n: number, startAt: number): Values {
  const out: Values = xs.map(() => null); let prev = 0;
  for (let i = startAt; i < xs.length; i++) {
    const k = i - startAt;
    if (k < n - 1) continue;
    prev = k === n - 1 ? xs.slice(startAt, i + 1).reduce((a, b) => a + b, 0) / n : (prev * (n - 1) + xs[i]!) / n;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], n = 14): Values {
  const gains = closes.map((c, i) => (i ? Math.max(0, c - closes[i - 1]!) : 0));
  const losses = closes.map((c, i) => (i ? Math.max(0, closes[i - 1]! - c) : 0));
  const g = wilder(gains, n, 1), l = wilder(losses, n, 1);
  return g.map((gv, i) => { const lv = l[i]; if (gv === null || lv === null || lv === undefined) return null; return lv === 0 ? (gv === 0 ? 50 : 100) : 100 - 100 / (1 + gv / lv); });
}

export function macd(closes: number[]): { macd: Values; signal: Values; hist: Values } {
  const fast = ema(closes, 12), slow = ema(closes, 26);
  const line = fast.map((f, i) => (f === null || slow[i] === null ? null : f - slow[i]!));
  const signal = ema(line, 9);
  return { macd: line, signal, hist: line.map((m, i) => (m === null || signal[i] === null ? null : m - signal[i]!)) };
}

export function bollinger(closes: number[], n = 20, k = 2): { mid: Values; upper: Values; lower: Values } {
  const mid = sma(closes, n), upper: Values = [], lower: Values = [];
  closes.forEach((_, i) => {
    const m = mid[i];
    if (m === null || m === undefined) { upper.push(null); lower.push(null); return; }
    const w = closes.slice(i - n + 1, i + 1), sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
    upper.push(m + k * sd); lower.push(m - k * sd);
  });
  return { mid, upper, lower };
}

export function atr(bars: Bar[], n = 14): Values {
  const tr = bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close)) : b.high - b.low));
  return wilder(tr, n, 0);
}

export function vwma(bars: Bar[], n = 14): Values {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    const w = bars.slice(i - n + 1, i + 1), vol = w.reduce((a, b) => a + b.volume, 0);
    return vol > 0 ? w.reduce((a, b) => a + b.close * b.volume, 0) / vol : null;
  });
}

export function mfi(bars: Bar[], n = 14): Values {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  return bars.map((_, i) => {
    if (i < n) return null;
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) { const flow = tp[j]! * bars[j]!.volume; if (tp[j]! > tp[j - 1]!) pos += flow; else if (tp[j]! < tp[j - 1]!) neg += flow; }
    return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  });
}

export const INDICATORS = {
  close_50_sma: '50 SMA: a medium-term trend indicator. Use: trend direction and dynamic support/resistance. It lags price; combine with faster indicators.',
  close_200_sma: '200 SMA: a long-term trend benchmark. Use: the overall trend and golden/death crosses. It reacts slowly; better for strategy than entries.',
  close_10_ema: '10 EMA: a responsive short-term average. Use: quick shifts in momentum and entry points. Noisy in choppy markets.',
  macd: 'MACD: momentum from the difference of two EMAs (12, 26). Use: crossovers and divergence. Confirm in sideways markets.',
  macds: 'MACD signal: the 9-day EMA of MACD. Use: crossovers with the MACD line. Part of a broader view, not a trigger alone.',
  macdh: 'MACD histogram: MACD minus its signal. Use: momentum strength and early divergence. Can be volatile.',
  rsi: 'RSI (14): momentum, 70/30 for overbought/oversold. In strong trends it can stay extreme; cross-check with the trend.',
  boll: 'Bollinger middle: the 20-day SMA under the bands. Use: a dynamic benchmark for price.',
  boll_ub: 'Bollinger upper band: 2 standard deviations above the middle. Use: overbought zones and breakouts; price can ride it in strong trends.',
  boll_lb: 'Bollinger lower band: 2 standard deviations below the middle. Use: oversold zones; confirm before calling a reversal.',
  atr: 'ATR (14): average true range, the size of daily moves. Use: stop-loss distance and position size.',
  vwma: 'VWMA (14): a moving average weighted by volume. Use: confirm trends with volume; watch for skew from volume spikes.',
  mfi: 'MFI (14): money flow, momentum from price and volume. Use: overbought (>80) or oversold (<20) and divergence.',
} as const;

export type IndicatorName = keyof typeof INDICATORS;
export const INDICATOR_NAMES = Object.keys(INDICATORS) as IndicatorName[];
export const isIndicator = (s: string): s is IndicatorName => s in INDICATORS;

/** One indicator's values, one per row. */
export function compute(name: IndicatorName, bars: Bar[]): Values {
  const closes = bars.map((b) => b.close);
  switch (name) {
    case 'close_50_sma': return sma(closes, 50);
    case 'close_200_sma': return sma(closes, 200);
    case 'close_10_ema': return ema(closes, 10);
    case 'macd': return macd(closes).macd;
    case 'macds': return macd(closes).signal;
    case 'macdh': return macd(closes).hist;
    case 'rsi': return rsi(closes);
    case 'boll': return bollinger(closes).mid;
    case 'boll_ub': return bollinger(closes).upper;
    case 'boll_lb': return bollinger(closes).lower;
    case 'atr': return atr(bars);
    case 'vwma': return vwma(bars);
    case 'mfi': return mfi(bars);
  }
}
