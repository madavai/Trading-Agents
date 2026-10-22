// The dashboard's local server: one page and its data, on this computer only. It reads the desk's own files and Yahoo
// Finance's public prices and search, keeps the person's watchlist, the analyses they ask for, the contact email the SEC
// asks for (sent to sec.gov alone, never shown back in full) and what the page should remember (never anything about an
// order), and can connect to Robinhood to
// read (robinhood/link.ts); it holds no order. Everything it accepts is checked: the address it was reached by, where
// a change came from, and a key made at start-up. The key is in no page it serves: the dashboard opens the person's
// browser on a one-time link, which the page swaps for the key once (/api/claim), so another program on this computer
// that reads the page gets no key, and another web page open in the same browser cannot use it. For a later opening of
// the page from this computer, the key is kept in the person's private folder, where only their own programs can read it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { today } from '../data/dates.js';
import { configure } from '../data/http.js';
import { clearCache, daily } from '../data/yahoo.js';
import { addDays } from '../data/dates.js';
import { readContactEmail, saveContactEmail } from '../contact.js';
import { followed, paperBook, readPaperStart, recordOf, RECORD_WEEKS, RECORD_WORDS, savePaperStart, type Closes, type PaperBook } from '../desk/paper.js';
import { isCrypto, safeSymbol } from '../data/symbols.js';
import { dashboardKeyFile, deskDataDir, robinhoodFile } from '../paths.js';
import { writePrivate } from '../private.js';
import { Link, plainFailure, type Snapshot } from '../robinhood/link.js';
import { saveAccountHoldings } from '../desk/holdings.js';
import { careOf, deskSymbol, stopIn, toWatch, watched, type HoldingCare } from '../desk/care.js';
import { lastBuy, logOrder, placedToday } from '../desk/orders.js';
import { Sectors } from '../desk/sectors.js';
export { placedToday };
import { check, passes, propose, proposeOwn, type Check, type Order, type Proposal, type TicketContext } from '../desk/ticket.js';
import type { Review } from '../robinhood/review.js';
import type { Placed } from '../robinhood/order.js';
import { Journal } from '../desk/journal.js';
import { capsFrom, readSettings, type Caps } from '../settings.js';
import { VERSION } from '../version.js';
import { callOf, listenerOf, marketView, queueOf, stateOf, versionOf } from './state.js';
import { clearQuotes, history, isRange, MARKETS, quote } from './quotes.js';
import { findSymbols, QUERY } from './search.js';
import { marketOf, readPrefs, saveMarket, savePrefs } from './prefs.js';
import { marketSymbol, MAX_MARKET, screenUniverse, ticketable } from './tiers.js';
import { addWatch, readWatchlist, removeWatch, setFavourite } from './store.js';
import { nextMarketDay, queueTop, readScreen, SCREEN_MS, screenToday, TOP_QUEUED, type Screen } from '../desk/screen.js';
import { weatherNow, type Weather } from '../desk/weather.js';
import { dequeue, depthOfRounds, enqueue, isDepth, QueueRefusal, readQueue, removeListener, ringDoorbell, waitingIn } from '../desk/queue.js';
import { findClaude } from '../watch/claude.js';
import { maskEmail } from './guide.js';

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
 *  there may be one. A coin is named as the desk analyses it (BTC as BTC-USD). */
export function shareHoldings(dir: string, snap: Snapshot, day: string): boolean {
  if (!snap.views.length || snap.views.some((v) => v.problems.some((x) => /held/.test(x)) || v.unread > 0)) return false;
  saveAccountHoldings(dir, snap.views.map((v) => ({
    label: v.account.label, tradable: v.account.agentic, currency: v.portfolio?.currency,
    ...(v.portfolio?.cash == null ? {} : { cash: v.portfolio.cash }), ...(v.portfolio?.buyingPower == null ? {} : { buyingPower: v.portfolio.buyingPower }),
    positions: v.holdings.map((h) => ({ ticker: deskSymbol(h.symbol, h.kind), quantity: h.quantity, ...(h.averageCost == null ? {} : { averagePrice: h.averageCost }) })),
  })), day);
  return true;
}

const REVIEW_MS = 5 * 60_000;
/** The exact words the person confirms: what is bought or sold, how many, at what limit. */
export const confirmWords = (o: Order): string => `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.quantity} ${o.symbol} at $${o.limitPrice.toFixed(2)}`;

export interface Terminal {
  url: string; port: number; token: string; deskId: string;
  /** A one-time link to open the page with: `url#open=<claim>`. The page swaps the claim for the key, once, within two minutes. */
  claim: () => string;
  close: () => Promise<void>;
}

import { deskIdOf, PORTS } from './launch.js';
export { deskIdOf, PORTS };

const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
} as const;

class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Robinhood's agent doorway trades stocks and funds only: an index cannot be bought, and crypto is followed on paper.
 *  Asked when a ticket opens and again before Robinhood checks or places it, before anything reaches Robinhood. */
function tradable(symbol: string): void {
  if (isCrypto(symbol)) throw new Refused(400, `Robinhood's agent doorway trades stocks and funds only: ${symbol} is crypto, which the desk follows on paper`);
  if (/[\^=]/.test(symbol)) throw new Refused(400, 'the order ticket trades stocks and funds only, not indices, futures or currencies');
}

/** A short fingerprint of the dashboard's own code on disk. When an update changes it, the running dashboard is old. */
export function fingerprint(files: readonly string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) { try { h.update(fs.readFileSync(f)); } catch { h.update(`missing ${f}`); } }
  return h.digest('hex').slice(0, 12);
}

export interface TerminalOptions {
  root: string; assets: Assets; port?: number; robinhood?: Link;
  /** The files of the dashboard's own code; when they change on disk, the page offers Restart, which calls `restart`. */
  code?: string[]; restart?: () => void;
  /** Stops the dashboard when the person presses Stop on the page. */
  stop?: () => void;
  /** How often to look at the code on disk (every 15 seconds). */
  updateCheckMs?: number;
  /** The key of the dashboard this one restarts from (an update, on the person's press), so the page it was serving keeps
   *  working; otherwise a fresh key is made. */
  key?: string;
  /** Where the key is kept for a later opening of the page: the person's private folder unless the tests say otherwise. */
  keyFile?: string;
  /** How long a one-time link stays good (two minutes). */
  claimMs?: number;
  /** Starts the desk's own listener (`node dist/watch.mjs`) for "Run automatically with Claude Code"; `claude` says
   *  whether Claude Code is on this computer. Without it the page offers no such switch. */
  listen?: { start: () => void; claude?: () => boolean };
  /** Where a stock's sector is looked up (Yahoo Finance's profiles, unless the tests say otherwise). */
  sectors?: Sectors;
}

/** The listener the switch starts calls itself this, in its note. */
const OWN_LISTENER = 'Claude Code';

const KEY = /^[0-9a-f]{48}$/, CLAIM = /^[0-9a-f]{36}$/;

export async function startTerminal(opts: TerminalOptions): Promise<Terminal> {
  const { root, assets } = opts, dir = deskDataDir(root), deskId = deskIdOf(root);
  // The SEC asks everyone who reads its filings (a stock's sector comes from them) for a contact email: the person's own,
  // looked up at each request, so one saved on this page or in a chat goes at once, and to sec.gov alone.
  configure({ contact: readSettings(root).sources.contact, secEmail: () => readContactEmail(root) });
  const token = opts.key && KEY.test(opts.key) ? opts.key : crypto.randomBytes(24).toString('hex');
  const code = opts.code ?? [], build = fingerprint(code);
  let updated = false, restarting = false;
  const robinhood = opts.robinhood ?? new Link(robinhoodFile());
  // One-time links: each is good once, for two minutes, and gives the page the key and nothing else.
  const claims = new Map<string, number>(), claimMs = opts.claimMs ?? 2 * 60_000;
  const claim = (): string => {
    for (const [c, until] of claims) if (until < Date.now()) claims.delete(c);
    const c = crypto.randomBytes(18).toString('hex');
    claims.set(c, Date.now() + claimMs);
    return c;
  };
  // Tickets the person has open: what a call proposed on the real figures (or, for the person's own order, one share of
  // the stock they chose), and Robinhood's check once they press Review. Kept in memory for a quarter of an hour; the page
  // names a ticket by its id and can change only its quantity and price.
  interface Ticket { id: string; at: number; own: boolean; context: TicketContext; proposal: Proposal; order: Order | null; checks: Check[]; review: Review | null; reviewedAt: number; refId: string; placing: boolean; placed: Placed | null }
  const tickets = new Map<string, Ticket>();
  const TICKET_MS = 15 * 60_000;
  const ticketOf = (id: unknown): Ticket => {
    for (const [k, t] of tickets) if (Date.now() - t.at > TICKET_MS) tickets.delete(k);
    const t = typeof id === 'string' ? tickets.get(id) : undefined;
    if (!t) throw new Refused(404, 'that ticket has expired: open it again');
    return t;
  };
  const opened = (own: boolean, context: TicketContext, proposal: Proposal, trading: ReturnType<typeof readSettings>['trading'], caps: Caps): Ticket => {
    const t: Ticket = { id: crypto.randomBytes(12).toString('hex'), at: Date.now(), own, context, proposal, order: proposal.order, checks: proposal.order ? check(proposal.order, context, trading, caps) : [], review: null, reviewedAt: 0, refId: crypto.randomUUID(), placing: false, placed: null };
    tickets.set(t.id, t);
    return t;
  };
  const edited = (t: Ticket, b: Record<string, unknown>): Order => {
    if (!t.proposal.order) throw new Refused(400, 'this ticket proposes no order');
    const quantity = typeof b.quantity === 'number' ? b.quantity : NaN, limitPrice = typeof b.limitPrice === 'number' ? b.limitPrice : NaN;
    return { ...t.proposal.order, quantity, limitPrice };   // the person can change how many and the price; never the stock, the side or the account
  };
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

  // The paper book: worked out from the live journal and daily closes, at the person's caps (beside the trading switch),
  // and kept for ten minutes, or until the journal, the starting money or the caps change.
  const callsOf = () => new Journal(path.join(dir, 'journal.md')).load().map((e) => ({ ticker: e.ticker, date: e.date, rating: e.rating }));
  let paperMemo: { key: string; at: number; book: PaperBook } | null = null;
  const paper = async (today: string): Promise<PaperBook & { record: ReturnType<typeof recordOf> }> => {
    const calls = callsOf(), caps = robinhood.trading().caps, startUsd = readPaperStart(dir), trading = readSettings(root).trading;
    let stamp = '0';
    try { stamp = String(fs.statSync(path.join(dir, 'journal.md')).mtimeMs); } catch { /* no journal yet */ }
    const key = `${stamp}|${startUsd}|${JSON.stringify(caps)}|${today}`;
    if (!paperMemo || paperMemo.key !== key || Date.now() - paperMemo.at > 10 * 60_000) {
      const record = recordOf(calls, today), closes: Closes = {};
      if (record.since) {
        const from = addDays(record.since, -7);
        await Promise.all([...new Set([...calls.filter((c) => followed(c.ticker)).map((c) => c.ticker), 'SPY'])].map(async (s) => {
          try { closes[s] = (await daily(s, from, today)).bars.map((r) => ({ date: r.date, close: r.close })); } catch { /* left out: said as unavailable */ }
        }));
      }
      await sectors.warm(calls.filter((c) => followed(c.ticker)).map((c) => c.ticker));
      paperMemo = { key, at: Date.now(), book: paperBook(calls, closes, { startUsd, trading, caps, today, sectors }) };
    }
    return { ...paperMemo.book, record: recordOf(calls, today) };
  };

  // The guard rails' facts for a ticket: the stock's sector and what the account already holds in it (from each holding's
  // own profile, looked up once and remembered), and when the stock was last bought here, for the shortest hold.
  const sectors = opts.sectors ?? new Sectors();
  const limitedNow = (c: TicketContext): TicketContext => {
    const positions = c.positions ?? [], bought = lastBuy(dir, c.symbol, new Date());
    return { ...c, sector: sectors.context(c.symbol, positions), ...(bought ? bought : {}) };
  };
  const limited = async (c: TicketContext): Promise<TicketContext> => { await sectors.warm([c.symbol, ...(c.positions ?? []).map((p) => p.symbol)]); return limitedNow(c); };

  // "Worth a look today" and "Market weather": each worked out at most once an hour, once however many pages ask. With
  // the person's morning switch on, the top three of the screen go on the waiting list once a market day, and the
  // doorbell rings for whoever listens.
  let screening: Promise<Screen> | null = null;
  const screenNow = async (day: string) => {
    const { symbols, news } = screenUniverse(readWatchlist(dir), marketOf(dir));
    screening ??= screenToday(dir, symbols, news, day).finally(() => { screening = null; });
    const worked = await screening, prefs = readPrefs(dir), on = prefs.morning === true;
    const queued = on ? queueTop(dir, worked, day, true, new Date(), prefs.morningFrom) : [];
    return { screen: readScreen(dir) ?? worked, morning: { on, top: TOP_QUEUED, from: on ? prefs.morningFrom : undefined }, queued };
  };
  let weatherMemo: { at: number; day: string; value: Promise<Weather> } | null = null;
  const weather = (day: string): Promise<Weather> => {
    if (!weatherMemo || weatherMemo.day !== day || Date.now() - weatherMemo.at > SCREEN_MS) weatherMemo = { at: Date.now(), day, value: weatherNow(day) };
    return weatherMemo.value;
  };

  // Care for what the person holds: the accounts as last read from Robinhood, each holding with the desk's latest view of
  // it; in the Agentic account alone, the trader's stop watched against Yahoo Finance's price and a Sell or Underweight
  // marked. Nothing is ever sold from here: a mark opens a ticket only on the person's press.
  const care = async (day: string): Promise<{ at: string | null; holdings: HoldingCare[] }> => {
    const snap = robinhood.snapshot(), now = new Date();
    if (!snap) return { at: null, holdings: [] };
    const held = careOf({ views: snap.views, calls: callsOf(), queue: readQueue(dir, now), today: day, trading: readSettings(root).trading, caps: robinhood.trading().caps,
      stop: (ticker, date) => stopIn(dir, ticker, date), bought: (symbol) => lastBuy(dir, symbol, now), ticketable });
    const prices = new Map<string, { value: number; asOf: string }>();
    for (const q of await Promise.all(toWatch(held).map(quote))) if (!('error' in q)) prices.set(q.symbol, { value: q.price, asOf: q.asOf });
    return { at: snap.at, holdings: watched(held, prices) };
  };

  /** A change to the waiting list; what the list refuses (full, or a stock being analysed now) is said in its own words. */
  const queued = <T>(job: () => T): T => { try { return job(); } catch (e) { if (e instanceof QueueRefusal) throw new Refused(409, e.message); throw e; } };

  // Robinhood's failures are told in plain words; one of the person's own choices that is refused says why.
  const askRobinhood = async <T>(job: () => Promise<T>): Promise<T> => {
    try { return await job(); } catch (e) {
      const m = e instanceof Error ? e.message : '', own = /not one of your Robinhood accounts|show your Agentic account|not the Agentic account|not complete, so it was not sent|no longer passes on Robinhood's latest figures|trading is switched off|trading switched itself off/.test(m);
      throw new Refused(own ? 400 : 502, own ? m : plainFailure(e));
    }
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Only this computer, by its own name and port: a page that has pointed another name at this address cannot reach it.
    if (!hosts().has(String(req.headers.host ?? '').toLowerCase())) throw new Refused(421, 'wrong address');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`), method = req.method ?? 'GET', p = url.pathname;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') throw new Refused(405, 'not allowed');

    if (method === 'GET' && !p.startsWith('/api/')) {
      const a = assets.get(p === '/' ? '/index.html' : p);
      if (!a) throw new Refused(404, 'not found');
      return send(res, 200, a.body, a.type, { 'Cache-Control': 'no-cache' });   // the key is in no page: see /api/claim
    }
    if (method === 'GET' && p === '/api/ping') return json(res, 200, { app: 'trading-agents', version: VERSION, desk: deskId, build });
    if (!p.startsWith('/api/')) throw new Refused(404, 'not found');
    if (method !== 'GET') { const o = req.headers.origin; if (o !== undefined && !origins().has(o)) throw new Refused(403, 'not allowed'); }   // a change must come from this page's own address

    // The one-time link the dashboard opened the browser with: the page swaps it for the key, once, within two minutes.
    if (method === 'POST' && p === '/api/claim') {
      const b = await body(req), c = typeof b.claim === 'string' && CLAIM.test(b.claim) ? b.claim : '';
      const until = claims.get(c);
      claims.delete(c);
      if (!until || until < Date.now()) throw new Refused(403, 'this link has been used or has expired: open the dashboard again');
      return json(res, 200, { key: token });
    }
    // Every other call to the data needs the key.
    if (!same(String(req.headers['x-desk-token'] ?? ''), token)) throw new Refused(401, 'this page has no key to the dashboard: open the dashboard again');
    const day = today(), sym = url.searchParams.get('symbol') ?? '';

    if (method === 'GET') {
      if (p === '/api/state') return json(res, 200, stateOf(root, day));
      if (p === '/api/version') return json(res, 200, { version: versionOf(root), build, update: updated, restarting });
      if (p === '/api/prefs') return json(res, 200, readPrefs(dir));
      if (p === '/api/paper') return json(res, 200, await paper(day));
      if (p === '/api/screen') return json(res, 200, await screenNow(day));
      if (p === '/api/weather') return json(res, 200, { weather: await weather(day) });
      if (p === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').trim();
        if (!QUERY.test(q)) throw new Refused(400, 'type a name or a ticker, in at most 40 letters');
        try { return json(res, 200, { matches: await findSymbols(q) }); } catch { throw new Refused(502, "Yahoo Finance's search did not answer: type the ticker instead"); }
      }
      if (p === '/api/robinhood') return json(res, 200, robinhood.info());
      if (p === '/api/trading') return json(res, 200, { ...robinhood.trading(), placedToday: placedToday(dir, new Date()) });
      if (p === '/api/robinhood/accounts') return json(res, 200, await askRobinhood(() => robinhood.accounts()));
      if (p === '/api/robinhood/snapshot') return json(res, 200, { snapshot: robinhood.snapshot(), chosen: robinhood.chosen() });
      if (p === '/api/care') return json(res, 200, await care(day));
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
        if (!readPrefs(dir).readCall) savePrefs(dir, { readCall: day });   // the first call read in full: "Get started", step four
        return json(res, 200, c);
      }
      throw new Refused(404, 'not found');
    }

    const b = method === 'POST' ? await body(req) : {};
    const name = typeof b.symbol === 'string' ? b.symbol : sym;
    // A fresh one-time link, for a program of the person's own that opens the page again (terminal/main.ts, with the key from the private folder).
    if (p === '/api/claim/new' && method === 'POST') return json(res, 200, { claim: claim() });
    if (p === '/api/watchlist' && method === 'POST') {
      safeSymbol(name);                                       // a name that is not a ticker is refused before Yahoo is asked
      const q = await quote(name);
      if ('error' in q && q.error === 'no-data') throw new Refused(422, q.message);
      return json(res, 200, { watchlist: addWatch(dir, name, day) });
    }
    if (p === '/api/watchlist' && method === 'DELETE') return json(res, 200, { watchlist: removeWatch(dir, name) });
    if (p === '/api/favourite' && method === 'POST') return json(res, 200, { watchlist: setFavourite(dir, name, b.favourite === true) });
    // The waiting list. Asking (Analyse, Retry) and Run now ring the doorbell for whoever listens; taking a stock off does not.
    if (p === '/api/queue' && method === 'POST') {
      const symbol = safeSymbol(name), d = b.depth === undefined ? depthOfRounds(readSettings(root).analysis.debateRounds) : b.depth;
      if (!isDepth(d)) throw new Refused(400, 'the depth is shallow, medium or deep');
      const call = new Journal(path.join(dir, 'journal.md')).load().find((e) => e.ticker === symbol && e.date === day);
      if (call) throw new Refused(409, `${symbol} was already analysed today (${call.rating}): its call is in the journal. Ask again tomorrow`);
      queued(() => enqueue(dir, symbol, new Date().toISOString(), d));
      ringDoorbell(dir, 'press');
      return json(res, 200, { queue: queueOf(dir) });
    }
    if (p === '/api/queue' && method === 'DELETE') { queued(() => dequeue(dir, name)); return json(res, 200, { queue: queueOf(dir) }); }
    if (p === '/api/queue/run' && method === 'POST') {
      if (!waitingIn(readQueue(dir)).length) throw new Refused(409, 'nothing is waiting to be analysed');
      ringDoorbell(dir, 'press');
      return json(res, 200, { queue: queueOf(dir) });
    }
    // "Run automatically with Claude Code": the desk's own listener, started and stopped from here, remembered across starts.
    if (p === '/api/listen' && method === 'POST') {
      if (!opts.listen) throw new Refused(404, 'not found');
      const now = listenerOf(dir);
      if (b.on === false) {
        if (now && now.listener !== OWN_LISTENER) throw new Refused(409, `${now.listener} is listening, not Claude Code: switch it off there`);
        savePrefs(dir, { autorun: false });
        if (now) removeListener(dir);   // the listener ends after the run in hand
        return json(res, 200, { listener: null });
      }
      if (b.on !== true) throw new Refused(400, 'say on or off');
      if (now) { if (now.listener === OWN_LISTENER) return json(res, 200, { listener: now }); throw new Refused(409, `${now.listener} is already listening: analyses already run by themselves`); }
      if (!(opts.listen.claude ?? (() => !!findClaude()))()) throw new Refused(400, 'Claude Code is not installed on this computer: install it from claude.com/claude-code, or switch on "Run automatically" in Madav');
      savePrefs(dir, { autorun: true });
      opts.listen.start();
      for (const until = Date.now() + 8_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) { const l = listenerOf(dir); if (l) return json(res, 200, { listener: l }); }
      throw new Refused(502, 'the listener did not start: see desk-data/watcher.log, or start it yourself with node dist/watch.mjs');
    }
    if (p === '/api/prefs' && method === 'POST') { delete b.autorun; delete b.market; delete b.morning; delete b.morningFrom; delete b.readCall; return json(res, 200, savePrefs(dir, b)); }   // only their own switches set autorun and morning, only Change… the whole market, only a call served readCall
    // The contact email the SEC asks for, from the field in "Get started": checked, kept in the desk's records like the
    // desk tool set_contact_email keeps it, sent to sec.gov alone, and never shown back in full.
    if (p === '/api/contact' && method === 'POST') {
      let email: string;
      try { email = saveContactEmail(root, typeof b.email === 'string' ? b.email : ''); } catch (e) { throw new Refused(400, (e as Error).message); }
      return json(res, 200, { saved: maskEmail(email) });
    }
    // "Analyse the top three each market morning": the person's switch, off as shipped. Switching it on puts nothing on the
    // waiting list at once: it starts the next market morning, and then acts once each market morning.
    if (p === '/api/screen/morning' && method === 'POST') {
      if (typeof b.on !== 'boolean') throw new Refused(400, 'say on or off');
      const from = b.on ? nextMarketDay(day) : undefined;
      savePrefs(dir, b.on ? { morning: true, morningFrom: from } : { morning: false }, b.on ? [] : ['morningFrom']);
      return json(res, 200, { morning: { on: b.on, top: TOP_QUEUED, from }, queued: [] });
    }
    // The whole-market funds on "Start here": the person's own list, each a fund or a stock Yahoo has a price for, checked
    // before it is kept. The shipped four put back are kept as no list, so a later version's four reach the person.
    if (p === '/api/tiers/market' && method === 'POST') {
      if (!Array.isArray(b.symbols) || b.symbols.length > MAX_MARKET) throw new Refused(400, `choose up to ${MAX_MARKET} funds for the whole market`);
      const list: string[] = [];
      for (const v of b.symbols as unknown[]) {
        let s: string;
        try { s = marketSymbol(v); } catch (e) { throw new Refused(400, (e as Error).message); }
        if (!list.includes(s)) list.push(s);
      }
      for (const q of await Promise.all(list.map(quote))) if ('error' in q && q.error === 'no-data') throw new Refused(422, q.message);
      saveMarket(dir, list);
      return json(res, 200, { market: marketView(dir) });
    }
    if (p === '/api/paper' && method === 'POST') {
      try { savePaperStart(dir, b.startUsd); } catch (e) { throw new Refused(400, (e as Error).message); }
      paperMemo = null;
      return json(res, 200, await paper(day));
    }
    if (p === '/api/stop' && method === 'POST') {
      if (!opts.stop) throw new Refused(404, 'not found');
      const stop = opts.stop;
      res.once('finish', () => { setTimeout(stop, 100); });
      return json(res, 200, { stopping: true });
    }
    // Restart into an update: only on the person's press, only when new code is on disk, never while an order is being sent.
    if (p === '/api/restart' && method === 'POST') {
      if (!opts.restart) throw new Refused(404, 'not found');
      if (!updated) throw new Refused(409, 'there is no update to restart into');
      if ([...tickets.values()].some((t) => t.placing)) throw new Refused(409, 'an order is being sent: restart when it is done');
      restarting = true;
      const restart = opts.restart;
      res.once('finish', () => { setTimeout(restart, 100); });
      return json(res, 200, { restarting: true });
    }
    if (restarting && p.startsWith('/api/ticket')) throw new Refused(503, 'the dashboard is restarting with an update: open the ticket again in a moment');
    // Robinhood: connect (sends the person to Robinhood's own page), check (asks, opens nothing) and disconnect (deletes the saved sign-in).
    if (p === '/api/robinhood/connect' && method === 'POST') return json(res, 200, robinhood.startSignIn());
    if (p === '/api/robinhood/check' && method === 'POST') return json(res, 200, await robinhood.check());
    if (p === '/api/robinhood' && method === 'DELETE') return json(res, 200, robinhood.forget());
    if (p === '/api/robinhood/accounts' && method === 'POST') {
      const keys = b.show;
      if (!Array.isArray(keys) || keys.length > 10 || !keys.every((k) => typeof k === 'string' && /^[0-9a-f]{16}$/.test(k))) throw new Refused(400, 'choose up to ten of your accounts');
      return json(res, 200, { chosen: await askRobinhood(() => robinhood.choose(keys as string[])) });
    }
    if (p === '/api/ticket' && method === 'POST') {
      const symbol = safeSymbol(typeof b.symbol === 'string' ? b.symbol : ''), date = typeof b.date === 'string' ? b.date : '';
      const call = new Journal(path.join(dir, 'journal.md')).load().find((e) => e.ticker === symbol && e.date === date);
      if (!call) throw new Refused(404, 'no such call');
      tradable(symbol);
      const trading = readSettings(root).trading, { caps } = robinhood.trading();
      const context: TicketContext = await limited({ ...(await askRobinhood(() => robinhood.ticketContext(symbol))), rating: call.rating, callDate: call.date });
      const t = opened(false, context, propose(context, trading, caps), trading, caps);
      return json(res, 200, { id: t.id, own: false, context, proposal: t.proposal, checks: t.checks, caps });
    }
    // The person's own order: a stock they chose and a side, not one of the desk's calls. It starts at one share and then
    // takes exactly the road a call's ticket takes: the same checks, Robinhood's dry run, the switch and their Confirm.
    if (p === '/api/ticket/own' && method === 'POST') {
      let symbol: string;
      try { symbol = safeSymbol(typeof b.symbol === 'string' ? b.symbol : ''); } catch (e) { throw new Refused(400, (e as Error).message); }
      tradable(symbol);
      const side = b.side === 'buy' || b.side === 'sell' ? b.side : null;
      if (!side) throw new Refused(400, 'say whether to buy or to sell');
      const trading = readSettings(root).trading, { caps } = robinhood.trading();
      const context: TicketContext = await limited({ ...(await askRobinhood(() => robinhood.ticketContext(symbol))), rating: '', callDate: '' });
      const t = opened(true, context, proposeOwn(context, side, trading), trading, caps);
      return json(res, 200, { id: t.id, own: true, context, proposal: t.proposal, checks: t.checks, caps });
    }
    if (p === '/api/ticket/check' && method === 'POST') {
      const t = ticketOf(b.id);
      if (t.placed || t.placing) throw new Refused(409, 'this ticket has already sent its order');
      const o = edited(t, b);
      t.order = o; t.review = null; t.checks = check(o, t.context, readSettings(root).trading, robinhood.trading().caps);
      return json(res, 200, { checks: t.checks });
    }
    if (p === '/api/ticket/review' && method === 'POST') {
      const t = ticketOf(b.id);
      if (t.placed || t.placing) throw new Refused(409, 'this ticket has already sent its order');
      const o = edited(t, b), checks = check(o, t.context, readSettings(root).trading, robinhood.trading().caps);
      tradable(o.symbol);
      t.order = o; t.checks = checks; t.review = null; t.reviewedAt = 0;
      if (!passes(checks)) throw new Refused(400, 'the order does not pass every check, so it was not sent to Robinhood');
      if (checks.some((c) => c.ask) && b.early !== true) throw new Refused(400, `${o.symbol} was bought here under your shortest hold: press "Sell anyway" to go on`);
      t.review = await askRobinhood(() => robinhood.review(o));
      t.reviewedAt = Date.now();
      return json(res, 200, { checks, review: t.review, confirm: confirmWords(o), trading: robinhood.trading() });
    }
    // Placing: only a ticket Robinhood checked with no alerts in the last five minutes, unchanged since, with trading
    // switched on, and the person's Confirm naming exactly this order; every cap is checked again on Robinhood's latest
    // figures just before it is sent, and a ticket sends at most one order.
    if (p === '/api/ticket/place' && method === 'POST') {
      const t = ticketOf(b.id), tr = robinhood.trading();   // the switch and the caps, read together from the person's private folder just now
      if (!tr.on) throw new Refused(403, 'trading is switched off: switch it on in Your account first');
      if (t.placed || t.placing) throw new Refused(409, 'this ticket has already sent its order');
      if (!t.order || !t.review || !t.reviewedAt) throw new Refused(400, 'have Robinhood check this order first');
      if (Date.now() - t.reviewedAt > REVIEW_MS) throw new Refused(400, "Robinhood's check is more than five minutes old: review the order again");
      if (!t.review.answered || t.review.alerts.length) throw new Refused(400, 'Robinhood raised alerts on this order, so it cannot be placed');
      if (b.confirm !== confirmWords(t.order)) throw new Refused(400, 'the confirmation does not name this order: nothing was sent');
      if (t.checks.some((c) => c.ask) && b.early !== true) throw new Refused(400, `${t.order.symbol} was bought here under your shortest hold: press "Sell anyway" to go on`);
      const order = t.order, trading = readSettings(root).trading, sentToday = placedToday(dir, new Date());
      tradable(order.symbol);
      t.placing = true;
      try {
        const { placed } = await askRobinhood(() => robinhood.placeChecked(order, t.refId, (fresh) => check(order, limitedNow({ ...fresh, rating: t.context.rating, callDate: t.context.callDate, ordersToday: Math.max(fresh.ordersToday, sentToday) }), trading, tr.caps)));
        t.placed = placed;
        logOrder(dir, { at: new Date().toISOString(), symbol: order.symbol, side: order.side, quantity: order.quantity, limitPrice: order.limitPrice, timeInForce: order.timeInForce, ...(t.own ? { own: true as const } : { call: { date: t.context.callDate, rating: t.context.rating } }), ticket: t.id, robinhood: { answered: placed.answered, approvalRequired: placed.approvalRequired, orderId: placed.orderId, state: placed.state, error: placed.error } });
        return json(res, 200, { placed });
      } finally { t.placing = false; }
    }
    // The trading switch and the person's caps: kept together beside the sign-in, changed only from this page.
    if (p === '/api/trading' && method === 'POST') {
      if (b.caps !== undefined) {
        const caps = capsFrom(b.caps);
        if (!caps) throw new Refused(400, 'caps are $1 to $100,000 an order, 1% to 100% of the account in one stock, and 1 to 50 orders a day');
        return json(res, 200, robinhood.setCaps(caps));
      }
      if (b.on === false) return json(res, 200, robinhood.setTrading(false));
      if (b.on !== true || b.confirm !== 'switch trading on') throw new Refused(400, 'to switch trading on, confirm it on the page');
      // Under four weeks of record, the person sees the record first and says they understand: never a block.
      const record = recordOf(callsOf(), day);
      if (record.weeks < RECORD_WEEKS && b.understood !== true) throw new Refused(400, `the desk has ${record.weeks} ${record.weeks === 1 ? 'week' : 'weeks'} and ${record.calls} ${record.calls === 1 ? 'call' : 'calls'} of record, under ${RECORD_WORDS}: confirm on the page that you understand`);
      return json(res, 200, robinhood.setTrading(true));
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

  // The key, kept in the person's private folder while this dashboard runs (one entry per desk), so that opening the
  // dashboard again from this computer can open a page that works. Best effort: without it the page says it has no key.
  const keyFile = opts.keyFile ?? dashboardKeyFile();
  const keep = (change: (keys: Record<string, unknown>) => void): void => {
    try {
      let keys: Record<string, unknown> = {};
      try { const v = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) keys = v as Record<string, unknown>; } catch { /* none yet */ }
      change(keys);
      if (Object.keys(keys).length) writePrivate(keyFile, JSON.stringify(keys, null, 2) + '\n');
      else fs.rmSync(keyFile, { force: true });
    } catch { /* a folder that cannot be written: the page opened later says it has no key */ }
  };
  keep((keys) => { keys[deskId] = { port, key: token }; });

  // "Run automatically with Claude Code" was left on: start the listener again, unless someone already listens.
  if (opts.listen && readPrefs(dir).autorun && !listenerOf(dir) && (opts.listen.claude ?? (() => !!findClaude()))()) {
    try { opts.listen.start(); } catch { /* the page then says nothing is listening */ }
  }

  // Yahoo's prices are held in memory for a short while; clear them now and then so a dashboard left open stays current.
  const sweep = setInterval(() => { clearCache(); clearQuotes(); }, 60_000);
  sweep.unref();

  // When an update puts new code on disk, the page offers Restart; the dashboard never restarts into new code by itself,
  // so code changed on this computer runs only after the person's own press. After it, the page reloads once the new one
  // answers, on the same address, so it opens where the person left it.
  let pending = '';
  const updates = opts.restart && code.length ? setInterval(() => {
    if (updated) return;
    const now = fingerprint(code);
    if (now === build) { pending = ''; return; }
    if (now !== pending) { pending = now; return; }   // changed: wait one more look, so an update still being written settles
    updated = true;
  }, opts.updateCheckMs ?? 15_000) : null;
  updates?.unref();
  return {
    url: `http://127.0.0.1:${port}/`, port, token, deskId, claim,
    close: () => new Promise((resolve) => { keep((keys) => { delete keys[deskId]; }); clearInterval(sweep); if (updates) clearInterval(updates); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
