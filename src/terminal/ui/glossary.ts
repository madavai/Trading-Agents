// "What does this mean?": every trading word the page uses, each in one plain line, written here once. The page shows
// the line when the person points at the word (and in a list of its own, for a phone, where there is no pointing), so a
// word means the same thing everywhere. A word that needs more than a line is explained where it is used, not here.

export interface Term { term: string; means: string; group: string }

const ratings = 'The desk\'s ratings', desk = 'How the desk works', markets = 'Markets', account = 'Your account and orders';

/** The words, in the order the list shows them, grouped. */
export const GLOSSARY = {
  Buy: { group: ratings, term: 'Buy', means: 'the desk would own it. As shipped, its ticket buys a full position.' },
  Overweight: { group: ratings, term: 'Overweight', means: 'the desk leans towards owning it. As shipped, its ticket buys half a position.' },
  Hold: { group: ratings, term: 'Hold', means: 'the desk would keep what is held, and neither buy nor sell.' },
  Underweight: { group: ratings, term: 'Underweight', means: 'the desk leans against it. As shipped, its ticket sells half of what is held.' },
  Sell: { group: ratings, term: 'Sell', means: 'the desk would not own it. As shipped, its ticket sells everything held.' },
  'Needs review': { group: ratings, term: 'Needs review', means: 'the decision gave no rating that could be read, so it asks for no order.' },

  call: { group: desk, term: "The desk's call", means: "its twelve agents' rating, from Buy to Sell, on the day they analysed it." },
  depth: { group: desk, term: 'Depth', means: 'how long the debates in an analysis run: shallow (one round each, quick), medium (three) or deep (five, the slowest and costliest).' },
  alpha: { group: desk, term: 'Alpha', means: "how much better (+) or worse (−) a call did than its market's index in the trading days after it: above zero, it beat the market." },
  paper: { group: desk, term: 'On paper', means: "followed with pretend money only, to see what the desk's calls would have done before any real money is at stake." },
  scorecard: { group: desk, term: 'Scorecard', means: "the desk's record, good or bad: its paper money against the S&P 500, and each rating's average alpha." },
  rerating: { group: desk, term: 'Re-rating', means: "it is on the waiting list, so the desk analyses it again and its view is fresh. Monday's morning routine re-rates the Agentic account's holdings whose view is a week old." },
  stop: { group: desk, term: 'Stop', means: "the price under which the desk's trader proposed selling, to limit a loss. The dashboard watches it against Yahoo Finance's price and tells you when the price falls below it. Nothing is ever sold by itself." },

  stock: { group: markets, term: 'Stock', means: 'a small share of one company; its price moves with what people will pay for that company.' },
  fund: { group: markets, term: 'Fund', means: 'a basket of many companies (or bonds) bought and sold as one share, also called an ETF.' },
  index: { group: markets, term: 'Index', means: "a list of companies whose prices are averaged into one number, such as the S&P 500. It cannot be bought itself, only through a fund that copies it." },
  sp500: { group: markets, term: 'S&P 500', means: 'the 500 largest US companies taken together: the yardstick the desk measures itself against.' },
  sector: { group: markets, term: 'Sector', means: 'one part of the economy, such as technology or energy. Companies in one sector tend to rise and fall together.' },
  crypto: { group: markets, term: 'Crypto', means: 'digital coins such as Bitcoin, which swing far more than shares. The desk follows Bitcoin and Ether on paper only.' },
  today: { group: markets, term: 'Today', means: "the change in price since the last day's close." },
  volume: { group: markets, term: 'Volume', means: 'how many shares changed hands in a day. A move on high volume means many people acted on it.' },
  average: { group: markets, term: '50- and 200-day average', means: 'the average closing price over that many days. A price above it has been rising lately; below it, falling.' },
  vix: { group: markets, term: 'VIX', means: "the market's own measure of nerves, from what insurance on the S&P 500 costs: under 15 is calm, over 25 is wild." },
  fed: { group: markets, term: 'The Fed', means: 'the Federal Reserve, which sets US interest rates. What it is expected to do moves almost everything.' },

  agentic: { group: account, term: 'Agentic account', means: 'the one Robinhood account the desk may ever trade in, and only on your Confirm. Every other account is shown view-only.' },
  buyingPower: { group: account, term: 'Buying power', means: 'the money Robinhood lets you spend on new buys right now.' },
  position: { group: account, term: 'Position', means: 'what you hold of one stock or fund. As shipped, a full position is 10% of the account, and half a position 5%.' },
  cap: { group: account, term: 'Cap', means: 'a limit you set: the most an order may cost, or the most of the account one stock, one sector or crypto may be.' },
  limitOrder: { group: account, term: 'Limit order', means: "an order to buy at no more, or sell at no less, than a price you set. The desk's tickets place only these." },
  ticket: { group: account, term: 'Order ticket', means: 'one proposed order with its checks against your caps, which Robinhood looks over and you confirm or close.' },
  dryRun: { group: account, term: "Robinhood's check", means: 'a dry run: Robinhood looks the order over and says what it would do, without placing it.' },
  shortestHold: { group: account, term: 'Shortest hold', means: 'the fewest trading days a stock bought here is kept before the desk proposes selling it.' },
  weeklyLoss: { group: account, term: 'Weekly loss limit', means: 'when the Agentic account falls this much below its best value of the last seven days, trading switches itself off.' },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof GLOSSARY;

/** A word's plain meaning in one line, as the page shows it when the person points at it: "Alpha: how much…". */
export const means = (key: TermKey): string => `${GLOSSARY[key].term}: ${GLOSSARY[key].means}`;

/** Whether a word is in the glossary (for words that reach the page as data, such as a rating). */
export const isTerm = (key: string): key is TermKey => Object.hasOwn(GLOSSARY, key);

/** The list as the page shows it: each group with its words, in order. */
export function glossaryGroups(): Array<{ group: string; terms: Array<Term & { key: TermKey }> }> {
  const out: Array<{ group: string; terms: Array<Term & { key: TermKey }> }> = [];
  for (const [key, t] of Object.entries(GLOSSARY) as Array<[TermKey, Term]>) {
    const g = out.find((x) => x.group === t.group) ?? out[out.push({ group: t.group, terms: [] }) - 1]!;
    g.terms.push({ key, ...t });
  }
  return out;
}
