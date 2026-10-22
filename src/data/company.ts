// What the company-accounts analyst reads, from official sources first: for a US filer, the SEC's own records - the
// financial statements, the profile and valuation worked out from what was filed and the checked closing price, and the
// insider trades of its Form 4s - each as known on the analysis date, so a past day reads them too. Yahoo Finance is
// asked only for a company that does not file with the SEC, and for today only: it serves such data with no filing date,
// so it is withheld for a past analysis date rather than leak later knowledge into it.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/yahoo/fundamentals.py and date_window.py), Apache License
// 2.0; rewritten in TypeScript.
import { addDays, analysisDate, isHistorical } from './dates.js';
import { getCookies, getJson, getText, NoData, Unavailable } from './http.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';
import { history, HOSTS } from './yahoo.js';
import { averageDilutedShares, cikFor, companyFacts, fundTickers, latestBalance, sectorOfSic, secStatement, sharesOutstanding, SHOWN, STATEMENTS, submissions, trailingYear, type Fact, type Frequency, type Statement, type Table } from './sec.js';
import { secInsiders } from './insiders.js';
import { ASK_FOR_EMAIL } from '../contact.js';

/** The filer's CIK, or null when the SEC does not list it (or its list could not be read). */
const filer = (sym: string): Promise<string | null> => cikFor(sym).catch(() => null);

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
      quoteType?: { quoteType?: string };
      summaryDetail?: Record<string, V>;
      defaultKeyStatistics?: Record<string, V>;
      financialData?: Record<string, V> & { financialCurrency?: string };
      insiderTransactions?: { transactions?: Array<{ filerName?: string; filerRelation?: string; transactionText?: string; ownership?: string; startDate?: V; shares?: V; value?: V }> };
      fundProfile?: { family?: string; categoryName?: string; legalType?: string; feesExpensesInvestment?: Record<string, V> };
      topHoldings?: Record<string, V> & {
        holdings?: Array<{ symbol?: string; holdingName?: string; holdingPercent?: V }>;
        sectorWeightings?: Array<Record<string, V>>;
      };
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

/** A symbol's sector and whether it is a fund, from the SEC: a fund if the SEC lists it among funds, else the sector of
 *  the industry code its filer gave (approximate); not known for a company that does not file with the SEC. For the
 *  dashboard's sector limit, which is about now. */
export async function profileSector(raw: string): Promise<{ sector: string | null; fund: boolean }> {
  const sym = companySymbol(raw);
  if ((await fundTickers()).has(sym)) return { sector: null, fund: true };
  const cik = await cikFor(sym);
  return { sector: cik ? sectorOfSic((await submissions(cik)).sic) : null, fund: false };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const units = (facts: { units?: Record<string, Fact[]> } | undefined, unit: string): Fact[] => facts?.units?.[unit] ?? [];
const fixed = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const whole = (n: number) => Math.round(n).toLocaleString('en-US');

/** A US filer's profile and valuation as known on `day`: who it is from its SEC record, and the multiples worked out from
 *  what it had filed by then and the checked closing price on or before then. Every multiple is derived and shows what it
 *  came from; what no official free source gives (forward estimates, analysts' targets) is said to be unavailable. */
async function secOverview(sym: string, cik: string, day: string): Promise<string> {
  const [s, facts] = await Promise.all([submissions(cik), companyFacts(cik)]);
  const g = facts.facts?.['us-gaap'] ?? {}, dei = facts.facts?.dei ?? {};
  const lines: string[] = [];
  if (s.name) lines.push(`Name: ${s.name}`);
  if (s.sic) lines.push(`Industry (the SEC's code ${s.sic}): ${s.sicDescription || 'not named'}`, `Sector (worked out from that code, so approximate): ${sectorOfSic(s.sic) ?? 'not known'}`);
  const fy = /^(\d\d)(\d\d)$/.exec(s.fiscalYearEnd ?? '');
  if (fy && Number(fy[1]) >= 1 && Number(fy[1]) <= 12) lines.push(`Fiscal year ends: ${Number(fy[2])} ${MONTHS[Number(fy[1]) - 1]}`);

  let close: { date: string; close: number; currency?: string } | null = null;
  // The close in cents, as the price table shows it, so a product like the market value carries no rounding noise.
  try { const h = await history(sym, day), last = h.bars.at(-1)!; close = { date: last.date, close: Math.round(last.close * 100) / 100, currency: h.meta.currency }; } catch { /* no price: the multiples are unavailable */ }
  const usd = !close?.currency || close.currency === 'USD';
  lines.push(close ? `Close: ${fixed(close.close)} ${close.currency ?? ''} on ${close.date} (the checked price table's latest row on or before ${day})`.replace('  ', ' ') : 'Close: unavailable (the prices could not be read), so no multiple can be worked out');

  const cover = sharesOutstanding(units(dei.EntityCommonStockSharesOutstanding, 'shares'), day);
  const average = cover ? null : averageDilutedShares(units(g.WeightedAverageNumberOfDilutedSharesOutstanding, 'shares'), day);
  const shares = cover ?? average, which = average ? 'average diluted shares' : 'shares';
  if (cover) lines.push(`Shares outstanding: ${whole(cover.shares)} (counted on ${cover.end}, filed ${cover.filed})`);
  else if (average) lines.push(`Shares outstanding: no single count on a cover page filed by then (a company with more than one class of shares gives one per class there, which the SEC's data leaves out). In its place, the weighted average diluted shares from its accounts for ${average.start} to ${average.end}: ${whole(average.shares)} (filed ${average.filed}), so the figures worked out from it are close, not exact`);
  else lines.push('Shares outstanding: unavailable (not on a cover page filed by then)');
  if (shares && close && usd) lines.push(`Market value (derived: ${which} × close): ${whole(shares.shares * close.close)} USD`);

  const eps = trailingYear(units(g.EarningsPerShareDiluted, 'USD/shares'), day);
  if (eps) {
    lines.push(`Diluted EPS, last twelve months (derived from ${eps.parts}): ${fixed(eps.value)} USD`);
    if (close && usd) lines.push(eps.value > 0 ? `Price to earnings (derived: close ÷ that): ${fixed(close.close / eps.value)}` : 'Price to earnings: not meaningful (the last twelve months lost money)');
  } else lines.push('Diluted EPS, last twelve months: unavailable (not filed in US dollars by then)');

  const equity = latestBalance(units(g.StockholdersEquity, 'USD'), day);
  if (equity) {
    lines.push(`Stockholders' equity: ${whole(equity.val)} USD (at ${equity.end}, filed ${equity.filed})`);
    if (shares && shares.shares > 0) {
      const bv = equity.val / shares.shares;
      lines.push(`Book value per share (derived: equity ÷ ${which}): ${fixed(bv)} USD`);
      if (close && usd && bv > 0) lines.push(`Price to book (derived: close ÷ that): ${fixed(close.close / bv)}`);
    }
  }
  const dps = trailingYear(units(g.CommonStockDividendsPerShareDeclared, 'USD/shares'), day) ?? trailingYear(units(g.CommonStockDividendsPerShareCashPaid, 'USD/shares'), day);
  if (dps) {
    lines.push(`Dividends per share, last twelve months (derived from ${dps.parts}): ${fixed(dps.value, 4)} USD`);
    if (close && usd && close.close > 0) lines.push(`Dividend yield (derived: that ÷ close): ${fixed((dps.value / close.close) * 100)}%`);
  } else lines.push('Dividends per share: not among its filed figures (many companies pay none)');
  lines.push('Unavailable from official free sources: forward estimates (forward P/E, PEG), analysts\' price targets and beta.');
  return [`Company profile and valuation for ${sym}, from its SEC filings as they stood on ${day} and the desk's checked closing price. Every multiple is derived here from those filed figures and that price, and shows what it came from; nothing is an estimate.`, '', ...lines].join('\n');
}

export async function companyOverview(raw: string, analysis: string): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw), cik = await filer(sym);
  if (cik) return secOverview(sym, cik, day);
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
  const day = analysisDate(analysis), sym = companySymbol(raw), cik = await filer(sym);
  if (cik) return secInsiders(sym, cik, day);
  if (isHistorical(day)) return `Insider transactions for ${sym} are withheld for ${day}: Yahoo Finance dates a trade by when it happened, not by when its filing made it public (up to two business days later), so it cannot show which trades were known on ${day}.`;
  const r = await summary(sym, 'insiderTransactions');
  const list = (r.insiderTransactions?.transactions ?? []).filter((t) => has(t.startDate)).sort((a, b) => b.startDate!.raw! - a.startDate!.raw!).slice(0, limit);
  if (!list.length) return `No insider transactions reported for ${sym} by Yahoo Finance. Many listings have none.`;
  const n = (v: V) => (has(v) ? v.raw.toLocaleString('en-US') : null);
  return [`Insider transactions for ${sym} from Yahoo Finance (the latest ${list.length}, newest first). Each is dated by the trade; its filing follows within two business days.`, '',
    ...list.map((t) => `- ${new Date(t.startDate!.raw! * 1000).toISOString().slice(0, 10)} · ${t.filerName ?? 'unnamed'}${t.filerRelation ? ` (${t.filerRelation})` : ''}: ${t.transactionText || 'no description'}${n(t.shares) ? ` · ${n(t.shares)} shares` : ''}${n(t.value) ? ` · value ${n(t.value)}` : ''}${t.ownership === 'I' ? ' · held indirectly' : ''}`)].join('\n');
}

// Yahoo's names for a fund's sectors, in plain words.
const FUND_SECTORS: Record<string, string> = {
  technology: 'Technology', financial_services: 'Financial services', healthcare: 'Health care', consumer_cyclical: 'Consumer cyclical',
  communication_services: 'Communication services', industrials: 'Industrials', consumer_defensive: 'Consumer defensive', energy: 'Energy',
  basic_materials: 'Basic materials', realestate: 'Real estate', utilities: 'Utilities',
};

/** What a fund (an ETF or a mutual fund) is, for the fundamentals analyst: what it holds, what it costs to own and how big
 *  it is, from Yahoo Finance as it stands today. The yearly cost, the size and the top holdings are always named, as
 *  "unavailable" when Yahoo does not give them; withheld for a past day, since today's holdings and weights would put
 *  later prices into it. */
export async function fundProfile(raw: string, analysis: string, topN = 10): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw);
  if (isHistorical(day)) return `The fund profile of ${sym} is withheld for ${day}: Yahoo Finance serves it only as it stands today. Today's holdings and their weights carry the prices of every day since ${day}, and its size and yearly cost may have changed; they would put later knowledge into an analysis of ${day}. Say the profile is unavailable for a past day.`;
  const r = await summary(sym, 'price,quoteType,fundProfile,topHoldings,summaryDetail,defaultKeyStatistics');
  const type = r.quoteType?.quoteType ?? '';
  if (type !== 'ETF' && type !== 'MUTUALFUND') throw new NoData(`${sym} is not a fund (Yahoo Finance lists it as ${type ? type.toLowerCase() : 'not a fund'}): use the company tools instead`);
  const p = r.price ?? {}, d = r.summaryDetail ?? {}, k = r.defaultKeyStatistics ?? {}, f = r.fundProfile ?? {}, fees = f.feesExpensesInvestment ?? {}, t = r.topHoldings ?? {};
  const main = p.currency ? MAIN_UNIT[p.currency] ?? p.currency : undefined;
  const inception = has(k.fundInceptionDate) ? new Date(k.fundInceptionDate.raw * 1000).toISOString().slice(0, 10) : null;
  // The yearly cost to three figures (0.0945%, not 0.09%), so what it takes from 1,000 dollars can be worked out.
  const ratio = [fees.annualReportExpenseRatio, fees.netExpRatio, k.annualReportExpenseRatio].find(has);
  const cost = ratio ? `${Number((ratio.raw * 100).toPrecision(3))}%` : null;
  const size = money(d.totalAssets ?? k.totalAssets, main);
  const lines: string[] = [];
  const line = (label: string, v: string | null | undefined, always = false) => { if (v) lines.push(`${label}: ${v}`); else if (always) lines.push(`${label}: unavailable (Yahoo Finance does not give it)`); };
  line('Name', p.longName ?? p.shortName); line('Kind', type === 'ETF' ? 'an exchange-traded fund (ETF)' : 'a mutual fund');
  line('Family', f.family); line('Category', f.categoryName); line('Started', inception);
  line('Net assets (its size)', size, true);
  line('Yearly cost (expense ratio, taken from the fund\'s value each year)', cost, true);
  line('Yield (income paid out over the past year)', percent(d.yield ?? k.yield));
  line('Holdings turnover (how much of it is traded in a year)', percent(fees.annualHoldingsTurnover));
  line('Average yearly return, 3 years (past prices, as Yahoo gives it)', percent(k.threeYearAverageReturn));
  line('Average yearly return, 5 years (past prices, as Yahoo gives it)', percent(k.fiveYearAverageReturn));
  line('Beta, 3 years (how much it moves with the market)', plain(k.beta3Year));

  const split = ([['stocks', t.stockPosition], ['bonds', t.bondPosition], ['cash', t.cashPosition], ['other', t.otherPosition]] as const).filter(([, v]) => has(v)).map(([n, v]) => `${n} ${percent(v)}`);
  if (split.length) lines.push(`Held in: ${split.join(', ')}`);
  const top = (t.holdings ?? []).filter((h) => has(h.holdingPercent)).slice(0, topN);
  if (top.length) {
    const together = top.reduce((a, h) => a + h.holdingPercent!.raw!, 0);
    lines.push('', `Top ${top.length} holdings (${(together * 100).toFixed(2)}% of the fund together):`, ...top.map((h) => `- ${h.symbol ?? '?'}${h.holdingName ? ` ${h.holdingName}` : ''}: ${percent(h.holdingPercent)}`));
  } else lines.push('', 'Top holdings: unavailable (Yahoo Finance does not give them)');
  const sectors = (t.sectorWeightings ?? []).flatMap((w) => Object.entries(w)).filter(([, v]) => has(v) && v!.raw! > 0).sort((a, b) => b[1]!.raw! - a[1]!.raw!);
  if (sectors.length) lines.push('', `By sector: ${sectors.map(([n, v]) => `${FUND_SECTORS[n] ?? n.replace(/_/g, ' ')} ${percent(v)}`).join(', ')}`);
  // Yahoo's averages for a fund's stocks (equityHoldings) are left out: its "price to earnings" comes as about 0.03 for a
  // fund whose stocks trade near 32 times earnings, a figure that would mislead rather than inform.
  return [`Fund profile for ${sym}, from Yahoo Finance as it stands today (${day}). A fund has no company accounts or insider trades of its own: what it holds and what it costs to own are its fundamentals.`, '', ...lines].join('\n');
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

// A refusal by the SEC asks for the email only when none was sent; if one was, the SEC's own words are the diagnosis.
const reason = (e: unknown) => { const m = (e as Error).message; return /sec\.gov refused \(HTTP 403\)/.test(m) && m.includes('[no contact email was sent]') ? `${m}: ${ASK_FOR_EMAIL}` : m; };

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
