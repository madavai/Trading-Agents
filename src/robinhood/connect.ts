// The connection to Robinhood's agent doorway (its Trading MCP server): sign in through Robinhood's own page if needed,
// open a session that lists what the connection offers, and (for the connection test) ask one read-only tool for the
// positions. The dashboard opens sessions here too. Nothing here calls a tool: that is the Reader's job (reader.ts), and
// the Reader calls only tools labelled read-only that do not speak of orders or moving money.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FileAuth, readSaved } from './store.js';
import { Reader } from './reader.js';
import { Reviewer } from './review.js';
import { Placer } from './order.js';
import { isOrderTool, kindOf, TRADE_WORDS, type Kind } from './rules.js';
import { VERSION } from '../version.js';

export const ROBINHOOD_MCP = 'https://agent.robinhood.com/mcp/trading';
export const CALLBACK_PORT = 47613;
export const redirectFor = (port: number): string => `http://127.0.0.1:${port}/callback`;

export { TRADE_WORDS, isOrderTool };

/** The one tool the connection test may call: a get or list of positions, nothing that trades. */
export const isPositionsRead = (name: string): boolean => /^(get|list)_/i.test(name) && /position/i.test(name) && !isOrderTool(name);

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
    // Every answer closes its connection: this server lives for one sign-in, and a browser (or a later sign-in in a program that
    // stays open, like the dashboard) must not send the next return trip down a connection that still reaches this finished one.
    const answer = (res: http.ServerResponse, status: number, words?: string) => { res.writeHead(status, { connection: 'close', ...(words ? { 'content-type': 'text/html' } : {}) }).end(words ? page(words) : undefined); };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') { answer(res, 404); return; }
      const error = url.searchParams.get('error'), got = url.searchParams.get('code'), state = url.searchParams.get('state');
      const want = expectedState();
      if (error) { answer(res, 200, 'Robinhood did not sign you in. You can close this tab.'); finish(); reject(new Error(`Robinhood refused the sign-in: ${error}`)); return; }
      if (!got || (want && state !== want)) { answer(res, 400, 'This sign-in link does not match. Start again from Madav.'); return; }
      answer(res, 200, 'Signed in to Robinhood. You can close this tab and go back to Madav.');
      finish(); resolve(got);
    });
    const timer = setTimeout(() => { finish(); reject(new Error('no answer from the Robinhood sign-in within 5 minutes')); }, timeoutMs);
    const finish = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); };
    close = finish;
    server.on('error', (e: NodeJS.ErrnoException) => { finish(); reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use; close what uses it and try again` : e.message)); });
    server.listen(port, '127.0.0.1');
  });
  return { code, close };
}

export interface ToolLine { name: string; readOnly: boolean; kind: Kind; order: boolean; description: string }
export interface Connection { tools: ToolLine[]; positions?: string }

export const toolLine = (t: Tool): ToolLine => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, kind: kindOf(t), order: isOrderTool(t.name), description: (t.description ?? '').split('\n')[0]!.slice(0, 120) });

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

/** There is no usable sign-in: none saved, or Robinhood asks for a new one. Only a session opened to sign in may fix that. */
export class NotSignedIn extends Error { constructor(message: string) { super(message); this.name = 'NotSignedIn'; } }

export interface SessionOptions {
  /** true: send the person to Robinhood's sign-in page when needed. false: never open a browser or register anything;
   *  with no usable sign-in the session fails with NotSignedIn. */
  signIn: boolean;
  url?: string; port?: number; open?: (url: URL) => void; say?: (words: string) => void;
}
/** reader: the read tools. reviewer: Robinhood's order check alone, used only on the person's Review. placer: one
 *  limit order, used only by the dashboard's server after the person's Confirm (link.ts placeChecked). */
export interface Session { reader: Reader; reviewer: Reviewer; placer: Placer; close: () => Promise<void> }

/** Opens a connection to Robinhood and lists what it offers. The caller closes it. */
export async function openSession(file: string, opts: SessionOptions): Promise<Session> {
  const port = opts.port ?? CALLBACK_PORT, say = opts.say ?? (() => {}), endpoint = new URL(opts.url ?? ROBINHOOD_MCP);
  if (!opts.signIn && !readSaved(file).tokens) throw new NotSignedIn('No Robinhood sign-in is saved.');
  const auth = new FileAuth(file, redirectFor(port), (url) => {
    if (!opts.signIn) return;
    say(`Opening Robinhood's sign-in page. If no browser opens, visit:\n${url}`);
    (opts.open ?? openBrowser)(url);
  });
  const transport = () => new StreamableHTTPClientTransport(endpoint, { authProvider: auth });
  const client = () => new Client({ name: 'trading-agents', version: VERSION });

  let c = client(), t = transport();
  const waiting = opts.signIn ? waitForCode(port, () => auth.expectedState()) : null;
  waiting?.code.catch(() => {});   // awaited below only when a sign-in is needed
  try {
    await c.connect(t);
    waiting?.close();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) { waiting?.close(); throw e; }
    if (!waiting) throw new NotSignedIn('Robinhood asks for a new sign-in.');
    const code = await waiting.code;
    await t.finishAuth(code);
    c = client(); t = transport();
    await c.connect(t);
  }
  try {
    const { tools } = await c.listTools();
    return { reader: new Reader(c, tools), reviewer: new Reviewer(c, tools), placer: new Placer(c, tools), close: () => c.close().catch(() => {}) };
  } catch (e) {
    await c.close().catch(() => {});
    throw e;
  }
}

/** The connection test: sign in if needed, list what the connection offers, and read the positions once. Read-only. */
export async function connect(file: string, opts: Omit<SessionOptions, 'signIn'> = {}): Promise<Connection> {
  const session = await openSession(file, { ...opts, signIn: true });
  try {
    const { reader } = session;
    const out: Connection = { tools: reader.tools.map(toolLine) };
    const positions = reader.tools.find((x) => isPositionsRead(x.name) && !(x.inputSchema.required?.length));
    if (positions) {
      if (kindOf(positions) !== 'read') out.positions = `${positions.name} is not labelled read-only by Robinhood, so it was not called.`;
      else {
        const r = await reader.read(positions.name);
        out.positions = `${positions.name} answered: ${r.failed ? 'Robinhood reported an error' : summarise({ content: [{ type: 'text', text: r.text }] })}`;
      }
    }
    return out;
  } finally {
    await session.close();
  }
}