// What people are posting: StockTwits' public stream (each message tagged Bullish, Bearish or neither by its author) and
// Reddit's public search feed, held to the analysis window. Both serve only their latest posts (StockTwits 30, for a busy
// name an hour or two), so each says the span its posts really cover; a window they cannot reach, or a source that
// fails, is said to be so - never read as a quiet crowd.
// The sources, subreddits and their reading rules are TradingAgents' (sentiment analyst, stocktwits.py, reddit.py),
// Apache License 2.0.
import { addDays, analysisDate } from './dates.js';
import { getJson, getText, Unavailable } from './http.js';
import { reaches, spanOf, within } from './news.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';

export interface Post { time: string; text: string; tag?: string; where?: string; title?: string }
/** The posts in the window, and the oldest post the source returned at all (what its sample reaches back to). `full`:
 *  the source returned as many as it gives, so older posts in the window may not have been reached. */
export interface Sample { posts: Post[]; oldest?: string; full: boolean }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
const plain = (html: string) => decode(decode(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

interface TwitsJson { messages?: Array<{ body?: string; created_at?: string; entities?: { sentiment?: { basic?: string } | null } }>; errors?: Array<{ message?: string }> }

const oldestOf = (posts: Post[]) => posts.map((p) => p.time).sort()[0];

/** StockTwits' stream: its latest messages, a page of up to 30 (older ones need a request per page). It serves its latest
 *  messages however old they are (a symbol it does not know is refused), so an answer with no list of messages, or an
 *  empty one, is a broken answer: unavailable, never a quiet crowd. */
export async function stocktwits(raw: string, from: string, to: string, limit: number): Promise<Sample> {
  const base = cryptoBase(raw), sym = base ? `${base}.X` : normalizeSymbol(raw);
  const j = await getJson<TwitsJson>(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`);
  if (!Array.isArray(j.messages)) {
    const said = j.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new Unavailable(`StockTwits answered without its list of messages${said ? `, saying "${clip(said, 140)}"` : ''}`);
  }
  if (!j.messages.length) throw new Unavailable(`the stream for ${sym} came back with no messages at all, though it serves its latest messages however old they are: an empty stream is a fault, or a symbol no one has posted about`);
  const all = j.messages.filter((m) => m.body && m.created_at)
    .map((m) => ({ time: m.created_at!.slice(0, 16).replace('T', ' '), text: clip(m.body!.replace(/\s+/g, ' ').trim(), 280), tag: m.entities?.sentiment?.basic ?? undefined }));
  if (!all.length) throw new Unavailable(`none of the ${j.messages.length} messages in the stream for ${sym} came with a text and a time`);
  return { posts: all.filter((p) => within(p.time, from, to)).slice(0, limit), oldest: oldestOf(all), full: j.messages.length >= 30 };
}

/** The entries of a Reddit Atom feed. Exported for the tests. */
export function parseAtom(xml: string): Post[] {
  return xml.split(/<entry[\s>]/).slice(1).map((chunk) => {
    const e = chunk.split('</entry>')[0] ?? '';
    const pick = (re: RegExp) => re.exec(e)?.[1] ?? '';
    return { time: (pick(/<published>([^<]+)<\/published>/) || pick(/<updated>([^<]+)<\/updated>/)).slice(0, 16).replace('T', ' '), title: plain(pick(/<title[^>]*>([\s\S]*?)<\/title>/)), text: clip(plain(pick(/<content[^>]*>([\s\S]*?)<\/content>/)), 300), where: pick(/<category[^>]*term="([^"]+)"/) };
  }).filter((p) => p.time && p.title);
}

/** Reddit's search of the past week in these communities, newest first: up to 100 posts. Its feed with no posts is an
 *  answer; a web page in its place (a check or a block page) is not, and is said as unavailable. */
export async function reddit(raw: string, from: string, to: string, subs: string[]): Promise<Sample> {
  const base = cryptoBase(raw), q = base ?? normalizeSymbol(raw).replace(/\..*$/, '');
  const url = `https://www.reddit.com/r/${subs.map(encodeURIComponent).join('+')}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=on&sort=new&t=week&limit=100`;
  const body = await getText(url, { headers: { Accept: 'application/atom+xml' } });
  if (!/<feed[\s>]/.test(body)) {
    const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '');
    throw new Unavailable(`Reddit answered with something that is not its feed of posts${title ? ` (a page titled "${clip(title, 80)}")` : ''}`);
  }
  const all = parseAtom(body);
  return { posts: all.filter((p) => within(p.time, from, to)), oldest: oldestOf(all), full: all.length >= 100 };
}

/** What a sample covers, when it does not reach back over the whole window: said so, never read as a quiet crowd. */
const short = (s: Sample, from: string, to: string, what: string): string =>
  (s.full && !reaches(s.oldest, from) ? ` ${what} serves only its latest posts, and the oldest it returned is from ${s.oldest} UTC: the rest of the window asked for (${from} to ${to}, New York days) was not reached, so these show the mood of those hours and say nothing about earlier in the window.` : '');

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
  const out = [`Posts about ${sym}, asked for ${from} to ${day} (New York days; the times below are UTC). Both sources serve only their latest posts, so each part says the span its posts really cover, and a past window can be empty for that reason alone.`, ''];

  out.push('### StockTwits (retail traders; each author may tag a message Bullish or Bearish)');
  if (tw.status === 'rejected') out.push(`StockTwits unavailable: ${(tw.reason as Error).message}. This is not a quiet crowd.`);
  else if (!tw.value.posts.length) out.push(`No StockTwits messages about ${sym} in this window that the stream still serves.`);
  else {
    const posts = tw.value.posts, bull = posts.filter((p) => p.tag === 'Bullish').length, bear = posts.filter((p) => p.tag === 'Bearish').length, tagged = bull + bear;
    out.push(`${posts.length} message${posts.length === 1 ? "" : "s"}, from ${spanOf(posts.map((p) => p.time))}: ${bull} Bullish, ${bear} Bearish, ${posts.length - tagged} untagged${tagged ? ` (${Math.round((bull / tagged) * 100)}/${Math.round((bear / tagged) * 100)} among the tagged)` : ''}.${short(tw.value, from, day, 'The stream')}`);
    out.push(...posts.map((p) => `- ${p.time} UTC${p.tag ? ` [${p.tag}]` : ''}: ${p.text}`));
  }

  out.push('', `### Reddit (${subs.map((s) => `r/${s}`).join(', ')}; no vote or comment counts in the feed)`);
  if (rd.status === 'rejected') out.push(`Reddit unavailable: ${(rd.reason as Error).message}. This is not a quiet crowd.`);
  else if (!rd.value.posts.length) out.push(`No Reddit posts about ${sym} in these communities in this window that the feed still serves.`);
  else {
    const posts = rd.value.posts, shown = posts.slice(0, 25);
    out.push(`${posts.length} post${posts.length === 1 ? '' : 's'}, from ${spanOf(posts.map((p) => p.time))}${posts.length > shown.length ? ` (the newest ${shown.length} shown)` : ''}.${short(rd.value, from, day, 'The feed')}`,
      ...shown.map((p) => `- ${p.time} UTC · r/${p.where || '?'}: ${p.title}${p.text ? ` - ${p.text}` : ''}`));
  }
  return out.join('\n');
}
