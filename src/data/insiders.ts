// Insider trades as the SEC holds them: every Form 4 a company's directors, officers and largest owners filed, read from
// the filing itself. EDGAR dates each filing by the day it was made public, so an analysis of a past day reads only the
// trades known by then. An amended filing (Form 4/A) takes the place of the filing it corrects, never adds to it.
// Free and official; the SEC asks every caller for a contact email (http.ts sends it).
import { addDays } from './dates.js';
import { getText, NoData, Unavailable } from './http.js';
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
  /** The day an amended filing (Form 4/A) gave this trade as it now stands; `filed` is then the day the trade was first
   *  made public, the day of the filing that amendment corrects. */
  corrected?: string;
}

/** One Form 4 or 4/A as read: whose it is (their SEC numbers, which tie an amendment to the filing it corrects), the day
 *  of the filing an amendment corrects (null for a Form 4), the period it reports, and its trades. */
export interface Filing { form: string; filed: string; owners: string; original: string | null; period: string; trades: InsiderTrade[] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
/** Every `<tag>...</tag>` inside a piece of XML (a Form 4 or an N-PORT never nests a tag in itself). */
export const blocks = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
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

/** A Form 4 or 4/A with what ties an amendment to the filing it corrects. Exported for the tests. */
export function parseFiling(xml: string, form: string, filed: string): Filing {
  const owners = blocks(xml, 'reportingOwner').map((o) => field(o, 'rptOwnerCik').replace(/^0+/, '') || field(o, 'rptOwnerName').toUpperCase()).sort().join('+');
  const original = form.endsWith('/A') ? field(xml, 'dateOfOriginalSubmission').slice(0, 10) || null : null;
  return { form, filed, owners, original, period: field(xml, 'periodOfReport').slice(0, 10), trades: parseForm4(xml, filed) };
}

/** The trades of these filings, each amendment in place of the filing it corrects: the same insiders' filing made public
 *  on the day the amendment names (of two that day, the one for the same period). An amendment that lists trades in
 *  shares replaces that filing's trades; one that lists none corrected something else (the options table, a footnote,
 *  the signature) and leaves them. Taken oldest first, so a second amendment replaces the first. A corrected trade keeps
 *  the day it was first made public and carries the day of its correction. Exported for the tests. */
export function amended(filings: readonly Filing[]): { trades: InsiderTrade[]; replaced: number } {
  const state = new Map(filings.map((f) => [f, { first: f.filed, by: null as Filing | null }]));
  let replaced = 0;
  for (const f of [...filings].sort((a, b) => a.filed.localeCompare(b.filed))) {
    if (!f.original) continue;
    const me = state.get(f)!;
    me.first = f.original;
    const same = filings.filter((g) => g !== f && g.owners === f.owners && g.filed === f.original && g.filed <= f.filed);
    const pool = same.some((g) => g.period === f.period) ? same.filter((g) => g.period === f.period) : same;
    if (pool.length !== 1) continue;   // not read (older than the list, or beyond what was read), or no single match
    let target = pool[0]!;
    while (state.get(target)!.by) target = state.get(target)!.by!;
    me.first = state.get(target)!.first;
    if (!f.trades.length) continue;
    state.get(target)!.by = f;
    replaced++;
  }
  const trades = filings.filter((f) => !state.get(f)!.by)
    .flatMap((f) => f.trades.map((t) => (f.original ? { ...t, filed: state.get(f)!.first, corrected: f.filed } : t)));
  return { trades: trades.sort((a, b) => b.filed.localeCompare(a.filed)), replaced };
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
  // A filing that cannot be read is never taken for one with no trades: the counts say which filings they come from.
  const read = picked.slice(0, limit), filings: Filing[] = [];
  let failed = 0, why = '';
  for (const p of read) {
    const acc = r.accessionNumber?.[p.i] ?? '', doc = (r.primaryDocument?.[p.i] ?? '').replace(/^xsl[^/]*\//, '');
    try {
      if (!/^[\d-]+$/.test(acc) || !/^[\w.-]+\.xml$/i.test(doc)) throw new NoData('its address in the SEC\'s list is not one the desk can read');
      const xml = await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replaceAll('-', '')}/${doc}`);
      // A web page in place of the filing (a refusal, a notice) has no table of trades: it is not read as a filing with none.
      if (!/<ownershipDocument[\s>]/.test(xml)) throw new Unavailable('www.sec.gov answered with something that is not a Form 4');
      filings.push(parseFiling(xml, p.form, p.filed));
    } catch (e) { failed++; why ||= (e as Error).message; }
  }
  const span = `made public from ${addDays(from, 1)} to ${asOf}`;
  if (!filings.length) throw new Unavailable(`the SEC lists ${read.length === 1 ? 'one Form 4 filing' : `${read.length} Form 4 filings`} of ${symbol}'s insiders ${span}, but none of them could be read (${why}), so their trades are not known`);
  // Every trade is listed; the counts hold only those first made public in these days (a correction made now of a trade
  // made public before them is listed, not counted).
  const { trades: all, replaced } = amended(filings), trades = all.filter((t) => t.filed > from);
  const market = (code: string) => trades.filter((t) => t.code === code);
  // A trade whose filing gives no price (one given only in a footnote) is left out of the sum in dollars, and counted.
  const total = (list: InsiderTrade[]) => {
    if (!list.length) return 'none';
    const shares = list.reduce((a, t) => a + t.shares, 0), priced = list.filter((t) => t.price !== null), planned = list.filter((t) => t.plan).length;
    const value = priced.reduce((a, t) => a + t.shares * t.price!, 0), bare = list.length - priced.length;
    const usd = !priced.length ? `${list.length === 1 ? 'its filing gives' : 'their filings give'} no price, so no sum in USD`
      : `about ${fmt(value)} USD at their own prices${bare ? `; ${bare === 1 ? 'one gives' : `${bare} give`} no price and ${bare === 1 ? 'is' : 'are'} not in that sum` : ''}`;
    return `${list.length} (${fmt(shares)} shares, ${usd}${planned ? `; ${planned} under a pre-arranged 10b5-1 plan` : ''})`;
  };
  const buys = market('P'), sales = market('S'), other = trades.length - buys.length - sales.length;
  const when = (t: InsiderTrade) => (!t.corrected ? `made public ${t.filed}`
    : `made public ${t.filed}${t.filed > from ? '' : ', before these days'}; corrected ${t.corrected} by an amended filing, a Form 4/A${t.filed > from ? '' : ', so not counted above'}`);
  const lines = all.map((t) => `- ${t.date} (${when(t)}) · ${t.owner} (${t.role}): ${CODES[t.code] ?? `transaction ${t.code} of`} ${fmt(t.shares, 4)} shares${t.price ? ` at ${fmt(t.price, 4)}` : ', no price'}${t.after !== null ? ` · holds ${fmt(t.after, 4)} after` : ''}${t.indirect ? ` · indirectly (${t.indirect})` : ''}${t.plan ? ' · under a 10b5-1 plan' : ''}`);
  // What the counts leave out: filings that could not be read, older ones beyond the newest `limit`, days before the list.
  const skipped = picked.length - read.length;
  const missing = [
    failed ? `${failed} of the filings could not be read (${why})` : '',
    skipped ? `only the newest ${read.length} were asked for, made public from ${read.at(-1)!.filed}, so ${skipped === 1 ? 'the one older filing is' : `the ${skipped} older ones are`} not in them` : '',
    partial ? `the SEC's recent list starts on ${oldest}` : '',
  ].filter(Boolean);
  const scope = missing.length
    ? `Counted from only the ${filings.length} of the ${picked.length} filings ${span} that were read (${missing.join('; ')}). These counts are not the whole ${days} days: a "none" below is not a fact about the insiders`
    : `In these ${days} days`;
  return [
    `${head} (${filings.length} of ${picked.length} filings read, newest first${failed ? `; ${failed} could not be read` : ''}${skipped ? `; the ${skipped} oldest not asked for` : ''}${replaced ? `; ${replaced === 1 ? 'one is an amended filing, a Form 4/A, shown in place of the filing it corrects' : `${replaced} are amended filings, Form 4/A, each shown in place of the filing it corrects`}` : ''}). Each trade is dated by the day it happened and the day its filing made it public; only filings public by ${asOf} are shown.${gap}`,
    '',
    `${scope}: bought (code P) ${total(buys)}; sold (code S) ${total(sales)}; other kinds (awards, option exercises, shares handed back for tax, gifts) ${other}.`,
    'P and S are purchases and sales on the market or in a private deal: a purchase is the insider spending their own money. A sale under a 10b5-1 plan was arranged months ahead. Awards, exercises, tax handbacks and gifts say little about what an insider thinks of the price.',
    '', ...(lines.length ? lines : [missing.length
      ? `(the ${filings.length === 1 ? 'one filing' : `${filings.length} filings`} read ${filings.length === 1 ? 'lists' : 'list'} no trades in shares, only options or holdings; the others were not read, so nothing is known of their trades)`
      : '(these filings list no trades in shares, only options or holdings)']),
  ].join('\n');
}
