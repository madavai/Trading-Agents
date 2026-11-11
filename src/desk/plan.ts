// The plan for one analysis, drawn up before any agent speaks: the stock and what kind of instrument it is, which analysts
// run (a crypto asset or index has no company accounts), how many debate rounds, the language, the window and yardstick
// the call will be scored by (kept in its journal entry when it is recorded), what the person holds, the lessons from past
// calls - and, for a run that stopped half way, the next step.
// Every number and rule here is code; the agents only follow the plan.
import { analysisDate, isHistorical } from '../data/dates.js';
import { cryptoBase, safeSymbol } from '../data/symbols.js';
import { ASK_FOR_EMAIL, readContactEmail } from '../contact.js';
import { ANALYSTS, languageName, readSettings, type Analyst } from '../settings.js';
import { deskDataDir } from '../paths.js';
import { type Journal } from './journal.js';
import { journalIn, workspaceOf, type Workspace } from './workspace.js';
import { BACKTEST_HOLDINGS, readHoldings, renderHoldings } from './holdings.js';
import { builtOnOf, deleteRun, hasReport, progress, runDates, saveContext, savedPlan, startRun, type BuiltOn, type RunContext, type Section } from './runs.js';
import { addDays } from '../data/dates.js';
import { DEPTHS, readQueue } from './queue.js';
import { againstWords, checkName, rulesFor, windowWords, type Rules } from './scoring.js';

export class NeedsEmail extends Error { override name = 'NeedsEmail'; }

export interface Step { section: Section; turn: number; done: boolean }
export interface Plan {
  symbol: string; analysisDate: string; kind: 'stock' | 'crypto' | 'other';
  analysts: Analyst[]; debateRounds: number; riskRounds: number; language: string; managerModel: string;
  benchmark: string; holdingDays: number; steps: Step[]; notes: string[];
  /** The window and yardstick the call is scored by; a plan saved before the desk kept them has none. */
  window?: Rules;
  /** The desk's earlier full run this one builds on, and the analysts who write what changed since it; none for a full run. */
  builtOn?: BuiltOn;
}

/** `full`: a full run, even when the desk has a recent full run of the stock to build on (the person asked for one). */
export interface PlanRequest { symbol: string; analysisDate: string; analysts?: string[]; debateRounds?: number; riskRounds?: number; language?: string; restart?: boolean; full?: boolean }

const ANALYST_SECTION: Record<Analyst, Section> = { market: 'market', sentiment: 'sentiment', news: 'news', fundamentals: 'fundamentals' };

/** The journal of the live desk, or of the sweep being run. */
export const journalOf = (root: string, ws: Workspace = workspaceOf(root)): Journal => journalIn(root, ws);

function kindOf(raw: string, symbol: string): Plan['kind'] {
  if (cryptoBase(raw)) return 'crypto';
  return /[\^=]/.test(symbol) ? 'other' : 'stock';
}

/** Lays out the steps in the order the team works: analysts, then bull and bear in turn, the research manager, the trader,
 *  the three risk voices in turn, the portfolio manager. */
export function stepsFor(analysts: Analyst[], debateRounds: number, riskRounds: number): Array<Omit<Step, 'done'>> {
  const steps: Array<Omit<Step, 'done'>> = analysts.map((a) => ({ section: ANALYST_SECTION[a], turn: 1 }));
  // The fact checker corrects the analysts' reports before anyone argues from them.
  steps.push({ section: 'fact_check', turn: 1 });
  for (let t = 1; t <= debateRounds; t++) steps.push({ section: 'bull', turn: t }, { section: 'bear', turn: t });
  steps.push({ section: 'research_plan', turn: 1 }, { section: 'trader', turn: 1 });
  for (let t = 1; t <= riskRounds; t++) steps.push({ section: 'aggressive', turn: t }, { section: 'conservative', turn: t }, { section: 'neutral', turn: t });
  steps.push({ section: 'decision', turn: 1 });
  return steps;
}

/** Whether a run builds on an earlier one, and why not when it does not. Only today's own analyses do, never a backtest
 *  or a past day (a backtest measures the whole desk, and a past day must not lean on a run made after it). The run built
 *  on is the stock's latest full run (never one that built on another: a chain grows and cannot be checked) from the
 *  `days` before this one, finished (its report written), fact-checked, and in the same language. An analyst it has no
 *  report of writes in full; when it has none of this run's analysts, the run is full. */
export function earlierRunFor(dir: string, o: { symbol: string; day: string; analysts: Analyst[]; language: string; days: number; sweep: boolean; full?: boolean }): { builtOn?: BuiltOn; why: string } {
  if (o.full) return { why: 'a full run was asked for' };
  if (o.sweep) return { why: 'a backtest analyses every day in full' };
  if (isHistorical(o.day)) return { why: 'a past day is analysed in full' };
  if (o.days <= 0) return { why: "the desk's settings make every analysis a full run (buildOnEarlierDays 0)" };
  const from = addDays(o.day, -o.days);
  for (const date of runDates(dir, o.symbol)) {
    if (date >= o.day) continue;
    if (date < from) break;
    const plan = savedPlan(dir, o.symbol, date) as Partial<Plan> | undefined, done = progress(dir, o.symbol, date);
    if (!plan || builtOnOf(plan) || !hasReport(dir, o.symbol, date) || !done.decision || !done.fact_check || plan.language !== o.language) continue;
    const analysts = o.analysts.filter((a) => (done[ANALYST_SECTION[a]] ?? 0) > 0).map((a) => ANALYST_SECTION[a]);
    if (analysts.length) return { builtOn: { date, analysts }, why: '' };
  }
  return { why: `the desk has no full, finished and fact-checked run of ${o.symbol} in ${o.language} from the ${o.days} days before ${o.day}` };
}

/** What the decision agents work from besides the reports, drawn up as the plan gives it: the person's holdings (in a
 *  backtest, none: what they hold now was not known on the days it tests) and the lessons from past calls. */
export function runContext(root: string, ws: Workspace, symbol: string, day: string): RunContext {
  const scoring = readSettings(root).scoring;
  // An analysis of today also sees the desk's own latest calls on the stock that are not scored yet; a past day does not
  // (a call made after it), nor does a backtest's day, which is always a past one.
  const lessons = journalOf(root, ws).pastContext(symbol, isHistorical(day) ? { asOf: day, scoring } : { scoring, unscoredBefore: day });
  return {
    holdings: ws.sweep ? BACKTEST_HOLDINGS : renderHoldings(readHoldings(deskDataDir(root)), symbol),
    lessons: lessons ? `Lessons from past calls:\n${lessons}` : 'Lessons from past calls: none yet (no earlier call has been settled).',
  };
}

/** `fullWhy`: why the run is full, for the plan's line (empty when it builds on an earlier run). */
export function buildPlan(root: string, req: PlanRequest, ws: Workspace = workspaceOf(root)): RunContext & { plan: Plan; resumed: boolean; fullWhy: string } {
  if (!readContactEmail(root)) throw new NeedsEmail(ASK_FOR_EMAIL);
  const s = readSettings(root), dir = ws.dir;
  const symbol = safeSymbol(req.symbol), day = analysisDate(req.analysisDate), notes: string[] = [];
  const kind = kindOf(req.symbol, symbol);
  if (req.restart) deleteRun(dir, symbol, day);

  // A run that stopped half way is resumed as it was planned, so changed settings cannot shift its steps under it.
  const done = progress(dir, symbol, day), saved = savedPlan(dir, symbol, day) as Partial<Plan> | undefined;
  const resumed = Object.keys(done).length > 0 && !!saved?.analysts;
  let analysts: Analyst[], debateRounds: number, riskRounds: number, language: string, reRounded = false;
  // A stock asked for on the dashboard runs at the depth the person chose there (a request from before depths: the
  // settings'), whatever rounds the lead asks for: the time and the model allowance it spends are the person's.
  const asked = ws.sweep ? undefined : readQueue(dir).find((i) => i.symbol === symbol && i.state === 'running' && i.date === day);
  const askedRounds = (): [number, number] => (asked?.depth ? [DEPTHS[asked.depth], DEPTHS[asked.depth]] : [s.analysis.debateRounds, s.analysis.riskRounds]);
  const askedWords = () => (asked?.depth ? `${asked.depth} depth` : "the settings' depth");
  if (resumed) {
    ({ analysts, debateRounds, riskRounds, language } = saved as Plan);
    notes.push(`Resuming the run started earlier for ${symbol} on ${day}, with its original plan (${analysts.join(', ')}; ${debateRounds} debate and ${riskRounds} risk round(s); ${language}). To start over, plan again with restart.`);
    // Its steps stay as planned, but its rounds are the depth the person asked for now: a stopped deep run asked for again
    // at Shallow resumes at Shallow, spending what the person chose.
    const [d, r] = asked ? askedRounds() : [debateRounds, riskRounds];
    if (d !== debateRounds || r !== riskRounds) {
      notes.push(`${symbol} was asked for again on the dashboard at ${askedWords()}, so the run resumes with ${d} debate and ${r} risk round(s), not the ${debateRounds} and ${riskRounds} it started with.`);
      debateRounds = d; riskRounds = r; reRounded = true;
    }
  } else {
    if (req.analysts) {
      const unknown = req.analysts.filter((a) => !(ANALYSTS as readonly string[]).includes(a));
      if (unknown.length) throw new Error(`unknown analyst ${unknown.join(', ')}; choose from ${ANALYSTS.join(', ')}`);
      analysts = ANALYSTS.filter((a) => req.analysts!.includes(a));
      if (!analysts.length) throw new Error(`name at least one analyst from ${ANALYSTS.join(', ')}`);
      if (kind !== 'stock' && analysts.includes('fundamentals')) throw new Error(`the fundamentals analyst is not available for ${symbol}: a ${kind === 'crypto' ? 'crypto asset' : 'index, future or currency pair'} has no company accounts`);
    } else {
      analysts = s.analysis.analysts.filter((a) => kind === 'stock' || a !== 'fundamentals');
      if (kind !== 'stock' && s.analysis.analysts.includes('fundamentals')) notes.push(`${symbol} is ${kind === 'crypto' ? 'a crypto asset' : 'not a company'}, so there is no fundamentals analyst: it has no company accounts.`);
      if (!analysts.length) throw new Error(`none of the settings' analysts is available for ${symbol}`);
    }
    for (const [name, v] of [['debate rounds', req.debateRounds], ['risk rounds', req.riskRounds]] as const) if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= 5)) throw new Error(`${name} must be a whole number from 1 to 5`);
    debateRounds = req.debateRounds ?? s.analysis.debateRounds;
    riskRounds = req.riskRounds ?? s.analysis.riskRounds;
    if (asked) {
      const [d, r] = askedRounds();
      if ((req.debateRounds ?? d) !== d || (req.riskRounds ?? r) !== r) notes.push(`${symbol} was asked for on the dashboard at ${askedWords()}, so it runs ${d} debate and ${r} risk round(s), not the ${debateRounds} and ${riskRounds} asked for here.`);
      debateRounds = d; riskRounds = r;
    }
    if (req.language !== undefined && languageName(req.language, '') === '') throw new Error(`"${req.language}" is not a language name`);
    language = req.language !== undefined ? languageName(req.language) : s.analysis.outputLanguage;
  }

  // A run resumed keeps the window and yardstick it was planned with, like its steps, and builds on what it was planned to
  // (a run planned full stays full): its analysts may have written already.
  const window = resumed && saved?.window ? saved.window : rulesFor(symbol, s.scoring);
  const earlier = resumed ? { builtOn: builtOnOf(saved), why: 'it began as a full run, and a run resumes as it was planned' }
    : earlierRunFor(dir, { symbol, day, analysts, language, days: s.analysis.buildOnEarlierDays, sweep: !!ws.sweep, full: req.full });
  const plan: Plan = { symbol, analysisDate: day, kind, analysts, debateRounds, riskRounds, language, managerModel: s.analysis.managerModel, benchmark: window.yardstick, holdingDays: window.days, window, steps: [], notes, ...(earlier.builtOn ? { builtOn: earlier.builtOn } : {}) };
  let steps = stepsFor(analysts, debateRounds, riskRounds);
  // A run whose debate began before the desk had its fact checker goes on without one: its reports are already argued from.
  if (resumed && !done.fact_check && (done.bull ?? 0) > 0) {
    steps = steps.filter((st) => st.section !== 'fact_check');
    notes.push('Its debate began before the desk had a fact checker, so its reports go on unchecked.');
  }
  plan.steps = steps.map((st) => ({ ...st, done: (done[st.section] ?? 0) >= st.turn }));
  if (!resumed || reRounded) startRun(dir, symbol, day, plan);   // a resumed run keeps its plan, but for the rounds asked now
  // Saved with the run each time it is planned, so the agents read them from the desk, never from the lead's copy.
  const ctx = runContext(root, ws, symbol, day);
  saveContext(dir, symbol, day, ctx);
  return { plan, ...ctx, resumed, fullWhy: earlier.why };
}

/** The plan's line on what the run builds on: the earlier full run and who writes what changed since it, or why it is full. */
export function builtOnWords(p: Pick<Plan, 'analysisDate' | 'analysts' | 'builtOn'>, fullWhy: string): string {
  const b = p.builtOn;
  if (!b) return `Builds on: nothing, a full run (${fullWhy}).`;
  const full = p.analysts.filter((a) => !b.analysts.includes(ANALYST_SECTION[a]));
  return `Builds on: the desk's full run of ${b.date}. ${b.analysts.join(', ')} write what changed since then, each reading their own report of that day with read_earlier_run first${full.length ? `; ${full.join(', ')} write${full.length === 1 ? 's' : ''} in full (that run has no such report)` : ''}. The fact checker checks what they carry from it. The debate, the trader, the risk voices and the decision work from today's reports, as in every run.`;
}

/** What the call will be scored over and against, for the plan and the report's head: its first check, not its horizon. */
export const scoredWords = (p: Pick<Plan, 'symbol' | 'window' | 'holdingDays' | 'benchmark'>): string => p.window
  ? `${checkName(p.window)} ${againstWords(p.symbol, p.window)}, over the ${windowWords(p.window)} after the call, once a scoring runs after them. It is not the call's own time horizon.`
  : `after ${p.holdingDays} trading days against ${p.benchmark}`;

export function renderPlan({ plan: p, holdings, lessons, resumed, fullWhy }: ReturnType<typeof buildPlan>): string {
  const next = p.steps.find((x) => !x.done);
  const step = (x: Step) => `${x.section}${x.turn > 1 || p.steps.filter((y) => y.section === x.section).length > 1 ? ` (turn ${x.turn})` : ''}`;
  return [
    `Analysis plan for ${p.symbol} on ${p.analysisDate}${isHistorical(p.analysisDate) ? ' (a past day: use only what was known by then)' : ''}`,
    `Instrument: ${p.kind === 'stock' ? 'a stock or fund' : p.kind === 'crypto' ? 'a crypto asset, not a company' : 'an index, future or currency pair, not a company'}`,
    `Analysts: ${p.analysts.join(', ')}`,
    `Debate rounds: ${p.debateRounds} (bull and bear each speak ${p.debateRounds} time(s)); risk rounds: ${p.riskRounds} (each of the three risk voices speaks ${p.riskRounds} time(s))`,
    `Report language: ${p.language}${p.language.toLowerCase() === 'english' ? '' : ' (the labelled lines **Rating**, **Action**, **Recommendation** keep their English words)'}`,
    `Manager model: ${p.managerModel || 'the same as everyone else'}`,
    `Scored: ${scoredWords(p)}`,
    builtOnWords(p, fullWhy),
    ...(p.notes.length ? ['', ...p.notes.map((n) => `Note: ${n}`)] : []),
    '', `Steps${resumed ? ' (resuming)' : ''}: ${p.steps.map((x) => `${x.done ? '[done] ' : ''}${step(x)}`).join(' -> ')}`,
    next ? `Next step: ${step(next)}` : 'Every step is done: write the report and record the decision.',
    '', 'Saved with this run: the holdings and the lessons below. The trader, the risk voices and the portfolio manager read them from the desk themselves (read_run, sections holdings and lessons): do not copy them into their requests.',
    '', holdings,
    '', lessons,
  ].join('\n');
}
