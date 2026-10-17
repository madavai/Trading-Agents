// node dist/robinhood.mjs connect | status | forget | discover [--words] | shape TOOL [JSON] [--words]
// connect: sign in through Robinhood's own page if needed, list what its connection offers, and read the positions
// once - read-only, nothing is ever ordered. status: whether a sign-in is saved. forget: delete the saved sign-in.
// discover: each tool's arguments and the shape (never the values) of what the read tools answer, to build the desk on.
// shape: the same for one read tool that needs arguments. --words also shows short lower-case words such as a status.
import fs from 'node:fs';
import { robinhoodFile } from '../paths.js';
import { connect, openSession } from './connect.js';
import { discover, shapeOfRead } from './discover.js';
import { masked } from './rules.js';

const say = (words: string) => console.log(words);

async function main(args: string[]): Promise<number> {
  const words = args.includes('--words'), [command, ...rest] = args.filter((a) => a !== '--words');
  const file = robinhoodFile();
  if (command === 'status') {
    say(fs.existsSync(file) ? `A Robinhood sign-in is saved (last refreshed ${fs.statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC).` : 'No Robinhood sign-in is saved yet.');
    return 0;
  }
  if (command === 'forget') {
    fs.rmSync(file, { force: true });
    say('The saved Robinhood sign-in is deleted. Connect again whenever you like.');
    return 0;
  }
  if (command === 'discover' || command === 'shape') {
    let json: Record<string, unknown> = {};
    if (command === 'shape') {
      if (!rest[0]) { say('Use: node dist/robinhood.mjs shape TOOL \'{"argument": "value"}\''); return 2; }
      try { const v = JSON.parse(rest[1] ?? '{}') as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); json = v as Record<string, unknown>; }
      catch { say('The arguments must be a JSON object, for example \'{"account_number": "123"}\'.'); return 2; }
    }
    try {
      const session = await openSession(file, { signIn: true, say });
      try {
        for (const l of command === 'discover' ? await discover(session.reader, { words }) : await shapeOfRead(session.reader, rest[0]!, json, { words })) say(l);
      } finally { await session.close(); }
      return 0;
    } catch (e) {
      say(`The Robinhood connection did not work: ${masked((e as Error).message)}`);
      say('Nothing was ordered.');
      return 1;
    }
  }
  if (command !== 'connect') {
    say('Use: node dist/robinhood.mjs connect | status | forget | discover | shape TOOL [JSON]');
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
    say('Nothing was ordered. Tell the desk what this says; if Robinhood refuses this program, the desk switches to plan B.');
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
