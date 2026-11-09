// The one door to the outside for the data tools: a request with the desk's user agent, a time limit and one retry when
// a source is busy, and two kinds of failure kept apart - a source that could not answer (Unavailable) and a source
// that answered with no data for what was asked (NoData). Neither ever reads as "nothing happened".

export class Unavailable extends Error { override name = 'Unavailable'; }
export class NoData extends Error { override name = 'NoData'; }

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { userAgentFor } from '../check/probes.js';
import { writeWhole } from '../desk/lock.js';

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
// source again. A filed document never changes and the SEC's yearly figures change only when something is filed, so they
// are kept a day; a filer's list of filings gains a Form 4 any hour, so it is kept an hour, as is FRED (a figure released
// at 8:30 must reach a 9:00 analysis); prices and the rest five minutes. A failure is never kept. Every tool that serves a
// kept answer can say when it was read (`getTextAt`, `readWords`).
const MINUTE = 60_000;
export function keepFor(url: string): number {
  const u = new URL(url);
  if (/(^|\.)sec\.gov$/.test(u.hostname)) return /^\/submissions\//.test(u.pathname) ? 60 * MINUTE : 24 * 60 * MINUTE;
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
  try { for (const f of fs.readdirSync(dir)) { const file = path.join(dir, f); if (Date.now() - fs.statSync(file).mtimeMs > 3 * 24 * 60 * MINUTE) fs.rmSync(file, { force: true }); } } catch { /* no cache yet */ }
}

/** What a source said when it refused, in a few plain words: its own explanation can be the whole diagnosis. */
const excerpt = (body: string): string => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);

export async function getText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  return (await getTextAt(url, opts)).text;
}

/** The answer and when it was read from the source: now, or when the kept copy was read. */
export async function getTextAt(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ text: string; at: number }> {
  const host = new URL(url).host, cached = readCache(url);
  if (cached !== null) return cached;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    await pace(host);
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, emailNow()), Accept: '*/*', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (e) {
      const err = e as Error;
      if (attempt < 2 && err.name !== 'TimeoutError') { await sleep(800 * (attempt + 1)); continue; }
      throw new Unavailable(`${host} did not answer (${err.name === 'TimeoutError' ? 'no answer in time' : err.message})`);
    }
    // A busy source is asked again, waiting as long as it says (up to 20 s) or, if it does not say, a little longer each time.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel().catch(() => {});
      const said = res.headers.get('retry-after'), wait = said !== null && said !== '' && Number.isFinite(Number(said)) ? Number(said) * 1000 : [2_000, 5_000][attempt]!;
      await sleep(Math.min(20_000, wait));
      continue;
    }
    const text = await res.text();
    if (res.status === 404) throw new NoData(`${host} has nothing at that address (HTTP 404)`);
    if (!res.ok) {
      const sec = /(^|\.)sec\.gov$/.test(new URL(url).hostname);
      const said = res.status === 403 || res.status === 429 ? excerpt(text) : '';
      throw new Unavailable(`${host} refused (HTTP ${res.status})${said ? `, saying "${said}"` : ''}${res.status === 429 ? '; it is rate-limiting this computer, so try again in a few minutes' : ''}${sec ? (emailNow().trim() ? ' [a contact email was sent]' : ' [no contact email was sent]') : ''}`);
    }
    const at = Date.now();
    writeCache(url, text);
    return { text, at };
  }
}

/** The cookies a host sets, whatever its answer: Yahoo hands its session cookie on a page that answers 404. */
export async function getCookies(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, emailNow()) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Unavailable(`${new URL(url).host} did not answer (${(e as Error).message})`);
  }
  await res.body?.cancel().catch(() => {});
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function getJson<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  return (await getJsonAt<T>(url, opts)).value;
}

/** The answer as data, and when it was read from the source. */
export async function getJsonAt<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ value: T; at: number }> {
  const { text, at } = await getTextAt(url, opts);
  try { return { value: JSON.parse(text) as T, at }; } catch { throw new Unavailable(`${new URL(url).host} answered with something that is not data`); }
}

/** What a tool says when a source failed: never an empty finding, never a number to guess around. */
export function failureText(e: unknown, what: string): string {
  if (e instanceof NoData) return `NO_DATA_AVAILABLE: ${what}: ${e.message}. Do not estimate or invent values; report that the data is not available.`;
  if (e instanceof Unavailable) return `DATA_UNAVAILABLE: ${what}: ${e.message}. This says nothing about the company; report the data as unavailable and do not estimate or invent values.`;
  return `DATA_UNAVAILABLE: ${what}: ${(e as Error).message}. Report the data as unavailable; do not estimate or invent values.`;
}
