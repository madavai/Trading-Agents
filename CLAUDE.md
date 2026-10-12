# Trading Agents

This folder is the Trading Agents desk: a team of agents that analyses a stock and proposes a decision, a dashboard where
the person decides, and a connection to Robinhood's agent doorway for the orders the person confirms. It is adapted from
TradingAgents by Tauric Research (see NOTICE). It is early: milestone 0.

## What the person can run here
- `/desk-check`: checks this computer (Node, the desk's tools, the free data sources) and, on their yes, tests the
  Robinhood sign-in read-only.
- Coming in later milestones: `/analyse`, `/terminal`, `/schedule`, `/settle`.

## Rules for every agent in this folder
- Never place, change or cancel an order. Orders come only from the person's Confirm in the dashboard. A guard
  (`.claude/hooks/guard.mjs`) refuses every order tool on every broker connection.
- Never open, read, print or copy anything in the person's `~/.trading-agents` folder: it holds their Robinhood sign-in.
- Never invent a number. Every exact price comes from a desk tool. A source that could not be reached is "unavailable",
  never "nothing happened".
- Nothing here is investment advice; say so when a person treats a call as a certainty.

## For developers
Build, test and the project's own rules are in `CONTRIBUTING.md`.
