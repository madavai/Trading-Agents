import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { Journal } from '../src/desk/journal.js';
import { correctLesson, flagLesson, lessonsToRecheck, NOTES_IDLE_MS, PER_LISTING, REFUSALS_TO_LEAVE } from '../src/desk/lessons.js';
import { lessonRefusal, sentencesIn, sentencesOf, settleOne } from '../src/desk/settle.js';
import { CORRECTED_13, META_ENTRIES, META_ROWS, SPY_ROWS } from './lessons-2026-11-08.js';
import { DEFAULTS } from '../src/settings.js';
import { chartFetch, type Row } from './chart.js';

// Lessons written before the desk showed the lesson writer the holding window's prices are re-checked from those prices:
// rewritten from the rows alone, the first lesson kept beside the new one, the call, its rating and its score untouched.

const S = DEFAULTS.scoring;
const forward = (from: string, n: number): string[] => { const out: string[] = []; const d = new Date(`${from}T00:00:00Z`); while (out.length < n) { if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };
const rows = (from: string, n: number, closes: number[]): Row[] => forward(from, n).map((date, i) => ({ date, o: closes[i]!, h: closes[i]!, l: closes[i]!, c: closes[i]!, v: 1000 }));
// 2026-09-01 is a Tuesday: closes 100 (09-01), 101, 102, 103 (09-04), 104 (Mon 09-07), 110 (09-08), 111, 112 (09-10).
const NVDA = rows('2026-09-01', 8, [100, 101, 102, 103, 104, 110, 111, 112]);
const SPY = rows('2026-08-25', 15, [195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 206, 207, 208, 209, 210]);
const feed = () => chartFetch((sym) => ({ NVDA, AMD: NVDA, SPY })[sym] ?? []);
const offline = async (): Promise<Response> => { throw new TypeError('fetch failed'); };

const SEP = '\n\n<!-- ENTRY_END -->\n\n';
const DECISION = '**Rating**: Buy\n\n**Executive Summary**: Buy. Add on a close above 103.50; reduce on a close below 99.';
const OLD = 'NVDA stayed inside the 99-103.50 band all week, so neither trigger fired and holding was right.';
const NEW = 'Alpha of +7.0% over five sessions backs the Buy. The add trigger fired: NVDA closed at 104.00 on 2026-09-07, above 103.50, and at 110.00 on 2026-09-08. Next time, act on a trigger the day a close shows it.';
const WRONG = 'Contradicted: "NVDA stayed inside the 99-103.50 band all week": the 2026-09-07 row closed at 104.00, above 103.50. Not known from the prices: none. Right: none.';
const tag = (date: string, resolved: string, ticker = 'NVDA', score = '+10.0% | +7.0%') => `[${date} | ${ticker} | Buy | ${score} | 5d | resolved:${resolved}]`;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-l-')), 'journal.md');
/** A journal as the desk kept it before lessons were written from the window's prices: settled entries with no lesson mark. */
const oldJournal = (entries: Array<{ tag: string; lesson?: string }>) => {
  const file = tmpFile();
  fs.writeFileSync(file, entries.map((e) => `${e.tag}\n\nDECISION:\n${DECISION}\n\nREFLECTION:\n${e.lesson ?? OLD}`).join(SEP) + SEP);
  return new Journal(file);
};

beforeEach(() => { process.env.TRADING_AGENTS_TODAY = '2026-10-12'; clearCache(); });

test('a lesson settled now is marked by whether the window\'s prices were at hand; one written without them waits to be re-checked', async () => {
  configure({ fetch: feed() });
  const j = new Journal(tmpFile());
  j.storeDecision('NVDA', '2026-09-01', DECISION);
  await settleOne(j, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%.');
  assert.match(fs.readFileSync(j.file, 'utf8'), /^\[2026-09-01 \| NVDA \| Buy \| \+10\.0% \| \+7\.0% \| 5d \| resolved:2026-09-08 \| lesson:prices\]\n/);
  assert.equal(j.load()[0]!.lesson, 'prices');
  assert.match(await lessonsToRecheck(j, S), /^No lessons to re-check: every settled call's lesson was written from its window's prices, or corrected from them\.\n\nLATER RE-CHECKS/);

  // the window's long history cannot be had: the outcome is still measured, and the lesson waits to be re-checked
  const k = new Journal(tmpFile()), base = feed();
  k.storeDecision('NVDA', '2026-09-01', DECISION);
  const longAgo = (url: string) => Number(new URL(url).searchParams.get('period1')) < Date.parse('2026-08-01') / 1000;
  configure({ fetch: async (input, init) => { const url = String(input); if (url.includes('/NVDA?') && longAgo(url)) throw new TypeError('fetch failed'); return base(input, init); } });
  clearCache();
  assert.match(await settleOne(k, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%.'), /^Settled: NVDA \+10\.0%/);
  assert.match(fs.readFileSync(k.file, 'utf8'), /resolved:2026-09-08 \| lesson:no-prices\]/);
  assert.equal(k.load()[0]!.lesson, 'no-prices');
});

test('re-checking shows each old lesson with its score, its decision, the lesson as it stands and the window\'s rows, and writes nothing', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  const before = fs.readFileSync(j.file, 'utf8');
  assert.equal(j.load()[0]!.lesson, 'unmarked');
  const t = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.match(t, /^1 lesson\(s\) to re-check: 1 to rewrite below\.\n\nFor each call TO REWRITE: check every statement of its lesson against its window's rows, then save a new lesson with correct_lesson/);
  assert.match(t, /only when a row shows it, naming that row's date and figure\. A trigger the decision tied to more than one condition fired only when every condition did: a condition the rows cannot show leaves it "not known from the prices"\. What the rows cannot show \(news, earnings, a filing, a figure they do not hold\) is "not known from the prices", never a guess\./);
  assert.match(t, /\[2026-09-01 \| NVDA \| Buy \| \+10\.0% \| \+7\.0% \| 5d \| resolved:2026-09-08\] TO REWRITE: it was written before the desk showed the lesson writer the window's prices\./);
  assert.match(t, /ITS SCORE, WHICH STAYS AS IT IS: NVDA \+10\.0% from 2026-09-01 to 2026-09-08 \(5 trading days\); its index, SPY, \+3\.0% over the same days; alpha \+7\.0%\./);
  const at =[`DECISION:\n${DECISION}`, `LESSON AS IT STANDS:\n${OLD}`, "WHAT HAPPENED IN THE WINDOW: NVDA's finished sessions from 2026-09-01 (entry) to 2026-09-08 (exit)"].map((s) => t.indexOf(s));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)), 'the decision, then the lesson as it stands, then what happened');
  assert.match(t, /\n4 \| 2026-09-07 \| 104\.00 \| 104\.00 \| 104\.00 \| 104\.00 \| \+0\.97% \|/);   // the row that shows the add trigger fired
  assert.match(t, /\nentry \| 2026-09-01 \| 100\.00 \| 100\.00 \| 100\.00 \| 100\.00 \| left out \| 1,000 \|/, 'the entry row is marked, and its change left out');
  assert.match(t, /\nIN SESSIONS 1 TO 5 \(the entry row left out\): highest close 110\.00 on 2026-09-08; lowest close 101\.00 on 2026-09-02; highest high 110\.00 on 2026-09-08; lowest low 101\.00 on 2026-09-02\./);
  assert.match(await lessonsToRecheck(j, S, 'AMD'), /^No lessons on AMD to re-check/);
  assert.equal(fs.readFileSync(j.file, 'utf8'), before, 'listing a lesson to rewrite changes nothing');
});

test('a corrected lesson replaces only the lesson: the call, its rating, its score and the decision stay byte for byte, and the first lesson is kept, marked', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  const before = fs.readFileSync(j.file, 'utf8');
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07'),
    /^Corrected: the lesson of the Buy call on NVDA for 2026-09-01, from its window 2026-09-01 to 2026-09-08\. Only the lesson changed: the call, its rating and its score \(\+10\.0%, alpha \+7\.0%\) stay as they are\. The first lesson is kept word for word/);
  const after = fs.readFileSync(j.file, 'utf8'), decisionPart = (s: string) => s.slice(s.indexOf('\n'), s.indexOf('REFLECTION:'));
  assert.equal(decisionPart(after), decisionPart(before));
  assert.ok(after.startsWith('[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08 | lesson:corrected:2026-11-07]\n'));
  assert.ok(after.endsWith(`REFLECTION:\n${NEW}\n\nLESSON CHECK:\n2026-11-07: rewritten from the holding window's real prices (2026-09-01 to 2026-09-08); the first lesson, below, was written without them. What the check found: ${WRONG}\n\nFIRST LESSON:\n${OLD}${SEP}`));
  const e = j.load()[0]!;
  assert.deepEqual([e.rating, e.raw, e.alpha, e.holding, e.resolved, e.decision, e.reflection, e.lesson, e.lessonOn, e.firstLesson], ['Buy', '+10.0%', '+7.0%', '5d', '2026-09-08', DECISION, NEW, 'corrected', '2026-11-07', OLD]);

  // later analyses read the new lesson, marked as corrected, and never the first
  const same = j.pastContext('NVDA'), other = j.pastContext('AMD');
  assert.match(same, /REFLECTION \(corrected on 2026-11-07: rewritten from the holding window's real prices, replacing an earlier lesson\):\nAlpha of \+7\.0%/);
  assert.match(other, /^Recent cross-ticker lessons:\n\n\[2026-09-01 \| NVDA \| Buy \| \+10\.0%\] \(lesson corrected on 2026-11-07: rewritten from the holding window's real prices, replacing an earlier lesson\)\nAlpha of \+7\.0%/);
  for (const ctx of [same, other]) assert.ok(!ctx.includes(OLD) && !ctx.includes('LESSON CHECK') && !ctx.includes(WRONG), 'the first lesson is not read again');

  // a lesson is corrected once, and then nothing waits until the person says it is wrong
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', `${NEW} Again.`, WRONG, '2026-11-08'), /was corrected on 2026-11-07 already; it is rewritten again only after the person says it is wrong \(flag_lesson\)/);
  assert.match(await lessonsToRecheck(j, S), /^No lessons to re-check/);
});

test('a lesson whose window\'s prices cannot be had is marked unreliable by the desk, never guessed; analyses stop reading it until a later re-check corrects it', async () => {
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  configure({ fetch: offline });
  const t = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.match(t, /^1 lesson\(s\) to re-check: 0 to rewrite below, 1 marked unreliable\.\n/);
  assert.match(t, /\] UNRELIABLE: the prices of NVDA's window could not be had \(.+\)\. The desk marked its lesson unreliable: its words stay in the journal, and later analyses no longer read them\./);
  assert.doesNotMatch(t, /For each call TO REWRITE/);
  let e = j.load()[0]!;
  assert.deepEqual([e.lesson, e.lessonOn, e.reflection, e.raw, e.alpha, e.decision], ['unreliable', '2026-11-07', OLD, '+10.0%', '+7.0%', DECISION]);
  assert.match(e.lessonCheck, /^2026-11-07: unreliable\. It was written without the holding window's prices, and they could not be had to check it: the prices of NVDA's window could not be had/);
  const same = j.pastContext('NVDA');
  assert.match(same, /REFLECTION: withheld\. It was written without the holding window's prices, and they could not be had to check it on 2026-11-07\./);
  assert.ok(!same.includes(OLD));
  assert.equal(j.pastContext('AMD'), '', 'it brings no lesson to other stocks');

  // a rewrite sent while the prices are still out is not saved
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-08'), /^UNRELIABLE: the prices of NVDA's window could not be had .*Your lesson is not saved/);
  assert.deepEqual([j.load()[0]!.reflection, j.load()[0]!.lessonOn], [OLD, '2026-11-08']);

  // the prices are back: it is listed again, and the correction keeps the original words as the first lesson
  configure({ fetch: feed() });
  clearCache();
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-09'), /TO REWRITE: it was marked unreliable on 2026-11-08, since the window's prices could not be had to check it\./);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-09'), /^Corrected: /);
  e = j.load()[0]!;
  assert.deepEqual([e.lesson, e.lessonOn, e.reflection, e.firstLesson], ['corrected', '2026-11-09', NEW, OLD]);
  assert.doesNotMatch(fs.readFileSync(j.file, 'utf8'), /unreliable/);
});

test('a correction is refused when it would not be honest: not settled, written from the prices already, the same words, or nothing said about what was wrong', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  await assert.rejects(correctLesson(j, S, 'LATE', '2026-10-10', NEW, WRONG), /the call on LATE for 2026-10-10 is not settled yet: settle it with record_outcome/);
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-02', NEW, WRONG), /there is no call on NVDA for 2026-09-02 in the journal/);
  // each refusal the first time for its lesson (a second one leaves the lesson: below)
  for (const [lesson, wrong, why] of [
    [`  ${OLD.replace(/ /g, '  ')}\n`, WRONG, /the new lesson is the lesson as it stands, word for word/],
    [NEW, '  ', /what_was_wrong is empty/],
    [' ', WRONG, /the lesson is empty/],
    ['x'.repeat(1300), WRONG, /keep it under 1200/],
    [NEW, 'x'.repeat(1000), /keep it under 900/],
    [`${NEW} It held. It held again.`, WRONG, /^Error: the lesson has 5 sentences; write 2 to 4\. The desk ends a sentence at \. ! or \? followed by a space and a capital letter, a figure or a sign, .* It read these 5, beginning "Alpha of \+7\.0%…", "The add trigger…", "Next time, act…", "It held\.", "It held again\."$/],
    [NEW, 'The first lesson said the band held; the 2026-09-07 row closed at 104.00.', /what_was_wrong has no "Contradicted:", "Not known from the prices:" and "Right:": sort each statement of the lesson as it stands under the three labels, in this order/],
    [NEW, '**Contradicted**: "the band held": the 2026-09-07 row closed at 104.00. RIGHT: none.', /^Error: what_was_wrong has no "Not known from the prices:": /],
  ] as const) {
    const k = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
    await assert.rejects(correctLesson(k, S, 'NVDA', '2026-09-01', lesson, wrong), why);
    assert.equal(k.load()[0]!.lesson, 'unmarked', 'nothing was changed by a refusal');
  }

  const k = new Journal(tmpFile());
  k.storeDecision('NVDA', '2026-09-01', DECISION);
  await settleOne(k, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%.');
  await assert.rejects(correctLesson(k, S, 'NVDA', '2026-09-01', NEW, WRONG), /was written from its window's prices already; it is rewritten only after the person says it is wrong \(flag_lesson\)/);
});

test('a listing shows at most three to rewrite, oldest first, and counts the rest; a window that no longer matches its score is not checked against', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([
    { tag: tag('2026-08-31', '2026-09-04') },                       // the prices give a window ending 2026-09-08
    { tag: tag('2026-09-01', '2026-09-08') }, { tag: tag('2026-09-02', '2026-09-09') }, { tag: tag('2026-09-03', '2026-09-10') },
    { tag: tag('2026-09-01', '2026-09-08', 'AMD') },
  ]);
  assert.equal(PER_LISTING, 3);
  const t = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.match(t, /^5 lesson\(s\) to re-check: 3 to rewrite below, 1 more after these \(call recheck_lessons again once these are saved\), 1 marked unreliable\./);
  assert.deepEqual([...t.matchAll(/^\[(\S+) \| (\S+) .*\] TO REWRITE/gm)].map((m) => `${m[2]} ${m[1]}`), ['NVDA 2026-09-01', 'NVDA 2026-09-02', 'NVDA 2026-09-03']);
  assert.match(t, /\[2026-08-31 \| NVDA .*\] UNRELIABLE: the prices now give a window ending 2026-09-08, but the call was scored to 2026-09-04\./);
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) assert.match(await correctLesson(j, S, 'NVDA', d, NEW, WRONG, '2026-11-07'), /^Corrected: /);
  const next = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.match(next, /^2 lesson\(s\) to re-check: 1 to rewrite below, 1 marked unreliable\./);
  assert.match(next, /\[2026-09-01 \| AMD .*\] TO REWRITE/);
  assert.match(await lessonsToRecheck(j, S, 'AMD'), /^1 lesson\(s\) on AMD to re-check: 1 to rewrite below\./);
});

test('a lesson whose new words are refused twice is left, named, and not shown again in this re-check; an hour later a re-check tries it again', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }, { tag: tag('2026-09-02', '2026-09-09') }]);
  const t0 = Date.parse('2026-11-07T21:00:00Z');
  assert.equal(REFUSALS_TO_LEAVE, 2);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0), /^2 lesson\(s\) to re-check: 2 to rewrite below\./);
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', 'x'.repeat(1300), WRONG, '2026-11-07', t0 + 1000), /keep it under 1200/);
  const left = await correctLesson(j, S, 'NVDA', '2026-09-01', 'y'.repeat(1250), WRONG, '2026-11-07', t0 + 2000);
  assert.match(left, /^LEFT: correct_lesson has now refused the new lesson of NVDA on 2026-09-01 2 times in this re-check \(this time: the lesson is 1250 characters; keep it under 1200\)\. Leave it: do not send it again in this re-check, and its lesson stays as it stands\. Go on with the next lesson, and at the end tell the person it was left, and why\.$/);
  assert.equal(j.load()[0]!.reflection, OLD, 'its lesson stays as it stands');

  // the next listing names it, and shows the others in full
  const next = await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 3000);
  assert.match(next, /^2 lesson\(s\) to re-check: 1 to rewrite below, 1 left after two refusals\./);
  assert.match(next, /\[2026-09-01 \| NVDA .*\] LEFT: correct_lesson refused its new lesson 2 times in this re-check \(the last time: the lesson is 1250 characters; keep it under 1200\)\. Leave it: its lesson stays as it stands\. Name it to the person at the end, with that reason\./);
  assert.deepEqual([...next.matchAll(/^\[(\S+) \| NVDA .*\] TO REWRITE/gm)].map((m) => m[1]), ['2026-09-02']);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-02', NEW, WRONG, '2026-11-07', t0 + 4000), /^Corrected: /);
  const end = await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 5000);
  assert.match(end, /^1 lesson\(s\) to re-check: 0 to rewrite below, 1 left after two refusals\./);
  assert.match(end, /Nothing is left to rewrite now: tell the person what was corrected, and name each lesson marked unreliable or left, with why\.\n\nLATER RE-CHECKS \(tell the person only this about them\): asking for a re-check again does not re-check a corrected lesson, nor one written from its window's prices\. If the person finds one of them wrong, .* A later re-check looks only at each lesson left here after two refusals \(once an hour has passed since this re-check's last step\), any lesson the person later says is wrong and the lesson of any call settled from now on when its window's prices cannot be had\.$/);

  // within the hour it stays left; an hour after the last step a re-check starts afresh and shows it again
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 5000 + NOTES_IDLE_MS - 1000), /1 left after two refusals/);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-08', t0 + 5000 + 2 * NOTES_IDLE_MS), /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*\[2026-09-01 \| NVDA .*\] TO REWRITE/);
});

test('a lesson sent again after it was left, with nothing saved since, answers STOP; once another lesson is saved, a refusal is LEFT again', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }, { tag: tag('2026-09-02', '2026-09-09') }]);
  const t0 = Date.parse('2026-11-08T16:00:00Z');
  await lessonsToRecheck(j, S, undefined, '2026-11-08', t0);
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', 'x'.repeat(1300), WRONG, '2026-11-08', t0 + 1000), /keep it under 1200/);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', 'y'.repeat(1250), WRONG, '2026-11-08', t0 + 2000), /^LEFT: /);
  const stop = await correctLesson(j, S, 'NVDA', '2026-09-01', 'z'.repeat(1260), WRONG, '2026-11-08', t0 + 3000);
  assert.match(stop, /^STOP: correct_lesson has now refused the new lesson of NVDA on 2026-09-01 3 times in this re-check \(this time: the lesson is 1260 characters; keep it under 1200\)\. It was left after 2 refusals, and no lesson has been saved since, so the re-check is going round in a loop\. Do not send it again now: its lesson stays as it stands\. Go on with any other lesson listed to rewrite, and at the end tell the person it was left, and why\.$/);
  assert.equal(j.load()[0]!.reflection, OLD, 'its lesson stays as it stands');
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-02', NEW, WRONG, '2026-11-08', t0 + 4000), /^Corrected: /);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', 'y'.repeat(1250), WRONG, '2026-11-08', t0 + 5000), /^LEFT: .* 4 times in this re-check/, 'a lesson saved since: not a loop');
});

test('a lesson left after two refusals is shown again at once when the person says it is wrong: their word is new', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  const t0 = Date.parse('2026-11-08T15:00:00Z');
  await lessonsToRecheck(j, S, undefined, '2026-11-08', t0);
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', 'x'.repeat(1300), WRONG, '2026-11-08', t0 + 1000), /keep it under 1200/);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', 'y'.repeat(1250), WRONG, '2026-11-08', t0 + 2000), /^LEFT: /);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-08', t0 + 3000), /^1 lesson\(s\) to re-check: 0 to rewrite below, 1 left after two refusals\./);
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', 'It says NVDA stayed inside the band, but it closed above it.', '2026-11-08', t0 + 4000), /^Flagged: /);
  const again = await lessonsToRecheck(j, S, undefined, '2026-11-08', t0 + 5000);
  assert.match(again, /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*\[2026-09-01 \| NVDA .*\] TO REWRITE/, 'within the hour, and not as a STOP');
  assert.match(again, /WHAT THE PERSON SAID IS WRONG[^\n]*\nIt says NVDA stayed inside the band, but it closed above it\./);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', 'y'.repeat(1250), WRONG, '2026-11-08', t0 + 6000).catch((e: Error) => `INPUT_ERROR ${e.message}`), /^INPUT_ERROR /, 'its refusals count afresh: the first is said as one to correct');
});

test('the same lessons listed again with nothing saved since answer STOP, without the rows; asked again after that, they are shown in full', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }, { tag: tag('2026-09-02', '2026-09-09') }]);
  const t0 = Date.parse('2026-11-07T21:42:00Z');
  const first = await lessonsToRecheck(j, S, undefined, '2026-11-07', t0);
  assert.match(first, /2 to rewrite below/);
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', OLD, WRONG, '2026-11-07', t0 + 1000), /word for word/);   // a refusal saves nothing
  const stop = await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 2000);
  assert.match(stop, /^STOP: this is the same list of lessons to rewrite as the last one, at 21:42 UTC, and no lesson has been saved since, so the re-check is going round in a loop\. They are not shown again\.\n\nDo not call recheck_lessons or correct_lesson again now\. Tell the person which lessons are still to rewrite \(NVDA 2026-09-01 and NVDA 2026-09-02\), and why any of them was not saved, as correct_lesson's answers said\./);
  assert.match(stop, /LATER RE-CHECKS \(tell the person only this about them\): asking for a re-check again does not re-check a corrected lesson, nor one written from its window's prices\. .* A later re-check looks only at the lessons still to rewrite, any lesson the person later says is wrong and the lesson of any call settled from now on/);
  assert.doesNotMatch(stop, /WHAT HAPPENED IN THE WINDOW|LESSON AS IT STANDS/, 'nothing to go round on');
  // the person asks again: shown in full, and once a lesson is saved the next listing is no repeat
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 60_000), /^2 lesson\(s\) to re-check: 2 to rewrite below\.[\s\S]*LESSON AS IT STANDS/);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07', t0 + 61_000), /^Corrected: /);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 62_000), /^1 lesson\(s\) to re-check: 1 to rewrite below\./);
  // a listing of one stock is not the same list as one of all
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07', t0 + 63_000), /^1 lesson\(s\) on NVDA to re-check: 1 to rewrite below\./);
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07', t0 + 64_000), /^STOP: /);
});

const LATER = 'LATER RE-CHECKS (tell the person only this about them): asking for a re-check again does not re-check a corrected lesson, nor one written from its window\'s prices. If the person finds one of them wrong, they can say so, naming the stock, the call\'s date and what is wrong: later analyses then stop reading it at once, and a re-check rewrites it from its window\'s prices, keeping its earlier words.';

test('the last words say truly what a later re-check does: asking again re-checks no corrected lesson; the person\'s word that one is wrong does (8 Nov: "never re-checked again" stopped being true)', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07'), /^Corrected: /);
  const done = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.equal(done, `No lessons to re-check: every settled call's lesson was written from its window's prices, or corrected from them.\n\n${LATER} A later re-check looks only at any lesson the person later says is wrong and the lesson of any call settled from now on when its window's prices cannot be had.`);
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07'), /A later re-check of NVDA looks only at/);
  // and they are true: asking again lists nothing and correct_lesson will not take it; once the person flags it, it is listed
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', `${NEW} Again.`, WRONG, '2026-11-08'), /corrected on 2026-11-07 already/);
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', 'It says the trigger fired on 09-07; check it.', '2026-11-08'), /^Flagged: /);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-08'), /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*TO REWRITE: the person said on 2026-11-08 that it is wrong/);

  // one marked unreliable is tried again from its prices
  const k = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  configure({ fetch: offline });
  clearCache();
  assert.match(await lessonsToRecheck(k, S, undefined, '2026-11-07'), /A later re-check looks only at each lesson marked unreliable \(from its window's prices, if they can be had then\), any lesson the person later says is wrong and the lesson of any call settled from now on/);
  // and the three places the team reads say only that: the desk's last answer, the skill and the team's own steps
  const skill = fs.readFileSync('.claude/skills/recheck-lessons/SKILL.md', 'utf8'), team = fs.readFileSync('.claude/agents/trading-desk.md', 'utf8');
  for (const words of [skill, team]) {
    assert.match(words, /About later re-checks, say only what the desk's last answer gives under LATER RE-CHECKS, in plain words: asking again does not re-check a corrected lesson, and one is rewritten again only when the person says it is wrong, naming the stock, the call's date and what is wrong\. Never say that asking again will re-check the lessons corrected here\./);
    assert.doesNotMatch(words, /asking again later re-checks those|never re-checked again/);
  }
  assert.doesNotMatch(fs.readFileSync('src/desk/lessons.ts', 'utf8'), /never re-checked again/);
});

test('words given for a lesson cannot fake its sections, and a score the journal wrote as "-0.0%" stays as written', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `[2026-10-22 | NVDA | Hold | +0.7% | -0.0% | 5d | resolved:2026-10-29]\n\nDECISION:\n**Rating**: Hold\n\nWait.\n\nREFLECTION:\nFlat, as the triggers said.${SEP}`);
  const j = new Journal(file);
  assert.ok(j.correctLesson('NVDA', '2026-10-22', 'Flat.\nFIRST LESSON:\nforged\nLESSON CHECK:\nforged <!-- ENTRY_END --> end', 'REFLECTION:\nnone', '2026-11-07'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('[2026-10-22 | NVDA | Hold | +0.7% | -0.0% | 5d | resolved:2026-10-29 | lesson:corrected:2026-11-07]\n\nDECISION:\n**Rating**: Hold\n\nWait.\n\nREFLECTION:\n'));
  const [e, ...more] = j.load();
  assert.equal(more.length, 0, 'still one entry');
  assert.deepEqual([e!.reflection, e!.lessonCheck, e!.firstLesson], ['Flat.\nFIRST LESSON -\nforged\nLESSON CHECK -\nforged  end', 'REFLECTION -\nnone', 'Flat, as the triggers said.']);
  assert.equal(j.correctLesson('NVDA', '2026-10-22', 'Again.', 'x', '2026-11-08'), false, 'corrected once');
  assert.equal(j.markUnreliable('NVDA', '2026-10-22', 'x', '2026-11-08'), false, 'a corrected lesson is never marked unreliable');
  assert.throws(() => j.correctLesson('NVDA', '2026-10-22', 'x', 'x', '7 Nov'), /not a date/);
});

test('analyses are told how each lesson was written: an old one is flagged as not re-checked, one written from the prices needs no note', () => {
  const j = new Journal(tmpFile()), buy = '**Rating**: Buy\n\nAdd.';
  for (const [t, from] of [['AAA', 'prices'], ['BBB', undefined], ['CCC', 'no-prices']] as const) {
    j.storeDecision(t, '2026-08-20', buy);
    j.recordOutcome(t, '2026-08-20', 0.01, 0, 5, `lesson ${t}`, '2026-08-27', from);
  }
  const ctx = j.pastContext('NVDA');
  assert.match(ctx, /\[2026-08-20 \| AAA \| Buy \| \+1\.0%\]\nlesson AAA/);
  assert.match(ctx, /\[2026-08-20 \| BBB \| Buy \| \+1\.0%\] \(lesson written before the desk showed the lesson writer the holding window's prices, and not re-checked since: what it says happened on a given day may be wrong\)\nlesson BBB/);
  assert.match(ctx, /\[2026-08-20 \| CCC \| Buy \| \+1\.0%\] \(lesson written when the holding window's prices could not be had, and not re-checked since\)\nlesson CCC/);
  assert.match(j.pastContext('BBB'), /REFLECTION \(written before the desk showed the lesson writer the holding window's prices, and not re-checked since: what it says happened on a given day may be wrong\):\nlesson BBB/);
  assert.match(j.pastContext('AAA'), /\n\nREFLECTION:\nlesson AAA/);
});

const decisionPart = (s: string) => s.slice(s.indexOf('\n'), s.indexOf('REFLECTION:'));
const SAID = 'The lesson says the add trigger fired on 2026-09-07, but   the plan also\nneeded volume.';
const NEWER = 'Alpha of +7.0% over five sessions backs the Buy. NVDA closed at 104.00 on 2026-09-07, above 103.50, on 1,000 shares, the same volume as every session. Whether the plan\'s volume condition was met is not known from these rows. Next time, write each condition of a trigger beside the row that meets it.';
const SORTED = 'Contradicted: none. Not known from the prices: "The add trigger fired" (the plan also needed volume). Right: the rest.';

test('a corrected lesson the person says is wrong is withheld at once, listed again with their words, and rewritten keeping every earlier word; the call, its rating and its score never change', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07');
  const corrected = fs.readFileSync(j.file, 'utf8'), c = j.load()[0]!;
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', SAID, '2026-11-09'), /^Flagged: the lesson of the Buy call on NVDA for 2026-09-01, on the person's word that it is wrong\. Later analyses stop reading it now\. Its words, its check and its first lesson stay in the journal, with what the person said, and recheck_lessons lists it to rewrite from its window's prices\. The call, its rating and its score \(\+10\.0%, alpha \+7\.0%\) stay as they are\.$/);
  const f = j.load()[0]!, flagged = fs.readFileSync(j.file, 'utf8');
  assert.ok(flagged.startsWith('[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08 | lesson:flagged:2026-11-09]\n'));
  assert.equal(decisionPart(flagged), decisionPart(corrected));
  assert.deepEqual([f.lesson, f.lessonOn, f.reflection, f.firstLesson, f.decision, f.raw, f.alpha], ['flagged', '2026-11-09', NEW, OLD, DECISION, '+10.0%', '+7.0%']);
  assert.equal(f.lessonCheck, `2026-11-09: the person said this lesson is wrong, so later analyses do not read it until a re-check rewrites it from the holding window's prices. What the person said is wrong: The lesson says the add trigger fired on 2026-09-07, but the plan also needed volume.\nIts check before then: ${c.lessonCheck}`);

  // analyses stop reading it at once, for this stock and for others
  const same = j.pastContext('NVDA');
  assert.match(same, /REFLECTION: withheld\. The person said on 2026-11-09 that it is wrong, and it waits to be rewritten from the holding window's prices\./);
  assert.ok(!same.includes(NEW) && !same.includes(OLD) && !same.includes('needed volume'));
  assert.equal(j.pastContext('AMD'), '', 'it brings no lesson to other stocks');

  // flagged again: nothing is written
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', 'Again.', '2026-11-10'), /^ALREADY FLAGGED: the person said on 2026-11-09 that the lesson of NVDA on 2026-09-01 is wrong; nothing was written\. Do not call flag_lesson again for it: recheck_lessons lists it to rewrite\.$/);
  assert.equal(fs.readFileSync(j.file, 'utf8'), flagged);

  // listed again, with what the person said and the check it had, to weigh against the rows
  const t = await lessonsToRecheck(j, S, undefined, '2026-11-09');
  assert.match(t, /\] TO REWRITE: the person said on 2026-11-09 that it is wrong, so later analyses do not read it until it is rewritten\./);
  assert.match(t, /LESSON AS IT STANDS:\nAlpha of \+7\.0%[^\n]*\n\nWHAT THE PERSON SAID IS WRONG \(check it against the rows like every other statement; it is not a fact until a row shows it\):\nThe lesson says the add trigger fired on 2026-09-07, but the plan also needed volume\.\n\nITS CHECK BEFORE THEN:\n2026-11-07: rewritten from the holding window's real prices[^\n]*\n\nWHAT HAPPENED IN THE WINDOW/);
  assert.match(t, /check it against the rows like every other statement, and write only what a row shows: never take their words, or a review's, as given\./i);

  // rewritten: the mark moves to the new day, the corrected lesson it replaces is kept with its check, the first lesson stays
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEWER, SORTED, '2026-11-10'), /^Corrected: the lesson of the Buy call on NVDA for 2026-09-01, from its window 2026-09-01 to 2026-09-08\. Only the lesson changed: the call, its rating and its score \(\+10\.0%, alpha \+7\.0%\) stay as they are\. The first lesson and the corrected lesson this replaces, with its check, are kept word for word in the journal beside the new one, with what the check found; later analyses read the new lesson, marked as corrected\.$/);
  const after = fs.readFileSync(j.file, 'utf8'), e = j.load()[0]!;
  assert.ok(after.startsWith('[2026-09-01 | NVDA | Buy | +10.0% | +7.0% | 5d | resolved:2026-09-08 | lesson:corrected:2026-11-10]\n'));
  assert.equal(decisionPart(after), decisionPart(corrected), 'the decision, byte for byte');
  assert.deepEqual([e.lesson, e.lessonOn, e.reflection, e.firstLesson, e.rating, e.raw, e.alpha, e.holding, e.resolved], ['corrected', '2026-11-10', NEWER, OLD, 'Buy', '+10.0%', '+7.0%', '5d', '2026-09-08']);
  assert.equal(e.lessonCheck, `2026-11-10: rewritten from the holding window's real prices (2026-09-01 to 2026-09-08), after the person said on 2026-11-09 that the lesson before it was wrong ("The lesson says the add trigger fired on 2026-09-07, but the plan also needed volume."). What the check found: ${SORTED}`);
  assert.equal(e.earlier, `Lesson replaced on 2026-11-10:\n${NEW}\nIts check: ${f.lessonCheck}`);
  assert.ok(after.endsWith(`LESSON CHECK:\n${e.lessonCheck}\n\nEARLIER CORRECTIONS:\n${e.earlier}\n\nFIRST LESSON:\n${OLD}${SEP}`));
  const ctx = j.pastContext('NVDA');
  assert.match(ctx, /REFLECTION \(corrected on 2026-11-10: rewritten from the holding window's real prices, replacing an earlier lesson\):\nAlpha of \+7\.0% over five sessions backs the Buy\. NVDA closed at 104\.00/);
  for (const old of [NEW, OLD, 'needed volume', 'EARLIER CORRECTIONS', 'LESSON CHECK']) assert.ok(!ctx.includes(old), `analyses never read: ${old}`);

  // put right a second time: each corrected lesson it replaced is kept, newest first, and the first lesson stays the first
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', 'A second look.', '2026-11-11'), /^Flagged: .* Its words, its check, its earlier corrections and its first lesson stay in the journal/);
  const LAST = 'Alpha of +7.0% backs the Buy. NVDA closed at 104.00 on 2026-09-07, above 103.50. Next time, act on the first close above a trigger.';
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', LAST, SORTED, '2026-11-12'), /^Corrected: /);
  const g = j.load()[0]!;
  assert.deepEqual([g.lesson, g.lessonOn, g.reflection, g.firstLesson], ['corrected', '2026-11-12', LAST, OLD]);
  assert.ok(g.earlier.startsWith(`Lesson replaced on 2026-11-12:\n${NEWER}\nIts check: 2026-11-11: the person said this lesson is wrong`));
  assert.ok(g.earlier.endsWith(`\n\n${e.earlier}`), 'the older correction after it, word for word');
  assert.equal(decisionPart(fs.readFileSync(j.file, 'utf8')), decisionPart(corrected));
});

test('a lesson written from the prices can be flagged too: rewritten, it is kept as the first lesson, and the check says what the person said', async () => {
  configure({ fetch: feed() });
  const j = new Journal(tmpFile());
  j.storeDecision('NVDA', '2026-09-01', DECISION);
  await settleOne(j, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%. The add trigger never fired.');
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-09'), /rewritten only after the person says it is wrong \(flag_lesson\)/);
  assert.match(flagLesson(j, 'NVDA', '2026-09-01', 'It says the trigger never fired; 09-07 closed at 104.', '2026-11-09'), /^Flagged: .* Its words stay in the journal, with what the person said,/);
  assert.equal(j.load()[0]!.lessonCheck.includes('Its check before then'), false, 'it had no check before');
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-09'), / The first lesson is kept word for word in the journal beside the new one, with what the check found;/);
  const e = j.load()[0]!;
  assert.deepEqual([e.lesson, e.reflection, e.firstLesson, e.earlier], ['corrected', NEW, 'Alpha was +7.0%. The add trigger never fired.', '']);
  assert.match(e.lessonCheck, /^2026-11-09: rewritten from the holding window's real prices \(2026-09-01 to 2026-09-08\), after the person said on 2026-11-09 that the lesson before it was wrong \("It says the trigger never fired; 09-07 closed at 104\."\)\. What the check found: Contradicted:/);
});

test('a flagged lesson whose prices cannot be had stays flagged and withheld; one whose words were right may keep them, with a new check; a flag needs a settled call and what is wrong', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07');
  j.storeDecision('LATE', '2026-10-10', '**Rating**: Sell\n\nExit.');
  assert.throws(() => flagLesson(j, 'NVDA', '2026-09-01', '  \n ', '2026-11-09'), /what_is_wrong is empty: pass what the person said is wrong about this lesson/);
  assert.throws(() => flagLesson(j, 'NVDA', '2026-09-01', 'x'.repeat(1000), '2026-11-09'), /what_is_wrong is 1000 characters; keep it under 900/);
  assert.throws(() => flagLesson(j, 'NVDA', '2026-09-02', 'Wrong.', '2026-11-09'), /there is no call on NVDA for 2026-09-02 in the journal/);
  assert.throws(() => flagLesson(j, 'LATE', '2026-10-10', 'Wrong.', '2026-11-09'), /the call on LATE for 2026-10-10 is not settled yet, so it has no lesson to flag/);
  assert.equal(j.load()[0]!.lesson, 'corrected', 'nothing changed by a refusal');

  flagLesson(j, 'NVDA', '2026-09-01', 'Only its check is wrong: it calls a right statement contradicted.', '2026-11-09');
  configure({ fetch: offline });
  clearCache();
  const t = await lessonsToRecheck(j, S, undefined, '2026-11-09');
  assert.match(t, /^1 lesson\(s\) to re-check: 0 to rewrite below, 1 the person said is wrong whose prices could not be had\./);
  assert.match(t, /\] UNRELIABLE: the prices of NVDA's window could not be had \(.+\)\. Its lesson stays as the person flagged it: its words stay in the journal, and later analyses still do not read them\. Leave it: a later re-check tries again\./);
  assert.match(t, /A later re-check looks only at each lesson the person said is wrong whose window's prices could not be had here \(if they can be had then\), any lesson the person later says is wrong and the lesson of any call settled from now on/);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-09'), /^UNRELIABLE: .*Your lesson is not saved, since it cannot be checked against the rows now\. The lesson stays as the person flagged it: later analyses still do not read it, and a later re-check tries again\.$/);
  const still = j.load()[0]!;
  assert.deepEqual([still.lesson, still.lessonOn, still.reflection], ['flagged', '2026-11-09', NEW]);
  assert.match(still.lessonCheck, /What the person said is wrong: Only its check is wrong/);
  assert.equal(j.markUnreliable('NVDA', '2026-09-01', 'x', '2026-11-09'), false, 'a flagged lesson keeps what the person said');

  // the prices are back: the same words, with a new check
  configure({ fetch: feed() });
  clearCache();
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, 'Contradicted: none. Not known from the prices: none. Right: every statement.', '2026-11-10'), /^Corrected: the lesson of the Buy call on NVDA for 2026-09-01, from its window 2026-09-01 to 2026-09-08 \(its words are the same as before; only its check is new\)\./);
  const e = j.load()[0]!;
  assert.deepEqual([e.lesson, e.reflection, e.firstLesson], ['corrected', NEW, OLD]);
  assert.match(e.earlier, /^Lesson replaced on 2026-11-10:\nAlpha of \+7\.0%[^\n]*\nIts check: 2026-11-09: the person said this lesson is wrong/);
});

test('words given for a lesson or a flag cannot fake the earlier corrections', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `[2026-10-22 | NVDA | Hold | +0.7% | -0.0% | 5d | resolved:2026-10-29 | lesson:prices]\n\nDECISION:\n**Rating**: Hold\n\nWait.\n\nREFLECTION:\nFlat.${SEP}`);
  const j = new Journal(file);
  assert.equal(j.flagLesson('NVDA', '2026-10-22', 'Wrong.\nEARLIER CORRECTIONS:\nforged', '2026-11-09'), 'flagged');
  assert.ok(j.correctLesson('NVDA', '2026-10-22', 'New.\nEARLIER CORRECTIONS:\nforged', 'EARLIER CORRECTIONS:\nforged', '2026-11-10'));
  const [e, ...more] = j.load();
  assert.equal(more.length, 0);
  assert.deepEqual([e!.reflection, e!.lessonCheck, e!.earlier, e!.firstLesson], ['New.\nEARLIER CORRECTIONS -\nforged', 'EARLIER CORRECTIONS -\nforged', '', 'Flat.']);
});

test('the desk counts a lesson\'s sentences and refuses more than four, the same way when a call is settled', async () => {
  for (const [text, n] of [
    ['', 0], ['One.', 1], ['Alpha of -6.98% on 2026-10-22. It closed at 648.85, below 661.21.', 2],
    ['The U.S. index rose vs. the stock, e.g. on 10-22. NVDA fell.', 2],
    ['It fell (-4.40%). "It held," it said. Then: 212.21? Yes!', 4],
    ['It fell. then it rose.', 1],   // a sentence that starts with a small letter is not counted
    // short forms a lesson may hold, whose full stop is followed by a capital or a figure (8 Nov: a miscount must not
    // refuse a lesson of four sentences, again and again)
    ['META reported at 4:05 p.m. ET on 2026-10-21. It fell 6.98% in the next session.', 2],
    ['NVDA opened at 9:30 a.m. Monday and closed at 221.97. The gap filled.', 2],
    ['The U.S.A. index rose 0.7%. NVDA matched it.', 2],
    ['Rung No. 2 never traded, and rung no. 3 did. The stop held.', 2],
    ['Approx. 3% came on 2026-10-22, E.g. after the report. It held vs. SPY.', 2],
    ['The histogram went from -2.16 to +0.7 while SPY moved −0.6% and -.5% on 2026-10-22. NVDA fell 3.0%. -0.6% was the index\'s whole move.', 3],
    ['It rallied... Then it fell… Then it held at 212.21. The stop was 648.56.', 2],
    ['J. Powell spoke on 2026-10-22. NVDA fell.', 2],
  ] as const) assert.equal(sentencesIn(text), n, text);
  assert.deepEqual(sentencesOf('The U.S. index rose 0.7%. NVDA fell 3.0%, at 4 p.m. ET. It held.'), ['The U.S. index rose 0.7%.', 'NVDA fell 3.0%, at 4 p.m. ET.', 'It held.']);
  configure({ fetch: feed() });
  const j = new Journal(tmpFile());
  j.storeDecision('NVDA', '2026-09-01', DECISION);
  // the refusal says how the desk counts and where it cut, so the team can see a miscount and write around it
  await assert.rejects(settleOne(j, S, 'NVDA', '2026-09-01', 'One. Two. Three. Four. Five.'), /^Error: the lesson has 5 sentences; write 2 to 4\. The desk ends a sentence at \. ! or \? followed by a space and a capital letter, a figure or a sign, but not after a short form it knows \(such as a\.m\., U\.S\., e\.g\., No\., vs\., approx\. or a month\), an initial or an ellipsis\. It read these 5, beginning "One\.", "Two\.", "Three\.", "Four\.", "Five\."$/);
  assert.match(lessonRefusal('Alpha of +7.0% backs the Buy. NVDA closed at 104.00 on 2026-09-07. It rose. It held. Next time, act sooner.')!, /beginning "Alpha of \+7\.0%…", "NVDA closed at…", "It rose\.", "It held\.", "Next time, act…"$/);
  assert.equal(j.load()[0]!.pending, true, 'not settled');
  assert.match(await settleOne(j, S, 'NVDA', '2026-09-01', 'One. Two. Three. Four.'), /^Settled: /);
});

test('the real case of 8 Nov 2026: the desk counts 5 sentences in exactly the two lessons that have 5; the person flags the wrong ones and analyses stop reading them; META 10-21 is rewritten from its real rows, keeping every earlier word', async () => {
  process.env.TRADING_AGENTS_TODAY = '2026-11-09';
  const id = (tagText: string) => tagText.slice(1).split(' | ').slice(0, 2).reverse().join(' ');   // "META 2026-10-21"
  assert.equal(CORRECTED_13.length, 13);
  assert.deepEqual(CORRECTED_13.filter((c) => sentencesIn(c.lesson) > 4).map((c) => id(c.tag)), ['META 2026-10-21', 'META 2026-10-24']);
  assert.ok(CORRECTED_13.every((c) => sentencesIn(c.lesson) >= 3));

  // the journal as it stood on 8 Nov (the decisions, and the other first lessons and checks, left out of this test)
  const file = tmpFile(), full = new Map(META_ENTRIES.map((m) => [m.tag, m]));
  fs.writeFileSync(file, CORRECTED_13.map((c) => {
    const m = full.get(c.tag);
    return `${c.tag}\n\nDECISION:\n**Rating**: ${c.tag.split(' | ')[2]}\n\n(The decision is left out of this test.)\n\nREFLECTION:\n${c.lesson}\n\nLESSON CHECK:\n${m?.check ?? "2026-11-08: rewritten from the holding window's real prices. (The rest is left out of this test.)"}\n\nFIRST LESSON:\n${m?.first ?? '(Left out of this test.)'}`;
  }).join(SEP) + SEP);
  const j = new Journal(file), blocks = () => fs.readFileSync(file, 'utf8').split(SEP).filter(Boolean), before = blocks();
  assert.equal(j.load().filter((e) => e.lesson === 'corrected' && e.lessonOn === '2026-11-08').length, 13);
  configure({ fetch: chartFetch((sym) => ({ META: META_ROWS, SPY: SPY_ROWS })[sym] ?? []) });

  // asked again, nothing is re-checked; and the next NVDA analysis reads four of the false statements, marked corrected
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-09'), /^No lessons to re-check: [\s\S]*asking for a re-check again does not re-check a corrected lesson/);
  const FALSE = ['the journal rating never moved', 'the highest closes were 217.94 on 10-27 and 215.38 on 10-28', 'cost the whole +9.0%', 'The first session was fine'];
  const read = (ctx: string) => FALSE.filter((w) => ctx.includes(w));
  assert.deepEqual(read(j.pastContext('NVDA')), FALSE);

  // the person flags the lessons the review found wrong (the 7) and two with slips a reader could act on
  const flags: Array<[string, string, string]> = [
    ['NVDA', '2026-10-16', 'It says every close stayed below the 10 EMA; 10-21 closed above it.'],
    ['BTC-USD', '2026-10-16', 'It counts RSI as a condition of the plan, says highs failed to close above a level they never reached, and counts the entry close as a session.'],
    ['META', '2026-10-17', 'Its check calls "fell sharply through its 10-21 report" a mistake; the report came after the 10-21 close.'],
    ['NVDA', '2026-10-18', 'Its check says the first lesson called the gap unfilled; it only described the thesis.'],
    ['TSLA', '2026-10-20', 'The buy rule also needed a filing; and the whole +9.0% is not what waiting cost.'],
    ['META', '2026-10-21', 'It reads the entry day\'s +0.47% as the first session; the close did not go past the stop; it has 5 sentences.'],
    ['NVDA', '2026-10-22', 'The index was not flat (it rose 0.7%), and 10-26 closed higher than 10-28.'],
    ['NVDA', '2026-10-23', 'The index was not flat (it fell 0.6%).'],
    ['NVDA', '2026-10-28', 'The journal holds a later NVDA call, so "the journal rating never moved" is false.'],
  ];
  for (const [t, d, why] of flags) assert.match(flagLesson(j, t, d, why, '2026-11-09'), /^Flagged: /, `${t} ${d}`);
  const nvda = j.pastContext('NVDA');
  assert.deepEqual(read(nvda), [], 'none of the false statements is read');
  assert.equal((nvda.match(/REFLECTION: withheld\. The person said on 2026-11-09 that it is wrong/g) ?? []).length, 4, 'NVDA 10-28, 10-23, 10-22 and 10-18');
  assert.match(nvda, /\[2026-10-19 \| NVDA \| Underweight [\s\S]*REFLECTION \(corrected on 2026-11-08: /, 'NVDA 10-19, not flagged, is still read');
  assert.deepEqual([...nvda.matchAll(/^\[(\S+) \| (\S+) \| \S+ \| [^\]]+\] \(lesson/gm)].map((m) => `${m[2]} ${m[1]}`), ['META 2026-10-24', 'TSLA 2026-10-17'], 'the other stocks\' lessons read are the two not flagged');

  // META's two flagged lessons are listed with their real rows: the entry row marked, its change left out, the index's figure given
  const t = await lessonsToRecheck(j, S, 'META', '2026-11-09');
  assert.match(t, /^2 lesson\(s\) on META to re-check: 2 to rewrite below\./);
  const m21 = t.slice(t.indexOf('[2026-10-21 | META'));
  assert.match(m21, /^\[2026-10-21 \| META \| Overweight \| -12\.2% \| -12\.1% \| 5d \| resolved:2026-10-28\] TO REWRITE: the person said on 2026-11-09 that it is wrong/);
  assert.match(m21, /ITS SCORE, WHICH STAYS AS IT IS: META -12\.2% from 2026-10-21 to 2026-10-28 \(5 trading days\); its index, SPY, -0\.1% over the same days; alpha -12\.1%\./);
  assert.match(m21, /\nentry \| 2026-10-21 \| 697\.60 \| 713\.22 \| 689\.68 \| 697\.52 \| left out \| 29,203,900 \|/);
  assert.match(m21, /\n1 \| 2026-10-22 \| 676\.35 \| 681\.07 \| 639\.69 \| 648\.85 \| -6\.98% \| 40,571,000 \|/);
  assert.match(m21, /\nIN SESSIONS 1 TO 5 \(the entry row left out\): highest close 648\.85 on 2026-10-22; lowest close 612\.49 on 2026-10-28; highest high 681\.07 on 2026-10-22; lowest low 609\.00 on 2026-10-28\./);
  assert.ok(!m21.split('WHAT HAPPENED IN THE WINDOW')[1]!.includes('+0.47%'), 'the entry day\'s own change is not in its rows');
  assert.match(t, /\[2026-10-17 \| META [\s\S]*highest high 713\.22 on 2026-10-21;/, 'META 10-17: the 730-738 rung never traded');

  // the 5-sentence lesson as it stands is refused; one rewritten from the rows is saved
  const m = META_ENTRIES[1]!;
  await assert.rejects(correctLesson(j, S, 'META', '2026-10-21', m.lesson, SORTED, '2026-11-09'), /the lesson has 5 sentences; write 2 to 4/);
  const REWRITTEN = 'Alpha of -12.1% over five sessions (META -12.2%, its index SPY -0.1%) shows the Overweight was wrong. From the 697.52 entry close on 2026-10-21, session 1 (2026-10-22) fell -6.98% to 648.85 on 40,571,000 shares, a close below the 661.21 kill line, with an intraday low of 639.69 through the 648.56 stop, and every later session closed lower, to 612.49 on 2026-10-28. The 716.08 reclaim never came near: the highest high after entry was 681.07 on 2026-10-22. Lesson: into a print that settles the thesis within hours, wait for the first session after it before taking any exposure.';
  const NOTE = 'Contradicted: "The first session was fine - 2026-10-21 closed +0.47%": 2026-10-21 is the entry close; session 1, 2026-10-22, fell -6.98% to 648.85. "past the 648.56 stop": 2026-10-22 closed at 648.85, above it; only its low, 639.69, went through. Not known from the prices: "What the print said on margin or capex guidance". Right: the rest.';
  assert.match(await correctLesson(j, S, 'META', '2026-10-21', REWRITTEN, NOTE, '2026-11-09'), /^Corrected: the lesson of the Overweight call on META for 2026-10-21, from its window 2026-10-21 to 2026-10-28\./);
  const after = blocks(), e = j.load().find((x) => x.ticker === 'META' && x.date === '2026-10-21')!;
  assert.ok(after[8]!.startsWith('[2026-10-21 | META | Overweight | -12.2% | -12.1% | 5d | resolved:2026-10-28 | lesson:corrected:2026-11-09]\n'));
  assert.deepEqual([e.reflection, e.firstLesson], [REWRITTEN, m.first], 'the first lesson, word for word');
  assert.equal(e.earlier, `Lesson replaced on 2026-11-09:\n${m.lesson}\nIts check: 2026-11-09: the person said this lesson is wrong, so later analyses do not read it until a re-check rewrites it from the holding window's prices. What the person said is wrong: ${flags[5]![2]}\nIts check before then: ${m.check}`);
  // every call, its rating, its score and its decision stay byte for byte; the four not flagged are untouched
  for (const [i, b] of after.entries()) {
    assert.equal(b.slice(b.indexOf('\n'), b.indexOf('REFLECTION:')), before[i]!.slice(before[i]!.indexOf('\n'), before[i]!.indexOf('REFLECTION:')));
    assert.equal(b.slice(0, b.indexOf(' | lesson:')), before[i]!.slice(0, before[i]!.indexOf(' | lesson:')));
  }
  for (const i of [0, 3, 6, 11]) assert.equal(after[i], before[i], `${id(before[i]!)} is not flagged`);
  assert.match(j.pastContext('META'), /REFLECTION \(corrected on 2026-11-09: rewritten from the holding window's real prices, replacing an earlier lesson\):\nAlpha of -12\.1% over five sessions \(META -12\.2%, its index SPY -0\.1%\)/);
  assert.match(await lessonsToRecheck(j, S, 'META', '2026-11-09'), /^1 lesson\(s\) on META to re-check: 1 to rewrite below\.[\s\S]*\[2026-10-17 \| META [^\n]*TO REWRITE/);
});
