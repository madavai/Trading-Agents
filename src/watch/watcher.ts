// The desk's own listener for the doorbell (desk/queue.ts), the same contract Madav's routine keeps: while it listens it
// keeps a note saying so, with a heartbeat; when the doorbell rings it waits a moment (several presses make one run),
// runs the team once, one run at a time, with at most one more owed; and it stops when its note is taken away (the person
// switched it off), after the run in hand. It starts no run when nothing is waiting, so a ring costs nothing then.
import { finishItem, readDoorbell, readListener, readQueue, removeListener, waitingIn, writeListener, type ListenerNote } from '../desk/queue.js';

export interface WatcherOptions {
  /** The desk's data folder (desk-data). */
  dir: string;
  /** Who is listening, as the person reads it on the dashboard. */
  listener: string;
  /** Runs the team once. Resolves with nothing, or with a few words on what went wrong. */
  run: () => Promise<string | void>;
  pid?: number;
  /** Wait this long after the last ring before a run (20 seconds); look this often (2 seconds); beat this often (a minute). */
  settleMs?: number; pollMs?: number; beatMs?: number;
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
    const start = now().toISOString();
    let trouble = '';
    try { trouble = (await o.run()) ?? ''; } catch (e) { trouble = (e as Error).message; }
    // A stock this run started and left running did not finish: say so now rather than after two hours.
    for (const i of readQueue(o.dir)) if (i.state === 'running' && (i.startedAt ?? '') >= start) finishItem(o.dir, i.symbol, { reason: 'the run stopped before this stock was finished: press Retry' });
    const ended = readQueue(o.dir).filter((i) => (i.endedAt ?? '') >= start);
    const d = ended.filter((i) => i.state === 'done').length, f = ended.filter((i) => i.state === 'failed').length;
    note.lastRun = { at: now().toISOString(), result: `${d} analysed, ${f} failed${trouble ? `; ${trouble}` : ''}` };
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
    if (!running && pending && now().getTime() - ringAt >= settle) { pending = false; void runOnce(); }
    if (now().getTime() - lastBeat >= beatEvery) beat();
  };
  const timer = setInterval(tick, o.pollMs ?? 2_000);
  return { done, stop: () => { stopping ??= 'stopped'; tick(); } };
}
