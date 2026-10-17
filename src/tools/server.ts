// The desk tool server: the one MCP server this folder gives the engine (.mcp.json, started by main.ts). It holds the
// desk check and the data tools the agents read facts from; it never holds an order tool. Every data tool works as of
// an analysis date and never serves anything dated after it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deskCheck } from '../check/desk-check.js';
import { readSettings } from '../settings.js';
import { readContactEmail, saveContactEmail } from '../contact.js';
import { configure, failureText } from '../data/http.js';
import { INDICATOR_NAMES } from '../data/indicators.js';
import { indicatorWindow, instrument, priceHistory, verifiedSnapshot } from '../data/market.js';
import { companyNews, worldNews } from '../data/news.js';
import { socialPosts } from '../data/social.js';
import { economicSeries, SERIES } from '../data/macro.js';
import { predictionMarkets } from '../data/odds.js';
import { companyOverview, financialStatement, insiderTransactions } from '../data/company.js';
import { registerDeskTools } from './desk.js';
import { VERSION } from '../version.js';
import { listed, plainName, resetAgentFiles, shippedAgentFiles } from '../desk/agent-files.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

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
export function deskServer(root: string = process.cwd(), fetchImpl?: typeof fetch, source: string = root): McpServer {
  const settings = readSettings(root), a0 = settings.analysis;
  configure({ contact: settings.sources.contact, secEmail: () => readContactEmail(root) });
  if (fetchImpl) configure({ fetch: fetchImpl });
  const server = new McpServer({ name: 'trading-desk', version: VERSION });

  server.registerTool('desk_check', {
    title: 'Desk check',
    description: 'Check that this computer is ready for the Trading Agents desk: Node, the desk data folder, whether a Robinhood sign-in is saved, whether the desk\'s agents and team are as the project ships them, and whether each free data source answers. Read-only; it sends no order and reads no secret.',
    annotations: READ,
  }, async () => text(await deskCheck(root, fetchImpl, source)));

  server.registerTool('reset_team', {
    title: 'Reset the team',
    description: 'Put the desk\'s twelve agents, the trading-desk team\'s file and its line-up back exactly as the project ships them, when they were changed (a save in Madav\'s Agent Studio can do it). Only after the person asked for it and confirmed it in this conversation. It writes only those files in this folder and cannot change Madav\'s own saved settings for the team.',
    inputSchema: { confirmed: z.literal(true).describe('true: the person confirmed this reset in this conversation') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    let wrote: string[];
    try { wrote = resetAgentFiles(root, await shippedAgentFiles(source)); } catch (e) {
      return text(`The team could not be reset: ${(e as Error).message}. Nothing was changed.`);
    }
    if (!wrote.length) return text('The desk\'s agents and the trading-desk team already match the project\'s version. Nothing was changed.');
    return text([
      `Put back as the project ships them: ${listed(wrote.map(plainName))}.`,
      'They take effect from the next conversation or run. Madav keeps its own saved settings for the team, which this cannot change: until Madav can reset them itself, do not press Save on the trading-desk team in Agent Studio, or it may write its settings into these files again.',
    ].join('\n'));
  });

  server.registerTool('set_contact_email', {
    title: 'Save the contact email',
    description: 'Save the person\'s own email as the contact the SEC asks of everyone who reads its filings. Ask the person for it in plain words and pass exactly what they give; never invent, guess or reuse an address. It is kept in this folder\'s desk-data (never committed) and sent to sec.gov alone.',
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

  const days = z.number().int().min(1).max(30).optional().describe('Calendar days before the analysis date; ' + a0.newsLookbackDays + ' when left out');

  server.registerTool('get_company_news', {
    title: 'Company news',
    description: 'Headlines about the instrument from Yahoo Finance, with publisher and time, over the days before the analysis date. Search returns a recent sample: an empty or unreachable window is said to be so, never no news.',
    inputSchema: { symbol, analysis_date: analysis, look_back_days: days },
    annotations: READ,
  }, async (a) => answer('news about ' + a.symbol, () => companyNews(a.symbol, a.analysis_date, a.look_back_days ?? a0.newsLookbackDays, a0.companyNewsLimit)));

  server.registerTool('get_world_news', {
    title: 'World and economic news',
    description: 'Headlines on central banks, the economy, geopolitics and commodities from the desk\'s standing searches, over the days before the analysis date.',
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
    description: 'An economic series from FRED as known by the analysis date: the latest value, the change over the window and recent values. Names: ' + Object.keys(SERIES).join(', ') + '; or any FRED series id.',
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
    description: 'The company\'s name, sector and industry, market value, valuation multiples (P/E, forward P/E, PEG, price to book), margins, returns, debt to equity, dividend yield, beta and the 52-week range, from Yahoo Finance as they stand today. Withheld for a past analysis date.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('profile of ' + a.symbol, () => companyOverview(a.symbol, a.analysis_date)));

  server.registerTool('get_financial_statement', {
    title: 'Financial statement',
    description: 'A balance sheet, income statement or cash flow statement, quarterly or annual, latest periods first. For a US filer it is the SEC filing as it stood on the analysis date; otherwise Yahoo Finance\'s, for today only.',
    inputSchema: {
      symbol, analysis_date: analysis,
      statement: z.enum(['balance_sheet', 'income_statement', 'cashflow']),
      frequency: z.enum(['quarterly', 'annual']).optional().describe('quarterly when left out'),
    },
    annotations: READ,
  }, async (a) => answer(`${a.statement.replace('_', ' ')} of ${a.symbol}`, () => financialStatement(a.symbol, a.statement, a.frequency ?? 'quarterly', a.analysis_date)));

  server.registerTool('get_insider_transactions', {
    title: 'Insider transactions',
    description: 'Recent buying and selling by the company\'s directors and officers, from Yahoo Finance: who, their role, what, how many shares and the value. Withheld for a past analysis date.',
    inputSchema: { symbol, analysis_date: analysis },
    annotations: READ,
  }, async (a) => answer('insider transactions of ' + a.symbol, () => insiderTransactions(a.symbol, a.analysis_date)));

  registerDeskTools(server, root);
  return server;
}
