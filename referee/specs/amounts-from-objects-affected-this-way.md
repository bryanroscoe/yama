# Spec: counts and amounts taken from the objects an ability just affected come out as 0

Root cause (observed behaviour): when an ability does something to objects and a later part of it uses those objects ("for each creature sacrificed this way", "the greatest power among creatures sacrificed this way", "the total power of creatures goaded this way", "for each permanent exiled this way", "the exiled creature card's power", "the last creature card exiled with it"), phase performs the first part but then finds no affected objects: counts and amounts are 0, and characteristics copied from a linked exiled card aren't applied.

Merged from three specs written in parallel: `amount-from-affected-objects.md` (Part A), `sacrificed-this-way.md` (Part B), `duplicant-imprinted-creature.md` (Part C; the same linked-exile shape as Phyrexian Ingester in Part A).

Cards: Shadowgrange Archfiend, Havoc Eater, Phyrexian Ingester (Part A); Syphon Flesh, Reign of the Pit, Voracious Fell Beast, Unexplained Absence (Part B); Duplicant (Part C).

Related: `destroyed-this-way-return.md` (Necromantic Selection: the "this way" restriction is ignored and a card that was already in a graveyard returns), `returned-this-way-you-control.md` (Flood of Tears over-counts), `dice-roll-spells-do-nothing.md` (Danse Macabre: "put into a graveyard this way"), `drawn-this-way-reflexive-trigger.md`. In the same sweep Infernal Offering ("Each player who sacrificed a creature this way draws two cards") worked in phase.

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: amounts taken from the objects an ability just affected come out as 0

(Formerly `amount-from-affected-objects.md`.)

Root cause (observed behaviour): when an ability does something to objects and then uses a number from those objects ("the greatest power among creatures sacrificed this way", "the total power of creatures goaded this way", "the exiled creature card's power"), phase performs the first part but uses 0 for the number.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-shadowgrange-archfiend`, `card-havoc-eater` (trigger target: seat 1 Grizzly Bears), `card-phyrexian-ingester` (trigger target: seat 1 Grizzly Bears).

### 1. Cards

Oracle text from Scryfall.

- **Shadowgrange Archfiend** ({6}{B} creature — Demon 8/4): "When this creature enters, each opponent sacrifices a creature with the greatest power among creatures they control. You gain life equal to the greatest power among creatures sacrificed this way. Madness—{2}{B}, Pay 8 life."
- **Havoc Eater** ({5}{R}{R} creature — Elemental 3/3): "Flying. When this creature enters, for each opponent, goad up to one target creature that opponent controls. Put X +1/+1 counters on this creature, where X is the total power of creatures goaded this way."
- **Phyrexian Ingester** ({6}{U} creature — Phyrexian Beast 3/3): "Imprint — When this creature enters, you may exile target nontoken creature. This creature gets +X/+Y, where X is the exiled creature card's power and Y is its toughness."
  - Ruling 2016-06-08: "Phyrexian Ingester will get bonuses based on the card's power and toughness in exile. Counters, Auras, and Equipment it had on it before it was exiled won't add to those numbers."

### 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears. Seat 1: Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire. Seat 0 casts the creature; its enters trigger resolves. Havoc Eater's and Phyrexian Ingester's trigger target is seat 1's Grizzly Bears.

### 3. Correct result

**Shadowgrange Archfiend.** Seat 1 sacrifices Serra Angel (the only creature with the greatest power, 4). Seat 0 gains 4 life: **20 → 24**.

**Havoc Eater.** Seat 1's Grizzly Bears (power 2) is goaded. X = 2: Havoc Eater gets two +1/+1 counters and is **5/5**.

**Phyrexian Ingester.** Seat 0 chooses to exile Grizzly Bears (both engines did). The exiled card is a 2/2 creature card, so Ingester gets +2/+2 and is **5/5** for as long as that card stays in exile.

### 4. Why

1. Shadowgrange: the sacrificed creature has left the battlefield; its power is taken from last known information (608.2h: "if it's no longer in that zone ... the effect uses the object's last known information"). "Creatures sacrificed this way" are exactly the ones this resolution sacrificed.
2. Havoc Eater: X is computed on resolution from the creatures this ability goaded (608.2h), using their current power. Goad: 701.15a.
3. Phyrexian Ingester: the exile ability and the P/T ability are linked (607.2a: an ability that refers to "the exiled card" refers to the card exiled by the linked ability). The bonus is a static effect in layer 7c (613.4c) that reads the card's power and toughness in exile (ruling).

### 5. What phase did

- Shadowgrange Archfiend: Serra Angel was sacrificed, but seat 0 stayed at 20 life.
- Havoc Eater: Grizzly Bears was targeted, but Havoc Eater had no counters: 3/3. (The final state doesn't show goad, so whether the goad itself happened is unknown; test it too.)
- Phyrexian Ingester: Grizzly Bears was exiled, but Ingester stayed 3/3.

### 6. Variations to test

- Shadowgrange with a pumped creature (e.g. Serra Angel with a +1/+1 counter) sacrificed: gain uses its power as it last existed (5). Two opponents sacrificing 4- and 2-power creatures: gain 4 (greatest, not total). Opponent with no creatures: gain 0.
- Havoc Eater with "up to one" chosen as zero targets: X = 0. Goading a creature whose power is boosted at resolution counts the boosted power. Two opponents: X is the sum.
- Phyrexian Ingester exiling a creature with +1/+1 counters: bonus uses the card's printed P/T in exile (counters don't count). If the exiled card leaves exile, the bonus ends. Exiling a token (not allowed: "nontoken"). Choosing not to exile: no bonus.
- Ingester copied by a Clone: the Clone has the abilities but no linked exiled card, so no bonus (607.2a).

### 7. Acceptance checks

- After Shadowgrange Archfiend's trigger, its controller has gained life equal to the greatest power among the sacrificed creatures as they last existed.
- After Havoc Eater's trigger goads a 2-power creature, Havoc Eater has two +1/+1 counters.
- Phyrexian Ingester that exiled a 2/2 creature card is 5/5 while that card is in exile.

## Part B: "Sacrificed this way" counts and uses the creatures the spell just sacrificed

(Formerly `sacrificed-this-way.md`.)

Scenarios: `card-syphon-flesh`, `card-reign-of-the-pit`. Observed:
- Syphon Flesh: seat 1 sacrifices Grizzly Bears in both engines; Forge creates a 2/2 Zombie for seat 0, phase creates none.
- Reign of the Pit: both seats sacrifice Grizzly Bears; Forge creates a 4/4 flying Demon for seat 0; phase creates a Demon that is immediately put into the graveyard (0/0).

### 1. Cards

- **Syphon Flesh** {4}{B}, Sorcery. "Each other player sacrifices a creature of their choice. You create a 2/2 black Zombie creature token for each creature sacrificed this way."
- **Reign of the Pit** {4}{B}{B}, Sorcery. "Each player sacrifices a creature of their choice. Create an X/X black Demon creature token with flying, where X is the total power of the creatures sacrificed this way."

Rulings, Reign of the Pit (2014-05-29):
- "You choose which creature you are sacrificing first, then each other player in turn order does the same. The creatures are all sacrificed simultaneously."
- "Use the powers of the creatures as they last existed on the battlefield to determine the value of X, even if they were negative. For example, if the sacrificed creatures were 3/3, 5/5, 0/4, and -2/2, the Demon will be 6/6."

### 2. Board and actions

Sweep board: seat 0 has the lands for the cost and Grizzly Bears (2/2). Seat 1 has Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire. Seat 0 casts the card (no targets); it resolves.

### 3. Correct result

- Syphon Flesh: seat 1 sacrifices one creature of its choice (Grizzly Bears in both engines). Seat 0 creates exactly one 2/2 black Zombie token. Seat 0's own Bears is untouched ("each other player").
- Reign of the Pit: seat 0 sacrifices its Grizzly Bears (its only creature), seat 1 sacrifices one of its creatures (Grizzly Bears in both engines). Seat 0 creates a 4/4 black Demon token with flying, which stays on the battlefield. Had seat 1 chosen Serra Angel, the Demon would be 6/6.

### 4. Why

1. Instructions are followed in order (608.2c). The sacrifices happen first (701.21a: moved from the battlefield to the owner's graveyard).
2. "This way" refers to the creatures actually sacrificed by that first sentence of the same resolving spell (608.2c, read the whole text). One creature was sacrificed by Syphon Flesh, so one Zombie; two by Reign of the Pit.
3. Reign of the Pit's X needs information from objects that have left the battlefield, so it uses their last known information (608.2h, 113.7a): each Grizzly Bears had power 2 on the battlefield; X = 2 + 2 = 4. The ruling says the same.
4. The Demon is 4/4, so state-based actions don't put it into the graveyard (704.5f only applies at toughness 0 or less).

### 5. What phase did

- Syphon Flesh: the sacrifice happened, but no token was created (count treated as 0).
- Reign of the Pit: the Demon was created as 0/0 (power of the sacrificed creatures not counted) and died to 704.5f.

Note: in the same batch, Infernal Offering ("Each player who sacrificed a creature this way draws two cards") worked in phase, so the "this way" link works for that card.

### 6. Variations to test

- Reign of the Pit where a sacrificed creature was pumped until end of turn (e.g. +3/+3): its pumped power counts (last known information).
- A sacrificed creature with negative power: it lowers X (ruling example: 3/3, 5/5, 0/4, -2/2 gives 6/6).
- A player who controls no creature sacrifices nothing; only real sacrifices count (Syphon Flesh with an opponent who has no creatures: no Zombie).
- Sacrificed creature is a token: it still counts.
- A sacrificed creature that goes to exile instead of the graveyard (e.g. under Rest in Peace) was still sacrificed and still counts.
- Multiplayer Syphon Flesh with three opponents who each have a creature: three Zombies.

### 7. Acceptance checks

- Syphon Flesh with one opponent who sacrifices a creature gives the caster exactly one 2/2 black Zombie.
- Reign of the Pit where two 2/2 creatures are sacrificed gives a 4/4 flying Demon that survives.
- X uses the creatures' power as they last were on the battlefield, not 0.

---

### Added from triage batch 2: Voracious Fell Beast

Same shape as Syphon Flesh: the sacrifice happens, the count of creatures "sacrificed this way" comes out 0.

Scenario: `card-voracious-fell-beast`. Standard sweep board (`referee/sweep.py`); seat 0's lands are Swamp, Swamp + 4 Wastes.

- **Voracious Fell Beast** {4}{B}{B}, Creature — Drake Beast, 4/4. "Flying / When this creature enters, each opponent sacrifices a creature of their choice. Create a Food token for each creature sacrificed this way. (It's an artifact with '{2}, {T}, Sacrifice this token: You gain 3 life.')"

Seat 0 casts Voracious Fell Beast; its trigger resolves; seat 1 sacrifices Grizzly Bears (both engines made that choice).

**Correct result:** one creature was sacrificed, so seat 0 creates one Food token (608.2c, 701.21a). Forge matches.

**What phase did:** seat 1 sacrificed Grizzly Bears; no Food was created.

**Variations:** two opponents each sacrificing a creature: two Food. An opponent with no creature sacrifices nothing and adds no Food. A sacrificed creature that a replacement effect exiles instead of putting into the graveyard was still sacrificed and still counts.

**Acceptance check:** on this board, after the trigger resolves, seat 0 controls exactly one Food token and seat 1's Grizzly Bears is in seat 1's graveyard.

### Added from triage batch 3: Unexplained Absence ("for each permanent exiled this way")

Scenario: `card-unexplained-absence` (standard sweep board). Same shape: a "for each ... this way" count is treated as zero.

**Unexplained Absence** ({3}{W} instant): "For each player, exile up to one target nonland permanent that player controls. For each permanent exiled this way, its controller cloaks the top card of their library. (To cloak a card, put it onto the battlefield face down as a 2/2 creature with ward {2}. Turn it face up any time for its mana cost if it's a creature card.)"

- Board and action: seat 0 has Plains, 3 Wastes, Grizzly Bears; library 8 Wastes. Seat 0 casts it with one target, its own Grizzly Bears (seat 1: no target).
- Correct (608.2c, 701.58a): the Bears is exiled; one permanent was exiled this way, so its controller, seat 0, cloaks the top card of its library: a face-down 2/2 creature with ward {2}. Final: seat 0 exile [Grizzly Bears], a face-down 2/2 on seat 0's battlefield, library 7. (Forge: exactly this.)
- Phase: exiled the Bears, then cloaked nothing (library 8, no face-down creature).
- Variations: one target on each side (seat 0's Bears and seat 1's Serra Angel) → each player cloaks one card from their own library; zero targets → nothing; a target that has become illegal (left before resolution) isn't exiled, so its controller cloaks nothing; the cloaked card is the controller's library top, not the caster's.
- Acceptance: each permanent this spell exiles gives its controller exactly one cloaked 2/2 with ward {2} from the top of their own library.

## Part C: Duplicant takes the power, toughness and creature types of the card it exiled

(Formerly `duplicant-imprinted-creature.md`.)

Scenario: `card-duplicant`. Observed: both engines exile seat 1's Grizzly Bears with Duplicant's trigger. Forge then shows Duplicant as a 2/2 Artifact Creature with types Bear and Shapeshifter; phase shows it as 2/4 with only Shapeshifter.

### 1. Card

- **Duplicant** {6}, Artifact Creature — Shapeshifter, 2/4. "Imprint — When this creature enters, you may exile target nontoken creature. As long as a card exiled with this creature is a creature card, this creature has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter."
- **Grizzly Bears** {1}{G}, Creature — Bear, 2/2.

Rulings (Scryfall, 2020-08-07):
- "Duplicant's base power and toughness change to the imprinted card's power and toughness. Counters and other effects that modify Duplicant's power and toughness still apply."
- "Duplicant's power and toughness are constantly updated if the exiled card's power and/or toughness change."
- "Abilities that define a * in a creature's power and toughness apply while that card is in exile, but abilities that add or subtract power and toughness don't."

### 2. Board and actions

Sweep board: seat 0 has six Wastes and Grizzly Bears; seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Duplicant. Its enters trigger targets seat 1's Grizzly Bears (scripted). Seat 0 chooses to exile it (both engines did).

### 3. Correct result

- Seat 1's Grizzly Bears is in seat 1's exile.
- Duplicant: Artifact Creature — Shapeshifter Bear, power 2, toughness 2, no damage.

### 4. Why

1. The trigger and the static ability are linked (607.2a, 406.6): "exiled with this creature" means the Grizzly Bears card exiled by that trigger.
2. The exiled Grizzly Bears is a creature card, so the static ability applies (611.3, it's a static ability's continuous effect, always on while the condition holds).
3. Layer 4 (613.1d): Duplicant's creature types become those of the card, Bear, and "It's still a Shapeshifter" keeps Shapeshifter. It stays an Artifact Creature (card types aren't changed).
4. Layer 7b (613.4b): its base power and toughness are set to the card's, 2/2 (ruling: "base power and toughness change to the imprinted card's").
5. No other effects modify it, so it's 2/2.

### 5. What phase did

Exiled the Grizzly Bears, then left Duplicant at its printed 2/4 with only the Shapeshifter type.

### 6. Variations to test

- Seat 0 declines the "may": Duplicant stays a 2/4 Shapeshifter.
- Exile a creature that has +1/+1 counters or an Aura pump (e.g. Serra Angel with a +1/+1 counter): Duplicant uses the card in exile, 4/4, Angel Shapeshifter (counters and pumps don't follow the card).
- Duplicant with its own +1/+1 counter, then exiling Grizzly Bears: 3/3 (counters apply on top, layer 7c).
- Exile a creature whose power/toughness is defined by a */* ability (e.g. a Lhurgoyf-type card): the CDA applies in exile and Duplicant's P/T tracks it.
- If the exiled card later leaves exile, no card exiled with Duplicant is a creature card, so it returns to 2/4 Shapeshifter.
- Duplicant's flying etc. are not copied: only power, toughness and creature types (Serra Angel exiled gives no flying or vigilance).

### 7. Acceptance checks

- After Duplicant exiles a Grizzly Bears, it's a 2/2 Artifact Creature with creature types Bear and Shapeshifter.
- Its toughness 4 must not survive the exile.
- Its abilities are unchanged (no keywords from the exiled card).
