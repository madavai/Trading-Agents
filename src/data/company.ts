// What the company-accounts analyst reads: the financial statements - as filed with the SEC for a US filer, else Yahoo
// Finance's for today only - and Yahoo Finance's profile, ratios and insider trades. Yahoo serves those only as they
// stand today, with no filing date, so each is withheld for a past analysis date rather than leak later knowledge into it.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/yahoo/fundamentals.py and date_window.py), Apache License
// 2.0; rewritten in TypeScript.
import { addDays, analysisDate, isHistorical } from './dates.js';
import { getCookies, getJson, getText, NoData, Unavailable } from './http.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';
import { HOSTS } from './yahoo.js';
import { secStatement, SHOWN, STATEMENTS, type Frequency, type Statement, type Table } from './sec.js';

/** The symbol of a company; a crypto asset, an index, a future or a currency pair has no company accounts. */
function companySymbol(raw: string): string {
  const sym = normalizeSymbol(raw);
  if (cryptoBase(raw) || /[\^=]/.test(sym)) throw new NoData(`${sym} is not a company: a crypto asset, index, future or currency pair has no company accounts`);
  return sym;
}

// Yahoo serves company data only to a session: a cookie from fc.yahoo.com and a key ("crumb") issued for it.
let session: Promise<{ cookie: string; crumb: string }> | null = null;

function yahooSession(): Promise<{ cookie: string; crumb: string }> {
  session ??= (async () => {
    const cookie = await getCookies('https://fc.yahoo.com');
    if (!cookie) throw new Unavailable('Yahoo Finance gave no session cookie');
    const crumb = (await getText(`${HOSTS[1]}/v1/test/getcrumb`, { headers: { Cookie: cookie } })).trim();
    if (!crumb || crumb.length > 64 || /[\s<]/.test(crumb)) throw new Unavailable('Yahoo Finance gave no session key');
    return { cookie, crumb };
  })();
  session.catch(() => { session = null; });
  return session;
}

export function clearYahooSession(): void { session = null; }

/** A Yahoo company-data answer, asking for a new session once when the old one has expired. */
async function yahooJson<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const s = await yahooSession();
    try {
      return await getJson<T>(`${HOSTS[1]}${path}&crumb=${encodeURIComponent(s.crumb)}`, { headers: { Cookie: s.cookie } });
    } catch (e) {
      if (attempt === 0 && /HTTP 401/.test((e as Error).message)) { session = null; continue; }
      throw e;
    }
  }
}

type V = { raw?: number; fmt?: string } | undefined;
interface Summary {
  quoteSummary?: {
    result?: Array<{
      price?: { longName?: string; shortName?: string; currency?: string; marketCap?: V };
      summaryProfile?: { sector?: string; industry?: string };
      summaryDetail?: Record<string, V>;
      defaultKeyStatistics?: Record<string, V>;
      financialData?: Record<string, V> & { financialCurrency?: string };
      insiderTransactions?: { transactions?: Array<{ filerName?: string; filerRelation?: string; transactionText?: string; ownership?: string; startDate?: V; shares?: V; value?: V }> };
    }> | null;
    error?: { description?: string } | null;
  };
}

async function summary(sym: string, modules: string): Promise<NonNullable<NonNullable<Summary['quoteSummary']>['result']>[number]> {
  const j = await yahooJson<Summary>(`/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}`);
  const r = j.quoteSummary?.result?.[0];
  if (!r) throw new NoData(`Yahoo Finance has no company data for ${sym}${j.quoteSummary?.error?.description ? ` (${j.quoteSummary.error.description})` : ''}`);
  return r;
}

// Quote currencies Yahoo gives in a minor unit (London in pence), and the main unit of each.
const MAIN_UNIT: Record<string, string> = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };
const has = (v: V): v is { raw: number } => typeof v?.raw === 'number' && Number.isFinite(v.raw);
const money = (v: V, currency?: string) => (has(v) ? `${v.raw.toLocaleString('en-US', { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}` : null);
const plain = (v: V) => (has(v) ? String(Number(v.raw.toFixed(4))) : null);
const percent = (v: V) => (has(v) ? `${(v.raw * 100).toFixed(2)}%` : null);   // Yahoo gives margins, returns and yield as fractions

export async function companyOverview(raw: string, analysis: string): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw);
  if (isHistorical(day)) return `Company profile and ratios for ${sym} are withheld for ${day}: Yahoo Finance serves them only as they stand today. Market value, multiples, the 52-week range and the past year's income move with today's price, and even the name, sector and industry are today's; they would put later knowledge into an analysis of ${day}. Use get_financial_statement, which serves a US filer's accounts as filed by then.`;
  const r = await summary(sym, 'price,summaryProfile,summaryDetail,defaultKeyStatistics,financialData');
  const p = r.price ?? {}, d = r.summaryDetail ?? {}, k = r.defaultKeyStatistics ?? {}, f = r.financialData ?? {};
  // Three currencies: prices in the quote currency (which can be pence), market value and per-share figures in its main
  // unit, income in the currency the company reports in (an ADR quotes in USD and may report in another).
  const quote = p.currency, main = quote ? MAIN_UNIT[quote] ?? quote : undefined, reported = f.financialCurrency;
  const de = has(f.debtToEquity) ? `${Number(f.debtToEquity.raw.toFixed(2))}% (${(f.debtToEquity.raw / 100).toFixed(2)}x)` : null;   // Yahoo gives this one in percent
  const fields: Array<[string, string | null | undefined]> = [
    ['Name', p.longName ?? p.shortName], ['Sector', r.summaryProfile?.sector], ['Industry', r.summaryProfile?.industry],
    ['Market Cap', money(p.marketCap ?? d.marketCap, main)],
    ['PE Ratio (TTM)', plain(d.trailingPE)], ['Forward PE', plain(d.forwardPE ?? k.forwardPE)], ['PEG Ratio', plain(k.pegRatio)], ['Price to Book', plain(k.priceToBook)],
    ['EPS (TTM)', money(k.trailingEps, main)], ['Forward EPS', money(k.forwardEps, main)],
    ['Dividend Yield', percent(d.dividendYield)], ['Beta', plain(d.beta ?? k.beta)],
    ['52 Week High', money(d.fiftyTwoWeekHigh, quote)], ['52 Week Low', money(d.fiftyTwoWeekLow, quote)],
    ['50 Day Average', money(d.fiftyDayAverage, quote)], ['200 Day Average', money(d.twoHundredDayAverage, quote)],
    ['Revenue (TTM)', money(f.totalRevenue, reported)], ['Gross Profit (TTM)', money(f.grossProfits, reported)], ['EBITDA', money(f.ebitda, reported)],
    ['Net Income (TTM)', money(k.netIncomeToCommon, reported)], ['Free Cash Flow', money(f.freeCashflow, reported)],
    ['Profit Margin', percent(f.profitMargins ?? k.profitMargins)], ['Operating Margin', percent(f.operatingMargins)],
    ['Return on Equity', percent(f.returnOnEquity)], ['Return on Assets', percent(f.returnOnAssets)],
    ['Debt to Equity', de], ['Current Ratio', plain(f.currentRatio)], ['Book Value per Share', money(k.bookValue, main)],
  ];
  const lines = fields.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([l, v]) => `${l}: ${v}`);
  if (!lines.length) throw new NoData(`Yahoo Finance has no profile or ratios for ${sym}`);
  return [`Company profile and ratios for ${sym}, from Yahoo Finance as they stand today (${day}). TTM is the last twelve months; a field Yahoo does not give is left out.`, '', ...lines].join('\n');
}

export async function insiderTransactions(raw: string, analysis: string, limit = 30): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw);
  if (isHistorical(day)) return `Insider transactions for ${sym} are withheld for ${day}: Yahoo Finance dates a trade by when it happened, not by when its filing made it public (up to two business days later), so it cannot show which trades were known on ${day}.`;
  const r = await summary(sym, 'insiderTransactions');
  const list = (r.insiderTransactions?.transactions ?? []).filter((t) => has(t.startDate)).sort((a, b) => b.startDate!.raw! - a.startDate!.raw!).slice(0, limit);
  if (!list.length) return `No insider transactions reported for ${sym} by Yahoo Finance. Many listings have none.`;
  const n = (v: V) => (has(v) ? v.raw.toLocaleString('en-US') : null);
  return [`Insider transactions for ${sym} from Yahoo Finance (the latest ${list.length}, newest first). Each is dated by the trade; its filing follows within two business days.`, '',
    ...list.map((t) => `- ${new Date(t.startDate!.raw! * 1000).toISOString().slice(0, 10)} · ${t.filerName ?? 'unnamed'}${t.filerRelation ? ` (${t.filerRelation})` : ''}: ${t.transactionText || 'no description'}${n(t.shares) ? ` · ${n(t.shares)} shares` : ''}${n(t.value) ? ` · value ${n(t.value)}` : ''}${t.ownership === 'I' ? ' · held indirectly' : ''}`)].join('\n');
}

// Yahoo's names for the statement lines, in the order of the SEC table's lines, so both sources read alike.
const YAHOO_LINES: Record<Statement, string[]> = {
  balance_sheet: ['TotalAssets', 'CurrentAssets', 'CashAndCashEquivalents', 'TotalLiabilitiesNetMinorityInterest', 'CurrentLiabilities', 'StockholdersEquity'],
  income_statement: ['TotalRevenue', 'CostOfRevenue', 'GrossProfit', 'OperatingIncome', 'NetIncome', 'DilutedEPS'],
  cashflow: ['OperatingCashFlow', 'InvestingCashFlow', 'FinancingCashFlow', 'CapitalExpenditure'],
};

interface Point { asOfDate?: string; currencyCode?: string; reportedValue?: V }
interface TimeseriesJson { timeseries?: { result?: Array<{ meta?: { type?: string[] } } & Record<string, unknown>> | null } }

/** A statement from Yahoo's fundamentals series, as it stands today. Exported for the tests. */
export function yahooTable(j: TimeseriesJson, kind: Statement, freq: Frequency): Table {
  const series = new Map<string, Point[]>();
  for (const r of j.timeseries?.result ?? []) { const t = r.meta?.type?.[0]; if (t && Array.isArray(r[t])) series.set(t, (r[t] as Array<Point | null>).filter((p): p is Point => !!p)); }
  const lines = YAHOO_LINES[kind].map((name, i) => {
    const values = new Map<string, number>();
    let unit = '';
    for (const p of series.get(freq + name) ?? []) if (p.asOfDate && has(p.reportedValue)) { values.set(p.asOfDate, p.reportedValue.raw); unit = p.currencyCode ?? unit; }
    return { label: STATEMENTS[kind].lines[i]![0], unit: name === 'DilutedEPS' ? `${unit}/shares` : unit, values };
  });
  const ends = [...new Set(lines.flatMap((l) => [...l.values.keys()]))].sort().reverse().slice(0, SHOWN[freq]);
  if (!ends.length) throw new NoData(`Yahoo Finance has no ${freq} ${STATEMENTS[kind].title.toLowerCase()}`);
  return { columns: ends, rows: lines.map((l) => ({ label: l.label, unit: l.unit, cells: ends.map((e) => l.values.get(e) ?? null) })) };
}

const epoch = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

async function yahooStatement(sym: string, kind: Statement, freq: Frequency, day: string): Promise<Table> {
  const types = YAHOO_LINES[kind].map((n) => freq + n).join(',');
  const j = await yahooJson<TimeseriesJson>(`/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=${epoch(addDays(day, -6 * 366))}&period2=${epoch(addDays(day, 1))}`);
  return yahooTable(j, kind, freq);
}

/** A statement as a table an agent reads: millions of the main currency, per-share rows as they are, "–" for no figure. */
export function renderTable(t: Table, head: string, note: string): string {
  const rows = t.rows.filter((r) => r.cells.some((c) => c !== null)), missing = t.rows.filter((r) => !rows.includes(r)).map((r) => r.label);
  const perShare = (u: string) => u.includes('/');
  const main = rows.find((r) => !perShare(r.unit))?.unit ?? '';
  const name = (r: Table['rows'][number]) => (perShare(r.unit) ? `${r.label} (${r.unit.split('/')[0] || 'currency'} per share)` : r.unit !== main ? `${r.label} (millions of ${r.unit || 'an unstated currency'})` : r.label);
  const cell = (v: number | null, u: string) => (v === null ? '–' : perShare(u) ? v.toFixed(2) : (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const out = [head, `Money in millions of ${main || 'an unstated currency'} unless the row says otherwise; "–" means no figure for that period. ${note}`, '',
    `Line | ${t.columns.join(' | ')}`, `---|${t.columns.map(() => '---:').join('|')}`, ...rows.map((r) => `${name(r)} | ${r.cells.map((c) => cell(c, r.unit)).join(' | ')}`)];
  if (missing.length) out.push('', `Not reported by this source: ${missing.join(', ')}.`);
  return out.join('\n');
}

const SEC_EMAIL = 'the SEC asks every caller for a contact email: put yours in desk-settings.json, sources.secContactEmail';
const reason = (e: unknown) => { const m = (e as Error).message; return /sec\.gov refused \(HTTP 403\)/.test(m) ? `${m}: ${SEC_EMAIL}` : m; };

/** A financial statement: as filed with the SEC by the analysis date for a US filer; else, for today only, Yahoo's. */
export async function financialStatement(raw: string, kind: Statement, freq: Frequency, analysis: string): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw), title = STATEMENTS[kind].title;
  let secFailure: unknown;
  try {
    const t = await secStatement(sym, kind, freq, day);
    const q4 = kind !== 'balance_sheet' && freq === 'quarterly' ? ' A fourth quarter is never derived: it is filed only inside the annual figure.' : '';
    return renderTable(t, `${title} for ${sym} (${freq}), as filed with the SEC on or before ${day}`, `Each figure is the latest filing of it by that day; a restatement counts only from the day it was filed.${q4}`);
  } catch (e) { secFailure = e; }
  if (isHistorical(day)) {
    if (!(secFailure instanceof NoData)) throw new Unavailable(`the SEC, the only source of accounts as filed by ${day}, could not answer (${reason(secFailure)})`);
    return `${title} for ${sym} is withheld for ${day}: ${reason(secFailure)}, and the other source, Yahoo Finance, dates a statement by the period it covers, not by when it was filed, so it cannot show which figures were public on ${day}.`;
  }
  try {
    const t = await yahooStatement(sym, kind, freq, day);
    return renderTable(t, `${title} for ${sym} (${freq}), from Yahoo Finance as it stands today`, `Not from the SEC (${reason(secFailure)}). Yahoo gives money spent, such as capital expenditure, as a negative figure.`);
  } catch (e) {
    const both = `SEC: ${reason(secFailure)}; Yahoo Finance: ${(e as Error).message}`;
    throw secFailure instanceof NoData && e instanceof NoData ? new NoData(both) : new Unavailable(both);
  }
}
