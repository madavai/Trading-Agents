---
name: routine
description: Run the desk's morning routine (score past calls, then analyse what is waiting and the starred watchlist stocks, on Mondays also re-rating the holdings with an old view, and list the new calls to decide on) or its evening wrap-up (score what is ready and report the day's calls and orders). Use when the person, or a routine scheduled in Madav, asks for the morning routine or the evening wrap-up. It never places an order.
argument-hint: morning|evening
---

# Routine

The person asked: $ARGUMENTS

A routine may be started by Madav's scheduler with no one watching. Never wait for an answer: if a step needs the person (for example no contact email is saved), skip what depends on it and say so at the end. Nothing in a routine places, changes or cancels an order. End your answer with one short line on its own that sums the routine up, for example `3 analysed, 1 skipped, 2 scored` or `2 calls today, 1 order sent, 4 to score`: a routine shows the last line as the run's result.

## Morning routine
Asked for as "the morning routine", "morning", or at the start of a market day.
1. Call `routine_brief` with kind `morning` and follow it. It gives today's order of work and the limit on how many stocks a morning analyses. On a Monday it has also put up to three of the person's holdings on the waiting list, those the desk has no view of or one a week old or more, to be re-rated at shallow depth.
2. Score past calls first, by the /settle playbook: `list_settlements`, then `record_outcome` with a lesson for each READY call.
3. Analyse each stock the brief lists, in its order, one after another, each by the /analyse playbook with today's date. Do not ask the person anything between stocks. A stock on the dashboard's waiting list (asked for there, re-rated on a Monday, or put there by the morning switch) is run as the /analyse playbook's waiting list says (`start_queue_item` first, which gives its depth; `finish_queue_item` once its call is recorded, or with why it failed); a starred stock uses the settings' depth. A stock whose analysis fails twice is noted and skipped; go on with the next. If the brief says so, call `end_queue_run` last.
4. Finish with a short plain list: each new call (stock, rating, one sentence of its executive summary from `read_run`; for a re-rated holding, its new rating beside its last one), anything skipped and why, and any data that was unavailable. Then say: decide on the dashboard ("Decide…" on a call), where only the person's own Confirm places an order; a Sell or Underweight on a holding of the Agentic account shows there as "the desk says sell", with a Sell button that opens a ticket, and nothing is ever sold by itself. This is not investment advice.

## Evening wrap-up
Asked for as "the evening wrap-up", "evening", or after the close.
1. Call `routine_brief` with kind `evening` and follow it.
2. Score what is ready, by the /settle playbook.
3. Tell the person in a short plain list: the desk's calls today, each in one sentence; the orders the dashboard sent today and what Robinhood answered; which may still be waiting for their approval on their phone (the team cannot see what happened since: say they can check the dashboard or the Robinhood app); and how many calls are still waiting to be scored. Use only the brief's facts and what the tools return. This is not investment advice.

## Never
- Never call a broker connection, open Robinhood's site, or call a tool that trades or moves money.
- Never invent a number. A source that could not be reached is "unavailable", never "nothing happened".
