// A read-only connection to Robinhood's agent doorway (its Trading MCP server): sign in through Robinhood's own page if
// needed, list what the connection offers, and ask one read-only tool for the positions. Milestone 0 uses it to learn,
// on the person's computer, whether Robinhood accepts this program's sign-in; the dashboard reuses it later. It never
// calls a tool that places, changes or cancels an order: isOrderTool refuses those by name.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FileAuth } from './store.js';
import { VERSION } from '../version.js';

export const ROBINHOOD_MCP = 'https://agent.robinhood.com/mcp/trading';
export const CALLBACK_PORT = 47613;
export const redirectFor = (port: number): string => `http://127.0.0.1:${port}/callback`;

/** A tool that places, changes or cancels an order, on any broker. The same rule as .claude/hooks/guard.mjs. */
export const isOrderTool = (name: string): boolean =>
  /(place|submit|cancel|replace|modify|amend|send|execute)[\w-]*order|order[\w-]*(place|submit|cancel|replace|modify|amend|send|execute)/i.test(name);

/** Opens the person's browser on a page, without a shell reading the address. */
export function openBrowser(url: URL): void {
  const href = url.toString();
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
    : process.platform === 'darwin' ? ['open', [href]] : ['xdg-open', [href]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the address is printed too */ }
}

/** Waits for Robinhood to send the person back with a code: one request to the loopback address, its state checked. */
export function waitForCode(port: number, expectedState: () => string | undefined, timeoutMs = 5 * 60_000): { code: Promise<string>; close: () => void } {
  let close = () => {};
  const code = new Promise<string>((resolve, reject) => {
    const page = (words: string) => `<!doctype html><meta charset="utf-8"><title>Trading Agents</title><body style="font:16px system-ui;padding:40px">${words}</body>`;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const error = url.searchParams.get('error'), got = url.searchParams.get('code'), state = url.searchParams.get('state');
      const want = expectedState();
      if (error) { res.writeHead(200, { 'content-type': 'text/html' }).end(page('Robinhood did not sign you in. You can close this tab.')); finish(); reject(new Error(`Robinhood refused the sign-in: ${error}`)); return; }
      if (!got || (want && state !== want)) { res.writeHead(400, { 'content-type': 'text/html' }).end(page('This sign-in link does not match. Start again from Madav.')); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Signed in to Robinhood. You can close this tab and go back to Madav.'));
      finish(); resolve(got);
    });
    const timer = setTimeout(() => { finish(); reject(new Error('no answer from the Robinhood sign-in within 5 minutes')); }, timeoutMs);
    const finish = () => { clearTimeout(timer); server.close(); };
    close = finish;
    server.on('error', (e: NodeJS.ErrnoException) => { finish(); reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use; close what uses it and try again` : e.message)); });
    server.listen(port, '127.0.0.1');
  });
  return { code, close };
}

export interface ToolLine { name: string; readOnly: boolean; order: boolean; description: string }
export interface Connection { tools: ToolLine[]; positions?: string }

const line = (t: Tool): ToolLine => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, order: isOrderTool(t.name), description: (t.description ?? '').split('\n')[0]!.slice(0, 120) });

/** Counts what a read tool answered, without repeating any of it. */
export function summarise(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) return `${data.length} item(s)`;
    if (data && typeof data === 'object') {
      const lists = Object.entries(data).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
      if (lists.length) return lists.map(([k, v]) => `${k}: ${v.length}`).join(', ');
      return `fields: ${Object.keys(data).slice(0, 8).join(', ')}`;
    }
  } catch { /* not JSON */ }
  return `${text.length} characters of text`;
}

export async function connect(file: string, opts: { port?: number; open?: (url: URL) => void; say?: (words: string) => void } = {}): Promise<Connection> {
  const port = opts.port ?? CALLBACK_PORT, say = opts.say ?? (() => {});
  const auth = new FileAuth(file, redirectFor(port), (url) => { say(`Opening Robinhood's sign-in page. If no browser opens, visit:\n${url}`); (opts.open ?? openBrowser)(url); });
  const transport = () => new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP), { authProvider: auth });
  const client = () => new Client({ name: 'trading-agents', version: VERSION });

  let c = client(), t = transport();
  const waiting = waitForCode(port, () => auth.expectedState());
  waiting.code.catch(() => {});   // awaited below only when a sign-in is needed
  try {
    await c.connect(t);
    waiting.close();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) { waiting.close(); throw e; }
    const code = await waiting.code;
    await t.finishAuth(code);
    c = client(); t = transport();
    await c.connect(t);
  }

  try {
    const { tools } = await c.listTools();
    const out: Connection = { tools: tools.map(line) };
    const positions = tools.find((x) => /position/i.test(x.name) && !isOrderTool(x.name) && !(x.inputSchema.required?.length));
    if (positions) out.positions = `${positions.name} answered: ${summarise(await c.callTool({ name: positions.name, arguments: {} }))}`;
    return out;
  } finally {
    await c.close().catch(() => {});
  }
}
