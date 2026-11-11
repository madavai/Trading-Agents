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

/** How many stocks one run may analyse side by side, as the page offers them: the same as the desk's own `AT_ONCE`
 *  (desk/queue.ts), kept here so the page carries none of the desk's file code. */
export const AT_ONCE_CHOICES = [1, 2, 3] as const;
export type AtOnceChoice = (typeof AT_ONCE_CHOICES)[number];
export const isAtOnceChoice = (n: number): n is AtOnceChoice => (AT_ONCE_CHOICES as readonly number[]).includes(n);

/** The end of the line saying who runs the list: how many side by side, and how many in one run. */
export const paceWords = (atOnce: number, perRun: number): string => `${atOnce > 1 ? `Up to ${atOnce} side by side` : 'One stock at a time'}, at most ${perRun} a run.`;

/** What the choice does and what it costs, where it is made. */
export const AT_ONCE_WHY = 'How many stocks one run analyses side by side. More at once finishes a list sooner, but no single analysis is faster, and each stock asks the same free data sources and the same AI model at the same time, so a source may answer "unavailable" more often. 1 is one at a time, as shipped.';

/** Said when the person changes it. A run already going starts no more than the new number. */
export const atOnceToast = (n: number): string => (n > 1 ? `Up to ${n} side by side: a run keeps up to ${n} stocks going at once, from the next stock it starts.` : 'One at a time: a run analyses one stock, then the next, from the next stock it starts.');
