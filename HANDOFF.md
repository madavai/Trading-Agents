# Handoff: Trading Agents, as of 22 October 2026

This file lets a new session (on any Claude account) carry on the project without guessing. It says what the project
is for, who decides, what is built, which decisions stand, where every document is, what is pending and what to do
next. Read it whole before doing anything. The details of the code are in [CONTRIBUTING.md](CONTRIBUTING.md); this
file is the map and the history.

On the owner's computer there is also a private notes file that is never committed (`CLAUDE.local.md` in the project
folder, with a `handoff.local/` folder beside it). Claude Code reads that file by itself in every session in this
folder. It holds what cannot be public: the owner's own working rules, where things live on their computer, and the
notes about Madav (the app the owner runs the desk in). If you are on that computer, read it next.

## 1. Read in this order
1. This file.
2. `CLAUDE.local.md` and `handoff.local/` (on the owner's computer only).
3. [CLAUDE.md](CLAUDE.md): the rules every agent in this folder follows.
4. [CONTRIBUTING.md](CONTRIBUTING.md): build, test, the layout of the code, and the project's rules.
5. [README.md](README.md) and [SECURITY.md](SECURITY.md): what a person sees and what keeps their money safe.
6. [docs/plan/phases-b-to-g.md](docs/plan/phases-b-to-g.md): the plan the owner approved, phase by phase.
7. [docs/trading-agents-walk.html](docs/trading-agents-walk.html): the hands-on test of every part, which every change
   keeps up to date.

## 2. Who decides, and how to work with them
- **The owner** is the only collaborator on GitHub (the account `madavai`). They are not a programmer. Talk to them in
  plain English: short sentences, everyday words, what they would notice rather than how the code works, no file
  names, code or abbreviations unless they ask (a technical word that cannot be avoided gets a meaning in brackets).
- **The flow, every task:** a session does its task on its own branch and opens a pull request. It runs the tests near
  the change on this computer, then waits until GitHub's checks are green and there are no conflicts (MERGEABLE). Only
  then is it handed to the owner, who merges. A session never merges, approves, turns on auto-merge, force-pushes or
  pushes to `main`, and never skips a hook or a test (no `--no-verify`).
- **Every pull request** has a plain one-sentence title (no prefixes such as `ci:`) and a body with these headings, in
  this order: What this is about; What changes for you; How it was checked; Risk; What could go wrong; What you need to
  do; then the technical details folded away under "Technical details (for developers)". The handover in chat follows
  the same plain style, with the link and "all checks green, no conflicts".
- **Before work:** fetch, fast-forward the main folder if it is clean and on `main`, and bring the branch up to date.
  In the Claude app, use its sync-with-base tool. It refused here because the repository's origin was never confirmed
  in the app (Help, Troubleshooting, Review Pinned Git Origins), so a plain fast-forward or merge of `origin/main` is
  what sessions used.
- **New task, new session:** once a session runs long, each new task goes to its own new session, with a full brief
  (decisions, rules, where to read).
- **Core reason, in the owner's words: "make money using agents."** Judge every piece of work first by whether it
  improves the calls or protects money, measured honestly: the paper record against the S&P 500. The owner is willing
  to take a bit of risk, but the desk's edge is unproven until the record shows it. Never promise returns; never give
  personal investment advice.
- **Build it as a public product** that 10,000 strangers could clone and run: long-term, consistent, secure, and
  friendly to people who have never traded. Credentials stay in the person's private folder, never in the repo or on
  the page.

## 3. What the project is
A team of twelve agents (adapted from TradingAgents by Tauric Research; see [NOTICE](NOTICE)) analyses a stock, a fund
or a coin from free public data and records a rated call. A dashboard on the person's own computer shows the markets,
the calls, the paper record and their Robinhood accounts. An order is placed only by the person's own Confirm there,
through Robinhood's agent doorway, in its separate Agentic account, with trading switched on by them. The desk runs in
Madav's Agent Studio as the team `trading-desk`, or in Claude Code in this folder (`/analyse`, `/terminal`,
`/routine` and the rest; see [CLAUDE.md](CLAUDE.md)). Version 0.9.0. Repository: https://github.com/madavai/Trading-Agents
(public). Website (GitHub Pages, from `docs/` on `main`): https://madavai.github.io/Trading-Agents/

## 4. What is built: every pull request
All are merged into `main`. The latest commit when this file was written is `aa06415` (#49).

**Milestones 0 to 6 (12 to 17 October)**

| PR | Merged | What changed for the owner |
|---|---|---|
| #1 | 10-12 | Milestone 0: skeleton, desk check and read-only Robinhood test |
| #2 | 10-12 | Milestone 1a: market data tools |
| #3 | 10-12 | Milestone 1b: news, posts, economic figures and odds |
| #4 | 10-12 | Milestone 1c: company accounts |
| #5 | 10-12 | Ask each person for their own email; licence text and an honest README |
| #6 | 10-14 | Milestone 2a: the desk's records |
| #7 | 10-14 | Milestone 2b: the analysis team, /analyse and /settle |
| #8 | 10-14 | Milestone 2c: backtesting |
| #9 | 10-14 | Fixes from the first real run: SEC email, Yahoo rate limits, partial session |
| #10 | 10-14 | Milestone 3: the dashboard |
| #11 | 10-14 | The dashboard can now connect to Robinhood, read-only |
| #12 | 10-14 | The desk's company accounts work again: the SEC accepts the desk |
| #13 | 10-17 | Your Robinhood accounts and the Decide ticket on the dashboard (nothing placed) |
| #14 | 10-16 | Decide on a call: an order ticket Robinhood checks, with nothing placed |
| #15 | 10-17 | Place an order on your own Confirm, once you switch trading on |
| #16 | 10-17 | Clone it and the trading desk team is ready in Agent Studio |
| #17 | 10-17 | The trading desk team is shipped where Agent Studio looks |
| #18 | 10-17 | The desk runs a morning routine and an evening wrap-up, and each stock has its own page |
| #19 | 10-17 | The project is ready for others: a README that matches what exists, a safety note, version 0.9.0 |
| #20 | 10-17 | The trading desk's agents can talk to each other |
| #21 | 10-17 | If the trading desk team gets changed by mistake, the desk notices and can put it back |
| #22 | 10-17 | The visual guide to the trading desk is part of the project on GitHub |
| #23 | 10-17 | The README and the site's short address open the live visual guide |
| #24 | 10-17 | The dashboard is tidier, and you can buy or sell any stock yourself |
| #25 | 10-17 | The dashboard is cleaner and livelier, with colours, a today row and a richer call view |
| #26 | 10-17 | The visual guide shows today's dashboard, with its side list and Trade |
| #27 | 10-17 | The project's front page on GitHub shows the guide's pictures, in light and dark |

**Safety, autonomy and phases A to G (17 to 22 October)**

| PR | Merged | What changed for the owner |
|---|---|---|
| #28 | 10-17 | The dashboard suggests stocks as you type, opens where you left it, and offers Restart after an update |
| #29 | 10-17 | The desk's safety locks are tighter before the project goes public |
| #30 | 10-19 | Only your browser gets the dashboard's key, and your caps live beside the trading switch |
| #31 | 10-19 | In Madav, /terminal opens the dashboard in one step |
| #32 | 10-19 | The desk's later members get 15 steps to finish their work, not 8 |
| #33 | 10-20 | Phase A: analyses you ask for on the dashboard run by themselves, at the depth you choose |
| #34 | 10-21 | Phase A: the agents talk to each other only when it helps |
| #35 | 10-21 | Phase B: every call is followed on paper, and the dashboard opens on that record |
| #36 | 10-21 | Phase C: four more limits: one sector, crypto, a bad week, and selling too soon |
| #37 | 10-21 | A stopped analysis says why, and the desk dates its calls by New York's calendar |
| #38 | 10-21 | Phase D (desk): a fund is read for what it holds and costs; Bitcoin and Ether are followed on paper |
| #39 | 10-21 | Official sources: a US company's valuation, insider trades and sector come from its own SEC filings |
| #40 | 10-21 | Phase D (page): the dashboard starts with the whole market, the eleven sectors and your own names |
| #41 | 10-21 | Madav's routines come ready with the project, and the dashboard sees when Madav is listening |
| #42 | 10-21 | Phase E: the market weather and what is worth a look each morning |
| #43 | 10-21 | Phase F: the desk looks after what you hold, and never sells by itself |
| #44 | 10-21 | Phase G: a newcomer is walked through a safe first month, and every trading word explains itself |
| #45 | 10-21 | A hands-on walk through every part of the desk, kept up to date with each change |
| #46 | 10-22 | The walk teaches newcomers the desk, with NVIDIA examples and prompts to copy |
| #47 | 10-22 | Analyses keep the depth you chose, world news arrives, and two-class companies like Meta get a market value |
| #48 | 10-22 | Funds are read from their own reports to the SEC: holdings, size and returns, not unavailable |
| #49 | 10-22 | The morning switch waits for the next market morning instead of queuing stocks straight away |

Every phase of the approved plan (B to G) is built. The plan itself, with each decision, is in
[docs/plan/phases-b-to-g.md](docs/plan/phases-b-to-g.md).

## 5. Decisions that stand
Each was the owner's, or agreed with them. Change one only on their word.

**Money and safety**
- Orders come only from the person's own Confirm on the dashboard, in Robinhood's Agentic account, with trading
  switched on by them. No agent has an order tool or a shell; the guard (`.claude/hooks/guard.mjs`) refuses broker
  tools, the dashboard's address and the person's private folder. Robinhood's phone approval stays recommended.
- Shipped limits, all the person's own and changed only on the dashboard (kept beside the trading switch in the private
  folder; a value out of range falls back to the shipped one, never a larger one): $500 an order, 10% of the account in
  one stock, 30% in one sector, 5% in crypto, 3 orders a day, trading off by itself after a 5% fall in a week, and a
  5-trading-day shortest hold before the desk proposes a sell. A full position is 10% of the account.
- Paper before money: every call is followed on paper against the S&P 500; switching trading on with under four weeks
  of record shows the record and asks one more press ("four weeks", said one way everywhere).
- Crypto (Bitcoin and Ether) is followed on paper only. Robinhood's agent doorway trades stocks and funds, so every
  ticket door refuses crypto and indices before Robinhood is asked anything.
- Out of scope until the desk has a long record: options, futures, currencies; notices outside the dashboard (phone,
  email).
- Nothing here is investment advice; the desk proposes research and the person decides.

**Data**
- **Official sources, honest name (22 Oct 2026).** Yahoo Finance gives its company data only to programs that call
  themselves a web browser. The owner chose official sources: the desk never calls itself a browser. A US company's
  accounts, valuation (worked out from its filings and the checked closing price), insider trades (Form 4) and sector
  (its SEC industry code, mapped approximately to eleven sectors) come from the SEC. A fund's holdings and size come
  from its SEC N-PORT reports. Yahoo stays for prices and news, and only as a today-only fallback for companies that do
  not file with the SEC (mostly unavailable). A fund's yearly cost has no official free source and stays unavailable.
- The SEC asks every reader for a contact email: the person's own, saved once (dashboard or chat), sent to the SEC
  alone. Never invent, guess or reuse an address.
- Every exact number comes from a desk tool; a source that fails is "unavailable", never "nothing happened".
- The desk's day is New York's (the market's own), wherever the computer is.

**Agents and runs**
- Twelve agents plus the lead `trading-desk`, written from `scripts/agents-src.mjs` and `scripts/team-src.mjs` by
  `npm run agents` (edit the source, never the files). Agents keep `SendMessage` in their files. No agent file sets
  `permissionMode`, and each agent's name is in one file only.
- Analyses asked for on the dashboard wait on a list in `desk-data` and ring a doorbell; whatever listens runs them, one
  stock at a time, at most five a run. The contract (queue, doorbell, listener note) is engine-neutral and documented in
  CONTRIBUTING. Two listeners exist: Madav's routine and the desk's own Claude Code listener (`node dist/watch.mjs`).
- The project ships three routines to Madav in `.claude/routines.json`, all off until the person switches them on:
  "Run automatically when the dashboard asks" (watches the doorbell), "Morning routine" (8:00 on weekdays) and
  "Evening wrap-up" (17:00 on weekdays). Madav pauses them whenever anything under `.claude`, `.mcp.json` or
  `CLAUDE.md` changes, so a run never writes there, and a handover says when a change will pause them.
- "Reset the team" writes every desk agent file again, even matching ones; that also brings Madav back to the project's
  version. The model, permissions and effort the person chose in Madav stay theirs.
- **Real test runs go through the Madav app on its default models, in Madav's own copy of the project, never through
  Claude Code** (the owner's rule, 21 Oct). A session may read that copy's `desk-data` to follow a run; updating that
  copy needs the owner's yes each time.

**The public repository**
- It is public: no commit, pull request or file may hold Madav's internal details (its source paths, store formats,
  internal names, unfixed bugs) or private session links. Describe Madav only as a person would see it.
- `main` is protected: changes only by pull request, required checks `test (ubuntu-latest)` and
  `test (windows-latest)`, no force-push. Posting is limited to collaborators until 2027-04-17 (renew it before then).
  Dependabot and private vulnerability reports are on.

## 6. Every document, and how each is kept up to date
| Document | What it is | Keep it up to date |
|---|---|---|
| [README.md](README.md) | What a person sees and does, with the guide's pictures | With every change a person would notice |
| [SECURITY.md](SECURITY.md) | Who can place an order, what agents can do, the person's data, limits | With every change near orders, data or agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, test, the layout of every part, the rules | With every change to the code's shape or rules |
| [CLAUDE.md](CLAUDE.md) | Rules for every agent in this folder, and what the person can run | Rarely; a change pauses Madav's routines |
| [NOTICE](NOTICE), [LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE) | Origin (TradingAgents, Apache 2.0) and licence | As needed |
| [docs/inside-the-trading-desk.html](docs/inside-the-trading-desk.html) | The visual guide (live at `/inside-the-trading-desk.html`; `docs/index.html` opens it) | With every change to the desk or the dashboard; then retake the README pictures (below) |
| [docs/readme/](docs/readme/) | The guide's chapters as pictures, light and dark, shown in the README | `node scripts/readme-pictures.mjs` (a hidden Chrome or Edge), keeping only pictures whose chapter changed |
| [docs/trading-agents-walk.html](docs/trading-agents-walk.html) | The Trading Agents Walk: 15 sections (A to O), every part of the desk to try by hand, with Pass, Fail or Skip marks (live at `/trading-agents-walk.html`; `#K` opens a section, `#K2` a test) | Every pull request that changes what a person can do or see adds or updates its tests (rules in CONTRIBUTING; `test/walk.test.ts` checks it) and names the tests to walk |
| [docs/plan/phases-b-to-g.md](docs/plan/phases-b-to-g.md) | The approved plan for phases B to G | Historical; add a new plan beside it |
| [docs/design/](docs/design/) | The dashboard's design reference (`desk-mock.html`, fonts) | With design changes |
| `.claude/routines.json` | The routines shipped to Madav | With routine changes (pauses them) |
| `desk-settings.json` | The desk's settings (never the caps) | With settings changes |

**Copies outside the repository.** The guide and the walk each also had a copy on claude.ai in the owner's previous
Claude account (the walk's copy keeps marks in its own database; it had none saved on 22 Oct 2026). A new account
cannot update those. The repository files are the originals: on the owner's word, publish fresh copies from them in the
new account. To make one: remove the outer page wrappers (`<!doctype html>`, `<html>`, `<head>`, the charset and
viewport metas, `<body>` and their closing tags), add `<meta name="claude:viewport-fit-sides" content="cover">` after
the title and a `body::before` band in `var(--canvas)` for a phone's top inset, then publish; for the walk, give the
artifact a database so marks are kept. A third copy of the guide is the repo file itself, sent to the owner as a file
when asked.

## 7. How to work in this repository (the parts that surprise newcomers)
- Node 22. `npm ci`, then `npm test` (type check, then Node's test runner on the compiled tests). `npm run build`
  bundles each program into `dist/`, which **is committed**: run it before committing, and `npm run check-dist` must
  show no difference. The owner's ruling (22 Oct): on this computer run the tests near the change plus the project-wide
  rule checks; the full suite runs on GitHub, and that run must be green.
- **The guard reads every tool call a session makes here.** It refuses any input that names the person's private folder
  or the sign-in file (refer to them in code through `homeDir()` and `robinhoodFile()` from `src/paths.ts`, and in prose
  as "the person's private folder"); it refuses shell and MCP calls that name the dashboard's address or its ticket and
  trading paths (edit `src/terminal/server.ts` and tests with the file editor, and write pull request bodies to a file
  passed with `--body-file`). Even a search pattern that happens to spell the private folder's name is refused.
- **The dashboard cannot be opened from a session** (the guard refuses it). To see the page: build, copy `dist/terminal/`
  to a scratch folder, add a script before `app.js` that sets a stored key and answers `fetch` with fixed data, serve it
  on a port outside the dashboard's range, and open it in the browser pane. It shows layout and script errors only.
- On Windows, tests call system tools by full path under `SystemRoot\System32` (`whoami.exe`, `icacls.exe`).
- After a pull request that touches `.claude`, `.mcp.json` or `CLAUDE.md` is merged and Madav's copy is updated, the
  owner must switch Madav's routines on again: say so in the handover.
- Every exact claim in a handover is checked (tests run, checks read); what was not tried by hand is said.

## 8. Real runs so far
- **21 Oct, Claude Code listener, NVDA shallow.** The listener worked unattended and saved 7 of 12 steps, then stopped
  on Claude Code's weekly usage limit. That led to #37: a stopped run now says why, and the desk's day became New
  York's.
- **21 Oct, Madav, META shallow** (the owner drove it, on Madav's default models): META was rated Overweight. The same
  run then took XLK and stopped on that model's 5-hour usage limit at the bull step. Its findings were fixed in #47 (the
  depth chosen is kept, world news arrives, two-class companies get a market value) and #48 (fund holdings from the
  SEC). #49 made the morning switch wait for the next market morning, after turning it on at 4:19pm queued three
  stocks at once.
- **Still on Madav's waiting list:** NVDA, XLF and XLE, to run with Run now once Madav's model allowance is back.
- **The walk:** no marks saved yet.

## 9. Pending: the owner's to do (none urgent)
1. In Madav: press Restart on the dashboard; switch the morning switch off and on once; switch the desk's routines on
   again after each update that pauses them.
2. Run the waiting stocks (NVDA, XLF, XLE) when the allowance is back, and let the routines run daily so the paper
   record grows.
3. Walk the Trading Agents Walk and mark each test; every Fail becomes the next fix.
4. Say whether "Get started" and the underlined explanations made sense, and whether the Robinhood figures look right.
5. Pass the small listener-note request to Madav (in the private notes file): today a run that stops at a usage limit
   can read as running for two hours.
6. In the Claude app (new account too): confirm GitHub as a trusted origin for this project (Help, Troubleshooting,
   Review Pinned Git Origins), so sessions can update their own folders by themselves.
7. The one-share real order is optional, and only ever the owner's decision.

## 10. Known gaps, not built unless the owner asks
- No US market-holiday calendar: the morning switch and Monday's re-rating can run on a holiday, and the shortest hold
  counts weekdays.
- The stop watch only runs while the dashboard is open.
- At phone width, the stock page's buttons push the page slightly sideways.
- No official free source for a fund's yearly cost, or for valuation and insider trades of companies outside the US.
- The SEC's industry codes are older than the market's sectors, so a few companies land in a neighbouring sector
  (ASML counts as Industrials).
- The caps refusal on the dashboard names only three caps' allowed ranges, not the four guard rails'.

## 11. Next actions, in order
1. **Let the desk run every day** (routines on, the waiting list cleared): the paper record is what proves whether the
   desk can make money.
2. **Walk the walk;** fix what fails, one pull request each, in new sessions.
3. **Around 18 November 2026, after four weeks of record:** read the scorecard against simply holding the S&P 500. If
   the desk is behind, the next work improves the calls themselves (the analysis, the data, the lessons from scored
   calls) before any new feature. If it is ahead, the owner decides about trading with real money, starting with the
   small shipped limits.
4. **Small gaps when convenient:** the market-holiday calendar first (it stops wasted runs).
5. **Before 17 April 2027:** remind the owner to renew GitHub's posting limit.

## 12. Moving to a new Claude account
- **Carries over:** everything in this repository and on GitHub; the owner's GitHub login on this computer (`gh` as
  `madavai`); the private notes file and `handoff.local/` in the project folder; Madav and its own copy of the project.
- **Does not carry over:** earlier Claude sessions and their history; the claude.ai copies of the guide and the walk,
  and the plan's claude.ai page (its content is in `docs/plan/`); the Claude app's per-account settings (confirm the
  pinned origin again); notes the app kept for linked sessions (copied into `handoff.local/notes/`).
- **First session in the new account:** read this file and the private notes; run `git fetch` and check that the main
  folder is clean and on `main` at or after `aa06415`; `npm ci` and `npm test` once; then ask the owner what to do
  first (section 11 is the recommendation).
