// A run's own notes beside the journal, so it cannot go round in a loop. A re-check (lesson-check.json) and a scoring
// (settle-check.json) each keep their own: how many times the desk refused one call's words in this run and why, how many
// were saved, and the last listing shown. The first refusal is said as one, to correct and send again; the second of the
// same call's words is LEFT (leave that call and go on); the same call refused again after that, with nothing saved since
// its last refusal, is STOP. The notes lapse an hour after the run's last step, so a later run starts afresh and tries
// again what this one left.
import fs from 'node:fs';
import path from 'node:path';
import type { Journal } from './journal.js';
import { withLock, writeWhole } from './lock.js';

/** After this many refusals of the same call's words in one run, the call is left for a later run. */
export const REFUSALS_TO_LEAVE = 2;
/** How long a run's notes are kept after its last step. A run asked for after that starts afresh, and tries the calls it
 *  left again; one asked for within it goes on from where the last one stopped. */
export const NOTES_IDLE_MS = 60 * 60_000;
/** Notes stamped up to this much after a caller's own time still count as this run's: two runs scoring at once each read
 *  the time before they wait for the notes, so the other's last step can be a moment "later". Notes stamped further ahead
 *  (a clock put back) start afresh. */
const SKEW_MS = 60_000;
/** The longest refusal kept in the notes, to be named again in a later listing. */
const MAX_WHY = 600;

export type NotesKind = 'lesson-check' | 'settle-check';

export interface Notes {
  at: number;
  saved: number;
  /** Per call: how many refusals in this run, the last one's words, and how many saves the run had made by then. */
  refused: Record<string, { n: number; why: string; saved: number }>;
  listed?: { of: string; shown: string[]; saved: number; at: number };
  /** A scoring's calls listed without their window's rows (they could not be read then): each one's lesson is written
   *  from the outcome line alone, so it is kept as written without them even if the rows can be read when it is saved. */
  unrowed?: string[];
}

export const keyOf = (ticker: string, date: string) => `${ticker}|${date}`;
const fileOf = (j: Journal, kind: NotesKind) => path.join(path.dirname(j.file), `${kind}.json`);

/** A run's notes, read field by field; fresh ones when there are none, or the last step was an hour ago or more. */
export function readNotes(j: Journal, kind: NotesKind, now: number): Notes {
  try {
    const n = JSON.parse(fs.readFileSync(fileOf(j, kind), 'utf8')) as Record<string, unknown>;
    if (typeof n.at === 'number' && now - n.at < NOTES_IDLE_MS && now >= n.at - SKEW_MS) {
      const refused: Notes['refused'] = {};
      for (const [k, v] of Object.entries((n.refused ?? {}) as Record<string, { n?: unknown; why?: unknown; saved?: unknown }>)) {
        // a note kept before saves were counted per refusal can never be the same count: it is LEFT, not STOP
        if (typeof v?.n === 'number' && typeof v.why === 'string') refused[k] = { n: v.n, why: v.why, saved: typeof v.saved === 'number' ? v.saved : -1 };
      }
      const l = n.listed as Notes['listed'] | undefined;
      const listedOk = l && typeof l.of === 'string' && Array.isArray(l.shown) && l.shown.every((s) => typeof s === 'string') && typeof l.saved === 'number' && typeof l.at === 'number';
      const unrowed = Array.isArray(n.unrowed) ? n.unrowed.filter((k): k is string => typeof k === 'string') : [];
      return { at: n.at, saved: typeof n.saved === 'number' ? n.saved : 0, refused, ...(listedOk ? { listed: l } : {}), ...(unrowed.length ? { unrowed } : {}) };
    }
  } catch { /* none kept yet, or unreadable: start afresh */ }
  return { at: now, saved: 0, refused: {} };
}

export function writeNotes(j: Journal, kind: NotesKind, notes: Notes, now: number): void {
  try { writeWhole(fileOf(j, kind), JSON.stringify({ ...notes, at: Math.max(now, notes.at) })); } catch { /* the run works on; only its loop guard forgets */ }
}

/** Reads, changes and writes a run's notes as one step, so two runs scoring at once (a routine beside a run of the waiting
 *  list) never drop each other's counts. A lock that cannot be had (the folder is not there yet, or another run holds it
 *  too long) never stops the run: the notes are then changed as before, unlocked. `edit` never throws. */
function changing<T>(j: Journal, kind: NotesKind, edit: () => T): T {
  try { return withLock(fileOf(j, kind), edit); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || /in use by another run/.test((e as Error).message)) return edit();
    throw e;
  }
}

/** One step of the run that refused nothing: the notes' hour starts again, and a save (the call named) is counted, with
 *  that call's refusals forgotten. */
export function noteStep(j: Journal, kind: NotesKind, now: number, saved?: { ticker: string; date: string }): void {
  changing(j, kind, () => {
    const notes = readNotes(j, kind, now);
    if (saved) {
      notes.saved++; delete notes.refused[keyOf(saved.ticker, saved.date)];
      const unrowed = (notes.unrowed ?? []).filter((k) => k !== keyOf(saved.ticker, saved.date));
      if (unrowed.length) notes.unrowed = unrowed; else delete notes.unrowed;
    }
    writeNotes(j, kind, notes, now);
  });
}

/** What a listing showed of each call's window: the calls shown without their rows are noted, and one shown with them
 *  again is no longer. The file is written only when that changes, and the notes' hour is kept as it was (a listing is
 *  not a step), so a listing that showed every call's rows writes nothing. */
export function noteRows(j: Journal, kind: NotesKind, shown: { without: string[]; with: string[] }, now: number): void {
  changing(j, kind, () => {
    const notes = readNotes(j, kind, now), before = notes.unrowed ?? [];
    const after = [...new Set([...before.filter((k) => !shown.with.includes(k)), ...shown.without])];
    if (after.length === before.length && after.every((k) => before.includes(k))) return;
    const { unrowed: _, ...rest } = notes;
    try { writeWhole(fileOf(j, kind), JSON.stringify(after.length ? { ...rest, unrowed: after } : rest)); } catch { /* the lesson is then marked by the rows at save time, as before */ }
  });
}

/** Whether a scoring listed this call without its window's rows. */
export const listedUnrowed = (notes: Notes, ticker: string, date: string): boolean => (notes.unrowed ?? []).includes(keyOf(ticker, date));

/** Counts one refusal of a call's words in this run. AGAIN the first time: say the refusal, to correct and send again.
 *  LEFT from the second: leave that call and go on. STOP when it is refused again after it was left, with nothing saved
 *  since its last refusal: the run is going round in a loop. */
export function countRefusal(j: Journal, kind: NotesKind, ticker: string, date: string, why: string, now: number): { n: number; answer: 'again' | 'left' | 'stop' } {
  return changing(j, kind, () => {
    const notes = readNotes(j, kind, now), key = keyOf(ticker, date), before = notes.refused[key];
    const n = (before?.n ?? 0) + 1;
    notes.refused[key] = { n, why: why.slice(0, MAX_WHY), saved: notes.saved };
    writeNotes(j, kind, notes, now);
    if (n < REFUSALS_TO_LEAVE) return { n, answer: 'again' as const };
    return { n, answer: before && before.n >= REFUSALS_TO_LEAVE && before.saved === notes.saved ? 'stop' as const : 'left' as const };
  });
}

/** The call's refusals in this run when it was left after them, or null: what a listing names instead of showing it. */
export function leftIn(notes: Notes, ticker: string, date: string): { n: number; why: string } | null {
  const r = notes.refused[keyOf(ticker, date)];
  return r && r.n >= REFUSALS_TO_LEAVE ? r : null;
}
