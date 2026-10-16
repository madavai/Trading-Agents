// The second door to Robinhood, and the narrowest: it can ask Robinhood to check one stock order without placing it
// (review_equity_order, which Robinhood describes as "Simulate a stock order without placing it"), for the Agentic
// account, as a limit order of whole shares. It can call no other tool: this file names only that one, and a test checks
// it. It is used only when the person presses Review on a ticket in the dashboard; no agent can reach it.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Order } from '../desk/ticket.js';
import { Refused } from './reader.js';
import { masked } from './rules.js';

const REVIEW = 'review_equity_order';

/** Robinhood's review in plain parts. Its shape is read as Robinhood's tool description names it (an answer with alerts
 *  under order_checks and a customer_approval_required flag); anything else it says is shown as it said it. */
export interface Review {
  /** Robinhood answered without reporting an error. */
  answered: boolean;
  /** Robinhood's own alerts on the order (buying power, a halt, a pattern-day-trade rule, ...), in its words. */
  alerts: string[];
  /** Whether Robinhood will ask the person to approve the order on their phone, when it says. */
  approvalRequired: boolean | null;
  /** The other things Robinhood said, as name and value, at most 24. */
  facts: Array<[string, string]>;
  /** Robinhood's words when it reported an error. */
  error: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const words = (v: unknown): string[] => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(words);
  const o = obj(v);
  const own = ['message', 'detail', 'description', 'title', 'reason', 'text'].map((k) => o[k]).find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return own ? [own.trim()] : Object.values(o).flatMap(words);
};

export function parseReview(answer: { data: unknown; text: string; failed: boolean }): Review {
  if (answer.failed) return { answered: false, alerts: [], approvalRequired: null, facts: [], error: masked(answer.text) };
  const d = obj(obj(answer.data).data);
  const alerts = [...new Set([...words(d.order_checks), ...words(d.alerts), ...words(d.warnings)])].slice(0, 12).map((x) => x.slice(0, 300));
  const facts: Array<[string, string]> = [];
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (facts.length >= 24 || ['order_checks', 'alerts', 'warnings', 'customer_approval_required', 'account_number', 'rhs_account_number'].includes(k)) continue;
      const name = `${prefix}${k.replace(/_/g, ' ')}`;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') facts.push([name, String(v).replace(/\b[a-z0-9]*\d{7,}[a-z0-9]*\b/gi, '#####').slice(0, 120)]);
      else if (!Array.isArray(v) && depth < 2) walk(obj(v), `${name} · `, depth + 1);
    }
  };
  walk(d, '', 0);
  return { answered: true, alerts, approvalRequired: typeof d.customer_approval_required === 'boolean' ? d.customer_approval_required : null, facts, error: null };
}

export class Reviewer {
  constructor(private readonly client: Pick<Client, 'callTool'>, private readonly tools: Tool[]) {}

  /** Asks Robinhood to check the order on the Agentic account. Nothing is placed. */
  async review(account: { accountNumber: string; agentic: boolean }, o: Order): Promise<Review> {
    if (!account.agentic) throw new Refused('Only the Agentic account can have an order checked, and this is not it.');
    if (!this.tools.some((t) => t.name === REVIEW)) throw new Refused("Robinhood's connection no longer offers its order check, so nothing was sent.");
    if (!Number.isInteger(o.quantity) || o.quantity < 1 || !(o.limitPrice > 0) || (o.side !== 'buy' && o.side !== 'sell')) throw new Refused('That order is not complete, so it was not sent for checking.');
    const r = await this.client.callTool({ name: REVIEW, arguments: {
      account_number: account.accountNumber, symbol: o.symbol, side: o.side, type: 'limit', quantity: String(o.quantity),
      limit_price: o.limitPrice.toFixed(2), time_in_force: o.timeInForce, market_hours: 'regular_hours',
    } }) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    let data: unknown = r.structuredContent ?? null;
    if (data === null) { try { data = JSON.parse(text) as unknown; } catch { /* words only */ } }
    return parseReview({ data, text, failed: r.isError === true });
  }
}
