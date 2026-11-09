// What happened in a settled call's holding window, day by day, from the desk's own price rows. The agent writing the
// call's lesson reads these rows instead of guessing what the stock did: whether a level was reached, a stop hit or a
// trigger fired is in them, or it is not known from prices. Every row is a finished session: a call is only ready to
// settle once its exit session is over.
//
// The first row is the entry: the call is scored from its close, so its open, high, low and change came before the window
// began. Its change is left out and the row is labelled "entry", and the sessions after it are numbered from 1, because a
// lesson writer once read the entry row's change (the call day's own move) as the call's first session.
//
// The rows are dividend-adjusted, as the call is scored: a dividend is part of what holding the stock returned. Once a
// dividend has gone ex since a row's day, that row's adjusted prices sit below what the market printed then, so a level
// the decision named (an entry, a stop, a target, all in prices as traded) is checked against the prices as traded, shown
// beside them whenever the two differ.
import { addDays } from '../data/dates.js';
import { compute } from '../data/indicators.js';
import { adjustedWords, vol } from '../data/market.js';
import { daily, history, type Bar } from '../data/yahoo.js';
import { signedPct } from '../numbers.js';
import type { Outcome } from './scoring.js';

const f2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : v.toFixed(2));

/** The window's sessions from entry to exit: the stock's prices, change, volume and main indicators, and the yardstick's close. */
export async function windowRows(ticker: string, o: Outcome): Promise<string> {
  const s = await history(ticker, o.exit), bars = s.bars;   // a long history, so the indicators on the window's rows are settled
  const rsi = compute('rsi', bars), macdh = compute('macdh', bars), ema10 = compute('close_10_ema', bars), sma50 = compute('close_50_sma', bars);
  const bench = (await daily(o.benchmark, addDays(o.entry, -7), o.exit)).bars;
  const benchClose = (date: string) => [...bench].reverse().find((b) => b.date <= date)?.close;
  const tradedOn = new Map((s.traded ?? []).map((b) => [b.date, b] as const));
  const inWindow = bars.filter((b) => b.date >= o.entry && b.date <= o.exit);
  // As traded beside them only when a row's adjusted prices differ from the printed ones by a cent or more.
  const differ = inWindow.some((b) => { const t = tradedOn.get(b.date); return !!t && [b.open - t.open, b.high - t.high, b.low - t.low, b.close - t.close].some((x) => Math.abs(x) >= 0.005); });
  const asTraded = (b: Bar) => { const t = tradedOn.get(b.date); return ` | ${f2(t?.high)} | ${f2(t?.low)} | ${f2(t?.close)}`; };
  const rows: string[] = [], after: Array<{ date: string; high: number; low: number; close: number; t?: Bar }> = [];
  bars.forEach((b, i) => {
    if (b.date < o.entry || b.date > o.exit) return;
    const entry = b.date === o.entry, before = bars[i - 1];
    const change = entry ? 'left out' : before ? signedPct(b.close / before.close - 1, 2) : 'N/A';
    if (!entry) after.push({ date: b.date, high: b.high, low: b.low, close: b.close, ...(tradedOn.has(b.date) ? { t: tradedOn.get(b.date)! } : {}) });
    rows.push(`${entry ? 'entry' : after.length} | ${b.date} | ${f2(b.open)} | ${f2(b.high)} | ${f2(b.low)} | ${f2(b.close)} | ${change} | ${vol(b.volume)} | ${f2(rsi[i])} | ${f2(macdh[i])} | ${f2(ema10[i])} | ${f2(sma50[i])} | ${f2(benchClose(b.date))}${differ ? asTraded(b) : ''}`);
  });
  const most = <R,>(list: R[], pick: (r: R) => number, top: boolean) => list.reduce((a, r) => ((top ? pick(r) > pick(a) : pick(r) < pick(a)) ? r : a));
  const glance = after.length
    ? [`IN SESSIONS 1 TO ${after.length} (the entry row left out): highest close ${f2(most(after, (r) => r.close, true).close)} on ${most(after, (r) => r.close, true).date}; lowest close ${f2(most(after, (r) => r.close, false).close)} on ${most(after, (r) => r.close, false).date}; highest high ${f2(most(after, (r) => r.high, true).high)} on ${most(after, (r) => r.high, true).date}; lowest low ${f2(most(after, (r) => r.low, false).low)} on ${most(after, (r) => r.low, false).date}.`]
    : [];
  const printed = after.map((r) => r.t).filter((t): t is Bar => !!t);
  if (differ && printed.length) glance.push(`AS TRADED, IN SESSIONS 1 TO ${after.length}: highest close ${f2(most(printed, (t) => t.close, true).close)} on ${most(printed, (t) => t.close, true).date}; lowest close ${f2(most(printed, (t) => t.close, false).close)} on ${most(printed, (t) => t.close, false).date}; highest high ${f2(most(printed, (t) => t.high, true).high)} on ${most(printed, (t) => t.high, true).date}; lowest low ${f2(most(printed, (t) => t.low, false).low)} on ${most(printed, (t) => t.low, false).date}.`);
  return [
    `WHAT HAPPENED IN THE WINDOW: ${ticker}'s finished sessions from ${o.entry} (entry) to ${o.exit} (exit), prices ${adjustedWords({ bars: inWindow, unadjusted: s.unadjusted ?? [] })} (the call is scored on these, so its return counts any dividend), and ${o.benchmark}'s close beside each${o.unit === 'calendar' ? ` (a coin trades every day, ${o.benchmark} only on New York's market days: beside a weekend or a New York holiday, its close is its last one before that day)` : ''}. Anything the lesson says about what happened in the window must be found in these rows.`,
    `The row marked "entry" is not a session of the window: the call is scored from its close, so its open, high, low and volume came before the window began, and its change, against the session before it, is left out. The window's sessions are numbered from 1${after[0] ? ` (${after[0].date})` : ''}; each one's change is against the session before it.`,
    differ
      ? 'A dividend has gone ex since some of these days, so their adjusted prices sit below what the market printed then. The last three columns are the high, low and close as traded: check every price level the decision named (an entry, a stop, a target) against those, never against the adjusted prices.'
      : 'These prices are also the prices as traded (no dividend has lowered them), so a price level the decision named can be checked against them.',
    `Session | Date | Open | High | Low | Close | Change | Volume | RSI | MACD histogram | 10 EMA | 50 SMA | ${o.benchmark} close${differ ? ' | High as traded | Low as traded | Close as traded' : ''}`,
    ...rows,
    ...glance,
  ].join('\n');
}
