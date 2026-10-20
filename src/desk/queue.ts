// The analyses the person asks for on the dashboard, and the contract between the dashboard and whatever runs the agents
// (Madav's routine, the desk's own watcher for Claude Code, a person typing in a chat). Three small files in desk-data:
// - queue.json: each stock asked for, with the depth asked and where it stands: waiting, running, done or failed.
//   The dashboard adds and removes; the desk's own tools mark a stock running and finished. One stock runs at a time.
// - doorbell.json: written when the person presses Analyse (or Run now), and when a run stops with stocks still waiting.
//   A runner watches it and starts a run when it changes; the waiting list's own changes never ring it.
// - listener.json: written by whoever is listening for the doorbell (its name, since when, a heartbeat, its last run),
//   so the dashboard can say "Madav is listening" or "nothing is listening" instead of leaving a press unanswered.
// All three are data from other programs: every field is checked when read, and a bad one is dropped, never trusted.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from './lock.js';

export const DEPTHS = { shallow: 1, medium: 3, deep: 5 } as const;
export type Depth = keyof typeof DEPTHS;
export const isDepth = (v: unknown): v is Depth => typeof v === 'string' && Object.hasOwn(DEPTHS, v);
/** The depth a number of debate rounds stands for, for the depth the page offers first. */
export const depthOfRounds = (rounds: number): Depth => (rounds >= 5 ? 'deep' : rounds >= 3 ? 'medium' : 'shallow');

export type QueueState = 'waiting' | 'running' | 'done' | 'failed';
export interface QueueItem {
  symbol: string;
  requestedAt: string;
  /** Absent only on a request made before depths existed: the settings decide. */
  depth?: Depth;
  state: QueueState;
  /** The day the run analyses (set when it starts), where its call and its progress are found. */
  date?: string;
  startedAt?: string;
  endedAt?: string;
  /** Done: the rating the desk recorded. Failed: why, in plain words. */
  rating?: string;
  reason?: string;
}

/** At most this many stocks waiting or running, and this many finished ones kept for the person to see (oldest go first). */
export const MAX_OPEN = 20, MAX_FINISHED = 20;
/** A stock marked running for longer than this belongs to a run that died: it counts as failed and can be retried. */
export const STALE_MS = 2 * 60 * 60_000;
export const STALE_REASON = 'the run did not finish (it stopped, or took over two hours): press Retry';

/** A refusal the desk's tools and the dashboard say in plain words; `code` lets a playbook tell them apart. */
export class QueueRefusal extends Error {
  constructor(readonly code: 'BUSY' | 'NOT_ON_LIST' | 'NOT_WAITING' | 'FINISHED' | 'RUNNING' | 'FULL', message: string) { super(message); }
}

const queueFile = (dir: string) => path.join(dir, 'queue.json');
export const doorbellFile = (dir: string) => path.join(dir, 'doorbell.json');
export const listenerFile = (dir: string) => path.join(dir, 'listener.json');

const iso = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined);
const day = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
/** Words another program wrote, kept as words: no markup, one line, at most `max` characters. */
const words = (v: unknown, max: number): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return s || undefined;
};
const STATES: readonly QueueState[] = ['waiting', 'running', 'done', 'failed'];

/** One item as read from the file: checked field by field. A request from before states existed is waiting. */
function itemOf(v: unknown): QueueItem | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  let symbol: string;
  try { symbol = safeSymbol(String(r.symbol ?? '')); } catch { return null; }
  const requestedAt = iso(r.requestedAt);
  if (!requestedAt) return null;
  const state = STATES.includes(r.state as QueueState) ? (r.state as QueueState) : 'waiting';
  const out: QueueItem = { symbol, requestedAt, state };
  if (isDepth(r.depth)) out.depth = r.depth;
  const date = day(r.date), startedAt = iso(r.startedAt), endedAt = iso(r.endedAt), rating = words(r.rating, 30), reason = words(r.reason, 300);
  if (date) out.date = date;
  if (startedAt) out.startedAt = startedAt;
  if (endedAt) out.endedAt = endedAt;
  if (state === 'done' && rating) out.rating = rating;
  if (state === 'failed') out.reason = reason ?? 'no reason was given';
  return out;
}

/** A run that died leaves its stock "running" for ever; past two hours it reads as failed, the same everywhere. */
function settled(item: QueueItem, now: Date): QueueItem {
  if (item.state !== 'running') return item;
  const started = Date.parse(item.startedAt ?? item.requestedAt);
  return now.getTime() - started > STALE_MS ? { ...item, state: 'failed', reason: STALE_REASON, endedAt: now.toISOString() } : item;
}

function load(dir: string, now: Date): QueueItem[] {
  let raw: unknown = [];
  try { raw = JSON.parse(fs.readFileSync(queueFile(dir), 'utf8')) as unknown; } catch { /* none yet */ }
  const seen = new Set<string>(), out: QueueItem[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const item = itemOf(v);
    if (!item || seen.has(item.symbol)) continue;   // one entry per stock
    seen.add(item.symbol); out.push(settled(item, now));
  }
  return out;
}

const open = (i: QueueItem) => i.state === 'waiting' || i.state === 'running';

/** Keeps the newest finished items only, so the list never grows without end. */
function trimmed(list: QueueItem[]): QueueItem[] {
  const finished = list.filter((i) => !open(i)).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  const keep = new Set(finished.slice(0, MAX_FINISHED));
  return list.filter((i) => open(i) || keep.has(i));
}

function change<T>(dir: string, now: Date, edit: (list: QueueItem[]) => { list: QueueItem[]; result: T }): T {
  const file = queueFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  return withLock(file, () => {
    const { list, result } = edit(load(dir, now));
    writeWhole(file, JSON.stringify(trimmed(list), null, 2) + '\n');
    return result;
  });
}

/** Every stock asked for, as it stands now (a run that died reads as failed). */
export const readQueue = (dir: string, now: Date = new Date()): QueueItem[] => load(dir, now);
export const waitingIn = (list: QueueItem[]): QueueItem[] => list.filter((i) => i.state === 'waiting');

/** Asks the desk to analyse a stock at a depth. Asked again while it waits, the new depth stands; asked again after it
 *  finished, it waits afresh at the end of the list. A stock being analysed now is left as it is. */
export function enqueue(dir: string, raw: string, at: string, depth?: Depth, now: Date = new Date()): QueueItem[] {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    const was = list.find((i) => i.symbol === symbol);
    if (was?.state === 'running') return { list, result: list };
    if (was?.state === 'waiting') { const next = list.map((i) => (i === was ? { ...i, ...(depth ? { depth } : {}) } : i)); return { list: next, result: next }; }
    const rest = list.filter((i) => i !== was);
    if (rest.filter(open).length >= MAX_OPEN) throw new QueueRefusal('FULL', `${MAX_OPEN} analyses are already waiting: let them run first`);
    const next = [...rest, { symbol, requestedAt: at, state: 'waiting' as const, ...(depth ? { depth } : {}) }];
    return { list: next, result: next };
  });
}

/** Takes a stock off the list: one waiting, or a finished one the person has seen. A stock being analysed stays. */
export function dequeue(dir: string, raw: string, now: Date = new Date()): QueueItem[] {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    if (list.some((i) => i.symbol === symbol && i.state === 'running')) throw new QueueRefusal('RUNNING', `${symbol} is being analysed now: it can be taken off once its run ends`);
    const next = list.filter((i) => i.symbol !== symbol);
    return { list: next, result: next };
  });
}

/** Marks a waiting stock running, for an analysis of `date`. Only one stock runs at a time, whoever started the run. */
export function startItem(dir: string, raw: string, date: string, now: Date = new Date()): QueueItem {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal('NOT_ON_LIST', `${symbol} is not on the waiting list`);
    const busy = list.find((i) => i.state === 'running' && i.symbol !== symbol);
    if (busy) throw new QueueRefusal('BUSY', `${busy.symbol} is being analysed now: one stock runs at a time`);
    if (item.state === 'running') return { list, result: item };   // the same run asking again
    if (item.state !== 'waiting') throw new QueueRefusal('NOT_WAITING', `${symbol} is not waiting (it is ${item.state}): the person presses Retry to ask again`);
    const started: QueueItem = { ...item, state: 'running', date, startedAt: now.toISOString() };
    delete started.endedAt; delete started.rating; delete started.reason;
    return { list: list.map((i) => (i === item ? started : i)), result: started };
  });
}

/** Marks a stock done, with the rating the desk recorded, or failed, with why. A finished stock stays finished. */
export function finishItem(dir: string, raw: string, outcome: { rating: string } | { reason: string }, now: Date = new Date()): QueueItem {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal('NOT_ON_LIST', `${symbol} is not on the waiting list`);
    if (!open(item)) throw new QueueRefusal('FINISHED', `${symbol} is already ${item.state}`);
    const finished: QueueItem = 'rating' in outcome
      ? { ...item, state: 'done', rating: words(outcome.rating, 30) ?? 'recorded', endedAt: now.toISOString() }
      : { ...item, state: 'failed', reason: words(outcome.reason, 300) ?? 'no reason was given', endedAt: now.toISOString() };
    if (finished.state === 'done') delete finished.reason; else delete finished.rating;
    return { list: list.map((i) => (i === item ? finished : i)), result: finished };
  });
}

// ---------- the doorbell ----------
export interface Doorbell { at: string; waiting: number; why: 'press' | 'more' }

/** Rings for a runner: the person pressed Analyse, Retry or Run now ("press"), or a run stopped at its limit with stocks
 *  still waiting ("more"). */
export function ringDoorbell(dir: string, why: Doorbell['why'], now: Date = new Date()): Doorbell {
  const bell: Doorbell = { at: now.toISOString(), waiting: waitingIn(readQueue(dir, now)).length, why };
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(doorbellFile(dir), JSON.stringify(bell, null, 2) + '\n');
  return bell;
}

export function readDoorbell(dir: string): Doorbell | null {
  try {
    const v = JSON.parse(fs.readFileSync(doorbellFile(dir), 'utf8')) as Record<string, unknown>;
    const at = iso(v.at);
    return at ? { at, waiting: Number.isInteger(v.waiting) ? (v.waiting as number) : 0, why: v.why === 'more' ? 'more' : 'press' } : null;
  } catch { return null; }
}

// ---------- the listener's note ----------
export interface ListenerNote {
  /** Who is listening, as the person should read it: "Madav", "Claude Code". */
  listener: string;
  since: string;
  /** Written at least once a minute while it listens; a note older than three minutes is from a listener that died. */
  beat: string;
  /** The desk's own watcher writes its process id, to know the note is its own. */
  pid?: number;
  lastRun?: { at: string; result: string };
}
export const LISTENER_FRESH_MS = 3 * 60_000;

/** The listener's note, checked; `fresh` says whether its heartbeat is recent enough to believe it still listens. */
export function readListener(dir: string, now: Date = new Date()): (ListenerNote & { fresh: boolean }) | null {
  try {
    const v = JSON.parse(fs.readFileSync(listenerFile(dir), 'utf8')) as Record<string, unknown>;
    const listener = words(v.listener, 40), since = iso(v.since), beat = iso(v.beat) ?? since;
    if (!listener || !since || !beat) return null;
    const note: ListenerNote & { fresh: boolean } = { listener, since, beat, fresh: now.getTime() - Date.parse(beat) <= LISTENER_FRESH_MS };
    if (Number.isInteger(v.pid) && (v.pid as number) > 0) note.pid = v.pid as number;
    const last = v.lastRun as Record<string, unknown> | undefined, lastAt = iso(last?.at), result = words(last?.result, 200);
    if (lastAt && result) note.lastRun = { at: lastAt, result };
    return note;
  } catch { return null; }
}

export function writeListener(dir: string, note: ListenerNote): void {
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(listenerFile(dir), JSON.stringify(note, null, 2) + '\n');
}

/** Takes the note away: anyone's (the person switched listening off), or only the one with this process id. */
export function removeListener(dir: string, pid?: number): void {
  if (pid !== undefined && readListener(dir)?.pid !== pid) return;
  fs.rmSync(listenerFile(dir), { force: true });
}
