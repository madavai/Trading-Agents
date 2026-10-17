# Trading Agents

A trading desk of AI agents for [Madav](https://github.com/madavai), built in the open. A team of agents analyses a
stock the way a trading firm would; you see their call on a dashboard beside your own Robinhood accounts; and if you
decide to act, you place the order through Robinhood's agent connection with one review and one confirm. The agents
never trade. You do.

Adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) by Tauric Research (see `NOTICE`); not
affiliated with them. **Nothing here is investment advice.**

**See how it works:** [Inside the Trading Desk](https://madavai.github.io/Trading-Agents/inside-the-trading-desk.html)
is a visual guide to the whole desk: where its data comes from, what each of the twelve agents does, one call from
question to order, where everything is kept, and how Robinhood and the dashboard fit in.

> **Status: every part is built** - the desk check, the free data tools, the twelve-agent team with its scoring and
> lessons, back-testing, the dashboard with your Robinhood accounts, order tickets with Robinhood's own check, placing
> an order on your Confirm, the morning and evening routines, and the trading-desk team in Madav's Agent Studio.
> **Being proven now, on a real computer:** a full analysis with company accounts, the dashboard with a real Robinhood
> account, and a first real order. Until that is done, keep trading switched off, or keep orders to one share with
> Robinhood's phone approval on.

## Start in three steps
1. In Madav, clone this repository. There is nothing to install.
2. Open **Agent Studio**: the **trading-desk** team and its twelve agents are there, ready. If Madav asks whether to use
   this folder's tools, say yes.
3. Ask the team to check this computer, then to analyse a stock ("analyse NVDA") or to open the dashboard. The first
   check looks at your computer and the free data sources and asks for your email (once). In a chat in this folder the
   same desk answers to `/desk-check`, `/analyse NVDA` and `/terminal`.

**If the team was changed by mistake:** saving the trading-desk team in Agent Studio can rewrite the project's agent
files. The desk check notices and names them; ask the team to "reset the team" and, on your yes, it puts them back
exactly as the project ships them.

You need Node 22 or later (Madav needs it too). No keys and no installs; only your email, once.

**Why your email:** the SEC asks everyone who reads its filings for a contact address, so the desk needs yours before
its first analysis. It is kept in this folder's `desk-data` (which git never commits) and sent to the SEC alone; no
other source sees it.

## How it works
1. **Agents analyse.** Ask the trading-desk team in Agent Studio ("analyse NVDA"), or type `/analyse NVDA` in a chat. Four analysts (price and indicators,
   mood, news, company accounts), a bull and a bear, a research manager, a trader, three risk voices and a portfolio
   manager work in turn, from free public data, and give a rating. Choose `shallow`, `medium` or `deep` (1, 3 or 5
   rounds of debate), which analysts run, and the report language. Each call is scored a few trading days later against
   its market's index (`/settle`), and the lessons go into later analyses. `/backtest NVDA,AAPL 2026-06-01 2026-08-01`
   runs the team over past dates in a journal of its own and reports, by rating, how often the direction was right and
   the mean alpha. It is slow and uses a lot of model time, and for past dates only prices, indicators, economic figures
   and SEC accounts are as known then: news, posts, odds and insider trades are recent-only, so they are thin.
2. **You see.** Ask the team to open the dashboard, or type `/terminal`: a page on your own computer with the markets,
   a chart of any stock (area or candles, 50- and 200-day averages, volume), your watchlist, a page per stock, the
   desk's calls with their full reasoning, and how the desk has scored. Under "Your account" you connect Robinhood
   yourself (on Robinhood's own sign-in page) and choose which accounts to show: value, cash, buying power and
   holdings at Robinhood's live prices; for the Agentic account its orders and whether Robinhood's phone approval is
   on. The agents see those holdings when they analyse. Market prices are Yahoo Finance's and may be up to 15 minutes
   late. The page works on this computer only and keeps no key.
3. **You decide and trade.** On a call, "Decide…" opens a ticket for the Agentic account, sized by your settings and
   checked against your caps; "Review with Robinhood" is Robinhood's own dry run. With trading switched on (by you,
   on the dashboard), "Place order…" then "Confirm: Buy 1 NVDA at $182.40" sends exactly that order. Trading ships
   switched off.

## Routines
The trading-desk team has two routines, which Madav's scheduler can start for you:
- **Morning routine**: scores past calls, then analyses what you asked for on the dashboard and your starred watchlist
  stocks (at most 5 a morning, set in `desk-settings.json` under `routines`), and ends with the new calls to decide on.
  On a weekend it only scores past calls.
- **Evening wrap-up**: scores what is ready and tells you the day's calls, the orders the dashboard sent and what
  Robinhood answered.

To schedule one in Madav: Routines, new routine, run as **trading-desk**, the words "Run the morning routine" (or
"Run the evening wrap-up"), on weekdays at the time you choose. In a chat here: `/routine morning`. Neither ever
places an order, and the team reads your holdings as the dashboard last read them from Robinhood.

## Where the data comes from
Free public sources, with no keys: Yahoo Finance (prices, news, company profile), StockTwits, Reddit, FRED (economic
figures), Polymarket (odds) and SEC EDGAR (company filings). Yahoo Finance has no official free service: the desk reads
the same public pages its website uses, for personal use, and Yahoo can block or change them without notice. Any source
that does not answer is reported as unavailable, never as "nothing happened".

## Safety
- No agent uses a broker connection. A guard refuses every broker tool, every tool that speaks of trading or moving
  money, Robinhood's site, and the dashboard's own address, whatever an agent was told. No agent, and no one on the
  trading-desk team, has a Robinhood tool or an order tool.
- Only the dashboard talks to Robinhood, through three narrow doors: one that only reads, one that only asks for
  Robinhood's dry-run check, and one that places a single limit order. The last is used only when trading is switched
  on (by you), on a ticket Robinhood checked with no alerts in the last five minutes and unchanged since, after your
  Confirm naming the exact order, and after every cap is checked again on fresh figures. A ticket sends one order.
- Your caps are in `desk-settings.json` under `trading`: $500 an order, 10% of the account in one stock, 3 orders a
  day, a full position being 10% of the account. A setting out of range falls back to the shipped value, never to a
  larger one.
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

## More
- `docs/inside-the-trading-desk.html`: the visual guide, in light and dark, with the full "not financial advice" notice;
  published at [madavai.github.io/Trading-Agents](https://madavai.github.io/Trading-Agents/).
- `SECURITY.md`: who can place an order, what agents can and cannot do, where your data stays, and how to report a
  problem.
- `CONTRIBUTING.md`: building, testing and the project's own rules.

## Licence
MIT (see `LICENSE`). Files adapted from TradingAgents say so at their top and stay under the Apache License 2.0
(`LICENSE-APACHE`). Credits and font licences are in `NOTICE`.
