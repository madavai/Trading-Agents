// What the page shows of the desk itself: the calls in the journal, how they turned out, the stocks being watched, the
// world in tiers (the "Sectors" section and the watchlist), the analyses waiting and the first month's steps ("Get started"). All of it is read from
// the desk's own files; nothing here is invented, and a part with nothing in it is empty.
import fs from 'node:fs';
import path from 'node:path';
import { readContactEmail } from '../contact.js';
import { Journal, type Entry } from '../desk/journal.js';
import { hasReport, sectionsOf, stepWords } from '../desk/runs.js';
import { alphaOf, renderSummary, summarize, worked, type Summary } from '../desk/backtest.js';
import { depthOfRounds, readListener, readQueue, type AtOnce, type Depth, type QueueItem } from '../desk/queue.js';
import { followed, lateWhy, readPaperStart, recordOf, RECORD_WEEKS, RECORD_WORDS, type PaperCall, type PaperRecord } from '../desk/paper.js';
import { readSettings } from '../settings.js';
import { againstWords, basisWords, checkName, copiesOf, legacyRules, ownReturn, resolveBenchmark, rulesFor, stockRules, WHEN_SCORED, windowWords, yardstickName, yardstickWords, type Rules, type Scoring } from '../desk/scoring.js';
import { MARKET_FUNDS, SECTOR_FUNDS } from '../desk/sectors.js';
import { isCrypto } from '../data/symbols.js';
import { deskDataDir } from '../paths.js';
import { today } from '../data/dates.js';
import { readWatchlist, type WatchItem } from './store.js';
import { readPrefs } from './prefs.js';
import { ticketable, tiersOf, type TierView } from './tiers.js';
import { guideOf, type Guide } from './guide.js';

/** A stock on the waiting list as the page shows it: a running one says where its run stands. */
export type QueueView = QueueItem & { progress?: string };
/** Who listens for the doorbell, when its heartbeat is recent. */
export interface ListenerView { listener: string; since: string; lastRun?: { at: string; result: string; startOnly?: true } }

export interface Call {
  date: string; ticker: string; rating: string; pending: boolean; raw: string | null; alpha: string | null; holding: string | null;
  /** Whether the scored call went the way its rating said (backtest.ts `worked`): the page colours and words its result by
   *  this, never by the alpha's sign. null while it waits, for a Hold, and for a call with no readable rating or alpha. */
  worked: boolean | null;
  summary: string; hasReport: boolean;
  /** Whether Decide… can open an order ticket from it (not for crypto or an index), and whether paper follows it; `late`
   *  says why paper does not, when the call was recorded after the close it would have filled at. */
  ticket: boolean; paper: boolean; late?: string;
  /** What the call is scored by, as its journal entry keeps it (or, for one recorded before the desk kept it, as such
   *  calls are scored): its window ("5 trading days"), its yardstick ("SPY"), the check's name ("a first-week check")
   *  and, when it is not a US listing scored against SPY, why that yardstick ('' otherwise). */
  window: string; yardstick: string; check: string; why: string;
  /** Scored on its own return, not against its yardstick (a call on the yardstick itself, or on a fund that copies the
   *  same index): its "alpha" is its own return. */
  own: boolean;
  /** What the call is on, in the words its result uses: a coin, a fund the desk knows as one, else a stock. */
  noun: 'stock' | 'coin' | 'fund';
}
export interface DeskState {
  version: string; today: string; watchlist: WatchItem[]; queue: QueueView[]; calls: Call[];
  record: { summary: Summary; text: string; benchmarkNote: string };
  /** `benchmark`: what a US stock's call is scored against (SPY as shipped: the fund that copies the S&P 500); `scoring`:
   *  how a call made now is scored, in a few words for the calls list. */
  desk: { emailSaved: boolean; tradingEnabled: boolean; holdingDays: number; benchmark: string; scoring: string };
  /** The depth the page offers first (the settings' debate rounds, as the nearest depth at or below them), the settings'
   *  own debate and risk rounds (what an analysis asked for with no depth runs), how many one run analyses, and who
   *  listens for the doorbell. */
  /** `atOnce`: how many stocks one run analyses side by side, the person's choice (1, as shipped, to 3). */
  analyses: { depth: Depth; rounds: { debate: number; risk: number }; perRun: number; atOnce: AtOnce; listener: ListenerView | null };
  /** How much record the desk has on paper, the paper money it starts with, and the weeks under which switching trading
   *  on asks for one extra press, as a number and in words ("four weeks"). The paper book itself is /api/paper. */
  paper: PaperRecord & { startUsd: number; minWeeks: number; minWords: string };
  /** The "Sectors" section (named "Start here" before, hence the field): the eleven sector funds, each with the desk's latest
   *  call; and the watchlist grouped by tier, broadest first, which is where the whole-market funds, single names and coins
   *  the person follows are. Prices are /api/quotes. */
  startHere: TierView[]; watchTiers: TierView[];
  /** "Get started": the first month's five steps, each ticked from the desk's own records. */
  guide: Guide;
}

/** Markdown's marks taken out, so a few words read as words: bold, slanted, code, headings, list marks, table bars. */
const plainText = (s: string): string => s
  .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1')
  .replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/\|/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** The call in a few words, as plain text: the decision's own executive summary, whether the portfolio manager wrote it
 *  as a bold label ("**Executive Summary**: ...") or as a heading ("## Executive Summary"); else its first sentences,
 *  without its headings and labelled lines (the rating and the like). */
export function summaryOf(decision: string): string {
  const text = decision.replace(/\r\n/g, '\n');
  const label = /\*\*Executive Summary:?\*\*:?[ \t]*([\s\S]*?)(?=\n\s*\n\*\*|\n\*\*|\n\s{0,3}#{1,6}\s|$)/i.exec(text);
  const heading = /^\s{0,3}#{1,6}\s*Executive Summary\s*:?\s*\n+([\s\S]*?)(?=\n\s{0,3}#{1,6}\s|\n\s*\n\*\*[^*\n]+\*\*\s*:|$)/im.exec(text);
  const found = [label, heading].filter((m): m is RegExpExecArray => !!m && !!m[1]?.trim()).sort((a, b) => a.index - b.index)[0];
  const source = found?.[1] ?? text.split('\n').filter((l) => !/^\s{0,3}#/.test(l) && !/^\s*\*\*[^*\n]+\*\*\s*:/.test(l) && !/^\s*\|/.test(l)).join('\n');
  const words = plainText(source) || plainText(text);
  return words.length > 320 ? `${words.slice(0, 317).trimEnd()}...` : words;
}

const stamp = (file: string): string => { try { return String(fs.statSync(file).mtimeMs); } catch { return '0'; } };

// ---------- how calls are scored, in words: each call's own rules, and the scorecard's note ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-16 as "16 Oct 2026", as the page writes days. */
const dayWords = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${Number(d)} ${MON[Number(m) - 1]} ${y}`; };
/** A call's rules: those its entry keeps, or for one recorded before the desk kept them, the rules it was made under. */
const rulesOfEntry = (e: Entry, s: Scoring): { r: Rules; older: boolean } => {
  if (e.rules) return { r: e.rules, older: false };
  const r = legacyRules(e.ticker, s, e.holding), now = rulesFor(e.ticker, s);
  return { r, older: r.days !== now.days || r.unit !== now.unit };
};
const OLDER = "it was recorded before the desk kept each call's window with it, so it is scored as such calls were then";

/** What one call is scored by, for its chips and its window on the page. */
export function scoredBy(e: Entry, s: Scoring): Pick<Call, 'window' | 'yardstick' | 'check' | 'why' | 'own'> {
  const { r, older } = rulesOfEntry(e, s);
  return { window: windowWords(r), yardstick: r.yardstick, check: checkName(r), why: [basisWords(e.ticker, r), older ? OLDER : ''].filter(Boolean).join('; '), own: ownReturn(r) };
}
/** What a call is on, as its result says it: "the coin", "the fund" (a fund the desk knows as one), else "the stock". */
export const nounOf = (ticker: string): Call['noun'] => (isCrypto(ticker) ? 'coin' : MARKET_FUNDS.has(ticker) || ticker in SECTOR_FUNDS ? 'fund' : 'stock');
/** A journal entry as the paper record reads it, with when it was recorded when the entry keeps that. */
const paperCallOf = (e: Entry): PaperCall => ({ ticker: e.ticker, date: e.date, rating: e.rating, ...(e.recorded ? { recorded: e.recorded } : {}) });
/** Whether paper follows a call, and when it does not only because the call came late, why. */
const paperOf = (e: Entry): Pick<Call, 'paper' | 'late'> => {
  const late = followed(e.ticker) ? lateWhy(paperCallOf(e)) : null;
  return { paper: followed(e.ticker) && !late, ...(late ? { late } : {}) };
};

/** How a call made now is scored, in a few words for the calls list: "each scored once, a first-week check, not its time
 *  horizon: a US stock or fund over 5 trading days, a coin over 7 calendar days, against SPY". */
export function scoringShort(s: Scoring): string {
  const stock = stockRules(s), coin = rulesFor('BTC-USD', s), same = stock.yardstick === coin.yardstick;
  const name = checkName(stock) === checkName(coin) ? checkName(stock) : 'a short first check';
  return `each scored once, ${name}, not its time horizon: a US stock or fund over ${windowWords(stock)}${same ? '' : ` against ${stock.yardstick}`}, a coin over ${windowWords(coin)}, against ${coin.yardstick}`;
}

/** The scorecard's note: how a stock or fund and a coin are scored now, each call the journal keeps that is scored
 *  otherwise (another exchange's index, an exchange the settings do not list, rules from before the desk kept them),
 *  that it is not the call's own horizon, and when scoring happens. */
export function scoringNote(entries: Entry[], s: Scoring): string {
  const stock = stockRules(s), coin = rulesFor('BTC-USD', s), copies = copiesOf(stock.yardstick);
  const name = checkName(stock) === checkName(coin) ? checkName(stock) : 'a short first check';
  const coinY = coin.yardstick === stock.yardstick ? `${coin.yardstick} too` : yardstickName(coin.yardstick);
  const ny = coin.yardstick === 'SPY', y = coin.yardstick;
  const closed = ny ? "New York's market was closed (a weekend or a New York holiday)" : 'its market was closed';
  // A call on the yardstick itself is scored as the note says of it below, so it is not listed as scored otherwise.
  const same = (r: Rules, std: Rules) => r.days === std.days && r.unit === std.unit && r.yardstick === std.yardstick && (r.basis === std.basis || ownReturn(r));
  const otherwise = entries.map((e) => ({ e, ...rulesOfEntry(e, s) })).filter(({ e, r, older }) => older || !same(r, isCrypto(e.ticker) ? coin : stock));
  const listed = otherwise.slice(0, 6).map(({ e, r, older }) => `${e.ticker} (${dayWords(e.date)}): ${againstWords(e.ticker, r)}, over the ${windowWords(r)} after the call${older ? `, as ${OLDER}` : ''}`);
  return [
    `Each call is scored once, ${name} against a named yardstick, not over the call's own time horizon (its decision states that).`,
    `A US stock or fund: against ${yardstickWords('', stock)}, over the ${windowWords(stock)} after the call.`,
    `A call on ${stock.yardstick} itself${copies.length ? `, or on a fund that copies the same index (${copies.join(', ')})` : ''}, is scored on its own return instead: against ${stock.yardstick} its alpha would always be about zero, so a Buy works when it rose over the window, a Sell when it fell.`,
    `A coin: against ${coinY}${coin.basis === 'coin' ? ", as the desk's settings name no yardstick for coins" : ''}, over the ${windowWords(coin)} after the call. A coin trades every day and ${y} ${ny ? "only on New York's market days" : 'only on its own market\'s days'}, so ${y}'s close on the coin's first and last day is used, or its last close before that day when ${closed}.`,
    ...(listed.length ? [`Scored otherwise: ${listed.join('; ')}${otherwise.length > listed.length ? `; and ${otherwise.length - listed.length} more` : ''}.`] : []),
    WHEN_SCORED, 'Both returns count dividends: they are worked out from prices adjusted for them.',
  ].join(' ');
}

/** A short fingerprint of everything the page reads, so the page can ask "did anything change?" cheaply and refresh only then. */
export function versionOf(root: string): string {
  const dir = deskDataDir(root), runs = path.join(dir, 'runs');
  let latest = 0;
  try { for (const d of fs.readdirSync(runs)) latest = Math.max(latest, Number(stamp(path.join(runs, d, 'run.json')))); } catch { /* no runs yet */ }
  // Two things change with time alone, not with a file: a listener whose heartbeat stopped, and a run that died. Both are
  // part of the fingerprint, so the page hears of them too; so is what "Get started" reads besides the desk's files:
  // whether it is open, a call read, and the day, which adds a week of paper record (the page's other choices, kept in
  // the same file, change nothing it shows).
  const p = readPrefs(dir);
  const timely = `${listenerOf(dir) ? 'L' : 'n'}${readQueue(dir).map((i) => i.state[0]).join('')}|${p.guide ?? ''}${p.readCall ? 'r' : ''}${p.atOnce ?? 1}|${today()}`;
  return [stamp(path.join(dir, 'journal.md')), stamp(path.join(dir, 'watchlist.json')), stamp(path.join(dir, 'queue.json')), latest, stamp(path.join(dir, 'contact.json')), stamp(path.join(dir, 'listener.json')), stamp(path.join(dir, 'paper.json')), timely].join('-');
}

/** The waiting list for the page: running first, then waiting in order, then finished, newest first. */
export function queueOf(dir: string, now: Date = new Date()): QueueView[] {
  const rank = { running: 0, waiting: 1, done: 2, failed: 2 } as const;
  return readQueue(dir, now)
    .map((i): QueueView => (i.state === 'running' && i.date ? { ...i, progress: stepWords(dir, i.symbol, i.date) } : i))
    .sort((a, b) => rank[a.state] - rank[b.state] || (rank[a.state] === 2 ? (b.endedAt ?? '').localeCompare(a.endedAt ?? '') : 0));
}

export function listenerOf(dir: string, now: Date = new Date()): ListenerView | null {
  const n = readListener(dir, now);
  return n?.fresh ? { listener: n.listener, since: n.since, ...(n.lastRun ? { lastRun: n.lastRun } : {}) } : null;
}

export function stateOf(root: string, day: string): DeskState {
  const dir = deskDataDir(root), s = readSettings(root);
  const entries: Entry[] = new Journal(path.join(dir, 'journal.md')).load();
  const calls: Call[] = entries.map((e) => ({
    date: e.date, ticker: e.ticker, rating: e.rating, pending: e.pending, raw: e.raw, alpha: e.alpha, holding: e.holding,
    worked: e.pending ? null : worked(e.rating, alphaOf(e)),
    summary: summaryOf(e.decision), hasReport: hasReport(dir, e.ticker, e.date), ticket: ticketable(e.ticker), ...paperOf(e),
    ...scoredBy(e, s.scoring), noun: nounOf(e.ticker),
  })).reverse().sort((a, b) => b.date.localeCompare(a.date));
  const summary = summarize(entries), watchlist = readWatchlist(dir);
  const { startHere, watch } = tiersOf(watchlist, calls);
  const queue = queueOf(dir), listener = listenerOf(dir), prefs = readPrefs(dir), email = readContactEmail(root);
  const record = recordOf(entries.map(paperCallOf), day);
  const guide = guideOf({ email, watchlist, queue, calls, listener: listener?.listener ?? null, readCall: !!prefs.readCall, record, ...(prefs.guide ? { pref: prefs.guide } : {}) });
  return {
    version: versionOf(root), today: day, watchlist, queue, calls, startHere, watchTiers: watch, guide,
    record: { summary, text: renderSummary(summary), benchmarkNote: scoringNote(entries, s.scoring) },
    desk: { emailSaved: !!email, tradingEnabled: false, holdingDays: s.scoring.holdingPeriodDays, benchmark: resolveBenchmark('SPY', s.scoring), scoring: scoringShort(s.scoring) },
    analyses: { depth: depthOfRounds(s.analysis.debateRounds), rounds: { debate: s.analysis.debateRounds, risk: s.analysis.riskRounds }, perRun: s.routines.maxAnalyses, atOnce: prefs.atOnce ?? 1, listener },
    paper: { ...record, startUsd: readPaperStart(dir), minWeeks: RECORD_WEEKS, minWords: RECORD_WORDS },
  };
}

/** One call in full: the portfolio manager's decision and the work behind it, as the team wrote it. */
export function callOf(root: string, ticker: string, date: string): { decision: string; sections: Record<string, string[]>; hasReport: boolean } | null {
  const dir = deskDataDir(root), e = new Journal(path.join(dir, 'journal.md')).load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) return null;
  return { decision: e.decision, sections: sectionsOf(dir, ticker, date), hasReport: hasReport(dir, ticker, date) };
}
