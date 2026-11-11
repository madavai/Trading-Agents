// What the dashboard remembers between visits, so the person finds it as they left it: the face, the side list, the page
// they were on, the stock on the chart with its range and lines, the stocks they looked at last, which tiers of the
// watchlist they folded away, and whether "Get started" is open. It is kept in one small file in desk-data on this computer, so it
// outlives a restart, another browser and another port. Nothing about an order is ever kept here: every ticket starts
// afresh, with Robinhood's check and the person's Confirm.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from '../desk/lock.js';
import { addWatch, MAX_WATCH, readWatchlist } from './store.js';
import { SHIPPED_MARKET, TIERS, type Tier } from './tiers.js';

export interface Recent { symbol: string; name: string }
export interface Prefs {
  theme?: 'light' | 'dark'; side?: 'open' | 'folded'; view?: 'overview' | 'account' | 'today' | 'score' | 'analyses';
  symbol?: string; range?: '1M' | '3M' | '6M' | '1Y' | '5Y'; kind?: 'area' | 'candles';
  layers?: { ma50: boolean; ma200: boolean; vol: boolean };
  recent?: Recent[];
  /** What an older version kept apart as "the whole market" row (when the person had changed its four shipped funds). It is no
   *  longer shown or set by anything: it is read only by moveMarketToWatchlist, which puts each fund on the watchlist and
   *  takes this away; what is left here is a fund that did not fit (the watchlist was full). */
  market?: string[];
  /** The older whole-market row has been put on the watchlist (moveMarketToWatchlist, once). Set only by that move. */
  marketMoved?: boolean;
  /** The tiers of the watchlist folded away. */
  folded?: Tier[];
  /** "Analyse the top three each market morning" is on (off as shipped): the top three of "Worth a look today" go on the
   *  waiting list at shallow depth once each market morning (desk/screen.ts queueTop). Set only by that switch. */
  morning?: boolean;
  /** The first market day the switch may queue: the weekday after the one it was switched on, so switching it on never
   *  puts anything on the list at once. Set only by that switch. */
  morningFrom?: string;
  /** "Get started" is open (it opened by itself on a first visit, or the person reopened it) or put away. */
  guide?: 'open' | 'away';
  /** The day the person first opened one of the desk's calls in full: the guide's fourth step. Set only by the dashboard
   *  when it serves a call, never by the page's choices. */
  readCall?: string;
}

export const MAX_RECENT = 6;
const one = <T extends string>(v: unknown, of: readonly T[]): T | undefined => (of.includes(v as T) ? (v as T) : undefined);
const sym = (v: unknown): string | undefined => { try { return typeof v === 'string' ? safeSymbol(v) : undefined; } catch { return undefined; } };
/** A name as words only: no markup, at most 80 characters. */
const words = (v: unknown, or: string): string => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '') || or;

/** Keeps only what the dashboard knows, each in its own shape; anything else is dropped, never stored. */
export function cleanPrefs(raw: unknown): Prefs {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Prefs = {};
  const theme = one(r.theme, ['light', 'dark'] as const); if (theme) out.theme = theme;
  const side = one(r.side, ['open', 'folded'] as const); if (side) out.side = side;
  const view = one(r.view, ['overview', 'account', 'today', 'score', 'analyses'] as const); if (view) out.view = view;
  const symbol = sym(r.symbol); if (symbol) out.symbol = symbol;
  const range = one(r.range, ['1M', '3M', '6M', '1Y', '5Y'] as const); if (range) out.range = range;
  const kind = one(r.kind, ['area', 'candles'] as const); if (kind) out.kind = kind;
  const l = r.layers as Record<string, unknown> | undefined;
  if (l && typeof l === 'object' && ['ma50', 'ma200', 'vol'].every((k) => typeof l[k] === 'boolean')) out.layers = { ma50: l.ma50 as boolean, ma200: l.ma200 as boolean, vol: l.vol as boolean };
  if (Array.isArray(r.recent)) {
    const seen = new Set<string>(), recent: Recent[] = [];
    for (const x of r.recent as unknown[]) {
      const s = sym((x as Recent | null)?.symbol);
      if (!s || seen.has(s)) continue;
      seen.add(s); recent.push({ symbol: s, name: words((x as Recent).name, s) });
      if (recent.length >= MAX_RECENT) break;
    }
    out.recent = recent;
  }
  // An `autorun` an older version saved ("Run automatically with Claude Code") is not read: nothing starts a run any more.
  if (Array.isArray(r.market)) out.market = [...new Set((r.market as unknown[]).map(sym).filter((s): s is string => !!s))].slice(0, MAX_WATCH);
  if (r.marketMoved === true) out.marketMoved = true;
  if (Array.isArray(r.folded)) out.folded = TIERS.filter((t) => (r.folded as unknown[]).includes(t));
  if (typeof r.morning === 'boolean') out.morning = r.morning;
  if (typeof r.morningFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.morningFrom)) out.morningFrom = r.morningFrom;
  const guide = one(r.guide, ['open', 'away'] as const); if (guide) out.guide = guide;
  if (typeof r.readCall === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.readCall)) out.readCall = r.readCall;
  return out;
}

const prefsFile = (dir: string) => path.join(dir, 'dashboard.json');

export function readPrefs(dir: string): Prefs {
  try { return cleanPrefs(JSON.parse(fs.readFileSync(prefsFile(dir), 'utf8'))); } catch { return {}; }
}

/** Merges what changed into what is kept, and returns the whole; the names in `drop` are taken out. */
export function savePrefs(dir: string, change: unknown, drop: ReadonlyArray<keyof Prefs> = []): Prefs {
  const file = prefsFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  return withLock(file, () => {
    const next = cleanPrefs({ ...readPrefs(dir), ...cleanPrefs(change) });
    for (const k of drop) delete next[k];
    writeWhole(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}

/** Puts the funds an older version showed in "the whole market" row on the person's watchlist, once, so nothing they chose is
 *  lost when the row goes: their own list, else (when they never changed it) the shipped four. Each goes in the row's order,
 *  after what is already watched, and a fund already watched stays where it is, with its star. The watchlist holds
 *  MAX_WATCH: a fund that does not fit stays in `market` to be moved when there is room, and the move is not marked done.
 *  Safe to run again and again (the desk runs it when the dashboard starts and before a routine's look): once done it reads
 *  one small file and changes nothing. Returns the funds it put on the watchlist. */
export function moveMarketToWatchlist(dir: string, onDay: string): string[] {
  const kept = readPrefs(dir);
  if (kept.marketMoved === true && kept.market === undefined) return [];
  const pending = kept.market ?? [...SHIPPED_MARKET];
  const have = new Set(readWatchlist(dir).map((w) => w.symbol)), moved: string[] = [], left: string[] = [];
  for (const symbol of pending) {
    if (have.has(symbol)) continue;
    if (have.size >= MAX_WATCH) { left.push(symbol); continue; }
    try { addWatch(dir, symbol, onDay); have.add(symbol); moved.push(symbol); } catch { /* not a ticker: nothing to keep */ }
  }
  if (left.length) savePrefs(dir, { market: left }); else savePrefs(dir, { marketMoved: true }, ['market']);
  return moved;
}
