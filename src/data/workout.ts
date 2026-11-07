// The desk's calculator: the sums an agent would otherwise do in its head (a difference, a percentage, a ratio, an
// average) and the days between dates, worked out exactly and answered with the sum, so a report quotes a figure it can
// show. The fact-check of the desk's saved calls found 52 of the agents' own mistakes in such sums and 29 in dates.
// The expressions are read by a small parser of its own: numbers, + - * / ^, brackets, a % after a number, and a few
// named functions. Nothing in them is ever run as code.
import { addDays, analysisDate, daysBetween, parseDate, weekday, withWeekday } from './dates.js';
import { normalizeSymbol } from './symbols.js';
import { daily } from './yahoo.js';

export interface Sum { label?: string; expression: string }
export interface DateQuestion { date?: string; from?: string; to?: string; symbol?: string }

const FUNCTIONS: Record<string, { args: [number, number]; run: (xs: number[]) => number; says: string }> = {
  change: { args: [2, 2], run: ([a, b]) => (b! / a! - 1) * 100, says: 'change(a, b) is the percent change from a to b' },
  share: { args: [2, 2], run: ([a, b]) => (a! / b!) * 100, says: 'share(a, b) is a as a percent of b' },
  abs: { args: [1, 1], run: ([a]) => Math.abs(a!), says: 'abs(a) is a without its sign' },
  sqrt: { args: [1, 1], run: ([a]) => Math.sqrt(a!), says: 'sqrt(a) is the square root' },
  round: { args: [1, 2], run: ([a, d]) => { const k = 10 ** (d ?? 0); return Math.round(a! * k) / k; }, says: 'round(a, d) rounds to d decimals' },
  sum: { args: [1, 100], run: (xs) => xs.reduce((p, x) => p + x, 0), says: 'sum(...) adds them' },
  avg: { args: [1, 100], run: (xs) => xs.reduce((p, x) => p + x, 0) / xs.length, says: 'avg(...) is their average' },
  min: { args: [1, 100], run: (xs) => Math.min(...xs), says: 'min(...) and max(...) are the smallest and largest' },
  max: { args: [1, 100], run: (xs) => Math.max(...xs), says: '' },
};

// Only the helpers above: never a name every object has, such as "constructor".
const helper = (name: string) => (Object.hasOwn(FUNCTIONS, name.toLowerCase()) ? FUNCTIONS[name.toLowerCase()] : undefined);

class Refused extends Error {}

/** One expression's value, or a plain reason it cannot be worked out. Exported for the tests. */
export function evaluate(expression: string): number {
  const src = expression.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
  let i = 0;
  const space = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const peek = () => { space(); return src[i] ?? ''; };
  const take = (c: string) => { if (peek() === c) { i++; return true; } return false; };
  const number = (): number => {
    space();
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new Refused(src[i] === undefined ? 'it ends where a number should be' : `"${src.slice(i, i + 12)}" is not a number`);
    i += m[0].length;
    return Number(m[0]);
  };
  const primary = (): number => {
    if (take('(')) { const v = expr(); if (!take(')')) throw new Refused('a bracket is not closed'); return v; }
    space();
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      const f = helper(id[0]);
      if (!f) throw new Refused(`"${id[0]}" is not something it knows: use numbers, + - * / ^, brackets, % and ${Object.keys(FUNCTIONS).join(', ')}`);
      i += id[0].length;
      if (!take('(')) throw new Refused(`${id[0]} needs its numbers in brackets`);
      const xs = [expr()];
      while (take(',')) xs.push(expr());
      if (!take(')')) throw new Refused(`the brackets of ${id[0]} are not closed`);
      if (xs.length < f.args[0] || xs.length > f.args[1]) throw new Refused(`${id[0]} takes ${f.args[0] === f.args[1] ? f.args[0] : `${f.args[0]} to ${f.args[1]}`} number${f.args[1] > 1 ? 's' : ''}, not ${xs.length} (write numbers without thousands commas: 1234567, not 1,234,567)`);
      return f.run(xs);
    }
    return number();
  };
  const postfix = (): number => { let v = primary(); while (take('%')) v /= 100; return v; };
  const power = (): number => { const b = postfix(); return take('^') ? b ** unary() : b; };
  const unary = (): number => (take('-') ? -unary() : take('+') ? unary() : power());
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (take('*')) v *= unary();
      else if (take('/')) { const d = unary(); if (d === 0) throw new Refused('it divides by zero'); v /= d; }
      else return v;
    }
  };
  const expr = (): number => { let v = term(); for (;;) { if (take('+')) v += term(); else if (take('-')) v -= term(); else return v; } };
  const v = expr();
  if (peek() === ',') throw new Refused('a comma outside a function\'s brackets: write numbers without thousands commas (1234567, not 1,234,567)');
  if (peek()) throw new Refused(`"${src.slice(i, i + 12)}" was not expected there`);
  if (!Number.isFinite(v)) throw new Refused('the answer is not a finite number');
  return v;
}

/** A result as the desk writes it: up to four decimals, or four significant figures below one, with thousands commas. */
export function shown(v: number): string {
  const opts = Math.abs(v) >= 1 || v === 0 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
  const t = v.toLocaleString('en-US', opts);
  return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t;
}

const weeks = (days: number) => { const w = Math.floor(Math.abs(days) / 7), r = Math.abs(days) % 7; return w ? ` (${w} week${w > 1 ? 's' : ''}${r ? ` and ${r} day${r > 1 ? 's' : ''}` : ''})` : ''; };
const LONG: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/** The weekdays after `from` up to and including `to`. */
function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (!['Sat', 'Sun'].includes(weekday(d))) n++;
  return n;
}

async function dateAnswer(q: DateQuestion, day: string): Promise<string> {
  const sym = q.symbol ? normalizeSymbol(q.symbol) : '';
  if (q.date && !q.from && !q.to) {
    const d = parseDate(q.date);
    const line = `- ${d} is a ${LONG[weekday(d)]}.`;
    if (!sym) return line;
    if (d > day) return `${line} ${sym}'s sessions after the analysis date, ${day}, are not known to the desk.`;
    const rows = (await daily(sym, addDays(d, -10), d)).bars;
    const last = rows.at(-1);
    return `${line} ${last?.date === d ? `${sym} traded that day.` : `${sym} did not trade that day${last ? `; its session on or before it: ${withWeekday(last.date)}` : ''}.`}`;
  }
  if (!q.from || !q.to) throw new Refused('give a date, or a from date and a to date');
  let a = parseDate(q.from, 'from date'), b = parseDate(q.to, 'to date');
  if (a > b) [a, b] = [b, a];
  const days = daysBetween(a, b);
  const parts = [`- From ${withWeekday(a)} to ${withWeekday(b)}: ${days} calendar day${days === 1 ? '' : 's'}${weeks(days)}; ${weekdaysBetween(a, b)} weekdays after the first date up to and including the second.`];
  if (sym) {
    if (b > day) parts.push(` ${sym}'s sessions after the analysis date, ${day}, are not known to the desk: counted to ${withWeekday(day)}.`);
    const end = b > day ? day : b, rows = (await daily(sym, a, end)).bars;
    const after = rows.filter((r) => r.date > a), traded = rows.length && rows[0]!.date === a;
    parts.push(` ${sym} traded on ${after.length} session${after.length === 1 ? '' : 's'} after ${a} up to and including ${end}${after.length ? ` (the first ${withWeekday(after[0]!.date)}, the last ${withWeekday(after.at(-1)!.date)})` : ''}; ${a} itself ${traded ? 'was a session, so both included it is ' + (after.length + 1) : 'was not a session'}.`);
  }
  return parts.join('');
}

/** The answers to a batch of sums and date questions, each with its working. */
export async function workOut(analysis: string, sums: Sum[] = [], dates: DateQuestion[] = []): Promise<string> {
  const day = analysisDate(analysis);
  if (!sums.length && !dates.length) throw new Error('give at least one sum or one date question');
  const out: string[] = [];
  const used = new Set<string>();
  if (sums.length) {
    out.push('## Sums, worked out by the desk', '');
    for (const s of sums) {
      for (const m of s.expression.toLowerCase().matchAll(/[a-z]+(?=\s*\()/g)) used.add(m[0]);
      const label = s.label ? `${s.label.trim()}: ` : '';
      try { out.push(`- ${label}${s.expression.trim()} = ${shown(evaluate(s.expression))}`); } catch (e) {
        out.push(`- ${label}${s.expression.trim()}: cannot be worked out, ${e instanceof Refused ? e.message : (e as Error).message}.`);
      }
    }
    const says = [...used].map((u) => helper(u)?.says).filter(Boolean);
    if (says.length) out.push('', `${says.join('; ')}.`);
    out.push('', 'Quote a result with its sum, as written here, and round it only when you say so.');
  }
  if (dates.length) {
    out.push(...(out.length ? [''] : []), '## Dates, worked out by the desk', '');
    for (const q of dates) {
      try { out.push(await dateAnswer(q, day)); } catch (e) { out.push(`- ${JSON.stringify(q)}: cannot be answered, ${(e as Error).message}.`); }
    }
  }
  return out.join('\n');
}
