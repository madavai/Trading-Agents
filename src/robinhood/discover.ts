// `node dist/robinhood.mjs discover`: what Robinhood's connection offers, told so the desk can be built against what is
// really there - each tool's name, what it says it does, the arguments it takes (names and types) and, for the read tools
// that need no argument, the SHAPE of what they answer: field names and kinds of value, never a value. The person can paste
// it whole: no balance, no account number, no ticker is in it. Nothing is ordered, changed or cancelled.
import { Reader } from './reader.js';
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

/** One read tool's answer, as a shape (see discover). The arguments are the person's own words. */
export async function shapeOfRead(reader: Reader, name: string, args: Record<string, unknown>, opts: { words?: boolean } = {}): Promise<string[]> {
  const r = await reader.read(name, args);
  if (r.failed) return [`Robinhood reported an error: ${masked(r.text)}`];
  if (r.data === null) return [`answered with plain text (${r.text.length} characters), not data`];
  return shapeLines(r.data, opts.words === true);
}
