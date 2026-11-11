// New York's market holidays: the weekdays the New York Stock Exchange is closed, as it publishes them ("Holidays &
// Trading Hours", nyse.com/trade/hours-calendars, read 8 Nov 2026: 2026, 2027 and 2028). The NYSE lists about three
// years ahead; a test fails once the year after this one is missing, so the list is renewed before it runs out. A year
// not in the list is said to be unknown wherever the desk relies on it, and its weekdays are taken as market days.
// The early closes (1:00 p.m. on the day after Thanksgiving, on 24 Dec 2026 and on 3 Jul 2028) are market days.
import { addDays, nyClock, weekday } from './dates.js';

export const HOLIDAYS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  2026: [
    ['2026-01-01', "New Year's Day"], ['2026-01-19', 'Martin Luther King, Jr. Day'], ['2026-02-16', "Washington's Birthday"],
    ['2026-04-03', 'Good Friday'], ['2026-05-25', 'Memorial Day'], ['2026-06-19', 'Juneteenth'],
    ['2026-07-03', 'Independence Day (observed)'], ['2026-09-07', 'Labor Day'], ['2026-11-26', 'Thanksgiving Day'],
    ['2026-12-25', 'Christmas Day'],
  ],
  2027: [
    ['2027-01-01', "New Year's Day"], ['2027-01-18', 'Martin Luther King, Jr. Day'], ['2027-02-15', "Washington's Birthday"],
    ['2027-03-26', 'Good Friday'], ['2027-05-31', 'Memorial Day'], ['2027-06-18', 'Juneteenth (observed)'],
    ['2027-07-05', 'Independence Day (observed)'], ['2027-09-06', 'Labor Day'], ['2027-11-25', 'Thanksgiving Day'],
    ['2027-12-24', 'Christmas Day (observed)'],
  ],
  // 1 Jan 2028 is a Saturday: the NYSE keeps no New Year's Day holiday that year.
  2028: [
    ['2028-01-17', 'Martin Luther King, Jr. Day'], ['2028-02-21', "Washington's Birthday"], ['2028-04-14', 'Good Friday'],
    ['2028-05-29', 'Memorial Day'], ['2028-06-19', 'Juneteenth'], ['2028-07-04', 'Independence Day'],
    ['2028-09-04', 'Labor Day'], ['2028-11-23', 'Thanksgiving Day'], ['2028-12-25', 'Christmas Day'],
  ],
};

const NAMES = new Map(Object.values(HOLIDAYS).flat().map(([day, name]) => [day, name]));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOfWeek = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Whether New York's holidays for the year of `day` (YYYY-MM-DD) are in the list. */
export const holidaysKnown = (day: string): boolean => day.slice(0, 4) in HOLIDAYS;

/** Why New York's market is closed on `day`, in words ("a Saturday", "Thanksgiving Day"), or null on a market day. A day
 *  of a year not in the list is closed only at a weekend. */
export function marketClosed(day: string): string | null {
  const w = dayOfWeek(day);
  if (w === 0 || w === 6) return `a ${DAYS[w]}`;
  return NAMES.get(day) ?? null;
}

/** A weekday New York's market is open: not a weekend, and not one of its holidays. */
export const isMarketDay = (day: string): boolean => marketClosed(day) === null;

/** New York's early closes (1:00 p.m.), as the NYSE lists them with its holidays: the day after Thanksgiving, and
 *  Christmas Eve or the day before Independence Day when it lists one. */
export const EARLY_CLOSES: ReadonlySet<string> = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

/** When New York's regular session closes on a market day, on its own clock: "16:00", or "13:00" on an early close. */
export const closeOf = (day: string): string => (EARLY_CLOSES.has(day) ? '13:00' : '16:00');

/** The market day after `day`. */
export function nextMarketDay(day: string): string {
  let d = addDays(day, 1);
  while (!isMarketDay(d)) d = addDays(d, 1);
  return d;
}

/** Whether New York's regular session (9:30 a.m. to its close) is open at `now` and, when it is not, when it opens next,
 *  in words: "today at 9:30 a.m. New York time", or "Monday 2026-11-16 at 9:30 a.m. New York time". */
export function regularSession(now: Date): { open: boolean; opens: string } {
  const [day, hm] = nyClock(now.getTime()).split(' ') as [string, string];
  if (isMarketDay(day) && hm >= '09:30' && hm < closeOf(day)) return { open: true, opens: '' };
  const next = isMarketDay(day) && hm < '09:30' ? day : nextMarketDay(day);
  return { open: false, opens: `${next === day ? 'today' : `${weekday(next)} ${next}`} at 9:30 a.m. New York time` };
}

/** The first market day of `day`'s week (Monday to Friday), or null when the market is closed all week. */
export function firstMarketDayOfWeek(day: string): string | null {
  const monday = addDays(day, -((dayOfWeek(day) + 6) % 7));
  for (let i = 0; i < 5; i++) { const d = addDays(monday, i); if (isMarketDay(d)) return d; }
  return null;
}

/** Market days after `from` up to and including `to`, both YYYY-MM-DD: 0 on the same day. */
export function marketDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isMarketDay(d)) n++;
  return n;
}
