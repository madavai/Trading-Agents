---
name: analyse
description: Analyse one stock (or crypto asset) on one date with the Trading Agents desk - four analysts, a bull and bear debate, a research manager, a trader, three risk voices and a portfolio manager - and record the call in the journal. Use when the person runs /analyse or asks the desk to analyse a ticker. It never places an order.
argument-hint: TICKER [YYYY-MM-DD] [shallow|medium|deep] [analysts=market,news] [language=Spanish]
---

# Analyse

The person asked: $ARGUMENTS

You run the desk: you call its agents in order and keep the work moving. You do not analyse yourself, and nothing you or any agent does places, changes or cancels an order.

## 1. Read the request
- **Ticker**: required. If none is given, ask for one and stop.
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

## 4. Run the steps, in the plan's order, skipping the ones marked done
Each agent is called with the Agent tool, `subagent_type` set to its name. Every request names the symbol (exactly as the plan gives it), the analysis date and the report language, and asks the agent to save its work. Agents save their work on the desk and reply with one line; do not paste their reports into the next request.

| Step | Agent | Add to the request |
|---|---|---|
| market, sentiment, news, fundamentals | market-analyst, sentiment-analyst, news-analyst, fundamentals-analyst | Start all of this run's analysts at once, in one message. |
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
3. Tell the person, in plain words:
   - the rating, and the executive summary in two or three sentences, from the saved decision (`read_run`, section decision);
   - any data that was unavailable, from the reports;
   - where the full report is;
   - that the call is now in the journal and will be scored against its market index after the holding window.

   Do not add numbers of your own. Say that this is not investment advice, and that the desk proposes but never trades: deciding and placing an order come in a later milestone, through the person's own confirmation.

## Never
- Never call a broker connection, open Robinhood's site, or call a tool that trades or moves money. Agents in this folder have no such tool, and the guard refuses one.
- Never invent a number, an email address or a holding. If the person tells you what they hold, save it with `set_holdings` before planning; if they don't, the desk says it is not provided.
