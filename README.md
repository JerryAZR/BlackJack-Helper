# ♠ Blackjack Helper

A static web app that tells you whether to **hit, stand, or double** — not from a
memorized strategy chart, but from **exact expected values computed against the
specific cards you can see**.

Live at: **https://jerryazr.github.io/BlackJack-Helper/**

## Rules modeled

| Rule | Default | Toggle |
|---|---|---|
| Decks in shoe | 1 | 1–16, free entry |
| Shoe mode | fresh deck every round | running shoe (cards stay out across rounds) |
| Dealer soft 17 | stands (S17) | hits (H17) |
| Dealer blackjack | peeks — round ends before you act (US) | no peek (ENHC) — a dealer blackjack takes your stake after you act, both units on a double |
| Double | any first two cards, one card after | — |
| Split / surrender / insurance | not offered | — |
| Blackjack payout | 3:2 (no decision involved, so it never affects the advice) | — |

You enter ranks only (J/Q/K count as 10) — suits never matter in blackjack, so
rank-level tracking is exact.

## How the math works

The engine is a small exact recursion, not a simulation and not a lookup table:

1. **Composition tracking.** Your cards, the upcard, and anything else you log
   are removed from the shoe. All EVs are conditioned on the exact remaining
   composition — this is why, e.g., 16 vs 10 gives different advice depending
   on whether your 16 contains a ten (in a single deck).
2. **The hole card is integrated, not guessed.** The dealer's hole card is
   unknown, so every EV sums over all possible hole cards weighted by their
   probability in the remaining composition. With peeking, that distribution
   is conditioned on the dealer *not* having blackjack; without it, the
   possibility of a dealer blackjack is priced into every action.
3. **Optimal future play.** Hitting is evaluated by backward induction over
   every hand you could draw to — the hit EV assumes you keep playing
   optimally afterwards (double only on the first two cards).
4. **Dealer draws without replacement** from the same composition, so card
   removal affects the dealer's probabilities too.

Because unseen cards are exchangeable, re-deriving the hole-card
probabilities from the updated composition after each draw is exact, which
keeps the recursion small. Memoization keys are sufficient statistics:
(hard total, usable ace) + remaining composition for the dealer, hand
multiset for the player.

The advice can differ from published basic strategy for two reasons: there is
no split (pairs are played as totals, which the EV math handles naturally),
and the EVs are composition-dependent rather than chart-averaged.

## Shoe modes

- **Fresh each round** — every round is dealt from a full shoe; the tracker
  resets automatically.
- **Running shoe** — cards stay out across rounds. Log the dealer's revealed
  cards (hole card + draws) and any other players' cards you saw under
  "Seen elsewhere"; the advice sharpens as the shoe depletes. Reset with
  "New shoe".

## Development

```
npm install     # dev-only dependency: jsdom, for the DOM-level smoke test
npm test        # node:test — engine + UI wiring
```

The DOM smoke test loads the real `index.html`, drives the real `ui.js`, and
simulates the full click flow (card entry, acting on advice, undo, round
reset, settings). It skips with a notice when jsdom is not installed; the
engine tests run with zero dependencies.

The test suite checks the engine against:

- **brute-force enumeration** (a separately written reference that shares no
  code with the engine) — agreement to 1e-9,
- **Monte Carlo simulation** of the actual dealing/peek/dealer/play rules,
- a **with-replacement recurrence** for the infinite-deck dealer distribution,
- **strategy and identity anchors** (basic-strategy cells, the exact ENHC
  adjustment identity `EV_no-peek = -pBJ·stake + (1-pBJ)·EV_peek` for
  terminal actions, exact dealer-blackjack probabilities).

## Deployment (GitHub Pages)

The site is fully static — no build step. This repo serves it from the root
of `main`:

- Repo settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`,
  or once with the GitHub CLI:

  ```
  gh api -X POST repos/JerryAZR/BlackJack-Helper/pages --input - <<<'{"source":{"branch":"main","path":"/"}}'
  ```
