// The order ticket: what one of the desk's calls asks of the Agentic account, sized by the person's settings and checked
// against their caps, before anything is sent to Robinhood. Pure arithmetic on real figures (the account's value, buying
// power and holdings as Robinhood gave them, Robinhood's live price): when a figure is missing the ticket says so and
// proposes nothing, it never guesses. Limit orders of whole shares only: Robinhood takes fractions on market orders alone.
// Crypto is sized here for the paper book alone (the dashboard never sends it to Robinhood, whose agent doorway trades
// stocks and funds only): in fractions to six decimal places, as crypto is bought, and within the crypto limit.
import type { Action, Caps, Trading } from '../settings.js';
import { isCrypto } from '../data/symbols.js';

/** Crypto is counted to six decimal places (0.006123 BTC-USD), and an order is at least a dollar, as Robinhood's are. */
const COIN_STEP = 1e6, MIN_COIN_USD = 1;
const downToStep = (n: number): number => Math.floor(n * COIN_STEP + 1e-6) / COIN_STEP;
const units = (n: number, coin: boolean): string => (coin ? `${n} unit(s)` : `${n} share(s)`);

export interface TicketContext {
  symbol: string;
  rating: string;
  /** The day of the call, YYYY-MM-DD. */
  callDate: string;
  /** The Agentic account, as Robinhood gave it. */
  accountValue: number | null;
  buyingPower: number | null;
  /** Shares of this stock already held in the Agentic account (0 when none). */
  held: number;
  /** Robinhood's live price of the stock. */
  price: number | null;
  /** Orders the Agentic account has had today (Robinhood's own list). */
  ordersToday: number;
  /** The stock's sector and how much of the account is already in it, for the sector limit. name null: a whole-market
   *  fund, in no sector. Absent: not known, so the stock counts as a sector of its own. */
  sector?: { name: string | null; label: string; heldUsd: number };
  /** How much of the account is already in crypto, for the crypto limit. */
  cryptoHeldUsd?: number;
  /** When this stock was last bought here, and how many trading days ago, for the shortest hold. Absent: not bought here. */
  boughtOn?: string; heldDays?: number;
  /** What the Agentic account holds, at Robinhood's live prices, for the sector and crypto limits. */
  positions?: Array<{ symbol: string; quantity: number; price: number | null }>;
}

export type Side = 'buy' | 'sell';
export interface Order { symbol: string; side: Side; quantity: number; limitPrice: number; timeInForce: 'gfd' | 'gtc' }
/** ask: it passes, but the person presses once more before Review (selling a stock bought here under the shortest hold). */
export interface Check { ok: boolean; words: string; ask?: true }
/** Under the shortest hold: a stock bought here fewer trading days ago than the person's limit. */
export const early = (c: TicketContext, caps: Caps): boolean => c.heldDays !== undefined && c.heldDays < caps.minHoldDays;
/** What a ticket proposes: from a call, the action its rating asks in the person's settings; from the person, their own. */
export type OwnAction = 'your own buy' | 'your own sell';
export interface Proposal { action: Action | OwnAction; order: Order | null; why: string[] }

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n: number) => Math.round(n * 100) / 100;

/** What the rating asks, in the person's own settings. */
export const actionOf = (rating: string, t: Trading): Action => t.ratingToOrder[rating] ?? 'no order';

/** `caps` are the person's own, read beside the trading switch (never from the project's settings file). */
export function propose(c: TicketContext, t: Trading, caps: Caps): Proposal {
  const action = actionOf(c.rating, t), why: string[] = [], coin = isCrypto(c.symbol);
  const none = (reason: string): Proposal => ({ action, order: null, why: [...why, reason] });
  if (action === 'no order') return none(`The desk rated ${c.symbol} ${c.rating}: your settings place no order for that rating.`);
  if (c.price === null || c.price <= 0) return none(`Robinhood gave no live price for ${c.symbol}, so no order can be sized.`);
  const limitPrice = cents(c.price);
  why.push(`Limit price: Robinhood's live price, ${money(limitPrice)}. You can change it.`);

  if (action === 'sell half of what is held' || action === 'sell everything held') {
    if (c.held <= 0) return none(`The desk rated ${c.symbol} ${c.rating}, but the Agentic account holds none to sell.`);
    if (early(c, caps)) return none(`${c.symbol} was bought here on ${c.boughtOn}, ${c.heldDays} trading day(s) ago: your shortest hold is ${caps.minHoldDays}, so the desk proposes no sell yet.`);
    const all = action === 'sell everything held', quantity = coin ? (all ? c.held : downToStep(c.held / 2)) : Math.floor(all ? c.held : c.held / 2);
    if (coin && quantity <= 0) return none(`${units(c.held, true)} of ${c.symbol} are held; half of that is less than the smallest step of 0.000001.`);
    if (quantity < (coin ? 0 : 1)) return none(`The Agentic account holds ${c.held} share(s); half of that is less than one whole share, and a limit order sells whole shares only.`);
    why.push(`${all ? 'Everything held' : 'Half of what is held'}: ${quantity} of ${units(c.held, coin)}${coin ? '' : ', whole shares only'}.`);
    return { action, order: { symbol: c.symbol, side: 'sell', quantity, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
  }

  if (c.accountValue === null || c.accountValue <= 0) return none('Robinhood gave no total value for the Agentic account, so a position cannot be sized.');
  if (c.buyingPower === null) return none('Robinhood gave no buying power for the Agentic account, so a buy cannot be sized.');
  const share = action === 'buy a full position' ? t.fullPositionPercent : t.fullPositionPercent / 2;
  const target = (c.accountValue * share) / 100;
  why.push(`${action === 'buy a full position' ? 'A full position' : 'Half a position'}: ${share}% of the account's ${money(c.accountValue)} is ${money(target)}.`);
  let amount = target;
  if (amount > caps.perOrderUsd) { amount = caps.perOrderUsd; why.push(`Your cap of ${money(caps.perOrderUsd)} an order makes it ${money(amount)}.`); }
  if (amount > c.buyingPower) { amount = c.buyingPower; why.push(`Buying power is ${money(c.buyingPower)}, so at most that.`); }
  if (coin) {
    const room = Math.max(0, Math.floor(((c.accountValue * caps.cryptoPercent) / 100 - (c.cryptoHeldUsd ?? 0)) * 100) / 100);
    if (amount > room) { amount = room; why.push(`Your crypto limit of ${caps.cryptoPercent}% of the account leaves ${money(room)}, so at most that.`); }
    if (amount < MIN_COIN_USD) return none(`${money(amount)} is under ${money(MIN_COIN_USD)}, the smallest crypto order.`);
    const quantity = downToStep(amount / limitPrice);
    if (quantity <= 0) return none(`${money(amount)} buys no ${c.symbol} at ${money(limitPrice)}.`);
    why.push(`${money(amount)} ÷ ${money(limitPrice)}, rounded down to six decimal places: ${units(quantity, true)}.`);
    return { action, order: { symbol: c.symbol, side: 'buy', quantity, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
  }
  const quantity = Math.floor(amount / limitPrice);
  if (quantity < 1) return none(`${money(amount)} buys less than one share at ${money(limitPrice)}, and a limit order buys whole shares only.`);
  why.push(`${money(amount)} ÷ ${money(limitPrice)}, rounded down: ${quantity} share(s).`);
  return { action, order: { symbol: c.symbol, side: 'buy', quantity, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
}

/** A ticket the person opens themselves, for one stock and one side, not from a call: one whole share at Robinhood's live
 *  price to start (they change both), in the Agentic account only, and then exactly the checks, the review and the
 *  Confirm of a call's ticket. Nothing is sized for them: the smallest order is where a person's own order begins. */
export function proposeOwn(c: TicketContext, side: Side, t: Trading): Proposal {
  const action: OwnAction = side === 'buy' ? 'your own buy' : 'your own sell';
  const none = (reason: string): Proposal => ({ action, order: null, why: [reason] });
  if (c.price === null || c.price <= 0) return none(`Robinhood gave no live price for ${c.symbol}, so no order can be priced.`);
  if (side === 'sell' && c.held <= 0) return none(`The Agentic account holds no ${c.symbol} to sell.`);
  if (side === 'sell' && c.held < 1) return none(`The Agentic account holds ${c.held} of a share of ${c.symbol}; a limit order sells whole shares only.`);
  const limitPrice = cents(c.price);
  const why = [`Your own order: one whole share to start, at Robinhood's live price of ${money(limitPrice)}. Change the shares and the limit price below.`];
  if (side === 'sell') why.push(`The Agentic account holds ${c.held} share(s) of ${c.symbol}.`);
  return { action, order: { symbol: c.symbol, side, quantity: 1, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
}

/** Every check an order must pass before it may be reviewed (and, later, placed). The page shows each one. */
export function check(o: Order, c: TicketContext, t: Trading, caps: Caps): Check[] {
  const out: Check[] = [], coin = isCrypto(o.symbol);
  const add = (ok: boolean, words: string) => out.push({ ok, words });
  if (coin) {
    const steps = o.quantity * COIN_STEP, ok = Number.isFinite(o.quantity) && o.quantity > 0 && o.quantity <= 100_000 && Math.abs(steps - Math.round(steps)) < 1e-6;
    add(ok, ok ? `${units(o.quantity, true)} of ${o.symbol}` : 'The quantity must be above zero, to at most six decimal places');
  } else add(Number.isInteger(o.quantity) && o.quantity >= 1 && o.quantity <= 100_000, Number.isInteger(o.quantity) && o.quantity >= 1 ? `${o.quantity} whole share(s)` : 'The quantity must be a whole number of shares, at least one');
  const priceOk = Number.isFinite(o.limitPrice) && o.limitPrice > 0 && cents(o.limitPrice) === o.limitPrice;
  add(priceOk, priceOk ? `Limit price ${money(o.limitPrice)}` : 'The limit price must be above zero, in dollars and cents');
  if (!out.every((x) => x.ok)) return out;
  if (c.price !== null && c.price > 0) {
    const off = Math.abs(o.limitPrice / c.price - 1) * 100;
    add(off <= 10, off <= 10 ? `${off.toFixed(1)}% from Robinhood's live price` : `${off.toFixed(1)}% from Robinhood's live price of ${money(c.price)}: more than 10% away, which looks like a typing slip`);
  } else add(false, `Robinhood gave no live price for ${o.symbol} to check the limit against`);
  const cost = cents(o.quantity * o.limitPrice);
  if (o.side === 'buy') {
    add(cost <= caps.perOrderUsd, cost <= caps.perOrderUsd ? `${money(cost)} is within your cap of ${money(caps.perOrderUsd)} an order` : `${money(cost)} is over your cap of ${money(caps.perOrderUsd)} an order`);
    if (c.buyingPower === null) add(false, 'Robinhood gave no buying power for the Agentic account');
    else add(cost <= c.buyingPower, cost <= c.buyingPower ? `Buying power ${money(c.buyingPower)} covers it` : `Buying power is ${money(c.buyingPower)}: not enough`);
    if (c.accountValue === null || c.accountValue <= 0) add(false, 'Robinhood gave no total value for the Agentic account to check your per-stock cap');
    else {
      const after = ((c.held + o.quantity) * o.limitPrice / c.accountValue) * 100;
      add(after <= caps.perStockPercent, `${o.symbol} would be ${after.toFixed(1)}% of the account; your cap is ${caps.perStockPercent}%`);
      if (coin) {
        // Crypto has a limit of its own, in place of a sector's.
        const inCrypto = (((c.cryptoHeldUsd ?? 0) + cost) / c.accountValue) * 100;
        add(inCrypto <= caps.cryptoPercent + 1e-9, `Crypto would be ${inCrypto.toFixed(1)}% of the account; your limit is ${caps.cryptoPercent}%`);
      } else {
        // The sector limit: a whole-market fund is in no sector; a stock whose sector is not known counts as one of its own.
        const s = c.sector ?? { name: `own:${o.symbol}`, label: 'not known, so counted as a sector of its own', heldUsd: c.held * o.limitPrice };
        if (s.name === null) add(true, `${o.symbol} is a whole-market fund: it counts towards no sector`);
        else {
          const inSector = ((s.heldUsd + cost) / c.accountValue) * 100;
          add(inSector <= caps.perSectorPercent, `${s.label === '' ? 'Its sector' : `Sector ${s.label}`} would be ${inSector.toFixed(1)}% of the account; your limit is ${caps.perSectorPercent}%`);
        }
      }
    }
  } else {
    add(o.quantity <= c.held, o.quantity <= c.held ? `Selling ${o.quantity} of the ${c.held} held` : `Only ${units(c.held, coin)} are held in the Agentic account`);
    if (early(c, caps)) out.push({ ok: true, ask: true, words: `${o.symbol} was bought here on ${c.boughtOn}, ${c.heldDays} trading day(s) ago, under your shortest hold of ${caps.minHoldDays}: selling it now takes one more press` });
  }
  add(c.ordersToday < caps.ordersPerDay, `${c.ordersToday} of your ${caps.ordersPerDay} orders a day used`);
  return out;
}

export const passes = (checks: Check[]): boolean => checks.length > 0 && checks.every((x) => x.ok);
