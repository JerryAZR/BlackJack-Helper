/**
 * Exact, composition-dependent blackjack decision engine.
 *
 * Computes win/push/lose distributions and expected values for Hit / Stand /
 * Double from the exact composition of unseen cards. Ranks are tracked at
 * rank level (10/J/Q/K share one bucket) — exact, because blackjack outcomes
 * depend only on card values.
 *
 * Model
 * -----
 * - The player's cards and the dealer's upcard are known and removed from the
 *   shoe; everything else is unseen.
 * - The dealer's hole card is unknown and is integrated over the unseen
 *   composition. With `peek` (US rules) the hole-card law is conditioned on
 *   the dealer not having blackjack; without it (ENHC) a dealer blackjack
 *   simply takes the staked amount for every action (both units on a double).
 * - The player decides on their information state only (own cards + upcard).
 *   The recursion is a Bellman equation over that state: re-deriving the
 *   hole-card law from the updated composition at each node is exact, because
 *   unseen cards are exchangeable (verified against brute-force references).
 * - The dealer draws without replacement from the same composition and stands
 *   on all 17s (S17) or hits soft 17 (H17).
 *
 * Hand-rolled numerics are intentional: the algorithm is a small exact
 * recursion over card-count vectors, memoized on sufficient statistics
 * ((hard total, usable-ace) + composition). Validated in tests against
 * independent naive enumeration, Monte Carlo simulation and published
 * infinite-deck values.
 */

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/** Hard value of each rank. Aces count 1 here; soft promotion is derived. */
const RANK_VALUE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const TEN = 9; // index of the 10/J/Q/K bucket
const ACE = 0;

export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

/** Rank counts of a list of rank indices, e.g. countsOf([0, 9]) -> [1,0,...,1]. */
export function countsOf(cards) {
  const c = new Array(10).fill(0);
  for (const r of cards) c[r]++;
  return c;
}

/** Composition of a full shoe: A..9 four per deck, tens sixteen per deck. */
export function fullShoe(decks) {
  if (!Number.isInteger(decks) || decks < 1 || decks > 1000) {
    throw new EngineError(`Deck count must be an integer from 1 to 1000 (got ${decks}).`);
  }
  const counts = new Array(10).fill(4 * decks);
  counts[TEN] = 16 * decks;
  return counts;
}

/** Total / soft / bust / blackjack summary of a hand given as rank counts. */
export function handInfo(counts) {
  let cards = 0;
  let hard = 0;
  let aces = 0;
  for (let r = 0; r < 10; r++) {
    const n = counts[r];
    cards += n;
    hard += n * RANK_VALUE[r];
    if (r === ACE) aces = n;
  }
  const soft = aces > 0 && hard + 10 <= 21;
  const total = soft ? hard + 10 : hard;
  return {
    cards,
    hard,
    aces,
    soft,
    total,
    bust: total > 21,
    blackjack: cards === 2 && total === 21,
  };
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

const sum = c => c[0] + c[1] + c[2] + c[3] + c[4] + c[5] + c[6] + c[7] + c[8] + c[9];

// Net-payoff histograms over {−2,−1,0,+1,+2} units of the initial bet,
// indexed by net + 2.
const histEV = h => -2 * h[0] - h[1] + h[3] + 2 * h[4];
const histMass = h => h[0] + h[1] + h[2] + h[3] + h[4];
const pointHist = net => {
  const h = new Float64Array(5);
  h[net + 2] = 1;
  return h;
};

/**
 * Dealer final-total distribution given (hard total, ace count, composition).
 * Returns Float64Array(6): [bust, 17, 18, 19, 20, 21].
 *
 * (hard, aces, composition) is a sufficient statistic: two dealer states with
 * the same key have identical futures. Memoized per evaluate() call.
 * Returned arrays are shared and must be treated as read-only.
 */
function createDealerDist(h17) {
  const memo = new Map();
  // Terminal distributions, shared read-only (callers never mutate them).
  const BUST = (() => { const d = new Float64Array(6); d[0] = 1; return d; })();
  const STAND = [];
  for (let t = 17; t <= 21; t++) STAND[t] = pointDealer(t);
  function pointDealer(total) {
    const d = new Float64Array(6);
    d[total - 16] = 1;
    return d;
  }

  return function D(hard, aces, comp) {
    const soft = aces > 0 && hard + 10 <= 21;
    const total = soft ? hard + 10 : hard;
    if (total > 21) return BUST;
    if (total >= 17 && !(h17 && soft && total === 17)) return STAND[total];

    const key = `${hard}|${aces > 0 ? 1 : 0}|${comp.join(',')}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const n = sum(comp);
    const d = new Float64Array(6);
    if (n === 0) {
      // Degenerate: shoe exhausted mid-draw (reachable only with a nearly
      // dead shoe). Convention: dealer stands on 17+, a stuck dealer counts
      // as bust. Never hit for healthy compositions.
      if (total >= 17) d[total - 16] = 1;
      else d[0] = 1;
    } else {
      for (let r = 0; r < 10; r++) {
        const cnt = comp[r];
        if (!cnt) continue;
        const child = comp.slice();
        child[r]--;
        const sub = D(hard + RANK_VALUE[r], aces + (r === ACE ? 1 : 0), child);
        const p = cnt / n;
        for (let i = 0; i < 6; i++) d[i] += p * sub[i];
      }
    }
    memo.set(key, d);
    return d;
  };
}

function checkCounts(x, name) {
  if (
    !Array.isArray(x) ||
    x.length !== 10 ||
    x.some(n => !Number.isInteger(n) || n < 0)
  ) {
    throw new EngineError(`${name} must be an array of 10 non-negative integers.`);
  }
}

/**
 * @param {object} q
 * @param {number} q.decks   deck count, 1–16
 * @param {number[]} q.out   rank counts of ALL cards known to be out
 *                           (player hand + upcard + anything else seen)
 * @param {number} q.upcard  rank index of the dealer upcard (must be in `out`)
 * @param {number[]} q.hand  rank counts of the player's current hand (⊆ `out`)
 * @param {boolean} [q.peek] dealer peeks for blackjack (default true)
 * @param {boolean} [q.h17]  dealer hits soft 17 (default false)
 */
export function evaluate({ decks, out, upcard, hand, peek = true, h17 = false }) {
  checkCounts(out, 'out');
  checkCounts(hand, 'hand');
  if (!Number.isInteger(upcard) || upcard < 0 || upcard > 9) {
    throw new EngineError('upcard must be a rank index 0–9.');
  }
  for (let r = 0; r < 10; r++) {
    if (hand[r] > out[r]) throw new EngineError('hand must be a subset of out.');
  }
  if (out[upcard] - hand[upcard] < 1) {
    throw new EngineError('out must contain the dealer upcard besides the hand.');
  }

  const info = handInfo(hand);
  if (info.cards < 2) throw new EngineError('hand must contain at least two cards.');

  const meta = { decks, peek, h17, unseen: 0, pBJ: 0 };
  if (info.blackjack) {
    return { player: info, blackjack: true, actions: null, best: null, dealer: null, meta };
  }

  const full = fullShoe(decks);
  // base = unseen cards + the player's current hand. The hand is subtracted
  // again per recursion node, so `base` stays fixed for the whole search.
  const base = new Array(10);
  for (let r = 0; r < 10; r++) {
    const knownOut = out[r] - hand[r]; // upcard + extra seen cards
    base[r] = full[r] - knownOut;
    if (base[r] < hand[r]) {
      throw new EngineError(
        `Composition error: more ${RANKS[r]}s accounted for than ${decks} deck(s) contain.`
      );
    }
  }
  const unseen = sum(base) - info.cards;
  meta.unseen = unseen;
  if (unseen < 10) {
    throw new EngineError(
      `Only ${unseen} unseen cards left — too few to deal out a round. Start a new shoe.`
    );
  }

  const D = createDealerDist(h17);
  const vMemo = new Map(); // player multiset -> best-action histogram

  const isBjHole = h => (upcard === ACE && h === TEN) || (upcard === TEN && h === ACE);

  /** Hole-card law over the given composition (peek-conditioned if enabled). */
  function holeWeights(B) {
    const n = sum(B);
    let z = n;
    if (peek) {
      if (upcard === ACE) z -= B[TEN];
      else if (upcard === TEN) z -= B[ACE];
    }
    if (z <= 0) {
      throw new EngineError('Inconsistent shoe: no admissible hole card remains.');
    }
    const w = new Array(10).fill(0);
    for (let h = 0; h < 10; h++) {
      if (peek && isBjHole(h)) continue;
      w[h] = B[h] / z;
    }
    return { w, n };
  }

  const dealerStart = h => ({
    hard: RANK_VALUE[upcard] + RANK_VALUE[h],
    aces: (upcard === ACE ? 1 : 0) + (h === ACE ? 1 : 0),
  });

  /** Accumulate `weight` × P(net) of standing/doubling on `playerTotal`. */
  function addPayoff(into, weight, playerTotal, dist, stake) {
    if (playerTotal > 21) {
      into[-stake + 2] += weight;
      return;
    }
    for (let i = 0; i < 6; i++) {
      const p = dist[i] * weight;
      if (p === 0) continue;
      if (i === 0) {
        into[stake + 2] += p; // dealer busts
      } else {
        const dealerTotal = 16 + i;
        if (dealerTotal > playerTotal) into[-stake + 2] += p;
        else if (dealerTotal < playerTotal) into[stake + 2] += p;
        else into[2] += p;
      }
    }
  }

  function addWeighted(into, weight, hist) {
    for (let i = 0; i < 5; i++) into[i] += weight * hist[i];
  }

  /** Values of every available action at a player node (hand given as counts). */
  function Q(pc) {
    const node = handInfo(pc);
    if (node.bust) {
      return { stand: pointHist(-1), hit: null, double: null, best: 'stand' };
    }
    // Hitting a 21 can never help (it busts or makes the same/less total), so
    // the action is simply not offered.
    const canHit = node.total < 21;

    const B = new Array(10);
    for (let r = 0; r < 10; r++) B[r] = base[r] - pc[r];

    const { w, n } = holeWeights(B);
    const standH = new Float64Array(5);
    let hitH = canHit ? new Float64Array(5) : null;
    let dblH = node.cards === 2 ? new Float64Array(5) : null;

    const nLeft = n - 1; // cards left for the player's draw after the hole card

    for (let h = 0; h < 10; h++) {
      const ph = w[h];
      if (ph === 0) continue;

      if (!peek && isBjHole(h)) {
        // ENHC: dealer blackjack ends the round; a doubled bet loses both units.
        standH[1] += ph;
        if (hitH) hitH[1] += ph;
        if (dblH) dblH[0] += ph;
        continue;
      }

      const comp = B.slice();
      comp[h]--;
      const start = dealerStart(h);

      addPayoff(standH, ph, node.total, D(start.hard, start.aces, comp), 1);

      if (hitH && nLeft > 0) {
        for (let r = 0; r < 10; r++) {
          const cnt = comp[r];
          if (!cnt) continue;
          const pc2 = pc.slice();
          pc2[r]++;
          addWeighted(hitH, (ph * cnt) / nLeft, V(pc2));
        }
      }
      if (dblH && nLeft > 0) {
        for (let r = 0; r < 10; r++) {
          const cnt = comp[r];
          if (!cnt) continue;
          const comp2 = comp.slice();
          comp2[r]--;
          const pc2 = pc.slice();
          pc2[r]++;
          const after = handInfo(pc2);
          addPayoff(dblH, (ph * cnt) / nLeft, after.total, D(start.hard, start.aces, comp2), 2);
        }
      }
    }

    // A degenerate (nearly empty) shoe can leave an action unconditionally
    // impossible; drop it rather than report a partial distribution.
    if (hitH && Math.abs(histMass(hitH) - 1) > 1e-9) hitH = null;
    if (dblH && Math.abs(histMass(dblH) - 1) > 1e-9) dblH = null;

    let best = 'stand';
    let bestEV = histEV(standH);
    if (hitH && histEV(hitH) > bestEV + 1e-12) {
      best = 'hit';
      bestEV = histEV(hitH);
    }
    if (dblH && histEV(dblH) > bestEV + 1e-12) {
      best = 'double';
    }
    return { stand: standH, hit: hitH, double: dblH, best };
  }

  /** Optimal-play value (histogram) of a player node; memoized by multiset. */
  function V(pc) {
    const key = pc.join(',');
    const cached = vMemo.get(key);
    if (cached) return cached;
    const q = Q(pc);
    const best = q[q.best];
    vMemo.set(key, best);
    return best;
  }

  const root = Q(hand);

  // Hole-integrated dealer outcome distribution, for display.
  const Broot = new Array(10);
  for (let r = 0; r < 10; r++) Broot[r] = base[r] - hand[r];
  const { w } = holeWeights(Broot);
  const dealerDist = new Float64Array(6);
  let bj = 0;
  for (let h = 0; h < 10; h++) {
    const ph = w[h];
    if (ph === 0) continue;
    if (!peek && isBjHole(h)) {
      bj += ph;
      continue;
    }
    const comp = Broot.slice();
    comp[h]--;
    const s = dealerStart(h);
    const d = D(s.hard, s.aces, comp);
    for (let i = 0; i < 6; i++) dealerDist[i] += ph * d[i];
  }
  if (bj > 0) {
    for (let i = 0; i < 6; i++) dealerDist[i] /= 1 - bj;
  }
  meta.pBJ = bj;

  const toAction = h =>
    h ? { ev: histEV(h), win: h[3] + h[4], push: h[2], lose: h[0] + h[1] } : null;

  return {
    player: info,
    blackjack: false,
    actions: {
      stand: toAction(root.stand),
      hit: toAction(root.hit),
      double: toAction(root.double),
    },
    best: info.bust ? null : root.best,
    dealer: { dist: Array.from(dealerDist), bj },
    meta,
  };
}
