// Ticker symbols as Yahoo Finance spells them. People type broker or chart-site symbols (XAUUSD, BTCUSD, SPX500,
// 700.HK); Yahoo answers those with nothing, and an agent handed nothing may invent a price. So every symbol is mapped
// here first, by rule, with no network call.
// Adapted from TradingAgents (tradingagents/dataflows/symbols.py), Apache License 2.0; rewritten in TypeScript.

const FOREX = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'CNH', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'ZAR', 'TRY', 'INR', 'KRW', 'BRL', 'RUB', 'THB']);
/** The coins whose compact spelling (BTCUSD) the desk reads: a compact pair is told from a stock's ticker only by its base.
 *  Yahoo's own spelling of any coin, BASE-USD (SHIB-USD, BNB-USD, UNI7083-USD), is read as a coin whatever its base. */
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'BCH', 'DOT', 'AVAX', 'LINK']);
const CRYPTO_QUOTES = ['USDT', 'USDC', 'USD'];
/** A base before "-USD" that is not a coin: a currency (EUR-USD) or a metal (XAU-USD). */
const NOT_COINS = new Set([...FOREX, 'XAU', 'XAG', 'XPT', 'XPD']);
/** Yahoo's spelling of a coin quoted in dollars: its base (letters and digits, at least one letter) and -USD, -USDT or -USDC. */
const COIN_PAIR = /^([A-Z0-9]{1,15})-(USDT|USDC|USD)$/;
/** One letter after a dot is a US share class (BRK.B), which Yahoo spells with a dash (BRK-B), except Yahoo's one-letter
 *  exchanges (.T Tokyo, .L London, .V TSX Venture, .F Frankfurt). */
const SHARE_CLASS = /^([A-Z]{1,5})\.([A-Z])$/, ONE_LETTER_EXCHANGES = new Set(['T', 'L', 'V', 'F']);

// Chart-site and broker names for what is not a stock. A name that is also a US stock's ticker is left out, so the stock
// is never taken for something else: WTI is W&T Offshore's ticker in New York (crude oil is USOIL, WTICOUSD or CL=F).
const ALIASES: Record<string, string> = {
  XAUUSD: 'GC=F', XAU: 'GC=F', GOLD: 'GC=F', XAGUSD: 'SI=F', XAG: 'SI=F', SILVER: 'SI=F', XPTUSD: 'PL=F', XPDUSD: 'PA=F',
  WTICOUSD: 'CL=F', USOIL: 'CL=F', BCOUSD: 'BZ=F', UKOIL: 'BZ=F', BRENT: 'BZ=F', NATGAS: 'NG=F', XNGUSD: 'NG=F',
  COPPER: 'HG=F', XCUUSD: 'HG=F',
  SPX500: '^GSPC', US500: '^GSPC', SPX: '^GSPC', NAS100: '^NDX', US100: '^NDX', USTEC: '^NDX', US30: '^DJI', DJI30: '^DJI', WS30: '^DJI',
  GER40: '^GDAXI', GER30: '^GDAXI', DE40: '^GDAXI', UK100: '^FTSE', JP225: '^N225', JPN225: '^N225', FRA40: '^FCHI', EU50: '^STOXX50E', HK50: '^HSI',
};

/** The crypto base (BTC) of a coin quoted in USD, USDT or USDC: any coin in Yahoo's own spelling (SHIB-USD, BTC-USDT), and
 *  the coins the desk lists in a compact spelling (BTCUSD); else null. */
export function cryptoBase(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\+$/, '');
  const pair = COIN_PAIR.exec(s);
  if (pair) return /[A-Z]/.test(pair[1]!) && !NOT_COINS.has(pair[1]!) ? pair[1]! : null;
  const compact = s.replaceAll('-', '');
  for (const q of CRYPTO_QUOTES) {
    if (compact.endsWith(q)) {
      const base = compact.slice(0, -q.length);
      return CRYPTO_BASES.has(base) ? base : null;
    }
  }
  return null;
}

/** A US share class as Yahoo spells it (BRK.B is BRK-B); anything else as it is. */
const yahooClass = (s: string): string => {
  const m = SHARE_CLASS.exec(s);
  return m && !ONE_LETTER_EXCHANGES.has(m[2]!) ? `${m[1]}-${m[2]}` : s;
};

/** The Yahoo Finance symbol for what a person typed: an alias, a crypto pair, a forex pair, a US share class, a Hong Kong or
 *  Shanghai code, or the symbol itself in capitals. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\+$/, '');
  if (!s) return s;
  if (ALIASES[s]) return ALIASES[s]!;
  const base = cryptoBase(s);
  if (base) return `${base}-USD`;
  if (s.length === 6 && FOREX.has(s.slice(0, 3)) && FOREX.has(s.slice(3))) return `${s}=X`;
  const hk = /^(\d{1,5})\.HK$/.exec(s);
  if (hk) return `${String(Number(hk[1])).padStart(4, '0')}.HK`;
  const sh = /^(\d{6})\.SH$/.exec(s);
  if (sh) return `${sh[1]}.SS`;
  return yahooClass(s);
}

export const isCrypto = (raw: string): boolean => cryptoBase(raw) !== null;

/** The desk's name for what Robinhood lists: a coin is followed as its dollar pair (BTC is BTC-USD, USDC is USDC-USD), a
 *  stock or fund as Yahoo spells it (BRK.B is BRK-B), never through the chart-site names above (a stock is a stock). */
export function deskSymbol(symbol: string, kind: 'stock' | 'crypto'): string {
  const s = symbol.trim().toUpperCase();
  return kind === 'crypto' ? `${cryptoBase(s) ?? s}-USD` : yahooClass(s);
}

/** Robinhood's spelling of a stock the desk names as Yahoo does: a share class with a dot (BRK-B is BRK.B). */
export const brokerSymbol = (symbol: string): string => symbol.replace(/^([A-Z]{1,5})-([A-Z])$/, '$1.$2');

/** A symbol safe to use in a file name and a URL path: letters, digits and . - = ^ only. */
export function safeSymbol(raw: string): string {
  const s = normalizeSymbol(raw);
  if (!/^[A-Z0-9.\-=^]{1,20}$/.test(s)) throw new Error(`"${raw}" is not a ticker symbol this desk can look up`);
  return s;
}

/** A ticker as a broker gave it, checked to be safe in a file name and a URL path, with no mapping at all: a stock's own
 *  ticker is never read as a chart-site name (WTI stays W&T Offshore). */
export function checkedTicker(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z0-9.\-=^]{1,20}$/.test(s)) throw new Error(`"${raw}" is not a ticker symbol this desk can look up`);
  return s;
}
