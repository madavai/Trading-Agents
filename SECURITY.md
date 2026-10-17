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

No one on the team has a shell or a general file tool: every agent's file says so (`disallowedTools`), and a test keeps
it so. The guard reads the words of each tool call and follows links and short Windows names to the real path, and it
refuses any file search that starts at your home folder or above it. It cannot see what a shell command builds from
pieces, which is why the real protection is that the desk's agents get no shell at all, and any other session in this
folder asks you before it runs one.

## Your data
- Your Robinhood sign-in, the accounts you chose to show and the trading switch stay in your private folder, never in
  this repository and never on the page. Full account numbers never reach the page or the desk's files: the page shows
  the last four characters and tells accounts apart by a short fingerprint.
- The desk's own records (journal, reports, watchlist, holdings, the log of orders sent) stay in this folder's
  `desk-data`, which git never commits.
- Your email goes to the SEC alone, which asks every reader of its filings for one.
- The dashboard answers on this computer's own address only, so nothing on the internet can reach it, and every request
  for data needs a key made each time it starts.
- What the dashboard remembers between visits (light or dark, the side list, the page and the stock you were on, the
  chart's settings and the stocks you looked at last) is kept in `desk-data/dashboard.json`. Nothing about an order is
  ever remembered: every ticket starts afresh.
- After an update the dashboard offers Restart at the top of the page: new code on this computer runs only after your
  press, and never while an order is being sent. Stop, at the top right of the page, closes it.
- The search box sends what you type to Yahoo Finance's public search, which suggests matching stocks.

## Limits
- Any program on this computer, under any user account on it, can reach the dashboard's address and read its page and
  key the way your browser does. With trading switched on, such a program could send an order within your caps
  (Robinhood's phone approval, if you keep it on, would still ask you). Keep software you do not trust, and other
  people's accounts, off this computer; switch trading off when you are not using it; and never run this folder with
  permission checks bypassed.
- Your Robinhood sign-in is a file in your private folder, protected by your computer account like your other files.
  Disconnect deletes it from this computer; to end the access on Robinhood's side too, remove it in Robinhood.
- Nothing here is investment advice.

## Reporting a problem
If you find a way around any of this, please report it privately: on GitHub, open this repository's Security tab and
choose "Report a vulnerability". Please do not put the details in a public issue. You can also write to the
maintainers through Madav.
