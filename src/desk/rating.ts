// The five-tier rating every call on the desk uses, and a strict reader for it. A decision nobody can read is "Needs
// review", never a Hold: a Hold recorded in its place would be quoted back to later runs as a call that was never made.
// Adapted from TradingAgents (tradingagents/agents/rating.py), Apache License 2.0; rewritten in TypeScript.

export const RATINGS = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'] as const;
export type Rating = (typeof RATINGS)[number];
/** The sentinel for a decision with no readable rating: not a tradeable position. */
export const REVIEW = 'Needs review';

const SET = new Set(RATINGS.map((r) => r.toLowerCase()));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// "Rating: X" / "rating - X" / "Rating — **X**": tolerates markdown bold and any dash or colon as the separator.
// "rating" must start a word, so "Operating margin: Sell-side" is not a label.
const LABEL = /(?<![a-z])rating\b[^:\-\u2010-\u2015]*[:\-\u2010-\u2015][\s*]*(\w+)/gi;
// The decision's own rating line, in the shape the Portfolio Manager is asked to open with: an optional list marker,
// emphasis and heading marks, and only words naming the decision itself before "rating". "Consensus rating: Buy" or
// "Trader's rating: Buy" is someone else's rating.
const OWN = '(?:(?:final|our|overall|my|recommended|updated|revised|new|current)\\s+)*';
const LINE = new RegExp(`^\\s*(?<item>(?:[-+*\\u2022]|\\d+[.)])\\s+)?[\\s*_#]*${OWN}rating[^\\w:\\-\\u2010-\\u2015]*[:\\-\\u2010-\\u2015][\\s*]*(?<value>\\w+)`, 'i');
// A line presenting the scale rather than a decision ("Rating Scale: Buy, ...").
const SCALE = /rating\s*(scale|options|legend)/i;

/** The rating a text labels, or null when it has none or labels two different ones. */
export function extractRating(text: string): Rating | null {
  if (!text) return null;
  const lines = text.normalize('NFKC').split(/\r?\n/).filter((l) => l.trim() && !SCALE.test(l));
  // The decision is asked to open with its rating, so a first line (after any headings) in that shape is the call. A list
  // item there may be a quote heading a list of other parties' ratings, so it counts with the decision's other rating
  // lines, which leave out list items; failing those, every label counts. They must agree: ratings that differ, with
  // nothing marking which is the call, are no call.
  const first = lines.find((l) => !l.trimStart().startsWith('#') || LINE.test(l)) ?? '';
  const m = LINE.exec(first);
  const opening = m && SET.has(m.groups!.value!.toLowerCase()) ? m : null;
  if (opening && !opening.groups!.item) return cap(opening.groups!.value!) as Rating;

  const own: string[] = opening ? [cap(opening.groups!.value!)] : [], labels: string[] = [];
  for (const line of lines) {
    const lm = LINE.exec(line);
    if (lm && !lm.groups!.item && SET.has(lm.groups!.value!.toLowerCase())) own.push(cap(lm.groups!.value!));
    for (const x of line.matchAll(LABEL)) if (SET.has(x[1]!.toLowerCase())) labels.push(cap(x[1]!));
  }
  // Without a label there is no call to read: a rating word in prose may be one the text argues against ("not a Sell").
  const found = own.length ? own : labels;
  return found.length && new Set(found).size === 1 ? (found[0] as Rating) : null;
}

/** The rating a text labels, or "Needs review" when it has none. */
export const parseRating = (text: string): Rating | typeof REVIEW => extractRating(text) ?? REVIEW;
