// The one door to Robinhood's tools. Every call the desk makes to Robinhood goes through Reader.read, and read refuses any
// tool that is not labelled read-only by Robinhood and named like a read - and every tool whose name speaks of orders,
// trades or moving money, whatever its label says. This file is the only one in src/ that calls a tool (a test checks it),
// so the day an order is sent it will be from a place of its own, behind the person's Confirm, never from here.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { kindOf, type Kind } from './rules.js';

export class Refused extends Error { constructor(message: string) { super(message); this.name = 'Refused'; } }

export interface ReadResult {
  /** The answer as data: Robinhood's structured answer, else its text parsed as JSON, else null. */
  data: unknown;
  /** The answer's text, as Robinhood wrote it. */
  text: string;
  /** Robinhood said the call failed (its words are in text). */
  failed: boolean;
}

export class Reader {
  constructor(private readonly client: Pick<Client, 'callTool'>, readonly tools: Tool[]) {}

  /** Tools by kind: what the desk may read, what orders or moves money, and the rest. */
  byKind(): Record<Kind, Tool[]> {
    const out: Record<Kind, Tool[]> = { read: [], order: [], other: [] };
    for (const t of this.tools) out[kindOf(t)].push(t);
    return out;
  }

  async read(name: string, args: Record<string, unknown> = {}): Promise<ReadResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Refused(`Robinhood's connection offers no tool called ${name}.`);
    const kind = kindOf(tool);
    if (kind === 'order') throw new Refused(`${name} orders or moves money, or reviews an order, so this part of the desk never calls it.`);
    if (kind !== 'read') throw new Refused(`${name} is not labelled read-only by Robinhood, so this part of the desk never calls it.`);
    const r = await this.client.callTool({ name, arguments: args }) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    let data: unknown = r.structuredContent ?? null;
    if (data === null) { try { data = JSON.parse(text) as unknown; } catch { /* plain words */ } }
    return { data, text, failed: r.isError === true };
  }
}
