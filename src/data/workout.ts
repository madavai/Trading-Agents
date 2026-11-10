// The desk's calculator: the sums an agent would otherwise do in its head (a difference, a percentage, a ratio, an
// average) and the days between dates, worked out exactly and answered with the sum, so a report quotes a figure it can
// show. The fact-check of the desk's saved calls found 52 of the agents' own mistakes in such sums and 29 in dates.
// The expressions are read by a small parser of its own: numbers, + - * / ^, brackets, a % after a number, and a few
// named functions. Nothing in them is ever run as code.
import { addDays, analysisDate, daysBetween, parseDate, weekday, withWeekday } from './dates.js';
import { clock } from './market.js';
import { normalizeSymbol } from './symbols.js';
import { daily, type Series } from './yahoo.js';

export interface Sum { label?: string; expression: string }
export interface DateQuestion { date?: string; from?: string; to?: string; symbol?: string }

const FUNCTIONS: Record<string, { args: [number, number]; run: (xs: number[]) => number; says: string }> = {
  change: { args: [2, 2], run: ([a, b]) => (b! / a! - 1) * 100, says: 'change(a, b) is the percent change from a to b' },
  share: { args: [2, 2], run: ([a, b]) => (a! / b!) * 100, says: 'share(a, b) is a as a percent of b' },
  abs: { args: [1, 1], run: ([a]) => Math.abs(a!), says: 'abs(a) is a without its sign' },
  sqrt: { args: [1, 1], run: ([a]) => Math.sqrt(a!), says: 'sqrt(a) is the square root' },
  round: { args: [1, 2], run: ([a, d]) => roundHalfAway(a!, d ?? 0), says: 'round(a, d) rounds to d decimals, a half away from zero' },
  sum: { args: [1, 100], run: (xs) => xs.reduce((p, x) => p + x, 0), says: 'sum(...) adds them' },
  avg: { args: [1, 100], run: (xs) => xs.reduce((p, x) => p + x, 0) / xs.length, says: 'avg(...) is their average' },
  min: { args: [1, 100], run: (xs) => Math.min(...xs), says: 'min(...) and max(...) are the smallest and largest' },
  max: { args: [1, 100], run: (xs) => Math.max(...xs), says: '' },
};

// Only the helpers above: never a name every object has, such as "constructor".
const helper = (name: string) => (Object.hasOwn(FUNCTIONS, name.toLowerCase()) ? FUNCTIONS[name.toLowerCase()] : undefined);

class Refused extends Error {}

/** Rounds as a person does by hand, a half away from zero: 1.255 to 1.26, -2.5 to -3. The decimal point is moved in the
 *  number's own written form (1.255 → 125.5), since a power of ten multiplied in binary can land a half a hair low. */
function roundHalfAway(a: number, d: number): number {
  if (!Number.isInteger(d) || Math.abs(d) > 15) throw new Refused('round(a, d) needs d as a whole number of decimals, from -15 to 15');
  const shift = (x: number, by: number) => (String(x).includes('e') ? x * 10 ** by : Number(`${x}e${by}`));
  const r = shift(Math.floor(shift(Math.abs(a), d) + 0.5), -d);
  return a < 0 && r !== 0 ? -r : r;
}

/** A number written with a thousands comma ("45,123,456", "1,234.50"): a digit, a comma, three digits and no fourth. */
const THOUSANDS = /^\d+(?:,\d{3})+(?!\d)(?:\.\d*)?/;

/** One expression's value, or a plain reason it cannot be worked out. Exported for the tests. */
export function evaluate(expression: string): number {
  const src = expression.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/');
  let i = 0, inHelper = 0;
  const space = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const peek = () => { space(); return src[i] ?? ''; };
  const take = (c: string) => { if (peek() === c) { i++; return true; } return false; };
  const number = (): number => {
    space();
    // Inside a helper's brackets a comma separates numbers, so "45,123,456" would be read as three: refused instead.
    const t = inHelper ? THOUSANDS.exec(src.slice(i)) : null;
    if (t) throw new Refused(`"${t[0]}" reads as a number written with a thousands comma: write numbers without them (1234567, not 1,234,567), and put a space after each comma between numbers (avg(100, 200))`);
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
      inHelper++;
      const xs = [expr()];
      while (take(',')) xs.push(expr());
      inHelper--;
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

/** What the source cannot say about the days up to `end`: the days it lists with no prices, and, when its rows stop
 *  before `end` while its own record shows a session after its last row (rows are read a little past `end` to tell), the
 *  day they stop. None of these is a day with no trading. */
function unpriced(s: Series, end: string, now = Date.now()): { blank: Set<string>; stopsAt: string | null } {
  const last = s.bars.at(-1)?.date ?? '', session = s.meta.session;
  const stopped = !!session && now >= session.start && !!last && last < end && session.date > last;
  return { blank: new Set([...(s.missing ?? []), ...(s.unfilled ?? [])]), stopsAt: stopped ? last : null };
}

/** The session the source's own record shows has not opened yet, with when it opens: "2026-11-09", "09:30 America/New_York
 *  time". Before the open, today is neither a session that traded nor a day with no trading. */
function notOpen(s: Series, now = Date.now()): { date: string; opens: string } | null {
  const x = s.meta.session;
  return x && now < x.start ? { date: x.date, opens: clock(x.start, s.meta.timezone) } : null;
}

async function dateAnswer(q: DateQuestion, day: string): Promise<string> {
  const sym = q.symbol ? normalizeSymbol(q.symbol) : '';
  const past = (end: string) => { const x = addDays(end, 10); return x < day ? x : day; };   // a little past a day, to see that the source goes on
  if (q.date && !q.from && !q.to) {
    const d = parseDate(q.date);
    const line = `- ${d} is a ${LONG[weekday(d)]}.`;
    if (!sym) return line;
    if (d > day) return `${line} ${sym}'s sessions after the analysis date, ${day}, are not known to the desk.`;
    const s = await daily(sym, addDays(d, -10), past(d)), last = s.bars.filter((r) => r.date <= d).at(-1), gaps = unpriced(s, d);
    if (last?.date === d) return `${line} ${sym} traded that day.`;
    const before = last ? `; its session on or before it: ${withWeekday(last.date)}` : '', soon = notOpen(s);
    if (soon?.date === d) return `${line} ${sym}'s session that day has not opened yet (it opens at ${soon.opens})${last ? `; its latest session before it: ${withWeekday(last.date)}` : ''}.`;
    if (gaps.blank.has(d)) return `${line} The source lists ${d} as a session of ${sym} but gives no prices for it (yet): its prices are not available${last ? ` (the latest session with prices before it: ${withWeekday(last.date)})` : ''}. Do not say ${sym} did not trade that day.`;
    if (gaps.stopsAt) return `${line} Whether ${sym} traded that day is not known from the source: its own record shows a session on ${s.meta.session!.date}, but its prices stop at ${withWeekday(gaps.stopsAt)}. Do not say ${sym} did not trade that day.`;
    return `${line} ${sym} did not trade that day${before}.`;
  }
  if (!q.from || !q.to) throw new Refused('give a date, or a from date and a to date');
  let a = parseDate(q.from, 'from date'), b = parseDate(q.to, 'to date');
  if (a > b) [a, b] = [b, a];
  const days = daysBetween(a, b);
  const parts = [`- From ${withWeekday(a)} to ${withWeekday(b)}: ${days} calendar day${days === 1 ? '' : 's'}${weeks(days)}; ${weekdaysBetween(a, b)} weekdays after the first date up to and including the second.`];
  if (sym) {
    if (b > day) parts.push(` ${sym}'s sessions after the analysis date, ${day}, are not known to the desk: counted to ${withWeekday(day)}.`);
    const end = b > day ? day : b, s = await daily(sym, a, past(end)), rows = s.bars.filter((r) => r.date <= end), gaps = unpriced(s, end);
    const after = rows.filter((r) => r.date > a), traded = rows.length && rows[0]!.date === a;
    const blank = [...gaps.blank].filter((x) => x >= a && x <= end).sort();
    const sure = !blank.length && !gaps.stopsAt, soon = notOpen(s), later = soon && soon.date >= a && soon.date <= end ? soon : null;
    parts.push(` ${sym} ${sure ? 'traded' : 'has prices'} on ${after.length} session${after.length === 1 ? '' : 's'} after ${a} up to and including ${end}${after.length ? ` (the first ${withWeekday(after[0]!.date)}, the last ${withWeekday(after.at(-1)!.date)})` : ''}; ${a} itself ${traded ? 'was a session, so both included it is ' + (after.length + 1) : blank[0] === a ? 'is listed by the source with no prices' : later?.date === a ? `has not opened yet (it opens at ${later.opens})` : sure ? 'was not a session' : 'has no prices from the source'}.`);
    if (later && later.date > a) parts.push(` ${later.date}'s session has not opened yet (it opens at ${later.opens}): it is not counted.`);
    if (blank.length) parts.push(` The source lists ${blank.map(withWeekday).join(', ')} as ${blank.length === 1 ? 'a session' : 'sessions'} with no prices: not counted here, so the true count may be higher. Do not say ${blank.length === 1 ? 'that day' : 'those days'} had no trading.`);
    if (gaps.stopsAt) parts.push(` The source's prices stop at ${withWeekday(gaps.stopsAt)}, though its own record shows a session on ${s.meta.session!.date}: the sessions after ${gaps.stopsAt} are not known from it, so the true count may be higher.`);
  }
  return parts.join('');
}

/** The answers to a batch of sums and date questions, each with its working. */
/** A sum needs no date, so the analysis date is asked only with the date questions: required for every call, it cost the
 *  replayed debaters a refused call in most of their turns (9 Nov 2026). Given, it is checked either way. */
export async function workOut(analysis: string | undefined, sums: Sum[] = [], dates: DateQuestion[] = []): Promise<string> {
  if (!sums.length && !dates.length) throw new Error('give at least one sum or one date question');
  if (dates.length && !analysis) throw new Error('a date question needs the analysis date (analysis_date): nothing after it is ever counted');
  const day = analysis ? analysisDate(analysis) : '';
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
