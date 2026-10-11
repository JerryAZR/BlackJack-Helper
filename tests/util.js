import { RANKS, countsOf, evaluate } from '../src/engine.js';

/** Rank index for a rank label, e.g. R('10') === 9. */
export const R = s => RANKS.indexOf(s);

/**
 * Convenience wrapper around evaluate() taking rank labels.
 * extra = other cards seen this round (removed from the shoe).
 */
export function runEngine({ decks = 1, hand, upcard, extra = [], peek = true, h17 = false }) {
  const toRanks = cards => cards.map(c => (typeof c === 'string' ? R(c) : c));
  const h = toRanks(hand);
  const u = typeof upcard === 'string' ? R(upcard) : upcard;
  const x = toRanks(extra);
  return evaluate({
    decks,
    out: countsOf([...h, u, ...x]),
    upcard: u,
    hand: countsOf(h),
    peek,
    h17,
  });
}
