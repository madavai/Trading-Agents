// What the dashboard knows of Robinhood: whether a sign-in is saved, whether the person is in the middle of signing in, and
// what the last check found. It holds no sign-in itself (that stays in the person's own folder, store.ts) and opens a
// session only when asked: a check never opens a browser, and only "Connect" sends the person to Robinhood's page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openOrders, parseAccounts, parsePortfolio, parsePositions, parseQuotes, QUOTES_PER_CALL, readAccount, sortAccounts, type Account, type AccountIds, type AccountView } from './account.js';
import { marketDay } from '../data/dates.js';
import { brokerSymbol, deskSymbol } from '../data/symbols.js';
import type { Check, Order, TicketContext } from '../desk/ticket.js';
import { writePrivate } from '../private.js';
import { capsOf, type Caps } from '../settings.js';
import type { Placed } from './order.js';
import type { Reader } from './reader.js';
import type { Review } from './review.js';
import { NotSignedIn, openSession, type SessionOptions } from './connect.js';
import { readSaved } from './store.js';
import { LOOK_FIRST, masked, oneLine } from './rules.js';
import { Refused } from './reader.js';

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

/** The trading switch and the person's caps, as kept beside the sign-in. offBecause: the weekly loss limit switched it
 *  off, when and why; cleared when the person switches it on again. */
export interface TradingState { on: boolean; since: string | null; caps: Caps; offBecause: { at: string; words: string } | null }

/** A failure of Robinhood's, in plain words for the page. */
export const plainFailure = (e: unknown): string => e instanceof NotSignedIn ? 'Robinhood asks you to sign in again: press Connect.' : `Robinhood did not answer as expected: ${masked(e instanceof Error ? e.message : String(e))}`;

/** An order was sent to Robinhood, but its answer never came back (a dropped connection, a timeout): it may have gone
 *  through. Never told as a plain failure, which would invite a second order. */
export class AnswerLost extends Error {
  constructor(readonly why: string) { super(`Robinhood's answer did not arrive (${why}), so this order may have gone through. ${LOOK_FIRST}`); }
}

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

  /** The secret the account fingerprints are made with: random, made once on this computer and kept beside the sign-in.
   *  Without it a fingerprint says nothing about the account number, even to someone who knows the number. */
  private get secretFile(): string { return path.join(path.dirname(this.file), 'secrets.json'); }
  private secret(): string {
    try {
      const v = JSON.parse(fs.readFileSync(this.secretFile, 'utf8')) as { fingerprint?: unknown };
      if (typeof v.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(v.fingerprint)) return v.fingerprint;
    } catch { /* none yet */ }
    const fingerprint = crypto.randomBytes(32).toString('hex');
    writePrivate(this.secretFile, JSON.stringify({ fingerprint }, null, 2) + '\n');
    return fingerprint;
  }

  private learn(answer: unknown): Account[] {
    const found = parseAccounts(answer, this.secret());
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
    writePrivate(this.choiceFile, JSON.stringify({ show }, null, 2) + '\n');
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
   *  holding of the stock, Robinhood's live price, how many orders the account has had today (New York's day), and its
   *  orders still open, which count towards the caps as if they were filled. */
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
      this.noteValue(p.total, now);   // every read of the account's value counts towards the weekly loss limit
      // The desk names a share class as Yahoo does (BRK-B), Robinhood with a dot (BRK.B): its figures are read by its own.
      const all = parsePositions(await data('get_equity_positions', { account_number: ids.accountNumber })), rh = brokerSymbol(symbol);
      const same = (s: string) => deskSymbol(s, 'stock') === deskSymbol(symbol, 'stock');
      const held = all.find((x) => same(x.symbol))?.quantity ?? 0;
      const orders = openOrders(await data('get_equity_orders', { account_number: ids.accountNumber }));
      const ordersToday = orders.all.filter((o) => o.at && marketDay(new Date(o.at)) === marketDay(now)).length;
      // Live prices for the stock, every holding and every open buy without a price of its own, twenty at a time as
      // Robinhood answers them: a holding left unpriced would count nothing towards its sector.
      const wanted = [...new Set([rh, ...all.map((x) => x.symbol), ...orders.open.filter((o) => o.side === 'buy' && o.price === null).map((o) => o.symbol)])];
      const quotes = new Map<string, number>();
      for (let i = 0; i < wanted.length; i += QUOTES_PER_CALL) for (const [s, v] of parseQuotes(await data('get_equity_quotes', { symbols: wanted.slice(i, i + QUOTES_PER_CALL) }))) quotes.set(s, v);
      const price = quotes.get(rh) ?? null;
      const mine = (side: 'buy' | 'sell') => orders.open.filter((o) => same(o.symbol) && o.side === side).reduce((n, o) => n + o.quantity, 0);
      return { symbol, accountValue: p.total, buyingPower: p.buyingPower, held, price, ordersToday, positions: all.map((x) => ({ symbol: deskSymbol(x.symbol, 'stock'), quantity: x.quantity, price: quotes.get(x.symbol) ?? null })),
        open: { buy: mine('buy'), sell: mine('sell') }, unreadOrders: orders.unread,
        openBuys: orders.open.filter((o) => o.side === 'buy').map((o) => ({ symbol: deskSymbol(o.symbol, 'stock'), quantity: o.quantity, price: o.price ?? quotes.get(o.symbol) ?? null })) };
    }
  }

  /** Whether the person has switched trading on, on the dashboard, and their caps. Kept together beside the sign-in, where
   *  agents are refused: a cap missing or out of range is the shipped one, never a larger one. */
  private get switchFile(): string { return path.join(path.dirname(this.file), 'trading.json'); }
  trading(): TradingState {
    let v: { on?: unknown; since?: unknown; caps?: unknown; offBecause?: { at?: unknown; words?: unknown } } = {};
    try { v = JSON.parse(fs.readFileSync(this.switchFile, 'utf8')) as typeof v; } catch { /* off, with the shipped caps */ }
    const off = v.on !== true && typeof v.offBecause?.at === 'string' && typeof v.offBecause.words === 'string' ? { at: v.offBecause.at, words: v.offBecause.words.slice(0, 300) } : null;
    return { on: v.on === true, since: v.on === true && typeof v.since === 'string' ? v.since : null, caps: capsOf(v.caps), offBecause: off };
  }
  private keepTrading(on: boolean, caps: Caps, offBecause?: { at: string; words: string }): TradingState {
    writePrivate(this.switchFile, JSON.stringify(on ? { on: true, since: this.now(), caps } : { on: false, caps, ...(offBecause ? { offBecause } : {}) }, null, 2) + '\n');
    return this.trading();
  }
  setTrading(on: boolean): TradingState {
    const was = this.trading();
    if (on && was.on) return was;   // already on: the day it was switched on stands
    // Switched back on after the weekly loss limit tripped: the limit counts from now. The readings before (the high it
    // fell from, a withdrawal) would trip it again at the next read, for up to a week.
    if (on && was.offBecause) fs.rmSync(this.valuesFile, { force: true });
    return this.keepTrading(on, was.caps);
  }
  /** The person's caps, as the dashboard's server checked them (settings.ts capsFrom). The switch is left as it is. */
  setCaps(caps: Caps): TradingState {
    const was = this.trading();
    writePrivate(this.switchFile, JSON.stringify({ ...(was.on ? { on: true, since: was.since } : { on: false, ...(was.offBecause ? { offBecause: was.offBecause } : {}) }), caps }, null, 2) + '\n');
    return this.trading();
  }

  /** The Agentic account's value, day by day (New York's), kept beside the sign-in: the day's highest and latest reading,
   *  for the last fourteen days. When trading is on and the value falls the person's weekly limit below its highest of
   *  the last seven days, trading switches itself off and says why. A large withdrawal can trip it too; the person
   *  switches it back on, and the limit then counts from that moment (setTrading). */
  private get valuesFile(): string { return path.join(path.dirname(this.file), 'values.json'); }
  values(): Array<{ day: string; high: number; last: number }> {
    try {
      const v = JSON.parse(fs.readFileSync(this.valuesFile, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((d): d is { day: string; high: number; last: number } => !!d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.day)) && Number.isFinite(d.high) && Number.isFinite(d.last)) : [];
    } catch { return []; }
  }
  noteValue(total: number | null, now: Date = new Date()): TradingState {
    const state = this.trading();
    if (total === null || !(total > 0)) return state;
    const day = marketDay;
    const today = day(now), weekAgo = day(new Date(now.getTime() - 7 * 86_400_000)), twoWeeks = day(new Date(now.getTime() - 14 * 86_400_000));
    const days = this.values().filter((d) => d.day >= twoWeeks && d.day !== today);
    const mine = this.values().find((d) => d.day === today);
    days.push({ day: today, high: Math.max(mine?.high ?? 0, total), last: total });
    days.sort((a, b) => a.day.localeCompare(b.day));
    writePrivate(this.valuesFile, JSON.stringify(days, null, 2) + '\n');
    const week = days.filter((d) => d.day >= weekAgo), top = week.reduce((a, d) => (d.high > a.high ? d : a), week[0]!);
    const fall = (1 - total / top.high) * 100;
    if (!state.on || fall < state.caps.weeklyLossPercent) return state;
    const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return this.keepTrading(false, state.caps, { at: now.toISOString(), words: `The Agentic account fell ${fall.toFixed(1)}% below its highest value of the last seven days (${money(top.high)} on ${top.day}, now ${money(total)}), past your weekly limit of ${state.caps.weeklyLossPercent}%. Trading switched itself off. A large withdrawal can do this too. When you switch it back on, the limit counts from then.` });
  }

  /** Places one order on the Agentic account, in one session: reads the account afresh, has `approve` check the order on
   *  those figures, and only if every check passes sends it. The caller has already had the person Confirm it.
   *  `sending` runs just before the order goes out (the desk logs it then, so a send whose answer never comes is still
   *  known); a failure after that point is AnswerLost, never a plain failure: the order may have gone through. */
  async placeChecked(order: Order, refId: string, approve: (context: Omit<TicketContext, 'rating' | 'callDate'>) => Check[] | Promise<Check[]>, sending: () => void = () => {}): Promise<{ placed: Placed; context: Omit<TicketContext, 'rating' | 'callDate'> }> {
    if (!this.trading().on) throw new Error('trading is switched off: switch it on in Your account first');
    const session = await openSession(this.file, { ...this.opts, signIn: false });
    try {
      const context = await this.contextWith(session.reader, order.symbol, new Date());
      // Reading the account just now may have tripped the weekly loss limit: then nothing is sent.
      const now = this.trading();
      if (!now.on) throw new Error(`trading switched itself off: ${now.offBecause?.words ?? 'switch it on in Your account first'}`);
      const failed = (await approve(context)).filter((c) => !c.ok);
      if (failed.length) throw new Error(`the order no longer passes on Robinhood's latest figures: ${failed.map((c) => c.words).join('; ')}`);
      const account = { accountNumber: this.agenticIds().accountNumber, agentic: true }, sent = { ...order, symbol: brokerSymbol(order.symbol) };
      session.placer.ready(account, sent, refId);   // what this door would refuse is refused before anything is logged or sent
      sending();
      try { return { placed: await session.placer.place(account, sent, refId), context }; }
      catch (e) { throw e instanceof Refused ? e : new AnswerLost(oneLine(masked(e instanceof Error ? e.message : String(e)), 120)); }
    } finally { await session.close().catch(() => undefined); }   // closing the session afterwards never hides the answer
  }

  /** Robinhood's own check of an order on the Agentic account. Nothing is placed. */
  async review(order: Order): Promise<Review> {
    const session = await openSession(this.file, { ...this.opts, signIn: false });
    try {
      const a = await session.reader.read('get_accounts');
      if (a.failed) throw new Error('Robinhood could not list the accounts');
      this.learn(a.data);
      return await session.reviewer.review({ accountNumber: this.agenticIds().accountNumber, agentic: true }, { ...order, symbol: brokerSymbol(order.symbol) });
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
          const agentic = views.find((v) => v.account.agentic);
          if (agentic) this.noteValue(agentic.portfolio?.total ?? null, this.opts.now?.() ?? new Date());
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
      // Of the order tools, the page calls two (review.ts, order.ts), and only on the person's own press; no agent gets any.
      message: `Robinhood offers ${total} ${total === 1 ? 'tool' : 'tools'}: ${k.read.length} that only read, ${k.order.length} that order or move money (of these, this page uses only Robinhood's dry run, when you press Review, and the order itself, on your Confirm; no agent ever gets one) and ${k.other.length} others.` };
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
    fs.rmSync(this.valuesFile, { force: true });   // the account's values go with the sign-in
    if (fs.existsSync(this.switchFile)) this.setTrading(false);   // disconnecting switches trading off too; the caps are the person's rules and stay
    this.last = null; this.last_snapshot = null; this.known = null; this.ids.clear();
    return this.info();
  }
}
