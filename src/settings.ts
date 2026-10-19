// The desk's settings (desk-settings.json at the folder's root), read once by each program. Missing or unusable parts fall
// back to the defaults the repository ships with, so an older or hand-edited file keeps working.
import fs from 'node:fs';
import path from 'node:path';

export const ANALYSTS = ['market', 'sentiment', 'news', 'fundamentals'] as const;
export type Analyst = (typeof ANALYSTS)[number];

export interface Settings {
  analysis: {
    outputLanguage: string;
    debateRounds: number;
    riskRounds: number;
    analysts: Analyst[];
    /** The model for the two managers, who weigh the debates; empty means the same as everyone else. */
    managerModel: string;
    newsLookbackDays: number;
    companyNewsLimit: number;
    worldNewsLimit: number;
    worldNewsSearches: string[];
    stocktwitsLimit: number;
    subreddits: string[];
    cryptoSubreddits: string[];
  };
  scoring: { holdingPeriodDays: number; benchmark: string; benchmarks: Record<string, string> };
  journal: { maxResolvedEntries: number | null };
  sources: { contact: string };
  trading: Trading;
  /** The morning routine analyses at most this many stocks: each is a full team run. */
  routines: { maxAnalyses: number };
}

/** What a rating asks of the Agentic account. */
export const ACTIONS = ['buy a full position', 'buy half a position', 'no order', 'sell half of what is held', 'sell everything held'] as const;
export type Action = (typeof ACTIONS)[number];
export interface Trading {
  /** Whether the person has let the dashboard place orders at all (milestone 5). Ships off. */
  enabled: boolean;
  /** A full position is this share of the Agentic account's total value. */
  fullPositionPercent: number;
  ratingToOrder: Record<string, Action>;
  orderDefaults: { type: 'limit'; timeInForce: 'gfd' | 'gtc' };
}

/** The person's caps: the most an order may cost, the most of the account one stock may be after a buy, and the most
 *  orders in a day. They are not in the project's settings file, which anything working in this folder could edit: the
 *  dashboard keeps them beside the trading switch in the person's private folder (robinhood/link.ts), and only the
 *  person changes them, on the page. */
export interface Caps { perOrderUsd: number; perStockPercent: number; ordersPerDay: number }
export const DEFAULT_CAPS: Caps = { perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 3 };
/** What a cap may be: $1 to $100,000 an order, 1% to 100% of the account, 1 to 50 orders a day. */
export const CAP_RANGES = { perOrderUsd: [1, 100_000], perStockPercent: [1, 100], ordersPerDay: [1, 50] } as const;

export const DEFAULTS: Settings = {
  analysis: {
    outputLanguage: 'English',
    debateRounds: 1,
    riskRounds: 1,
    analysts: [...ANALYSTS],
    managerModel: '',
    newsLookbackDays: 7,
    companyNewsLimit: 20,
    worldNewsLimit: 10,
    worldNewsSearches: ['Federal Reserve interest rates inflation', 'S&P 500 earnings GDP economic outlook', 'geopolitical risk trade war sanctions', 'ECB Bank of England BOJ central bank policy', 'oil commodities supply chain energy'],
    stocktwitsLimit: 30,
    subreddits: ['wallstreetbets', 'stocks', 'investing'],
    cryptoSubreddits: ['CryptoCurrency', 'CryptoMarkets'],
  },
  scoring: {
    holdingPeriodDays: 5,
    benchmark: '',
    benchmarks: { '': 'SPY', '.NS': '^NSEI', '.BO': '^BSESN', '.T': '^N225', '.TW': '^TWII', '.TWO': '^TWII', '.KS': '^KS11', '.KQ': '^KQ11', '.HK': '^HSI', '.SI': '^STI', '.L': '^FTSE', '.DE': '^GDAXI', '.PA': '^FCHI', '.AS': '^AEX', '.SW': '^SSMI', '.MI': 'FTSEMIB.MI', '.TO': '^GSPTSE', '.AX': '^AXJO', '.SS': '000001.SS', '.SZ': '399001.SZ', '.SA': '^BVSP' },
  },
  journal: { maxResolvedEntries: null },
  sources: { contact: 'trading-agents (+https://github.com/madavai/trading-agents)' },
  trading: {
    enabled: false, fullPositionPercent: 10,
    ratingToOrder: { Buy: 'buy a full position', Overweight: 'buy half a position', Hold: 'no order', Underweight: 'sell half of what is held', Sell: 'sell everything held', 'Needs review': 'no order' },
    orderDefaults: { type: 'limit', timeInForce: 'gfd' },
  },
  routines: { maxAnalyses: 5 },
};

const within = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

const int = (v: unknown, lo: number, hi: number, fallback: number): number => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : fallback);

/** The caps as kept, checked: a value out of range falls back to the shipped one, never to something larger. */
export function capsOf(raw: unknown): Caps {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = DEFAULT_CAPS, r = CAP_RANGES;
  return { perOrderUsd: within(c.perOrderUsd, r.perOrderUsd[0], r.perOrderUsd[1], d.perOrderUsd), perStockPercent: within(c.perStockPercent, r.perStockPercent[0], r.perStockPercent[1], d.perStockPercent), ordersPerDay: int(c.ordersPerDay, r.ordersPerDay[0], r.ordersPerDay[1], d.ordersPerDay) };
}

/** Caps as the person typed them on the page: all three, each within its range (whole orders a day), or null. */
export function capsFrom(raw: unknown): Caps | null {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, r = CAP_RANGES;
  const n = (v: unknown, [lo, hi]: readonly [number, number], whole = false) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (!whole || Number.isInteger(v)) ? v : null);
  const perOrderUsd = n(c.perOrderUsd, r.perOrderUsd), perStockPercent = n(c.perStockPercent, r.perStockPercent), ordersPerDay = n(c.ordersPerDay, r.ordersPerDay, true);
  return perOrderUsd === null || perStockPercent === null || ordersPerDay === null ? null : { perOrderUsd: Math.round(perOrderUsd * 100) / 100, perStockPercent: Math.round(perStockPercent * 10) / 10, ordersPerDay };
}

/** The trading part, checked: a value out of range falls back to the shipped one, never to something larger. */
export function tradingOf(raw: unknown): Trading {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = DEFAULTS.trading;
  const od = (t.orderDefaults && typeof t.orderDefaults === 'object' ? t.orderDefaults : {}) as Record<string, unknown>;
  const map = (t.ratingToOrder && typeof t.ratingToOrder === 'object' ? t.ratingToOrder : {}) as Record<string, unknown>;
  const ratingToOrder: Record<string, Action> = { ...d.ratingToOrder };
  for (const [k, v] of Object.entries(map)) if (k.length <= 20 && (ACTIONS as readonly unknown[]).includes(v)) ratingToOrder[k] = v as Action;
  ratingToOrder['Needs review'] = 'no order';   // an unreadable call never trades
  const tif = od.timeInForce === 'gtc' ? 'gtc' : 'gfd';   // "day" in the shipped file is Robinhood's gfd (good for the day)
  return {
    enabled: t.enabled === true,
    fullPositionPercent: within(t.fullPositionPercent, 1, 100, d.fullPositionPercent),
    ratingToOrder,
    orderDefaults: { type: 'limit', timeInForce: tif },
  };
}

/** A language name that is safe to put in an agent's instructions: letters, spaces, brackets and hyphens, nothing else. */
export function languageName(v: unknown, fallback = 'English'): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\p{L}[\p{L} ()\-]{0,38}$/u.test(s) ? s : fallback;
}

export function readSettings(root: string): Settings {
  let raw: Partial<Record<keyof Settings, Record<string, unknown>>> = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(root, 'desk-settings.json'), 'utf8')); } catch { /* the defaults */ }
  const a = { ...DEFAULTS.analysis, ...raw.analysis }, s = { ...DEFAULTS.scoring, ...raw.scoring }, j = { ...DEFAULTS.journal, ...raw.journal };
  const analysts = Array.isArray(a.analysts) ? ANALYSTS.filter((x) => (a.analysts as unknown[]).includes(x)) : [];
  const benchmarks = s.benchmarks && typeof s.benchmarks === 'object' ? Object.fromEntries(Object.entries(s.benchmarks).filter(([k, v]) => typeof v === 'string' && v.trim() && k.length <= 8)) : {};
  return {
    analysis: {
      ...a,
      outputLanguage: languageName(a.outputLanguage),
      debateRounds: int(a.debateRounds, 1, 5, 1),
      riskRounds: int(a.riskRounds, 1, 5, 1),
      analysts: analysts.length ? analysts : [...ANALYSTS],
      managerModel: typeof a.managerModel === 'string' && /^[\w.\-[\]]{0,60}$/.test(a.managerModel.trim()) ? a.managerModel.trim() : '',
    },
    scoring: {
      holdingPeriodDays: int(s.holdingPeriodDays, 1, 60, 5),
      benchmark: typeof s.benchmark === 'string' ? s.benchmark.trim() : '',
      benchmarks: { ...DEFAULTS.scoring.benchmarks, ...benchmarks },
    },
    journal: { maxResolvedEntries: Number.isInteger(j.maxResolvedEntries) && (j.maxResolvedEntries as number) > 0 ? (j.maxResolvedEntries as number) : null },
    sources: { ...DEFAULTS.sources, ...raw.sources } as Settings['sources'],
    trading: tradingOf(raw.trading),
    routines: { maxAnalyses: int((raw.routines as Record<string, unknown> | undefined)?.maxAnalyses, 1, 20, DEFAULTS.routines.maxAnalyses) },
  };
}
