# Spec: "Your life total becomes N" does nothing

Scenario: `card-invincible-hymn` (card sweep, batch 2).

## 1. Card

- **Invincible Hymn** {6}{W}{W}, Sorcery. "Count the number of cards in your library. Your life total becomes that number."
  - Ruling 2008-10-01: "Invincible Hymn checks the number of cards in your library just once: when it resolves."
  - Ruling 2008-10-01: "For your life total to become the appropriate number, you actually gain or lose the necessary amount of life. For example, if your life total is 20 and your library has thirty-two cards in it when Invincible Hymn resolves, Invincible Hymn will cause you to gain 12 life."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Plains, Plains + 6 Wastes. Seat 0 casts Invincible Hymn; it resolves.

## 3. Correct result

Seat 0's library has 8 cards, so seat 0's life total becomes 8: it loses 12 life (20 → 8). (Forge matches.)

## 4. Why

1. 608.2h: the count is taken once, as the effect is applied: 8.
2. 119.5: "If an effect sets a player's life total to a specific number, the player gains or loses the necessary amount of life to end up with the new total." So this is a 12-point life loss, which other effects can see (e.g. "whenever you lose life").

## 5. What phase did

Seat 0 stayed at 20; the spell went to the graveyard with no life change.

## 6. Variations to test

- Library larger than life (e.g. 32 cards at 20 life): gain 12.
- Library equal to life: no change, and no life gain/loss event.
- Empty library: life becomes 0 and the player loses at the next state-based check (704.5a).
- An effect that says the player can't gain life, with a library above the life total: life stays (it can't gain); with "can't lose life" and a smaller library: life stays.
- Other "life total becomes" cards should follow the same rule.

## 7. Acceptance checks

- On this board, after Invincible Hymn resolves, seat 0's life is 8.
