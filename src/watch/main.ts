// `node dist/watch.mjs`: the desk's own listener, for people who run the desk with Claude Code. Started by the dashboard's
// "Run automatically with Claude Code" switch (or by hand, in this folder), it waits for the doorbell the dashboard rings
// when the person presses Analyse, and runs the trading-desk team with Claude Code to analyse what is waiting. It writes
// what each run said to desk-data/watcher.log. Switching it off on the dashboard ends it after the run in hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deskDataDir } from '../paths.js';
import { findClaude, runClaude } from './claude.js';
import { AlreadyListening, watch } from './watcher.js';

const root = process.cwd(), dir = deskDataDir(root), logFile = path.join(dir, 'watcher.log');
// Its own code: when an update changes it, it hands over to a fresh copy between runs, never during one.
const self = fileURLToPath(import.meta.url);
const print = (): string => { try { return crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex'); } catch { return ''; } };
const born = print();
const LOG_MAX = 1_000_000, LOG_KEEP = 250_000;

/** Adds to the log, keeping only its last part once it grows past a megabyte. */
function log(text: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, text);
    if (fs.statSync(logFile).size > LOG_MAX) { const all = fs.readFileSync(logFile, 'utf8'); fs.writeFileSync(logFile, all.slice(-LOG_KEEP)); }
  } catch { /* a log that cannot be written is only a missed note */ }
}

const claude = findClaude();
if (!claude) {
  console.error('Claude Code is not installed on this computer, so nothing can run the desk from here. Install it from claude.com/claude-code, or switch on "Run automatically" in Madav.');
  process.exit(1);
}

let w;
try {
  w = watch({
    dir, listener: 'Claude Code', retire: () => print() !== born,
    run: async () => {
      log(`\n=== ${new Date().toISOString()} a run of the waiting list starts ===\n`);
      const r = await runClaude(claude, root, log);
      log(`\n=== ${new Date().toISOString()} the run ended${r.timedOut ? ' (stopped after three hours)' : ''}, code ${r.code ?? 'none'} ===\n`);
      if (r.timedOut) return 'the run took over three hours and was stopped';
      return r.code === 0 ? undefined : 'Claude Code did not finish the run: see desk-data/watcher.log';
    },
  });
} catch (e) {
  if (e instanceof AlreadyListening) { console.log(`${e.message}: this one is not needed.`); process.exit(0); }
  throw e;
}
console.log('The desk is listening: an analysis asked for on the dashboard runs here with Claude Code. Switch it off on the dashboard, or press Ctrl+C.');
process.on('SIGINT', () => w.stop()); process.on('SIGTERM', () => w.stop());
if (await w.done === 'updated') {
  log(`\n=== ${new Date().toISOString()} updated: a fresh listener takes over ===\n`);
  spawn(process.execPath, [self], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}
process.exit(0);
