import os from 'node:os';
import path from 'node:path';

/** The person's own Trading Agents folder, outside every repository: the Robinhood sign-in lives here, and agents are
 *  refused it (.claude/settings.json, .claude/hooks/guard.mjs). TRADING_AGENTS_HOME moves it, for the tests. */
export const homeDir = (): string => process.env.TRADING_AGENTS_HOME || path.join(os.homedir(), '.trading-agents');

/** The desk's working data inside the cloned folder: journal, reports, watchlist, orders. Git ignores it. */
export const deskDataDir = (root: string = process.cwd()): string => path.join(root, 'desk-data');

/** Where a running dashboard keeps its key, for a later opening of its page from this computer (terminal/main.ts): in the
 *  private folder, so only the person's own programs can read it. */
export const dashboardKeyFile = (): string => path.join(homeDir(), 'dashboard.json');

export const robinhoodFile = (): string => path.join(homeDir(), 'robinhood.json');
