# Spec: "for each player, ... target [permanent] that player controls"

Root cause (observed behaviour): for an ability that needs one target per player, each restricted to what that player controls, phase let one land stand in for every player: it targeted seat 0's Mountain once and put a counter on it once per player (two counters on one land), even though seat 1 controls no land at all.

Part B (below) adds ten more cards with the same wording where phase targets the player instead of the object, targets nothing, or (Nihiloor) targets the wrong player's creature.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-turf-war` (trigger target scripted: seat 0's Mountain).

## 1. Card

Oracle text from Scryfall (no rulings published).

- **Turf War** ({4}{R} enchantment): "When this enchantment enters, for each player, put a contested counter on target land that player controls. Whenever a creature deals combat damage to a player, if that player controls one or more lands with contested counters on them, that creature's controller gains control of one of those lands of their choice and untaps it."

## 2. Board and actions

Seat 0 (active, main phase 1): Mountain + 4 Wastes (tapped to cast), Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire, **no lands**. Seat 0 casts Turf War; it resolves; its enters trigger goes on the stack.

## 3. Correct result

The trigger needs two targets: a land seat 0 controls and a land seat 1 controls. Seat 1 controls no land, so the trigger can't be given all of its required targets and is removed from the stack (603.3d). **No contested counters anywhere.** Turf War stays on the battlefield. (Forge: "Couldn't add to stack, failed to target", no counters.)

Even under a reading that let the trigger go on the stack with only seat 0's target, the result would be **one** contested counter on seat 0's Mountain, never two.

## 4. Why

1. The ability's text fixes the number of targets: one per player (601.2c: "In some cases, the number of targets will be defined by the spell's text"; 603.3d applies 601.2c to triggered abilities). Each of those targets must be "a land that player controls", for its own player.
2. Seat 0's Mountain is a legal choice only for seat 0's slot; it is not a land seat 1 controls. There is no legal choice for seat 1's slot.
3. 603.3d: "If a choice is required when the triggered ability goes on the stack but no legal choices can be made for it ... the ability is simply removed from the stack." The text doesn't say "up to one", so the target for seat 1 is required.
4. 115.3: the same object can't be chosen more than once for one instance of the word "target", so the Mountain can't fill two slots in any case.
5. 122.1/122.6: counters go on the object the effect names; "put a contested counter on target land" for each player puts one counter on each player's chosen land.

## 5. What phase did

Logged "Mountain is targeted by Turf War", then "1 contested counter on Mountain" twice. Final: seat 0's Mountain with `contested: 2`.

## 6. Variations to test

- **Both players control lands:** seat 1 also controls a Forest. Seat 0's slot takes a seat 0 land, seat 1's slot takes the Forest; one contested counter on each. (This is the normal case and the most important regression check.)
- **Three players, all with lands:** three targets, one per player, one counter each.
- **Three players, one without lands:** the trigger is removed from the stack (no counters at all).
- **Second ability:** with a contested Forest under seat 1, seat 0's creature deals combat damage to seat 1: seat 0 gains control of the Forest and untaps it.
- **Similar wording to check:** other "for each player/opponent, ... target X that player controls" abilities without "up to one" should require all targets; those with "up to one" (e.g. Decoy Gambit) may leave a slot empty.

## 7. Acceptance checks

- On this board (seat 1 has no lands), Turf War's enters trigger puts no counters anywhere.
- No land ever ends up with two contested counters from one Turf War trigger.
- When every player controls a land, each player's chosen land gets exactly one contested counter.

---

## Part B (sweep v6, batch 7): the player is taken as the target instead of the object

Root cause (observed behaviour): for "for each opponent / for each player, [up to one] target X that player controls", phase's target list names **the player** (seat 1) instead of one object per player, or names no target at all, or (for a reflexive trigger) a creature the *other* player controls. The objects the ability should affect are then left alone. Forge rejected every one of these target lists ("p1 is not a legal target").

Scenarios (standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-age-of-ultron`, `card-kang-dynasty`, `card-tri-sentinel-act-of-vengeance`, `card-the-horus-heresy`, `card-enigma-thief`, `card-hideous-taskmaster`, `card-desecrate-reality`, `card-blatant-thievery`, `card-guff-rewrites-history`, `card-nihiloor`.

Sweep board reminder: seat 0 (active, precombat main) controls exactly the lands for the card plus Grizzly Bears; graveyard Hill Giant, Divination. Seat 1 controls Grizzly Bears (2/2, mana value 2), Serra Angel (4/4 flier, mana value 5), Millstone (artifact, mana value 2), Seal of Fire (enchantment, mana value 1); no lands. Libraries are 8 Wastes each.

### B.1 Cards (Oracle text)

- **Age of Ultron** ({4}{B} Saga): "I — For each opponent, destroy up to one target nonartifact creature that player controls. II — For each opponent, you create a 2/2 colorless Robot Villain artifact creature token. III — Artifact creatures you control gain deathtouch until end of turn. Put a +1/+1 counter on each of them."
- **Kang Dynasty** ({3}{U} Saga): "I, II — For each opponent, tap up to one target creature that player controls. Goad those creatures. Until your next turn, whenever any of those creatures deals combat damage to a player, draw a card. III — Target creature you control gets +1/+1 until end of turn for each card in your hand and can't be blocked this turn."
- **Tri-Sentinel, Act of Vengeance** (7-mana creature): "Flying, menace, trample. When Tri-Sentinel enters, for each opponent, Tri-Sentinel deals 3 damage to up to one target creature that player controls. Unearth {7}."
- **The Horus Heresy** (Saga): "I — For each opponent, gain control of up to one target nonlegendary creature that player controls for as long as this Saga remains on the battlefield. II — Draw a card for each creature you control but don't own. III — Starting with you, each player chooses a creature. Destroy each creature chosen this way."
- **Enigma Thief** (creature): "Prowl {3}{U}. Flying. When this creature enters, for each opponent, return up to one target nonland permanent that player controls to its owner's hand."
- **Hideous Taskmaster** (creature): "Devoid. When you cast this spell, for each opponent, gain control of up to one target creature that player controls until end of turn. Untap those creatures. They gain trample, haste, and annihilator 1 until end of turn. Trample, haste, annihilator 1."
- **Desecrate Reality** ({7} instant): "For each opponent, exile up to one target permanent that player controls with an even mana value. (Zero is even.) Adamant — If at least three colorless mana was spent to cast this spell, return a permanent card with an odd mana value from your graveyard to the battlefield."
- **Blatant Thievery** ({4}{U}{U}{U} sorcery): "For each opponent, gain control of target permanent that player controls." Rulings: "You gain control of only one permanent from each player."
- **Guff Rewrites History** ({2}{R} instant): "For each player, choose target nonenchantment, nonland permanent that player controls. Those permanents' owners shuffle them into their libraries. Each player who controlled one of those permanents exiles cards from the top of their library until they exile a nonland card, then puts the rest on the bottom of their library in a random order. Each player may cast the nonland card they exiled without paying its mana cost."
- **Nihiloor** ({2}{W}{U}{B} legendary creature 3/5): "When Nihiloor enters, for each opponent, tap up to one untapped creature you control. When you do, gain control of target creature that player controls with power less than or equal to the tapped creature's power for as long as you control Nihiloor. Whenever you attack with a creature an opponent owns, you gain 2 life and that player loses 2 life." Rulings (2021-07-23): you choose up to one creature for each opponent and tap them all at once; a separate reflexive trigger goes on the stack for each creature tapped; both powers are checked when the reflexive trigger is put on the stack and when it resolves.

### B.2 Correct result

The targets are the objects ("target nonartifact creature that player controls"), one slot per opponent (or per player for Guff); the player is only the thing that restricts each slot. No player is a target (115.1, 115.10a). For "up to one" the slot may be left empty; without "up to" (Blatant Thievery, Guff) one target per player is required (601.2c).

On this board (one opponent, seat 1):

| Card | Legal choices for seat 1's slot | Result with a target picked (the runner prefers an opponent's creature) |
|---|---|---|
| Age of Ultron, chapter I | Grizzly Bears, Serra Angel (not Millstone: artifact) | That creature is destroyed. Saga has 1 lore counter. |
| Kang Dynasty, chapter I | Grizzly Bears, Serra Angel | That creature is tapped and goaded. |
| Tri-Sentinel | Grizzly Bears, Serra Angel | 3 damage: Bears dies, or Serra Angel has 3 damage. |
| The Horus Heresy, chapter I | Grizzly Bears, Serra Angel | Seat 0 controls that creature (owner seat 1). |
| Enigma Thief | Bears, Serra Angel, Millstone, Seal of Fire | That permanent goes to seat 1's hand. |
| Hideous Taskmaster (cast trigger, resolves before the creature spell) | Grizzly Bears, Serra Angel | Seat 0 controls it until end of turn, untapped, with trample, haste, annihilator 1. |
| Desecrate Reality | Grizzly Bears (2), Millstone (2); not Serra Angel (5) or Seal of Fire (1) | That permanent is exiled. Adamant is on (seven {C} spent) but seat 0's graveyard has no permanent card with an odd mana value (Hill Giant is 4), so nothing returns. Desecrate Reality ends in seat 0's graveyard. |
| Blatant Thievery | Bears, Serra Angel, Millstone, Seal of Fire (required) | Seat 0 controls the chosen permanent; seat 1 is **not** a target. |
| Guff Rewrites History | seat 0: its Grizzly Bears (its only nonland, nonenchantment permanent); seat 1: Bears, Serra Angel or Millstone (required, both slots) | Both chosen permanents are shuffled into their owners' libraries. Each player exiles Wastes from the top until they exile their own shuffled-in card, puts the exiled Wastes on the bottom in a random order, and may cast that card free. Libraries end at 8 each; a card not cast stays in exile. |
| Nihiloor | Tap Nihiloor (power 3) or seat 0's Grizzly Bears (power 2). Then the reflexive trigger targets a creature **seat 1** controls with power ≤ the tapped creature's power: seat 1's Grizzly Bears (Serra Angel's power 4 is too high). | Seat 0 controls seat 1's Grizzly Bears for as long as it controls Nihiloor; the tapped creature stays tapped. |

### B.3 Why

1. 115.1a / 115.1d: the target is the thing named by "target [something]"; here the something is "nonartifact creature that player controls", an object. "For each opponent" sets how many targets there are (601.2c: "the number of targets will be defined by the spell's text").
2. 115.10a: a player affected or referred to but not named by "target" isn't a target. So naming seat 1 as a target is wrong, even when the object is also targeted (Blatant Thievery); it matters for a hexproof player (e.g. Leyline of Sanctity must not stop these spells) and for "becomes the target" triggers.
3. 601.2c / 603.3d: with "up to one" the controller may choose zero targets for a slot; but choosing a *player* is not one of the options.
4. 603.12 (Nihiloor): the reflexive trigger's "that player" is the opponent the creature was tapped for; its target must be a creature that opponent controls. Seat 0's own Grizzly Bears is not a legal target.
5. 608.2b: a spell isn't lost; after resolving (or failing to) it goes to its owner's graveyard (Desecrate Reality).

### B.4 What phase did

- Age of Ultron, Kang Dynasty, The Horus Heresy: chapter I's target was written as seat 1 (the player); nothing was destroyed / tapped / stolen.
- Tri-Sentinel, Enigma Thief, Hideous Taskmaster: trigger target written as seat 1; no damage, no bounce, no control change.
- Desecrate Reality: target written as seat 1; nothing was exiled, and **Desecrate Reality itself vanished** (not in any zone: not graveyard, exile, stack or hand).
- Blatant Thievery: targets written as [seat 1, seat 1's Grizzly Bears]; seat 0 gained control of the Bears (the effect itself was right).
- Guff Rewrites History: no targets at all; the spell went to the graveyard without resolving; nothing was shuffled.
- Nihiloor: tapped Nihiloor, then the reflexive trigger targeted **seat 0's own** Grizzly Bears; no control change.

### B.5 Variations to test

- Each card with zero choices in a slot: seat 1 controls only lands. "Up to one" abilities resolve with no target (and do nothing); Blatant Thievery and Guff can't be cast / are cast only if every slot has a legal choice (Guff: seat 0 must also control a nonland nonenchantment permanent).
- Hexproof opponent (Leyline of Sanctity under seat 1): all of these still work, since the player isn't targeted.
- Three players: one slot per opponent (Guff: per player), each restricted to that player's permanents; a permanent of opponent A can't fill opponent B's slot (115.3 with per-player restriction).
- Age of Ultron with only an artifact creature on seat 1's side: no legal choice; chapter I resolves with no target.
- Desecrate Reality with a Seal of Fire (odd) in seat 0's graveyard: adamant returns it; with two {C} and five other mana spent (not adamant), nothing returns.
- Nihiloor: tap Grizzly Bears (power 2) instead: still may take seat 1's Bears (2 ≤ 2) but not Serra Angel; with two opponents, two reflexive triggers, each targeting a creature of its own opponent.
- Hideous Taskmaster countered: the cast trigger still resolves (it's independent of the spell).

### B.6 Acceptance checks

- On the sweep board, Age of Ultron's chapter I destroys seat 1's chosen nonartifact creature (or nothing if none chosen); no player is ever listed as its target.
- Tri-Sentinel's trigger deals 3 damage to a seat 1 creature; Enigma Thief returns a seat 1 nonland permanent; The Horus Heresy and Hideous Taskmaster give seat 0 control of a seat 1 creature; Kang Dynasty taps one.
- Desecrate Reality exiles seat 1's Grizzly Bears or Millstone and ends in seat 0's graveyard; a spell never disappears from all zones.
- Blatant Thievery's only target is seat 1's permanent.
- Guff Rewrites History requires one target per player and shuffles both chosen permanents away.
- Nihiloor's reflexive trigger can only target a creature the opponent controls; on this board seat 0 ends up controlling seat 1's Grizzly Bears.

---

## Part C (sweep v6, batch 6): more "for each opponent, up to one target ... that player controls"

Same root cause as Part B. Scenarios: `card-grasp-of-fate`, `card-dismantling-wave`, `card-king-solomon-s-frogs`, `card-mass-mutiny`, `card-bronzebeak-foragers` (all `forge-error`: "Forge says p1 is not a legal target").

### C.1 Cards (Oracle text, Scryfall)

- **Grasp of Fate** ({1}{W}{W} enchantment): "When this enchantment enters, for each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves the battlefield. (Those permanents return under their owners' control.)"
- **Dismantling Wave** ({2}{W} sorcery): "For each opponent, destroy up to one target artifact or enchantment that player controls. Cycling {6}{W}{W}. When you cycle this card, destroy all artifacts and enchantments."
- **King Solomon's Frogs** ({3}{W} creature, flash): "When King Solomon's Frogs enters, if you cast it, for each opponent, exile up to one target permanent that player controls with mana value 3 or greater. For each permanent exiled this way, its controller draws a card. {3}, {T}, Exile King Solomon's Frogs: You become the monarch."
- **Mass Mutiny** ({3}{R}{R} sorcery): "For each opponent, gain control of up to one target creature that player controls until end of turn. Untap those creatures. They gain haste until end of turn."
- **Bronzebeak Foragers** ({3}{W} creature 3/4): "When this creature enters, for each opponent, exile up to one target nonland permanent that player controls until this creature leaves the battlefield. {X}{W}: Put target card with mana value X exiled with this creature into its owner's graveyard. You gain X life."

### C.2 Correct result (sweep board, one opponent)

| Card | Legal choices for seat 1's slot | Result with the runner's pick (an opponent's creature first) |
|---|---|---|
| Grasp of Fate | Grizzly Bears, Serra Angel, Millstone, Seal of Fire | That permanent is exiled until Grasp of Fate leaves the battlefield. |
| Dismantling Wave | Millstone, Seal of Fire | That permanent is destroyed; Dismantling Wave goes to seat 0's graveyard. |
| King Solomon's Frogs (it was cast, so the "if you cast it" condition holds) | Serra Angel only (mana value 5); Bears, Millstone (2) and Seal of Fire (1) are too low | Serra Angel is exiled and seat 1 draws a card (hand 3 Wastes, library 7). |
| Mass Mutiny | Grizzly Bears, Serra Angel | Seat 0 controls it until end of turn, untapped, with haste; Mass Mutiny goes to seat 0's graveyard. |
| Bronzebeak Foragers | Grizzly Bears, Serra Angel, Millstone, Seal of Fire | That permanent is exiled until the Foragers leave the battlefield. |

Zero targets is also legal ("up to one"); then nothing happens to seat 1's permanents, but the spell still resolves and goes to the graveyard.

### C.3 Why

As B.3: the targets are the objects (115.1a, 115.1d), "for each opponent" fixes how many (601.2c), and the opponent isn't a target (115.10a). 608.2b / 608.2n: an instant or sorcery goes to its owner's graveyard after resolving. King Solomon's Frogs: 603.4 (intervening "if" clause) and 202.3 (mana value).

### C.4 What phase did

- In the sweep (runner choosing targets itself), phase never asked for the per-opponent target; the stack entry's target was written down as seat 1 (the player). Nothing was exiled, destroyed or stolen.
- Dismantling Wave and Mass Mutiny then **vanished**: the logs end after "Player 2 passes priority" with no "effect resolves" and no move to the graveyard; the final state has the card in no zone (not hand, stack, graveyard or exile).
- Probe with the target given explicitly (hand-written scenarios run through the referee runner): seat 1's Serra Angel (Grasp of Fate, King Solomon's Frogs, Bronzebeak Foragers, Mass Mutiny) or Millstone (Dismantling Wave) was accepted and the effect was right (exiled + one draw for the Frogs; stolen with Mass Mutiny; Millstone destroyed). Given seat 1 explicitly, phase refused it as not legal ("2 legal": Millstone and Seal of Fire for Dismantling Wave). So the legal-target list is right; what goes wrong is that, without a scripted target, phase puts the spell or trigger on the stack with the player recorded as its target instead of asking for the permanent.

### C.5 Variations to test

- Each card cast with no target given in advance: phase must ask for (or let the AI pick) up to one permanent of each opponent; the final board must match C.2 for the pick.
- Choosing zero targets for the slot: the spell resolves doing nothing to permanents and goes to the graveyard (no vanishing).
- Grasp of Fate / Bronzebeak Foragers leaving the battlefield: the exiled permanent returns under its owner's control.
- King Solomon's Frogs put onto the battlefield without being cast: no trigger. With only permanents of mana value 2 or less on seat 1's side: no legal choice, no exile, no draw.
- Mass Mutiny on a tapped creature: it's untapped and has haste until end of turn.
- Two opponents: one slot per opponent; each slot only accepts that opponent's permanents.

### C.6 Acceptance checks

- On the sweep board each of the five cards affects at most one of seat 1's permanents and never records seat 1 (the player) as a target.
- Dismantling Wave destroys Millstone or Seal of Fire (or nothing) and ends in seat 0's graveyard; Mass Mutiny ends in seat 0's graveyard; neither ever disappears from every zone.
- King Solomon's Frogs exiles Serra Angel (the only permanent with mana value 3 or more) and seat 1 draws one card.
