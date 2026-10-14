---
name: settle
description: Score the desk's past calls whose holding window has finished trading - each against its market index - and write a short lesson for each, which later analyses read. Use when the person runs /settle or asks how the desk's calls turned out.
argument-hint: [TICKER]
---

# Settle

The person asked: $ARGUMENTS

1. Call `list_settlements` (with the ticker, if one was given). It lists every pending call. A READY call shows its measured outcome and the decision as it was made; a NOT YET call's window has not finished; an unavailable one could not be priced.
2. For each READY call, write its lesson and save it with `record_outcome` (symbol, trade_date, lesson). The desk measures the outcome again itself: you pass only the lesson, never a number of your own. A lesson is:
   - exactly 2 to 4 sentences of plain prose: no bullets, no headings, no markdown;
   - in this order: (1) what the alpha over the holding window shows about the directional call, citing the figure as listed, and saying plainly if the window is too short to judge the thesis; (2) which part of the investment thesis this window supports or undercuts; (3) one concrete lesson to apply to the next similar analysis;
   - specific and terse. It is stored word for word and re-read by later analysts, so every word must earn its place.
3. Leave NOT YET and unavailable calls pending: they are tried again next time.
4. Tell the person in a short list: each call settled (date, ticker, rating, its return, the index's return and the alpha, as the tool reported them), how many are still pending and why. A short window says little about a long thesis: say so when it applies. Nothing here is investment advice.

Adapted from TradingAgents (tradingagents/memory/reflection.py), Apache License 2.0.
