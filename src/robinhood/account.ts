// The person's Robinhood accounts as the dashboard shows them, read only through the Reader. Robinhood's answers are read
// field by field into plain figures: a figure Robinhood did not give, or gave in a form that is not a number, is null (a
// dash on the page), never a zero. Shapes as Robinhood answered on 16 Oct 2026 (`discover` and a read-only look).
// An account is known to the page and to desk-data by a key made from its number, never by the number itself: a keyed
// hash with a secret kept on this computer alone (link.ts), so the key says nothing about the number even to someone
// who knows the number and the recipe.
import crypto from 'node:crypto';
import type { Reader } from './reader.js';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A figure as Robinhood sends it (text that is a number), or null. */
export const figure = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return null;
  return Number(v.trim());
};
/** What every read answers: { data, guide }. Only data is used; guide is Robinhood's advice to chat agents, not facts. */
const dataOf = (answer: unknown): Record<string, unknown> => obj(obj(answer).data);

export const keyOf = (accountNumber: string, secret: string): string => crypto.createHmac('sha256', secret).update(accountNumber).digest('hex').slice(0, 16);

export interface Account {
  key: string;
  /** The last four characters of the account number, for the person to recognise it. */
  last4: string;
  label: string;
  agentic: boolean;
  isDefault: boolean;
  deactivated: boolean;
}
/** What only the server keeps: the numbers Robinhood's tools ask for. Never sent to the page or written to desk-data. */
export interface AccountIds { key: string; accountNumber: string; rhsAccountNumber: string | null }

const TYPE_WORDS: Record<string, string> = { individual: 'Individual', ira_traditional: 'Traditional IRA', ira_roth: 'Roth IRA', joint: 'Joint', custodial: 'Custodial' };
const titleOf = (raw: string): string => TYPE_WORDS[raw] ?? raw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function parseAccounts(answer: unknown, secret: string): Array<Account & { ids: AccountIds }> {
  return list(dataOf(answer).accounts).flatMap((v) => {
    const a = obj(v), number = text(a.account_number);
    if (!number) return [];
    const kind = text(a.brokerage_account_type) ?? text(a.type);
    const key = keyOf(number, secret), agentic = a.agentic_allowed === true;
    const label = text(a.nickname) ?? (agentic ? 'Agentic account' : kind ? `${titleOf(kind)} account` : 'Account');
    return [{ key, last4: number.slice(-4), label, agentic, isDefault: a.is_default === true, deactivated: a.deactivated === true || a.permanently_deactivated === true,
      ids: { key, accountNumber: number, rhsAccountNumber: text(a.rhs_account_number) } }];
  });
}

/** Robinhood's own order for its accounts: the default first, the agentic second, then the rest. */
export const sortAccounts = <T extends Account>(accounts: T[]): T[] => [...accounts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.agentic) - Number(a.agentic));

export interface Portfolio { total: number | null; equities: number | null; crypto: number | null; options: number | null; cash: number | null; buyingPower: number | null; currency: string }
export function parsePortfolio(answer: unknown): Portfolio {
  const d = dataOf(answer);
  return { total: figure(d.total_value), equities: figure(d.equity_value), crypto: figure(d.crypto_value), options: figure(d.options_value), cash: figure(d.cash),
    buyingPower: figure(obj(d.buying_power).buying_power), currency: text(d.currency) ?? 'USD' };
}

export interface Holding { symbol: string; quantity: number; averageCost: number | null; price: number | null; value: number | null; gainPct: number | null; kind: 'stock' | 'crypto' }
export function parsePositions(answer: unknown): Array<Pick<Holding, 'symbol' | 'quantity' | 'averageCost'>> {
  return list(dataOf(answer).positions).flatMap((v) => {
    const p = obj(v), symbol = text(p.symbol), quantity = figure(p.quantity);
    return symbol && quantity !== null && quantity !== 0 ? [{ symbol: symbol.toUpperCase(), quantity, averageCost: figure(p.average_buy_price) }] : [];
  });
}

/** Crypto holdings. No account of the person's held any on 16 Oct 2026, so the fields are read as Robinhood names them
 *  elsewhere; a holding whose quantity cannot be read is left out and counted, never guessed. */
export function parseCrypto(answer: unknown): { holdings: Array<Pick<Holding, 'symbol' | 'quantity' | 'averageCost'>>; unread: number } {
  const rows = list(dataOf(answer).results);
  const holdings = rows.flatMap((v) => {
    const p = obj(v), symbol = text(p.symbol) ?? text(obj(p.currency).code) ?? text(p.asset_code), quantity = figure(p.quantity) ?? figure(p.quantity_available);
    return symbol && quantity !== null && quantity !== 0 ? [{ symbol: symbol.toUpperCase(), quantity, averageCost: figure(p.average_cost) ?? figure(p.average_buy_price) }] : [];
  });
  return { holdings, unread: rows.length - holdings.length };
}

/** The latest price of each symbol from Robinhood's live quotes. */
export function parseQuotes(answer: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of list(dataOf(answer).results)) {
    const q = obj(obj(v).quote), symbol = text(q.symbol), price = figure(q.last_trade_price);
    if (symbol && price !== null) out.set(symbol.toUpperCase(), price);
  }
  return out;
}

export interface Order { symbol: string | null; side: string | null; type: string | null; state: string | null; quantity: number | null; price: number | null; at: string | null }
/** Orders. The Agentic account had none on 16 Oct 2026, so the fields are read as Robinhood's tool description names
 *  them; whatever cannot be read is null and shown as a dash. */
export function parseOrders(answer: unknown): { orders: Order[]; count: number } {
  const rows = list(dataOf(answer).orders);
  return {
    count: rows.length,
    orders: rows.slice(0, 20).map((v) => {
      const o = obj(v);
      return { symbol: text(o.symbol)?.toUpperCase() ?? null, side: text(o.side), type: text(o.type), state: text(o.state),
        quantity: figure(o.quantity) ?? figure(o.cumulative_quantity), price: figure(o.average_price) ?? figure(o.price) ?? figure(o.limit_price), at: text(o.created_at) ?? text(o.updated_at) };
    }),
  };
}

export interface Approvals { required: boolean | null; pending: number }
export function parseApprovals(setting: unknown, approvals: unknown): Approvals {
  const s = obj(dataOf(setting).setting);
  return { required: typeof s.human_must_approve_trades === 'boolean' ? s.human_must_approve_trades : null, pending: list(dataOf(approvals).approvals).length };
}

export interface AccountView {
  account: Account;
  portfolio: Portfolio | null;
  holdings: Holding[];
  /** Holdings Robinhood listed that could not be read (left out, never guessed). */
  unread: number;
  /** For the Agentic account only: its orders and Robinhood's own approval on the phone. */
  orders: { orders: Order[]; count: number } | null;
  approvals: Approvals | null;
  /** What could not be read, in plain words. */
  problems: string[];
}

const QUOTES_PER_CALL = 20;

/** One account, read whole: its value, what it holds priced at Robinhood's live quotes, and for the Agentic account its orders. */
export async function readAccount(reader: Reader, account: Account, ids: AccountIds): Promise<AccountView> {
  const problems: string[] = [];
  const read = async (what: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const r = await reader.read(name, args);
      if (!r.failed) return r.data;
      problems.push(`${what}: Robinhood reported an error`);
    } catch (e) { problems.push(`${what}: ${(e as Error).message.replace(/\d{5,}/g, '#####').slice(0, 160)}`); }
    return null;
  };
  const p = await read('the value and buying power', 'get_portfolio', { account_number: ids.accountNumber });
  const stocks = await read('the stocks held', 'get_equity_positions', { account_number: ids.accountNumber });
  const coins = ids.rhsAccountNumber ? await read('the crypto held', 'get_crypto_positions', { rhs_account_number: ids.rhsAccountNumber }) : null;
  const crypto = coins === null ? { holdings: [], unread: 0 } : parseCrypto(coins);
  const base = [...parsePositions(stocks).map((h) => ({ ...h, kind: 'stock' as const })), ...crypto.holdings.map((h) => ({ ...h, kind: 'crypto' as const }))];

  const prices = new Map<string, number>(), symbols = base.filter((h) => h.kind === 'stock').map((h) => h.symbol);
  for (let i = 0; i < symbols.length; i += QUOTES_PER_CALL) {
    const q = await read('live prices', 'get_equity_quotes', { symbols: symbols.slice(i, i + QUOTES_PER_CALL) });
    for (const [s, v] of parseQuotes(q)) prices.set(s, v);
  }
  const holdings: Holding[] = base.map((h) => {
    const price = prices.get(h.symbol) ?? null;
    return { ...h, price, value: price === null ? null : price * h.quantity, gainPct: price !== null && h.averageCost ? (price / h.averageCost - 1) * 100 : null };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  let orders: AccountView['orders'] = null, approvals: Approvals | null = null;
  if (account.agentic) {
    const o = await read('the orders', 'get_equity_orders', { account_number: ids.accountNumber });
    orders = o === null ? null : parseOrders(o);
    const setting = await read('the phone approval setting', 'get_trade_approval_setting', { account_number: ids.accountNumber });
    const pending = await read('the approvals waiting', 'get_trade_approvals', { account_number: ids.accountNumber });
    approvals = setting === null && pending === null ? null : parseApprovals(setting, pending);
  }
  return { account, portfolio: p === null ? null : parsePortfolio(p), holdings, unread: crypto.unread, orders, approvals, problems };
}
