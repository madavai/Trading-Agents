# Safety and security

Trading Agents can place real orders with real money, so it is built so that only you can.

## Who can place an order
Only you, on the dashboard, and only when all of these hold:
- you switched trading on yourself (it ships off; the switch is kept beside your Robinhood sign-in, in your private
  Trading Agents folder in your home folder, which agents are refused). With under four weeks of the desk's record on
  paper, switching it on also shows you that record and asks you to press "I understand" first;
- the order is for the Agentic account, Robinhood's separate account for agent trading, which you fund yourself;
- Robinhood checked that exact order (its own dry run) with no alerts, in the last five minutes, and nothing changed since;
- every one of your caps and guard rails passes, checked again on figures read from Robinhood just before sending: the
  most an order costs, the most in one stock, one sector and crypto, the orders a day, and the shortest hold (an early
  sell of a stock bought here takes one more press from you). The caps are yours alone: you set them on the dashboard,
  beside the trading switch, and they are kept with it in your private folder, never in the project's files, which
  anything working in this folder could edit;
- the weekly loss limit has not tripped: every time the dashboard reads the Agentic account it notes its value (in your
  private folder, day by day), and when the value falls your limit below its highest of the last seven days, trading
  switches itself off and the page says why, even in the middle of sending an order;
- you pressed Confirm on the words of that exact order ("Confirm: Buy 1 NVDA at $182.40").

The same holds whether the ticket comes from one of the desk's calls ("Decide…", or "Sell…" beside a holding the desk
says to sell, which opens that call's own ticket) or is your own ("Trade…", a stock you chose, starting at one share):
your own order gets no way around any of it, and the desk's log records it as yours.

Nothing is ever sold by itself. The stop the desk's trader proposes is only watched: when the price falls below it, the
dashboard says so and marks the holding, and never places a stop order. A Sell or Underweight on a holding only marks it.

Crypto and indices never reach Robinhood: Robinhood's agent doorway trades stocks and funds, so the dashboard refuses a
ticket for a coin or an index when it opens and again before Robinhood checks or places it. Bitcoin and Ether calls are
followed on paper only.

A ticket sends at most one order, with Robinhood's own protection against a repeat. Keep Robinhood's phone approval on
until you trust the desk: then Robinhood also asks you on your phone before the order reaches the market.

## What agents can do
No agent has a Robinhood tool or an order tool. The trading-desk team and its twelve members use only the desk's own
tools (market data, the desk's records, opening the dashboard). A guard (`.claude/hooks/guard.mjs`) refuses every broker
tool, every tool that speaks of trading or moving money, Robinhood's site, the dashboard's address, and your private
folder, whatever an agent was told. Tests keep all of this true: no file but the dashboard's three Robinhood doors can
call Robinhood, each names only its own tools, and the agents' tool server contains none of them.

No one on the team has a shell or a general file tool: every agent's file says so (`disallowedTools`), and a test keeps
it so. The guard reads the words of each tool call and follows links and short Windows names to the real path, and it
refuses any file search that starts at your home folder or above it. It cannot see what a shell command builds from
pieces, which is why the real protection is that the desk's agents get no shell at all, and any other session in this
folder asks you before it runs one.

## Analyses that run by themselves
When you ask for an analysis on the dashboard, it waits on a list in `desk-data` and the dashboard rings a "doorbell"
(a small file there). Whatever listens for it (Madav's routine "Run automatically when the dashboard asks", which the
project ships switched off, or the desk's own listener for Claude Code) runs the
trading-desk team, which proposes only, exactly as when you ask in a chat: the same agents, tools and guard, and no
order tool.
- The desk's own listener (`node dist/watch.mjs`, started by "Run automatically with Claude Code") runs one fixed
  thing, written in its code: Claude Code as the trading-desk team, with the words "Analyse what is waiting on the
  dashboard", in a mode that refuses anything this folder's settings do not already allow instead of asking. Nothing
  in the project's files can change that command, so a file an agent could write never chooses what it runs. It never
  runs with permission checks bypassed.
- Madav's routines (`.claude/routines.json`: the waiting list, the morning routine and the evening wrap-up) ship
  switched off, and only you switch one on. A run takes its model and permissions from what you chose in Madav, never
  from the project's files (no desk agent file sets a permission mode), and Madav never runs one with permission checks
  skipped. Switching a routine on approves the desk as it stands: when an update changes its agents, playbooks,
  settings, hooks or tools, Madav pauses the routine until you switch it on again.
- The files it shares with the dashboard (the waiting list, the doorbell, the note that says who is listening) are
  read as data: every field is checked, and a bad one is dropped. They hold no secret and no key.
- One stock runs at a time, at most five a run, and a run starts only when something is waiting. Each run uses your
  own Claude Code plan or Madav's model, like a chat; switch it off when you do not want analyses to run by
  themselves.

## Your data
- Your Robinhood sign-in, the accounts you chose to show, the trading switch with your caps, the secret your account
  fingerprints are made with and the running dashboard's key stay in your private folder, never in this repository and
  never on the page. On Windows the dashboard locks that folder to your own account (and the system) with an access
  list of its own, so no other account on this computer can open it; on Linux and macOS the file mode does the same.
  The desk check says who can open it.
- Full account numbers never reach the page or the desk's files: the page shows the last four characters and tells
  accounts apart by a short fingerprint, made with a secret kept in your private folder, so the fingerprint says
  nothing about the number even to someone who knows the number.
- The desk's own records (journal, reports, watchlist, holdings, the log of orders sent) stay in this folder's
  `desk-data`, which git never commits.
- Your email goes to the SEC alone, which asks every reader of its filings for one.
- The dashboard answers on this computer's own address only, so nothing on the internet can reach it, and every request
  for data needs a key made each time it starts. The key is in no page it serves: the dashboard opens your browser on a
  one-time link, which the page swaps for the key once, within two minutes, and then keeps for itself. A page opened by
  hand has no key and says so; opening the dashboard again (run /terminal) opens a page that has one.
- What the dashboard remembers between visits (light or dark, the side list, the page and the stock you were on, the
  chart's settings, the stocks you looked at last, your whole-market funds and which watchlist tiers you folded) is kept
  in `desk-data/dashboard.json`, each value checked before it is kept. Nothing about an order is ever remembered: every
  ticket starts afresh.
- After an update the dashboard offers Restart at the top of the page: new code on this computer runs only after your
  press, and never while an order is being sent. Stop, at the top right of the page, closes it.
- The search box sends what you type to Yahoo Finance's public search, which suggests matching stocks.
- "This morning" asks Yahoo Finance for the daily prices of the whole-market funds, the sector funds and your watchlist
  (and its news search for your companies and coins), and asks Polymarket's public search for its odds on the Federal
  Reserve, at most once an hour. The list is kept in `desk-data/screen.json`. The switch "Analyse the top 3 each market
  morning" ships off; on, it only puts those stocks on the waiting list, never an order.
- To watch the stops in the Agentic account, the dashboard asks Yahoo Finance for the price of each holding there that
  has one (by ticker only, never a quantity or an account), as often as it refreshes its other prices.
- On a Monday the morning routine puts up to three of the holdings the desk sizes trades to on the waiting list, to be
  re-rated, and notes which in `desk-data/rerate.json`: never an order.
- For the sector limit, the dashboard asks the SEC for the industry of the stocks you trade and hold and for its list of
  funds (by ticker only, never a quantity or an account).
- The desk always introduces itself by its own name, never as a web browser. Yahoo Finance gives its company data only
  to browsers, so for a company that does not file with the SEC that data is unavailable; everything about a US
  company comes from the SEC's own filings.

## Limits
- Any program on this computer, under any user account on it, can reach the dashboard's address and read its page the
  way your browser does, but no longer finds the key there. A program running under your own account can read the key
  from your private folder, exactly as it could read your sign-in; a program under another account on this computer
  cannot. With trading switched on, a program under your own account could therefore still send an order within your
  caps (Robinhood's phone approval, if you keep it on, would still ask you). Keep software you do not trust off this
  computer; switch trading off when you are not using it; and never run this folder with permission checks bypassed.
- Your Robinhood sign-in is a file in your private folder, protected by your computer account like your other files.
  Disconnect deletes it from this computer; to end the access on Robinhood's side too, remove it in Robinhood.
- Nothing here is investment advice.

## Reporting a problem
If you find a way around any of this, please report it privately: on GitHub, open this repository's Security tab and
choose "Report a vulnerability". Please do not put the details in a public issue. You can also write to the
maintainers through Madav.
