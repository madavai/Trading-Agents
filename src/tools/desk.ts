// The desk's own records as tools the agents call: the plan for an analysis, the run's working record, the journal of calls
// and their outcomes, and what the person holds. None of these touches an order; each answers in plain words, and a
// refused request says INPUT_ERROR with what to correct.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analysisDate, today } from '../data/dates.js';
import { isMarketDay } from '../data/holidays.js';
import { safeSymbol } from '../data/symbols.js';
import { deskDataDir } from '../paths.js';
import { readSettings } from '../settings.js';
import { forgetHoldings, saveHoldings } from '../desk/holdings.js';
import { ASK_FOR_EMAIL, readContactEmail } from '../contact.js';
import { cells, iterGrid, renderSummary, summarize } from '../desk/backtest.js';
import { buildPlan, journalOf, NeedsEmail, renderPlan, runContext, scoredWords, type Plan } from '../desk/plan.js';
import { checkWords, rulesFor, windowWords, WHEN_SCORED, type Rules } from '../desk/scoring.js';
import { SWEEP_ID, workspaceOf } from '../desk/workspace.js';
import { byAnother, DEPTHS, finishItem, QueueRefusal, readQueue, ringDoorbell, RUNNER_ID, startItem, waitingIn, type Depth, type Runner } from '../desk/queue.js';
import { Journal } from '../desk/journal.js';
import { writeWhole } from '../desk/lock.js';
import { parseRating, RATINGS } from '../desk/rating.js';
import { CONTEXT, correctSection, PART_CHARS, progress, readPart, readSections, savedPlan, saveSection, SECTIONS, writeReport } from '../desk/runs.js';
import { dueSettlements, settleOne } from '../desk/settle.js';
import { correctLesson, flagLesson, lessonsToRecheck } from '../desk/lessons.js';
import { failureText, NoData, Unavailable } from '../data/http.js';
import { openDashboard } from '../terminal/launch.js';
import { eveningBrief, morningBrief, type MorningLook } from '../desk/routine.js';
import { queueTop, readScreen, screenToday } from '../desk/screen.js';
import { rerateWeekly, stopsAtClose } from '../desk/care.js';
import { lastClose } from '../data/market.js';
import { marketOf, readPrefs } from '../terminal/prefs.js';
import { readWatchlist } from '../terminal/store.js';
import { screenUniverse } from '../terminal/tiers.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const symbol = z.string().min(1).max(20).describe('The ticker as the plan gives it');
const day = z.string().describe('The analysis date, YYYY-MM-DD');
const DEBATES = ['investment_debate', 'risk_debate'] as const;

/** Runs a desk tool: its answer, or what to correct. A source that could not answer says so, never "nothing". */
async function act(run: () => string | Promise<string>) {
  try { return text(await run()); } catch (e) {
    if (e instanceof NeedsEmail) return text(`NEEDS_EMAIL: ${e.message}`);
    if (e instanceof Unavailable || e instanceof NoData) return text(failureText(e, 'a source this desk tool reads'));
    return text(`INPUT_ERROR: ${(e as Error).message}. Correct it and call again.`);
  }
}

export function registerDeskTools(server: McpServer, root: string): void {
  const dir = deskDataDir(root);
  const write = { readOnlyHint: false, openWorldHint: false } as const;
  // While a backtest sweep is running, each of its cells (its stocks on its dates) is recorded in the sweep's own run
  // records and journal; everything else stays on the live desk, so the person's own analyses, routines and scoring go on
  // beside a backtest and never land in it. Which sweep is running, and its cells, are kept on disk, not in this process,
  // so every copy of the tool server (a member with its own connection) routes a cell the same way. Only a cell's own
  // work keeps the sweep alive: it lapses after two idle hours, so an abandoned one routes nothing for long.
  const activeFile = path.join(dir, 'backtest', 'active.json'), IDLE_MS = 2 * 3_600_000;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const activeSweep = (): { id: string; cells: Set<string> } | null => {
    try {
      const a = JSON.parse(fs.readFileSync(activeFile, 'utf8')) as { sweep?: unknown; at?: unknown };
      if (typeof a.sweep !== 'string' || !SWEEP_ID.test(a.sweep) || typeof a.at !== 'number' || Date.now() - a.at >= IDLE_MS) return null;
      let cells = new Set<string>();
      try {
        const g = JSON.parse(fs.readFileSync(path.join(workspaceOf(root, a.sweep).dir, 'sweep.json'), 'utf8')) as { symbols?: unknown; dates?: unknown };
        cells = new Set(strings(g.symbols).flatMap((s) => strings(g.dates).map((d) => `${s}|${d}`)));
      } catch { /* a sweep with no grid on disk has no cells: nothing is routed to it */ }
      return { id: a.sweep, cells };
    } catch { return null; }
  };
  const getSweep = (): string | null => activeSweep()?.id ?? null;
  const setSweep = (id: string | null): void => {
    if (id === null) { fs.rmSync(activeFile, { force: true }); return; }
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    writeWhole(activeFile, JSON.stringify({ sweep: id, at: Date.now() }));
  };
  /** The running sweep whose cell this stock and day are, if any (read only: nothing is kept alive by asking). */
  const sweepOfCell = (sym: string, day: string): string | null => { const s = activeSweep(); return s?.cells.has(`${safeSymbol(sym)}|${day}`) ? s.id : null; };
  /** Where a run of this stock and day is recorded: the running sweep's own records when it is one of its cells (which
   *  keeps the sweep alive), else the live desk's. */
  const wsFor = (sym: string, day: string) => { const id = sweepOfCell(sym, day); if (id) setSweep(id); return workspaceOf(root, id); };
  const live = () => workspaceOf(root);
  /** The journal a scoring reads: a sweep's when its id is given (only /backtest gives it), else the live one. */
  const scored = (sweep?: string) => (sweep ? workspaceOf(root, sweep) : live());
  const sweepArg = z.string().max(40).optional().describe("Only inside a backtest: the sweep_id whose calls to score (the /backtest playbook gives it). Left out: the live journal's calls, the person's own");

  server.registerTool('plan_analysis', {
    title: 'Plan an analysis',
    description: 'Draw up the plan for analysing a stock on a date, before any agent speaks: the instrument, the analysts that run, the debate rounds, the report language, the window and yardstick the call will be scored by (a short first check, not its time horizon), what the person holds, the lessons from past calls, and - for a run that stopped half way - the next step. Refused with NEEDS_EMAIL until the person has given their email. Call it first, and follow it.',
    inputSchema: {
      symbol, analysis_date: day,
      analysts: z.array(z.enum(['market', 'sentiment', 'news', 'fundamentals'])).optional().describe('Only these analysts; the settings\' when left out'),
      debate_rounds: z.number().int().min(1).max(5).optional().describe('Rounds of bull and bear; the settings\' when left out'),
      risk_rounds: z.number().int().min(1).max(5).optional().describe('Rounds of the three risk voices; the settings\' when left out'),
      language: z.string().max(40).optional().describe('Report language, e.g. Spanish; the settings\' when left out'),
      restart: z.boolean().optional().describe('Throw away an earlier unfinished run of this stock and day and start over'),
    },
    annotations: write,
  }, async (a) => act(() => {
    const w = wsFor(a.symbol, analysisDate(a.analysis_date));
    return (w.sweep ? `[Backtest sweep ${w.sweep}: this run is recorded in the sweep's own journal, not the live one.]\n` : '') + renderPlan(buildPlan(root, { symbol: a.symbol, analysisDate: a.analysis_date, analysts: a.analysts, debateRounds: a.debate_rounds, riskRounds: a.risk_rounds, language: a.language, restart: a.restart }, w));
  }));

  server.registerTool('save_run_section', {
    title: 'Save a run section',
    description: `Save what you wrote for your step of an analysis, so the next agent reads it from the desk and a stopped run can resume. section is one of ${SECTIONS.join(', ')}. A debate turn (bull, bear, aggressive, conservative, neutral) is added; any other section replaces the earlier text.`,
    inputSchema: { symbol, analysis_date: day, section: z.enum(SECTIONS), text: z.string().min(1).max(60_000) },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), turns = saveSection(wsFor(a.symbol, d).dir, a.symbol, d, a.section, a.text);
    return `Saved ${a.section} for ${safeSymbol(a.symbol)} on ${d} (${turns > 1 ? `turn ${turns}` : 'one text'}).`;
  }));

  server.registerTool('correct_report', {
    title: "Correct an analyst's report",
    description: 'The fact checker\'s corrections to an analyst\'s report (market, sentiment, news or fundamentals), made by the desk word for word before the debate begins. Each correction gives the report\'s exact old words and the right ones: the desk replaces them where they stand and keeps the old words beside them as [corrected: was "..."]. Correcting a correction\'s new words back to the analyst\'s own takes it back: the mark goes. flag_after names the exact words that end a conclusion resting on a corrected fact; the desk adds a note after them. Nothing else in the report changes, so never save a corrected report yourself. Words found more than once need more of the words around them, or every set to true to correct them all. It answers line by line what was done and what was not, and why.',
    inputSchema: {
      symbol, analysis_date: day,
      section: z.enum(['market', 'sentiment', 'news', 'fundamentals']),
      corrections: z.array(z.object({
        was: z.string().min(1).max(2000).describe('The report\'s words, exactly as it has them'),
        now: z.string().min(1).max(2000).describe('The right words, from a tool result'),
        every: z.boolean().optional().describe('Correct every place these words appear'),
      })).max(60),
      flag_after: z.array(z.string().min(1).max(500)).max(20).optional().describe('The exact words ending each conclusion that rested on a corrected fact'),
    },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), lines = correctSection(wsFor(a.symbol, d).dir, a.symbol, d, a.section, a.corrections, a.flag_after);
    return [`The ${a.section} report for ${safeSymbol(a.symbol)} on ${d}:`, ...lines].join('\n');
  }));

  server.registerTool('read_run', {
    title: 'Read a run',
    description: `Read what the team has written so far for a stock and day. Without sections it lists which sections exist and how many turns each holds. With sections it returns their text; ${DEBATES.join(' and ')} give a whole debate in the order spoken. A section not written yet is said to be missing, never blank. ${CONTEXT.join(' and ')} give what the plan saved with the run: what the person holds (or that none are saved) and the lessons from past calls. Ask for everything you need in one call: a read longer than ${PART_CHARS.toLocaleString('en-US')} characters comes in parts, cut between sections and turns, and its first part says what each part holds; read each part once, with the same sections and part 2, 3 and so on.`,
    inputSchema: {
      symbol, analysis_date: day, sections: z.array(z.enum([...SECTIONS, ...DEBATES, ...CONTEXT])).optional(),
      part: z.number().int().min(1).max(50).optional().describe('Which part of a read that comes in parts; 1 when left out'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), w = wsFor(a.symbol, d);
    if (a.sections?.length) return readPart(w.dir, a.symbol, d, a.sections, a.part ?? 1, () => runContext(root, w, safeSymbol(a.symbol), d));
    const p = progress(w.dir, a.symbol, d);
    return Object.keys(p).length ? `Written so far for ${safeSymbol(a.symbol)} on ${d}: ${Object.entries(p).map(([k, n]) => `${k} (${n})`).join(', ')}` : `Nothing written yet for ${safeSymbol(a.symbol)} on ${d}.`;
  }));

  server.registerTool('write_report', {
    title: 'Write the report',
    description: 'Assemble the finished report of an analysis from everything the team saved - the analysts, the debates, the manager, the trader, the risk voices, the decision - into one markdown page in the run\'s folder. Returns where it is. Call it after the portfolio manager\'s decision is saved.',
    inputSchema: { symbol, analysis_date: day },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol), w = wsFor(sym, d), plan = savedPlan(w.dir, sym, d) as Plan | undefined;
    if (!progress(w.dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const rating = parseRating(readSections(w.dir, sym, d, ['decision']));
    const header = [`Rating: ${rating}`, `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`];
    if (plan?.analysts) header.push(`Analysts: ${plan.analysts.join(', ')}; research debate rounds ${plan.debateRounds}, risk debate rounds ${plan.riskRounds}; language ${plan.language}`, `Scored: ${scoredWords(plan)}`);
    const file = writeReport(w.dir, sym, d, header);
    return `Report written: ${file}\nRating: ${rating}`;
  }));

  server.registerTool('record_decision', {
    title: 'Record the decision',
    description: 'Put the portfolio manager\'s saved decision in the journal as a pending call, with the window and yardstick it will be scored by (the plan\'s), so a later change to the settings never re-scores it. It is scored once a scoring runs after that window (/settle, an analysis or a routine): a short first check, not the call\'s own time horizon. The text is the one saved in the run, so the journal always matches the report. One call per stock and day: a repeat is ignored. The rating kept is the one the decision\'s words state: a rating passed that differs from it is refused, and a decision whose words state none is recorded as Needs review.',
    inputSchema: { symbol, analysis_date: day, rating: z.enum(RATINGS).optional() },
    annotations: write,
  }, async (a) => act(() => {
    const d = analysisDate(a.analysis_date), sym = safeSymbol(a.symbol), w = wsFor(sym, d);
    const decision = readSections(w.dir, sym, d, ['decision']);
    if (!progress(w.dir, sym, d)['decision']) throw new Error(`the portfolio manager's decision is not saved yet for ${sym} on ${d}`);
    const body = decision.replace(/^## [^\n]*\n/, '');
    // The window and yardstick the plan gave this run; a run planned before the desk kept them gets the settings' now.
    const rules: Rules = (savedPlan(w.dir, sym, d) as Plan | undefined)?.window ?? rulesFor(sym, readSettings(root).scoring);
    // Recorded now: the paper record follows a call only from when it was made (an analysis dated in the past is not).
    const r = journalOf(root, w).storeDecision(sym, d, body, a.rating ?? undefined, rules, new Date());
    const rating = parseRating(body);
    return r === 'stored' ? `Recorded: ${sym} on ${d}, ${rating}, pending. It will be scored as ${checkWords(sym, rules)}, kept with the call so a later change to the settings does not change it. It is not the call's own time horizon. ${WHEN_SCORED} Until then it stays pending: for the ${windowWords(rules)} after the call, and after them until a scoring runs.` : `${sym} on ${d} is already in the journal; nothing changed.`;
  }));

  server.registerTool('list_settlements', {
    title: 'Pending calls',
    description: 'List the calls in the journal that are not settled yet. For each whose scoring window has passed (the window kept with the call: a short first check, not the call\'s own time horizon), it shows the measured outcome (return, its yardstick\'s return, alpha), the decision, and what happened in the window day by day (the stock\'s prices, volume and main indicators beside the yardstick\'s close), so you can write the lesson from what happened; the others are marked NOT YET. A call record_outcome failed to settle twice in this scoring is LEFT: named, not shown, and left pending. The figures come from price rows only.',
    inputSchema: { symbol: symbol.optional(), sweep_id: sweepArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a) => act(() => dueSettlements(journalOf(root, scored(a.sweep_id)), readSettings(root).scoring, a.symbol ? safeSymbol(a.symbol) : undefined)));

  server.registerTool('record_outcome', {
    title: 'Settle a call',
    description: 'Settle one pending call whose window has finished: the desk measures the outcome again itself and keeps it with your lesson. Give only the lesson - 2 to 4 plain sentences (the desk counts them and refuses more than 4) naming what the alpha shows, what part of the thesis it supports or undercuts, and one thing to do next time. The row marked "entry" is the close the call is scored from, not a session of the window. Say what happened in the window only as its rows from list_settlements show it, naming the day; never pass or invent a number. Failing a second time for the same call in this scoring, it answers LEFT: leave that call pending and go on. The same call sent again after that with no call settled since answers STOP: leave it too.',
    // The desk checks the length itself (under 1200 characters), so a refusal is counted and said in plain words: one
    // refused by these input rules never reaches it, and could be sent round again and again.
    inputSchema: { symbol, trade_date: day, lesson: z.string().max(8000).describe('The lesson: 2 to 4 plain sentences, under 1200 characters'), sweep_id: sweepArg },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (a) => act(() => settleOne(journalOf(root, scored(a.sweep_id)), readSettings(root).scoring, safeSymbol(a.symbol), a.trade_date, a.lesson)));

  server.registerTool('recheck_lessons', {
    title: 'Lessons to re-check',
    description: 'Find the settled calls whose lesson was not written from the holding window\'s prices (written before the desk showed them, when they could not be had, or marked unreliable before), or that the person said is wrong (flag_lesson). Up to three at a time are shown to rewrite: the call\'s score and its yardstick\'s return over the same days, which stay as they are, the decision, the lesson as it stands, what the person said is wrong (for a flagged one), and the window\'s entry and finished sessions day by day; call again once those are saved for the next ones. A call whose window\'s prices cannot be had is marked unreliable by the desk itself, so later analyses stop reading its lesson. A lesson correct_lesson refused twice in this re-check is LEFT, named but not shown; the same lessons asked for again with nothing saved since answer STOP. With nothing left to rewrite, its last words say what a later re-check does. Never changes a call, its rating or its score.',
    inputSchema: { symbol: symbol.optional() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (a) => act(() => lessonsToRecheck(journalOf(root, live()), readSettings(root).scoring, a.symbol ? safeSymbol(a.symbol) : undefined)));

  server.registerTool('correct_lesson', {
    title: 'Correct a lesson',
    description: 'Replace the lesson of a call recheck_lessons listed TO REWRITE with one rewritten from its window\'s rows alone: 2 to 4 plain sentences, as for record_outcome (the desk counts them and refuses more than 4). what_was_wrong sorts each statement of the lesson as it stands under three labels, in this order: "Contradicted:" (each quoted, with the row\'s date and figure that shows otherwise), "Not known from the prices:" (each quoted) and "Right:" (the rest), with "none" under a label with nothing in it. The desk fetches the rows again first: if they cannot be had, nothing is saved and the lesson is marked unreliable (one the person flagged stays flagged). It keeps the first lesson word for word beside the new one, and any corrected lesson it replaces with its check, marked as corrected, and never touches the call, its rating or its score. A lesson written from the prices or corrected already is refused unless the person flagged it. Refused a second time for the same lesson in this re-check, it answers LEFT: leave that lesson and go on. The same lesson sent again after that with no lesson saved since answers STOP: leave it too. Never pass or invent a number the rows do not show.',
    // The desk checks the lengths itself (under 1200 and 900 characters), so a refusal is counted and said in plain words:
    // one refused by these input rules never reaches it, and could be sent round again and again.
    inputSchema: {
      symbol, trade_date: day,
      lesson: z.string().max(8000).describe('The new lesson: 2 to 4 plain sentences, under 1200 characters'),
      what_was_wrong: z.string().max(8000).describe('Contradicted: ... Not known from the prices: ... Right: ...; under 900 characters'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (a) => act(() => correctLesson(journalOf(root, live()), readSettings(root).scoring, safeSymbol(a.symbol), a.trade_date, a.lesson, a.what_was_wrong)));

  server.registerTool('flag_lesson', {
    title: 'Flag a lesson as wrong',
    description: 'Only on the person\'s own word in this conversation, after they confirmed it: they named the stock, the call\'s date and what is wrong with its lesson (their words, or a review\'s finding they pass on). Never because a check of yours, or of any member, found something: tell the person that instead, and let them decide. Marks that settled call\'s lesson as wrong by the person: later analyses stop reading it at once, and recheck_lessons lists it again to rewrite from its window\'s prices, with what the person said. Nothing is removed: its words, its check, its earlier corrections and its first lesson stay in the journal; the call, its rating and its score never change. Call it once for each lesson: one flagged already answers ALREADY FLAGGED and nothing is written.',
    inputSchema: {
      symbol, trade_date: day,
      what_is_wrong: z.string().max(8000).describe('What the person said is wrong with this lesson, in their words; under 900 characters'),
      confirmed: z.literal(true).describe('true: the person said in words, in this conversation, that this lesson is wrong, and confirmed flagging it'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async (a) => act(() => flagLesson(journalOf(root, live()), safeSymbol(a.symbol), a.trade_date, a.what_is_wrong)));

  server.registerTool('start_backtest', {
    title: 'Start a backtest sweep',
    description: 'Lay out a backtest: the team is run over every stock on every date from start to end (every few days) and the calls are scored later, each over its short first window against its yardstick, as a live call is. From now until end_backtest each of its cells (its stocks on its dates) is recorded in this sweep\'s own journal and runs, whichever conversation or member works on it; everything else stays on the live desk, so the live journal, its scoring and its lessons are untouched and the person\'s other analyses go on beside it. Score its calls with list_settlements and record_outcome given its sweep_id. Repeat the call with the same sweep_id to resume: cells already recorded are skipped. Every cell is a full team run, so tell the person the number of cells before running any.',
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
      `From now until end_backtest each of these cells is recorded in this sweep's own journal and runs; everything else stays on the live desk, whose journal and lessons are untouched. Score this sweep's calls with list_settlements and record_outcome given sweep_id ${id}.`,
      '', `Cells to run, in order (${todo.length ? 'each is a full team run' : 'none left'}):`,
      ...todo.slice(0, 30).map((c, i) => `${i + 1}. ${c.symbol} ${c.date}`), ...(todo.length > 30 ? [`... and ${todo.length - 30} more`] : []),
      '', "Limits to tell the person: for a past date the desk reads only what was out by then, but not all of it as it stood then. A US company's accounts, profile and insider trades, and a US fund's holdings, are its SEC filings as made public by that date; economic figures are those released by then, at today's revised values; prices and indicators are adjusted for every split and dividend since, so before a split they read as a fraction of the price traded then; news, posts and odds exist only for recent days, so those reads are thin or unavailable and say so. Results are indicative, not repeatable.",
    ].join('\n');
  }));

  server.registerTool('end_backtest', {
    title: 'End the backtest sweep',
    description: 'End the backtest sweep this conversation started, named by the sweep_id start_backtest gave it, once it has run and been scored (or the person said to stop it): from now on its cells are recorded on the live desk again. The sweep and its results stay on disk. Never end a sweep this conversation did not start.',
    inputSchema: { sweep_id: z.string().max(40).describe('The sweep to end: the sweep_id start_backtest gave this conversation') },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    // Ending names the sweep, so a routine or another chat, which is never given its id, cannot end it by mistake.
    const was = getSweep();
    if (!was) return 'No backtest was running; the desk is on the live journal.';
    if (was !== a.sweep_id) return `NOT ENDED: the backtest running is not ${a.sweep_id}. Only the conversation that started it ends it, with the sweep_id start_backtest gave it; it also ends by itself after two hours with no work on its cells. Nothing was changed.`;
    setSweep(null);
    return `Backtest sweep ${was} ended. The desk is back on the live journal.`;
  }));

  server.registerTool('backtest_summary', {
    title: 'Backtest results',
    description: 'Score a sweep\'s settled calls by rating: how many, how often the direction was called right (not for Hold, which claims none), and the mean alpha against each call\'s yardstick over its first window (the summary names them), not over the calls\' own time horizons. Calls whose window has not traded are pending; calls with no readable rating are unscored. Report the figures as they are and say that a few calls prove nothing.',
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

  server.registerTool('routine_brief', {
    title: "Today's routine",
    description: "What the morning routine should do today (on a day New York's market is closed, a weekend or one of its holidays, only score past calls; otherwise score past calls; on a Monday, or the Tuesday after a Monday holiday, re-rate the holdings whose view is a week old; \"Worth a look today\", the same list the dashboard shows, worked out from prices if it was not this hour; then the stocks to analyse in order, within the person's limit) or what the evening wrap-up has to report (today's calls, the orders the dashboard sent and Robinhood's answer, any holding whose last close is below the stop the desk's trader proposed, since the dashboard warns of a stop only while its page is open, and what is still to be scored). It changes nothing but the waiting list: on a Monday (the Tuesday after a Monday holiday), up to three holdings with no view or one a week old or more go on it at shallow depth, once that week; and with the person's switch \"Analyse the top three each market morning\" on, the top three of the list go on it at shallow depth, once a market day. Call it first when asked to run the morning routine or the evening wrap-up.",
    inputSchema: { kind: z.enum(['morning', 'evening']).describe('morning: before the open; evening: after the close') },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => act(async () => {
    const day = today();
    if (a.kind === 'evening') {
      let stops: Parameters<typeof eveningBrief>[3];
      try { stops = await stopsAtClose(dir, day, (sym) => lastClose(sym, day)); } catch (e) { stops = { state: 'failed', why: (e as Error).message }; }
      return eveningBrief(dir, day, new Date(), stops);
    }
    const on = readPrefs(dir).morning === true, open = isMarketDay(day);
    let look: MorningLook | undefined;
    if (open) {
      try { rerateWeekly(dir, day); } catch { /* the brief says the holdings due were not put on the list */ }   // Monday's re-rating first: what is held comes before what is worth a look
      try {
        const { symbols, news } = screenUniverse(readWatchlist(dir), marketOf(dir));
        const worked = await screenToday(dir, symbols, news, day);
        if (on) queueTop(dir, worked, day, false, new Date(), readPrefs(dir).morningFrom);   // the routine analyses what waits itself: no doorbell
        look = { screen: readScreen(dir) ?? worked, on };
      } catch (e) { look = { screen: null, failed: (e as Error).message, on }; }
    }
    return morningBrief(dir, day, readSettings(root).routines.maxAnalyses, look, { now: new Date() });
  }));

  server.registerTool('open_dashboard', {
    title: 'Open the dashboard',
    description: "Start the Trading Agents dashboard on this computer and open it in the person's browser, or open the one already running. Use when the person asks to see the dashboard, their accounts, the markets or the desk's calls. It only starts the page; everything on it, Robinhood and any order included, is the person's own to press.",
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => act(() => openDashboard(root)));

  // The waiting list: the stocks the person asked for on the dashboard, and those Monday's re-rating and the morning switch
  // put there. A run takes them one at a time, in order, up to the
  // routines' limit: start_queue_item marks one running (one at a time, whoever started the run), finish_queue_item marks
  // it done with the rating recorded or failed with why, and end_queue_run asks for another run when stocks still wait.
  // Which run asks: this copy of the desk's tools, one per conversation. A launcher may give its run an id (each
  // copy its run starts shares it); any other conversation's copy makes its own. With its process, it is noted on each
  // stock this run starts, so a second run never takes it and only its own run's end finishes it.
  const given = process.env.TRADING_AGENTS_RUN;
  const me: Runner = { runner: given && RUNNER_ID.test(given) ? given : `tools-${randomUUID().slice(0, 8)}`, pid: process.pid };
  const perRun = () => readSettings(root).routines.maxAnalyses;
  const depthWords = (d: Depth | undefined) => (d ? `${d} (debate_rounds ${DEPTHS[d]} and risk_rounds ${DEPTHS[d]})` : "the settings' depth (leave the rounds out)");
  const called = (sym: string, d: string) => new Journal(path.join(dir, 'journal.md')).load().find((e) => e.ticker === sym && e.date === d);
  const queueAct = (run: () => string) => act(() => { try { return run(); } catch (e) { if (e instanceof QueueRefusal) return `${e.code}: ${e.message}.`; throw e; } });

  server.registerTool('read_queue', {
    title: 'The waiting list',
    description: 'The waiting list: the stocks the person asked the desk to analyse on the dashboard, and those Monday\'s re-rating and the morning switch put on it. It gives those waiting, in the order to run them, each with the depth asked, any being analysed now, and how many one run may analyse. /analyse with no ticker runs them. Read-only.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => act(() => {
    const list = readQueue(dir), waiting = waitingIn(list), running = list.find((i) => i.state === 'running');
    const lines: string[] = [], since = `started ${running?.startedAt?.slice(11, 16) ?? '?'} UTC`, another = !!running && byAnother(running, me);
    // Another run's stock: this run stops, and asks for no other run, which would only find the same and stop (a loop).
    if (running && another) lines.push(`Being analysed now by another run: ${running.symbol} (${since}). One stock runs at a time: stop this run and say so. Do not call end_queue_run: the run analysing ${running.symbol} asks for the next run itself when it finishes.`);
    if (running && !another) lines.push(`Being analysed now by this run: ${running.symbol} (${since}). Finish it with finish_queue_item (done once its call is recorded, or failed with why) before starting another.`);
    if (!waiting.length) {
      const doneN = list.filter((i) => i.state === 'done').length, failedN = list.filter((i) => i.state === 'failed').length;
      const kept = [doneN ? `${doneN} done` : '', failedN ? `${failedN} failed (the person presses Retry on the dashboard to ask again)` : ''].filter(Boolean).join(' and ');
      lines.push(!list.length ? 'Nothing is waiting: the list is empty.'
        : `Nothing ${running ? 'else ' : ''}is waiting.${kept ? ` The list also keeps finished analyses for the person to see, ${kept}: none of them needs a run.` : ''}`);
    } else if (another) {
      lines.push(`Waiting behind it, left to that run: ${waiting.map((i) => i.symbol).join(', ')}.`);
    } else {
      lines.push(`${waiting.length} waiting, in the order to run them; one run analyses at most ${perRun()}:`);
      waiting.forEach((i, n) => lines.push(`${n + 1}. ${i.symbol}, depth ${depthWords(i.depth)}, asked ${i.requestedAt.slice(0, 16).replace('T', ' ')} UTC`));
      lines.push('For each, in order: start_queue_item, the analysis, then finish_queue_item. At the end, end_queue_run.');
    }
    return lines.join('\n');
  }));

  server.registerTool('start_queue_item', {
    title: 'Start a waiting analysis',
    description: 'Mark a stock from the waiting list as being analysed now, before its analysis starts, so the dashboard shows it running. It answers the date and the debate rounds to plan with. BUSY means another run is analysing a stock: stop this run, without end_queue_run. ALREADY means it was called today: it is marked done, take the next. NOT STARTED means it cannot run now (it says why, and it is marked failed with that reason): take the next.',
    inputSchema: { symbol },
    annotations: write,
  }, async (a) => queueAct(() => {
    const sym = safeSymbol(a.symbol), d = today(), done = called(sym, d);
    if (done) { finishItem(dir, sym, { rating: done.rating, already: true }, new Date(), me); return `ALREADY: ${sym} was already called today (${done.rating}); it is marked done. Take the next.`; }
    // A backtest whose cells include this stock today would record the analysis in its own journal, not the person's.
    const sweep = sweepOfCell(sym, d);
    if (sweep && readQueue(dir).find((i) => i.symbol === sym)?.state === 'waiting') {
      finishItem(dir, sym, { reason: `A backtest that includes ${sym} on ${d} is running, so an analysis now would be recorded in the backtest, not in the desk's journal: press Retry once it has ended.` }, new Date(), me);
      return `NOT STARTED: ${sym} on ${d} is a cell of the backtest sweep ${sweep}, which is running, so its analysis would be recorded in the sweep, not the live journal. It is marked failed with why; the person presses Retry once the backtest has ended. Take the next.`;
    }
    const item = startItem(dir, sym, d, new Date(), me);
    return `START: ${sym} is marked as being analysed. Plan it with analysis date ${d}, depth ${depthWords(item.depth)}. When its call is recorded, call finish_queue_item; if it cannot be finished, call finish_queue_item with failed_because.`;
  }));

  server.registerTool('finish_queue_item', {
    title: 'Finish a waiting analysis',
    description: 'Mark a stock from the waiting list as done once its call is recorded (the rating is taken from the journal), or as failed with failed_because: one plain sentence the person reads on the dashboard, saying what went wrong and what to do.',
    inputSchema: { symbol, failed_because: z.string().min(3).max(300).optional() },
    annotations: write,
  }, async (a) => queueAct(() => {
    const sym = safeSymbol(a.symbol);
    const item = readQueue(dir).find((i) => i.symbol === sym), late = item?.quiet ? ` It had read as failed, because nothing was saved for it for two hours; this run's word replaces that.` : '';
    if (item?.state === 'running' && item.runner && byAnother(item, me)) return `BUSY: ${sym} is being analysed by another run: only that run finishes it. Stop this run and say so, without end_queue_run.`;
    if (a.failed_because) { finishItem(dir, sym, { reason: a.failed_because }, new Date(), me); return `Marked failed: ${sym}. The person sees why on the dashboard and can press Retry.${late}`; }
    const call = called(sym, item?.date ?? today());
    if (!call) throw new Error(`no call for ${sym} on ${item?.date ?? today()} is recorded yet: call record_decision first, or pass failed_because`);
    finishItem(dir, sym, { rating: call.rating }, new Date(), me);
    return `Marked done: ${sym}, ${call.rating}. The dashboard shows it.${late}`;
  }));

  server.registerTool('end_queue_run', {
    title: 'End a run of the waiting list',
    description: 'Call once when a run of the waiting list stops. A stock this run started and left unfinished is marked failed. If stocks are still waiting (the run reached its limit, or stopped early), it asks whoever listens on this computer for another run, unless another run is analysing a stock: that run asks when it finishes. Answers one line to end the run with.',
    annotations: write,
  }, async () => act(() => {
    const now = new Date(), left = readQueue(dir, now).find((i) => i.state === 'running' && !byAnother(i, me));
    if (left) finishItem(dir, left.symbol, { reason: 'The run analysing it ended before it was finished, without saying why: press Retry to ask again.' }, now, me);
    const list = readQueue(dir), waiting = waitingIn(list).length, other = list.find((i) => i.state === 'running');
    const doneN = list.filter((i) => i.state === 'done').length, failedN = list.filter((i) => i.state === 'failed').length;
    const tally = `On the dashboard's list: ${doneN} done, ${failedN} failed.`, mine = left ? `Marked failed: ${left.symbol}, which this run left unfinished without saying why. ` : '';
    if (other) return `${mine}${other.symbol} is being analysed by another run, which asks for the next run itself when it finishes: no run was asked for here. ${waiting ? `${waiting} still waiting.` : 'Nothing else is waiting.'} ${tally}`;
    if (waiting) ringDoorbell(dir, 'more');
    return `${mine}${waiting ? `${waiting} still waiting: another run was asked for.` : 'Nothing is waiting.'} ${tally}`;
  }));

  server.registerTool('set_holdings', {
    title: 'Save what the person holds',
    description: 'Save the positions and free cash the person tells you they hold, so the trader and risk voices size against their real book. Pass exactly what they said; never guess. An empty list of positions means they hold nothing (a flat book) - different from not having said, which is the default.',
    inputSchema: {
      positions: z.array(z.object({ ticker: z.string().min(1).max(20), quantity: z.number(), average_price: z.number().optional() })).max(500),
      cash: z.number().optional(), currency: z.string().length(3).optional().describe('e.g. USD'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => act(() => {
    const h = saveHoldings(dir, { cash: a.cash, currency: a.currency, positions: a.positions.map((p) => ({ ticker: p.ticker, quantity: p.quantity, averagePrice: p.average_price })) }, today());
    return h.positions.length ? `Saved ${h.positions.length} position(s)${h.cash !== undefined ? ` and cash ${h.cash}` : ''}.` : `Saved: the person holds nothing${h.cash !== undefined ? `, with cash ${h.cash}` : ''}.`;
  }));

  server.registerTool('clear_holdings', {
    title: 'Forget what the person holds',
    description: 'Forget the saved holdings, so the desk goes back to not knowing what the person holds. Use when they ask to; it is not the same as holding nothing.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async () => act(() => (forgetHoldings(dir) ? 'Forgotten: the desk no longer knows what the person holds.' : 'Nothing was saved.')));

}
