// Settling past calls: once a call's holding window has fully traded, its measured outcome - from price rows, never from an
// agent - and the window's sessions day by day are shown to the agent, who writes the short lesson from them; the outcome
// and the lesson are then kept in the journal.
//
// A scoring keeps a few notes of its own beside the journal (settle-check.json, loop-notes.ts), so it cannot go round in a
// loop: a call record_outcome failed to settle twice is LEFT (it stays pending, unscored, and is named at the end), and
// the same call sent again after that with no call settled since answers STOP. A scoring started an hour after
// record_outcome was last used starts afresh, and tries the calls left again.
import { Journal, type Entry } from './journal.js';
import { checkName, COIN_YARDSTICK_WORDS, legacyRules, measure, windowWords, type Outcome, type Rules, type Scoring } from './scoring.js';
import { failureText } from '../data/http.js';
import { signedPct as pct } from '../numbers.js';
import { windowRows } from './window.js';
import { REFUSALS_TO_LEAVE, countRefusal, leftIn, noteStep, readNotes } from './loop-notes.js';

const line = (o: Outcome, e: Entry) => `${e.ticker} ${pct(o.raw)} from ${o.entry} to ${o.exit} (${windowWords({ days: o.holdingDays, unit: o.unit })}); ${o.benchmark} ${pct(o.benchmarkReturn)}${o.unit === 'calendar' ? ` (its close of ${o.benchFrom} to its close of ${o.benchTo})` : ''}; alpha ${pct(o.alpha)}`;
/** The rules a pending call is scored by: those kept with it, or for a call recorded before the desk kept them, the rules
 *  it was made under. */
export const rulesOf = (e: Entry, scoring: Scoring): Rules => e.rules ?? legacyRules(e.ticker, scoring, e.holding);
/** What a ready call's score is, said beside it for the lesson writer: a first check, not the call's horizon. */
const scoreIs = (o: Outcome, r: Rules) => `THIS SCORE IS ${checkName(r).toUpperCase()}: the ${windowWords(r)} after the call against ${o.benchmark}, not the call's own time horizon (its decision states that). Say in the lesson how much a window this short can show about the thesis.${r.unit === 'calendar' ? ` ${COIN_YARDSTICK_WORDS}` : ''}`;
export const MAX_REFLECTION = 1200;
/** A lesson is 2 to 4 sentences (the /settle and /recheck-lessons rule); the desk refuses more. */
export const MAX_SENTENCES = 4;
/** The scoring's notes, beside the journal: settle-check.json. */
const SCORING = 'settle-check';

// Full stops that do not end a sentence, in any case: a run of single letters each with a point (a.m., p.m., U.S.A., e.g.,
// i.e.), a short word the desk knows (No., vs., approx., Inc., a month), a capital's initial (J. Smith) and an ellipsis
// (... or …). A figure's point (221.97, -2.16, +0.7%, -.5%) never ends one, since no space follows it. Each is kept the
// same length, so the sentences can be cut from the lesson's own words.
const DOTTED = /(?<![A-Za-z])(?:[A-Za-z]\.){2,}/g;
const SHORT_WORDS = /\b(?:vs|etc|approx|est|Inc|Corp|Co|Ltd|No|Nos|Mr|Ms|Mrs|Dr|St|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./gi;
const INITIAL = /\b[A-Z]\./g;
const ELLIPSIS = /\.{3,}/g;
/** A sentence's end: . ! or ? (with any closing quote or bracket) followed by a space and a capital letter, a figure, a
 *  sign or an opening quote or bracket. */
const END = /[.!?]+["')\]”’]*(?= ["'(\[“‘]?[A-Z0-9$+\-−])/g;
const keepPoints = (m: string) => m.replace(/\./g, '·');

/** A lesson's sentences, as the desk reads them, in the lesson's own words. A sentence that starts with a small letter is
 *  read as part of the one before, and a short form it does not know can read as an end, so a refusal shows where it cut.
 *  On the 13 lessons re-checked on 8 Nov 2026 it gives what a reader counts (two of them have 5). */
export function sentencesOf(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const read = t.replace(DOTTED, keepPoints).replace(SHORT_WORDS, keepPoints).replace(INITIAL, keepPoints).replace(ELLIPSIS, keepPoints);
  const out: string[] = [];
  let from = 0;
  for (const m of read.matchAll(END)) { const to = m.index + m[0].length; out.push(t.slice(from, to).trim()); from = to; }
  out.push(t.slice(from).trim());
  return out;
}

/** How many sentences a lesson has, as the desk reads them (sentencesOf). */
export const sentencesIn = (text: string): number => sentencesOf(text).length;

/** A sentence's first words, to show where the desk cut. */
const opening = (s: string) => { const w = s.split(' '); return `"${w.slice(0, 3).join(' ')}${w.length > 3 ? '…' : ''}"`; };

/** Why a lesson cannot be kept as given, or null: the same rules for a lesson settled now and one re-checked. */
export function lessonRefusal(text: string): string | null {
  if (!text) return 'the lesson is empty: write 2 to 4 plain sentences';
  if (text.length > MAX_REFLECTION) return `the lesson is ${text.length} characters; keep it under ${MAX_REFLECTION}`;
  const s = sentencesOf(text);
  if (s.length > MAX_SENTENCES) return `the lesson has ${s.length} sentences; write 2 to ${MAX_SENTENCES}. The desk ends a sentence at . ! or ? followed by a space and a capital letter, a figure or a sign, but not after a short form it knows (such as a.m., U.S., e.g., No., vs., approx. or a month), an initial or an ellipsis. It read these ${s.length}, beginning ${s.map(opening).join(', ')}`;
  return null;
}

/** The window's rows, or why they could not be had - in which case the lesson may say nothing about any day. */
async function windowText(ticker: string, o: Outcome): Promise<string> {
  try { return await windowRows(ticker, o); }
  catch (err) { return `WHAT HAPPENED IN THE WINDOW: ${failureText(err, `the day-by-day rows of ${ticker}'s window`)} Write the lesson from the outcome line alone, and say nothing about what happened on any day of the window.`; }
}

/** The true words about when a call left now is scored. */
const LATER = 'A later scoring, started an hour or more after record_outcome was last used, tries it again.';

/** Every pending call (of one stock, if named), with its outcome when the window has finished. A call this scoring left
 *  after two refusals is named, not shown. Reads the scoring's notes and writes nothing. */
export async function dueSettlements(journal: Journal, scoring: Scoring, ticker?: string, now: number = Date.now()): Promise<string> {
  const pending = journal.pending().filter((e) => !ticker || e.ticker === ticker);
  if (!pending.length) return ticker ? `No pending calls on ${ticker}.` : 'No pending calls: every call in the journal is settled.';
  const notes = readNotes(journal, SCORING, now), out: string[] = [];
  let ready = 0, left = 0;
  for (const e of pending) {
    const head = `[${e.date} | ${e.ticker} | ${e.rating}]`;
    const refused = leftIn(notes, e.ticker, e.date);
    if (refused) {
      left++;
      out.push(`${head} LEFT: record_outcome failed to settle it ${refused.n} times in this scoring (the last time: ${refused.why}). Leave it pending, unscored: do not send it again in this scoring. Name it to the person at the end, with that reason. ${LATER}`);
      continue;
    }
    try {
      const r = rulesOf(e, scoring), o = await measure(e.ticker, e.date, r);
      if (!o) { out.push(`${head} NOT YET: its window, the ${windowWords(r)} after ${e.date} (against ${r.yardstick}), has not finished. Leave it pending.`); continue; }
      ready++;
      out.push(`${head} READY: ${line(o, e)}\n${scoreIs(o, r)}\nDECISION:\n${e.decision}\n\n${await windowText(e.ticker, o)}`);
    } catch (err) {
      out.push(`${head} ${failureText(err, `prices to settle ${e.ticker} on ${e.date}`)} Leave it pending.`);
    }
  }
  return [`${pending.length} pending call(s), ${ready} ready to settle${left ? `, ${left} left in this scoring after ${REFUSALS_TO_LEAVE} failed tries` : ''}. Settle a ready one with record_outcome, using only the figures shown here. Before writing about a level, stop, target or trigger the decision named, find it in that call's window rows: say what happened only as a row shows it, naming its date.`, '', ...out].join('\n\n');
}

/** Settles one call (`settleOnce`), and keeps count: a refusal is said as one (INPUT_ERROR, to correct and send again) the
 *  first time, and the second time for the same call in this scoring as LEFT, so the team leaves it pending and goes on
 *  instead of sending it round again. Sent again after that with no call settled since, and refused, it answers STOP. A
 *  call that is not pending is not counted: it is said as it is. */
export async function settleOne(journal: Journal, scoring: Scoring, ticker: string, date: string, reflection: string, now: number = Date.now()): Promise<string> {
  const pending = journal.pending().some((x) => x.ticker === ticker && x.date === date);
  let answer: string;
  try { answer = await settleOnce(journal, scoring, ticker, date, reflection); } catch (err) {
    if (!(err instanceof Error) || !pending) { noteStep(journal, SCORING, now); throw err; }
    const { n, answer: count } = countRefusal(journal, SCORING, ticker, date, err.message, now);
    if (count === 'again') throw err;
    if (count === 'stop') return `STOP: record_outcome has now failed to settle ${ticker} on ${date} ${n} times in this scoring (this time: ${err.message}). It was left after ${REFUSALS_TO_LEAVE} failed tries, and no call has been settled since, so the scoring is going round in a loop. Do not send it again now: it stays pending, unscored. Go on with any other READY call, and at the end tell the person it was left, and why. ${LATER}`;
    return `LEFT: record_outcome has now failed to settle ${ticker} on ${date} ${n} times in this scoring (this time: ${err.message}). Leave it: do not send it again in this scoring. It stays pending, unscored. Go on with the next READY call, and at the end tell the person it was left, and why. ${LATER}`;
  }
  noteStep(journal, SCORING, now, answer.startsWith('Settled: ') ? { ticker, date } : undefined);
  return answer;
}

/** Settles one call: measures it again (so the figures cannot be an agent's), then keeps outcome and lesson. The lesson is
 *  marked by whether the window's rows - the ones list_settlements showed - can be had now: if not, it is re-checked later. */
async function settleOnce(journal: Journal, scoring: Scoring, ticker: string, date: string, reflection: string): Promise<string> {
  const text = reflection.trim(), refused = lessonRefusal(text);
  if (refused) throw new Error(refused);
  const e = journal.pending().find((x) => x.ticker === ticker && x.date === date);
  if (!e) throw new Error(`there is no pending call on ${ticker} for ${date}`);
  const r = rulesOf(e, scoring), o = await measure(ticker, date, r);
  if (!o) return `NOT_YET: its window, the ${windowWords(r)} after ${date}, has not finished, so ${ticker} stays pending.`;
  const from = await windowRows(ticker, o).then(() => 'prices' as const, () => 'no-prices' as const);
  return journal.recordOutcome(ticker, date, o.raw, o.alpha, o.holdingDays, text, o.exit, from)
    ? `Settled: ${line(o, e)}. The lesson is kept and will be read by later analyses from ${o.exit} on.`
    : `${ticker} on ${date} was settled by another run already.`;
}
