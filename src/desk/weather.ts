// "Market weather": what ground the market is on, in three plain lines, each from figures the desk already reads and never
// a forecast. The trend is the S&P 500 against its 50- and 200-day averages (above both rising, between them mixed, below
// both falling); the mood is the VIX (under 15 calm, 15 to 25 normal, over 25 wild); the rates line is what Polymarket's
// crowd prices for the Federal Reserve's next decision. A line whose figures cannot be had says so, and has no colour.
// During New York's session the latest row is today's, still trading: its figure is the price so far, said as such and
// never "closed at". Rows read before the close was final (market.ts latestState) are said as read, not as a close.
import { addDays, marketDay } from '../data/dates.js';
import { getJson } from '../data/http.js';
import { sma } from '../data/indicators.js';
import { latestState } from '../data/market.js';
import { eventsOf, firstPrice, type SearchJson } from '../data/odds.js';
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

/** When the latest row is not a final close: the moment it was read (`at`); `ended` when its session has ended since,
 *  but the row was read before its close was final; `unsure` when the source gave no session to tell by and the row is
 *  today's. Null when it is a finished session's final close. */
export type Live = { at: Date; unsure?: true; ended?: true } | null;
/** 14:05 as New York's clock reads it. */
const newYorkTime = (at: Date): string => at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
/** "closed at X on DAY"; during the session, "is at X at TIME New York time on DAY, still trading"; after it, for a row
 *  read before its close was final, "was at X when read at TIME …". */
const figureWords = (name: string, figure: string, day: string, live: Live): string => (!live ? `${name} closed at ${figure} on ${dayWords(day)}`
  : live.unsure ? `${name}'s latest figure on ${dayWords(day)}, read at ${newYorkTime(live.at)} New York time, is ${figure} (Yahoo Finance did not say whether that session had ended)`
  : live.ended ? `${name} was at ${figure} when read at ${newYorkTime(live.at)} New York time on ${dayWords(day)}, before that session's close was final (not a close)`
  : `${name} is at ${figure} at ${newYorkTime(live.at)} New York time on ${dayWords(day)}, still trading (not a close)`);

/** Whether a series' latest row is a final close at `now` (market.ts latestState): if not, its figure is the price as read
 *  (`fetchedAt`), still trading or read before its close was final. */
export function liveOf(s: Series, day: string, now: Date): Live {
  const last = s.bars.at(-1), session = s.meta.session;
  if (!last) return null;
  const at = new Date(s.fetchedAt ?? now.getTime());
  if (!session) return last.date === day ? { at, unsure: true } : null;
  if (!latestState(s, day, now.getTime()).open) return null;
  return session.date === last.date && now.getTime() < session.end ? { at } : { at, ended: true };
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

/** "25 bps increase" as "a rise of 0.25 percentage points"; "No change" as "no change". A move in a rate is said in
 *  percentage points: "0.25%" would read as a quarter of a percent of the rate itself (audit 1 W2). */
export function outcomeWords(title: string): { words: string; way: 'none' | 'cut' | 'rise' } {
  if (/no change/i.test(title)) return { words: 'no change', way: 'none' };
  const m = /(\d+)\s*(\+?)\s*bps?\s*(decrease|cut|increase|hike|rise)/i.exec(title);
  if (!m) return { words: title.toLowerCase(), way: 'none' };
  const points = Number((Number(m[1]) / 100).toFixed(2));   // 25 basis points are 0.25 percentage points
  const cut = /decrease|cut/i.test(m[3]!), size = `${points} percentage point${points === 1 ? '' : 's'}`;
  return { words: `${cut ? 'a cut' : 'a rise'} of ${size}${m[2] ? ' or more' : ''}`, way: cut ? 'cut' : 'rise' };
}

/** The rates line, from Polymarket's events: the open "Fed decision" event that resolves first, and its likeliest outcomes. */
export function ratesOf(events: readonly PolyEvent[], now: Date = new Date()): WeatherLine {
  const next = events.filter((e) => /^fed decision in /i.test(e.title ?? '') && !e.closed && e.endDate && Date.parse(e.endDate) > now.getTime())
    .sort((a, b) => Date.parse(a.endDate!) - Date.parse(b.endDate!))[0];
  // A blank price is no price: never read as 0%.
  const odds = (next?.markets ?? []).filter((m) => m.groupItemTitle && !m.closed && m.active !== false)
    .map((m) => ({ ...outcomeWords(m.groupItemTitle!), p: firstPrice(m.outcomePrices) }))
    .filter((o): o is typeof o & { p: number } => o.p !== null).sort((a, b) => b.p - a.p);
  const top = odds[0];
  if (!next || !top) return unavailable('rates', 'Rates', "Polymarket has no open market on the Federal Reserve's next decision");
  const [state, tone]: [string, Tone] = top.way === 'cut' ? ['A cut', 'ok'] : top.way === 'rise' ? ['A rise', 'warn'] : ['No change', ''];
  const pct = (p: number) => `${Math.round(p * 100)}%`, second = odds[1] && odds[1].p >= 0.1 ? ` and ${odds[1].words} at ${pct(odds[1].p)}` : '';
  return { key: 'rates', name: 'Rates', state, tone, words: `For the Federal Reserve's next decision, by ${dayWords(marketDay(new Date(next.endDate!)))}, Polymarket's crowd puts ${top.words} at ${pct(top.p)}${second}.`, meaning: MEANING.rates };
}

/** The weather now, each line on its own: a source that fails leaves its line unavailable and the others standing. A
 *  Polymarket answer without its search results is a broken answer, not "no open market". */
export async function weatherNow(day: string, now: Date = new Date()): Promise<Weather> {
  const [trend, mood, rates] = await Promise.all([
    daily('^GSPC', addDays(day, -400), day).then((s) => trendOf(s.bars, liveOf(s, day, now)), () => unavailable('trend', 'Trend', 'Yahoo Finance did not answer for the S&P 500')),
    daily('^VIX', addDays(day, -14), day).then((s) => moodOf(s.bars, liveOf(s, day, now)), () => unavailable('mood', 'Mood', 'Yahoo Finance did not answer for the VIX')),
    getJson<SearchJson<PolyEvent>>('https://gamma-api.polymarket.com/public-search?q=fed%20decision&limit_per_type=20').then(
      (j) => { try { return ratesOf(eventsOf(j), now); } catch { return unavailable('rates', 'Rates', 'Polymarket answered without its search results'); } },
      () => unavailable('rates', 'Rates', 'Polymarket did not answer')),
  ]);
  return { at: now.toISOString(), lines: [trend, mood, rates] };
}
