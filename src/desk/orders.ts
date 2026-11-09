// The desk's own log of every order the dashboard sent (desk-data/orders.jsonl, which git ignores): what, when, from which
// call, and what Robinhood answered. The dashboard writes it; the evening wrap-up reads it. No account number is in it.
// An order is written just before it is sent, its answer not yet known, and Robinhood's answer is written after it under
// the same ticket: read back, the two are one entry. So an order whose answer never came (a dropped connection, the
// dashboard stopped mid-send) is still known, counts towards orders a day and the shortest hold, and is said as unknown.
import fs from 'node:fs';
import path from 'node:path';
import { marketDay } from '../data/dates.js';
import { marketDaysBetween } from '../data/holidays.js';

export interface SentOrder {
  at: string; symbol: string; side: 'buy' | 'sell'; quantity: number; limitPrice: number; timeInForce?: string;
  call?: { date: string; rating: string }; own?: true; ticket?: string;   // own: the person's own order, not from a call
  /** answered: Robinhood took it. unknown: no clear answer (none yet, none ever came, or one without an order id): it may
   *  have gone through. Neither: Robinhood refused it, in its words. */
  robinhood: { answered: boolean; unknown?: boolean; approvalRequired: boolean | null; orderId: string | null; state: string | null; error: string | null };
}

const file = (dir: string) => path.join(dir, 'orders.jsonl');

export function logOrder(dir: string, line: SentOrder): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file(dir), JSON.stringify(line) + '\n');
}

/** Every order the dashboard sent, oldest first; a line that cannot be read is left out. The lines of one ticket are one
 *  order: when it was sent (its first line) and Robinhood's latest answer (its last). */
export function readOrders(dir: string): SentOrder[] {
  let lines: SentOrder[];
  try {
    lines = fs.readFileSync(file(dir), 'utf8').split('\n').flatMap((l) => {
      try { const v = JSON.parse(l) as SentOrder; return v && typeof v.at === 'string' && typeof v.symbol === 'string' && v.robinhood ? [v] : []; } catch { return []; }
    });
  } catch { return []; }
  const out: SentOrder[] = [], at = new Map<string, number>();
  for (const v of lines) {
    const i = v.ticket ? at.get(v.ticket) : undefined;
    if (i === undefined) { if (v.ticket) at.set(v.ticket, out.length); out.push(v); }
    else out[i] = { ...v, at: out[i]!.at };
  }
  return out;
}

/** Robinhood took it, or it may have: no clear answer. */
export const mayHaveGone = (o: SentOrder): boolean => o.robinhood.answered || o.robinhood.unknown === true;

/** The orders the dashboard sent on a market day (New York's). */
export const ordersOn = (dir: string, now: Date): SentOrder[] => readOrders(dir).filter((o) => marketDay(new Date(o.at)) === marketDay(now));
/** How many orders the dashboard sent today, whatever Robinhood's own list says yet. */
export const placedToday = (dir: string, now: Date): number => ordersOn(dir, now).length;

/** The latest order of a stock sent from here in the last seven days that has no clear answer from Robinhood: it may
 *  have gone through, so a new ticket for the stock says so. */
export function unanswered(dir: string, symbol: string, now: Date): SentOrder | null {
  const since = now.getTime() - 7 * 86_400_000;
  return readOrders(dir).filter((o) => o.symbol === symbol && o.robinhood.unknown === true && Date.parse(o.at) >= since).at(-1) ?? null;
}

/** Trading days after `from` up to and including `to`, both YYYY-MM-DD: 0 on the same day. Weekends and New York's
 *  market holidays (data/holidays.ts) are not trading days. */
export const tradingDaysBetween = (from: string, to: string): number => marketDaysBetween(from, to);

/** When the dashboard last bought a stock that Robinhood took (or may have: no clear answer), as New York's day, and how
 *  many trading days ago: for the shortest hold. Nothing when it never bought it here. */
export function lastBuy(dir: string, symbol: string, now: Date): { boughtOn: string; heldDays: number } | null {
  const buy = readOrders(dir).filter((o) => o.symbol === symbol && o.side === 'buy' && mayHaveGone(o)).at(-1);
  if (!buy) return null;
  const boughtOn = marketDay(new Date(buy.at));
  return { boughtOn, heldDays: tradingDaysBetween(boughtOn, marketDay(now)) };
}
