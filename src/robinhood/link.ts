// What the dashboard knows of Robinhood: whether a sign-in is saved, whether the person is in the middle of signing in, and
// what the last check found. It holds no sign-in itself (that stays in the person's own folder, store.ts) and opens a
// session only when asked: a check never opens a browser, and only "Connect" sends the person to Robinhood's page.
import fs from 'node:fs';
import path from 'node:path';
import { parseAccounts, parseOrders, parsePortfolio, parsePositions, parseQuotes, readAccount, sortAccounts, type Account, type AccountIds, type AccountView } from './account.js';
import type { Check, Order, TicketContext } from '../desk/ticket.js';
import type { Placed } from './order.js';
import type { Reader } from './reader.js';
import type { Review } from './review.js';
import { NotSignedIn, openSession, type SessionOptions } from './connect.js';
import { readSaved } from './store.js';
import { masked, oneLine } from './rules.js';

export type LinkState = 'none' | 'saved' | 'waiting' | 'connected' | 'failed';
export interface LinkInfo {
  state: LinkState;
  /** The state in plain words, for the page. */
  message: string;
  checkedAt: string | null;
  /** How many tools Robinhood offers, by kind (see rules.ts), as of the last good check. */
  tools: { read: number; order: number; other: number } | null;
}

/** What the dashboard shows of the accounts: the ones the person ticked, read whole, and when. */
export interface Snapshot { at: string; views: AccountView[] }

/** A failure of Robinhood's, in plain words for the page. */
export const plainFailure = (e: unknown): string => e instanceof NotSignedIn ? 'Robinhood asks you to sign in again: press Connect.' : `Robinhood did not answer as expected: ${masked(e instanceof Error ? e.message : String(e))}`;

type Last = { state: 'connected' | 'failed'; message: string; checkedAt: string; tools: LinkInfo['tools'] };

export class Link {
  private last: Last | null = null;
  private signing: Promise<void> | null = null;
  private checking: Promise<LinkInfo> | null = null;

  constructor(private readonly file: string, private readonly opts: Pick<SessionOptions, 'url' | 'port' | 'open'> & { now?: () => Date } = {}) {}

  private ids = new Map<string, AccountIds>();
  private known: Account[] | null = null;
  private last_snapshot: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;

  /** Which accounts the person ticked, kept beside the sign-in as keys (never account numbers). */
  private get choiceFile(): string { return path.join(path.dirname(this.file), 'accounts.json'); }
  chosen(): string[] {
    try { const v = JSON.parse(fs.readFileSync(this.choiceFile, 'utf8')) as { show?: unknown }; return Array.isArray(v.show) ? v.show.filter((k): k is string => typeof k === 'string') : []; } catch { return []; }
  }

  private async withReader<T>(job: (r: Reader) => Promise<T>): Promise<T> {
    const session = await openSession(this.file, { ...this.opts, signIn: false });
    try { return await job(session.reader); } finally { await session.close(); }
  }

  private learn(answer: unknown): Account[] {
    const found = parseAccounts(answer);
    this.ids = new Map(found.map((a) => [a.key, a.ids]));
    this.known = sortAccounts(found.map(({ ids: _ids, ...a }) => a));
    return this.known;
  }

  /** The person's accounts, for them to tick the ones to show. Asks Robinhood. */
  async accounts(): Promise<{ accounts: Account[]; chosen: string[] }> {
    const accounts = await this.withReader(async (r) => { const a = await r.read('get_accounts'); if (a.failed) throw new Error('Robinhood could not list the accounts'); return this.learn(a.data); });
    return { accounts, chosen: this.chosen().filter((k) => accounts.some((a) => a.key === k)) };
  }

  /** Keeps the person's choice. Only accounts Robinhood listed can be chosen. */
  async choose(keys: string[]): Promise<string[]> {
    if (!this.known) await this.accounts();
    const show = [...new Set(keys)].filter((k) => this.known!.some((a) => a.key === k && !a.deactivated));
    if (show.length !== new Set(keys).size) throw new Error('that is not one of your Robinhood accounts');
    fs.mkdirSync(path.dirname(this.choiceFile), { recursive: true });
    fs.writeFileSync(this.choiceFile, JSON.stringify({ show }, null, 2) + '\n', { mode: 0o600 });
    this.last_snapshot = null;
    return show;
  }

  /** The Agentic account's numbers, when the person chose to show it. A ticket is only ever for that account. */
  private agenticIds(): AccountIds {
    const a = this.known?.find((x) => x.agentic && !x.deactivated);
    if (!a || !this.chosen().includes(a.key)) throw new Error('show your Agentic account on the dashboard first: an order can only ever be for that account');
    return this.ids.get(a.key)!;
  }

  /** The real figures a ticket for one stock is sized and checked on: the Agentic account's value, buying power and
   *  holding of the stock, Robinhood's live price, and how many orders the account has had today (New York's day). */
  async ticketContext(symbol: string, now: Date = new Date()): Promise<Omit<TicketContext, 'rating' | 'callDate'>> {
    return this.withReader((r) => this.contextWith(r, symbol, now));
  }

  private async contextWith(r: Reader, symbol: string, now: Date): Promise<Omit<TicketContext, 'rating' | 'callDate'>> {
    {
      const a = await r.read('get_accounts');
      if (a.failed) throw new Error('Robinhood could not list the accounts');
      this.learn(a.data);
      const ids = this.agenticIds();
      const data = async (name: string, args: Record<string, unknown>) => { const x = await r.read(name, args); if (x.failed) throw new Error(`Robinhood could not give ${name.replace(/^get_|_/g, ' ').trim()}`); return x.data; };
      const p = parsePortfolio(await data('get_portfolio', { account_number: ids.accountNumber }));
      const held = parsePositions(await data('get_equity_positions', { account_number: ids.accountNumber })).find((x) => x.symbol === symbol)?.quantity ?? 0;
      const price = parseQuotes(await data('get_equity_quotes', { symbols: [symbol] })).get(symbol) ?? null;
      const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
      const ordersToday = parseOrders(await data('get_equity_orders', { account_number: ids.accountNumber })).orders.filter((o) => o.at && day(o.at) === day(now.toISOString())).length;
      return { symbol, accountValue: p.total, buyingPower: p.buyingPower, held, price, ordersToday };
    }
  }

  /** Whether the person has switched trading on, on the dashboard. Kept beside the sign-in, where agents are refused. */
  private get switchFile(): string { return path.join(path.dirname(this.file), 'trading.json'); }
  trading(): { on: boolean; since: string | null } {
    try { const v = JSON.parse(fs.readFileSync(this.switchFile, 'utf8')) as { on?: unknown; since?: unknown }; return v.on === true ? { on: true, since: typeof v.since === 'string' ? v.since : null } : { on: false, since: null }; } catch { return { on: false, since: null }; }
  }
  setTrading(on: boolean): { on: boolean; since: string | null } {
    fs.mkdirSync(path.dirname(this.switchFile), { recursive: true });
    fs.writeFileSync(this.switchFile, JSON.stringify(on ? { on: true, since: this.now() } : { on: false }, null, 2) + '\n', { mode: 0o600 });
    return this.trading();
  }

  /** Places one order on the Agentic account, in one session: reads the account afresh, has `approve` check the order on
   *  those figures, and only if every check passes sends it. The caller has already had the person Confirm it. */
  async placeChecked(order: Order, refId: string, approve: (context: Omit<TicketContext, 'rating' | 'callDate'>) => Check[]): Promise<{ placed: Placed; context: Omit<TicketContext, 'rating' | 'callDate'> }> {
    if (!this.trading().on) throw new Error('trading is switched off: switch it on in Your account first');
    const session = await openSession(this.file, { ...this.opts, signIn: false });
    try {
      const context = await this.contextWith(session.reader, order.symbol, new Date());
      const failed = approve(context).filter((c) => !c.ok);
      if (failed.length) throw new Error(`the order no longer passes on Robinhood's latest figures: ${failed.map((c) => c.words).join('; ')}`);
      const placed = await session.placer.place({ accountNumber: this.agenticIds().accountNumber, agentic: true }, order, refId);
      return { placed, context };
    } finally { await session.close(); }
  }

  /** Robinhood's own check of an order on the Agentic account. Nothing is placed. */
  async review(order: Order): Promise<Review> {
    const session = await openSession(this.file, { ...this.opts, signIn: false });
    try {
      const a = await session.reader.read('get_accounts');
      if (a.failed) throw new Error('Robinhood could not list the accounts');
      this.learn(a.data);
      return await session.reviewer.review({ accountNumber: this.agenticIds().accountNumber, agentic: true }, order);
    } finally { await session.close(); }
  }

  /** The last read of the chosen accounts, without asking Robinhood again. */
  snapshot(): Snapshot | null { return this.last_snapshot; }

  /** Reads the chosen accounts afresh: value, holdings at Robinhood's live prices, and the Agentic account's orders. */
  refresh(): Promise<Snapshot> {
    this.refreshing ??= (async () => {
      try {
        return await this.withReader(async (r) => {
          const a = await r.read('get_accounts');
          if (a.failed) throw new Error('Robinhood could not list the accounts');
          const accounts = this.learn(a.data), show = this.chosen();
          const views: AccountView[] = [];
          for (const account of accounts.filter((x) => show.includes(x.key))) views.push(await readAccount(r, account, this.ids.get(account.key)!));
          this.last_snapshot = { at: this.now(), views };
          return this.last_snapshot;
        });
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  private now = (): string => (this.opts.now?.() ?? new Date()).toISOString();
  private saved = (): boolean => !!readSaved(this.file).tokens;

  info(): LinkInfo {
    if (this.signing) return { state: 'waiting', message: "Waiting for you to finish signing in on Robinhood's page. This waits up to five minutes.", checkedAt: null, tools: null };
    if (this.last?.state === 'failed') return { ...this.last };
    if (!this.saved()) return { state: 'none', message: 'Robinhood is not connected.', checkedAt: null, tools: null };
    if (this.last) return { ...this.last };
    return { state: 'saved', message: 'A Robinhood sign-in is saved. It has not been checked since the dashboard started.', checkedAt: null, tools: null };
  }

  private good(reader: Reader): Last {
    const k = reader.byKind(), total = reader.tools.length;
    return { state: 'connected', checkedAt: this.now(), tools: { read: k.read.length, order: k.order.length, other: k.other.length },
      message: `Robinhood offers ${total} ${total === 1 ? 'tool' : 'tools'}: ${k.read.length} that only read, ${k.order.length} that order or move money (this page never uses them) and ${k.other.length} others.` };
  }

  private bad(e: unknown): Last {
    const words = oneLine(masked(e instanceof Error ? e.message : String(e)), 200);
    const why = e instanceof NotSignedIn ? 'Robinhood asks you to sign in again.' : /^Robinhood refused/.test(words) ? words : `Robinhood did not answer as expected: ${words}`;
    return { state: 'failed', checkedAt: this.now(), tools: null, message: why };
  }

  /** Sends the person to Robinhood's sign-in page and waits for them to come back, in the background. */
  startSignIn(): LinkInfo {
    if (this.signing) return this.info();
    this.last = null;
    this.signing = (async () => {
      try {
        const session = await openSession(this.file, { ...this.opts, signIn: true });
        try { this.last = this.good(session.reader); } finally { await session.close(); }
      } catch (e) {
        this.last = this.bad(e);
      } finally {
        this.signing = null;
      }
    })();
    return this.info();
  }

  /** Asks Robinhood whether the saved sign-in still works, and what it offers. Never opens a browser. */
  check(): Promise<LinkInfo> {
    if (this.signing) return Promise.resolve(this.info());
    this.checking ??= (async () => {
      try {
        const session = await openSession(this.file, { ...this.opts, signIn: false });
        try { this.last = this.good(session.reader); } finally { await session.close(); }
      } catch (e) {
        this.last = e instanceof NotSignedIn && !this.saved() ? null : this.bad(e);
      } finally {
        this.checking = null;
      }
      return this.info();
    })();
    return this.checking;
  }

  /** Deletes the saved sign-in. Robinhood is not told; the person can also end the access on Robinhood's side. */
  forget(): LinkInfo {
    fs.rmSync(this.file, { force: true });
    fs.rmSync(this.choiceFile, { force: true });
    fs.rmSync(this.switchFile, { force: true });   // disconnecting switches trading off too
    this.last = null; this.last_snapshot = null; this.known = null; this.ids.clear();
    return this.info();
  }
}
