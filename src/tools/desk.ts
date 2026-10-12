// The desk's own records as tools the agents call: the plan for an analysis, the run's working record, the journal of calls
// and their outcomes, and what the person holds. None of these touches an order; each answers in plain words, and a
// refused request says INPUT_ERROR with what to correct.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analysisDate } from '../data/dates.js';
import { safeSymbol } from '../data/symbols.js';
import { deskDataDir } from '../paths.js';
import { readSettings } from '../settings.js';
import { forgetHoldings, saveHoldings } from '../desk/holdings.js';
import { buildPlan, journalOf, NeedsEmail, renderPlan, type Plan } from '../desk/plan.js';
import { parseRating, RATINGS } from '../desk/rating.js';
import { progress, readSections, savedPlan, saveSection, SECTIONS, writeReport } from '../desk/runs.js';
import { dueSettlements, settleOne } from '../desk/settle.js';
import { failureText, NoData, Unavailable } from '../data/http.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const symbol = z.string().min(1).max(20).describe('The ticker as the plan gives it');
const day = z.string().describe('The analysis date, YYYY-MM-DD');
const DEBATES = ['investment_debate', 'risk_debate'] as const;

/** Runs a desk tool: its answer, or what to correct. A source that could not answer says so, never "nothing". */
async function act(run: () => string | Promise<string>) {
  try { return text(await run()); } catch (e) {
    if (e instanceof NeedsEmail) return text(`NEEDS_EMAIL: ${e.message}`);
    if (e instanceof Unavailable || e instanceof NoData) return text(failureText(e, 'this desk record'));
    return text(`INPUT_ERROR: ${(e as Error).message}. Correct it and call again.`);
  }
}

export function registerDeskTools(server: McpServer, root: string): void {
  const dir = deskDataDir(root);
  const write = { readOnlyHint: false, openWorldHint: false } as const;

  server.registerTool('plan_analysis', {
    title: 'Plan an analysis',
    description: 'Draw up the plan for analysing a stock on a date, before any agent speaks: the instrument, the analysts that run, the debate rounds, the report language, the index the call will be judged against, what the person holds, the lessons from past calls, and - for a run that stopped half way - the next step. Refused with NEEDS_EMAIL until the person has given their email. Call it first, and follow it.',
    inputSchema: {
      symbol, analysis_date: day,
      analysts: z.array(z.enum(['market', 'sentiment', 'news', 'fundamentals'])).optional().describe('Only these analysts; the settings\' when left out'),
      debate_rounds: z.number().int().min(1).max(5).optional().describe('Rounds of bull and bear; the settings\' when left out'),
      risk_rounds: z.number().int().min(1).max(5).optional().describe('Rounds of the three risk voices; the settings\' when left out'),
      language: z.string().max(40).optional().describe('Report language, e.g. Spanish; the settings\' when left out'),
      restart: z.boolean().optional().describe('Throw away an earlier unfinished run of this stock and day and start over'),
    },
    annotations: write,
  }, async (a) => act(() => renderPlan(buildPlan(root, { symbol: a.symbol, analysisDate: a.analysis_date, analysts: a.analysts, debateRounds: a.debate_rounds, riskRounds: a.risk_rounds, language: a.language, restart: a.restart }))));

  server.registerTool('save_run_section', {
    title: 'Save a run section',
    description: `Save what you wrote for your step of an analysis, so the next agent reads it from the desk and a stopped run can resume. section is one of ${SECTIONS.join(', ')}. A debate turn (bull, bear, aggressive, conservative, neutral) is added; any other section replaces the earlier text.`,
    inputSchema: { symbol, analysis_date: day, section: z.enum(SECTIONS), text: z.string().min(1).max(60_000) },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), turns = saveSection(dir, a.symbol, d, a.section, a.text);
    return `Saved ${a.section} for ${safeSymbol(a.symbol)} on ${d} (${turns > 1 ? `turn ${turns}` : 'one text'}).`;
  }));

  server.registerTool('read_run', {
    title: 'Read a run',
    description: `Read what the team has written so far for a stock and day. Without sections it lists which sections exist and how many turns each holds. With sections it returns their text; ${DEBATES.join(' and ')} give a whole debate in the order spoken. A section not written yet is said to be missing, never blank.`,
    inputSchema: { symbol, analysis_date: day, sections: z.array(z.enum([...SECTIONS, ...DEBATES])).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date);
    if (a.sections?.length) return readSections(dir, a.symbol, d, a.sections);
    const p = progress(dir, a.symbol, d);
    return Object.keys(p).length ? `Written so far for ${safeSymbol(a.symbol)} on ${d}: ${Object.entries(p).map(([k, n]) => `${k} (${n})`).join(', ')}` : `Nothing written yet for ${safeSymbol(a.symbol)} on ${d}.`;
  }));

  server.registerTool('write_report', {
    title: 'Write the report',
    description: 'Assemble the finished report of an analysis from everything the team saved - the analysts, the debates, the manager, the trader, the risk voices, the decision - into one markdown page in the run\'s folder. Returns where it is. Call it after the portfolio manager\'s decision is saved.',
    inputSchema: { symbol, analysis_date: day },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol), plan = savedPlan(dir, sym, d) as Plan | undefined;
    if (!progress(dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const rating = parseRating(readSections(dir, sym, d, ['decision']));
    const header = [`Rating: ${rating}`, `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`];
    if (plan?.analysts) header.push(`Analysts: ${plan.analysts.join(', ')}; research debate rounds ${plan.debateRounds}, risk debate rounds ${plan.riskRounds}; language ${plan.language}`, `Judged after ${plan.holdingDays} trading days against ${plan.benchmark}`);
    const file = writeReport(dir, sym, d, header);
    return `Report written: ${file}\nRating: ${rating}`;
  }));

  server.registerTool('record_decision', {
    title: 'Record the decision',
    description: 'Put the portfolio manager\'s saved decision in the journal as a pending call, to be scored later against its market index. The text is the one saved in the run, so the journal always matches the report. One call per stock and day: a repeat is ignored. Pass the rating the decision states; without one it is read from the text, and a decision with no readable rating is recorded as Needs review.',
    inputSchema: { symbol, analysis_date: day, rating: z.enum(RATINGS).optional() },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol);
    const decision = readSections(dir, sym, d, ['decision']);
    if (!progress(dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const body = decision.replace(/^## [^\n]*\n/, '');
    const r = journalOf(root).storeDecision(sym, d, body, a.rating ?? undefined);
    const rating = a.rating ?? parseRating(body);
    return r === 'stored' ? `Recorded: ${sym} on ${d}, ${rating}, pending. It is scored after ${readSettings(root).scoring.holdingPeriodDays} trading days.` : `${sym} on ${d} is already in the journal; nothing changed.`;
  }));

  server.registerTool('list_settlements', {
    title: 'Pending calls',
    description: 'List the calls in the journal that are not settled yet. For each whose holding window has finished trading, it shows the measured outcome (return, the index\'s return, alpha) and the decision, so you can write the lesson; the others are marked NOT YET. The figures come from price rows only.',
    inputSchema: { symbol: symbol.optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => act(() => dueSettlements(journalOf(root), readSettings(root).scoring, a.symbol ? safeSymbol(a.symbol) : undefined)));

  server.registerTool('record_outcome', {
    title: 'Settle a call',
    description: 'Settle one pending call whose window has finished: the desk measures the outcome again itself and keeps it with your lesson. Give only the lesson - 2 to 4 plain sentences naming what the alpha shows, what part of the thesis it supports or undercuts, and one thing to do next time. Never pass or invent a number.',
    inputSchema: { symbol, trade_date: day, lesson: z.string().min(1).max(1200) },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (a) => act(() => settleOne(journalOf(root), readSettings(root).scoring, safeSymbol(a.symbol), a.trade_date, a.lesson)));

  server.registerTool('set_holdings', {
    title: 'Save what the person holds',
    description: 'Save the positions and free cash the person tells you they hold, so the trader and risk voices size against their real book. Pass exactly what they said; never guess. An empty list of positions means they hold nothing (a flat book) - different from not having said, which is the default.',
    inputSchema: {
      positions: z.array(z.object({ ticker: z.string().min(1).max(20), quantity: z.number(), average_price: z.number().optional() })).max(500),
      cash: z.number().optional(), currency: z.string().length(3).optional().describe('e.g. USD'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const h = saveHoldings(dir, { cash: a.cash, currency: a.currency, positions: a.positions.map((p) => ({ ticker: p.ticker, quantity: p.quantity, averagePrice: p.average_price })) }, new Date().toISOString().slice(0, 10));
    return h.positions.length ? `Saved ${h.positions.length} position(s)${h.cash !== undefined ? ` and cash ${h.cash}` : ''}.` : `Saved: the person holds nothing${h.cash !== undefined ? `, with cash ${h.cash}` : ''}.`;
  }));

  server.registerTool('clear_holdings', {
    title: 'Forget what the person holds',
    description: 'Forget the saved holdings, so the desk goes back to not knowing what the person holds. Use when they ask to; it is not the same as holding nothing.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async () => act(() => (forgetHoldings(dir) ? 'Forgotten: the desk no longer knows what the person holds.' : 'Nothing was saved.')));

}
