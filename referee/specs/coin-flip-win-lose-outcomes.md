# Spec: "For each flip you win, ... For each flip you lose, ... to that player"

Root cause (observed behaviour): after a lost coin flip, phase applied *both* outcomes (drew a card as if the flip were won) and dealt the lost-flip damage to the flipping player instead of the opponent the flip was for.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-mutalith-vortex-beast`.

## 1. Card

Oracle text and rulings from Scryfall.

- **Mutalith Vortex Beast** ({4}{U}{R} Creature — Mutant Beast 6/6): "Trample. Warp Vortex — When this creature enters, flip a coin for each opponent you have. For each flip you win, draw a card. For each flip you lose, this creature deals 3 damage to that player."
  - 2022-10-07: "Mutalith's Vortex Beast deals 3 damage to the appropriate player for each lost flip, not 3 damage to each of those players for each lost flip."

## 2. Board and actions

Seat 0 (active, main phase 1) casts Mutalith Vortex Beast; it resolves; its enters trigger resolves. Seat 1 is seat 0's only opponent. Both at 20 life; seat 0's library is 8 Wastes, hand one Wastes.

## 3. Correct result

Seat 0 flips one coin (one opponent), associated with seat 1.

- **Win:** seat 0 draws one card (hand 1 → 2, library 8 → 7). No damage. Life 20 / 20.
- **Lose:** Mutalith Vortex Beast deals 3 damage to **seat 1** (20 → 17). Seat 0 draws nothing (hand 1, library 8). Seat 0 stays at 20.

Never both; never damage to seat 0. (Forge: won, drew one; phase: lost, see below.)

## 4. Why

1. 705.2: the flipping player calls heads or tails and either wins or loses that flip; "Only the player who flips the coin wins or loses the flip."
2. Each flip is one of the "flip a coin for each opponent you have" flips, so each flip belongs to one opponent; "that player" in the lose clause is the opponent that flip was for (ruling: "the appropriate player").
3. The win clause and the lose clause are mutually exclusive for a single flip (608.2c, plain English): a won flip draws, a lost flip deals damage.

## 5. What phase did

Logged "Player 1 flips a coin: loses", then "Player 1 draws a card", then "Mutalith Vortex Beast deals 3 damage to Player 1". Final: seat 0 at 17 life with a card drawn; seat 1 at 20.

## 6. Variations to test

- **Forced win / forced lose** (seeded RNG or a "you win all flips" effect such as Krark's Thumb-style or 705.3 "certain player wins"): win → draw 1, no damage; lose → 3 damage to the opponent, no draw.
- **Three opponents:** three flips, one per opponent; each lost flip deals 3 to its own opponent only (ruling). E.g. win, lose, lose: draw 1, two different opponents take 3 each.
- **Damage source:** the damage is dealt by Mutalith Vortex Beast (a creature), so lifelink/infect/deathtouch on it would apply; if it left the battlefield, last known information is used (608.2h).

## 7. Acceptance checks

- A lost flip never draws a card and never damages the flipping player; it deals exactly 3 damage to the opponent that flip was for.
- A won flip draws exactly one card and deals no damage.
