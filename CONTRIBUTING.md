# Contributing

## Build and test
- Node 22 or later. `npm ci`, then `npm test` (type check, then Node's own test runner on the compiled tests).
- `npm run build` bundles each program into one file in `dist/`. **`dist/` is committed** so that a person who clones the
  repository runs it with nothing to install; CI fails when `dist/` does not match the source (`npm run check-dist`).

## Layout
- `src/tools/` - the desk tool server, the one MCP server this folder gives the engine (`.mcp.json`).
- `src/check/` - the desk check: this computer, and the free data sources.
- `src/robinhood/` - the connection to Robinhood's Trading MCP: sign-in (OAuth, kept in `~/.trading-agents`), and reads.
- `.claude/` - what Madav and Claude Code load in this folder: settings, the guard hook, skills, and later the agents.
- `desk-settings.json` - the desk's settings; `docs/design/` - the dashboard's design reference.

## Rules
- TypeScript, ESM, Node 22, `node:test`. No Python, here or in anything the desk runs.
- No agent ever gets an order tool. Orders come only from the person's Confirm in the dashboard, checked against the
  ticket they confirmed and their caps. The guard hook and its test keep this true.
- The Robinhood sign-in never leaves `~/.trading-agents`, is never printed, and is never given to an agent.
- Every exact number an agent states comes from a desk tool; a source that fails is reported as unavailable.
- A fix comes with a test that fails without it.

## Milestones
0 skeleton and desk check · 1 data layer · 2 the desk team · 3 the dashboard · 4 Robinhood read and review ·
5 placing orders · 6 the dashboard's stock pages and routines · 7 ready for the public.
