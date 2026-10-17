// What the page shows of the desk itself: the calls in the journal, how they turned out, the stocks being watched and the
// analyses waiting. All of it is read from the desk's own files; nothing here is invented, and a part with nothing in it is empty.
import fs from 'node:fs';
import path from 'node:path';
import { readContactEmail } from '../contact.js';
import { Journal, type Entry } from '../desk/journal.js';
import { hasReport, sectionsOf } from '../desk/runs.js';
import { renderSummary, summarize, type Summary } from '../desk/backtest.js';
import { readSettings } from '../settings.js';
import { deskDataDir } from '../paths.js';
import { readQueue, readWatchlist, type QueueItem, type WatchItem } from './store.js';

export interface Call {
  date: string; ticker: string; rating: string; pending: boolean; raw: string | null; alpha: string | null; holding: string | null;
  summary: string; hasReport: boolean;
}
export interface DeskState {
  version: string; today: string; watchlist: WatchItem[]; queue: QueueItem[]; calls: Call[];
  record: { summary: Summary; text: string; benchmarkNote: string };
  desk: { emailSaved: boolean; tradingEnabled: boolean; holdingDays: number };
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
  return [stamp(path.join(dir, 'journal.md')), stamp(path.join(dir, 'watchlist.json')), stamp(path.join(dir, 'queue.json')), latest, stamp(path.join(dir, 'contact.json'))].join('-');
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
    version: versionOf(root), today: day, watchlist: readWatchlist(dir), queue: readQueue(dir), calls,
    record: { summary, text: renderSummary(summary), benchmarkNote: `Each call is judged after ${s.scoring.holdingPeriodDays} trading days against its market's index.` },
    desk: { emailSaved: !!readContactEmail(root), tradingEnabled: false, holdingDays: s.scoring.holdingPeriodDays },
  };
}

/** One call in full: the portfolio manager's decision and the work behind it, as the team wrote it. */
export function callOf(root: string, ticker: string, date: string): { decision: string; sections: Record<string, string[]>; hasReport: boolean } | null {
  const dir = deskDataDir(root), e = new Journal(path.join(dir, 'journal.md')).load().find((x) => x.ticker === ticker && x.date === date);
  if (!e) return null;
  return { decision: e.decision, sections: sectionsOf(dir, ticker, date), hasReport: hasReport(dir, ticker, date) };
}
