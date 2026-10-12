// Dates as the desk uses them: every tool works "as of" an analysis date and never serves anything dated after it, so an
// analysis of a past day reads only what was known that day. Dates are calendar days, YYYY-MM-DD.

const DAY = 86_400_000;

/** Today's date (UTC). TRADING_AGENTS_TODAY sets it, for the tests. */
export function today(): string {
  return process.env.TRADING_AGENTS_TODAY || new Date().toISOString().slice(0, 10);
}

/** A YYYY-MM-DD date checked to be a real calendar day; throws with plain words otherwise. */
export function parseDate(value: string, what = 'date'): string {
  const v = String(value ?? '').trim();
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new Error(`the ${what} "${value}" is not a date in YYYY-MM-DD form`);
  }
  return v;
}

/** The analysis date, refused when it is in the future: the desk cannot analyse a day that has not happened. */
export function analysisDate(value: string): string {
  const d = parseDate(value, 'analysis date');
  if (d > today()) throw new Error(`the analysis date ${d} is in the future (today is ${today()})`);
  return d;
}

export const isHistorical = (date: string): boolean => date < today();

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** A date a model asked for, held to the analysis date: never later than it. */
export const asOf = (requested: string | undefined, analysis: string): string => {
  if (!requested) return analysis;
  const r = parseDate(requested);
  return r > analysis ? analysis : r;
};

/** A window a model asked for, held to the analysis date; a window wholly after it becomes the days before it. */
export function window(start: string, end: string, analysis: string): [string, string] {
  let s = parseDate(start, 'start date'), e = parseDate(end, 'end date');
  if (s > e) [s, e] = [e, s];
  if (e > analysis) {
    const span = daysBetween(s, e);
    e = analysis;
    if (s > analysis) s = addDays(analysis, -span);
  }
  return [s, e];
}
