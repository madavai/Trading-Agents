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
  caps: { perOrderUsd: number; perStockPercent: number; ordersPerDay: number };
  orderDefaults: { type: 'limit'; timeInForce: 'gfd' | 'gtc' };
}

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
    caps: { perOrderUsd: 500, perStockPercent: 10, ordersPerDay: 3 },
    orderDefaults: { type: 'limit', timeInForce: 'gfd' },
  },
};

const within = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

/** The trading part, checked: a value out of range falls back to the shipped one, never to something larger. */
export function tradingOf(raw: unknown): Trading {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = DEFAULTS.trading;
  const caps = (t.caps && typeof t.caps === 'object' ? t.caps : {}) as Record<string, unknown>;
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
    caps: { perOrderUsd: within(caps.perOrderUsd, 1, 100_000, d.caps.perOrderUsd), perStockPercent: within(caps.perStockPercent, 1, 100, d.caps.perStockPercent), ordersPerDay: int(caps.ordersPerDay, 1, 50, d.caps.ordersPerDay) },
    orderDefaults: { type: 'limit', timeInForce: tif },
  };
}

const int = (v: unknown, lo: number, hi: number, fallback: number): number => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : fallback);

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
  };
}
