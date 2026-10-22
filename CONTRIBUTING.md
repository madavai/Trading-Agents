# Contributing

New to the project, or carrying it on in a new session? Read [HANDOFF.md](HANDOFF.md) first: who decides, what is
built, which decisions stand, every document, and what is pending.

## Build and test
- Node 22 or later. `npm ci`, then `npm test` (type check, then Node's own test runner on the compiled tests).
- `npm run build` bundles each program into one file in `dist/`. **`dist/` is committed** so that a person who clones the
  repository runs it with nothing to install; CI fails when `dist/` does not match the source (`npm run check-dist`).

## Layout
- `src/tools/` - the desk tool server, the one MCP server this folder gives the engine (`.mcp.json`).
- `src/data/` - the free sources, each held to the analysis date, official ones first. `company.ts` is a company's
  accounts, profile, valuation and insider trades: for a US filer all from the SEC as filed by the analysis date
  (`sec.ts`: statements, `submissions` for name and industry code, `sectorOfSic`, `trailingYear` for the last twelve
  months no filing states, `sharesOutstanding` from the cover page, or `averageDilutedShares` from the accounts when
  the cover page gives no single count, as for a filer with two classes of shares, and said so; `insiders.ts`: each
  Form 4 read from its own XML),
  the valuation worked out with the checked close; Yahoo Finance only for a company that does not file with the SEC,
  today only (Yahoo refuses its company data to the desk's honest name, so this is mostly unavailable). The desk never
  calls itself a browser. `fundProfile` (tool `get_fund_profile`) is a fund's in their place, from `nport.ts`: the latest
  portfolio report (form N-PORT) the fund had filed by the analysis day, found by its series (`fundOf`, from the SEC's
  fund list, then the SEC's list of that series' reports) or, for an ETF set up as a trust such as SPY, by its own
  filings; its size, lines added up by issuer, assets, issuers, countries, bonds' years and interest, its own monthly
  returns, and the day its holdings are from. Amendments are not read. The yearly cost has no official free source and
  is said as unavailable; a fund the SEC does not list falls back to Yahoo, today only.
- `src/check/` - the desk check: this computer, and the free data sources.
- `src/robinhood/` - the connection to Robinhood's Trading MCP: sign-in (OAuth, kept in `~/.trading-agents`), and reads.
  `rules.ts` says what a Robinhood tool is (read, order or other) by its name and Robinhood's own read-only label;
  `reader.ts` is the ONLY place in `src/` that calls a Robinhood tool, and it refuses everything but reads (a test
  scans the source to keep it so); `connect.ts` signs in and opens sessions; `link.ts` is what the dashboard knows
  (none, waiting, connected, failed), which accounts the person chose (kept beside the sign-in as keys, never numbers;
  a key is a keyed hash with a secret made once and kept there too, `secrets.json`), the trading switch with the
  person's caps (`trading.json`, beside the sign-in, never in `desk-settings.json`) and the last read of the accounts;
  `review.ts` is the only other door: Robinhood's own
  order check (`review_equity_order`) and nothing else, for the Agentic account only; `order.ts` is the third and last:
  one limit order (`place_equity_order`), reached only from the dashboard's server after the person's Confirm, with
  trading switched on (kept beside the sign-in) and every cap checked again on fresh figures; `account.ts` reads Robinhood's answers into figures (a dash, never a zero, for what it
  did not give); `discover.ts` and `cli.ts` are `node dist/robinhood.mjs discover` and `shape`,
  which print what Robinhood offers and the SHAPE of its answers, never a value, so the desk is built on what is there.
- `.claude/` - what Madav and Claude Code load in this folder: settings, the guard hook, skills, and the agents.
  The twelve agent files in `.claude/agents/` are written from `scripts/agents-src.mjs` (`npm run agents`); edit the
  source, not the files, and a test fails if they differ.
  Madav's Agent Studio lists the same files. Beside them, `trading-desk.md` is the team's own file and
  `trading-desk.team.json` its line-up in the shape Madav keeps a team in (members, steps, together, gates, talk), for
  Agent Studio to take as the team until the person changes it there. Both are written by `npm run agents` from
  `scripts/team-src.mjs`: the team's playbook is the /analyse, /settle and /backtest skills, so after editing a skill run
  `npm run agents` again. The team gets no shell: it opens the dashboard with the desk tool `open_dashboard`.
  `scripts/team-files.mjs` is the one list of these files and their text: `npm run agents` writes it, the desk check
  compares the folder with it (an edit, or an older Madav, can change the files), and the desk tool `reset_team` writes it
  back on the person's confirmed yes (`src/desk/agent-files.ts`), every file each time, even one that matches: Madav
  keeps Agent Studio's changes inside itself and returns to the project's version of a file when that file is written.
  Touches no other file. Agent files never set `permissionMode` (Madav ignores it in routine runs; the person's choice
  rules), and each agent's name is in one file only (a name in two files is not started); a test keeps both true.
- `.claude/routines.json` - the routines the project ships to Madav, each off until the person switches it on: the
  waiting list (`watch` the doorbell, `listener` the note, the same words as the desk's own listener, `RUN_WORDS`), and
  the morning and evening routines (`cron`). Madav reads it and never writes it. A change under `.claude`, to
  `.mcp.json` or to `CLAUDE.md` pauses the routines until the person switches them on again, so nothing written at run
  time may live there.
- `src/private.ts` - the one way anything is written into the person's private folder (`paths.ts` `homeDir`): whole,
  and locked to their own account on every system (the file mode on Linux and macOS; on Windows an access list naming
  their account and the system alone, by `icacls`). The desk check reports who can open the folder (`lockState`).
- `src/terminal/` - the dashboard: `server.ts` (loopback only, host and origin checks, a per-start key that is in no
  page it serves: the browser is opened on a one-time link, `#open=<claim>`, which the page swaps for the key once at
  `/api/claim`; while it runs the key is kept in the private folder, `dashboard.json`, so `main.ts` can open the page
  again with a fresh link from `/api/claim/new`; strict CSP),
  `quotes.ts` (Yahoo prices), `search.ts` (Yahoo's matches for what is typed), `prefs.ts` (what the page remembers, in
  `desk-data/dashboard.json`, each value checked; the whole-market funds only through `/api/tiers/market`, which checks
  each one's price first), `tiers.ts` (the world in tiers for "Start here" and the watchlist: the whole market, the
  sector funds, single names and crypto, with every fund's and tier's name and meaning in plain words; the page draws
  what it is sent and holds no tier rules of its own), `guide.ts` ("Get started", the first month in five steps:
  `guideOf` ticks each from the desk's own records, the contact email, the watchlist, the waiting list and its listener,
  the journal, `prefs.ts` `readCall` (noted by `/api/call`, never by the page) and the paper record against
  `paper.ts` `RECORD_WEEKS`, said everywhere as `RECORD_WORDS`; it opens by itself while the desk has no calls and the
  page keeps it open until it is put away; `maskEmail` is all of the address the page ever sees; `/api/contact` saves
  it as `set_contact_email` does), `state.ts` and `store.ts` (the desk's files and the watchlist; the
  waiting list for the page, with each running stock's step), `main.ts` (the program: Stop, and Restart into an update on the person's press only, on the same address
  with `--port=N` and the same key, handed over in the new program's environment, never on a command line), and `ui/` (the
  page: `house.css` is the Madav House theme, `dashboard.css` only places its objects with tokens, `main.ts` and the
  rest are the page; `glossary.ts` is "What does this mean?", every trading word the page uses in one plain line, written
  there once: the page shows a word's line with `term()` / `means()`, the words in `index.html` carry `data-term`, and
  a test fails when a word is never pointed at, a pointed word is missing, or another file spells a meaning again).
  The page has no inline script or style (the policy refuses them): colours in charts come from
  classes, and anything an agent wrote goes through `md.ts`, which escapes first. `npm run build` bundles the page into
  `dist/terminal/`. `ui/` has its own `tsconfig.json` (it needs the browser's types).
- `src/desk/queue.ts` - the analyses asked for on the dashboard, and the contract with whatever runs the agents. Three
  files in `desk-data`, each read field by field as data from another program:
  - `queue.json`: `[{ symbol, requestedAt, depth?: "shallow"|"medium"|"deep", state: "waiting"|"running"|"done"|"failed",
    date?, startedAt?, endedAt?, rating?, reason? }]`. The dashboard adds (and takes off what is not running); the desk
    tools `start_queue_item`, `finish_queue_item` and `end_queue_run` mark the rest. One stock runs at a time; one left
    running for two hours reads as failed. `plan_analysis` plans a stock running from the list at its `depth` (no depth:
    the settings'), whatever rounds the lead asks for, and says so in the plan's notes.
  - `doorbell.json`: `{ at, waiting, why: "press"|"more" }`, written when the person presses Analyse, Retry or Run now,
    and by `end_queue_run` when stocks still wait. A runner starts a run when `at` changes, and never because the
    waiting list changed.
  - `listener.json`: `{ listener, since, beat, pid?, lastRun?: { started?, at, result } }`, kept by whoever listens, its
    `beat` renewed at least once a minute (older than three minutes: not believed). The dashboard says who listens from
    it. `lastRun` is the last run: when it started and ended, and what it did or why it stopped, in plain words. With
    `started`, a stock that run left running reads as failed at once, with the listener's words as its reason (without
    it, only after two hours). Madav's routine writes the same note in its own words, which `readListener` reads too:
    `{ listening, routine, since, checked, running, lastRun?: { at, ended: "finished"|"failed"|"stopped", endedAt?,
    result } }`, where `checked` is the heartbeat and `lastRun.at` is when the run started (`endedAt`, when given,
    when it ended).
- `src/watch/` - the desk's own listener for Claude Code (`node dist/watch.mjs`): `watcher.ts` keeps the contract above
  (a short wait so several presses make one run, one run at a time with at most one owed, no run when nothing waits,
  stopping when its note is taken away, and making way for an update between runs); `claude.ts` finds Claude Code
  without a shell and runs it with the fixed words and options in `RUN_ARGS`, never from a project file, and
  `stopReason` turns its last words, when it stops early, into the stock's reason (its usage limit and when it resets,
  a sign-in, no credit, a busy service); `main.ts` is the program, logging to `desk-data/watcher.log`.
- `src/desk/routine.ts` - the morning and evening briefs the routines run from (desk tool `routine_brief`, skill
  `/routine`, the team's playbook); `src/desk/orders.ts` - the dashboard's log of the orders it sent.
- `src/desk/care.ts` - care for what is held, and it never sells. `viewOf` is a holding's latest call and its age;
  `stopOf` reads the trader's labelled line `**Stop Loss**` as one price level alone (a sum, a percentage or "not
  provided" is no level, never guessed at), from the trader's part of the call's run (`stopIn`); `careOf` joins each
  holding of the accounts shown with its view, "re-rating" while it is on the waiting list, and in the Agentic account
  alone its stop and, for a Sell or Underweight, "the desk says sell" (the action the person's settings give the rating,
  whether a ticket can open, the shortest hold); `watched` holds each stop against Yahoo Finance's price (the dashboard's
  `/api/care`; the page draws what it is sent and tells a new fall below a stop once). `rerateWeekly` is Monday's
  re-rating from `routine_brief`: up to three of the holdings the desk sizes trades to (`holdings.ts` positions), with no
  view or one a week old, the stalest first, go on the waiting list at shallow depth, once that Monday
  (`desk-data/rerate.json`), with no doorbell. A coin held is named as the desk calls it (BTC as BTC-USD), also in what
  the agents see.
- `src/desk/screen.ts` - "Worth a look today": `signalsOf` reads a symbol's daily rows into plain signals (a move of 3%
  or more, volume twice its 20-day average, a 52-week high or low by the calendar, a close across the 50- or 200-day
  average, news today), `rank` keeps five, `screenToday` works them out at most once an hour over `tiers.ts`
  `screenUniverse` and keeps them in `desk-data/screen.json` (`{ day, at, looked, unavailable, picks, queued? }`), which
  the dashboard (`/api/screen`) and the morning routine (`routine_brief`) both read. `queueTop` is the person's morning
  switch (`prefs.ts` `morning` and `morningFrom`, set only by `/api/screen/morning`, which queues nothing itself and
  starts the switch on the next weekday): on a weekday morning (before noon New York time, `MORNING_ENDS`) from
  `morningFrom`, once, the top three not called today nor already open go on the waiting list at shallow depth; the dashboard rings the doorbell, the routine does not.
  `src/desk/weather.ts` - "Market weather": `trendOf` (the S&P 500 against its averages), `moodOf` (the VIX) and
  `ratesOf` (Polymarket's next "Fed decision" event), each a line with a state, a tone, its figures and its meaning;
  `/api/weather` keeps it an hour. Neither ever forecasts, and a figure that cannot be had leaves its line unavailable.
- `src/desk/ticket.ts` - the order ticket: sizing from the person's settings and every cap check, on real figures only,
  the guard rails included (`sector`, `cryptoHeldUsd`, `boughtOn`/`heldDays` in its context; a `Check` with `ask`
  passes but needs the person's "Sell anyway", which the server requires at Review and Place). Crypto is sized here for
  the paper book only: in fractions to six decimal places, at least $1, within what the crypto limit leaves, and with
  the crypto limit in place of a sector's. The dashboard's server refuses crypto and indices (`tradable`) when a ticket
  opens and again at Review and Place, before Robinhood is asked anything.
- `src/desk/sectors.ts` - a symbol's sector for the sector limit: the S&P sector funds and the whole-market funds by
  table, else the SEC (`data/company.ts` `profileSector`: a fund if in the SEC's funds list, else the sector of its
  industry code), an unknown one counted on its own; looked up
  once per run of the dashboard. The weekly loss limit is `robinhood/link.ts` `noteValue`, with the account's values day
  by day in `values.json` beside the sign-in.
- `src/desk/paper.ts` - the paper book: every live call on a stock, a fund or a coin in `PAPER_CRYPTO` (Bitcoin and
  Ether) sized by `propose` and held to `check` as
  its ticket would be, filled at the first close after the call's day, valued daily against SPY; worked out afresh from
  the journal and Yahoo's daily closes (the dashboard's `/api/paper`, kept ten minutes). Only the starting money is
  kept (`desk-data/paper.json`). `recordOf` is the record (weeks, calls) the trading switch's four-week press and Get started's fifth step use;
  `RECORD_WEEKS` and `RECORD_WORDS` are that paper time, one number said one way everywhere.
- `desk-settings.json` - the desk's settings (read and checked by `src/settings.ts`, trading part included, but never
  the caps: those are the person's own, beside the trading switch); `docs/design/` - the dashboard's design reference.
- `docs/inside-the-trading-desk.html` - the visual guide (GitHub Pages serves `docs/` from `main`). The README shows it
  as pictures in `docs/readme/`, light and dark: after the guide changes, `node scripts/readme-pictures.mjs` takes
  them again with a hidden Chrome or Edge (it downloads and installs nothing).
- `docs/trading-agents-walk.html` - the Trading Agents walk: the whole desk, section by section, for two readers at
  once: someone who just cloned the project and learns it by trying it, and the person testing a change, who marks
  each test Pass, Fail or Skip (kept in their browser, or in the page's own record when it is opened on claude.ai). Its
  tests are one JSON block in the page (`<script type="application/json" id="walk">`). A section is `id` (a letter),
  `name`, `sub` (one line), `about` (what this part of the desk does, for a newcomer) and `before` (what is needed
  first; optional). A test is `id` (the section's letter and the next free number, never reused or renumbered),
  `title`, `about` (what this part does and why, in plain words), `where` (the path to it, steps joined by ›), `tags`
  (`Market hours`, `Real money`, `Optional`, `Later`), `do` (the steps), `see` (what the person should see, in the
  page's own words) and `changed` (the day its steps last changed: a mark made before it counts as still to do). In
  `do` and `see`, `[[words]]` is a prompt the person types (the page copies it on a press). NVIDIA (NVDA) is the walk's
  example company. `updated` is the latest `changed`, and `version` follows `package.json`. `test/walk.test.ts` keeps
  it sound.
- `test/fake-robinhood.ts` - a pretend Robinhood for the tests: an MCP door that wants a sign-in, with read tools and
  order tools, recording every call. Its sign-in is the MCP library's own demo server (`test/fake-sign-in-server.ts`,
  a side process). The guard refuses any file that spells out the sign-in's token field names, so tests reach the
  sign-in through that demo server and read the saved file only to check that nothing in it leaks.

## Rules
- TypeScript, ESM, Node 22, `node:test`. No Python, here or in anything the desk runs.
- The desk's day is New York's (`data/dates.ts` `today` and `marketDay`), never the computer's or UTC's: every "today"
  goes through them.
- No agent ever gets an order tool. Orders come only from the person's Confirm in the dashboard, checked against the
  ticket they confirmed and their caps. The guard hook and its test keep this true.
- The Robinhood sign-in never leaves `~/.trading-agents`, is never printed, and is never given to an agent.
- Everything in the person's private folder is written through `src/private.ts`, which locks it to their own account.
  The trading caps live there beside the switch and are read from nowhere else; the dashboard's key is in no page.
- Every exact number an agent states comes from a desk tool; a source that fails is reported as unavailable.
- A fix comes with a test that fails without it.
- The page shows only what the desk really has. A number that cannot be had is a dash; a control for something that
  does not work yet is not drawn. Screenshots in a pull request must say when they were made on fixture data.
- Every pull request that changes what a person can do or see adds or updates the walk's tests in the same pull request
  (`docs/trading-agents-walk.html`): a new test for something new, the steps rewritten (and `changed` moved to that
  day) for something changed, the test taken out for something removed. The pull request says which tests to walk.

## Milestones
0 skeleton and desk check · 1 data layer · 2 the desk team · 3 the dashboard · 4 Robinhood read and review ·
5 placing orders · 6 the dashboard's stock pages and routines · 7 ready for the public.
