// What the company-accounts analyst reads, from official sources first: for a US filer, the SEC's own records - the
// financial statements, the profile and valuation worked out from what was filed and the checked closing price, and the
// insider trades of its Form 4s - each as known on the analysis date, so a past day reads them too. Yahoo Finance is
// asked only for a company that does not file with the SEC, and for today only: it serves such data with no filing date,
// so it is withheld for a past analysis date rather than leak later knowledge into it.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/yahoo/fundamentals.py and date_window.py), Apache License
// 2.0; rewritten in TypeScript.
import { addDays, analysisDate, daysBetween, isHistorical, today } from './dates.js';
import { getCookies, getJson, getText, NoData, Unavailable } from './http.js';
import { cryptoBase, normalizeSymbol } from './symbols.js';
import { history, HOSTS } from './yahoo.js';
import { annualFormIn, averageDilutedShares, cikFor, companyFacts, filingSplits, firstTagPerPeriod, fundTickers, latestBalance, rebase, sectorOfSic, secStatement, sharesOutstanding, SHOWN, splitList, STATEMENTS, submissions, trailingYear, type Fact, type Facts, type Frequency, type Split, type Statement, type Submissions, type Table } from './sec.js';
import { secInsiders } from './insiders.js';
import { latestReport, renderReport } from './nport.js';
import { latestState } from './market.js';
import { ASK_FOR_EMAIL } from '../contact.js';

/** The filer's CIK, or null when the SEC's list of filers was read and does not name it. A list that cannot be read is
 *  the SEC's outage, said as one: never taken for a company that does not file with the SEC, which would send the desk to
 *  Yahoo Finance or to a "withheld" notice and hide the outage. */
async function filer(sym: string): Promise<string | null> {
  try { return await cikFor(sym); } catch (e) {
    throw new Unavailable(`the SEC's list of US filers could not be read (${reason(e)}), so whether ${sym} files with the SEC is not known`);
  }
}

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
    if (!cookie) throw new Unavailable('Yahoo Finance would not let the desk read its company data (it gave no cookie, which it asks for first)');
    const crumb = (await getText(`${HOSTS[1]}/v1/test/getcrumb`, { headers: { Cookie: cookie } })).trim();
    if (!crumb || crumb.length > 64 || /[\s<]/.test(crumb)) throw new Unavailable('Yahoo Finance would not let the desk read its company data (it gave no key for the cookie it had given)');
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
      if (attempt === 0 && e instanceof Unavailable && e.status === 401) { session = null; continue; }
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
/** The same day a year before (28 February for 29 February): the twelve months to `day` begin the day after it. */
const yearBefore = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4) === '-02-29' ? '-02-28' : day.slice(4)}`;

interface SplitJson { chart?: { result?: Array<{ meta?: { gmtoffset?: number }; timestamp?: number[]; events?: { splits?: Record<string, { date?: number; numerator?: number; denominator?: number }> } }> | null } }
const ratio = (n: number) => Number(n.toFixed(4)).toString();

/** The share splits the price source has applied to its prices, from 2009 (the start of the SEC's figures in XBRL) to
 *  today, each dated by its first day on the new basis. Its prices are on the basis after all of them. */
async function priceSplits(sym: string): Promise<Split[]> {
  const qs = `period1=${epoch('2009-01-01')}&period2=${epoch(addDays(today(), 1))}&interval=1mo&events=split`;
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const r = (await getJson<SplitJson>(`${host}/v8/finance/chart/${encodeURIComponent(sym)}?${qs}`)).chart?.result?.[0];
      if (!r?.timestamp?.length) throw new Unavailable(`the price source answered with no record for ${sym}`);
      const offset = r.meta?.gmtoffset ?? 0;
      return Object.values(r.events?.splits ?? {}).flatMap((e): Split[] => {
        const n = Number(e.numerator), d = Number(e.denominator);
        if (!(n > 0 && d > 0 && Number.isFinite(n / d)) || n === d || typeof e.date !== 'number') return [];
        const date = new Date((e.date + offset) * 1000).toISOString().slice(0, 10);
        return [{ date, factor: n / d, words: `the ${ratio(n)}-for-${ratio(d)}${n < d ? ' reverse' : ''} split of ${date}` }];
      }).sort((a, b) => a.date.localeCompare(b.date));
    } catch (e) { if (e instanceof NoData) throw e; last = e; }
  }
  throw last;
}

/** The basis to put a US company's filed per-share figures and share counts on before they meet its price: the splits
 *  the price source applied to its prices, checked against the splits the company's own per-share figures show (a split
 *  the filings show and the price source does not means its record is missing one). When that record cannot be used,
 *  the splits the filings show, with `why`: the figures are then on the basis of the latest filings, which a split since
 *  them would leave behind the prices. */
async function shareBasis(sym: string, perShare: readonly Fact[]): Promise<{ splits: Split[]; why?: string }> {
  const filed = filingSplits(perShare, today());
  try {
    const splits = await priceSplits(sym);
    const missing = filed.find((f) => !splits.some((s) => Math.abs(s.factor / f.factor - 1) <= 0.03 && s.date > f.old! && s.date <= f.date));
    return missing ? { splits: filed, why: `its record does not show ${missing.words}` } : { splits };
  } catch (e) { return { splits: filed, why: (e as Error).message }; }
}

/** A foreign company's yearly report (20-F, or 40-F from Canada), from its list of filings by `day` or else its facts;
 *  null for a US company. Its cover count and per-share figures are of its ordinary shares, and its US listing may be
 *  depositary shares that each stand for several of them. */
function foreignForm(s: Submissions | null, facts: { 'us-gaap'?: Facts; dei?: Facts } | undefined, day: string): string | null {
  const r = s?.filings?.recent, at = (r?.form ?? []).findIndex((f, i) => /^(10-K|20-F|40-F)/.test(f) && (r?.filingDate?.[i] ?? '') <= day);
  const form = at >= 0 ? /^(10-K|20-F|40-F)/.exec(r!.form![at]!)![1]! : annualFormIn(facts, day);
  return form === '20-F' || form === '40-F' ? form : null;
}

const NO_MULTIPLES = (why: string) => `Market value, price to earnings and price to book: unavailable. The price source's record of share splits could not be read (${why}), so the filed figures cannot be put on the share basis of its prices: a split since a figure was filed would put a multiple off by its ratio.`;

/** A US filer's profile and valuation as known on `day`: who it is from its SEC record, and the multiples worked out from
 *  what it had filed by then and the checked closing price on or before then, every filed per-share figure and share count
 *  first put on the share basis of that price. Every multiple is derived and shows what it came from; what no official
 *  free source gives (forward estimates, analysts' targets) is said to be unavailable. */
async function secOverview(sym: string, cik: string, day: string): Promise<string> {
  const [s, facts] = await Promise.all([submissions(cik), companyFacts(cik)]);
  const g = facts.facts?.['us-gaap'] ?? {}, dei = facts.facts?.dei ?? {};
  const lines: string[] = [];
  if (s.name) lines.push(`Name: ${s.name}`);
  if (s.sic) lines.push(`Industry (the SEC's code ${s.sic}): ${s.sicDescription || 'not named'}`, `Sector (worked out from that code, so approximate): ${sectorOfSic(s.sic) ?? 'not known'}`);
  const fy = /^(\d\d)(\d\d)$/.exec(s.fiscalYearEnd ?? '');
  if (fy && Number(fy[1]) >= 1 && Number(fy[1]) <= 12) lines.push(`Fiscal year ends: ${Number(fy[2])} ${MONTHS[Number(fy[1]) - 1]}`);

  // Diluted EPS as filed, under the combined "basic and diluted" tag for a period the diluted one does not give.
  const epsFacts = firstTagPerPeriod(units(g.EarningsPerShareDiluted, 'USD/shares'), units(g.EarningsPerShareBasicAndDiluted, 'USD/shares'));
  const foreign = foreignForm(s, facts.facts, day);
  // A foreign company's figures stay as its filings give them by the day (per ordinary share); a US company's go on the
  // prices' share basis, or, when the price source's record of splits cannot be used, on its latest filings' basis.
  const basis: { splits: Split[]; why?: string } = foreign ? { splits: filingSplits(epsFacts, day) } : await shareBasis(sym, epsFacts);
  const priced = !foreign && basis.why === undefined;

  let close: { date: string; close: number; table: number; currency?: string; open: boolean; label: string } | null = null, paid: Array<{ date: string; amount: number }> = [];
  // The close in cents, so a product like the market value carries no rounding noise: the price it traded at (adjusted
  // for later splits only, as every price the source gives); the price table's row for a past day is also lowered by the
  // dividends paid since. While its session is still trading (or was when it was read) it is the latest price, and every
  // multiple says so.
  try {
    const h = await history(sym, day), bar = h.bars.at(-1)!, state = latestState(h, day), traded = h.traded?.at(-1);
    const row = traded?.date === bar.date ? traded : bar, cents = (n: number) => Math.round(n * 100) / 100;
    close = { date: row.date, close: cents(row.close), table: cents(bar.close), currency: h.meta.currency, open: state.open, label: state.open ? state.label : 'Close' };
    paid = h.dividends ?? [];
  } catch { /* no price: the multiples are unavailable */ }
  const usd = !close?.currency || close.currency === 'USD', px = close?.open ? 'latest price' : 'close', past = isHistorical(day);
  if (close) {
    const where = past
      ? `the price it traded at that day, on the price source's share basis of today: it adjusts every past price for any share split since${priced ? ', and the filed per-share figures and share counts below are put on that same basis' : ''}`
      : `the checked price table's latest row on or before ${day}`;
    const table = close.table !== close.close ? `; the checked price table shows ${fixed(close.table)} for that day, lowered by the dividends paid since` : '';
    lines.push(`${close.label}: ${fixed(close.close)} ${close.currency ?? ''} on ${close.date} (${where}${close.open ? '; not a close, so every multiple below moves with it' : ''}${table})`.replace('  ', ' '));
  } else lines.push('Close: unavailable (the prices could not be read), so no multiple can be worked out');

  // A share count on the basis: the count as filed, and what a split it can name changed.
  const counted = (val: number, filed: string) => {
    if (foreign) return { n: val, words: '' };
    const { k, named, silent } = rebase(basis.splits, filed, day), n = Math.round(val * k);
    return { n, words: !named.length ? '' : silent ? `, before ${splitList(named)}` : ` as ${whole(val)}, before ${splitList(named)}` };
  };
  const cover = sharesOutstanding(units(dei.EntityCommonStockSharesOutstanding, 'shares'), day);
  const dilutedAvg = cover ? null : averageDilutedShares(units(g.WeightedAverageNumberOfDilutedSharesOutstanding, 'shares'), day);
  const bothAvg = cover || dilutedAvg ? null : averageDilutedShares(units(g.WeightedAverageNumberOfShareOutstandingBasicAndDiluted, 'shares'), day);
  const average = dilutedAvg ?? bothAvg, which = average ? 'average diluted shares' : 'shares';
  const shares = cover ? counted(cover.shares, cover.filed).n : average ? counted(average.shares, average.filed).n : null;
  if (cover) { const c = counted(cover.shares, cover.filed); lines.push(`Shares outstanding: ${whole(c.n)}${foreign ? ' ordinary shares' : ''} (counted on ${cover.end}, filed ${cover.filed}${c.words})`); }
  else if (average) { const c = counted(average.shares, average.filed); lines.push(`Shares outstanding: no single count on a cover page filed by then (a company with more than one class of shares gives one per class there, which the SEC's data leaves out). In its place, the weighted average ${bothAvg ? 'shares from its accounts (one figure, filed as both basic and diluted)' : 'diluted shares from its accounts'} for ${average.start} to ${average.end}: ${whole(c.n)} (filed ${average.filed}${c.words}), so the figures worked out from it are close, not exact`); }
  else lines.push('Shares outstanding: unavailable (not on a cover page filed by then)');
  if (foreign) lines.push(`Market value, price to earnings and price to book: not worked out. ${sym} files with the SEC as a foreign company (its yearly report is a form ${foreign}): the count on its cover and any per-share figure in its accounts are of its ordinary shares, and its US listing may be depositary shares (ADS) that each stand for several of them, a ratio its SEC filings do not give in a form the desk can read. A multiple from these figures and the price of one US share could be off by that ratio.`);
  else if (!priced) lines.push(NO_MULTIPLES(basis.why!));
  else if (shares && close && usd) lines.push(`Market value (derived: ${which} × ${px}): ${whole(shares * close.close)} USD`);

  const eps = trailingYear(epsFacts, day, basis.splits);
  if (eps) {
    lines.push(`Diluted EPS, last twelve months${foreign ? ', per ordinary share' : priced ? '' : ', on the basis of its latest filings'} (derived from ${eps.parts}): ${fixed(eps.value)} USD`);
    if (priced && close && usd) lines.push(eps.value > 0 ? `Price to earnings (derived: ${px} ÷ that): ${fixed(close.close / eps.value)}` : 'Price to earnings: not meaningful (the last twelve months lost money)');
  } else lines.push('Diluted EPS, last twelve months: unavailable (no full year of it in US dollars among its filed figures by then)');

  const equity = latestBalance(units(g.StockholdersEquity, 'USD'), day);
  if (equity) {
    lines.push(`Stockholders' equity: ${whole(equity.val)} USD (at ${equity.end}, filed ${equity.filed})`);
    if (!foreign && shares && shares > 0) {
      const bv = equity.val / shares;
      lines.push(`Book value per share (derived: equity ÷ ${which}${priced ? '' : ', on the basis of its latest filings'}): ${fixed(bv)} USD`);
      if (priced && close && usd && bv > 0) lines.push(`Price to book (derived: ${px} ÷ that): ${fixed(close.close / bv)}`);
    }
  }
  // Dividends over the true twelve months to the day, from the price source's record of each one (the filings stop at
  // the last quarter filed, months before); the filed figure only when the prices could not be read.
  const dps = trailingYear(units(g.CommonStockDividendsPerShareDeclared, 'USD/shares'), day, basis.splits) ?? trailingYear(units(g.CommonStockDividendsPerShareCashPaid, 'USD/shares'), day, basis.splits);
  if (close) {
    const after = yearBefore(day), year = paid.filter((d) => d.date > after && d.date <= day), unit = close.currency ?? 'USD';
    const sum = Number(year.reduce((a, d) => a + d.amount, 0).toFixed(6)), span = `${addDays(after, 1)} to ${day}`;
    if (year.length) {
      lines.push(`Dividends per share, the 12 months to ${day} (derived: the ${year.length === 1 ? 'one' : year.length} that went ex-dividend from ${span}, from the price source, ${year.map((d) => `${d.date} ${d.amount}`).join(', ')}): ${fixed(sum, 4)} ${unit}`);
      if (close.close > 0) lines.push(`Dividend yield (derived: that ÷ ${px}): ${fixed((sum / close.close) * 100)}%`);
    // The price source leaves its record of dividends out of an answer with none in it, and out of a broken one alike, so
    // "none" is checked against the filings: dividends filed while the source records none make the record unavailable.
    } else if (dps && dps.value > 0) lines.push(`Dividends per share, the 12 months to ${day}: unavailable. The price source records none that went ex-dividend from ${span}, but the company's filings show ${fixed(dps.value, 4)} USD a share over the last twelve months filed (derived from ${dps.parts}), so the price source's record of dividends may be missing. That filed figure covers the last twelve months filed, not these twelve months, so no yield is worked out from it`);
    else lines.push(`Dividends per share, the 12 months to ${day}: none went ex-dividend from ${span}, as the price source records them${dps ? ' (the filings show none over the last twelve months filed either)' : ' (the filings give no dividend figure to check that record against)'}`);
  } else if (dps) lines.push(`Dividends per share, the last twelve months filed (derived from ${dps.parts}): ${fixed(dps.value, 4)} USD. Dividends since the last filed period are not in the filings, and the prices that record them could not be read`);
  else lines.push('Dividends per share: not among its filed figures (many companies pay none)');
  lines.push('Unavailable from official free sources: forward estimates (forward P/E, PEG), analysts\' price targets and beta.');
  return [`Company profile and valuation for ${sym}, from its SEC filings as they stood on ${day} and the desk's checked ${close?.open ? 'latest price (not a close)' : 'closing price'}, with the dividends its price source records. Every multiple is derived here from those filed figures and that price, and shows what it came from; nothing is an estimate.`, '', ...lines].join('\n');
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
  // A US fund reports what it holds to the SEC (form N-PORT), dated by the day it was filed: official, and right for a
  // past day too. Yahoo, as it stands today, is left for a fund the SEC's lists were read and do not name (one outside the
  // US); a company or trust that files no such report, and an SEC list that cannot be read, are said by latestReport.
  const report = await latestReport(sym, day);
  if (report) return renderReport(sym, day, report, topN);
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

type Row = Table['rows'][number];
// A column's period: its end date, and whether it is one quarter, one year or a year to date.
const periodOf = (column: string, freq: Frequency) => ({ end: column.slice(0, 10), kind: /months to date/.test(column) ? 'to date' : freq === 'quarterly' ? 'quarter' : 'year' });

/** The figures an agent would otherwise work out in its head, worked out here from the table's own figures: margins,
 *  growth (a quarter only against the quarter just before it or the same quarter a year earlier, a year against the year
 *  before; never across a gap or against a loss), free cash flow, capital spending against operating cash, and the
 *  balance-sheet ratios. Each row names its sum. Exported for the tests. */
export function withWorkedRows(t: Table, kind: Statement, freq: Frequency): Table {
  const row = (label: string) => t.rows.find((r) => r.label === label && r.cells.some((c) => c !== null));
  const money = t.rows.find((r) => !r.unit.includes('/'))?.unit ?? 'USD';
  const periods = t.columns.map((c) => periodOf(c, freq));
  const each = (f: (i: number) => number | null) => t.columns.map((_, i) => { const v = f(i); return v === null || !Number.isFinite(v) ? null : v; });
  const ratio = (a: Row | undefined, b: Row | undefined, label: string, worked: 'percent' | 'times', abs = false): Row | null => {
    if (!a || !b) return null;
    const cells = each((i) => { const x = a.cells[i] ?? null, y = b.cells[i] ?? null; return x === null || y === null || y <= 0 ? null : (abs ? Math.abs(x) : x) / y * (worked === 'percent' ? 100 : 1); });
    return cells.some((c) => c !== null) ? { label, unit: '', cells, worked } : null;
  };
  // The column `days` before column i (within ten days), of the same kind of period.
  const before = (i: number, lo: number, hi: number) => periods.findIndex((p, j) => j > i && p.kind === periods[i]!.kind && p.kind !== 'to date' && (() => { const d = daysBetween(p.end, periods[i]!.end); return d >= lo && d <= hi; })());
  const growth = (r: Row | undefined, label: string, lo: number, hi: number): Row | null => {
    if (!r) return null;
    const cells = each((i) => { const j = before(i, lo, hi), x = r.cells[i] ?? null, y = j < 0 ? null : r.cells[j] ?? null; return x === null || y === null || y <= 0 ? null : (x / y - 1) * 100; });
    return cells.some((c) => c !== null) ? { label, unit: '', cells, worked: 'percent' } : null;
  };
  const out: Array<Row | null> = [];
  if (kind === 'income_statement') {
    const revenue = row('Revenue'), op = row('Operating Income'), net = row('Net Income');
    let gross = row('Gross Profit');
    const cost = row('Cost of Revenue');
    if (!gross && revenue && cost) gross = { label: 'Gross Profit', unit: revenue.unit, cells: each((i) => { const r = revenue.cells[i] ?? null, c = cost.cells[i] ?? null; return r === null || c === null ? null : r - c; }) };
    out.push(ratio(gross, revenue, `Gross margin (worked out: gross profit ÷ revenue${row('Gross Profit') ? '' : ', gross profit being revenue less cost of revenue'})`, 'percent'),
      ratio(op, revenue, 'Operating margin (worked out: operating income ÷ revenue)', 'percent'),
      ratio(net, revenue, 'Net margin (worked out: net income ÷ revenue)', 'percent'));
    if (freq === 'quarterly') out.push(growth(revenue, 'Revenue growth on the quarter just before (worked out)', 80, 100));
    const year = freq === 'quarterly' ? 'the same quarter a year before' : 'the year before';
    out.push(growth(revenue, `Revenue growth on ${year} (worked out)`, 355, 375), growth(op, `Operating income growth on ${year} (worked out)`, 355, 375), growth(net, `Net income growth on ${year} (worked out)`, 355, 375));
  } else if (kind === 'cashflow') {
    const ocf = row('Operating Cash Flow'), capex = row('Capital Expenditure');
    if (ocf && capex) {
      const fcf = each((i) => { const o = ocf.cells[i] ?? null, c = capex.cells[i] ?? null; return o === null || c === null ? null : o - Math.abs(c); });
      if (fcf.some((c) => c !== null)) out.push({ label: 'Free cash flow (worked out: operating cash flow less capital expenditure)', unit: money, cells: fcf, worked: 'money' });
      out.push(ratio(capex, ocf, 'Capital expenditure as a share of operating cash flow (worked out)', 'percent', true));
    }
  } else {
    const ca = row('Current Assets'), cl = row('Current Liabilities'), tl = row('Total Liabilities'), eq = row('Stockholders Equity'), cash = row('Cash and Equivalents');
    out.push(ratio(ca, cl, 'Current ratio (worked out: current assets ÷ current liabilities)', 'times'), ratio(tl, eq, 'Liabilities to equity (worked out: total liabilities ÷ equity)', 'times'));
    const less = (a: Row | undefined, b: Row | undefined, label: string): Row | null => {
      if (!a || !b) return null;
      const cells = each((i) => { const x = a.cells[i] ?? null, y = b.cells[i] ?? null; return x === null || y === null ? null : x - y; });
      return cells.some((c) => c !== null) ? { label, unit: money, cells, worked: 'money' } : null;
    };
    out.push(less(tl, cl, 'Non-current liabilities (worked out: total liabilities less current liabilities)'), less(ca, cash, 'Current assets other than cash (worked out: current assets less cash and equivalents)'));
  }
  return { ...t, rows: [...t.rows, ...out.filter((r): r is Row => r !== null)] };
}

/** A statement as a table an agent reads: millions of the main currency, per-share rows as they are, worked-out rows as
 *  percentages or multiples, "–" for no figure, then the table's notes. */
export function renderTable(t: Table, head: string, note: string): string {
  const rows = t.rows.filter((r) => r.cells.some((c) => c !== null)), missing = t.rows.filter((r) => !rows.includes(r) && !r.worked).map((r) => r.label);
  const perShare = (u: string) => u.includes('/');
  const main = rows.find((r) => !perShare(r.unit) && !r.worked)?.unit ?? '';
  const name = (r: Row) => (r.worked === 'percent' || r.worked === 'times' ? r.label : perShare(r.unit) ? `${r.label} (${r.unit.split('/')[0] || 'currency'} per share)` : r.unit !== main ? `${r.label} (millions of ${r.unit || 'an unstated currency'})` : r.label);
  const cell = (v: number | null, r: Row) => (v === null ? '–' : r.worked === 'percent' ? `${v.toFixed(1)}%` : r.worked === 'times' ? v.toFixed(2) : perShare(r.unit) ? v.toFixed(2) : (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const worked = rows.some((r) => r.worked) ? ' Rows marked "worked out" are worked out by the desk from the figures in this table, as named; quote them rather than working your own.' : '';
  const out = [head, `Money in millions of ${main || 'an unstated currency'} unless the row says otherwise; "–" means no figure for that period. ${note}${worked}`, '',
    `Line | ${t.columns.join(' | ')}`, `---|${t.columns.map(() => '---:').join('|')}`, ...rows.map((r) => `${name(r)} | ${r.cells.map((c) => cell(c, r)).join(' | ')}`)];
  if (missing.length) out.push('', `Not reported by this source: ${missing.join(', ')}.`);
  if (t.notes?.length) out.push('', ...t.notes);
  return out.join('\n');
}

// A refusal by the SEC asks for the email only when none was sent; if one was, the SEC's own words are the diagnosis.
const reason = (e: unknown) => { const m = (e as Error).message; return e instanceof Unavailable && e.noEmail && e.status === 403 ? `${m}: ${ASK_FOR_EMAIL}` : m; };

/** The share basis for a US company's per-share figures in its income statement: the prices' (so they meet the price an
 *  agent reads), or none with a note saying why they stay on the basis of its latest filings. A foreign company's stay as
 *  filed (per ordinary share). Never fails: the statement does not depend on it. */
async function statementBasis(sym: string, day: string): Promise<{ splits?: Split[]; note: string }> {
  try {
    const cik = await cikFor(sym);
    if (!cik) return { note: '' };
    const [s, facts] = await Promise.all([submissions(cik).catch(() => null), companyFacts(cik)]);
    if (foreignForm(s, facts.facts, day)) return { note: '' };
    const g = facts.facts?.['us-gaap'] ?? {};
    const b = await shareBasis(sym, firstTagPerPeriod(units(g.EarningsPerShareDiluted, 'USD/shares'), units(g.EarningsPerShareBasicAndDiluted, 'USD/shares')));
    return b.why === undefined ? { splits: b.splits, note: '' } : { note: ` The price source's record of share splits could not be used (${b.why}), so per-share figures are on the basis of the company's latest filings by that day; a split since then would put them off its prices by the split's ratio.` };
  } catch { return { note: '' }; }
}

/** A financial statement: as filed with the SEC by the analysis date for a US filer; else, for today only, Yahoo's. */
export async function financialStatement(raw: string, kind: Statement, freq: Frequency, analysis: string): Promise<string> {
  const day = analysisDate(analysis), sym = companySymbol(raw), title = STATEMENTS[kind].title;
  let secFailure: unknown;
  try {
    const basis = kind === 'income_statement' ? await statementBasis(sym, day) : { note: '' };
    const t = withWorkedRows(await secStatement(sym, kind, freq, day, basis.splits), kind, freq);
    const q = kind !== 'balance_sheet' && freq === 'quarterly' ? ' Every column is one quarter in a row of quarters; a quarter no filing states (a fourth quarter, which only the annual report covers, or one filed only inside a year to date) is derived from two filed figures of the same year, its column marked "(derived)", and the notes below say from which. Per-share figures are never derived.' : '';
    return renderTable(t, `${title} for ${sym} (${freq}), as filed with the SEC on or before ${day}`, `Each figure is the latest filing of it by that day; a restatement counts only from the day it was filed.${q}${basis.note}`);
  } catch (e) { secFailure = e; }
  if (isHistorical(day)) {
    if (!(secFailure instanceof NoData)) throw new Unavailable(`the SEC, the only source of accounts as filed by ${day}, could not answer (${reason(secFailure)})`);
    return `${title} for ${sym} is withheld for ${day}: ${reason(secFailure)}, and the other source, Yahoo Finance, dates a statement by the period it covers, not by when it was filed, so it cannot show which figures were public on ${day}.`;
  }
  try {
    const t = withWorkedRows(await yahooStatement(sym, kind, freq, day), kind, freq);
    return renderTable(t, `${title} for ${sym} (${freq}), from Yahoo Finance as it stands today`, `Not from the SEC (${reason(secFailure)}). Yahoo gives money spent, such as capital expenditure, as a negative figure.`);
  } catch (e) {
    const both = `SEC: ${reason(secFailure)}; Yahoo Finance: ${(e as Error).message}`;
    throw secFailure instanceof NoData && e instanceof NoData ? new NoData(both) : new Unavailable(both);
  }
}
