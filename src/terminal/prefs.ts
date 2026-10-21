// What the dashboard remembers between visits, so the person finds it as they left it: the face, the side list, the page
// they were on, the stock on the chart with its range and lines, the stocks they looked at last, their whole-market funds,
// which tiers of the watchlist they folded away, and whether "Get started" is open. It is kept in one small file in desk-data on this computer, so it
// outlives a restart, another browser and another port. Nothing about an order is ever kept here: every ticket starts
// afresh, with Robinhood's check and the person's Confirm.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from '../desk/lock.js';
import { cleanMarket, isShipped, SHIPPED_MARKET, TIERS, type Tier } from './tiers.js';

export interface Recent { symbol: string; name: string }
export interface Prefs {
  theme?: 'light' | 'dark'; side?: 'open' | 'folded'; view?: 'overview' | 'account';
  symbol?: string; range?: '1M' | '3M' | '6M' | '1Y' | '5Y'; kind?: 'area' | 'candles';
  layers?: { ma50: boolean; ma200: boolean; vol: boolean };
  recent?: Recent[];
  /** "Run automatically with Claude Code" is on: the dashboard starts the desk's listener again when it starts. Set only
   *  by that switch, never by the page's other choices. */
  autorun?: boolean;
  /** The person's whole-market funds, when they changed the shipped four (tiers.ts SHIPPED_MARKET). Set only by "Change…"
   *  on "Start here", once each fund's price is checked, never by the page's other choices. */
  market?: string[];
  /** The tiers of the watchlist folded away. */
  folded?: Tier[];
  /** "Analyse the top three each market morning" is on (off as shipped): the top three of "Worth a look today" go on the
   *  waiting list at shallow depth once each market day (desk/screen.ts queueTop). Set only by that switch. */
  morning?: boolean;
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
  const view = one(r.view, ['overview', 'account'] as const); if (view) out.view = view;
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
  if (typeof r.autorun === 'boolean') out.autorun = r.autorun;
  const market = cleanMarket(r.market); if (market) out.market = market;
  if (Array.isArray(r.folded)) out.folded = TIERS.filter((t) => (r.folded as unknown[]).includes(t));
  if (typeof r.morning === 'boolean') out.morning = r.morning;
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

/** The person's whole-market funds: their own list, else the shipped four. */
export const marketOf = (dir: string): string[] => readPrefs(dir).market ?? [...SHIPPED_MARKET];

/** Keeps the person's whole-market funds (already checked); the shipped four are kept as no list at all, so a later
 *  version's four reach them. */
export const saveMarket = (dir: string, list: readonly string[]): string[] =>
  (isShipped(list) ? savePrefs(dir, {}, ['market']) : savePrefs(dir, { market: list })).market ?? [...SHIPPED_MARKET];
