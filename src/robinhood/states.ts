// How Robinhood's order states are read, in one place. Pure: nothing here talks to Robinhood or to a page. Two readers use it
// and so always agree: robinhood/account.ts counts the orders still open towards the caps with `isDone`, and the dashboard
// page words each state with `stateGroup` (terminal/ui/fmt.ts `orderState`).
//
// A state is done when it is filled or never to be filled; every other state is still open (queued, unconfirmed,
// confirmed, partially_filled, and any word the desk has not met). The lists below are the one list.

/** The done states, by what they say: filled; cancelled (by the person, or voided); expired; rejected (or failed). */
const DONE_GROUPS = {
  filled: ['filled'],
  cancelled: ['cancelled', 'canceled', 'voided'],
  expired: ['expired'],
  rejected: ['rejected', 'failed'],
} as const;

/** The open states the desk has met, by what they say: not filled yet at all, or filled in part. */
const OPEN_GROUPS = {
  pending: ['queued', 'unconfirmed', 'confirmed'],
  partly: ['partially_filled'],
} as const;

const DONE = new RegExp(`^(${Object.values(DONE_GROUPS).flat().join('|')})$`, 'i');

/** A state Robinhood gives an order that is done: filled, or never to be filled. Any other state is still open. */
export const isDone = (state: string): boolean => DONE.test(state);

export type DoneGroup = keyof typeof DONE_GROUPS;
export type OpenGroup = keyof typeof OPEN_GROUPS;
/** `other`: a state still open (the desk counts every state that is not done as open) whose word the desk has not met. */
export type StateGroup = DoneGroup | OpenGroup | 'other';

/** The group a state belongs to, or null for no state at all. Open or done is always `isDone`'s answer. */
export function stateGroup(state: string | null | undefined): StateGroup | null {
  const s = (state ?? '').trim();
  if (!s) return null;
  const word = s.toLowerCase();
  for (const groups of [DONE_GROUPS, OPEN_GROUPS] as const) {
    for (const [name, words] of Object.entries(groups) as Array<[StateGroup, readonly string[]]>) if (words.includes(word)) return name;
  }
  return 'other';
}

/** Every done state, for words that name them (the page's hover). */
export const DONE_WORDS: readonly string[] = Object.values(DONE_GROUPS).flat();
