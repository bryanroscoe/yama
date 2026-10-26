# Spec: "If a creature dealt damage this way would die this turn, exile it instead"

Root cause (observed behaviour): phase deals the damage but doesn't apply the follow-up replacement effect; creatures that die from it go to the graveyard.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-gallifrey-falls`.

## 1. Card

- **Gallifrey Falls** (the {4}{R}{R} half of Gallifrey Falls // No More; sorcery, Fuse): "Gallifrey Falls deals 4 damage to each creature. If a creature dealt damage this way would die this turn, exile it instead." (Only Gallifrey Falls was cast; Fuse wasn't used.)

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Mountain ×2, Wastes ×4, Grizzly Bears (2/2). Seat 1: Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire. Seat 0 casts Gallifrey Falls.

## 3. Correct result

- 4 damage to each of the three creatures. All three have lethal damage.
- State-based actions would destroy them (704.5g); each would die, so each is **exiled instead**.
- Seat 0: exile [Grizzly Bears]; graveyard [Divination, Gallifrey Falls // No More, Hill Giant].
- Seat 1: exile [Grizzly Bears, Serra Angel]; graveyard [Hill Giant].

## 4. Why

1. The second sentence sets up a replacement effect (614.1a, "instead") for the rest of the turn, applying to each creature that was dealt damage by this spell.
2. "Die" means put into a graveyard from the battlefield (700.4). Destruction by state-based actions after lethal damage is a die event, so it is replaced by exile (614.6: the replaced event never happens; the creatures never go to the graveyard and no "dies" triggers fire).
3. The effect is created on resolution and lasts until end of turn, so it also covers deaths later in the turn from other causes.

## 5. What phase did

All three creatures went to their owners' graveyards ("is destroyed"); nothing was exiled. Forge exiled all three.

## 6. Variations to test

- A creature that survives the 4 damage (e.g. a 5/5) and is destroyed by another spell later this turn: exiled instead.
- A creature that was not dealt damage (protection from red, or damage prevented): if it dies later this turn, it goes to the graveyard.
- Next turn: no replacement.
- "Dies" triggers (e.g. a creature with "When this creature dies") don't trigger for exiled creatures.
- The same wording on other cards: Anger of the Gods ("If a creature dealt damage this way would die this turn, exile it instead"), Lava Coil-style single-target versions, Scorching Dragonfire.

## 7. Acceptance checks

- After Gallifrey Falls on this board, all three creatures are in exile and none in a graveyard.
- A creature damaged by it and destroyed later the same turn also goes to exile.
