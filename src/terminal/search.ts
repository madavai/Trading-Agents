// Stocks that match what the person types in the dashboard's box, from Yahoo Finance's public search (no key): the
// ticker, the name, the market and what kind of thing it is. Only what can be bought here is offered (buyable.ts): a US
// stock or fund on a main exchange, or Bitcoin or Ether, never an index, a currency, a future, an option, a mutual fund,
// a foreign listing or another coin; how many Yahoo found that were left out is said. A search that cannot be run is
// said to be unavailable, never "nothing matches".
import { getJson, Unavailable } from '../data/http.js';
import { safeSymbol } from '../data/symbols.js';
import { HOSTS } from '../data/yahoo.js';
import { unbuyable } from './buyable.js';

export interface Match { symbol: string; name: string; exchange: string; kind: string }
/** The matches offered, and how many more Yahoo found that cannot be bought here, so the page can say they were left out. */
export interface Found { matches: Match[]; left: number }
interface SearchJson { quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; exchange?: string; exchDisp?: string; quoteType?: string; isYahooFinance?: boolean }> }

/** The kinds that can be offered, in the page's words: whatever else Yahoo lists cannot be bought here. */
const KINDS: Record<string, string> = { EQUITY: 'Stock', ETF: 'ETF', CRYPTOCURRENCY: 'Crypto' };

/** What a person may type: letters, digits, spaces and the marks in names and tickers, at most 40 characters. */
export const QUERY = /^[\p{L}\p{N} .&'\-^=,]{1,40}$/u;

/** Turns Yahoo's answer into the matches the dashboard offers, and counts those left out because they cannot be bought
 *  here (a coin in another currency, BTC-EUR, among them: never taken for a stock). Exported for the tests. */
export function parseSearch(json: SearchJson, limit = 8): Found {
  const matches: Match[] = [], seen = new Set<string>(), left = new Set<string>();
  for (const q of json.quotes ?? []) {
    if (!q.symbol || q.isYahooFinance === false) continue;
    let symbol: string;
    try { symbol = safeSymbol(q.symbol); } catch { continue; }
    if (seen.has(symbol) || left.has(symbol)) continue;
    const kind = KINDS[q.quoteType ?? ''];
    if (!kind || unbuyable(symbol, { instrumentType: q.quoteType, exchangeName: q.exchange, fullExchangeName: q.exchDisp })) { left.add(symbol); continue; }
    if (matches.length >= limit) continue;
    seen.add(symbol);
    matches.push({ symbol, name: (q.longname || q.shortname || symbol).trim(), exchange: (q.exchDisp ?? '').trim(), kind });
  }
  return { matches, left: left.size };
}

const memo = new Map<string, { at: number; value: Promise<Found> }>();
const MEMO_MS = 5 * 60_000;

/** The matches for a query, asked of Yahoo once every five minutes however often it is typed. */
export function findSymbols(raw: string): Promise<Found> {
  const q = raw.trim().replace(/\s+/g, ' ');
  const key = q.toLowerCase(), hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const qs = `q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
  const value = (async () => {
    let last: unknown;
    for (const host of HOSTS) {
      try { return parseSearch(await getJson<SearchJson>(`${host}/v1/finance/search?${qs}`)); } catch (e) { last = e; }
    }
    throw last instanceof Unavailable ? last : new Unavailable("Yahoo Finance's search did not answer");
  })();
  value.catch(() => memo.delete(key));   // a failed search is asked again next time
  if (memo.size > 500) memo.clear();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export const clearSearches = (): void => memo.clear();
