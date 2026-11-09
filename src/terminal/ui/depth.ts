// How deep an analysis asked for on the page runs: the choices the Analyse box offers, and what Retry asks for. Kept apart
// from the page, with nothing of the browser in it, so the tests read the choices as the person does.
import type { Depth } from '../../desk/queue.js';

export const DEPTH_ORDER: readonly Depth[] = ['shallow', 'medium', 'deep'];
export const DEPTH_WORDS: Record<Depth, [string, string]> = {
  shallow: ['Shallow', 'Quick: the bull and the bear each make their case once, and so do the three risk voices.'],
  medium: ['Medium', 'The two sides answer each other three times, and so do the risk voices. Slower, and costs more.'],
  deep: ['Deep', 'Five rounds of each debate. The slowest and costliest: for a call you may act on.'],
};

/** The debate and risk rounds in the desk's settings. */
export interface Rounds { debate: number; risk: number }
/** One choice in the Analyse box: a depth, or `null` for the settings' own rounds, asked for with no depth at all. */
export interface DepthChoice { depth: Depth | null; label: string; means: string }

const rounds = (n: number, word: string) => (n === 1 ? `one ${word}` : `${n} ${word}s`);

/** The choices the Analyse box offers, and the one chosen first. A desk that says its settings' rounds keeps an analysis
 *  asked for with no depth at exactly those rounds, when it runs: they come first, chosen. A desk that does not say them
 *  turns a request with no depth into the nearest depth, so only the three depths are offered, that nearest one chosen. */
export function depthChoices(a: { depth: Depth; rounds?: Rounds | null }): { choices: DepthChoice[]; first: Depth | null } {
  const depths: DepthChoice[] = DEPTH_ORDER.map((d) => ({ depth: d, label: DEPTH_WORDS[d][0], means: DEPTH_WORDS[d][1] }));
  if (!a.rounds) return { choices: depths, first: a.depth };
  const { debate, risk } = a.rounds;
  const settings: DepthChoice = {
    depth: null, label: `Settings (${debate} and ${risk} rounds)`,
    means: `The rounds in the desk's settings when it runs, now ${rounds(debate, 'round')} of the bull and bear debate and ${risk === 1 ? 'one' : risk} of the risk debate.`,
  };
  return { choices: [settings, ...depths], first: null };
}

/** What Retry asks for: exactly what the stock was first asked at, its depth, or none (the settings' own rounds). */
export const retryDepth = (item: { depth?: Depth } | undefined): Depth | undefined => item?.depth;
