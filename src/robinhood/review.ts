// The second door to Robinhood, and the narrowest: it can ask Robinhood to check one order without placing it, for the
// Agentic account. A stock order goes to review_equity_order ("Simulate a stock order without placing it"): a limit order
// of whole shares, or a part-share at the market price (rules.ts, equityOrderArgs). A coin order goes to
// preview_crypto_order ("Simulate a crypto order without placing it"): a limit order in coins (rules.ts, cryptoOrderArgs).
// It can call no other tool: this file names only those two, and a test checks it. It is used only when the person presses
// Review on a ticket in the dashboard; no agent can reach it.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { coinAmount, type CoinRules, type Order } from '../desk/ticket.js';
import { isCrypto } from '../data/symbols.js';
import { Refused } from './reader.js';
import { cryptoOrderArgs, equityOrderArgs, hideLong, masked } from './rules.js';

const REVIEW = 'review_equity_order', PREVIEW = 'preview_crypto_order';

/** Robinhood's review in plain parts. Its shape is read as Robinhood's tool description names it (an answer with alerts
 *  under order_checks and a customer_approval_required flag); anything else it says is shown as it said it. */
export interface Review {
  /** Robinhood answered without reporting an error, with its list of order checks (an empty list: no alerts). */
  answered: boolean;
  /** Robinhood answered without an error but without its list of order checks: the order counts as not checked. */
  unclear: boolean;
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
  if (answer.failed) return { answered: false, unclear: false, alerts: [], approvalRequired: null, facts: [], error: masked(answer.text) };
  const d = obj(obj(answer.data).data);
  // Only an answer with Robinhood's list of order checks is a check; anything else (words alone, another shape) checked
  // nothing that the desk can tell, so it is shown as Robinhood said it and the order cannot be placed.
  if (d.order_checks === undefined || d.order_checks === null) {
    const said = answer.data === null ? answer.text.trim() : words(obj(answer.data).data).join(' ');   // its data part only: its guide is advice to chat agents
    return { answered: false, unclear: true, alerts: [], approvalRequired: null, facts: [],
      error: `Robinhood answered without its list of order checks, so this order counts as not checked and cannot be placed.${said ? ` It said: ${masked(said).slice(0, 300)}` : ''}` };
  }
  const alerts = [...new Set([...words(d.order_checks), ...words(d.alerts), ...words(d.warnings)])].slice(0, 12).map((x) => x.slice(0, 300));
  const facts: Array<[string, string]> = [];
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (facts.length >= 24 || ['order_checks', 'alerts', 'warnings', 'customer_approval_required', 'account_number', 'rhs_account_number'].includes(k)) continue;
      const name = `${prefix}${k.replace(/_/g, ' ')}`;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') facts.push([name, hideLong(String(v), 7).slice(0, 120)]);
      else if (!Array.isArray(v) && depth < 2) walk(obj(v), `${name} · `, depth + 1);
    }
  };
  walk(d, '', 0);
  return { answered: true, unclear: false, alerts, approvalRequired: typeof d.customer_approval_required === 'boolean' ? d.customer_approval_required : null, facts, error: null };
}

const factsOf = (d: Record<string, unknown>): Array<[string, string]> => {
  const facts: Array<[string, string]> = [];
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (facts.length >= 24 || ['customer_approval_required', 'account_number', 'rhs_account_number', 'rhc_account_number'].includes(k)) continue;
      const name = `${prefix}${k.replace(/_/g, ' ')}`;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') facts.push([name, hideLong(String(v), 7).slice(0, 120)]);
      else if (!Array.isArray(v) && depth < 2) walk(obj(v), `${name} · `, depth + 1);
    }
  };
  walk(d, '', 0);
  return facts;
};
const figureOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);

/** Robinhood's coin check, read strictly. Its answer had not been seen when this was written (11 Nov 2026): Robinhood
 *  describes it as the order's own shape, with the estimated cost and fees, plus any errors found before the trade. So it
 *  counts as a check only when it names this very order back (the same side and amount, at the top or one level in); any
 *  word under a name that speaks of an error, alert, warning or rejection is an alert; and an amount Robinhood would
 *  have rounded (`requested_quantity`) is an alert too, since its order tool rejects such an amount. Anything else is not
 *  checked and cannot be placed, and what Robinhood said is shown. */
export function parsePreview(answer: { data: unknown; text: string; failed: boolean }, o: Pick<Order, 'side' | 'quantity'>): Review {
  if (answer.failed) return { answered: false, unclear: false, alerts: [], approvalRequired: null, facts: [], error: masked(answer.text) };
  const d = obj(obj(answer.data).data);
  const same = (x: Record<string, unknown>) => x.side === o.side && (() => { const q = figureOf(x.quantity); return q !== null && Math.abs(q - o.quantity) <= 1e-12 + o.quantity * 1e-9; })();
  const named = same(d) || Object.values(d).some((v) => !Array.isArray(v) && same(obj(v)));
  const facts = factsOf(d);
  if (!named) {
    const said = answer.data === null ? answer.text.trim() : words(d).join(' ');
    return { answered: false, unclear: true, alerts: [], approvalRequired: null, facts,
      error: `Robinhood's coin check did not name this order back, so it counts as not checked and cannot be placed.${said ? ` It said: ${masked(said).slice(0, 300)}` : ''}` };
  }
  const flagged = Object.entries(d).filter(([k]) => /error|alert|warning|reject|invalid/i.test(k)).flatMap(([, v]) => words(v));
  const inner = Object.values(d).filter((v) => !Array.isArray(v) && Object.keys(obj(v)).length).flatMap((v) => Object.entries(obj(v)).filter(([k]) => /error|alert|warning|reject|invalid/i.test(k)).flatMap(([, x]) => words(x)));
  // The amount asked is a coin amount, said in plain digits; it is never an account number, so it is not hidden.
  const asked = figureOf(d.requested_quantity);
  const rounded = d.requested_quantity !== undefined && d.requested_quantity !== null ? [`Robinhood would round the amount${asked === null ? '' : ` (${coinAmount(asked)} asked)`}: its order tool refuses an amount off the coin's step, so change it`] : [];
  const alerts = [...new Set([...flagged, ...inner, ...rounded])].slice(0, 12).map((x) => x.slice(0, 300));
  return { answered: true, unclear: false, alerts, approvalRequired: typeof d.customer_approval_required === 'boolean' ? d.customer_approval_required : null, facts, error: null };
}

/** What an MCP tool answered, as data (its structured part, else its words read as JSON) and words. */
const answerOf = (r: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }): { data: unknown; text: string; failed: boolean } => {
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  let data: unknown = r.structuredContent ?? null;
  if (data === null) { try { data = JSON.parse(text) as unknown; } catch { /* words only */ } }
  return { data, text, failed: r.isError === true };
};

export class Reviewer {
  constructor(private readonly client: Pick<Client, 'callTool'>, private readonly tools: Tool[]) {}

  /** Asks Robinhood to check the order on the Agentic account. Nothing is placed. A coin order needs the account's numeric
   *  number and the coin's own rules (read from Robinhood's list of coins just before). */
  async review(account: { accountNumber: string; rhsAccountNumber?: string | null; agentic: boolean }, o: Order, coin?: CoinRules): Promise<Review> {
    if (!account.agentic) throw new Refused('Only the Agentic account can have an order checked, and this is not it.');
    const crypto = isCrypto(o.symbol), name = crypto ? PREVIEW : REVIEW;
    if (!this.tools.some((t) => t.name === name)) throw new Refused(`Robinhood's connection no longer offers its ${crypto ? 'coin ' : ''}order check, so nothing was sent.`);
    const args = crypto ? (coin && account.rhsAccountNumber ? cryptoOrderArgs(account.rhsAccountNumber, o, coin) : null) : equityOrderArgs(account.accountNumber, o);
    if (!args) throw new Refused('That order is not complete, so it was not sent for checking.');
    const r = answerOf(await this.client.callTool({ name, arguments: args }) as Parameters<typeof answerOf>[0]);
    return crypto ? parsePreview(r, o) : parseReview(r);
  }
}
