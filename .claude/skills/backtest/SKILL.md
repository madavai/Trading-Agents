---
name: backtest
description: Test how well the desk decides - run the analysis team over several stocks and past dates, then score each call against its market index and report by rating. Use when the person runs /backtest or asks how good the desk's calls would have been. Slow and costly: every date is a full team run.
argument-hint: TICKER[,TICKER...] START END [every=7] [shallow|medium|deep] [analysts=market,news]
---

# Backtest

The person asked: $ARGUMENTS

One analysis gives one decision, which cannot tell whether the desk decides well. A backtest runs the same team over a grid of stocks and past dates and scores what came back. It judges decision quality only; it is not a portfolio simulator, and nothing in it orders anything. The live journal is never touched.

## 1. Read the request
- **Stocks**: one or a few tickers (at most 10). **Start and end**: YYYY-MM-DD; the end is cut to today. **every**: days between analysis dates, 7 when none is given.
- **Depth** is shallow (1 round) unless the person says otherwise, and the **analysts** are the settings' unless named. A backtest is expensive; do not raise the depth on your own.
- If the stocks or the dates are missing, ask for them and stop.

## 2. Lay out the sweep
Call `start_backtest`.
- **NEEDS_EMAIL**: ask the person for their own email as /analyse does, save it with `set_contact_email`, and call again.
- **INPUT_ERROR**: tell the person what to correct and stop.
- Otherwise, **tell the person before running anything**: the number of cells (a stock on a date), that each cell is a full team run that takes minutes and a real amount of model use, and the limits it reports (for a past date, only prices, indicators, economic figures and SEC accounts are as known then; news, posts, odds, profile and insider trades are recent-only, so those reads are thin or unavailable and say so). If there are more than 3 cells, **ask whether to go ahead and wait for a yes**; on a no, call `end_backtest`.
- To resume an interrupted sweep, call `start_backtest` again with the same `sweep_id` and the same stocks and dates: cells already recorded are skipped.

## 3. Run the cells
For each cell still to run, one at a time, in the order listed: run the /analyse procedure for that stock and date, with the depth and analysts above. The desk records it all in the sweep's own journal; each cell ends with `record_decision`, and /analyse then replies with one line (ticker, date, rating). Print that line as the cell's progress.
- A cell that fails twice is noted and skipped; do not end the sweep for one cell. Say which ones failed at the end.
- Do not ask the person anything between cells.

## 4. Score
1. Run the /settle procedure for the sweep's pending calls: `list_settlements`, then `record_outcome` with a lesson for each READY call. Those still NOT YET stay pending.
2. Call `backtest_summary`, then `end_backtest`.
3. Report the figures exactly as the summary gives them: how many calls were scored, pending and unscored, and by rating the count, how often the direction was called right (Hold claims none) and the mean alpha. Add, in your own words, that this is a handful of calls from one run of the model: a hit rate over fewer than about 30 calls per rating is noise, text feeds are not archived, and past results do not promise future ones. Nothing here is investment advice.

## Never
- Never call a broker connection, open Robinhood's site, or use a tool that trades or moves money.
- Never work out a return, alpha or hit rate yourself; only the summary's figures are reported.
