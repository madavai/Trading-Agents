---
name: recheck-lessons
description: Re-check the lessons of past calls that were not written from their holding window's real prices, and rewrite each from those prices, keeping the first lesson beside the new one, marked as corrected. Use when the person runs /recheck-lessons or asks to re-check, correct or fix the desk's lessons. It changes only the lessons, never a call, its rating or its score.
argument-hint: [TICKER]
---

# Re-check lessons

The person asked: $ARGUMENTS

1. Call `recheck_lessons` (with the ticker, if one was given). It finds every scored call whose lesson was not written from the holding window's prices: written before the desk showed them to the lesson writer, written when they could not be had, or marked unreliable before. Up to three are shown TO REWRITE, each with its score (which stays as it is), the decision as it was made, the lesson as it stands, and the window's finished sessions day by day (open, high, low, close, change, volume, RSI, MACD histogram, 10 EMA, 50 SMA) beside the index's close. One whose prices cannot be had is marked UNRELIABLE by the desk itself: later analyses stop reading it, and it needs nothing from you.
2. For each call TO REWRITE, check every statement of its lesson against its rows, then write a new lesson and save it with `correct_lesson` (symbol, trade_date, lesson, what_was_wrong). Write only from the rows, the decision and the score shown, never from the lesson as it stands. The new lesson is:
   - exactly 2 to 4 sentences of plain prose: no bullets, no headings, no markdown;
   - in this order: (1) what the alpha over the holding window shows about the directional call, citing the figure as listed, and saying plainly if the window is too short to judge the thesis; (2) which part of the investment thesis this window supports or undercuts; (3) one concrete lesson to apply to the next similar analysis;
   - true to the window's rows. Before writing about any price level, stop, target or trigger the decision named, find it in the rows. Say a level was reached, held or broken, or a trigger fired or not, only when a row shows it, and name that row's date and figure. What the rows cannot show (news, earnings, a filing, a figure they do not hold) is "not known from the prices", never a guess;
   - specific and terse. It is stored word for word and re-read by later analysts, so every word must earn its place.

   `what_was_wrong` quotes each statement of the lesson as it stands that the rows contradict, with the row that shows otherwise (its date and figure); if none is contradicted, it says so. The desk keeps the first lesson word for word beside the new one, marked as corrected, and never changes the call, its rating or its score.
3. If the listing said more calls wait after these, call `recheck_lessons` again and go on, until none is left to rewrite. If `correct_lesson` answers UNRELIABLE, the prices could not be had again: go on with the next.
4. Tell the person in a short list: each lesson corrected (date, ticker, rating, and in one plain sentence what the first lesson got wrong, or that nothing in it was contradicted), each marked unreliable and why, and that asking again later re-checks those. Say that the calls, their ratings and their scores are unchanged, and that later analyses read the corrected lessons, marked as corrected. Nothing here is investment advice.
