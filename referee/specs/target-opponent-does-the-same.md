# Spec: The Wedding of River Song: "Then target opponent does the same"

Root cause (observed behaviour): phase treats The Wedding of River Song as having no target and skips the opponent's half: the caster draws two, the opponent draws nothing. Because phase's resolved scenario had no target, Forge's replay was then cast without a target and failed ("Couldn't add to stack, failed to target"), so the Forge side of this comparison is not usable; the rules settle it.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-the-wedding-of-river-song`.

## 1. Card

- **The Wedding of River Song** ({2}{W} sorcery): "Draw two cards, then you may exile a nonland card from your hand with a number of time counters on it equal to its mana value. Then target opponent does the same. Cards exiled this way that don't have suspend gain suspend. Time travel. (For each suspended card you own and each permanent you control with a time counter on it, you may add or remove a time counter.)"

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains, Wastes ×2, Grizzly Bears; hand: the card, Wastes; library 8 Wastes. Seat 1: hand 2 Wastes, library 8 Wastes. Seat 0 casts The Wedding of River Song; it requires a target opponent, which can only be seat 1.

## 3. Correct result

1. Casting: seat 0 chooses seat 1 as the target opponent (the spell can't be cast without a legal target).
2. Seat 0 draws two (hand 3 Wastes, library 6). Seat 0 may exile a nonland card from hand: it has none, so nothing.
3. Seat 1 "does the same": draws two (hand 4 Wastes, library 6), and may exile a nonland card from its hand (none).
4. No cards were exiled, so nothing gains suspend. Time travel: seat 0 has no suspended cards or permanents with time counters; nothing.
Final: seat 0 hand 3 Wastes, library 6; **seat 1 hand 4 Wastes, library 6**.

## 4. Why

1. "Target opponent" makes this a targeted spell (115.1, 601.2c): the target is chosen as it's cast, and if that player is an illegal target on resolution the spell does nothing (608.2b).
2. "Does the same" repeats the preceding instructions for that player: draw two cards, then may exile a nonland card with time counters equal to its mana value (608.2c).
3. Exiled cards without suspend gain it; time travel is 701.56a (for each chosen permanent with a time counter or suspended card you own, add or remove one time counter).

## 5. What phase did

No target was chosen (no "is targeted" in the log). Seat 0 drew two; seat 1 drew nothing.

## 6. Variations to test

- Hands with nonland cards: seat 0 exiles Hill Giant (mana value 4) with 4 time counters; it gains suspend; then time travel lets seat 0 add or remove one counter from it (3 or 5). Seat 1's exiled card also gains suspend but seat 0's time travel only affects cards seat 0 owns.
- A card with mana value 0 exiled: gains suspend but has no time counters, so it isn't "suspended" (ruling).
- Target opponent gains hexproof in response: the spell doesn't resolve at all (it's the only target), so seat 0 doesn't draw either.

## 7. Acceptance checks

- The Wedding of River Song requires a target opponent when cast.
- On resolution both the caster and the target opponent draw two cards, and each may exile one nonland card from their hand.
