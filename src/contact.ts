// The person's own contact email. The SEC asks everyone who reads its filings for one, so the desk asks the person for
// it before the first analysis. It is kept in this folder's desk-data (never committed) and sent to sec.gov alone.
import fs from 'node:fs';
import path from 'node:path';
import { deskDataDir } from './paths.js';

const file = (root: string) => path.join(deskDataDir(root), 'contact.json');

// An address with a name, an @, a domain and a top-level name, and nothing a header could be split on.
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
// Names reserved for examples and tests (RFC 2606, RFC 6761): they reach no one.
const RESERVED = /@(?:[^@]*\.)?(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/** The address checked and trimmed; throws with plain words when it is not a usable address of the person's own. */
export function checkEmail(raw: string): string {
  const email = String(raw ?? '').trim();
  if (!EMAIL.test(email)) throw new Error(`"${raw}" is not an email address`);
  if (RESERVED.test(email)) throw new Error(`${email} is a made-up example address: the SEC needs one that reaches the person`);
  return email;
}

/** The saved address, or '' when the person has not given one yet. */
export function readContactEmail(root: string): string {
  try {
    const saved = JSON.parse(fs.readFileSync(file(root), 'utf8')) as { email?: unknown };
    return typeof saved.email === 'string' ? checkEmail(saved.email) : '';
  } catch {
    return '';
  }
}

export function saveContactEmail(root: string, raw: string): string {
  const email = checkEmail(raw);
  fs.mkdirSync(deskDataDir(root), { recursive: true });
  fs.writeFileSync(file(root), JSON.stringify({ email }, null, 2) + '\n');
  return email;
}

export const ASK_FOR_EMAIL = 'the SEC asks everyone who reads its filings for a contact email, and none is saved yet: ask the person for their own email (never invent one) and save it with set_contact_email';
