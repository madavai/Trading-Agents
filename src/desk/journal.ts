// The decision journal: an append-only markdown record of every call the desk made and, once the holding window has
// traded, how it turned out against its market index, with a short lesson. The lessons are read back into later analyses
// of the same and other stocks - but a past-dated analysis only sees lessons whose outcome was already known on its date.
// The file format is TradingAgents' memory log (tradingagents/memory/log.py), Apache License 2.0, rewritten in TypeScript.
//
// How a lesson was written is kept in its tag, so the desk can tell which lessons rest on the holding window's prices:
// "lesson:prices" (written with the window's rows at hand), "lesson:no-prices" (the rows could not be had, so it may say
// nothing about any day), "lesson:corrected:<day>" (rewritten from the rows that day; the first lesson is kept word for
// word under FIRST LESSON, and LESSON CHECK says what the check found), "lesson:unreliable:<day>" (it could not be
// checked against the rows that day, so analyses do not read it) and "lesson:flagged:<day>" (the person said that day
// that it is wrong, so analyses do not read it until a re-check rewrites it). No mark: written before the desk showed the
// lesson writer the window's prices. A lesson rewritten more than once keeps each corrected lesson it replaced, with its
// check, under EARLIER CORRECTIONS (newest first), so no words are ever lost.
//
// A call recorded since the desk kept each call's own scoring rules carries them in its tag, as two fields after "pending"
// (and after the score once settled): "window:5 trading days" (or "window:7 calendar days" for a coin) and
// "yardstick:SPY (us)", the yardstick with why it is that one (scoring.ts Basis). Scoring reads them from there, so a
// later change to the settings never re-scores a call. A call recorded before has neither, and keeps the rules it was
// made under (scoring.ts legacyRules).
//
// A call recorded since 9 Nov 2026 also keeps when it was recorded, "recorded:2026-11-09T15:04Z" (UTC, to the minute), so
// the paper record can tell an analysis dated in the past from a call made on its day (paper.ts lateWhy).
//
// The rating kept is the one the decision's words state: a rating passed that differs from it is refused, and a decision
// whose words state none is "Needs review", whatever was passed, so the journal never says what the decision does not.
//
// The file is read whatever its line ends (a journal saved by a Windows editor has CR LF) and written back with its own;
// an entry ends at its separator line, with or without the blank lines around it.
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW, RATINGS, parseRating } from './rating.js';
import { withLock, writeWhole } from './lock.js';
import { signedPct as pct, unsignZero } from '../numbers.js';
import { checkName, checkWords, legacyRules, ownReturn, windowWords, type Basis, type Rules, type Scoring } from './scoring.js';

/** How a settled call's lesson was written: see the file's head. "unmarked" is the old way; "none" a call not settled. */
export type LessonState = 'none' | 'unmarked' | 'prices' | 'no-prices' | 'corrected' | 'unreliable' | 'flagged';
/** The states whose lesson was not written from the window's prices, or that the person said is wrong, and so wait to be
 *  re-checked. A lesson written from the prices or corrected waits again only once the person flags it. */
export const UNCHECKED: readonly LessonState[] = ['unmarked', 'no-prices', 'unreliable', 'flagged'];
/** The states whose words analyses never read. */
export const WITHHELD: readonly LessonState[] = ['unreliable', 'flagged'];

export interface Entry {
  date: string; ticker: string; rating: string; pending: boolean;
  raw: string | null; alpha: string | null; holding: string | null; resolved: string | null;
  decision: string; reflection: string;
  /** How the lesson was written, the day it was corrected, marked unreliable or flagged, what that check found, the
   *  corrected lessons it replaced with their checks (newest first), and the first lesson's words. */
  lesson: LessonState; lessonOn: string | null; lessonCheck: string; earlier: string; firstLesson: string;
  /** The window and yardstick kept with the call when it was recorded; null for a call recorded before the desk kept them. */
  rules: Rules | null;
  /** When the call was recorded (ISO, UTC, to the minute); null for a call recorded before the desk kept it. */
  recorded: string | null;
}

const SEPARATOR = '\n\n<!-- ENTRY_END -->\n\n';

const MARK = /<!--\s*ENTRY_END\s*-->/i;
/** Where one entry ends and the next begins: the separator's line, with any blank lines around it. keep() means no
 *  model's words hold one, so each is the journal's own. */
const SPLIT = /\s*<!--\s*ENTRY_END\s*-->\s*/i;

/** A model's words made safe to keep: they can never end the entry early or fake a section of it. The separator is removed
 *  until none is left, since taking one out can join the pieces around it into another. */
function keep(text: string): string {
  let s = text;
  while (MARK.test(s)) s = s.replace(MARK, '');
  return s.replace(/^([ \t]*)(DECISION|REFLECTION|LESSON CHECK|EARLIER CORRECTIONS|FIRST LESSON):/gim, '$1$2 -').trim();
}

const LESSON_STATES = new Set<LessonState>(['prices', 'no-prices', 'corrected', 'unreliable', 'flagged']);
/** The tag's lesson field: "lesson:<state>" or "lesson:<state>:<day>". */
function lessonOf(fields: string[], pending: boolean): { lesson: LessonState; lessonOn: string | null } {
  if (pending) return { lesson: 'none', lessonOn: null };
  const [state, on] = (fields.find((x) => x.startsWith('lesson:'))?.slice('lesson:'.length) ?? '').split(':');
  return LESSON_STATES.has(state as LessonState) ? { lesson: state as LessonState, lessonOn: on && DATE.test(on) ? on : null } : { lesson: 'unmarked', lessonOn: null };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/, TICKER = /^[A-Za-z0-9.\-=^]{1,20}$/;
const BASES: readonly Basis[] = ['us', 'coin', 'unlisted', 'market', 'chosen', 'same'];
const RECORDED = /^recorded:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/;
/** When a call was recorded, as its tag keeps it. */
const recordedIn = (fields: string[]): string | null => fields.map((x) => RECORDED.exec(x)?.[1]).find(Boolean) ?? null;
const WINDOW = /^window:(\d{1,3}) (trading|calendar) days?$/, YARDSTICK = /^yardstick:([A-Za-z0-9.\-=^]{1,20}) \(([a-z]+)\)$/;
/** A call's rules as its tag keeps them: the window, then the yardstick with why. */
const rulesFields = (r: Rules): string[] => [`window:${windowWords(r)}`, `yardstick:${r.yardstick} (${r.basis})`];
/** The rules in a tag's fields, or null when it keeps none (a call recorded before the desk kept them). */
function rulesIn(fields: string[]): Rules | null {
  const w = fields.map((x) => WINDOW.exec(x)).find(Boolean), y = fields.map((x) => YARDSTICK.exec(x)).find(Boolean);
  if (!w || !y || !(BASES as readonly string[]).includes(y[2]!) || !(Number(w[1]) > 0)) return null;
  return { days: Number(w[1]), unit: w[2] as Rules['unit'], yardstick: y[1]!, basis: y[2] as Basis };
}
/** Rules the journal can keep in a tag: a whole number of days and a yardstick spelled as a ticker. */
function checkRules(r: Rules): void {
  if (!Number.isInteger(r.days) || r.days < 1 || r.days > 366) throw new Error(`a window of ${r.days} days is not one the journal can keep`);
  if (!TICKER.test(r.yardstick)) throw new Error(`the yardstick "${r.yardstick}" in desk-settings.json is not a ticker the journal can keep`);
  if (!BASES.includes(r.basis)) throw new Error(`"${r.basis}" is not why a yardstick is chosen`);
}
/** The parts of an entry's tag are checked, not trusted: a stray bar or bracket would split or forge the tag. */
function checkTag(ticker: string, date: string): void {
  if (!TICKER.test(ticker)) throw new Error(`"${ticker}" is not a ticker the journal can keep`);
  if (!DATE.test(date)) throw new Error(`"${date}" is not a date in YYYY-MM-DD form`);
}

function parse(block: string): Entry | null {
  const lines = block.trim().split(/\r?\n/);
  const tag = lines[0]?.trim() ?? '';
  if (!tag.startsWith('[') || !tag.endsWith(']')) return null;
  const f = tag.slice(1, -1).split('|').map((s) => s.trim());
  if (f.length < 4) return null;
  const body = lines.slice(1).join('\n').trim();
  const decision = /DECISION:\n([\s\S]*?)(?=\nREFLECTION:|$)/.exec(body)?.[1]?.trim() ?? '';
  // Each section runs to the next one's heading or the end ((?![\s\S]) is the end of the text, whatever the lines).
  const reflection = /(?:^|\n)REFLECTION:\n([\s\S]*?)(?=\nLESSON CHECK:\n|\nEARLIER CORRECTIONS:\n|\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? '';
  const lessonCheck = /(?:^|\n)LESSON CHECK:\n([\s\S]*?)(?=\nEARLIER CORRECTIONS:\n|\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? '';
  const earlier = /(?:^|\n)EARLIER CORRECTIONS:\n([\s\S]*?)(?=\nFIRST LESSON:\n|(?![\s\S]))/.exec(body)?.[1]?.trim() ?? '';
  const firstLesson = /(?:^|\n)FIRST LESSON:\n([\s\S]*)$/.exec(body)?.[1]?.trim() ?? '';
  const resolved = f.slice(6).find((x) => x.startsWith('resolved:'))?.slice('resolved:'.length).trim() ?? null;
  const pending = f[3] === 'pending', score = (s: string | undefined) => (s === undefined ? null : unsignZero(s));
  return { date: f[0]!, ticker: f[1]!, rating: f[2]!, pending, raw: pending ? null : score(f[3]), alpha: pending ? null : score(f[4]), holding: pending ? null : f[5] ?? null, resolved, decision, reflection, ...lessonOf(f.slice(6), pending), lessonCheck, earlier, firstLesson, rules: rulesIn(f.slice(4)), recorded: recordedIn(f.slice(4)) };
}

/** A settled entry's lesson part: the lesson, then each section that has words, in the journal's order. */
const lessonPart = (p: { lesson: string; check?: string; earlier?: string; first?: string }): string =>
  [keep(p.lesson), ...([['LESSON CHECK', p.check], ['EARLIER CORRECTIONS', p.earlier], ['FIRST LESSON', p.first]] as const)
    .filter(([, words]) => words?.trim()).map(([head, words]) => `${head}:\n${keep(words!)}`)].join('\n\n');

/** The first line of a flagged lesson's check: the day, and what the person said is wrong (kept on one line). */
const FLAG_LINE = /^(\d{4}-\d{2}-\d{2}): the person said this lesson is wrong, so later analyses do not read it until a re-check rewrites it from the holding window's prices\. What the person said is wrong: (.*)$/;
/** What the person said is wrong about a flagged lesson, and the day they said it; null for any other lesson. */
export function flagOf(e: Entry): { on: string; said: string } | null {
  const m = e.lesson === 'flagged' ? FLAG_LINE.exec(e.lessonCheck.split('\n')[0] ?? '') : null;
  return m ? { on: m[1]!, said: m[2]! } : null;
}

/** A settled entry with its lesson part rewritten. Everything before REFLECTION - the tag's call, rating and score, and the
 *  decision - stays byte for byte: only the tag's lesson field is replaced. (keep() means no model's words hold a line
 *  "REFLECTION:", so the first such line is the section's own.) */
function withLesson(block: string, mark: string, lessonPart: string): string {
  const b = block.trim(), nl = b.indexOf('\n'), at = b.search(/^REFLECTION:\r?$/m);
  const tag = b.slice(1, nl).replace(/\]\s*$/, '').split('|').map((s) => s.trim()).filter((x) => !x.startsWith('lesson:'));
  return `[${[...tag, mark].join(' | ')}]${at < 0 ? `${b.slice(nl)}\n\n` : b.slice(nl, at)}REFLECTION:\n${lessonPart}`;
}

/** What an analysis is told beside a lesson about how it was written. A lesson written from the window's prices needs no
 *  note; one marked unreliable or flagged by the person is withheld, with this note in its place. */
const LESSON_NOTE: Partial<Record<LessonState, (e: Entry) => string>> & Record<'unreliable' | 'flagged', (e: Entry) => string> = {
  unmarked: () => "written before the desk showed the lesson writer the holding window's prices, and not re-checked since: what it says happened on a given day may be wrong",
  'no-prices': () => "written when the holding window's prices could not be had, and not re-checked since",
  corrected: (e) => `corrected${e.lessonOn ? ` on ${e.lessonOn}` : ''}: rewritten from the holding window's real prices, replacing an earlier lesson`,
  unreliable: (e) => `withheld. It was written without the holding window's prices, and they could not be had to check it${e.lessonOn ? ` on ${e.lessonOn}` : ''}.`,
  flagged: (e) => `withheld. The person said${e.lessonOn ? ` on ${e.lessonOn}` : ''} that it is wrong, and it waits to be rewritten from the holding window's prices.`,
};
const withheld = (e: Entry) => (WITHHELD as LessonState[]).includes(e.lesson);

export class Journal {
  /** @param maxResolved keep at most this many settled entries (the oldest go first); pending ones are never dropped */
  constructor(readonly file: string, private maxResolved: number | null = null) {}

  /** The file's own line ends, as last read: written back the same way. */
  private eol = '\n';
  private read(): string {
    try { const t = fs.readFileSync(this.file, 'utf8'); this.eol = t.includes('\r\n') ? '\r\n' : '\n'; return t.replace(/\r\n/g, '\n'); } catch { return ''; }
  }
  private write(text: string): void { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeWhole(this.file, this.eol === '\n' ? text : text.replace(/\n/g, this.eol)); }
  private blocks(): string[] { return this.read().split(SPLIT).filter((b) => b.trim()); }

  load(): Entry[] { return this.blocks().map(parse).filter((e): e is Entry => e !== null); }
  pending(): Entry[] { return this.load().filter((e) => e.pending); }

  /** Adds a pending entry, with the window and yardstick it will be scored by when they are given (every call the desk
   *  records now), and when it was recorded (`at`, which record_decision gives). The rating kept is the one the decision
   *  states: a `rating` passed that differs from it is refused, and a decision that states none is Needs review. One
   *  entry per stock and day, settled or not: a re-run must not count the same call twice. */
  storeDecision(ticker: string, date: string, decision: string, rating?: string, rules?: Rules, at?: Date): 'stored' | 'exists' {
    checkTag(ticker, date);
    if (rules) checkRules(rules);
    const stated = parseRating(decision);
    if (rating && (RATINGS as readonly string[]).includes(rating) && stated !== REVIEW && rating !== stated) throw new Error(`the decision states ${stated}, not ${rating}: the journal keeps the rating the decision's words give. Correct the decision, or pass ${stated}`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.file, () => {
      if (this.load().some((e) => e.date === date && e.ticker === ticker)) return 'exists';
      const old = this.read().replace(/\s+$/, '');
      const kept = [...(rules ? rulesFields(rules) : []), ...(at ? [`recorded:${at.toISOString().slice(0, 16)}Z`] : [])].map((x) => ` | ${x}`).join('');
      const before = !old ? '' : /<!--\s*ENTRY_END\s*-->$/i.test(old) ? `${old}\n\n` : `${old}${SEPARATOR}`;
      this.write(`${before}[${date} | ${ticker} | ${stated} | pending${kept}]\n\nDECISION:\n${keep(decision)}${SEPARATOR}`);
      return 'stored';
    });
  }

  /** Settles a pending entry with its measured outcome and the lesson. False when it was no longer pending. `from` says
   *  whether the window's day-by-day prices were at hand for the lesson; left out, the lesson is unmarked (the old way).
   *  The window and yardstick the entry kept stay in its tag. */
  recordOutcome(ticker: string, date: string, raw: number, alpha: number, holdingDays: number, reflection: string, resolution: string, from?: 'prices' | 'no-prices'): boolean {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || !e.pending || e.date !== date || e.ticker !== ticker) return block;
        done = true;
        // The window and yardstick the call kept, and when it was recorded, stay in its tag once scored, before the lesson's mark.
        const kept = [...(e.rules ? rulesFields(e.rules) : []), ...(e.recorded ? [`recorded:${e.recorded}`] : [])].map((x) => ` | ${x}`).join('');
        return `[${date} | ${ticker} | ${e.rating} | ${pct(raw)} | ${pct(alpha)} | ${holdingDays}d | resolved:${resolution}${kept}${from ? ` | lesson:${from}` : ''}]\n\nDECISION:\n${e.decision}\n\nREFLECTION:\n${keep(reflection)}`;
      });
      if (!done) return false;
      this.write(this.rotate(out).join(SEPARATOR) + SEPARATOR);
      return true;
    });
  }

  /** Rewrites the lesson of one settled entry and nothing else; `change` gets the entry and returns its new tag mark and
   *  lesson part, or null to leave it. False when there is no such settled entry or `change` left it. */
  private relesson(ticker: string, date: string, change: (e: Entry) => { mark: string; part: string } | null): boolean {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || e.pending || e.date !== date || e.ticker !== ticker) return block;
        const c = change(e);
        if (!c) return block;
        done = true;
        return withLesson(block, c.mark, c.part);
      });
      if (done) this.write(out.join(SEPARATOR) + SEPARATOR);
      return done;
    });
  }

  /** Replaces a settled call's lesson with one rewritten from its window's prices on `on`. The first lesson is kept word
   *  for word under FIRST LESSON (one already kept stays: it is the first); a corrected lesson the person flagged, which
   *  this replaces, is kept with its check under EARLIER CORRECTIONS, newest first; and `check` - what the check found -
   *  goes under LESSON CHECK. The tag's call, rating and score and the decision are not touched. False when not settled,
   *  or the lesson was written from the window's prices or corrected, and the person has not flagged it since. */
  correctLesson(ticker: string, date: string, lesson: string, check: string, on: string): boolean {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    return this.relesson(ticker, date, (e) => (!(UNCHECKED as LessonState[]).includes(e.lesson) ? null : {
      mark: `lesson:corrected:${on}`,
      part: lessonPart({
        lesson, check,
        // Only a lesson the desk already corrected has a first lesson kept beside it: that corrected lesson moves to the
        // earlier corrections. Any other lesson being replaced is the first lesson itself.
        earlier: e.firstLesson ? [`Lesson replaced on ${on}:\n${e.reflection}\nIts check: ${e.lessonCheck || 'none was kept'}`, e.earlier].filter(Boolean).join('\n\n') : e.earlier,
        first: e.firstLesson || e.reflection,
      }),
    }));
  }

  /** Marks a settled call's lesson unreliable on `on`: it could not be checked against its window's prices, for the reason
   *  `check` gives. Its words stay as they are; analyses stop reading them until a later check corrects them. False when
   *  not settled, or the lesson was written from the window's prices or corrected already, or the person flagged it (it
   *  is withheld already, and keeps what they said). */
  markUnreliable(ticker: string, date: string, check: string, on: string): boolean {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    return this.relesson(ticker, date, (e) => (!(UNCHECKED as LessonState[]).includes(e.lesson) || e.lesson === 'flagged' ? null : {
      mark: `lesson:unreliable:${on}`,
      part: lessonPart({ lesson: e.reflection, check, earlier: e.earlier, first: e.firstLesson }),
    }));
  }

  /** Flags a settled call's lesson on `on`, on the person's word that it is wrong (`said`, kept on one line): analyses stop
   *  reading it at once, and a re-check lists it again to be rewritten from the window's prices. Its words stay; the check
   *  it had is kept under the person's words. The tag's call, rating and score and the decision are not touched.
   *  'flagged' when done; 'already' when it was flagged already (nothing written); 'none' when there is no such settled call. */
  flagLesson(ticker: string, date: string, said: string, on: string): 'flagged' | 'already' | 'none' {
    if (!DATE.test(on)) throw new Error(`"${on}" is not a date in YYYY-MM-DD form`);
    let already = false;
    const done = this.relesson(ticker, date, (e) => {
      if (e.lesson === 'flagged') { already = true; return null; }
      const line = `${on}: the person said this lesson is wrong, so later analyses do not read it until a re-check rewrites it from the holding window's prices. What the person said is wrong: ${said.replace(/\s+/g, ' ').trim()}`;
      return { mark: `lesson:flagged:${on}`, part: lessonPart({ lesson: e.reflection, check: `${line}${e.lessonCheck ? `\nIts check before then: ${e.lessonCheck}` : ''}`, earlier: e.earlier, first: e.firstLesson }) };
    });
    return done ? 'flagged' : already ? 'already' : 'none';
  }

  private rotate(blocks: string[]): string[] {
    if (!this.maxResolved || this.maxResolved <= 0) return blocks;
    const settled = blocks.filter((b) => { const e = parse(b); return e && !e.pending; }).length;
    let drop = settled - this.maxResolved;
    return drop <= 0 ? blocks : blocks.filter((b) => { const e = parse(b); if (e && !e.pending && drop > 0) { drop--; return false; } return true; });
  }

  /** The lessons for an analysis: the latest settled calls on this stock in full, and the latest on others as lessons only.
   *  With `asOf`, only calls whose outcome was already known on that day - a past-dated run must not learn from its future.
   *  Each lesson says how it was written (see LESSON_NOTE); one marked unreliable or flagged by the person is withheld, and
   *  is not counted among the other stocks' lessons, since it brings none. Each call's header names what it was scored
   *  over and against (its own rules, or for a call recorded before the desk kept them, the rules it was made under, from
   *  `scoring`): a short first check, not the call's own time horizon. */
  pastContext(ticker: string, o: { asOf?: string; sameLimit?: number; otherLimit?: number; scoring?: Scoring; unscoredBefore?: string; unscoredLimit?: number } = {}): string {
    const { sameLimit = 5, otherLimit = 3, unscoredLimit = 2 } = o;
    const all = this.load();
    let settled = all.filter((e) => !e.pending);
    if (o.asOf) settled = settled.filter((e) => e.resolved && e.resolved <= o.asOf!);
    // The desk's own latest calls on this stock that are not scored yet, made before this analysis's day: only for an
    // analysis of today (`unscoredBefore`), never with `asOf` (a past day must not see a call made after it).
    const unscored = o.unscoredBefore && !o.asOf
      ? all.filter((e) => e.pending && e.ticker === ticker && e.date < o.unscoredBefore!).sort((a, b) => b.date.localeCompare(a.date)).slice(0, unscoredLimit)
      : [];
    const same: Entry[] = [], other: Entry[] = [];
    for (const e of settled.reverse()) {
      if (e.ticker !== ticker && withheld(e)) continue;
      if (e.ticker === ticker ? same.length < sameLimit : other.length < otherLimit) (e.ticker === ticker ? same : other).push(e);
      if (same.length >= sameLimit && other.length >= otherLimit) break;
    }
    if (!same.length && !other.length && !unscored.length) return '';
    const over = (e: Entry): string => {
      const r = e.rules ?? (o.scoring ? legacyRules(e.ticker, o.scoring, e.holding) : null);
      return r ? `${checkName(r)}: ${ownReturn(r) ? `on its own return (${r.yardstick} is its own yardstick or copies the same index), so its alpha is its return,` : `against ${r.yardstick}`} over the ${windowWords(r)} after the call, not the call's own time horizon` : `over ${e.holding ?? 'n/a'}`;
    };
    const head = (e: Entry) => `[${e.date} | ${e.ticker} | ${e.rating} | return ${e.raw ?? 'n/a'} | alpha ${e.alpha ?? 'n/a'} | ${over(e)}]`;
    const full = (e: Entry) => [head(e), `DECISION:\n${e.decision}`,
      ...(e.lesson === 'unreliable' || e.lesson === 'flagged' ? [`REFLECTION: ${LESSON_NOTE[e.lesson](e)}`] : e.reflection ? [`REFLECTION${LESSON_NOTE[e.lesson] ? ` (${LESSON_NOTE[e.lesson]!(e)})` : ''}:\n${e.reflection}`] : [])].join('\n\n');
    const short = (e: Entry) => `${head(e)}${e.reflection && LESSON_NOTE[e.lesson] ? ` (lesson ${LESSON_NOTE[e.lesson]!(e)})` : ''}\n${e.reflection || e.decision.slice(0, 300) + (e.decision.length > 300 ? '...' : '')}`;
    // A call not scored yet has no result: none is given, nor any guess at one. Its rules say how it will be scored.
    const notYet = (e: Entry) => {
      const r = e.rules ?? (o.scoring ? legacyRules(e.ticker, o.scoring, e.holding) : null);
      return [`[${e.date} | ${e.ticker} | ${e.rating} | not scored yet: it has no result, and is scored${r ? ` by ${checkWords(e.ticker, r)}` : ''} once a scoring runs after that window]`, `DECISION:\n${e.decision}`].join('\n\n');
    };
    const parts: string[] = [];
    if (unscored.length) parts.push(`The desk's latest calls on ${ticker} not scored yet (latest first; the call's own view on its day, not how it turned out):`, ...unscored.map(notYet));
    if (same.length) parts.push(`Past analyses of ${ticker} (latest recorded first):`, ...same.map(full));
    if (other.length) parts.push('Recent cross-ticker lessons:', ...other.map(short));
    return parts.join('\n\n');
  }
}

export { REVIEW };
