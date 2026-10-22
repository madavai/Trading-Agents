// Company and world news from Yahoo Finance's public search (no key): headlines with their publisher and time, held to
// the analysis window. Search returns a recent sample, so a window it cannot reach, or an empty one, is said to be so -
// never "no news". World news is the news Yahoo files under the market's own symbols (the settings' worldNewsSearches):
// its search finds nothing under topic words such as "Federal Reserve".
import { addDays, analysisDate, isHistorical } from './dates.js';
import { getJson, Unavailable } from './http.js';
import { normalizeSymbol } from './symbols.js';
import { HOSTS } from './yahoo.js';

export interface Article { title: string; publisher: string; link: string; time: string; tickers: string[] }
interface SearchJson { news?: Array<{ uuid?: string; title?: string; publisher?: string; link?: string; providerPublishTime?: number; relatedTickers?: string[] }> }

const stamp = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ');

export async function search(q: string, count: number): Promise<Article[]> {
  const qs = `q=${encodeURIComponent(q)}&newsCount=${count}&quotesCount=0&enableFuzzyQuery=false`;
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const j = await getJson<SearchJson>(`${host}/v1/finance/search?${qs}`);
      return (j.news ?? []).filter((n) => n.title && n.providerPublishTime).map((n) => ({ title: n.title!, publisher: n.publisher ?? 'unknown', link: n.link ?? '', time: stamp(n.providerPublishTime!), tickers: (n.relatedTickers ?? []).map((t) => t.toUpperCase()) }));
    } catch (e) { last = e; }
  }
  throw last;
}

const inWindow = (a: Article, from: string, to: string) => a.time.slice(0, 10) >= from && a.time.slice(0, 10) <= to;
const render = (list: Article[]) => list.map((a) => `- ${a.time} UTC · ${a.publisher}: ${a.title}${a.link ? `\n  ${a.link}` : ''}`).join('\n');

/** What to say when no article falls in the window: a window the sample does not reach, or an empty sample. */
function gap(found: Article[], from: string, to: string, subject: string): string {
  const oldest = found.map((a) => a.time.slice(0, 10)).sort()[0];
  if (oldest && oldest > to) return `Unavailable for ${from} to ${to}: Yahoo Finance's search serves only recent articles (the oldest it returned is from ${oldest}), so this is not an absence of ${subject}.`;
  return `No ${subject} between ${from} and ${to} in Yahoo Finance's search results. Search returns a sample, so this is not proof that nothing happened.`;
}

export async function companyNews(raw: string, analysis: string, lookBackDays: number, limit: number): Promise<string> {
  const day = analysisDate(analysis), sym = normalizeSymbol(raw), from = addDays(day, -lookBackDays);
  const all = await search(sym, Math.max(limit * 2, 20));
  // Articles carry the tickers they are about; when the search sends none at all, its own match is all there is.
  const untagged = all.length > 0 && all.every((a) => a.tickers.length === 0);
  const found = untagged ? all : all.filter((a) => a.tickers.includes(sym));
  if (!found.length) throw new Unavailable(`Yahoo Finance's search has no articles tagged ${sym} (it tags few listings outside the US)`);
  const list = found.filter((a) => inWindow(a, from, day)).sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
  if (!list.length) return gap(found, from, day, `news about ${sym}`);
  const how = untagged ? `matched by Yahoo's search for "${sym}", not tagged: check each is about this company` : `tagged ${sym}`;
  return [`News about ${sym}, ${from} to ${day} (${list.length} article${list.length === 1 ? '' : 's'} ${how}; headlines only)`, '', render(list)].join('\n');
}

export async function worldNews(analysis: string, lookBackDays: number, limit: number, queries: string[]): Promise<string> {
  const day = analysisDate(analysis), from = addDays(day, -lookBackDays);
  const results = await Promise.allSettled(queries.map((q) => search(q, 10)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === queries.length) throw (results[0] as PromiseRejectedResult).reason;
  const seen = new Set<string>(), all: Article[] = [];
  for (const r of results) if (r.status === 'fulfilled') for (const a of r.value) { const k = a.link || a.title; if (!seen.has(k)) { seen.add(k); all.push(a); } }
  const list = all.filter((a) => inWindow(a, from, day)).sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
  const note = failed ? `\n(${failed} of ${queries.length} searches could not be run: Yahoo Finance did not answer them.)` : '';
  if (!list.length) return gap(all, from, day, 'world and economic news') + note;
  const past = isHistorical(day) ? ' Search favours recent articles, so a past window may be thin.' : '';
  return [`World and economic news, ${from} to ${day}, from the news filed under ${queries.join(', ')}.${past}`, '', render(list)].join('\n') + note;
}
