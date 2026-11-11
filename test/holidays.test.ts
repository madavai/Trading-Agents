import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketDay } from '../src/data/dates.js';
import { firstMarketDayOfWeek, HOLIDAYS, holidaysKnown, isMarketDay, marketClosed, marketDaysBetween, nextMarketDay, regularSession } from '../src/data/holidays.js';
import { tradingDaysBetween } from '../src/desk/orders.js';

test("New York's holiday list reaches the year after this one: renew it from the NYSE's own page before it runs out", () => {
  const next = String(Number(marketDay(new Date()).slice(0, 4)) + 1);
  assert.ok(next in HOLIDAYS, `the market holidays for ${next} are missing: add them from the NYSE's "Holidays & Trading Hours" page (src/data/holidays.ts)`);
});

test('every listed holiday is a weekday of its own year, in order, once', () => {
  for (const [year, days] of Object.entries(HOLIDAYS)) {
    assert.ok(days.length >= 9 && days.length <= 10, `${year}: the NYSE closes for nine or ten weekdays a year`);
    days.forEach(([day, name], i) => {
      assert.equal(day.slice(0, 4), year, day);
      assert.ok(![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay()), `${day} (${name}) is a weekday`);
      if (i) assert.ok(day > days[i - 1]![0], `${day} after ${days[i - 1]![0]}`);
    });
  }
});

test('Thanksgiving and Martin Luther King Jr. Day are closed; the day after Thanksgiving, an early close, is a market day', () => {
  assert.equal(marketClosed('2026-11-26'), 'Thanksgiving Day');
  assert.equal(marketClosed('2027-01-18'), 'Martin Luther King, Jr. Day');
  assert.deepEqual([isMarketDay('2026-11-26'), isMarketDay('2027-01-18'), isMarketDay('2026-11-27'), isMarketDay('2026-11-25')], [false, false, true, true]);
  assert.deepEqual([marketClosed('2026-11-28'), marketClosed('2026-11-29')], ['a Saturday', 'a Sunday']);
  assert.equal(marketClosed('2027-12-31'), null, 'New Year 2028 falls on a Saturday: the NYSE keeps no holiday for it, and is open the Friday before');
  assert.equal(marketClosed('2027-07-05'), 'Independence Day (observed)');
});

test('the next market day, the week\'s first, and the trading days between, all skip the holidays', () => {
  assert.equal(nextMarketDay('2026-11-25'), '2026-11-27', 'Wednesday before Thanksgiving: Friday');
  assert.equal(nextMarketDay('2027-01-15'), '2027-01-19', 'Friday before Martin Luther King Jr. Day: Tuesday');
  assert.deepEqual([firstMarketDayOfWeek('2027-01-18'), firstMarketDayOfWeek('2027-01-21'), firstMarketDayOfWeek('2026-11-26')], ['2027-01-19', '2027-01-19', '2026-11-23']);
  assert.equal(marketDaysBetween('2026-11-25', '2026-11-30'), 2, 'Friday 27th and Monday 30th, not Thanksgiving');
  assert.equal(tradingDaysBetween('2026-11-20', '2026-11-30'), 5, 'the shortest hold counts trading days: Thanksgiving week has four');
  assert.equal(tradingDaysBetween('2026-11-20', '2026-11-20'), 0);
});

test('a year not in the list is said to be unknown, and only its weekends are closed', () => {
  assert.deepEqual([holidaysKnown('2026-11-26'), holidaysKnown('2031-11-27')], [true, false]);
  assert.equal(marketClosed('2031-11-27'), null, 'Thanksgiving 2031 is not known: a weekday is taken as a market day');
  assert.equal(marketClosed('2031-11-29'), 'a Saturday');
});

test("New York's regular session, the only time a part-share is sent: 9:30 a.m. to the close, on market days, and when it next opens", () => {
  const at = (iso: string) => regularSession(new Date(iso));
  assert.deepEqual(at('2026-11-12T15:00:00Z'), { open: true, opens: '' }, 'a Thursday, 10:00 a.m. in New York');
  assert.deepEqual(at('2026-11-12T14:30:00Z'), { open: true, opens: '' }, '9:30 a.m. exactly');
  assert.deepEqual(at('2026-11-12T13:00:00Z'), { open: false, opens: 'today at 9:30 a.m. New York time' }, 'before the open');
  assert.deepEqual(at('2026-11-12T21:00:00Z'), { open: false, opens: 'Friday 2026-11-13 at 9:30 a.m. New York time' }, '4:00 p.m.: closed');
  assert.deepEqual(at('2026-11-14T16:00:00Z'), { open: false, opens: 'Monday 2026-11-16 at 9:30 a.m. New York time' }, 'a Saturday');
  assert.deepEqual(at('2026-11-26T16:00:00Z'), { open: false, opens: 'Friday 2026-11-27 at 9:30 a.m. New York time' }, 'Thanksgiving Day');
  assert.equal(at('2026-11-27T17:30:00Z').open, true, 'the day after Thanksgiving, 12:30 p.m.');
  assert.deepEqual(at('2026-11-27T18:30:00Z'), { open: false, opens: 'Monday 2026-11-30 at 9:30 a.m. New York time' }, 'after its early close at 1:00 p.m.');
  assert.equal(at('2026-07-01T13:30:00Z').open, true, 'in summer New York is four hours behind: 9:30 a.m.');
});
