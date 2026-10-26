# Spec: "Whenever a face-down creature you control enters" triggers for each one

Scenario: `card-they-came-from-the-pipes` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: both engines manifest dread twice (two face-down 2/2s, two Wastes to the graveyard). Forge then draws two cards; phase draws one.

## 1. Card

- **They Came from the Pipes** ({4}{U} enchantment): "When this enchantment enters, manifest dread twice. (To manifest dread, look at the top two cards of your library. Put one onto the battlefield face down as a 2/2 creature and the other into your graveyard. Turn it face up any time for its mana cost if it's a creature card.) Whenever a face-down creature you control enters, draw a card."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Island, 4 Wastes and Grizzly Bears; hand They Came from the Pipes and a Wastes; library 8 Wastes. Seat 0 casts They Came from the Pipes; it resolves; its enters trigger resolves.

## 3. Correct result

1. The enchantment enters; its first ability triggers and resolves: manifest dread (701.62a) — look at two Wastes, one onto the battlefield face down as a 2/2, the other to the graveyard — and then again.
2. Each manifested card is a face-down creature that enters under seat 0's control. The second ability is on the battlefield the whole time, so it triggers **once for each** of the two (603.2, 603.2c).
3. Both triggers go on the stack after the first trigger finishes resolving (603.3) and each draws one card.

Final for seat 0: two face-down 2/2 creatures; graveyard + 2 Wastes; hand 1 + 2 = three Wastes; library 8 − 4 − 2 = 2. (Forge: exactly this.)

## 4. Why

- 603.2c: an ability triggers once each time its trigger event occurs; two face-down creatures entering are two events (they entered separately, one per manifest dread).
- 701.62a / 701.40a: manifesting puts the card onto the battlefield face down as a 2/2 creature.

## 5. What phase did

Drew one card (hand two Wastes, library 3): one of the two triggers was lost.

## 6. Variations to test

- **One manifest:** a single face-down creature entering draws one card.
- **Simultaneous entry:** two face-down creatures entering at the same time (if some effect does that) still trigger twice.
- **Face-down creature cast face down** (a morph or disguise creature cast face down while They Came from the Pipes is on the battlefield): draws a card.
- **Opponent's face-down creature** entering: no draw.
- **Face-up creature entering:** no draw. **Turning a face-down creature face up:** no draw (it didn't enter).

## 7. Acceptance checks

- On the sweep board seat 0 ends with three Wastes in hand and two cards in library, and the log shows two draws after the manifests.
