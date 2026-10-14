# Trading Agents

This folder is the Trading Agents desk: a team of agents that analyses a stock and proposes a decision, a dashboard where
the person decides, and a connection to Robinhood's agent doorway for the orders the person confirms. It is adapted from
TradingAgents by Tauric Research (see NOTICE). It is early: the desk check, the market data tools and the analysis
team are in (not yet proven on real data); the dashboard and trading come next.

## What the person can run here
- `/desk-check`: checks this computer (Node, the desk's tools, the free data sources) and, on their yes, tests the
  Robinhood sign-in read-only.
- `/analyse TICKER [date] [shallow|medium|deep]`: the desk's twelve agents analyse a stock and record their call in the
  journal. It proposes only; it never places an order.
- `/settle`: scores past calls whose holding window has finished against their market index and writes the lessons.
- `/backtest TICKERS START END`: runs the team over past dates in a journal of its own and scores the calls by rating.
  Slow and costly: every date is a full team run.
- Coming in later milestones: `/terminal`, `/schedule`.

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
