// Settling past calls: once a call's holding window has fully traded, its measured outcome - from price rows, never from an
// agent - and the window's sessions day by day are shown to the agent, who writes the short lesson from them; the outcome
// and the lesson are then kept in the journal.
import { Journal, type Entry } from './journal.js';
import { measure, resolveBenchmark, type Outcome } from './scoring.js';
import type { Scoring } from './scoring.js';
import { failureText } from '../data/http.js';
import { signedPct as pct } from '../numbers.js';
import { windowRows } from './window.js';

const line = (o: Outcome, e: Entry) => `${e.ticker} ${pct(o.raw)} from ${o.entry} to ${o.exit} (${o.holdingDays} trading days); ${o.benchmark} ${pct(o.benchmarkReturn)}; alpha ${pct(o.alpha)}`;
export const MAX_REFLECTION = 1200;

/** The window's rows, or why they could not be had - in which case the lesson may say nothing about any day. */
async function windowText(ticker: string, o: Outcome): Promise<string> {
  try { return await windowRows(ticker, o); }
  catch (err) { return `WHAT HAPPENED IN THE WINDOW: ${failureText(err, `the day-by-day rows of ${ticker}'s window`)} Write the lesson from the outcome line alone, and say nothing about what happened on any day of the window.`; }
}

/** Every pending call (of one stock, if named), with its outcome when the window has finished. */
export async function dueSettlements(journal: Journal, scoring: Scoring, ticker?: string): Promise<string> {
  const pending = journal.pending().filter((e) => !ticker || e.ticker === ticker);
  if (!pending.length) return ticker ? `No pending calls on ${ticker}.` : 'No pending calls: every call in the journal is settled.';
  const out: string[] = [];
  let ready = 0;
  for (const e of pending) {
    const head = `[${e.date} | ${e.ticker} | ${e.rating}]`;
    try {
      const o = await measure(e.ticker, e.date, resolveBenchmark(e.ticker, scoring), scoring.holdingPeriodDays);
      if (!o) { out.push(`${head} NOT YET: the ${scoring.holdingPeriodDays}-trading-day window after ${e.date} has not finished. Leave it pending.`); continue; }
      ready++;
      out.push(`${head} READY: ${line(o, e)}\nDECISION:\n${e.decision}\n\n${await windowText(e.ticker, o)}`);
    } catch (err) {
      out.push(`${head} ${failureText(err, `prices to settle ${e.ticker} on ${e.date}`)} Leave it pending.`);
    }
  }
  return [`${pending.length} pending call(s), ${ready} ready to settle. Settle a ready one with record_outcome, using only the figures shown here. Before writing about a level, stop, target or trigger the decision named, find it in that call's window rows: say what happened only as a row shows it, naming its date.`, '', ...out].join('\n\n');
}

/** Settles one call: measures it again (so the figures cannot be an agent's), then keeps outcome and lesson. The lesson is
 *  marked by whether the window's rows - the ones list_settlements showed - can be had now: if not, it is re-checked later. */
export async function settleOne(journal: Journal, scoring: Scoring, ticker: string, date: string, reflection: string): Promise<string> {
  const text = reflection.trim();
  if (!text) throw new Error('the lesson is empty: write 2 to 4 plain sentences');
  if (text.length > MAX_REFLECTION) throw new Error(`the lesson is ${text.length} characters; keep it under ${MAX_REFLECTION}`);
  const e = journal.pending().find((x) => x.ticker === ticker && x.date === date);
  if (!e) throw new Error(`there is no pending call on ${ticker} for ${date}`);
  const o = await measure(ticker, date, resolveBenchmark(ticker, scoring), scoring.holdingPeriodDays);
  if (!o) return `NOT_YET: the ${scoring.holdingPeriodDays}-trading-day window after ${date} has not finished, so ${ticker} stays pending.`;
  const from = await windowRows(ticker, o).then(() => 'prices' as const, () => 'no-prices' as const);
  return journal.recordOutcome(ticker, date, o.raw, o.alpha, o.holdingDays, text, o.exit, from)
    ? `Settled: ${line(o, e)}. The lesson is kept and will be read by later analyses from ${o.exit} on.`
    : `${ticker} on ${date} was settled by another run already.`;
}
