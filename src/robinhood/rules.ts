// What a Robinhood tool is, told only by its name and its own labels. Pure: nothing here talks to Robinhood. The desk
// reads with the "read" kind; of the "order" kind the dashboard calls only Robinhood's dry run (review.ts) and the order
// itself (order.ts), each on the person's own press; the rest are counted and shown, never called. No agent gets any.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Order } from '../desk/ticket.js';

/** A tool whose name speaks of trading or moving money - orders (reviews included), trades, buying, selling,
 *  transfers. The same rule as TRADE_WORDS in .claude/hooks/guard.mjs (a test keeps them in step). */
export const TRADE_WORDS = /order|trade|buy|sell|liquidat|close.?position|transfer|withdraw|deposit|payment/i;
export const isOrderTool = (name: string): boolean => TRADE_WORDS.test(name);

/** A name that asks for something and changes nothing. */
const READ_NAME = /^(get|list|search|find|view|fetch|read)_/i;

/** read: labelled read-only by Robinhood and named like a read. order: its name speaks of trading or moving money, whatever
 *  its label says. other: anything else (not labelled read-only, or named like something that changes). Only "read" is ever called. */
export type Kind = 'read' | 'order' | 'other';

/** Reads whose names speak of orders or trades, each checked by hand against Robinhood's own description of it
 *  (`discover`, 14 Oct 2026): order history, pending phone approvals, whether approvals are on, realised trades. Each is
 *  a read only while Robinhood also labels it read-only; a name not on this list that speaks of orders never is. */
export const NAMED_READS: ReadonlySet<string> = new Set(['get_equity_orders', 'get_option_orders', 'get_crypto_orders', 'get_trade_approvals', 'get_trade_approval_setting', 'get_pnl_trade_history']);

export function kindOf(tool: Pick<Tool, 'name' | 'annotations'>): Kind {
  if (NAMED_READS.has(tool.name)) return tool.annotations?.readOnlyHint === true ? 'read' : 'order';
  if (isOrderTool(tool.name)) return 'order';
  return tool.annotations?.readOnlyHint === true && READ_NAME.test(tool.name) ? 'read' : 'other';
}

export interface ArgLine { name: string; type: string; required: boolean; note: string }

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; description?: string; properties?: Record<string, Schema> };

function typeOf(s: Schema | undefined): string {
  if (!s) return 'any';
  if (Array.isArray(s.enum)) return `one of ${s.enum.slice(0, 12).map((v) => JSON.stringify(v)).join(' | ')}${s.enum.length > 12 ? ' | ...' : ''}`;
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length) return [...new Set(alt.map(typeOf))].join(' or ');
  if (s.type === 'array') return `list of ${typeOf(s.items)}`;
  if (Array.isArray(s.type)) return s.type.join(' or ');
  return s.type ?? 'any';
}

/** The arguments a tool takes, from its own description of them (names and types: no values). */
/** Each argument a tool takes. `noteMax`: how much of Robinhood's note on it to keep (Infinity: all of it). */
export function argsOf(tool: Pick<Tool, 'inputSchema'>, noteMax = 160): ArgLine[] {
  const schema = tool.inputSchema as { properties?: Record<string, Schema>; required?: string[] };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, s]) => ({ name, type: typeOf(s), required: required.has(name), note: (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, noteMax) }));
}

const labelOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    if (v === '') return 'empty text';
    if (/^-?\d+(\.\d+)?$/.test(v)) return 'text that is a number';
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return 'text that is a date';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'text that is an id';
    return 'text';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'whole number' : 'number';
  return typeof v;
};

const MAX_DEPTH = 8, MAX_KEYS = 60, MAX_ITEMS = 200;

function describe(values: unknown[], words: boolean, depth: number): { head: string; body: string[] } {
  const present = values.filter((v) => v !== undefined);
  const objects = present.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  const lists = present.filter(Array.isArray) as unknown[][];
  const scalars = present.filter((v) => v === null || typeof v !== 'object');
  const heads: string[] = [], body: string[] = [], pad = '  '.repeat(depth + 1);
  if (scalars.length) {
    heads.push([...new Set(scalars.map(labelOf))].join(' or '));
    // Words (status, side, type) are shown only when asked: short lower-case ones, never a ticker, a number or an id.
    const seen = words ? [...new Set(scalars.filter((v): v is string => typeof v === 'string' && /^[a-z][a-z_]{1,23}$/.test(v)))].sort().slice(0, 12) : [];
    if (seen.length) heads[heads.length - 1] += ` (words seen: ${seen.join(', ')})`;
  }
  if (lists.length) {
    const all = lists.flatMap((l) => l.slice(0, MAX_ITEMS));
    heads.push(`list of ${lists.reduce((n, l) => n + l.length, 0)}`);
    if (all.length && depth < MAX_DEPTH) { const inner = describe(all, words, depth + 1); body.push(`${pad}each: ${inner.head}`, ...inner.body); }
  }
  if (objects.length) {
    heads.push('object');
    if (depth < MAX_DEPTH) {
      const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].slice(0, MAX_KEYS);
      for (const k of keys) {
        const inner = describe(objects.map((o) => o[k]), words, depth + 1);
        body.push(`${pad}${k}${objects.some((o) => !(k in o)) ? '?' : ''}: ${inner.head}`, ...inner.body);
      }
    }
  }
  return { head: heads.join(' or ') || 'nothing', body };
}

/** What a tool's answer looks like - its names and kinds of values, never a value itself - so the desk can learn the
 *  shape of Robinhood's answers without anyone pasting a balance or an account number. */
export function shapeLines(value: unknown, words = false): string[] {
  const d = describe([value], words, 0);
  return [`answer: ${d.head}`, ...d.body];
}

const inSixPlaces = (n: number): boolean => Number.isFinite(n) && Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-6;

/** What Robinhood's stock order check and stock order are sent for one of the desk's orders, by Robinhood's own rules for
 *  those two tools (`discover --full`, 11 Nov 2026), or null for an order the desk does not send. A limit order is whole
 *  shares at a price in dollars and cents. A part-share is a market order in regular hours, good for the day: a buy as a
 *  dollar amount (Robinhood works out the shares from its last trade price), a sell as shares to at most six decimal
 *  places. No limit price goes with a market order. */
export function equityOrderArgs(accountNumber: string, o: Order): Record<string, string> | null {
  if (o.side !== 'buy' && o.side !== 'sell') return null;
  const base = { account_number: accountNumber, symbol: o.symbol, side: o.side };
  if (o.market === true) {
    const regular = { type: 'market', time_in_force: 'gfd', market_hours: 'regular_hours' };
    if (o.side === 'buy') {
      const d = o.dollars;
      return typeof d === 'number' && Number.isFinite(d) && d >= 1 && Math.round(d * 100) / 100 === d ? { ...base, ...regular, dollar_amount: d.toFixed(2) } : null;
    }
    return o.quantity > 0 && inSixPlaces(o.quantity) ? { ...base, ...regular, quantity: o.quantity.toFixed(6).replace(/\.?0+$/, '') } : null;
  }
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || !(o.limitPrice > 0)) return null;
  return { ...base, type: 'limit', quantity: String(o.quantity), limit_price: o.limitPrice.toFixed(2), time_in_force: o.timeInForce, market_hours: 'regular_hours' };
}

/** Words on one line, cut to a length. */
export const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 3)}...` : t; };
/** A failure's words, short, with any word holding a long run of digits hidden whole (an account number, which can mix
 *  letters and digits). Dates and prices, with shorter runs, are left as they are. */
export const masked = (s: string): string => oneLine(s, 300).replace(/\b[a-z0-9]*\d{5,}[a-z0-9]*\b/gi, '#####');
/** What the person is told to do when it is not clear whether an order went through: never to send it again blind. */
export const LOOK_FIRST = "Look at the Agentic account's orders in Robinhood's own app before you try again.";
