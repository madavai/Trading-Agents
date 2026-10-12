// The decision journal: an append-only markdown record of every call the desk made and, once the holding window has
// traded, how it turned out against its market index, with a short lesson. The lessons are read back into later analyses
// of the same and other stocks - but a past-dated analysis only sees lessons whose outcome was already known on its date.
// The file format is TradingAgents' memory log (tradingagents/memory/log.py), Apache License 2.0, rewritten in TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW, RATINGS, parseRating } from './rating.js';
import { withLock, writeWhole } from './lock.js';

export interface Entry {
  date: string; ticker: string; rating: string; pending: boolean;
  raw: string | null; alpha: string | null; holding: string | null; resolved: string | null;
  decision: string; reflection: string;
}

const SEPARATOR = '\n\n<!-- ENTRY_END -->\n\n';
const pct = (v: number) => `${v >= 0 ? '+' : '-'}${(Math.abs(v) * 100).toFixed(1)}%`;

const MARK = /<!--\s*ENTRY_END\s*-->/i;

/** A model's words made safe to keep: they can never end the entry early or fake a section of it. The separator is removed
 *  until none is left, since taking one out can join the pieces around it into another. */
function keep(text: string): string {
  let s = text;
  while (MARK.test(s)) s = s.replace(MARK, '');
  return s.replace(/^([ \t]*)(DECISION|REFLECTION):/gim, '$1$2 -').trim();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/, TICKER = /^[A-Za-z0-9.\-=^]{1,20}$/;
/** The parts of an entry's tag are checked, not trusted: a stray bar or bracket would split or forge the tag. */
function checkTag(ticker: string, date: string): void {
  if (!TICKER.test(ticker)) throw new Error(`"${ticker}" is not a ticker the journal can keep`);
  if (!DATE.test(date)) throw new Error(`"${date}" is not a date in YYYY-MM-DD form`);
}

function parse(block: string): Entry | null {
  const lines = block.trim().split(/\r?\n/);
  const tag = lines[0]?.trim() ?? '';
  if (!tag.startsWith('[') || !tag.endsWith(']')) return null;
  const f = tag.slice(1, -1).split('|').map((s) => s.trim());
  if (f.length < 4) return null;
  const body = lines.slice(1).join('\n').trim();
  const decision = /DECISION:\n([\s\S]*?)(?=\nREFLECTION:|$)/.exec(body)?.[1]?.trim() ?? '';
  const reflection = /REFLECTION:\n([\s\S]*)$/.exec(body)?.[1]?.trim() ?? '';
  const resolved = f.slice(6).find((x) => x.startsWith('resolved:'))?.slice('resolved:'.length).trim() ?? null;
  return { date: f[0]!, ticker: f[1]!, rating: f[2]!, pending: f[3] === 'pending', raw: f[3] === 'pending' ? null : f[3]!, alpha: f[4] ?? null, holding: f[5] ?? null, resolved, decision, reflection };
}

export class Journal {
  /** @param maxResolved keep at most this many settled entries (the oldest go first); pending ones are never dropped */
  constructor(readonly file: string, private maxResolved: number | null = null) {}

  private read(): string { try { return fs.readFileSync(this.file, 'utf8'); } catch { return ''; } }
  private write(text: string): void { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeWhole(this.file, text); }
  private blocks(): string[] { return this.read().split(SEPARATOR).filter((b) => b.trim()); }

  load(): Entry[] { return this.blocks().map(parse).filter((e): e is Entry => e !== null); }
  pending(): Entry[] { return this.load().filter((e) => e.pending); }

  /** Adds a pending entry. One entry per stock and day, settled or not: a re-run must not count the same call twice. */
  storeDecision(ticker: string, date: string, decision: string, rating?: string): 'stored' | 'exists' {
    checkTag(ticker, date);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.file, () => {
      if (this.load().some((e) => e.date === date && e.ticker === ticker)) return 'exists';
      const r = rating && (RATINGS as readonly string[]).includes(rating) ? rating : parseRating(decision);
      const old = this.read();
      this.write(`${old}${old && !old.endsWith(SEPARATOR) ? SEPARATOR : ''}[${date} | ${ticker} | ${r} | pending]\n\nDECISION:\n${keep(decision)}${SEPARATOR}`);
      return 'stored';
    });
  }

  /** Settles a pending entry with its measured outcome and the lesson. False when it was no longer pending. */
  recordOutcome(ticker: string, date: string, raw: number, alpha: number, holdingDays: number, reflection: string, resolution: string): boolean {
    return withLock(this.file, () => {
      let done = false;
      const out = this.blocks().map((block) => {
        const e = parse(block);
        if (done || !e || !e.pending || e.date !== date || e.ticker !== ticker) return block;
        done = true;
        return `[${date} | ${ticker} | ${e.rating} | ${pct(raw)} | ${pct(alpha)} | ${holdingDays}d | resolved:${resolution}]\n\nDECISION:\n${e.decision}\n\nREFLECTION:\n${keep(reflection)}`;
      });
      if (!done) return false;
      this.write(this.rotate(out).join(SEPARATOR) + SEPARATOR);
      return true;
    });
  }

  private rotate(blocks: string[]): string[] {
    if (!this.maxResolved || this.maxResolved <= 0) return blocks;
    const settled = blocks.filter((b) => { const e = parse(b); return e && !e.pending; }).length;
    let drop = settled - this.maxResolved;
    return drop <= 0 ? blocks : blocks.filter((b) => { const e = parse(b); if (e && !e.pending && drop > 0) { drop--; return false; } return true; });
  }

  /** The lessons for an analysis: the latest settled calls on this stock in full, and the latest on others as lessons only.
   *  With `asOf`, only calls whose outcome was already known on that day - a past-dated run must not learn from its future. */
  pastContext(ticker: string, o: { asOf?: string; sameLimit?: number; otherLimit?: number } = {}): string {
    const { sameLimit = 5, otherLimit = 3 } = o;
    let settled = this.load().filter((e) => !e.pending);
    if (o.asOf) settled = settled.filter((e) => e.resolved && e.resolved <= o.asOf!);
    const same: Entry[] = [], other: Entry[] = [];
    for (const e of settled.reverse()) {
      if (e.ticker === ticker ? same.length < sameLimit : other.length < otherLimit) (e.ticker === ticker ? same : other).push(e);
      if (same.length >= sameLimit && other.length >= otherLimit) break;
    }
    if (!same.length && !other.length) return '';
    const full = (e: Entry) => [`[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw ?? 'n/a'} | ${e.alpha ?? 'n/a'} | ${e.holding ?? 'n/a'}]`, `DECISION:\n${e.decision}`, ...(e.reflection ? [`REFLECTION:\n${e.reflection}`] : [])].join('\n\n');
    const short = (e: Entry) => `[${e.date} | ${e.ticker} | ${e.rating} | ${e.raw ?? 'n/a'}]\n${e.reflection || e.decision.slice(0, 300) + (e.decision.length > 300 ? '...' : '')}`;
    const parts: string[] = [];
    if (same.length) parts.push(`Past analyses of ${ticker} (most recent first):`, ...same.map(full));
    if (other.length) parts.push('Recent cross-ticker lessons:', ...other.map(short));
    return parts.join('\n\n');
  }
}

export { REVIEW };
