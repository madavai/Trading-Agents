// A run's working record: everything each agent wrote, saved as it is written, so a run that stops half way is resumed from
// the last finished step instead of paid for again, and so the agents hand work to each other through the desk rather
// than through one long conversation. One folder per stock and day; the finished report is written from it.
// The report layout is TradingAgents' (tradingagents/reporting.py), Apache License 2.0, rewritten in TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { withLock, writeWhole } from './lock.js';

export const SECTIONS = ['market', 'sentiment', 'news', 'fundamentals', 'bull', 'bear', 'research_plan', 'trader', 'aggressive', 'conservative', 'neutral', 'decision'] as const;
export type Section = (typeof SECTIONS)[number];
/** Sections that grow a turn at a time; every other section holds one text, replaced when written again. */
const DEBATES: Record<string, readonly Section[]> = { investment_debate: ['bull', 'bear'], risk_debate: ['aggressive', 'conservative', 'neutral'] };
const TURNS = new Set<string>(Object.values(DEBATES).flat());
const MAX_CHARS = 60_000;

const LABELS: Record<Section, string> = { market: 'Market Analyst', sentiment: 'Sentiment Analyst', news: 'News Analyst', fundamentals: 'Fundamentals Analyst', bull: 'Bull Researcher', bear: 'Bear Researcher', research_plan: 'Research Manager', trader: 'Trader', aggressive: 'Aggressive Analyst', conservative: 'Conservative Analyst', neutral: 'Neutral Analyst', decision: 'Portfolio Manager' };
const PARTS: Array<[string, Section[]]> = [
  ['I. Analyst Team Reports', ['market', 'sentiment', 'news', 'fundamentals']],
  ['II. Research Team Decision', ['bull', 'bear', 'research_plan']],
  ['III. Trading Team Plan', ['trader']],
  ['IV. Risk Management Team Decision', ['aggressive', 'conservative', 'neutral']],
  ['V. Portfolio Manager Decision', ['decision']],
];

interface Run { ticker: string; date: string; startedAt: string; plan?: unknown; log: Array<{ section: Section; text: string }> }

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

/** Which sections exist and how many turns each holds. */
export function progress(dir: string, ticker: string, date: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of load(dir, ticker, date).log) out[e.section] = (out[e.section] ?? 0) + 1;
  return out;
}

export const savedPlan = (dir: string, ticker: string, date: string): unknown => load(dir, ticker, date).plan;

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
    case 'bull': case 'bear': return `debate round ${next.turn}${of(plan?.debateRounds)}`;
    case 'research_plan': return 'the research manager is weighing the debate';
    case 'trader': return 'the trader is drafting the plan';
    case 'aggressive': case 'conservative': case 'neutral': return `risk round ${next.turn}${of(plan?.riskRounds)}`;
    default: return 'the portfolio manager is deciding';
  }
}

/** The text of the named sections, in the order asked. A debate name (investment_debate, risk_debate) gives its turns in
 *  the order they were spoken. */
export function readSections(dir: string, ticker: string, date: string, names: string[]): string {
  const log = load(dir, ticker, date).log;
  return names.map((name) => {
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
