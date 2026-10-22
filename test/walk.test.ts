import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Trading Agents walk (docs/trading-agents-walk.html) is the hands-on test of the whole desk. Every pull request that
// changes what a person can do or see adds or updates its tests (CONTRIBUTING.md); these keep it sound.

type Test = { id: string; title: string; about: string; where: string; tags?: string[]; do: string[]; see: string[]; changed: string };
type Section = { id: string; name: string; sub: string; about: string; before?: string; tests: Test[] };
type Walk = { version: string; updated: string; sections: Section[] };

const PAGE = 'docs/trading-agents-walk.html';
const TAGS = ['Market hours', 'Real money', 'Optional', 'Later'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function readWalk(): { html: string; json: string; walk: Walk } {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script type="application\/json" id="walk">([\s\S]*?)<\/script>/);
  assert.ok(m, 'the walk keeps its tests in one <script type="application/json" id="walk"> block');
  return { html, json: m[1]!, walk: JSON.parse(m[1]!) as Walk };
}

const filled = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

test('the walk is the version the project ships, dated, with every section named and holding tests', () => {
  const { walk } = readWalk();
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(walk.version, pkg.version, 'the walk says which version it walks: change it with package.json');
  assert.match(walk.updated, DAY);
  assert.ok(walk.sections.length > 0);
  const ids = walk.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `section letters are unique: ${ids.join(' ')}`);
  for (const s of walk.sections) {
    assert.match(s.id, /^[A-Z]$/, `section ${s.id} is one capital letter`);
    assert.ok(filled(s.name) && filled(s.sub), `section ${s.id} has a name and a line under it`);
    assert.ok(filled(s.about), `section ${s.id} says what this part of the desk does, for someone new to it`);
    assert.ok(s.before === undefined || filled(s.before), `section ${s.id}: "before" is left out or says what is needed`);
    assert.ok(s.tests.length > 0, `section ${s.id} has tests`);
  }
});

test('every test has a unique id in its section, where it happens, steps and what you should see', () => {
  const { walk } = readWalk();
  const seen = new Set<string>();
  let latest = '';
  for (const s of walk.sections) {
    for (const t of s.tests) {
      assert.match(t.id, new RegExp(`^${s.id}[1-9]\\d*$`), `${t.id} is its section's letter and a number`);
      assert.ok(!seen.has(t.id), `${t.id} is used once`);
      seen.add(t.id);
      assert.ok(filled(t.title), `${t.id} has a title`);
      assert.ok(filled(t.about), `${t.id} says what this part does, in plain words`);
      for (const line of [...t.do, ...t.see]) {
        // [[words]] is a prompt to copy: each one closed, and nothing inside it that the page would read as markup
        const bare = line.replace(/\[\[([^\]]+?)\]\]/g, (_, words: string) => {
          assert.doesNotMatch(words, /`|\[|\]/, `${t.id}: the prompt "${words}" holds no backtick or bracket`);
          return '';
        });
        assert.doesNotMatch(bare, /\[\[|\]\]/, `${t.id}: every [[prompt]] is opened and closed`);
      }
      assert.ok(filled(t.where), `${t.id} says where it happens`);
      assert.ok(Array.isArray(t.do) && t.do.length > 0 && t.do.every(filled), `${t.id} has steps`);
      assert.ok(Array.isArray(t.see) && t.see.length > 0 && t.see.every(filled), `${t.id} says what you should see`);
      for (const g of t.tags ?? []) assert.ok(TAGS.includes(g), `${t.id}: the tag "${g}" is one of ${TAGS.join(', ')}`);
      assert.match(t.changed, DAY, `${t.id} says the day its steps last changed`);
      assert.ok(t.changed <= walk.updated, `${t.id} changed no later than the walk's own date`);
      if (t.changed > latest) latest = t.changed;
    }
  }
  assert.equal(walk.updated, latest, 'the walk is dated by its latest change');
});

test('the walk is linked from the README, and the rule to keep it is in CONTRIBUTING', () => {
  const { json } = readWalk();
  assert.doesNotMatch(json, /<\/|<!--/, 'nothing in the tests can end the block they are kept in');
  assert.match(fs.readFileSync('README.md', 'utf8'), /madavai\.github\.io\/Trading-Agents\/trading-agents-walk\.html/);
  assert.match(fs.readFileSync('CONTRIBUTING.md', 'utf8'), /trading-agents-walk\.html/);
});
