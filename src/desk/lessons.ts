// Re-checking the lessons of settled calls that were not written from their holding window's prices: those written before
// the desk showed the lesson writer the window's rows (no mark in the journal), those written when the rows could not be
// had, those marked unreliable before, and those the person said are wrong (flag_lesson). The desk lists each with its
// decision, its lesson as it stands and the window's rows; the agent rewrites the lesson from the rows alone, and the desk
// keeps the first lesson word for word beside the new one, and every corrected lesson it replaces with its check, marked
// as corrected - the same honesty as the fact checker's [corrected: was "..."]. A call whose rows cannot be had is marked
// unreliable by the desk itself, so nobody guesses, and analyses stop reading its lesson until a later re-check. Only the
// lesson ever changes: never the call, its rating or its score.
//
// A lesson written from the window's prices, or corrected, is never listed again unless the person flags it: only their
// word, naming the stock, the call's date and what is wrong, does that, and analyses stop reading it from that moment
// until it is rewritten. The team never flags a lesson by itself.
//
// A re-check keeps a few notes of its own beside the journal (lesson-check.json, loop-notes.ts), so it cannot go round in
// a loop: a lesson whose new words correct_lesson refused twice is left and named at the end, the same lesson refused
// again after that with nothing saved since answers STOP, and a listing that would show the same lessons again with
// nothing saved since says STOP instead. The notes lapse an hour after the re-check's last step.
import { Journal, UNCHECKED, flagOf, type Entry } from './journal.js';
import { measure, resolveBenchmark, type Outcome, type Scoring } from './scoring.js';
import { windowRows } from './window.js';
import { lessonRefusal } from './settle.js';
import { REFUSALS_TO_LEAVE, countRefusal, keyOf, leftIn, noteStep, readNotes, writeNotes } from './loop-notes.js';
import { listed, utcTime } from './agent-files.js';
import { today } from '../data/dates.js';
import { signedPct } from '../numbers.js';

/** How many calls one listing shows in full: each carries its whole decision. The others wait for the next listing. */
export const PER_LISTING = 3;
/** The longest what_was_wrong (sorted under three labels) and the longest note of what the person said is wrong. */
export const MAX_CHECK_NOTE = 900;
/** The three labels what_was_wrong sorts each statement of the lesson as it stands under, in this order. */
export const CHECK_LABELS = ['Contradicted:', 'Not known from the prices:', 'Right:'] as const;
/** The re-check's notes, beside the journal: lesson-check.json. */
const CHECK = 'lesson-check';
export { REFUSALS_TO_LEAVE, NOTES_IDLE_MS } from './loop-notes.js';

/** The true words about what a later re-check does, for the team to pass on and nothing more. */
function laterWords(ticker: string | undefined, o: { toRewrite?: number; unreliable?: number; flagged?: number; left?: number } = {}): string {
  const looks = [
    ...(o.toRewrite ? ['the lessons still to rewrite'] : []),
    ...(o.unreliable ? ['each lesson marked unreliable (from its window\'s prices, if they can be had then)'] : []),
    ...(o.flagged ? ['each lesson the person said is wrong whose window\'s prices could not be had here (if they can be had then)'] : []),
    ...(o.left ? ['each lesson left here after two refusals (once an hour has passed since this re-check\'s last step)'] : []),
    'any lesson the person later says is wrong',
    'the lesson of any call settled from now on when its window\'s prices cannot be had',
  ];
  return `LATER RE-CHECKS (tell the person only this about them): asking for a re-check again does not re-check a corrected lesson, nor one written from its window's prices. If the person finds one of them wrong, they can say so, naming the stock, the call's date and what is wrong: later analyses then stop reading it at once, and a re-check rewrites it from its window's prices, keeping its earlier words. A later re-check${ticker ? ` of ${ticker}` : ''} looks only at ${listed(looks)}.`;
}

class NoWindow extends Error {}

const tagOf = (e: Entry) => `[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw} | ${e.alpha} | ${e.holding} | resolved:${e.resolved}]`;

/** Why this lesson waits to be re-checked, in the journal's own terms. */
const whyOf = (e: Entry): string =>
  e.lesson === 'flagged' ? `the person said${e.lessonOn ? ` on ${e.lessonOn}` : ''} that it is wrong, so later analyses do not read it until it is rewritten`
    : e.lesson === 'unreliable' ? `it was marked unreliable${e.lessonOn ? ` on ${e.lessonOn}` : ''}, since the window's prices could not be had to check it`
      : e.lesson === 'no-prices' ? "it was written when the window's prices could not be had"
        : "it was written before the desk showed the lesson writer the window's prices";

/** For a flagged lesson: what the person said is wrong, and the check it had before, for the rewriter to weigh against the rows. */
function flagWords(e: Entry): string[] {
  const flag = flagOf(e);
  if (e.lesson !== 'flagged') return [];
  const before = e.lessonCheck.split('\n').slice(1).join('\n').replace(/^Its check before then: /, '').trim();
  return [
    `WHAT THE PERSON SAID IS WRONG (check it against the rows like every other statement; it is not a fact until a row shows it):\n${flag ? flag.said : e.lessonCheck}`,
    ...(flag && before ? [`ITS CHECK BEFORE THEN:\n${before}`] : []),
  ];
}

/** The window the call was scored over, rebuilt from prices, and its rows; NoWindow with the reason when they cannot be had. */
async function windowOf(e: Entry, scoring: Scoring): Promise<{ o: Outcome; rows: string }> {
  const days = Number(/^(\d+)d$/.exec(e.holding ?? '')?.[1]);
  if (!days || !e.resolved) throw new NoWindow('the journal does not record its holding window');
  let o: Outcome | null;
  try { o = await measure(e.ticker, e.date, resolveBenchmark(e.ticker, scoring), days); }
  catch (err) { throw new NoWindow(`the prices of ${e.ticker}'s window could not be had (${(err as Error).message})`); }
  if (!o) throw new NoWindow(`the prices no longer cover ${e.ticker}'s ${days}-trading-day window after ${e.date}`);
  if (o.exit !== e.resolved) throw new NoWindow(`the prices now give a window ending ${o.exit}, but the call was scored to ${e.resolved}`);
  try { return { o, rows: await windowRows(e.ticker, o) }; }
  catch (err) { throw new NoWindow(`the day-by-day rows of ${e.ticker}'s window could not be had (${(err as Error).message})`); }
}

const unreliableNote = (on: string, why: string) =>
  `${on}: unreliable. It was written without the holding window's prices, and they could not be had to check it: ${why}. Analyses do not read it until a later re-check rewrites it from them.`;

/** What becomes of a lesson whose window cannot be had now: one the person flagged stays flagged (withheld already, with
 *  their words); any other is marked unreliable by the desk. */
function noWindow(journal: Journal, e: Entry, why: string, on: string): 'flagged' | 'unreliable' {
  if (e.lesson === 'flagged') return 'flagged';
  journal.markUnreliable(e.ticker, e.date, unreliableNote(on, why), on);
  return 'unreliable';
}

const RULES = [
  'For each call TO REWRITE: check every statement of its lesson against its window\'s rows, then save a new lesson with correct_lesson (symbol, trade_date, lesson, what_was_wrong). Write only from the rows, the decision and the score shown here: say nothing about the desk\'s other calls or its journal, which are not shown here.',
  `The lesson: 2 to 4 sentences of plain prose (the desk counts them and refuses more than 4), no bullets, headings or markdown; (1) what the alpha over the window shows about the directional call, citing the figure as listed, and saying plainly if the window is too short to judge the thesis; (2) which part of the thesis the window supports or undercuts; (3) one concrete lesson for the next similar analysis.`,
  'Read the rows as they are labelled: the row marked "entry" is the close the call is scored from, not a session of the window, so the call\'s first session is session 1. Say how the index moved with the figure the score line gives, never a word for it such as "flat". When the decision says an event comes after a session\'s close (a report after the bell), the first session that can show it is the next one.',
  'Before writing about any level, stop, target or trigger the decision named, find it in the rows: say it was reached, held or broken, or that a trigger fired or not, only when a row shows it, naming that row\'s date and figure. A trigger the decision tied to more than one condition fired only when every condition did: a condition the rows cannot show leaves it "not known from the prices". What the rows cannot show (news, earnings, a filing, a figure they do not hold) is "not known from the prices", never a guess.',
  `what_was_wrong sorts each statement of the lesson as it stands under three labels, in this order: "${CHECK_LABELS[0]}" each statement the rows contradict, quoted, with the row that shows otherwise (its date and figure); "${CHECK_LABELS[1]}" each statement the rows cannot show, quoted; "${CHECK_LABELS[2]}" the rest. Write "none" under a label with nothing in it. A statement is contradicted only when a row shows otherwise. The desk keeps the first lesson word for word beside the new one, and any corrected lesson it replaces, marked as corrected. The call, its rating and its score stay as they are.`,
  'For a lesson the person said is wrong, what they said is shown beside it. Check it against the rows like every other statement, and write only what a row shows: never take their words, or a review\'s, as given.',
].join('\n');

/** Every settled call whose lesson waits to be re-checked (of one stock, if named), oldest first: up to PER_LISTING shown
 *  in full to rewrite. One whose window's rows cannot be had is marked unreliable here, by the desk, with why; one this
 *  re-check left after two refusals is named, not shown. The same lessons shown again with nothing saved since: STOP. */
export async function lessonsToRecheck(journal: Journal, scoring: Scoring, ticker?: string, on: string = today(), now: number = Date.now()): Promise<string> {
  const notes = readNotes(journal, CHECK, now), of = ticker ?? '';
  const due = journal.load().filter((e) => !e.pending && UNCHECKED.includes(e.lesson) && (!ticker || e.ticker === ticker));
  if (!due.length) {
    writeNotes(journal, CHECK, { ...notes, listed: undefined }, now);
    return `No lessons${ticker ? ` on ${ticker}` : ''} to re-check: every settled call's lesson was written from its window's prices, or corrected from them.\n\n${laterWords(ticker)}`;
  }
  const shown: string[] = [], keys: string[] = [], unreliable: string[] = [], flaggedOut: string[] = [], left: string[] = [];
  let later = 0;
  for (const e of due) {
    const refused = leftIn(notes, e.ticker, e.date);
    if (refused) {
      left.push(`${tagOf(e)} LEFT: correct_lesson refused its new lesson ${refused.n} times in this re-check (the last time: ${refused.why}). Leave it: its lesson stays as it stands${e.lesson === 'flagged' ? ', and later analyses still do not read it' : ''}. Name it to the person at the end, with that reason.`);
      continue;
    }
    if (shown.length >= PER_LISTING) { later++; continue; }
    try {
      const w = await windowOf(e, scoring);
      shown.push([
        `${tagOf(e)} TO REWRITE: ${whyOf(e)}.`,
        `ITS SCORE, WHICH STAYS AS IT IS: ${e.ticker} ${e.raw} from ${w.o.entry} to ${w.o.exit} (${w.o.holdingDays} trading days); its index, ${w.o.benchmark}, ${signedPct(w.o.benchmarkReturn)} over the same days; alpha ${e.alpha}.`,
        `DECISION:\n${e.decision}`,
        `LESSON AS IT STANDS:\n${e.reflection}`,
        ...flagWords(e),
        w.rows,
      ].join('\n\n'));
      keys.push(keyOf(e.ticker, e.date));
    } catch (err) {
      if (!(err instanceof NoWindow)) throw err;
      if (noWindow(journal, e, err.message, on) === 'flagged') {
        flaggedOut.push(`${tagOf(e)} UNRELIABLE: ${err.message}. Its lesson stays as the person flagged it: its words stay in the journal, and later analyses still do not read them. Leave it: a later re-check tries again.`);
      } else {
        unreliable.push(`${tagOf(e)} UNRELIABLE: ${err.message}. The desk marked its lesson unreliable: its words stay in the journal, and later analyses no longer read them. Leave it: a later re-check tries again.`);
      }
    }
  }
  const last = notes.listed;
  if (keys.length && last && last.of === of && last.saved === notes.saved && last.shown.join('\n') === keys.join('\n')) {
    // The same lessons as the last listing, and nothing saved since: the re-check is going round. The notes forget that
    // listing, so a person who asks again afterwards is shown the lessons in full.
    writeNotes(journal, CHECK, { ...notes, listed: undefined }, now);
    return [
      `STOP: this is the same list of lessons to rewrite as the last one, at ${utcTime(new Date(last.at))}, and no lesson has been saved since, so the re-check is going round in a loop. They are not shown again.`,
      `Do not call recheck_lessons or correct_lesson again now. Tell the person which lessons are still to rewrite (${listed(keys.map((k) => k.replace('|', ' ')))}), and why any of them was not saved, as correct_lesson's answers said.${left.length ? ` Name the ${left.length} left after two refusals too, with why.` : ''}`,
      laterWords(ticker, { toRewrite: keys.length + later, unreliable: unreliable.length, flagged: flaggedOut.length, left: left.length }),
    ].join('\n\n');
  }
  writeNotes(journal, CHECK, { ...notes, listed: { of, shown: keys, saved: notes.saved, at: now } }, now);
  const counts = [
    `${shown.length} to rewrite below`,
    ...(later ? [`${later} more after these (call recheck_lessons again once these are saved)`] : []),
    ...(unreliable.length ? [`${unreliable.length} marked unreliable`] : []),
    ...(flaggedOut.length ? [`${flaggedOut.length} the person said is wrong whose prices could not be had`] : []),
    ...(left.length ? [`${left.length} left after two refusals`] : []),
  ];
  const end = shown.length ? [] : [`Nothing is left to rewrite now: tell the person what was corrected, and name each lesson marked unreliable or left, with why.`, laterWords(ticker, { unreliable: unreliable.length, flagged: flaggedOut.length, left: left.length })];
  return [`${due.length} lesson(s)${ticker ? ` on ${ticker}` : ''} to re-check: ${counts.join(', ')}.`, ...(shown.length ? [RULES] : []), '', ...shown, ...unreliable, ...flaggedOut, ...left, ...end].join('\n\n');
}

const sameWords = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** Replaces one settled call's lesson with one the agent rewrote from its window's rows (`correctOnce`), and keeps count:
 *  a refusal is said as one (INPUT_ERROR, to correct and send again) the first time, and the second time for the same
 *  lesson in this re-check as LEFT, so the team leaves it and goes on instead of sending it round again. Sent again after
 *  that with no lesson saved since, and refused, it answers STOP. */
export async function correctLesson(journal: Journal, scoring: Scoring, ticker: string, date: string, lesson: string, whatWasWrong: string, on: string = today(), now: number = Date.now()): Promise<string> {
  let answer: string;
  try { answer = await correctOnce(journal, scoring, ticker, date, lesson, whatWasWrong, on); } catch (err) {
    if (!(err instanceof Error)) throw err;
    const { n, answer: count } = countRefusal(journal, CHECK, ticker, date, err.message, now);
    if (count === 'again') throw err;
    if (count === 'stop') return `STOP: correct_lesson has now refused the new lesson of ${ticker} on ${date} ${n} times in this re-check (this time: ${err.message}). It was left after ${REFUSALS_TO_LEAVE} refusals, and no lesson has been saved since, so the re-check is going round in a loop. Do not send it again now: its lesson stays as it stands. Go on with any other lesson listed to rewrite, and at the end tell the person it was left, and why.`;
    return `LEFT: correct_lesson has now refused the new lesson of ${ticker} on ${date} ${n} times in this re-check (this time: ${err.message}). Leave it: do not send it again in this re-check, and its lesson stays as it stands. Go on with the next lesson, and at the end tell the person it was left, and why.`;
  }
  noteStep(journal, CHECK, now, answer.startsWith('Corrected: ') ? { ticker, date } : undefined);
  return answer;
}

/** The labels what_was_wrong lacks, as the desk finds them (any case, with or without bold around them). */
const missingLabels = (note: string) => CHECK_LABELS.filter((l) => !new RegExp(`(?:^|[^a-z])${l.slice(0, -1).replace(/ /g, '\\s+')}\\W{0,3}:`, 'i').test(note));

/** One correction: the lesson replaced once the desk has the window's rows again. The first lesson, any corrected lesson
 *  it replaces and what the check found are kept beside it; the call, its rating and its score are not touched. */
async function correctOnce(journal: Journal, scoring: Scoring, ticker: string, date: string, lesson: string, whatWasWrong: string, on: string): Promise<string> {
  const text = lesson.trim(), note = whatWasWrong.trim(), refused = lessonRefusal(text);
  if (refused) throw new Error(refused);
  if (!note) throw new Error(`what_was_wrong is empty: sort each statement of the lesson as it stands under ${listed(CHECK_LABELS.map((l) => `"${l}"`))}`);
  if (note.length > MAX_CHECK_NOTE) throw new Error(`what_was_wrong is ${note.length} characters; keep it under ${MAX_CHECK_NOTE}`);
  const missing = missingLabels(note);
  if (missing.length) throw new Error(`what_was_wrong has no ${listed(missing.map((l) => `"${l}"`))}: sort each statement of the lesson as it stands under the three labels, in this order: "${CHECK_LABELS[0]}" (quoted, with the row's date and figure), "${CHECK_LABELS[1]}" (quoted) and "${CHECK_LABELS[2]}" (the rest), writing "none" under a label with nothing in it`);
  const e = journal.load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) throw new Error(`there is no call on ${ticker} for ${date} in the journal`);
  if (e.pending) throw new Error(`the call on ${ticker} for ${date} is not settled yet: settle it with record_outcome`);
  if (e.lesson === 'prices') throw new Error(`the lesson of ${ticker} on ${date} was written from its window's prices already; it is rewritten only after the person says it is wrong (flag_lesson)`);
  if (e.lesson === 'corrected') throw new Error(`the lesson of ${ticker} on ${date} was corrected${e.lessonOn ? ` on ${e.lessonOn}` : ''} already; it is rewritten again only after the person says it is wrong (flag_lesson)`);
  // A lesson the person flagged may keep its words when what they said was wrong is only in its check.
  const same = sameWords(text, e.reflection);
  if (same && e.lesson !== 'flagged') throw new Error('the new lesson is the lesson as it stands, word for word: write it from the window\'s rows');
  let o: Outcome;
  try { ({ o } = await windowOf(e, scoring)); } catch (err) {
    if (!(err instanceof NoWindow)) throw err;
    return noWindow(journal, e, err.message, on) === 'flagged'
      ? `UNRELIABLE: ${err.message}. Your lesson is not saved, since it cannot be checked against the rows now. The lesson stays as the person flagged it: later analyses still do not read it, and a later re-check tries again.`
      : `UNRELIABLE: ${err.message}. Your lesson is not saved, since it cannot be checked against the rows now. The desk marked the lesson as it stands unreliable: later analyses no longer read it, and a later re-check tries again.`;
  }
  const flag = e.lesson === 'flagged' ? flagOf(e) ?? { on: e.lessonOn ?? 'an earlier day', said: '' } : null;
  const check = flag
    ? `${on}: rewritten from the holding window's real prices (${o.entry} to ${o.exit}), after the person said on ${flag.on} that the lesson before it was wrong${flag.said ? ` ("${flag.said}")` : ''}. What the check found: ${note}`
    : `${on}: rewritten from the holding window's real prices (${o.entry} to ${o.exit}); the first lesson, below, was written without them. What the check found: ${note}`;
  const kept = e.firstLesson
    ? 'The first lesson and the corrected lesson this replaces, with its check, are kept word for word in the journal beside the new one'
    : 'The first lesson is kept word for word in the journal beside the new one';
  return journal.correctLesson(ticker, date, text, check, on)
    ? `Corrected: the lesson of the ${e.rating} call on ${ticker} for ${date}, from its window ${o.entry} to ${o.exit}${same ? ' (its words are the same as before; only its check is new)' : ''}. Only the lesson changed: the call, its rating and its score (${e.raw}, alpha ${e.alpha}) stay as they are. ${kept}, with what the check found; later analyses read the new lesson, marked as corrected.`
    : `The lesson of ${ticker} on ${date} was changed by another run meanwhile; nothing was saved. Call recheck_lessons again.`;
}

/** On the person's word only: marks one settled call's lesson as wrong, so later analyses stop reading it at once and
 *  recheck_lessons lists it again to rewrite from its window's prices. `whatIsWrong` is what the person said (their words,
 *  or a review's finding they passed on). Nothing is removed: its words, its check, its earlier corrections and its first
 *  lesson stay. A lesson flagged already is not flagged again. A lesson this re-check left after two refusals is tried
 *  again: the person's word is new. Never changes the call, its rating or its score. */
export function flagLesson(journal: Journal, ticker: string, date: string, whatIsWrong: string, on: string = today(), now: number = Date.now()): string {
  const said = whatIsWrong.replace(/\s+/g, ' ').trim();
  if (!said) throw new Error('what_is_wrong is empty: pass what the person said is wrong about this lesson');
  if (said.length > MAX_CHECK_NOTE) throw new Error(`what_is_wrong is ${said.length} characters; keep it under ${MAX_CHECK_NOTE}`);
  const e = journal.load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) throw new Error(`there is no call on ${ticker} for ${date} in the journal`);
  if (e.pending) throw new Error(`the call on ${ticker} for ${date} is not settled yet, so it has no lesson to flag`);
  const done = journal.flagLesson(ticker, date, said, on);
  if (done === 'already') return `ALREADY FLAGGED: the person said on ${e.lessonOn ?? 'an earlier day'} that the lesson of ${ticker} on ${date} is wrong; nothing was written. Do not call flag_lesson again for it: recheck_lessons lists it to rewrite.`;
  if (done === 'none') return `The lesson of ${ticker} on ${date} was changed by another run meanwhile; nothing was written.`;
  noteStep(journal, CHECK, now, { ticker, date });
  const stay = listed(['its words', ...(e.lessonCheck ? ['its check'] : []), ...(e.earlier ? ['its earlier corrections'] : []), ...(e.firstLesson ? ['its first lesson'] : [])]);
  return `Flagged: the lesson of the ${e.rating} call on ${ticker} for ${date}, on the person's word that it is wrong. Later analyses stop reading it now. ${stay[0]!.toUpperCase()}${stay.slice(1)} stay in the journal, with what the person said, and recheck_lessons lists it to rewrite from its window's prices. The call, its rating and its score (${e.raw}, alpha ${e.alpha}) stay as they are.`;
}
