// The dashboard page's own behaviour, from audit 3 (9 Nov 2026), group G: the words a person reads and what a press does.
// What runs without a browser is run here (the report reader, the days, the chart's hover box); what needs the page
// (the find box, the switches, the dialogs) is checked in its code here and on screen in a look-only copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { markdown } from '../src/terminal/ui/md.js';
import { dayText, when } from '../src/terminal/ui/fmt.js';
import { barsOf, spanText, tipOf, volumeWords, type Bar } from '../src/terminal/ui/bars.js';

const page = fs.readFileSync('src/terminal/ui/main.ts', 'utf8');

/** The report reader run in a worker, so a reader that never ends fails the test instead of hanging it. */
const markdownWithin = (source: string, ms = 3_000): Promise<string> => new Promise((resolve, reject) => {
  const md = new URL('../src/terminal/ui/md.js', import.meta.url).href;
  const w = new Worker(`const { workerData, parentPort } = require('node:worker_threads'); import(workerData.md).then((m) => parentPort.postMessage(m.markdown(workerData.source)));`, { eval: true, workerData: { md, source } });
  const t = setTimeout(() => { void w.terminate(); reject(new Error(`the report reader did not finish within ${ms} ms`)); }, ms);
  w.once('message', (html: string) => { clearTimeout(t); void w.terminate(); resolve(html); });
  w.once('error', (e) => { clearTimeout(t); reject(e); });
});

test('page-6: a report line holding a line separator (U+2028) is read whole, and the call window never freezes', async () => {
  // Agents quote news and filings, where U+2028 turns up; before, a list line or heading holding one looped for ever.
  assert.equal(await markdownWithin('- a quoted headline\u{2028}carried on\n- second'), '<ul><li>a quoted headline carried on</li><li>second</li></ul>');
  assert.equal(await markdownWithin('# A heading\u{2028}with one too\n\nPlain words.'), '<h3>A heading with one too</h3><p>Plain words.</p>');
  assert.equal(await markdownWithin('one\u{2029}two'), '<p>one</p><p>two</p>', 'a paragraph separator ends a paragraph');
  assert.equal(await markdownWithin('1. first\u{2028}more\n2. second'), '<ol><li>first more</li><li>second</li></ol>');
  // whatever a line holds, the reader always moves on
  for (const odd of ['-\u{2028}', '#\u{2028}', '- \u{2028} \u{2029}', '\u{2028}\u{2028}', '| a |\u{2028}| --- |', '*\u{2028}*\u{2028}*']) assert.equal(typeof await markdownWithin(odd), 'string', JSON.stringify(odd));
  assert.equal(markdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>', 'plain lists as before');
});

test('page-8: a full time is shown on the person\'s own day, a market day as it is', () => {
  const was = process.env.TZ;
  try {
    process.env.TZ = 'America/Chicago';
    // asked at 8:30 PM on Fri 6 Nov in Chicago, which is 7 Nov in UTC
    assert.equal(dayText('2026-11-07T02:30:00.000Z'), '6 Nov 2026');
    assert.equal(dayText('2026-11-07T01:30:00.123456+00:00'), '6 Nov 2026', "Robinhood's times, with microseconds");
    assert.match(when('2026-11-07T02:30:00.000Z', new Date('2026-11-09T15:00:00Z')), /^Fri 6 Nov, /, 'the same day the finished line names');
    assert.equal(dayText('2026-11-07'), '7 Nov 2026', 'a market day is that day wherever the person is');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(dayText('2026-11-06T16:30:00Z'), '7 Nov 2026', 'east of UTC, the next morning');
    assert.equal(dayText('2026-11-06'), '6 Nov 2026');
    assert.equal(dayText('not a time'), 'not a time');
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

const bar = (date: string, o: number, c: number, v: number | null = 1_000_000): Bar => ({ date, label: date, o, h: Math.max(o, c), l: Math.min(o, c), c, v });

test('page-9: the chart\'s hover box gives the move from the close before, in points for a yield, names a five-day bar\'s days, and words its volume', () => {
  const days = [bar('2026-11-05', 99, 100), bar('2026-11-06', 101, 103, 46_000)];
  const fri = tipOf(days, 1);
  assert.match(fri, /6 Nov 2026/);
  assert.match(fri, />\+3\.00%</, "the day's move, from Thursday's close of 100: not +1.98% from Friday's own open");
  assert.match(fri, /title="From the close of 5 Nov 2026"/);
  assert.match(fri, /<dt>Volume<\/dt><dd>46K<\/dd>/, 'not "0.0M"');
  assert.doesNotMatch(tipOf(days, 0), /%/, 'the first bar drawn has no close before it here: no move rather than one from its open');
  const yieldDays = [bar('2026-11-05', 4.07, 4.08, 0), bar('2026-11-06', 4.09, 4.10, 0)];
  assert.match(tipOf(yieldDays, 1, '%'), />\+0\.02 points</, 'a yield moves in points, never a percent of a percent');
  assert.match(tipOf(yieldDays, 1, '%'), /<dt>Volume<\/dt><dd>not given<\/dd>/, 'a yield has no volume');
  assert.deepEqual([volumeWords(null), volumeWords(950), volumeWords(43_000_000), volumeWords(1_234_567_890)], ['not given', '950', '43M', '1.2B']);
  // five years are drawn five trading days a bar: the box names the days a bar spans, its open the first's, its close the last's
  const daily = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const h = { symbol: 'NVDA', range: '5Y', bars: daily.map((date, i) => ({ date, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1_000 })), ma50: daily.map(() => null), ma200: daily.map(() => null) } as unknown as Parameters<typeof barsOf>[0];
  const { bars } = barsOf(h);
  assert.deepEqual(bars.map((b) => [b.from, b.date, b.o, b.c]), [['2026-10-26', '2026-10-30', 100, 104.5], ['2026-11-02', '2026-11-06', 105, 109.5]]);
  const week = tipOf(bars, 1);
  assert.match(week, /2 Nov to 6 Nov 2026/);
  assert.match(week, />\+4\.78%</, 'the move over those days, from the close before them (104.5 to 109.5)');
  assert.match(week, /<dd>5K<\/dd>/, 'the volume of the five days together');
  assert.deepEqual([spanText('2025-12-29', '2026-01-02'), spanText('2026-10-26', '2026-10-30')], ['29 Dec 2025 to 2 Jan 2026', '26 Oct to 30 Oct 2026']);
  // and the chart uses it, told the yield's unit
  const chart = fs.readFileSync('src/terminal/ui/chart.ts', 'utf8');
  assert.match(chart, /tip\.innerHTML = tipOf\(bars, i, o\.unit\)/);
  assert.doesNotMatch(chart, /b\.c \/ b\.o - 1|1e6\)\.toFixed/);
  assert.match(page, /heroChart\(svg, tip, h, \{ kind: S\.kind, layers: S\.layers, unit: marketOf\(sym\)\?\.unit \}\)/);
});

test('page-1: "Add to watchlist" adds the match the list marks, as Enter does, never the typed words', () => {
  // Before: the button took the focus, the list closed, and "Apple" was tried as APPLE (refused) and "Ford" added FORD.
  assert.match(page, /\$\('#addForm button\[type="submit"\]'\)\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/, 'pressing the button keeps the list and its marked row');
  assert.match(page, /const listed = F\.found === q \? F\.matches : null;/, "the list's matches for exactly these words");
  assert.match(page, /listed\[F\.active >= 0 && F\.active < listed\.length \? F\.active : markedOf\(listed, q\)\] \?\? null : await findNow\(q\)/, 'the marked one, else waits for the matches');
  // a company typed by its name marks Yahoo's own first match ("Ford" is Ford Motor, F); a ticker typed as one marks itself
  assert.match(page, /const markedOf = \(matches: readonly Match\[\], q: string\): number => \(!matches\.length \? -1 : Math\.max\(0, q === q\.toUpperCase\(\) \? matches\.findIndex\(\(m\) => m\.symbol === q\) : -1\)\)/);
  assert.match(page, /F\.active = markedOf\(matches, q\)/);
});

test('page-3: the morning switch is drawn only once the page knows whether it is on, and a press never re-arms it', () => {
  assert.match(page, /MORNING\.on = kept\.morning === true; MORNING\.from = MORNING\.on \? kept\.morningFrom \?\? '' : ''; MORNING\.known = true;/, 'read with the remembered choices at load, not only from the slow first look of the day');
  assert.match(page, /const sw = !MORNING\.known \?/, 'until then no switch is drawn, so none can read "off"');
  assert.match(page, /Reading whether/);
  assert.match(page, /case 'morning-switch': if \(!MORNING\.known\) break;/);
});

test('page-4: only a press on the shade around a dialog closes it, never one on its own padding or the gaps inside it', () => {
  assert.doesNotMatch(page, /e\.target === dlg\)|e\.target === \$\('#(ticket|stop|gloss)Dialog'\)/);
  assert.match(page, /const onShade = \(e: MouseEvent, dlg: Element\): boolean =>/);
  for (const id of ['callDialog', 'ticketDialog', 'stopDialog', 'glossDialog']) assert.match(page, new RegExp(`onShade\\(e, \\$\\('#${id}'\\)\\)|onShade\\(e, dlg\\)`), id);
  assert.match(page, /e\.clientX < r\.left \|\| e\.clientX > r\.right \|\| e\.clientY < r\.top \|\| e\.clientY > r\.bottom/);
});

test('page-11: the starred side list words a move as the watchlist does: points for a yield, and its day when not today', () => {
  assert.doesNotMatch(page, /<small>\$\{q \? pct\(q\.changePct\) : ''\}<\/small>/);
  assert.match(page, /<small>\$\{q \? sideMove\(q\) : ''\}<\/small>/);
  assert.match(page, /const sideMove = \(q: Quote\): string => \{ const day = moveDayOf\(q\.asOf\); return q\.changePct === null \? '—' : `\$\{moveText\(q\)\}\$\{day \? ` · \$\{chipDay\(day\)\}` : ''\}`; \};/);
  // the yields' unit comes with the markets; when they come after the prices, the moves are written again
  assert.match(page, /S\.markets = \(await api\.markets\(\)\)\.markets; renderMarkets\(\); renderHero\(\); renderFavs\(\); renderWatch\(\);/);
});

test('page-12: the stock page says which of the Agentic account\'s orders it read, never "no orders" from a cut list', () => {
  assert.doesNotMatch(page, /No orders on \$\{esc\(sym\)\} in the Agentic account\./);
  // what Robinhood listed and how many of them the dashboard reads: never "the latest", as nothing says its list is by time
  assert.match(page, /among the \$\{shown\} the dashboard reads of the \$\{count\} orders Robinhood listed for the Agentic account at \$\{esc\(at\)\}/);
  assert.match(page, /\$\{restWords\}, so \$\{rest === 1 \? 'it' : 'one of them'\} may be/);
  assert.match(page, /`the other \$\{rest\} are not read here`/);
  assert.match(page, /Read from \$\{shown\} of the \$\{count\} orders Robinhood listed at \$\{esc\(at\)\}: \$\{restWords\}/, 'and under the orders it shows');
  assert.doesNotMatch(page, /the latest \$\{shown\}/);
  assert.match(page, /The dashboard reads the Agentic account's stock and fund orders only, so a coin's orders are not shown here\./);
});

test('page-15: the page saves only the choices that changed, so an older tab cannot undo another tab\'s', () => {
  assert.doesNotMatch(page, /api\.savePrefs\(P\)/, 'never the whole of what this tab remembers');
  assert.match(page, /const send = \{ \.\.\.unsent \};/);
  assert.match(page, /void api\.savePrefs\(send\)/);
  assert.match(page, /remember\(\{ \.\.\.P \}\)/, "the first visit after an update still keeps this browser's older choices in the desk's folder");
});

test('call window: a stock is named only by its own name, never by the one charted, else by its ticker alone', () => {
  // Before: with no quote of AAPL loaded and Shiba Inu charted, AAPL's call read "AAPL · Shiba Inu USD · the desk's call of …".
  assert.doesNotMatch(page, /\?\? S\.history\?\.name \?\?/, "the chart's name for whatever stock it shows");
  assert.match(page, /const nameOf = \(sym: string\): string => quoteOf\(sym\)\?\.name \?\? \(S\.history\?\.symbol === sym \? S\.history\.name : undefined\) \?\? marketOf\(sym\)\?\.name \?\? sym;/);
  // a call on a stock whose name is not known says the ticker once, in the title, and not again beside it
  assert.match(page, /const named = nameOf\(symbol\), of = `the desk's call of \$\{dayText\(date\)\}`;/);
  assert.match(page, /\$\{esc\(named !== symbol \? `\$\{named\} · \$\{of\}` : of\[0\]!\.toUpperCase\(\) \+ of\.slice\(1\)\)\}/);
});

test('server-11: the Analyse box offers the settings\' own rounds first and asks for them with no depth; Retry asks at the depth first asked', async () => {
  const { depthChoices, retryDepth } = await import('../src/terminal/ui/depth.js');
  // A desk that says its settings' rounds keeps an analysis asked with no depth at exactly those rounds (2 and 3 here,
  // which no depth is): offered first and chosen, then the three depths.
  const said = depthChoices({ depth: 'shallow', rounds: { debate: 2, risk: 3 } });
  assert.deepEqual(said.choices.map((c) => [c.depth, c.label]), [[null, 'Settings (2 and 3 rounds)'], ['shallow', 'Shallow'], ['medium', 'Medium'], ['deep', 'Deep']]);
  assert.equal(said.first, null, 'the settings chosen first, sent as no depth');
  assert.equal(said.choices[0]!.means, "The rounds in the desk's settings when it runs, now 2 rounds of the bull and bear debate and 3 of the risk debate.");
  assert.equal(depthChoices({ depth: 'shallow', rounds: { debate: 1, risk: 1 } }).choices[0]!.means, "The rounds in the desk's settings when it runs, now one round of the bull and bear debate and one of the risk debate.");
  // A desk that does not say them turns a request with no depth into the nearest depth, so the page offers only the
  // three, the nearest chosen, as before: no "Settings" it could not keep.
  const unsaid = depthChoices({ depth: 'medium' });
  assert.deepEqual(unsaid.choices.map((c) => c.label), ['Shallow', 'Medium', 'Deep']);
  assert.equal(unsaid.first, 'medium');
  // Retry asks again exactly as first asked: at its depth, or with none (the settings' own rounds), never the nearest depth
  assert.equal(retryDepth({ depth: 'deep' }), 'deep');
  assert.equal(retryDepth({}), undefined);
  assert.equal(retryDepth(undefined), undefined);
  assert.doesNotMatch(page, /api\.enqueue\(sym, x\?\.depth \?\? S\.desk\?\.analyses\.depth/, 'before: Retry asked a Settings one again at the nearest depth');
  assert.match(page, /await api\.enqueue\(sym, retryDepth\(x\)\)/);
  assert.match(page, /ASK\.depth = depthChoices\(S\.desk\?\.analyses \?\? \{ depth: 'shallow' \}\)\.first;/);
  assert.match(page, /await api\.enqueue\(sym, ASK\.depth \?\? undefined\);/);
  assert.match(fs.readFileSync('src/terminal/ui/api.ts', 'utf8'), /enqueue: \(symbol: string, depth\?: Depth\) => call<\{ queue: QueueView\[\] \}>\('POST', '\/api\/queue', depth \? \{ symbol, depth \} : \{ symbol \}\)/, 'no depth sent at all for the settings');
});

test('page-16 (dashboard tour, 11 Nov 2026): the account page keeps its rows apart, its cards at their own height, and its caps in four rows in both views', () => {
  const css = fs.readFileSync('src/terminal/ui/dashboard.css', 'utf8'), html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  // The side list's account block: every row is marked while the account page is open, and marked rows touched.
  assert.match(css, /#sideAccount > \.at-li \+ \.at-li \{ margin-top: var\(--space-1\); \}/, 'a small space between the account block\'s rows');
  // The Robinhood and Trading cards were stretched to one height, with Check again and Disconnect pushed to the foot of the taller card.
  const pair = /<div class="([^"]*)">\s*<div class="at-card at-box" id="accountCard">/.exec(html);
  assert.ok(pair, 'the two account cards stand in one row');
  assert.doesNotMatch(pair[1]!, /ta-even/, 'each card is as tall as its own words');
  // The caps: what they apply to, said once and in both views; four rows by what a limit is for; the seven fields of one size.
  assert.match(page, /const CAPS_SCOPE = 'These limits apply to orders you place from this page, not to trades you make in the Robinhood app\.';/);
  assert.equal([...page.matchAll(/\$\{CAPS_SCOPE\}/g)].length, 2, 'the chips view and the edit view both say it');
  for (const row of ['Buys', 'Buys and sells', 'Sells', 'The account']) assert.equal([...page.matchAll(new RegExp(`capRow\\('${row}'`, 'g'))].length, 2, `${row}: a row in the chips view and in the edit view`);
  for (const id of ['capOrder', 'capStock', 'capSector', 'capCrypto', 'capDay', 'capHold', 'capWeek']) assert.match(page, new RegExp(`field\\('${id}'`), `${id} is a field of the edit view`);
  assert.match(css, /\.ta-capfields \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'fields of one width, two to a line');
  assert.match(css, /\.ta-capfields > \.at-field \{ justify-content: flex-end; \}/, 'a label that wraps grows upwards, so the fields stay level');
  // The short words: the old paragraph ("kept beside the trading switch, where agents are refused") is gone, and no folder is named.
  assert.doesNotMatch(page, /where agents are refused|The most an order may cost/);
  assert.match(page, /Every ticket is checked against them, and again just before it is sent; a failed check stops the order\. Only you can change them, and the agents are blocked from where they are kept\./);
  assert.doesNotMatch(page, /trading-agents|private folder/i, 'the page never names the private folder');
});

test('page-17 (dashboard tour, 11 Nov 2026): the Accounts section keeps only status: no explaining lines, the phone approval as a chip, one read time, and orders in plain words', () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  // The owner marked these as unnecessary: each is gone, and nothing but a failure keeps a line under an account.
  for (const gone of ['The accounts you chose to show', 'Nothing is held in this account', 'Keep it on until you trust the desk', "holdings valued at Robinhood's live prices", 'now see these holdings when they analyse a stock', 'is kept on this computer only and is never shown on this page']) {
    assert.ok(!page.includes(gone) && !html.includes(gone), `"${gone}" is gone`);
  }
  assert.match(html, /<h2>Accounts<\/h2><\/div><\/div>/, 'the Accounts heading has no line under it');
  // The phone approval is a status chip, marked when it is off; a pending approval is a chip of its own.
  assert.match(page, /mark\('Phone approval: not read', "Robinhood's phone approval setting could not be read\."\)/);
  assert.match(page, /mark\('Phone approval: on', .*'ok'\)/);
  assert.match(page, /mark\('Phone approval: off', .*You can switch phone approval on in the Robinhood app\.", 'warn'\)/);
  assert.match(page, /mark\(`\$\{ap\.pending\} waiting for your approval`/);
  // How fresh the figures are: one read time, small, beside the Refresh button, never one more line in each card.
  assert.match(page, /<span class="at-quiet">Read at \$\{esc\(when\(A\.snapshot\.at\)\)\}<\/span>/);
  assert.match(page, /A\.snapshot\.views\.map\(viewCard\)/);
  // The agents' holdings: said only when the read was not whole.
  assert.match(page, /A\.snapshot && A\.shared === false \? '<p class="at-honest">Some holdings could not be read, so the agents were not given this read: they keep the last complete one\.<\/p>'/);
  // Both tables of orders (an account's, a stock's) are one function: Robinhood's raw word is never the cell, and orders still open come first.
  assert.equal([...page.matchAll(/ordersTable\(/g)].length, 3, 'defined once, used for the account card and the stock page');
  assert.doesNotMatch(page, /esc\(x\.state \?\? '—'\)/, "Robinhood's raw state word is not what the table shows");
  assert.match(page, /\[\.\.\.orders\]\.sort\(\(a, b\) => Number\(open\(b\)\) - Number\(open\(a\)\)\)/);
  assert.match(page, /<th class="num" title="\$\{esc\(NOTES\.orderPrice\)\}">Price<\/th>/, 'the Price heading says which price it is');
  // The lines that appear only when something failed stay.
  for (const kept of ['The orders could not be read.', 'Not read: ', 'holding(s) could not be read and are left out.']) assert.ok(page.includes(kept), kept);
});
