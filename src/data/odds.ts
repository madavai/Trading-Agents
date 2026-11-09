// Prediction-market odds from Polymarket's public search (no key): the crowd's priced chance of forward-looking events -
// rate decisions, recession, elections, geopolitics, crypto. Polymarket serves only live odds, so a past analysis date
// gets none: today's odds would put later knowledge into an earlier day.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/polymarket.py), Apache License 2.0.
import { analysisDate, isHistorical } from './dates.js';
import { getJson, Unavailable } from './http.js';
import { signed } from '../numbers.js';

interface Market { question?: string; outcomes?: string; outcomePrices?: string; volumeNum?: number; volume?: string; endDate?: string; closed?: boolean; active?: boolean; oneWeekPriceChange?: number }
export interface SearchJson<E = { markets?: Market[] }> { events?: E[]; pagination?: unknown; error?: unknown }

const list = (s: string | undefined): string[] => { try { const v = JSON.parse(s ?? '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

/** The events of a Polymarket search. When nothing matches it leaves the list out and sends its page count alone; an
 *  answer with neither (an error, a notice) is broken: unavailable, never "no markets". */
export function eventsOf<E>(j: SearchJson<E>): E[] {
  if (Array.isArray(j.events)) return j.events;
  if (j.error === undefined && typeof j.pagination === 'object' && j.pagination !== null) return [];
  throw new Unavailable(`gamma-api.polymarket.com answered without its search results${typeof j.error === 'string' && j.error ? `, saying "${j.error.slice(0, 140)}"` : ''}`);
}

/** The first outcome's price, a chance from 0 to 1, or null when it is blank or not a price (never read as 0%). */
export function firstPrice(outcomePrices: string | undefined): number | null {
  const s = list(outcomePrices)[0]?.trim();
  const p = s ? Number(s) : NaN;
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

/** The volume traded, in dollars, or null when Polymarket gives none. */
const volumeOf = (m: Market): number | null => {
  const v = typeof m.volumeNum === 'number' ? m.volumeNum : m.volume?.trim() ? Number(m.volume) : NaN;
  return Number.isFinite(v) ? v : null;
};

export async function predictionMarkets(topic: string, analysis: string, limit = 6, now = new Date()): Promise<string> {
  const day = analysisDate(analysis);
  if (isHistorical(day)) return `Prediction-market odds are withheld for ${day}: Polymarket serves only today's odds on open markets, and those would put later knowledge into an analysis of ${day}.`;
  const j = await getJson<SearchJson>(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(topic)}&limit_per_type=20`);
  const open = eventsOf(j).flatMap((e) => e.markets ?? []).filter((m) => m.question && !m.closed && m.active !== false && list(m.outcomePrices).length && list(m.outcomes).length && (!m.endDate || Date.parse(m.endDate) > now.getTime()));
  // A price is the crowd's only where the market has traded: one with no traded volume (none given, or $0) or no price is
  // left out, and counted, never shown as "volume $0" or "0%".
  const traded = open.filter((m) => (volumeOf(m) ?? 0) > 0), shown = traded.filter((m) => firstPrice(m.outcomePrices) !== null)
    .sort((a, b) => volumeOf(b)! - volumeOf(a)!).slice(0, Math.max(1, Math.min(10, limit)));
  const idle = open.length - traded.length, blank = traded.length - traded.filter((m) => firstPrice(m.outcomePrices) !== null).length;
  const left = [idle ? `${idle} with no traded volume (Polymarket gives none, or $0), so ${idle === 1 ? 'its price is' : 'their prices are'} not yet a crowd's` : '', blank ? `${blank} with no price given` : ''].filter(Boolean);
  const note = left.length ? `\nLeft out of the ${open.length} open market${open.length === 1 ? '' : 's'} that matched: ${left.join('; ')}.` : '';
  const head = `## Polymarket: "${topic}"\nLive odds: the crowd's priced chance of each event (more traded volume, more reliable). A price is not a forecast to take as certain. The date after each market is when it stops trading, not the date of the event it asks about: take an event's own date from the news or a filing.\n`;
  if (!open.length) return `${head}\nNo open markets matched "${topic}". Polymarket covers mostly economic, political, geopolitical and crypto events; a single company may have none.`;
  if (!shown.length) return `${head}\nNo open market that matched "${topic}" has a traded price to show.${note}`;
  // Rounding never turns a traded price or volume into "0%", "100%" or "$0".
  const chance = (p: number) => (p > 0 && p < 0.005 ? 'under 1%' : p < 1 && p >= 0.995 ? 'over 99%' : `${(p * 100).toFixed(0)}%`);
  const dollars = (v: number) => (v < 1 ? 'under $1' : `$${Math.round(v).toLocaleString('en-US')}`);
  return head + '\n' + shown.map((m) => {
    const p = firstPrice(m.outcomePrices)!, wk = m.oneWeekPriceChange;
    return `- ${m.question}: ${list(m.outcomes)[0]} ${chance(p)} · volume ${dollars(volumeOf(m)!)}${m.endDate ? ` · trading closes ${m.endDate.slice(0, 10)}` : ''}${typeof wk === 'number' ? ` · ${signed(wk * 100, 1)} points this week` : ''}`;
  }).join('\n') + note;
}
