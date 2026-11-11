// Faster re-runs (11 Nov 2026). The owner: "every new run for the same stock should be faster because agents don't have to
// go and get the data again from scratch"; "A new run should only take the delta". An analysis of today builds on the
// desk's latest full run of the stock from the 30 days before: the analysts write what changed since that day, carrying
// only what cannot have moved, each carried point with its day; the debate and the decision are redone as always. Never
// an earlier figure shown as today's.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { saveContactEmail } from '../src/contact.js';
import { buildPlan, earlierRunFor, renderPlan } from '../src/desk/plan.js';
import { builtOnOf, EARLIER, readPart, readSections, savedPlan, saveSection, startRun, stepTimes, stepWords, writeReport, type BuiltOn } from '../src/desk/runs.js';
import { Journal } from '../src/desk/journal.js';
import { workspaceOf } from '../src/desk/workspace.js';
import { readSettings } from '../src/settings.js';
import { callOf } from '../src/terminal/state.js';
import { deskServer } from '../src/tools/server.js';

const TODAY = '2026-11-11';
beforeEach(() => { process.env.TRADING_AGENTS_TODAY = TODAY; });

const folder = (settings?: (s: Record<string, Record<string, unknown>>) => void) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-rr-'));
  const s = JSON.parse(fs.readFileSync('desk-settings.json', 'utf8')) as Record<string, Record<string, unknown>>;
  settings?.(s);
  fs.writeFileSync(path.join(root, 'desk-settings.json'), JSON.stringify(s));
  saveContactEmail(root, 'jane@mail.com');
  return { root, dir: path.join(root, 'desk-data') };
};

const CHECKED = 'Checked the reports: no wrong and no misleading claims, corrected in place; 0 could not be checked.';
const ALL = ['market', 'sentiment', 'news', 'fundamentals'] as const;
/** A run of the desk as it is kept: its plan, its analysts' reports, a fact check, a decision and the finished report. */
function run(dir: string, sym: string, date: string, o: { analysts?: readonly string[]; language?: string; check?: boolean; report?: boolean; builtOn?: BuiltOn; record?: boolean } = {}): void {
  const analysts = o.analysts ?? ALL;
  startRun(dir, sym, date, { symbol: sym, analysisDate: date, analysts, language: o.language ?? 'English', ...(o.builtOn ? { builtOn: o.builtOn } : {}) });
  for (const a of analysts) saveSection(dir, sym, date, a as 'market', `${o.builtOn ? `What changed since ${o.builtOn.date}\n` : ''}${a} report of ${sym} on ${date}: revenue 10.0 bn as filed`);
  if (o.check !== false) saveSection(dir, sym, date, 'fact_check', CHECKED);
  saveSection(dir, sym, date, 'decision', `**Rating**: Hold\n\n**Executive Summary**: hold ${sym} as of ${date}.`);
  if (o.report !== false) writeReport(dir, sym, date, []);
  if (o.record) new Journal(path.join(dir, 'journal.md')).storeDecision(sym, date, `**Rating**: Hold\n\n**Executive Summary**: hold ${sym} as of ${date}.`, 'Hold');
}

test('an analysis of today builds on the latest full, finished, fact-checked run of the stock from the 30 days before', () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-10-01');                                                       // 41 days before: too old
  run(dir, 'NVDA', '2026-11-03');                                                       // the full run built on
  run(dir, 'NVDA', '2026-11-06', { builtOn: { date: '2026-11-03', analysts: ['market'] } });   // built on another: never a base
  run(dir, 'NVDA', '2026-11-07', { check: false });                                     // never fact-checked
  run(dir, 'NVDA', '2026-11-08', { report: false });                                    // never finished
  run(dir, 'NVDA', '2026-11-09', { language: 'Spanish' });                              // in another language
  run(dir, 'AAPL', '2026-11-10');                                                       // another stock
  const p = buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  assert.deepEqual(p.plan.builtOn, { date: '2026-11-03', analysts: ['market', 'sentiment', 'news', 'fundamentals'] });
  assert.deepEqual(builtOnOf(savedPlan(dir, 'NVDA', TODAY)), p.plan.builtOn, 'kept with the run, so a resumed run keeps it');
  const text = renderPlan(p);
  assert.match(text, /Builds on: the desk's full run of 2026-11-03\. market, sentiment, news, fundamentals write what changed since then, each reading their own report of that day with read_earlier_run first\. The fact checker checks what they carry from it\. The debate, the trader, the risk voices and the decision work from today's reports, as in every run\./);
  // the steps are the same thirteen kinds: only what the analysts write changes
  assert.deepEqual(p.plan.steps.map((s) => s.section).slice(0, 5), ['market', 'sentiment', 'news', 'fundamentals', 'fact_check']);
});

test('beyond the setting\'s days, with none to build on, asked for in full, for a past day or with the setting at 0, the run is full and says why', () => {
  const { root, dir } = folder();
  const why = (o: Partial<Parameters<typeof earlierRunFor>[1]>) => earlierRunFor(dir, { symbol: 'NVDA', day: TODAY, analysts: ['market', 'news'], language: 'English', days: 30, sweep: false, ...o });
  assert.match(renderPlan(buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY })), /Builds on: nothing, a full run \(the desk has no full, finished and fact-checked run of NVDA in English from the 30 days before 2026-11-11\)\./);
  run(dir, 'NVDA', '2026-10-11');                                                       // 31 days before
  assert.equal(why({}).builtOn, undefined);
  run(dir, 'NVDA', '2026-10-12');                                                       // exactly 30 days before: built on
  assert.equal(why({}).builtOn?.date, '2026-10-12');
  assert.deepEqual(why({ full: true }), { why: 'a full run was asked for' });
  assert.deepEqual(why({ sweep: true }), { why: 'a backtest analyses every day in full' });
  assert.deepEqual(why({ day: '2026-11-10' }), { why: 'a past day is analysed in full' });
  assert.deepEqual(why({ days: 0 }), { why: "the desk's settings make every analysis a full run (buildOnEarlierDays 0)" });
  const full = buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY, full: true, restart: true });
  assert.equal(full.plan.builtOn, undefined);
  assert.match(renderPlan(full), /Builds on: nothing, a full run \(a full run was asked for\)\./);
  // the setting: 30 as shipped, 0 makes every run full, anything else is kept within 0 to 30
  assert.equal(readSettings(root).analysis.buildOnEarlierDays, 30);
  const never = folder((s) => { s.analysis!.buildOnEarlierDays = 0; });
  run(never.dir, 'NVDA', '2026-11-10');
  assert.equal(buildPlan(never.root, { symbol: 'NVDA', analysisDate: TODAY }).plan.builtOn, undefined);
  assert.equal(readSettings(folder((s) => { s.analysis!.buildOnEarlierDays = 90; }).root).analysis.buildOnEarlierDays, 30, 'out of range: the shipped 30');
  // a backtest's day is always full, even with a run of its own to build on
  const sweep = workspaceOf(root, 'sw1');
  run(sweep.dir, 'NVDA', '2026-11-10');
  assert.equal(buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY }, sweep).plan.builtOn, undefined);
});

test('an analyst the earlier run did not have writes in full; a run resumed keeps what it was planned to build on', () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-11-09', { analysts: ['market', 'news'] });
  const p = buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  assert.deepEqual(p.plan.builtOn, { date: '2026-11-09', analysts: ['market', 'news'] });
  assert.match(renderPlan(p), /market, news write what changed since then, each reading their own report of that day with read_earlier_run first; sentiment, fundamentals write in full \(that run has no such report\)/);
  // the sentiment analyst writes in full: its first line need not name the day; the market analyst's must
  saveSection(dir, 'NVDA', TODAY, 'sentiment', 'A full sentiment report');
  assert.throws(() => saveSection(dir, 'NVDA', TODAY, 'market', 'Prices rose.\nMore.'), /this run builds on the desk's full run of 2026-11-09, so your report says what changed since then, and its first line names that day, for example "What changed since 2026-11-09"/);
  saveSection(dir, 'NVDA', TODAY, 'market', 'Lo que cambió desde 2026-11-09\nToday: ...');   // any language: the day is what is looked for
  // a full run of the stock saved meanwhile changes nothing for a run already going
  run(dir, 'NVDA', '2026-11-10');
  const again = buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  assert.equal(again.resumed, true);
  assert.deepEqual(again.plan.builtOn, { date: '2026-11-09', analysts: ['market', 'news'] });
  // and a run planned full stays full when resumed
  const { root: r2, dir: d2 } = folder();
  buildPlan(r2, { symbol: 'NVDA', analysisDate: TODAY });
  saveSection(d2, 'NVDA', TODAY, 'market', 'A full market report');
  run(d2, 'NVDA', '2026-11-10');
  const resumed = buildPlan(r2, { symbol: 'NVDA', analysisDate: TODAY });
  assert.equal(resumed.plan.builtOn, undefined);
  assert.match(renderPlan(resumed), /Builds on: nothing, a full run \(it began as a full run, and a run resumes as it was planned\)\./);
});

test('side by side, each stock builds only on its own earlier run', () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-11-05');
  run(dir, 'META', '2026-11-09');
  run(dir, 'AAPL', '2026-10-01');                                                       // too old: AAPL runs in full
  const plans = ['NVDA', 'META', 'AAPL'].map((s) => buildPlan(root, { symbol: s, analysisDate: TODAY }).plan);
  assert.deepEqual(plans.map((p) => p.builtOn?.date ?? 'full'), ['2026-11-05', '2026-11-09', 'full']);
  assert.match(readPart(dir, 'NVDA', TODAY, [`${EARLIER}:market`]), /market report of NVDA on 2026-11-05/);
  assert.doesNotMatch(readPart(dir, 'NVDA', TODAY, [EARLIER]), /META/);
  assert.match(readPart(dir, 'META', TODAY, [EARLIER]), /market report of META on 2026-11-09/);
});

test('the earlier reports come under a head the desk writes, naming their day and that they are not today\'s', () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-11-04', { analysts: ['market', 'news'] });
  buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  const all = readSections(dir, 'NVDA', TODAY, [EARLIER]);
  assert.match(all, /^## From the desk's full run of 2026-11-04 \(7 days before 2026-11-11\)\nThis run builds on it\. Below are the analysts' reports from that run, as its fact checker corrected them\. Every figure in them is as of 2026-11-04, not today: give one only with that date beside it, never as today's\.\n\n### Market Analyst, as of 2026-11-04\nmarket report of NVDA on 2026-11-04/);
  assert.match(all, /### News Analyst, as of 2026-11-04\nnews report/);
  const mine = readSections(dir, 'NVDA', TODAY, [`${EARLIER}:news`]);
  assert.match(mine, /Below is your report from that run, as its fact checker corrected it\. Every figure in it is as of 2026-11-04, not today/);
  assert.doesNotMatch(mine, /Market Analyst/, 'an analyst reads only its own report');
  assert.match(readSections(dir, 'NVDA', TODAY, [`${EARLIER}:sentiment`]), /^This run builds on the desk's full run of 2026-11-04, but not for the Sentiment Analyst: write your full report, as your instructions say\.$/);
  // a full run says so, never a blank
  const { root: r2, dir: d2 } = folder();
  buildPlan(r2, { symbol: 'NVDA', analysisDate: TODAY });
  assert.equal(readSections(d2, 'NVDA', TODAY, [`${EARLIER}:market`]), 'This run does not build on an earlier one: write your full report, as your instructions say.');
  assert.equal(readSections(d2, 'NVDA', TODAY, [EARLIER]), '(This run does not build on an earlier run: every report in it is a full report of its own.)');
});

test('each step keeps the time it was saved; the waiting list says what the analysts build on', () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-11-10');
  buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  assert.equal(stepWords(dir, 'NVDA', TODAY), 'analysts reading what changed since 10 Nov 2026: 0 of 4 done');
  const before = Date.now();
  saveSection(dir, 'NVDA', TODAY, 'market', 'What changed since 2026-11-10\nToday: ...');
  const times = stepTimes(dir, 'NVDA', TODAY);
  assert.deepEqual(times.map((t) => t.section), ['market']);
  assert.ok(Date.parse(times[0]!.at) >= before - 1000 && Date.parse(times[0]!.at) <= Date.now() + 1000, times[0]!.at);
  assert.equal(stepWords(dir, 'NVDA', TODAY), 'analysts reading what changed since 10 Nov 2026: 1 of 4 done');
  // a fact check and a debate turn are not analyst reports: no first line asked of them
  for (const a of ['sentiment', 'news', 'fundamentals'] as const) saveSection(dir, 'NVDA', TODAY, a, `What changed since 2026-11-10\n${a}`);
  saveSection(dir, 'NVDA', TODAY, 'fact_check', CHECKED);
  saveSection(dir, 'NVDA', TODAY, 'bull', 'Bull Analyst: up.');
  assert.equal(stepTimes(dir, 'NVDA', TODAY).length, 6);
});

test('the desk sees its own latest calls on the stock before they are scored, never with a result', () => {
  const { root, dir } = folder();
  const j = new Journal(path.join(dir, 'journal.md'));
  const rules = { days: 5, unit: 'trading' as const, yardstick: 'SPY', basis: 'us' as const };
  j.storeDecision('NVDA', '2026-11-03', '**Rating**: Buy\n\nOldest.', 'Buy', rules);
  j.storeDecision('NVDA', '2026-11-06', '**Rating**: Hold\n\nMiddle.', 'Hold', rules);
  j.storeDecision('NVDA', '2026-11-10', '**Rating**: Underweight\n\nLatest.', 'Underweight', rules);
  j.storeDecision('META', '2026-11-10', '**Rating**: Sell\n\nAnother stock.', 'Sell', rules);
  const { lessons } = buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY });
  assert.match(lessons, /The desk's latest calls on NVDA not scored yet \(latest first; the call's own view on its day, not how it turned out\):/);
  assert.match(lessons, /\[2026-11-10 \| NVDA \| Underweight \| not scored yet: it has no result, and is scored by [^\]]*SPY[^\]]*over the 5 trading days after the call once a scoring runs after that window\]\n\nDECISION:\n\*\*Rating\*\*: Underweight\n\nLatest\./);
  assert.ok(lessons.indexOf('2026-11-10 | NVDA') < lessons.indexOf('2026-11-06 | NVDA'), 'latest first');
  assert.doesNotMatch(lessons, /Oldest|Another stock/, 'the latest two, and only of this stock');
  const heads = lessons.match(/^\[[^\]]*not scored yet[^\]]*\]$/gm) ?? [];
  assert.equal(heads.length, 2);
  for (const h of heads) assert.doesNotMatch(h, /return -?\d|alpha|\d+(\.\d+)?%/i, 'no result of any kind');
  // a past day never sees them: they were made after it, or not yet known on it
  const past = buildPlan(root, { symbol: 'NVDA', analysisDate: '2026-11-07' }).lessons;
  assert.doesNotMatch(past, /not scored yet/);
  // nor does a call on the day itself count (one call a day)
  j.storeDecision('NVDA', TODAY, '**Rating**: Buy\n\nToday.', 'Buy', rules);
  assert.doesNotMatch(buildPlan(root, { symbol: 'NVDA', analysisDate: TODAY, restart: true }).lessons, /Today\./);
});

test('the tools: read_earlier_run gives an analyst its own earlier report; the report and the call page say what the run built on', async () => {
  const { root, dir } = folder();
  run(dir, 'NVDA', '2026-11-06', { record: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await deskServer(root).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  const at = { symbol: 'NVDA', analysis_date: TODAY };
  assert.match(await call('plan_analysis', at), /Builds on: the desk's full run of 2026-11-06/);
  assert.match(await call('read_earlier_run', { ...at, section: 'market' }), /^## From the desk's full run of 2026-11-06 \(5 days before 2026-11-11\)[\s\S]*### Market Analyst, as of 2026-11-06\nmarket report of NVDA on 2026-11-06/);
  assert.match(await call('read_run', { ...at, sections: ['earlier'] }), /### Fundamentals Analyst, as of 2026-11-06/);
  assert.match(await call('save_run_section', { ...at, section: 'market', text: 'Prices.' }), /^INPUT_ERROR: .*first line names that day/);
  for (const s of ALL) assert.match(await call('save_run_section', { ...at, section: s, text: `What changed since 2026-11-06\n${s} today` }), /^Saved/);
  await call('save_run_section', { ...at, section: 'decision', text: '**Rating**: Buy\n\n**Executive Summary**: buy.' });
  await call('write_report', at);
  const report = fs.readFileSync(path.join(dir, 'runs', `NVDA_${TODAY}`, 'complete_report.md'), 'utf8');
  assert.match(report, /- Built on: the desk's full run of 2026-11-06 \(its own report is kept in its folder\); the market, sentiment, news, fundamentals reports below say what changed since then, and what they carry from it is marked with that day/);
  // the earlier run's report is kept as it was: each call's Read opens its own
  assert.match(fs.readFileSync(path.join(dir, 'runs', 'NVDA_2026-11-06', 'complete_report.md'), 'utf8'), /market report of NVDA on 2026-11-06/);
  await call('record_decision', at);
  assert.equal(callOf(root, 'NVDA', TODAY)?.builtOn, '2026-11-06');
  assert.equal(callOf(root, 'NVDA', '2026-11-06')?.builtOn, undefined);
  // a full run asked for in words
  assert.match(await call('plan_analysis', { symbol: 'NVDA', analysis_date: TODAY, full: true, restart: true }), /Builds on: nothing, a full run \(a full run was asked for\)/);
  await client.close();
});
