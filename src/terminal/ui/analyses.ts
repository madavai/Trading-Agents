// Which analyses the "Analysis status" page lists, and the count beside its name in the side list. The desk's own waiting list
// (queue.json) is never changed by this: it keeps its newest finished items, and the page simply does not list the old ones.
import type { QueueView } from '../state.js';

/** A finished analysis is not listed once it is this old (a week). */
export const STALE_MS = 7 * 86_400_000;

type Row = Pick<QueueView, 'state' | 'symbol' | 'date' | 'endedAt' | 'requestedAt'>;

/** Whether a row is left out of the page: only a finished one is ever, and only when its stock has a newer call in the journal
 *  (a call on a later day than the day it analysed, however that call was made) or it finished more than a week before `now`.
 *  A waiting, a running and a failed row always show, and so does a finished one whose time cannot be read. */
export function isStale(x: Row, calls: ReadonlyArray<{ ticker: string; date: string }>, now: number = Date.now()): boolean {
  if (x.state !== 'done') return false;
  if (x.date && calls.some((c) => c.ticker === x.symbol && c.date > x.date!)) return true;
  return now - Date.parse(x.endedAt ?? x.requestedAt) > STALE_MS;
}

/** What is waiting or being analysed, and what has failed: the count beside the name (nothing when none) and its mark. */
export function standing(queue: ReadonlyArray<Pick<QueueView, 'state'>>): { open: number; failed: number } {
  return { open: queue.filter((x) => x.state === 'waiting' || x.state === 'running').length, failed: queue.filter((x) => x.state === 'failed').length };
}
