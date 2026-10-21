// Insider trades as the SEC holds them: every Form 4 a company's directors, officers and largest owners filed, read from
// the filing itself. EDGAR dates each filing by the day it was made public, so an analysis of a past day reads only the
// trades known by then. Free and official; the SEC asks every caller for a contact email (http.ts sends it).
import { addDays } from './dates.js';
import { getText, NoData } from './http.js';
import { submissions } from './sec.js';

/** One line of a Form 4's table of shares: a trade (or an award, a gift, an option exercise) by one insider. */
export interface InsiderTrade {
  owner: string; role: string; filed: string; date: string;
  /** The SEC's transaction code: P purchase, S sale, A award, M option exercise, F tax withholding, G gift, ... */
  code: string;
  shares: number; price: number | null; acquired: boolean;
  /** Shares held after it, and how (null: directly). */
  after: number | null; indirect: string | null;
  /** Made under a pre-arranged trading plan (Rule 10b5-1). */
  plan: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
/** Every `<tag>...</tag>` inside a piece of XML (a Form 4 never nests a tag in itself). */
const blocks = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
/** The text of a tag, or of the `<value>` inside it, as the SEC writes both. */
const field = (xml: string, tag: string): string => {
  const b = blocks(xml, tag)[0];
  if (b === undefined) return '';
  const v = blocks(b, 'value')[0];
  return decode((v ?? b).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
};
const num = (s: string): number | null => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
const yes = (s: string): boolean => s === '1' || s.toLowerCase() === 'true';

/** The trades in one Form 4's XML. Exported for the tests. */
export function parseForm4(xml: string, filed: string): InsiderTrade[] {
  const owners = blocks(xml, 'reportingOwner');
  const owner = owners.map((o) => field(o, 'rptOwnerName')).filter(Boolean).join(' and ') || 'unnamed';
  const r = owners[0] ?? '';
  const role = [yes(field(r, 'isDirector')) && 'Director', yes(field(r, 'isOfficer')) && (field(r, 'officerTitle') || 'Officer'),
    yes(field(r, 'isTenPercentOwner')) && 'owner of over 10%', yes(field(r, 'isOther')) && (field(r, 'otherText') || 'other')].filter(Boolean).join(', ') || 'insider';
  const plan = yes(field(xml, 'aff10b5One'));
  return blocks(xml, 'nonDerivativeTransaction').map((t) => ({
    owner, role, filed, plan,
    date: field(t, 'transactionDate').slice(0, 10),
    code: field(t, 'transactionCode').toUpperCase(),
    shares: num(field(t, 'transactionShares')) ?? 0,
    price: num(field(t, 'transactionPricePerShare')),
    acquired: field(t, 'transactionAcquiredDisposedCode').toUpperCase() === 'A',
    after: num(field(t, 'sharesOwnedFollowingTransaction')),
    indirect: field(t, 'directOrIndirectOwnership').toUpperCase() === 'I' ? field(t, 'natureOfOwnership') || 'indirectly' : null,
  })).filter((t) => t.date && t.code);
}

const CODES: Record<string, string> = {
  P: 'bought', S: 'sold', A: 'was awarded', M: 'exercised options for', X: 'exercised options for',
  F: 'handed back, for tax or the exercise price,', G: 'gave away', D: 'returned to the company', C: 'converted into', J: 'other transaction of', W: 'inherited or bequeathed', I: 'discretionary trade of',
};
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });

/** A company's insider trades from the Form 4s made public in the `days` up to `asOf`, newest first, reading at most
 *  `limit` filings. `cik` is the filer's ten-digit number. */
export async function secInsiders(symbol: string, cik: string, asOf: string, days = 90, limit = 25): Promise<string> {
  const s = await submissions(cik), r = s.filings?.recent ?? {};
  const forms = r.form ?? [], from = addDays(asOf, -days);
  const oldest = (r.filingDate ?? []).at(-1);
  const picked = forms.map((f, i) => ({ form: f, i, filed: r.filingDate?.[i] ?? '' }))
    .filter((x) => (x.form === '4' || x.form === '4/A') && x.filed <= asOf && x.filed > from)
    .sort((a, b) => b.filed.localeCompare(a.filed));
  const head = `Insider trades in ${symbol}, from the Form 4 filings with the SEC made public from ${addDays(from, 1)} to ${asOf}`;
  // The SEC's recent list holds a filer's latest thousand filings: for a busy filer and an old date it may not reach back
  // over the whole window, and then "none" cannot be said.
  const partial = oldest !== undefined && oldest > addDays(from, 1) && (r.filingDate?.length ?? 0) >= 1000;
  const gap = partial ? ` The SEC's recent list of filings starts on ${oldest}, so filings before that day are not read.` : '';
  if (!picked.length) {
    if (partial) throw new NoData(`the SEC's recent list of ${symbol}'s filings starts on ${oldest}, after ${addDays(from, 1)}, so the trades of those days cannot be read`);
    return `${head}: none. No director, officer or large owner reported a trade in these ${days} days. That is a fact from the SEC, not a gap in the data.`;
  }
  const read = picked.slice(0, limit), trades: InsiderTrade[] = [];
  let failed = 0;
  for (const p of read) {
    const acc = r.accessionNumber?.[p.i] ?? '', doc = (r.primaryDocument?.[p.i] ?? '').replace(/^xsl[^/]*\//, '');
    if (!/^[\d-]+$/.test(acc) || !/^[\w.-]+\.xml$/i.test(doc)) { failed++; continue; }
    try { trades.push(...parseForm4(await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replaceAll('-', '')}/${doc}`), p.filed)); } catch { failed++; }
  }
  const market = (code: string) => trades.filter((t) => t.code === code);
  const total = (list: InsiderTrade[]) => {
    const shares = list.reduce((a, t) => a + t.shares, 0), value = list.reduce((a, t) => a + t.shares * (t.price ?? 0), 0), planned = list.filter((t) => t.plan).length;
    return list.length ? `${list.length} (${fmt(shares)} shares, about ${fmt(value)} USD at their own prices${planned ? `; ${planned} under a pre-arranged 10b5-1 plan` : ''})` : 'none';
  };
  const buys = market('P'), sales = market('S'), other = trades.length - buys.length - sales.length;
  const lines = trades.map((t) => `- ${t.date} (made public ${t.filed}) · ${t.owner} (${t.role}): ${CODES[t.code] ?? `transaction ${t.code} of`} ${fmt(t.shares, 4)} shares${t.price ? ` at ${fmt(t.price, 4)}` : ', no price'}${t.after !== null ? ` · holds ${fmt(t.after, 4)} after` : ''}${t.indirect ? ` · indirectly (${t.indirect})` : ''}${t.plan ? ' · under a 10b5-1 plan' : ''}`);
  return [
    `${head} (${read.length} of ${picked.length} filings read, newest first${failed ? `; ${failed} could not be read` : ''}). Each trade is dated by the day it happened and the day its filing made it public; only filings public by ${asOf} are shown.${gap}`,
    '',
    `In these ${days} days: bought (code P) ${total(buys)}; sold (code S) ${total(sales)}; other kinds (awards, option exercises, shares handed back for tax, gifts) ${other}.`,
    'P and S are purchases and sales on the market or in a private deal: a purchase is the insider spending their own money. A sale under a 10b5-1 plan was arranged months ahead. Awards, exercises, tax handbacks and gifts say little about what an insider thinks of the price.',
    '', ...(lines.length ? lines : ['(these filings list no trades in shares, only options or holdings)']),
  ].join('\n');
}
