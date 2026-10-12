// One writer at a time for a file that is read, changed and written back: without it, two writers read the same text and
// the second write drops the first's change. A lock is a folder made beside the file (creating one is atomic on every
// system); a lock older than a minute belongs to a program that died and is taken over.
import fs from 'node:fs';

const STALE_MS = 60_000;
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock<T>(file: string, run: () => T, waitMs = 15_000): T {
  const lock = `${file}.lock`, until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(`${file} is in use by another run; try again in a moment`);
      nap(40);
    }
  }
  try { return run(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

/** A file written whole: a reader sees the old file or the new one, never half of one. */
export function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { fs.writeFileSync(temp, text); fs.renameSync(temp, file); } catch (e) { try { fs.rmSync(temp, { force: true }); } catch { /* nothing to remove */ } throw e; }
}
