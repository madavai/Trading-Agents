// The one door to the outside for the data tools: a request with the desk's user agent, a time limit and one retry when
// a source is busy, and two kinds of failure kept apart - a source that could not answer (Unavailable) and a source
// that answered with no data for what was asked (NoData). Neither ever reads as "nothing happened".

export class Unavailable extends Error { override name = 'Unavailable'; }
export class NoData extends Error { override name = 'NoData'; }

import { userAgentFor } from '../check/probes.js';

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
let contact = 'trading-agents (+https://github.com/madavai/trading-agents)';
let secEmail = '';

/** For the tests and the server: the fetch to use, the user agent every source sees, and the email only the SEC sees. */
export function configure(opts: { fetch?: Fetch; contact?: string; secEmail?: string }): void {
  if (opts.fetch) fetchImpl = opts.fetch;
  if (opts.contact) contact = opts.contact;
  if (opts.secEmail !== undefined) secEmail = opts.secEmail;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, secEmail), Accept: '*/*', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (e) {
      const err = e as Error;
      if (attempt === 0 && err.name !== 'TimeoutError') { await sleep(800); continue; }
      throw new Unavailable(`${host} did not answer (${err.name === 'TimeoutError' ? 'no answer in time' : err.message})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await res.body?.cancel().catch(() => {});
      const wait = Math.min(5_000, (Number(res.headers.get('retry-after')) || 1.5) * 1000);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (res.status === 404) throw new NoData(`${host} has nothing at that address (HTTP 404)`);
    if (!res.ok) throw new Unavailable(`${host} refused (HTTP ${res.status})`);
    return text;
  }
}

/** The cookies a host sets, whatever its answer: Yahoo hands its session cookie on a page that answers 404. */
export async function getCookies(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': userAgentFor(url, contact, secEmail) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Unavailable(`${new URL(url).host} did not answer (${(e as Error).message})`);
  }
  await res.body?.cancel().catch(() => {});
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function getJson<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const text = await getText(url, opts);
  try { return JSON.parse(text) as T; } catch { throw new Unavailable(`${new URL(url).host} answered with something that is not data`); }
}

/** What a tool says when a source failed: never an empty finding, never a number to guess around. */
export function failureText(e: unknown, what: string): string {
  if (e instanceof NoData) return `NO_DATA_AVAILABLE: ${what}: ${e.message}. Do not estimate or invent values; report that the data is not available.`;
  if (e instanceof Unavailable) return `DATA_UNAVAILABLE: ${what}: ${e.message}. This says nothing about the company; report the data as unavailable and do not estimate or invent values.`;
  return `DATA_UNAVAILABLE: ${what}: ${(e as Error).message}. Report the data as unavailable; do not estimate or invent values.`;
}
