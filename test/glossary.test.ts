import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY, glossaryGroups, isTerm, means, type TermKey } from '../src/terminal/ui/glossary.js';
import { ratingMeaning } from '../src/terminal/ui/fmt.js';
import { RATINGS, REVIEW } from '../src/desk/rating.js';
import { RECORD_WEEKS, RECORD_WORDS } from '../src/desk/paper.js';

const ui = 'src/terminal/ui';
const read = (f: string) => fs.readFileSync(f, 'utf8');
const keys = Object.keys(GLOSSARY) as TermKey[];
const ratingKeys = new Set<string>([...RATINGS, REVIEW]);

test('"What does this mean?" holds about thirty words, each in one plain line, the ones a beginner meets first among them', () => {
  assert.ok(keys.length >= 28 && keys.length <= 36, `${keys.length} words`);
  for (const k of ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell', 'alpha', 'index', 'fund', 'sector', 'cap', 'limitOrder', 'stop', 'paper', 'depth', 'call', 'scorecard']) assert.ok(isTerm(k), k);
  const terms = new Set<string>();
  for (const k of keys) {
    const t = GLOSSARY[k];
    assert.ok(!terms.has(t.term), `${t.term} twice`); terms.add(t.term);
    assert.doesNotMatch(t.means, /\n/, `${k}: one line`);
    assert.match(t.means, /^[a-z0-9"'(].*[.]$/s, `${k}: a plain sentence after its word`);
    assert.ok(t.means.length <= 240, `${k}: ${t.means.length} characters is more than a line`);
    assert.equal(means(k), `${t.term}: ${t.means}`);
  }
  assert.deepEqual(glossaryGroups().flatMap((g) => g.terms.map((t) => t.key)), keys, 'the list shows every word, once, grouped in order');
});

test('alpha says how to read it for each rating: above zero is good only for a Buy or Overweight', () => {
  // Round 1 (7 Nov 2026): the line said "above zero, it beat the market", the opposite of the truth for an Underweight or Sell.
  assert.match(GLOSSARY.alpha.means, /beat \(\+\) or trailed \(−\) its market's index/);
  assert.match(GLOSSARY.alpha.means, /Above zero is good for a Buy or Overweight; below zero is good for an Underweight or Sell\./);
  assert.doesNotMatch(GLOSSARY.alpha.means, /beat the market|better \(\+\)|a call did/);
});

test('the S&P 500 is the index, SPY the fund the desk measures itself against, and a move is named for its day', () => {
  // Round 1 (7 Nov 2026): "S&P 500" named both the index (7,377) and SPY ($735.29), and a Saturday showed Friday's moves as today's.
  assert.match(GLOSSARY.sp500.means, /^the index of about 500 large US companies, chosen by a committee at S&P, taken together. /);
  assert.match(GLOSSARY.sp500.means, /SPY, the S&P 500 fund, copies it .* and is the yardstick the desk measures itself against\./);
  assert.match(GLOSSARY.scorecard.means, /against SPY, the S&P 500 fund,/);
  assert.equal(GLOSSARY.today.term, "Day's move");
  assert.match(GLOSSARY.today.means, /latest trading day.*When that day was not today, as on a weekend, the page names it/);
});

test('each rating\'s meaning on the page is the glossary\'s, and a rating the desk does not use has none made up', () => {
  for (const r of ratingKeys) { assert.ok(isTerm(r), r); assert.equal(ratingMeaning(r), means(r as TermKey), r); }
  assert.equal(ratingMeaning('alpha'), '', 'only ratings are ratings');
  assert.equal(ratingMeaning('Maybe'), '');
});

test('the glossary is used across the page: every word is pointed at somewhere, and only words it has', () => {
  const page = read(path.join(ui, 'main.ts')), html = read(path.join(ui, 'index.html'));
  const used = new Set<string>();
  for (const m of page.matchAll(/\b(?:term|means|chip)\(\s*'([^']+)'/g)) used.add(m[1]!);
  for (const m of page.matchAll(/\bterm:\s*'([^']+)'/g)) used.add(m[1]!);
  for (const m of page.matchAll(/,\s*'([a-zA-Z]+)'\)/g)) if (isTerm(m[1]!)) used.add(m[1]!);   // a figure's word, fact(name, value, 'volume')
  const marked = [...html.matchAll(/data-term="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(marked.length >= 3, 'the words written into the page itself are marked too');
  assert.deepEqual(marked.filter((k) => !isTerm(k)), [], 'a marked word the glossary does not have');
  for (const k of marked) used.add(k);
  assert.deepEqual([...used].filter((k) => !isTerm(k)), [], 'a word pointed at that the glossary does not have');
  assert.deepEqual(keys.filter((k) => !ratingKeys.has(k) && !used.has(k)), [], 'a word in the glossary that the page never explains');
  assert.match(page, /ratingChip = [^\n]*ratingMeaning/, 'every rating chip says what its rating means');
  assert.match(page, /querySelectorAll<HTMLElement>\('\[data-term\]'\)/, 'the marked words get their meaning at the start');
  assert.match(html, /data-act="gloss-open"/, 'the whole list opens from the side list');
});

test('each meaning is written once: no other part of the page spells out a word\'s line again', () => {
  const others = fs.readdirSync(ui).filter((f) => (f.endsWith('.ts') || f.endsWith('.html')) && f !== 'glossary.ts').map((f) => [f, read(path.join(ui, f))] as const);
  for (const k of keys) {
    const line = GLOSSARY[k].means.slice(0, 40);
    for (const [f, text] of others) assert.ok(!text.includes(line), `${f} repeats the meaning of ${k}`);
  }
});

test('the paper time before the money step is said one way everywhere: four weeks', () => {
  assert.equal(RECORD_WEEKS, 4);
  assert.equal(RECORD_WORDS, 'four weeks');
  for (const f of [path.join(ui, 'main.ts'), path.join(ui, 'index.html')]) assert.doesNotMatch(read(f), /\b(?:\d+|one|two|three|four|five|six) weeks?\b(?! of record)|minWeeks \?\? \d/, `${f} says the weeks itself instead of the desk's words`);
  for (const f of ['README.md', 'SECURITY.md', 'docs/inside-the-trading-desk.html']) {
    const text = read(f);
    assert.match(text, /four weeks/, `${f} says four weeks`);
    assert.doesNotMatch(text, /\b(?:[2-35-9]|two|three|five|six) weeks? (?:of (?:paper|record)|on paper)/i, `${f} gives another paper time`);
  }
});
