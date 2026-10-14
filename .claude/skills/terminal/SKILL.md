---
name: terminal
description: Open the Trading Agents dashboard - the page where the person sees the markets, charts a stock, keeps a watchlist, reads the desk's calls and how they scored, and asks for an analysis. Use when the person runs /terminal or asks to see the dashboard.
---

# Terminal

The dashboard is a page on this computer only. It shows prices from Yahoo Finance (up to 15 minutes late) and the desk's own records; it has no order button and cannot place one.

1. Run `node dist/terminal.mjs` in this folder, in the background (it keeps running while the dashboard is open). It opens the page in the person's browser and prints the address; if a dashboard for this folder is already running it opens that one instead.
2. Read its first lines. Tell the person the address in one line, and that the page works on this computer only. If the program printed an error (for example Node is too old, or no free port), give its words and stop.
3. Say what the page can do in one short list: chart any stock or index, keep a watchlist, read the desk's calls and how they scored, and ask for an analysis (the page lists the request; the analysis itself runs here, when the person types /analyse with no stock).
4. If the person asks for an analysis from the page, run /analyse with no stock: it runs what the page has listed.
5. The page has a "Your account" card where the person themselves presses Connect to sign in to Robinhood (read-only; it opens Robinhood's own page in their browser). That button is theirs: never press it for them, and never call anything of Robinhood's yourself. If they ask what it does, say it only reads and cannot place an order.

If this session ends the dashboard stops with it. To keep it open on its own, the person can run `node dist/terminal.mjs` in a terminal window of their own, in this folder.

Never open, search, read, print or copy anything in the person's `~/.trading-agents` folder, never use a broker connection, and never call a tool that trades or moves money.
