// Re-checking the lessons of settled calls that were not written from their holding window's prices: those written before
// the desk showed the lesson writer the window's rows (no mark in the journal), those written when the rows could not be
// had, and those marked unreliable before. The desk lists each with its decision, its lesson as it stands and the window's
// rows; the agent rewrites the lesson from the rows alone, and the desk keeps the first lesson word for word beside the new
// one, marked as corrected - the same honesty as the fact checker's [corrected: was "..."]. A call whose rows cannot be
// had is marked unreliable by the desk itself, so nobody guesses, and analyses stop reading its lesson until a later
// re-check. Only the lesson ever changes: never the call, its rating or its score.
import { Journal, UNCHECKED, type Entry } from './journal.js';
import { measure, resolveBenchmark, type Outcome, type Scoring } from './scoring.js';
import { windowRows } from './window.js';
import { MAX_REFLECTION } from './settle.js';
import { today } from '../data/dates.js';

/** How many calls one listing shows in full: each carries its whole decision. The others wait for the next listing. */
export const PER_LISTING = 3;
export const MAX_CHECK_NOTE = 600;

class NoWindow extends Error {}

const tagOf = (e: Entry) => `[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw} | ${e.alpha} | ${e.holding} | resolved:${e.resolved}]`;

/** Why this lesson waits to be re-checked, in the journal's own terms. */
const whyOf = (e: Entry): string =>
  e.lesson === 'unreliable' ? `it was marked unreliable${e.lessonOn ? ` on ${e.lessonOn}` : ''}, since the window's prices could not be had to check it`
    : e.lesson === 'no-prices' ? "it was written when the window's prices could not be had"
      : "it was written before the desk showed the lesson writer the window's prices";

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

const RULES = [
  'For each call TO REWRITE: check every statement of its lesson against its window\'s rows, then save a new lesson with correct_lesson (symbol, trade_date, lesson, what_was_wrong). Write only from the rows, the decision and the score shown here.',
  'The lesson: 2 to 4 sentences of plain prose, no bullets, headings or markdown; (1) what the alpha over the window shows about the directional call, citing the figure as listed, and saying plainly if the window is too short to judge the thesis; (2) which part of the thesis the window supports or undercuts; (3) one concrete lesson for the next similar analysis.',
  'Before writing about any level, stop, target or trigger the decision named, find it in the rows: say it was reached, held or broken, or that a trigger fired or not, only when a row shows it, naming that row\'s date and figure. What the rows cannot show (news, earnings, a filing, a figure they do not hold) is "not known from the prices", never a guess.',
  'what_was_wrong: each statement of the lesson as it stands that the rows contradict, quoted, with the row that shows otherwise (its date and figure); or, if none is, say so. The desk keeps the first lesson word for word beside the new one, marked as corrected. The call, its rating and its score stay as they are.',
].join('\n');

/** Every settled call whose lesson waits to be re-checked (of one stock, if named), oldest first: up to PER_LISTING shown
 *  in full to rewrite. One whose window's rows cannot be had is marked unreliable here, by the desk, with why. */
export async function lessonsToRecheck(journal: Journal, scoring: Scoring, ticker?: string, on: string = today()): Promise<string> {
  const due = journal.load().filter((e) => !e.pending && UNCHECKED.includes(e.lesson) && (!ticker || e.ticker === ticker));
  if (!due.length) return `No lessons${ticker ? ` on ${ticker}` : ''} to re-check: every settled call's lesson was written from its window's prices, or corrected from them.`;
  const shown: string[] = [], unreliable: string[] = [];
  let later = 0;
  for (const e of due) {
    if (shown.length >= PER_LISTING) { later++; continue; }
    try {
      const w = await windowOf(e, scoring);
      shown.push([
        `${tagOf(e)} TO REWRITE: ${whyOf(e)}.`,
        `ITS SCORE, WHICH STAYS AS IT IS: ${e.ticker} ${e.raw} from ${w.o.entry} to ${w.o.exit} (${w.o.holdingDays} trading days); alpha ${e.alpha}.`,
        `DECISION:\n${e.decision}`,
        `LESSON AS IT STANDS:\n${e.reflection}`,
        w.rows,
      ].join('\n\n'));
    } catch (err) {
      if (!(err instanceof NoWindow)) throw err;
      journal.markUnreliable(e.ticker, e.date, unreliableNote(on, err.message), on);
      unreliable.push(`${tagOf(e)} UNRELIABLE: ${err.message}. The desk marked its lesson unreliable: its words stay in the journal, and later analyses no longer read them. Leave it: a later re-check tries again.`);
    }
  }
  const counts = [`${shown.length} to rewrite below`, ...(later ? [`${later} more after these (call recheck_lessons again once these are saved)`] : []), ...(unreliable.length ? [`${unreliable.length} marked unreliable`] : [])];
  return [`${due.length} lesson(s)${ticker ? ` on ${ticker}` : ''} to re-check: ${counts.join(', ')}.`, ...(shown.length ? [RULES] : []), '', ...shown, ...unreliable].join('\n\n');
}

const sameWords = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** Replaces one settled call's lesson with one the agent rewrote from its window's rows, once the desk has the rows again.
 *  The first lesson and what the check found are kept beside it; the call, its rating and its score are not touched. */
export async function correctLesson(journal: Journal, scoring: Scoring, ticker: string, date: string, lesson: string, whatWasWrong: string, on: string = today()): Promise<string> {
  const text = lesson.trim(), note = whatWasWrong.trim();
  if (!text) throw new Error('the lesson is empty: write 2 to 4 plain sentences');
  if (text.length > MAX_REFLECTION) throw new Error(`the lesson is ${text.length} characters; keep it under ${MAX_REFLECTION}`);
  if (!note) throw new Error('what_was_wrong is empty: quote each statement the rows contradict, with the row, or say that none is');
  if (note.length > MAX_CHECK_NOTE) throw new Error(`what_was_wrong is ${note.length} characters; keep it under ${MAX_CHECK_NOTE}`);
  const e = journal.load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) throw new Error(`there is no call on ${ticker} for ${date} in the journal`);
  if (e.pending) throw new Error(`the call on ${ticker} for ${date} is not settled yet: settle it with record_outcome`);
  if (e.lesson === 'prices') throw new Error(`the lesson of ${ticker} on ${date} was written from its window's prices already; it needs no re-check`);
  if (e.lesson === 'corrected') throw new Error(`the lesson of ${ticker} on ${date} was corrected${e.lessonOn ? ` on ${e.lessonOn}` : ''} already`);
  if (sameWords(text, e.reflection)) throw new Error('the new lesson is the lesson as it stands, word for word: write it from the window\'s rows');
  let o: Outcome;
  try { ({ o } = await windowOf(e, scoring)); } catch (err) {
    if (!(err instanceof NoWindow)) throw err;
    journal.markUnreliable(ticker, date, unreliableNote(on, err.message), on);
    return `UNRELIABLE: ${err.message}. Your lesson is not saved, since it cannot be checked against the rows now. The desk marked the lesson as it stands unreliable: later analyses no longer read it, and a later re-check tries again.`;
  }
  const check = `${on}: rewritten from the holding window's real prices (${o.entry} to ${o.exit}); the first lesson, below, was written without them. What the check found: ${note}`;
  return journal.correctLesson(ticker, date, text, check, on)
    ? `Corrected: the lesson of the ${e.rating} call on ${ticker} for ${date}, from its window ${o.entry} to ${o.exit}. Only the lesson changed: the call, its rating and its score (${e.raw}, alpha ${e.alpha}) stay as they are. The first lesson is kept word for word in the journal beside the new one, with what the check found; later analyses read the new lesson, marked as corrected.`
    : `The lesson of ${ticker} on ${date} was changed by another run meanwhile; nothing was saved. Call recheck_lessons again.`;
}
