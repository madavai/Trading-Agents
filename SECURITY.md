# Safety and security

Trading Agents can place real orders with real money, so it is built so that only you can.

## Who can place an order
Only you, on the dashboard, and only when all of these hold:
- you switched trading on yourself (it ships off; the switch is kept beside your Robinhood sign-in, in your private
  Trading Agents folder in your home folder, which agents are refused);
- the order is for the Agentic account, Robinhood's separate account for agent trading, which you fund yourself;
- Robinhood checked that exact order (its own dry run) with no alerts, in the last five minutes, and nothing changed since;
- every one of your caps passes, checked again on figures read from Robinhood just before sending;
- you pressed Confirm on the words of that exact order ("Confirm: Buy 1 NVDA at $182.40").

The same holds whether the ticket comes from one of the desk's calls ("Decide…") or is your own ("Trade…", a stock you
chose, starting at one share): your own order gets no way around any of it, and the desk's log records it as yours.

A ticket sends at most one order, with Robinhood's own protection against a repeat. Keep Robinhood's phone approval on
until you trust the desk: then Robinhood also asks you on your phone before the order reaches the market.

## What agents can do
No agent has a Robinhood tool or an order tool. The trading-desk team and its twelve members use only the desk's own
tools (market data, the desk's records, opening the dashboard). A guard (`.claude/hooks/guard.mjs`) refuses every broker
tool, every tool that speaks of trading or moving money, Robinhood's site, the dashboard's address, and your private
folder, whatever an agent was told. Tests keep all of this true: no file but the dashboard's three Robinhood doors can
call Robinhood, each names only its own tools, and the agents' tool server contains none of them.

## Your data
- Your Robinhood sign-in, the accounts you chose to show and the trading switch stay in your private folder, never in
  this repository and never on the page. Account numbers never reach the page or the desk's files (the page shows the
  last four characters).
- The desk's own records (journal, reports, watchlist, holdings, the log of orders sent) stay in this folder's
  `desk-data`, which git never commits.
- Your email goes to the SEC alone, which asks every reader of its filings for one.
- The dashboard answers on this computer only, to the page it served, with a key made each time it starts.
- What the dashboard remembers between visits (light or dark, the side list, the page and the stock you were on, the
  chart's settings and the stocks you looked at last) is kept in `desk-data/dashboard.json`. Nothing about an order is
  ever remembered: every ticket starts afresh.
- After an update the dashboard offers Restart at the top of the page: new code on this computer runs only after your
  press, and never while an order is being sent. Stop, at the top right of the page, closes it.
- The search box sends what you type to Yahoo Finance's public search, which suggests matching stocks.

## Limits
- A program running on your computer with your permissions could read the dashboard's page like your browser does.
  Keep your computer free of software you do not trust, and never run this folder with permission checks bypassed.
- Nothing here is investment advice.

## Reporting a problem
If you find a way around any of this, open an issue on GitHub without the details of the exploit and ask for a private
contact, or write to the maintainers through Madav.
