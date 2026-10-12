// Ticker symbols as Yahoo Finance spells them. People type broker or chart-site symbols (XAUUSD, BTCUSD, SPX500,
// 700.HK); Yahoo answers those with nothing, and an agent handed nothing may invent a price. So every symbol is mapped
// here first, by rule, with no network call.
// Adapted from TradingAgents (tradingagents/dataflows/symbols.py), Apache License 2.0; rewritten in TypeScript.

const FOREX = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'CNH', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'ZAR', 'TRY', 'INR', 'KRW', 'BRL', 'RUB', 'THB']);
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'BCH', 'DOT', 'AVAX', 'LINK']);
const CRYPTO_QUOTES = ['USDT', 'USDC', 'USD'];

const ALIASES: Record<string, string> = {
  XAUUSD: 'GC=F', XAU: 'GC=F', GOLD: 'GC=F', XAGUSD: 'SI=F', XAG: 'SI=F', SILVER: 'SI=F', XPTUSD: 'PL=F', XPDUSD: 'PA=F',
  WTICOUSD: 'CL=F', USOIL: 'CL=F', WTI: 'CL=F', BCOUSD: 'BZ=F', UKOIL: 'BZ=F', BRENT: 'BZ=F', NATGAS: 'NG=F', XNGUSD: 'NG=F',
  COPPER: 'HG=F', XCUUSD: 'HG=F',
  SPX500: '^GSPC', US500: '^GSPC', SPX: '^GSPC', NAS100: '^NDX', US100: '^NDX', USTEC: '^NDX', US30: '^DJI', DJI30: '^DJI', WS30: '^DJI',
  GER40: '^GDAXI', GER30: '^GDAXI', DE40: '^GDAXI', UK100: '^FTSE', JP225: '^N225', JPN225: '^N225', FRA40: '^FCHI', EU50: '^STOXX50E', HK50: '^HSI',
};

/** The crypto base (BTC) of a symbol quoted in USD, USDT or USDC, in any spelling (BTC-USD, BTCUSD, BTC-USDT); else null. */
export function cryptoBase(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/\+$/, '').replaceAll('-', '');
  for (const q of CRYPTO_QUOTES) {
    if (compact.endsWith(q)) {
      const base = compact.slice(0, -q.length);
      return CRYPTO_BASES.has(base) ? base : null;
    }
  }
  return null;
}

/** The Yahoo Finance symbol for what a person typed: an alias, a crypto pair, a forex pair, a Hong Kong or Shanghai code,
 *  or the symbol itself in capitals. */
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
  return s;
}

export const isCrypto = (raw: string): boolean => cryptoBase(raw) !== null;

/** A symbol safe to use in a file name and a URL path: letters, digits and . - = ^ only. */
export function safeSymbol(raw: string): string {
  const s = normalizeSymbol(raw);
  if (!/^[A-Z0-9.\-=^]{1,20}$/.test(s)) throw new Error(`"${raw}" is not a ticker symbol this desk can look up`);
  return s;
}
