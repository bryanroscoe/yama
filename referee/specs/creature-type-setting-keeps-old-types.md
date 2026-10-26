# Spec: effects that set or remove creature types leave the old creature types in place

Root cause (observed behaviour): when an effect sets a creature's creature type ("becomes a blue Frog", "is a Treefolk", "is an Insect artifact creature") or removes creature types ("loses all other creature types", "lose all creature types") without "in addition to its other types", phase adds the new type but keeps the creature's old creature types. 205.1a says the new creature types replace the old ones. Power/toughness, color and ability changes from the same effects were right.

Merged from two specs written in parallel: `becomes-creature-type-replaces-types.md` (Part A) and `lose-other-creature-types.md` (Part B).

Cards: Polymorphist's Jest, Snakeform, Eye of Nidhogg, Lignify, Hunted by The Family, Curse of Conformity, Turn to Frog (Part A); Darksteel Mutation, Kenrith's Transformation (Part B).

Related: `embalm-exception-only-when-embalmed.md` (the opposite error: a Zombie type added when it shouldn't be), `reanimated-cards-lose-stated-modifications.md` (an "in addition" type that wasn't added).

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: "becomes a [creature type]" replaces the old creature types

(Formerly `becomes-creature-type-replaces-types.md`.)

Root cause (observed behaviour): when an effect says a creature *becomes* a given creature type (without "in addition to its other types"), phase adds the new type but keeps the creature's old creature types. The rules say the new creature type replaces them.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-polymorphist-s-jest`, `card-snakeform`, `card-eye-of-nidhogg`.

### 1. Cards

Oracle text from Scryfall.

- **Polymorphist's Jest** ({1}{U}{U} instant): "Until end of turn, each creature target player controls loses all abilities and becomes a blue Frog with base power and toughness 1/1."
- **Snakeform** ({2}{U} instant): "Until end of turn, target creature loses all abilities and becomes a green Snake with base power and toughness 1/1. Draw a card."
- **Eye of Nidhogg** ({2}{B} Aura): "Enchant creature. Enchanted creature is a black Dragon with base power and toughness 4/2, has flying and deathtouch, and is goaded. ... When Eye of Nidhogg is put into a graveyard from the battlefield, return it to its owner's hand."

Other cards on the board: Grizzly Bears (Creature — Bear 2/2), Serra Angel (Creature — Angel 4/4).

### 2. Board and actions

Seat 0 (active, main phase 1) has exactly the lands for the spell, a Grizzly Bears, and the spell in hand. Seat 1 controls Grizzly Bears, Serra Angel, Millstone, Seal of Fire.

- `card-polymorphist-s-jest`: seat 0 casts Polymorphist's Jest targeting seat 1.
- `card-snakeform`: seat 0 casts Snakeform targeting seat 1's Grizzly Bears.
- `card-eye-of-nidhogg`: seat 0 casts Eye of Nidhogg targeting (enchanting) seat 1's Grizzly Bears.

### 3. Correct result

| Scenario | Affected creature | Creature types afterwards | P/T |
|---|---|---|---|
| Polymorphist's Jest | seat 1 Grizzly Bears | Frog only | 1/1 |
| Polymorphist's Jest | seat 1 Serra Angel | Frog only | 1/1 |
| Snakeform | seat 1 Grizzly Bears | Snake only | 1/1 |
| Eye of Nidhogg | seat 1 Grizzly Bears | Dragon only | 4/2 |

Card type stays Creature in every case. Colors become blue / green / black respectively (only that color). Seat 0's own Grizzly Bears is untouched in the Jest scenario (it targets seat 1 only).

### 4. Why

1. 205.1a: "when an effect sets one or more of an object's subtypes, the new subtype(s) replaces any existing subtypes from the appropriate set (creature types, ...)". "Becomes a blue Frog" sets the creature type to Frog.
2. 205.1b gives the exceptions where old types are kept: wording such as "in addition to its other types" or "is still a [type]", or "becomes an artifact creature". None of these three cards uses that wording, so 205.1b does not apply.
3. The type change applies in layer 4 (613.1d), the color change in layer 5, the base P/T in layer 7b (613.4b). Loss of abilities applies in layer 6. None of that brings the old creature types back.
4. The rulings say so outright:
   - Polymorphist's Jest, 2014-07-18: "The creatures will lose all other colors and creature types, but they will retain any other card types (such as artifact) or supertypes (such as legendary) they may have."
   - Eye of Nidhogg, 2025-06-06: "Eye of Nidhogg overwrites all colors and creature types the enchanted creature has. It's just a black Dragon. The creature keeps any supertypes it has (such as legendary), as well as any other card types it has (such as enchantment)."
   - Snakeform, 2008-08-01: "If Snakeform affects a creature with changeling, the creature will lose its changeling ability, and will no longer be all creature types."
   - Goddric, Cloaked Reveler's reminder text states the same rule for "is a Dragon": "(He loses all other creature types.)"

### 5. What phase did

phase gave each creature the new type but kept the old ones: Grizzly Bears became `[Bear, Creature, Frog]` / `[Bear, Creature, Snake]` / `[Bear, Creature, Dragon]`, Serra Angel became `[Angel, Creature, Frog]`. P/T was right (1/1, 1/1, 4/2). Forge reported `[Creature, Frog]`, `[Creature, Snake]`, `[Creature, Dragon]`.

### 6. Variations to test

- **Changeling target.** Snakeform on a creature with changeling (e.g. Moritte of the Frost or Universal Automaton): changeling is an ability, and Snakeform removes all abilities (layer 6) while setting the type in layer 4. Changeling is a characteristic-defining ability (702.73a) that applies first within layer 4 (613.3), then Snakeform's type-setting effect replaces those types: the creature is a Snake only.
- **"In addition" wording keeps types (negative control).** Arcane Adaptation ("Creatures you control are the chosen type in addition to their other types"): Grizzly Bears is Bear plus the chosen type. Make sure the fix doesn't strip types for "in addition to" effects.
- **Later "in addition" effect.** Snakeform on Grizzly Bears, then (later timestamp) an effect that makes creatures you control a Demon in addition to their other types: the creature is Snake and Demon, not Bear.
- **End of turn.** After the cleanup step, Jest/Snakeform's effects end and the creature is a Bear again (514.2).
- **Aura leaves.** Eye of Nidhogg destroyed: the creature returns to Bear 2/2; Eye of Nidhogg goes to its owner's hand from the graveyard via its trigger.
- **Noncreature subtypes untouched.** A "becomes a [creature type]" effect on an artifact creature with an artifact subtype (e.g. an Equipment creature, or a Vehicle that is crewed) keeps the artifact subtype; only creature types are replaced (205.1a "from the appropriate set").

### 7. Acceptance checks

- After Polymorphist's Jest targeting the opponent, each of the opponent's creatures has exactly one creature type, Frog, and is 1/1; the caster's creatures are unchanged.
- After Snakeform on Grizzly Bears, it is a 1/1 Creature — Snake with no Bear type, and the caster has drawn one card.
- Grizzly Bears enchanted by Eye of Nidhogg is a 4/2 Creature — Dragon with no Bear type.
- Effects that say "in addition to its other types" still keep the old types.

---

### Added from triage batch 2: Lignify, Hunted by The Family, Curse of Conformity

### Spec: Effects that set or remove creature types leave the old creature types in place

Scenarios: `card-lignify`, `card-hunted-by-the-family`, `card-curse-of-conformity` (card sweep, batch 2).

Each card either sets a creature's creature type ("is a Treefolk", "becomes a ... Human creature") or removes all creature types. In phase the affected creatures kept their printed creature types (Bear, Angel) alongside the new one. Forge drops them, which is correct. The power/toughness part of each effect worked in both engines.

#### 1. Cards

- **Lignify** {1}{G}, Kindred Enchantment — Treefolk Aura. "Enchant creature / Enchanted creature is a Treefolk with base power and toughness 0/4 and loses all abilities."
  - Ruling 2007-10-01: "Lignify overwrites previous effects that changed the enchanted creature's creature types. Any such effects that apply after Lignify enters will work normally."
  - Ruling 2007-10-01: "Lignify overwrites characteristic-defining abilities that specify the enchanted creature's power or toughness ... or that specify its creature types (such as changeling does)."
- **Hunted by The Family** {5}{U}{U}, Sorcery. "Choose up to four target creatures you don't control. For each of them, that creature's controller faces a villainous choice — That creature becomes a 1/1 white Human creature and loses all abilities, or you create a token that's a copy of it."
- **Curse of Conformity** {4}{W}, Enchantment — Aura Curse. "Enchant player / Nonlegendary creatures enchanted player controls have base power and toughness 3/3 and lose all creature types."
  - Ruling 2021-09-24: "Creatures with the changeling ability will still lose all creature types even though they don't lose changeling."

#### 2. Board and actions

Board: the sweep board (top of this file).

- `card-lignify`: lands Forest + Wastes. Seat 0 casts Lignify targeting seat 1's Grizzly Bears; it resolves and attaches.
- `card-hunted-by-the-family`: lands Island, Island + 5 Wastes. Seat 0 casts Hunted by The Family targeting seat 1's Grizzly Bears and Serra Angel. On resolution seat 1 chose "becomes a 1/1 white Human creature and loses all abilities" for both (both engines made that choice).
- `card-curse-of-conformity`: lands Plains + 4 Wastes. Seat 0 casts Curse of Conformity targeting (enchanting) seat 1.

#### 3. Correct result

- Lignify: seat 1's Grizzly Bears is a **Creature — Treefolk**, base 0/4, with no abilities. It is not a Bear.
- Hunted by The Family: seat 1's Grizzly Bears and Serra Angel are each a 1/1 white **Creature — Human** with no abilities (Serra Angel loses flying and vigilance). Neither is a Bear or an Angel.
- Curse of Conformity: seat 1's Grizzly Bears and Serra Angel are each a base 3/3 **Creature** with **no creature types**. Serra Angel keeps its abilities.

Forge's final states show exactly these type lines.

#### 4. Why

1. All three effects change subtypes, so they apply in layer 4 (613.1d); the P/T parts apply in layer 7b and the ability loss in layer 6.
2. 205.1a: "when an effect sets one or more of an object's subtypes, the new subtype(s) replaces any existing subtypes from the appropriate set (creature types, ...)". "Is a Treefolk" and "becomes a 1/1 white Human creature" set the creature type, so Treefolk or Human replaces Bear and Angel.
3. 205.1b: old types are kept only when the effect says so ("in addition to its other types", "is still a ..."). None of these effects says so.
4. Curse of Conformity says outright "lose all creature types": the creatures end with the card type Creature and no creature subtypes. Removing subtypes doesn't affect card types (205.1a, last sentence).
5. Lignify's rulings confirm the reading: it overwrites earlier type-changing effects and even changeling.

#### 5. What phase did

- Lignify: the Bears' types were [Bear, Creature, Treefolk].
- Hunted by The Family: [Bear, Creature, Human] and [Angel, Creature, Human].
- Curse of Conformity: [Bear, Creature] and [Angel, Creature].

The P/T values (0/4, 1/1, 3/3) were right.

#### 6. Variations to test

- A changeling creature under Lignify is only a Treefolk; under Curse of Conformity it has no creature types (it keeps changeling the ability).
- An artifact creature (e.g. a Golem) under Lignify stays an artifact and keeps any artifact subtypes; only creature types are replaced. A land creature keeps its land types.
- An effect that adds a creature type with a later timestamp than Lignify (e.g. "becomes a Zombie in addition to its other types") applies normally: Treefolk Zombie.
- An effect with "in addition to its other types" (e.g. Path of the Schemer's "It's an artifact in addition to its other types") must keep the old types: guard against overcorrecting.
- When Lignify leaves the battlefield, the creature is a Bear again.
- Curse of Conformity doesn't affect legendary creatures or the curse controller's creatures.

#### 7. Acceptance checks

- With Lignify on seat 1's Grizzly Bears, that permanent's creature types are exactly [Treefolk] and it is 0/4.
- After Hunted by The Family with the Human option, each target's creature types are exactly [Human], it is 1/1, white, and has no abilities.
- With Curse of Conformity on seat 1, seat 1's Grizzly Bears and Serra Angel have no creature types and are 3/3.

### Added from triage batch 5: Turn to Frog

Scenario: `card-turn-to-frog` (target: seat 1's Grizzly Bears). **Turn to Frog** ({1}{U} instant): "Until end of turn, target creature loses all abilities and becomes a blue Frog with base power and toughness 1/1."

Observed: phase made seat 1's Grizzly Bears a 1/1 with types [Bear, Creature, Frog]; Forge [Creature, Frog].

Correct: Creature — Frog only, blue, 1/1, no abilities, until end of turn. Same rules as above (205.1a). Scryfall ruling 2014-07-18: "The creature will lose all other colors and creature types, but it will retain any other card types (such as artifact) or supertypes (such as legendary) it may have."

Extra variation: Turn to Frog on an artifact creature or a legendary creature keeps Artifact / Legendary but loses its creature types.

## Part B: "Loses all other creature types" removes the old creature types

(Formerly `lose-other-creature-types.md`.)

Scenarios: `card-darksteel-mutation`, `card-kenrith-s-transformation`. Observed: both engines make seat 1's Grizzly Bears the right power/toughness (0/1 and 3/3). Forge's types: [Artifact, Creature, Insect] and [Creature, Elk]. Phase keeps Bear: [Artifact, Bear, Creature, Insect] and [Bear, Creature, Elk].

### 1. Cards

- **Darksteel Mutation** {1}{W}, Enchantment — Aura. "Enchant creature. Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types."
- **Kenrith's Transformation** {1}{G}, Enchantment — Aura. "Enchant creature. When this Aura enters, draw a card. Enchanted creature loses all abilities and is a green Elk creature with base power and toughness 3/3. (It loses all other card types and creature types.)"

Rulings:
- Darksteel Mutation (2013-10-17): "The enchanted creature will be only an artifact and a creature, not any other card types. It will be only an Insect, not any other creature types." Also: other artifact subtypes (such as Equipment) are retained; supertypes are kept.
- Kenrith's Transformation (2019-10-04): "Kenrith's Transformation overwrites all colors and creature types the enchanted creature has. It's just a green Elk. The creature keeps any supertypes (such as legendary) it has, but loses any other card types it has (such as artifact)."

### 2. Board and actions

Sweep board. Seat 0 casts the Aura targeting seat 1's Grizzly Bears (Creature — Bear 2/2, scripted); it resolves and attaches. For Kenrith's Transformation, its enters trigger then makes seat 0 draw a card (both engines did).

### 3. Correct result

| Aura | Enchanted Grizzly Bears |
|---|---|
| Darksteel Mutation | Artifact Creature — Insect, 0/1, indestructible, no other abilities, still green |
| Kenrith's Transformation | Creature — Elk, green, 3/3, no abilities |

In neither case is it a Bear.

### 4. Why

1. Both Auras have type-changing effects, applied in layer 4 (613.1d).
2. When an effect sets an object's subtypes, the new subtypes replace the existing ones of that set (205.1a); neither Aura says "in addition to its other types", so 205.1b doesn't apply. Both texts say outright that the creature loses its other creature types.
3. So in layer 4 the creature types become exactly {Insect} or {Elk}; Bear is gone. The card types become Artifact Creature or Creature (Kenrith's removes artifact, if any).
4. Color (layer 5, 613.1e: Kenrith's makes it green), abilities (layer 6), and base P/T (layer 7b, 613.4b) are separate and phase already gets P/T right.

### 5. What phase did

Set the new type and base P/T but kept the creature's original creature type (Bear) alongside the new one.

### 6. Variations to test

- Enchant a creature with changeling (every creature type, a characteristic-defining ability): the CDA applies first in layer 4 (613.3), then the Aura overwrites, so it's only an Insect / only an Elk.
- Enchant a legendary creature: it stays legendary (supertypes kept).
- Darksteel Mutation on an artifact creature that is also Equipment-typed (rare): keeps Equipment, per ruling; loses e.g. enchantment card type.
- Kenrith's Transformation on an artifact creature: loses Artifact.
- An "in addition to its other types" effect with a later timestamp (e.g. Necromantic Selection's "It's a black Zombie in addition") still adds its type after the Aura.
- Remove the Aura: the creature is a Bear again.
- Effects that ask "is it a Bear?" (e.g. a lord for Bears) no longer apply to the enchanted creature.

### 7. Acceptance checks

- A Grizzly Bears enchanted by Darksteel Mutation has creature types exactly [Insect] and card types exactly [Artifact, Creature].
- A Grizzly Bears enchanted by Kenrith's Transformation has creature types exactly [Elk] and card type exactly [Creature], and is green.
