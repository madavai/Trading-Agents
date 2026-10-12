// The free data sources the desk reads, each asked once with a small request, so a person sees which ones this computer
// can reach before the desk relies on them. A source that cannot be reached is reported as such, never as "no data".
import { ASK_FOR_EMAIL } from '../contact.js';

export interface Source {
  name: string;
  url: string;
  /** whether the answer is the kind of data the desk reads, from its first bytes */
  looksRight: (body: string) => boolean;
  /** what to tell the person when the source refuses */
  onRefused?: string;
}

export const SOURCES: Source[] = [
  { name: 'Yahoo Finance prices', url: 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d', looksRight: (b) => b.includes('"chart"') },
  { name: 'Yahoo Finance news', url: 'https://query1.finance.yahoo.com/v1/finance/search?q=SPY&newsCount=3&quotesCount=1', looksRight: (b) => b.includes('"news"') },
  { name: 'StockTwits', url: 'https://api.stocktwits.com/api/2/streams/symbol/SPY.json', looksRight: (b) => b.includes('"messages"') },
  { name: 'Reddit', url: 'https://www.reddit.com/r/stocks/search.rss?q=SPY&restrict_sr=on&sort=new&t=week', looksRight: (b) => b.includes('<feed') },
  { name: 'FRED economic data', url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10', looksRight: (b) => /observation_date|DATE/.test(b) },
  { name: 'Polymarket', url: 'https://gamma-api.polymarket.com/public-search?q=fed&limit_per_type=1', looksRight: (b) => b.trimStart().startsWith('{') },
  { name: 'SEC EDGAR', url: 'https://www.sec.gov/files/company_tickers.json', looksRight: (b) => b.includes('"ticker"'),
    onRefused: ASK_FOR_EMAIL },
];

export interface ProbeResult { name: string; ok: boolean; detail: string }

type Fetch = typeof fetch;
const MAX_BYTES = 64 * 1024;

/** The first bytes of a body, without reading the rest. */
async function head(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function probe(source: Source, userAgent: string, fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetchImpl(source.url, { headers: { 'User-Agent': userAgent, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - started;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const why = source.onRefused && (res.status === 403 || res.status === 401) ? `: ${source.onRefused}` : '';
      return { name: source.name, ok: false, detail: `refused (HTTP ${res.status})${why}` };
    }
    const body = await head(res);
    return source.looksRight(body)
      ? { name: source.name, ok: true, detail: `answered in ${ms} ms` }
      : { name: source.name, ok: false, detail: 'answered, but not with the data the desk reads' };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { name: source.name, ok: false, detail: `unreachable (no answer within ${Math.round(timeoutMs / 1000)} s)` };
    return { name: source.name, ok: false, detail: `unreachable (${err.message})` };
  }
}

/** The user agent a source sees: the project's name and address. The person's email goes to the SEC alone, which asks
 *  every caller for one; no other source ever sees it. */
export function userAgentFor(url: string, contact: string, email: string): string {
  const host = new URL(url).hostname;
  const sec = host === 'sec.gov' || host.endsWith('.sec.gov');
  return sec && email.trim() ? `${contact} ${email.trim()}` : contact;
}

export async function probeAll(contact: string, secEmail: string, fetchImpl: Fetch = fetch, timeoutMs = 8000): Promise<ProbeResult[]> {
  return Promise.all(SOURCES.map((s) => probe(s, userAgentFor(s.url, contact, secEmail), fetchImpl, timeoutMs)));
}
