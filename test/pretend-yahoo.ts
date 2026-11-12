// Yahoo's one-day answer standing in for the real one in the tests that open order tickets, so a buy's check of what a
// symbol is (terminal/buyable.ts) never goes out to the internet: a symbol ending .TO is a listing in Toronto, a coin is
// a coin, anything else a US stock on Nasdaq. Any other address goes out as before.
import { configure } from '../src/data/http.js';
import { clearQuotes } from '../src/terminal/quotes.js';

export function pretendListings(): void {
  const realFetch = fetch;
  configure({ fetch: async (input, init) => {
    const m = /\/v8\/finance\/chart\/([^?]+)\?range=1d/.exec(String(input));
    if (!m) return realFetch(input, init);
    const symbol = decodeURIComponent(m[1]!), now = Math.floor(Date.now() / 1000);
    const listing = symbol.endsWith('.TO') ? { instrumentType: 'EQUITY', exchangeName: 'TOR', fullExchangeName: 'Toronto' }
      : symbol.endsWith('-USD') ? { instrumentType: 'CRYPTOCURRENCY', exchangeName: 'CCC' }
      : { instrumentType: 'EQUITY', exchangeName: 'NMS' };
    return new Response(JSON.stringify({ chart: { result: [{ meta: { symbol, currency: 'USD', regularMarketPrice: 100, chartPreviousClose: 99, regularMarketTime: now - 60, ...listing }, timestamp: [now - 60], indicators: { quote: [{ close: [100] }] } }], error: null } }));
  } });
  clearQuotes();
}
