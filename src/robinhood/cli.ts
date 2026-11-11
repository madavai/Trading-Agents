// node dist/robinhood.mjs connect | status | forget | discover [--words | --full] | shape TOOL [JSON] [--words]
// connect: sign in through Robinhood's own page if needed, list what its connection offers, and read the positions
// once - read-only, nothing is ever ordered. status: whether a sign-in is saved. forget: delete the saved sign-in and
// switch trading off, as the dashboard's Disconnect does.
// discover: each tool's arguments and the shape (never the values) of what the read tools answer, to build the desk on.
// shape: the same for one read tool that needs arguments; "agentic" in place of an account number stands for the Agentic
// account, read from Robinhood and never printed. --words also shows short lower-case words such as a status.
// discover --full: the whole words of the tools that order, review or move money (discover cuts them short), calling none.
import fs from 'node:fs';
import { robinhoodFile } from '../paths.js';
import { connect, openSession } from './connect.js';
import { argsFromWords, discover, discoverFull, shapeOfRead } from './discover.js';
import { Link } from './link.js';
import { masked } from './rules.js';

const say = (words: string) => console.log(words);

async function main(args: string[]): Promise<number> {
  const words = args.includes('--words'), full = args.includes('--full'), [command, ...rest] = args.filter((a) => a !== '--words' && a !== '--full');
  const file = robinhoodFile();
  if (command === 'status') {
    say(fs.existsSync(file) ? `A Robinhood sign-in is saved (last refreshed ${fs.statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC).` : 'No Robinhood sign-in is saved yet.');
    return 0;
  }
  if (command === 'forget') {
    new Link(file).forget();   // as the dashboard's Disconnect: the sign-in, the account choice and values go, and trading is switched off
    say('The saved Robinhood sign-in is deleted, and trading is switched off. Connect again whenever you like.');
    return 0;
  }
  if (command === 'discover' || command === 'shape') {
    let json: Record<string, unknown> = {}, pairs: Record<string, string> | null = null;
    if (command === 'shape') {
      if (!rest[0]) { say('Use: node dist/robinhood.mjs shape TOOL account_number=agentic symbols=META (or \'{"argument": "value"}\'). "agentic" stands for the Agentic account; a list is written META+NVDA.'); return 2; }
      if (rest.length > 1 && !rest[1]!.trim().startsWith('{')) {
        // name=value words, which a Windows shell passes as they are (it strips the quotes inside a JSON object)
        pairs = {};
        for (const w of rest.slice(1)) { const at = w.indexOf('='); if (at < 1) { say(`"${w}" is not name=value, for example account_number=agentic.`); return 2; } pairs[w.slice(0, at)] = w.slice(at + 1); }
      } else {
        try { const v = JSON.parse(rest[1] ?? '{}') as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); json = v as Record<string, unknown>; }
        catch { say('The arguments must be name=value words (account_number=agentic symbols=META) or a JSON object.'); return 2; }
      }
    }
    try {
      const session = await openSession(file, { signIn: true, say });
      try {
        const lines = command === 'shape' ? await shapeOfRead(session.reader, rest[0]!, pairs ? argsFromWords(session.reader, rest[0]!, pairs) : json, { words }) : full ? discoverFull(session.reader) : await discover(session.reader, { words });
        for (const l of lines) say(l);
      } finally { await session.close(); }
      return 0;
    } catch (e) {
      say(`The Robinhood connection did not work: ${masked((e as Error).message)}`);
      say('Nothing was ordered.');
      return 1;
    }
  }
  if (command !== 'connect') {
    say('Use: node dist/robinhood.mjs connect | status | forget | discover [--full] | shape TOOL [JSON]');
    return 2;
  }
  try {
    const c = await connect(file, { say });
    const read = c.tools.filter((t) => t.kind === 'read'), order = c.tools.filter((t) => t.kind === 'order'), other = c.tools.filter((t) => t.kind === 'other');
    say(`Connected to Robinhood. Its connection offers ${c.tools.length} tools.`);
    say(`\nRead tools (${read.length}) - the only kind the desk ever calls:`);
    for (const t of read) say(`- ${t.name} (read-only): ${t.description}`);
    say(`\nTools that order, review orders or move money (${order.length}) - agents can never call these; only your Confirm in the dashboard will place an order:`);
    for (const t of order) say(`- ${t.name}${t.readOnly ? ' (labelled read-only)' : ''}: ${t.description}`);
    say(`\nOther tools (${other.length}) - not labelled read-only, so the desk never calls them:`);
    for (const t of other) say(`- ${t.name}: ${t.description}`);
    say(`\n${c.positions ?? 'No positions tool without inputs was found, so nothing was read.'}`);
    say('Nothing was ordered, changed or cancelled.');
    return 0;
  } catch (e) {
    say(`The Robinhood connection did not work: ${masked((e as Error).message)}`);
    say('Nothing was ordered. The desk\'s analyses do not need Robinhood: they work without it. To try again, run this test again, or press Connect on the dashboard\'s Your account; if Robinhood keeps refusing, the words above say why.');
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
