/**
 * Independent reference implementations used to validate the engine.
 *
 * Deliberately structured differently from src/engine.js (card lists instead
 * of count vectors, separate total/dealer/payoff logic, no shared helpers)
 * so that both being wrong the same way is unlikely. Imports nothing from
 * the engine.
 */

const VAL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // hard values, ace = 1

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shoeOf(decks) {
  const c = new Array(10).fill(0);
  for (let r = 0; r < 10; r++) c[r] = r === 9 ? 16 * decks : 4 * decks;
  return c;
}

function totalOf(cards) {
  let hard = 0;
  let aces = 0;
  for (const r of cards) {
    hard += VAL[r];
    if (r === 0) aces++;
  }
  const soft = aces > 0 && hard + 10 <= 21;
  return { total: soft ? hard + 10 : hard, soft, bust: hard > 21 };
}

function countOf(cards, r) {
  let n = 0;
  for (const c of cards) if (c === r) n++;
  return n;
}

/**
 * Dealer final-total distribution with replacement (infinite-deck limit).
 * Returns { bust, 17, 18, 19, 20, 21 }.
 * `noBjHole` conditions on the hole card not completing blackjack
 * (meaningful only for ace / ten upcards).
 */
export function infiniteDealerOutcome(upcard, { h17 = false, noBjHole = false } = {}) {
  const p = r => (r === 9 ? 16 / 52 : 4 / 52);
  const memo = new Map();
  function rec(hard, aces) {
    const soft = aces > 0 && hard + 10 <= 21;
    const total = soft ? hard + 10 : hard;
    if (total > 21) return { bust: 1 };
    if (total >= 17 && !(h17 && soft && total === 17)) {
      const d = { bust: 0 };
      d[total] = 1;
      return d;
    }
    const key = `${hard},${aces}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const out = { bust: 0, 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 };
    for (let r = 0; r < 10; r++) {
      const sub = rec(hard + VAL[r], aces + (r === 0 ? 1 : 0));
      for (const k in out) out[k] += p(r) * (sub[k] || 0);
    }
    memo.set(key, out);
    return out;
  }
  const isBj = h => (upcard === 0 && h === 9) || (upcard === 9 && h === 0);
  let z = 0;
  for (let h = 0; h < 10; h++) if (!(noBjHole && isBj(h))) z += p(h);
  const out = { bust: 0, 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 };
  for (let h = 0; h < 10; h++) {
    if (noBjHole && isBj(h)) continue;
    const w = p(h) / z;
    const start = rec(VAL[upcard] + VAL[h], (upcard === 0 ? 1 : 0) + (h === 0 ? 1 : 0));
    for (const k in out) out[k] += w * (start[k] || 0);
  }
  return out;
}

/**
 * Exact EVs by brute-force recursion over card lists, mirroring the game
 * rules but sharing no abstractions with the engine. `hand` and `out` are
 * arrays of rank indices (hand ⊆ out, upcard ∈ out).
 */
export function naiveEvaluate({ decks, out, upcard, hand, peek = true, h17 = false }) {
  const full = shoeOf(decks);
  // Mirrors the engine's `base`: unseen cards PLUS the player's current hand.
  // Q() subtracts the hand at each node, so it must not be subtracted twice.
  const poolBase = full.map((f, r) => f - countOf(out, r) + countOf(hand, r));
  const isBj = h => (upcard === 0 && h === 9) || (upcard === 9 && h === 0);
  const dealerMemo = new Map();

  function dealerDist(hole, pool) {
    function rec(cards, pool) {
      const t = totalOf(cards);
      if (t.bust) return { bust: 1 };
      const mustHit = t.total < 17 || (h17 && t.soft && t.total === 17);
      if (!mustHit) {
        const d = { bust: 0 };
        d[t.total] = 1;
        return d;
      }
      const key = `${[...cards].sort().join(',')}|${pool.join(',')}`;
      const hit = dealerMemo.get(key);
      if (hit) return hit;
      const n = pool.reduce((a, b) => a + b, 0);
      const out = { bust: 0, 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 };
      if (n === 0) {
        // Degenerate shoe-exhaustion convention, mirroring the engine:
        // stand on 17+, a dealer stuck below 17 counts as bust.
        if (t.total >= 17) out[t.total] = 1;
        else out.bust = 1;
      } else {
        for (let r = 0; r < 10; r++) {
          if (!pool[r]) continue;
          const pool2 = pool.slice();
          pool2[r]--;
          const sub = rec([...cards, r], pool2);
          for (const k in out) out[k] += (pool[r] / n) * (sub[k] || 0);
        }
      }
      dealerMemo.set(key, out);
      return out;
    }
    return rec([upcard, hole], pool);
  }

  function standEv(playerTotal, dist, stake) {
    if (playerTotal > 21) return -stake;
    let ev = dist.bust * stake;
    for (let d = 17; d <= 21; d++) {
      const p = dist[d] || 0;
      ev += p * (d < playerTotal ? stake : d > playerTotal ? -stake : 0);
    }
    return ev;
  }

  const vMemo = new Map();
  function V(cards) {
    const key = [...cards].sort().join(',');
    const hit = vMemo.get(key);
    if (hit !== undefined) return hit;
    const q = Q(cards);
    const best = Math.max(...Object.values(q).filter(v => v !== null));
    vMemo.set(key, best);
    return best;
  }

  function Q(cards) {
    const t = totalOf(cards);
    if (t.bust) return { stand: -1, hit: null, double: null };
    const pool = poolBase.slice();
    for (const r of cards) pool[r]--;

    let z = 0;
    for (let h = 0; h < 10; h++) {
      if (peek && isBj(h)) continue;
      z += pool[h];
    }

    let stand = 0;
    let hit = t.total < 21 ? 0 : null;
    let dbl = cards.length === 2 ? 0 : null;

    for (let h = 0; h < 10; h++) {
      if (peek && isBj(h)) continue;
      const cnt = pool[h];
      if (!cnt) continue;
      const ph = cnt / z;
      const afterHole = pool.slice();
      afterHole[h]--;

      if (!peek && isBj(h)) {
        stand += ph * -1;
        if (hit !== null) hit += ph * -1;
        if (dbl !== null) dbl += ph * -2;
        continue;
      }

      const dist = dealerDist(h, afterHole);
      stand += ph * standEv(t.total, dist, 1);
      const nLeft = afterHole.reduce((a, b) => a + b, 0);

      if (hit !== null && nLeft > 0) {
        for (let r = 0; r < 10; r++) {
          if (!afterHole[r]) continue;
          hit += ((ph * afterHole[r]) / nLeft) * V([...cards, r]);
        }
      }
      if (dbl !== null && nLeft > 0) {
        for (let r = 0; r < 10; r++) {
          if (!afterHole[r]) continue;
          const pool2 = afterHole.slice();
          pool2[r]--;
          const t2 = totalOf([...cards, r]);
          dbl += ((ph * afterHole[r]) / nLeft) * standEv(t2.total, dealerDist(h, pool2), 2);
        }
      }
    }
    return { stand, hit, double: dbl };
  }

  return Q(hand);
}

/**
 * Monte-Carlo estimate of stand / double EV, simulating the round directly
 * from the rules. Independent semantics: dealing, peek rejection sampling,
 * dealer play and payoffs are re-implemented here.
 */
export function simulateEV({
  decks, out, upcard, hand, action,
  peek = true, h17 = false, trials = 1000000, seed = 1,
}) {
  const full = shoeOf(decks);
  const unseen = [];
  for (let r = 0; r < 10; r++) {
    for (let i = 0; i < full[r] - countOf(out, r); i++) unseen.push(r);
  }
  const pt = totalOf(hand);
  const isBj = h => (upcard === 0 && h === 9) || (upcard === 9 && h === 0);
  const rand = mulberry32(seed);

  function dealerPlays(pool, hole) {
    const cards = [upcard, hole];
    for (;;) {
      const t = totalOf(cards);
      if (t.bust) return 'bust';
      if (t.total >= 17 && !(h17 && t.soft && t.total === 17)) return t.total;
      if (pool.length === 0) return t.total >= 17 ? t.total : 'bust';
      const i = (rand() * pool.length) | 0;
      cards.push(pool.splice(i, 1)[0]);
    }
  }
  function payoff(total, result, stake) {
    if (total > 21) return -stake; // player busted — the dealer result is irrelevant
    if (result === 'bust') return stake;
    if (result > total) return -stake;
    if (result < total) return stake;
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < trials; i++) {
    const pool = unseen.slice();
    let holeIdx;
    for (;;) {
      holeIdx = (rand() * pool.length) | 0;
      if (peek && isBj(pool[holeIdx])) continue; // rejection-sample the peek law
      break;
    }
    const hole = pool.splice(holeIdx, 1)[0];
    if (action === 'stand') {
      if (!peek && isBj(hole)) sum += -1;
      else sum += payoff(pt.total, dealerPlays(pool, hole), 1);
    } else {
      const c = pool.splice((rand() * pool.length) | 0, 1)[0];
      const t2 = totalOf([...hand, c]);
      if (!peek && isBj(hole)) sum += -2; // ENHC: doubles lose both units
      else sum += payoff(t2.total, dealerPlays(pool, hole), 2);
    }
  }
  return sum / trials;
}
