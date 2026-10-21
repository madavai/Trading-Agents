// The page's only way to the desk's server: its key, on every call. The key is in no page the dashboard serves: the
// dashboard opens the browser on a one-time link (#open=…), which the page swaps for the key once (claimKey) and keeps
// in this browser's own storage for this address alone. A page opened by hand, or one left from a dashboard that was
// since stopped and started afresh, has no key, and says so rather than guessing.
import type { DeskState, MarketView } from '../state.js';
import type { Tier, TierItem, TierView } from '../tiers.js';
import type { Pick as Worth, Screen } from '../../desk/screen.js';
import type { Weather, WeatherLine } from '../../desk/weather.js';
/** One stock worth a look today (desk/screen.ts Pick; renamed so it does not hide TypeScript's own Pick). */
export type { MarketView, Tier, TierItem, TierView, Worth, Screen, Weather, WeatherLine };
/** The morning switch as the page shows it: on or off, and how many it puts on the waiting list. */
export interface Morning { on: boolean; top: number }
import type { History, QuoteResult } from '../quotes.js';
import type { WatchItem } from '../store.js';
import type { ListenerView, QueueView } from '../state.js';
import type { Depth } from '../../desk/queue.js';
import type { PaperBook, PaperRecord, PaperTrade } from '../../desk/paper.js';
/** The paper book, with the record it stands on. */
export type PaperView = PaperBook & { record: PaperRecord };
export type { PaperTrade };
import type { LinkInfo, Snapshot, TradingState } from '../../robinhood/link.js';
import type { Account, AccountView, Holding, Order } from '../../robinhood/account.js';
import type { Check, Proposal, TicketContext } from '../../desk/ticket.js';
import type { Review } from '../../robinhood/review.js';
import type { Placed } from '../../robinhood/order.js';
import type { Match } from '../search.js';
import type { Prefs, Recent } from '../prefs.js';
import type { Caps } from '../../settings.js';
import type { HoldingCare } from '../../desk/care.js';
export type { Match, Prefs, Recent, Caps, HoldingCare };
export type Trading = TradingState;
export type { Placed };
/** An open ticket; own: the person's own order for a stock they chose, not one of the desk's calls. */
export interface TicketOpen { id: string; own: boolean; context: TicketContext; proposal: Proposal; checks: Check[]; caps: Caps }

export type { Check, Proposal, Review, TicketContext };
export type { DeskState, History, QuoteResult, WatchItem, QueueView, ListenerView, Depth, LinkInfo, Snapshot, Account, AccountView, Holding, Order };
export interface Market { symbol: string; name: string; unit?: '%'; quote: QuoteResult }
export interface CallDetail { decision: string; sections: Record<string, string[]>; hasReport: boolean }

const KEPT = 'ta.key';
let key = '';
try { key = localStorage.getItem(KEPT) ?? ''; } catch { /* then the key lives for this visit only */ }

export const hasKey = (): boolean => key !== '';

/** The one-time link the dashboard opened this page with, swapped for the key: once, and dropped from the address. */
export async function claimKey(): Promise<void> {
  const m = /^#open=([0-9a-f]{36})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const res = await fetch('/api/claim', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: m[1] }) });
    const got = (await res.json().catch(() => ({}))) as { key?: unknown };
    if (!res.ok || typeof got.key !== 'string' || !got.key) return;
    key = got.key;
    try { localStorage.setItem(KEPT, key); } catch { /* kept for this visit only */ }
  } catch { /* the page then says it has no key */ }
}

/** Said once when the desk refuses the key this page holds: it belongs to a dashboard that no longer runs. */
export const KEY_LOST = 'desk-key-lost';

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, cache: 'no-store',
    headers: { 'x-desk-token': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    key = '';
    try { localStorage.removeItem(KEPT); } catch { /* nothing kept */ }
    document.dispatchEvent(new Event(KEY_LOST));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `the desk answered ${res.status}`);
  return data as T;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  state: () => call<DeskState>('GET', '/api/state'),
  version: () => call<{ version: string; build: string; update: boolean; restarting: boolean }>('GET', '/api/version'),
  restart: () => call<{ restarting: boolean }>('POST', '/api/restart', {}),
  /** Asked without the key: whether a dashboard answers here, and which build of it (after a restart, a new one). */
  ping: async (): Promise<{ build?: string }> => (await fetch('/api/ping', { cache: 'no-store' })).json() as Promise<{ build?: string }>,
  search: (query: string) => call<{ matches: Match[] }>('GET', `/api/search?${q({ q: query })}`),
  prefs: () => call<Prefs>('GET', '/api/prefs'),
  savePrefs: (p: Prefs) => call<Prefs>('POST', '/api/prefs', p),
  /** "Worth a look today", worked out at most once an hour; `queued` is what the morning switch just put on the waiting list. */
  screen: () => call<{ screen: Screen; morning: Morning; queued: string[] }>('GET', '/api/screen'),
  /** "Market weather": the trend, the mood and the rates, worked out at most once an hour. */
  weather: () => call<{ weather: Weather }>('GET', '/api/weather'),
  /** "Analyse the top three each market morning", on or off. */
  setMorning: (on: boolean) => call<{ morning: Morning; queued: string[] }>('POST', '/api/screen/morning', { on }),
  /** The whole-market funds on "Start here"; the desk checks each has a price before it keeps the list. */
  setMarket: (symbols: string[]) => call<{ market: MarketView }>('POST', '/api/tiers/market', { symbols }),
  stop: () => call<{ stopping: boolean }>('POST', '/api/stop', {}),
  quotes: (symbols: string[]) => call<{ quotes: QuoteResult[] }>('GET', `/api/quotes?${q({ symbols: symbols.join(',') })}`),
  markets: () => call<{ markets: Market[] }>('GET', '/api/markets'),
  history: (symbol: string, range: string) => call<History>('GET', `/api/history?${q({ symbol, range })}`),
  call: (symbol: string, date: string) => call<CallDetail>('GET', `/api/call?${q({ symbol, date })}`),
  addWatch: (symbol: string) => call<{ watchlist: WatchItem[] }>('POST', '/api/watchlist', { symbol }),
  removeWatch: (symbol: string) => call<{ watchlist: WatchItem[] }>('DELETE', `/api/watchlist?${q({ symbol })}`),
  favourite: (symbol: string, favourite: boolean) => call<{ watchlist: WatchItem[] }>('POST', '/api/favourite', { symbol, favourite }),
  /** Asks the desk to analyse a stock at a depth (Analyse, Retry); rings for whoever listens. */
  enqueue: (symbol: string, depth: Depth) => call<{ queue: QueueView[] }>('POST', '/api/queue', { symbol, depth }),
  dequeue: (symbol: string) => call<{ queue: QueueView[] }>('DELETE', `/api/queue?${q({ symbol })}`),
  /** Rings again for what is waiting (Run now). */
  runQueue: () => call<{ queue: QueueView[] }>('POST', '/api/queue/run', {}),
  /** "Run automatically with Claude Code": the desk's own listener, on or off. */
  listen: (on: boolean) => call<{ listener: ListenerView | null }>('POST', '/api/listen', { on }),
  robinhood: () => call<LinkInfo>('GET', '/api/robinhood'),
  connectRobinhood: () => call<LinkInfo>('POST', '/api/robinhood/connect', {}),
  checkRobinhood: () => call<LinkInfo>('POST', '/api/robinhood/check', {}),
  disconnectRobinhood: () => call<LinkInfo>('DELETE', '/api/robinhood'),
  accounts: () => call<{ accounts: Account[]; chosen: string[] }>('GET', '/api/robinhood/accounts'),
  chooseAccounts: (show: string[]) => call<{ chosen: string[] }>('POST', '/api/robinhood/accounts', { show }),
  snapshot: () => call<{ snapshot: Snapshot | null; chosen: string[] }>('GET', '/api/robinhood/snapshot'),
  /** Each holding of the last read with the desk's view of it; in the Agentic account, its stop watched and a sell marked. */
  care: () => call<{ at: string | null; holdings: HoldingCare[] }>('GET', '/api/care'),
  openTicket: (symbol: string, date: string) => call<TicketOpen>('POST', '/api/ticket', { symbol, date }),
  openOwnTicket: (symbol: string, side: 'buy' | 'sell') => call<TicketOpen>('POST', '/api/ticket/own', { symbol, side }),
  checkTicket: (id: string, quantity: number, limitPrice: number) => call<{ checks: Check[] }>('POST', '/api/ticket/check', { id, quantity, limitPrice }),
  reviewTicket: (id: string, quantity: number, limitPrice: number, early = false) => call<{ checks: Check[]; review: Review; confirm: string; trading: Trading }>('POST', '/api/ticket/review', { id, quantity, limitPrice, ...(early ? { early } : {}) }),
  placeTicket: (id: string, confirm: string, early = false) => call<{ placed: Placed }>('POST', '/api/ticket/place', { id, confirm, ...(early ? { early } : {}) }),
  trading: () => call<Trading & { placedToday: number }>('GET', '/api/trading'),
  /** Switching on with under four weeks of record also says the person understood that. */
  setTrading: (on: boolean, understood = false) => call<Trading>('POST', '/api/trading', on ? { on, confirm: 'switch trading on', ...(understood ? { understood } : {}) } : { on }),
  /** The paper book: every call followed at its ticket's size, against the S&P 500. */
  paper: () => call<PaperView>('GET', '/api/paper'),
  setPaperStart: (startUsd: number) => call<PaperView>('POST', '/api/paper', { startUsd }),
  /** The person's caps, kept beside the trading switch; the desk checks them before keeping them. */
  setCaps: (caps: Caps) => call<Trading>('POST', '/api/trading', { caps }),
  readAccounts: () => call<{ snapshot: Snapshot; chosen: string[]; holdingsShared: boolean }>('POST', '/api/robinhood/refresh', {}),
};
