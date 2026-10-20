// What the page shows of the desk itself: the calls in the journal, how they turned out, the stocks being watched and the
// analyses waiting. All of it is read from the desk's own files; nothing here is invented, and a part with nothing in it is empty.
import fs from 'node:fs';
import path from 'node:path';
import { readContactEmail } from '../contact.js';
import { Journal, type Entry } from '../desk/journal.js';
import { hasReport, sectionsOf, stepWords } from '../desk/runs.js';
import { renderSummary, summarize, type Summary } from '../desk/backtest.js';
import { depthOfRounds, readListener, readQueue, type Depth, type QueueItem } from '../desk/queue.js';
import { readSettings } from '../settings.js';
import { deskDataDir } from '../paths.js';
import { readWatchlist, type WatchItem } from './store.js';

/** A stock on the waiting list as the page shows it: a running one says where its run stands. */
export type QueueView = QueueItem & { progress?: string };
/** Who listens for the doorbell, when its heartbeat is recent. */
export interface ListenerView { listener: string; since: string; lastRun?: { at: string; result: string } }

export interface Call {
  date: string; ticker: string; rating: string; pending: boolean; raw: string | null; alpha: string | null; holding: string | null;
  summary: string; hasReport: boolean;
}
export interface DeskState {
  version: string; today: string; watchlist: WatchItem[]; queue: QueueView[]; calls: Call[];
  record: { summary: Summary; text: string; benchmarkNote: string };
  desk: { emailSaved: boolean; tradingEnabled: boolean; holdingDays: number };
  /** The depth the page offers first (the settings'), how many one run analyses, and who listens for the doorbell. */
  analyses: { depth: Depth; perRun: number; listener: ListenerView | null };
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

/** A short fingerprint of everything the page reads, so the page can ask "did anything change?" cheaply and refresh only then. */
export function versionOf(root: string): string {
  const dir = deskDataDir(root), runs = path.join(dir, 'runs');
  let latest = 0;
  try { for (const d of fs.readdirSync(runs)) latest = Math.max(latest, Number(stamp(path.join(runs, d, 'run.json')))); } catch { /* no runs yet */ }
  // Two things change with time alone, not with a file: a listener whose heartbeat stopped, and a run that died. Both are
  // part of the fingerprint, so the page hears of them too.
  const timely = `${listenerOf(dir) ? 'L' : 'n'}${readQueue(dir).map((i) => i.state[0]).join('')}`;
  return [stamp(path.join(dir, 'journal.md')), stamp(path.join(dir, 'watchlist.json')), stamp(path.join(dir, 'queue.json')), latest, stamp(path.join(dir, 'contact.json')), stamp(path.join(dir, 'listener.json')), timely].join('-');
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
    summary: summaryOf(e.decision), hasReport: hasReport(dir, e.ticker, e.date),
  })).reverse().sort((a, b) => b.date.localeCompare(a.date));
  const summary = summarize(entries);
  return {
    version: versionOf(root), today: day, watchlist: readWatchlist(dir), queue: queueOf(dir), calls,
    record: { summary, text: renderSummary(summary), benchmarkNote: `Each call is judged after ${s.scoring.holdingPeriodDays} trading days against its market's index.` },
    desk: { emailSaved: !!readContactEmail(root), tradingEnabled: false, holdingDays: s.scoring.holdingPeriodDays },
    analyses: { depth: depthOfRounds(s.analysis.debateRounds), perRun: s.routines.maxAnalyses, listener: listenerOf(dir) },
  };
}

/** One call in full: the portfolio manager's decision and the work behind it, as the team wrote it. */
export function callOf(root: string, ticker: string, date: string): { decision: string; sections: Record<string, string[]>; hasReport: boolean } | null {
  const dir = deskDataDir(root), e = new Journal(path.join(dir, 'journal.md')).load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) return null;
  return { decision: e.decision, sections: sectionsOf(dir, ticker, date), hasReport: hasReport(dir, ticker, date) };
}
