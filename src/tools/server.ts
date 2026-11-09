// The desk tool server: the one MCP server this folder gives the engine (.mcp.json, started by main.ts). It holds the
// desk check and the data tools the agents read facts from; it never holds an order tool. Every data tool works as of
// an analysis date and never serves anything dated after it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deskCheck, type Home } from '../check/desk-check.js';
import { readSettings } from '../settings.js';
import { readContactEmail, saveContactEmail } from '../contact.js';
import { configure, failureText } from '../data/http.js';
import { INDICATOR_NAMES } from '../data/indicators.js';
import { indicatorWindow, instrument, priceHistory, verifiedSnapshot } from '../data/market.js';
import { priceFacts } from '../data/facts.js';
import { workOut } from '../data/workout.js';
import { companyNews, worldNews } from '../data/news.js';
import { socialPosts } from '../data/social.js';
import { economicSeries, SERIES } from '../data/macro.js';
import { predictionMarkets } from '../data/odds.js';
import { companyOverview, financialStatement, fundProfile, insiderTransactions } from '../data/company.js';
import { registerDeskTools } from './desk.js';
import { VERSION } from '../version.js';
import { driftOf, lastReset, listed, noteReset, plainName, RESET_AGAIN_MS, resetAgainWords, resetAgentFiles, shippedAgentFiles } from '../desk/agent-files.js';
import { Freshness, UPDATED_NOTE } from '../desk/freshness.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

type Answer = { content: Array<{ type: string; text?: string }> };

/** Every tool's answer, once the desk in the folder was updated after this process started, opens with UPDATED_NOTE: the
 *  first answer an old conversation gets after the update says so, whichever member asked and whichever tool, and so does
 *  every one after it. Done here, once, for every tool registered on the server, those to come included. */
function noteWhenUpdated(server: McpServer, fresh: Freshness): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...args: unknown[]) => Promise<Answer>) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => register(name, config, async (...args) => {
    const r = await cb(...args);
    if (!fresh.updated()) return r;
    const [first, ...rest] = r.content;
    return { ...r, content: first?.type === 'text' ? [{ ...first, text: `${UPDATED_NOTE}\n\n${first.text ?? ''}` }, ...rest] : [{ type: 'text', text: UPDATED_NOTE }, ...r.content] };
  });
}

/** Runs a data tool: its answer, or the plain failure an agent must report as unavailable. */
async function answer(what: string, run: () => Promise<string>) {
  try { return text(await run()); } catch (e) {
    const err = e as Error;
    if (/YYYY-MM-DD|in the future|not a ticker|not a series name/.test(err.message)) return text(`INPUT_ERROR: ${err.message}. Correct it and call again.`);
    return text(failureText(e, what));
  }
}

const symbol = z.string().min(1).max(20).describe('The ticker as the instrument context gives it, e.g. NVDA, 7203.T, BTC-USD');
const analysis = z.string().describe('The analysis date, YYYY-MM-DD. Nothing dated after it is ever returned.');
const READ = { readOnlyHint: true, openWorldHint: true } as const;

/** `root` is the folder the desk works in; `source` is where the project's own source is (the same folder, except in tests). */
export function deskServer(root: string = process.cwd(), fetchImpl?: typeof fetch, source: string = root, home?: Home): McpServer {
  const settings = readSettings(root), a0 = settings.analysis;
  configure({ contact: settings.sources.contact, secEmail: () => readContactEmail(root) });
  if (fetchImpl) configure({ fetch: fetchImpl });
  const server = new McpServer({ name: 'trading-desk', version: VERSION });
  const fresh = new Freshness(source);
  noteWhenUpdated(server, fresh);

  server.registerTool('desk_check', {
    title: 'Desk check',
    description: 'Check that this computer is ready for the Trading Agents desk: Node, the desk data folder, whether a Robinhood sign-in is saved, whether the desk\'s agent files in this folder are as the project ships them, whether this conversation began with the team\'s steps of the version in this folder (a change made to the team in Agent Studio keeps that version, so it cannot be told; only from the version those steps give: team_version is required; the trading-desk team passes the one in step 1 of its own "Check this computer" steps, anyone else "none", and then it says they were not compared), and whether each free data source answers (naming the one it does not ask). If its answer starts with TEAM VERSION NEEDED, do what that line says. Pass on its line about this conversation\'s steps and its line about the agent files as written, never one for the other. It sends no order and reads no secret; the contact email is shown masked. All it writes is a test file in desk-data, removed at once.',
    // Required (8 Nov 2026: in Madav the team twice left out the version its own step 1 names, so a conversation begun
    // before an update could not be told). Left out, nothing is checked and the caller is told what to pass.
    inputSchema: { team_version: z.string({ error: (issue) => (issue.input === undefined ? 'Nothing was checked: team_version is required. The trading-desk team: call desk_check again with the version in step 1 of your own "Check this computer" steps, copied exactly. Anyone else: call it again with "none". Never read a version from a file and never make one up. The value is missing' : undefined) }).max(40).describe('Required. The trading-desk team: the version in step 1 of its own "Check this computer" steps, copied exactly from the instructions this conversation began with. Anyone else (a chat that is not the trading-desk team): "none", and the check says this conversation\'s steps were not compared. Never read it from a file and never make one up') },
    annotations: READ,
  }, async (a) => text(await deskCheck(root, fetchImpl, source, { updated: fresh.updated(), teamVersion: a.team_version, viaTool: true }, home)));

  server.registerTool('reset_team', {
    title: 'Reset the team',
    description: 'Put the desk\'s thirteen agents, the trading-desk team\'s file and its line-up back exactly as the project ships them: each file is written again, even one that already matches, which also brings Madav back to the project\'s version of the team in place of changes made in its Agent Studio. Only when the person asked in words, in this conversation, for the team to be reset or put back, and confirmed it: never in place of any other request. Call it once: asked again soon after a reset, with the files still matching, it writes nothing. It writes only those files in this folder; the model, permissions and effort the person chose in Madav stay theirs.',
    inputSchema: { confirmed: z.literal(true).describe('true: the person asked for this reset in words and confirmed it in this conversation') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    // Tools started before an update hold the team's source as it was then: a reset from them would write the old team back.
    if (fresh.updated()) return text("Not reset: the desk in this folder was updated after the desk's tools in this conversation started, so they could write the team back as it was before the update. Nothing was written. Do not call reset_team again here: tell the person in one plain line to start a new conversation in Madav and check this computer there; a reset is needed only if that check still finds a difference.");
    let wrote: string[];
    try {
      const shipped = await shippedAgentFiles(source), last = lastReset(root), drift = driftOf(root, shipped);
      // Soon after a reset, with nothing differing on disk, another one cannot add anything: it is refused, and nothing is
      // written (a write would tell Madav once more to pause the desk's routines).
      if (last && Date.now() - last.getTime() < RESET_AGAIN_MS && !drift.changed.length && !drift.missing.length) return text(resetAgainWords(last));
      wrote = resetAgentFiles(root, shipped);
    } catch (e) {
      return text(`The team could not be reset: ${(e as Error).message}. Nothing was changed.`);
    }
    try { noteReset(root); } catch { /* the reset is done; only a repeat soon after will not be caught */ }
    const madav = 'Madav goes back to the project\'s version of the team too, in place of changes made in its Agent Studio; the model, permissions and effort chosen there stay as they are. If Madav runs the desk\'s routines, it pauses them until they are switched on again in Madav.';
    if (!wrote.length) return text(['The desk\'s agent files already matched the project\'s version on this computer; each was written again as the project ships it.', madav].join('\n'));
    return text([
      `Put back as the project ships them: ${listed(wrote.map(plainName))}; the others were written again too.`,
      `They take effect from the next conversation or run. ${madav}`,
    ].join('\n'));
  });

  server.registerTool('set_contact_email', {
    title: 'Save the contact email',
    description: 'Save the person\'s own email as the contact the SEC asks of every program that reads its filings. Ask the person for it in plain words and pass exactly what they give; never invent, guess or reuse an address. It is kept in this folder\'s desk-data (never committed) and sent to sec.gov alone.',
    inputSchema: { email: z.string().min(3).max(254).describe('The email address the person gave') },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    try {
      const email = saveContactEmail(root, a.email);
      return text(`Saved. The SEC will see ${email} as the contact for this desk's requests; no other source sees it.`);
    } catch (e) {
      return text(`INPUT_ERROR: ${(e as Error).message}. Ask the person for their own email address and call again.`);
    }
  });

  server.registerTool('get_instrument', {
    title: 'Instrument identity',
    description: 'Who the instrument is: the exact ticker (broker spellings like XAUUSD or BTCUSD mapped to the one the data uses), its kind (stock, fund, crypto, index), name, exchange, currency and its latest trading day on or before the analysis date. Call it first; refer to the instrument by this ticker in every report.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer(`identity of ${a.symbol}`, () => instrument(a.symbol, a.analysis_date)));

  server.registerTool('get_price_history', {
    title: 'Daily prices',
    description: 'Daily open, high, low, close and volume between two dates, adjusted for splits and dividends, held to the analysis date.',
    inputSchema: { symbol, analysis_date: analysis, start_date: z.string().describe('YYYY-MM-DD'), end_date: z.string().describe('YYYY-MM-DD; later than the analysis date is cut to it') },
    annotations: READ,
  }, async (a) => answer(`prices of ${a.symbol}`, () => priceHistory(a.symbol, a.analysis_date, a.start_date, a.end_date)));

  server.registerTool('get_indicators', {
    title: 'Technical indicators',
    description: `Values of one or more technical indicators, one per trading day over a look-back window ending on the analysis date, each with what it is for. Choose up to 8 that complement each other. Names: ${INDICATOR_NAMES.join(', ')}.`,
    inputSchema: { symbol, analysis_date: analysis, indicators: z.string().describe('One name or several, comma separated, e.g. "rsi, macd, close_50_sma"'), look_back_days: z.number().int().min(5).max(120).optional().describe('Calendar days to show; 30 when left out') },
    annotations: READ,
  }, async (a) => answer(`indicators of ${a.symbol}`, () => indicatorWindow(a.symbol, a.analysis_date, a.indicators, a.look_back_days ?? 30)));

  server.registerTool('get_verified_snapshot', {
    title: 'Checked price table',
    description: 'The checked price table: the latest trading row on or before the analysis date, the main indicators on it, and the last closes. Call it before writing any report, and take every exact price, level and indicator value from it.',
    inputSchema: { symbol, analysis_date: analysis, look_back_days: z.number().int().min(1).max(30).optional().describe('How many recent closes to list; 30 when left out') },
    annotations: READ,
  }, async (a) => answer(`checked price table of ${a.symbol}`, () => verifiedSnapshot(a.symbol, a.analysis_date, a.look_back_days ?? 30)));

  server.registerTool('get_price_facts', {
    title: 'Price facts',
    description: 'What the prices and indicators did, worked out by the desk so no one counts by eye: runs up to the latest row (how many sessions in a row), which side of each average and since when, every crossing of the last year, how often things happened in the last 20, 63, 126 and 252 sessions (closes below an average or beyond a band, RSI extremes, big days), the three highest and lowest of each window (closes, volume, daily moves, RSI, MACD, ATR), the latest row against the past (the lowest since when), and the change over each window. Every date carries its weekday. Call it before stating a streak, a first or last time, a record, a rank or a count of sessions.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer(`price facts of ${a.symbol}`, () => priceFacts(a.symbol, a.analysis_date)));

  server.registerTool('work_out', {
    title: 'Work it out',
    description: 'The desk\'s calculator, for every figure no tool prints: a difference, a percentage, a ratio, a sum or an average, many in one call, each answered with its sum; and the days between dates (calendar days, weekdays and, for a symbol, the sessions it traded), or the weekday of a date. Use it instead of working anything out in your head, and quote the sum it gives.',
    inputSchema: {
      analysis_date: analysis,
      sums: z.array(z.object({
        label: z.string().max(120).optional().describe('What the figure is, e.g. "fall on the day"'),
        expression: z.string().min(1).max(400).describe('Numbers without thousands commas, + - * / ^, brackets, % after a number, and change(a, b) (percent change from a to b), share(a, b) (a as a percent of b), abs, sqrt, round(a, d), sum, avg, min, max. E.g. "change(221.97, 212.21)" or "(96221 - 81615) / 81615 * 100"'),
      })).max(40).optional(),
      dates: z.array(z.object({
        date: z.string().optional().describe('YYYY-MM-DD: its weekday, and with a symbol whether it traded that day'),
        from: z.string().optional().describe('YYYY-MM-DD, with to: the days between them'),
        to: z.string().optional(),
        symbol: z.string().max(20).optional().describe('Also count the sessions this symbol traded'),
      })).max(20).optional(),
    },
    annotations: READ,
  }, async (a) => answer('the sums', () => workOut(a.analysis_date, a.sums, a.dates)));

  const days = z.number().int().min(1).max(30).optional().describe('Calendar days before the analysis date; ' + a0.newsLookbackDays + ' when left out');

  server.registerTool('get_company_news', {
    title: 'Company news',
    description: 'Headlines about the instrument from Yahoo Finance, with publisher and time, over the days before the analysis date. Search returns a recent sample: an empty or unreachable window is said to be so, never no news.',
    inputSchema: { symbol, analysis_date: analysis, look_back_days: days },
    annotations: READ,
  }, async (a) => answer('news about ' + a.symbol, () => companyNews(a.symbol, a.analysis_date, a.look_back_days ?? a0.newsLookbackDays, a0.companyNewsLimit)));

  server.registerTool('get_world_news', {
    title: 'World and economic news',
    description: 'Market-wide headlines over the days before the analysis date: the news Yahoo Finance files under the US stock market, the 10-year Treasury yield, oil, gold and the euro (the settings\' world-news symbols), where central banks, the economy, geopolitics and commodities are reported.',
    inputSchema: { analysis_date: analysis, look_back_days: days },
    annotations: READ,
  }, async (a) => answer('world news', () => worldNews(a.analysis_date, a.look_back_days ?? a0.newsLookbackDays, a0.worldNewsLimit, a0.worldNewsSearches)));

  server.registerTool('get_social_posts', {
    title: 'StockTwits and Reddit posts',
    description: 'What people posted about the instrument over the week before the analysis date: StockTwits messages with their authors\' Bullish or Bearish tags and counts, and Reddit posts from the investing communities (crypto ones for a crypto pair). Each source that fails is named as unavailable, never as quiet.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('posts about ' + a.symbol, () => socialPosts(a.symbol, a.analysis_date, { lookBackDays: a0.newsLookbackDays, stocktwitsLimit: a0.stocktwitsLimit, subreddits: a0.subreddits, cryptoSubreddits: a0.cryptoSubreddits })));

  server.registerTool('get_economic_series', {
    title: 'Economic figures (FRED)',
    description: 'An economic series from FRED as known by the analysis date: the latest value named by the period it stands for, the change over a year (from the same period a year earlier: quote a yearly rate only from that line), the change over the look-back window and recent values. Names: ' + Object.keys(SERIES).join(', ') + '; or any FRED series id.',
    inputSchema: { indicator: z.string().describe('A name such as cpi, 10y_treasury, unemployment, or a FRED series id'), analysis_date: analysis, look_back_days: z.number().int().min(30).max(3650).optional().describe('365 when left out') },
    annotations: READ,
  }, async (a) => answer('economic series ' + a.indicator, () => economicSeries(a.indicator, a.analysis_date, a.look_back_days ?? 365)));

  server.registerTool('get_prediction_markets', {
    title: 'Prediction-market odds',
    description: 'Live Polymarket odds for forward-looking events matching a topic (e.g. "Fed rate cut", "recession 2026"), with volume and resolution date. Withheld for a past analysis date.',
    inputSchema: { topic: z.string().min(2).max(80), analysis_date: analysis, limit: z.number().int().min(1).max(10).optional() },
    annotations: READ,
  }, async (a) => answer('prediction markets on ' + a.topic, () => predictionMarkets(a.topic, a.analysis_date, a.limit ?? 6)));

  server.registerTool('get_company_overview', {
    title: 'Company profile and ratios',
    description: 'For a US filer, from its SEC filings as they stood on the analysis date and the checked closing price: its name, industry and sector, fiscal year, shares outstanding, and its valuation worked out from them (market value, last-twelve-months diluted EPS, price to earnings, book value and price to book), each shown with the filed figures it came from, and the dividends per share and yield of the twelve months to the day from the dividends the price source records, each dated; a past analysis date has its own. For a company that does not file with the SEC, Yahoo Finance\'s profile and ratios for today only, withheld for a past analysis date.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('profile of ' + a.symbol, () => companyOverview(a.symbol, a.analysis_date)));

  server.registerTool('get_financial_statement', {
    title: 'Financial statement',
    description: 'A balance sheet, income statement or cash flow statement, quarterly or annual, latest periods first, with margins, growth, free cash flow and balance-sheet ratios worked out in rows of their own. For a US filer it is the SEC filing as it stood on the analysis date (a quarter no filing states derived and marked so, per-share figures on the basis of the latest filings across a share split); otherwise Yahoo Finance\'s, for today only.',
    inputSchema: {
      symbol, analysis_date: analysis,
      statement: z.enum(['balance_sheet', 'income_statement', 'cashflow']),
      frequency: z.enum(['quarterly', 'annual']).optional().describe('quarterly when left out'),
    },
    annotations: READ,
  }, async (a) => answer(`${a.statement.replace('_', ' ')} of ${a.symbol}`, () => financialStatement(a.symbol, a.statement, a.frequency ?? 'quarterly', a.analysis_date)));

  server.registerTool('get_insider_transactions', {
    title: 'Insider transactions',
    description: 'Buying and selling by the company\'s directors, officers and largest owners in the 90 days up to the analysis date, for a US filer from its Form 4 filings with the SEC (only those made public by then, so a past date has its own): who, their role, what kind of trade, shares, price, what they hold after, and whether it was under a pre-arranged plan, with a count of purchases and sales. For a company that does not file with the SEC, Yahoo Finance\'s for today only, withheld for a past analysis date.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('insider transactions of ' + a.symbol, () => insiderTransactions(a.symbol, a.analysis_date)));

  server.registerTool('get_fund_profile', {
    title: 'Fund profile',
    description: 'For a fund (an ETF or a mutual fund, as get_instrument says), its fundamentals in place of company accounts, from the latest portfolio report it had filed with the SEC by the analysis date (form N-PORT; a past date reads what was public then): its size, what it holds (largest holdings by issuer, stocks against bonds and cash, issuers, countries, for bonds their years to repayment and interest), and its own monthly returns, with the day its holdings are from. Its yearly cost has no official free source and is said as unavailable. A fund outside the US falls back to Yahoo Finance, today only.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('fund profile of ' + a.symbol, () => fundProfile(a.symbol, a.analysis_date)));

  registerDeskTools(server, root);
  return server;
}
