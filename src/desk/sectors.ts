// Which sector a stock or a fund counts towards, for the sector limit. The eleven S&P sector funds count towards their
// sector; the common whole-market funds count towards none; anything else takes its sector from its own profile, and a
// fund or a stock whose sector cannot be told counts as a sector of its own, so missing data never hides a concentration.
import { isCrypto } from '../data/symbols.js';
import { profileSector } from '../data/company.js';

/** The S&P sector funds, by the sector names Yahoo Finance gives companies. */
export const SECTOR_FUNDS: Readonly<Record<string, string>> = {
  XLK: 'Technology', XLF: 'Financial Services', XLV: 'Healthcare', XLE: 'Energy', XLI: 'Industrials',
  XLY: 'Consumer Cyclical', XLP: 'Consumer Defensive', XLU: 'Utilities', XLB: 'Basic Materials', XLRE: 'Real Estate', XLC: 'Communication Services',
};
/** Whole-market funds, which spread over every sector and so count towards none. */
export const MARKET_FUNDS: ReadonlySet<string> = new Set(['SPY', 'VOO', 'IVV', 'VTI', 'ITOT', 'SCHB', 'QQQ', 'DIA', 'IWM', 'VT', 'VXUS', 'VEA', 'VWO', 'EFA', 'BND', 'AGG']);

/** A sector as a group the limit adds up: name null is no sector (a whole-market fund); an unknown one is the stock alone. */
export interface Group { name: string | null; label: string }
export const ownGroup = (symbol: string): Group => ({ name: `own:${symbol}`, label: `${symbol}, whose sector is not known, counted on its own` });

export type Lookup = (symbol: string) => Promise<{ sector: string | null; fund: boolean }>;

/** The group of each symbol, remembered for the life of the program (a sector rarely changes). */
export class Sectors {
  private known = new Map<string, Group>();
  constructor(private readonly lookup: Lookup = profileSector) {}

  /** The group of a symbol, if it was looked up already (for a check that must not wait). */
  cached(symbol: string): Group | undefined { return this.known.get(symbol); }

  async of(symbol: string): Promise<Group> {
    const hit = this.known.get(symbol);
    if (hit) return hit;
    let g: Group;
    if (MARKET_FUNDS.has(symbol)) g = { name: null, label: 'a whole-market fund' };
    else if (SECTOR_FUNDS[symbol]) g = { name: SECTOR_FUNDS[symbol]!, label: SECTOR_FUNDS[symbol]! };
    else if (isCrypto(symbol)) g = { name: 'Crypto', label: 'Crypto' };
    else {
      try { const p = await this.lookup(symbol); g = !p.fund && p.sector ? { name: p.sector, label: p.sector } : ownGroup(symbol); }
      catch { return ownGroup(symbol); }   // not remembered: asked again next time
    }
    this.known.set(symbol, g);
    return g;
  }

  /** Looks up every symbol at once, so a later sync check finds them all. */
  async warm(symbols: Iterable<string>): Promise<void> { await Promise.all([...new Set(symbols)].map((s) => this.of(s))); }

  /** The sector a buy of `symbol` falls in, and how much the account already holds in it, from what is held now. A
   *  symbol not looked up yet counts on its own. */
  context(symbol: string, positions: ReadonlyArray<{ symbol: string; quantity: number; price: number | null }>): { name: string | null; label: string; heldUsd: number } {
    const g = this.known.get(symbol) ?? ownGroup(symbol);
    const same = (s: string) => (this.known.get(s) ?? ownGroup(s)).name === g.name;
    const heldUsd = g.name === null ? 0 : positions.filter((p) => same(p.symbol)).reduce((a, p) => a + p.quantity * (p.price ?? 0), 0);
    return { ...g, heldUsd: Math.round(heldUsd * 100) / 100 };
  }
}
