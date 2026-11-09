// A private folder of its own for a test that runs the desk check, so no test ever looks at the person's real one (the
// sign-in's date, who can open the folder) on the computer the tests run on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from '../src/check/desk-check.js';

export function awayHome(): Home {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-home-'));
  return { folder: path.join(dir, 'private'), signIn: path.join(dir, 'private', 'sign-in.json') };
}
