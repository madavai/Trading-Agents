// The world in tiers, as the dashboard shows it: the whole market (a few broad funds), the eleven S&P sector funds, single
// names, and crypto, broadest first, so the page itself points a beginner to broad, cheaper risk before single companies.
// Each tier, each broad fund and each sector fund has a name and a one-line meaning in plain words. The "Sectors" section
// shows the eleven sector funds; the watchlist, which holds everything else the person follows, is grouped by tier.
import { isCrypto } from '../data/symbols.js';
import { followed } from '../desk/paper.js';
import { spelledUnbuyable } from './buyable.js';
import { MARKET_FUNDS, SECTOR_FUNDS } from '../desk/sectors.js';
import type { WatchItem } from './store.js';

export type Tier = 'market' | 'sectors' | 'names' | 'crypto';
/** The tiers, broadest first: the order the page shows them in. */
export const TIERS: readonly Tier[] = ['market', 'sectors', 'names', 'crypto'];

export const TIER_WORDS: Readonly<Record<Tier, { name: string; meaning: string }>> = {
  market: { name: 'The whole market', meaning: 'Funds that each follow a broad index, from 30 companies (the Dow Jones) or 100 (the Nasdaq 100) to thousands, or bonds: broader than one sector or one company.' },
  sectors: { name: 'Sectors', meaning: 'The eleven parts of the economy, such as technology or energy, one fund each: side by side, they show which parts are rising.' },
  names: { name: 'Single names', meaning: 'One company each, or a narrower fund: each can swing far more than the whole market.' },
  crypto: { name: 'Crypto', meaning: 'Coins such as Bitcoin, which swing far more than shares, at any hour: the desk follows Bitcoin and Ether, and you can order them in your Agentic account; no other coin.' },
};

/** The four broad funds an older version put in everyone's "whole market" row: the S&P 500, the Nasdaq 100, the whole world and
 *  US bonds. That row is gone; a person who never changed it gets these four on their watchlist, once (prefs.ts
 *  moveMarketToWatchlist). */
export const SHIPPED_MARKET: readonly string[] = ['SPY', 'QQQ', 'VT', 'BND'];

// A fund that copies an index is named as a fund ("S&P 500 fund"), so it is never taken for the index itself, which the
// Markets cards show under the index's own name at about ten times the fund's price.
const sp500 = { name: 'S&P 500 fund', meaning: 'copies the S&P 500 index: about 500 large US companies, chosen by S&P' }, us = { name: 'The whole US market', meaning: 'nearly every US company, large and small' };
const bonds = { name: 'US bonds', meaning: 'loans to the US government and to companies: steadier than shares, and they pay interest' };
/** The broad funds, the sector funds and the coins paper follows, by name in plain words, with what each holds. */
export const PLAIN: Readonly<Record<string, { name: string; meaning: string }>> = {
  SPY: sp500, VOO: sp500, IVV: sp500, VTI: us, ITOT: us, SCHB: us, BND: bonds, AGG: bonds,
  QQQ: { name: 'Nasdaq 100 fund', meaning: 'copies the Nasdaq 100 index: the 100 largest companies on the Nasdaq exchange, leaving out banks and other financial firms, mostly technology' },
  DIA: { name: 'Dow Jones fund', meaning: 'copies the Dow Jones index: 30 large, long-established US companies' },
  IWM: { name: 'Russell 2000 fund', meaning: 'copies the Russell 2000 index: 2,000 smaller US companies' },
  VT: { name: 'The whole world', meaning: 'thousands of companies in dozens of countries' },
  VXUS: { name: 'The world outside the US', meaning: 'thousands of companies outside the United States' },
  VEA: { name: 'Developed markets', meaning: 'companies large and small in developed countries outside the US, such as in Europe, Japan, Canada and Australia' },
  EFA: { name: 'Developed markets', meaning: 'large companies in Europe, Japan and Australia' },
  VWO: { name: 'Emerging markets', meaning: 'companies in growing economies such as China, India and Brazil' },
  XLK: { name: 'Technology', meaning: 'makers of chips, software and computers' },
  XLF: { name: 'Financials', meaning: 'banks, insurers and investment firms' },
  XLV: { name: 'Health care', meaning: 'drug makers, hospitals and medical equipment' },
  XLE: { name: 'Energy', meaning: 'oil and gas producers and the firms that serve them' },
  XLI: { name: 'Industrials', meaning: 'machines, planes, railways and builders' },
  XLY: { name: 'Consumer discretionary', meaning: 'what people choose to buy, such as cars, shops and travel' },
  XLP: { name: 'Consumer staples', meaning: 'what people buy whatever happens, such as food, drink and soap' },
  XLU: { name: 'Utilities', meaning: 'electricity, gas and water companies' },
  XLB: { name: 'Materials', meaning: 'chemicals, metals, mining and packaging' },
  XLRE: { name: 'Real estate', meaning: 'owners of offices, homes, warehouses and phone towers' },
  XLC: { name: 'Communication', meaning: 'phone companies, media and internet platforms' },
  'BTC-USD': { name: 'Bitcoin', meaning: 'the first and largest coin' },
  'ETH-USD': { name: 'Ether', meaning: 'the coin of the Ethereum network, the second largest' },
};

/** Whether an order ticket can open for it, by its spelling (buyable.ts): a stock or a fund, or among coins Bitcoin and
 *  Ether (each checked live against Robinhood's list of coins when the ticket opens); never another coin, an index, a
 *  future or a currency (the dashboard's server refuses those at every ticket door too). What Yahoo says of a stock or a
 *  fund (a foreign listing, a mutual fund) the page reads from its quote, and the server asks again before a buy. */
export const ticketable = (symbol: string): boolean => spelledUnbuyable(symbol) === null;

/** The tier a symbol belongs to: crypto, a sector fund, the whole market (a broad fund the desk lists in desk/sectors.ts, or an
 *  index), else a single name (one company, or a narrower fund). */
export function tierOf(symbol: string): Tier {
  if (isCrypto(symbol)) return 'crypto';
  if (SECTOR_FUNDS[symbol]) return 'sectors';
  if (symbol.startsWith('^') || MARKET_FUNDS.has(symbol)) return 'market';
  return 'names';
}

/** What "Worth a look today" looks at: the eleven sector funds and the watchlist (broad funds the person follows are on it);
 *  news is read for the single names and the coins alone (a fund is seldom in the news by its ticker). */
export function screenUniverse(watchlist: readonly WatchItem[]): { symbols: string[]; news: Set<string> } {
  const symbols = [...new Set([...Object.keys(SECTOR_FUNDS), ...watchlist.map((w) => w.symbol)])];
  return { symbols, news: new Set(watchlist.map((w) => w.symbol).filter((s) => { const t = tierOf(s); return t === 'names' || t === 'crypto'; })) };
}

export interface TierItem {
  symbol: string;
  /** Its name in plain words and what it holds, for a fund or a coin in PLAIN; else none, and the page names it as Yahoo does. */
  name?: string; meaning?: string;
  /** On the person's watchlist, and starred there. */
  watched: boolean; favourite: boolean;
  /** The desk's latest call on it, or null: no call yet. */
  call: { rating: string; date: string } | null;
  /** Followed on paper: a stock, a fund, Bitcoin or Ether. */
  paper: boolean;
  /** Can open an order ticket: a stock or a fund, or Bitcoin or Ether; never another coin or an index. */
  ticket: boolean;
}
export interface TierView { tier: Tier; name: string; meaning: string; items: TierItem[] }

/** The "Sectors" section and the watchlist by tier, from the watchlist and the desk's calls. Sectors (sent as `startHere`,
 *  the section's old name): the eleven sector funds, always, whether watched or not. The watchlist: each tier it has
 *  something in, broadest first, which is where the whole-market funds, single names and coins the person follows are. */
export function tiersOf(watchlist: readonly WatchItem[], calls: ReadonlyArray<{ ticker: string; date: string; rating: string }>): { startHere: TierView[]; watch: TierView[] } {
  const latest = new Map<string, { rating: string; date: string }>();
  for (const c of calls) { const was = latest.get(c.ticker); if (!was || c.date > was.date) latest.set(c.ticker, { rating: c.rating, date: c.date }); }
  const watched = new Map(watchlist.map((w) => [w.symbol, w]));
  const item = (symbol: string): TierItem => {
    const w = watched.get(symbol), p = PLAIN[symbol];
    return {
      symbol, ...(p ? { name: p.name, meaning: p.meaning } : {}), watched: !!w, favourite: !!w?.favourite,
      call: latest.get(symbol) ?? null, paper: followed(symbol), ticket: ticketable(symbol),
    };
  };
  const view = (tier: Tier, symbols: readonly string[]): TierView => ({ tier, ...TIER_WORDS[tier], items: symbols.map(item) });
  const of = (t: Tier) => watchlist.filter((w) => tierOf(w.symbol) === t).map((w) => w.symbol);
  return {
    startHere: [view('sectors', Object.keys(SECTOR_FUNDS))],
    watch: TIERS.map((t) => view(t, of(t))).filter((v) => v.items.length > 0),
  };
}
