import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockArgs, lockDown, lockState, ownerOnWindows, writePrivate } from '../src/private.js';

const win = process.platform === 'win32';
const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
/** Each name on a Windows access list, as icacls prints it: one line per grant. */
const grants = (p: string): string[] => spawnSync(icacls, [p], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter((l) => /:\(/.test(l));

test('the Windows lock names the person and the system alone and inherits nothing; a folder passes it on to what is made in it', () => {
  assert.deepEqual(lockArgs('C:\\x\\private', true, '*S-1-5-21-7'), ['C:\\x\\private', '/inheritance:r', '/grant:r', '*S-1-5-21-7:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']);
  assert.deepEqual(lockArgs('C:\\x\\private\\a.json', false, '*S-1-5-21-7'), ['C:\\x\\private\\a.json', '/inheritance:r', '/grant:r', '*S-1-5-21-7:F', '*S-1-5-18:F']);
  if (win) assert.match(ownerOnWindows(), /^\*S-1-/, 'the person is named by SID, which has one spelling');
});

test('a private file is written whole, and it and its folder are the person\'s alone, on every system', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-private-')), dir = path.join(home, 'private'), file = path.join(dir, 'a.json');
  assert.equal(lockState(dir), 'unknown', 'not there yet');
  writePrivate(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'nothing half-written is left beside it');
  assert.deepEqual([lockState(dir), lockState(file)], ['locked', 'locked']);
  if (win) {
    for (const p of [dir, file]) {
      const g = grants(p);
      assert.equal(g.length, 2, `${p} is granted to exactly two names:\n${g.join('\n')}`);
      assert.ok(g.every((l) => /\(F\)/.test(l) && !/\(I\)/.test(l)), `granted outright, inherited from nothing:\n${g.join('\n')}`);
    }
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  writePrivate(file, '{"a":2}\n');   // written again, over the old one: still whole, still locked
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n');
  assert.deepEqual([fs.readdirSync(dir), lockState(file)], [['a.json'], 'locked']);
  // a folder opened up by hand reads as open, and is locked again on the next write
  if (win) spawnSync(icacls, [dir, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
  else fs.chmodSync(dir, 0o755);
  assert.equal(lockState(dir), 'open');
  assert.equal(lockDown(dir), true);
  assert.equal(lockState(dir), 'locked');
  assert.equal(lockDown(path.join(dir, 'missing')), false, 'what is not there cannot be locked');
  fs.rmSync(home, { recursive: true, force: true });
});
