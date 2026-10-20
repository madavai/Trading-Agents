// The desk's two routines, as briefs read from the desk's own files: what the morning routine should analyse today, and
// what the evening wrap-up has to report. A routine may run with no one watching (Madav's scheduler starts the
// trading-desk team at a set time), so the brief says everything the team needs in plain words: nothing is guessed,
// no figure is made up, and nothing in either routine places, changes or cancels an order.
import path from 'node:path';
import { Journal } from './journal.js';
import { readHoldings } from './holdings.js';
import { ordersOn } from './orders.js';
import { readWatchlist } from '../terminal/store.js';
import { readQueue } from './queue.js';

export type Kind = 'morning' | 'evening';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (day: string): string => DAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]!;

/** What the morning routine analyses, in order: what the person asked for on the dashboard and is still waiting first (at
 *  the depth they asked), then their starred watchlist stocks, leaving out any already called today or being analysed
 *  now, at most `max` in all. */
export function morningList(dir: string, today: string, max: number): { analyse: Array<{ symbol: string; why: string; queued: boolean }>; later: string[]; calledToday: string[]; running: string | null } {
  const called = new Set(new Journal(path.join(dir, 'journal.md')).load().filter((e) => e.date === today).map((e) => e.ticker));
  const queue = readQueue(dir), running = queue.find((q) => q.state === 'running')?.symbol ?? null;
  const wanted: Array<{ symbol: string; why: string; queued: boolean }> = [], seen = new Set<string>(running ? [running] : []);
  const add = (symbol: string, why: string, queued: boolean) => { if (!seen.has(symbol) && !called.has(symbol)) { seen.add(symbol); wanted.push({ symbol, why, queued }); } };
  for (const q of queue) if (q.state === 'waiting') add(q.symbol, `asked for on the dashboard, ${q.depth ?? "the settings'"} depth`, true);
  for (const w of readWatchlist(dir)) if (w.favourite && !w.symbol.startsWith('^')) add(w.symbol, 'a starred watchlist stock', false);
  return { analyse: wanted.slice(0, max), later: wanted.slice(max).map((w) => w.symbol), calledToday: [...called], running };
}

const holdingsLine = (dir: string): string => {
  const h = readHoldings(dir);
  if (!h) return 'Holdings: not provided. The analyses say so; they do not assume a flat book.';
  return h.source === 'robinhood'
    ? `Holdings: as the dashboard last read them from Robinhood, on ${h.savedOn}. The team never reads Robinhood itself; for fresher figures the person presses "Refresh from Robinhood" on the dashboard.`
    : `Holdings: as the person gave them, on ${h.savedOn}.`;
};

export function morningBrief(dir: string, today: string, max: number): string {
  const day = weekday(today), weekend = day === 'Saturday' || day === 'Sunday';
  const m = morningList(dir, today, max);
  const lines = [`MORNING ROUTINE for ${day} ${today}.`];
  if (weekend) lines.push(`US markets do not open on a ${day}: score past calls (step 1), then stop and say so. Analyse nothing unless the person asked for it in words.`);
  lines.push('', '1. Score past calls first: list_settlements, then record_outcome with a lesson for each READY call (the /settle playbook).');
  if (m.running) lines.push('', `   ${m.running} is being analysed now by another run: leave it alone.`);
  if (!m.analyse.length) lines.push('', '2. Nothing to analyse: no stock is waiting on the dashboard and no starred watchlist stock is without a call today. Say so.');
  else {
    lines.push('', `2. Analyse, one after another, in this order (${m.analyse.length} of at most ${max} a morning), each by the /analyse playbook with today's date:`);
    m.analyse.forEach((a, i) => lines.push(`   ${i + 1}. ${a.symbol} (${a.why})`));
    if (m.analyse.some((a) => a.queued)) lines.push('   A stock asked for on the dashboard is run as the /analyse playbook\'s waiting list says: start_queue_item first (it gives the depth), finish_queue_item once its call is recorded or with why it failed. A starred stock uses the settings\' depth.');
  }
  if (m.later.length) lines.push(`   Left for another morning, over the limit of ${max}: ${m.later.join(', ')}.`);
  if (m.calledToday.length) lines.push(`   Already called today, so not analysed again: ${m.calledToday.join(', ')}.`);
  if (m.analyse.some((a) => a.queued) || m.later.length) lines.push('   Last, call end_queue_run once: stocks still waiting on the dashboard get another run.');
  lines.push('', `3. ${holdingsLine(dir)}`);
  lines.push('', '4. Finish with a short plain list: each new call (stock, rating, one sentence of its executive summary), anything skipped and why, and any data that was unavailable. Then: decide on the dashboard ("Decide…" on a call); only the person\'s own Confirm there places an order. Not investment advice.');
  lines.push('', 'No one may be watching: do not wait for an answer. If a step needs the person (for example no contact email is saved), skip what depends on it and say so at the end.');
  return lines.join('\n');
}

export function eveningBrief(dir: string, today: string, now: Date): string {
  const calls = new Journal(path.join(dir, 'journal.md')).load();
  const todays = calls.filter((e) => e.date === today), pending = calls.filter((e) => e.pending).length;
  const orders = ordersOn(dir, now);
  const lines = [`EVENING WRAP-UP for ${weekday(today)} ${today}.`, '', '1. Score what is ready: list_settlements, then record_outcome with a lesson for each READY call (the /settle playbook).', ''];
  lines.push(todays.length ? `2. The desk's calls today (${todays.length}): ${todays.map((e) => `${e.ticker} ${e.rating}`).join(', ')}. Read each one's executive summary with read_run (section decision) for one sentence each.` : '2. The desk made no call today.');
  lines.push('');
  if (!orders.length) lines.push('3. The dashboard sent no order today.');
  else {
    lines.push(`3. Orders the dashboard sent today (${orders.length}), with what Robinhood answered when each was sent:`);
    for (const o of orders) {
      const r = o.robinhood, answer = !r.answered ? `refused${r.error ? `: ${r.error}` : ''}` : r.approvalRequired === true ? 'taken, waiting for the person\'s approval on their phone' : r.approvalRequired === false ? 'taken and sent to the market' : 'taken';
      lines.push(`   - ${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.quantity} ${o.symbol} at limit ${o.limitPrice.toFixed(2)}, ${o.at.slice(11, 16)} UTC${o.call ? `, from the ${o.call.rating} call of ${o.call.date}` : o.own ? ', your own order' : ''}: ${answer}${r.state ? ` (state then: ${r.state})` : ''}.`);
    }
    lines.push('   What happened since (filled, approved, cancelled) is on the dashboard and in the Robinhood app: the team does not read Robinhood. Say so; do not guess.');
  }
  lines.push('', `4. Calls still waiting to be scored: ${pending}.`);
  lines.push('', 'Tell the person in a short plain list, using only these facts and what the tools return. Not investment advice.');
  return lines.join('\n');
}
