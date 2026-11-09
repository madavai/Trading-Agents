// The person's own contact email. The SEC asks every program that reads its filings to say who runs it, with a contact
// email (its "Accessing EDGAR Data" page: "Please declare your user agent in request headers"), so the desk asks the person
// for it before the first analysis. It is kept in this folder's desk-data (never committed) and sent to sec.gov alone. The
// desk check and the dashboard show it masked (`maskEmail`), so a conversation that only checks the desk never carries
// the address; only the answer to the person who has just typed it repeats it, for them to see it was read right.
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
  // An invisible mark pasted with the address (a zero-width space, a byte-order mark, a word joiner) is dropped: no one
  // means it, and it would stop every request to the SEC.
  const email = String(raw ?? '').replace(/\p{Cf}/gu, '').trim();
  if (!EMAIL.test(email)) throw new Error(`"${raw}" is not an email address`);
  // The address travels in every request's header, which carries only plain ASCII letters: one written with any other
  // letter (an accent, another alphabet) could never reach the SEC, so it is refused now rather than failing every request.
  const odd = [...email].find((c) => c < '!' || c > '~');
  if (odd) throw new Error(`"${email}" cannot be sent to the SEC: it has "${odd}", and the SEC can only be sent an address written with the letters a to z, digits and marks such as . _ - + (it goes in the header of every request)`);
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

/** All of the address the desk's own words show: its first letter and its domain, "c…@example.org". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}…${email.slice(at)}` : '';
}

/** Why the desk needs the email, in one plain sentence the desk's words share. */
export const WHY_EMAIL = 'the SEC asks every program that reads its filings for a contact email';

export const ASK_FOR_EMAIL = 'the SEC asks every program that reads its filings for a contact email, and none is saved yet: ask the person for their own email (never invent one) and save it with set_contact_email';
