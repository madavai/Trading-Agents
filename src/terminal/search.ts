// Stocks that match what the person types in the dashboard's box, from Yahoo Finance's public search (no key): the
// ticker, the name, the market and what kind of thing it is. Only what the desk can price and chart is offered: no
// futures or options. A search that cannot be run is said to be unavailable, never "nothing matches".
import { getJson, Unavailable } from '../data/http.js';
import { safeSymbol } from '../data/symbols.js';
import { HOSTS } from '../data/yahoo.js';

export interface Match { symbol: string; name: string; exchange: string; kind: string }
interface SearchJson { quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; exchDisp?: string; quoteType?: string; isYahooFinance?: boolean }> }

const KINDS: Record<string, string> = { EQUITY: 'Stock', ETF: 'ETF', INDEX: 'Index', MUTUALFUND: 'Fund', CRYPTOCURRENCY: 'Crypto', CURRENCY: 'Currency' };

/** What a person may type: letters, digits, spaces and the marks in names and tickers, at most 40 characters. */
export const QUERY = /^[\p{L}\p{N} .&'\-^=,]{1,40}$/u;

/** Turns Yahoo's answer into the matches the dashboard offers. Exported for the tests. */
export function parseSearch(json: SearchJson, limit = 8): Match[] {
  const out: Match[] = [], seen = new Set<string>();
  for (const q of json.quotes ?? []) {
    const kind = KINDS[q.quoteType ?? ''];
    if (!kind || !q.symbol || q.isYahooFinance === false) continue;
    let symbol: string;
    try { symbol = safeSymbol(q.symbol); } catch { continue; }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: (q.longname || q.shortname || symbol).trim(), exchange: (q.exchDisp ?? '').trim(), kind });
    if (out.length >= limit) break;
  }
  return out;
}

const memo = new Map<string, { at: number; value: Promise<Match[]> }>();
const MEMO_MS = 5 * 60_000;

/** The matches for a query, asked of Yahoo once every five minutes however often it is typed. */
export function findSymbols(raw: string): Promise<Match[]> {
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
