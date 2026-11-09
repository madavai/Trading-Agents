// The desk's own listener for the doorbell (desk/queue.ts), the same contract Madav's routine keeps: while it listens it
// keeps a note saying so, with a heartbeat; when the doorbell rings it waits a moment (several presses make one run),
// runs the team once, one run at a time, with at most one more owed; and it stops when its note is taken away (the person
// switched it off), after the run in hand. It starts no run when nothing is waiting, so a ring costs nothing then, and none
// while another run (a routine, a chat) is analysing a stock: that run would only stop at once, so it waits for the list
// to be free and runs then. Each run gets an id, which the desk's tools note on each stock it starts.
import crypto from 'node:crypto';
import { alive, finishItem, lastSignOf, QUIET_MS, readDoorbell, readListener, readQueue, removeListener, runEnded, waitingIn, writeListener, type ListenerNote, type QueueItem } from '../desk/queue.js';

/** The longest the desk's own listener lets one stock be analysed before it stops the run, in case the team is going round
 *  in a loop that keeps saving: more than twice the longest analysis seen in the desk's first real runs (2 h 47 min). */
export const STOCK_MAX_MS = 6 * 60 * 60_000;

const startedIn = (i: QueueItem, start: string) => (i.startedAt ?? '') >= start;
/** A stock started since the run began that no run has finished: still running, or read as failed only by the quiet rule. */
const leftOpen = (i: QueueItem, start: string) => startedIn(i, start) && (i.state === 'running' || i.quiet === true);
/** A stock this run started (the desk's tools noted its id), or one whose run has ended: never another run's that is still
 *  going (a routine started beside this run). */
const ownOrEnded = (i: QueueItem, id: string) => i.runner === id || runEnded(i);

/** Why the desk's own listener stops the run in hand, in plain words for the stock it was on, or null while the run is
 *  working. It stops a run only when nothing has been saved for `QUIET_MS` (the waiting list's own rule: the run is
 *  stuck), or when one stock has been analysed for `STOCK_MAX_MS`. A long run that keeps saving its steps goes on,
 *  however many stocks it takes. `start` is when the run began (ISO). */
export function stopWhy(dir: string, start: string, now: Date = new Date()): string | null {
  const list = readQueue(dir, now);
  let last = Date.parse(start);
  for (const i of list) {
    if (startedIn(i, start)) last = Math.max(last, lastSignOf(dir, i));
    if (!i.quiet && i.endedAt && i.endedAt >= start) last = Math.max(last, Date.parse(i.endedAt));
  }
  if (now.getTime() - last > QUIET_MS) return 'nothing was saved for two hours, so the desk\'s listener stopped the run: press Retry';
  const long = list.find((i) => leftOpen(i, start) && now.getTime() - Date.parse(i.startedAt!) > STOCK_MAX_MS);
  return long ? `${long.symbol} had been analysed for six hours, the most the desk's listener allows one stock, so it stopped the run: press Retry` : null;
}

export interface WatcherOptions {
  /** The desk's data folder (desk-data). */
  dir: string;
  /** Who is listening, as the person reads it on the dashboard. */
  listener: string;
  /** Runs the team once, from `start` (ISO, for `stopWhy`), as run `id` (given to the desk's tools the run starts, which
   *  note it on each stock). Resolves with nothing, or with a few plain words on why it stopped early, which the person
   *  reads beside the stock it left unfinished. */
  run: (start: string, id: string) => Promise<string | void>;
  pid?: number;
  /** Wait this long after the last ring before a run (20 seconds); look this often (2 seconds); beat this often (a minute);
   *  after a run, wait at most this long for its tools to close (10 seconds), to tell its stocks from another run's. */
  settleMs?: number; pollMs?: number; beatMs?: number; graceMs?: number;
  now?: () => Date;
  /** True once the listener's own code changed on disk (an update): it then stops between runs, to be started afresh. */
  retire?: () => boolean;
}

/** Why it stopped: switched off (its note was taken away), asked to (Ctrl+C), or to make way for an update. */
export type Ended = 'off' | 'stopped' | 'updated';
export interface Watcher { done: Promise<Ended>; stop: () => void }

export class AlreadyListening extends Error {}

export function watch(o: WatcherOptions): Watcher {
  const pid = o.pid ?? process.pid, now = o.now ?? (() => new Date());
  const settle = o.settleMs ?? 20_000, beatEvery = o.beatMs ?? 60_000;
  const other = readListener(o.dir, now());
  if (other?.fresh && other.pid !== pid) throw new AlreadyListening(`${other.listener} is already listening on this computer`);
  const since = now().toISOString();
  const note: ListenerNote = { listener: o.listener, since, beat: since, pid };
  writeListener(o.dir, note);

  let bell = readDoorbell(o.dir)?.at ?? '';
  // Stocks already waiting when it starts are its first job, after the same short wait.
  let pending = waitingIn(readQueue(o.dir)).length > 0, ringAt = now().getTime();
  let running = false, owed = false, lastBeat = now().getTime();
  let stopping: Ended | null = null;
  let finished!: (why: Ended) => void;
  const done = new Promise<Ended>((resolve) => { finished = resolve; });

  const mine = (): boolean => readListener(o.dir, now())?.pid === pid;
  const beat = (): void => { if (!mine()) return; note.beat = now().toISOString(); writeListener(o.dir, note); lastBeat = now().getTime(); };

  const runOnce = async (): Promise<void> => {
    if (!waitingIn(readQueue(o.dir)).length) return;   // nothing to do: no run, no cost
    running = true;
    const start = now().toISOString(), id = `listener-${crypto.randomUUID().slice(0, 8)}`;
    let trouble = '';
    try { trouble = (await o.run(start, id)) ?? ''; } catch (e) { trouble = (e as Error).message; }
    // Its tools close a moment after the run: wait for them, so a stock whose run is still going is told apart.
    const unclear = () => readQueue(o.dir).some((i) => leftOpen(i, start) && i.runner !== id && i.pid !== undefined && alive(i.pid));
    for (const until = Date.now() + (o.graceMs ?? 10_000); unclear() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    // A stock this run started and left unfinished did not finish: say so now, and why, rather than leave it to the
    // waiting list's quiet rule (which may already read it as failed, in general words this run can put right). A stock
    // another run started meanwhile, and is still analysing, is left to it.
    const why = trouble || 'the run stopped before this stock was finished: press Retry';
    for (const i of readQueue(o.dir)) if (leftOpen(i, start) && ownOrEnded(i, id)) finishItem(o.dir, i.symbol, { reason: why });
    const ended = readQueue(o.dir).filter((i) => (i.endedAt ?? '') >= start && ownOrEnded(i, id));
    const done = ended.filter((i) => i.state === 'done'), a = done.filter((i) => i.already).length, f = ended.filter((i) => i.state === 'failed').length;
    note.lastRun = { started: start, at: now().toISOString(), result: `${done.length - a} analysed${a ? `, ${a} already called today` : ''}, ${f} failed${trouble ? `; ${trouble}` : ''}`, runner: id };
    running = false;
    beat();
    if (owed) { owed = false; pending = true; }
  };

  const tick = (): void => {
    if (!stopping && !mine()) stopping = 'off';   // the note was taken away: switched off
    if (!stopping && !running && o.retire?.()) stopping = 'updated';
    if (stopping) { if (!running) { clearInterval(timer); removeListener(o.dir, pid); finished(stopping); } return; }
    const b = readDoorbell(o.dir)?.at ?? '';
    if (b !== bell) { bell = b; ringAt = now().getTime(); if (running) owed = true; else pending = true; }
    if (!running && pending && now().getTime() - ringAt >= settle) {
      // Another run is analysing a stock: a run now would only stop. Wait for the list to be free, then run.
      const list = readQueue(o.dir);
      if (!list.some((i) => i.state === 'running') || !waitingIn(list).length) { pending = false; void runOnce(); }
    }
    if (now().getTime() - lastBeat >= beatEvery) beat();
  };
  const timer = setInterval(tick, o.pollMs ?? 2_000);
  return { done, stop: () => { stopping ??= 'stopped'; tick(); } };
}
