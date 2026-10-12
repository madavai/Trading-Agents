---
name: desk-check
description: Check that this computer is ready for the Trading Agents desk - Node, the desk's own tools, the free data sources - and, when the person says yes, test the Robinhood sign-in read-only. Use when the person runs /desk-check, opens this folder for the first time, or something in the desk seems not to work.
---

# Desk check

1. Call the desk's `desk_check` tool (the trading-desk server). If that tool is not there, the folder's own tools did not start. Tell the person in plain words: check that Madav was allowed to use this folder's tools, and that Node 22 or later is installed (nodejs.org); then open a new session in this folder and try again. Stop there.
2. Call `get_verified_snapshot` for SPY with today's date as the analysis date, to prove the price data works end to end. It should answer with a checked price table; if it answers DATA_UNAVAILABLE or NO_DATA_AVAILABLE, say so and give its reason.
3. Tell the person what it found as a short plain list: what is ready, what is not, and what to do about each. Paste the raw output only if they ask.
4. Ask whether to test the Robinhood connection now. Say what it does: it opens Robinhood's own sign-in page, it only reads, and it never places an order. Only on a yes, run `node dist/robinhood.mjs connect` in this folder and wait while they sign in (up to five minutes).
5. Report what came back: whether Robinhood accepted the sign-in, how many tools its connection offers (read and review tools, and order tools that agents can never call), and whether the positions answered. If it did not work, give its words and say the desk will switch to plan B; nothing was ordered.

Never open, search, read, print or copy anything in the person's `~/.trading-agents` folder. Never use a broker connection or Robinhood's site yourself, and never call a tool that trades or moves money: the connection test is the program's own, run only on the person's yes.
