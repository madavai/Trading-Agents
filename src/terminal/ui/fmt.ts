// How numbers and words are written on the page. A number that is missing is a dash, never a zero.
const MINUS = '−';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const num = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const money = (n: number | null | undefined, currency = 'USD'): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? MINUS : '', abs = Math.abs(n);
  const sym = currency === 'USD' ? '$' : '';
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${sym}${body}${sym ? '' : ` ${currency}`}`;
};

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : MINUS}${Math.abs(n).toFixed(2)}%`;

export const tone = (n: number | null | undefined): '' | 'ok' | 'danger' => (n === null || n === undefined || !Number.isFinite(n) ? '' : n >= 0 ? 'ok' : 'danger');

export const ratingTone = (r: string): '' | 'ok' | 'danger' | 'warn' =>
  r === 'Buy' || r === 'Overweight' ? 'ok' : r === 'Underweight' || r === 'Sell' ? 'danger' : r === 'Hold' ? '' : 'warn';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-09 as "9 Oct 2026". */
export const dayText = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : iso;
};
/** 2026-10-09 as "9 Oct". */
export const shortDay = (iso: string): string => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso); return m ? `${Number(m[2])} ${MON[Number(m[1]) - 1]}` : iso; };
export const clock = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

export const SECTION_NAMES: Record<string, string> = {
  market: 'Market report', sentiment: 'Sentiment report', news: 'News report', fundamentals: 'Fundamentals report',
  bull: 'Bull case', bear: 'Bear case', research_plan: 'Research plan', trader: "Trader's proposal",
  aggressive: 'Aggressive risk voice', conservative: 'Conservative risk voice', neutral: 'Neutral risk voice', decision: "Portfolio manager's decision",
};
