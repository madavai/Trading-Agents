// "Market weather": what ground the market is on, in three plain lines, each from figures the desk already reads and never
// a forecast. The trend is the S&P 500 against its 50- and 200-day averages (above both rising, between them mixed, below
// both falling); the mood is the VIX (under 15 calm, 15 to 25 normal, over 25 wild); the rates line is what Polymarket's
// crowd prices for the Federal Reserve's next decision. A line whose figures cannot be had says so, and has no colour.
// During New York's session the latest row is today's, still trading: its figure is the price so far, said as such and
// never "closed at".
import { addDays, marketDay } from '../data/dates.js';
import { getJson } from '../data/http.js';
import { sma } from '../data/indicators.js';
import { latestState } from '../data/market.js';
import { daily, type Bar, type Series } from '../data/yahoo.js';

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

/** When the latest row is a session still trading, the moment it was read (`at`), `unsure` when the source gave no session
 *  to tell by and the row is today's; null when it is a finished session. */
export type Live = { at: Date; unsure?: true } | null;
/** 14:05 as New York's clock reads it. */
const newYorkTime = (at: Date): string => at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
/** "closed at X on DAY", or, during the session, "is at X at TIME New York time on DAY, still trading". */
const figureWords = (name: string, figure: string, day: string, live: Live): string => (!live ? `${name} closed at ${figure} on ${dayWords(day)}`
  : live.unsure ? `${name}'s latest figure on ${dayWords(day)}, read at ${newYorkTime(live.at)} New York time, is ${figure} (Yahoo Finance did not say whether that session had ended)`
  : `${name} is at ${figure} at ${newYorkTime(live.at)} New York time on ${dayWords(day)}, still trading (not a close)`);

/** Whether a series' latest row is New York's session still trading at `now`: then its figure is the price so far. */
export function liveOf(s: Series, day: string, now: Date): Live {
  const last = s.bars.at(-1);
  if (!last) return null;
  if (!s.meta.session) return last.date === day ? { at: now, unsure: true } : null;
  return latestState(s, day, now.getTime()).open ? { at: now } : null;
}

/** The trend, from the S&P 500's daily rows (oldest first): its latest figure against its 50- and 200-day averages. */
export function trendOf(bars: readonly Bar[], live: Live = null): WeatherLine {
  const closes = bars.map((b) => b.close), n = closes.length;
  const ma50 = sma(closes, 50)[n - 1], ma200 = sma(closes, 200)[n - 1], last = closes[n - 1];
  if (last === undefined || ma50 == null || ma200 == null) return unavailable('trend', 'Trend', 'too few days of S&P 500 prices for its 200-day average');
  const above = (ma: number) => (last > ma ? 'above' : 'below');
  const [state, tone]: [string, Tone] = last > ma50 && last > ma200 ? ['Rising', 'ok'] : last < ma50 && last < ma200 ? ['Falling', 'bad'] : ['Mixed', 'warn'];
  return { key: 'trend', name: 'Trend', state, tone, words: `${figureWords('The S&P 500', whole(last), bars[n - 1]!.date, live)}, ${above(ma50)} its 50-day average (${whole(ma50)}) and ${above(ma200)} its 200-day average (${whole(ma200)}).`, meaning: MEANING.trend };
}

/** The mood, from the VIX's latest figure. */
export function moodOf(bars: readonly Bar[], live: Live = null): WeatherLine {
  const last = bars[bars.length - 1];
  if (!last) return unavailable('mood', 'Mood', 'no VIX figure came from Yahoo Finance');
  const v = last.close, [state, tone]: [string, Tone] = v < 15 ? ['Calm', 'ok'] : v <= 25 ? ['Normal', ''] : ['Wild', 'bad'];
  return { key: 'mood', name: 'Mood', state, tone, words: `${figureWords('The VIX', v.toFixed(1), last.date, live)}.`, meaning: MEANING.mood };
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
    daily('^GSPC', addDays(day, -400), day).then((s) => trendOf(s.bars, liveOf(s, day, now)), () => unavailable('trend', 'Trend', 'Yahoo Finance did not answer for the S&P 500')),
    daily('^VIX', addDays(day, -14), day).then((s) => moodOf(s.bars, liveOf(s, day, now)), () => unavailable('mood', 'Mood', 'Yahoo Finance did not answer for the VIX')),
    getJson<{ events?: PolyEvent[] }>('https://gamma-api.polymarket.com/public-search?q=fed%20decision&limit_per_type=20')
      .then((j) => ratesOf(j.events ?? [], now), () => unavailable('rates', 'Rates', 'Polymarket did not answer')),
  ]);
  return { at: now.toISOString(), lines: [trend, mood, rates] };
}
