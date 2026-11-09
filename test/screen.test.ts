import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bar, Series } from '../src/data/yahoo.js';
import { configure } from '../src/data/http.js';
import { nextMarketDay, queueTop, rank, readScreen, SCREEN_MS, screenToday, signalsOf, whyOf, workScreen, type Screen } from '../src/desk/screen.js';
import { liveOf, moodOf, outcomeWords, ratesOf, trendOf, type PolyEvent } from '../src/desk/weather.js';
import { morningBrief, morningList } from '../src/desk/routine.js';
import { Journal } from '../src/desk/journal.js';
import { enqueue, readDoorbell, readQueue } from '../src/desk/queue.js';
import { screenUniverse } from '../src/terminal/tiers.js';
import { chartJson, series, weekdays } from './chart.js';

/** `n` weekday rows ending on `last`, drifting by `slope` a day from 100 (high and low a dollar either side, a million
 *  traded); the last row is then changed as given, its close as a multiple of the close before, and a narrow day (high
 *  and low 20 cents either side) unless said otherwise. */
const drift = (n: number, last: { times?: number; high?: number; low?: number; volume?: number } = {}, slope = 0.02, day = '2026-10-16'): Bar[] => {
  const rows = weekdays(day, n).map((date, i) => { const c = 100 + i * slope; return { date, open: c, high: c + 1, low: c - 1, close: c, volume: 1_000_000 }; });
  const prev = rows[n - 2]?.close ?? 100, close = prev * (last.times ?? 1), end = rows[n - 1]!;
  rows[n - 1] = { ...end, close, high: last.high ?? close + 0.2, low: last.low ?? close - 0.2, volume: last.volume ?? 1_000_000 };
  return rows;
};
const kinds = (bars: Bar[], news: number | null = null) => signalsOf(bars, news).signals.map((s) => s.kind);
const desk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-screen-')), 'desk-data');

test('a day worth a look: a move of 3% or more, twice the usual volume, a new 52-week high or low, a cross of the 50- or 200-day average, news today', () => {
  const s = signalsOf(drift(300, { times: 1.045, volume: 3_000_000 }));   // a gentle rise, then a jump: above its averages all along
  assert.deepEqual(s.signals.map((x) => x.kind), ['move', 'volume', 'high']);
  assert.ok(Math.abs(s.movePct! - 4.5) < 1e-9);
  assert.equal(whyOf(s.signals), 'Rose 4.5% on 3.0 times its usual volume, a new 52-week high');
  const fall = drift(300, { times: 0.96, low: 95 });
  assert.deepEqual(kinds(fall), ['move', 'low', 'below50', 'below200'], 'a fall through both averages: no volume signal at the usual volume');
  assert.equal(whyOf(signalsOf(fall).signals), 'Fell 4.0%, a new 52-week low, crossed below its 50-day average, crossed below its 200-day average');
  assert.deepEqual(kinds(drift(300, { times: 1.025 }, -0.02)), ['above50', 'above200'], 'a gentle fall, then a rise of 2.5% back over both averages: a cross, not a move');
  assert.deepEqual(kinds(drift(300, { times: 1.005, volume: 1_500_000 })), [], 'a quiet day fires nothing');
  assert.ok(!kinds(drift(300, { times: 1.029 })).includes('move'), 'under 3% is not a move');
  assert.equal(whyOf(signalsOf(drift(300, { volume: 2_500_000 })).signals), 'Traded 2.5 times its usual volume');
  assert.deepEqual(kinds(drift(30, { times: 1.04, high: 140 })), ['move'], 'without a year of rows, no 52-week high, and no average it cannot work out');
  assert.deepEqual(kinds(drift(300, {}).map((b) => ({ ...b, volume: 0 }))), [], 'an index trades no volume: no volume signal');
  assert.deepEqual(kinds(drift(300), 2), ['news']);
  assert.equal(signalsOf(drift(300), 1).signals[0]!.words, 'in the news today (1 article)');
  assert.deepEqual([kinds(drift(300), 0), kinds(drift(300), null)], [[], []], 'no news, or news not read, fires nothing');
  assert.deepEqual(signalsOf([]), { signals: [], movePct: null });
});

test('the picks: those with a signal, by how many fire, then by the size of the move; five at most', () => {
  const picks = rank([
    { symbol: 'QUIET', bars: drift(300, { times: 1.002 }), news: null },
    { symbol: 'BIG', bars: drift(300, { times: 1.08 }), news: null },               // move, high: two, 8%
    { symbol: 'NEWSY', bars: drift(300, { times: 1.035 }), news: 3 },               // move, high, news: three
    { symbol: 'SMALL', bars: drift(300, { times: 1.031 }), news: null },            // move, high: two, 3.1%
    { symbol: 'VOL', bars: drift(300, { volume: 4_000_000 }), news: null },         // one
    { symbol: 'DROP', bars: drift(300, { times: 0.91 }), news: null },              // move, low, both averages: four, 9%
    { symbol: 'LOW', bars: drift(300, { times: 0.965, low: 90 }), news: null },     // four, 3.5%
  ]);
  assert.deepEqual(picks.map((p) => [p.symbol, p.signals.length]), [['DROP', 4], ['LOW', 4], ['NEWSY', 3], ['BIG', 2], ['SMALL', 2]], 'five at most; VOL, with one signal, is left out');
  assert.equal(picks[0]!.session, '2026-10-16');
  assert.ok(!picks.some((p) => p.symbol === 'QUIET'));
});

test('the market weather: the trend from the S&P 500\'s averages, the mood from the VIX, never a forecast; too few figures say so', () => {
  const rows = (closes: number[]) => weekdays('2026-10-16', closes.length).map((date, i) => ({ date, open: closes[i]!, high: closes[i]! + 1, low: closes[i]! - 1, close: closes[i]!, volume: 0 }));
  const rising = rows(Array.from({ length: 260 }, (_, i) => 5000 + i * 5));
  assert.deepEqual([trendOf(rising).state, trendOf(rising).tone], ['Rising', 'ok']);
  assert.match(trendOf(rising).words, /^The S&P 500 closed at 6,295 on 16 Oct 2026, above its 50-day average \(6,173\) and above its 200-day average \(5,798\)\.$/);
  assert.deepEqual([trendOf(rows(Array.from({ length: 260 }, (_, i) => 7000 - i * 5))).state, trendOf(rows(Array.from({ length: 260 }, (_, i) => 7000 - i * 5))).tone], ['Falling', 'bad']);
  const dip = rows([...Array.from({ length: 250 }, (_, i) => 5000 + i * 5), ...Array.from({ length: 10 }, () => 6000)]);   // under the 50-day, over the 200-day
  assert.deepEqual([trendOf(dip).state, trendOf(dip).tone], ['Mixed', 'warn']);
  assert.match(trendOf(dip).words, /below its 50-day average .* and above its 200-day average/);
  const short = trendOf(rows(Array.from({ length: 120 }, () => 5000)));
  assert.deepEqual([short.state, short.tone], [null, '']);
  assert.match(short.words, /^Unavailable: too few days/);
  assert.match(trendOf(rising).meaning, /not where it goes next/);
  for (const [vix, state, tone] of [[14.9, 'Calm', 'ok'], [15, 'Normal', ''], [25, 'Normal', ''], [25.1, 'Wild', 'bad']] as const) {
    const m = moodOf(rows([20, vix]));
    assert.deepEqual([m.state, m.tone], [state, tone], String(vix));
  }
  assert.equal(moodOf(rows([17.42])).words, 'The VIX closed at 17.4 on 16 Oct 2026.');
  assert.equal(moodOf([]).state, null);
});

/** Polymarket's answer in the shape it gives: an event per Federal Reserve meeting, a market per outcome. */
const fed = (title: string, endDate: string, odds: Record<string, number>, closed = false): PolyEvent => ({
  title, endDate, closed, markets: Object.entries(odds).map(([g, p]) => ({ groupItemTitle: g, outcomePrices: JSON.stringify([String(p), String(1 - p)]), closed })),
});

test('the rates line: what Polymarket prices for the Federal Reserve\'s next decision, in plain words, or unavailable', () => {
  const now = new Date('2026-10-21T14:00:00Z');
  const events = [
    fed('Fed decision in October?', '2025-10-29T12:00:00Z', { 'No change': 0, '25 bps decrease': 1 }, true),
    fed('Fed Decision in December?', '2026-12-10T04:59:00Z', { 'No change': 0.2, '25 bps increase': 0.78 }),
    fed('Fed Decision in October?', '2026-10-29T03:59:00Z', { '50+ bps decrease': 0.0005, '25 bps decrease': 0.0035, 'No change': 0.875, '25 bps increase': 0.115, '50+ bps increase': 0.0035 }),
    { title: 'Will the Fed chair resign?', endDate: '2026-11-01T00:00:00Z', markets: [] },
  ];
  const r = ratesOf(events, now);
  assert.deepEqual([r.state, r.tone], ['No change', '']);
  assert.equal(r.words, "For the Federal Reserve's next decision, by 28 Oct 2026, Polymarket's crowd puts no change at 88% and a rise of 0.25 percentage points at 12%.");
  assert.match(r.meaning, /not a forecast of ours/);
  const cut = ratesOf([fed('Fed decision in March?', '2027-03-18T00:00:00Z', { '50+ bps decrease': 0.6, '25 bps decrease': 0.05 })], now);
  assert.deepEqual([cut.state, cut.tone, cut.words.endsWith('puts a cut of 0.5 percentage points or more at 60%.')], ['A cut', 'ok', true], 'a second outcome under 10% is not named');
  assert.deepEqual([ratesOf([events[1]!], now).state, ratesOf([events[1]!], now).tone], ['A rise', 'warn']);
  assert.equal(ratesOf([events[0]!], now).state, null, 'a decided meeting is not the next one');
  assert.match(ratesOf([], now).words, /^Unavailable: Polymarket has no open market/);
  assert.deepEqual([outcomeWords('No change'), outcomeWords('25+ bps increase'), outcomeWords('100 bps decrease')].map((o) => o.words), ['no change', 'a rise of 0.25 percentage points or more', 'a cut of 1 percentage point']);
});

const screenOf = (day: string, picks: string[]): Screen => ({ day, at: `${day}T13:00:00.000Z`, looked: 20, unavailable: [], picks: picks.map((symbol) => ({ symbol, signals: [{ kind: 'move', words: 'rose 4.0%' }], movePct: 4, why: 'Rose 4.0%', session: day })) });

test('the screen is worked out at most once an hour and kept, so the dashboard and the morning routine read the same list', async () => {
  const dir = desk();
  let worked = 0;
  const work = async (symbols: readonly string[], _news: ReadonlySet<string>, day: string, now: Date = new Date()): Promise<Screen> => { worked++; return { ...screenOf(day, symbols.slice(0, 2)), at: now.toISOString() }; };
  const t0 = new Date('2026-10-19T13:00:00Z');
  const first = await screenToday(dir, ['XLE', 'NVDA', 'SPY'], new Set(['NVDA']), '2026-10-19', t0, work);
  assert.deepEqual(first.picks.map((p) => p.symbol), ['XLE', 'NVDA']);
  assert.deepEqual(readScreen(dir)!.picks.map((p) => p.symbol), ['XLE', 'NVDA'], 'kept in desk-data');
  await screenToday(dir, ['SPY'], new Set(), '2026-10-19', new Date(t0.getTime() + SCREEN_MS - 1000), work);
  assert.equal(worked, 1, 'within the hour, the kept one is read');
  fs.writeFileSync(path.join(dir, 'screen.json'), JSON.stringify({ ...readScreen(dir), queued: { day: '2026-10-19', symbols: ['XLE'] } }));
  const later = await screenToday(dir, ['SPY'], new Set(), '2026-10-19', new Date(t0.getTime() + SCREEN_MS + 1000), work);
  assert.deepEqual([worked, later.picks.map((p) => p.symbol), later.queued], [2, ['SPY'], { day: '2026-10-19', symbols: ['XLE'] }], 'after the hour, worked out again; what was queued today is carried over');
  await screenToday(dir, ['SPY'], new Set(), '2026-10-20', new Date('2026-10-20T13:00:00Z'), work);
  assert.equal(readScreen(dir)!.queued, undefined, 'a new day queues afresh');
  fs.writeFileSync(path.join(dir, 'screen.json'), 'not json');
  assert.equal(readScreen(dir), null);
  const u = screenUniverse([{ symbol: 'NVDA', favourite: true, addedOn: 'x' }, { symbol: 'SPY', favourite: false, addedOn: 'x' }, { symbol: 'BTC-USD', favourite: false, addedOn: 'x' }], ['VT']);
  assert.deepEqual([u.symbols.length, u.symbols.slice(0, 2), [...u.news]], [15, ['VT', 'XLK'], ['NVDA', 'BTC-USD']], 'the whole market, the eleven sectors and the watchlist; news for companies and coins only');
});

test('the morning switch: on a weekday, once, the top three not called today nor already asked for go on the waiting list at shallow depth', () => {
  const dir = desk(), now = new Date('2026-10-19T13:00:00Z');
  new Journal(path.join(dir, 'journal.md')).storeDecision('NVDA', '2026-10-19', '**Rating**: Hold\n\n**Executive Summary**: x.');
  enqueue(dir, 'AAPL', '2026-10-19T12:00:00Z', 'deep');
  const s = screenOf('2026-10-19', ['NVDA', 'XLE', 'AAPL', 'TSLA', 'XLK', 'MSFT']);
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'screen.json'), JSON.stringify(s));
  assert.deepEqual(queueTop(dir, s, '2026-10-19', true, now), ['XLE', 'TSLA', 'XLK'], 'NVDA was called today and AAPL is already waiting');
  assert.deepEqual(readQueue(dir, now).map((q) => [q.symbol, q.depth]), [['AAPL', 'deep'], ['XLE', 'shallow'], ['TSLA', 'shallow'], ['XLK', 'shallow']]);
  assert.equal(readDoorbell(dir)?.at, now.toISOString(), 'the doorbell rings for whoever listens');
  assert.deepEqual(readScreen(dir)!.queued, { day: '2026-10-19', symbols: ['XLE', 'TSLA', 'XLK'] });
  assert.deepEqual(queueTop(dir, readScreen(dir)!, '2026-10-19', true, now), [], 'once a day');
  assert.deepEqual(queueTop(dir, s, '2026-10-19', true, now), [], 'once a day, whichever copy of the screen asks');
  const afternoon = desk(), late = new Date('2026-10-19T17:00:00Z'), early = new Date('2026-10-19T15:59:00Z');
  assert.deepEqual(queueTop(afternoon, screenOf('2026-10-19', ['XLE']), '2026-10-19', true, late), [], 'a market morning only: noon in New York is 16:00 UTC in October');
  assert.deepEqual(queueTop(afternoon, screenOf('2026-10-19', ['XLE']), '2026-10-19', true, early), ['XLE'], 'just before noon in New York');
  const started = desk();
  assert.deepEqual(queueTop(started, screenOf('2026-10-19', ['XLE']), '2026-10-19', true, now, '2026-10-20'), [], 'switched on the day before: it starts on the next market day');
  assert.deepEqual(queueTop(started, screenOf('2026-10-20', ['XLE']), '2026-10-20', true, new Date('2026-10-20T13:00:00Z'), '2026-10-20'), ['XLE'], 'and acts on that morning');
  assert.deepEqual([nextMarketDay('2026-10-19'), nextMarketDay('2026-10-23'), nextMarketDay('2026-10-24'), nextMarketDay('2026-10-25')], ['2026-10-20', '2026-10-26', '2026-10-26', '2026-10-26'], 'the weekday after; Friday, Saturday and Sunday all lead to Monday');
  const weekend = desk();
  assert.deepEqual(queueTop(weekend, screenOf('2026-10-17', ['XLE']), '2026-10-17', true, now), [], 'never on a Saturday');
  const quiet = desk();
  assert.deepEqual(queueTop(quiet, screenOf('2026-10-19', ['XLE']), '2026-10-19', false, now), ['XLE']);
  assert.equal(readDoorbell(quiet), null, 'the morning routine runs them itself: no doorbell');
  assert.deepEqual(queueTop(quiet, screenOf('2026-10-18', ['TSLA']), '2026-10-19', false, now), [], 'a screen from another day queues nothing');
});

test('the morning routine reads the same list: the picks with their reasons, and what the switch put on the waiting list, or that it is off', () => {
  const dir = desk(), s = { ...screenOf('2026-10-19', ['XLE', 'TSLA']), unavailable: ['ZZZZ'] };
  const off = morningBrief(dir, '2026-10-19', 5, { screen: s, on: false });
  assert.match(off, /Worth a look today, from Yahoo Finance's daily prices at 13:00 UTC \(figures only, never a forecast; 20 looked at; the moves are from the session of 2026-10-19 \(Mon\)\):\n {3}- XLE: Rose 4\.0%\.\n {3}- TSLA: Rose 4\.0%\.\n {3}Could not be read: ZZZZ\./);
  assert.match(off, /switch "Analyse the top 3 each market morning" is off: this list is for the person to read, not for you to analyse/);
  enqueue(dir, 'XLE', '2026-10-19T13:00:00Z', 'shallow');
  const on = { ...s, queued: { day: '2026-10-19', symbols: ['XLE'] } };
  assert.match(morningBrief(dir, '2026-10-19', 5, { screen: on, on: true }), /is on: XLE was put on the waiting list at shallow depth, and is analysed in step 2/);
  assert.deepEqual(morningList(dir, '2026-10-19', 5, on).analyse[0], { symbol: 'XLE', why: 'worth a look today, put on the list by the morning switch, shallow depth', queued: true });
  assert.match(morningBrief(dir, '2026-10-19', 5, { screen: null, failed: 'Yahoo Finance did not answer', on: true }), /Worth a look today: unavailable \(Yahoo Finance did not answer\)/);
  assert.match(morningBrief(dir, '2026-10-19', 5, { screen: { ...s, picks: [] }, on: false }), /nothing stood out/);
  assert.ok(!morningBrief(dir, '2026-10-17', 5, { screen: s, on: true }).includes('Worth a look'), 'not on a weekend');
  assert.ok(!morningBrief(dir, '2026-10-19', 5).includes('Worth a look'), 'without a look, the brief is as before');
});

/** A made-up S&P 500 day: its session in Yahoo's shape (9:30 to 4:00 New York time, 13:30 to 20:00 UTC in October). */
const sessionOf = (day: string) => ({ date: day, start: Date.parse(`${day}T13:30:00Z`), end: Date.parse(`${day}T20:00:00Z`) });

test('during the session the weather says "still trading", never "closed at": a price still moving is not a close', () => {
  const bars = weekdays('2026-10-16', 260).map((date, i) => ({ date, open: 5000 + i * 5, high: 5001 + i * 5, low: 4999 + i * 5, close: 5000 + i * 5, volume: 0 }));
  const s: Series = { meta: { symbol: '^GSPC', session: sessionOf('2026-10-16') }, bars };
  const open = new Date('2026-10-16T15:05:00Z'), after = new Date('2026-10-16T20:30:00Z');
  const live = trendOf(bars, liveOf(s, '2026-10-16', open));
  assert.equal(live.words, 'The S&P 500 is at 6,295 at 11:05 AM New York time on 16 Oct 2026, still trading (not a close), above its 50-day average (6,173) and above its 200-day average (5,798).');
  assert.doesNotMatch(live.words, /closed/);
  assert.equal(moodOf(bars.map((b) => ({ ...b, close: 17.42 })), liveOf(s, '2026-10-16', open)).words, 'The VIX is at 17.4 at 11:05 AM New York time on 16 Oct 2026, still trading (not a close).');
  assert.match(trendOf(bars, liveOf(s, '2026-10-16', after)).words, /^The S&P 500 closed at 6,295 on 16 Oct 2026,/, 'read 30 minutes after 4:00 p.m., the row is a close');
  const settling = new Date('2026-10-16T20:05:00Z'), readEarly = { ...s, fetchedAt: Date.parse('2026-10-16T19:30:00Z') };
  assert.match(trendOf(bars, liveOf(s, '2026-10-16', settling)).words, /^The S&P 500 was at 6,295 when read at 4:05 PM New York time on 16 Oct 2026, before that session's close was final \(not a close\),/, 'five minutes after the close its figures are not final yet');
  assert.match(trendOf(bars, liveOf(readEarly, '2026-10-16', after)).words, /^The S&P 500 was at 6,295 when read at 3:30 PM New York time on 16 Oct 2026, before that session's close was final/, 'rows read before the close are the price then, however late they are shown');
  assert.match(trendOf(bars, liveOf(s, '2026-10-19', new Date('2026-10-19T12:00:00Z'))).words, /^The S&P 500 closed at 6,295 on 16 Oct 2026,/, "before Monday's open, Friday's close");
  const unsure = trendOf(bars, liveOf({ meta: { symbol: '^GSPC' }, bars }, '2026-10-16', open));
  assert.match(unsure.words, /^The S&P 500's latest figure on 16 Oct 2026, read at 11:05 AM New York time, is 6,295 \(Yahoo Finance did not say whether that session had ended\)/, 'no session to tell by: neither "closed" nor "still trading"');
});

test('a news read that fails is named, never "no news today"; the brief names the session its moves are from', async () => {
  const rows = series('2026-10-16', 300);
  configure({ spacingMs: 0, cacheDir: null, fetch: async (input) => {
    const url = String(input), chart = /\/v8\/finance\/chart\/([^?]+)/.exec(url), news = /\/v1\/finance\/search\?q=([^&]+)/.exec(url);
    if (chart) return new Response(JSON.stringify(chartJson(decodeURIComponent(chart[1]!), rows, { currentTradingPeriod: { regular: { start: Date.parse('2026-10-16T13:30:00Z') / 1000, end: Date.parse('2026-10-16T20:00:00Z') / 1000 } } })), { status: 200 });
    if (news && news[1] === 'NVDA') return new Response('Forbidden', { status: 403 });   // NVDA's news cannot be read
    if (news) return new Response(JSON.stringify({ news: [] }), { status: 200 });          // AAPL's can: none today
    return new Response('not found', { status: 404 });
  } });
  const screen = await workScreen(['XLE', 'NVDA', 'AAPL'], new Set(['NVDA', 'AAPL']), '2026-10-16', new Date('2026-10-16T15:00:00Z'));
  assert.deepEqual(screen.news, { read: 1, unread: ['NVDA'] }, 'NVDA is not counted as quiet');
  assert.deepEqual([screen.session, screen.live], ['2026-10-16', true], 'read at 11:00 in New York: the session is still trading');
  const quiet = { ...screen, picks: [] }, dir = desk();
  const brief = morningBrief(dir, '2026-10-16', 5, { screen: quiet, on: false });
  assert.match(brief, /the moves are from the session of 2026-10-16 \(Fri\), read before its close was final: a move so far, not a close\):/);
  assert.match(brief, /- nothing stood out: no move of 3% or more, no volume twice its usual, no 52-week high or low, no cross of an average, no news today about the other companies and coins the person watches\./);
  assert.match(brief, /News could not be read just now for NVDA: whether it is in the news today is not known\. Never say "no news" for it\./);
  const allFailed = morningBrief(dir, '2026-10-16', 5, { screen: { ...quiet, news: { read: 0, unread: ['NVDA', 'AAPL'] } }, on: false });
  assert.doesNotMatch(allFailed, /no news today/, 'no news read at all: nothing is said of news but that it could not be read');
  assert.match(allFailed, /News could not be read just now for NVDA, AAPL: whether they are in the news today is not known/);
  assert.doesNotMatch(morningBrief(dir, '2026-10-16', 5, { screen: { ...quiet, news: undefined }, on: false }), /no news today/, 'a screen kept before news was recorded says nothing about news');
  const mixed = { ...screen, picks: [{ symbol: 'XLE', signals: [], movePct: 4, why: 'Rose 4.0%', session: '2026-10-16' }, { symbol: 'BTC-USD', signals: [], movePct: 5, why: 'Rose 5.0%', session: '2026-10-17' }] };
  assert.match(morningBrief(dir, '2026-10-16', 5, { screen: mixed, on: false }), /- BTC-USD \(session of 2026-10-17 \(Sat\)\): Rose 5\.0%\./, 'moves from different sessions name each one');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'screen.json'), JSON.stringify({ ...quiet, news: { read: 'x' } }));
  assert.equal(readScreen(dir)!.news, undefined, 'a news record that cannot be read is not believed');
  configure({ fetch: globalThis.fetch });
});

test('the morning switch acts on market days only: never on Thanksgiving, and from the day after it when switched on the day before', () => {
  const thanksgiving = desk(), morning = new Date('2026-11-26T14:00:00Z');
  assert.deepEqual(queueTop(thanksgiving, screenOf('2026-11-26', ['XLE']), '2026-11-26', true, morning), [], 'New York is closed on Thanksgiving');
  assert.equal(readDoorbell(thanksgiving), null);
  assert.equal(nextMarketDay('2026-11-25'), '2026-11-27', 'switched on the day before Thanksgiving: it starts on the Friday');
  assert.deepEqual(queueTop(desk(), screenOf('2026-11-27', ['XLE']), '2026-11-27', true, new Date('2026-11-27T14:00:00Z'), '2026-11-27'), ['XLE'], 'and acts that Friday morning');
  assert.deepEqual(queueTop(desk(), screenOf('2027-01-18', ['XLE']), '2027-01-18', true, new Date('2027-01-18T15:00:00Z')), [], 'nor on Martin Luther King Jr. Day');
});

// Audit 3 server-5 (9 Nov 2026): the screen judged a new 52-week high or low on dividend-adjusted rows, where every older
// row is lowered by each later dividend, so a fund that pays (BND, VT, XLU...) was called "a new 52-week high" while still
// below its traded high, and a real new low was missed. The chart beside it shows the prices traded.
test('"Worth a look today" judges a fund at the prices it traded, as its chart shows them: a dividend makes no new 52-week high or low', async () => {
  const day = '2026-10-16', days = weekdays(day, 300), n = days.length;
  // A fund paying 0.21 every 21 sessions: each row's dividend-adjusted close is lowered by the dividends paid after it.
  const fund = (peakAt: number, peak: { c: number; h: number; l: number }, last: { c: number; h: number; l: number }) => days.map((date, i) => {
    const r = i === n - 1 ? last : i === peakAt ? peak : { c: 72, h: 72.05, l: 71.95 };
    return { date, o: r.c, h: r.h, l: r.l, c: r.c, v: 1_000_000, adj: r.c - 0.21 * Math.floor((n - 1 - i) / 21) };
  });
  const high = fund(n - 211, { c: 74, h: 74.05, l: 73.95 }, { c: 72.4, h: 73.45, l: 72.35 });   // traded high 74.05 ten months ago; today's high 73.45
  const low = fund(n - 211, { c: 70.6, h: 70.65, l: 70.5 }, { c: 70.45, h: 71.0, l: 70.4 });    // traded low 70.50 ten months ago; today's low 70.40
  for (const [symbol, rows, want, not] of [['BND', high, null, 'high'], ['XLU', low, 'low', 'high']] as const) {
    configure({ fetch: async () => new Response(JSON.stringify(chartJson(symbol, rows))) });
    const s = await workScreen([symbol], new Set(), day, new Date('2026-10-16T22:00:00Z'));
    const fired = s.picks.flatMap((p) => p.signals.map((x) => x.kind));
    assert.ok(!fired.includes(not), `${symbol}: no new 52-week ${not} (${fired.join(', ')})`);
    if (want) assert.ok(fired.includes(want), `${symbol}: a real new 52-week ${want} is seen`);
    else assert.ok(!fired.includes('high') && !fired.includes('low'), `${symbol}: below its traded high, above its traded low`);
  }
  configure({ fetch: globalThis.fetch });
});
