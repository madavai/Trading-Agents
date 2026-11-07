// What happened in a settled call's holding window, day by day, from the desk's own price rows. The agent writing the
// call's lesson reads these rows instead of guessing what the stock did: whether a level was reached, a stop hit or a
// trigger fired is in them, or it is not known from prices. Every row is a finished session: a call is only ready to
// settle once its exit session is over.
import { addDays } from '../data/dates.js';
import { compute } from '../data/indicators.js';
import { daily, history } from '../data/yahoo.js';
import { signedPct } from '../numbers.js';
import type { Outcome } from './scoring.js';

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : v.toFixed(2));
const vol = (v: number) => Math.round(v).toLocaleString('en-US');

/** The window's sessions from entry to exit: the stock's prices, change, volume and main indicators, and the index's close. */
export async function windowRows(ticker: string, o: Outcome): Promise<string> {
  const bars = (await history(ticker, o.exit)).bars;   // a long history, so the indicators on the window's rows are settled
  const rsi = compute('rsi', bars), macdh = compute('macdh', bars), ema10 = compute('close_10_ema', bars), sma50 = compute('close_50_sma', bars);
  const bench = (await daily(o.benchmark, addDays(o.entry, -7), o.exit)).bars;
  const benchClose = (date: string) => [...bench].reverse().find((b) => b.date <= date)?.close;
  const rows: string[] = [];
  bars.forEach((b, i) => {
    if (b.date < o.entry || b.date > o.exit) return;
    const before = bars[i - 1], change = before ? signedPct(b.close / before.close - 1, 2) : 'N/A';
    rows.push(`${b.date} | ${f2(b.open)} | ${f2(b.high)} | ${f2(b.low)} | ${f2(b.close)} | ${change} | ${vol(b.volume)} | ${f2(rsi[i])} | ${f2(macdh[i])} | ${f2(ema10[i])} | ${f2(sma50[i])} | ${f2(benchClose(b.date))}`);
  });
  return [
    `WHAT HAPPENED IN THE WINDOW: ${ticker}'s finished sessions from ${o.entry} (entry) to ${o.exit} (exit), prices adjusted for splits and dividends, each change against the session before, and ${o.benchmark}'s close beside each. Anything the lesson says about what happened in the window must be found in these rows.`,
    `Date | Open | High | Low | Close | Change | Volume | RSI | MACD histogram | 10 EMA | 50 SMA | ${o.benchmark} close`,
    ...rows,
  ].join('\n');
}
