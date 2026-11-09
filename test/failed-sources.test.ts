// A source that fails is said as unavailable, with why: never as "none", "quiet", "no markets" or a zero. Each test
// replays a broken answer shaped like the failure drills of the 7 Nov 2026 audit (an unreadable Form 4, an SEC outage, a
// broken posts or odds answer, a price with no time), with made-up companies and figures.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configure, NoData, Unavailable } from '../src/data/http.js';
import { clearSecCache } from '../src/data/sec.js';
import { clearYahooSession, companyOverview, fundProfile, insiderTransactions } from '../src/data/company.js';
import { secInsiders } from '../src/data/insiders.js';
import { renderReport } from '../src/data/nport.js';
import { socialPosts } from '../src/data/social.js';
import { predictionMarkets } from '../src/data/odds.js';
import { companyNews } from '../src/data/news.js';
import { economicSeries } from '../src/data/macro.js';
import { ratesOf, weatherNow, type PolyEvent } from '../src/desk/weather.js';
import { clearQuotes, parseQuote, quote } from '../src/terminal/quotes.js';
import { clearCache } from '../src/data/yahoo.js';
import { deskServer } from '../src/tools/server.js';

const json = (v: unknown, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status });
/** No answer in time: the request fails at once (a network error would be tried again after a wait). */
const noAnswer = (): Response => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
function route(routes: Array<[RegExp, (url: string) => Response]>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input); seen.push(url);
    for (const [re, r] of routes) if (re.test(url)) return r(url);
    return new Response('no route', { status: 404 });
  };
}

beforeEach(() => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-06';
  clearSecCache(); clearYahooSession(); clearCache(); clearQuotes();
  configure({ secEmail: '' });
});

// ---------- insider trades: a filing that cannot be read is never read as "none" ----------
const FORM4 = (owner: string, rows: string) => `<?xml version="1.0"?>
<ownershipDocument><schemaVersion>X0609</schemaVersion><documentType>4</documentType><periodOfReport>2026-10-01</periodOfReport>
  <issuer><issuerCik>0000001234</issuerCik><issuerName>ACME CORP</issuerName><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerCik>000000${owner.length}999</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>
  <aff10b5One>0</aff10b5One><nonDerivativeTable>${rows}</nonDerivativeTable></ownershipDocument>`;
const ROW = (date: string, code: string, shares: number, price: number | null, ad: 'A' | 'D') => `
    <nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle><transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare>${price === null ? '<footnoteId id="F2"/>' : `<value>${price}</value>`}</transactionPricePerShare><transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>1000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>`;
// Four Form 4s in the 90 days to 6 Nov 2026, newest first; the oldest is a sale whose price is given only in a footnote.
const FILINGS = [['2026-11-04', 'a'], ['2026-10-20', 'b'], ['2026-10-01', 'c'], ['2026-09-15', 'd']] as const;
const DOCS: Record<string, string> = {
  a: FORM4('ONE', ROW('2026-11-03', 'S', 1000, 200, 'D')), b: FORM4('TWO', ROW('2026-10-17', 'S', 500, 210, 'D')),
  c: FORM4('THREE', ROW('2026-09-30', 'P', 100, 190, 'A')), d: FORM4('FOUR', ROW('2026-09-12', 'S', 300, null, 'D')),
};
const SUBMISSIONS = { name: 'ACME CORP', sic: '3674', filings: { recent: {
  accessionNumber: FILINGS.map((_, i) => `0000009999-26-00000${4 - i}`), filingDate: FILINGS.map(([d]) => d), reportDate: FILINGS.map(([d]) => d),
  form: FILINGS.map(() => '4'), primaryDocument: FILINGS.map(([, n]) => `xslF345X06/${n}.xml`),
} } };
const TICKERS: [RegExp, (url: string) => Response] = [/company_tickers\.json/, () => json({ 0: { cik_str: 1234, ticker: 'ACME' }, 1: { cik_str: 884394, ticker: 'SPY' } })];
/** The SEC with ACME's four Form 4s; `broken` answers in place of a document it names (null: the document itself). */
const sec = (broken: (doc: string) => Response | null = () => null, seen: string[] = []) => route([TICKERS,
  [/submissions\/CIK0000001234\.json/, () => json(SUBMISSIONS)],
  [/Archives\/edgar\/data\/1234\/\d+\/(\w)\.xml$/, (u) => { const doc = /(\w)\.xml$/.exec(u)![1]!; return broken(doc) ?? new Response(DOCS[doc]!); }],
], seen);
const refused = () => new Response('Forbidden', { status: 403 });

test('insider trades: every filing read gives the 90 days; a sale whose filing gives no price is counted, never priced at 0', async () => {
  configure({ fetch: sec() });
  const t = await insiderTransactions('ACME', '2026-11-06');
  assert.match(t, /\(4 of 4 filings read, newest first\)/);
  assert.match(t, /^In these 90 days: bought \(code P\) 1 \(100 shares, about 19,000 USD at their own prices\); sold \(code S\) 3 \(1,800 shares, about 305,000 USD at their own prices; one gives no price and is not in that sum\); other kinds .* 0\.$/m);
  assert.doesNotMatch(t, /about 0 USD/);
  // Only sales with no price: no sum in dollars at all.
  configure({ fetch: sec((doc) => (doc === 'd' ? null : new Response(FORM4('X', ROW('2026-10-01', 'A', 10, 0, 'A'))))) });
  clearSecCache();
  assert.match(await insiderTransactions('ACME', '2026-11-06'), /sold \(code S\) 1 \(300 shares, its filing gives no price, so no sum in USD\)/);
});

test('insider trades: with every Form 4 unreadable the answer is unavailable, never "bought none; sold none"', async () => {
  configure({ fetch: sec(refused) });
  await assert.rejects(insiderTransactions('ACME', '2026-11-06'), (e: Error) => e instanceof Unavailable
    && /^the SEC lists 4 Form 4 filings of ACME's insiders made public from 2026-08-09 to 2026-11-06, but none of them could be read \(www\.sec\.gov refused \(HTTP 403\), saying "Forbidden".*\), so their trades are not known$/.test(e.message));
  // What the fundamentals analyst reads from the desk's tool.
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(process.cwd(), sec(refused)).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  clearSecCache();
  const r = await client.callTool({ name: 'get_insider_transactions', arguments: { symbol: 'ACME', analysis_date: '2026-11-06' } }) as { content: Array<{ text: string }> };
  assert.match(r.content[0]!.text, /^DATA_UNAVAILABLE: insider transactions of ACME: the SEC lists 4 Form 4 filings/);
  assert.doesNotMatch(r.content[0]!.text, /none\b.*none|list no trades/);
  await client.close();
});

test('insider trades: with some Form 4s unreadable the counts say they cover only what was read, and the head never says all were read', async () => {
  configure({ fetch: sec((doc) => (doc === 'b' || doc === 'd' ? refused() : null)) });
  const t = await insiderTransactions('ACME', '2026-11-06');
  assert.match(t, /\(2 of 4 filings read, newest first; 2 could not be read\)/);
  assert.match(t, /^Counted from only the 2 of the 4 filings made public from 2026-08-09 to 2026-11-06 that were read \(2 of the filings could not be read \(www\.sec\.gov refused \(HTTP 403\).*\)\)\. These counts are not the whole 90 days: a "none" below is not a fact about the insiders: bought \(code P\) 1 \(100 shares, about 19,000 USD at their own prices\); sold \(code S\) 1 \(1,000 shares, about 200,000 USD at their own prices\)/m);
  assert.doesNotMatch(t, /^In these 90 days/m);
  // A web page in place of a filing (a notice, a refusal) is a filing not read, not one with no trades.
  configure({ fetch: sec((doc) => (doc === 'c' ? new Response('<html><body>Request Rate Threshold Exceeded</body></html>') : null)) });
  clearSecCache();
  const page = await insiderTransactions('ACME', '2026-11-06');
  assert.match(page, /\(3 of 4 filings read, newest first; 1 could not be read\)/);
  assert.match(page, /1 of the filings could not be read \(www\.sec\.gov answered with something that is not a Form 4\)/);
  assert.match(page, /bought \(code P\) none/, 'the purchase was in the page that could not be read');
  assert.match(page, /a "none" below is not a fact about the insiders/);
});

test('insider trades: only the newest filings are asked for, and the counts say so rather than claim the 90 days', async () => {
  configure({ fetch: sec() });
  const t = await secInsiders('ACME', '0000001234', '2026-11-06', 90, 2);
  assert.match(t, /\(2 of 4 filings read, newest first; the 2 oldest not asked for\)/);
  assert.match(t, /^Counted from only the 2 of the 4 filings .* that were read \(only the newest 2 were asked for, made public from 2026-10-20, so the 2 older ones are not in them\)\./m);
  // Every filing that could be read lists none, and some could not be read: that is said, not "these filings list none".
  configure({ fetch: sec((doc) => (doc === 'a' ? new Response(FORM4('X', '')) : refused())) });
  clearSecCache();
  assert.match(await insiderTransactions('ACME', '2026-11-06'), /\(the one filing read lists no trades in shares, only options or holdings; the others were not read, so nothing is known of their trades\)/);
});

// ---------- an SEC outage is said as an SEC outage ----------
/** Yahoo's company data as a session gets it, here an empty list of insider trades. */
const YAHOO: Array<[RegExp, (url: string) => Response]> = [
  [/fc\.yahoo\.com/, () => new Response('', { status: 404, headers: { 'set-cookie': 'A3=d=test; Path=/' } })],
  [/getcrumb/, () => new Response('crumb123')],
  [/quoteSummary/, () => json({ quoteSummary: { result: [{ insiderTransactions: { transactions: [] } }], error: null } })],
];
const OUTAGE = /^the SEC's list of US filers could not be read \(www\.sec\.gov did not answer \(no answer in time\)\), so whether ACME files with the SEC is not known$/;

test("the SEC's list of filers unreachable: unavailable, naming the SEC, never Yahoo's empty list or a withheld notice", async () => {
  const seen: string[] = [];
  configure({ fetch: route([[/company_tickers\.json/, noAnswer], ...YAHOO], seen) });
  const isOutage = (e: Error) => e instanceof Unavailable && OUTAGE.test(e.message);
  await assert.rejects(insiderTransactions('ACME', '2026-11-06'), isOutage, 'not "No insider transactions reported for ACME by Yahoo Finance"');
  await assert.rejects(companyOverview('ACME', '2026-11-06'), isOutage);
  await assert.rejects(insiderTransactions('ACME', '2026-11-03'), isOutage, 'a past day is not "withheld", as if ACME did not file with the SEC');
  await assert.rejects(companyOverview('ACME', '2026-11-03'), isOutage);
  assert.ok(!seen.some((u) => /yahoo\.com/.test(u)), 'Yahoo is asked only about a company the SEC was read and does not list');
  // The SEC refusing a reader with no contact email asks the person for theirs.
  configure({ fetch: route([[/company_tickers\.json/, refused]]) });
  clearSecCache();
  await assert.rejects(companyOverview('ACME', '2026-11-06'), (e: Error) => /could not be read \(www\.sec\.gov refused \(HTTP 403\).*\[no contact email was sent\]: .*email/.test(e.message));
});

const FUNDS: [RegExp, (url: string) => Response] = [/company_tickers_mf\.json/, () => json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[36405, 'S000002839', 'C000092055', 'VOO']] })];
const FEED = (entries: string) => `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>VANGUARD INDEX FUNDS</title>${entries}</feed>`;

test('fund holdings: an SEC list that is broken or empty is unavailable, never "not a fund", and Yahoo is not asked', async () => {
  const seen: string[] = [];
  // VOO is in the SEC's list of funds; its list of reports answers with a web page, then comes back empty.
  configure({ fetch: route([FUNDS, TICKERS, [/browse-edgar/, () => new Response('<html><body>Service temporarily unavailable</body></html>')], ...YAHOO], seen) });
  await assert.rejects(fundProfile('VOO', '2026-11-06'), (e: Error) => e instanceof Unavailable && e.message === "the SEC answered with something that is not its list of VOO's portfolio reports");
  configure({ fetch: route([FUNDS, TICKERS, [/browse-edgar/, () => new Response(FEED(''))], ...YAHOO], seen) });
  clearSecCache();
  await assert.rejects(fundProfile('VOO', '2026-11-06'), (e: Error) => e instanceof Unavailable && /lists VOO as a fund, but its list of the fund's portfolio reports \(form N-PORT\) came back empty/.test(e.message));
  // SPY reports under its own number: its list of filings coming back empty is not "a company or a trust".
  configure({ fetch: route([FUNDS, TICKERS, [/submissions\/CIK0000884394\.json/, () => json({ name: 'SPDR S&P 500 ETF TRUST', filings: { recent: {} } })], ...YAHOO], seen) });
  clearSecCache();
  await assert.rejects(fundProfile('SPY', '2026-11-06'), (e: Error) => e instanceof Unavailable && e.message === "the SEC's list of SPY's filings came back empty");
  // The SEC's list of funds unreachable.
  configure({ fetch: route([[/company_tickers_mf\.json/, noAnswer], TICKERS, ...YAHOO], seen) });
  clearSecCache();
  await assert.rejects(fundProfile('VOO', '2026-11-06'), (e: Error) => e instanceof Unavailable && /^the SEC's list of funds could not be read \(www\.sec\.gov did not answer/.test(e.message));
  assert.ok(!seen.some((u) => /yahoo\.com/.test(u)));
  // A company that files with the SEC, and no portfolio report among its filings, is said to be no fund that lists holdings.
  configure({ fetch: route([FUNDS, TICKERS, [/submissions\/CIK0000001234\.json/, () => json({ name: 'ACME CORP', filings: { recent: { form: ['10-K', '10-Q', '8-K'], accessionNumber: ['0000001234-26-000001', '0000001234-26-000002', '0000001234-26-000003'], filingDate: ['2026-03-01', '2026-08-01', '2026-10-01'] } } })]]) });
  clearSecCache();
  await assert.rejects(fundProfile('ACME', '2026-11-06'), (e: Error) => e instanceof NoData && /^ACME reports to the SEC as a company or a trust, not as a fund that lists its holdings \(form N-PORT\): none of the 3 filings in the SEC's list of its recent filings is one\./.test(e.message));
});

test("a fund's holdings with no country are named apart, never counted as outside the US", () => {
  const h = (name: string, pct: number, country: string) => ({ name, pct, asset: 'EC', issuer: 'CORP', country, maturity: null, coupon: null });
  const t = renderReport('VOO', '2026-11-06', { series: 'Test Fund', registrant: 'Test Trust', asOf: '2026-09-30', filed: '2026-11-01', netAssets: 1e6, returns: null,
    holdings: [h('Apple Inc', 50, 'US'), h('Toyota Motor', 10, 'JP'), h('Cash collateral', 25, 'N/A'), h('Index future', 15, '')] });
  assert.match(t, /^Countries: United States 50\.00%, not given 40\.00%, Japan 10\.00% \(outside the US together: 10\.00%; no country given for 40\.00%\)$/m);
  assert.match(renderReport('VOO', '2026-11-06', { series: 'T', registrant: 'T', asOf: '2026-09-30', filed: '2026-11-01', netAssets: 1e6, returns: null, holdings: [h('A', 70, 'US'), h('B', 30, 'JP')] }),
    /\(outside the US together: 30\.00%\)$/m);
});

// ---------- posts and odds: a broken answer is unavailable, never quiet ----------
const OPTS = { lookBackDays: 7, stocktwitsLimit: 30, subreddits: ['wallstreetbets', 'stocks', 'investing'], cryptoSubreddits: ['CryptoCurrency'] };
const TWITS = { symbol: { symbol: 'NVDA' }, messages: [{ body: 'Holding through earnings', created_at: '2026-11-06T15:00:00Z', entities: { sentiment: { basic: 'Bullish' } } }] };
const ATOM = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><category term="stocks" label="r/stocks"/><content type="html">chips</content><published>2026-11-06T14:00:00+00:00</published><title>NVDA after the selloff</title></entry></feed>';

test('StockTwits: an answer with no list of messages, or an empty one, is unavailable, never "no messages in this window"', async () => {
  configure({ fetch: route([[/stocktwits/, () => json({ response: { status: 200 }, errors: [{ message: 'temporarily unavailable' }] })], [/reddit/, () => new Response(ATOM)]]) });
  const broken = await socialPosts('NVDA', '2026-11-06', OPTS);
  assert.match(broken, /StockTwits unavailable: api\.stocktwits\.com answered without its list of messages, saying "temporarily unavailable"\. This is not a quiet crowd\./);
  assert.doesNotMatch(broken, /No StockTwits messages/);
  assert.match(broken, /NVDA after the selloff/, 'Reddit still answers');
  configure({ fetch: route([[/stocktwits/, () => json({ symbol: { symbol: 'NVDA' }, messages: [] })], [/reddit/, () => new Response(ATOM)]]) });
  const empty = await socialPosts('NVDA', '2026-11-06', OPTS);
  assert.match(empty, /StockTwits unavailable: the stream for NVDA came back with no messages at all, though it serves its latest messages however old they are: an empty stream is a fault, or a symbol no one has posted about\. This is not a quiet crowd\./);
  assert.doesNotMatch(empty, /No StockTwits messages/);
});

test('Reddit: a web page in place of its feed is unavailable; its feed with no posts is an answer', async () => {
  configure({ fetch: route([[/stocktwits/, () => json(TWITS)], [/reddit/, () => new Response('<!doctype html><html><head><title>Reddit - Dive into anything</title></head><body>Please wait for verification.</body></html>')]]) });
  const page = await socialPosts('NVDA', '2026-11-06', OPTS);
  assert.match(page, /Reddit unavailable: www\.reddit\.com answered with something that is not its feed of posts \(a page titled "Reddit - Dive into anything"\)\. This is not a quiet crowd\./);
  assert.doesNotMatch(page, /No Reddit posts/);
  configure({ fetch: route([[/stocktwits/, () => json(TWITS)], [/reddit/, () => new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>search results</title></feed>')]]) });
  assert.match(await socialPosts('NVDA', '2026-11-06', OPTS), /No Reddit posts about NVDA in these communities in this window that the feed still serves\./);
});

const NOW = new Date('2026-11-06T17:00:00Z');
const market = (question: string, price: string, volume: number | undefined) => ({ question, outcomes: '["Yes","No"]', outcomePrices: `["${price}","${price === '' ? '' : (1 - Number(price)).toFixed(2)}"]`, ...(volume === undefined ? {} : { volumeNum: volume }), endDate: '2026-11-30T12:00:00Z', active: true, closed: false });

test("Polymarket: an answer without its search results is unavailable; with nothing matched it says so", async () => {
  configure({ fetch: route([[/polymarket/, () => json({ error: 'internal error' })]]) });
  await assert.rejects(predictionMarkets('NVIDIA', '2026-11-06', 6, NOW), (e: Error) => e instanceof Unavailable && e.message === 'gamma-api.polymarket.com answered without its search results, saying "internal error"');
  // Its real answer when nothing matches: the page count alone, no list of events (seen 8 Nov 2026).
  configure({ fetch: route([[/polymarket/, () => json({ pagination: { hasMore: false, totalResults: 0 } })]]) });
  assert.match(await predictionMarkets('NVIDIA', '2026-11-06', 6, NOW), /No open markets matched "NVIDIA"\./);
});

test('Polymarket: a market with no traded volume, or no price, is left out and counted, never "volume $0" or "0%"', async () => {
  configure({ fetch: route([[/polymarket/, () => json({ events: [{ markets: [
    market('Will NVIDIA close above $250 end of November?', '0.41', undefined), market('Will NVIDIA close above $240 end of November?', '0.08', 0),
    market('Will NVIDIA close above $180 end of November?', '0.55', 120_000),
  ] }] })]]) });
  const t = await predictionMarkets('NVIDIA', '2026-11-06', 6, NOW);
  assert.match(t, /^- Will NVIDIA close above \$180 end of November\?: Yes 55% · volume \$120,000 · trading closes 2026-11-30$/m);
  assert.match(t, /\nLeft out of the 3 open markets that matched: 2 with no traded volume \(Polymarket gives none, or \$0\), so their prices are not yet a crowd's\.$/);
  assert.doesNotMatch(t, /volume \$0|\$250|\$240/);
  configure({ fetch: route([[/polymarket/, () => json({ events: [{ markets: [market('Fed cuts in December?', '', 12_000)] }] })]]) });
  const blank = await predictionMarkets('Fed', '2026-11-06', 6, NOW);
  assert.match(blank, /No open market that matched "Fed" has a traded price to show\.\nLeft out of the 1 open market that matched: 1 with no price given\.$/);
  assert.doesNotMatch(blank, /Yes 0%/);
  // A traded market with a tiny price or a tiny volume is shown as such, never rounded to "0%", "100%" or "$0".
  configure({ fetch: route([[/polymarket/, () => json({ events: [{ markets: [market('Will NVIDIA close above $400 end of November?', '0.003', 0.4), market('Will NVIDIA close above $100 end of November?', '0.998', 5_000)] }] })]]) });
  const tiny = await predictionMarkets('NVIDIA', '2026-11-06', 6, NOW);
  assert.match(tiny, /^- Will NVIDIA close above \$100 end of November\?: Yes over 99% · volume \$5,000 · /m);
  assert.match(tiny, /^- Will NVIDIA close above \$400 end of November\?: Yes under 1% · volume under \$1 · /m);
  assert.doesNotMatch(tiny, /Yes 0%|Yes 100%|volume \$0/);
});

test('the market weather: a broken Polymarket answer and a blank price are unavailable, never "no open market" or 0%', async () => {
  const fed = (prices: Record<string, string>): PolyEvent => ({ title: 'Fed decision in December?', endDate: '2026-12-10T00:00:00Z', closed: false,
    markets: Object.entries(prices).map(([groupItemTitle, p]) => ({ groupItemTitle, outcomePrices: `["${p}",""]`, closed: false, active: true })) });
  const r = ratesOf([fed({ 'No change': '', '25 bps decrease': '0.70' })], NOW);
  assert.match(r.words, /puts a cut of 0\.25 percentage points at 70%\.$/);
  assert.doesNotMatch(r.words, /no change at 0%/);
  assert.equal(ratesOf([fed({ 'No change': '', '25 bps decrease': '' })], NOW).state, null, 'blank prices are no odds');
  configure({ fetch: route([[/polymarket/, () => json({ error: 'internal error' })], [/finance\/chart/, noAnswer]]) });
  const w = await weatherNow('2026-11-06', NOW);
  assert.equal(w.lines.find((l) => l.key === 'rates')!.words, 'Unavailable: Polymarket answered without its search results.');
});

// ---------- news: why it has none is said only where it applies ----------
test('company news: an empty answer for a US stock gives no reason about listings outside the US; an answer without articles is broken', async () => {
  configure({ fetch: route([[/finance\/search/, () => json({ explains: [], count: 0, quotes: [], news: [] })]]) });
  await assert.rejects(companyNews('NVDA', '2026-11-06', 7, 20), (e: Error) => e instanceof Unavailable && e.message === "Yahoo Finance's search returned no articles for NVDA");
  await assert.rejects(companyNews('7203.T', '2026-11-06', 7, 20), (e: Error) => /returned no articles for 7203\.T \(it carries few articles on listings outside the US\)$/.test(e.message));
  configure({ fetch: route([[/finance\/search/, () => json({ finance: { result: null, error: { code: 'Bad Request' } } })]]) });
  await assert.rejects(companyNews('NVDA', '2026-11-06', 7, 20), (e: Error) => e instanceof Unavailable && /answered its news search without a list of articles/.test(e.message));
});

// ---------- small wording ----------
test('a dashboard price that comes with no time is no data, never stamped with the moment it was read', async () => {
  const noTime = { chart: { result: [{ meta: { symbol: '^GSPC', currency: 'USD', regularMarketPrice: 6850.12, chartPreviousClose: 6801.5, currentTradingPeriod: { regular: { start: 1, end: 2 } } }, timestamp: [], indicators: { quote: [{ close: [] }] } }], error: null } };
  assert.throws(() => parseQuote(noTime, '^GSPC'), (e: Error) => e instanceof NoData && /gave a price for \^GSPC with no time, so when it is from is not known/.test(e.message));
  configure({ fetch: route([[/finance\/chart/, () => json(noTime)]]) });
  assert.deepEqual(await quote('^GSPC'), { symbol: '^GSPC', error: 'no-data', message: 'Yahoo Finance gave a price for ^GSPC with no time, so when it is from is not known' });
});

test('FRED: a series asked by its id changes in its own units only (no percent of a percent), and nothing changes by a percent from zero', async () => {
  const days = (from: string, to: string) => { const out: string[] = []; for (let d = Date.parse(from); d <= Date.parse(to); d += 86_400_000) if (new Date(d).getUTCDay() % 6) out.push(new Date(d).toISOString().slice(0, 10)); return out; };
  const csv = (id: string, value: (d: string) => number) => `observation_date,${id}\n${days('2025-10-01', '2026-11-06').map((d) => `${d},${value(d).toFixed(2)}`).join('\n')}\n`;
  configure({ fetch: route([[/id=DGS5&/, () => new Response(csv('DGS5', (d) => (d <= '2025-11-06' ? 3.6 : 3.9)))]]) });
  const t = await economicSeries('DGS5', '2026-11-06', 365);
  assert.match(t, /^- Year over year, from 3\.60 for 2025-11-06: \+0\.30 in the series' own units \(no percentage change: the desk does not know this series' units\)$/m);
  assert.doesNotMatch(t, /\+8\.3%/);
  configure({ fetch: route([[/id=VIXCLS&/, () => new Response(csv('VIXCLS', (d) => (d <= '2025-11-06' ? 0 : 18)))]]) });
  assert.match(await economicSeries('vix', '2026-11-06', 365), /^- Year over year, from 0\.00 for 2025-11-06: \+18\.00 \(no percentage change from zero\)$/m);
});

test('the sentiment analyst says "Unavailable" with no score when no source answered, and Neutral only for sources read and quiet', () => {
  const body = fs.readFileSync('.claude/agents/sentiment-analyst.md', 'utf8');
  assert.match(body, /exactly one of Bullish \/ Mildly Bullish \/ Neutral \/ Mixed \/ Mildly Bearish \/ Bearish \/ Unavailable/);
  assert.match(body, /\*\*Overall Sentiment:\*\* \*\*Unavailable\*\* \(Score: none\)/);
  assert.match(body, /Neutral only when the sources answered/);
  assert.match(body, /An unavailable source is not a quiet one/);
  assert.doesNotMatch(body, /Neutral only when all sources are genuinely silent/);
});
