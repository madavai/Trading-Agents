# Contributing

New to the project, or carrying it on in a new session? Read [HANDOFF.md](HANDOFF.md) first: who decides, what is
built, which decisions stand, every document, and what is pending.

## Build and test
- Node 22 or later. `npm ci`, then `npm test` (type check, then Node's own test runner on the compiled tests).
- `npm run build` bundles each program into one file in `dist/`. **`dist/` is committed** so that a person who clones the
  repository runs it with nothing to install; CI fails when `dist/` does not match the source (`npm run check-dist`).

## Layout
- `src/tools/` - the desk tool server, the one MCP server this folder gives the engine (`.mcp.json`).
- `src/data/holidays.ts` - New York's market holidays by year, from the NYSE's "Holidays & Trading Hours" page (early
  closes are market days): `marketClosed` (why a day is closed, or null), `isMarketDay`, `nextMarketDay`,
  `firstMarketDayOfWeek` (Monday's re-rating day) and `marketDaysBetween` (the shortest hold, `orders.ts`
  `tradingDaysBetween`). A year not in the list has only its weekends closed and the routine brief says so;
  `test/holidays.test.ts` fails once next year is missing.
- `src/data/` - the free sources, each held to the analysis date, official ones first. `http.ts` keeps answers on disk
  (`keepFor`: a day for SEC documents and figures, an hour for a filer's list of filings and for FRED, five minutes for
  the rest) and says when each was read (`getTextAt`, `getJsonAt`, `readWords`); an answer asked for as data that is
  not data (a web page) is never kept (`usable`). `yahoo.ts` keeps a price series in memory for five minutes from when
  the source was read (`fetchedAt`, so a disk copy does not start them again), dates each row in the exchange's own time
  zone (`exchangeTimezoneName`, so a row stamped at its midnight keeps its day across a summer-time change), gives a
  volume it does not have as null (never 0), and names the days it lists with no prices (`missing`, `unfilled`) and
  without a dividend-adjusted close (`unadjusted`), and the market the prices are from (`market`, `delay.ts`).
  `market.ts` `latestState` calls a row final only when it was read 15 minutes or more after its session ended
  (`SETTLE_MS`), 45 for a market whose delay the desk has not checked (`SETTLE_OTHER_MS`), and names a source behind
  its own session record; `adjustedWords` says how the rows are adjusted.
  `company.ts` is a company's
  accounts, profile, valuation and insider trades: for a US filer all from the SEC as filed by the analysis date
  (`sec.ts`: statements, `submissions` for name and industry code, `sectorOfSic`, `trailingYear` for the last twelve
  months no filing states, `sharesOutstanding` from the cover page, or `averageDilutedShares` from the accounts when
  the cover page gives no single count, as for a filer with two classes of shares, and said so; `insiders.ts`: each
  Form 4 read from its own XML, an amended one (4/A) put in place of the same insiders' filing of the day it names,
  `amended`; `results.ts`: the results releases, form 8-K with item 2.02, filed in the year to the analysis date, from
  the SEC's list of filings and its older pages when the list does not reach back that far, each with the first session
  that could trade it (`firstSession`: the price table's sessions, New York's calendar outside them, 1 p.m. on an early
  close; a filing of the results alone dated before it was filed is put on that day) and that session's close, worked
  out from the closes as shown; the next results date is said to be not known, since a company announces it in a press
  release, not a filing),
  the valuation worked out with the checked close; Yahoo Finance only for a company that does not file with the SEC,
  today only (Yahoo refuses its company data to the desk's honest name, so this is mostly unavailable). The desk never
  calls itself a browser. `fundProfile` (tool `get_fund_profile`) is a fund's in their place, from `nport.ts`: the latest
  portfolio report (form N-PORT) the fund had filed by the analysis day, found by its series (`fundOf`, from the SEC's
  fund list, then the SEC's list of that series' reports) or, for an ETF set up as a trust such as SPY, by its own
  filings; its size, lines added up by issuer, assets, issuers, countries, bonds' years and interest, its own monthly
  returns, and the day its holdings are from. Amendments are not read. The yearly cost is not read (the prospectus states it) and
  is said as unavailable; a fund the SEC does not list falls back to Yahoo, today only.
- `src/check/` - the desk check: this computer, and the free data sources. `probes.ts` asks each host the desk reads
  (SEC EDGAR and the SEC's company data among them); `NOT_PROBED` names the one it does not ask, and the check says so.
  The contact email is shown masked (`contact.ts` `maskEmail`). `deskCheck` takes a `Home` (the private folder and
  the sign-in file) so tests point it at a folder of their own, never the person's.
- `src/robinhood/` - the connection to Robinhood's Trading MCP: sign-in (OAuth, kept in `~/.trading-agents`), and reads.
  `rules.ts` says what a Robinhood tool is (read, order or other) by its name and Robinhood's own read-only label;
  `reader.ts` is the ONLY place in `src/` that calls a Robinhood tool, and it refuses everything but reads (a test
  scans the source to keep it so); `connect.ts` signs in and opens sessions; `link.ts` is what the dashboard knows
  (none, waiting, connected, failed), which accounts the person chose (kept beside the sign-in as keys, never numbers;
  a key is a keyed hash with a secret made once and kept there too, `secrets.json`), the trading switch with the
  person's caps (`trading.json`, beside the sign-in, never in `desk-settings.json`) and the last read of the accounts;
  `review.ts` is the only other door: Robinhood's own
  order check (`review_equity_order`) and nothing else, for the Agentic account only; `order.ts` is the third and last:
  one order (`place_equity_order`): whole shares at a limit price, or a part-share at the market price in regular hours,
  both shaped by `rules.ts` `equityOrderArgs` (which the check door uses too), reached only from the dashboard's server after the person's Confirm, with
  trading switched on (kept beside the sign-in) and every cap checked again on fresh figures; `account.ts` reads Robinhood's answers into figures (a dash, never a zero, for what it
  did not give); `states.ts` is the one list of an order's states (done: filled, cancelled, rejected, failed, expired,
  voided; open: every other), which `account.ts` counts open orders with for the caps and the page words the orders by
  (`ui/fmt.ts` `orderState`), so the two always agree; `discover.ts` and `cli.ts` are `node dist/robinhood.mjs discover` and `shape`,
  which print what Robinhood offers and the SHAPE of its answers, never a value, so the desk is built on what is there.
- `.claude/` - what Madav and Claude Code load in this folder: settings, the guard hook, skills, and the agents.
  The thirteen agent files in `.claude/agents/` are written from `scripts/agents-src.mjs` (`npm run agents`); edit the
  source, not the files, and a test fails if they differ.
  Madav's Agent Studio lists the same files. Beside them, `trading-desk.md` is the team's own file and
  `trading-desk.team.json` its line-up in the shape Madav keeps a team in (members, steps, together, gates, talk), for
  Agent Studio to take as the team until the person changes it there. Both are written by `npm run agents` from
  `scripts/team-src.mjs`: the team's playbook is the /analyse, /settle, /recheck-lessons and /backtest skills, so after editing a skill run
  `npm run agents` again. The team gets no shell: it opens the dashboard with the desk tool `open_dashboard`.
  `scripts/team-files.mjs` is the one list of these files and their text: `npm run agents` writes it, the desk check
  compares the folder with it (an edit, or an older Madav, can change the files), and the desk tool `reset_team` writes it
  back on the person's confirmed yes (`src/desk/agent-files.ts`), every file each time, even one that matches: Madav
  keeps Agent Studio's changes inside itself and returns to the project's version of a file when that file is written.
  Touches no other file. A reset is noted in `desk-data/team-reset.json`; asked again within `RESET_AGAIN_MS` (half an
  hour) with nothing differing on disk, it writes nothing and answers ALREADY RESET. The team's file carries the version
  of its own steps (`team_version "…"`: the first eight hex digits of the SHA-256 of its text with `VERSION_MARK` in
  their place, `scripts/team-src.mjs`); the team passes it to `desk_check`, which says whether it is the folder's
  (`teamLine`), since a conversation keeps its copy of the steps from when it began. `team_version` is required (the
  team twice left an optional one out): left out, the call is refused with what to pass and nothing is checked; a
  caller that is not the team passes `"none"` (`NONE`). `scripts/team-versions.json` lists every version the steps
  have had (`npm run agents` adds the new one, `--check` fails without it; never remove one): only a version on it
  that is not the folder's says this conversation began before the update; one never had, like none given, not a
  version, or tools started before an update, makes the first line say plainly that this conversation's steps were not
  compared, marked `--` (neither OK nor NO; `NO_VERSION` in a plain chat). Through the tool, the first three of those
  open the answer with `ASK_AGAIN` (TEAM VERSION NEEDED), asking the team once to call again with the version from its
  own step 1; a terminal's check (`--check`) is never asked again. The agent-files line names the files in this
  folder, and `TWO_LINES` under them says to pass both on as written, never one for the other. The desk-check skill
  carries no version of its own: it tells the team to pass the one in its own steps, since steps read from the folder
  during a conversation would always match. The team's own section and the skill share the same reporting step, which
  never sums up "nothing needs fixing" while the steps were not compared (a test keeps them so).
- `src/desk/freshness.ts` - whether the desk in the folder was updated after this tool server started: a fingerprint
  of the desk's own code (`CODE_FILES`: the built tool server, the team's source, and every skill) taken at start and
  compared on each answer, read again only when a file's size or time changes. Once it differs, every answer opens with
  `UPDATED_NOTE` ("DESK UPDATED: …", added once for every tool in `server.ts`), `reset_team` writes nothing (the
  process holds the team's source as it was when it first loaded it, so it would write the old team back), and the
  desk check compares no agent files. A conversation whose tools are started afresh for each step is not seen this way;
  the team's version line covers it. Agent files never set `permissionMode` (Madav ignores it in routine runs; the person's choice
  rules), and each agent's name is in one file only (a name in two files is not started); a test keeps both true.
- `.claude/routines.json` - the routines the project ships to Madav, each off until the person switches it on: the
  waiting list (`watch` the doorbell, `listener` the note, the words `RUN_WORDS` in `desk/queue.ts`), and
  the morning and evening routines (`cron`). Madav reads it and never writes it. A change under `.claude`, to
  `.mcp.json` or to `CLAUDE.md` pauses the routines until the person switches them on again, so nothing written at run
  time may live there.
- `src/numbers.ts` - signed figures in words (`signed`, `signedPct`): what rounds to zero is written as zero, never
  "-0.0%"; `unsignZero` reads a score stored that way back as "0.0%". The page's own `pct` and `money`
  (`src/terminal/ui/fmt.ts`) follow the same rule.
- `src/desk/scoring.ts` - how a call is scored: once, a first-week check against a named yardstick, never over the
  call's own time horizon. `rulesFor` gives a new call its `Rules` (days, unit, yardstick and why that yardstick:
  `us`, `coin`, `unlisted`, `market` or `chosen`): a US stock or fund over `holdingPeriodDays` (5) trading days, a coin
  over `coinDays` (7) calendar days, both against SPY; a stock from an exchange the settings do not list (`exchangeOf`)
  against SPY too, said so. `record_decision` writes them into the call's journal tag (`window:5 trading days`,
  `yardstick:SPY (us)`), and every scoring, lesson and page reads them from there; a call recorded before the tag kept
  them gets `legacyRules` (its stored days, a coin in calendar days, the yardstick by suffix), so no score already
  given changes. `measure` scores a trading window on the yardstick's own sessions; a coin's calendar window ends
  exactly N days after the call, the coin's close on that day, and SPY's last close on or before the coin's first and
  last day (a weekend or a New York holiday, `holidays.ts`, takes the close before it); while New York's last market
  day on or before the end has no SPY close yet, it is not scored. `checkWords`, `windowWords` and `WHEN_SCORED` are
  the words every place says it in.
- `src/desk/window.ts` - what happened in a settled call's holding window (`windowRows`): the entry row, marked
  "entry" with its change left out (the call is scored from its close; its own move came before the window), then the
  finished sessions numbered from 1, with change, volume, RSI, MACD histogram, 10 EMA and 50 SMA beside the yardstick's
  close, and a glance line over sessions 1 to N only. The rows are dividend-adjusted, as the call is scored; when a
  dividend has lowered them, the high, low and close as traded are added beside them, for the levels a decision named.
  `list_settlements` shows it under each READY call, so a lesson
  says what a stock did only as a row shows it; the /settle skill holds the lesson to those rows. `settle.ts` counts a
  lesson's sentences (`sentencesOf`, `sentencesIn`) and refuses more than `MAX_SENTENCES` (four), in `record_outcome`
  and `correct_lesson` alike (`lessonRefusal`, which says how it counts and where it cut). A full stop in a run of
  single letters (a.m., U.S.A.), a short word it knows (No., vs., approx., a month, any case), an initial or an
  ellipsis never ends a sentence: a miscount must not refuse a lesson of four, so it errs on the low side. A scoring
  keeps its own notes beside the journal (`settle-check.json`, the same `loop-notes.ts` as a re-check's): a call
  `record_outcome` failed to settle `REFUSALS_TO_LEAVE` (two) times answers LEFT, stays pending, and is named, not
  shown, by `list_settlements` (which only reads the notes); sent again after that with no call settled since, it
  answers STOP. A call that is not pending is never counted. The notes lapse `NOTES_IDLE_MS` after `record_outcome`
  was last used, so a later scoring tries the call again.
- `src/desk/lessons.ts` - re-checking lessons that were not written from their window's rows (`recheck_lessons`,
  `correct_lesson`, `flag_lesson`, the /recheck-lessons skill). How a lesson was written is in its journal tag
  (`journal.ts`): `lesson:prices`, `lesson:no-prices`, `lesson:corrected:<day>`, `lesson:unreliable:<day>`,
  `lesson:flagged:<day>`, or no mark for one written before the rows were shown. A correction replaces only the
  lesson: the tag's call, rating and score and the decision stay byte for byte, the first lesson is kept word for word
  under FIRST LESSON, a corrected lesson it replaces is kept with its check under EARLIER CORRECTIONS (newest first),
  and LESSON CHECK says what the check found. `what_was_wrong` sorts each statement under "Contradicted:", "Not known
  from the prices:" and "Right:" (`CHECK_LABELS`), under `MAX_CHECK_NOTE` characters. A lesson written from the prices
  or corrected already is rewritten only after `flag_lesson`, on the person's confirmed word: it is withheld at once
  and listed again with what they said. A call whose rows cannot be had is marked unreliable by the desk, never
  guessed. `pastContext` tells the analyses how each lesson was written and withholds an unreliable or flagged one
  (`WITHHELD`). A re-check keeps its own notes beside the journal (`lesson-check.json`, in `loop-notes.ts`, forgotten
  `NOTES_IDLE_MS`, an hour, after its last step) so it cannot go round: a lesson `correct_lesson` refused
  `REFUSALS_TO_LEAVE` (two) times answers LEFT and is named, not shown, in later listings (a flag clears that); sent
  again after that with no lesson saved since, it answers STOP; the same lessons listed again with nothing saved since
  answer STOP, without the rows. With nothing left to rewrite, the answer ends with LATER
  RE-CHECKS: the true words about what a later re-check does (no corrected lesson, unless the person says it is wrong).
- `src/private.ts` - the one way anything is written into the person's private folder (`paths.ts` `homeDir`): whole,
  and locked to their own account on every system (the file mode on Linux and macOS; on Windows an access list naming
  their account and the system alone, by `icacls`). The desk check reports who can open the folder (`lockState`).
- `src/terminal/` - the dashboard: `server.ts` (loopback only, host and origin checks, a per-start key that is in no
  page it serves: the browser is opened on a one-time link, `#open=<claim>`, which the page swaps for the key once at
  `/api/claim`; while it runs the key is kept in the private folder, `dashboard.json`, so `main.ts` can open the page
  again with a fresh link from `/api/claim/new`; strict CSP),
  `quotes.ts` (Yahoo prices; each quote carries what Yahoo calls it, `quoteKind`: company, fund or coin, and none for an index,
  a currency, a future or no word, which the page's letter badges are shaded by), `search.ts` (Yahoo's matches for what is typed), `prefs.ts` (what the page remembers, in
  `desk-data/dashboard.json`, each value checked; `moveMarketToWatchlist` is the one-time move of an older version's
  "whole market" row onto the watchlist, run when the dashboard starts and before a routine's look at the market, and the
  page can set neither the old list nor the mark that it was moved), `tiers.ts` (the world in tiers for the "Sectors" section
  and the watchlist: the sector funds are all the section shows, sent as `startHere`, the section's old name; the watchlist
  is grouped into the whole market, the sector funds, single names and crypto by `tierOf`, by the desk's own list of broad
  funds in `desk/sectors.ts`, with every fund's and tier's name and meaning in plain words; the page draws what it is sent
  and holds no tier rules of its own; `screenUniverse` is what "Worth a look" scans: the sector funds and the watchlist),
  `guide.ts` ("Get started", the first month in five steps:
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
- `src/desk/runs.ts` - a run's working record (`run.json`): each agent's section, saved as it is written, and the
  finished report. `correctSection` (desk tool `correct_report`) is how the fact checker changes an analyst's report:
  exact passages only, each marked `[corrected: was "..."]`, and only before the debate begins, so it never retypes a
  report. A run whose debate began before it had a fact checker goes on without one (`buildPlan`). Each time a run is
  planned, `saveContext` keeps the holdings and the lessons the plan drew up (`runContext` in `plan.ts`; in a backtest no
  holdings, since today's were not known on the days tested), and `read_run` serves them as sections `holdings` and
  `lessons`. The trader, the risk voices and the portfolio manager read them from there, never from the lead's request,
  which a lead can leave out unseen.
- `src/desk/queue.ts` - the analyses asked for on the dashboard, and the contract with whatever runs the agents. Three
  files in `desk-data`, each read field by field as data from another program:
  - `queue.json`: `[{ symbol, requestedAt, depth?: "shallow"|"medium"|"deep", state: "waiting"|"running"|"done"|"failed",
    date?, startedAt?, endedAt?, rating?, reason?, quiet?: true, already?: true }]`. The dashboard adds (and takes off
    what is not running); the desk tools `start_queue_item`, `finish_queue_item` and `end_queue_run` mark the rest
    (`already`: done because it was called earlier that day, not analysed again). One stock runs at a time. A running
    stock with nothing saved for `QUIET_MS` (two hours: since it started, or since its run record, `runs.ts`
    `lastSaved`, last changed; `lastSignOf`) reads as failed with `QUIET_REASON` and `quiet`, however long it has run:
    an analysis still saving its steps is never failed. That is the desk's guess, so `finishItem` still lets its own
    run finish it (done when its call is recorded, or failed in its words); any other finished stock stays finished.
    `plan_analysis` plans a stock running from the list at its `depth` (no depth: the settings'), whatever rounds the
    lead asks for, and says so in the plan's notes.
  - `doorbell.json`: `{ at, waiting, why: "press"|"more" }`, written when the person presses Analyse, Retry or Run now,
    and by `end_queue_run` when stocks still wait. A runner starts a run when `at` changes, and never because the
    waiting list changed.
  - `listener.json`: `{ listener, since, beat, pid?, lastRun?: { started?, at, result } }`, kept by whoever listens, its
    `beat` renewed at least once a minute (older than three minutes: not believed). The dashboard says who listens from
    it. `lastRun` is the last run: when it started and ended, and what it did or why it stopped, in plain words. With
    `started`, a stock that run left running reads as failed at once, with the listener's words as its reason (without
    it, only by the quiet rule). Madav's routine writes the same note in its own words, which `readListener` reads too:
    `{ listening, routine, since, checked, running, lastRun?: { at, ended: "finished"|"failed"|"stopped", endedAt?,
    result } }`, where `checked` is the heartbeat and `lastRun.at` is when the run started (`endedAt`, when given,
    when it ended).
- The desk has no listener of its own (`src/watch/` and `dist/watch.mjs` were removed: it runs analyses only in the app it runs
  in, and the dashboard has no button that starts Claude Code). Whatever runs them follows the contract above: Madav's routine,
  or a chat. `desk/queue.ts` `RUN_WORDS` is the words a runner is started with. A dashboard that starts takes away, and
  then at every look, a listener note that names itself "Claude Code" (`server.ts` `retireOldListener`): the note an
  older version's listener kept, which makes one left running from before an update stop after the run in hand. Madav's
  note is never touched. An `autorun` an older version saved in `dashboard.json` is not read and is dropped on the next save.
- `src/desk/routine.ts` - the morning and evening briefs the routines run from (desk tool `routine_brief`, skill
  `/routine`, the team's playbook); `src/desk/orders.ts` - the dashboard's log of the orders it sent.
- `src/desk/care.ts` - care for what is held, and it never sells. `viewOf` is a holding's latest call and its age;
  `stopOf` reads the trader's labelled line `**Stop Loss**` as one price level alone (a sum, a percentage or "not
  provided" is no level, never guessed at), from the trader's part of the call's run (`stopIn`); `careOf` joins each
  holding of the accounts shown with its view, "re-rating" while it is on the waiting list, and in the Agentic account
  alone its stop and, for a Sell or Underweight, "the desk says sell" (the action the person's settings give the rating,
  whether a ticket can open, the shortest hold); `watched` holds each stop against Yahoo Finance's price (the dashboard's
  `/api/care`; the page draws what it is sent and tells a new fall below a stop once). `rerateWeekly` is the week's
  re-rating from `routine_brief`, on its first market day (`isRerateDay`: a Monday, or the Tuesday after a Monday
  holiday): up to three of the holdings the desk sizes trades to (`holdings.ts` positions), with no view or one a week
  old, the stalest first, go on the waiting list at shallow depth, once that week (`desk-data/rerate.json`, with `full`
  when the waiting list refused one, so the brief says the true reason), with no doorbell. A coin held is named as the
  desk calls it (BTC as BTC-USD), also in what
  the agents see.
- `src/desk/screen.ts` - "Worth a look today": `signalsOf` reads a symbol's daily rows into plain signals (a move of 3%
  or more, volume twice its 20-day average, a 52-week high or low by the calendar, a close across the 50- or 200-day
  average, news today), `rank` keeps five (marking a move read before its session's close was final `live`), `screenToday` works them out at most once an hour over `tiers.ts`
  `screenUniverse` and keeps them in `desk-data/screen.json` (`{ day, at, looked, unavailable, picks, queued?, news?,
  session?, live? }`: `news` is how many names' news was read and which could not be, `session` the trading day the
  moves are from), which
  the dashboard (`/api/screen`) and the morning routine (`routine_brief`) both read. `queueTop` is the person's morning
  switch (`prefs.ts` `morning` and `morningFrom`, set only by `/api/screen/morning`, which queues nothing itself and
  starts the switch on the next market day): on a market morning (`data/holidays.ts`; before noon New York time,
  `MORNING_ENDS`) from
  `morningFrom`, once, the top three not called today nor already open go on the waiting list at shallow depth; the dashboard rings the doorbell, the routine does not.
  `src/desk/weather.ts` - "Market weather": `trendOf` (the S&P 500 against its averages), `moodOf` (the VIX), both
  saying "closed at" only for a final close (`liveOf`, from `market.ts` `latestState`: "still trading (not a close)"
  while it trades, "before that session's close was final" for rows read before then, and plain about it when Yahoo
  gives no session times), and
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
  its ticket would be, filled at the first close after the call's day as printed (Yahoo's `traded` rows, never the
  dividend-adjusted ones), each dividend paid into paper cash on its ex-day for the shares held that morning, valued
  daily against SPY bought at the same start and paid its own dividends; worked out afresh from the journal and Yahoo's
  daily closes (the dashboard's `/api/paper`, kept ten minutes). A held stock is valued only at a close of its own,
  never at its cost: when a stock with a buy-asking call has no closes (`missing`), or a held one has none for a day
  (`NoClose`), the book is withheld, with no total, chart or positions, its fills marked `withheld`, and not kept, so
  the page (which asks again a minute later) says which stock's prices could not be read. Only the starting money is
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
