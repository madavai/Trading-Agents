// A fund's holdings and size as it reports them to the SEC on form N-PORT: every US fund, and every ETF set up as a unit
// investment trust (SPY, DIA), files one each month, and the last month of each quarter is made public about two months
// later. EDGAR dates each report by the day it was filed, so an analysis of a past day reads only what was public by then.
// Free and official; the SEC asks every caller for a contact email (http.ts sends it). It gives no yearly cost.
import { daysBetween } from './dates.js';
import { getText, NoData, Unavailable } from './http.js';
import { blocks, decode } from './insiders.js';
import { cikFor, fundOf, submissions } from './sec.js';

/** One line of a fund's portfolio, as reported: one security (a company's class of shares, one bond). */
export interface Holding {
  name: string; pct: number;
  /** The SEC's codes: asset (EC common stock, DBT debt, STIV cash-like, ...), issuer (CORP, UST, ...), country (ISO). */
  asset: string; issuer: string; country: string;
  /** For a bond: when it is repaid, and its yearly interest in percent. */
  maturity: string | null; coupon: number | null;
}
export interface Report {
  series: string; registrant: string; asOf: string; filed: string;
  netAssets: number; holdings: Holding[];
  /** The fund's own total return for each month of the quarter, oldest first, in percent (its share class's). */
  returns: number[] | null;
}

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The text of the first `<tag>`, or ''. */
const text = (xml: string, tag: string): string => decode(blocks(xml, tag)[0] ?? '').replace(/\s+/g, ' ').trim();
/** An attribute of the first `<tag ...>`, or ''. */
const attr = (xml: string, tag: string, name: string): string => decode(new RegExp(`<${tag}\\s[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? '').trim();
const num = (v: string): number | null => (v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A portfolio report read into what the desk shows. `cls` picks the share class whose returns are given. */
export function parseReport(xml: string, cls: string | null): Omit<Report, 'filed'> {
  const gen = blocks(xml, 'genInfo')[0], info = blocks(xml, 'fundInfo')[0];
  const asOf = gen ? text(gen, 'repPdDate') : '', netAssets = info ? num(text(info, 'netAssets')) : null;
  if (!gen || !DAY.test(asOf) || netAssets === null) throw new Unavailable('the SEC answered with something that is not a fund\'s portfolio report');
  const holdings = blocks(xml, 'invstOrSec').map((h): Holding => ({
    name: text(h, 'name') || text(h, 'title') || 'unnamed',
    pct: num(text(h, 'pctVal')) ?? 0,
    asset: text(h, 'assetCat') || attr(h, 'assetConditional', 'assetCat') || 'OTHER',
    issuer: text(h, 'issuerCat') || attr(h, 'issuerConditional', 'issuerCat') || 'OTHER',
    country: text(h, 'invCountry'),
    maturity: DAY.test(text(h, 'maturityDt')) ? text(h, 'maturityDt') : null,
    coupon: num(text(h, 'annualizedRt')),
  }));
  const rows = [...xml.matchAll(/<monthlyTotReturn\s([^>]*)\/?>/g)].map((m) => m[1]!);
  const row = rows.find((r) => cls && r.includes(`classId="${cls}"`)) ?? (rows.length === 1 ? rows[0] : undefined);
  const returns = row ? ['rtn1', 'rtn2', 'rtn3'].map((k) => num(new RegExp(`\\b${k}="([^"]*)"`).exec(row)?.[1] ?? '')) : null;
  return {
    series: text(gen, 'seriesName').replace(/\((?:R|TM)\)/g, '').replace(/\s+/g, ' ').trim() || text(gen, 'regName'),
    registrant: text(gen, 'regName'), asOf, netAssets, holdings,
    returns: returns && returns.every((r) => r !== null) ? returns as number[] : null,
  };
}

/** A fund's portfolio reports (originals; an amendment's period cannot be told from the list), newest first. */
async function filings(cik: string, series: string | null): Promise<Array<{ accession: string; filed: string }>> {
  let list: Array<{ form: string; accession: string; filed: string }>;
  if (series) {
    // A trust files for many funds under one number: the SEC lists each fund's (its series') reports apart.
    const atom = await getText(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${series}&type=NPORT-P&dateb=&owner=include&count=40&output=atom`, { timeoutMs: 30_000 });
    list = blocks(atom, 'entry').map((e) => ({ form: text(e, 'filing-type'), accession: text(e, 'accession-number'), filed: text(e, 'filing-date') }));
  } else {
    const r = (await submissions(cik)).filings?.recent ?? {};
    list = (r.form ?? []).map((form, i) => ({ form, accession: r.accessionNumber?.[i] ?? '', filed: r.filingDate?.[i] ?? '' }));
  }
  return list.filter((f) => f.form === 'NPORT-P' && ACCESSION.test(f.accession) && DAY.test(f.filed)).sort((a, b) => b.filed.localeCompare(a.filed));
}

/** The latest portfolio report a fund had made public by `day`; null when the ticker is not a fund that files them (a
 *  company, a trust holding gold or bitcoin, a fund outside the US). */
export async function latestReport(sym: string, day: string): Promise<Report | null> {
  const fund = await fundOf(sym), cik = fund?.cik ?? (await cikFor(sym));
  if (!cik) return null;
  const all = await filings(cik, fund?.series ?? null);
  if (!all.length) return null;
  const pick = all.find((f) => f.filed <= day);
  if (!pick) throw new NoData(`${sym}'s first portfolio report to the SEC (form N-PORT) was filed on ${all.at(-1)!.filed}, after ${day}`);
  const xml = await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${pick.accession.replace(/-/g, '')}/primary_doc.xml`, { timeoutMs: 60_000 });
  return { ...parseReport(xml, fund?.cls ?? null), filed: pick.filed };
}

// ---------- in words ----------
const ASSETS: Record<string, string> = {
  EC: 'stocks', EP: 'preferred stocks', DBT: 'bonds and other debt', 'ABS-MBS': 'mortgage-backed bonds', 'ABS-ASBS': 'asset-backed bonds',
  'ABS-CBDO': 'collateralised debt', 'ABS-O': 'other asset-backed bonds', STIV: 'cash and money-market funds', RE: 'real estate',
  LON: 'loans', COMM: 'commodities', SN: 'structured notes', DCO: 'derivatives', DCR: 'derivatives', DE: 'derivatives',
  DFE: 'derivatives', DIR: 'derivatives', DO: 'derivatives', OTHER: 'other',
};
const ISSUERS: Record<string, string> = {
  CORP: 'companies', UST: 'the US Treasury', USGA: 'US government agencies', USGSE: 'US government-sponsored enterprises (such as Fannie Mae)',
  MUN: 'US states and cities', NUSS: 'governments outside the US', RF: 'other funds', PF: 'private funds', OTHER: 'other',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let regions: Intl.DisplayNames | null = null;
const country = (code: string): string => {
  if (!/^[A-Z]{2}$/.test(code)) return 'not given';   // the SEC's "N/A", or nothing
  try { regions ??= new Intl.DisplayNames(['en'], { type: 'region' }); return regions.of(code) ?? code; } catch { return code; }
};
const pct = (n: number) => `${n.toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

/** Shares of the fund added up by a key, largest first, leaving out what rounds to nothing. */
function shares(list: Holding[], key: (h: Holding) => string): Array<[string, number, number]> {
  const m = new Map<string, [number, number]>();
  for (const h of list) { const k = key(h), was = m.get(k) ?? [0, 0]; m.set(k, [was[0] + h.pct, was[1] + 1]); }
  return [...m].map(([k, [p, n]]): [string, number, number] => [k, p, n]).filter(([, p]) => Math.abs(p) >= 0.005).sort((a, b) => b[1] - a[1]);
}

/** The report in plain words: size, what it holds, how concentrated, where, its own returns, and what it does not say. */
export function renderReport(sym: string, day: string, r: Report, topN = 10): string {
  const lines: string[] = [
    `Fund profile for ${sym}, from its portfolio report to the SEC (form N-PORT, filed ${r.filed}): what it held on ${r.asOf}, ${daysBetween(r.asOf, day)} days before ${day}. Funds make each quarter's last month public about two months later, so this is the latest anyone could read by ${day}. A fund has no company accounts or insider trades of its own: what it holds and what it costs are its fundamentals.`,
    '',
    `Name: ${r.series}`,
    ...(r.registrant && r.registrant.toLowerCase() !== r.series.toLowerCase() ? [`Filed by: ${r.registrant}`] : []),
    `Net assets (its size): ${Math.round(r.netAssets).toLocaleString('en-US')} USD on ${r.asOf}`,
    `Holdings: ${r.holdings.length.toLocaleString('en-US')} lines`,
    `Held in: ${shares(r.holdings, (h) => ASSETS[h.asset] ?? h.asset).map(([k, p]) => `${k} ${pct(p)}`).join(', ') || 'not given'}`,
    `Issued by: ${shares(r.holdings, (h) => ISSUERS[h.issuer] ?? h.issuer).map(([k, p]) => `${k} ${pct(p)}`).join(', ') || 'not given'}`,
  ];
  const where = shares(r.holdings, (h) => country(h.country));
  if (where.length) {
    const us = where.find(([k]) => k === 'United States')?.[1] ?? 0, total = where.reduce((a, [, p]) => a + p, 0);
    lines.push(`Countries: ${where.slice(0, 5).map(([k, p]) => `${k} ${pct(p)}`).join(', ')}${where.length > 5 ? `, and ${where.length - 5} more` : ''} (outside the US together: ${pct(total - us)})`);
  }
  const bonds = r.holdings.filter((h) => h.maturity && h.pct > 0);
  const weight = bonds.reduce((a, h) => a + h.pct, 0);
  if (weight >= 1) {
    const years = bonds.reduce((a, h) => a + h.pct * Math.max(0, daysBetween(r.asOf, h.maturity!)) / 365.25, 0) / weight;
    const paying = bonds.filter((h) => h.coupon !== null), w2 = paying.reduce((a, h) => a + h.pct, 0);
    const coupon = w2 ? paying.reduce((a, h) => a + h.pct * h.coupon!, 0) / w2 : null;
    lines.push(`Bonds (${pct(weight)} of the fund): on average ${years.toFixed(1)} years to repayment${coupon !== null ? ` and ${coupon.toFixed(2)}% yearly interest` : ''}, weighted by value (worked out here from each bond's maturity and rate)`);
  }
  if (r.returns) {
    const end = new Date(`${r.asOf}T12:00:00Z`), month = (back: number) => { const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back, 15)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
    lines.push(`Its own total return by month, as it reported it: ${r.returns.map((v, i) => `${month(2 - i)} ${signed(v)}`).join(', ')}`);
  } else lines.push('Its own monthly returns: not in this report');
  lines.push('Yearly cost (expense ratio): unavailable (no official free source gives it in a form the desk can read; the fund\'s prospectus states it)');
  const top = shares(r.holdings, (h) => h.name).slice(0, topN);
  if (top.length) {
    const together = top.reduce((a, [, p]) => a + p, 0);
    lines.push('', `Top ${top.length} holdings, by issuer (${pct(together)} of the fund together; an issuer's several lines, such as two classes of shares or many bonds, added up):`,
      ...top.map(([k, p, n]) => `- ${k}${n > 1 ? ` (${n.toLocaleString('en-US')} lines)` : ''}: ${pct(p)}`));
  }
  return lines.join('\n');
}
