import os from 'node:os';
import path from 'node:path';

/** The person's own Trading Agents folder, outside every repository: the Robinhood sign-in lives here, and agents are
 *  refused it (.claude/settings.json, .claude/hooks/guard.mjs). TRADING_AGENTS_HOME moves it, for the tests. */
export const homeDir = (): string => process.env.TRADING_AGENTS_HOME || path.join(os.homedir(), '.trading-agents');

/** The desk's working data inside the cloned folder: journal, reports, watchlist, orders. Git ignores it. */
export const deskDataDir = (root: string = process.cwd()): string => path.join(root, 'desk-data');

export const robinhoodFile = (): string => path.join(homeDir(), 'robinhood.json');
