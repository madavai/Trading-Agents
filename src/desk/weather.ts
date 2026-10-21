// "Market weather": what ground the market is on, in three plain lines, each from figures the desk already reads and never
// a forecast. The trend is the S&P 500 against its 50- and 200-day averages (above both rising, between them mixed, below
// both falling); the mood is the VIX (under 15 calm, 15 to 25 normal, over 25 wild); the rates line is what Polymarket's
// crowd prices for the Federal Reserve's next decision. A line whose figures cannot be had says so, and has no colour.
import { addDays, marketDay } from '../data/dates.js';
import { getJson } from '../data/http.js';
import { sma } from '../data/indicators.js';
import { daily, type Bar } from '../data/yahoo.js';

export type Tone = 'ok' | 'warn' | 'bad' | '';
export interface WeatherLine {
  key: 'trend' | 'mood' | 'rates'; name: string;
  /** The line in a word or two ("Rising", "Calm", "No change"), or null when its figures could not be had. */
  state: string | null; tone: Tone;
  /** The figures behind it, in one sentence. */
  words: string;
  /** What the line means, in one sentence. */
  meaning: string;
}
export interface Weather { at: string; lines: WeatherLine[] }

const MEANING = {
  trend: 'The S&P 500 against its 50- and 200-day averages: above both is rising, between them mixed, below both falling. It tells where the market has been, not where it goes next.',
  mood: 'The VIX is how much the market expects prices to swing over the next month: under 15 calm, 15 to 25 normal, over 25 wild.',
  rates: "What prediction markets price for the Federal Reserve's next interest-rate decision, not a forecast of ours. Lower rates tend to help share prices; higher rates tend to weigh on them.",
} as const;

const whole = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
/** 2026-10-20 as "20 Oct 2026". */
const dayWords = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`; };
const unavailable = (key: WeatherLine['key'], name: string, why: string): WeatherLine => ({ key, name, state: null, tone: '', words: `Unavailable: ${why}.`, meaning: MEANING[key] });

/** The trend, from the S&P 500's daily rows (oldest first): its latest close against its 50- and 200-day averages. */
export function trendOf(bars: readonly Bar[]): WeatherLine {
  const closes = bars.map((b) => b.close), n = closes.length;
  const ma50 = sma(closes, 50)[n - 1], ma200 = sma(closes, 200)[n - 1], last = closes[n - 1];
  if (last === undefined || ma50 == null || ma200 == null) return unavailable('trend', 'Trend', 'too few days of S&P 500 prices for its 200-day average');
  const above = (ma: number) => (last > ma ? 'above' : 'below');
  const [state, tone]: [string, Tone] = last > ma50 && last > ma200 ? ['Rising', 'ok'] : last < ma50 && last < ma200 ? ['Falling', 'bad'] : ['Mixed', 'warn'];
  return { key: 'trend', name: 'Trend', state, tone, words: `The S&P 500 closed at ${whole(last)} on ${dayWords(bars[n - 1]!.date)}, ${above(ma50)} its 50-day average (${whole(ma50)}) and ${above(ma200)} its 200-day average (${whole(ma200)}).`, meaning: MEANING.trend };
}

/** The mood, from the VIX's latest close. */
export function moodOf(bars: readonly Bar[]): WeatherLine {
  const last = bars[bars.length - 1];
  if (!last) return unavailable('mood', 'Mood', 'no VIX figure came from Yahoo Finance');
  const v = last.close, [state, tone]: [string, Tone] = v < 15 ? ['Calm', 'ok'] : v <= 25 ? ['Normal', ''] : ['Wild', 'bad'];
  return { key: 'mood', name: 'Mood', state, tone, words: `The VIX closed at ${v.toFixed(1)} on ${dayWords(last.date)}.`, meaning: MEANING.mood };
}

interface PolyMarket { groupItemTitle?: string; outcomePrices?: string; closed?: boolean; active?: boolean }
export interface PolyEvent { title?: string; endDate?: string; closed?: boolean; markets?: PolyMarket[] }

/** "25 bps increase" as "a rise of 0.25%"; "No change" as "no change". */
export function outcomeWords(title: string): { words: string; way: 'none' | 'cut' | 'rise' } {
  if (/no change/i.test(title)) return { words: 'no change', way: 'none' };
  const m = /(\d+)\s*(\+?)\s*bps?\s*(decrease|cut|increase|hike|rise)/i.exec(title);
  if (!m) return { words: title.toLowerCase(), way: 'none' };
  const cut = /decrease|cut/i.test(m[3]!), size = `${Number((Number(m[1]) / 100).toFixed(2))}%`;   // 25 bps is 0.25%
  return { words: `${cut ? 'a cut' : 'a rise'} of ${size}${m[2] ? ' or more' : ''}`, way: cut ? 'cut' : 'rise' };
}

/** The rates line, from Polymarket's events: the open "Fed decision" event that resolves first, and its likeliest outcomes. */
export function ratesOf(events: readonly PolyEvent[], now: Date = new Date()): WeatherLine {
  const next = events.filter((e) => /^fed decision in /i.test(e.title ?? '') && !e.closed && e.endDate && Date.parse(e.endDate) > now.getTime())
    .sort((a, b) => Date.parse(a.endDate!) - Date.parse(b.endDate!))[0];
  const list = (s?: string): string[] => { try { const v = JSON.parse(s ?? '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  const odds = (next?.markets ?? []).filter((m) => m.groupItemTitle && !m.closed && m.active !== false)
    .map((m) => ({ ...outcomeWords(m.groupItemTitle!), p: Number(list(m.outcomePrices)[0]) }))
    .filter((o) => Number.isFinite(o.p)).sort((a, b) => b.p - a.p);
  const top = odds[0];
  if (!next || !top) return unavailable('rates', 'Rates', "Polymarket has no open market on the Federal Reserve's next decision");
  const [state, tone]: [string, Tone] = top.way === 'cut' ? ['A cut', 'ok'] : top.way === 'rise' ? ['A rise', 'warn'] : ['No change', ''];
  const pct = (p: number) => `${Math.round(p * 100)}%`, second = odds[1] && odds[1].p >= 0.1 ? ` and ${odds[1].words} at ${pct(odds[1].p)}` : '';
  return { key: 'rates', name: 'Rates', state, tone, words: `For the Federal Reserve's next decision, by ${dayWords(marketDay(new Date(next.endDate!)))}, Polymarket's crowd puts ${top.words} at ${pct(top.p)}${second}.`, meaning: MEANING.rates };
}

/** The weather now, each line on its own: a source that fails leaves its line unavailable and the others standing. */
export async function weatherNow(day: string, now: Date = new Date()): Promise<Weather> {
  const [trend, mood, rates] = await Promise.all([
    daily('^GSPC', addDays(day, -400), day).then((s) => trendOf(s.bars), () => unavailable('trend', 'Trend', 'Yahoo Finance did not answer for the S&P 500')),
    daily('^VIX', addDays(day, -14), day).then((s) => moodOf(s.bars), () => unavailable('mood', 'Mood', 'Yahoo Finance did not answer for the VIX')),
    getJson<{ events?: PolyEvent[] }>('https://gamma-api.polymarket.com/public-search?q=fed%20decision&limit_per_type=20')
      .then((j) => ratesOf(j.events ?? [], now), () => unavailable('rates', 'Rates', 'Polymarket did not answer')),
  ]);
  return { at: now.toISOString(), lines: [trend, mood, rates] };
}
