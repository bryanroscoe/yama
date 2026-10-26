# Spec: Seize the Spotlight's fortune draw goes to the caster

Scenario: `card-seize-the-spotlight`. Observed: Forge's seat 1 chose fame (seat 0 takes seat 1's Grizzly Bears until end of turn). Phase's seat 1 chose fortune; phase then created the Treasure for seat 0 but had seat 1 draw the card. The fame/fortune choice is each AI's own; who draws is not.

Possibly related: `back-references-resolve-to-wrong-object.md` (Part E) (an effect acting on the wrong player).

## 1. Card

- **Seize the Spotlight** {2}{R}, Sorcery. "Each opponent chooses fame or fortune. For each player who chose fame, gain control of a creature that player controls until end of turn. Untap those creatures and they gain haste until end of turn. For each player who chose fortune, you draw a card and create a Treasure token."

## 2. Board and actions

Sweep board: seat 0's hand after casting: one Wastes; library 8. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire and two Wastes in hand. Seat 0 casts Seize the Spotlight; it resolves; seat 1 chooses fortune (phase's choice).

## 3. Correct result (seat 1 chose fortune)

- Seat 0 draws a card: seat 0 hand two Wastes, library 7.
- Seat 0 creates a Treasure token.
- Seat 1's hand and library are unchanged (2 cards, 8 cards).

If seat 1 chooses fame instead: seat 0 gains control of one creature seat 1 controls (seat 0 picks), untaps it, and it gains haste, all until end of turn; nobody draws.

## 4. Why

1. "You" on a spell means its controller (109.5): seat 0.
2. 608.2c: for each opponent who chose fortune, "you draw a card and create a Treasure token": both the draw and the Treasure are seat 0's.

## 5. What phase did

Gave the Treasure to seat 0 correctly but made seat 1 (the player who chose fortune) draw the card.

## 6. Variations to test

- Seat 1 chooses fame: seat 0 gains control of one of seat 1's creatures until end of turn, untapped, with haste; no draw, no Treasure.
- Multiplayer with two opponents choosing fortune: seat 0 draws two and makes two Treasures.
- Mixed choices: fame for one opponent (take one of their creatures), fortune for another (draw and Treasure).

## 7. Acceptance checks

- Whatever opponents choose, every card drawn by Seize the Spotlight is drawn by its controller.
- Each fortune choice gives the controller exactly one card and one Treasure.
