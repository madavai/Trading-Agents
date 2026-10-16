// The page's only way to the desk's server: the token it was given at load, on every call.
import type { DeskState } from '../state.js';
import type { History, QuoteResult } from '../quotes.js';
import type { WatchItem, QueueItem } from '../store.js';
import type { LinkInfo, Snapshot } from '../../robinhood/link.js';
import type { Account, AccountView, Holding, Order } from '../../robinhood/account.js';

export type { DeskState, History, QuoteResult, WatchItem, QueueItem, LinkInfo, Snapshot, Account, AccountView, Holding, Order };
export interface Market { symbol: string; name: string; unit?: '%'; quote: QuoteResult }
export interface CallDetail { decision: string; sections: Record<string, string[]>; hasReport: boolean }

const token = document.querySelector<HTMLMetaElement>('meta[name="desk-token"]')?.content ?? '';

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, cache: 'no-store',
    headers: { 'x-desk-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `the desk answered ${res.status}`);
  return data as T;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  state: () => call<DeskState>('GET', '/api/state'),
  version: () => call<{ version: string }>('GET', '/api/version'),
  quotes: (symbols: string[]) => call<{ quotes: QuoteResult[] }>('GET', `/api/quotes?${q({ symbols: symbols.join(',') })}`),
  markets: () => call<{ markets: Market[] }>('GET', '/api/markets'),
  history: (symbol: string, range: string) => call<History>('GET', `/api/history?${q({ symbol, range })}`),
  call: (symbol: string, date: string) => call<CallDetail>('GET', `/api/call?${q({ symbol, date })}`),
  addWatch: (symbol: string) => call<{ watchlist: WatchItem[] }>('POST', '/api/watchlist', { symbol }),
  removeWatch: (symbol: string) => call<{ watchlist: WatchItem[] }>('DELETE', `/api/watchlist?${q({ symbol })}`),
  favourite: (symbol: string, favourite: boolean) => call<{ watchlist: WatchItem[] }>('POST', '/api/favourite', { symbol, favourite }),
  enqueue: (symbol: string) => call<{ queue: QueueItem[] }>('POST', '/api/queue', { symbol }),
  dequeue: (symbol: string) => call<{ queue: QueueItem[] }>('DELETE', `/api/queue?${q({ symbol })}`),
  robinhood: () => call<LinkInfo>('GET', '/api/robinhood'),
  connectRobinhood: () => call<LinkInfo>('POST', '/api/robinhood/connect', {}),
  checkRobinhood: () => call<LinkInfo>('POST', '/api/robinhood/check', {}),
  disconnectRobinhood: () => call<LinkInfo>('DELETE', '/api/robinhood'),
  accounts: () => call<{ accounts: Account[]; chosen: string[] }>('GET', '/api/robinhood/accounts'),
  chooseAccounts: (show: string[]) => call<{ chosen: string[] }>('POST', '/api/robinhood/accounts', { show }),
  snapshot: () => call<{ snapshot: Snapshot | null; chosen: string[] }>('GET', '/api/robinhood/snapshot'),
  readAccounts: () => call<{ snapshot: Snapshot; chosen: string[]; holdingsShared: boolean }>('POST', '/api/robinhood/refresh', {}),
};
