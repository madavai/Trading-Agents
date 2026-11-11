// The order ticket: what one of the desk's calls asks of the Agentic account, sized by the person's settings and checked
// against their caps, before anything is sent to Robinhood. Pure arithmetic on real figures (the account's value, buying
// power and holdings as Robinhood gave them, Robinhood's live price): when a figure is missing the ticket says so and
// proposes nothing, it never guesses. A ticket is a limit order of whole shares whenever whole shares do the job. When
// they cannot (one share costs more than the order may spend, or what is to be sold is less than one share or has a
// part of one), it is a part-share, which Robinhood takes only as a market order in regular hours: a buy as a dollar
// amount, a sell as shares to six decimal places (Robinhood's rules for its stock order tools, `discover --full`).
// A coin (Bitcoin or Ether) is a limit order in coins, at any hour, which Robinhood keeps until it fills or the person
// cancels it, for at most 90 days: on a real ticket its amount and price follow the coin's own steps as Robinhood gives
// them (its coin order tools reject any other), on paper six decimal places and cents; always within the crypto limit,
// counting the coin buys not yet filled.
import type { Action, Caps, Trading } from '../settings.js';
import { cryptoBase, isCrypto } from '../data/symbols.js';

/** Crypto and part-shares are counted to six decimal places (0.006123 BTC-USD, 0.770594 of a share), and an order is at
 *  least a dollar, as Robinhood's are. */
const COIN_STEP = 1e6, MIN_COIN_USD = 1;
/** The smallest part-share order: Robinhood does not say one, and its own check refuses what it will not take. */
export const MIN_PART_USD = 1;
/** New York's regular session, the only time Robinhood takes a part-share order. */
export const PART_HOURS = '9:30 a.m. to 4 p.m. New York time';
const downToStep = (n: number): number => Math.floor(n * COIN_STEP + 1e-6) / COIN_STEP;
const inSteps = (n: number): boolean => Number.isFinite(n) && Math.abs(n * COIN_STEP - Math.round(n * COIN_STEP)) < 1e-6;
const units = (n: number, coin: boolean): string => (coin ? `${n} unit(s)` : `${n} share(s)`);
/** Why a part-share is a market order, said on every ticket that proposes one. */
const MARKET_WHY = `A part-share is a market order: Robinhood takes no limit price for it, so it fills at the market's price at that moment, and Robinhood's check shows only an estimate. It is sent only while the US market is open, ${PART_HOURS}.`;
/** The coins a ticket may trade, to start: Bitcoin and Ether, each also checked live against Robinhood's list of coins. */
export const TICKET_COINS: ReadonlySet<string> = new Set(['BTC-USD', 'ETH-USD']);
/** What a real coin order is, said on every coin ticket (Robinhood: a coin limit order is "good till canceled", for 90 days). */
export const COIN_WHY = "A coin order is a limit order: it fills at your price or better, at any hour, and stays open until it fills or you cancel it in Robinhood's app, for at most 90 days. Coin prices can move fast, at night and at weekends too.";

/** Whether `n` is a whole number of `step`s, within the noise of a computer's fractions. */
export const onStep = (n: number, step: number): boolean => Number.isFinite(n) && step > 0 && Math.abs(n / step - Math.round(n / step)) < 1e-6;
/** How many decimal places a step has: 0.01 has 2, 0.00000001 has 8, 1 has 0. */
export function placesOf(step: number): number {
  const s = step.toString(), e = /e-(\d+)$/.exec(s);
  if (e) return Number(e[1]) + ((s.split('e')[0]!.split('.')[1] ?? '').length);
  return (s.split('.')[1] ?? '').length;
}
/** A coin amount in plain digits (never 1e-7), to its step's places, without trailing zeros: 0.00001031. */
export const coinAmount = (n: number, step = 1e-8): string => n.toFixed(Math.min(placesOf(step), 18)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
/** A number put on a step: down, up or to the nearest, written to the step's places so no fraction noise is left. */
const toStep = (n: number, step: number, way: 'down' | 'up' | 'near'): number => {
  const k = way === 'down' ? Math.floor(n / step + 1e-9) : way === 'up' ? Math.ceil(n / step - 1e-9) : Math.round(n / step);
  return Number((k * step).toFixed(Math.min(placesOf(step), 18)));
};
/** A coin's steps: on a real ticket its own rules from Robinhood; on paper, six decimal places, cents and no bounds. */
export const stepsOf = (c: TicketContext): { q: number; p: number; min: number; max: number } => {
  const r = c.coin?.rules;
  return { q: r?.quantityStep ?? 1 / COIN_STEP, p: r?.priceStep ?? 0.01, min: r?.minQuantity ?? 0, max: r?.maxQuantity ?? 100_000 };
};
/** A coin amount in Robinhood's way of saying it: "0.00001031 BTC", never shares. */
const coinWords = (n: number, symbol: string, step?: number): string => `${coinAmount(n, step ?? 1e-8)} ${cryptoBase(symbol) ?? symbol}`;

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
  /** The stock's sector and how much of the account is already in it (orders not yet filled included), for the sector
   *  limit. name null: a whole-market fund, in no sector. Absent: not known, so the stock counts as a sector of its own.
   *  unpriced: holdings in the sector Robinhood gave no live price for, so the limit cannot be checked. */
  sector?: { name: string | null; label: string; heldUsd: number; openUsd?: number; unpriced?: string[] };
  /** Shares of this stock in the Agentic account's orders not yet filled: a buy counts towards the per-stock cap as if
   *  filled, a sell has already promised what it sells. */
  open?: { buy: number; sell: number };
  /** Orders Robinhood listed that could not be read well enough to tell whether they are still open: the caps cannot be checked. */
  unreadOrders?: number;
  /** Every open buy of the Agentic account, at its own limit price (else the live one), for the sector limit. */
  openBuys?: Array<{ symbol: string; quantity: number; price: number | null }>;
  /** How much of the account is already in crypto, for the crypto limit. */
  cryptoHeldUsd?: number;
  /** When this stock was last bought here, and how many trading days ago, for the shortest hold. Absent: not bought here. */
  boughtOn?: string; heldDays?: number;
  /** What the Agentic account holds, at Robinhood's live prices, for the sector and crypto limits. */
  positions?: Array<{ symbol: string; quantity: number; price: number | null }>;
  /** Whether New York's regular session is open now and, when it is not, when it opens next (in words), for a
   *  part-share. Absent on paper, which fills at a close. */
  session?: { open: boolean; opens: string };
  /** A real coin ticket's facts from Robinhood (absent on paper): the coin's own order rules, or why no coin order can be
   *  had now (not tradable, halted, no crypto account open...); what the account's open coin buys still wait to spend,
   *  already counted in `cryptoHeldUsd`; and why the crypto limit cannot be checked, when it cannot (a coin held with no
   *  live price, a holding that could not be read), in words. */
  coin?: { rules: CoinRules | null; unusable?: string; openUsd?: number; unchecked?: string[] };
}

/** A coin's own order rules on Robinhood (get_currency_pairs): the step an amount must be a whole number of, the step a
 *  price must be, and the least and the most one order may be, in coins. */
export interface CoinRules { quantityStep: number; priceStep: number; minQuantity: number; maxQuantity: number }

export type Side = 'buy' | 'sell';
export interface Order {
  symbol: string; side: Side;
  /** Whole shares for a limit order; for a part-share, shares to six decimal places (a buy's: an estimate at the live price). */
  quantity: number;
  /** A limit order's price. A part-share's: Robinhood's live price when the ticket was made, an estimate, never sent. */
  limitPrice: number;
  timeInForce: 'gfd' | 'gtc';
  /** A part-share: a market order in regular hours, the only way Robinhood takes one. */
  market?: true;
  /** A part-share buy's dollar amount, in dollars and cents: what is sent, and what the caps are checked on. */
  dollars?: number;
}
/** ask: it passes, but the person presses once more before Review (selling a stock bought here under the shortest hold). */
export interface Check { ok: boolean; words: string; ask?: true }
/** Under the shortest hold: a stock bought here fewer trading days ago than the person's limit. */
export const early = (c: TicketContext, caps: Caps): boolean => c.heldDays !== undefined && c.heldDays < caps.minHoldDays;
/** What a ticket proposes: from a call, the action its rating asks in the person's settings; from the person, their own. */
export type OwnAction = 'your own buy' | 'your own sell';
export interface Proposal { action: Action | OwnAction; order: Order | null; why: string[] }

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n: number) => Math.round(n * 100) / 100;
const marketSell = (symbol: string, quantity: number, price: number): Order => ({ symbol, side: 'sell', quantity, limitPrice: price, timeInForce: 'gfd', market: true });
const marketBuy = (symbol: string, dollars: number, price: number): Order => ({ symbol, side: 'buy', quantity: downToStep(dollars / price), limitPrice: price, timeInForce: 'gfd', market: true, dollars });

/** What the rating asks, in the person's own settings. */
export const actionOf = (rating: string, t: Trading): Action => t.ratingToOrder[rating] ?? 'no order';

/** `caps` are the person's own, read beside the trading switch (never from the project's settings file). */
export function propose(c: TicketContext, t: Trading, caps: Caps): Proposal {
  const action = actionOf(c.rating, t), why: string[] = [], coin = isCrypto(c.symbol);
  const none = (reason: string): Proposal => ({ action, order: null, why: [...why, reason] });
  if (action === 'no order') return none(`The desk rated ${c.symbol} ${c.rating}: your settings place no order for that rating.`);
  if (coin && c.coin?.unusable) return none(c.coin.unusable);
  if (c.price === null || c.price <= 0) return none(`Robinhood gave no live price for ${c.symbol}, so no order can be sized.`);
  const s = stepsOf(c), real = coin && c.coin !== undefined;
  const limitPrice = coin ? toStep(c.price, s.p, 'near') : cents(c.price), limitWhy = `Limit price: Robinhood's live price, ${money(limitPrice)}. You can change it.`;

  if (action === 'sell half of what is held' || action === 'sell everything held') {
    if (c.held <= 0) return none(`The desk rated ${c.symbol} ${c.rating}, but the Agentic account holds none to sell.`);
    if (early(c, caps)) return none(`${c.symbol} was bought here on ${c.boughtOn}, ${c.heldDays} trading day(s) ago: your shortest hold is ${caps.minHoldDays}, so the desk proposes no sell yet.`);
    const all = action === 'sell everything held';
    if (coin) {
      // On the coin's own step, and at least the least Robinhood takes for it.
      const quantity = toStep(all ? c.held : c.held / 2, s.q, 'down');
      if (quantity <= 0 || quantity < s.min * (1 - 1e-9)) return none(`${coinWords(c.held, c.symbol, s.q)} is held; ${all ? 'that' : 'half of that'} is less than the smallest order Robinhood takes for it, ${coinWords(Math.max(s.min, s.q), c.symbol, s.q)}.`);
      why.push(limitWhy, `${all ? 'Everything held' : 'Half of what is held'}: ${coinWords(quantity, c.symbol, s.q)} of ${coinWords(c.held, c.symbol, s.q)}.`, ...(real ? [COIN_WHY] : []));
      return { action, order: { symbol: c.symbol, side: 'sell', quantity: Math.min(quantity, s.max), limitPrice, timeInForce: 'gtc' }, why };
    }
    // Whole shares when they do the job; a part-share when everything held has a part of a share in it, or when half of
    // what is held is less than one share.
    const whole = Math.floor(all ? c.held : c.held / 2);
    if (all ? !Number.isInteger(c.held) : whole < 1) {
      const quantity = all ? downToStep(c.held) : downToStep(c.held / 2), worth = quantity * limitPrice;
      if (quantity <= 0) return none(`${units(c.held, false)} of ${c.symbol} are held; half of that is less than the smallest step of 0.000001 of a share.`);
      if (!all && worth < MIN_PART_USD) return none(`Half of the ${units(c.held, false)} held is worth about ${money(worth)}, under ${money(MIN_PART_USD)}, the smallest part-share order.`);
      why.push(all ? `Everything held: ${units(quantity, false)}, a part of a share included, so a part-share sold at the market price, about ${money(cents(worth))} now.`
        : `Half of what is held: ${quantity} of ${units(c.held, false)}, less than one whole share, so a part-share sold at the market price, about ${money(cents(worth))} now.`, MARKET_WHY);
      return { action, order: marketSell(c.symbol, quantity, limitPrice), why };
    }
    why.push(limitWhy, `${all ? 'Everything held' : 'Half of what is held'}: ${whole} of ${units(c.held, false)}, whole shares.`);
    return { action, order: { symbol: c.symbol, side: 'sell', quantity: whole, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
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
    if (c.coin?.unchecked?.length) return none(`Your crypto limit cannot be checked: ${c.coin.unchecked.join('; ')}.`);
    // What is in crypto already counts the coin buys not yet filled, as if they had filled.
    const room = Math.max(0, Math.floor(((c.accountValue * caps.cryptoPercent) / 100 - (c.cryptoHeldUsd ?? 0)) * 100) / 100);
    if (amount > room) {
      const open = c.coin?.openUsd ?? 0, held = cents(Math.max(0, (c.cryptoHeldUsd ?? 0) - open));
      amount = room;
      why.push(`Your crypto limit of ${caps.cryptoPercent}% of the account leaves ${money(room)}${open ? `, counting ${held > 0 ? `${money(held)} held and ` : ''}${money(cents(open))} in coin buys not yet filled` : ''}, so at most that.`);
    }
    if (amount < MIN_COIN_USD) return none(`${money(amount)} is under ${money(MIN_COIN_USD)}, the smallest crypto order.`);
    let quantity = toStep(amount / limitPrice, s.q, 'down');
    if (quantity <= 0 || quantity < s.min * (1 - 1e-9)) return none(`${money(amount)} buys ${coinWords(quantity, c.symbol, s.q)} at ${money(limitPrice)}, less than the smallest order Robinhood takes for it, ${coinWords(Math.max(s.min, s.q), c.symbol, s.q)}.`);
    why.unshift(limitWhy);
    why.push(`${money(amount)} ÷ ${money(limitPrice)}, rounded down to ${real ? `${c.symbol}'s step of ${coinWords(s.q, c.symbol, s.q)}` : 'six decimal places'}: ${coinWords(quantity, c.symbol, s.q)}.`);
    if (quantity > s.max) { quantity = toStep(s.max, s.q, 'down'); why.push(`The most Robinhood takes in one order is ${coinWords(s.max, c.symbol, s.q)}, so that.`); }
    if (real) why.push(COIN_WHY);
    return { action, order: { symbol: c.symbol, side: 'buy', quantity, limitPrice, timeInForce: 'gtc' }, why };
  }
  if (amount < limitPrice) {
    // One whole share costs more than this order may spend: a part of one, as a dollar amount at the market price.
    const dollars = Math.floor(amount * 100 + 1e-6) / 100;
    if (dollars < MIN_PART_USD) return none(`${money(dollars)} is under ${money(MIN_PART_USD)}, the smallest part-share order.`);
    const order = marketBuy(c.symbol, dollars, limitPrice);
    why.push(`One share costs ${money(limitPrice)}, more than ${money(amount)}, so a part of a share: ${money(dollars)} of ${c.symbol}, about ${order.quantity} of a share at Robinhood's live price.`, MARKET_WHY);
    return { action, order, why };
  }
  const quantity = Math.floor(amount / limitPrice);
  why.unshift(limitWhy);
  why.push(`${money(amount)} ÷ ${money(limitPrice)}, rounded down: ${quantity} share(s).`);
  return { action, order: { symbol: c.symbol, side: 'buy', quantity, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
}

/** A ticket the person opens themselves, for one stock and one side, not from a call, in the Agentic account only, and
 *  then exactly the checks, the review and the Confirm of a call's ticket. Nothing is sized for them: the smallest order
 *  is where a person's own order begins. One whole share at Robinhood's live price (they change both), or, when one
 *  share costs more than their cap or the buying power, a part-share of the smallest amount; a sell of less than one
 *  share held sells it all, as a part-share. They can switch between whole shares and a part-share on the ticket. */
export function proposeOwn(c: TicketContext, side: Side, t: Trading, caps: Caps): Proposal {
  const action: OwnAction = side === 'buy' ? 'your own buy' : 'your own sell';
  const none = (reason: string): Proposal => ({ action, order: null, why: [reason] });
  if (isCrypto(c.symbol) && c.coin?.unusable) return none(c.coin.unusable);
  if (c.price === null || c.price <= 0) return none(`Robinhood gave no live price for ${c.symbol}, so no order can be priced.`);
  if (side === 'sell' && c.held <= 0) return none(`The Agentic account holds no ${c.symbol} to sell.`);
  if (isCrypto(c.symbol)) {
    // A coin starts at the smallest order worth a dollar or more, on its own step and at least its least; a sell at no more
    // than what is held. The person types the amount in coins and sees its dollar value beside it.
    const s = stepsOf(c), price = toStep(c.price, s.p, 'near');
    let q = Math.max(s.min, toStep(MIN_COIN_USD / price, s.q, 'up'));
    if (side === 'sell' && q > c.held) q = toStep(c.held, s.q, 'down');
    if (!(q > 0) || q < s.min * (1 - 1e-9)) return none(`The Agentic account holds ${coinWords(c.held, c.symbol, s.q)}, less than the smallest order Robinhood takes for it, ${coinWords(Math.max(s.min, s.q), c.symbol, s.q)}.`);
    const why = [`Your own order: ${coinWords(q, c.symbol, s.q)} to start, about ${money(cents(q * price))} at Robinhood's live price of ${money(price)}. Change the amount and the limit price below.`];
    if (side === 'sell') why.push(`The Agentic account holds ${coinWords(c.held, c.symbol, s.q)}.`);
    if (c.coin) why.push(COIN_WHY);
    return { action, order: { symbol: c.symbol, side, quantity: q, limitPrice: price, timeInForce: 'gtc' }, why };
  }
  const limitPrice = cents(c.price);
  if (side === 'sell' && c.held < 1) {
    return { action, order: marketSell(c.symbol, downToStep(c.held), limitPrice), why: [`Your own order: the Agentic account holds ${c.held} of a share of ${c.symbol}, so it sells all of it, a part-share at the market price.`, MARKET_WHY] };
  }
  if (side === 'buy' && (limitPrice > caps.perOrderUsd || (c.buyingPower !== null && limitPrice > c.buyingPower))) {
    const over = limitPrice > caps.perOrderUsd ? `your cap of ${money(caps.perOrderUsd)} an order` : `the buying power of ${money(c.buyingPower!)}`;
    return { action, order: marketBuy(c.symbol, MIN_PART_USD, limitPrice), why: [`Your own order: one share of ${c.symbol} costs ${money(limitPrice)}, more than ${over}, so it starts as a part-share of ${money(MIN_PART_USD)} at the market price. Change the dollar amount below.`, MARKET_WHY] };
  }
  const why = [`Your own order: one whole share to start, at Robinhood's live price of ${money(limitPrice)}. Change the shares and the limit price below.`];
  if (side === 'sell') why.push(`The Agentic account holds ${c.held} share(s) of ${c.symbol}.`);
  return { action, order: { symbol: c.symbol, side, quantity: 1, limitPrice, timeInForce: t.orderDefaults.timeInForce }, why };
}

/** The person's change to a ticket: how many whole shares and their limit price, or a part-share at the market price (a
 *  buy as a dollar amount, a sell as shares to six decimal places), switching between the two as they like. Never the
 *  stock, the side or the account. A part-share's price is Robinhood's live one, an estimate; crypto stays a limit order. */
export function edit(base: Order, c: TicketContext, t: Trading, e: Record<string, unknown>): Order {
  const num = (v: unknown): number => (typeof v === 'number' ? v : NaN), { symbol, side } = base;
  if (e.market === true && !isCrypto(symbol)) {
    const price = c.price !== null && c.price > 0 ? cents(c.price) : NaN;
    if (side === 'buy') {
      const dollars = num(e.dollars);
      return { symbol, side, quantity: price > 0 && dollars > 0 ? downToStep(dollars / price) : NaN, limitPrice: price, timeInForce: 'gfd', market: true, dollars };
    }
    return { symbol, side, quantity: num(e.quantity), limitPrice: price, timeInForce: 'gfd', market: true };
  }
  return { symbol, side, quantity: num(e.quantity), limitPrice: num(e.limitPrice), timeInForce: base.market ? t.orderDefaults.timeInForce : base.timeInForce };
}

/** Every check an order must pass before it may be reviewed (and, later, placed). The page shows each one. */
export function check(o: Order, c: TicketContext, t: Trading, caps: Caps): Check[] {
  const out: Check[] = [], coin = isCrypto(o.symbol), market = o.market === true;
  const add = (ok: boolean, words: string) => out.push({ ok, words });
  if (market) {
    // A part-share: Robinhood takes it only at the market price, in regular hours, to six decimal places of a share.
    const qOk = !coin && inSteps(o.quantity) && o.quantity > 0 && o.quantity <= 100_000;
    if (coin) add(false, `${o.symbol} is crypto: the desk sizes it at a limit price, never at the market price`);
    else if (o.side === 'buy') {
      const d = o.dollars, ok = qOk && typeof d === 'number' && Number.isFinite(d) && cents(d) === d && d >= MIN_PART_USD;
      add(ok, ok ? `${money(d!)} of ${o.symbol}, about ${o.quantity} of a share at Robinhood's live price` : `A part-share is bought as a dollar amount in dollars and cents, at least ${money(MIN_PART_USD)}`);
    } else add(qOk, qOk ? `${units(o.quantity, false)} of ${o.symbol}` : 'The quantity must be above zero, to at most six decimal places');
    if (!out.every((x) => x.ok)) return out;
    if (c.price !== null && c.price > 0) {
      add(true, `A market order: it fills at the market's price at that moment, about ${money(c.price)} a share now; Robinhood's check shows only an estimate`);
      const worth = o.quantity * c.price;
      if (o.side === 'sell' && worth < MIN_PART_USD && Math.abs(o.quantity - c.held) > 1e-9) add(false, `About ${money(worth)}: a part-share order is at least ${money(MIN_PART_USD)}, unless it sells everything held`);
    } else add(false, `Robinhood gave no live price for ${o.symbol} to estimate the order with`);
    if (c.session) add(c.session.open, c.session.open ? 'The US market is open, so a part-share can be sent now' : `A part-share is sent only while the US market is open, ${PART_HOURS}: it opens ${c.session.opens}`);
  } else {
    const s = stepsOf(c);
    if (coin) {
      // On a real ticket, Robinhood's own rules for the coin: a whole number of its step, from its least to its most.
      if (c.coin?.unusable) add(false, c.coin.unusable.replace(/\.$/, ''));
      const ok = o.quantity > 0 && onStep(o.quantity, s.q) && o.quantity >= s.min * (1 - 1e-9) && o.quantity <= s.max * (1 + 1e-9);
      const base = cryptoBase(o.symbol) ?? o.symbol;
      add(ok, ok ? coinWords(o.quantity, o.symbol, s.q) : c.coin?.rules ? `The amount must be in steps of ${coinAmount(s.q, s.q)} ${base}, from ${coinAmount(Math.max(s.min, s.q), s.q)} to ${coinAmount(s.max, s.q)} ${base} (Robinhood's rules for ${o.symbol})` : 'The quantity must be above zero, to at most six decimal places');
    } else add(Number.isInteger(o.quantity) && o.quantity >= 1 && o.quantity <= 100_000, Number.isInteger(o.quantity) && o.quantity >= 1 ? `${o.quantity} whole share(s)` : 'The quantity must be a whole number of shares, at least one (or choose a part-share at the market price)');
    const priceOk = Number.isFinite(o.limitPrice) && o.limitPrice > 0 && (coin ? onStep(o.limitPrice, s.p) : cents(o.limitPrice) === o.limitPrice);
    add(priceOk, priceOk ? `Limit price ${money(o.limitPrice)}` : coin && s.p !== 0.01 ? `The limit price must be above zero, in steps of $${coinAmount(s.p, s.p)}` : 'The limit price must be above zero, in dollars and cents');
    if (!out.every((x) => x.ok)) return out;
    if (c.price !== null && c.price > 0) {
      const off = Math.abs(o.limitPrice / c.price - 1) * 100;
      add(off <= 10, off <= 10 ? `${off.toFixed(1)}% from Robinhood's live price` : `${off.toFixed(1)}% from Robinhood's live price of ${money(c.price)}: more than 10% away, which looks like a typing slip`);
    } else add(false, `Robinhood gave no live price for ${o.symbol} to check the limit against`);
    if (coin && c.coin) add(true, "Coins trade at any hour, so this can be sent now; it stays open until it fills or you cancel it in Robinhood's app, for at most 90 days");
  }
  // What a share is counted at: its limit price, or for a part-share the live price; and what the order costs, a
  // part-share buy's own dollar amount.
  const per = market && c.price !== null && c.price > 0 ? c.price : o.limitPrice;
  const cost = cents(market && o.side === 'buy' ? o.dollars! : o.quantity * per);
  if (o.side === 'buy') {
    add(cost <= caps.perOrderUsd, cost <= caps.perOrderUsd ? `${money(cost)} is within your cap of ${money(caps.perOrderUsd)} an order` : `${money(cost)} is over your cap of ${money(caps.perOrderUsd)} an order`);
    if (c.buyingPower === null) add(false, 'Robinhood gave no buying power for the Agentic account');
    else add(cost <= c.buyingPower, cost <= c.buyingPower ? `Buying power ${money(c.buyingPower)} covers it` : `Buying power is ${money(c.buyingPower)}: not enough`);
    if (c.accountValue === null || c.accountValue <= 0) add(false, 'Robinhood gave no total value for the Agentic account to check your per-stock cap');
    else if (c.unreadOrders) add(false, coin ? 'Robinhood listed open coin orders that could not all be read, so your per-coin and crypto caps cannot be checked'
      : `Robinhood listed ${c.unreadOrders} order(s) whose stock, side, size or state could not be read, so your per-stock and sector caps cannot be checked`);
    else {
      const waiting = c.open?.buy ?? 0, after = (((c.held + waiting) * per + cost) / c.accountValue) * 100;
      add(after <= caps.perStockPercent, `${o.symbol} would be ${after.toFixed(1)}% of the account${waiting ? `, counting ${coin ? coinWords(waiting, o.symbol) : `${waiting} share(s)`} in orders not yet filled` : ''}; your cap is ${caps.perStockPercent}%`);
      if (coin) {
        // Crypto has a limit of its own, in place of a sector's; the coin buys not yet filled count as if they had filled.
        if (c.coin?.unchecked?.length) add(false, `Crypto cannot be checked against your limit of ${caps.cryptoPercent}%: ${c.coin.unchecked.join('; ')}`);
        else {
          const inCrypto = (((c.cryptoHeldUsd ?? 0) + cost) / c.accountValue) * 100;
          const open = c.coin?.openUsd ?? 0, held = cents(Math.max(0, (c.cryptoHeldUsd ?? 0) - open));
          add(inCrypto <= caps.cryptoPercent + 1e-9, `Crypto would be ${inCrypto.toFixed(1)}% of the account${open ? `, counting ${held > 0 ? `${money(held)} held and ` : ''}${money(cents(open))} in coin buys not yet filled` : ''}; your limit is ${caps.cryptoPercent}%`);
        }
      } else {
        // The sector limit: a whole-market fund is in no sector; a stock whose sector is not known counts as one of its own.
        const s = c.sector ?? { name: `own:${o.symbol}`, label: 'not known, so counted as a sector of its own', heldUsd: c.held * per };
        const named = s.label === '' ? 'Its sector' : `Sector ${s.label}`;
        if (s.name === null) add(true, `${o.symbol} is a whole-market fund: it counts towards no sector`);
        else if (s.unpriced?.length) add(false, `${named} cannot be checked against your limit of ${caps.perSectorPercent}%: Robinhood gave no live price for ${s.unpriced.join(', ')}, held in the account`);
        else {
          const inSector = ((s.heldUsd + cost) / c.accountValue) * 100;
          add(inSector <= caps.perSectorPercent, `${named} would be ${inSector.toFixed(1)}% of the account${s.openUsd ? ', counting orders not yet filled' : ''}; your limit is ${caps.perSectorPercent}%`);
        }
      }
    }
  } else {
    const promised = c.open?.sell ?? 0, free = c.held - promised;
    const n = (x: number): string => (coin ? coinAmount(x) : String(x));   // a coin amount in plain digits, never 1e-7
    if (promised) add(o.quantity <= free + 1e-9, o.quantity <= free + 1e-9 ? `Selling ${n(o.quantity)} of the ${n(c.held)} held, ${n(promised)} more already in sell orders not yet filled` : `Only ${n(Math.max(0, free))} of the ${n(c.held)} held can be sold: ${n(promised)} are in sell orders not yet filled`);
    else add(o.quantity <= c.held + 1e-9, o.quantity <= c.held + 1e-9 ? `Selling ${n(o.quantity)} of the ${n(c.held)} held` : coin ? `Only ${coinWords(c.held, o.symbol)} is held in the Agentic account` : `Only ${units(c.held, false)} are held in the Agentic account`);
    if (early(c, caps)) out.push({ ok: true, ask: true, words: `${o.symbol} was bought here on ${c.boughtOn}, ${c.heldDays} trading day(s) ago, under your shortest hold of ${caps.minHoldDays}: selling it now takes one more press` });
  }
  add(c.ordersToday < caps.ordersPerDay, `${c.ordersToday} of your ${caps.ordersPerDay} orders a day used`);
  return out;
}

export const passes = (checks: Check[]): boolean => checks.length > 0 && checks.every((x) => x.ok);
