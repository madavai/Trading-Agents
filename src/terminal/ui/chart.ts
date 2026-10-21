// The page's charts, drawn as SVG from the desk's own numbers. Colours and type come from classes in dashboard.css (the page's
// security policy allows no inline styles), and the gradients are the three fixed ones in index.html.
import { dayText, esc, num, pct, shortDay, tone } from './fmt.js';
import type { History } from './api.js';

export type Tone = 'accent' | 'ok' | 'bad';
type Pt = [number, number];

/** A smooth line through points that never overshoots between them (monotone cubic). */
export function smooth(pts: Pt[]): string {
  const n = pts.length;
  if (n < 2) return '';
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1]![0] - pts[i]![0]; m[i] = (pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1); }
  t[0] = m[0]!; t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]!; t[i + 1] = k * b * m[i]!; }
  }
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${f(pts[i]![0] + h)},${f(pts[i]![1] + t[i]! * h)} ${f(pts[i + 1]![0] - h)},${f(pts[i + 1]![1] - t[i + 1]! * h)} ${f(pts[i + 1]![0])},${f(pts[i + 1]![1])}`;
  }
  return d;
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** A small area chart with no axes, for a row or a tile. Fewer than two points draws nothing rather than a made-up line. */
export function sparkline(el: HTMLElement, values: number[], t: Tone, opts: { dot?: boolean; width?: number } = {}): void {
  if (values.length < 2) { el.replaceChildren(); return; }
  const W = el.clientWidth || 200, H = el.clientHeight || 40, pad = 3;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts: Pt[] = values.map((v, i) => [pad + (i / (values.length - 1)) * (W - pad * 2), pad + (1 - (v - lo) / span) * (H - pad * 2)]);
  const line = smooth(pts), last = pts[pts.length - 1]!;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path d="${line} L${last[0]},${H} L${pts[0]![0]},${H} Z" fill="url(#g-${t})"/>`
    + `<path d="${line}" class="ln s-${t}" stroke-width="${opts.width ?? 2}"/>`
    + (opts.dot ? `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" class="dot f-${t}"/>` : '') + `</svg>`;
}

/** The paper book against the S&P 500: two lines on one scale, the paper one in the accent, the index dashed, the value
 *  labels on the right and the first and last days underneath. Fewer than two days draws nothing. */
export function paperChart(el: HTMLElement, series: ReadonlyArray<{ date: string; value: number; benchmark: number | null }>): void {
  if (series.length < 2) { el.replaceChildren(); return; }
  const W = el.clientWidth || 640, H = el.clientHeight || 180, R = 64, T = 10, B = 24, pw = W - R, ph = H - T - B;
  const vals = series.flatMap((p) => (p.benchmark === null ? [p.value] : [p.value, p.benchmark]));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || hi * 0.01 || 1, a = lo - pad, b = hi + pad;
  const x = (i: number) => (i / (series.length - 1)) * pw, y = (v: number) => T + (1 - (v - a) / (b - a)) * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Paper value against the S&amp;P 500">`;
  for (const v of niceTicks(a, b, 3)) s += `<line x1="0" x2="${pw}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/><text x="${pw + 8}" y="${y(v) + 4}" class="ch-axis">$${Math.round(v).toLocaleString('en-US')}</text>`;
  const bench = series.map((p, i) => (p.benchmark === null ? null : [x(i), y(p.benchmark)] as Pt)).filter((p): p is Pt => p !== null);
  if (bench.length > 1) s += `<path d="${smooth(bench)}" class="ma ma200"/>`;
  s += `<path d="${smooth(series.map((p, i) => [x(i), y(p.value)] as Pt))}" class="ln s-accent" stroke-width="2"/>`;
  s += `<text x="0" y="${H - 6}" class="ch-axis">${esc(shortDay(series[0]!.date))}</text><text x="${pw}" y="${H - 6}" text-anchor="end" class="ch-axis">${esc(shortDay(series.at(-1)!.date))}</text></svg>`;
  el.innerHTML = s;
}

interface Bar { date: string; label: string; o: number; h: number; l: number; c: number; v: number }
export interface HeroOptions { kind: 'area' | 'candles'; layers: { ma50: boolean; ma200: boolean; vol: boolean } }
export interface HeroInfo { first: number; last: number; hasAverages: boolean }

const monthYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Five years of days is too many to read: they are drawn a week at a time, each week's average at its last day. */
function barsOf(h: History): { bars: Bar[]; ma50: Array<number | null>; ma200: Array<number | null> } {
  const day = (b: History['bars'][number]): Bar => ({ date: b.date, label: shortDay(b.date), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
  if (h.range !== '5Y') return { bars: h.bars.map(day), ma50: h.ma50, ma200: h.ma200 };
  const bars: Bar[] = [], ma50: Array<number | null> = [], ma200: Array<number | null> = [];
  for (let i = 0; i < h.bars.length; i += 5) {
    const g = h.bars.slice(i, i + 5), end = g[g.length - 1]!;
    bars.push({ date: end.date, label: monthYear(end.date), o: g[0]!.open, h: Math.max(...g.map((b) => b.high)), l: Math.min(...g.map((b) => b.low)), c: end.close, v: g.reduce((a, b) => a + b.volume, 0) });
    ma50.push(h.ma50[i + g.length - 1] ?? null); ma200.push(h.ma200[i + g.length - 1] ?? null);
  }
  return { bars, ma50, ma200 };
}

/** The main chart: area or candles, the 50- and 200-day averages, volume, a price tag and a crosshair with a tooltip. */
export function heroChart(el: HTMLElement, tip: HTMLElement, h: History, o: HeroOptions): HeroInfo | null {
  const { bars, ma50, ma200 } = barsOf(h), n = bars.length;
  if (n < 2) { el.replaceChildren(); return null; }
  const W = el.clientWidth || 600, H = el.clientHeight || 300, R = 64, T = 10, VOL = o.layers.vol ? 52 : 0, X = 26;
  const PB = H - VOL - X - (VOL ? 10 : 0), pw = W - R, step = pw / n;
  const x = (i: number) => step * (i + 0.5);
  let lo = Math.min(...bars.map((b) => (o.kind === 'candles' ? b.l : b.c))), hi = Math.max(...bars.map((b) => (o.kind === 'candles' ? b.h : b.c)));
  const lines: Array<['ma50' | 'ma200', Array<number | null>]> = [['ma50', ma50], ['ma200', ma200]];
  for (const [k, arr] of lines) if (o.layers[k]) for (const v of arr) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const padv = (hi - lo) * 0.08 || hi * 0.01; lo -= padv; hi += padv;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (PB - T);
  const first = bars[0]!.c, last = bars[n - 1]!.c, t: Tone = o.kind === 'area' ? 'accent' : last >= first ? 'ok' : 'bad';

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(h.symbol)} price over ${esc(h.range)}">`;
  const ly = y(last);
  for (const v of niceTicks(lo, hi, 4)) s += `<line x1="0" x2="${pw}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/>${Math.abs(y(v) - ly) < 14 ? '' : `<text x="${pw + 10}" y="${y(v) + 4}" class="ch-axis">${num(v, v >= 1000 ? 0 : 2)}</text>`}`;
  const every = Math.ceil(n / 6);
  for (let i = Math.floor(every / 2); i < n; i += every) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="ch-axis">${bars[i]!.label}</text>`;
  if (VOL) {
    const vmax = Math.max(...bars.map((b) => b.v)) || 1, vb = PB + 10 + VOL;
    bars.forEach((b, i) => { const bh = Math.max(1.5, (b.v / vmax) * VOL), w = Math.max(1, step * 0.6); s += `<rect x="${x(i) - w / 2}" y="${vb - bh}" width="${w}" height="${bh}" rx="${Math.min(2, w / 2)}" class="vol-${b.c >= b.o ? 'ok' : 'bad'}"/>`; });
  }
  const path = (arr: Array<number | null>) => smooth(arr.map((v, i): Pt | null => (v === null ? null : [x(i), y(v)])).filter((p): p is Pt => p !== null));
  const has50 = ma50.some((v) => v !== null), has200 = ma200.some((v) => v !== null);
  if (o.layers.ma200 && has200) s += `<path d="${path(ma200)}" class="ma ma200"/>`;
  if (o.layers.ma50 && has50) s += `<path d="${path(ma50)}" class="ma ma50"/>`;
  if (o.kind === 'area') {
    const pts: Pt[] = bars.map((b, i) => [x(i), y(b.c)]), line = smooth(pts);
    s += `<path d="${line} L${pts[n - 1]![0]},${PB} L${pts[0]![0]},${PB} Z" fill="url(#g-accent)"/><path d="${line}" class="ln s-accent" stroke-width="2.25"/>`;
  } else {
    bars.forEach((b, i) => {
      const c = b.c >= b.o ? 'ok' : 'bad', w = Math.max(1.5, step * 0.62), top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      s += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.h)}" y2="${y(b.l)}" class="s-${c}" stroke-width="1.25"/><rect x="${x(i) - w / 2}" y="${top}" width="${w}" height="${bh}" rx="${Math.min(1.5, w / 3)}" class="f-${c}"/>`;
    });
  }
  s += `<line x1="0" x2="${pw}" y1="${ly}" y2="${ly}" class="ch-last s-${t}"/>`;
  s += `<rect x="${pw + 4}" y="${ly - 11}" width="${R - 6}" height="22" rx="5" class="f-${t}"/><text x="${pw + 4 + (R - 6) / 2}" y="${ly + 4.5}" text-anchor="middle" class="ch-tag">${num(last)}</text>`;
  if (o.kind === 'area') s += `<circle cx="${x(n - 1)}" cy="${ly}" r="4" class="dot f-accent"/>`;
  s += `<g id="xh" class="hide"><line id="xhl" y1="${T}" y2="${PB}" class="ch-cross"/><circle id="xhd" r="4.5" class="dot f-accent"/></g>`;
  s += `<rect x="0" y="0" width="${pw}" height="${H}" class="ch-hit" id="hit"/></svg>`;
  el.innerHTML = s;

  const hit = el.querySelector<SVGRectElement>('#hit')!, xh = el.querySelector<SVGGElement>('#xh')!, xhl = el.querySelector<SVGLineElement>('#xhl')!, xhd = el.querySelector<SVGCircleElement>('#xhd')!;
  hit.addEventListener('mousemove', (e) => {
    const r = el.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / step))), b = bars[i]!;
    xh.classList.remove('hide');
    xhl.setAttribute('x1', String(x(i))); xhl.setAttribute('x2', String(x(i))); xhd.setAttribute('cx', String(x(i))); xhd.setAttribute('cy', String(y(b.c)));
    const move = (b.c / b.o - 1) * 100;
    tip.innerHTML = `<div class="at-tile-name">${dayText(b.date)}</div><dl class="at-facts"><div><dt>Open</dt><dd>${num(b.o)}</dd></div><div><dt>High</dt><dd>${num(b.h)}</dd></div><div><dt>Low</dt><dd>${num(b.l)}</dd></div><div><dt>Close</dt><dd>${num(b.c)} <span class="at-chip ${tone(move)}">${pct(move)}</span></dd></div><div><dt>Volume</dt><dd>${(b.v / 1e6).toFixed(1)}M</dd></div></dl>`;
    tip.classList.add('on');
    const tw = tip.offsetWidth; let left = x(i) + 16; if (left + tw > pw) left = x(i) - tw - 16;
    tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${T}px`;
  });
  hit.addEventListener('mouseleave', () => { xh.classList.add('hide'); tip.classList.remove('on'); });
  return { first, last, hasAverages: has50 || has200 };
}
