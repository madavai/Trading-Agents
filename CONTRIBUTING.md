# Contributing

## Build and test
- Node 22 or later. `npm ci`, then `npm test` (type check, then Node's own test runner on the compiled tests).
- `npm run build` bundles each program into one file in `dist/`. **`dist/` is committed** so that a person who clones the
  repository runs it with nothing to install; CI fails when `dist/` does not match the source (`npm run check-dist`).

## Layout
- `src/tools/` - the desk tool server, the one MCP server this folder gives the engine (`.mcp.json`).
- `src/check/` - the desk check: this computer, and the free data sources.
- `src/robinhood/` - the connection to Robinhood's Trading MCP: sign-in (OAuth, kept in `~/.trading-agents`), and reads.
- `.claude/` - what Madav and Claude Code load in this folder: settings, the guard hook, skills, and the agents.
  The twelve agent files in `.claude/agents/` are written from `scripts/agents-src.mjs` (`npm run agents`); edit the
  source, not the files, and a test fails if they differ.
- `src/terminal/` - the dashboard: `server.ts` (loopback only, host and origin checks, a per-start token, strict CSP),
  `quotes.ts` (Yahoo prices), `state.ts` and `store.ts` (the desk's files, the watchlist and the queue), and `ui/` (the
  page: `house.css` is the Madav House theme, `dashboard.css` only places its objects with tokens, `main.ts` and the
  rest are the page). The page has no inline script or style (the policy refuses them): colours in charts come from
  classes, and anything an agent wrote goes through `md.ts`, which escapes first. `npm run build` bundles the page into
  `dist/terminal/`. `ui/` has its own `tsconfig.json` (it needs the browser's types).
- `desk-settings.json` - the desk's settings; `docs/design/` - the dashboard's design reference.

## Rules
- TypeScript, ESM, Node 22, `node:test`. No Python, here or in anything the desk runs.
- No agent ever gets an order tool. Orders come only from the person's Confirm in the dashboard, checked against the
  ticket they confirmed and their caps. The guard hook and its test keep this true.
- The Robinhood sign-in never leaves `~/.trading-agents`, is never printed, and is never given to an agent.
- Every exact number an agent states comes from a desk tool; a source that fails is reported as unavailable.
- A fix comes with a test that fails without it.
- The page shows only what the desk really has. A number that cannot be had is a dash; a control for something that
  does not work yet is not drawn. Screenshots in a pull request must say when they were made on fixture data.

## Milestones
0 skeleton and desk check · 1 data layer · 2 the desk team · 3 the dashboard · 4 Robinhood read and review ·
5 placing orders · 6 the dashboard's stock pages and routines · 7 ready for the public.
