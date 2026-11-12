// What the dashboard lets the person add and order: only what they can buy and sell here. Robinhood's agent doorway
// trades US stocks and US funds that trade like stocks (ETFs), and coins, of which the desk orders Bitcoin and Ether.
// Anything else (another coin, an index, a currency rate, a future, a mutual fund bought from its fund company, a
// listing outside the main US exchanges) is left out of the search, refused where it would be added, marked "can't be
// bought here" where it is already on the watchlist, and opens no order to buy. Each says why in words, from its
// spelling or from Yahoo Finance's own description of it (its kind and its exchange), never a guess: what Yahoo does
// not describe is not offered. The page and the server read the same words from here.
import { US_EXCHANGES, type Listing } from '../data/delay.js';
import { isCrypto } from '../data/symbols.js';
import { TICKET_COINS } from '../desk/ticket.js';

/** What can be bought here, in one line, for the search and the page. */
export const BUYABLE_WORDS = 'US stocks and funds on Nasdaq, NYSE, NYSE Arca, NYSE American or Cboe, and Bitcoin and Ether';

/** Yahoo's description of an instrument, as its chart service (`fullExchangeName`) or its search (`exchDisp`) names
 *  the exchange in words. */
export interface Described extends Listing { fullExchangeName?: string }

const INDEX = (s: string) => `${s} is an index, a measure of a market that cannot itself be bought: a fund that follows it can, such as SPY for the S&P 500.`;
const CURRENCY = (s: string) => `${s} is a currency rate, which cannot be bought here.`;
const FUTURE = (s: string) => `${s} is a futures contract, which cannot be bought here.`;

/** Why a symbol cannot be bought here from its spelling alone: a coin other than Bitcoin and Ether, an index (^), a
 *  future (=F) or a currency rate (=X). Null when its spelling does not say: a stock or a fund is then checked against
 *  Yahoo's description (`unbuyable`). */
export function spelledUnbuyable(symbol: string): string | null {
  if (isCrypto(symbol)) return TICKET_COINS.has(symbol) ? null : `${symbol} is a coin the desk does not order: among coins, only Bitcoin and Ether can be bought here.`;
  if (symbol.startsWith('^')) return INDEX(symbol);
  if (/=F$/.test(symbol)) return FUTURE(symbol);
  if (symbol.includes('=')) return CURRENCY(symbol);
  return null;
}

/** A field of Yahoo's answer as text: anything else (a number, an object) is none. */
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** The OTC markets, as Yahoo names them: shares traded between dealers, not on an exchange. */
const isOtc = (d: Described) => text(d.exchangeName) === 'PNK' || /\bOTC\b/i.test(text(d.fullExchangeName));

/** Why it cannot be bought here, from its spelling and then Yahoo's description; null when it can: a stock or an ETF
 *  on a main US exchange, or Bitcoin or Ether. */
export function unbuyable(symbol: string, d: Described): string | null {
  const spelled = spelledUnbuyable(symbol);
  if (spelled) return spelled;
  if (TICKET_COINS.has(symbol)) return null;
  switch (d.instrumentType) {
    case 'EQUITY': case 'ETF':
      if (US_EXCHANGES.includes(text(d.exchangeName))) return null;
      if (isOtc(d)) return `${symbol} trades over the counter (between dealers, not on an exchange), so it cannot be bought here: ${BUYABLE_WORDS} can.`;
      return `${symbol} trades ${text(d.fullExchangeName) ? `on ${text(d.fullExchangeName).slice(0, 40)}` : 'outside the main US exchanges'}, so it cannot be bought here: ${BUYABLE_WORDS} can.`;
    case 'CRYPTOCURRENCY': return `${symbol} is a coin priced in another currency: Bitcoin and Ether are offered in dollars, as BTC-USD and ETH-USD.`;
    case 'MUTUALFUND': return `${symbol} is a mutual fund, bought from its fund company once a day rather than traded on an exchange, so it cannot be bought here: a fund that trades like a stock (an ETF) can.`;
    case 'INDEX': return INDEX(symbol);
    case 'CURRENCY': return CURRENCY(symbol);
    case 'FUTURE': return FUTURE(symbol);
    case undefined: return undescribed(symbol);
    default: return `${symbol} is not a stock, a fund or a coin, so it cannot be bought here.`;
  }
}

/** For what Yahoo gives a price but no kind: it is not added, since it cannot be checked. An order ticket is not stopped
 *  by it, though: there Robinhood's own check (Review) decides. */
export const undescribed = (symbol: string): string => `Yahoo Finance does not say what ${symbol} is, so whether it can be bought here cannot be checked: it was not added.`;
