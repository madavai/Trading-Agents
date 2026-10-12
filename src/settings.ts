// The desk's settings (desk-settings.json at the folder's root), read once by each program. Missing parts fall back to
// the defaults the repository ships with, so an older settings file keeps working.
import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  analysis: {
    newsLookbackDays: number;
    companyNewsLimit: number;
    worldNewsLimit: number;
    worldNewsSearches: string[];
    stocktwitsLimit: number;
    subreddits: string[];
    cryptoSubreddits: string[];
  };
  sources: { contact: string };
}

export const DEFAULTS: Settings = {
  analysis: {
    newsLookbackDays: 7,
    companyNewsLimit: 20,
    worldNewsLimit: 10,
    worldNewsSearches: ['Federal Reserve interest rates inflation', 'S&P 500 earnings GDP economic outlook', 'geopolitical risk trade war sanctions', 'ECB Bank of England BOJ central bank policy', 'oil commodities supply chain energy'],
    stocktwitsLimit: 30,
    subreddits: ['wallstreetbets', 'stocks', 'investing'],
    cryptoSubreddits: ['CryptoCurrency', 'CryptoMarkets'],
  },
  sources: { contact: 'trading-agents (+https://github.com/madavai/trading-agents)' },
};

export function readSettings(root: string): Settings {
  let raw: Partial<Settings> = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(root, 'desk-settings.json'), 'utf8')) as Partial<Settings>; } catch { /* the defaults */ }
  return { analysis: { ...DEFAULTS.analysis, ...raw.analysis }, sources: { ...DEFAULTS.sources, ...raw.sources } };
}
