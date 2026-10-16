// The dashboard's local server: one page and its data, on this computer only. It reads the desk's own files and Yahoo
// Finance's public prices, keeps the person's watchlist and the analyses they ask for, and can connect to Robinhood to
// read (robinhood/link.ts); it holds no order and never hands the page a key. Everything it accepts is checked: the
// address it was reached by, where a change came from, and a token made at start-up that only the page it served knows,
// so another web page open in the same browser cannot use it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { today } from '../data/dates.js';
import { clearCache } from '../data/yahoo.js';
import { safeSymbol } from '../data/symbols.js';
import { deskDataDir, robinhoodFile } from '../paths.js';
import { Link, plainFailure, type Snapshot } from '../robinhood/link.js';
import { saveAccountHoldings } from '../desk/holdings.js';
import { VERSION } from '../version.js';
import { callOf, stateOf, versionOf } from './state.js';
import { clearQuotes, history, isRange, MARKETS, quote } from './quotes.js';
import { addWatch, dequeue, enqueue, removeWatch, setFavourite } from './store.js';

export interface Asset { type: string; body: Buffer | string }
export type Assets = Map<string, Asset>;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

/** The page's files, read once: only these exact names are ever served. */
export function loadAssets(dir: string = path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal')): Assets {
  const out: Assets = new Map();
  const add = (rel: string) => out.set(`/${rel.replace(/\\/g, '/')}`, { type: TYPES[path.extname(rel)] ?? 'application/octet-stream', body: fs.readFileSync(path.join(dir, rel)) });
  for (const f of ['index.html', 'app.js', 'app.css']) add(f);
  try { for (const f of fs.readdirSync(path.join(dir, 'fonts'))) if (f.endsWith('.woff2')) add(`fonts/${f}`); } catch { /* no fonts folder */ }
  return out;
}

/** Gives the desk's agents what the dashboard read, so their analyses size trades to the real accounts. Only a read in
 *  which every account's holdings came back whole is kept: a half-read account would tell the agents "no position" where
 *  there may be one. */
export function shareHoldings(dir: string, snap: Snapshot, day: string): boolean {
  if (!snap.views.length || snap.views.some((v) => v.problems.some((x) => /held/.test(x)) || v.unread > 0)) return false;
  saveAccountHoldings(dir, snap.views.map((v) => ({
    label: v.account.label, tradable: v.account.agentic, currency: v.portfolio?.currency,
    ...(v.portfolio?.cash == null ? {} : { cash: v.portfolio.cash }), ...(v.portfolio?.buyingPower == null ? {} : { buyingPower: v.portfolio.buyingPower }),
    positions: v.holdings.map((h) => ({ ticker: h.symbol, quantity: h.quantity, ...(h.averageCost == null ? {} : { averagePrice: h.averageCost }) })),
  })), day);
  return true;
}

export interface Terminal { url: string; port: number; token: string; deskId: string; close: () => Promise<void> }

export const deskIdOf = (root: string): string => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
export const PORTS = [47615, 47625] as const;

const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
} as const;

class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function startTerminal(opts: { root: string; assets: Assets; port?: number; robinhood?: Link }): Promise<Terminal> {
  const { root, assets } = opts, dir = deskDataDir(root), token = crypto.randomBytes(24).toString('hex'), deskId = deskIdOf(root);
  const robinhood = opts.robinhood ?? new Link(robinhoodFile());
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...SECURITY, ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reject(new Refused(415, 'send JSON'));
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 4096) reject(new Refused(413, 'too large')); else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; v && typeof v === 'object' && !Array.isArray(v) ? resolve(v as Record<string, unknown>) : reject(new Refused(400, 'send a JSON object')); } catch { reject(new Refused(400, 'that is not JSON')); } });
    req.on('error', reject);
  });

  // Robinhood's failures are told in plain words; one of the person's own choices that is refused says why.
  const askRobinhood = async <T>(job: () => Promise<T>): Promise<T> => {
    try { return await job(); } catch (e) { throw new Refused(/not one of your Robinhood accounts/.test((e as Error).message) ? 400 : 502, /not one of your Robinhood accounts/.test((e as Error).message) ? (e as Error).message : plainFailure(e)); }
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Only this computer, by its own name and port: a page that has pointed another name at this address cannot reach it.
    if (!hosts().has(String(req.headers.host ?? '').toLowerCase())) throw new Refused(421, 'wrong address');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`), method = req.method ?? 'GET', p = url.pathname;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') throw new Refused(405, 'not allowed');

    if (method === 'GET' && !p.startsWith('/api/')) {
      const a = assets.get(p === '/' ? '/index.html' : p);
      if (!a) throw new Refused(404, 'not found');
      const text = p === '/' ? String(a.body).replace('__DESK_TOKEN__', token) : a.body;
      return send(res, 200, text, a.type, { 'Cache-Control': 'no-cache' });
    }
    if (method === 'GET' && p === '/api/ping') return json(res, 200, { app: 'trading-agents', version: VERSION, desk: deskId });
    if (!p.startsWith('/api/')) throw new Refused(404, 'not found');

    // Every call to the data needs the token the page was given; a change must also come from this page's own address.
    if (!same(String(req.headers['x-desk-token'] ?? ''), token)) throw new Refused(403, 'not allowed');
    if (method !== 'GET') { const o = req.headers.origin; if (o !== undefined && !origins().has(o)) throw new Refused(403, 'not allowed'); }
    const day = today(), sym = url.searchParams.get('symbol') ?? '';

    if (method === 'GET') {
      if (p === '/api/state') return json(res, 200, stateOf(root, day));
      if (p === '/api/version') return json(res, 200, { version: versionOf(root) });
      if (p === '/api/robinhood') return json(res, 200, robinhood.info());
      if (p === '/api/robinhood/accounts') return json(res, 200, await askRobinhood(() => robinhood.accounts()));
      if (p === '/api/robinhood/snapshot') return json(res, 200, { snapshot: robinhood.snapshot(), chosen: robinhood.chosen() });
      if (p === '/api/quotes') {
        const list = [...new Set((url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 30);
        return json(res, 200, { quotes: await Promise.all(list.map(quote)) });
      }
      if (p === '/api/markets') return json(res, 200, { markets: await Promise.all(MARKETS.map(async (m) => ({ ...m, quote: await quote(m.symbol) }))) });
      if (p === '/api/history') {
        const range = url.searchParams.get('range') ?? '6M';
        if (!isRange(range)) throw new Refused(400, 'range is one of 1M, 3M, 6M, 1Y, 5Y');
        try { return json(res, 200, await history(sym, range)); } catch (e) { throw new Refused(e instanceof Error && e.name === 'NoData' ? 404 : 502, (e as Error).message); }
      }
      if (p === '/api/call') {
        const c = callOf(root, sym.toUpperCase(), url.searchParams.get('date') ?? '');
        if (!c) throw new Refused(404, 'no such call');
        return json(res, 200, c);
      }
      throw new Refused(404, 'not found');
    }

    const b = method === 'POST' ? await body(req) : {};
    const name = typeof b.symbol === 'string' ? b.symbol : sym;
    if (p === '/api/watchlist' && method === 'POST') {
      safeSymbol(name);                                       // a name that is not a ticker is refused before Yahoo is asked
      const q = await quote(name);
      if ('error' in q && q.error === 'no-data') throw new Refused(422, q.message);
      return json(res, 200, { watchlist: addWatch(dir, name, day) });
    }
    if (p === '/api/watchlist' && method === 'DELETE') return json(res, 200, { watchlist: removeWatch(dir, name) });
    if (p === '/api/favourite' && method === 'POST') return json(res, 200, { watchlist: setFavourite(dir, name, b.favourite === true) });
    if (p === '/api/queue' && method === 'POST') return json(res, 200, { queue: enqueue(dir, name, new Date().toISOString()) });
    if (p === '/api/queue' && method === 'DELETE') return json(res, 200, { queue: dequeue(dir, name) });
    // Robinhood: connect (sends the person to Robinhood's own page), check (asks, opens nothing) and disconnect (deletes the saved sign-in).
    if (p === '/api/robinhood/connect' && method === 'POST') return json(res, 200, robinhood.startSignIn());
    if (p === '/api/robinhood/check' && method === 'POST') return json(res, 200, await robinhood.check());
    if (p === '/api/robinhood' && method === 'DELETE') return json(res, 200, robinhood.forget());
    if (p === '/api/robinhood/accounts' && method === 'POST') {
      const keys = b.show;
      if (!Array.isArray(keys) || keys.length > 10 || !keys.every((k) => typeof k === 'string' && /^[0-9a-f]{16}$/.test(k))) throw new Refused(400, 'choose up to ten of your accounts');
      return json(res, 200, { chosen: await askRobinhood(() => robinhood.choose(keys as string[])) });
    }
    if (p === '/api/robinhood/refresh' && method === 'POST') {
      const snapshot = await askRobinhood(() => robinhood.refresh());
      return json(res, 200, { snapshot, chosen: robinhood.chosen(), holdingsShared: shareHoldings(dir, snapshot, day) });
    }
    throw new Refused(404, 'not found');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof Refused) {
        // An oversized body is answered, then the connection is cut so the rest is never read.
        if (e.status === 413) res.once('finish', () => req.socket.destroy());
        return json(res, e.status, { error: e.message });
      }
      // Our own checks (a bad ticker, a full list) speak plainly; anything else is not shown.
      const m = e instanceof Error ? e.message : '';
      json(res, /not a ticker|not on the watchlist|holds \d+ stocks|are already waiting/.test(m) ? 400 : 500, { error: /not a ticker|not on the watchlist|holds \d+ stocks|are already waiting/.test(m) ? m : 'something went wrong' });
    });
  });

  // The first free port in a small range, on this computer's own address only.
  const listen = (candidate: number) => new Promise<boolean>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onListen); e.code === 'EADDRINUSE' ? resolve(false) : reject(e); };
    const onListen = () => { server.off('error', onError); resolve(true); };
    server.once('error', onError); server.once('listening', onListen);
    server.listen(candidate, '127.0.0.1');
  });
  const tryPorts = opts.port !== undefined ? [opts.port] : Array.from({ length: PORTS[1] - PORTS[0] + 1 }, (_, i) => PORTS[0] + i);
  for (const candidate of tryPorts) if (await listen(candidate)) { port = (server.address() as { port: number }).port; break; }
  if (!port) throw new Error(`no free port from ${PORTS[0]} to ${PORTS[1]} on this computer`);

  // Yahoo's prices are held in memory for a short while; clear them now and then so a dashboard left open stays current.
  const sweep = setInterval(() => { clearCache(); clearQuotes(); }, 60_000);
  sweep.unref();
  return { url: `http://127.0.0.1:${port}/`, port, token, deskId, close: () => new Promise((resolve) => { clearInterval(sweep); server.close(() => resolve()); server.closeAllConnections?.(); }) };
}
