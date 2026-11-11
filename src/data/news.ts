// Company and world news from Yahoo Finance's public search (no key): headlines with their publisher and time, held to
// the analysis window. Search returns only its latest articles (for a busy name, a few hours' worth), so every answer says
// the span its articles really cover, and a window it cannot reach, or an empty one, is said to be so - never "no news".
// World news is the news Yahoo files under the market's own symbols (the settings' worldNewsSearches): its search finds
// nothing under topic words such as "Federal Reserve".
import { addDays, analysisDate, isHistorical, marketDay } from './dates.js';
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
      // Its search always carries a list of articles, empty when there are none: an answer without one is broken.
      if (!Array.isArray(j.news)) throw new Unavailable("Yahoo Finance answered its news search without a list of articles");
      return j.news.filter((n) => n.title && n.providerPublishTime).map((n) => ({ title: n.title!, publisher: n.publisher ?? 'unknown', link: n.link ?? '', time: stamp(n.providerPublishTime!), tickers: (n.relatedTickers ?? []).map((t) => t.toUpperCase()) }));
    } catch (e) { last = e; }
  }
  throw last;
}

/** The desk's day (New York's) of a time stamped "YYYY-MM-DD HH:MM" in UTC: an article or post of a New York evening is
 *  of that day, though its UTC date is the next. */
export const dayOf = (time: string): string => marketDay(new Date(`${time.replace(' ', 'T')}:00Z`));
/** Within the window's New York days. */
export const within = (time: string, from: string, to: string): boolean => { const d = dayOf(time); return d >= from && d <= to; };
const inWindow = (a: Article, from: string, to: string) => within(a.time, from, to);
const render = (list: Article[]) => list.map((a) => `- ${a.time} UTC · ${a.publisher}: ${a.title}${a.link ? `\n  ${a.link}` : ''}`).join('\n');

/** The span some times ("YYYY-MM-DD HH:MM", UTC) cover, in words: "2026-11-06 21:52 to 23:41 UTC" within a day. */
export function spanOf(times: readonly string[]): string {
  const sorted = [...times].sort(), a = sorted[0] ?? '', b = sorted.at(-1) ?? '';
  return a === b ? `${a} UTC` : `${a} to ${a.slice(0, 10) === b.slice(0, 10) ? b.slice(11) : b} UTC`;
}

/** Whether a source's sample reaches back over the whole window: its oldest item is from before the window's first day. */
export const reaches = (oldest: string | undefined, from: string): boolean => oldest !== undefined && dayOf(oldest) < from;

/** "the newest 20 of 39" when the limit cut the list, else the count alone. */
const newest = (shown: number, of: number, noun: string) => (of > shown ? `the newest ${shown} of ${of} ${noun}s` : `${shown} ${noun}${shown === 1 ? '' : 's'}`);

/** What to say when no article falls in the window: a window the sample does not reach, or an empty sample. */
function gap(found: Article[], from: string, to: string, subject: string): string {
  const oldest = found.map((a) => dayOf(a.time)).sort()[0];
  if (oldest && oldest > to) return `Unavailable for ${from} to ${to}: Yahoo Finance's search serves only recent articles (the oldest it returned is from ${oldest}), so this is not an absence of ${subject}.`;
  return `No ${subject} between ${from} and ${to} in Yahoo Finance's search results. Search returns a sample, so this is not proof that nothing happened.`;
}

export async function companyNews(raw: string, analysis: string, lookBackDays: number, limit: number): Promise<string> {
  const day = analysisDate(analysis), sym = normalizeSymbol(raw), from = addDays(day, -lookBackDays);
  const all = await search(sym, Math.max(limit * 2, 20));
  // Articles carry the tickers they are about; when the search sends none at all, its own match is all there is.
  const untagged = all.length > 0 && all.every((a) => a.tickers.length === 0);
  const found = untagged ? all : all.filter((a) => a.tickers.includes(sym));
  if (!found.length) {
    // Why it may have none is said only where it applies: a listing with an exchange suffix (7203.T, SHEL.L) is outside the US.
    const abroad = /\.[A-Z]{1,4}$/.test(sym) ? ' (it carries few articles on listings outside the US)' : '';
    throw new Unavailable(all.length ? `Yahoo Finance's search returned ${all.length} article${all.length === 1 ? '' : 's'} for ${sym}, none tagged ${sym}${abroad}` : `Yahoo Finance's search returned no articles for ${sym}${abroad}`);
  }
  const within = found.filter((a) => inWindow(a, from, day)).sort((a, b) => b.time.localeCompare(a.time)), list = within.slice(0, limit);
  if (!list.length) return gap(found, from, day, `news about ${sym}`);
  const how = untagged ? `matched by Yahoo's search for "${sym}", not tagged: check each is about this company` : `tagged ${sym}`;
  const count = newest(list.length, within.length, 'article'), span = spanOf(list.map((a) => a.time)), oldest = found.map((a) => a.time).sort()[0];
  const head = reaches(oldest, from)
    ? `News about ${sym}, ${from} to ${day} (New York days; ${count} ${how}, from ${span}; headlines only)`
    : `News about ${sym} from ${span} only (${count} ${how}; headlines only). The window asked for is ${from} to ${day} (New York days), but Yahoo Finance's search returns only its latest articles, and the oldest it returned is from ${oldest} UTC: what came before was not reached, so this says nothing about the news earlier in the window.`;
  return [head, '', render(list)].join('\n');
}

export async function worldNews(analysis: string, lookBackDays: number, limit: number, queries: string[]): Promise<string> {
  const day = analysisDate(analysis), from = addDays(day, -lookBackDays);
  const results = await Promise.allSettled(queries.map((q) => search(q, 10)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === queries.length) throw (results[0] as PromiseRejectedResult).reason;
  const seen = new Set<string>(), all: Article[] = [];
  for (const r of results) if (r.status === 'fulfilled') for (const a of r.value) { const k = a.link || a.title; if (!seen.has(k)) { seen.add(k); all.push(a); } }
  const within = all.filter((a) => inWindow(a, from, day)).sort((a, b) => b.time.localeCompare(a.time)), list = within.slice(0, limit);
  const note = failed ? `\n(${failed} of ${queries.length} searches could not be run: Yahoo Finance did not answer them, or answered without a list of articles.)` : '';
  if (!list.length) return gap(all, from, day, 'world and economic news') + note;
  // Each search returns only its latest articles: a busy one covers hours, a quiet one days.
  const short = queries.flatMap((q, i) => {
    const r = results[i]!, oldest = r.status === 'fulfilled' ? r.value.map((a) => a.time).sort()[0] : undefined;
    return r.status === 'fulfilled' && oldest !== undefined && !reaches(oldest, from) ? [`under ${q} only back to ${oldest} UTC`] : [];
  });
  const past = isHistorical(day) ? ' Search favours recent articles, so a past window may be thin.' : '';
  const count = newest(list.length, within.length, 'article'), span = spanOf(list.map((a) => a.time));
  const head = short.length
    ? `World and economic news from ${span} (${count}), from the news filed under ${queries.join(', ')}. The window asked for is ${from} to ${day} (New York days), but each search returns only its latest articles, and these did not reach back over it: ${short.join('; ')}. What came before was not reached, so this says nothing about the news earlier in the window.${past}`
    : `World and economic news, ${from} to ${day} (${count}, from ${span}), from the news filed under ${queries.join(', ')}.${past}`;
  return [head, '', render(list)].join('\n') + note;
}
