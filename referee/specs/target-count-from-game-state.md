# Spec: Impact Resonance is castable when its X is 0

Scenario: `card-impact-resonance` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: Forge casts it with no targets and it resolves doing nothing. Phase refuses the cast: "Action not allowed: Target count requires a resolved quantity before target selection".

## 1. Card

- **Impact Resonance** ({1}{R} instant): "Impact Resonance deals X damage divided as you choose among any number of target creatures, where X is the greatest amount of damage dealt by a source to a permanent or player this turn."

Rulings (Scryfall):
- "You determine the value for X and announce how damage will be divided as you cast Impact Resonance. Each chosen target must receive at least 1 damage. Once the value of X is determined, it won't change, even if a source deals a greater amount of damage before Impact Resonance resolves. (Most of the time, the value of X in an effect would be determined only as the spell resolves. However, the rules state that if damage needs to be 'divided,' that information is checked as the spell is put on the stack.)"
- "Impact Resonance looks at the entire turn to see the greatest amount of damage dealt from a single source to a single permanent or player."
- "If Impact Resonance has multiple targets, and some, but not all, of them become illegal before Impact Resonance resolves, Impact Resonance will still deal damage to the remaining legal targets according to the original damage division."

## 2. Board and actions

Standard sweep board: game turn 2, seat 0 active in precombat main; seat 0 has Mountain, Wastes and Grizzly Bears; seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. No damage has been dealt this turn. Seat 0 casts Impact Resonance; the runner lets phase pick the targets.

## 3. Correct result

1. X is defined by the text (107.3c) and, because the damage is divided, it is fixed while casting (601.2d, ruling). No damage has been dealt this turn, so X = 0.
2. The spell has a variable number of targets, "any number" (601.2c). Each target must get at least 1 of the divided damage (601.2d), so with X = 0 the only legal number of targets is zero.
3. Zero is a legal choice for "any number", so the spell can be cast with no targets. It's not a spell that "requires" a target that can't be found.
4. It resolves and does nothing; it goes to the graveyard (608.2n). Seat 0's Mountain and Wastes are tapped.

Final: seat 0 graveyard [Divination, Hill Giant, Impact Resonance]; no damage anywhere. (Forge: exactly this.)

## 4. What phase did

Refused the cast with "Target count requires a resolved quantity before target selection": it didn't work out X before asking for the number of targets, so the spell couldn't be cast at all.

## 5. Variations to test

- **Damage earlier in the turn.** Script: seat 0 casts Lightning Bolt targeting seat 1 (3 damage), then Impact Resonance (add a second Mountain). X = 3. Seat 0 may choose 1 to 3 target creatures and divide 3 among them, at least 1 each; e.g. 2 to seat 1's Grizzly Bears and 1 to Serra Angel. Bears dies, Angel has 1 damage.
- **X is locked at cast.** With X = 3 from the Bolt and Impact Resonance on the stack, a 5-damage source resolves first (e.g. seat 0 responds to its own Impact Resonance with a second spell): Impact Resonance still deals 3.
- **Greatest single amount, not the total.** Two Shocks (2 each) at seat 1 earlier: X = 2, not 4.
- **Damage to a player counts**, as does damage to a noncreature permanent (e.g. a planeswalker).
- **Partial fizzle.** Two targets, one leaves before resolution: the other still gets its share; the share for the gone target isn't reassigned.
- Similar "target count from the game state" texts: Mysterious Stranger ("for each graveyard with an instant or sorcery card in it, exile target ..."), see `trigger-targets-in-graveyard.md`.

## 6. Acceptance checks

- On the sweep board Impact Resonance can be cast; it has no targets, deals no damage, and ends in seat 0's graveyard.
- After 3 damage was dealt this turn, Impact Resonance can be cast with 1, 2 or 3 creature targets and the divided total is exactly 3.
