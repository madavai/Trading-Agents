import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure } from '../src/data/http.js';
import { companyNews, worldNews } from '../src/data/news.js';
import { parseAtom, socialPosts, subredditsFor } from '../src/data/social.js';
import { economicSeries, parseCsv, releaseLag } from '../src/data/macro.js';
import { predictionMarkets } from '../src/data/odds.js';
import { deskServer } from '../src/tools/server.js';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

/** A fetch that answers by address, so each test says exactly what each source returns. */
function route(routes: Array<[RegExp, () => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => { const u = String(input); seen.push(u); for (const [re, r] of routes) if (re.test(u)) return r(); return new Response('no route', { status: 404 }); };
}

const NEWS = { news: [
  { title: 'Chipmaker beats on data-centre demand', publisher: 'Reuters', link: 'https://x/1', providerPublishTime: at('2026-10-09T13:00:00Z'), relatedTickers: ['NVDA'] },
  { title: 'Fed holds rates steady', publisher: 'AP', link: 'https://x/2', providerPublishTime: at('2026-10-08T18:00:00Z'), relatedTickers: ['SPY'] },
  { title: 'Analyst day preview', publisher: 'Barron\'s', link: 'https://x/3', providerPublishTime: at('2026-10-11T09:00:00Z'), relatedTickers: ['NVDA'] },
] };

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; });

test('company news keeps only articles tagged with the ticker, inside the window', async () => {
  configure({ fetch: route([[/finance\/search/, () => json(NEWS)]]) });
  const t = await companyNews('nvda', '2026-10-10', 7, 20);
  assert.match(t, /News about NVDA, 2026-10-03 to 2026-10-10 \(1 article/);
  assert.match(t, /Chipmaker beats/);
  assert.doesNotMatch(t, /Fed holds/);           // not tagged NVDA
  assert.doesNotMatch(t, /Analyst day preview/);  // after the analysis date
});

test('a window the search cannot reach is said to be unavailable, not quiet', async () => {
  configure({ fetch: route([[/finance\/search/, () => json(NEWS)]]) });
  assert.match(await companyNews('NVDA', '2026-09-01', 7, 20), /^Unavailable for 2026-08-25 to 2026-09-01: .*not an absence of news about NVDA/);
  configure({ fetch: route([[/finance\/search/, () => json({ news: [] })]]) });
  await assert.rejects(companyNews('7203.T', '2026-10-10', 7, 20), /has no articles tagged 7203.T/);
});

test('when the search tags no article at all, its matches are kept and said to be untagged', async () => {
  const bare = { news: NEWS.news.map(({ relatedTickers: _drop, ...a }) => a) };
  configure({ fetch: route([[/finance\/search/, () => json(bare)]]) });
  const t = await companyNews('NVDA', '2026-10-10', 7, 20);
  assert.match(t, /matched by Yahoo's search for "NVDA", not tagged: check each is about this company/);
  assert.match(t, /Chipmaker beats/);
});

test('world news merges the standing searches without repeats', async () => {
  const seen: string[] = [];
  configure({ fetch: route([[/finance\/search/, () => json(NEWS)]], seen) });
  const t = await worldNews('2026-10-10', 7, 10, ['Federal Reserve', 'oil supply']);
  assert.equal(seen.length, 2);
  assert.equal(t.match(/Fed holds rates steady/g)?.length, 1);
});

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><category term="stocks" label="r/stocks"/><content type="html">&lt;p&gt;Long &amp;amp; strong on NVDA&lt;/p&gt;</content><link href="https://reddit.com/1"/><published>2026-10-09T15:00:00+00:00</published><title>NVDA earnings thread</title></entry>
<entry><category term="wallstreetbets" label="r/wallstreetbets"/><content type="html">calls</content><published>2026-09-01T15:00:00+00:00</published><title>Old post</title></entry>
</feed>`;
const TWITS = { messages: [
  { body: 'Breaking out', created_at: '2026-10-09T14:00:00Z', entities: { sentiment: { basic: 'Bullish' } } },
  { body: 'Too far too fast', created_at: '2026-10-08T14:00:00Z', entities: { sentiment: { basic: 'Bearish' } } },
  { body: 'Watching', created_at: '2026-10-08T15:00:00Z', entities: { sentiment: null } },
  { body: 'Bought more', created_at: '2026-10-07T15:00:00Z', entities: { sentiment: { basic: 'Bullish' } } },
] };
const OPTS = { lookBackDays: 7, stocktwitsLimit: 30, subreddits: ['wallstreetbets', 'stocks', 'investing'], cryptoSubreddits: ['CryptoCurrency', 'CryptoMarkets'] };

test('the Reddit feed is read as plain posts', () => {
  const posts = parseAtom(ATOM);
  assert.equal(posts.length, 2);
  assert.deepEqual({ ...posts[0], text: posts[0]!.text }, { time: '2026-10-09 15:00', title: 'NVDA earnings thread', text: 'Long & strong on NVDA', where: 'stocks' });
});

test('posts: StockTwits tags counted, Reddit held to the window, crypto read in crypto communities', async () => {
  const seen: string[] = [];
  configure({ fetch: route([[/stocktwits/, () => json(TWITS)], [/reddit/, () => new Response(ATOM)]], seen) });
  const t = await socialPosts('NVDA', '2026-10-10', OPTS);
  assert.match(t, /4 messages: 2 Bullish, 1 Bearish, 1 untagged \(67\/33 among the tagged\)/);
  assert.match(t, /1 posts\.\n- 2026-10-09 15:00 UTC · r\/stocks: NVDA earnings thread/);
  assert.doesNotMatch(t, /Old post/);
  assert.ok(seen.some((u) => u.includes('/r/wallstreetbets+stocks+investing/search.rss?q=NVDA')));
  assert.deepEqual(subredditsFor('BTCUSD', OPTS.subreddits, OPTS.cryptoSubreddits), ['Bitcoin', 'CryptoCurrency', 'CryptoMarkets']);
  await socialPosts('BTC-USD', '2026-10-10', OPTS);
  assert.ok(seen.some((u) => u.includes('/streams/symbol/BTC.X.json')));
});

test('a source that fails is named unavailable while the other still answers', async () => {
  configure({ fetch: route([[/stocktwits/, () => new Response('blocked', { status: 403 })], [/reddit/, () => new Response(ATOM)]]) });
  const t = await socialPosts('NVDA', '2026-10-10', OPTS);
  assert.match(t, /StockTwits unavailable: api\.stocktwits\.com refused \(HTTP 403\)\. This is not a quiet crowd\./);
  assert.match(t, /NVDA earnings thread/);
});

const CPI = 'observation_date,CPIAUCSL\n2026-06-01,320.1\n2026-07-01,320.9\n2026-08-01,321.5\n2026-09-01,.\n';
test('FRED: missing values left out, monthly series lag their release, a past day never sees later releases', async () => {
  assert.deepEqual(parseCsv(CPI).map((o) => o.date), ['2026-06-01', '2026-07-01', '2026-08-01']);
  assert.equal(releaseLag(parseCsv(CPI)), 45);
  assert.equal(releaseLag(parseCsv('DATE,DGS10\n2026-10-06,4.1\n2026-10-07,4.12\n2026-10-08,4.15\n')), 1);
  configure({ fetch: route([[/fredgraph\.csv\?id=CPIAUCSL/, () => new Response(CPI)]]) });
  const past = await economicSeries('cpi', '2026-09-10', 365);   // August's figure (dated 08-01) not yet published
  assert.match(past, /Latest value known by 2026-09-10: 320.90 \(for 2026-07-01\)/);
  assert.match(past, /45-day release lag/);
  const now = await economicSeries('CPI', '2026-10-12', 365);
  assert.match(now, /Latest value known by 2026-10-12: 321.50 \(for 2026-08-01\)/);
  await assert.rejects(economicSeries('drop table', '2026-10-12'), /not a series name/);
});

const POLY = { events: [{ markets: [
  { question: 'Fed cuts in December?', outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', volumeNum: 2500000, endDate: '2026-12-17T00:00:00Z', closed: false, active: true, oneWeekPriceChange: 0.04 },
  { question: 'Fed cut in September?', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', volumeNum: 9000000, endDate: '2026-09-17T00:00:00Z', closed: true, active: false },
] }] };
test('odds: open markets only, by volume; withheld for a past day', async () => {
  configure({ fetch: route([[/polymarket/, () => json(POLY)]]) });
  const t = await predictionMarkets('Fed rate cut', '2026-10-12', 6, new Date('2026-10-12T12:00:00Z'));
  assert.match(t, /Fed cuts in December\?: Yes 62% · volume \$2,500,000 · resolves 2026-12-17 · \+4\.0 points this week/);
  assert.doesNotMatch(t, /September/);
  assert.match(await predictionMarkets('Fed rate cut', '2026-10-01'), /withheld for 2026-10-01/);
});

test('the server offers the news, posts, economic and odds tools', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), route([[/fredgraph/, () => new Response(CPI)]])).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['get_company_news', 'get_world_news', 'get_social_posts', 'get_economic_series', 'get_prediction_markets']) assert.ok(names.includes(n), n);
  const r = await client.callTool({ name: 'get_economic_series', arguments: { indicator: 'cpi', analysis_date: '2026-10-12' } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /Consumer price index/);
  await client.close();
});
