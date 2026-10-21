---
name: analyse
description: Analyse one stock (or crypto asset) on one date with the Trading Agents desk - four analysts, a bull and bear debate, a research manager, a trader, three risk voices and a portfolio manager - and record the call in the journal. Use when the person runs /analyse or asks the desk to analyse a ticker. It never places an order.
argument-hint: TICKER [YYYY-MM-DD] [shallow|medium|deep] [analysts=market,news] [language=Spanish]
---

# Analyse

The person asked: $ARGUMENTS

You run the desk: you call its agents in order and keep the work moving. You do not analyse yourself, and nothing you or any agent does places, changes or cancels an order.

## 1. Read the request
- **Ticker**: required, unless the person typed nothing after /analyse, or asked to analyse what is waiting on the dashboard. Then run the waiting list (section 6) instead of the steps below.
- **Date**: the analysis date, YYYY-MM-DD; today when none is given. A past date is analysed with only what was known then.
- **Depth**: shallow = 1, medium = 3, deep = 5 rounds of both the research and the risk debate. When none is given, leave the rounds out and the settings decide.
- **Analysts**: only if the person names some (market, sentiment, news, fundamentals).
- **Language**: only if the person names one.

## 2. Settle past calls first
Call `list_settlements`. For each call marked READY, write its lesson and save it with `record_outcome`, following the /settle skill's rules for a lesson. Leave NOT YET and unavailable calls alone. This puts the latest lessons into today's plan.

## 3. Plan
Call `plan_analysis` with the ticker, date, and any rounds, analysts or language the person asked for (debate_rounds and risk_rounds both take the depth's number).
- **NEEDS_EMAIL**: ask the person for their own email. Say in one sentence why: the SEC asks everyone who reads its filings for a contact address; it stays in this folder and only the SEC sees it. Save it with `set_contact_email`, never inventing one, then plan again.
- **INPUT_ERROR**: tell the person what to correct and stop.
- **Otherwise**: keep the plan. It lists the steps, marks any already done (a run that stopped is resumed), and gives the holdings block, the lessons and the manager model.

Tell the person in two lines what will run: the analysts, the rounds, the language, and that it takes a few minutes.

If the plan starts with a line naming a backtest sweep, and you were not asked to run one by the /backtest skill, an earlier sweep was left running: call `end_backtest`, then plan again, so this analysis goes into the live journal.

## 4. Run the steps, in the plan's order, skipping the ones marked done
Each agent is called with the Agent tool, `subagent_type` set to its name. Every request names the symbol (exactly as the plan gives it), the analysis date and the report language, and asks the agent to save its work. Agents save their work on the desk and reply with one line; do not paste their reports into the next request.

| Step | Agent | Add to the request |
|---|---|---|
| market, sentiment, news, fundamentals | market-analyst, sentiment-analyst, news-analyst, fundamentals-analyst | Start all of this run's analysts at once, in one message, and name in each request the analysts working in this run, so they can tell each other what to weigh. |
| bull (turn n), bear (turn n) | bull-researcher, bear-researcher | "This is turn n of N." Run them one at a time, bull first, in turn. |
| research_plan | research-manager | |
| trader | trader | The plan's holdings block, word for word. |
| aggressive, conservative, neutral (turn n) | aggressive-risk-analyst, conservative-risk-analyst, neutral-risk-analyst | The holdings block, and "This is turn n of N." One at a time, in that order. |
| decision | portfolio-manager | The holdings block and the lessons, word for word. |

For the research-manager and the portfolio-manager, if the plan's manager model is not "the same as everyone else", pass it as the Agent call's `model`.

After each step, check it was saved: call `read_run` without sections and see the section's count go up. If an agent did not save, call it once more with the same request. If it fails a second time, stop. Tell the person which step failed and that running /analyse again with the same ticker and date resumes from there.

## 5. Finish
1. Call `write_report`.
2. Call `record_decision` with the rating the portfolio manager's decision states (from its **Rating** line).
3. Inside a backtest (the plan starts with a line naming the sweep), skip the summary: reply with one line, the ticker, date and rating.
   Otherwise tell the person, in plain words:
   - the rating, and the executive summary in two or three sentences, from the saved decision (`read_run`, section decision);
   - any data that was unavailable, from the reports;
   - where the full report is;
   - that the call is now in the journal and will be scored against its market index after the holding window.

   Do not add numbers of your own. Say that this is not investment advice, and that the desk proposes but never trades: the person decides on the dashboard ("Decide…" on the call), and only their own Confirm there places an order.

## 6. The waiting list: the stocks asked for on the dashboard
A run of the waiting list is often started with nobody watching: by a routine, or by the listener the dashboard rings when the person presses Analyse. So in it you never ask the person anything and never wait for an answer; what cannot be done is marked failed, with why, for the person to read on the dashboard.
1. Settle past calls once (step 2), then call `read_queue`. It lists the stocks waiting, in order, each with the depth asked, and how many one run may analyse. If it says another stock is being analysed now, stop and say so: one stock runs at a time. If nothing is waiting, say so and stop.
2. Take the waiting stocks one at a time, in that order, up to that number. For each:
   - Call `start_queue_item`. START: plan with the date and the rounds it gives (step 3; no rounds when it says the settings decide). ALREADY: it was called today and is marked done; take the next. BUSY: stop the run and say why.
   - Run its steps (step 4) and finish it (step 5, without the summary: one line, the ticker and the rating).
   - Once its call is recorded, call `finish_queue_item` with the symbol alone: the dashboard shows it done, with its rating.
   - If it cannot be finished, call `finish_queue_item` with `failed_because`: one plain sentence the person reads, saying what went wrong and what to do, then go on with the next. If the plan answers NEEDS_EMAIL, do not ask: fail it with "the desk needs your email for the SEC: give it in a chat, then press Retry", and stop the run, since every stock would fail the same way. A step that fails twice: fail it with which step and why.
3. Call `end_queue_run` once, at the end, however the run stopped. If stocks are still waiting, it asks for another run.
4. Reply with one line per stock (the ticker, and its rating or why it failed), then the line `end_queue_run` gave. Nothing here is investment advice, and the desk never trades: the person decides on the dashboard.

## Never
- Never call a broker connection, open Robinhood's site, or call a tool that trades or moves money. Agents in this folder have no such tool, and the guard refuses one.
- Never invent a number, an email address or a holding. If the person tells you what they hold, save it with `set_holdings` before planning; if they don't, the desk says it is not provided.
