import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { markdown } from '../src/terminal/ui/md.js';
import { averageOf, barOn, chipDay, clock, labelled, money, moveDayOf, num, nyDay, opening, pct, plain, points, priceDayWords, qty, resultOf, shortDay, weekDay, when } from '../src/terminal/ui/fmt.js';
import { LATE } from '../src/data/delay.js';

const ui = 'src/terminal/ui';
const read = (f: string) => fs.readFileSync(path.join(ui, f), 'utf8');
const sources = fs.readdirSync(ui).filter((f) => f.endsWith('.ts') || f === 'index.html');

test('the agents\' words are shown as words: markup in them is escaped, and nothing becomes a link, picture or script', () => {
  const html = markdown('# Plan\n\n<script>alert(1)</script> and <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) ![p](http://evil/x.png)\n\n**bold** and *slanted*');
  assert.doesNotMatch(html, /<script|<img|<a |onerror=(?!.*&)/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>bold<\/strong> and <em>slanted<\/em>/);
  assert.match(html, /<h3>Plan<\/h3>/);
  // a quote cannot break out of anything, whatever surrounds it
  assert.doesNotMatch(markdown('"><svg onload=alert(1)>'), /<svg/);
});

test('lists, tables and rules keep their shape', () => {
  assert.equal(markdown('- one\n- two\n\n1. a\n2. b'), '<ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>');
  const t = markdown('| Level | Price |\n| --- | --- |\n| Entry | **181.90** |');
  assert.match(t, /<th>Level<\/th><th>Price<\/th>/);
  assert.match(t, /<td>Entry<\/td><td><strong>181\.90<\/strong><\/td>/);
  // A bar written "\|" stays in its cell: the fact checker's mark in a row keeps the row's old words so.
  const fixed = markdown('| Signal | Source |\n|---|---|\n| Split 27/73 | StockTwits [corrected: was "\\| Split 54/46 \\| StockTwits \\|"] |');
  assert.match(fixed, /<tr><td>Split 27\/73<\/td><td>StockTwits \[corrected: was &quot;\| Split 54\/46 \| StockTwits \|&quot;\]<\/td><\/tr>/);
  assert.match(markdown('a\n\n---\n\nb'), /<p>a<\/p><hr><p>b<\/p>/);
  assert.equal(markdown('first line\nsecond line'), '<p>first line second line</p>');
  assert.equal(markdown(''), '');
});

test('a call in full reads the agents\' own words: plain text, its labelled lines, each report\'s opening, the close on a day', () => {
  const decision = '# NVDA\n\n**Rating**: Hold\n\n**Price Target**: Not provided as a firm target; the **10 EMA** at 224.33 is the first reference.\n**Time Horizon**: A few weeks to 3 months.';
  assert.equal(labelled(decision, 'Rating'), 'Hold');
  assert.equal(labelled(decision, 'Price Target'), 'Not provided as a firm target; the 10 EMA at 224.33 is the first reference.');
  assert.equal(labelled(decision, 'Time Horizon'), 'A few weeks to 3 months.');
  assert.equal(labelled(decision, 'Stop Loss'), '', 'a line that is not there is empty, never made up');
  assert.equal(plain('## Head\n- **one** and *two*\n| a | b |\n`code`'), 'Head one and two code');
  assert.equal(opening('## Market report\nThe trend is down. The 50-day average is falling.'), 'The trend is down.');
  assert.ok(opening('x '.repeat(200)).length <= 160);
  const bars = [{ date: '2026-10-14', close: 1 }, { date: '2026-10-15', close: 2 }, { date: '2026-10-19', close: 3 }];
  assert.equal(barOn(bars, '2026-10-17')?.close, 2, 'a weekend call compares with the Friday close');
  assert.equal(barOn(bars, '2026-10-19')?.close, 3);
  assert.equal(barOn(bars, '2026-10-01'), null);
});

test('a number that is missing is a dash, never a zero', () => {
  assert.deepEqual([money(null), num(undefined), pct(NaN)], ['—', '—', '—']);
  assert.equal(money(1234.5), '$1,234.50'); assert.equal(money(-3), '−$3.00'); assert.equal(pct(-0.894), '−0.89%'); assert.equal(pct(1.2), '+1.20%');
  // What rounds to zero is written as zero: no minus on nothing.
  assert.deepEqual([pct(-0.004), pct(0.004), pct(0), pct(-0.024, 1), pct(-0.06, 1), money(-0.004), money(0.004)], ['0.00%', '0.00%', '0.00%', '0.0%', '−0.1%', '$0.00', '$0.00']);
  assert.equal(shortDay('2026-10-09'), '9 Oct');
});

test('a call\'s result is coloured and worded by whether it worked for its rating, never by the alpha\'s sign alone', () => {
  // Round 1 (7 Nov 2026): META's Underweight of 17 Oct trailed its index by 10.5%, so it worked, and showed red. Since
  // 8 Nov each result names the call's own window and yardstick, and that it is a first check, not the call's horizon.
  const spy5 = { yardstick: 'SPY', window: '5 trading days', check: 'a first-week check', why: '' };
  assert.deepEqual(resultOf({ rating: 'Underweight', alpha: '-10.5%', worked: true, ...spy5 }), {
    tone: 'ok', words: 'worked · alpha -10.5%', verdict: 'the call worked',
    why: "An Underweight works when the stock trails SPY over the 5 trading days after the call. It did (alpha -10.5%): the call worked. It is a first-week check, not the call's own time horizon.",
  });
  const tsla = resultOf({ rating: 'Underweight', alpha: '+9.0%', worked: false, ...spy5 });   // it beat its index: the call failed, and showed green
  assert.deepEqual([tsla.tone, tsla.words, tsla.verdict], ['danger', 'did not work · alpha +9.0%', 'the call did not work']);
  const meta = resultOf({ rating: 'Overweight', alpha: '-12.1%', worked: false, ...spy5 });   // META's Overweight of 21 Oct
  assert.deepEqual([meta.tone, meta.words], ['danger', 'did not work · alpha -12.1%']);
  assert.match(resultOf({ rating: 'Buy', alpha: '+7.0%', worked: true, ...spy5 }).why, /^A Buy works when the stock beats SPY over the 5 trading days/);
  const coin = resultOf({ rating: 'Buy', alpha: '+1.0%', worked: true, yardstick: 'SPY', window: '7 calendar days', check: 'a first-week check', why: "the desk's settings name no yardstick for coins, so a coin is scored against the one for US listings", noun: 'coin' });
  assert.equal(coin.why, "A Buy works when the coin beats SPY over the 7 calendar days after the call. It did (alpha +1.0%): the call worked. It is a first-week check, not the call's own time horizon. Against SPY: the desk's settings name no yardstick for coins, so a coin is scored against the one for US listings.");
  const hold = resultOf({ rating: 'Hold', alpha: '+1.8%', worked: null, ...spy5 });
  assert.deepEqual([hold.tone, hold.words, hold.verdict], ['', 'alpha +1.8%', 'a Hold claims no direction'], 'a Hold is plain: it claims no direction');
  assert.match(hold.why, /only says how the stock did against SPY over the 5 trading days after the call\. It is a first-week check, not the call's own time horizon\.$/);
  assert.deepEqual([resultOf({ rating: 'Needs review', alpha: '+9.0%', worked: null, ...spy5 }).tone, resultOf({ rating: 'Needs review', alpha: '+9.0%', worked: null, ...spy5 }).verdict], ['', '']);
  // the scorecard's averages, as round 1's scorecard showed them
  assert.equal(averageOf('Underweight', { direction: -1, meanAlpha: 0.0037 }).tone, 'ta-down', 'the stocks marked down beat the index on average: against the calls');
  assert.equal(averageOf('Underweight', { direction: -1, meanAlpha: 0.0037 }).why, "On average, what the desk rated Underweight beat its yardstick by 0.4% in each call's first check: on average these calls did not work so far.");
  assert.equal(averageOf('Overweight', { direction: 1, meanAlpha: -0.0725 }).tone, 'ta-down');
  assert.equal(averageOf('Sell', { direction: -1, meanAlpha: -0.05 }).tone, 'ta-up');
  assert.deepEqual([averageOf('Hold', { direction: 0, meanAlpha: -0.0118 }).tone, averageOf('Buy', { direction: 1, meanAlpha: 0.0004 }).tone], ['', ''], 'a Hold, and an average that prints as 0.0%, are plain');
  // and the page uses them everywhere a call's result shows: no chip is coloured by the alpha's sign
  const page = read('main.ts');
  assert.doesNotMatch(page, /tone\(parseFloat\(/, 'a result coloured by the sign of its alpha');
  assert.match(page, /<td>\$\{resultChip\(c\)\}<\/td>/, 'the stock page\'s list shows the same result chip');
  assert.match(page, /resultOf\(meta\)\.verdict/, 'the call window says whether it worked');
  assert.match(page, /\['Scored', scored\]/, 'and names how it is scored, beside the time horizon');
  assert.doesNotMatch(page, /holdDays|market's index/, 'no result is said as a holding period or against a market index');
  assert.match(page, /averageOf\(n, s\)/, 'the scorecard colours each average by its rating');
});

test('the page names the day of a move or a time that is not today, and never calls a weekend\'s quote today', () => {
  // Round 1 (Sat 7 Nov 2026): the stock page said "(+2.78% today)" and the watchlist's Today column showed Friday's
  // moves; the analyses said "last run 12:54 AM" for a run that started on 24 Oct.
  const sat = new Date('2026-11-07T15:00:00Z'), fri = '2026-11-06T21:00:00Z';   // Friday's close: 4 PM in New York
  assert.equal(weekDay('2026-11-06'), 'Fri 6 Nov');
  assert.equal(nyDay('2026-11-07T03:00:00Z'), '2026-11-06', 'late Friday evening in New York is still Friday there');
  assert.deepEqual([moveDayOf(fri, sat), moveDayOf('2026-11-07T14:00:00Z', sat)], ['2026-11-06', ''], "Friday's move on a Saturday is named; today's is not");
  assert.deepEqual([chipDay('2026-11-06', sat), chipDay('2026-10-30', sat)], ['Fri', '30 Oct'], 'its weekday within the week, else its date');
  assert.equal(priceDayWords('$188.08', '+2.78%', { open: false, asOf: fri }, sat), '$188.08, the close of Fri 6 Nov (+2.78% that day), from Yahoo Finance');
  assert.equal(priceDayWords('$188.08', '+2.78%', { open: false, asOf: fri }, new Date('2026-11-06T22:00:00Z')), "$188.08, today's close (+2.78% today), from Yahoo Finance");
  // how late a live price may be, by its market, as data/delay.ts says from Yahoo's own list: never one figure for every
  // market (audit 1 F2: "up to 15 min late" everywhere, where Yahoo lists 20 and 30 minutes for some), and nothing
  // about lateness beside a final close
  const open = new Date('2026-11-06T20:00:00Z');
  for (const market of ['us', 'coin', 'other'] as const) assert.equal(priceDayWords('$188.08', '+2.78%', { open: true, asOf: fri, market }, open), `$188.08 (+2.78% today) on Yahoo Finance, ${LATE[market]}`, market);
  assert.equal(priceDayWords('$188.08', '+2.78%', { open: true, asOf: fri }, open), '$188.08 (+2.78% today) on Yahoo Finance, may be late', 'a quote whose market is not known gives no figure');
  assert.doesNotMatch(priceDayWords('$188.08', '+2.78%', { open: false, asOf: fri, market: 'other' }, sat), /late|real-time|minute/, 'a final close says nothing of lateness');
  // a quantity as held, never rounded to four places (a coin's 0.00012345) or to none (audit 1 F6)
  assert.deepEqual([qty(12), qty(0.00012345), qty(2.5), qty(1234.5678), qty(null)], ['12', '0.00012345', '2.5', '1,234.5678', '—']);
  assert.equal(priceDayWords('$188.08', null, { open: false, asOf: fri }, sat), '$188.08, the close of Fri 6 Nov, from Yahoo Finance', 'no move given: none written');
  // a time today is its clock; another day's has its day, another year's its year (in the person's own time)
  const now = new Date(2026, 10, 7, 10, 0), run = new Date(2026, 9, 24, 0, 54).toISOString(), early = new Date(2026, 10, 7, 8, 5).toISOString();
  assert.equal(when(run, now), `Sat 24 Oct, ${clock(run)}`);
  assert.equal(when(early, now), clock(early));
  const old = new Date(2025, 9, 24, 0, 54).toISOString();
  assert.equal(when(old, now), `24 Oct 2025, ${clock(old)}`);
  assert.equal(when('not a time', now), '');
  // a yield's change is in points, never a percent of a percent (4.08% to 4.10% is not "+0.41%")
  assert.deepEqual([points(0.02), points(-0.0123), points(1), points(0.001), points(null)], ['+0.02 points', '−0.01 points', '+1.00 point', '0.00 points', '—']);
  // and the page uses them wherever it shows a move or a time
  const page = read('main.ts');
  assert.doesNotMatch(page, /\bclock\(/, 'a time is shown with its day when it is not today, never as a bare clock');
  assert.doesNotMatch(page, /\} today\)` on Yahoo|'S&P 500 today'|<th class="num">Today<\/th>/, "a move called today's whatever its day");
  assert.match(page, /const day = moveDayOf\(q\.asOf\)/, 'the move chip names its day');
  assert.match(page, /marketOf\(q\.symbol\)\?\.unit === '%' \? points\(q\.change\)/, "a yield's move is in points");
  assert.match(page, /l\.lastRun\.startOnly \? 'started ' : ''/, 'a run whose end Madav did not give says when it started');
  assert.match(page, /l\.lastRun\.result\.replace\(\/\[\\s\.\]\+\$\/, ''\)/, 'its result ends in one full stop, not two ("1 scored..")');
  assert.doesNotMatch(page, /title="\$\{esc\(t\.why\)\}"/, 'a paper badge says its day as the page does ("26 Oct 2026"), not "2026-10-26"');
});

test("a report's preview is its first sentence, never a heading, a bold heading or a bold label alone", () => {
  // Round 1: the fact check's card previewed as "Data note and verification." and nothing else.
  assert.equal(opening('**Data note and verification.** Instrument confirmed: NVDA, NVIDIA Corporation, on NasdaqGS. Prices from Yahoo Finance.'),
    'Instrument confirmed: NVDA, NVIDIA Corporation, on NasdaqGS.');
  assert.equal(opening('**Summary**\n\nThe trend is up. The 50-day average is rising.'), 'The trend is up.');
  assert.equal(opening('- **Corrections:**\nThe RSI was 62.1, not 70.'), 'The RSI was 62.1, not 70.');
  assert.equal(opening('**Rating**: Overweight\nMore words follow.'), 'Rating: Overweight More words follow.', 'a bold label with its value stays');
  assert.equal(opening('**Only a heading.**'), 'Only a heading.', 'with nothing else, the heading is all there is');
});

test('the page is one policy-clean file: no inline script, style or event attribute, and no key in it', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no event attribute');
  assert.doesNotMatch(html, /<style/i);
  assert.ok(!html.includes('__DESK_TOKEN__') && !html.includes('desk-token'), 'the key is in no page: the page swaps the one-time link it was opened with for it');
  assert.match(read('api.ts'), /\/api\/claim/, 'the page claims its key from the one-time link');
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !u!.startsWith('data:')), ['/app.css', '/app.js']);
  for (const f of sources.filter((x) => x.endsWith('.ts'))) assert.doesNotMatch(read(f), /\bstyle\s*=\s*\\?["']|setAttribute\(\s*['"]style['"]|cssText/, `${f} sets a style the page's policy refuses`);
});

test('the dashboard\'s own sheet only places House tokens: no colours or fonts of its own, and every token it names exists', () => {
  const house = read('house.css'), own = read('dashboard.css');
  assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i, 'no colour literal');
  assert.doesNotMatch(own, /font-family:(?!\s*var\()/i, 'no font of its own');
  assert.doesNotMatch(own, /!important/);
  const defined = new Set([...house.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set<string>();
  for (const text of [own, ...sources.map(read)]) for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]!);
  assert.deepEqual([...used].filter((t) => !defined.has(t)), []);
});

test('what the page hides stays hidden: a class that sets display has a [hidden] rule beside it', () => {
  const html = read('index.html'), css = read('house.css') + read('dashboard.css');
  const missing: string[] = [];
  for (const m of html.matchAll(/<(\w+)\s([^>]*)>/g)) {
    const tag = m[1]!, attrs = ` ${m[2]!}`;
    if (!/\shidden(?=[\s/]|$)/.test(attrs)) continue;   // the hidden attribute itself, not aria-hidden
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    const ruled = (cls: string) => new RegExp(`(?:\\.${cls}|#${id ?? '-'}|(?:^|[\\s>])${tag})\\[hidden\\]`, 'm').test(css);
    for (const cls of /\sclass="([^"]+)"/.exec(attrs)?.[1]?.split(/\s+/) ?? []) {
      const sets = new RegExp(`\\.${cls}(?![\\w-])[^{},]*\\{[^}]*\\bdisplay\\s*:\\s*(?!none)`).test(css);
      if (sets && !ruled(cls)) missing.push(`.${cls}${id ? ` (#${id})` : ''}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every House object the page names is defined in the House sheet', () => {
  const house = read('house.css'), mine = read('dashboard.css');
  const names = new Set<string>();
  for (const f of sources) for (const m of read(f).matchAll(/\b(at-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) names.add(m[1]!);
  const missing = [...names].filter((n) => !new RegExp(`\\.${n}(?![a-z0-9-])`).test(house) && !new RegExp(`\\.${n}(?![a-z0-9-])`).test(mine));
  assert.deepEqual(missing, []);
});
