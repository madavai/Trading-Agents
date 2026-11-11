// Company accounts as they were filed, from SEC EDGAR's public XBRL facts (no key; the SEC asks every caller for a
// contact email). EDGAR dates every figure by the day it was filed, so an analysis of a past day reads exactly what was
// on file then, with a restatement counted only from the day it was filed. US filers only.
// Adapted from TradingAgents (tradingagents/dataflows/vendors/sec_edgar.py), Apache License 2.0; rewritten in TypeScript.
import { daysBetween } from './dates.js';
import { getJsonAt, keepFor, NoData } from './http.js';

export type Statement = 'balance_sheet' | 'income_statement' | 'cashflow';
export type Frequency = 'quarterly' | 'annual';

/** The line items of each statement, each with the tags filers use for it, best first. A period takes the first tag that
 *  reports it; values are never added across tags, which would count a figure twice. */
export const STATEMENTS: Record<Statement, { title: string; lines: Array<[string, string[]]> }> = {
  balance_sheet: { title: 'Balance sheet', lines: [
    ['Total Assets', ['Assets']],
    ['Current Assets', ['AssetsCurrent']],
    ['Cash and Equivalents', ['CashAndCashEquivalentsAtCarryingValue']],
    ['Total Liabilities', ['Liabilities']],
    ['Current Liabilities', ['LiabilitiesCurrent']],
    ['Stockholders Equity', ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']],
  ] },
  income_statement: { title: 'Income statement', lines: [
    ['Revenue', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']],
    ['Cost of Revenue', ['CostOfRevenue', 'CostOfGoodsAndServicesSold']],
    ['Gross Profit', ['GrossProfit']],
    ['Operating Income', ['OperatingIncomeLoss']],
    ['Net Income', ['NetIncomeLoss']],
    // A company with nothing that dilutes its shares files one figure for both, under its own tag.
    ['Diluted EPS', ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']],
  ] },
  cashflow: { title: 'Cash flow statement', lines: [
    ['Operating Cash Flow', ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations']],
    ['Investing Cash Flow', ['NetCashProvidedByUsedInInvestingActivities']],
    ['Financing Cash Flow', ['NetCashProvidedByUsedInFinancingActivities']],
    ['Capital Expenditure', ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']],
  ] },
};

/** A statement as a table: columns are periods, newest first; a row's unit is USD, another currency, or per share. A row
 *  the desk worked out from the others has `worked` (a percentage, a multiple, or money in the table's unit); `notes`
 *  says how any derived figure was worked out. */
export interface Table {
  columns: string[];
  rows: Array<{ label: string; unit: string; cells: Array<number | null>; worked?: 'percent' | 'times' | 'money' }>;
  notes?: string[];
}

export interface Fact { start?: string; end: string; val: number; filed: string; form?: string; accn?: string }
export type Facts = Record<string, { units?: Record<string, Fact[]> }>;

// A quarter covers about 90 days and a year about 365. One filing reports the quarter and the year to date under the same
// end date, so the span is checked: a match on the end date alone could report half a year as a quarter.
const QUARTER: [number, number] = [60, 115], YEAR: [number, number] = [300, 400];
// A 10-Q's cash flows are often filed only for the year to date, and no filing states a fourth quarter: the annual report
// gives the year. Shown side by side, such columns read as quarters in a row with a gap no one sees, and agents drew
// "five quarters of growth" across a missing one. So a quarterly table works such a quarter out from two filed figures
// of the same year (the year to date less the year to the quarter before), marks its column as derived and says which
// figures it came from. A per-share figure is never derived: it does not add up across quarters. A year to date that
// gives no quarter this way is shown as filed, named in its column.
const YEAR_TO_DATE: Array<[number, number, number]> = [[150, 200, 6], [240, 290, 9]];
// A year is what an annual report covers: a 10-Q's balance has no span to reject, and some 10-Qs report twelve-month
// totals that pass the span check.
const ANNUAL_FORMS = ['10-K', '20-F', '40-F'];
export const SHOWN: Record<Frequency, number> = { quarterly: 8, annual: 5 };

/** Which span a fact covers (0 for a balance, which has none), or null when it covers none of them. */
function spanIndex(f: Fact, spans: Array<[number, number]>): number | null {
  if (!f.start) return 0;
  const days = daysBetween(f.start, f.end);
  const i = spans.findIndex(([lo, hi]) => days >= lo && days <= hi);
  return i < 0 ? null : i;
}

/** The figures of one line as known on `asOf`: each period's latest filing on or before that day. */
function lineAsOf(facts: Facts, tags: string[], asOf: string, spans: Array<[number, number]>, forms: string[]): { values: Map<string, Fact>; unit: string } {
  const values = new Map<string, Fact>();
  let unit = 'USD';
  for (const tag of tags) {
    for (const [u, list] of Object.entries(facts[tag]?.units ?? {})) {
      const latest = new Map<string, Fact>(), covered = new Set<string>();
      for (const f of list) {
        const i = spanIndex(f, spans), key = `${f.end}|${i}`;
        if (i === null || f.filed > asOf || values.has(key)) continue;
        if (!forms.length || forms.some((p) => (f.form ?? '').startsWith(p))) covered.add(key);
        const seen = latest.get(key);
        if (!seen || f.filed >= seen.filed) latest.set(key, f);
      }
      let any = false;
      for (const [key, f] of latest) if (covered.has(key)) { values.set(key, f); any = true; }
      if (any) unit = u;
    }
  }
  return { values, unit };
}

const perShareUnit = (u: string) => u.includes('/');
const spanWords = (f: Fact) => { const d = f.start ? daysBetween(f.start, f.end) : 0; return d <= QUARTER[1] ? 'the quarter' : d <= 200 ? 'the six months' : d <= 290 ? 'the nine months' : 'the year'; };

/** A figure of a line filed again at another value (beyond rounding): a restatement, or a recast of earlier periods on a
 *  new basis, as when a business is sold or spun off. `filed` is the day of the filing that changed it, `prev` the day of
 *  the filing of it just before: the basis changed between the two. */
interface Recast { filed: string; prev: string; start?: string; end: string; first: number; now: number }

/** A change of basis of a line: it came after `from` and on or before `by`; `r` is its first refiling, which names it. */
interface Change { from: string; by: string; r: Recast }

/** How a line's figures were filed again by `asOf`: every restatement (`recasts`, oldest first), and every figure filed
 *  again at the same value (`kept`: the two filing days, between which its basis did not change). Exported for the tests. */
export function refilingsOf(facts: Facts, tags: string[], asOf: string): { recasts: Recast[]; kept: Array<[string, string]> } {
  const recasts: Recast[] = [], kept: Array<[string, string]> = [];
  for (const tag of tags) for (const list of Object.values(facts[tag]?.units ?? {})) {
    const periods = new Map<string, Fact[]>();
    for (const f of list) if (f.filed <= asOf && f.start) (periods.get(`${f.start}|${f.end}`) ?? periods.set(`${f.start}|${f.end}`, []).get(`${f.start}|${f.end}`)!).push(f);
    for (const fs of periods.values()) {
      const byDay = [...fs].sort((a, b) => a.filed.localeCompare(b.filed));
      for (let n = 1; n < byDay.length; n++) {
        const a = byDay[n - 1]!, b = byDay[n]!;
        if (a.filed === b.filed) continue;
        if (Math.abs(b.val - a.val) > 0.001 * Math.max(Math.abs(a.val), Math.abs(b.val))) recasts.push({ filed: b.filed, prev: a.filed, start: b.start, end: b.end, first: byDay[0]!.val, now: b.val });
        else kept.push([a.filed, b.filed]);
      }
    }
  }
  return { recasts: recasts.sort((a, b) => a.filed.localeCompare(b.filed)), kept };
}

/** The changes of basis a line's refilings show, as few as explain them all. A company that spins off a business refiles
 *  each earlier period on the new basis as it next reports it, over a year or more, and each refiling says only that the
 *  change came after that period's last filing and by this one. Taken by the day of the refiling, each joins the change
 *  before it when it could be the same one, narrowing when it came; a period filed again unchanged across part of that
 *  time narrows it further (the change came before or after that, not during it). Exported for the tests. */
export function changesOf({ recasts, kept }: { recasts: readonly Recast[]; kept: ReadonlyArray<readonly [string, string]> }): Change[] {
  const out: Change[] = [];
  for (const r of recasts) {
    const last = out.at(-1);
    if (last && r.prev < last.by) last.from = r.prev > last.from ? r.prev : last.from;
    else out.push({ from: r.prev, by: r.filed, r });
  }
  for (const c of out) {
    for (let moved = true; moved; ) {
      moved = false;
      for (const [a, b] of kept) {
        if (a <= c.from && b > c.from && b < c.by) { c.from = b; moved = true; }
        else if (a > c.from && a < c.by && b >= c.by) { c.by = a; moved = true; }
      }
    }
  }
  return out;
}

type Quarter = { val: number; start: string; how?: string; lo: string; hi: string };
type Blocked = { c: Fact; other: string; ch: Change; lo: string; hi: string };
/** A line's quarters: each filed quarter, and each quarter a filed year to date (or year) gives when the same year's
 *  figure to the quarter before is filed too (or its quarters are), with how it was worked out. Keyed by the end date.
 *  `lo` and `hi` are the first and last filing day of the figures a quarter comes from. A quarter is never worked out
 *  from figures that a change of basis of the line (`changes`) may fall between: the later one may be on a new basis (a
 *  business sold or spun off left out) and the earlier on the old, and the one less the other is then no quarter;
 *  `blocked` says why for each such quarter. */
function quartersOf(values: Map<string, Fact>, years: Map<string, Fact>, changes: readonly Change[]): { quarters: Map<string, Quarter>; blocked: Map<string, Blocked> } {
  const out = new Map<string, Quarter>(), blocked = new Map<string, Blocked>();
  const all = [...values.values(), ...years.values()].filter((f) => f.start);
  for (const f of all) if (daysBetween(f.start!, f.end) <= QUARTER[1]) out.set(f.end, { val: f.val, start: f.start!, lo: f.filed, hi: f.filed });
  const near = (a: string, b: string, lo: number, hi: number) => { const d = daysBetween(a, b); return d >= lo && d <= hi; };
  // A change that came after `from` and by `by` may fall between figures filed on `lo` and `hi` (after the one, by the
  // other) unless both were filed by `from` (both on the old basis) or both on or after `by` (both on the new).
  const across = (lo: string, hi: string) => changes.find((c) => lo < c.by && hi > c.from);
  const min = (a: string, b: string) => (a < b ? a : b), max = (a: string, b: string) => (a > b ? a : b);
  // The shortest spans first, so a quarter worked out from six months can serve the nine months after it.
  for (const c of all.filter((f) => daysBetween(f.start!, f.end) > QUARTER[1]).sort((a, b) => daysBetween(a.start!, a.end) - daysBetween(b.start!, b.end))) {
    if (out.has(c.end)) continue;
    // The same year's figure to the quarter before: filed as one figure, or added up from its quarters.
    const prior = all.find((p) => p !== c && Math.abs(daysBetween(c.start!, p.start!)) <= 7 && near(p.end, c.end, 80, 100));
    if (prior) {
      const lo = min(c.filed, prior.filed), hi = max(c.filed, prior.filed), ch = across(lo, hi);
      if (!ch) { out.set(c.end, { val: c.val - prior.val, start: prior.end, how: `${spanWords(c)} to ${c.end} less ${spanWords(prior)} to ${prior.end}`, lo, hi }); continue; }
      if (!blocked.has(c.end)) blocked.set(c.end, { c, other: `${spanWords(prior)} to ${prior.end} (filed ${prior.filed})`, ch, lo, hi });
    }
    let sum = 0, at = '', parts = 0, qlo = '9999-12-31', qhi = '';
    for (let q = [...out.entries()].find(([, v]) => Math.abs(daysBetween(c.start!, v.start)) <= 7); q; ) {
      sum += q[1].val; at = q[0]; parts++; qlo = min(qlo, q[1].lo); qhi = max(qhi, q[1].hi);
      if (near(at, c.end, 80, 100)) break;
      q = [...out.entries()].find(([e, v]) => e > at && near(at, v.start, 0, 7) && !v.how?.includes(c.end));
    }
    if (!parts || !near(at, c.end, 80, 100)) continue;
    const lo = min(c.filed, qlo), hi = max(c.filed, qhi), ch = across(lo, hi);
    if (!ch) { out.set(c.end, { val: c.val - sum, start: at, how: `${spanWords(c)} to ${c.end} less its ${parts} quarter${parts > 1 ? 's' : ''} to ${at}`, lo, hi }); blocked.delete(c.end); }
    else if (!blocked.has(c.end)) blocked.set(c.end, { c, other: `its ${parts} quarter${parts > 1 ? 's' : ''} to ${at} (filed by ${qhi})`, ch, lo, hi });
  }
  return { quarters: out, blocked };
}

/** Share splits as the filer's own per-share figures show them: one period filed again at a whole multiple (or a whole
 *  fraction) of what it was filed at before. `factor` divides a figure filed before `from`, the first filing on the new
 *  basis, to put it on the basis of the latest filings; `old` is the last filing seen on the old basis. Two periods must
 *  agree, so one restatement is never taken for a split. */
export function splitsIn(list: readonly Fact[], asOf: string): Array<{ factor: number; old: string; from: string }> {
  const periods = new Map<string, Fact[]>();
  for (const f of list) if (f.filed <= asOf && f.start) (periods.get(`${f.start}|${f.end}`) ?? periods.set(`${f.start}|${f.end}`, []).get(`${f.start}|${f.end}`)!).push(f);
  const like = (r: number) => {
    const up = r >= 1 ? r : 1 / r;
    if (up < 1.4) return null;
    const k = Math.abs(up - 1.5) < 0.05 ? 1.5 : Math.round(up);
    return Math.abs(up / k - 1) <= 0.03 ? (r >= 1 ? k : 1 / k) : null;
  };
  const found: Array<{ factor: number; old: string; from: string; seen: number }> = [];
  for (const fs of periods.values()) {
    const byDay = fs.sort((a, b) => a.filed.localeCompare(b.filed));
    for (let n = 1; n < byDay.length; n++) {
      const a = byDay[n - 1]!, b = byDay[n]!;
      if (a.filed === b.filed || !a.val || !b.val || Math.sign(a.val) !== Math.sign(b.val) || Math.min(Math.abs(a.val), Math.abs(b.val)) < 0.05) continue;
      const k = like(a.val / b.val);
      if (k === null) continue;
      const later = (x: string, y: string) => (x > y ? x : y), sooner = (x: string, y: string) => (x < y ? x : y);
      const same = found.find((e) => e.factor === k && later(e.old, a.filed) < sooner(e.from, b.filed));
      if (same) { same.old = later(same.old, a.filed); same.from = sooner(same.from, b.filed); same.seen++; }
      else found.push({ factor: k, old: a.filed, from: b.filed, seen: 1 });
    }
  }
  // A period refiled only after two splits shows both at once: that is no split of its own.
  const real = found.filter((e) => e.seen >= 2);
  return real.filter((e) => {
    const inside = real.filter((o) => o !== e && o.from > e.old && o.from <= e.from);
    return !(inside.length && Math.abs(inside.reduce((p, o) => p * o.factor, 1) / e.factor - 1) <= 0.03);
  }).map(({ factor, old, from }) => ({ factor, old, from })).sort((a, b) => a.from.localeCompare(b.from));
}

const splitWords = (k: number) => (k >= 1 ? `${k === 1.5 ? '3-for-2' : `${k}-for-1`} split` : `1-for-${Math.round(1 / k)} reverse split`);
const plain = (n: number) => Number(n.toFixed(6)).toString();

/** A share split as a basis for filed figures: a per-share figure filed before `date` is divided by `factor` (new shares
 *  for one old), a share count multiplied by it. `words` names it; `old`, for one the filings show, is their last filing
 *  on the old basis (`date` is then their first on the new). */
export interface Split { date: string; factor: number; words: string; old?: string }

/** The splits the filer's own per-share figures show by `asOf`, as a basis. */
export const filingSplits = (list: readonly Fact[], asOf: string): Split[] =>
  splitsIn(list, asOf).map((s) => ({ date: s.from, factor: s.factor, old: s.old, words: `the ${splitWords(s.factor)} the filings show between ${s.old} and ${s.from}` }));

/** What a figure filed on `filed` takes from a basis: the factor of every split after its filing, and of those the ones
 *  that can be named on `day` (on or before it). A split after the analysis day is applied and never named: it would
 *  tell an analysis of a past day what came later. */
export function rebase(basis: readonly Split[], filed: string, day: string): { k: number; named: Split[]; silent: boolean } {
  const after = basis.filter((s) => filed < s.date), named = after.filter((s) => s.date <= day);
  return { k: after.reduce((a, s) => a * s.factor, 1), named, silent: named.length < after.length };
}
export const splitList = (splits: readonly Split[]) => splits.map((s) => s.words).join(' and ');

/** One statement from a filer's us-gaap facts, as filed on or before `asOf`. Per-share figures filed before a split are
 *  put on the basis of the later filings it shows by then; or, given `basis`, on that one (the prices' share basis).
 *  Exported for the tests. */
export function filedStatement(usGaap: Facts, kind: Statement, freq: Frequency, asOf: string, basis?: readonly Split[]): Table {
  const quarterly = freq === 'quarterly', flows = kind !== 'balance_sheet';
  const spans: Array<[number, number]> = quarterly ? [QUARTER, ...YEAR_TO_DATE.map(([lo, hi]) => [lo, hi] as [number, number])] : [YEAR];
  const names = quarterly ? ['', ...YEAR_TO_DATE.map(([, , m]) => ` (${m} months to date)`)] : [''];
  const lines = STATEMENTS[kind].lines.map(([label, tags]) => ({ label, ...lineAsOf(usGaap, tags, asOf, spans, quarterly ? [] : ANNUAL_FORMS) }));
  const notes: string[] = [];
  // A quarterly flow: every quarter filed or derived; a year to date only where it gives no quarter.
  const worked = lines.map((l, n) => (quarterly && flows && !perShareUnit(l.unit)
    ? quartersOf(l.values, lineAsOf(usGaap, STATEMENTS[kind].lines[n]![1], asOf, [YEAR], ANNUAL_FORMS).values, changesOf(refilingsOf(usGaap, STATEMENTS[kind].lines[n]![1], asOf)))
    : { quarters: new Map<string, Quarter>(), blocked: new Map<string, Blocked>() }));
  const quarters = worked.map((w) => w.quarters);
  // Each row shows a period at the shortest span it was filed for; a column is one span of one period.
  const chosen = lines.map((l, n) => {
    const m = new Map<string, number>();
    for (const key of l.values.keys()) { const [end, i] = key.split('|') as [string, string]; if (!quarters[n]!.has(end)) m.set(end, Math.min(Number(i), m.get(end) ?? Number(i))); }
    for (const end of quarters[n]!.keys()) m.set(end, 0);
    return m;
  });
  const ends = [...new Set(chosen.flatMap((m) => [...m.keys()]))].sort().reverse().slice(0, SHOWN[freq]);
  const periods = ends.flatMap((end) => [...new Set(chosen.map((m) => m.get(end)).filter((i) => i !== undefined))].sort().map((i) => ({ end, i: i! })));
  if (!periods.length) throw new NoData(`no ${freq} ${STATEMENTS[kind].title.toLowerCase()} was filed with the SEC by ${asOf}`);
  const derived = new Map<string, Set<string>>();
  for (const q of quarters) for (const [end, v] of q) if (v.how && ends.includes(end)) (derived.get(end) ?? derived.set(end, new Set()).get(end)!).add(v.how);
  for (const [end, how] of [...derived].sort((a, b) => b[0].localeCompare(a[0]))) notes.push(`The quarter to ${end} is derived (no filing states it): ${[...how].join('; or ')}.`);
  // A quarter left out because its figures straddle a restatement, said for every one as recent as the oldest column.
  const million = (v: number) => (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  worked.forEach((w, n) => {
    for (const [end, { c, other, ch, lo, hi }] of [...w.blocked].sort((a, b) => b[0].localeCompare(a[0]))) {
      if (quarters[n]!.has(end) || !ends.length || end < ends.at(-1)!) continue;
      const r = ch.r, what = `a filing of ${r.filed} restated an earlier figure of it (${spanWords({ ...r, val: 0 })} to ${r.end}, first filed as ${million(r.first)} million ${lines[n]!.unit}, refiled then as ${million(r.now)} million), as when a business is sold or spun off`;
      // Sure only when the one was filed before the change could have come and the other after it surely had.
      notes.push(lo <= ch.from && hi >= ch.by
        ? `${lines[n]!.label} for the quarter to ${end} is not derived: ${spanWords(c)} to ${c.end} (filed ${c.filed}) and ${other} are on different bases, since ${what}. The one less the other would not be a quarter.`
        : `${lines[n]!.label} for the quarter to ${end} is not derived: ${spanWords(c)} to ${c.end} (filed ${c.filed}) and ${other} may be on different bases: ${what}, and the filings show only that the change came after ${ch.from} and by ${ch.by}. The one less the other may not be a quarter.`);
    }
  });
  // Per-share figures filed before a split, put on the basis of the latest filings, each named; or on the basis given (the
  // prices' share basis of today), said once, since naming a split after the analysis day would tell it what came later.
  // Every filing of the line, quarters and years alike, brackets a split the filings show as closely as they allow.
  const onto = 'the basis of the later filings';
  let perShare = false;
  const rows = lines.map((l, n) => {
    const every = STATEMENTS[kind].lines[n]![1].flatMap((tag) => Object.entries(usGaap[tag]?.units ?? {}).filter(([u]) => perShareUnit(u)).flatMap(([, list]) => list));
    const splits = !perShareUnit(l.unit) ? [] : basis ?? filingSplits(every, asOf);
    const cells = periods.map((p) => {
      if (chosen[n]!.get(p.end) !== p.i) return null;
      const q = p.i === 0 ? quarters[n]!.get(p.end) : undefined;
      if (q) return q.val;
      const f = l.values.get(`${p.end}|${p.i}`);
      if (!f) return null;
      if (perShareUnit(l.unit)) perShare = true;
      const { k, named, silent } = rebase(splits, f.filed, asOf);
      if (k === 1) return f.val;
      const v = Number((f.val / k).toFixed(6));
      if (named.length && !basis) notes.push(silent
        ? `${l.label} for ${spanWords(f)} to ${f.end} was filed on ${f.filed}, before ${splitList(named)}; shown here on ${onto}.`
        : `${l.label} for ${spanWords(f)} to ${f.end} was filed on ${f.filed} as ${plain(f.val)}, before ${splitList(named)}; shown here on ${onto}: ${plain(v)}.`);
      return v;
    });
    return { label: l.label, unit: l.unit, cells };
  });
  if (basis && perShare) notes.push('Per-share figures are on the price source\'s share basis of today, the one its prices are on: a figure filed before a share split since then is divided by that split\'s ratio, so it can differ from the number in its filing.');
  return { columns: periods.map((p) => p.end + (p.i === 0 && derived.has(p.end) ? ' (derived)' : names[p.i]!)), rows, notes };
}

const cache = new Map<string, { at: number; value: Promise<unknown>; read?: number }>();

/** One request for every question asked at once, kept in memory no longer than the desk keeps the answer on disk
 *  (`keepFor`: an hour for a filer's list of filings, a day for the rest), so memory never adds a day on top. When the
 *  answer was read from the SEC is kept beside it (`readAtOf`). */
function cached<T>(url: string, timeoutMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < keepFor(url)) return hit.value as Promise<T>;
  const entry: { at: number; value: Promise<unknown>; read?: number } = { at: Date.now(), value: Promise.resolve() };
  const value = getJsonAt<T>(url, { timeoutMs }).then((r) => { entry.read = r.at; return r.value; });
  entry.value = value;
  cache.set(url, entry);
  value.catch(() => { if (cache.get(url) === entry) cache.delete(url); });
  return value;
}

export function clearSecCache(): void { cache.clear(); }

/** When the SEC's list of a filer's filings now in hand was read (ms), for a tool to say how old it is. */
export const filingsReadAt = (cik: string): number | undefined => cache.get(`https://data.sec.gov/submissions/CIK${cik}.json`)?.read;

/** The filer's CIK, or null when the ticker is not a US SEC filer. */
export async function cikFor(symbol: string): Promise<string | null> {
  const table = await cached<Record<string, { cik_str: number; ticker: string }>>('https://www.sec.gov/files/company_tickers.json', 30_000);
  const hit = Object.values(table).find((e) => e.ticker?.toUpperCase() === symbol.toUpperCase());
  return hit ? String(hit.cik_str).padStart(10, '0') : null;
}

/** Every XBRL fact a filer has filed: its accounts (us-gaap) and its cover page (dei: shares outstanding). */
export const companyFacts = (cik: string) => cached<{ facts?: { 'us-gaap'?: Facts; dei?: Facts } }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 45_000);

/** A statement of a US filer as filed with the SEC on or before `asOf`, its per-share figures on `basis` when given. */
export async function secStatement(symbol: string, kind: Statement, freq: Frequency, asOf: string, basis?: readonly Split[]): Promise<Table> {
  const cik = await cikFor(symbol);
  if (!cik) throw new NoData(`${symbol} is not in the SEC's list of US filers`);
  const usGaap = (await companyFacts(cik)).facts?.['us-gaap'];
  if (!usGaap) throw new NoData(`${symbol} files with the SEC but not in US GAAP terms`);
  return filedStatement(usGaap, kind, freq, asOf, basis);
}

/** The form of the filer's latest yearly report filed by `day` as its facts show it: 10-K for a US company, 20-F or 40-F
 *  for a foreign one; null when none is among them. */
export function annualFormIn(facts: { 'us-gaap'?: Facts; dei?: Facts } | undefined, day: string): string | null {
  let best: Fact | null = null;
  const lists = [facts?.dei?.EntityCommonStockSharesOutstanding, facts?.['us-gaap']?.StockholdersEquity, facts?.['us-gaap']?.Assets, facts?.['us-gaap']?.EarningsPerShareDiluted];
  for (const x of lists) for (const list of Object.values(x?.units ?? {})) for (const f of list) {
    if (f.filed <= day && /^(10-K|20-F|40-F)/.test(f.form ?? '') && (!best || f.filed > best.filed)) best = f;
  }
  return best ? /^(10-K|20-F|40-F)/.exec(best.form!)![1]! : null;
}

// ---------- a filer's own record: its name, industry code and filings ----------
/** A list of filings as the SEC gives it, one column per field, newest first. `acceptanceDateTime` is the moment the SEC
 *  accepted each one (in UTC), `items` the 8-K items it reports ("2.02,9.01"). */
export interface Filings { accessionNumber?: string[]; filingDate?: string[]; reportDate?: string[]; acceptanceDateTime?: string[]; form?: string[]; items?: string[]; primaryDocument?: string[] }
export interface Submissions {
  name?: string; sic?: string; sicDescription?: string; fiscalYearEnd?: string;
  /** `recent`: its latest filings (a year's or a thousand, whichever is more); `files`: the pages that list older ones. */
  filings?: { recent?: Filings; files?: Array<{ name?: string; filingFrom?: string; filingTo?: string }> };
}
/** The filer's record at the SEC: name, industry code, fiscal year end and its latest thousand filings. */
export const submissions = (cik: string) => cached<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`, 30_000);
/** One of the pages that list a filer's older filings, by the name its record gives it ("CIK0001045810-submissions-001.json"). */
export function submissionsPage(name: string): Promise<Filings> {
  if (!/^CIK\d{10}-submissions-\d{3}\.json$/.test(name)) return Promise.reject(new NoData(`the SEC's record names a page of older filings the desk cannot read ("${name}")`));
  return cached<Filings>(`https://data.sec.gov/submissions/${name}`, 30_000);
}

/** The eleven sectors (by the names Yahoo Finance and the S&P sector funds use) an SEC industry code (SIC) falls in. The
 *  SEC's codes are older and coarser than the market's sectors, so this is approximate: a search engine files as "computer
 *  programming" and lands in Technology, not Communication Services. Null for a code that names no industry. */
export function sectorOfSic(raw: string | number | undefined): string | null {
  const c = Number(raw);
  if (!Number.isInteger(c) || c < 100) return null;
  const in_ = (lo: number, hi: number) => c >= lo && c <= hi;
  if (in_(100, 999)) return 'Consumer Defensive';
  if (in_(1000, 1099) || in_(1400, 1499)) return 'Basic Materials';
  if (in_(1200, 1399)) return 'Energy';
  if (in_(1500, 1799)) return 'Industrials';
  if (in_(2000, 2199)) return 'Consumer Defensive';
  if (in_(2200, 2399) || in_(2500, 2599)) return 'Consumer Cyclical';
  if (in_(2400, 2499) || in_(2600, 2699)) return 'Basic Materials';
  if (in_(2700, 2799)) return 'Communication Services';
  if (in_(2830, 2836)) return 'Healthcare';
  if (in_(2840, 2844)) return 'Consumer Defensive';
  if (in_(2800, 2899)) return 'Basic Materials';
  if (in_(2900, 2999)) return 'Energy';
  if (in_(3000, 3099) || in_(3200, 3399)) return 'Basic Materials';
  if (in_(3100, 3199) || in_(3630, 3639) || in_(3710, 3716) || in_(3750, 3751) || in_(3900, 3999)) return 'Consumer Cyclical';
  if (in_(3570, 3579) || in_(3660, 3679)) return 'Technology';
  if (in_(3840, 3851)) return 'Healthcare';
  if (in_(3800, 3899)) return 'Technology';
  if (in_(3400, 3799)) return 'Industrials';
  if (in_(4000, 4799)) return 'Industrials';
  if (in_(4800, 4899)) return 'Communication Services';
  if (in_(4950, 4959)) return 'Industrials';
  if (in_(4900, 4999)) return 'Utilities';
  if (c === 5122 || c === 5047) return 'Healthcare';
  if (in_(5140, 5149) || in_(5400, 5499) || c === 5331 || c === 5912) return 'Consumer Defensive';
  if (in_(5000, 5199)) return 'Industrials';
  if (in_(5200, 5999)) return 'Consumer Cyclical';
  if (c === 6798 || in_(6500, 6599)) return 'Real Estate';
  if (in_(6000, 6799)) return 'Financial Services';
  if (in_(7000, 7299) || in_(7500, 7599) || in_(7900, 7999)) return 'Consumer Cyclical';
  if (in_(7310, 7319) || in_(7800, 7899)) return 'Communication Services';
  if (in_(7370, 7379)) return 'Technology';
  if (in_(7300, 7399)) return 'Industrials';
  if (in_(8000, 8099)) return 'Healthcare';
  if (in_(8200, 8299)) return 'Consumer Defensive';
  if (in_(7600, 8999)) return 'Industrials';
  return null;
}

/** The funds the SEC lists by ticker (mutual funds and most ETFs, each with its series and class), as a set of tickers. */
export async function fundTickers(): Promise<ReadonlySet<string>> {
  const t = await cached<{ fields?: string[]; data?: unknown[][] }>('https://www.sec.gov/files/company_tickers_mf.json', 30_000);
  const at = t.fields?.indexOf('symbol') ?? 3;
  return new Set((t.data ?? []).map((r) => String(r[at] ?? '').toUpperCase()).filter(Boolean));
}

/** A fund's place at the SEC from its ticker: the registrant that files for it, and the series (the fund itself, one of
 *  the many a trust may file for) and share class it reports as. Null when it is not in the SEC's list of funds. */
export async function fundOf(symbol: string): Promise<{ cik: string; series: string; cls: string } | null> {
  const t = await cached<{ fields?: string[]; data?: unknown[][] }>('https://www.sec.gov/files/company_tickers_mf.json', 30_000);
  const col = (name: string, fallback: number) => { const i = t.fields?.indexOf(name) ?? -1; return i >= 0 ? i : fallback; };
  const row = (t.data ?? []).find((r) => String(r[col('symbol', 3)] ?? '').toUpperCase() === symbol.toUpperCase());
  const series = String(row?.[col('seriesId', 1)] ?? ''), cls = String(row?.[col('classId', 2)] ?? '');
  return row && /^\d+$/.test(String(row[col('cik', 0)])) && /^S\d{9}$/.test(series) ? { cik: String(row[col('cik', 0)]).padStart(10, '0'), series, cls } : null;
}

// ---------- figures as filed, for valuation ----------
const ANNUAL = (f: Fact) => ANNUAL_FORMS.some((p) => (f.form ?? '').startsWith(p));
const span = (f: Fact) => (f.start ? daysBetween(f.start, f.end) : 0);
/** Of the facts filed by `asOf`, the latest filing of each one period (a restatement replaces what it restates). */
function knownBy(list: readonly Fact[], asOf: string): Fact[] {
  const best = new Map<string, Fact>();
  for (const f of list) {
    if (f.filed > asOf) continue;
    const key = `${f.start ?? ''}|${f.end}`, seen = best.get(key);
    if (!seen || f.filed >= seen.filed) best.set(key, f);
  }
  return [...best.values()];
}

/** The last twelve months of a per-share flow (diluted EPS, dividends per share) as filed by `asOf`: the last full year,
 *  plus this year to date, less the same span a year before (no filing gives twelve months that end mid-year). With no
 *  year to date filed since the last full year, that year itself. Each figure is first put on `basis`, by the splits
 *  after its own filing, so figures filed on either side of a split are never added as they stand. `parts` says which
 *  filed figures it came from, and what a split it can name on `asOf` changed. */
export function trailingYear(list: readonly Fact[], asOf: string, basis: readonly Split[] = []): { value: number; parts: string } | null {
  const known = knownBy(list, asOf).filter((f) => f.start);
  const year = known.filter((f) => ANNUAL(f) && span(f) >= YEAR[0] && span(f) <= YEAR[1]).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!year) return null;
  const after = known.filter((f) => f.end > year.end && daysBetween(year.end, f.start!) >= 0 && daysBetween(year.end, f.start!) <= 7 && span(f) >= 60 && span(f) <= 290)
    .sort((a, b) => b.end.localeCompare(a.end) || span(b) - span(a))[0];
  const round = (n: number) => Number(n.toFixed(6));
  const on = (f: Fact) => {
    const { k, named, silent } = rebase(basis, f.filed, asOf), v = round(f.val / k);
    return { v, words: `${plain(v)}${!named.length ? '' : silent ? ` (filed before ${splitList(named)})` : ` (${plain(f.val)} as filed, before ${splitList(named)})`}` };
  };
  const y = on(year);
  if (!after) return { value: y.v, parts: `the full year to ${year.end}, ${y.words}` };
  const before = known.find((f) => Math.abs(daysBetween(f.end, after.end) - 365) <= 10 && Math.abs(span(f) - span(after)) <= 10);
  if (!before) return { value: y.v, parts: `the full year to ${year.end}, ${y.words} (the same span a year before ${after.end} was not filed, so the year to date cannot be added)` };
  const a = on(after), b = on(before);
  return { value: round(y.v + a.v - b.v), parts: `the full year to ${year.end}, ${y.words}, plus ${after.start} to ${after.end}, ${a.words}, less ${before.start} to ${before.end}, ${b.words}` };
}

/** The facts of the first list, and of each later one those for periods no earlier list gives: a line a filer reports
 *  under one tag or another, never both added. */
export function firstTagPerPeriod(...lists: Array<readonly Fact[]>): Fact[] {
  const seen = new Set<string>(), out: Fact[] = [];
  for (const list of lists) {
    const mine = list.filter((f) => !seen.has(`${f.start ?? ''}|${f.end}`));
    for (const f of mine) { out.push(f); }
    for (const f of mine) seen.add(`${f.start ?? ''}|${f.end}`);
  }
  return out;
}

/** The latest balance (a figure at a date, like equity) filed by `asOf`. */
export function latestBalance(list: readonly Fact[], asOf: string): Fact | null {
  return knownBy(list, asOf).filter((f) => !f.start).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0] ?? null;
}

/** In place of a cover-page count: the weighted average diluted shares of the latest quarter filed by `asOf` (of the
 *  latest year, when no quarter was filed). The SEC's data leaves out the counts a filer with more than one class of
 *  shares gives class by class on its cover page (Meta, Alphabet), and this figure from its accounts is always there. */
export function averageDilutedShares(list: readonly Fact[], asOf: string): { shares: number; start: string; end: string; filed: string } | null {
  const known = knownBy(list, asOf).filter((f) => f.start && f.val > 0), quarters = known.filter((f) => span(f) >= 80 && span(f) <= 100);
  const top = (quarters.length ? quarters : known).sort((a, b) => b.end.localeCompare(a.end) || span(a) - span(b))[0];
  return top ? { shares: top.val, start: top.start!, end: top.end, filed: top.filed } : null;
}

/** Shares outstanding as the latest cover page filed by `asOf` gives them, each class added (a filer with classes A, B
 *  and C files one count for each, on the same date in the same filing). */
export function sharesOutstanding(list: readonly Fact[], asOf: string): { shares: number; end: string; filed: string } | null {
  const known = list.filter((f) => f.filed <= asOf).sort((a, b) => b.filed.localeCompare(a.filed) || b.end.localeCompare(a.end));
  const top = known[0];
  if (!top) return null;
  const same = known.filter((f) => f.filed === top.filed && f.end === top.end && (f.accn ?? '') === (top.accn ?? ''));
  return { shares: same.reduce((a, f) => a + f.val, 0), end: top.end, filed: top.filed };
}
