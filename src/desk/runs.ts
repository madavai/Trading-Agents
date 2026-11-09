// A run's working record: everything each agent wrote, saved as it is written, so a run that stops half way is resumed from
// the last finished step instead of paid for again, and so the agents hand work to each other through the desk rather
// than through one long conversation. One folder per stock and day; the finished report is written from it.
// The report layout is TradingAgents' (tradingagents/reporting.py), Apache License 2.0, rewritten in TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from './lock.js';

export const SECTIONS = ['market', 'sentiment', 'news', 'fundamentals', 'fact_check', 'bull', 'bear', 'research_plan', 'trader', 'aggressive', 'conservative', 'neutral', 'decision'] as const;
export type Section = (typeof SECTIONS)[number];
/** Sections that grow a turn at a time; every other section holds one text, replaced when written again. */
const DEBATES: Record<string, readonly Section[]> = { investment_debate: ['bull', 'bear'], risk_debate: ['aggressive', 'conservative', 'neutral'] };
const TURNS = new Set<string>(Object.values(DEBATES).flat());
const MAX_CHARS = 60_000;

const LABELS: Record<Section, string> = { market: 'Market Analyst', sentiment: 'Sentiment Analyst', news: 'News Analyst', fundamentals: 'Fundamentals Analyst', fact_check: 'Fact Checker', bull: 'Bull Researcher', bear: 'Bear Researcher', research_plan: 'Research Manager', trader: 'Trader', aggressive: 'Aggressive Analyst', conservative: 'Conservative Analyst', neutral: 'Neutral Analyst', decision: 'Portfolio Manager' };
const PARTS: Array<[string, Section[]]> = [
  ['I. Analyst Team Reports', ['market', 'sentiment', 'news', 'fundamentals', 'fact_check']],
  ['II. Research Team Decision', ['bull', 'bear', 'research_plan']],
  ['III. Trading Team Plan', ['trader']],
  ['IV. Risk Management Team Decision', ['aggressive', 'conservative', 'neutral']],
  ['V. Portfolio Manager Decision', ['decision']],
];

/** What the decision agents work from besides the reports: the person's holdings and the lessons from past calls, as the
 *  plan drew them up. Saved with the run, so the trader, the risk voices and the portfolio manager read them from the desk
 *  (read_run) instead of trusting the lead to copy them into each request, and so the run shows what they were given. */
export const CONTEXT = ['holdings', 'lessons'] as const;
export type ContextName = (typeof CONTEXT)[number];
export interface RunContext { holdings: string; lessons: string }
const CONTEXT_LABELS: Record<ContextName, string> = { holdings: 'Holdings', lessons: 'Lessons' };

interface Run { ticker: string; date: string; startedAt: string; plan?: unknown; context?: RunContext & { at: string }; log: Array<{ section: Section; text: string }> }

const folder = (dir: string, ticker: string, date: string) => path.join(dir, 'runs', `${safeSymbol(ticker).replace(/\^/g, 'IDX_').replace(/=/g, '_EQ_')}_${date}`);
const runFile = (dir: string, ticker: string, date: string) => path.join(folder(dir, ticker, date), 'run.json');

function load(dir: string, ticker: string, date: string): Run {
  try { return JSON.parse(fs.readFileSync(runFile(dir, ticker, date), 'utf8')) as Run; } catch { return { ticker: safeSymbol(ticker), date, startedAt: new Date().toISOString(), log: [] }; }
}

function change(dir: string, ticker: string, date: string, edit: (r: Run) => void): Run {
  const file = runFile(dir, ticker, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => { const r = load(dir, ticker, date); edit(r); writeWhole(file, JSON.stringify(r)); return r; });
}

export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);

export function startRun(dir: string, ticker: string, date: string, plan: unknown): void { change(dir, ticker, date, (r) => { r.plan = plan; }); }

/** Keeps the holdings and lessons the plan gave, replacing older ones: a run planned again (resumed) works from the latest. */
export function saveContext(dir: string, ticker: string, date: string, ctx: RunContext): void {
  change(dir, ticker, date, (r) => { r.context = { holdings: ctx.holdings, lessons: ctx.lessons, at: new Date().toISOString() }; });
}

const contextOf = ({ context: c }: Run): RunContext | undefined =>
  (typeof c?.holdings === 'string' && typeof c.lessons === 'string' ? { holdings: c.holdings, lessons: c.lessons } : undefined);

/** The holdings and lessons saved with a run, or undefined for a run planned before the desk kept them. */
export const savedContext = (dir: string, ticker: string, date: string): RunContext | undefined => contextOf(load(dir, ticker, date));

/** Saves what an agent wrote. A debate turn is added; any other section is replaced. */
export function saveSection(dir: string, ticker: string, date: string, section: Section, text: string): number {
  const t = text.trim();
  if (!t) throw new Error('there is nothing to save: the text is empty');
  if (t.length > MAX_CHARS) throw new Error(`the text is ${t.length} characters; the most one section holds is ${MAX_CHARS}`);
  let turns = 0;
  change(dir, ticker, date, (r) => {
    if (!TURNS.has(section)) r.log = r.log.filter((e) => e.section !== section);
    r.log.push({ section, text: t });
    turns = r.log.filter((e) => e.section === section).length;
  });
  return turns;
}

export interface Correction { was: string; now: string; every?: boolean }
export const REPORTS: readonly Section[] = ['market', 'sentiment', 'news', 'fundamentals'];
export const FLAG = '[the fact it rested on was corrected: see the fact check]';
const times = (text: string, words: string) => (words ? text.split(words).length - 1 : 0);

/** The fact checker's corrections to an analyst's report, made by the desk word for word: each wrong passage is replaced
 *  where it stands with its old words kept beside it, and a conclusion that rested on one can be flagged. Nothing else
 *  in the report changes, so the checker never writes a report out again (a long report retyped by a model can lose or
 *  change words no one asked it to). Only before the debate begins: after that the reports are already argued from.
 *  Returns one line per correction and flag: done, or why not (a passage not there word for word, or there twice). */
export function correctSection(dir: string, ticker: string, date: string, section: Section, corrections: Correction[], flagAfter: string[] = []): string[] {
  if (!REPORTS.includes(section)) throw new Error(`only an analyst's report can be corrected (${REPORTS.join(', ')}), not ${section}`);
  if (!corrections.length && !flagAfter.length) throw new Error('give at least one correction or one conclusion to flag');
  const lines: string[] = [];
  change(dir, ticker, date, (r) => {
    if (r.log.some((e) => e.section === 'bull')) throw new Error('the debate has begun: the reports are already argued from, so they are no longer corrected');
    const entry = r.log.find((e) => e.section === section);
    if (!entry) throw new Error(`this run has no ${section} report to correct`);
    let t = entry.text;
    for (const c of corrections) {
      const now = c.now.trim(), n = times(t, c.was);
      if (!c.was.trim() || !now || now === c.was.trim()) lines.push(`- not applied: a correction needs the report's exact old words and different new ones (${JSON.stringify(c.was)})`);
      else if (!n) lines.push(`- not applied: "${c.was}" is not in the ${section} report word for word; copy the words exactly as it has them`);
      else if (n > 1 && !c.every) lines.push(`- not applied: "${c.was}" is in the ${section} report ${n} times; give more of the words around the one to correct, or set every to correct all ${n}`);
      else {
        t = t.split(c.was).join(`${now} [corrected: was "${c.was}"]`);
        lines.push(`- corrected${n > 1 ? ` in ${n} places` : ''}: "${c.was}" now reads "${now}"`);
      }
    }
    for (const f of flagAfter) {
      const n = times(t, f);
      if (n !== 1) lines.push(`- not flagged: "${f}" is in the ${section} report ${n} times, not once; give the exact words that end the conclusion`);
      else { t = t.split(f).join(`${f} ${FLAG}`); lines.push(`- flagged the conclusion ending "${f}"`); }
    }
    if (t.length > MAX_CHARS) throw new Error(`the corrected report would be ${t.length} characters; the most one section holds is ${MAX_CHARS}`);
    entry.text = t;
  });
  return lines;
}

/** Which sections exist and how many turns each holds. */
export function progress(dir: string, ticker: string, date: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of load(dir, ticker, date).log) out[e.section] = (out[e.section] ?? 0) + 1;
  return out;
}

export const savedPlan = (dir: string, ticker: string, date: string): unknown => load(dir, ticker, date).plan;

/** When this run last saved anything (its plan, a step, a correction, its finished report), in milliseconds, or null
 *  when it has saved nothing yet. Every save rewrites the file whole, so its time is the run's latest sign of work,
 *  whatever program runs the agents. */
export function lastSaved(dir: string, ticker: string, date: string): number | null {
  let latest: number | null = null;
  for (const file of [runFile(dir, ticker, date), path.join(folder(dir, ticker, date), 'complete_report.md')]) {
    try { latest = Math.max(latest ?? 0, fs.statSync(file).mtimeMs); } catch { /* not written yet */ }
  }
  return latest;
}

/** Where a run stands, in a few plain words for the dashboard: its next unfinished step, from its plan and what is saved. */
export function stepWords(dir: string, ticker: string, date: string): string {
  const plan = savedPlan(dir, ticker, date) as { steps?: Array<{ section?: unknown; turn?: unknown }>; debateRounds?: unknown; riskRounds?: unknown } | undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter((s): s is { section: Section; turn: number } => isSection(String(s.section)) && Number.isInteger(s.turn)) : [];
  if (!steps.length) return 'starting';
  const done = progress(dir, ticker, date), next = steps.find((s) => (done[s.section] ?? 0) < s.turn);
  if (!next) return 'recording the call';
  const analysts = steps.filter((s) => ['market', 'sentiment', 'news', 'fundamentals'].includes(s.section));
  const of = (n: unknown) => (Number.isInteger(n) ? ` of ${n as number}` : '');
  switch (next.section) {
    case 'market': case 'sentiment': case 'news': case 'fundamentals':
      return `analysts reading: ${analysts.filter((s) => (done[s.section] ?? 0) >= 1).length} of ${analysts.length} done`;
    case 'fact_check': return 'the fact checker is checking the reports';
    case 'bull': case 'bear': return `debate round ${next.turn}${of(plan?.debateRounds)}`;
    case 'research_plan': return 'the research manager is weighing the debate';
    case 'trader': return 'the trader is drafting the plan';
    case 'aggressive': case 'conservative': case 'neutral': return `risk round ${next.turn}${of(plan?.riskRounds)}`;
    default: return 'the portfolio manager is deciding';
  }
}

/** The text of the named sections, in the order asked. A debate name (investment_debate, risk_debate) gives its turns in
 *  the order they were spoken. holdings and lessons give what the plan saved with the run; for a run planned before the
 *  desk kept them, `fallback` draws them up now, so an agent is never left to guess. */
export function readSections(dir: string, ticker: string, date: string, names: string[], fallback?: () => RunContext): string {
  const run = load(dir, ticker, date), log = run.log;
  let ctx: RunContext | undefined;
  return names.map((name) => {
    if ((CONTEXT as readonly string[]).includes(name)) {
      ctx ??= contextOf(run) ?? fallback?.();
      const label = CONTEXT_LABELS[name as ContextName];
      return ctx ? `## ${label}\n${ctx[name as ContextName]}` : `(No ${label.toLowerCase()} saved with this run: plan it with plan_analysis first. It is not known, not empty.)`;
    }
    const group = DEBATES[name];
    const entries = group ? log.filter((e) => group.includes(e.section)) : log.filter((e) => e.section === name);
    const label = group ? name.replace('_', ' ') : isSection(name) ? LABELS[name] : name;
    if (!entries.length) return `(No ${label} yet: it is not available, not an empty finding.)`;
    return `## ${label}\n${entries.map((e) => (group ? `[${LABELS[e.section]}]\n` : '') + e.text).join('\n\n')}`;
  }).join('\n\n');
}

/** Writes the finished report: one page per section and the whole in complete_report.md. */
export function writeReport(dir: string, ticker: string, date: string, header: string[]): string {
  const log = load(dir, ticker, date).log, root = folder(dir, ticker, date);
  const body = PARTS.flatMap(([heading, secs]) => {
    const written = secs.map((s) => ({ s, texts: log.filter((e) => e.section === s).map((e) => e.text) })).filter((x) => x.texts.length);
    if (!written.length) return [];
    return [`## ${heading}\n\n${written.map(({ s, texts }) => `### ${LABELS[s]}\n${texts.join('\n\n')}`).join('\n\n')}`];
  });
  const title = [`# Trading Analysis Report: ${safeSymbol(ticker)}`, '', `- Analysis date: ${date}`, ...header.map((h) => `- ${h}`), ''].join('\n');
  const out = path.join(root, 'complete_report.md');
  writeWhole(out, `${title}\n${body.join('\n\n')}\n`);
  return out;
}

/** Throws away a run's record so it can start again. */
export function deleteRun(dir: string, ticker: string, date: string): void {
  fs.rmSync(folder(dir, ticker, date), { recursive: true, force: true });
}

export const reportFolder = (dir: string, ticker: string, date: string): string => folder(dir, ticker, date);

/** Everything written for a run, section by section; a debate section lists its turns in order. Read-only, for the dashboard. */
export function sectionsOf(dir: string, ticker: string, date: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of load(dir, ticker, date).log) (out[e.section] ??= []).push(e.text);
  return out;
}

/** Whether the finished report has been written for a run. */
export const hasReport = (dir: string, ticker: string, date: string): boolean => fs.existsSync(path.join(folder(dir, ticker, date), 'complete_report.md'));
