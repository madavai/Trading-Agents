// "Get started": a newcomer's first month in five steps, each ticked off by itself from the desk's own records (the
// contact email, the watchlist, the waiting list and who listens for it, the journal, the paper record), never from what
// the page says happened. It opens by itself on the first visit, while the desk has no calls, stays until the person
// puts it away, and is reopened from the side list. It suggests the whole market and a sector or two, never a stock: the
// names are the person's own.
import { RECORD_WEEKS, RECORD_WORDS, type PaperRecord } from '../desk/paper.js';
import type { QueueItem } from '../desk/queue.js';
import { tierOf } from './tiers.js';
import type { WatchItem } from './store.js';

/** How many names of their own the person picks at least (the guide says three to five). */
export const NAMES_TO_PICK = 3;

export interface Guide {
  /** Shown at the top of the desk. */
  show: boolean;
  /** Shown by itself, as on a first visit: the page keeps it open from then on, so the first call does not take it away. */
  first: boolean;
  done: number; of: number;
  /** 1. The contact email the SEC asks for: `saved` is the address as the page may show it, masked ('' when none). */
  email: { done: boolean; saved: string };
  /** 2. Picks: the person's own single names, and whether the whole market and a sector are among them. */
  picks: { done: boolean; names: number; need: number; market: boolean; sector: boolean };
  /** 3. How many stocks were asked for (or already called), and who runs analyses by themselves ('' for nobody). */
  analyse: { done: boolean; asked: number; automatic: string };
  /** 4. Whether the person has opened a call in full, how many calls there are, and the latest. */
  read: { done: boolean; calls: number; latest: { ticker: string; date: string; rating: string } | null };
  /** 5. The paper record: whole weeks since the first call, of the RECORD_WEEKS before the money step. */
  paper: { done: boolean; weeks: number; need: number; words: string };
}

export interface GuideFacts {
  email: string;
  watchlist: readonly WatchItem[]; market: readonly string[];
  queue: ReadonlyArray<Pick<QueueItem, 'symbol'>>;
  /** The journal's calls. */
  calls: ReadonlyArray<{ ticker: string; date: string; rating: string }>;
  /** Who listens for the doorbell now (a fresh note), and whether "Run automatically with Claude Code" is switched on. */
  listener: string | null; autorun: boolean;
  /** The person opened a call in full (the dashboard notes the first time). */
  readCall: boolean;
  record: PaperRecord;
  /** The person put the guide away, or opened it from the side list (or it opened by itself and was kept open). */
  pref?: 'open' | 'away';
}

/** An address as the page may show it: its first letter and its domain, never the whole. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}…${email.slice(at)}` : '';
}

export function guideOf(f: GuideFacts): Guide {
  // A pick is a stock or fund the person watches or asked the desk about: the robot works on Start here without the watchlist.
  const picked = new Set([...f.watchlist.map((w) => w.symbol), ...f.queue.map((q) => q.symbol), ...f.calls.map((c) => c.ticker)]);
  const tiers = [...picked].filter((s) => !s.startsWith('^')).map((s) => tierOf(s, f.market));
  const names = tiers.filter((t) => t === 'names').length, market = tiers.includes('market'), sector = tiers.includes('sectors');
  const asked = new Set([...f.queue.map((q) => q.symbol), ...f.calls.map((c) => c.ticker)]).size;
  const automatic = f.listener ?? (f.autorun ? 'Claude Code' : '');
  const latest = [...f.calls].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const steps = {
    email: { done: !!f.email, saved: f.email ? maskEmail(f.email) : '' },
    picks: { done: names >= NAMES_TO_PICK && market && sector, names, need: NAMES_TO_PICK, market, sector },
    analyse: { done: asked > 0 && !!automatic, asked, automatic },
    read: { done: f.readCall, calls: f.calls.length, latest: latest ? { ticker: latest.ticker, date: latest.date, rating: latest.rating } : null },
    paper: { done: f.record.weeks >= RECORD_WEEKS, weeks: f.record.weeks, need: RECORD_WEEKS, words: RECORD_WORDS },
  };
  const first = f.pref === undefined && f.calls.length === 0;
  const done = Object.values(steps).filter((s) => s.done).length;
  return { show: f.pref === 'open' || first, first, done, of: 5, ...steps };
}
