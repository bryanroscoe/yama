# Spec: "Whenever a card is drawn this way" never triggers

Scenario: `card-explosion-of-riches` (card sweep, batch 2).

## 1. Card

- **Explosion of Riches** {5}{R}, Sorcery. "Draw a card, then each other player may draw a card. Whenever a card is drawn this way, Explosion of Riches deals 5 damage to target opponent chosen at random from among your opponents."
  - Ruling 2020-11-10: "Explosion of Riches goes on the stack without a target. While the spell is resolving, you draw a card, then each other player in turn order chooses whether to draw a card. After that, each other player who chose to draw a card does so. Finally, Explosion of Riches's reflexive triggered ability triggers for each card drawn while it was resolving, and those abilities are put on the stack with random targets."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Mountain + 5 Wastes. Seat 0 casts Explosion of Riches; it resolves. Seat 1 chose to draw (in both engines).

## 3. Correct result

Two cards were drawn by the spell (one by seat 0, one by seat 1). Each draw triggers the reflexive ability once: two triggers, each targeting an opponent chosen at random (only seat 1). Each deals 5 damage to seat 1. Final: seat 1 at 10 life; seat 0 has one more card in hand, seat 1 one more card in hand. (Forge matches: two triggers, 20 → 15 → 10.)

## 4. Why

1. 603.12: a resolving spell may create a reflexive triggered ability that triggers on "when [something happens] this way". It's checked immediately after being created and triggers based on whether the event happened earlier during the spell's resolution.
2. 603.12a: if the event happened several times during the resolution, the reflexive ability triggers once for each time. Two draws → two triggers.
3. The triggers go on the stack the next time a player would receive priority; the target opponent is chosen at random when each is put on the stack. They resolve and deal 5 damage each (120.3a: damage to a player causes that much life loss).

## 5. What phase did

Both players drew, but no damage was dealt; seat 1 stayed at 20. No trigger appears in phase's log.

## 6. Variations to test

- Seat 1 declines to draw: one trigger, seat 1 at 15.
- Three-player game: up to three triggers, each choosing a target opponent at random independently.
- A replacement effect that replaces seat 0's draw with something else (e.g. dredge): that card wasn't drawn, so no trigger for it.
- An opponent with hexproof: the random choice is among legal targets (opponents that can be targeted).

## 7. Acceptance checks

- On this board, after Explosion of Riches and its triggers resolve with seat 1 choosing to draw, seat 1 is at 10 life.
- If seat 1 declines to draw, seat 1 is at 15 life.
