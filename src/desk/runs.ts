// A run's working record: everything each agent wrote, saved as it is written, so a run that stops half way is resumed from
// the last finished step instead of paid for again, and so the agents hand work to each other through the desk rather
// than through one long conversation. One folder per stock and day; the finished report is written from it.
// The report layout is TradingAgents' (tradingagents/reporting.py), Apache License 2.0, rewritten in TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { daysBetween } from '../data/dates.js';
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

/** A correction as it stands in a report: the right words, then the mark that keeps the report's own words beside them. */
interface Fix { now: string; mark: string }
/** `at`: when the step was saved (ISO, UTC), so the time each step took can be read from the run itself, whatever program
 *  ran the agents. A step saved before the desk kept it has none. */
interface Run { ticker: string; date: string; startedAt: string; plan?: unknown; context?: RunContext & { at: string }; log: Array<{ section: Section; text: string; fixes?: Fix[]; at?: string }> }

/** The earlier full run a run builds on, as its plan keeps it: that run's date, and the analysts who write what changed
 *  since it (an analyst that run did not have writes in full). */
export interface BuiltOn { date: string; analysts: Section[] }

const folderName = (ticker: string) => safeSymbol(ticker).replace(/\^/g, 'IDX_').replace(/=/g, '_EQ_');
const folder = (dir: string, ticker: string, date: string) => path.join(dir, 'runs', `${folderName(ticker)}_${date}`);
const runFile = (dir: string, ticker: string, date: string) => path.join(folder(dir, ticker, date), 'run.json');

/** The days the desk has a run of this stock for, newest first. */
export function runDates(dir: string, ticker: string): string[] {
  const head = `${folderName(ticker)}_`;
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(dir, 'runs')); } catch { /* no runs yet */ }
  return names.filter((n) => n.startsWith(head) && /^\d{4}-\d{2}-\d{2}$/.test(n.slice(head.length))).map((n) => n.slice(head.length)).sort().reverse();
}

/** What a run's plan says it builds on, or undefined for a full run (and a run planned before the desk built on any). */
export function builtOnOf(plan: unknown): BuiltOn | undefined {
  const b = (plan as { builtOn?: { date?: unknown; analysts?: unknown } } | undefined)?.builtOn;
  if (!b || typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Array.isArray(b.analysts)) return undefined;
  const analysts = b.analysts.filter((a): a is Section => typeof a === 'string' && REPORTS.includes(a as Section));
  return analysts.length ? { date: b.date, analysts } : undefined;
}

/** A day as a person reads it on the page: "10 Nov 2026". */
export const dayWords = (date: string): string => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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

/** Why a fact check's first line does not count its own table, or null when it does (or says no count the desk can
 *  read: a check written in another language, or one where every claim held). "<w> wrong and <m> misleading claims"
 *  count the rows of its table of corrections: the NVDA run of 9 Nov 2026 said 1 and 5 over a table of 7. */
export function factCheckCount(text: string): string | null {
  const first = text.trim().split('\n')[0] ?? '', said = /\b(\d+|no) wrong and (\d+|no) misleading\b/i.exec(first);
  if (!said) return null;
  const n = (x: string) => (/^no$/i.test(x) ? 0 : Number(x)), w = n(said[1]!), m = n(said[2]!);
  // The table of corrections (Report | What it said | What is right | Source), else the first table.
  const lines = text.split('\n'), rules = lines.map((l, i) => (i > 0 && /^\s*\|?\s*:?-{2,}/.test(l) && lines[i - 1]!.includes('|') ? i : -1)).filter((i) => i > 0);
  const rule = rules.find((i) => /what it said|what is right/i.test(lines[i - 1]!)) ?? rules[0] ?? -1;
  let rows = 0;
  if (rule > 0) for (let i = rule + 1; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows++;
  return w + m === rows ? null
    : `the first line counts ${w} wrong and ${m} misleading claims, ${w + m} in all, but the table of corrections has ${rows === 1 ? 'one row' : `${rows} rows`}: w and m count its rows, one row a claim. Count them again (each row is wrong or misleading), mend the first line or the table, and save the fact check again`;
}

/** The desk's own marks, as an agent might write them: only correct_report makes them, only in the analysts' reports. */
const OWN_MARK = /\[corrected: was\b|\[the fact it rested on was corrected\b/i;

/** Saves what an agent wrote. A debate turn is added; any other section is replaced. A fact check whose first line does
 *  not count its own table is refused, with why: that line is the first thing the person reads of it. So is a text that
 *  writes the desk's own correction mark: the META run of 10 Nov 2026 had a bull turn with "777.59 on 2026-09-22
 *  [corrected: was "2026-09-24"]", the bull's own change, of a right date to a wrong one, which read as the fact checker's. */
export function saveSection(dir: string, ticker: string, date: string, section: Section, text: string): number {
  const t = text.trim();
  if (!t) throw new Error('there is nothing to save: the text is empty');
  if (t.length > MAX_CHARS) throw new Error(`the text is ${t.length} characters; the most one section holds is ${MAX_CHARS}`);
  if (OWN_MARK.test(t)) throw new Error('the text has a mark [corrected: was "..."] (or the note that a conclusion\'s fact was corrected): only the desk writes those, when the fact checker corrects an analyst\'s report, so a reader takes them as its. Quote a corrected figure by its corrected words alone, without the mark; and if your own earlier words were wrong, write the right words plainly and say in words what changed. Then save again');
  const miscount = section === 'fact_check' ? factCheckCount(t) : null;
  if (miscount) throw new Error(miscount);
  let turns = 0;
  change(dir, ticker, date, (r) => {
    const base = builtOnOf(r.plan);
    if (base?.analysts.includes(section) && !firstLine(t).includes(base.date)) throw new Error(sinceRefusal(base.date));
    if (!TURNS.has(section)) r.log = r.log.filter((e) => e.section !== section);
    r.log.push({ section, text: t, at: new Date().toISOString() });
    turns = r.log.filter((e) => e.section === section).length;
  });
  return turns;
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
/** Why an analyst's report in a run that builds on an earlier one is refused: its first line does not say what it builds
 *  on. The date alone is looked for, so a report in any language passes. */
const sinceRefusal = (date: string): string => `this run builds on the desk's full run of ${date}, so your report says what changed since then, and its first line names that day, for example "What changed since ${date}" (in the report language, the date written ${date}), so a reader knows the earlier points are as of that day. Mend the first line and save again`;

/** When each step of a run was saved, in the order saved: a debate turn each time. Steps saved before the desk kept the
 *  time are left out. */
export function stepTimes(dir: string, ticker: string, date: string): Array<{ section: Section; at: string }> {
  return load(dir, ticker, date).log.filter((e): e is typeof e & { at: string } => typeof e.at === 'string').map((e) => ({ section: e.section, at: e.at }));
}

export interface Correction { was: string; now: string; every?: boolean }
export const REPORTS: readonly Section[] = ['market', 'sentiment', 'news', 'fundamentals'];
export const FLAG = '[the fact it rested on was corrected: see the fact check]';

type Span = readonly [number, number];
/** Where words stand in a text, left to right, never overlapping (as a split finds them). */
const placesOf = (text: string, words: string): number[] => {
  const out: number[] = [];
  for (let i = words ? text.indexOf(words) : -1; i >= 0; i = text.indexOf(words, i + words.length)) out.push(i);
  return out;
};
// The desk's own marks in a report: a correction's old words, and a flagged conclusion's note. Those of a run corrected
// before the desk kept its corrections are found by their shape.
const MARKS = new RegExp(` \\[corrected: was "[\\s\\S]*?"\\]| ${FLAG.replace(/[[\]]/g, '\\$&')}`, 'g');
const within = (s: number, e: number, [a, b]: Span) => s >= a && e <= b;
const touches = (s: number, e: number, [a, b]: Span) => s < b && e > a;
const lineAt = (text: string, i: number) => text.slice(text.lastIndexOf('\n', i - 1) + 1, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i));
const MARK_HEAD = ' [corrected: was "';
/** The analyst's words a correction's mark keeps, as they stood in the report: in a table row the mark's bars are
 *  escaped, and a whole cell's correction stands before the row's last bar, so its words are also given without it. */
const analystsOwn = (mark: string, row: boolean): string[] => {
  const kept = mark.slice(MARK_HEAD.length, -2);
  if (!row) return [kept];
  const plain = kept.replace(/\\\|/g, '|');
  return [plain, plain.replace(/\s*\|\s*$/, '')];
};

/** The fact checker's corrections to an analyst's report, made by the desk word for word: each wrong passage is replaced
 *  where it stands with its old words kept beside it, and a conclusion that rested on one can be flagged. Nothing else
 *  in the report changes, so the checker never writes a report out again (a long report retyped by a model can lose or
 *  change words no one asked it to). Only before the debate begins: after that the reports are already argued from.
 *  Each mark keeps the analyst's own words, once: a correction of a correction's new words changes those words and keeps
 *  its mark, and one that gives the analyst's own words back takes the mark away (it replaced nothing); words that run into a mark, or that are only in one, are refused (the NVDA run of 9 Nov 2026 had a mark
 *  keeping the checker's own words, with another mark inside it). In a table row the mark stays in the row's last cell,
 *  its bars escaped, so the row keeps its cells. Returns one line per correction and flag: done, or why not. */
export function correctSection(dir: string, ticker: string, date: string, section: Section, corrections: Correction[], flagAfter: string[] = []): string[] {
  if (!REPORTS.includes(section)) throw new Error(`only an analyst's report can be corrected (${REPORTS.join(', ')}), not ${section}`);
  if (!corrections.length && !flagAfter.length) throw new Error('give at least one correction or one conclusion to flag');
  const lines: string[] = [];
  change(dir, ticker, date, (r) => {
    if (r.log.some((e) => e.section === 'bull')) throw new Error('the debate has begun: the reports are already argued from, so they are no longer corrected');
    const entry = r.log.find((e) => e.section === section);
    if (!entry) throw new Error(`this run has no ${section} report to correct`);
    let t = entry.text;
    const fixes: Fix[] = [...(entry.fixes ?? [])];
    const marksIn = (): Span[] => [
      ...[...t.matchAll(MARKS)].map((m): Span => [m.index, m.index + m[0].length]),
      ...fixes.flatMap((f) => placesOf(t, f.mark).map((p): Span => [p, p + f.mark.length])),
    ];
    for (const c of corrections) {
      const now = c.now.trim();
      if (!c.was.trim() || !now || now === c.was.trim()) { lines.push(`- not applied: a correction needs the report's exact old words and different new ones (${JSON.stringify(c.was)})`); continue; }
      const marks = marksIn();
      const news = fixes.flatMap((f) => placesOf(t, f.now + f.mark).map((p) => ({ span: [p, p + f.now.length] as Span, f })));
      const found = placesOf(t, c.was).map((s) => ({ s, e: s + c.was.length }));
      const live = found.filter(({ s, e }) => !marks.some((m) => within(s, e, m)));
      // Words that end where a mark begins are an earlier correction's new words: changed only as such (below), never
      // given a second mark, which would keep the checker's words as the analyst's.
      const clash = live.some(({ s, e }) => {
        const own = news.find((x) => within(s, e, x.span));
        return marks.some((m) => touches(s, e, m)) || (!own && t.startsWith(' [corrected: was "', e)) || news.some((x) => touches(s, e, x.span) && !within(s, e, x.span));
      });
      if (!live.length) lines.push(found.length ? `- not applied: "${c.was}" is only in the old words a correction keeps beside its new ones ([corrected: was "..."]); those stay as the analyst wrote them`
        : `- not applied: "${c.was}" is not in the ${section} report word for word; copy the words exactly as it has them`);
      else if (clash) lines.push(`- not applied: "${c.was}" runs into an earlier correction (its new words or the old words it keeps); correct words outside it, or only within the new words it gave, so that each mark keeps the analyst's own words, once`);
      else if (live.length > 1 && !c.every) lines.push(`- not applied: "${c.was}" is in the ${section} report ${live.length} times; give more of the words around the one to correct, or set every to correct all ${live.length}`);
      else {
        let again = 0, back = 0;
        for (const { s, e } of [...live].reverse()) {
          const own = news.find((x) => within(s, e, x.span));
          if (own) {
            const [a] = own.span, fresh = own.f.now.slice(0, s - a) + now + own.f.now.slice(e - a);
            if (analystsOwn(own.f.mark, /^[ \t]*\|/.test(lineAt(t, a))).includes(fresh)) {
              // Taken back to the analyst's own words (AAPL, 11 Nov 2026: a correction made from a read that had only
              // moved): the passage reads as the analyst wrote it, and the mark goes, for nothing was replaced.
              t = t.slice(0, a) + fresh + t.slice(a + own.f.now.length + own.f.mark.length);
              back++;
              continue;
            }
            // A correction of a correction: its new words change, and its mark still keeps the analyst's words.
            t = t.slice(0, a) + fresh + t.slice(a + own.f.now.length);
            fixes.push({ now: fresh, mark: own.f.mark });
            again++;
            continue;
          }
          const row = /^[ \t]*\|/.test(lineAt(t, s)), mark = ` [corrected: was "${row ? c.was.replace(/\|/g, '\\|') : c.was}"]`;
          const cell = row && /\|\s*$/.test(now) ? now.replace(/\s*\|\s*$/, '') : null;
          t = t.slice(0, s) + (cell === null ? `${now}${mark}` : `${cell}${mark} |`) + t.slice(e);
          fixes.push({ now: cell ?? now, mark });
        }
        const n = live.length;
        if (back === n) lines.push(`- taken back${n > 1 ? ` in ${n} places` : ''}: "${c.was}" now reads "${now}", so the passage is again the analyst's own words and its correction mark is gone; it is no longer a correction, so leave it out of your table`);
        else lines.push(`- corrected${n > 1 ? ` in ${n} places` : ''}: "${c.was}" now reads "${now}"${again ? `${n > 1 ? `; ${again} of them` : ''} within an earlier correction's new words, whose mark still keeps the analyst's own words` : ''}${back ? `; ${back} of them taken back to the analyst's own words, their marks gone` : ''}`);
      }
    }
    for (const f of flagAfter) {
      const marks = marksIn(), live = placesOf(t, f).filter((s) => !marks.some((m) => touches(s, s + f.length, m)));
      if (live.length !== 1) { lines.push(`- not flagged: "${f}" is in the ${section} report ${live.length} times, not once; give the exact words that end the conclusion`); continue; }
      // After a correction's mark when the words end a correction's new words, so the two stay together.
      let p = live[0]! + f.length;
      for (const m of marks.filter((x) => x[0] === p)) p = Math.max(p, m[1]);
      t = `${t.slice(0, p)} ${FLAG}${t.slice(p)}`;
      lines.push(`- flagged the conclusion ending "${f}"`);
    }
    if (t.length > MAX_CHARS) throw new Error(`the corrected report would be ${t.length} characters; the most one section holds is ${MAX_CHARS}`);
    entry.text = t;
    entry.fixes = fixes;
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
  const base = builtOnOf(plan);
  switch (next.section) {
    case 'market': case 'sentiment': case 'news': case 'fundamentals':
      return `analysts reading${base ? ` what changed since ${dayWords(base.date)}` : ''}: ${analysts.filter((s) => (done[s.section] ?? 0) >= 1).length} of ${analysts.length} done`;
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
  return blocksOf(dir, ticker, date, names, fallback).map((b) => b.text).join('\n\n');
}

/** One piece of a read: a section, or one turn of a debate (the debate's heading goes with its first turn), and what to
 *  call it when a read comes in parts. Joined with blank lines, the blocks are the read exactly. */
interface Block { text: string; name: string }

/** The section of read_run that gives the earlier full run's reports this run builds on (the fact checker reads it). */
export const EARLIER = 'earlier';

/** The earlier full run's reports a run builds on, under a head the desk writes, so every figure in them keeps its day:
 *  every one of them (`only` left out), or one analyst's own (read_earlier_run). Each is that run's report as its fact
 *  checker corrected it. */
function earlierBlocks(dir: string, ticker: string, date: string, run: Run, only?: Section): Block[] {
  const base = builtOnOf(run.plan);
  if (!base) return [{ name: 'Earlier run', text: only ? 'This run does not build on an earlier one: write your full report, as your instructions say.' : '(This run does not build on an earlier run: every report in it is a full report of its own.)' }];
  const wanted = only ? [only] : base.analysts;
  if (only && !base.analysts.includes(only)) return [{ name: 'Earlier run', text: `This run builds on the desk's full run of ${base.date}, but not for the ${LABELS[only]}: write your full report, as your instructions say.` }];
  const earlier = load(dir, ticker, base.date).log, days = daysBetween(base.date, date);
  const head = `## From the desk's full run of ${base.date} (${days === 1 ? 'one day' : `${days} days`} before ${date})\nThis run builds on it. ${only ? 'Below is your report' : 'Below are the analysts\' reports'} from that run, as its fact checker corrected ${only ? 'it' : 'them'}. Every figure ${only ? 'in it' : 'in them'} is as of ${base.date}, not today: give one only with that date beside it, never as today's.`;
  return wanted.map((s, i) => {
    const text = earlier.filter((e) => e.section === s).map((e) => e.text).join('\n\n');
    return { name: `${LABELS[s]} of ${base.date}`, text: `${i ? '' : `${head}\n\n`}### ${LABELS[s]}, as of ${base.date}\n${text || `(That run has no ${LABELS[s]} report.)`}` };
  });
}

function blocksOf(dir: string, ticker: string, date: string, names: string[], fallback?: () => RunContext): Block[] {
  const run = load(dir, ticker, date), log = run.log;
  let ctx: RunContext | undefined;
  return names.flatMap((name): Block[] => {
    if (name === EARLIER) return earlierBlocks(dir, ticker, date, run);
    if (name.startsWith(`${EARLIER}:`) && isSection(name.slice(EARLIER.length + 1))) return earlierBlocks(dir, ticker, date, run, name.slice(EARLIER.length + 1) as Section);
    if ((CONTEXT as readonly string[]).includes(name)) {
      ctx ??= contextOf(run) ?? fallback?.();
      const label = CONTEXT_LABELS[name as ContextName];
      return [{ name: label, text: ctx ? `## ${label}\n${ctx[name as ContextName]}` : `(No ${label.toLowerCase()} saved with this run: plan it with plan_analysis first. It is not known, not empty.)` }];
    }
    const group = DEBATES[name];
    const entries = group ? log.filter((e) => group.includes(e.section)) : log.filter((e) => e.section === name);
    const label = group ? name.replace('_', ' ') : isSection(name) ? LABELS[name] : name;
    if (!entries.length) return [{ name: label, text: `(No ${label} yet: it is not available, not an empty finding.)` }];
    if (!group) return [{ name: label, text: `## ${label}\n${entries.map((e) => e.text).join('\n\n')}` }];
    const turn: Record<string, number> = {};
    return entries.map((e, i) => ({
      name: `${LABELS[e.section]} turn ${(turn[e.section] = (turn[e.section] ?? 0) + 1)}`,
      text: `${i ? '' : `## ${label}\n`}[${LABELS[e.section]}]\n${e.text}`,
    }));
  });
}

/** The most of a run's text one answer of read_run holds (its note on the parts comes on top). Claude Code hands an agent
 *  a tool answer of more than about 50,000 characters only as a file, and the desk's agents have no tool to open files:
 *  before reads came in parts, a debater in the last round of a three-round debate received only the first lines of the
 *  debate it had to answer, and every debater read its sections again one by one (replay of a real run, 9 Nov 2026). */
export const PART_CHARS = 40_000;

/** A read in parts of at most PART_CHARS, cut between sections and debate turns (a single one longer than a part is cut
 *  between paragraphs, its name carried on with "continued"), so every part arrives whole and nothing is read twice. */
export function readParts(dir: string, ticker: string, date: string, names: string[], fallback?: () => RunContext): Array<{ text: string; names: string[] }> {
  const pieces: Block[] = [];
  for (const b of blocksOf(dir, ticker, date, names, fallback)) {
    let rest = b.text, first = true;
    while (rest.length > PART_CHARS) {
      const room = PART_CHARS - 200, cut = Math.max(rest.lastIndexOf('\n\n', room), rest.lastIndexOf('\n', room));
      const at = cut > room / 2 ? cut : room;
      pieces.push({ name: first ? b.name : `${b.name} (continued)`, text: rest.slice(0, at).trimEnd() });
      rest = `(${b.name}, continued)\n${rest.slice(at).replace(/^\n+/, '')}`;
      first = false;
    }
    pieces.push({ name: first ? b.name : `${b.name} (continued)`, text: rest });
  }
  const parts: Array<{ text: string; names: string[] }> = [];
  for (const p of pieces) {
    const last = parts.at(-1);
    if (last && last.text.length + 2 + p.text.length <= PART_CHARS) { last.text += `\n\n${p.text}`; last.names.push(p.name); }
    else parts.push({ text: p.text, names: [p.name] });
  }
  return parts;
}

/** One part of a read (1 when left out), opening with what every part holds when there is more than one. */
export function readPart(dir: string, ticker: string, date: string, names: string[], part = 1, fallback?: () => RunContext): string {
  const parts = readParts(dir, ticker, date, names, fallback);
  if (parts.length <= 1 && part === 1) return parts[0]?.text ?? '';
  if (part > parts.length) throw new Error(`this read has ${parts.length} part${parts.length === 1 ? '' : 's'}, not ${part}`);
  const holds = parts.map((p, i) => `part ${i + 1}: ${p.names.join('; ')}`).join('. ');
  const next = part < parts.length ? `Read the next with the same sections and part ${part + 1}` : 'This is the last part';
  return `(Part ${part} of ${parts.length} of this read, too long for one answer. ${holds}. Read every part once, in order. ${next}.)\n\n${parts[part - 1]!.text}`;
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
