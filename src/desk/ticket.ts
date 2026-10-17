// The order ticket: what one of the desk's calls asks of the Agentic account, sized by the person's settings and checked
// against their caps, before anything is sent to Robinhood. Pure arithmetic on real figures (the account's value, buying
// power and holdings as Robinhood gave them, Robinhood's live price): when a figure is missing the ticket says so and
// proposes nothing, it never guesses. Limit orders of whole shares only: Robinhood takes fractions on market orders alone.
import type { Action, Trading } from '../settings.js';

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
}

export type Side = 'buy' | 'sell';
export interface Order { symbol: string; side: Side; quantity: number; limitPrice: number; timeInForce: 'gfd' | 'gtc' }
export interface Check { ok: boolean; words: string }
/** What a ticket proposes: from a call, the action its rating asks in the person's settings; from the person, their own. */
export type OwnAction = 'your own buy' | 'your own sell';
export interface Proposal { action: Action | OwnAction; order: Order | null; why: string[] }

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n: number) => Math.round(n * 100) / 100;

/** What the rating asks, in the person's own settings. */
export const actionOf = (rating: string, t: Trading): Action => t.ratingToOrder[rating] ?? 'no order';

export function propose(c: TicketContext, t: Trading): Proposal {
  const action = actionOf(c.rating, t), why: string[] = [];
  const none = (reason: string): Proposal => ({ action, order: null, why: [...why, reason] });
  if (action === 'no order') return none(`The desk rated ${c.symbol} ${c.rating}: your settings place no order for that rating.`);
  if (c.price === null || c.price <= 0) return none(`Robinhood gave no live price for ${c.symbol}, so no order can be sized.`);
  const limitPrice = cents(c.price);
  why.push(`Limit price: Robinhood's live price, ${money(limitPrice)}. You can change it.`);

  if (action === 'sell half of what is held' || action === 'sell everything held') {
    if (c.held <= 0) return none(`The desk rated ${c.symbol} ${c.rating}, but the Agentic account holds none to sell.`);
    const quantity = Math.floor(action === 'sell everything held' ? c.held : c.held / 2);
    if (quantity < 1) return none(`The Agentic account holds ${c.held} share(s); half of that is less than one whole share, and a limit order sells whole shares only.`);
    why.push(`${action === 'sell everything held' ? 'Everything held' : 'Half of what is held'}: ${quantity} of ${c.held} share(s), whole shares only.`);
    return { action, order: { symbol: c.symbol, side: 'sell', quantity, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
  }

  if (c.accountValue === null || c.accountValue <= 0) return none('Robinhood gave no total value for the Agentic account, so a position cannot be sized.');
  if (c.buyingPower === null) return none('Robinhood gave no buying power for the Agentic account, so a buy cannot be sized.');
  const share = action === 'buy a full position' ? t.fullPositionPercent : t.fullPositionPercent / 2;
  const target = (c.accountValue * share) / 100;
  why.push(`${action === 'buy a full position' ? 'A full position' : 'Half a position'}: ${share}% of the account's ${money(c.accountValue)} is ${money(target)}.`);
  let amount = target;
  if (amount > t.caps.perOrderUsd) { amount = t.caps.perOrderUsd; why.push(`Your cap of ${money(t.caps.perOrderUsd)} an order makes it ${money(amount)}.`); }
  if (amount > c.buyingPower) { amount = c.buyingPower; why.push(`Buying power is ${money(c.buyingPower)}, so at most that.`); }
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
export function check(o: Order, c: TicketContext, t: Trading): Check[] {
  const out: Check[] = [];
  const add = (ok: boolean, words: string) => out.push({ ok, words });
  add(Number.isInteger(o.quantity) && o.quantity >= 1 && o.quantity <= 100_000, Number.isInteger(o.quantity) && o.quantity >= 1 ? `${o.quantity} whole share(s)` : 'The quantity must be a whole number of shares, at least one');
  const priceOk = Number.isFinite(o.limitPrice) && o.limitPrice > 0 && cents(o.limitPrice) === o.limitPrice;
  add(priceOk, priceOk ? `Limit price ${money(o.limitPrice)}` : 'The limit price must be above zero, in dollars and cents');
  if (!out.every((x) => x.ok)) return out;
  if (c.price !== null && c.price > 0) {
    const off = Math.abs(o.limitPrice / c.price - 1) * 100;
    add(off <= 10, off <= 10 ? `${off.toFixed(1)}% from Robinhood's live price` : `${off.toFixed(1)}% from Robinhood's live price of ${money(c.price)}: more than 10% away, which looks like a typing slip`);
  } else add(false, `Robinhood gave no live price for ${o.symbol} to check the limit against`);
  const cost = cents(o.quantity * o.limitPrice);
  if (o.side === 'buy') {
    add(cost <= t.caps.perOrderUsd, cost <= t.caps.perOrderUsd ? `${money(cost)} is within your cap of ${money(t.caps.perOrderUsd)} an order` : `${money(cost)} is over your cap of ${money(t.caps.perOrderUsd)} an order`);
    if (c.buyingPower === null) add(false, 'Robinhood gave no buying power for the Agentic account');
    else add(cost <= c.buyingPower, cost <= c.buyingPower ? `Buying power ${money(c.buyingPower)} covers it` : `Buying power is ${money(c.buyingPower)}: not enough`);
    if (c.accountValue === null || c.accountValue <= 0) add(false, 'Robinhood gave no total value for the Agentic account to check your per-stock cap');
    else {
      const after = ((c.held + o.quantity) * o.limitPrice / c.accountValue) * 100;
      add(after <= t.caps.perStockPercent, `${o.symbol} would be ${after.toFixed(1)}% of the account; your cap is ${t.caps.perStockPercent}%`);
    }
  } else add(o.quantity <= c.held, o.quantity <= c.held ? `Selling ${o.quantity} of the ${c.held} held` : `Only ${c.held} share(s) are held in the Agentic account`);
  add(c.ordersToday < t.caps.ordersPerDay, `${c.ordersToday} of your ${t.caps.ordersPerDay} orders a day used`);
  return out;
}

export const passes = (checks: Check[]): boolean => checks.length > 0 && checks.every((x) => x.ok);
