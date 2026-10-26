# Spec: Profane Transfusion's Horror token (X = difference between the two life totals)

Root cause (observed behaviour): Profane Transfusion exchanges the two players' life totals correctly but never creates the X/X Horror token, even when the life totals differ. (Its other fault, accepting the same player for both targets, is in `target-restrictions-not-enforced.md`, Part B.)

Scenario: `card-profane-transfusion` (standard sweep board, `forge-error`: Forge wouldn't play phase's one-player target list). The sweep board has both players at 20 life, where the token is 0/0 and dies at once, so the missing token only shows with different life totals (variation below, run by hand through the referee runner).

## 1. Card

- **Profane Transfusion** ({6}{B}{B}{B} sorcery): "Two target players exchange life totals. You create an X/X colorless Horror artifact creature token, where X is the difference between those players' life totals."
  Rulings (2020-11-10): "When life totals are exchanged, each player gains or loses the amount of life necessary to equal the other player's life total. For example, if one player has 10 life and the other has 17 life, the first player gains 7 life and the other one loses 7 life." "If a player can't gain life, that player can't exchange life totals with a player with a higher life total. Similarly, a player who can't lose life can't exchange life totals with a player with a lower life total." "Use the difference between the life totals after the exchange to determine the size of the Horror token. Because replacement effects can modify the life gain and life loss, this number may be different from what it was before the exchange."

## 2. Board and actions

Sweep board (seat 0: 3 Swamps + 6 Wastes, Grizzly Bears; seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire), but **seat 0 starts at 10 life**, seat 1 at 20. Seat 0 casts Profane Transfusion targeting seat 0 and seat 1.

## 3. Correct result

1. Exchange: seat 0 gains 10 (to 20), seat 1 loses 10 (to 10).
2. X = |20 - 10| = 10, measured after the exchange (ruling). Seat 0 creates a 10/10 colorless Horror artifact creature token.

Final: seat 0 at 20 life with a 10/10 Horror token (artifact creature, colorless, token); seat 1 at 10; Profane Transfusion in seat 0's graveyard.

On the plain sweep board (both at 20): nothing changes, X = 0, the 0/0 Horror is created and immediately put into the graveyard (704.5f), where it ceases to exist (704.5d). Final board the same as with no token.

## 4. Why

1. 701.12c: exchanging life totals is each player gaining or losing the amount needed to reach the other's previous total.
2. 608.2c / 608.2h: the instructions happen in order; "the difference between those players' life totals" is read when the token is created, after the exchange.
3. 111.2, 111.4: the token is created under the control of the player who creates it ("you"), with the name and characteristics the text gives.
4. 701.12a: if the exchange can't be completed (e.g. one player can't lose life), no part of the exchange happens; the token is still created, with X from the then-current life totals.

## 5. What phase did

With seat 0 at 10 and seat 1 at 20 and targets [seat 0, seat 1] given explicitly: "Player 1 gains 10 life", "Player 2 loses 10 life", then "effect resolves" and the spell went to the graveyard. No Horror token was created.

## 6. Variations to test

- Seat 0 at 25, seat 1 at 20: seat 0 ends at 20, seat 1 at 25; a 5/5 Horror for seat 0.
- Targets are two opponents in a multiplayer game (seat 1 at 30, seat 2 at 12): they swap; seat 0 creates an 18/18 Horror.
- One target player can't gain life (e.g. under a "players can't gain life" effect) and has the lower total: no exchange (701.12a, 119.7); X is the difference of the unchanged totals, so the token is still created at that size.
- A replacement effect changing life gain (e.g. "if you would gain life, you gain twice that much instead") for the lower player: the totals after the exchange decide X (ruling).
- Both players at the same life: 0/0 token, dies at once.

## 7. Acceptance checks

- With seat 0 at 10 and seat 1 at 20, after Profane Transfusion seat 0 has 20 life and a 10/10 colorless Horror artifact creature token, seat 1 has 10.
- The token's size always equals the difference between the two targets' life totals after the exchange.
