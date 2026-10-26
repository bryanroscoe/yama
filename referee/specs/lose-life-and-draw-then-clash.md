# Spec: Hoarder's Greed loses life but never draws or clashes

Root cause (observed behaviour): phase applied only the first instruction of "You lose 2 life and draw two cards, then clash with an opponent. If you win, repeat this process." It took the 2 life and stopped: no cards drawn, no clash.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-hoarder-s-greed`.

## 1. Card

Oracle text and rulings from Scryfall.

- **Hoarder's Greed** ({3}{B} sorcery): "You lose 2 life and draw two cards, then clash with an opponent. If you win, repeat this process. (Each clashing player reveals the top card of their library, then puts that card on their choice of the top or bottom. A player wins if their card had a greater mana value.)"
  - 2007-10-01: "The effect will automatically repeat itself until its controller doesn't win the clash. There's no other way to stop it."

## 2. Board and actions

Seat 0 (active, main phase 1) at 20 life; hand one Wastes; library 8 Wastes. Seat 1's library is 8 Wastes. Seat 0 casts Hoarder's Greed; it resolves.

## 3. Correct result

1. Seat 0 loses 2 life (20 → 18) and draws two cards (hand 1 → 3 Wastes, library 8 → 6).
2. Seat 0 clashes with seat 1: each reveals the top card of their library (Wastes, mana value 0, for both) and chooses to leave it on top or put it on the bottom.
3. Seat 0's card's mana value (0) is not greater than seat 1's (0), so seat 0 doesn't win: the process doesn't repeat.

Final: **seat 0 life 18, hand 3 Wastes, library 6**; seat 1 unchanged (library still 8). (Forge: exactly this, both put their revealed Wastes on the bottom.)

## 4. Why

1. The instructions are followed in order (608.2c): lose 2 life, draw two cards, clash.
2. 701.30a/b: to clash, each player reveals the top card of their library and may put it on the bottom; "clash with an opponent" means choose an opponent, then both clash. Both reveal at the same time and decide top/bottom in APNAP order (701.30c). "A player wins a clash if that player revealed a card with a higher mana value than all other cards revealed in that clash" (701.30d).
3. Repeat only on a win (ruling: repeats until its controller doesn't win).

## 5. What phase did

Logged "Player 1 loses 2 life", then the spell went to the graveyard. Final: life 18, hand 1 Wastes, library 8. No draw, no clash.

## 6. Variations to test

- **Seat 0 wins the first clash:** seat 0's library top is Hill Giant (MV 4), seat 1's top is Wastes. Seat 0 loses 2 more life and draws two more cards (the Hill Giant if left on top), then clashes again; repeats while it keeps winning.
- **Opponent's library empty:** seat 1 reveals no card; under 701.30d seat 0 wins if its revealed card has a higher mana value than all other cards revealed, and there are none, so seat 0 wins with any card and the process repeats (until seat 0's own library runs out or it reveals nothing).
- **Draw from a short library:** with one card left, seat 0 draws one and would draw from an empty library — it loses at the next state-based action check (704.5b).
- **Clash triggers:** "whenever you clash" abilities trigger once per clash.

## 7. Acceptance checks

- Hoarder's Greed always draws two cards for each 2 life it takes.
- After the draw, a clash happens (both players reveal their top card) and the process repeats only when the caster's card has strictly greater mana value.
