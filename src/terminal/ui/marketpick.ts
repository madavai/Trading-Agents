// What the dashboard's search list says about "The whole market" row for one match, so the box at the top is the only place
// a ticker is typed. The page cannot load tiers.ts (it reads files), so the rule for which matches may be offered is here, in
// the same words as `marketSymbol` there, which still holds the last word when the row is saved: it refuses a crypto
// coin, an index, a future, a currency and a sector fund. A test keeps the two in step. Nothing here reads the network.
import { isCrypto } from '../../data/symbols.js';

/** `show`: a fund the row can take; `in`: it is in the row already; `full`: the row holds its most; `none`: not a fund
 *  the row takes (a stock, a sector fund, a coin, an index), or a match whose kind is not known. */
export type MarketOffer = 'show' | 'in' | 'full' | 'none';

/** Yahoo's kinds a fund has, as the search names them (search.ts KINDS: an ETF, and a mutual fund as "Fund"). */
export const FUND_KINDS: readonly string[] = ['ETF', 'Fund'];

export function marketOffer(m: { symbol: string; kind?: string }, row: readonly string[], sectorFunds: ReadonlySet<string>, max: number): MarketOffer {
  if (!m.kind || !FUND_KINDS.includes(m.kind) || isCrypto(m.symbol) || /[\^=]/.test(m.symbol) || sectorFunds.has(m.symbol)) return 'none';
  if (row.includes(m.symbol)) return 'in';
  return row.length >= max ? 'full' : 'show';
}
