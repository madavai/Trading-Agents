---
name: analyse
description: Analyse one stock (or crypto asset) on one date with the Trading Agents desk - four analysts, a fact checker, a bull and bear debate, a research manager, a trader, three risk voices and a portfolio manager - and record the call in the journal. Use when the person runs /analyse or asks the desk to analyse a ticker. It never places an order.
argument-hint: TICKER [YYYY-MM-DD] [shallow|medium|deep] [analysts=market,news] [language=Spanish]
---

# Analyse

The person asked: $ARGUMENTS

You run the desk: you call its agents in order and keep the work moving. You do not analyse yourself, and nothing you or any agent does places, changes or cancels an order.

## 1. Read the request
- **Ticker**: required, unless the person typed nothing after /analyse, or asked to analyse what is waiting on the dashboard. Then run the waiting list (section 6) instead of the steps below.
- **Date**: the analysis date, YYYY-MM-DD; today when none is given. A past date is analysed with what was out by then: its prices adjusted for every split and dividend since, its economic figures at today's revised values, and news, posts and odds thin or unavailable (they exist only for recent days).
- **Depth**: shallow = 1, medium = 3, deep = 5 rounds of both the research and the risk debate. When none is given, leave the rounds out and the settings decide.
- **Analysts**: only if the person names some (market, sentiment, news, fundamentals).
- **Language**: only if the person names one.

## 2. Settle past calls first
Call `list_settlements`. For each call marked READY, write its lesson and save it with `record_outcome`, following the /settle skill's rules for a lesson. Leave NOT YET and unavailable calls alone. This puts the latest lessons into today's plan.

## 3. Plan
Call `plan_analysis` with the ticker, date, and any rounds, analysts or language the person asked for (debate_rounds and risk_rounds both take the depth's number).
- **NEEDS_EMAIL**: ask the person for their own email. Say in one sentence why: the SEC asks every program that reads its filings for a contact address; it stays in this folder and is sent to the SEC alone. Save it with `set_contact_email`, never inventing one, then plan again.
- **INPUT_ERROR**: tell the person what to correct and stop.
- **Otherwise**: keep the plan. It lists the steps, marks any already done (a run that stopped is resumed), and gives the manager model. It also shows the holdings and the lessons it saved with the run: the agents read those from the desk themselves, so never copy them into a request.

Tell the person in two lines what will run: the analysts, the rounds, the language, and how long it can take: in the desk's first real runs, about 40 minutes at shallow depth and up to about 3 hours at medium; deep runs more rounds, so longer.

If the plan starts with a line naming a backtest sweep, and you were not asked to run one by the /backtest skill, this stock and date are a cell of a backtest running now, so the analysis would be recorded in that backtest, not in the person's journal. Stop and tell the person so (in a run of the waiting list, fail the stock with that reason); never end the backtest: only the conversation running it does.

## 4. Run the steps, in the plan's order, skipping the ones marked done
Each agent is called with the Agent tool, `subagent_type` set to its name. Every request names the symbol (exactly as the plan gives it), the analysis date and the report language, and asks the agent to save its work. Agents save their work on the desk and reply with one line; do not paste their reports into the next request.

| Step | Agent | Add to the request |
|---|---|---|
| market, sentiment, news, fundamentals | market-analyst, sentiment-analyst, news-analyst, fundamentals-analyst | Start all of this run's analysts at once, in one message, and name in each request the analysts working in this run, so they can tell each other what to weigh. |
| fact_check | fact-checker | Start it once every analyst of this run has saved, and name the analysts working in this run. It corrects their reports in place before the debate starts. |
| bull (turn n), bear (turn n) | bull-researcher, bear-researcher | "This is turn n of N." Run them one at a time, bull first, in turn. |
| research_plan | research-manager | |
| trader | trader | |
| aggressive, conservative, neutral (turn n) | aggressive-risk-analyst, conservative-risk-analyst, neutral-risk-analyst | "This is turn n of N." One at a time, in that order. |
| decision | portfolio-manager | |

The trader, the risk voices and the portfolio manager read what the person holds, and the portfolio manager the lessons, from the desk (`read_run`), as the plan saved them with the run.

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
   - that the call is now in the journal and, as `record_decision` said, will be scored once a scoring runs after its window (/settle, an analysis or a routine): a first-week check against its yardstick (or on its own return, for a call on the yardstick itself), not the call's own time horizon.

   Do not add numbers of your own. Say that this is not investment advice, and that the desk proposes but never trades: the person decides on the dashboard ("Decide…" on the call), and only their own Confirm there places an order.

## 6. The waiting list: the stocks asked for on the dashboard
A run of the waiting list is often started with nobody watching: by a routine, or by the listener the dashboard rings when the person presses Analyse. So in it you never ask the person anything and never wait for an answer; what cannot be done is marked failed, with why, for the person to read on the dashboard.
1. Settle past calls once (step 2), then call `read_queue`. It lists the stocks waiting, in order, each with the depth asked, how many one run may analyse, and, when the person chose so, how many side by side. If it says another run is analysing a stock, stop and say so, without `end_queue_run`: one run takes stocks from the list at a time, and that run asks for the next run itself when it finishes. If it names stocks this run is analysing, finish those first. If nothing is waiting, say so and stop.
2. Take the waiting stocks in that order, up to that number: one at a time, or, when `read_queue` says side by side, up to that many at once as section 7 says. For each:
   - Call `start_queue_item`. START: plan with the date and the rounds it gives (step 3; no rounds when it says the settings decide). ALREADY: it was called today and is marked done; take the next. NOT STARTED: it cannot run now and is marked failed with why; take the next. BUSY: another run is analysing a stock: stop the run and say why, without `end_queue_run`. UNFINISHED: this run already has as many stocks going as it may: finish one first.
   - Run its steps (step 4) and finish it (step 5, without the summary: one line, the ticker and the rating).
   - Once its call is recorded, call `finish_queue_item` with the symbol alone: the dashboard shows it done, with its rating.
   - If it cannot be finished, call `finish_queue_item` with `failed_because`: one plain sentence the person reads, saying what went wrong and what to do, then go on with the next. If the plan answers NEEDS_EMAIL, do not ask: fail it with "the desk needs your email for the SEC: give it in a chat, then press Retry", and stop the run, since every stock would fail the same way. A step that fails twice: fail it with which step and why.
3. Call `end_queue_run` once, at the end, however the run stopped, unless it stopped because another run is analysing a stock. Each stock this run started and left unfinished is marked failed; if stocks are still waiting, it asks for another run.
4. Reply with one line per stock (the ticker, and its rating or why it failed), then the line `end_queue_run` gave, then that nothing here is investment advice and the desk never trades: the person decides on the dashboard. End with one short line on its own, the count of this run, for example `2 analysed, 0 failed` (a routine shows the last line as the run's result).

## 7. Side by side
When `read_queue` or a routine's brief says up to N stocks side by side, keep up to N of them going at once instead of one after another. Nothing else changes: each stock has its own plan, its own steps and its own checks, and the desk keeps each stock's work apart by its symbol and date.
1. Start up to N, in order: for each, `start_queue_item` (for a routine's starred stock, nothing) and then its plan (step 3).
2. Then work in rounds. Each round is one message with the next step of every stock going, by step 4's order for each stock (for a stock at its analysts, all of its analysts at once). A stock's own steps never overlap: its next step starts only once its last one is saved.
3. Every request names its stock's symbol and date exactly as its plan gives them. While more than one stock is going, add to each analyst's request: "Several stocks are analysed side by side in this run: do not message the other analysts." Two members of the same name may be working on other stocks, so a message could reach the wrong one; they may still ask you.
4. After each round, check each stock's save with `read_run` (its symbol and date). A step that was not saved is asked once more in the next round; a stock whose step fails twice is failed with which step and why (`finish_queue_item` with `failed_because`, or named at the end in a routine), and the others go on.
5. When a stock's call is recorded (step 5), finish it, then start the next waiting stock in its place, up to the run's number.

## Never
- Never call a broker connection, open Robinhood's site, or call a tool that trades or moves money. Agents in this folder have no such tool, and the guard refuses one.
- Never invent a number, an email address or a holding. If the person tells you what they hold, save it with `set_holdings` before planning; otherwise the desk works from the holdings it has saved, or says plainly that none are saved.
