// The third door to Robinhood, the one that can place an order. It names one tool (place_equity_order, a limit order of
// whole shares on the Agentic account) and nothing else; a test checks that, and that the agents' tool server holds no
// trace of it. It is reached only from the dashboard's server, after the person's own Confirm on a ticket that Robinhood
// checked with no alerts, with trading switched on by the person, and after every cap has been checked again on figures
// read from Robinhood just before. Robinhood's own ref_id makes a repeated send of the same ticket place nothing twice.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Order } from '../desk/ticket.js';
import { Refused } from './reader.js';
import { LOOK_FIRST, masked } from './rules.js';

const PLACE = 'place_equity_order';

export interface Placed {
  /** Robinhood took the order: it gave the order's id, and a state that is not a refusal (it may still wait for the
   *  person's approval on their phone). */
  answered: boolean;
  /** No clear answer: Robinhood's answer never arrived, or came without an order id. The order may have gone through. */
  unknown: boolean;
  /** Whether Robinhood will ask the person to approve it on their phone, when it says. */
  approvalRequired: boolean | null;
  /** Robinhood's id for the order and its state, when it gives them. */
  orderId: string | null;
  state: string | null;
  /** The other things Robinhood said, as name and value, at most 24. */
  facts: Array<[string, string]>;
  /** Robinhood's words when it refused, or when it is not clear that it took the order. */
  error: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** A state in which Robinhood will not fill the order. */
const REFUSED = /^(rejected|failed|cancell?ed|expired|voided)$/i;

export function parsePlaced(answer: { data: unknown; text: string; failed: boolean }): Placed {
  if (answer.failed) return { answered: false, unknown: false, approvalRequired: null, orderId: null, state: null, facts: [], error: masked(answer.text) };
  const d = obj(obj(answer.data).data), order = obj(d.order);
  const id = [d.order_id, d.id, order.id, d.approval_id].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const state = [d.state, order.state, d.status].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  // Robinhood's own words: a message in its answer, else the whole answer when it was words and no JSON.
  const said = ([d.reject_reason, order.reject_reason, d.message, d.detail, d.reason].find((v) => typeof v === 'string' && v.trim()) as string | undefined)?.trim()
    ?? (answer.data === null && answer.text.trim() ? answer.text.trim() : undefined);
  const words = said === undefined ? undefined : masked(said).slice(0, 300);
  const facts: Array<[string, string]> = [];
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (facts.length >= 24 || ['account_number', 'rhs_account_number', 'customer_approval_required'].includes(k)) continue;
      const name = `${prefix}${k.replace(/_/g, ' ')}`;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') facts.push([name, (/(^|_)id$/.test(k) ? String(v) : String(v).replace(/\b[a-z0-9]*\d{7,}[a-z0-9]*\b/gi, '#####')).slice(0, 120)]);   // an order's own id is shown whole
      else if (!Array.isArray(v) && depth < 2) walk(obj(v), `${name} · `, depth + 1);
    }
  };
  walk(d, '', 0);
  const base = { approvalRequired: typeof d.customer_approval_required === 'boolean' ? d.customer_approval_required : null, orderId: id ?? null, state: state ?? null, facts };
  if (state && REFUSED.test(state)) return { ...base, answered: false, unknown: false, error: `Robinhood marked the order ${state}${words ? `: ${words}` : '.'}` };
  if (!id) return { ...base, answered: false, unknown: true, error: `Robinhood answered without an order id, so it is not clear it took this order: it may have gone through. ${LOOK_FIRST}${words ? ` It said: ${words}` : ''}` };
  return { ...base, answered: true, unknown: false, error: null };
}

export class Placer {
  constructor(private readonly client: Pick<Client, 'callTool'>, private readonly tools: Tool[]) {}

  /** Refuses, before anything is sent, an order this door would not send. */
  ready(account: { accountNumber: string; agentic: boolean }, o: Order, refId: string): void {
    if (!account.agentic) throw new Refused('Only the Agentic account can trade, and this is not it.');
    if (!this.tools.some((t) => t.name === PLACE)) throw new Refused("Robinhood's connection no longer offers placing a stock order, so nothing was sent.");
    if (!Number.isInteger(o.quantity) || o.quantity < 1 || !(o.limitPrice > 0) || (o.side !== 'buy' && o.side !== 'sell') || !/^[0-9a-f-]{36}$/.test(refId)) throw new Refused('That order is not complete, so it was not sent.');
  }

  /** Places one limit order of whole shares on the Agentic account. Call only after the person's Confirm. */
  async place(account: { accountNumber: string; agentic: boolean }, o: Order, refId: string): Promise<Placed> {
    this.ready(account, o, refId);
    const r = await this.client.callTool({ name: PLACE, arguments: {
      account_number: account.accountNumber, symbol: o.symbol, side: o.side, type: 'limit', quantity: String(o.quantity),
      limit_price: o.limitPrice.toFixed(2), time_in_force: o.timeInForce, market_hours: 'regular_hours', ref_id: refId,
    } }) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    let data: unknown = r.structuredContent ?? null;
    if (data === null) { try { data = JSON.parse(text) as unknown; } catch { /* words only */ } }
    return parsePlaced({ data, text, failed: r.isError === true });
  }
}
