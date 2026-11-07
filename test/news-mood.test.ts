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
import { readSettings } from '../src/settings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  assert.match(t, /^News about NVDA from 2026-10-09 13:00 UTC only \(1 article tagged NVDA; headlines only\)\. The window asked for is 2026-10-03 to 2026-10-10 \(New York days\)/);
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

/** `n` articles tagged NVDA, one every `minutes`, the newest at `newest`. */
const run = (n: number, newest: string, minutes: number) => ({ news: Array.from({ length: n }, (_, i) => (
  { title: `Story ${i}`, publisher: 'Reuters', link: `https://x/s${i}`, providerPublishTime: at(newest) - i * minutes * 60, relatedTickers: ['NVDA'] })) });

test('news says the hours its articles really cover when the search does not reach back over the window', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  // Round 1 (6 Nov 2026): 39 articles over the last three hours of the day, the newest 20 shown.
  configure({ fetch: route([[/finance\/search/, () => json(run(39, '2026-11-06T23:41:00Z', 5))]]) });
  const t = await companyNews('NVDA', '2026-11-06', 7, 20);
  assert.match(t, /^News about NVDA from 2026-11-06 22:06 to 23:41 UTC only \(the newest 20 of 39 articles tagged NVDA; headlines only\)\. The window asked for is 2026-10-30 to 2026-11-06 \(New York days\), but Yahoo Finance's search returns only its latest articles, and the oldest it returned is from 2026-11-06 20:31 UTC: what came before was not reached, so this says nothing about the news earlier in the window\./);
  assert.doesNotMatch(t, /^News about NVDA, 2026-10-30 to 2026-11-06/, 'never the window as if it were covered');
  // A sample that reaches back before the window covers it: the window, then the span of what is shown.
  configure({ fetch: route([[/finance\/search/, () => json(run(10, '2026-11-06T20:00:00Z', 24 * 60))]]) });
  assert.match(await companyNews('NVDA', '2026-11-06', 7, 20), /^News about NVDA, 2026-10-30 to 2026-11-06 \(New York days; 8 articles tagged NVDA, from 2026-10-30 20:00 to 2026-11-06 20:00 UTC; headlines only\)\n/);
});

test("the window is New York's days: an evening article belongs to its New York day, though its UTC date is the next", async () => {
  configure({ fetch: route([[/finance\/search/, () => json({ news: [
    { title: 'Late on the 10th in New York', publisher: 'AP', link: 'https://x/e1', providerPublishTime: at('2026-10-11T01:30:00Z'), relatedTickers: ['NVDA'] },
    { title: 'Early on the 11th in New York', publisher: 'AP', link: 'https://x/e2', providerPublishTime: at('2026-10-11T05:00:00Z'), relatedTickers: ['NVDA'] },
    { title: 'A week before', publisher: 'AP', link: 'https://x/e3', providerPublishTime: at('2026-10-01T12:00:00Z'), relatedTickers: ['NVDA'] },
  ] })]]) });
  const t = await companyNews('NVDA', '2026-10-10', 7, 20);
  assert.match(t, /^News about NVDA, 2026-10-03 to 2026-10-10 \(New York days; 1 article tagged NVDA, from 2026-10-11 01:30 UTC;/);
  assert.match(t, /Late on the 10th/);
  assert.doesNotMatch(t, /Early on the 11th/);
});

test('world news names each search that did not reach back over the window', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  configure({ fetch: route([[/q=%5EGSPC/, () => json(run(10, '2026-11-06T23:00:00Z', 10))], [/finance\/search/, () => json({ news: [
    { title: 'Euro slips', publisher: 'Reuters', link: 'https://x/fx', providerPublishTime: at('2026-10-20T12:00:00Z'), relatedTickers: ['EURUSD=X'] },
    { title: 'Euro steady', publisher: 'Reuters', link: 'https://x/fx2', providerPublishTime: at('2026-11-03T12:00:00Z'), relatedTickers: ['EURUSD=X'] },
  ] })]]) });
  const t = await worldNews('2026-11-06', 7, 10, ['^GSPC', 'EURUSD=X']);
  assert.match(t, /^World and economic news from 2026-11-06 21:30 to 23:00 UTC \(the newest 10 of 11 articles\), from the news filed under \^GSPC, EURUSD=X\. The window asked for is 2026-10-30 to 2026-11-06 \(New York days\), but each search returns only its latest articles, and these did not reach back over it: under \^GSPC only back to 2026-11-06 21:30 UTC\. What came before/);
  assert.doesNotMatch(t, /under EURUSD=X only/, 'a search that reached before the window is not named');
});

test('world news merges the standing searches without repeats', async () => {
  const seen: string[] = [];
  configure({ fetch: route([[/finance\/search/, () => json(NEWS)]], seen) });
  const t = await worldNews('2026-10-10', 7, 10, ['Federal Reserve', 'oil supply']);
  assert.equal(seen.length, 2);
  assert.equal(t.match(/Fed holds rates steady/g)?.length, 1);
});

test('world news reads the news Yahoo files under market symbols, since its search finds none under topic words', async () => {
  // As Yahoo answered on 2026-10-22: "Federal Reserve interest rates inflation" no news; ^GSPC and CL=F the day's market stories.
  const MARKET = { news: [
    { title: 'Stock market today: Dow, S&P 500, Nasdaq tumble as oil jumps', publisher: 'Yahoo Finance', link: 'https://x/m1', providerPublishTime: at('2026-10-09T15:00:00Z'), relatedTickers: ['^GSPC', 'CL=F'] },
    { title: 'Nasdaq leads Wall Street lower on AI spending jitters', publisher: 'Reuters', link: 'https://x/m2', providerPublishTime: at('2026-10-09T20:00:00Z'), relatedTickers: ['^GSPC'] },
  ] };
  configure({ fetch: route([[/finance\/search\?q=(%5E|[A-Z]+%3D)/, () => json(MARKET)], [/finance\/search/, () => json({ news: [] })]]) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-w-'));
  const { worldNewsSearches } = readSettings(root).analysis;
  const t = await worldNews('2026-10-10', 7, 10, worldNewsSearches);
  assert.match(t, /from the news filed under \^GSPC, \^TNX, CL=F, GC=F, EURUSD=X/);
  assert.equal(t.match(/Nasdaq leads Wall Street lower/g)?.length, 1);
  // A settings file still holding the old topic words gets the symbols; a person's own list is kept.
  const old = ['Federal Reserve interest rates inflation', 'S&P 500 earnings GDP economic outlook', 'geopolitical risk trade war sanctions', 'ECB Bank of England BOJ central bank policy', 'oil commodities supply chain energy'];
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify({ analysis: { worldNewsSearches: old } }));
  assert.deepEqual(readSettings(root).analysis.worldNewsSearches, worldNewsSearches);
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify({ analysis: { worldNewsSearches: [' ^VIX ', 7, ''] } }));
  assert.deepEqual(readSettings(root).analysis.worldNewsSearches, ['^VIX']);
  assert.deepEqual(readSettings('.').analysis.worldNewsSearches, worldNewsSearches);   // the shipped settings file
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
  assert.match(t, /4 messages, from 2026-10-07 15:00 to 2026-10-09 14:00 UTC: 2 Bullish, 1 Bearish, 1 untagged \(67\/33 among the tagged\)\.\n/, 'four messages are all the stream had: nothing more to reach');
  assert.match(t, /1 post, from 2026-10-09 15:00 UTC\.\n- 2026-10-09 15:00 UTC · r\/stocks: NVDA earnings thread/);
  assert.doesNotMatch(t, /Old post/);
  assert.ok(seen.some((u) => u.includes('/r/wallstreetbets+stocks+investing/search.rss?q=NVDA')));
  assert.deepEqual(subredditsFor('BTCUSD', OPTS.subreddits, OPTS.cryptoSubreddits), ['Bitcoin', 'CryptoCurrency', 'CryptoMarkets']);
  await socialPosts('BTC-USD', '2026-10-10', OPTS);
  assert.ok(seen.some((u) => u.includes('/streams/symbol/BTC.X.json')));
});

test("StockTwits' latest 30 messages are said to cover only their hours, not the window", async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  // Round 1 (6 Nov 2026): the stream's 30 messages ran from 22:26 to 23:48 UTC.
  const page = { messages: Array.from({ length: 30 }, (_, i) => ({ body: `post ${i}`, created_at: new Date(Date.parse('2026-11-06T23:48:00Z') - i * 170_000).toISOString(), entities: { sentiment: i % 4 ? null : { basic: 'Bullish' } } })) };
  configure({ fetch: route([[/stocktwits/, () => json(page)], [/reddit/, () => new Response(ATOM)]]) });
  const t = await socialPosts('NVDA', '2026-11-06', OPTS);
  assert.match(t, /^Posts about NVDA, asked for 2026-10-30 to 2026-11-06 \(New York days; the times below are UTC\)/);
  assert.match(t, /30 messages, from 2026-11-06 22:25 to 23:48 UTC: 8 Bullish, 0 Bearish, 22 untagged \(100\/0 among the tagged\)\. The stream serves only its latest posts, and the oldest it returned is from 2026-11-06 22:25 UTC: the rest of the window asked for \(2026-10-30 to 2026-11-06, New York days\) was not reached, so these show the mood of those hours and say nothing about earlier in the window\./);
  // Late in a New York evening the stream's posts carry the next UTC date, and they are still that day's.
  const evening = { messages: [{ body: 'after the bell', created_at: '2026-11-07T03:20:00Z', entities: { sentiment: null } }] };
  configure({ fetch: route([[/stocktwits/, () => json(evening)], [/reddit/, () => new Response(ATOM)]]) });
  assert.match(await socialPosts('NVDA', '2026-11-06', OPTS), /1 message, from 2026-11-07 03:20 UTC: 0 Bullish, 0 Bearish, 1 untagged\.\n- 2026-11-07 03:20 UTC: after the bell/);
});

test('a source that fails is named unavailable while the other still answers', async () => {
  configure({ fetch: route([[/stocktwits/, () => new Response('blocked', { status: 403 })], [/reddit/, () => new Response(ATOM)]]) });
  const t = await socialPosts('NVDA', '2026-10-10', OPTS);
  assert.match(t, /StockTwits unavailable: api\.stocktwits\.com refused \(HTTP 403\), saying "blocked"\. This is not a quiet crowd\./);
  assert.match(t, /NVDA earnings thread/);
});

const CPI = 'observation_date,CPIAUCSL\n2026-06-01,320.1\n2026-07-01,320.9\n2026-08-01,321.5\n2026-09-01,.\n';
test('FRED: missing values left out, monthly series lag their release, a past day never sees later releases', async () => {
  assert.deepEqual(parseCsv(CPI).map((o) => o.date), ['2026-06-01', '2026-07-01', '2026-08-01']);
  assert.equal(releaseLag(parseCsv(CPI)), 45);
  assert.equal(releaseLag(parseCsv('DATE,DGS10\n2026-10-06,4.1\n2026-10-07,4.12\n2026-10-08,4.15\n')), 1);
  configure({ fetch: route([[/fredgraph\.csv\?id=CPIAUCSL/, () => new Response(CPI)]]) });
  const past = await economicSeries('cpi', '2026-09-10', 365);   // August's figure (dated 08-01) not yet published
  assert.match(past, /Latest value known by 2026-09-10: 320\.90 \(for July 2026\)/);
  assert.match(past, /45-day release lag/);
  const now = await economicSeries('CPI', '2026-10-12', 365);
  assert.match(now, /Latest value known by 2026-10-12: 321\.50 \(for August 2026\)/);
  assert.match(now, /- Year over year: not available \(no value for August 2025 in FRED's data\)\. Do not work one out from other rows\./);
  assert.match(now, /\nDate \(the first day of the period it stands for\) \| Value\n/);
  await assert.rejects(economicSeries('drop table', '2026-10-12'), /not a series name/);
});

test('FRED: the change over a year is from the same month a year earlier, never a shorter window read as yearly', async () => {
  // Fourteen months of an index, 300 in July 2025 rising 1 a month: August 2026 is 313, August 2025 was 301.
  const months = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2025, 6 + i, 1)).toISOString().slice(0, 10));
  configure({ fetch: route([[/fredgraph\.csv\?id=CPIAUCSL/, () => new Response(`observation_date,CPIAUCSL\n${months.map((d, i) => `${d},${300 + i}`).join('\n')}\n`)]]) });
  const t = await economicSeries('cpi', '2026-10-12', 365);
  assert.match(t, /- Latest value known by 2026-10-12: 313\.00 \(for August 2026\)/);
  assert.match(t, /- Year over year, from 301\.00 for August 2025: \+12\.00 \(\+4\.0%\)/);
  // The window starts in November 2025 (a year before the analysis date): its change is labelled as not yearly.
  assert.match(t, /- Change over the look-back window, from November 2025 to August 2026: \+9\.00 \(\+3\.0%\) \(not a yearly rate\)/);   // 304 -> 313
});

test('FRED: the federal funds rate is the daily one, a rate changes by percentage points, and an outage is not "no data"', async () => {
  const seen: string[] = [];
  const days = ['2025-10-08', '2025-10-09', '2026-09-16', '2026-09-17', '2026-10-08', '2026-10-09'], rates = [4.33, 4.33, 3.63, 3.88, 3.88, 3.88];
  configure({ fetch: route([[/fredgraph\.csv\?id=DFF/, () => new Response(`observation_date,DFF\n${days.map((d, i) => `${d},${rates[i]}`).join('\n')}\n`)]], seen) });
  const t = await economicSeries('fed_funds_rate', '2026-10-12', 365);
  assert.ok(seen.some((u) => u.includes('id=DFF&')));
  assert.match(t, /## Federal funds effective rate, daily \(percent\) - FRED series DFF/);
  assert.match(t, /- Latest value known by 2026-10-12: 3\.88 \(for 2026-10-09\)/);
  assert.match(t, /- Year over year, from 4\.33 for 2025-10-09: -0\.45 percentage points/);
  configure({ fetch: route([[/fredgraph/, () => new Response('<html><body>FRED is down for maintenance</body></html>')]]) });
  await assert.rejects(economicSeries('cpi', '2026-10-12'), (e: Error) => e.name === 'Unavailable' && /something other than its data download/.test(e.message));
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
