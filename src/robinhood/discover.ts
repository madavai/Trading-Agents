// `node dist/robinhood.mjs discover`: what Robinhood's connection offers, told so the desk can be built against what is
// really there - each tool's name, what it says it does, the arguments it takes (names and types) and, for the read tools
// that need no argument, the SHAPE of what they answer: field names and kinds of value, never a value. The person can paste
// it whole: no balance, no account number, no ticker is in it. Nothing is ordered, changed or cancelled. Descriptions are
// cut short there; `discover --full` gives the whole words of the tools that order, review or move money, calling none.
import { Reader, Refused } from './reader.js';
import { argsOf, masked, oneLine, shapeLines, type ArgLine } from './rules.js';

const takes = (args: ArgLine[]): string => args.length ? args.map((a) => `${a.name} (${a.type}${a.required ? ', required' : ''})${a.note ? ` - ${a.note}` : ''}`).join('; ') : 'nothing';

export async function discover(reader: Reader, opts: { words?: boolean } = {}): Promise<string[]> {
  const out: string[] = [], { read, order, other } = reader.byKind();
  out.push(`Robinhood's connection offers ${reader.tools.length} tools: ${read.length} that only read, ${order.length} that order, review or move money, ${other.length} others.`);

  out.push('', `READ TOOLS (${read.length}) - the only ones the desk may call:`);
  for (const t of read) {
    const args = argsOf(t), needed = args.filter((a) => a.required);
    out.push('', `* ${t.name}`, `  says: ${oneLine(t.description ?? '', 400) || '(no description)'}`, `  takes: ${takes(args)}`);
    if (needed.length) { out.push(`  not called here: it needs ${needed.map((a) => a.name).join(', ')}. To see its shape: node dist/robinhood.mjs shape ${t.name} '{"${needed[0]!.name}": "..."}'`); continue; }
    try {
      for (const l of await shapeOfRead(reader, t.name, {}, opts)) out.push(`  ${l}`);
    } catch (e) {
      out.push(`  could not be read: ${masked((e as Error).message)}`);
    }
  }

  out.push('', `TOOLS THAT ORDER, REVIEW OR MOVE MONEY (${order.length}) - never called by this program:`);
  for (const t of order) out.push('', `* ${t.name}`, `  says: ${oneLine(t.description ?? '', 400) || '(no description)'}`, `  takes: ${takes(argsOf(t))}`, `  labelled read-only by Robinhood: ${t.annotations?.readOnlyHint === true ? 'yes' : 'no'}`);

  out.push('', `OTHER TOOLS (${other.length}) - not labelled read-only, never called:`);
  for (const t of other) out.push('', `* ${t.name}`, `  says: ${oneLine(t.description ?? '', 200) || '(no description)'}`, `  takes: ${takes(argsOf(t))}`);

  out.push('', 'Nothing was ordered, changed or cancelled. No value from your account is shown above: only the names and kinds of what Robinhood answers.');
  return out;
}

/** `discover --full`: every word Robinhood gives about the tools that order, review or move money - the whole description,
 *  line by line, and the whole note on each argument - for building the desk's tickets on Robinhood's own rules. It calls
 *  no tool at all, and these words hold no value from the account. */
export function discoverFull(reader: Reader): string[] {
  const { order } = reader.byKind(), out: string[] = [];
  out.push(`The ${order.length} tools that order, review or move money, in Robinhood's full words. None of them is called here.`);
  for (const t of order) {
    const lines = (t.description ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
    out.push('', `* ${t.name}`, '  says:', ...(lines.length ? lines.map((l) => `    ${l}`) : ['    (no description)']), '  takes:');
    const args = argsOf(t, Infinity);
    out.push(...(args.length ? args.map((a) => `    - ${a.name} (${a.type}${a.required ? ', required' : ''})${a.note ? `: ${a.note}` : ''}`) : ['    nothing']));
    out.push(`  labelled read-only by Robinhood: ${t.annotations?.readOnlyHint === true ? 'yes' : 'no'}`);
  }
  out.push('', 'Nothing was called, ordered, changed or cancelled.');
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ACCOUNT_ARGS = ['account_number', 'rhs_account_number'] as const;

/** The word "agentic" in place of an account number is the Agentic account's own number, read here from get_accounts
 *  and never printed, so the person need not type it (nor anyone see it) to learn the shape of a read that needs it. */
export async function withAgentic(reader: Reader, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const asked = ACCOUNT_ARGS.filter((k) => args[k] === 'agentic');
  if (!asked.length) return args;
  const r = await reader.read('get_accounts');
  const d = obj(r.data), all = obj(d.data).accounts ?? d.accounts;
  const agentic = (Array.isArray(all) ? all : []).map(obj).filter((a) => a.agentic_allowed === true);
  if (r.failed || agentic.length !== 1) throw new Refused(r.failed ? `Robinhood did not list the accounts: ${masked(r.text)}` : `Robinhood listed ${agentic.length} accounts that agents may trade, not one, so "agentic" cannot stand for an account.`);
  const out = { ...args };
  for (const k of asked) {
    const n = agentic[0]![k];
    if (typeof n !== 'string' || !n.trim()) throw new Refused(`Robinhood gave no ${k} for the Agentic account.`);
    out[k] = n.trim();
  }
  return out;
}

/** name=value words as a tool's arguments: a value for an argument Robinhood takes as a list is split at "+"
 *  (symbols=META+NVDA), and any other value is kept as text. */
export function argsFromWords(reader: Reader, name: string, pairs: Record<string, string>): Record<string, unknown> {
  const tool = reader.tools.find((t) => t.name === name), types = new Map((tool ? argsOf(tool) : []).map((a) => [a.name, a.type]));
  return Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, /\barray\b|^list of\b/.test(types.get(k) ?? '') ? v.split('+').map((x) => x.trim()).filter(Boolean) : v]));
}

/** One read tool's answer, as a shape (see discover). The arguments are the person's own words; "agentic" in place of an
 *  account number stands for the Agentic account (withAgentic). */
export async function shapeOfRead(reader: Reader, name: string, args: Record<string, unknown>, opts: { words?: boolean } = {}): Promise<string[]> {
  const r = await reader.read(name, await withAgentic(reader, args));
  if (r.failed) return [`Robinhood reported an error: ${masked(r.text)}`];
  if (r.data === null) return [`answered with plain text (${r.text.length} characters), not data`];
  return shapeLines(r.data, opts.words === true);
}
