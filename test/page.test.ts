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

test('page-19: The whole market is changed only from the search box and the tiles: no typed list, no Change… button, and no word that points at them', () => {
  // Before: "Change…" opened a field for up to eight tickers typed with commas and no suggestions, beside the search box at the top.
  for (const gone of [/mkInput/, /mk-edit/, /mk-cancel/, /mk-save/, /marketEditor/, /separated by commas/, /Press Change… to add/, /MK\.editing/, /Choose the broad funds this tier shows/]) assert.doesNotMatch(page, gone, String(gone));
  assert.match(page, /market: 'The whole market is empty\. Search a fund in the box at the top, such as SPY, and press Show in The whole market\.',/);
  assert.match(page, /<p class="at-quiet">✕ takes a fund out of this row\. To add one, search for it in the box at the top and press Show in The whole market\.<\/p>/);
  // every save goes through the desk's own, which checks each fund's price (and the desk's rules) before it keeps the row
  assert.equal((page.match(/api\.setMarket\(/g) ?? []).length, 1);
  assert.match(page, /case 'mk-remove': if \(S\.desk\) void saveMarketList\(S\.desk\.market\.symbols\.filter\(\(s\) => s !== sym\)\); break;/);
  assert.match(page, /case 'mk-shipped': void saveMarketList\(\[\.\.\.\(S\.desk\?\.market\.shipped \?\? \[\]\)\]\); break;/);
  // ✕ only on a tile of The whole market; "Put back" only while the row is not the four the desk ships
  assert.match(page, /\(tier === 'market' \? `<button class="icon-btn" data-act="mk-remove" data-symbol="\$\{esc\(i\.symbol\)\}" title="\$\{esc\(out\)\}" aria-label="\$\{esc\(out\)\}"><svg class="g"><use href="#i-x"\/><\/svg><\/button>` : ''\)/);
  assert.match(page, /const out = `Take \$\{i\.symbol\} out of The whole market`;/);
  assert.match(page, /t\.tier === 'market' && !market\.asShipped \? `<button class="at-btn at-press" data-act="mk-shipped">Put back \$\{esc\(listWords\(market\.shipped\)\)\}<\/button>` : ''/);
  // each save sends the whole row as the page last read it, so a press made while one is being saved waits to be pressed again
  assert.match(page, /if \(MK\.saving\) \{ toast\('The whole market is still being saved\. Press again in a moment\.', 'bad'\); return; \}/);
  assert.match(page, /\} finally \{ MK\.saving = false; \}/);
  // the other "Change…" buttons stay: the SEC contact email's and the paper money's
  assert.match(page, /data-act="contact-edit">Change…/);
  assert.match(page, /data-act="paper-edit">Change…/);
});

test('page-20: a fund in the search list gets "Add to watchlist" and "Show in The whole market"; one in the row, or a full row, says so; Shift+Enter does what the button does', () => {
  assert.match(page, /import \{ marketOffer, type MarketOffer \} from '\.\/marketpick\.js';/);
  assert.match(page, /return marketOffer\(r, d\.market\.symbols, new Set\(d\.startHere\.find\(\(t\) => t\.tier === 'sectors'\)\?\.items\.map\(\(i\) => i\.symbol\)\), d\.market\.max\);/);
  assert.match(page, /const add = watched \? '' : `<button type="button" class="at-btn at-press" data-act="find-pick" data-i="\$\{i\}">Add to watchlist<\/button>`;/);
  assert.match(page, /offer === 'show' \? `<button type="button" class="at-btn at-press" data-act="find-market" data-i="\$\{i\}">Show in The whole market<\/button>`/);
  assert.match(page, /: offer === 'in' \? '<span class="at-chip">In The whole market<\/span>'/);
  assert.match(page, /const marketFull = \(max: number\): string => `The whole market already holds \$\{max\} funds: take one out to make room\.`;/);
  // the second press keeps the fund in the row alone, last; it never puts it on the watchlist
  assert.match(page, /void saveMarketList\(\[\.\.\.d\.market\.symbols, r\.symbol\]\);/);
  assert.match(page, /if \(e\.shiftKey\) showInMarket\(rows\[F\.active\]!\); else pick\(rows\[F\.active\]!\);/);
  assert.match(page, / to your watchlist · Shift\+Enter to show it in The whole market/, 'the line under the list says it only for a fund the row can take');
  // a press on a button inside a row is that button's, never the row's: the closest [data-act] is the button itself
  assert.match(page, /case 'find-market': \{ const r = findRows\(\)\[Number\(el\.dataset\.i\)\]; if \(r\) showInMarket\(r\); break; \}/);
  // two buttons, drawn on a phone as on a desktop: nothing waits for a hover, and the phone's rule hides only the tags
  const css = fs.readFileSync('src/terminal/ui/dashboard.css', 'utf8');
  assert.match(css, /\.ta-opt-do \{ grid-column: 2 \/ -1;/);
  assert.doesNotMatch(css, /\.ta-opt-do[^{}]*:hover/);
  assert.doesNotMatch(css, /\.ta-opt-do[^{}]*\{[^}]*display: none/);
  assert.match(css, /@media \(max-width: 640px\) \{ \.ta-opt \{ grid-template-columns: calc\(var\(--unit\) \* 18\) minmax\(0, 1fr\); \} \.ta-opt-tags \{ display: none; \} \}/);
});

test('page-21: a Start here tile is three lines, the same on every tile (name; code and move; rating and presses), with a letter badge, what leaves it is said when it is pointed at, and a badge is shaded only by the kind Yahoo gives', () => {
  // the badge: the House's logo box holding letters, no picture, so nothing is fetched from outside (the page's policy allows images from this computer only)
  assert.match(page, /const badge = \(sym: string, kind: Kind\): string => `<span class="at-logo-box sm ta-badge\$\{kind \? ` \$\{kind\}` : ''\}"><span class="at-logo fallback">\$\{esc\(badgeLetters\(sym\)\)\}<\/span><\/span>`;/);
  assert.doesNotMatch(page, /<img\b/, 'no picture from anywhere');
  assert.match(page, /const badgeLetters = \(sym: string\): string => \(cryptoBase\(sym\) \?\? sym\.replace\(\/\^\\\^\/, ''\)\.split\(\/\[-\.=\]\/\)\[0\] \?\? sym\)\.slice\(0, 4\)\.toUpperCase\(\);/, 'BTC for BTC-USD, BRK for BRK-B, at most four letters');
  // a kind only from Yahoo's own word on the quote (a company, a fund or a coin; anything else says none); with no price yet, or a failed one, a tile in The whole market or Sectors is a fund as its row says, and nothing else is anything
  assert.match(page, /type Kind = QuoteKind \| '';/);
  assert.match(page, /const q = quoteOf\(sym\);\n {2}if \(q\) return q\.kind \?\? '';/);
  assert.match(page, /return at === 'market' \|\| at === 'sectors' \? 'fund' : '';/);
  assert.doesNotMatch(page, /isCrypto\(sym\)\) return 'coin'/, 'no kind is read from how a ticker looks');
  // the tile: badge, name and move; then the rating or "no call", and the presses. The old second line and its chips are gone from the tile.
  assert.match(page, /<button class="ta-tier-go" data-act="select" data-symbol="\$\{esc\(i\.symbol\)\}" title="\$\{words\}"><b class="at-tile-name">\$\{esc\(name\)\}<\/b><\/button>/, 'line 1: the name, in full');
  assert.match(page, /<span class="ta-tile-id">\$\{badge\(i\.symbol, kindOf\(i\.symbol, tier\)\)\}\$\{changeChip\(q\)\}<\/span>/, 'line 2: the code and the day\'s move');
  assert.match(page, /const call = i\.call \? ratingChip\(i\.call\.rating\) : `<span class="at-quiet" title="\$\{esc\(means\('call'\)\)\}">no call<\/span>`;/);
  assert.match(page, /<div class="ta-tile-row">.*<span class="ta-tile-rate">\$\{call\}<\/span><span class="at-tail">\$\{ask\}<\/span><\/div>/, 'line 3: the rating, then the robot, + and ✕ side by side');
  const css0 = fs.readFileSync('src/terminal/ui/dashboard.css', 'utf8');
  assert.match(css0, /\.ta-tile-row \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "id id" "rate tail";/, 'three lines on every tile, whatever the rating or the presses');
  assert.match(css0, /\.ta-tier-tile \.at-tail \{ grid-area: tail; gap: 0; flex-wrap: nowrap; \}/, 'the presses side by side, no gap, never wrapped apart');
  assert.match(css0, /\.ta-tier-tile \.at-tile-name \{ white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: break-word; \}/, 'a name is never cut with …');
  assert.doesNotMatch(css0, /ta-tiles-[ab]|PROTOTYPE/);
  const tile = /function tierTile\([\s\S]*?\n\}\n/.exec(page)![0];
  assert.doesNotMatch(tile, /at-tile-sub|noTicketChip|no call yet/, 'the tile writes no sub line, no order-ticket chip and no date');
  // what left the tile is in its hover (the tile and its button, which is its accessible description): name, ticker and meaning, the call with its day, and why no ticket
  const words = /function tileWords\([\s\S]*?\n\}\n/.exec(page)![0];
  for (const kept of [/\n {4}name,/, /\$\{i\.symbol\}\$\{i\.meaning \? ` · \$\{i\.meaning\}` : ''\}/, /The desk's latest call: \$\{i\.call\.rating\}, \$\{dayText\(i\.call\.date\)\}\./, /The desk has made no call on it yet\./, /\$\{means\('paper'\)\} \$\{NOTES\.coinOnPaper\}`? : NOTES\.noTicket/]) assert.match(words, kept, String(kept));
  assert.match(page, /<div class="at-tile at-box ta-tier-tile\$\{i\.symbol === S\.symbol \? ' on' : ''\}" title="\$\{words\}">/);
  assert.match(page, /<button class="ta-tier-go" data-act="select" data-symbol="\$\{esc\(i\.symbol\)\}" title="\$\{words\}">/);
  // Worth a look takes the same badge and keeps its words
  assert.match(page, /<span class="ta-tier-top">\$\{badge\(p\.symbol, kindOf\(p\.symbol\)\)\}<b class="at-tile-name">\$\{esc\(name\)\}<\/b>\$\{move\}<\/span><span class="at-tile-sub">\$\{esc\(p\.symbol\)\} · \$\{esc\(p\.why\)\}<\/span>/);
  // the shorter words: the subtitle and the line under the tiers, with the dotted words and the advice line kept
  assert.match(fs.readFileSync('src/terminal/ui/index.html', 'utf8'), /<h2>Start here<\/h2><p>The broadest first\. Press a tile to chart it; the robot asks the desk to analyse it and \+ adds it to your watchlist\.<\/p>/);
  assert.match(page, /\$\{term\('today'\)\} is the change over the latest trading day; a dash is a price Yahoo Finance did not give\. Each \$\{term\('call', 'call'\)\} is the desk's rating, Buy to Sell; a \$\{term\('fund', 'fund'\)\} holds many companies at once\. Nothing here is investment advice\./);
  // the style: a shade for a fund and one for a coin, the neutral box for the rest; nothing shown only on a hover
  const css = fs.readFileSync('src/terminal/ui/dashboard.css', 'utf8');
  assert.match(css, /\.ta-badge\.fund \{ background: var\(--accent-tint\); \}/);
  assert.match(css, /\.ta-badge\.coin \{ background: color-mix\(in srgb, var\(--warn\) 18%, transparent\); \}/);
  assert.match(css, /\.ta-badge\.company \{ background: color-mix\(in srgb, var\(--file-page\) 18%, transparent\); \}/);
  assert.doesNotMatch(css, /\.ta-tier-tile[^{}]*:hover[^{}]*\{[^}]*display/, 'nothing is shown only on a hover');
});

test('page-22: the Overview runs Markets, Start here, the Chart, the stock page, the watchlist, Analyses and the calls, and the side list and rail follow it; a press on the page brings the chart into view, and nothing else does', () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  const overview = html.slice(html.indexOf('id="view-overview"'), html.indexOf('id="view-today"'));
  const ids = [...overview.matchAll(/<section class="at-section[^"]*" id="(sec-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['sec-guide', 'sec-today', 'sec-care', 'sec-markets', 'sec-start', 'sec-chart', 'sec-stock', 'sec-watch', 'sec-analyses', 'sec-calls']);
  // the side list and the rail jump to the same headings in the same order, and every jump lands on a heading that exists
  const jumps = (from: string) => [...from.matchAll(/data-act="goto" data-to="(sec-[a-z]+)"/g)].map((m) => m[1]!);
  const side = html.slice(html.indexOf('id="sideOpen"'), html.indexOf('id="sideFolded"')), rail = html.slice(html.indexOf('id="sideFolded"'), html.indexOf('<div class="main-col">'));
  const want = ['sec-start', 'sec-chart', 'sec-stock', 'sec-watch', 'sec-analyses', 'sec-calls'];
  assert.deepEqual(jumps(side), want);
  assert.deepEqual(jumps(rail), want);
  for (const id of new Set([...jumps(html), ...[...page.matchAll(/data-to="(sec-[a-z]+)"/g)].map((m) => m[1]!)])) assert.ok(ids.includes(id), `${id} is a heading on the page`);
  assert.deepEqual(want, ids.filter((x) => want.includes(x!)), 'the same order as the page');
  // a press brings the chart into view: asked before charting (which draws the tiles again, so the pressed one is gone), unless all of it is on screen, smoothly unless motion is reduced
  assert.match(page, /const shows = !!el\.closest\('#page, #sideOpen'\);\n {6}select\(sym\);\n {6}if \(shows\) \{ if \(view !== 'overview'\) showView\('overview'\); showChart\(\); \}/, 'a press on the page or on a side-list star: the Overview first if Your account is showing, then the chart');
  assert.match(page, /if \(at\.top >= page\.top && at\.bottom <= page\.bottom\) return;/);
  assert.match(page, /c\.scrollIntoView\(\{ behavior: matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth', block: 'start' \}\);/);
  // never from putting back the last stock, from the page opening, from adding a stock, or from the search list: only from a press on a tile, a row or a star in the side list
  assert.equal((page.match(/showChart\(\)/g) ?? []).length, 2, 'the definition and the one press');
  assert.match(page, /<button class="at-li \$\{w\.symbol === S\.symbol \? 'on' : ''\}" data-act="select" data-symbol=/, 'a side-list star presses through the same act');
  assert.match(fs.readFileSync('src/terminal/ui/index.html', 'utf8'), /<div class="at-list small" id="favs"><\/div>/);
  assert.ok(fs.readFileSync('src/terminal/ui/index.html', 'utf8').indexOf('id="favs"') < fs.readFileSync('src/terminal/ui/index.html', 'utf8').indexOf('id="sideFolded"'), 'the stars are in the open side list, #sideOpen');
  assert.doesNotMatch(/function select\([\s\S]*?\n\}\n/.exec(page)![0], /showChart/);
  // the tiles, Markets, Worth a look and the watchlist rows all press through the same act
  assert.equal((page.match(/data-act="select"/g) ?? []).length, 5, 'the side list star, a Markets tile, a watchlist row, a Start here tile and a Worth a look tile');
});

test("page-23: Today's market is a page of its own, opened from the side list and the rail like Your account, remembered, and fed by the one hourly refresh whichever page shows", () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  const today = html.slice(html.indexOf('id="view-today"'), html.indexOf('id="view-account"'));
  // the page: its heading and subtitle, the two cards as they were, and a way back; hidden until opened
  assert.match(html, /<div class="at-page-col" id="view-today" hidden>/);
  assert.match(today, /<h1 class="page-title">Today's <em>market\.<\/em><\/h1>/);
  assert.match(today, /<p class="page-sub">What ground the market is on, and what moved in a way worth reading about: worked out from figures once an hour, never a forecast\.<\/p>/);
  assert.match(today, /id="weatherCard"/);
  assert.match(today, /id="lookCard"/);
  assert.match(today, /data-act="view" data-view="overview"/);
  // the cards are in no other place, and the Overview has no This morning section or jump to one
  assert.equal((html.match(/id="weatherCard"/g) ?? []).length, 1);
  assert.equal((html.match(/id="lookCard"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /sec-morning|This morning/);
  assert.doesNotMatch(page, /sec-morning|data-to="sec-morning"/, 'no link in the page opens a section that is gone');
  // the side list and the rail each have the button that opens it, marked as current while it shows
  assert.match(html, /<button class="at-li" data-act="view" data-view="today" id="navToday">.*<span class="at-li-t">Today's market<\/span><\/button>/);
  assert.match(html, /<button class="icon-btn" data-act="view" data-view="today" id="railToday" aria-label="Today's market" title="Today's market">/);
  assert.match(page, /for \(const \[id, page\] of \[\['#navOverview', 'overview'\], \['#navToday', 'today'\], \['#railToday', 'today'\], /);
  assert.match(page, /\$\('#view-today'\)\.hidden = v !== 'today';/);
  assert.match(page, /\$\('#railToday'\)\.classList\.toggle\('on', v === 'today'\);/);
  assert.match(page, /case 'view': showView\(VIEWS\.find\(\(v\) => v === el\.dataset\.view\) \?\? 'overview'\); break;/, "the page opens whichever of the four it is asked for (the desk's own list)");
  assert.match(page, /const VIEWS: readonly View\[\] = \['overview', 'account', 'today', 'score'\];/);
  // remembered, and put back where the person left it, like the account page (the desk's prefs accept the new page: terminal.test)
  assert.match(page, /if \(P\.view && P\.view !== 'overview'\) showView\(P\.view, false\);/);
  assert.match(fs.readFileSync('src/terminal/prefs.ts', 'utf8'), /one\(r\.view, \['overview', 'account', 'today', 'score'\] as const\)/);
  // a press on a Worth a look pick charts it from the Overview, as a side-list star does; its robot keeps its own act
  assert.match(page, /<button class="ta-look-go" data-act="select" data-symbol="\$\{esc\(p\.symbol\)\}"/);
  assert.match(page, /\$\{isOpen\(p\.symbol\) \? openChip\(p\.symbol\) : robot\(p\.symbol\)\}/);
  assert.match(page, /const shows = !!el\.closest\('#page, #sideOpen'\);/);
  // the weather and the screen are asked for once when the page opens and once an hour after, whichever page shows, and nowhere else
  assert.equal((page.match(/api\.weather\(\)/g) ?? []).length, 1);
  assert.equal((page.match(/api\.screen\(\)/g) ?? []).length, 1);
  assert.equal((page.match(/void loadMorning\(\)/g) ?? []).length, 2, 'at the start, and by the hourly timer');
  assert.match(page, /setInterval\(\(\) => void loadMorning\(\), 60 \* 60_000\);/);
  assert.doesNotMatch(page, /case 'view':[^\n]*loadMorning/, 'opening the page asks for nothing again');
});

test('page-24: "How the desk is doing" is a page of its own with both cards, opened from the side list and the rail, remembered, saying in words that it runs by itself, and loading as it did', () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  const score = html.slice(html.indexOf('id="view-score"'), html.indexOf('id="view-account"'));
  // the page: its heading (the scorecard's dotted word kept), a subtitle written by the page from what the desk holds, the counts, the paper money control, a way back
  assert.match(html, /<div class="at-page-col" id="view-score" hidden>/);
  assert.match(score, /<h1 class="page-title"><span class="ta-term" data-term="scorecard">How the desk is <em>doing\.<\/em><\/span><\/h1>/);
  for (const id of ['scoreIntro', 'scoreSub', 'paperDo', 'paperCard', 'score']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `${id} is on the page once`);
  assert.ok(['scoreIntro', 'scoreSub', 'paperDo', 'paperCard'].every((id) => score.includes(`id="${id}"`)) && score.includes('id="score"'), 'all of it is on the new page');
  assert.match(score, /data-act="view" data-view="overview"/);
  // nothing of it stays in the Overview, and no link goes to a section that is gone
  assert.doesNotMatch(html, /sec-score/);
  assert.doesNotMatch(page, /sec-score/);
  assert.match(page, /<button class="at-btn at-press" data-act="view" data-view="score"><svg class="g"><use href="#i-target"\/><\/svg><span>Go to the scorecard<\/span><\/button>/, 'Get started step 5 opens the page');
  // the side list and the rail: the buttons that open it, marked as current while it shows; the old Scorecard jump is gone from both
  assert.match(html, /<button class="at-li" data-act="view" data-view="score" id="navScore">.*<span class="at-li-t">How the desk is doing<\/span><\/button>/);
  assert.match(html, /<button class="icon-btn" data-act="view" data-view="score" id="railScore" aria-label="How the desk is doing" title="How the desk is doing">/);
  assert.doesNotMatch(html, /aria-label="Scorecard"|<span class="at-li-t">Scorecard<\/span>/);
  assert.match(page, /\['#navScore', 'score'\], \['#railScore', 'score'\]\] as const\) \{/);
  assert.match(page, /\$\('#view-score'\)\.hidden = v !== 'score';/);
  assert.match(page, /\$\('#railScore'\)\.classList\.toggle\('on', v === 'score'\);/);
  assert.match(page, /case 'view': showView\(VIEWS\.find\(\(v\) => v === el\.dataset\.view\) \?\? 'overview'\); break;/);
  // remembered like the account page (the desk's prefs accept it: terminal.test)
  assert.match(page, /if \(P\.view && P\.view !== 'overview'\) showView\(P\.view, false\);/);
  assert.match(fs.readFileSync('src/terminal/prefs.ts', 'utf8'), /one\(r\.view, \['overview', 'account', 'today', 'score'\] as const\)/);
  // the page says in plain words that it runs by itself, and every fact in it is the code's: what a call is followed with and against, and the days it is graded over
  assert.match(page, /\$\('#scoreIntro'\)\.textContent = `It runs by itself: each call the desk records is followed with pretend money, at the first close after its day and sized as its order ticket would size it, and compared with just holding \$\{fundWords\(d\.desk\.benchmark\)\}\. The scorecard grades each call once, over its first \$\{d\.desk\.holdingDays\} market days, and nothing here needs pressing, apart from the paper money you start with\.`;/);
  assert.match(page, /fills at the first closing price after its day/, 'the paper card says the same of its fills');
  assert.match(page, /followed as its order ticket would size it/);
  // the paper money's edit works from the new page: the same control, still written into #paperDo
  assert.match(page, /\$\('#paperDo'\)\.innerHTML = PAPER\.editing/);
  assert.match(page, /case 'paper-edit': PAPER\.editing = true; renderPaper\(\); break;/);
  assert.match(page, /case 'paper-save': void run\(async \(\) => \{ PAPER\.book = await api\.setPaperStart\(/);
  // loading as before: the paper record is asked for by the desk's records changing, never by the page being shown, and the chart is drawn again when the page opens (a hidden page has no width), asking for nothing
  assert.equal((page.match(/api\.paper\(\)/g) ?? []).length, 1);
  assert.match(page, /if \(v === 'score'\) renderPaper\(\);/);
  assert.doesNotMatch(page, /case 'view':[^\n]*(loadPaper|api\.paper)/);
});

test('page-25: the section that shows where each analysis stands is called "Analysis status" on the page, in the side list and the rail, in every sentence that points at it, and in the docs', () => {
  const html = fs.readFileSync('src/terminal/ui/index.html', 'utf8');
  assert.match(html, /<h2>Analysis status<\/h2><p id="analysesSub">Reading the desk's waiting list\.<\/p>/, 'the heading changes; its subtitle and contents do not');
  assert.match(html, /<button class="at-li" data-act="goto" data-to="sec-analyses">.*<span class="at-li-t">Analysis status<\/span><\/button>/);
  assert.match(html, /<button class="icon-btn" data-act="goto" data-to="sec-analyses" aria-label="Analysis status" title="Analysis status">/);
  // the sentences that send the person to it
  assert.match(page, /they are listed under Analysis status\.<\/p>/);
  assert.match(page, /': it is asked for, see Analysis status'/);
  assert.equal((page.match(/see Analysis status\./g) ?? []).length, 2, 'the Analyse box and the notice after asking');
  // no file says the old name any more (the walk and the guide included), and "Analyses that run by themselves" is another thing and stays
  for (const f of ['src/terminal/ui/index.html', 'src/terminal/ui/main.ts', 'README.md', 'docs/trading-agents-walk.html', 'docs/inside-the-trading-desk.html']) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /Analyses you asked for/, f);
  assert.match(fs.readFileSync('README.md', 'utf8'), /The stock joins \*\*Analysis status\*\*, where each one shows where it stands/);
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

test('page-18 (dashboard tour, 11 Nov 2026): the Overview\'s first tile says "nothing held" when the accounts hold nothing, and "not known" only when a holding lacks its cost, as the account page\'s own tile does', () => {
  // Before: gainOf() is null for no holdings, and the tile said "gain since bought not known" of an account that holds nothing.
  assert.match(page, /const held = views\.flatMap\(\(v\) => v\.holdings\)/);
  assert.match(page, / since bought` : held\.length \? 'gain since bought not known' : 'nothing held';/);
  assert.match(page, /: v\.holdings\.length \? 'a holding lacks its cost' : 'nothing held'/, 'the account page\'s own tile says the same two cases');
});
