# Spec: Hex Magic exiles the hand and draws that many

Root cause (observed behaviour): phase resolves Hex Magic without exiling the hand or drawing.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-hex-magic`.

## 1. Card

- **Hex Magic** ({2}{R} sorcery — Arcane): "Exile all the cards from your hand, then draw that many cards. Until the end of your next turn, you may play cards exiled this way."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Mountain, Wastes ×2, Grizzly Bears; hand: Hex Magic, Wastes; library: 8 Wastes. Seat 0 casts Hex Magic, so while it resolves seat 0's hand is one Wastes.

## 3. Correct result

1. Exile the one card in hand (Wastes).
2. Draw one card.
3. Until the end of seat 0's next turn, seat 0 may play the exiled Wastes (seat 0 hasn't played a land this turn, so it could play it now as its land drop).
Final: exile [Wastes], hand [Wastes], library **7**, Hex Magic in the graveyard.

## 4. Why

608.2c: instructions in order. "That many" is the number of cards actually exiled (608.2h, determined when applied). The play permission is a continuous effect from a resolved spell lasting until the end of the next turn (611.2a); playing a land from exile still uses the land drop (305.2).

## 5. What phase did

Hex Magic went to the graveyard; hand stayed [Wastes], exile empty, library 8. Forge: exile [Wastes], library 7.

## 6. Variations to test

- Empty hand: nothing exiled, draw 0.
- Three cards in hand: exile three, draw three; each exiled card playable (spells cast normally, paying costs; lands as the land drop) through the end of the next turn, not after.
- Library with fewer cards than needed: draw as many as possible; drawing from an empty library makes the player lose at the next state-based check (704.5b).

## 7. Acceptance checks

- After Hex Magic with N cards in hand, those N cards are in exile, N new cards are in hand, and the exiled cards can be played until the end of the caster's next turn.
