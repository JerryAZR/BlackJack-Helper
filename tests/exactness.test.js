import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, R } from './util.js';
import { naiveEvaluate, simulateEV } from './reference.js';

/**
 * The engine's optimizations (memoization on (hard, ace) + composition,
 * count-vector state, re-derived hole-card laws) must not change results.
 * Compare against a brute-force reference that shares no code with it.
 */
test('engine matches brute-force enumeration exactly', () => {
  const cases = [
    { decks: 1, hand: ['10', '6'], up: '10', peek: true, h17: false },
    { decks: 1, hand: ['9', '7'], up: '10', peek: true, h17: false },
    { decks: 1, hand: ['9', '7'], up: '10', peek: false, h17: true },
    { decks: 1, hand: ['A', '7'], up: '9', peek: true, h17: false },
    { decks: 1, hand: ['A', '7'], up: 'A', peek: true, h17: false },
    { decks: 1, hand: ['6', '5'], up: '6', peek: true, h17: false },
    { decks: 2, hand: ['6', '5'], up: '6', peek: false, h17: true },
    { decks: 2, hand: ['8', '8'], up: '10', peek: true, h17: false },
    { decks: 1, hand: ['A', '2'], up: '5', peek: false, h17: true },
    { decks: 1, hand: ['10', '6'], up: '10', extra: ['5', '5', '9'], peek: true, h17: false },
  ];
  for (const c of cases) {
    const eng = runEngine({ ...c, upcard: c.up });
    const ref = naiveEvaluate({
      decks: c.decks,
      out: [...c.hand, c.up, ...(c.extra ?? [])].map(R),
      upcard: R(c.up),
      hand: c.hand.map(R),
      peek: c.peek,
      h17: c.h17,
    });
    for (const a of ['stand', 'hit', 'double']) {
      const e = eng.actions[a] ? eng.actions[a].ev : null;
      const r = ref[a];
      assert.equal(e === null, r === null, `${JSON.stringify(c)} ${a} availability`);
      if (r === null) continue;
      assert.ok(Math.abs(e - r) < 1e-9, `${JSON.stringify(c)} ${a}: engine ${e} vs brute force ${r}`);
    }
  }
});

/**
 * Semantics check with an independently written simulation: deal from the
 * shoe, apply peek by rejection sampling, play the dealer by the rules.
 */
test('stand and double EVs match Monte Carlo simulation', () => {
  const cases = [
    { decks: 1, hand: ['10', '6'], up: '10', action: 'stand', peek: true, h17: false },
    { decks: 1, hand: ['A', '7'], up: 'A', action: 'stand', peek: true, h17: false },
    { decks: 1, hand: ['9', '7'], up: '10', action: 'stand', peek: false, h17: true },
    { decks: 1, hand: ['10', '4'], up: '5', action: 'double', peek: true, h17: false },
    { decks: 1, hand: ['A', '2'], up: '6', action: 'double', peek: true, h17: false },
    { decks: 2, hand: ['6', '5'], up: '6', action: 'double', peek: false, h17: false },
  ];
  cases.forEach((c, i) => {
    const eng = runEngine({ ...c, upcard: c.up }).actions[c.action].ev;
    const mc = simulateEV({
      decks: c.decks,
      out: [...c.hand, c.up].map(R),
      upcard: R(c.up),
      hand: c.hand.map(R),
      action: c.action,
      peek: c.peek,
      h17: c.h17,
      trials: 1000000,
      seed: 20261011 + i,
    });
    // ~6 standard errors at 1M trials: catches real bugs, does not flake
    assert.ok(Math.abs(eng - mc) < 0.012, `${JSON.stringify(c)}: engine ${eng} vs MC ${mc}`);
  });
});
