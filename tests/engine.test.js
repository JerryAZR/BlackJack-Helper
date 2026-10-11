import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, handInfo, fullShoe, countsOf, EngineError } from '../src/engine.js';
import { runEngine, R } from './util.js';
import { infiniteDealerOutcome } from './reference.js';

/* ------------------------------------------------------------------ */
/* unit: hand totals                                                   */
/* ------------------------------------------------------------------ */

test('handInfo computes totals, softness, bust and blackjack', () => {
  const h = cards => handInfo(countsOf(cards.map(R)));
  let r;

  r = h(['A', '7']);
  assert.equal(r.total, 18); assert.ok(r.soft); assert.equal(r.blackjack, false);

  r = h(['A', 'A']);
  assert.equal(r.total, 12); assert.ok(r.soft);

  r = h(['A', 'A', '9']);
  assert.equal(r.total, 21); assert.ok(r.soft); assert.equal(r.blackjack, false);

  r = h(['10', '6', 'A']);
  assert.equal(r.total, 17); assert.equal(r.soft, false);

  r = h(['10', '9', 'A', 'A']);
  assert.equal(r.total, 21); assert.equal(r.soft, false);

  r = h(['9', '7', '10']);
  assert.equal(r.bust, true); assert.equal(r.total, 26);

  r = h(['A', '10']);
  assert.equal(r.blackjack, true);

  r = h(['7', '10', '4']);
  assert.equal(r.total, 21); assert.equal(r.blackjack, false);
});

test('fullShoe builds a full composition and rejects bad deck counts', () => {
  assert.deepEqual(fullShoe(1), [4, 4, 4, 4, 4, 4, 4, 4, 4, 16]);
  assert.deepEqual(fullShoe(8), [32, 32, 32, 32, 32, 32, 32, 32, 32, 128]);
  for (const bad of [0, -1, 1001, 2.5, '2']) {
    assert.throws(() => fullShoe(bad), EngineError);
  }
});

/* ------------------------------------------------------------------ */
/* unit: input validation and terminal roots                           */
/* ------------------------------------------------------------------ */

test('evaluate validates its inputs', () => {
  const counts = countsOf([R('A'), R('7')]);
  // hand not a subset of out
  assert.throws(() => evaluate({ decks: 1, out: countsOf([R('A')]), upcard: R('2'), hand: counts }), EngineError);
  // upcard missing from out
  assert.throws(() => evaluate({ decks: 1, out: counts, upcard: R('2'), hand: counts }), EngineError);
  // fewer than two cards
  assert.throws(() => evaluate({
    decks: 1, out: countsOf([R('A'), R('7'), R('2')]), upcard: R('2'), hand: countsOf([R('A')]),
  }), EngineError);
  // more cards logged than the shoe contains (5 aces in 1 deck)
  assert.throws(() => runEngine({
    decks: 1, hand: ['A', 'A'], upcard: 'A', extra: ['A', 'A'],
  }), EngineError);
});

test('blackjack and bust roots', () => {
  const bj = runEngine({ hand: ['A', '10'], upcard: '6' });
  assert.equal(bj.blackjack, true);
  assert.equal(bj.actions, null);

  const bust = runEngine({ hand: ['10', '6', '10'], upcard: '10' });
  assert.equal(bust.player.bust, true);
  assert.equal(bust.best, null);
  assert.equal(bust.actions.stand.ev, -1);
  assert.equal(bust.actions.hit, null);
  assert.equal(bust.actions.double, null);
});

test('hitting is not offered at 21', () => {
  const res = runEngine({ hand: ['7', '7', '7'], upcard: '10' });
  assert.equal(res.actions.hit, null);
  assert.equal(res.best, 'stand');
});

/* ------------------------------------------------------------------ */
/* dealer distribution vs independent with-replacement reference       */
/* ------------------------------------------------------------------ */

test('dealer distribution matches the with-replacement reference at 500 decks', () => {
  for (const up of ['2', '5', '6', '7', '9', 'A', '10']) {
    for (const h17 of [false, true]) {
      const res = runEngine({ decks: 500, hand: ['5', '4'], upcard: up, h17 });
      const ref = infiniteDealerOutcome(R(up), { h17, noBjHole: true });
      const buckets = ['bust', '17', '18', '19', '20', '21'];
      buckets.forEach((k, i) => {
        const got = res.dealer.dist[i];
        assert.ok(
          Math.abs(got - ref[k]) < 2e-3,
          `up ${up} h17=${h17} ${k}: engine ${got} vs ref ${ref[k]}`
        );
      });
      const sum = res.dealer.dist.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9);
    }
  }
});

test('dealer bust rates match cross-validated infinite-deck values (S17)', () => {
  // Bands centered on values agreed by three independent computations in this
  // repo (engine, with-replacement recurrence, direct Monte Carlo) at 500
  // decks; ±0.5% still catches gross rule errors (an S17/H17 swap moves the
  // 6-up bust rate by ~1.6 points). Widely-published tables vary by source
  // and convention; the 2-up figure matches the classic 35.35%.
  const bands = {
    2: [0.348, 0.359], 3: [0.369, 0.379], 4: [0.389, 0.400], 5: [0.411, 0.422],
    6: [0.418, 0.428], 7: [0.257, 0.267], 9: [0.223, 0.233],
  };
  for (const [up, [lo, hi]] of Object.entries(bands)) {
    const bust = runEngine({ decks: 500, hand: ['5', '4'], upcard: up }).dealer.dist[0];
    assert.ok(bust > lo && bust < hi, `up ${up}: bust ${bust} not in [${lo}, ${hi}]`);
  }
});

test('S17 vs H17 changes the dealer distribution for relevant upcards', () => {
  const s = runEngine({ decks: 8, hand: ['10', '8'], upcard: 'A' }).actions.stand.ev;
  const h = runEngine({ decks: 8, hand: ['10', '8'], upcard: 'A', h17: true }).actions.stand.ev;
  assert.ok(Math.abs(s - h) > 1e-4, `S17 ${s} vs H17 ${h} should differ`);
});

/* ------------------------------------------------------------------ */
/* infinite-deck strategy anchors                                      */
/* ------------------------------------------------------------------ */

test('advice matches standard infinite-deck basic strategy (peek, S17)', () => {
  const cases = [
    // [hand, upcard, expected best action] — standard US rules, no surrender
    [['10', '6'], '10', 'hit'],
    [['10', '5'], '10', 'hit'],
    [['10', '2'], '10', 'hit'],
    [['4', '5'], '2', 'hit'],
    [['3', '5'], '5', 'hit'],
    [['A', '7'], '9', 'hit'],
    [['A', '2'], '4', 'hit'],
    [['10', '6'], '6', 'stand'],
    [['10', '3'], '2', 'stand'],
    [['10', '7'], 'A', 'stand'],
    [['10', '10'], '5', 'stand'],
    [['A', '8'], '2', 'stand'],
    [['6', '5'], '6', 'double'],
    [['6', '5'], '10', 'double'],
    [['5', '5'], '9', 'double'],
    [['6', '3'], '3', 'double'],
    [['A', '7'], '4', 'double'],
    [['A', '6'], '3', 'double'],
    [['A', '5'], '4', 'double'],
    [['A', '2'], '6', 'double'],
  ];
  for (const [hand, up, want] of cases) {
    const res = runEngine({ decks: 500, hand, upcard: up });
    assert.equal(res.best, want, `${hand.join(' ')} vs ${up}`);
  }
});

test('H17 anchor: soft 19 doubles vs 6 when the dealer hits soft 17', () => {
  const res = runEngine({ decks: 500, hand: ['A', '8'], upcard: '6', h17: true });
  assert.equal(res.best, 'double');
});

/* ------------------------------------------------------------------ */
/* peek / no-peek mechanics                                            */
/* ------------------------------------------------------------------ */

test('ENHC adjustment identity holds for terminal actions', () => {
  const cases = [
    { decks: 1, hand: ['10', '6'], upcard: '10' },
    { decks: 1, hand: ['A', '7'], upcard: 'A' },
    { decks: 2, hand: ['6', '5'], upcard: 'A' },
    { decks: 8, hand: ['9', '7'], upcard: '10' },
    { decks: 1, hand: ['7', '7'], upcard: 'A' },
  ];
  for (const c of cases) {
    const p = runEngine({ ...c, peek: true });
    const n = runEngine({ ...c, peek: false });
    const pBJ = n.dealer.bj;
    assert.ok(pBJ > 0, `case should have dealer-BJ mass: ${JSON.stringify(c)}`);
    assert.ok(
      Math.abs(n.actions.stand.ev - (-pBJ + (1 - pBJ) * p.actions.stand.ev)) < 1e-10,
      `stand identity for ${JSON.stringify(c)}`
    );
    assert.ok(
      Math.abs(n.actions.double.ev - (-2 * pBJ + (1 - pBJ) * p.actions.double.ev)) < 1e-10,
      `double identity for ${JSON.stringify(c)}`
    );
    assert.ok(n.actions.double.ev < p.actions.double.ev);
  }
});

test('peek toggle is a no-op for upcards 2 through 9', () => {
  for (const up of ['2', '6', '9']) {
    const p = runEngine({ decks: 1, hand: ['10', '6'], upcard: up, peek: true });
    const n = runEngine({ decks: 1, hand: ['10', '6'], upcard: up, peek: false });
    assert.equal(n.dealer.bj, 0);
    assert.equal(p.actions.stand.ev, n.actions.stand.ev);
    assert.equal(p.actions.hit.ev, n.actions.hit.ev);
    assert.equal(p.actions.double.ev, n.actions.double.ev);
  }
});

test('no-peek dealer blackjack probability is exact (1 deck)', () => {
  // (10,6) v A: the player holds one ten, so 15 of 49 unseen cards complete the BJ
  const a = runEngine({ decks: 1, hand: ['10', '6'], upcard: 'A', peek: false });
  assert.ok(Math.abs(a.dealer.bj - 15 / 49) < 1e-12);
  // no tens or aces out: all 16 unseen tens complete it
  const b = runEngine({ decks: 1, hand: ['9', '7'], upcard: 'A', peek: false });
  assert.ok(Math.abs(b.dealer.bj - 16 / 49) < 1e-12);
  const t = runEngine({ decks: 1, hand: ['9', '7'], upcard: '10', peek: false });
  assert.ok(Math.abs(t.dealer.bj - 4 / 49) < 1e-12);
});

/* ------------------------------------------------------------------ */
/* composition dependence                                              */
/* ------------------------------------------------------------------ */

test('EVs depend on deck count and on which cards are out', () => {
  // Standing on 16 v 10 with no tens in hand: clearly composition-sensitive
  const one = runEngine({ decks: 1, hand: ['9', '7'], upcard: '10' }).actions.stand.ev;
  const big = runEngine({ decks: 500, hand: ['9', '7'], upcard: '10' }).actions.stand.ev;
  assert.ok(Math.abs(one - big) > 0.015, `1 deck ${one} vs 500 decks ${big}`);
  // the effect shrinks with deck count
  const eight = runEngine({ decks: 8, hand: ['9', '7'], upcard: '10' }).actions.stand.ev;
  assert.ok(Math.abs(eight - big) < 0.01);
  // holding a ten vs not changes the stand/hit gap a lot in a single deck
  const gap = hand => {
    const r = runEngine({ decks: 1, hand, upcard: '10' });
    return r.actions.stand.ev - r.actions.hit.ev;
  };
  assert.ok(Math.abs(gap(['10', '6']) - gap(['9', '7'])) > 0.005);
});

test('extra seen cards shift the advice composition', () => {
  const without = runEngine({ decks: 1, hand: ['10', '6'], upcard: '10' });
  const withFives = runEngine({ decks: 1, hand: ['10', '6'], upcard: '10', extra: ['5', '5', '5', '5'] });
  assert.notEqual(without.actions.stand.ev, withFives.actions.stand.ev);
  assert.ok(Math.abs(without.actions.stand.ev - withFives.actions.stand.ev) > 1e-3);
});

/* ------------------------------------------------------------------ */
/* well-formedness and performance                                     */
/* ------------------------------------------------------------------ */

test('action distributions are well-formed', () => {
  const res = runEngine({ decks: 2, hand: ['A', '7'], upcard: '3' });
  for (const a of ['stand', 'hit', 'double']) {
    const act = res.actions[a];
    assert.ok(act, `${a} should be available for soft 18 vs 3`);
    assert.ok(Math.abs(act.win + act.push + act.lose - 1) < 1e-9);
    assert.ok(act.ev >= -2 && act.ev <= 2);
    const twoUnits = a === 'double';
    assert.ok(
      Math.abs(act.ev - (twoUnits ? 2 : 1) * (act.win - act.lose)) < 1e-12,
      `${a}: EV must match win/lose at the right stake`
    );
  }
});

test('performance: worst-case queries stay interactive', () => {
  const t0 = Date.now();
  runEngine({ decks: 16, hand: ['A', '2'], upcard: '2' });
  runEngine({ decks: 1, hand: ['10', '6'], upcard: '10' });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `two evaluations took ${ms}ms`);
});
