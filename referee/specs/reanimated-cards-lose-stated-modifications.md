# Spec: what a spell says about the cards it puts onto the battlefield is dropped

Root cause (observed behaviour): when a spell puts cards onto the battlefield and states something about them as they enter ("They're black Zombies in addition to their other colors and types and they gain decayed", "Each of them enters with an additional -1/-1 counter on it"), phase puts the cards onto the battlefield under the right control but drops the stated modification.

Merged from two specs written in parallel: `added-types-on-reanimated-cards.md` (Part A) and `reanimate-enters-with-additional-counter.md` (Part B).

Cards: Ghouls' Night Out (Part A); Aberrant Return (Part B).

Related: `destroyed-this-way-return.md` (Necromantic Selection: "It's a black Zombie in addition to its other colors and types"), `vanishing-n-enters-with-time-counters.md` (counters a permanent should enter with), `creature-type-setting-keeps-old-types.md`.

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: Ghouls' Night Out's returned creatures are black Zombies with decayed

(Formerly `added-types-on-reanimated-cards.md`.)

Scenario: `card-ghouls-night-out` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: both engines put both Hill Giants onto the battlefield under seat 0's control. Forge reports their types as [Creature, Giant, Zombie]; phase reports [Creature, Giant]. The final-state format doesn't show colour or abilities, so the black colour and decayed can't be compared directly, but phase didn't add the Zombie type from the same sentence.

### 1. Card

- **Ghouls' Night Out** ({3}{B}{B} sorcery): "For each player, choose a creature card in that player's graveyard. Put those cards onto the battlefield under your control. They're black Zombies in addition to their other colors and types and they gain decayed. (A creature with decayed can't block. When it attacks, sacrifice it at end of combat.)"

Rulings (Scryfall):
- "The creatures will enter the battlefield simultaneously. They will see each other enter for the purposes of triggered abilities."
- "If any creature cards put onto the battlefield this way become permanents that aren't creatures because of another effect, those permanents won't be Zombies, but they will gain decayed."
- "Decayed represents a static ability and a triggered ability. 'Decayed' means 'This creature can't block' and 'When this creature attacks, sacrifice it at end of combat.'"
- "Decayed does not grant haste."

### 2. Board and actions

Standard sweep board: seat 0 active in precombat main with the lands for the card and Grizzly Bears; seat 0's graveyard has Hill Giant ({3}{R}, red Creature — Giant 3/3) and Divination; seat 1's graveyard has Hill Giant. Seat 0 casts Ghouls' Night Out (no targets).

### 3. Correct result

1. For each player, seat 0 chooses a creature card in that player's graveyard: each graveyard has exactly one, Hill Giant. These are choices on resolution, not targets (115.10a).
2. Both Hill Giants enter the battlefield at the same time under seat 0's control (owners: seat 0 and seat 1).
3. From then on, with no stated duration (611.2a), each of them is:
   - a Giant **Zombie** creature (type added in layer 4, 613.1d; "in addition" keeps Giant),
   - **red and black** (colour added in layer 5, 613.1e; "in addition" keeps red),
   - with **decayed** (ability added in layer 6, 613.1f): it can't block, and when it attacks it's sacrificed at end of combat (702.147a).
4. They're still 3/3.

Final: seat 0 controls two Hill Giants (owner 0 and owner 1), each Creature — Giant Zombie, red and black, 3/3, with decayed; both graveyards have no Hill Giant left. (Forge's types match this.)

### 4. What phase did

Put both Hill Giants onto the battlefield under seat 0's control, but they were plain [Creature, Giant]: the Zombie type (and, as far as can be told, the colour and decayed) wasn't applied.

### 5. Variations to test

- **Can't block.** Next turn seat 1 attacks seat 0 with Grizzly Bears; neither Hill Giant can be declared as a blocker.
- **Sacrificed after attacking.** On seat 0's next turn a Hill Giant attacks; at end of combat it's sacrificed (to its owner's graveyard: seat 1's Giant goes to seat 1's graveyard).
- **Lasts past the turn.** After the turn ends the Giants are still black Zombies with decayed.
- **Only one graveyard has a creature card.** Remove seat 1's Hill Giant: one Giant returns; nothing is chosen for seat 1.
- **Same pattern, types only, with targets:** Afterlife from the Loam ({5}{B}{B}{B}, delve: "For each player, choose up to one target creature card in that player's graveyard. Put those cards onto the battlefield under your control. They're Zombies in addition to their other types.") targeting both Hill Giants: both enter as Giant Zombies, red only (no colour change).
- **Zombie-matters check.** With a "Zombies you control get +1/+1" lord on seat 0's battlefield (e.g. Lord of the Undead, "Other Zombie creatures get +1/+1."), each returned Hill Giant is 4/4.
- Related: `destroyed-this-way-return.md` (Necromantic Selection, "It's a black Zombie in addition to its other colors and types").

### 6. Acceptance checks

- After Ghouls' Night Out resolves on the sweep board, both Hill Giants are on seat 0's battlefield, each with types Creature, Giant and Zombie, colours red and black, and decayed.
- Neither can block; each is sacrificed at end of a combat in which it attacked.

## Part B: "Each of them enters with an additional -1/-1 counter on it"

(Formerly `reanimate-enters-with-additional-counter.md`.)

Root cause (observed behaviour): phase put the creature card onto the battlefield under the caster's control but without the -1/-1 counter the spell says it enters with.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-aberrant-return`.

### 1. Card

Oracle text from Scryfall (no rulings published).

- **Aberrant Return** ({4}{B}{B} sorcery): "Put one, two, or three target creature cards from graveyards onto the battlefield under your control. Each of them enters with an additional -1/-1 counter on it."

### 2. Board and actions

Seat 0 (active, main phase 1) casts Aberrant Return targeting Hill Giant (3/3) in **seat 1's** graveyard. It resolves.

### 3. Correct result

Hill Giant (owner seat 1) enters the battlefield under seat 0's control **with one -1/-1 counter: a 2/2.** (Forge: Hill Giant, owner 1, under seat 0, `-1/-1: 1`, 2/2.)

### 4. Why

1. "Enters with ... counter" is a replacement effect on the way the permanent enters (614.1c); the counter is on it as it enters (122.6), not added afterwards.
2. "Under your control" makes seat 0 the controller; ownership stays with seat 1 (108.3).
3. "An additional" -1/-1 counter: one more than it would otherwise enter with (none here), so one.
4. A -1/-1 counter changes P/T in layer 7c (613.4c): 3/3 → 2/2.

### 5. What phase did

Hill Giant entered under seat 0's control as a 3/3 with no counters.

### 6. Variations to test

- **Three targets:** three creature cards (from any graveyards); each enters with exactly one -1/-1 counter.
- **A 1/1 creature card:** it enters with a -1/-1 counter as 0/0 and dies to state-based actions (704.5f); "enters" triggers still trigger.
- **A creature that enters with +1/+1 counters** (e.g. a card with "enters with two +1/+1 counters"): it gets both, and the +1/+1 and -1/-1 counters then annihilate as a state-based action (704.5q), leaving one +1/+1 counter.
- **Persist/undying interaction:** a creature with undying put onto the battlefield this way has a -1/-1 counter (fine for undying's "if it had no +1/+1 counters" check).

### 7. Acceptance checks

- Every creature put onto the battlefield by Aberrant Return has exactly one more -1/-1 counter than it would otherwise have, from the moment it enters.
- Returned cards are controlled by the caster and owned by their original owner.
