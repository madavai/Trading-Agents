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

export async function fakeRobinhood(): Promise<Fake> {
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
    const mcp = fakeTools(calls), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    return transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise<void>((resolve) => server.listen(doorPort, '127.0.0.1', resolve));
  fake.close = () => new Promise((resolve) => { child.kill(); server.close(() => resolve()); server.closeAllConnections(); });
  return fake;
}
