// What the person holds, as the decision agents see it: positions, average prices and free cash. Three states stay
// distinct and must never blur: a position, a flat book (the person said they hold nothing), and nothing known at all -
// "not provided" must not read as "flat", which would invent a fact about an account the desk was never told about.
// The person gives it in words (set_holdings), or the dashboard fills it in from Robinhood each time it reads the
// accounts the person chose: then each account is listed apart, saying whether the desk may trade in it.
// Adapted from TradingAgents (tradingagents/portfolio.py), Apache License 2.0; rewritten in TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { safeSymbol } from '../data/symbols.js';
import { writeWhole } from './lock.js';

export interface Position { ticker: string; quantity: number; averagePrice?: number }
/** One Robinhood account as the agents see it: a label (never its number), whether the desk may trade in it, and what is in it. */
export interface HeldAccount { label: string; tradable: boolean; cash?: number; buyingPower?: number; currency?: string; positions: Position[] }
export interface Holdings { cash?: number; currency?: string; positions: Position[]; source: 'person' | 'robinhood'; savedOn: string; accounts?: HeldAccount[] }

const file = (dir: string) => path.join(dir, 'holdings.json');
const num = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a number`); return v; };

/** Checks what the person gave and keeps it. An empty list of positions is a flat book. */
export function saveHoldings(dir: string, input: { cash?: number; currency?: string; positions: Array<{ ticker: string; quantity: number; averagePrice?: number }> }, today: string, source: Holdings['source'] = 'person'): Holdings {
  if (input.positions.length > 500) throw new Error('more than 500 positions');
  const seen = new Set<string>();
  const positions = input.positions.map((p) => {
    const ticker = safeSymbol(p.ticker);
    if (seen.has(ticker)) throw new Error(`${ticker} is listed twice: give one total quantity`);
    seen.add(ticker);
    const quantity = num(p.quantity, `the quantity of ${ticker}`);
    if (quantity === 0) throw new Error(`${ticker} has a quantity of 0: leave it out`);
    const averagePrice = p.averagePrice === undefined ? undefined : num(p.averagePrice, `the average price of ${ticker}`);
    if (averagePrice !== undefined && averagePrice <= 0) throw new Error(`the average price of ${ticker} must be above 0`);
    return { ticker, quantity, ...(averagePrice === undefined ? {} : { averagePrice }) };
  });
  const cash = input.cash === undefined ? undefined : num(input.cash, 'cash');
  if (cash !== undefined && cash < 0) throw new Error('cash cannot be negative');
  const currency = input.currency?.trim().toUpperCase();
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new Error(`"${input.currency}" is not a three-letter currency such as USD`);
  const h: Holdings = { ...(cash === undefined ? {} : { cash }), ...(currency ? { currency } : {}), positions, source, savedOn: today };
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(file(dir), JSON.stringify(h, null, 2) + '\n');
  return h;
}

const finite = (v: number | null | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Keeps what the dashboard read from Robinhood. The top-level positions and cash are the tradable account's (the one
 *  the desk may trade); every account is kept apart under accounts. A holding whose symbol the desk cannot use is left out
 *  and counted. Returns how many were left out. */
export function saveAccountHoldings(dir: string, accounts: HeldAccount[], today: string): { saved: Holdings; leftOut: number } {
  let leftOut = 0;
  const clean = accounts.slice(0, 10).map((a) => ({
    label: a.label.slice(0, 60), tradable: a.tradable,
    ...(finite(a.cash) === undefined ? {} : { cash: finite(a.cash) }), ...(finite(a.buyingPower) === undefined ? {} : { buyingPower: finite(a.buyingPower) }),
    ...(a.currency ? { currency: a.currency } : {}),
    positions: a.positions.flatMap((p) => {
      try {
        const ticker = safeSymbol(p.ticker), quantity = finite(p.quantity), averagePrice = finite(p.averagePrice);
        if (!quantity) { leftOut++; return []; }
        return [{ ticker, quantity, ...(averagePrice && averagePrice > 0 ? { averagePrice } : {}) }];
      } catch { leftOut++; return []; }
    }),
  }));
  const tradable = clean.find((a) => a.tradable);
  const saved: Holdings = { positions: tradable?.positions ?? [], ...(tradable?.cash === undefined ? {} : { cash: tradable.cash }), ...(tradable?.currency ? { currency: tradable.currency } : {}), source: 'robinhood', savedOn: today, accounts: clean };
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(file(dir), JSON.stringify(saved, null, 2) + '\n');
  return { saved, leftOut };
}

/** The saved holdings, or null when the person has not said (which is not the same as holding nothing). */
export function readHoldings(dir: string): Holdings | null {
  try {
    const h = JSON.parse(fs.readFileSync(file(dir), 'utf8')) as Holdings;
    return Array.isArray(h.positions) ? h : null;
  } catch { return null; }
}

export function forgetHoldings(dir: string): boolean {
  try { fs.rmSync(file(dir)); return true; } catch { return false; }
}

const n = (v: number) => v.toLocaleString('en-US', { maximumSignificantDigits: 4 });
const m = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The holdings block for the agents, led by the stock being analysed. */
function renderAccounts(h: Holdings, ticker: string): string {
  const lines = (h.accounts ?? []).map((a) => {
    const held = a.positions.find((p) => p.ticker === ticker), others = a.positions.filter((p) => p !== held), cur = a.currency ? ` ${a.currency}` : '';
    const parts = [held ? `position in ${ticker}: ${n(held.quantity)} units${held.averagePrice ? `, average price ${m(held.averagePrice)}` : ''}` : `no position in ${ticker}`];
    if (a.cash !== undefined) parts.push(`cash ${m(a.cash)}${cur}`);
    if (a.buyingPower !== undefined) parts.push(`buying power ${m(a.buyingPower)}${cur}`);
    if (others.length) parts.push(`other positions: ${others.map((p) => `${p.ticker} ${n(p.quantity)}`).join(', ')}`);
    return `- ${a.label} (${a.tradable ? "the only account the desk may trade in, and only on the person's Confirm" : 'view only: the desk never trades in it'}): ${parts.join('; ')}`;
  });
  return `Portfolio as read from Robinhood on ${h.savedOn} (it may have changed since). Size any trade to the tradable account; the other accounts are the rest of the person's holdings, for context only:\n${lines.join('\n')}`;
}

export function renderHoldings(h: Holdings | null, ticker: string): string {
  if (h?.accounts?.length) return renderAccounts(h, ticker);
  if (!h) return 'Portfolio context: not provided. You do not know the person\'s current holdings or cash, so do not assume a flat book; give direction and sizing guidance in terms they can apply to their own position.';
  const held = h.positions.find((p) => p.ticker === ticker);
  const lines = [held ? `- Current position in ${ticker}: ${n(held.quantity)} units${held.averagePrice ? `, average price ${m(held.averagePrice)}` : ''}` : `- No current position in ${ticker}`];
  if (h.cash !== undefined) lines.push(`- Cash available: ${m(h.cash)}${h.currency ? ` ${h.currency}` : ''}`);
  const others = h.positions.filter((p) => p !== held);
  if (others.length) lines.push(`- Other positions: ${others.map((p) => `${p.ticker} ${n(p.quantity)}`).join(', ')}`);
  return `Portfolio as ${h.source === 'robinhood' ? 'read from Robinhood' : 'given by the person'} on ${h.savedOn} (it may have changed since):\n${lines.join('\n')}`;
}
