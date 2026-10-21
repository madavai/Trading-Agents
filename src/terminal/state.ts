// What the page shows of the desk itself: the calls in the journal, how they turned out, the stocks being watched, the
// world in tiers ("Start here"), the analyses waiting and the first month's steps ("Get started"). All of it is read from
// the desk's own files; nothing here is invented, and a part with nothing in it is empty.
import fs from 'node:fs';
import path from 'node:path';
import { readContactEmail } from '../contact.js';
import { Journal, type Entry } from '../desk/journal.js';
import { hasReport, sectionsOf, stepWords } from '../desk/runs.js';
import { renderSummary, summarize, type Summary } from '../desk/backtest.js';
import { depthOfRounds, readListener, readQueue, type Depth, type QueueItem } from '../desk/queue.js';
import { followed, readPaperStart, recordOf, RECORD_WEEKS, RECORD_WORDS, type PaperRecord } from '../desk/paper.js';
import { readSettings } from '../settings.js';
import { deskDataDir } from '../paths.js';
import { today } from '../data/dates.js';
import { readWatchlist, type WatchItem } from './store.js';
import { marketOf, readPrefs } from './prefs.js';
import { isShipped, MAX_MARKET, SHIPPED_MARKET, ticketable, tiersOf, type TierView } from './tiers.js';
import { guideOf, type Guide } from './guide.js';

/** A stock on the waiting list as the page shows it: a running one says where its run stands. */
export type QueueView = QueueItem & { progress?: string };
/** Who listens for the doorbell, when its heartbeat is recent. */
export interface ListenerView { listener: string; since: string; lastRun?: { at: string; result: string } }

export interface Call {
  date: string; ticker: string; rating: string; pending: boolean; raw: string | null; alpha: string | null; holding: string | null;
  summary: string; hasReport: boolean;
  /** Whether Decide… can open an order ticket from it (not for crypto or an index), and whether paper follows it. */
  ticket: boolean; paper: boolean;
}
export interface DeskState {
  version: string; today: string; watchlist: WatchItem[]; queue: QueueView[]; calls: Call[];
  record: { summary: Summary; text: string; benchmarkNote: string };
  desk: { emailSaved: boolean; tradingEnabled: boolean; holdingDays: number };
  /** The depth the page offers first (the settings'), how many one run analyses, and who listens for the doorbell. */
  analyses: { depth: Depth; perRun: number; listener: ListenerView | null };
  /** How much record the desk has on paper, the paper money it starts with, and the weeks under which switching trading
   *  on asks for one extra press, as a number and in words ("four weeks"). The paper book itself is /api/paper. */
  paper: PaperRecord & { startUsd: number; minWeeks: number; minWords: string };
  /** "Start here": the whole market, the eleven sectors, the person's own names (and crypto, when they watch any), each
   *  with the desk's latest call; and the watchlist grouped the same way, broadest first. Prices are /api/quotes. */
  startHere: TierView[]; watchTiers: TierView[];
  /** The person's whole-market funds, whether they are the shipped four, those four, and how many the list may hold. */
  market: MarketView;
  /** "Get started": the first month's five steps, each ticked from the desk's own records. */
  guide: Guide;
}
export interface MarketView { symbols: string[]; asShipped: boolean; shipped: string[]; max: number }

export const marketView = (dir: string): MarketView => {
  const symbols = marketOf(dir);
  return { symbols, asShipped: isShipped(symbols), shipped: [...SHIPPED_MARKET], max: MAX_MARKET };
};

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

/** A short fingerprint of everything the page reads, so the page can ask "did anything change?" cheaply and refresh only then. */
export function versionOf(root: string): string {
  const dir = deskDataDir(root), runs = path.join(dir, 'runs');
  let latest = 0;
  try { for (const d of fs.readdirSync(runs)) latest = Math.max(latest, Number(stamp(path.join(runs, d, 'run.json')))); } catch { /* no runs yet */ }
  // Two things change with time alone, not with a file: a listener whose heartbeat stopped, and a run that died. Both are
  // part of the fingerprint, so the page hears of them too; so are the whole-market funds, which another page may change,
  // and what "Get started" reads besides the desk's files: whether it is open, a call read, the Claude Code switch, and
  // the day, which adds a week of paper record (the page's other choices, kept in the same file, change nothing it shows).
  const p = readPrefs(dir);
  const timely = `${listenerOf(dir) ? 'L' : 'n'}${readQueue(dir).map((i) => i.state[0]).join('')}|${p.market?.join(',') ?? 'shipped'}|${p.guide ?? ''}${p.readCall ? 'r' : ''}${p.autorun ? 'a' : ''}|${today()}`;
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
    summary: summaryOf(e.decision), hasReport: hasReport(dir, e.ticker, e.date), ticket: ticketable(e.ticker), paper: followed(e.ticker),
  })).reverse().sort((a, b) => b.date.localeCompare(a.date));
  const summary = summarize(entries), watchlist = readWatchlist(dir), market = marketView(dir);
  const { startHere, watch } = tiersOf(watchlist, market.symbols, calls);
  const queue = queueOf(dir), listener = listenerOf(dir), prefs = readPrefs(dir), email = readContactEmail(root);
  const record = recordOf(entries.map((e) => ({ ticker: e.ticker, date: e.date, rating: e.rating })), day);
  const guide = guideOf({ email, watchlist, market: market.symbols, queue, calls, listener: listener?.listener ?? null, autorun: prefs.autorun === true, readCall: !!prefs.readCall, record, ...(prefs.guide ? { pref: prefs.guide } : {}) });
  return {
    version: versionOf(root), today: day, watchlist, queue, calls, startHere, watchTiers: watch, market, guide,
    record: { summary, text: renderSummary(summary), benchmarkNote: `Each call is judged after ${s.scoring.holdingPeriodDays} trading days against its market's index.` },
    desk: { emailSaved: !!email, tradingEnabled: false, holdingDays: s.scoring.holdingPeriodDays },
    analyses: { depth: depthOfRounds(s.analysis.debateRounds), perRun: s.routines.maxAnalyses, listener },
    paper: { ...record, startUsd: readPaperStart(dir), minWeeks: RECORD_WEEKS, minWords: RECORD_WORDS },
  };
}

/** One call in full: the portfolio manager's decision and the work behind it, as the team wrote it. */
export function callOf(root: string, ticker: string, date: string): { decision: string; sections: Record<string, string[]>; hasReport: boolean } | null {
  const dir = deskDataDir(root), e = new Journal(path.join(dir, 'journal.md')).load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) return null;
  return { decision: e.decision, sections: sectionsOf(dir, ticker, date), hasReport: hasReport(dir, ticker, date) };
}
