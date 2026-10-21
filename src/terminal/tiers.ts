// The world in tiers, as the dashboard shows it: the whole market (a few broad funds, the person's to change), the eleven
// S&P sector funds, single names, and crypto, broadest first, so the page itself points a beginner to broad, cheaper risk
// before single companies. Each tier, each broad fund and each sector fund has a name and a one-line meaning in plain
// words. "Start here" shows the first two whole and the person's own names after them; the watchlist is grouped the same way.
import { isCrypto, safeSymbol } from '../data/symbols.js';
import { followed } from '../desk/paper.js';
import { MARKET_FUNDS, SECTOR_FUNDS } from '../desk/sectors.js';
import type { WatchItem } from './store.js';

export type Tier = 'market' | 'sectors' | 'names' | 'crypto';
/** The tiers, broadest first: the order the page shows them in. */
export const TIERS: readonly Tier[] = ['market', 'sectors', 'names', 'crypto'];

export const TIER_WORDS: Readonly<Record<Tier, { name: string; meaning: string }>> = {
  market: { name: 'The whole market', meaning: 'Funds that each hold hundreds or thousands of companies, or bonds: the broadest and steadiest place to start.' },
  sectors: { name: 'Sectors', meaning: 'The eleven parts of the economy, such as technology or energy, one fund each: side by side, they show which parts are rising.' },
  names: { name: 'Single names', meaning: 'One company each, or a narrower fund: each can swing far more than the whole market.' },
  crypto: { name: 'Crypto', meaning: 'Coins such as Bitcoin, which swing far more than shares: the desk follows them on paper only, never with an order.' },
};

/** The whole-market tier as shipped: the S&P 500, the Nasdaq 100, the whole world and US bonds. */
export const SHIPPED_MARKET: readonly string[] = ['SPY', 'QQQ', 'VT', 'BND'];
export const MAX_MARKET = 8;
/** How many of the person's own names "Start here" shows in a tier; the rest are in the watchlist below it. */
export const START_NAMES = 12;

const sp500 = { name: 'S&P 500', meaning: 'the 500 largest US companies' }, us = { name: 'The whole US market', meaning: 'nearly every US company, large and small' };
const bonds = { name: 'US bonds', meaning: 'loans to the US government and to companies: steadier than shares, and they pay interest' };
/** The broad funds, the sector funds and the coins paper follows, by name in plain words, with what each holds. */
export const PLAIN: Readonly<Record<string, { name: string; meaning: string }>> = {
  SPY: sp500, VOO: sp500, IVV: sp500, VTI: us, ITOT: us, SCHB: us, BND: bonds, AGG: bonds,
  QQQ: { name: 'Nasdaq 100', meaning: 'the 100 largest companies on the Nasdaq exchange, mostly technology' },
  DIA: { name: 'Dow Jones', meaning: '30 large, long-established US companies' },
  IWM: { name: 'Russell 2000', meaning: '2,000 smaller US companies' },
  VT: { name: 'The whole world', meaning: 'thousands of companies in dozens of countries' },
  VXUS: { name: 'The world outside the US', meaning: 'thousands of companies outside the United States' },
  VEA: { name: 'Developed markets', meaning: 'large companies in Europe, Japan, Canada and Australia' },
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

/** A ticker the person may put in the whole-market tier: a fund or a stock, spelled as Yahoo spells it. Crypto, indices,
 *  futures, currencies and the sector funds are refused, each in words: they have tiers of their own, or cannot be held. */
export function marketSymbol(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('a ticker is a word, such as SPY');
  const s = safeSymbol(raw);
  if (isCrypto(s)) throw new Error(`${s} is crypto, which has a tier of its own`);
  if (/[\^=]/.test(s)) throw new Error(`${s} is an index, a future or a currency, which cannot be held: choose a fund that follows it, such as SPY`);
  if (SECTOR_FUNDS[s]) throw new Error(`${s} is a sector fund, already among the sectors`);
  return s;
}

/** The person's whole-market list as kept: each a market ticker, once, at most eight; anything else is left out. */
export function cleanMarket(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= MAX_MARKET) break;
    try { const s = marketSymbol(v); if (!out.includes(s)) out.push(s); } catch { /* left out */ }
  }
  return out;
}

/** Whether an order ticket can open for it: Robinhood's agent doorway trades stocks and funds, never crypto or an index,
 *  a future or a currency (the dashboard's server refuses those at every ticket door too). */
export const ticketable = (symbol: string): boolean => !isCrypto(symbol) && !/[\^=]/.test(symbol);

export const isShipped = (list: readonly string[]): boolean => list.length === SHIPPED_MARKET.length && list.every((s, i) => s === SHIPPED_MARKET[i]);

/** The tier a symbol belongs to: crypto, a sector fund, the whole market (a broad fund, one in the person's list, or an
 *  index), else a single name. */
export function tierOf(symbol: string, market: readonly string[] = SHIPPED_MARKET): Tier {
  if (isCrypto(symbol)) return 'crypto';
  if (SECTOR_FUNDS[symbol]) return 'sectors';
  if (symbol.startsWith('^') || MARKET_FUNDS.has(symbol) || market.includes(symbol)) return 'market';
  return 'names';
}

/** What "Worth a look today" looks at: the whole-market funds, the eleven sector funds and the watchlist; news is read
 *  for the single names and the coins alone (a fund is seldom in the news by its ticker). */
export function screenUniverse(watchlist: readonly WatchItem[], market: readonly string[]): { symbols: string[]; news: Set<string> } {
  const symbols = [...new Set([...market, ...Object.keys(SECTOR_FUNDS), ...watchlist.map((w) => w.symbol)])];
  return { symbols, news: new Set(watchlist.map((w) => w.symbol).filter((s) => { const t = tierOf(s, market); return t === 'names' || t === 'crypto'; })) };
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
  /** Can open an order ticket: Robinhood's agent doorway trades stocks and funds, never crypto or an index. */
  ticket: boolean;
}
export interface TierView {
  tier: Tier; name: string; meaning: string; items: TierItem[];
  /** How many more of the person's own names are on the watchlist than "Start here" shows. */
  more?: number;
}

/** "Start here" and the watchlist by tier, from the watchlist, the person's whole-market list and the desk's calls.
 *  Start here: the whole market and the eleven sectors always, then the person's single names (starred first, at most
 *  START_NAMES), then their crypto when they watch any. The watchlist: each tier it has something in, broadest first. */
export function tiersOf(watchlist: readonly WatchItem[], market: readonly string[], calls: ReadonlyArray<{ ticker: string; date: string; rating: string }>): { startHere: TierView[]; watch: TierView[] } {
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
  const view = (tier: Tier, symbols: readonly string[], more = 0): TierView => ({ tier, ...TIER_WORDS[tier], items: symbols.map(item), ...(more > 0 ? { more } : {}) });
  const of = (t: Tier) => watchlist.filter((w) => tierOf(w.symbol, market) === t).map((w) => w.symbol);
  const own = (t: Tier): TierView => {
    const list = watchlist.filter((w) => tierOf(w.symbol, market) === t).sort((a, b) => Number(b.favourite) - Number(a.favourite)).map((w) => w.symbol);
    return view(t, list.slice(0, START_NAMES), list.length - START_NAMES);
  };
  return {
    startHere: [view('market', market), view('sectors', Object.keys(SECTOR_FUNDS)), own('names'), ...(of('crypto').length ? [own('crypto')] : [])],
    watch: TIERS.map((t) => view(t, of(t))).filter((v) => v.items.length > 0),
  };
}
