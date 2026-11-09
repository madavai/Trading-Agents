// "Worth a look today": a cheap pass over the whole market, the sector funds and the person's own names that says, from
// figures alone (the prices traded, as the dashboard's chart shows them), which moved in a way worth reading about: a
// day's move of 3% or more, volume at least twice its usual,
// a new 52-week high or low, a close across its 50- or 200-day average, and, for a single name or a coin, news about it
// published today. No model is asked and nothing here is a forecast. Ranked by how many signals fire, then by the size
// of the move; five are shown. It is worked out at most once an hour and kept in desk-data/screen.json, so the dashboard
// and the morning routine read the same list. With the person's morning switch on, the top three go on the waiting list
// at shallow depth once each market day (New York's, its holidays known); the screen itself never analyses or orders
// anything. A name whose news could not be read is kept by name, never counted as quiet.
import fs from 'node:fs';
import path from 'node:path';
import { addDays, marketDay } from '../data/dates.js';
import { isMarketDay, nextMarketDay } from '../data/holidays.js';
import { sma } from '../data/indicators.js';
import { latestState } from '../data/market.js';
import { search } from '../data/news.js';
import { daily, type Bar } from '../data/yahoo.js';
import { Journal } from './journal.js';
import { withLock, writeWhole } from './lock.js';
import { enqueue, QueueRefusal, readQueue, ringDoorbell } from './queue.js';

export const MOVE_PCT = 3, VOLUME_TIMES = 2, USUAL_DAYS = 20, SHOWN = 5, TOP_QUEUED = 3;
/** How long a worked-out screen stands before it is worked out again. */
export const SCREEN_MS = 60 * 60_000;

export type SignalKind = 'move' | 'volume' | 'high' | 'low' | 'above50' | 'below50' | 'above200' | 'below200' | 'news';
export interface Signal { kind: SignalKind; words: string }
export interface Pick {
  symbol: string; signals: Signal[];
  /** The day's move in percent, from the close before; null when there is no close before to compare with. */
  movePct: number | null;
  /** Every signal in one plain line, such as "Fell 4.2% on 3.1 times its usual volume, a new 52-week low". */
  why: string;
  /** The session the figures are from: the latest daily row. */
  session: string;
  /** That session's close was not final when the screen was worked out (it was still trading, or had just ended:
   *  market.ts latestState): its move is so far, not a close. */
  live?: true;
}
export interface Screen {
  day: string; at: string;
  /** How many symbols were looked at, and which could not be read (their prices did not come). */
  looked: number; unavailable: string[];
  picks: Pick[];
  /** The news read for the person's companies and coins: how many were read, and which could not be (never "no news").
   *  Missing in a screen kept before it was recorded: then nothing is said about news. */
  news?: { read: number; unread: string[] };
  /** The latest session most of the names were read on, and whether its close was not yet final then. */
  session?: string; live?: true;
  /** What the morning switch put on the waiting list, and on which day (once a day at most). */
  queued?: { day: string; symbols: string[] };
}

const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** The signals one symbol's daily rows give, oldest row first, as of its latest row; `newsToday` is how many articles
 *  about it were published today, or null when news was not looked at. A figure that cannot be had fires nothing. */
export function signalsOf(bars: readonly Bar[], newsToday: number | null = null): { signals: Signal[]; movePct: number | null } {
  const signals: Signal[] = [], n = bars.length, last = bars[n - 1], prev = bars[n - 2];
  if (!last) return { signals, movePct: null };
  const movePct = prev && prev.close > 0 ? (last.close / prev.close - 1) * 100 : null;
  if (movePct !== null && Math.abs(movePct) >= MOVE_PCT) signals.push({ kind: 'move', words: `${movePct >= 0 ? 'rose' : 'fell'} ${one(Math.abs(movePct))}%` });
  const usual = bars.slice(Math.max(0, n - 1 - USUAL_DAYS), n - 1).map((b) => b.volume).filter((v): v is number => v !== null && v > 0);   // a volume not given is left out, never a zero
  if (usual.length >= USUAL_DAYS / 2 && last.volume !== null && last.volume > 0) {
    const times = last.volume / (usual.reduce((a, v) => a + v, 0) / usual.length);
    if (times >= VOLUME_TIMES) signals.push({ kind: 'volume', words: `${one(times)} times its usual volume` });
  }
  // A 52-week high or low needs a whole year of rows before the latest, by the calendar (a coin trades every day).
  const yearAgo = addDays(last.date, -365), year = bars.slice(0, n - 1).filter((b) => b.date >= yearAgo);
  if (bars[0] && bars[0].date <= addDays(last.date, -350) && year.length) {
    if (last.high > Math.max(...year.map((b) => b.high))) signals.push({ kind: 'high', words: 'a new 52-week high' });
    if (last.low < Math.min(...year.map((b) => b.low))) signals.push({ kind: 'low', words: 'a new 52-week low' });
  }
  if (prev) {
    const closes = bars.map((b) => b.close);
    for (const days of [50, 200] as const) {
      const ma = sma(closes, days), now = ma[n - 1], before = ma[n - 2];
      if (now == null || before == null) continue;
      if (prev.close <= before && last.close > now) signals.push({ kind: days === 50 ? 'above50' : 'above200', words: `crossed above its ${days}-day average` });
      if (prev.close >= before && last.close < now) signals.push({ kind: days === 50 ? 'below50' : 'below200', words: `crossed below its ${days}-day average` });
    }
  }
  if (newsToday !== null && newsToday > 0) signals.push({ kind: 'news', words: `in the news today (${newsToday} ${newsToday === 1 ? 'article' : 'articles'})` });
  return { signals, movePct };
}

/** The signals in one plain line: the move with its volume first, then the rest. */
export function whyOf(signals: readonly Signal[]): string {
  const move = signals.find((s) => s.kind === 'move'), volume = signals.find((s) => s.kind === 'volume');
  const parts = [move && volume ? `${move.words} on ${volume.words}` : move ? move.words : volume ? `traded ${volume.words}` : '',
    ...signals.filter((s) => s.kind !== 'move' && s.kind !== 'volume').map((s) => s.words)].filter(Boolean);
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The picks worth a look: those with a signal, by how many signals fire, then by the size of the move; at most five. */
export function rank(candidates: ReadonlyArray<{ symbol: string; bars: readonly Bar[]; news: number | null; live?: boolean }>): Pick[] {
  return candidates.map((c): Pick => { const s = signalsOf(c.bars, c.news); return { symbol: c.symbol, signals: s.signals, movePct: s.movePct, why: whyOf(s.signals), session: c.bars[c.bars.length - 1]?.date ?? '', ...(c.live ? { live: true as const } : {}) }; })
    .filter((p) => p.signals.length > 0)
    .sort((a, b) => b.signals.length - a.signals.length || Math.abs(b.movePct ?? 0) - Math.abs(a.movePct ?? 0) || a.symbol.localeCompare(b.symbol))
    .slice(0, SHOWN);
}

/** Runs the jobs a few at a time, so a long list does not ask Yahoo everything at once. */
async function inTurn<T, R>(items: readonly T[], width: number, job: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await job(items[i]!); } }));
  return out;
}

/** How many articles tagged with the symbol were published on `day` (New York's), or null when news could not be read. */
async function newsOn(symbol: string, day: string): Promise<number | null> {
  try { return (await search(symbol, 12)).filter((a) => a.tickers.includes(symbol) && marketDay(new Date(`${a.time.replace(' ', 'T')}:00Z`)) === day).length; } catch { return null; }
}

/** The latest session most of the read names share (a coin's day can run ahead of the stock market's), and whether it was
 *  still trading; nothing when no name was read. */
function commonSession(read: ReadonlyArray<{ bars: readonly Bar[]; live: boolean }>): { session?: string; live?: true } {
  const count = new Map<string, { n: number; live: boolean }>();
  for (const r of read) { const d = r.bars.at(-1)!.date, c = count.get(d) ?? { n: 0, live: false }; count.set(d, { n: c.n + 1, live: c.live || r.live }); }
  const top = [...count].sort((a, b) => b[1].n - a[1].n || b[0].localeCompare(a[0]))[0];
  return top ? { session: top[0], ...(top[1].live ? { live: true as const } : {}) } : {};
}

/** Works the screen out now from Yahoo's daily rows (and its news for the names in `news`). Indices, futures and currencies
 *  are left out: they cannot be held. A symbol whose rows do not come, or whose latest row is over a week old, is listed
 *  as unavailable, never as quiet; a name whose news did not come is listed by name, never as "no news". */
export async function workScreen(symbols: readonly string[], news: ReadonlySet<string>, day: string, now: Date = new Date()): Promise<Screen> {
  const list = [...new Set(symbols)].filter((s) => !/[\^=]/.test(s));
  const read = await inTurn(list, 4, async (symbol) => {
    try {
      // At the prices traded, as the chart beside it shows them: dividend-adjusted rows lower every day before a dividend,
      // so a fund that pays would reach "a new 52-week high" below its traded high.
      const s = await daily(symbol, addDays(day, -400), day), bars = s.traded?.length === s.bars.length ? s.traded : s.bars;
      if (!bars.length || bars[bars.length - 1]!.date < addDays(day, -7)) return { symbol, bars: null, news: null, asked: false, live: false };
      const asked = news.has(symbol);
      return { symbol, bars, news: asked ? await newsOn(symbol, day) : null, asked, live: latestState(s, day, now.getTime()).open };
    } catch { return { symbol, bars: null, news: null, asked: false, live: false }; }
  });
  const ok = read.filter((r): r is typeof r & { bars: Bar[] } => !!r.bars), asked = ok.filter((r) => r.asked);
  return {
    day, at: now.toISOString(), looked: list.length, unavailable: read.filter((r) => !r.bars).map((r) => r.symbol),
    picks: rank(ok),
    news: { read: asked.filter((r) => r.news !== null).length, unread: asked.filter((r) => r.news === null).map((r) => r.symbol) },
    ...commonSession(ok),
  };
}

const screenFile = (dir: string) => path.join(dir, 'screen.json');

/** The screen as last kept, read field by field; null when there is none or it cannot be read. */
export function readScreen(dir: string): Screen | null {
  try {
    const v = JSON.parse(fs.readFileSync(screenFile(dir), 'utf8')) as Screen;
    if (typeof v.day !== 'string' || typeof v.at !== 'string' || !Array.isArray(v.picks)) return null;
    // the news read is said only when it was kept whole: a screen from before it was recorded says nothing about news
    const news = v.news && Number.isInteger(v.news.read) && Array.isArray(v.news.unread) && v.news.unread.every((s) => typeof s === 'string') ? v.news : undefined;
    const { news: _kept, ...rest } = v;
    return news ? { ...rest, news } : rest;
  } catch { return null; }
}

function keep(dir: string, s: Screen): Screen {
  fs.mkdirSync(dir, { recursive: true });
  withLock(screenFile(dir), () => writeWhole(screenFile(dir), JSON.stringify(s, null, 2) + '\n'));
  return s;
}

/** Today's screen: the one kept if it is from today and under an hour old, else worked out afresh and kept (what the
 *  morning switch queued today is carried over, so it queues once a day). */
export async function screenToday(dir: string, symbols: readonly string[], news: ReadonlySet<string>, day: string, now: Date = new Date(), work = workScreen): Promise<Screen> {
  const kept = readScreen(dir);
  if (kept && kept.day === day && now.getTime() - Date.parse(kept.at) < SCREEN_MS) return kept;
  const fresh = await work(symbols, news, day, now);
  return keep(dir, { ...fresh, ...(kept?.queued?.day === day ? { queued: kept.queued } : {}) });
}

/** The switch acts in a market morning only: before this hour, New York time. */
export const MORNING_ENDS = 12;
const newYorkHour = (now: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
/** The market day after `day` (New York's, its holidays known): where the switch starts when it is switched on. */
export { nextMarketDay };

/** Whether the morning switch still has today to act on: a market morning (before noon in New York), from the day it
 *  starts, and nothing put on the list yet today. The dashboard looks at this while it runs, with no page open. */
export const switchDue = (dir: string, day: string, now: Date = new Date(), from = ''): boolean =>
  isMarketDay(day) && day >= from && newYorkHour(now) < MORNING_ENDS && readScreen(dir)?.queued?.day !== day;

/** The morning switch: on a market morning (a day New York's market opens, before noon there), from the day the switch
 *  starts (`from`, the market day after it was switched on), once, the top three picks not already called today nor
 *  waiting or being analysed go on the waiting list at shallow depth. `ring` rings the doorbell for whoever listens (the
 *  dashboard does; the morning routine, which analyses what is waiting itself, does not). A screen with nothing to queue
 *  and names it could not read leaves the day open: what could not be read is unavailable, not "nothing stood out", so
 *  the next look tries again. Returns what it queued. */
export function queueTop(dir: string, screen: Screen, day: string, ring: boolean, now: Date = new Date(), from = ''): string[] {
  if (!isMarketDay(day) || day < from || newYorkHour(now) >= MORNING_ENDS) return [];
  if (screen.day !== day || screen.queued?.day === day || readScreen(dir)?.queued?.day === day) return [];
  const called = new Set(new Journal(path.join(dir, 'journal.md')).load().filter((e) => e.date === day).map((e) => e.ticker));
  const busy = new Set(readQueue(dir, now).filter((q) => q.state === 'waiting' || q.state === 'running').map((q) => q.symbol));
  const queued: string[] = [];
  for (const p of screen.picks) {
    if (queued.length >= TOP_QUEUED) break;
    if (called.has(p.symbol) || busy.has(p.symbol)) continue;
    try { enqueue(dir, p.symbol, now.toISOString(), 'shallow', now); queued.push(p.symbol); } catch (e) { if (!(e instanceof QueueRefusal)) throw e; break; }   // a full list takes no more
  }
  if (!queued.length && screen.unavailable.length) return [];
  keep(dir, { ...screen, queued: { day, symbols: queued } });
  if (queued.length && ring) ringDoorbell(dir, 'press', now);
  return queued;
}
