// The desk's two routines, as briefs read from the desk's own files: what the morning routine should analyse today, and
// what the evening wrap-up has to report. A routine may run with no one watching (Madav's scheduler starts the
// trading-desk team at a set time), so the brief says everything the team needs in plain words: nothing is guessed,
// no figure is made up, and nothing in either routine places, changes or cancels an order.
import path from 'node:path';
import { marketDay, withWeekday } from '../data/dates.js';
import { holidaysKnown, marketClosed, nextMarketDay } from '../data/holidays.js';
import { Journal } from './journal.js';
import { readHoldings } from './holdings.js';
import { ordersOn } from './orders.js';
import { readWatchlist } from '../terminal/store.js';
import { finishItem, readQueue } from './queue.js';
import { TOP_QUEUED, type Pick, type Screen } from './screen.js';
import { dueForRerate, isRerateDay, readRerate, RERATE_DAYS, RERATE_MAX, type Rerate, type StopsAtClose } from './care.js';

/** "Worth a look today" as the morning reads it: the screen (null when it could not be worked out, with why), and whether
 *  the person's switch "Analyse the top three each market morning" is on. */
export interface MorningLook { screen: Screen | null; failed?: string; on: boolean }

export type Kind = 'morning' | 'evening';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** What the scoring step does with a call it cannot settle, so a routine no one watches never goes round on it. */
const LEFT_CALLS = 'A call record_outcome answers LEFT or STOP for stays pending: do not send it again now, go on, and name it at the end with the reason it gave.';
const weekday = (day: string): string => DAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]!;

/** Today's re-rating as Monday's routine put it on the waiting list, by symbol. */
const reratedToday = (dir: string, today: string): Map<string, Rerate['symbols'][number]> => {
  const r = readRerate(dir);
  return new Map(r?.day === today ? r.symbols.map((s) => [s.symbol, s]) : []);
};
const lastView = (s: Rerate['symbols'][number]): string => (s.called ? `its latest view: ${s.rating ?? 'a call'} on ${s.called}` : s.tried ? `the desk has no view of it yet: the re-rating of ${s.tried} left no call on it, so it may not be one the desk can analyse` : 'the desk has no view of it yet');

/** What the morning routine analyses, in order: what is waiting on the dashboard first (asked for there, re-rated on a
 *  Monday or put there by the morning switch, each at its depth), then the person's starred watchlist stocks, leaving
 *  out any already called today or being analysed now, at most `max` in all. While another run analyses a stock from the
 *  waiting list, the rest of that list is left to it (one stock runs at a time; it asks for the next run when it ends),
 *  and the morning analyses the starred stocks. Starred stocks take turns: the ones whose latest call is oldest (or that
 *  have none) go first, so one over the limit today is analysed on a later morning. */
export interface Morning { analyse: Array<{ symbol: string; why: string; queued: boolean }>; later: string[]; calledToday: string[]; running: string | null; leftToRun: string[] }
export function morningList(dir: string, today: string, max: number, screen: Screen | null = null): Morning {
  const entries = new Journal(path.join(dir, 'journal.md')).load(), latest = new Map<string, string>();
  for (const e of entries) if ((latest.get(e.ticker) ?? '') < e.date) latest.set(e.ticker, e.date);
  const called = new Set(entries.filter((e) => e.date === today).map((e) => e.ticker));
  const queue = readQueue(dir), running = queue.find((q) => q.state === 'running')?.symbol ?? null, leftToRun: string[] = [];
  const wanted: Array<{ symbol: string; why: string; queued: boolean }> = [], seen = new Set<string>(running ? [running] : []);
  const add = (symbol: string, why: string, queued: boolean) => { if (!seen.has(symbol) && !called.has(symbol)) { seen.add(symbol); wanted.push({ symbol, why, queued }); } };
  const bySwitch = new Set(screen?.queued?.day === today ? screen.queued.symbols : []), rerated = reratedToday(dir, today);
  const why = (q: { symbol: string; depth?: string }): string => {
    const r = rerated.get(q.symbol);
    if (r) return `a holding re-rated this ${weekday(today) === 'Monday' ? 'Monday' : 'week'} (${lastView(r)}), ${q.depth ?? 'shallow'} depth`;
    return bySwitch.has(q.symbol) ? `worth a look today, put on the list by the morning switch, ${q.depth ?? 'shallow'} depth` : `asked for on the dashboard, ${q.depth ?? "the settings'"} depth`;
  };
  for (const q of queue) {
    if (q.state !== 'waiting') continue;
    if (running && !called.has(q.symbol)) { leftToRun.push(q.symbol); seen.add(q.symbol); } else add(q.symbol, why(q), true);
  }
  const starred = readWatchlist(dir).filter((w) => w.favourite && !w.symbol.startsWith('^')).map((w, i) => ({ symbol: w.symbol, i, last: latest.get(w.symbol) ?? '' }));
  starred.sort((a, b) => a.last.localeCompare(b.last) || a.i - b.i);
  for (const w of starred) add(w.symbol, 'a starred watchlist stock', false);
  return { analyse: wanted.slice(0, max), later: wanted.slice(max).map((w) => w.symbol), calledToday: [...called], running, leftToRun };
}

/** Where each of these stocks (put on the waiting list this morning) stands for the routine, in plain fragments: listed in
 *  step 2, or why not. Only step 2's stocks are analysed by this routine. */
function whereNow(symbols: string[], m: Morning, max: number): string[] {
  const step2 = new Set(m.analyse.map((a) => a.symbol)), called = new Set(m.calledToday), left = new Set(m.leftToRun), later = new Set(m.later);
  const groups: Array<{ words: (n: number) => string; names: string[] }> = [
    { words: () => 'analysed in step 2', names: symbols.filter((s) => step2.has(s)) },
    { words: () => 'being analysed now by another run', names: symbols.filter((s) => s === m.running) },
    { words: () => 'already called today, so not analysed again', names: symbols.filter((s) => !step2.has(s) && s !== m.running && called.has(s)) },
    { words: () => `left on the dashboard to the run analysing ${m.running} (one stock runs at a time)`, names: symbols.filter((s) => !called.has(s) && left.has(s)) },
    { words: (n) => `over today's limit of ${max}, so ${n === 1 ? 'it waits' : 'they wait'} on the dashboard`, names: symbols.filter((s) => !called.has(s) && later.has(s)) },
  ];
  const told = new Set(groups.flatMap((g) => g.names));
  groups.push({ words: () => 'no longer waiting on the dashboard', names: symbols.filter((s) => !told.has(s)) });
  return groups.filter((g) => g.names.length).map((g) => `${g.words(g.names.length)}: ${g.names.join(', ')}`);
}
const allInStep2 = (symbols: string[], m: Morning): boolean => symbols.every((s) => m.analyse.some((a) => a.symbol === s));
const sentence = (fragments: string[]): string => (fragments.length ? ` ${fragments.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : '');

/** The computer's clock, for the brief to name New York's day when this computer's day is another. */
export interface Clock { now: Date; zone?: string }
const dayIn = (now: Date, zone?: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const timeIn = (now: Date, zone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
/** Said when the routine starts on another day by this computer's clock than New York's (the desk's day): a routine is
 *  scheduled by the computer's clock. Only when the clock is the day the brief is for (never for a day given by hand). */
function clockLines(today: string, clock?: Clock): string[] {
  if (!clock || marketDay(clock.now) !== today) return [];
  const local = dayIn(clock.now, clock.zone);
  if (local === today) return [];
  return [`The desk's day is New York's: there it is ${weekday(today)} ${today}, ${timeIn(clock.now, 'America/New_York')}, while on this computer it is ${local > today ? 'already' : 'still'} ${weekday(local)} ${local}. This brief is for New York's ${weekday(today)}. Say so at the end: the routine runs by this computer's clock, so its time may need moving for New York's day.`];
}

const holdingsLine = (dir: string): string => {
  const h = readHoldings(dir);
  if (!h) return 'Holdings: none saved. The analyses say so; they do not assume a flat book.';
  return h.source === 'robinhood'
    ? `Holdings: as the dashboard last read them from Robinhood, on ${h.savedOn}. The team never reads Robinhood itself; for fresher figures the person presses "Refresh from Robinhood" on the dashboard.`
    : `Holdings: as the person gave them, on ${h.savedOn}.`;
};

/** The session a move is from: "2026-11-06 (Fri)", or, read before its close was final (while it traded, or within the
 *  minutes before its figures are final), "2026-11-09 (Mon), read before its close was final: a move so far". */
const sessionWords = (session: string, live?: boolean): string => `${withWeekday(session)}${live ? ', read before its close was final: a move so far, not a close' : ''}`;

/** What "nothing stood out" can say of the news: only of the names whose news was read today. */
export function quietNews(news: Screen['news']): string {
  if (!news || !news.read) return '';
  return news.unread.length ? ', no news today about the other companies and coins the person watches' : ', no news today about the companies and coins the person watches';
}

/** "Worth a look today" in the brief: the list, figures only, the session each move is from, and what the morning switch
 *  did with it. A name whose news could not be read is named as such, never as quiet. */
function lookLines(look: MorningLook | undefined, today: string, m: Morning, max: number): string[] {
  if (!look) return [];
  if (!look.screen) return ['', `   Worth a look today: unavailable (${look.failed ?? 'it could not be worked out'}). Say so at the end.`];
  const s = look.screen, of = (p: Pick) => sessionWords(p.session, p.live), sessions = new Set(s.picks.map(of));
  const one = sessions.size === 1 ? [...sessions][0]! : !s.picks.length && s.session ? sessionWords(s.session, s.live) : '';
  const out = ['', `   Worth a look today, from Yahoo Finance's daily prices at ${s.at.slice(11, 16)} UTC (figures only, never a forecast; ${s.looked} looked at${one ? `; the moves are from the session of ${one}` : ''}):`];
  if (!s.picks.length) out.push(`   - nothing stood out: no move of 3% or more, no volume twice its usual, no 52-week high or low, no cross of an average${quietNews(s.news)}.`);
  for (const p of s.picks) out.push(`   - ${p.symbol}${one ? '' : ` (session of ${of(p)})`}: ${p.why}.`);
  if (s.unavailable.length) out.push(`   Could not be read: ${s.unavailable.join(', ')}.`);
  if (s.news?.unread.length) out.push(`   News could not be read just now for ${s.news.unread.join(', ')}: whether ${s.news.unread.length === 1 ? 'it is' : 'they are'} in the news today is not known. Never say "no news" for ${s.news.unread.length === 1 ? 'it' : 'them'}.`);
  const queued = s.queued?.day === today ? s.queued.symbols : [];
  out.push(look.on
    ? `   The person's switch "Analyse the top ${TOP_QUEUED} each market morning" is on${queued.length ? `: ${queued.join(', ')} ${queued.length === 1 ? 'was' : 'were'} put on the waiting list at shallow depth${allInStep2(queued, m) ? `, and ${queued.length === 1 ? 'is' : 'are'} analysed in step 2` : `; ${whereNow(queued, m, max).join('; ')}`}` : ': nothing more went on the waiting list today'}.`
    : `   The person's switch "Analyse the top ${TOP_QUEUED} each market morning" is off: this list is for the person to read, not for you to analyse.`);
  out.push('   In step 4, give this list in a line or two, with its reasons.');
  return out;
}

/** Monday's re-rating in the brief: what went on the waiting list and why, or why nothing did. */
function rerateLines(dir: string, today: string, m: Morning, max: number): string[] {
  const held = readHoldings(dir), r = readRerate(dir), ran = r?.day === today, done = ran ? r.symbols : [], due = dueForRerate(dir, today);
  const day = weekday(today), monday = day === 'Monday' ? '' : ` (on ${day}: Monday was a New York market holiday)`;
  const head = `   Monday's re-rating${monday}, of the holdings the desk sizes trades to`;
  if (!held) return ['', `${head}: they are not known (the dashboard has not read Robinhood, and the person gave none), so nothing was re-rated. Say so at the end.`];
  if (held.source === 'robinhood' && !held.accounts?.some((a) => a.tradable)) return ['', `${head}: the Agentic account is not among the accounts shown on the dashboard, so nothing was re-rated. Say so at the end.`];
  if (!held.positions.length) return ['', `${head}: nothing is held, so there is nothing to re-rate.`];
  const out = [''], names = due.map((s) => s.symbol).join(', '), are = due.length === 1 ? 'is' : 'are';
  if (done.length) out.push(`${head}: ${done.map((s) => `${s.symbol} (${lastView(s)})`).join(', ')} ${done.length === 1 ? 'was' : 'were'} put on the waiting list at shallow depth, for a view under ${RERATE_DAYS} days old (at most ${RERATE_MAX} a week).${allInStep2(done.map((s) => s.symbol), m) ? ` ${done.length === 1 ? 'It is' : 'They are'} analysed in step 2 with the rest of the list.` : sentence(whereNow(done.map((s) => s.symbol), m, max))}`);
  else if (due.length && ran && r.full) out.push(`${head}: ${names} ${are} due, but the waiting list was full, so nothing went on it. Say so at the end.`);
  else if (due.length && ran) out.push(`${head}: ${names} ${are} due now, but the re-rating ran earlier today, when ${due.length === 1 ? 'it was' : 'they were'} not due, and it runs once a week: left for next week's re-rating. Say so at the end.`);
  else if (due.length) out.push(`${head}: ${names} ${are} due, but the re-rating could not put ${due.length === 1 ? 'it' : 'them'} on the waiting list today. Say so at the end.`);
  else out.push(`${head}: each has a view under ${RERATE_DAYS} days old, or is already on the waiting list. Nothing to re-rate.`);
  if (done.length && due.length) out.push(`   Due as well, left for next week's re-rating${r?.full ? ' (the waiting list was full)' : ''}: ${due.map((s) => s.symbol).join(', ')}.`);
  return out;
}

/** The morning on a day New York's market is closed (a weekend or one of its holidays): score past calls, then stop. Nothing
 *  is listed to analyse; what waits on the dashboard is named as left there. */
function closedBrief(dir: string, today: string, why: string, clock?: Clock): string {
  const waiting = readQueue(dir).filter((q) => q.state === 'waiting').map((q) => q.symbol), next = nextMarketDay(today);
  const lines = [`MORNING ROUTINE for ${weekday(today)} ${today}.`, ...clockLines(today, clock), `New York's market is closed today (${why}): score past calls (step 1), then stop. Analyse nothing in this routine today; the next market day is ${weekday(next)} ${next}.`];
  lines.push('', `1. Score past calls first: list_settlements, then record_outcome with a lesson for each READY call (the /settle playbook). ${LEFT_CALLS}`);
  lines.push('', '2. Analyse nothing today: the market is closed.');
  if (waiting.length) lines.push(`   Left on the dashboard's waiting list: ${waiting.join(', ')}. Do not start them from this routine.`);
  lines.push('', `3. Finish with a short plain list: what was scored, and that the market is closed today (${why}), so nothing was analysed; the next market day is ${weekday(next)} ${next}. Not investment advice.`);
  lines.push('', 'No one may be watching: do not wait for an answer. If a step needs the person (for example no contact email is saved), skip what depends on it and say so at the end.');
  return lines.join('\n');
}

/** Said when the year's New York holidays are not in the desk's list: then a weekday is taken as a market day. */
const unknownHolidays = (today: string): string[] => (holidaysKnown(today) ? [] : ['', `   New York's market holidays for ${today.slice(0, 4)} are not in the desk's list, so a weekday is taken as a market day. If the market is closed today, say so. Say at the end that the list needs that year added.`]);

/** Stocks waiting on the dashboard that were called today (in a chat, say): marked done there with that call's rating,
 *  as start_queue_item would, so no run analyses them again. Answers which. */
function doneAlready(dir: string, today: string): Set<string> {
  const calls = new Map(new Journal(path.join(dir, 'journal.md')).load().filter((e) => e.date === today).map((e) => [e.ticker, e.rating]));
  const marked = new Set<string>();
  for (const q of readQueue(dir)) {
    const rating = calls.get(q.symbol);
    if (q.state !== 'waiting' || !rating) continue;
    try { finishItem(dir, q.symbol, { rating, already: true }); marked.add(q.symbol); } catch { /* it changed meanwhile: a run's start_queue_item answers ALREADY */ }
  }
  return marked;
}

export function morningBrief(dir: string, today: string, max: number, look?: MorningLook, clock?: Clock): string {
  const closed = marketClosed(today);
  if (closed) return closedBrief(dir, today, closed, clock);
  const day = weekday(today), marked = doneAlready(dir, today);
  const m = morningList(dir, today, max, look?.screen ?? null);
  const lines = [`MORNING ROUTINE for ${day} ${today}.`, ...clockLines(today, clock)];
  lines.push(...unknownHolidays(today));
  lines.push('', `1. Score past calls first: list_settlements, then record_outcome with a lesson for each READY call (the /settle playbook). ${LEFT_CALLS}`);
  if (isRerateDay(today)) lines.push(...rerateLines(dir, today, m, max));
  lines.push(...lookLines(look, today, m, max));
  if (m.running) lines.push('', `   ${m.running} is being analysed now by another run: leave it alone.${m.leftToRun.length ? ` Waiting on the dashboard, left to that run (one stock runs at a time): ${m.leftToRun.join(', ')}. Do not start them from this routine.` : ''}`);
  if (!m.analyse.length) lines.push('', '2. Nothing to analyse: no stock is waiting on the dashboard and no starred watchlist stock is without a call today. Say so.');
  else {
    lines.push('', `2. Analyse, one after another, in this order (${m.analyse.length} of at most ${max} a morning), each by the /analyse playbook with today's date:`);
    m.analyse.forEach((a, i) => lines.push(`   ${i + 1}. ${a.symbol} (${a.why})`));
    if (m.analyse.some((a) => a.queued)) lines.push('   A stock asked for on the dashboard is run as the /analyse playbook\'s waiting list says: start_queue_item first (it gives the depth), finish_queue_item once its call is recorded or with why it failed. A starred stock uses the settings\' depth.');
  }
  const waitingNow = new Set(readQueue(dir).filter((q) => q.state === 'waiting').map((q) => q.symbol));
  const laterWaiting = m.later.filter((s) => waitingNow.has(s)), laterStarred = m.later.filter((s) => !waitingNow.has(s));
  if (laterWaiting.length) lines.push(`   Over the limit of ${max}, still waiting on the dashboard: ${laterWaiting.join(', ')}. Not left for another morning: end_queue_run asks for another run, which starts at once when something listens on this computer.`);
  if (laterStarred.length) lines.push(`   Left for another morning, over the limit of ${max}: ${laterStarred.join(', ')}. Starred stocks take turns: the ones whose latest call is oldest go first.`);
  if (m.calledToday.length) lines.push(`   Already called today, so not analysed again: ${m.calledToday.map((s) => (marked.has(s) ? `${s} (it was waiting on the dashboard: marked done there, with that call's rating)` : s)).join(', ')}.`);
  if (m.analyse.some((a) => a.queued) || laterWaiting.length) lines.push('   Last, call end_queue_run once: it asks for another run when stocks are still waiting on the dashboard.');
  lines.push('', `3. ${holdingsLine(dir)}`);
  lines.push('', '4. Finish with a short plain list: each new call (stock, rating, one sentence of its executive summary; for a re-rated holding, its new rating beside its last one), anything skipped and why, and any data that was unavailable. Then: decide on the dashboard ("Decide…" on a call); only the person\'s own Confirm there places an order. A Sell or Underweight on a holding of the Agentic account shows there as "the desk says sell", with a Sell button that opens a ticket: nothing is ever sold by itself. Not investment advice.');
  lines.push('', 'No one may be watching: do not wait for an answer. If a step needs the person (for example no contact email is saved), skip what depends on it and say so at the end.');
  return lines.join('\n');
}

/** Said when the wrap-up runs before New York's market has closed on its day (the routine is scheduled by this computer's
 *  clock): the day's calls and orders are only those so far. */
function openStill(today: string, now: Date): string[] {
  if (marketDay(now) !== today || marketClosed(today)) return [];
  const at = timeIn(now, 'America/New_York');
  return at >= '16:00' ? [] : [`New York's market has not closed yet today: it is ${at} there. The day's calls and orders below are those so far; say so at the end.`];
}

export function eveningBrief(dir: string, today: string, now: Date, stops?: StopsAtClose | { state: 'failed'; why: string }): string {
  const calls = new Journal(path.join(dir, 'journal.md')).load();
  const todays = calls.filter((e) => e.date === today), pending = calls.filter((e) => e.pending).length;
  const orders = ordersOn(dir, now);
  const lines = [`EVENING WRAP-UP for ${weekday(today)} ${today}.`, ...openStill(today, now), '', `1. Score what is ready: list_settlements, then record_outcome with a lesson for each READY call (the /settle playbook). ${LEFT_CALLS}`, ''];
  lines.push(todays.length ? `2. The desk's calls today (${todays.length}): ${todays.map((e) => `${e.ticker} ${e.rating}`).join(', ')}. Read each one's executive summary with read_run (section decision) for one sentence each.` : '2. The desk made no call today.');
  lines.push('');
  if (!orders.length) lines.push('3. The dashboard sent no order today.');
  else {
    lines.push(`3. Orders the dashboard sent today (${orders.length}), with what Robinhood answered when each was sent:`);
    for (const o of orders) {
      const r = o.robinhood, answer = r.unknown ? `no clear answer from Robinhood, so it may have gone through${r.error ? ` (${r.error})` : ''}` : !r.answered ? `refused${r.error ? `: ${r.error}` : ''}` : r.approvalRequired === true ? 'taken, waiting for the person\'s approval on their phone' : r.approvalRequired === false ? 'taken and sent to the market' : 'taken';
      lines.push(`   - ${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.quantity} ${o.symbol} at limit ${o.limitPrice.toFixed(2)}, ${o.at.slice(11, 16)} UTC${o.call ? `, from the ${o.call.rating} call of ${o.call.date}` : o.own ? ', your own order' : ''}: ${answer}${r.state ? ` (state then: ${r.state})` : ''}.`);
    }
    lines.push('   What happened since (filled, approved, cancelled) is on the dashboard and in the Robinhood app: the team does not read Robinhood. Say so; do not guess.');
  }
  lines.push('', ...stopLines(stops));
  lines.push('', `5. Calls still waiting to be scored: ${pending}.`);
  lines.push('', 'Tell the person in a short plain list, using only these facts and what the tools return. Not investment advice.');
  return lines.join('\n');
}

/** A price in the brief: two decimals, more for one under a dollar (a coin such as DOGE). */
const priceText = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 });

/** The stops at the last close, in the evening brief. The dashboard warns of a stop only while its page is open in a
 *  browser, so the wrap-up names here any holding whose last close is below the stop the desk's trader proposed. It only
 *  reports: nothing is ever sold by itself. A close that could not be read is said to be unknown, never taken as above. */
export function stopLines(s: StopsAtClose | { state: 'failed'; why: string } | undefined): string[] {
  const head = '4. Stops at the last close (the dashboard warns of a stop only while its page is open, so the wrap-up checks them here)';
  if (!s) return [`${head}: not checked this evening. Say so.`];
  if (s.state === 'failed') return [`${head}: they could not be checked (${s.why}). Say so: whether a holding closed below its stop is not known.`];
  if (s.state === 'unknown') return [`${head}: the holdings the desk sizes trades to are not known (the dashboard has not read Robinhood, and the person gave none), so no stop was checked. Say so.`];
  if (s.state === 'no-agentic') return [`${head}: the Agentic account is not among the accounts shown on the dashboard, so no stop was checked. Say so.`];
  if (s.state === 'nothing-held') return [`${head}: nothing is held, so there is no stop to check.`];
  if (!s.stops.length) return [`${head}: ${s.held === 1 ? 'the one holding has no stop' : `none of the ${s.held} holdings has a stop`} at a price level in the desk's latest call on it, so there is none to check.`];
  const out = [`${head}:`];
  for (const x of s.stops) {
    const stop = `the stop of ${priceText(x.level)} the desk's trader proposed in the call of ${withWeekday(x.called)}`;
    if (!x.close) out.push(`   - ${x.symbol}: its last close could not be read (${x.why ?? 'unavailable'}), so whether it is below ${stop} is not known. Never say it is above.`);
    else if (x.close.close < x.level) out.push(`   - BELOW ITS STOP: ${x.symbol} closed at ${priceText(x.close.close)} on ${withWeekday(x.close.date)}, below ${stop}.`);
    else out.push(`   - ${x.symbol} closed at ${priceText(x.close.close)} on ${withWeekday(x.close.date)}, at or above ${stop}.`);
  }
  const below = s.stops.filter((x) => x.close && x.close.close < x.level).map((x) => x.symbol);
  out.push(below.length
    ? `   Name ${below.length === 1 ? 'it' : 'each one below its stop'} first in your report, with its close and its stop (${below.join(', ')}). Nothing is sold by itself: selling is the person's own decision, on the dashboard or in the Robinhood app.`
    : '   None closed below its stop: say so in one line.');
  return out;
}
