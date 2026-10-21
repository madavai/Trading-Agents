// A pretend Robinhood for the tests: the same kind of door the real one is - an MCP server that wants a sign-in before it
// answers - with a few read tools and a few that order, review or change things. The sign-in is the MCP library's own demo
// server (fake-sign-in-server.ts, a side process); this file only asks it whether a visitor's pass is good. Every tool call
// is written to `calls`, so a test can prove which tools were reached and that no order tool ever was. The account figures
// are made up, and tests check that none of them leaks into what the desk prints or shows.
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const ACCOUNT = 'ACC48151623', BUYING_POWER = '1500.25', HELD = 'NVDA';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const READ = { readOnlyHint: true } as const, WRITE = { readOnlyHint: false } as const;

/** The pretend tools. `calls` collects the name of each tool called. */
export function fakeTools(calls: string[]): McpServer {
  const s = new McpServer({ name: 'fake-robinhood', version: '0' });
  const tool = (name: string, description: string, annotations: { readOnlyHint: boolean }, answer: () => unknown, inputSchema?: Record<string, z.ZodType>) => {
    const run = async () => { calls.push(name); return text(answer()); };
    if (inputSchema) s.registerTool(name, { description, inputSchema, annotations }, run); else s.registerTool(name, { description, annotations }, run);
  };
  tool('get_accounts', 'List the person\'s accounts and their buying power.', READ, () => ({ accounts: [{ account_number: ACCOUNT, type: 'agentic', buying_power: BUYING_POWER, updated_at: '2026-10-12T15:00:00Z', nickname: null }] }));
  tool('get_equity_positions', 'The stocks held, with quantity and average cost.', READ, () => ({ positions: [{ symbol: HELD, quantity: '20.0000', average_cost: '141.20' }, { symbol: 'AAPL', quantity: '10.0000', average_cost: '198.50', note: 'core' }] }));
  tool('get_account_activity', 'Recent activity of one account.', READ, () => ({ activity: [] }), { account_number: z.string().describe('The account to read') });
  tool('place_equity_order', 'Place an order to buy or sell a stock.', WRITE, () => ({ placed: true }), { symbol: z.string(), quantity: z.string() });
  tool('review_equity_order', 'Check an order without placing it.', READ, () => ({ ok: true }), { symbol: z.string(), quantity: z.string() });   // labelled read-only, but it names an order: never called
  tool('cancel_equity_order', 'Cancel an open order.', WRITE, () => ({ cancelled: true }), { order_id: z.string() });
  tool('set_account_nickname', 'Rename an account.', WRITE, () => ({ ok: true }), { nickname: z.string() });
  tool('get_sneaky', 'Named like a read, but not labelled read-only.', WRITE, () => ({ ok: true }));
  return s;
}

// ---------- a pretend Robinhood that answers the way the real one does: { data, guide } ----------
export const MAIN = '5RH77001234', MAIN_RHS = '771001234', AGENTIC = '5RH88004321', AGENTIC_RHS = '881004321', CLOSED = '5RH99009999';
export const MAIN_TOTAL = '9112.50', AGENTIC_CASH = '2500.00';
const answer = (data: unknown) => text({ data, guide: 'Present the accounts in a table and always confirm with the user.' });

/** Two live accounts (the default one, and the one agents may trade) and a closed one; the default holds NVDA and AAPL. */
export function accountTools(calls: string[], o: { approvalsOn?: boolean; orders?: unknown[]; reviewAlerts?: string[]; reviewed?: Array<Record<string, unknown>>; agenticBuyingPower?: string; placed?: Array<Record<string, unknown>>; agenticPositions?: unknown[] } = {}): McpServer {
  const s = new McpServer({ name: 'fake-robinhood-accounts', version: '0' });
  const acct = { account_number: z.string() }, rhs = { rhs_account_number: z.string() };
  const reg = (name: string, readOnlyHint: boolean, run: (a: Record<string, unknown>) => unknown, inputSchema?: Record<string, z.ZodType>) => {
    const cb = async (a: unknown) => { calls.push(name); return answer(run((a ?? {}) as Record<string, unknown>)); };
    if (inputSchema) s.registerTool(name, { description: name, inputSchema, annotations: { readOnlyHint } }, cb); else s.registerTool(name, { description: name, annotations: { readOnlyHint } }, async () => cb({}));
  };
  reg('get_accounts', true, () => ({ accounts: [
    { account_number: MAIN, rhs_account_number: MAIN_RHS, type: 'cash', brokerage_account_type: 'individual', is_default: true, agentic_allowed: false, deactivated: false },
    { account_number: CLOSED, rhs_account_number: '991009999', type: 'cash', brokerage_account_type: 'individual', is_default: false, agentic_allowed: false, deactivated: true },
    { account_number: AGENTIC, rhs_account_number: AGENTIC_RHS, type: 'cash', brokerage_account_type: 'individual', is_default: false, agentic_allowed: true, deactivated: false, nickname: 'Desk' },
  ] }));
  reg('get_portfolio', true, (a) => (a.account_number === MAIN
    ? { total_value: MAIN_TOTAL, equity_value: '6009.50', crypto_value: '0', options_value: '0', cash: '3103.00', currency: 'USD', buying_power: { buying_power: '3103.00' } }
    : { total_value: AGENTIC_CASH, equity_value: '0', crypto_value: '0', options_value: '0', cash: AGENTIC_CASH, currency: 'USD', buying_power: { buying_power: o.agenticBuyingPower ?? 'not a number' } }), acct);
  reg('get_equity_positions', true, (a) => ({ positions: a.account_number === MAIN ? [{ symbol: 'NVDA', quantity: '20.0000', average_buy_price: '141.20' }, { symbol: 'AAPL', quantity: '10.0000', average_buy_price: '198.50' }, { symbol: 'ZERO', quantity: '0.0000' }] : o.agenticPositions ?? [] }), acct);
  reg('get_crypto_positions', true, () => ({ results: [] }), rhs);
  reg('get_equity_quotes', true, (a) => ({ results: (a.symbols as string[]).filter((x) => x !== 'AAPL').map((symbol) => ({ quote: { symbol, last_trade_price: symbol === 'NVDA' ? '182.40' : '1.00' } })) }), { symbols: z.array(z.string()) });
  reg('get_equity_orders', true, () => ({ orders: o.orders ?? [] }), acct);
  reg('get_trade_approval_setting', true, (a) => ({ setting: { account_number: a.account_number, human_must_approve_trades: o.approvalsOn ?? true } }), acct);
  reg('get_trade_approvals', true, () => ({ approvals: [] }), acct);
  // Robinhood labels its order check as not read-only, though it places nothing: it is reached only through the Reviewer.
  reg('review_equity_order', false, (a) => { o.reviewed?.push(a); return { order_checks: (o.reviewAlerts ?? []).map((message) => ({ message })), customer_approval_required: o.approvalsOn ?? true, estimated_cost: String(Number(a.quantity) * Number(a.limit_price)), quote: { last_trade_price: '182.40' } }; },
    { ...acct, symbol: z.string(), side: z.string(), type: z.string(), quantity: z.string(), limit_price: z.string(), time_in_force: z.string(), market_hours: z.string() });
  reg('place_equity_order', false, (a) => { o.placed?.push(a); return { order_id: '6f1c2b9e-0000-4000-8000-00000000abcd', state: 'queued', customer_approval_required: o.approvalsOn ?? true, message: 'Waiting for the customer to approve in the Robinhood app.' }; },
    { ...acct, symbol: z.string(), side: z.string(), type: z.string(), quantity: z.string(), limit_price: z.string(), time_in_force: z.string(), market_hours: z.string(), ref_id: z.string() });
  return s;
}

const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

export interface Fake {
  /** The address of its MCP door. */
  url: string;
  calls: string[];
  /** How many times the door was knocked on, and how many knocks were turned away for want of a good pass. */
  hits: { mcp: number; turnedAway: number };
  /** While true, every pass is refused, as if Robinhood had ended the person's access. */
  refuseAll: boolean;
  close: () => Promise<void>;
}

export async function fakeRobinhood(tools: (calls: string[]) => McpServer = fakeTools): Promise<Fake> {
  const calls: string[] = [], hits = { mcp: 0, turnedAway: 0 };
  const [doorPort, signInPort] = [await freePort(), await freePort()];
  const door = `http://127.0.0.1:${doorPort}`, signIn = `http://127.0.0.1:${signInPort}`;

  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL('./fake-sign-in-server.js', import.meta.url)), String(signInPort), `${door}/mcp`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the pretend sign-in server stopped at start-up (${code})`)));
    child.stdout!.on('data', (b: Buffer) => { if (String(b).includes('listening')) { child.removeAllListeners('exit'); resolve(); } });
  });

  const fake: Fake = { url: `${door}/mcp`, calls, hits, refuseAll: false, close: async () => {} };
  const passIsGood = async (pass: string): Promise<boolean> => {
    if (fake.refuseAll) return false;
    const r = await fetch(`${signIn}/introspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pass }) });
    return r.ok && ((await r.json()) as { active?: boolean }).active === true;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', door);
    if (url.pathname === '/.well-known/oauth-protected-resource') return send(200, { resource: `${door}/mcp`, authorization_servers: [signIn] });
    if (url.pathname !== '/mcp') return send(404, { error: 'not found' });
    hits.mcp++;
    const pass = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!pass || !(await passIsGood(pass))) { hits.turnedAway++; return send(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${door}/.well-known/oauth-protected-resource"` }); }
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    let body = ''; for await (const c of req) body += c;
    const mcp = tools(calls), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    return transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise<void>((resolve) => server.listen(doorPort, '127.0.0.1', resolve));
  fake.close = () => new Promise((resolve) => { child.kill(); server.close(() => resolve()); server.closeAllConnections(); });
  return fake;
}
