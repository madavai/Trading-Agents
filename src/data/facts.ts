// Price facts: what an agent would otherwise count by eye in long tables of prices and indicators (how many sessions in
// a row, the first or the last time, a record, a rank, how often, a crossing), worked out here from the same daily rows
// as the checked price table, every date with its weekday. The fact-check of the desk's saved calls found most of the
// agents' own mistakes in exactly such claims, so the agents now state one only as this tool gives it.
import { analysisDate, withWeekday } from './dates.js';
import { atr, bollinger, ema, macd, rsi, sma, vwma, type Values } from './indicators.js';
import { adjustedWords, latestState } from './market.js';
import { normalizeSymbol } from './symbols.js';
import { history, type Series } from './yahoo.js';
import { signed } from '../numbers.js';

/** The windows facts are counted in: sessions back from the latest row, the latest included. */
export const WINDOWS: ReadonlyArray<readonly [number, string]> = [[20, 'about a month'], [63, 'about three months'], [126, 'about six months'], [252, 'about a year']];
// Enough calendar days for the 200-day average to have a value across the year's window.
const CALENDAR_DAYS = 700;
const CROSSES_SHOWN = 6, TOP = 3;

const f2 = (v: number) => v.toFixed(2);
const vol = (v: number) => Math.round(v).toLocaleString('en-US');
// Directions and sides are judged on figures rounded to the cent, as every table shows them, so a fact never rests on a
// difference no table can show.
const cent = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
type Side = 1 | -1 | 0 | null;
const cmp = (a: number | null | undefined, b: number | null | undefined): Side => {
  const x = cent(a), y = cent(b);
  return x === null || y === null ? null : x > y ? 1 : x < y ? -1 : 0;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function priceFacts(raw: string, analysis: string): Promise<string> {
  const day = analysisDate(analysis);
  return priceFactsText(normalizeSymbol(raw), day, await history(raw, day, CALENDAR_DAYS));
}

/** The facts as text, from rows already held to the analysis date. Exported for the tests. */
export function priceFactsText(sym: string, day: string, s: Series): string {
  const bars = s.bars, n = bars.length, L = n - 1;
  const d = (i: number) => withWeekday(bars[i]!.date);
  const close = bars.map((b) => b.close), m = macd(close), bb = bollinger(close);
  const ema10 = ema(close, 10), sma50 = sma(close, 50), sma200 = sma(close, 200), vw = vwma(bars), rsi14 = rsi(close), atr14 = atr(bars);
  const change: Values = close.map((c, i) => (i && close[i - 1] ? (c / close[i - 1]! - 1) * 100 : null));
  const windows = WINDOWS.map(([size, words]) => ({ size: Math.min(size, n), words: size <= n ? words : 'all on record', full: size }));
  const from = (w: { size: number }) => n - w.size;
  // A volume the source does not give is left out of every volume fact, never ranked as a zero; with no volume traded on
  // any row (a currency pair's zeros) there are no volume facts at all.
  const anyVolume = bars.some((b) => b.volume !== null && b.volume > 0);
  const volumeOf = (i: number): number | null => (anyVolume ? bars[i]!.volume : null);
  const noVolume = bars.map((b, i) => (b.volume === null ? i : -1)).filter((i) => i >= 0);
  const volumeNote = !anyVolume ? ['- The source gives no volume for these rows (or none traded): there are no volume facts here, and VWMA has no value.']
    : noVolume.length ? [`- The source gives no volume for ${plural(noVolume.length, 'session')} (${noVolume.slice(-5).map(d).join('; ')}${noVolume.length > 5 ? ', and earlier ones' : ''}): ${noVolume.length === 1 ? 'it is' : 'they are'} left out of every volume fact, and VWMA has no value on a window that includes ${noVolume.length === 1 ? 'it' : 'them'}.`] : [];

  const out = [
    `## Price facts for ${sym}, worked out by the desk`, '',
    `- Analysis date: ${withWeekday(day)}. Latest row: ${d(L)}. Rows after the analysis date are excluded.`,
    `- From the same daily prices as the checked price table (${adjustedWords(s)}) and the same indicators (10 EMA, 50 SMA, 200 SMA, VWMA, RSI, MACD, Bollinger bands, ATR). A session is a trading day; every date carries its weekday.`,
    ...volumeNote,
    `- Windows count back from the latest row, which they include: ${windows.map((w) => `the last ${w.size} sessions${w.size < w.full ? ' (all on record)' : ''} from ${d(from(w))}`).join('; ')}.`,
    '- Directions and sides are judged on figures rounded to the cent, as the tables show them.',
    ...latestState(s, day).lines, '',
    'Quote a fact as it stands here, naming its window ("the lowest RSI of the last 63 sessions"). A run, a first or a last time, a record, a rank, a count of sessions or a crossing that is not here is not known to the desk: leave it out rather than count it by eye.', '',
  ];

  // Runs up to the latest row: how many sessions in a row, from what to what, and what the session before did.
  const dir = (v: Values, i: number): Side => (i ? cmp(v[i], v[i - 1]) : null);
  const trend = (name: string, v: Values, up = 'rising', down = 'falling', rose = 'rose', fell = 'fell'): string | null => {
    const now = dir(v, L);
    if (now === null) return null;
    let st = L;
    while (st - 1 >= 1 && dir(v, st - 1) === now) st--;
    const len = L - st + 1, word = now > 0 ? up : now < 0 ? down : 'unchanged', before = st >= 2 ? dir(v, st - 1) : null;
    const last20 = Array.from({ length: Math.min(20, n - 1) }, (_, k) => dir(v, L - k)).filter((x) => x !== null);
    const tally = `Over the last ${last20.length} sessions it ${rose} on ${last20.filter((x) => x === 1).length} and ${fell} on ${last20.filter((x) => x === -1).length}${last20.some((x) => x === 0) ? `, unchanged on ${last20.filter((x) => x === 0).length}` : ''}.`;
    const span = len === 1 ? `on the latest session, ${d(L)}` : `on each of the last ${len} sessions, ${d(st)} to ${d(L)}`;
    const prior = before === null ? '' : `; on ${d(st - 1)} it ${before > 0 ? rose : before < 0 ? fell : 'was unchanged'}`;
    return `- ${name}: ${word} ${span}, from ${f2(v[st - 1]!)} to ${f2(v[L]!)}${prior}. ${tally}`;
  };
  out.push('### Runs up to the latest row', '');
  out.push(...[
    trend('Close', close, 'up', 'down', 'closed up', 'closed down'), trend('10 EMA', ema10), trend('50 SMA', sma50), trend('200 SMA', sma200), trend('VWMA', vw),
    trend('RSI', rsi14), trend('MACD', m.macd), trend('MACD histogram', m.hist), trend('ATR', atr14),
  ].filter((x): x is string => x !== null));

  // Which side of a line, since when, and the crossings of the last year, newest first.
  const year = Math.max(0, n - 252);
  const sides = (a: string, av: Values, b: string, bv: Values, what = 'session'): string | null => {
    const sd = (i: number) => cmp(av[i], bv[i]), now = sd(L);
    if (now === null) return null;
    let st = L;
    while (st - 1 >= 0 && sd(st - 1) === now) st--;
    const len = L - st + 1, word = now > 0 ? 'above' : now < 0 ? 'below' : 'level with';
    const prev = st - 1 >= 0 ? sd(st - 1) : null;
    const before = st === 0 ? ` (every ${what} on record)`
      : prev === null ? `; before ${d(st)} the ${b} had no value yet`
      : prev === 0 ? `; on ${d(st - 1)} they were level to the cent`
      : `; the last ${what} ${prev > 0 ? 'above' : 'below'} it was ${d(st - 1)} (${f2(av[st - 1]!)} against ${f2(bv[st - 1]!)})`;
    const crosses: Array<{ i: number; up: boolean }> = [];
    let last: Side = null;
    for (let i = 0; i < n; i++) {
      const x = sd(i);
      if (x === null || x === 0) continue;
      if (last !== null && x !== last && i >= year) crosses.push({ i, up: x > 0 });
      last = x;
    }
    const span = len === 1 ? `on the latest ${what}, ${d(L)}` : `on each of the last ${plural(len, what)}, since ${d(st)}`;
    const list = crosses.length
      ? ` Crossings in the last ${L - year + 1} sessions (${crosses.length} in all${crosses.length > CROSSES_SHOWN ? `, the ${CROSSES_SHOWN} latest shown` : ''}, newest first): ${crosses.reverse().slice(0, CROSSES_SHOWN).map((c) => `${c.up ? 'above' : 'below'} on ${d(c.i)}`).join('; ')}.`
      : ` No crossing in the last ${L - year + 1} sessions.`;
    return `- ${a} ${word} the ${b} ${span}${before}.${list}`;
  };
  const zero: Values = close.map(() => 0);
  out.push('', '### Sides and crossings', '');
  out.push(...[
    sides('Close', close, '10 EMA', ema10, 'close'), sides('Close', close, '50 SMA', sma50, 'close'), sides('Close', close, '200 SMA', sma200, 'close'), sides('Close', close, 'VWMA', vw, 'close'),
    sides('Close', close, 'Bollinger middle', bb.mid, 'close'), sides('10 EMA', ema10, '50 SMA', sma50), sides('50 SMA', sma50, '200 SMA', sma200),
    sides('MACD', m.macd, 'MACD signal', m.signal), sides('MACD', m.macd, 'zero line', zero),
  ].filter((x): x is string => x !== null));

  // How often, in each window: the count, the first in that window, and the latest in the last year.
  const up = (i: number) => (i ? (dir(close, i) === null ? null : dir(close, i) === 1) : null);
  const down = (i: number) => (i ? (dir(close, i) === null ? null : dir(close, i) === -1) : null);
  const below = (v: Values) => (i: number) => { const x = cmp(close[i], v[i]); return x === null ? null : x < 0; };
  const over = (a: (i: number) => number | null | undefined, v: Values, sign: 1 | -1) => (i: number) => { const x = cmp(a(i), v[i]); return x === null ? null : x === sign; };
  const level = (v: Values, t: (x: number) => boolean) => (i: number) => (cent(v[i]) === null ? null : t(cent(v[i])!));
  const counts: Array<[string, (i: number) => boolean | null]> = [
    ['Up closes (above the close before)', up], ['Down closes (below the close before)', down],
    ['Closes below the 10 EMA', below(ema10)], ['Closes below the 50 SMA', below(sma50)], ['Closes below the 200 SMA', below(sma200)], ['Closes below the VWMA', below(vw)],
    ['Closes above the upper Bollinger band', over((i) => close[i], bb.upper, 1)], ['Highs above the upper Bollinger band', over((i) => bars[i]!.high, bb.upper, 1)],
    ['Closes below the lower Bollinger band', over((i) => close[i], bb.lower, -1)], ['Lows below the lower Bollinger band', over((i) => bars[i]!.low, bb.lower, -1)],
    ['RSI at 70 or above', level(rsi14, (x) => x >= 70)], ['RSI at 30 or below', level(rsi14, (x) => x <= 30)], ['RSI below 50', level(rsi14, (x) => x < 50)],
    ['MACD below its signal', over((i) => m.macd[i], m.signal, -1)], ['MACD below zero', level(m.macd, (x) => x < 0)],
    ['Days up 3% or more', level(change, (x) => x >= 3)], ['Days down 3% or more', level(change, (x) => x <= -3)],
  ];
  out.push('', '### How often, in each window', '', `Fact | ${windows.map((w) => `Last ${w.size} sessions`).join(' | ')} | Latest in the last year`, `---|${windows.map(() => '---').join('|')}|---`);
  for (const [name, t] of counts) {
    const cells = windows.map((w) => {
      const idx = Array.from({ length: w.size }, (_, k) => from(w) + k), known = idx.filter((i) => t(i) !== null), hits = known.filter((i) => t(i) === true);
      const of = known.length < idx.length ? ` of ${plural(known.length, 'session')} with a value` : '';
      return hits.length ? `${hits.length}${of}, first ${d(hits[0]!)}` : `0${of}`;
    });
    const latest = Array.from({ length: L - year + 1 }, (_, k) => L - k).find((i) => t(i) === true);
    out.push(`${name} | ${cells.join(' | ')} | ${latest === undefined ? '–' : d(latest)}`);
  }

  // The highest and lowest of each window, ranked, ties the latest first.
  const pct = (i: number) => `${signed(change[i]!, 2)}%`;
  const extremes: Array<[string, (i: number) => number | null | undefined, 1 | -1, (i: number) => string, ((i: number) => boolean)?]> = [
    ['Highest closes', (i) => close[i], 1, (i) => f2(close[i]!)], ['Lowest closes', (i) => close[i], -1, (i) => f2(close[i]!)],
    ['Highest intraday highs', (i) => bars[i]!.high, 1, (i) => f2(bars[i]!.high)], ['Lowest intraday lows', (i) => bars[i]!.low, -1, (i) => f2(bars[i]!.low)],
    ['Biggest daily rises', (i) => change[i], 1, (i) => `${pct(i)} (${signed(close[i]! - close[i - 1]!, 2)})`, (i) => (change[i] ?? 0) > 0],
    ['Biggest daily falls', (i) => change[i], -1, (i) => `${pct(i)} (${signed(close[i]! - close[i - 1]!, 2)})`, (i) => (change[i] ?? 0) < 0],
    ['Heaviest volume', volumeOf, 1, (i) => `${vol(volumeOf(i)!)}${change[i] === null ? '' : ` (close ${pct(i)})`}`],
    ['Heaviest volume on a down close', volumeOf, 1, (i) => `${vol(volumeOf(i)!)} (close ${pct(i)})`, (i) => down(i) === true],
    ['Heaviest volume on an up close', volumeOf, 1, (i) => `${vol(volumeOf(i)!)} (close ${pct(i)})`, (i) => up(i) === true],
    ['Lightest volume', volumeOf, -1, (i) => vol(volumeOf(i)!)],
    ['Highest RSI', (i) => rsi14[i], 1, (i) => f2(rsi14[i]!)], ['Lowest RSI', (i) => rsi14[i], -1, (i) => f2(rsi14[i]!)],
    ['Highest MACD', (i) => m.macd[i], 1, (i) => f2(m.macd[i]!)], ['Lowest MACD', (i) => m.macd[i], -1, (i) => f2(m.macd[i]!)],
    ['Highest MACD histogram', (i) => m.hist[i], 1, (i) => f2(m.hist[i]!)], ['Lowest MACD histogram', (i) => m.hist[i], -1, (i) => f2(m.hist[i]!)],
    ['Highest ATR', (i) => atr14[i], 1, (i) => f2(atr14[i]!)], ['Lowest ATR', (i) => atr14[i], -1, (i) => f2(atr14[i]!)],
  ];
  out.push('', '### Highest and lowest in each window', '', `The ${TOP} highest or lowest of each window, first to ${TOP === 3 ? 'third' : 'last'}; a tie is ranked latest first.`);
  for (const w of windows) {
    out.push('', `Last ${w.size} sessions (${w.words}, from ${d(from(w))}) | First | Second | Third`, '---|---|---|---');
    for (const [name, key, sign, show, keep] of extremes) {
      const idx = Array.from({ length: w.size }, (_, k) => from(w) + k).filter((i) => cent(key(i)) !== null && (!keep || keep(i)));
      const ranked = idx.sort((a, b) => sign * (key(b)! - key(a)!) || b - a).slice(0, TOP);
      out.push(`${name} | ${[0, 1, 2].map((k) => (ranked[k] === undefined ? '–' : `${show(ranked[k]!)} on ${d(ranked[k]!)}`)).join(' | ')}`);
    }
  }

  // The latest row against the past: the highest or lowest since when. Higher or lower than the session before; a daily
  // move is a rise or a fall by its own sign.
  const since = (name: string, words: [string, string], v: (i: number) => number | null | undefined, show: (x: number) => string, bySign = false): string | null => {
    const x = v(L), p = bySign ? 0 : v(L - 1);
    if (cent(x) === null || cent(p) === null || cent(x) === cent(p)) return null;
    const high = x! > p!, j = Array.from({ length: L }, (_, k) => L - 1 - k).find((i) => cent(v(i)) !== null && (high ? v(i)! >= x! : v(i)! <= x!));
    const valued = Array.from({ length: n }, (_, i) => i).filter((i) => cent(v(i)) !== null).length, what = words[high ? 0 : 1];
    return j === undefined
      ? `- ${name} ${show(x!)} on ${d(L)}: the ${what} of all ${plural(valued, 'session')} on record${valued < n ? ' with a value' : ''}.`
      : `- ${name} ${show(x!)} on ${d(L)}: the ${what} since ${d(j)} (${show(v(j)!)}), ${plural(L - j, 'session')} before.`;
  };
  out.push('', '### The latest row against the past', '');
  out.push(...[
    since('Close', ['highest close', 'lowest close'], (i) => close[i], f2), since('Volume', ['heaviest volume', 'lightest volume'], volumeOf, vol),
    since('Daily move', ['biggest daily rise', 'biggest daily fall'], (i) => change[i], (x) => `${signed(x, 2)}%`, true),
    since('RSI', ['highest RSI', 'lowest RSI'], (i) => rsi14[i], f2), since('MACD', ['highest MACD', 'lowest MACD'], (i) => m.macd[i], f2),
    since('MACD histogram', ['highest MACD histogram', 'lowest MACD histogram'], (i) => m.hist[i], f2),
  ].filter((x): x is string => x !== null));
  for (const w of windows.filter((w) => w.full === 63 || w.full === 252)) {
    const idx = Array.from({ length: w.size }, (_, k) => from(w) + k);
    const hi = idx.reduce((a, i) => (close[i]! >= close[a]! ? i : a)), lo = idx.reduce((a, i) => (close[i]! <= close[a]! ? i : a));
    out.push(`- The close ${f2(close[L]!)} is ${f2(Math.abs((close[L]! / close[hi]! - 1) * 100))}% ${close[L]! < close[hi]! ? 'below' : 'at'} the highest close of the last ${w.size} sessions (${f2(close[hi]!)} on ${d(hi)}) and ${f2(Math.abs((close[L]! / close[lo]! - 1) * 100))}% ${close[L]! > close[lo]! ? 'above' : 'at'} the lowest (${f2(close[lo]!)} on ${d(lo)}).`);
  }

  // Changes of the close over whole windows, and the calendar year so far.
  const moves = [1, 5, 20, 63, 126, 252].filter((k) => k <= L).map((k) => `${plural(k, 'session')} ${signed((close[L]! / close[L - k]! - 1) * 100, 2)}% (from ${f2(close[L - k]!)} on ${d(L - k)})`);
  const lastOfYear = Array.from({ length: L }, (_, k) => L - 1 - k).find((i) => bars[i]!.date.slice(0, 4) < bars[L]!.date.slice(0, 4));
  if (lastOfYear !== undefined) moves.push(`this calendar year ${signed((close[L]! / close[lastOfYear]! - 1) * 100, 2)}% (from the last close of ${bars[lastOfYear]!.date.slice(0, 4)}, ${f2(close[lastOfYear]!)} on ${d(lastOfYear)})`);
  out.push('', '### Change of the close to the latest row', '', `- ${moves.join('; ')}.`);
  return out.join('\n');
}
