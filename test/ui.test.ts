import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { markdown } from '../src/terminal/ui/md.js';
import { barOn, labelled, money, num, opening, pct, plain, shortDay } from '../src/terminal/ui/fmt.js';

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
  assert.equal(shortDay('2026-10-09'), '9 Oct');
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
