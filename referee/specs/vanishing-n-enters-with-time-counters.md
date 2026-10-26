# Spec: a permanent that has vanishing N as it enters gets N time counters

Root cause (observed behaviour): when vanishing N comes from a copy exception or from the effect that created a token (not printed on a card), phase puts the permanent onto the battlefield with no time counters.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-flesh-duplicate`, `card-the-girl-in-the-fireplace`.

## 1. Cards

Oracle text from Scryfall.

- **Flesh Duplicate** ({U}{U} creature — Shapeshifter Rebel 0/0): "You may have this creature enter as a copy of any creature on the battlefield, except it has vanishing 3 if that creature doesn't have vanishing. (A permanent with vanishing 3 enters with three time counters on it. At the beginning of your upkeep, remove a time counter from it. When the last is removed, sacrifice it.)"
- **The Girl in the Fireplace** ({2}{W} enchantment — Saga): "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.) I — Create a 1/1 white Human Noble creature token with vanishing 3 and "Prevent all damage that would be dealt to this token." II — Create a 2/2 white Horse creature token with "Doctors you control have horsemanship." III — Whenever a creature you control deals combat damage to a player this turn, time travel."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts the card.

## 3. Correct result

**Flesh Duplicate.** Seat 0 chose to copy Serra Angel (both engines). It enters as Serra Angel (4/4 flying, vigilance) with vanishing 3, so it has **3 time counters**.

**The Girl in the Fireplace.** It enters with a lore counter; chapter I triggers and resolves: seat 0 creates a 1/1 white Human Noble token with vanishing 3 and the prevention ability. The token has **3 time counters**.

## 4. Why

1. 702.63a: "Vanishing N" means, in part, "This permanent enters with N time counters on it." That is a replacement effect (614.1c).
2. 614.12: to decide which replacement effects apply as a permanent enters, "check the characteristics of the permanent as it would exist on the battlefield, taking into account replacement effects that have already modified how it enters ... continuous effects from the permanent's own static abilities". Flesh Duplicate's copy effect (itself an "enters as" replacement) has already been applied; the copy has vanishing 3 as part of its copiable values (707.9a), so vanishing's "enters with" applies.
3. A token created "with vanishing 3" has that ability as it enters (111.3: the effect that creates a token defines its characteristics), so the same "enters with" replacement applies.
4. 122.6: counters an object "is given as it enters" are counters put on it.

## 5. What phase did

- Flesh Duplicate entered as a 4/4 Serra Angel with no counters (Forge: 3 time counters).
- The Human Noble token had no counters (Forge: 3 time counters).

## 6. Variations to test

- A card with printed vanishing (e.g. Keldon Marauders, vanishing 2) still enters with its counters (negative control).
- Flesh Duplicate copying a creature that already has vanishing (e.g. Keldon Marauders): no extra vanishing 3; it enters with that creature's N (2) only.
- Flesh Duplicate choosing not to copy: it's a 0/0 and dies to state-based actions; no counters matter.
- Upkeep: at seat 0's next upkeep one time counter is removed; when the last is removed it is sacrificed.
- Clone-type effects that grant other "enters with" keywords (e.g. a copy "except it has modular 1" or tokens "with fading 3") should behave the same way.

## 7. Acceptance checks

- Flesh Duplicate copying a creature without vanishing has exactly 3 time counters when it lands.
- The Girl in the Fireplace's chapter I token has exactly 3 time counters when created.
- At the next upkeep of the controller, each loses one time counter.
