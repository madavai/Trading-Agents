// Where a run's records live: the live desk, or one backtest sweep with a journal and runs of its own, so a sweep over
// past dates never floods the lessons that real analyses read back.
import path from 'node:path';
import { deskDataDir } from '../paths.js';
import { readSettings } from '../settings.js';
import { Journal } from './journal.js';

export interface Workspace { dir: string; sweep: string | null }

export const SWEEP_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function workspaceOf(root: string, sweep: string | null = null): Workspace {
  const live = deskDataDir(root);
  if (sweep === null) return { dir: live, sweep: null };
  if (!SWEEP_ID.test(sweep)) throw new Error(`"${sweep}" is not a sweep name: use up to 40 letters, digits, dashes or underscores`);
  return { dir: path.join(live, 'backtest', sweep), sweep };
}

export const journalIn = (root: string, ws: Workspace): Journal => new Journal(path.join(ws.dir, 'journal.md'), readSettings(root).journal.maxResolvedEntries);
