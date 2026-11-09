// The main chart's bars, and what its hover box says of one. Kept apart from the drawing (chart.ts), with nothing of the
// browser in it, so the tests read the box's words as the person does.
import type { History } from '../quotes.js';
import { dayText, esc, num, pct, points, shortDay, tone } from './fmt.js';

/** One bar of the chart: a day, or over five years a group of five trading days, from `from` to `date`. */
export interface Bar { date: string; from?: string; label: string; o: number; h: number; l: number; c: number; v: number | null }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Five years of days is too many to read: they are drawn five trading days at a time, each group's averages at its last
 *  day. A group's open is its first day's, its close its last day's, its volume theirs together. */
export function barsOf(h: History): { bars: Bar[]; ma50: Array<number | null>; ma200: Array<number | null> } {
  const day = (b: History['bars'][number]): Bar => ({ date: b.date, label: shortDay(b.date), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
  if (h.range !== '5Y') return { bars: h.bars.map(day), ma50: h.ma50, ma200: h.ma200 };
  const bars: Bar[] = [], ma50: Array<number | null> = [], ma200: Array<number | null> = [];
  for (let i = 0; i < h.bars.length; i += 5) {
    const g = h.bars.slice(i, i + 5), end = g[g.length - 1]!;
    bars.push({ date: end.date, from: g[0]!.date, label: monthYear(end.date), o: g[0]!.open, h: Math.max(...g.map((b) => b.high)), l: Math.min(...g.map((b) => b.low)), c: end.close, v: g.some((b) => b.volume === null) ? null : g.reduce((a, b) => a + b.volume!, 0) });
    ma50.push(h.ma50[i + g.length - 1] ?? null); ma200.push(h.ma200[i + g.length - 1] ?? null);
  }
  return { bars, ma50, ma200 };
}

/** The days a five-day bar spans: "26 Oct to 30 Oct 2026", or "29 Dec 2025 to 2 Jan 2026" across a year. */
export const spanText = (from: string, to: string): string => (from.slice(0, 4) === to.slice(0, 4) ? `${shortDay(from)} to ${dayText(to)}` : `${dayText(from)} to ${dayText(to)}`);

/** A volume in a few figures: "950", "46K", "43M", "1.2B". Yahoo gives none for an index or a yield (or a zero): not given. */
export const volumeWords = (v: number | null): string =>
  v === null || !Number.isFinite(v) || v <= 0 ? 'not given' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

/** The hover box of bar i: its day, or the days its group spans; its open, high, low and close; the move to its close from
 *  the close before it (the day's move, as the glossary has it; in points for a yield, which is itself a percent); and its
 *  volume. The first bar drawn has no close before it here, so it shows no move, rather than one from its own open. */
export function tipOf(bars: readonly Bar[], i: number, unit?: '%'): string {
  const b = bars[i]!, before = i > 0 ? bars[i - 1]! : null;
  const change = before === null ? null : unit === '%' ? b.c - before.c : (b.c / before.c - 1) * 100;
  const move = change === null ? '' : ` <span class="at-chip ${tone(change)}" title="From the close of ${esc(dayText(before!.date))}">${unit === '%' ? points(change) : pct(change)}</span>`;
  const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  return `<div class="at-tile-name">${esc(b.from && b.from !== b.date ? spanText(b.from, b.date) : dayText(b.date))}</div><dl class="at-facts">${fact('Open', num(b.o))}${fact('High', num(b.h))}${fact('Low', num(b.l))}${fact('Close', `${num(b.c)}${move}`)}${fact('Volume', volumeWords(b.v))}</dl>`;
}
