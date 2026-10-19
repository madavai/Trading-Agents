---
name: terminal
description: Open the Trading Agents dashboard - the page where the person sees the markets, charts a stock, keeps a watchlist, reads the desk's calls and how they scored, and asks for an analysis. Use when the person runs /terminal or asks to see the dashboard.
---

# Terminal

The dashboard is a page on this computer only. It shows prices from Yahoo Finance (up to 15 minutes late), the desk's own records and the Robinhood accounts the person chose to show. It places an order only when the person has switched trading on and presses Confirm on a ticket Robinhood has checked; nothing an agent does can place one.

1. Call the desk tool `open_dashboard`. It starts the dashboard on this computer (or finds the one already running for this folder) and opens the page in the person's browser, on a link that gives that page its key. That one call is the whole job: do not start the dashboard with a shell command, a background task or another agent, and do not reach for anything else first.
2. Pass on what the tool answered, in one line: the dashboard has opened in their browser, and it works on this computer only. The page the tool opened is the one to use; the address alone, typed into another browser, opens a page without its key. If the tool answered that the dashboard did not answer, give its words: the person can run `node dist/terminal.mjs` in a terminal window of their own, in this folder, and tell you what it prints.
3. Say what the page can do in one short list: chart any stock or index, keep a watchlist, read the desk's calls and how they scored, and ask for an analysis (the page lists the request; the analysis itself runs here, when the person types /analyse with no stock).
4. If the person asks for an analysis from the page, run /analyse with no stock: it runs what the page has listed.
5. The page has a "Your account" card where the person themselves presses Connect to sign in to Robinhood (read-only; it opens Robinhood's own page in their browser). That button is theirs, as are the trading switch and every ticket's Review, Place and Confirm: never press them for them, never reach the dashboard's address yourself (the guard refuses it), and never call anything of Robinhood's yourself. If they ask what it does, say it reads the accounts they chose, and places an order only on their own Confirm, in the Agentic account, within their caps, with trading switched on. This is not investment advice.

The dashboard runs as a program of its own and stays open after this session ends, until the person presses Stop on the page or closes it. To open it again later, they ask for the dashboard again, or run `node dist/terminal.mjs` in a terminal window of their own, in this folder.

Never open, search, read, print or copy anything in the person's `~/.trading-agents` folder, never use a broker connection, and never call a tool that trades or moves money.
