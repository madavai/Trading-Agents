// How late a price from Yahoo Finance may be, said only as far as it is known. The desk is US-focused (US stocks and
// funds, and coins), so those get Yahoo's own figure; any other market says only that it may be late, with no number.
// Nothing about lateness is said beside a close: a close is final.
//
// Source: Yahoo's help page "Exchanges and data providers on Yahoo Finance", https://help.yahoo.com/kb/SLN2310.html, its
// table "Yahoo Finance Market Coverage and Data Delays", read on 9 Nov 2026. What it says, row by row where it matters:
// - United States: "Nasdaq Stock Exchange | N/A | Real-time | ICE Data Services"; "Blue Ocean ATS (BOATS) | Real-time"
//   (the overnight session); "OTC Markets Group | 15 min"; "Cboe Indices | 15 min"; "NYSE Indices | 15 min"; "S & P
//   Indices | Real-time"; "Dow Jones Indexes | Real-time"; CBOT and CME futures 10 min, COMEX and NYMEX 30 min. The New
//   York Stock Exchange and NYSE Arca have no row of their own.
// - "Global | Cryptocurrencies | N/A | Real-time | Coinbase" (and the same row for CoinMarketCap).
// - Elsewhere, from real-time (Toronto) to 30 minutes (Shanghai, Shenzhen, Switzerland): for example Tokyo (.T), Korea
//   (.KS), Taiwan (.TW), London (.L) and Australia (.AX) 20 min.
// The page is about Yahoo's website. The desk reads Yahoo's chart service, and the page does not say that the service has
// the website's delays, so it was checked on the same day:
// - coins: BTC-USD's latest price was 2 seconds old, ETH-USD's 5 seconds (9 Nov 2026, 04:13 UTC): real-time, as the page says;
// - US: see US_CHECK below;
// - Tokyo: Toyota (7203.T), during its session, was 15 minutes old where the page says 20. The page's figure is not the
//   service's for every market, so a market the desk has not checked gets no number: "may be late".

/** Which market a price is from, for how late it may be. */
export type PriceMarket = 'us' | 'coin' | 'other';

/** What Yahoo's chart service says of an instrument: its kind and the exchange it trades on. */
export interface Listing { instrumentType?: string; exchangeName?: string }

/** The US exchanges whose prices were checked on the desk's own feed (US_CHECK): Nasdaq's tiers, the New York Stock
 *  Exchange and NYSE Arca, as Yahoo's chart service names them. A US listing elsewhere (NYSE American, Cboe's exchanges,
 *  the OTC markets, which Yahoo lists as 15 minutes late) is not among them, so it is "other": it may be late. */
export const US_EXCHANGES: readonly string[] = ['NMS', 'NGM', 'NCM', 'NYQ', 'PCX'];

/** The check of the desk's own feed for US prices (Yahoo's chart service, the dashboard's 5-minute and 1-minute bars). */
export const US_CHECK = 'PENDING';

/** The market of a price, from Yahoo's own description of the instrument: a coin; a US stock or fund on an exchange
 *  checked above; or any other. */
export function priceMarket(listing: Listing): PriceMarket {
  if (listing.instrumentType === 'CRYPTOCURRENCY') return 'coin';
  if ((listing.instrumentType === 'EQUITY' || listing.instrumentType === 'ETF') && US_EXCHANGES.includes(listing.exchangeName ?? '')) return 'us';
  return 'other';
}

/** How late a live price may be, in a word or two after where it is from: "$188.08 (+1.20% today) on Yahoo Finance,
 *  real-time"; "¥3,050 (+0.40% today) on Yahoo Finance, may be late". Never beside a close. */
export const LATE: Readonly<Record<PriceMarket, string>> = { us: 'real-time', coin: 'real-time', other: 'may be late' };

/** The same, said of where the price comes from in a sentence of its own. */
export const DELAY_SENTENCE = 'Prices come from Yahoo Finance: real-time for US stocks and funds on Nasdaq, the New York Stock Exchange and NYSE Arca, and for coins, by Yahoo\'s own list of its delays; any other market\'s price may be late. A close is final.';

/** The short form, for a chip or a footnote. */
export const DELAY_SHORT = 'US and coin prices real-time · others may be late';
