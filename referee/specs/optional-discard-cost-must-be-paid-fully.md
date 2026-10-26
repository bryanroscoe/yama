# Spec: "You may discard two cards. If you do, ..." with only one card in hand

Scenario: `card-thrilling-discovery` (card sweep, batch 2).

## 1. Card

- **Thrilling Discovery** {R}{W}, Sorcery. "You gain 2 life. Then you may discard two cards. If you do, draw three cards."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Mountain + Plains. Seat 0 casts Thrilling Discovery; it resolves. At that moment seat 0's hand is a single Wastes.

## 3. Correct result

Seat 0 gains 2 life (22). It can't discard two cards with one card in hand, so it can't take the option, and it draws nothing. Final: hand one Wastes, library 8, graveyard Divination, Hill Giant, Thrilling Discovery, life 22. (Forge matches.)

## 4. Why

1. 118.12: in "[A player] may [do something]. If [that player] does, [effect]", the action is a cost paid as the spell resolves.
2. 118.3: "A player can't pay a cost without having the necessary resources to pay it fully." Discarding two cards needs two cards in hand. Partial payment isn't allowed (601.2h's principle; also 608.2d: a player can't choose an option that's impossible).
3. So the "if you do" condition is false and no cards are drawn. Nothing is discarded either.

## 5. What phase did

Discarded the one Wastes and drew three cards (hand three Wastes, library 5).

## 6. Variations to test

- Two cards in hand: may discard both and draw three; or decline and keep both.
- Three cards in hand: choose which two to discard.
- Zero cards in hand: no option, no draw.
- The same shape on other cards ("you may sacrifice two creatures. If you do, ...", "you may pay {E}{E}. If you do, ...") with only one available: the option can't be taken.
- Contrast: a mandatory "discard two cards, then draw three" with one card in hand discards that one and still draws (609.3 does as much as possible; no "if you do").

## 7. Acceptance checks

- On this board, after Thrilling Discovery resolves, seat 0 has 22 life, exactly one Wastes in hand, 8 cards in library, and Thrilling Discovery, Divination and Hill Giant in its graveyard.
