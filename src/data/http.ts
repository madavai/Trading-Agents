// The one door to the outside for the data tools: a request with the desk's user agent, a time limit and one retry when
// a source is busy, and two kinds of failure kept apart - a source that could not answer (Unavailable) and a source
// that answered with no data for what was asked (NoData). Neither ever reads as "nothing happened". Each says what
// happened in plain words, with the source named as a person knows it (failure-words.ts): never a web error code.

/** `status`: the code of the source's answer (403, 429, 503...), for the program only; the words never carry it.
 *  `noEmail`: the SEC refused a request that carried no contact email, the one refusal the person can mend. */
export class Unavailable extends Error {
  override name = 'Unavailable';
  constructor(message: string, readonly status?: number, readonly noEmail = false) { super(message); }
}
export class NoData extends Error {
  override name = 'NoData';
  constructor(message: string, readonly status?: number) { super(message); }
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { userAgentFor } from '../check/probes.js';
import { writeWhole } from '../desk/lock.js';
import { today } from './dates.js';
import { refusalWords, sourceName, unreachableWords, whatItSaid } from './failure-words.js';

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
let contact = 'trading-agents (+https://github.com/madavai/trading-agents)';
// The person's email is looked up when a request is made, never kept from start-up: a copy of the tool server that began
// before the email was saved must still send it.
let secEmail: string | (() => string) = '';
let spacingMs = 0;
let cacheDir: string | null = null;

const emailNow = (): string => (typeof secEmail === 'function' ? secEmail() : secEmail);

/** For the tests and the server: the fetch to use, the user agent every source sees, the email only the SEC sees (or where
 *  to look it up), the least time between requests to one host, and a folder to keep answers in. */
export function configure(opts: { fetch?: Fetch; contact?: string; secEmail?: string | (() => string); spacingMs?: number; cacheDir?: string | null }): void {
  if (opts.fetch) fetchImpl = opts.fetch;
  if (opts.contact) contact = opts.contact;
  if (opts.secEmail !== undefined) secEmail = opts.secEmail;
  if (opts.spacingMs !== undefined) spacingMs = opts.spacingMs;
  if (opts.cacheDir !== undefined) { cacheDir = opts.cacheDir; if (cacheDir) pruneCache(cacheDir); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One request at a time may start per host each `spacingMs`: several analysts asking Yahoo at once is what gets a computer
// rate-limited. Callers queue in order, and each waits for the one before it to have really started, then the whole gap:
// when the computer stalls, the requests that were waiting go one after another, never together. The clock is read
// again after each wait, since a timer can wake early (on Windows, by up to one 15 ms clock tick).
const lastStart = new Map<string, number>(), queue = new Map<string, Promise<void>>();
async function pace(host: string): Promise<void> {
  if (!spacingMs) return;
  const turn = (queue.get(host) ?? Promise.resolve()).then(async () => {
    for (let i = 0; i < 5; i++) {
      const wait = (lastStart.get(host) ?? -Infinity) + spacingMs - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    lastStart.set(host, Date.now());
  });
  queue.set(host, turn);
  await turn;
}

// Answers are kept on disk, shared by every copy of the tool server, so the analysts and a repeated question do not ask a
// source again. How long one is served again depends on whether it can have changed since it was read. A filed document
// (an insider's Form 4, a fund's holdings report: the SEC's archive of filings) never changes, since a correction is a
// filing of its own, and FRED's figures as they were known on a past day never change either: both are served for 30
// days. The SEC's yearly figures change only when something is filed, so they are served for a day; a filer's list of
// filings gains a Form 4 any hour, so it is served for an hour, as is FRED's latest (a figure released at 8:30 must reach
// a 9:00 analysis); prices, news, posts, odds and the rest for five minutes. Past price rows are never served from an old
// copy: they are adjusted for every dividend and split paid since, so a dividend between two runs changes them all.
// Every answer stays on disk for 30 days (`KEPT_DAYS`, the person's choice), but one past its time is never served
// again: the source is asked afresh. A failure is never kept, nor an answer asked for as data that is not data (a web
// page saying the service will be right back). Every tool that serves a kept answer can say when it was read
// (`getTextAt`, `readWords`).
const MINUTE = 60_000, DAY_MS = 24 * 60 * MINUTE;
/** How many days a downloaded answer stays on disk, whether or not it may still be served. */
export const KEPT_DAYS = 30;
export function keepFor(url: string): number {
  const u = new URL(url);
  if (/(^|\.)sec\.gov$/.test(u.hostname)) {
    if (/^\/Archives\/edgar\/data\//.test(u.pathname)) return KEPT_DAYS * DAY_MS;
    return /^\/submissions\//.test(u.pathname) ? 60 * MINUTE : DAY_MS;
  }
  // FRED's archive of what was known on a day (ALFRED), for a day before today: fixed once that day has passed.
  const vintage = u.searchParams.get('vintage_date');
  if (/(^|\.)alfred\.stlouisfed\.org$/.test(u.hostname) && vintage && /^\d{4}-\d{2}-\d{2}$/.test(vintage) && vintage < today()) return KEPT_DAYS * DAY_MS;
  return /fred/.test(u.hostname) ? 60 * MINUTE : 5 * MINUTE;
}
const keyOf = (url: string): string => { const u = new URL(url); u.searchParams.delete('crumb'); return createHash('sha256').update(u.toString()).digest('hex').slice(0, 40); };

function readCache(url: string): { text: string; at: number } | null {
  if (!cacheDir) return null;
  try {
    const file = path.join(cacheDir, `${keyOf(url)}.txt`), at = fs.statSync(file).mtimeMs;
    return Date.now() - at < keepFor(url) ? { text: fs.readFileSync(file, 'utf8'), at } : null;
  } catch { return null; }
}

/** When an answer was read, as a person says it: "09:12 New York time on 2026-11-06" (the desk's day is New York's). */
export function readWords(at: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} New York time on ${p.year}-${p.month}-${p.day}`;
}

function writeCache(url: string, text: string): void {
  if (!cacheDir) return;
  try { fs.mkdirSync(cacheDir, { recursive: true }); writeWhole(path.join(cacheDir, `${keyOf(url)}.txt`), text); } catch { /* a cache that cannot be written is only a missed saving */ }
}

function pruneCache(dir: string): void {
  try { for (const f of fs.readdirSync(dir)) { const file = path.join(dir, f); if (Date.now() - fs.statSync(file).mtimeMs > KEPT_DAYS * DAY_MS) fs.rmSync(file, { force: true }); } } catch { /* no cache yet */ }
}

/** A failed answer in plain words: who refused and how, what it said when that can be read, and, for the SEC, whether
 *  the person's contact email went with the request (the SEC refuses a program that does not say who runs it). */
function refusal(url: string, status: number, body: string): Unavailable {
  const { did, then } = refusalWords(status), refused = status === 401 || status === 403 || status === 429;
  const said = status === 403 || status === 429 ? whatItSaid(body) : '';
  const sec = /(^|\.)sec\.gov$/.test(new URL(url).hostname), email = emailNow().trim() !== '';
  const note = sec && refused ? (email ? ', though a contact email was sent with it' : ', and no contact email was sent with it') : '';
  return new Unavailable(`${sourceName(url)} ${did}${said ? `, saying "${said}"` : ''}${note}${then}`, status, sec && refused && !email);
}

export async function getText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  return (await getTextAt(url, opts)).text;
}

/** The answer and when it was read from the source: now, or when the kept copy was read. `usable`, when given, says
 *  whether an answer is what was asked for (data, not a web page): one that is not is neither kept nor served from the
 *  kept copy, so the next question asks the source again. */
export async function getTextAt(url: string, opts: { timeoutMs?: number; headers?: Record<string, string>; usable?: (text: string) => boolean } = {}): Promise<{ text: string; at: number }> {
  const host = new URL(url).host, cached = readCache(url);
  if (cached !== null && (!opts.usable || opts.usable(cached.text))) return cached;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    await pace(host);
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, emailNow()), Accept: '*/*', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (e) {
      const err = e as Error;
      if (attempt < 2 && err.name !== 'TimeoutError') { await sleep(800 * (attempt + 1)); continue; }
      throw new Unavailable(`${sourceName(url)} ${unreachableWords(err)}`);
    }
    // A busy source is asked again, waiting as long as it says (up to 20 s) or, if it does not say, a little longer each time.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel().catch(() => {});
      const said = res.headers.get('retry-after'), wait = said !== null && said !== '' && Number.isFinite(Number(said)) ? Number(said) * 1000 : [2_000, 5_000][attempt]!;
      await sleep(Math.min(20_000, wait));
      continue;
    }
    const text = await res.text();
    if (res.status === 404) throw new NoData(`${sourceName(url)} ${refusalWords(404).did}`, 404);
    if (!res.ok) throw refusal(url, res.status, text);
    const at = Date.now();
    if (!opts.usable || opts.usable(text)) writeCache(url, text);
    return { text, at };
  }
}

/** The cookies a host sets, whatever its answer: Yahoo hands its session cookie on a page that answers 404. */
export async function getCookies(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, emailNow()) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Unavailable(`${sourceName(url)} ${unreachableWords(e)}`);
  }
  await res.body?.cancel().catch(() => {});
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function getJson<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  return (await getJsonAt<T>(url, opts)).value;
}

/** The answer as data, and when it was read from the source. */
export async function getJsonAt<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ value: T; at: number }> {
  // Read once: the check that decides whether the answer is kept is the reading itself.
  const read: { text?: string; value?: T } = {};
  const usable = (text: string): boolean => { try { read.value = JSON.parse(text) as T; read.text = text; return true; } catch { return false; } };
  const { text, at } = await getTextAt(url, { ...opts, usable });
  if (read.text !== text) throw new Unavailable(`${sourceName(url)} answered, but not with the data the desk reads`);
  return { value: read.value as T, at };
}

/** What a tool says when a source failed: never an empty finding, never a number to guess around. */
export function failureText(e: unknown, what: string): string {
  if (e instanceof NoData) return `NO_DATA_AVAILABLE: ${what}: ${e.message}. Do not estimate or invent values; report that the data is not available.`;
  if (e instanceof Unavailable) return `DATA_UNAVAILABLE: ${what}: ${e.message}. This says nothing about the company; report the data as unavailable and do not estimate or invent values.`;
  return `DATA_UNAVAILABLE: ${what}: ${(e as Error).message}. Report the data as unavailable; do not estimate or invent values.`;
}
