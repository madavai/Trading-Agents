import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRating, parseRating, REVIEW } from '../src/desk/rating.js';

// Cases from TradingAgents' own tests (tests/test_rating_integrity.py, test_signal_processing.py), Apache License 2.0.
const INVERTED = 'The aggressive analyst pushed hard for a Buy on the AI backlog, but the conservative case on margin compression carried the debate. Final rating — Underweight. Trim to half weight over the next two weeks.';

test('the labelled rating wins whatever separates it', () => {
  for (const sep of [':', '-', '—', '–', '：', ': **']) assert.equal(extractRating(`Buy arguments were raised and rejected.\n\nRating${sep}Underweight\n\nTrim.`), 'Underweight', sep);
});

test('a rating argued against is not read as the decision', () => assert.equal(extractRating(INVERTED), 'Underweight'));

test('prose naming several ratings without a label needs review', () => {
  assert.equal(extractRating('The bull wants Buy, the bear wants Sell, and the committee was split.'), null);
});

test('a rating word without a label is not read as the call', () => {
  for (const prose of ['We would not Sell here; the dip is a chance to add.', '**评级**：买入\n\n不建议卖出 (Sell)。', 'On balance we stay Underweight until margins recover.']) {
    assert.equal(extractRating(prose), null, prose);
    assert.equal(parseRating(prose), REVIEW);
  }
});

test('a refusal has no rating and is not defaulted to a Hold', () => {
  assert.equal(parseRating("I'm sorry, I can't provide a rating for this security."), REVIEW);
  assert.equal(parseRating(''), REVIEW);
});

test('the scale quoted in a prompt does not become the rating', () => {
  assert.equal(extractRating('**Rating Scale**: Buy, Overweight, Hold, Underweight, Sell.\n\n**Rating**: Sell\n\nExit the position.'), 'Sell');
});

test('the decision shapes the portfolio manager writes are read', () => {
  assert.equal(extractRating('**Rating**: Overweight\n\n**Executive Summary**: Add gradually.'), 'Overweight');
  assert.equal(extractRating('## Final Rating - **buy**\n\nThesis.'), 'Buy');
  assert.equal(extractRating('Rating：Overweight'), 'Overweight');            // full-width colon
  assert.equal(extractRating('- **Rating**: Hold\n\nWhy.'), 'Hold');
  assert.equal(extractRating('1. Rating: Sell\n2. Reason: margins'), 'Sell');   // numbered list, the only label
  for (const r of ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell']) assert.equal(extractRating(`Rating: ${r}`), r);
});

test("someone else's rating is not the call", () => {
  assert.equal(extractRating('Consensus rating: Buy\n\n**Rating**: Hold'), 'Hold');       // the decision's own line beats a quoted one
  assert.equal(extractRating("Trader's rating: Buy\n\n**Rating**: Hold"), 'Hold');
  assert.equal(extractRating('Consensus rating: Buy\nOur view: Sell\nAnalyst rating: Hold'), null);   // two labels that differ are no call
  assert.equal(extractRating('Operating margin: Sell-side models differ.'), null);
});
