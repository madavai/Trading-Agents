// The desk's own log of every order the dashboard sent (desk-data/orders.jsonl, which git ignores): what, when, from which
// call, and what Robinhood answered. The dashboard writes it; the evening wrap-up reads it. No account number is in it.
import fs from 'node:fs';
import path from 'node:path';
import { marketDay } from '../data/dates.js';

export interface SentOrder {
  at: string; symbol: string; side: 'buy' | 'sell'; quantity: number; limitPrice: number; timeInForce?: string;
  call?: { date: string; rating: string }; own?: true; ticket?: string;   // own: the person's own order, not from a call
  robinhood: { answered: boolean; approvalRequired: boolean | null; orderId: string | null; state: string | null; error: string | null };
}

const file = (dir: string) => path.join(dir, 'orders.jsonl');

export function logOrder(dir: string, line: SentOrder): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file(dir), JSON.stringify(line) + '\n');
}

/** Every order the dashboard sent, oldest first; a line that cannot be read is left out. */
export function readOrders(dir: string): SentOrder[] {
  try {
    return fs.readFileSync(file(dir), 'utf8').split('\n').flatMap((l) => {
      try { const v = JSON.parse(l) as SentOrder; return v && typeof v.at === 'string' && typeof v.symbol === 'string' && v.robinhood ? [v] : []; } catch { return []; }
    });
  } catch { return []; }
}

/** The orders the dashboard sent on a market day (New York's). */
export const ordersOn = (dir: string, now: Date): SentOrder[] => readOrders(dir).filter((o) => marketDay(new Date(o.at)) === marketDay(now));
/** How many orders the dashboard sent today, whatever Robinhood's own list says yet. */
export const placedToday = (dir: string, now: Date): number => ordersOn(dir, now).length;

/** Trading days (weekdays) after `from` up to and including `to`, both YYYY-MM-DD: 0 on the same day. Holidays are not
 *  known here, so a week with one counts a day more. */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = Date.parse(`${from}T12:00:00Z`) + 86_400_000; d <= Date.parse(`${to}T12:00:00Z`); d += 86_400_000) { const w = new Date(d).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

/** When the dashboard last bought a stock that Robinhood took, as New York's day, and how many trading days ago: for the
 *  shortest hold. Nothing when it never bought it here. */
export function lastBuy(dir: string, symbol: string, now: Date): { boughtOn: string; heldDays: number } | null {
  const buy = readOrders(dir).filter((o) => o.symbol === symbol && o.side === 'buy' && o.robinhood.answered).at(-1);
  if (!buy) return null;
  const boughtOn = marketDay(new Date(buy.at));
  return { boughtOn, heldDays: tradingDaysBetween(boughtOn, marketDay(now)) };
}
