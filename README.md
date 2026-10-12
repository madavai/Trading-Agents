# Trading Agents

A trading desk of AI agents for [Madav](https://github.com/madavai). A team of agents analyses a stock the way a trading
firm would; you see their call on a dashboard; and if you decide to act, you place the order through Robinhood's agent
connection with one review and one confirm. The agents never trade. You do.

Adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) by Tauric Research (see `NOTICE`); not
affiliated with them. **Nothing here is investment advice.**

> **Status: milestone 1b.** The desk check, a read-only Robinhood connection test, and the data tools: prices,
> 13 indicators, the checked price table, instrument identity, company and world news, StockTwits and Reddit posts,
> economic figures (FRED) and prediction-market odds. Company accounts, the analysis team, the dashboard and trading
> come in the next milestones.

## Start in three steps
1. In Madav, clone this repository and open its folder.
2. If Madav asks whether to use this folder's tools, say yes.
3. Type `/desk-check`. It checks your computer and the free data sources, and can test your Robinhood sign-in
   (read-only).

You need Node 22 or later (Madav needs it too). No keys, no installs, no settings.

## How it works
1. **Agents analyse.** Four analysts (price and indicators, mood, news, company accounts), a bull and a bear, a research
   manager, a trader, three risk voices and a portfolio manager work in turn, from free public data, and propose a
   rating and an order.
2. **You decide.** The dashboard shows your markets, your watchlist, charts, the desk's call and its record.
3. **You trade.** Decide, Review (Robinhood's own dry run), Place, Confirm. Only that confirm sends an order, only the
   exact order you confirmed, within your caps. Trading ships switched off.

## Safety
- No agent uses a broker connection. A guard refuses every broker tool, every tool that speaks of trading or moving
  money, and Robinhood's site, whatever an agent was told.
- Robinhood only lets agents trade in its separate Agentic account, which you fund yourself. Keep Robinhood's own
  "trade approvals" on until you trust the desk: then every order also waits for your OK on your phone.
- Your Robinhood sign-in stays in `~/.trading-agents` on your computer, never in this repository. Agents are refused
  that folder; the real protection is that they get no free shell or file access outside this folder without your
  approval, so **never run this folder with permission checks bypassed**.
- A source that cannot be reached is reported as unavailable, never as "no news". No number is invented.

## Design
`docs/design/desk-mock.html` is the dashboard's design reference, in the Madav House theme (open it in a browser; the
prices in it are made up).

## Licence
MIT (see `LICENSE`), with the credits and font licences in `NOTICE`.
