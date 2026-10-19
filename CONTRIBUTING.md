# Contributing

## Build and test
- Node 22 or later. `npm ci`, then `npm test` (type check, then Node's own test runner on the compiled tests).
- `npm run build` bundles each program into one file in `dist/`. **`dist/` is committed** so that a person who clones the
  repository runs it with nothing to install; CI fails when `dist/` does not match the source (`npm run check-dist`).

## Layout
- `src/tools/` - the desk tool server, the one MCP server this folder gives the engine (`.mcp.json`).
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
  compares the folder with it (a save in Agent Studio can rewrite the files), and the desk tool `reset_team` writes it
  back on the person's confirmed yes (`src/desk/agent-files.ts`), touching no other file.
- `src/private.ts` - the one way anything is written into the person's private folder (`paths.ts` `homeDir`): whole,
  and locked to their own account on every system (the file mode on Linux and macOS; on Windows an access list naming
  their account and the system alone, by `icacls`). The desk check reports who can open the folder (`lockState`).
- `src/terminal/` - the dashboard: `server.ts` (loopback only, host and origin checks, a per-start key that is in no
  page it serves: the browser is opened on a one-time link, `#open=<claim>`, which the page swaps for the key once at
  `/api/claim`; while it runs the key is kept in the private folder, `dashboard.json`, so `main.ts` can open the page
  again with a fresh link from `/api/claim/new`; strict CSP),
  `quotes.ts` (Yahoo prices), `search.ts` (Yahoo's matches for what is typed), `prefs.ts` (what the page remembers, in
  `desk-data/dashboard.json`, each value checked), `state.ts` and `store.ts` (the desk's files, the watchlist and the
  queue), `main.ts` (the program: Stop, and Restart into an update on the person's press only, on the same address
  with `--port=N` and the same key, handed over in the new program's environment, never on a command line), and `ui/` (the
  page: `house.css` is the Madav House theme, `dashboard.css` only places its objects with tokens, `main.ts` and the
  rest are the page). The page has no inline script or style (the policy refuses them): colours in charts come from
  classes, and anything an agent wrote goes through `md.ts`, which escapes first. `npm run build` bundles the page into
  `dist/terminal/`. `ui/` has its own `tsconfig.json` (it needs the browser's types).
- `src/desk/routine.ts` - the morning and evening briefs the routines run from (desk tool `routine_brief`, skill
  `/routine`, the team's playbook); `src/desk/orders.ts` - the dashboard's log of the orders it sent.
- `src/desk/ticket.ts` - the order ticket: sizing from the person's settings and every cap check, on real figures only.
- `desk-settings.json` - the desk's settings (read and checked by `src/settings.ts`, trading part included, but never
  the caps: those are the person's own, beside the trading switch); `docs/design/` - the dashboard's design reference.
- `docs/inside-the-trading-desk.html` - the visual guide (GitHub Pages serves `docs/` from `main`). The README shows it
  as pictures in `docs/readme/`, light and dark: after the guide changes, `node scripts/readme-pictures.mjs` takes
  them again with a hidden Chrome or Edge (it downloads and installs nothing).
- `test/fake-robinhood.ts` - a pretend Robinhood for the tests: an MCP door that wants a sign-in, with read tools and
  order tools, recording every call. Its sign-in is the MCP library's own demo server (`test/fake-sign-in-server.ts`,
  a side process). The guard refuses any file that spells out the sign-in's token field names, so tests reach the
  sign-in through that demo server and read the saved file only to check that nothing in it leaks.

## Rules
- TypeScript, ESM, Node 22, `node:test`. No Python, here or in anything the desk runs.
- No agent ever gets an order tool. Orders come only from the person's Confirm in the dashboard, checked against the
  ticket they confirmed and their caps. The guard hook and its test keep this true.
- The Robinhood sign-in never leaves `~/.trading-agents`, is never printed, and is never given to an agent.
- Everything in the person's private folder is written through `src/private.ts`, which locks it to their own account.
  The trading caps live there beside the switch and are read from nowhere else; the dashboard's key is in no page.
- Every exact number an agent states comes from a desk tool; a source that fails is reported as unavailable.
- A fix comes with a test that fails without it.
- The page shows only what the desk really has. A number that cannot be had is a dash; a control for something that
  does not work yet is not drawn. Screenshots in a pull request must say when they were made on fixture data.

## Milestones
0 skeleton and desk check · 1 data layer · 2 the desk team · 3 the dashboard · 4 Robinhood read and review ·
5 placing orders · 6 the dashboard's stock pages and routines · 7 ready for the public.
