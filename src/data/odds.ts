// Prediction-market odds from Polymarket's public search (no key): the crowd's priced chance of forward-looking events -
// rate decisions, recession, elections, geopolitics, crypto. Polymarket serves only live odds, so a past analysis date
// gets none: today's odds would put later knowledge into an earlier day.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/polymarket.py), Apache License 2.0.
import { analysisDate, isHistorical } from './dates.js';
import { getJson } from './http.js';

interface Market { question?: string; outcomes?: string; outcomePrices?: string; volumeNum?: number; endDate?: string; closed?: boolean; active?: boolean; oneWeekPriceChange?: number }
interface SearchJson { events?: Array<{ markets?: Market[] }> }

const list = (s: string | undefined): string[] => { try { const v = JSON.parse(s ?? '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

export async function predictionMarkets(topic: string, analysis: string, limit = 6, now = new Date()): Promise<string> {
  const day = analysisDate(analysis);
  if (isHistorical(day)) return `Prediction-market odds are withheld for ${day}: Polymarket serves only today's odds on open markets, and those would put later knowledge into an analysis of ${day}.`;
  const j = await getJson<SearchJson>(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(topic)}&limit_per_type=20`);
  const open = (j.events ?? []).flatMap((e) => e.markets ?? []).filter((m) => m.question && !m.closed && m.active !== false && list(m.outcomePrices).length && list(m.outcomes).length && (!m.endDate || Date.parse(m.endDate) > now.getTime()))
    .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0)).slice(0, Math.max(1, Math.min(10, limit)));
  const head = `## Polymarket: "${topic}"\nLive odds: the crowd's priced chance of each event (more traded volume, more reliable). A price is not a forecast to take as certain.\n`;
  if (!open.length) return `${head}\nNo open markets matched "${topic}". Polymarket covers mostly economic, political, geopolitical and crypto events; a single company may have none.`;
  return head + '\n' + open.map((m) => {
    const p = Number(list(m.outcomePrices)[0]), wk = m.oneWeekPriceChange;
    return `- ${m.question}: ${list(m.outcomes)[0]} ${(p * 100).toFixed(0)}% · volume $${Math.round(m.volumeNum ?? 0).toLocaleString('en-US')}${m.endDate ? ` · resolves ${m.endDate.slice(0, 10)}` : ''}${typeof wk === 'number' ? ` · ${wk >= 0 ? '+' : ''}${(wk * 100).toFixed(1)} points this week` : ''}`;
  }).join('\n');
}
