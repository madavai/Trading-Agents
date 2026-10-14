// What the dashboard knows of Robinhood: whether a sign-in is saved, whether the person is in the middle of signing in, and
// what the last check found. It holds no sign-in itself (that stays in the person's own folder, store.ts) and opens a
// session only when asked: a check never opens a browser, and only "Connect" sends the person to Robinhood's page.
import fs from 'node:fs';
import { NotSignedIn, openSession, type SessionOptions } from './connect.js';
import type { Reader } from './reader.js';
import { readSaved } from './store.js';
import { oneLine } from './rules.js';

export type LinkState = 'none' | 'saved' | 'waiting' | 'connected' | 'failed';
export interface LinkInfo {
  state: LinkState;
  /** The state in plain words, for the page. */
  message: string;
  checkedAt: string | null;
  /** How many tools Robinhood offers, by kind (see rules.ts), as of the last good check. */
  tools: { read: number; order: number; other: number } | null;
}

type Last = { state: 'connected' | 'failed'; message: string; checkedAt: string; tools: LinkInfo['tools'] };

export class Link {
  private last: Last | null = null;
  private signing: Promise<void> | null = null;
  private checking: Promise<LinkInfo> | null = null;

  constructor(private readonly file: string, private readonly opts: Pick<SessionOptions, 'url' | 'port' | 'open'> & { now?: () => Date } = {}) {}

  private now = (): string => (this.opts.now?.() ?? new Date()).toISOString();
  private saved = (): boolean => !!readSaved(this.file).tokens;

  info(): LinkInfo {
    if (this.signing) return { state: 'waiting', message: "Waiting for you to finish signing in on Robinhood's page. This waits up to five minutes.", checkedAt: null, tools: null };
    if (this.last?.state === 'failed') return { ...this.last };
    if (!this.saved()) return { state: 'none', message: 'Robinhood is not connected.', checkedAt: null, tools: null };
    if (this.last) return { ...this.last };
    return { state: 'saved', message: 'A Robinhood sign-in is saved. It has not been checked since the dashboard started.', checkedAt: null, tools: null };
  }

  private good(reader: Reader): Last {
    const k = reader.byKind(), total = reader.tools.length;
    return { state: 'connected', checkedAt: this.now(), tools: { read: k.read.length, order: k.order.length, other: k.other.length },
      message: `Robinhood offers ${total} ${total === 1 ? 'tool' : 'tools'}: ${k.read.length} that only read, ${k.order.length} that order or move money (this page never uses them) and ${k.other.length} others.` };
  }

  private bad(e: unknown): Last {
    const words = oneLine(e instanceof Error ? e.message : String(e), 200);
    const why = e instanceof NotSignedIn ? 'Robinhood asks you to sign in again.' : /^Robinhood refused/.test(words) ? words : `Robinhood did not answer as expected: ${words}`;
    return { state: 'failed', checkedAt: this.now(), tools: null, message: why };
  }

  /** Sends the person to Robinhood's sign-in page and waits for them to come back, in the background. */
  startSignIn(): LinkInfo {
    if (this.signing) return this.info();
    this.last = null;
    this.signing = (async () => {
      try {
        const session = await openSession(this.file, { ...this.opts, signIn: true });
        try { this.last = this.good(session.reader); } finally { await session.close(); }
      } catch (e) {
        this.last = this.bad(e);
      } finally {
        this.signing = null;
      }
    })();
    return this.info();
  }

  /** Asks Robinhood whether the saved sign-in still works, and what it offers. Never opens a browser. */
  check(): Promise<LinkInfo> {
    if (this.signing) return Promise.resolve(this.info());
    this.checking ??= (async () => {
      try {
        const session = await openSession(this.file, { ...this.opts, signIn: false });
        try { this.last = this.good(session.reader); } finally { await session.close(); }
      } catch (e) {
        this.last = e instanceof NotSignedIn && !this.saved() ? null : this.bad(e);
      } finally {
        this.checking = null;
      }
      return this.info();
    })();
    return this.checking;
  }

  /** Deletes the saved sign-in. Robinhood is not told; the person can also end the access on Robinhood's side. */
  forget(): LinkInfo {
    fs.rmSync(this.file, { force: true });
    this.last = null;
    return this.info();
  }
}
