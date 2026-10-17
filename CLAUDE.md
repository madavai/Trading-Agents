# Trading Agents

This folder is the Trading Agents desk: a team of agents that analyses a stock and proposes a decision, a dashboard where
the person decides, and a connection to Robinhood's agent doorway for the orders the person confirms. It is adapted from
TradingAgents by Tauric Research (see NOTICE). It is early: the desk check, the market data tools and the analysis
team and the dashboard are in (not yet proven on real data); the dashboard shows the person's chosen Robinhood accounts
(read-only), the agents see those holdings, and a call can be turned into an order ticket that
Robinhood checks (a dry run) and, with trading switched on by the person, places on their own Confirm.

## What the person can run here
In Madav's Agent Studio the trading-desk team (`.claude/agents/trading-desk.md`) does all of this when asked in words.
In a chat here:
- `/desk-check`: checks this computer (Node, the desk's tools, the free data sources, whether the desk's agent files are
  as the project ships them, and on their yes puts them back with `reset_team`) and, on their yes, tests the
  Robinhood sign-in read-only.
- `/analyse TICKER [date] [shallow|medium|deep]`: the desk's twelve agents analyse a stock and record their call in the
  journal. It proposes only; it never places an order.
- `/settle`: scores past calls whose holding window has finished against their market index and writes the lessons.
- `/backtest TICKERS START END`: runs the team over past dates in a journal of its own and scores the calls by rating.
  Slow and costly: every date is a full team run.
- `/terminal`: opens the dashboard on this computer (`node dist/terminal.mjs`): markets, charts, watchlist, the desk's
  calls and scorecard, a list of stocks to analyse, a page per stock, and the person's own Connect to Robinhood.
  `/analyse` with no stock runs that list. An order is placed only by the person's own Confirm there, with trading
  switched on by them. It remembers where the person left it, offers Restart after an update (new code runs only on
  the person's press) and has its own Stop.
- `/routine morning|evening`: the morning routine (score past calls, analyse what is waiting and the starred
  watchlist stocks, list the new calls to decide on) or the evening wrap-up (score what is ready, report the day's
  calls and orders). Madav's scheduler can start them as the trading-desk team. They never place an order.

## Rules for every agent in this folder
- Never place, change or cancel an order, and never use a broker connection or Robinhood's site. Orders come only from
  the person's Confirm in the dashboard. A guard (`.claude/hooks/guard.mjs`) refuses every broker tool and every tool
  that speaks of trading or moving money.
- Never open, search, read, print or copy anything in the person's `~/.trading-agents` folder: it holds their Robinhood
  sign-in.
- Ask before any shell command or file access outside this folder; never suggest running this folder with permission
  checks bypassed.
- Never invent a number. Every exact price, level and indicator comes from a desk tool (the checked price table
  first). A source that could not be reached is "unavailable", never "nothing happened".
- The desk needs the person's own email before its first analysis (the SEC asks every reader of its filings for one):
  ask them for it and save it with `set_contact_email`. Never invent, guess or reuse an address.
- Nothing here is investment advice; say so when a person treats a call as a certainty.

## For developers
Build, test and the project's own rules are in `CONTRIBUTING.md`.
