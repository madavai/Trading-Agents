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
export interface Caps {
  perOrderUsd: number; perStockPercent: number; ordersPerDay: number;
  /** The guard rails: the most of the account in one sector after a buy, the most in crypto, the fall in a week after
   *  which trading switches itself off, and the fewest trading days a stock bought here is held before the desk
   *  proposes selling it. */
  perSectorPercent: number; cryptoPercent: number; weeklyLossPercent: number; minHoldDays: number;
}
export const DEFAULT_CAPS: Caps = { perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 3, perSectorPercent: 30, cryptoPercent: 5, weeklyLossPercent: 5, minHoldDays: 5 };
/** What each may be: $1 to $100,000 an order, 1% to 100% of the account in a stock or a sector, 0% to 100% in crypto,
 *  1 to 50 orders a day, a weekly fall of 1% to 50%, a shortest hold of 0 to 60 trading days. */
export const CAP_RANGES = { perOrderUsd: [1, 100_000], perStockPercent: [1, 100], ordersPerDay: [1, 50], perSectorPercent: [1, 100], cryptoPercent: [0, 100], weeklyLossPercent: [1, 50], minHoldDays: [0, 60] } as const;
/** The limits counted in whole numbers. */
const WHOLE_CAPS = new Set<keyof Caps>(['ordersPerDay', 'minHoldDays']);

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
    // The news Yahoo files under the market's own symbols: US stocks, the 10-year Treasury yield, oil, gold, the euro. Its
    // search finds no news under topic words such as "Federal Reserve".
    worldNewsSearches: ['^GSPC', '^TNX', 'CL=F', 'GC=F', 'EURUSD=X'],
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

const CAP_KEYS = Object.keys(DEFAULT_CAPS) as Array<keyof Caps>;

/** The caps as kept, checked: a value missing or out of range falls back to the shipped one, never to something larger. */
export function capsOf(raw: unknown): Caps {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CAPS };
  for (const k of CAP_KEYS) { const [lo, hi] = CAP_RANGES[k]; out[k] = WHOLE_CAPS.has(k) ? int(c[k], lo, hi, DEFAULT_CAPS[k]) : within(c[k], lo, hi, DEFAULT_CAPS[k]); }
  return out;
}

/** Caps as the person typed them on the page: every one, each within its range (whole numbers where they count), or null.
 *  Dollars are kept to the cent and percentages to a tenth. */
export function capsFrom(raw: unknown): Caps | null {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CAPS };
  for (const k of CAP_KEYS) {
    const v = c[k], [lo, hi] = CAP_RANGES[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (WHOLE_CAPS.has(k) && !Number.isInteger(v))) return null;
    out[k] = k === 'perOrderUsd' ? Math.round(v * 100) / 100 : WHOLE_CAPS.has(k) ? v : Math.round(v * 10) / 10;
  }
  return out;
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

// The topic words shipped until October 2026 (TradingAgents' global news queries). Yahoo's search found nothing under
// them, so a settings file still holding exactly these gets today's searches.
const OLD_WORLD_SEARCHES = ['Federal Reserve interest rates inflation', 'S&P 500 earnings GDP economic outlook', 'geopolitical risk trade war sanctions', 'ECB Bank of England BOJ central bank policy', 'oil commodities supply chain energy'];

function searchesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, 10) : [];
  return !list.length || list.join('\n') === OLD_WORLD_SEARCHES.join('\n') ? [...DEFAULTS.analysis.worldNewsSearches] : list;
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
      worldNewsSearches: searchesOf(a.worldNewsSearches),
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
