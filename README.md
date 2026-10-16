# Trading Agents

A trading desk of AI agents for [Madav](https://github.com/madavai), being built in the open. When it is finished, a
team of agents analyses a stock the way a trading firm would; you see their call on a dashboard; and if you decide to
act, you place the order through Robinhood's agent connection with one review and one confirm. The agents never trade.
You do. What works today is listed under Status; everything else is marked as coming.

Adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) by Tauric Research (see `NOTICE`); not
affiliated with them. **Nothing here is investment advice.**

> **Status: milestone 4, second part.** Built: the desk check, a read-only Robinhood connection test, the data tools, the desk's
> records (plan, journal, scoring, lessons, holdings), the analysis team with `/analyse` and `/settle`, `/backtest`, and
> the dashboard with `/terminal` (markets, charts, watchlist, the desk's calls and scorecard). The dashboard connects
> to Robinhood (you press Connect, sign in on Robinhood's own page) and shows the accounts you choose: value, cash,
> buying power, holdings at Robinhood's live prices, and for the Agentic account its orders and whether Robinhood's
> phone approval is on. The agents see those holdings when they analyse. There is no order button yet.
> **Not yet proven on a real computer:** the dashboard, and a full analysis with company accounts.

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
1. **Agents analyse** (built, awaiting its first real run). Type `/analyse NVDA`. Four analysts (price and indicators,
   mood, news, company accounts), a bull and a bear, a research manager, a trader, three risk voices and a portfolio
   manager work in turn, from free public data, and give a rating. Choose `shallow`, `medium` or `deep` (1, 3 or 5
   rounds of debate), which analysts run, and the report language. Each call is scored a few trading days later against
   its market's index (`/settle`), and the lessons go into later analyses. `/backtest NVDA,AAPL 2026-06-01 2026-08-01`
   runs the team over past dates in a journal of its own and reports, by rating, how often the direction was right and
   the mean alpha. It is slow and uses a lot of model time, and for past dates only prices, indicators, economic figures
   and SEC accounts are as known then: news, posts, odds and insider trades are recent-only, so they are thin.
2. **You decide** (the dashboard is built; your account and the Decide step come later). Type `/terminal`: a page on
   your own computer shows the markets, a chart of any stock (area or candles, 50- and 200-day averages, volume), your
   watchlist, the desk's calls with their full reasoning, and how the desk has scored. Its "Analyse" buttons list a
   request; the analysis itself runs in Madav when you type `/analyse` with no stock. Prices are Yahoo Finance's and may
   be up to 15 minutes late. The page works on this computer only, keeps no key, and cannot place an order. Its
   "Your account" card connects to Robinhood on your press of Connect and only reads.
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
The dashboard wears the Madav House theme in a light and a dark face (the button at the top right). Its look is in
`src/terminal/ui/house.css`; the dashboard's own sheet only places those objects. `docs/design/desk-mock.html` is the
design reference (open it in a browser; the prices in it are made up).

## Licence
MIT (see `LICENSE`). Files adapted from TradingAgents say so at their top and stay under the Apache License 2.0
(`LICENSE-APACHE`). Credits and font licences are in `NOTICE`.
