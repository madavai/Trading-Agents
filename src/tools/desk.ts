// The desk's own records as tools the agents call: the plan for an analysis, the run's working record, the journal of calls
// and their outcomes, and what the person holds. None of these touches an order; each answers in plain words, and a
// refused request says INPUT_ERROR with what to correct.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analysisDate } from '../data/dates.js';
import { safeSymbol } from '../data/symbols.js';
import { deskDataDir } from '../paths.js';
import { readSettings } from '../settings.js';
import { forgetHoldings, saveHoldings } from '../desk/holdings.js';
import { ASK_FOR_EMAIL, readContactEmail } from '../contact.js';
import { cells, iterGrid, renderSummary, summarize } from '../desk/backtest.js';
import { buildPlan, journalOf, NeedsEmail, renderPlan, type Plan } from '../desk/plan.js';
import { SWEEP_ID, workspaceOf } from '../desk/workspace.js';
import { dequeue, readQueue } from '../terminal/store.js';
import { writeWhole } from '../desk/lock.js';
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
  // While a backtest sweep is running, the run record and the journal are the sweep's own; the live ones are not touched.
  // Which sweep is running is kept on disk, not in this process, so every copy of the tool server routes the same way. It
  // lapses after two idle hours, so a sweep that was abandoned cannot capture later live analyses.
  const activeFile = path.join(dir, 'backtest', 'active.json'), IDLE_MS = 2 * 3_600_000;
  const getSweep = (): string | null => {
    try { const a = JSON.parse(fs.readFileSync(activeFile, 'utf8')) as { sweep?: unknown; at?: unknown }; if (typeof a.sweep === 'string' && SWEEP_ID.test(a.sweep) && typeof a.at === 'number' && Date.now() - a.at < IDLE_MS) return a.sweep; } catch { /* none running */ }
    return null;
  };
  const setSweep = (id: string | null): void => {
    if (id === null) { fs.rmSync(activeFile, { force: true }); return; }
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    writeWhole(activeFile, JSON.stringify({ sweep: id, at: Date.now() }));
  };
  const ws = () => { const id = getSweep(); if (id) setSweep(id); return workspaceOf(root, id); };

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
  }, async (a) => act(() => (getSweep() ? `[Backtest sweep ${getSweep()}: this run is recorded in the sweep's own journal, not the live one.]\n` : '') + renderPlan(buildPlan(root, { symbol: a.symbol, analysisDate: a.analysis_date, analysts: a.analysts, debateRounds: a.debate_rounds, riskRounds: a.risk_rounds, language: a.language, restart: a.restart }, ws()))));

  server.registerTool('save_run_section', {
    title: 'Save a run section',
    description: `Save what you wrote for your step of an analysis, so the next agent reads it from the desk and a stopped run can resume. section is one of ${SECTIONS.join(', ')}. A debate turn (bull, bear, aggressive, conservative, neutral) is added; any other section replaces the earlier text.`,
    inputSchema: { symbol, analysis_date: day, section: z.enum(SECTIONS), text: z.string().min(1).max(60_000) },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), turns = saveSection(ws().dir, a.symbol, d, a.section, a.text);
    return `Saved ${a.section} for ${safeSymbol(a.symbol)} on ${d} (${turns > 1 ? `turn ${turns}` : 'one text'}).`;
  }));

  server.registerTool('read_run', {
    title: 'Read a run',
    description: `Read what the team has written so far for a stock and day. Without sections it lists which sections exist and how many turns each holds. With sections it returns their text; ${DEBATES.join(' and ')} give a whole debate in the order spoken. A section not written yet is said to be missing, never blank.`,
    inputSchema: { symbol, analysis_date: day, sections: z.array(z.enum([...SECTIONS, ...DEBATES])).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date);
    if (a.sections?.length) return readSections(ws().dir, a.symbol, d, a.sections);
    const p = progress(ws().dir, a.symbol, d);
    return Object.keys(p).length ? `Written so far for ${safeSymbol(a.symbol)} on ${d}: ${Object.entries(p).map(([k, n]) => `${k} (${n})`).join(', ')}` : `Nothing written yet for ${safeSymbol(a.symbol)} on ${d}.`;
  }));

  server.registerTool('write_report', {
    title: 'Write the report',
    description: 'Assemble the finished report of an analysis from everything the team saved - the analysts, the debates, the manager, the trader, the risk voices, the decision - into one markdown page in the run\'s folder. Returns where it is. Call it after the portfolio manager\'s decision is saved.',
    inputSchema: { symbol, analysis_date: day },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol), plan = savedPlan(ws().dir, sym, d) as Plan | undefined;
    if (!progress(ws().dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const rating = parseRating(readSections(ws().dir, sym, d, ['decision']));
    const header = [`Rating: ${rating}`, `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`];
    if (plan?.analysts) header.push(`Analysts: ${plan.analysts.join(', ')}; research debate rounds ${plan.debateRounds}, risk debate rounds ${plan.riskRounds}; language ${plan.language}`, `Judged after ${plan.holdingDays} trading days against ${plan.benchmark}`);
    const file = writeReport(ws().dir, sym, d, header);
    return `Report written: ${file}\nRating: ${rating}`;
  }));

  server.registerTool('record_decision', {
    title: 'Record the decision',
    description: 'Put the portfolio manager\'s saved decision in the journal as a pending call, to be scored later against its market index. The text is the one saved in the run, so the journal always matches the report. One call per stock and day: a repeat is ignored. Pass the rating the decision states; without one it is read from the text, and a decision with no readable rating is recorded as Needs review.',
    inputSchema: { symbol, analysis_date: day, rating: z.enum(RATINGS).optional() },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol);
    const decision = readSections(ws().dir, sym, d, ['decision']);
    if (!progress(ws().dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const body = decision.replace(/^## [^\n]*\n/, '');
    const r = journalOf(root, ws()).storeDecision(sym, d, body, a.rating ?? undefined);
    const rating = a.rating ?? parseRating(body);
    return r === 'stored' ? `Recorded: ${sym} on ${d}, ${rating}, pending. It is scored after ${readSettings(root).scoring.holdingPeriodDays} trading days.` : `${sym} on ${d} is already in the journal; nothing changed.`;
  }));

  server.registerTool('list_settlements', {
    title: 'Pending calls',
    description: 'List the calls in the journal that are not settled yet. For each whose holding window has finished trading, it shows the measured outcome (return, the index\'s return, alpha) and the decision, so you can write the lesson; the others are marked NOT YET. The figures come from price rows only.',
    inputSchema: { symbol: symbol.optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => act(() => dueSettlements(journalOf(root, ws()), readSettings(root).scoring, a.symbol ? safeSymbol(a.symbol) : undefined)));

  server.registerTool('record_outcome', {
    title: 'Settle a call',
    description: 'Settle one pending call whose window has finished: the desk measures the outcome again itself and keeps it with your lesson. Give only the lesson - 2 to 4 plain sentences naming what the alpha shows, what part of the thesis it supports or undercuts, and one thing to do next time. Never pass or invent a number.',
    inputSchema: { symbol, trade_date: day, lesson: z.string().min(1).max(1200) },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (a) => act(() => settleOne(journalOf(root, ws()), readSettings(root).scoring, safeSymbol(a.symbol), a.trade_date, a.lesson)));

  server.registerTool('start_backtest', {
    title: 'Start a backtest sweep',
    description: 'Lay out a backtest: the team is run over every stock on every date from start to end (every few days) and the calls are scored later against the market index. From now until end_backtest every desk tool records into this sweep\'s own journal and runs, so the live journal and its lessons are untouched. Repeat the call with the same sweep_id to resume: cells already recorded are skipped. Every cell is a full team run, so tell the person the number of cells before running any.',
    inputSchema: {
      symbols: z.array(symbol).min(1).max(10), start_date: day, end_date: day,
      every_days: z.number().int().min(1).max(60).optional().describe('Days between analysis dates; 7 when left out'),
      sweep_id: z.string().max(40).optional().describe('Name of the sweep, to resume it; made from the time when left out'),
    },
    annotations: write,
  }, async (a) => act(() => {
    if (!readContactEmail(root)) throw new NeedsEmail(ASK_FOR_EMAIL);
    const every = a.every_days ?? 7, dates = iterGrid(a.start_date, a.end_date, every), grid = cells(a.symbols, dates);
    const id = a.sweep_id ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14), w = workspaceOf(root, id);
    fs.mkdirSync(w.dir, { recursive: true });
    const recorded = new Set(journalOf(root, w).load().map((e) => `${e.ticker}|${e.date}`));
    const todo = grid.filter((c) => !recorded.has(`${c.symbol}|${c.date}`));
    writeWhole(path.join(w.dir, 'sweep.json'), JSON.stringify({ symbols: [...new Set(grid.map((c) => c.symbol))], dates, every, cells: grid.length }));
    setSweep(id);
    const symbols = new Set(grid.map((c) => c.symbol)).size;
    return [
      `Backtest sweep ${id}: ${grid.length} cell(s) (${symbols} stock(s) on ${dates.length} date(s), every ${every} day(s), ${dates[0]} to ${dates[dates.length - 1]}); ${grid.length - todo.length} already recorded, ${todo.length} to run.`,
      'From now until end_backtest every desk tool records into this sweep\'s own journal and runs. The live journal and its lessons are untouched.',
      '', `Cells to run, in order (${todo.length ? 'each is a full team run' : 'none left'}):`,
      ...todo.slice(0, 30).map((c, i) => `${i + 1}. ${c.symbol} ${c.date}`), ...(todo.length > 30 ? [`... and ${todo.length - 30} more`] : []),
      '', 'Limits to tell the person: for a past date, prices, indicators, economic figures and SEC accounts are as known on that date, but news, posts, odds, the company profile and insider trades exist only for recent days, so those reads are thin or unavailable and say so. Results are indicative, not repeatable.',
    ].join('\n');
  }));

  server.registerTool('end_backtest', {
    title: 'End the backtest sweep',
    description: 'Go back to the live desk: from now on the desk tools record into the live journal and runs again. The sweep and its results stay on disk.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => act(() => { const was = getSweep(); setSweep(null); return was ? `Backtest sweep ${was} ended. The desk is back on the live journal.` : 'No backtest was running; the desk is on the live journal.'; }));

  server.registerTool('backtest_summary', {
    title: 'Backtest results',
    description: 'Score a sweep\'s settled calls by rating: how many, how often the direction was called right (not for Hold, which claims none), and the mean alpha against each stock\'s market index. Calls whose window has not traded are pending; calls with no readable rating are unscored. Report the figures as they are and say that a few calls prove nothing.',
    inputSchema: { sweep_id: z.string().max(40).optional().describe('The sweep to score; the running one when left out') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const id = a.sweep_id ?? getSweep();
    if (!id) throw new Error('no backtest is running: name the sweep to score');
    const w = workspaceOf(root, id);
    if (!fs.existsSync(path.join(w.dir, 'journal.md'))) throw new Error(`sweep ${id} has no recorded calls yet`);
    let meta = '';
    try { const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'sweep.json'), 'utf8')) as { cells: number }; meta = ` of ${m.cells} planned`; } catch { /* no plan file */ }
    const entries = journalOf(root, w).load();
    return `Backtest sweep ${id}: ${entries.length} call(s) recorded${meta}\n\n${renderSummary(summarize(entries))}`;
  }));

  server.registerTool('read_queue', {
    title: 'Analyses waiting',
    description: 'The stocks the person asked the desk to analyse from the dashboard, oldest first. /analyse with no ticker runs these. Read-only.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => act(() => {
    const q = readQueue(dir);
    return q.length ? `${q.length} analysis request(s) waiting, oldest first:\n${q.map((i, n) => `${n + 1}. ${i.symbol} (asked ${i.requestedAt.slice(0, 16).replace('T', ' ')} UTC)`).join('\n')}` : 'Nothing is waiting: the person has not asked for any analysis from the dashboard.';
  }));

  server.registerTool('finish_queue_item', {
    title: 'Mark a waiting analysis done',
    description: 'Take a stock off the waiting list once its analysis has been run and recorded (or the person no longer wants it).',
    inputSchema: { symbol },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => act(() => { const left = dequeue(dir, a.symbol); return `Taken off the waiting list. ${left.length} left.`; }));

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
