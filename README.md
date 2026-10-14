# Trading Agents

A trading desk of AI agents for [Madav](https://github.com/madavai), being built in the open. When it is finished, a
team of agents analyses a stock the way a trading firm would; you see their call on a dashboard; and if you decide to
act, you place the order through Robinhood's agent connection with one review and one confirm. The agents never trade.
You do. What works today is listed under Status; everything else is marked as coming.

Adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) by Tauric Research (see `NOTICE`); not
affiliated with them. **Nothing here is investment advice.**

> **Status: milestone 2a.** Working today: the desk check, a read-only Robinhood connection test, the data tools (prices,
> 13 indicators, the checked price table, news, StockTwits and Reddit posts, economic figures, prediction-market odds,
> company accounts), and the desk's records: the plan for an analysis, the run's working record and report, the journal
> of calls with their scoring against the stock's market index after 5 trading days, lessons from past calls (a past-dated
> analysis only sees outcomes already known on its day), and what you hold. The analysts and the rest of the team that use
> them, the dashboard and trading come in the next milestones.

## Start in three steps
1. In Madav, clone this repository and open its folder.
2. If Madav asks whether to use this folder's tools, say yes.
3. Type `/desk-check`. It checks your computer and the free data sources, asks for your email (once), and can test
   your Robinhood sign-in (read-only).

You need Node 22 or later (Madav needs it too). No keys and no installs; only your email, once.

**Why your email:** the SEC asks everyone who reads its filings for a contact address, so the desk needs yours before
its first analysis. It is kept in this folder's `desk-data` (which git never commits) and sent to the SEC alone; no
other source sees it.

## How it will work
1. **Agents analyse** (coming next). Four analysts (price and indicators, mood, news, company accounts), a bull and a
   bear, a research manager, a trader, three risk voices and a portfolio manager work in turn, from free public data,
   and propose a rating and an order.
2. **You decide** (coming later). The dashboard shows your markets, your watchlist, charts, the desk's call and its
   record.
3. **You trade** (coming later, and only after a real order has been proven end to end). Decide, Review (Robinhood's own
   dry run), Place, Confirm. Only that confirm sends an order, only the exact order you confirmed, within your caps.
   Trading ships switched off.

## Where the data comes from
Free public sources, with no keys: Yahoo Finance (prices, news, company profile), StockTwits, Reddit, FRED (economic
figures), Polymarket (odds) and SEC EDGAR (company filings). Yahoo Finance has no official free service: the desk reads
the same public pages its website uses, for personal use, and Yahoo can block or change them without notice. Any source
that does not answer is reported as unavailable, never as "nothing happened".

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
MIT (see `LICENSE`). Files adapted from TradingAgents say so at their top and stay under the Apache License 2.0
(`LICENSE-APACHE`). Credits and font licences are in `NOTICE`.
