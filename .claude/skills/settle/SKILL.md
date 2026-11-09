---
name: settle
description: Score the desk's past calls whose scoring window has passed - each a first-week check against its yardstick (SPY as shipped), not the call's own time horizon - and write a short lesson for each, which later analyses read. Use when the person runs /settle or asks how the desk's calls turned out.
argument-hint: [TICKER]
---

# Settle

The person asked: $ARGUMENTS

1. Call `list_settlements` (with the ticker, if one was given). It lists every pending call. A READY call shows its measured outcome, the decision as it was made, and what happened in the window: the entry row and the finished sessions after it, numbered from 1, day by day (open, high, low, close, change, volume, RSI, MACD histogram, 10 EMA, 50 SMA) beside its yardstick's close, and a THIS SCORE IS line naming the window and yardstick the call is scored by. A NOT YET call's window has not finished; an unavailable one could not be priced; a LEFT one `record_outcome` failed to settle twice in this scoring.
2. For each READY call, write its lesson and save it with `record_outcome` (symbol, trade_date, lesson). The desk measures the outcome again itself: you pass only the lesson, never a number of your own. A lesson is:
   - exactly 2 to 4 sentences of plain prose (the desk counts them and refuses more than 4): no bullets, no headings, no markdown;
   - in this order: (1) what the alpha over the window shows about the directional call, citing the figure as listed, and saying plainly if the window is too short to judge the thesis; (2) which part of the investment thesis this window supports or undercuts; (3) one concrete lesson to apply to the next similar analysis;
   - true to the window's rows. Before writing about any price level, stop, target or trigger the decision named, find it in the rows. Say a level was reached, held or broken, or a trigger fired or not, only when a row shows it, and name that row's date and figure. What the rows cannot show (news, earnings, a figure they do not hold) is "not known from the prices", never a guess. If the rows could not be fetched, say nothing about what happened on any day;
   - read as the rows are labelled: the row marked "entry" is the close the call is scored from, not a session of the window, so the call's first session is session 1; say how the yardstick moved with its figure as listed, never a word for it such as "flat";
   - specific and terse. It is stored word for word and re-read by later analysts, so every word must earn its place.
3. If `record_outcome` refuses a lesson (INPUT_ERROR), correct what it says once and send it again: a lesson with too many sentences is refused with how the desk counts them and where it cut. If it answers LEFT, it has failed to settle that call twice: leave it, go on with the next READY call, and name it at the end with the reason it gave. If it answers STOP for a call, it was sent again after it was left: leave it too, and never send it again in this scoring. A call `list_settlements` shows as LEFT is left the same way. A call left stays pending and unscored, with no lesson; a later scoring, started an hour or more after `record_outcome` was last used, tries it again.
4. Leave NOT YET and unavailable calls pending: they are tried again next time.
5. Tell the person in a short list: each call settled (date, ticker, rating, its return, its yardstick's return and the alpha, as the tool reported them; a call on its yardstick itself, or on a fund that copies the same index, is scored on its own return, so give its return alone), each call left (date, ticker, the reason `record_outcome` gave, and that a later scoring tries it again), how many are still pending and why. Say once that each score is a first-week check against its yardstick (or on its own return, for a call on the yardstick itself), as its THIS SCORE IS line says, not the call's own time horizon: a short window says little about a long thesis. Nothing here is investment advice.

Adapted from TradingAgents (tradingagents/memory/reflection.py), Apache License 2.0.
