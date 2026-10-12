// What people are posting: StockTwits' public stream (each message tagged Bullish, Bearish or neither by its author) and
// Reddit's public search feed, held to the analysis window. Both serve only recent posts; a window they cannot reach,
// or a source that fails, is said to be so - never read as a quiet crowd.
// The sources, subreddits and their reading rules are TradingAgents' (sentiment analyst, stocktwits.py, reddit.py),
// Apache License 2.0.
import { addDays, analysisDate } from './dates.js';
import { getJson, getText } from './http.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';

export interface Post { time: string; text: string; tag?: string; where?: string; title?: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
const plain = (html: string) => decode(decode(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

interface TwitsJson { messages?: Array<{ body?: string; created_at?: string; entities?: { sentiment?: { basic?: string } | null } }> }

export async function stocktwits(raw: string, from: string, to: string, limit: number): Promise<Post[]> {
  const base = cryptoBase(raw), sym = base ? `${base}.X` : normalizeSymbol(raw);
  const j = await getJson<TwitsJson>(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`);
  return (j.messages ?? []).filter((m) => m.body && m.created_at)
    .map((m) => ({ time: m.created_at!.slice(0, 16).replace('T', ' '), text: clip(m.body!.replace(/\s+/g, ' ').trim(), 280), tag: m.entities?.sentiment?.basic ?? undefined }))
    .filter((p) => p.time.slice(0, 10) >= from && p.time.slice(0, 10) <= to).slice(0, limit);
}

/** The entries of a Reddit Atom feed. Exported for the tests. */
export function parseAtom(xml: string): Post[] {
  return xml.split(/<entry[\s>]/).slice(1).map((chunk) => {
    const e = chunk.split('</entry>')[0] ?? '';
    const pick = (re: RegExp) => re.exec(e)?.[1] ?? '';
    return { time: (pick(/<published>([^<]+)<\/published>/) || pick(/<updated>([^<]+)<\/updated>/)).slice(0, 16).replace('T', ' '), title: plain(pick(/<title[^>]*>([\s\S]*?)<\/title>/)), text: clip(plain(pick(/<content[^>]*>([\s\S]*?)<\/content>/)), 300), where: pick(/<category[^>]*term="([^"]+)"/) };
  }).filter((p) => p.time && p.title);
}

export async function reddit(raw: string, from: string, to: string, subs: string[]): Promise<Post[]> {
  const base = cryptoBase(raw), q = base ?? normalizeSymbol(raw).replace(/\..*$/, '');
  const url = `https://www.reddit.com/r/${subs.map(encodeURIComponent).join('+')}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=on&sort=new&t=week&limit=100`;
  return parseAtom(await getText(url, { headers: { Accept: 'application/atom+xml' } })).filter((p) => p.time.slice(0, 10) >= from && p.time.slice(0, 10) <= to);
}

/** The subreddits for a symbol: crypto communities for a crypto pair (its own coin's first, when it has one). */
export function subredditsFor(raw: string, stock: string[], crypto: string[]): string[] {
  const base = cryptoBase(raw);
  if (!base) return stock;
  const own: Record<string, string> = { BTC: 'Bitcoin', ETH: 'ethereum', SOL: 'solana' };
  return own[base] ? [own[base]!, ...crypto] : crypto;
}

export async function socialPosts(raw: string, analysis: string, opts: { lookBackDays: number; stocktwitsLimit: number; subreddits: string[]; cryptoSubreddits: string[] }): Promise<string> {
  const day = analysisDate(analysis), from = addDays(day, -opts.lookBackDays), sym = normalizeSymbol(raw);
  const subs = subredditsFor(raw, opts.subreddits, opts.cryptoSubreddits);
  const [tw, rd] = await Promise.allSettled([stocktwits(raw, from, day, opts.stocktwitsLimit), reddit(raw, from, day, subs)]);
  const out = [`Posts about ${sym}, ${from} to ${day}. Both sources serve only recent posts, so a past window can be empty for that reason alone.`, ''];

  out.push('### StockTwits (retail traders; each author may tag a message Bullish or Bearish)');
  if (tw.status === 'rejected') out.push(`StockTwits unavailable: ${(tw.reason as Error).message}. This is not a quiet crowd.`);
  else if (!tw.value.length) out.push(`No StockTwits messages about ${sym} in this window that the stream still serves.`);
  else {
    const bull = tw.value.filter((p) => p.tag === 'Bullish').length, bear = tw.value.filter((p) => p.tag === 'Bearish').length, tagged = bull + bear;
    out.push(`${tw.value.length} messages: ${bull} Bullish, ${bear} Bearish, ${tw.value.length - tagged} untagged${tagged ? ` (${Math.round((bull / tagged) * 100)}/${Math.round((bear / tagged) * 100)} among the tagged)` : ''}.`);
    out.push(...tw.value.map((p) => `- ${p.time} UTC${p.tag ? ` [${p.tag}]` : ''}: ${p.text}`));
  }

  out.push('', `### Reddit (${subs.map((s) => `r/${s}`).join(', ')}; no vote or comment counts in the feed)`);
  if (rd.status === 'rejected') out.push(`Reddit unavailable: ${(rd.reason as Error).message}. This is not a quiet crowd.`);
  else if (!rd.value.length) out.push(`No Reddit posts about ${sym} in these communities in this window that the feed still serves.`);
  else out.push(`${rd.value.length} posts.`, ...rd.value.slice(0, 25).map((p) => `- ${p.time} UTC · r/${p.where || '?'}: ${p.title}${p.text ? ` - ${p.text}` : ''}`));
  return out.join('\n');
}
