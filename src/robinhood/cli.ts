// node dist/robinhood.mjs connect | status | forget
// connect: sign in through Robinhood's own page if needed, list what its connection offers, and read the positions
// once - read-only, nothing is ever ordered. status: whether a sign-in is saved. forget: delete the saved sign-in.
import fs from 'node:fs';
import { robinhoodFile } from '../paths.js';
import { connect } from './connect.js';

const say = (words: string) => console.log(words);

async function main(command: string | undefined): Promise<number> {
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
  if (command !== 'connect') {
    say('Use: node dist/robinhood.mjs connect | status | forget');
    return 2;
  }
  try {
    const c = await connect(file, { say });
    const order = c.tools.filter((t) => t.order), read = c.tools.filter((t) => !t.order);
    say(`Connected to Robinhood. Its connection offers ${c.tools.length} tools.`);
    say(`\nRead tools (${read.length}):`);
    for (const t of read) say(`- ${t.name}${t.readOnly ? ' (read-only)' : ''}: ${t.description}`);
    say(`\nTools that order, review orders or move money (${order.length}) - agents can never call these; only your Confirm in the dashboard will place an order:`);
    for (const t of order) say(`- ${t.name}: ${t.description}`);
    say(`\n${c.positions ?? 'No positions tool without inputs was found, so nothing was read.'}`);
    say('Nothing was ordered, changed or cancelled.');
    return 0;
  } catch (e) {
    say(`The Robinhood connection did not work: ${(e as Error).message}`);
    say('Nothing was ordered. Tell the desk what this says; if Robinhood refuses this program, the desk switches to plan B.');
    return 1;
  }
}

process.exitCode = await main(process.argv[2]);
