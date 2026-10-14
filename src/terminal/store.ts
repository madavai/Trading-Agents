// What the person keeps on the dashboard: the stocks they watch (some marked as favourites) and the analyses they have asked
// the desk to run. Both are small files in desk-data, written whole under a lock, because the dashboard and the desk's own
// tools may touch them at the same moment.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from '../desk/lock.js';

export interface WatchItem { symbol: string; favourite: boolean; addedOn: string }
export interface QueueItem { symbol: string; requestedAt: string }

export const MAX_WATCH = 50, MAX_QUEUE = 20;

const read = <T>(file: string, ok: (v: unknown) => v is T): T[] => {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; return Array.isArray(v) ? v.filter(ok) : []; } catch { return []; }
};
function change<T>(file: string, edit: (list: T[]) => T[], ok: (v: unknown) => v is T): T[] {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => { const next = edit(read(file, ok)); writeWhole(file, JSON.stringify(next, null, 2) + '\n'); return next; });
}

const isWatch = (v: unknown): v is WatchItem => !!v && typeof (v as WatchItem).symbol === 'string' && typeof (v as WatchItem).favourite === 'boolean';
const isQueued = (v: unknown): v is QueueItem => !!v && typeof (v as QueueItem).symbol === 'string' && typeof (v as QueueItem).requestedAt === 'string';

const watchFile = (dir: string) => path.join(dir, 'watchlist.json');
const queueFile = (dir: string) => path.join(dir, 'queue.json');

export const readWatchlist = (dir: string): WatchItem[] => read(watchFile(dir), isWatch);

export function addWatch(dir: string, raw: string, onDay: string): WatchItem[] {
  const symbol = safeSymbol(raw);
  return change<WatchItem>(watchFile(dir), (list) => {
    if (list.some((w) => w.symbol === symbol)) return list;
    if (list.length >= MAX_WATCH) throw new Error(`the watchlist holds ${MAX_WATCH} stocks: remove one first`);
    return [...list, { symbol, favourite: false, addedOn: onDay }];
  }, isWatch);
}

export function setFavourite(dir: string, raw: string, favourite: boolean): WatchItem[] {
  const symbol = safeSymbol(raw);
  return change<WatchItem>(watchFile(dir), (list) => {
    if (!list.some((w) => w.symbol === symbol)) throw new Error(`${symbol} is not on the watchlist`);
    return list.map((w) => (w.symbol === symbol ? { ...w, favourite } : w));
  }, isWatch);
}

export function removeWatch(dir: string, raw: string): WatchItem[] {
  const symbol = safeSymbol(raw);
  return change<WatchItem>(watchFile(dir), (list) => list.filter((w) => w.symbol !== symbol), isWatch);
}

export const readQueue = (dir: string): QueueItem[] => read(queueFile(dir), isQueued);

/** Asks the desk to analyse a stock. A browser cannot start a chat in Madav, so the request waits here until /analyse takes it. */
export function enqueue(dir: string, raw: string, at: string): QueueItem[] {
  const symbol = safeSymbol(raw);
  return change<QueueItem>(queueFile(dir), (list) => {
    if (list.some((q) => q.symbol === symbol)) return list;
    if (list.length >= MAX_QUEUE) throw new Error(`${MAX_QUEUE} analyses are already waiting: run them first`);
    return [...list, { symbol, requestedAt: at }];
  }, isQueued);
}

export function dequeue(dir: string, raw: string): QueueItem[] {
  const symbol = safeSymbol(raw);
  return change<QueueItem>(queueFile(dir), (list) => list.filter((q) => q.symbol !== symbol), isQueued);
}
