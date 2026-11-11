// The analyses the person asks for on the dashboard, and the contract between the dashboard and whatever runs the agents
// (Madav's routine, a person typing in a chat). The desk starts no run of its own: it only waits to be asked. Three small files in desk-data:
// - queue.json: each stock asked for, with the depth asked and where it stands: waiting, running, done or failed.
//   The dashboard adds and removes; the desk's own tools mark a stock running and finished. One run takes stocks from the
//   list at a time; it analyses one stock at a time, or up to three side by side when the person chooses (`AT_ONCE`).
// - doorbell.json: written when the person presses Analyse (or Run now), and when a run stops with stocks still waiting.
//   A runner watches it and starts a run when it changes; the waiting list's own changes never ring it.
// - listener.json: written by whoever is listening for the doorbell (its name, since when, a heartbeat, its last run),
//   so the dashboard can say "Madav is listening" or "nothing is listening" instead of leaving a press unanswered.
// All three are data from other programs: every field is checked when read, and a bad one is dropped, never trusted.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { Journal } from './journal.js';
import { withLock, writeWhole } from './lock.js';
import { lastSaved } from './runs.js';

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
  /** Failed only because nothing was saved for it for `QUIET_MS`: the desk's own inference, so its run can still finish
   *  it (done when its call is recorded, or failed in that run's own words). */
  quiet?: true;
  /** Done without an analysis: it had been called already that day. */
  already?: true;
  /** The run that started it (or marked it done as already called): the id of that conversation's copy of the desk's
   *  tools, and that copy's process, so another run never takes the stock, and a listener fails only what its own run, or
   *  a run that has ended, left unfinished. */
  runner?: string;
  pid?: number;
}

/** Who asks: one run's copy of the desk's tools (`runner`, its id) and its process. */
export interface Runner { runner: string; pid?: number }
export const RUNNER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Whether a process is still running on this computer: a run whose tools have closed has ended. One that cannot be asked
 *  about (another account's) is taken as running, so a stock is never failed on a guess. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** Whether the run that started a stock has ended, as far as this computer can tell: its process is gone, or it was started
 *  before the desk noted processes. */
export const runEnded = (i: QueueItem): boolean => !i.pid || !alive(i.pid);

/** At most this many stocks waiting or running, and this many finished ones kept for the person to see (oldest go first). */
export const MAX_OPEN = 20, MAX_FINISHED = 20;

/** How many stocks one run may analyse side by side: the person's choice on the dashboard. 1 is one at a time, as shipped;
 *  never more than 3, since each stock's analysts all ask the same free data sources and the same model at once. */
export const AT_ONCE = [1, 2, 3] as const;
export type AtOnce = (typeof AT_ONCE)[number];
export const isAtOnce = (v: unknown): v is AtOnce => (AT_ONCE as readonly unknown[]).includes(v);

/** The words a runner is started with: the analyse playbook's waiting list. Madav's routine "analyse-when-asked" (`.claude/routines.json`) sends the same. */
export const RUN_WORDS = 'Analyse what is waiting on the dashboard.';
/** A stock being analysed saves each step as it is written. One with nothing saved for this long (since it started, or
 *  since its run last saved a step) belongs to a run that stopped without a word: it reads as failed and can be retried.
 *  However long an analysis takes, it is never marked failed while it is still saving its steps: in the desk's first real
 *  runs a shallow one took about 40 minutes and a medium one 2 h 47 min, with no step near this long. */
export const QUIET_MS = 2 * 60 * 60_000;
export const QUIET_REASON = 'nothing was saved for this analysis for two hours, so its run has most likely stopped: press Retry. If it was still going, it shows done once its call is recorded';

/** A refusal the desk's tools and the dashboard say in plain words; `code` lets a playbook tell them apart. */
export class QueueRefusal extends Error {
  constructor(readonly code: 'BUSY' | 'UNFINISHED' | 'NOT_ON_LIST' | 'NOT_WAITING' | 'FINISHED' | 'RUNNING' | 'FULL', message: string) { super(message); }
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
  if (state === 'done' && r.already === true) out.already = true;
  if (state === 'failed') out.reason = reason ?? 'no reason was given';
  if (state === 'failed' && r.quiet === true) out.quiet = true;
  if (state !== 'waiting' && typeof r.runner === 'string' && RUNNER_ID.test(r.runner)) out.runner = r.runner;
  if (state !== 'waiting' && Number.isInteger(r.pid) && (r.pid as number) > 0) out.pid = r.pid as number;
  return out;
}

/** When a running stock last showed that its analysis was going: when it started, or when its run last saved anything. */
export function lastSignOf(dir: string, item: QueueItem): number {
  const started = Date.parse(item.startedAt ?? item.requestedAt);
  const saved = item.date ? lastSaved(dir, item.symbol, item.date) : null;
  return Math.max(started, saved ?? 0);
}

/** The live journal's calls by stock and day ("NVDA|2026-11-09" to its rating), read once per look at the list and only
 *  when a stock needs them. */
type Calls = () => Map<string, string>;
/** The stocks read as done only because their call is in the journal (their run has not said so yet): their own run can
 *  still finish them, as done. */
const fromJournal = new WeakSet<QueueItem>();
const callsIn = (dir: string): Calls => {
  let kept: Map<string, string> | null = null;
  return () => (kept ??= new Map(new Journal(path.join(dir, 'journal.md')).load().map((e) => [`${e.ticker}|${e.date}`, e.rating])));
};

/** A run that died leaves its stock "running" for ever. When the listener's note says the run that started it has ended
 *  (its last run started before the stock and ended after), it reads as failed with the listener's own words, whoever
 *  the listener is, unless another run started it and is still going (its process is still running: the note's run did
 *  not start it). Otherwise it reads as failed only once nothing has been saved for it for `QUIET_MS`, the same
 *  everywhere: a long analysis that is still saving its steps stays "running", however long it takes. A stock whose call
 *  is in the journal for its day was analysed, whatever its run did after (it stopped before finish_queue_item): it
 *  reads as done, with that call's rating, never as failed. */
function settled(dir: string, item: QueueItem, now: Date, note: ListenerNote | null, calls: Calls): QueueItem {
  if (item.state !== 'running' && item.state !== 'failed') return item;
  const rating = item.date ? calls().get(`${item.symbol}|${item.date}`) : undefined;
  if (rating) {
    const done: QueueItem = { ...item, state: 'done', rating, endedAt: item.endedAt ?? new Date(Math.min(now.getTime(), lastSignOf(dir, item))).toISOString() };
    delete done.reason; delete done.quiet;
    fromJournal.add(done);
    return done;
  }
  if (item.state !== 'running') return item;
  const last = note?.lastRun, started = Date.parse(item.startedAt ?? item.requestedAt);
  const itsRun = !!last && ((!!last.runner && item.runner === last.runner) || runEnded(item));
  if (last?.started && Date.parse(last.started) <= started && started <= Date.parse(last.at) && itsRun) {
    return { ...item, state: 'failed', reason: words(`${note!.listener}'s run ended before this stock was finished: ${last.result}`, 300)!, endedAt: last.at };
  }
  const sign = lastSignOf(dir, item);
  return now.getTime() - sign > QUIET_MS ? { ...item, state: 'failed', reason: QUIET_REASON, quiet: true, endedAt: new Date(sign + QUIET_MS).toISOString() } : item;
}

function load(dir: string, now: Date): QueueItem[] {
  let raw: unknown = [];
  try { raw = JSON.parse(fs.readFileSync(queueFile(dir), 'utf8')) as unknown; } catch { /* none yet */ }
  const seen = new Set<string>(), out: QueueItem[] = [], note = readListener(dir, now), calls = callsIn(dir);
  for (const v of Array.isArray(raw) ? raw : []) {
    const item = itemOf(v);
    if (!item || seen.has(item.symbol)) continue;   // one entry per stock
    seen.add(item.symbol); out.push(settled(dir, item, now, note, calls));
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

/** Whether a stock was started by another run than `by` (one started before runs were noted is taken as another's). */
export const byAnother = (i: QueueItem, by?: Runner): boolean => !by || i.runner !== by.runner;
const signed = (by?: Runner): Pick<QueueItem, 'runner' | 'pid'> => (by ? { runner: by.runner, ...(by.pid ? { pid: by.pid } : {}) } : {});

/** Marks a waiting stock running, for an analysis of `date`, as started by `by` (the run asking). One run takes stocks from
 *  the list at a time, whoever started it: while another run has a stock running this one starts none, and a stock another
 *  run is analysing is never taken by a second one. A run holds at most `atOnce` stocks running (the person's choice:
 *  1, one at a time, as shipped, up to 3 side by side); asked for one more, it is told to finish one first. */
export function startItem(dir: string, raw: string, date: string, now: Date = new Date(), by?: Runner, atOnce: AtOnce = 1): QueueItem {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal('NOT_ON_LIST', `${symbol} is not on the waiting list`);
    const others = list.filter((i) => i.state === 'running' && i.symbol !== symbol), theirs = others.find((i) => byAnother(i, by));
    if (theirs) throw new QueueRefusal('BUSY', `${theirs.symbol} is being analysed now${by ? ' by another run' : ''}: one run takes stocks from the waiting list at a time`);
    if (item.state === 'running') {
      if (by && item.runner && item.runner !== by.runner) throw new QueueRefusal('BUSY', `${symbol} is being analysed now by another run: one run takes stocks from the waiting list at a time`);
      return { list, result: item };   // the same run asking again
    }
    if (item.state !== 'waiting') throw new QueueRefusal('NOT_WAITING', `${symbol} is not waiting (it is ${item.state}): the person presses Retry to ask again`);
    if (others.length >= atOnce) {
      const names = others.map((i) => i.symbol).join(' and '), one = others.length === 1;
      throw new QueueRefusal('UNFINISHED', atOnce === 1
        ? `${names}, which this run started, is not finished yet: call finish_queue_item for it (done once its call is recorded, or failed with why) before starting another`
        : `${names}, which this run started, ${one ? 'is' : 'are'} not finished yet, and this run analyses at most ${atOnce} side by side (the person's choice): call finish_queue_item for ${one ? 'it' : 'one of them'} (done once its call is recorded, or failed with why) before starting another`);
    }
    const started: QueueItem = { ...item, state: 'running', date, startedAt: now.toISOString(), ...signed(by) };
    delete started.endedAt; delete started.rating; delete started.reason; delete started.quiet; delete started.already;
    if (!by) { delete started.runner; delete started.pid; }
    return { list: list.map((i) => (i === item ? started : i)), result: started };
  });
}

/** Marks a stock done, with the rating the desk recorded (`already`: called earlier that day, so not analysed again), or
 *  failed, with why. A finished stock stays finished, except one marked failed only because nothing was saved for it for
 *  two hours: that was the desk's guess, so its own run can still finish it, done or failed in its own words. A stock
 *  finished without being started (already called) is noted as `by`'s. */
export function finishItem(dir: string, raw: string, outcome: { rating: string; already?: boolean } | { reason: string }, now: Date = new Date(), by?: Runner): QueueItem {
  const symbol = safeSymbol(raw);
  return change(dir, now, (list) => {
    const item = list.find((i) => i.symbol === symbol);
    if (!item) throw new QueueRefusal('NOT_ON_LIST', `${symbol} is not on the waiting list`);
    if (fromJournal.has(item) && !('rating' in outcome)) throw new QueueRefusal('FINISHED', `${symbol} is already done: its call (${item.rating}) is in the journal`);
    if (!open(item) && !item.quiet && !fromJournal.has(item)) throw new QueueRefusal('FINISHED', `${symbol} is already ${item.state}`);
    const who = item.state === 'waiting' ? signed(by) : {};
    const finished: QueueItem = 'rating' in outcome
      ? { ...item, ...who, state: 'done', rating: words(outcome.rating, 30) ?? 'recorded', endedAt: now.toISOString(), ...(outcome.already ? { already: true as const } : {}) }
      : { ...item, ...who, state: 'failed', reason: words(outcome.reason, 300) ?? 'no reason was given', endedAt: now.toISOString() };
    if (finished.state === 'done') delete finished.reason; else delete finished.rating;
    delete finished.quiet;
    if (!('rating' in outcome && outcome.already)) delete finished.already;
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
  /** A listener may write its process id, to know the note is its own. */
  pid?: number;
  /** The last run: when it started and ended (`at`; for a note that gives no end time, when it started), and what it did
   *  or why it stopped, in plain words. With `started`, a stock that run left "running" reads as failed with these words
   *  at once. `startOnly`: `at` is when it started, because the note gave no end time, so the page says "started".
   *  `runner`: the run's id (a listener may give it to its run), so only a stock that run started is failed. */
  lastRun?: { started?: string; at: string; result: string; startOnly?: true; runner?: string };
}
export const LISTENER_FRESH_MS = 3 * 60_000;

/** The listener's note, checked; `fresh` says whether its heartbeat is recent enough to believe it still listens. Two
 *  shapes are read: the desk's own (above), and Madav's for a routine it runs (`listening` for who, `checked` for the
 *  heartbeat, and a last run whose `at` is when it started, `ended` how: finished, failed or stopped, and `endedAt`, when
 *  it gives it, when). Without an end time a run's stock is left to the quiet rule (`QUIET_MS` with nothing saved). */
export function readListener(dir: string, now: Date = new Date()): (ListenerNote & { fresh: boolean }) | null {
  try {
    const v = JSON.parse(fs.readFileSync(listenerFile(dir), 'utf8')) as Record<string, unknown>;
    const listener = words(v.listener ?? v.listening, 40), since = iso(v.since), beat = iso(v.beat) ?? iso(v.checked) ?? since;
    if (!listener || !since || !beat) return null;
    const note: ListenerNote & { fresh: boolean } = { listener, since, beat, fresh: now.getTime() - Date.parse(beat) <= LISTENER_FRESH_MS };
    if (Number.isInteger(v.pid) && (v.pid as number) > 0) note.pid = v.pid as number;
    const last = v.lastRun as Record<string, unknown> | undefined;
    if (typeof last?.ended === 'string') {
      const began = iso(last.at), ended = iso(last.endedAt), how = ({ failed: 'failed', stopped: 'stopped' } as Record<string, string>)[last.ended];
      const result = words([how, words(last.result, 200)].filter(Boolean).join(': '), 200) ?? 'finished';
      if (began) note.lastRun = ended && Date.parse(began) <= Date.parse(ended) ? { started: began, at: ended, result } : { at: began, result, startOnly: true };
    } else {
      const lastAt = iso(last?.at), result = words(last?.result, 200), started = iso(last?.started), runner = typeof last?.runner === 'string' && RUNNER_ID.test(last.runner) ? last.runner : undefined;
      if (lastAt && result) note.lastRun = { ...(started && Date.parse(started) <= Date.parse(lastAt) ? { started } : {}), at: lastAt, result, ...(runner ? { runner } : {}) };
    }
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
