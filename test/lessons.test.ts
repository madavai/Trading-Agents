import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure } from '../src/data/http.js';
import { clearCache } from '../src/data/yahoo.js';
import { Journal } from '../src/desk/journal.js';
import { correctLesson, lessonsToRecheck, NOTES_IDLE_MS, PER_LISTING, REFUSALS_TO_LEAVE } from '../src/desk/lessons.js';
import { settleOne } from '../src/desk/settle.js';
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
const WRONG = 'The first lesson said "NVDA stayed inside the 99-103.50 band all week"; the 2026-09-07 row closed at 104.00, above 103.50.';
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
  assert.match(t, /only when a row shows it, naming that row's date and figure\. What the rows cannot show \(news, earnings, a filing, a figure they do not hold\) is "not known from the prices", never a guess\./);
  assert.match(t, /\[2026-09-01 \| NVDA \| Buy \| \+10\.0% \| \+7\.0% \| 5d \| resolved:2026-09-08\] TO REWRITE: it was written before the desk showed the lesson writer the window's prices\./);
  assert.match(t, /ITS SCORE, WHICH STAYS AS IT IS: NVDA \+10\.0% from 2026-09-01 to 2026-09-08 \(5 trading days\); alpha \+7\.0%\./);
  const at = [`DECISION:\n${DECISION}`, `LESSON AS IT STANDS:\n${OLD}`, "WHAT HAPPENED IN THE WINDOW: NVDA's finished sessions from 2026-09-01 (entry) to 2026-09-08 (exit)"].map((s) => t.indexOf(s));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)), 'the decision, then the lesson as it stands, then what happened');
  assert.match(t, /\n2026-09-07 \| 104\.00 \| 104\.00 \| 104\.00 \| 104\.00 \| \+0\.97% \|/);   // the row that shows the add trigger fired
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
  assert.match(same, /REFLECTION \(corrected on 2026-11-07: rewritten from the holding window's real prices, replacing a first lesson written without them\):\nAlpha of \+7\.0%/);
  assert.match(other, /^Recent cross-ticker lessons:\n\n\[2026-09-01 \| NVDA \| Buy \| \+10\.0%\] \(lesson corrected on 2026-11-07: rewritten from the holding window's real prices, replacing a first lesson written without them\)\nAlpha of \+7\.0%/);
  for (const ctx of [same, other]) assert.ok(!ctx.includes(OLD) && !ctx.includes('LESSON CHECK') && !ctx.includes(WRONG), 'the first lesson is not read again');

  // a lesson is corrected once, and then nothing waits
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', `${NEW} Again.`, WRONG, '2026-11-08'), /was corrected on 2026-11-07 already/);
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
    [NEW, 'x'.repeat(700), /keep it under 600/],
  ] as const) {
    const k = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
    await assert.rejects(correctLesson(k, S, 'NVDA', '2026-09-01', lesson, wrong), why);
    assert.equal(k.load()[0]!.lesson, 'unmarked', 'nothing was changed by a refusal');
  }

  const k = new Journal(tmpFile());
  k.storeDecision('NVDA', '2026-09-01', DECISION);
  await settleOne(k, S, 'NVDA', '2026-09-01', 'Alpha was +7.0%.');
  await assert.rejects(correctLesson(k, S, 'NVDA', '2026-09-01', NEW, WRONG), /was written from its window's prices already; it needs no re-check/);
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
  assert.match(end, /Nothing is left to rewrite now: tell the person what was corrected, and name each lesson marked unreliable or left, with why\.\n\nLATER RE-CHECKS \(tell the person only this about them\): a corrected lesson is never re-checked again, and neither is one written from its window's prices\. A later re-check looks only at each lesson left here after two refusals \(once an hour has passed since this re-check's last step\) and the lesson of any call settled from now on when its window's prices cannot be had\.$/);

  // within the hour it stays left; an hour after the last step a re-check starts afresh and shows it again
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 5000 + NOTES_IDLE_MS - 1000), /1 left after two refusals/);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-08', t0 + 5000 + 2 * NOTES_IDLE_MS), /^1 lesson\(s\) to re-check: 1 to rewrite below\.[\s\S]*\[2026-09-01 \| NVDA .*\] TO REWRITE/);
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
  assert.match(stop, /LATER RE-CHECKS \(tell the person only this about them\): a corrected lesson is never re-checked again, and neither is one written from its window's prices\. A later re-check looks only at the lessons still to rewrite and the lesson of any call settled from now on/);
  assert.doesNotMatch(stop, /WHAT HAPPENED IN THE WINDOW|LESSON AS IT STANDS/, 'nothing to go round on');
  // the person asks again: shown in full, and once a lesson is saved the next listing is no repeat
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 60_000), /^2 lesson\(s\) to re-check: 2 to rewrite below\.[\s\S]*LESSON AS IT STANDS/);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07', t0 + 61_000), /^Corrected: /);
  assert.match(await lessonsToRecheck(j, S, undefined, '2026-11-07', t0 + 62_000), /^1 lesson\(s\) to re-check: 1 to rewrite below\./);
  // a listing of one stock is not the same list as one of all
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07', t0 + 63_000), /^1 lesson\(s\) on NVDA to re-check: 1 to rewrite below\./);
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07', t0 + 64_000), /^STOP: /);
});

test('the last words say truly what a later re-check does: a corrected lesson is never re-checked (7 Nov: "will re-check these")', async () => {
  configure({ fetch: feed() });
  const j = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  assert.match(await correctLesson(j, S, 'NVDA', '2026-09-01', NEW, WRONG, '2026-11-07'), /^Corrected: /);
  const done = await lessonsToRecheck(j, S, undefined, '2026-11-07');
  assert.equal(done, 'No lessons to re-check: every settled call\'s lesson was written from its window\'s prices, or corrected from them.\n\nLATER RE-CHECKS (tell the person only this about them): a corrected lesson is never re-checked again, and neither is one written from its window\'s prices. A later re-check looks only at the lesson of any call settled from now on when its window\'s prices cannot be had.');
  assert.match(await lessonsToRecheck(j, S, 'NVDA', '2026-11-07'), /A later re-check of NVDA looks only at/);
  // and they are true: the corrected lesson is not listed again, and correct_lesson will not take it
  await assert.rejects(correctLesson(j, S, 'NVDA', '2026-09-01', `${NEW} Again.`, WRONG, '2026-11-08'), /corrected on 2026-11-07 already/);

  // one marked unreliable is tried again from its prices
  const k = oldJournal([{ tag: tag('2026-09-01', '2026-09-08') }]);
  configure({ fetch: offline });
  clearCache();
  assert.match(await lessonsToRecheck(k, S, undefined, '2026-11-07'), /A later re-check looks only at each lesson marked unreliable \(from its window's prices, if they can be had then\) and the lesson of any call settled from now on/);
  // and the playbook says only that
  const skill = fs.readFileSync('.claude/skills/recheck-lessons/SKILL.md', 'utf8');
  assert.match(skill, /About later re-checks, say only what the desk's last answer gives under LATER RE-CHECKS, in plain words: a corrected lesson is never re-checked again, so never say that asking again will re-check the lessons corrected here\./);
  assert.doesNotMatch(skill, /asking again later re-checks those/);
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
