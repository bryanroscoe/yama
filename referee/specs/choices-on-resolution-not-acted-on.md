# Spec: choices made while an effect resolves are never acted on

Root cause (observed behaviour): when a spell or ability has a player *choose* something as it resolves (an object: "choose a creature", "the creature card with the greatest power", one creature per opponent; or an option from a list: war or peace, a color, silence or snitch), phase makes no choice, or ignores it, and the instructions that depend on the choice do nothing. The board ends as if that part of the effect didn't exist. In some cases phase also treats the choice as a target, asking for it when the spell was cast or the trigger was put on the stack, which 115.10a forbids; in one (Foreboding Steamboat) it acted on the source instead of the chosen objects.

Merged from three specs written in parallel: `objects-chosen-on-resolution-not-acted-on.md` (Part A), `each-player-chooses-produces-no-result.md` (Part B), `for-each-opponent-choose-a-creature.md` (Part C). Fix and test them together.

Cards: Sadistic Shell Game, Chaos Defiler, Eye of Doom, Summon: Valefor, Desecrator Hag, Dredge the Mire, Celestial Judgment, Stick Together, Foreboding Steamboat, The Nipton Lottery, Armed and Armored, Colonel Autumn (Part A); Archangel of Strife, Selective Obliteration, Prisoner's Dilemma (Part B); Highcliff Felidar, Benthic Anomaly (Part C).

Related: `votes-produce-no-result.md` (votes, 701.38), `friend-or-foe-is-a-choice.md` (the caster's friend-or-foe choice was taken as a vote, then nothing happened), `villainous-choice-outcomes.md`, `gain-control-of-chosen-or-all-creatures.md` (control of creatures chosen on resolution).

Contradiction resolved in the merge: Part A section 4 cited 608.2c for choices made on resolution, where Parts B and C (and Part A's Celestial Judgment section) cite 608.2d. 608.2d is the rule for choices made while applying an effect; 608.2c is the rule for following the instructions in order. Part A now cites both for what each covers.

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: objects chosen (not targeted) while an effect resolves are never acted on

(Formerly `objects-chosen-on-resolution-not-acted-on.md`.)

Root cause (observed behaviour): when an effect has a player *choose* an object as it resolves (or picks one by a characteristic, like "with the greatest power"), and then does something to "the chosen" object(s), phase does nothing. In two of the cases phase also treated the choice as a target, asking for it when the spell was cast or the trigger was put on the stack, which the rules forbid (115.10a); it still did nothing to the object.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-sadistic-shell-game`, `card-chaos-defiler`, `card-eye-of-doom`, `card-summon-valefor`, `card-desecrator-hag`.

### 1. Cards

Oracle text and rulings from Scryfall.

- **Sadistic Shell Game** ({4}{B} sorcery): "Starting with the next opponent in turn order, each player chooses a creature you don't control. Destroy the chosen creatures."
  - 2024-09-20: "Each player will know what choices players earlier in the turn order made."
- **Chaos Defiler** ({3}{B}{R} Artifact Creature — Demon Construct 5/4): "Trample. Battle Cannon — When this creature enters or dies, for each opponent, choose a nonland permanent that player controls. Destroy one of them chosen at random."
  - 2022-10-07: "If you choose one or more permanents with indestructible, and there are any permanents chosen which do not have indestructible, one of the permanents without indestructible will be randomly chosen and destroyed."
- **Eye of Doom** ({4} artifact): "When this artifact enters, each player chooses a nonland permanent and puts a doom counter on it. {2}, {T}, Sacrifice this artifact: Destroy each permanent with a doom counter on it."
  - 2013-10-17: "The active player chooses a permanent first, followed by each other player in turn order. ... Then the doom counters are put on all the chosen permanents simultaneously." "None of the permanents are targeted."
- **Summon: Valefor** ({4}{U} Enchantment Creature — Saga Drake 5/4): "I — Sonic Wings — Each opponent chooses a creature with the greatest mana value among creatures they control. Return those creatures to their owners' hands. II, III, IV — Tap up to one target creature and put a stun counter on it."
  - 2025-06-06: "While resolving Valefor's first chapter ability, the next opponent in turn order chooses a creature with the greatest mana value among creatures they control, then each other opponent in turn order does the same. Then the chosen creatures are returned to their owners' hands simultaneously."
- **Desecrator Hag** ({2}{B/G}{B/G} 2/2): "When this creature enters, return to your hand the creature card in your graveyard with the greatest power. If two or more cards are tied for greatest power, you choose one of them."
  - 2008-08-01: "This ability doesn't target a card. It will determine which card is returned to your hand as it resolves."

### 2. Board and actions

Seat 0 (active, main phase 1): the lands for the card, Grizzly Bears; graveyard Hill Giant (creature 3/3) and Divination. Seat 1: Grizzly Bears (MV 2), Serra Angel (MV 5), Millstone, Seal of Fire (all nonland). Seat 0 casts the card; for the creatures/Saga, the enters trigger or chapter I resolves.

### 3. Correct result

- **Sadistic Shell Game:** seat 1 chooses a creature seat 0 doesn't control (Grizzly Bears or Serra Angel, both seat 1's), then seat 0 chooses one too (also from seat 1's two). The chosen creatures are destroyed: **one or both of seat 1's creatures go to the graveyard; seat 0's Grizzly Bears survives.** (Forge: both destroyed.)
- **Chaos Defiler:** seat 0 chooses one nonland permanent seat 1 controls; it is the only chosen permanent, so it is destroyed. **Exactly one of seat 1's Grizzly Bears, Serra Angel, Millstone, Seal of Fire is destroyed.** (Forge: Serra Angel.)
- **Eye of Doom:** seat 0 chooses a nonland permanent (any player's), then seat 1 does; each chosen permanent gets one doom counter. **Exactly two doom counters are placed in total (two permanents, or two counters on one permanent if both chose the same).** (Forge: one on Eye of Doom, one on Serra Angel.)
- **Summon: Valefor, chapter I:** seat 1's creature with the greatest mana value is Serra Angel (5 > 2), so seat 1 must choose it; **Serra Angel returns to seat 1's hand.** No creature is tapped and no stun counter is placed (chapter II hasn't triggered). (Forge: Serra Angel to hand.)
- **Desecrator Hag:** seat 0's only creature card in its graveyard is Hill Giant, so **Hill Giant goes to seat 0's hand**. (Forge: Hill Giant to hand.)

### 4. Why

1. None of these abilities uses the word "target", so nothing is targeted (115.10, 115.10a); the objects are chosen as the ability resolves (608.2d, rulings above). Nothing should be asked for at cast / trigger time, and no "becomes the target" events happen.
2. The instruction after the choice ("Destroy the chosen creatures", "Destroy one of them chosen at random", "puts a doom counter on it", "Return those creatures", "return to your hand the creature card ...") is mandatory and applies to the chosen object(s) (608.2c).
3. A choice can only be skipped if there's nothing legal to choose (609.3: do as much as possible). Here every choice has at least one legal option.
4. Valefor's "greatest mana value" and Desecrator Hag's "greatest power" restrict the choice; when only one object qualifies, that object is the one.

### 5. What phase did

- Sadistic Shell Game: logged "Grizzly Bears is targeted by Sadistic Shell Game" during casting (the runner was asked for a target), then destroyed nothing.
- Chaos Defiler: trigger resolved; nothing destroyed.
- Eye of Doom: trigger resolved; no doom counters anywhere.
- Summon: Valefor: logged "Serra Angel is targeted by Summon: Valefor" when chapter I went on the stack, then nothing happened (Serra Angel stayed, untapped, no counter).
- Desecrator Hag: trigger resolved; Hill Giant stayed in the graveyard.

### 6. Variations to test

- **Sadistic Shell Game with three players** (seat 0 casting, seats 1 and 2 opponents): order is seat 1, seat 2, then seat 0; each must choose a creature seat 0 doesn't control (they may choose creatures of any non-caster player, including their own). All chosen are destroyed simultaneously.
- **Sadistic Shell Game when no creature qualifies** (opponents control no creatures): nothing is destroyed, no error.
- **Hexproof/protection.** Sadistic Shell Game, Chaos Defiler, Eye of Doom and Valefor can choose a creature with hexproof or protection from the source's color, because nothing is targeted (Eye of Doom ruling).
- **Chaos Defiler dies.** The "or dies" half: same result when it dies (e.g. after Lightning Bolt on a 5/4 with damage).
- **Chaos Defiler, two opponents:** one nonland permanent is chosen per opponent, then exactly one of those chosen permanents (random) is destroyed — not one per opponent.
- **Chaos Defiler, indestructible:** per the ruling, if any chosen permanent lacks indestructible, the random pick is among those.
- **Eye of Doom's activation:** after the counters, activate {2}, {T}, sacrifice: every permanent with a doom counter is destroyed.
- **Valefor with a tie:** seat 1 controls two creatures with MV 5: seat 1 chooses either one, exactly one returns.
- **Desecrator Hag with a tie:** two creature cards with power 3 in the graveyard: seat 0 chooses one; exactly one returns. With no creature card: nothing happens.
- **Valefor chapter II:** after a second lore counter, chapter II asks for "up to one target creature" (this one *is* targeted): it taps it and puts a stun counter on it.

### 7. Acceptance checks

- Casting Sadistic Shell Game on this board destroys at least one of the opponent's creatures and none of the caster's, and no target is chosen while casting it.
- Chaos Defiler's enters trigger destroys exactly one nonland permanent the opponent controls.
- Eye of Doom's enters trigger puts exactly one doom counter on a permanent chosen by each player.
- Summon: Valefor's chapter I returns the opponent's Serra Angel to hand without targeting it.
- Desecrator Hag's enters trigger puts Hill Giant from the graveyard into its owner's hand.

### Added from triage batch 1: Dredge the Mire (opponent chooses a card in its graveyard)

Scenario: `card-dredge-the-mire`. Observed: Forge puts seat 1's Hill Giant onto the battlefield under seat 0's control. Phase moves Dredge the Mire to the graveyard with no choice and no other effect.

- **Dredge the Mire** ({3}{B} sorcery): "Each opponent chooses a creature card in their graveyard. Put those cards onto the battlefield under your control."
  - Ruling 2020-04-17: "As Dredge the Mire resolves, first the next opponent in turn order ... chooses a creature card in their graveyard, then each other opponent in turn order does the same knowing the choices made before them. Then all the chosen cards are returned at the same time."

Board: the sweep board; seat 1's graveyard holds Hill Giant, its only creature card.

Correct result: seat 1 must choose Hill Giant (the choice is mandatory when a creature card exists; 608.2c). It enters the battlefield under seat 0's control (109.5: "your" is the caster). Seat 1's graveyard is empty; seat 0's own graveyard is untouched.

What phase did: nothing.

Variations: an opponent with no creature card in its graveyard (nothing for that opponent); several creature cards (the opponent picks one, exactly one comes over); multiplayer (one card from each opponent, all at once); a returned creature with an enters trigger (triggers under seat 0's control); the caster's own graveyard is never used.

Acceptance: Dredge the Mire puts exactly one creature card from each opponent's graveyard (if any) onto the battlefield under its caster's control, chosen by that opponent.

---

### Added from triage batch 2: Celestial Judgment

### Spec: Celestial Judgment destroys nothing when two creatures share a power

Scenario: `card-celestial-judgment` (card sweep, batch 2).

#### 1. Card

- **Celestial Judgment** {4}{W}{W}, Sorcery. "For each different power among creatures on the battlefield, choose a creature with that power. Destroy each creature not chosen this way."
  - Ruling 2021-09-24: "No creatures are targeted by Celestial Judgment, so all choices are made as the spell resolves."
  - Ruling 2021-09-24: "All creatures that aren't chosen are destroyed simultaneously."
  - Ruling 2021-09-24: "If there are multiple creatures with the same power on the battlefield, you may choose any of them, even if one of them wouldn't be destroyed."

#### 2. Board and actions

Board: the sweep board (top of this file).

Lands Plains, Plains + 4 Wastes. Seat 0 casts Celestial Judgment; it resolves.

#### 3. Correct result

Creatures on the battlefield: seat 0's Grizzly Bears (power 2), seat 1's Grizzly Bears (2), Serra Angel (4). Different powers: 2 and 4. Seat 0 (the spell's controller) chooses one creature with power 2 (either Grizzly Bears; its choice) and Serra Angel for power 4. The unchosen Grizzly Bears is destroyed. Forge chose seat 0's own Bears, destroying seat 1's.

So exactly one Grizzly Bears is in a graveyard at the end; Serra Angel survives.

#### 4. Why

1. The choices are made by the spell's controller as it resolves (608.2d, ruling); "choose" without "target" doesn't target (115.10).
2. One creature is chosen per distinct power value, so with two creatures at power 2 exactly one of them is unchosen and destroyed (701.8 destroy, simultaneously).

#### 5. What phase did

Nothing was destroyed; the spell went to the graveyard.

#### 6. Variations to test

- All creatures with different powers: nothing destroyed.
- Three creatures with power 2 and one with power 4: two of the 2-power creatures destroyed.
- A 0-power creature: power 0 is a power; it's chosen if it's the only one at 0.
- An indestructible 2-power creature and a normal 2-power creature: the controller may choose the normal one, and the indestructible one survives anyway (ruling).
- Creatures controlled by different players: the caster chooses for all of them.

#### 7. Acceptance checks

- On this board, after Celestial Judgment resolves, exactly one of the two Grizzly Bears is in its owner's graveyard and Serra Angel is still on the battlefield.

---

### Added from triage batch 2: Stick Together

### Spec: Stick Together keeps creatures that can't be in a party

Scenario: `card-stick-together` (card sweep, batch 2).

#### 1. Card

- **Stick Together** {3}{W}{W}, Sorcery. "Each player chooses a party from among creatures they control, then sacrifices the rest. (To choose a party, choose up to one each of Cleric, Rogue, Warrior, and Wizard.)"

#### 2. Board and actions

Board: the sweep board (top of this file).

Lands Plains, Plains + 3 Wastes. Seat 0 casts Stick Together; it resolves.

#### 3. Correct result

No creature on the battlefield is a Cleric, Rogue, Warrior or Wizard (Grizzly Bears is a Bear, Serra Angel an Angel). Each player's party is empty, so each sacrifices all its creatures: seat 0's Grizzly Bears, seat 1's Grizzly Bears and Serra Angel all go to their owners' graveyards. Noncreature permanents (lands, Millstone, Seal of Fire) are untouched. (Forge matches.)

#### 4. Why

1. 700.8d: "Stick Together instructs players to choose a party from among creatures they control. To do so, for each of the creature types listed in rule 700.8, each player chooses up to one creature they control of that type."
2. 700.8: a party is up to one Cleric, one Rogue, one Warrior and one Wizard. A creature with none of these types can't be chosen for any slot.
3. "Sacrifices the rest" = every creature the player controls that wasn't chosen (701.21a). Choices are made in APNAP order, then all sacrifices happen at once (608.2e).

#### 5. What phase did

Nobody sacrificed anything; all three creatures stayed on the battlefield.

#### 6. Variations to test

- A Cleric and a Wizard plus a Bear: keep the Cleric and Wizard, sacrifice the Bear.
- Two Clerics: keep one, sacrifice the other.
- A changeling creature can fill any one slot, but only one (700.8b); with a changeling and a Cleric, both can be kept (changeling as Rogue, say).
- A Cleric Wizard counts for one slot only.

#### 7. Acceptance checks

- On this board, after Stick Together resolves, no creatures remain on the battlefield; seat 0's graveyard includes Grizzly Bears and seat 1's includes Grizzly Bears and Serra Angel.

### Added from triage batch 3: Foreboding Steamboat, The Nipton Lottery, Armed and Armored, Colonel Autumn

Scenarios: `card-foreboding-steamboat`, `card-the-nipton-lottery`, `card-armed-and-armored`, `card-colonel-autumn` (standard sweep board). In each, something is chosen (not targeted) as the effect resolves; phase either acts on the wrong object, does nothing, or treats the choice as a target.

**Foreboding Steamboat** ({3}{B}{B} Artifact — Vehicle, crew 2): "When this Vehicle enters, each player chooses two nontoken, non-Vehicle creatures they control. Exile them until this Vehicle leaves the battlefield. ..."
- Ruling: "Starting with the player whose turn it is, each player in turn order chooses two nontoken, non-Vehicle creatures they control, then all the creatures chosen by all players are exiled at the same time." "If Foreboding Steamboat leaves the battlefield before its first triggered ability resolves, the chosen creatures won't be exiled at all."
- Correct: seat 0 controls only one such creature, Grizzly Bears (the uncrewed Steamboat isn't a creature, and it's a Vehicle anyway), so it chooses that one (609.3); seat 1 chooses Grizzly Bears and Serra Angel. All three are exiled until the Steamboat leaves (610.3). Final: seat 0 exile [Grizzly Bears], seat 1 exile [Grizzly Bears, Serra Angel]; the Steamboat stays on the battlefield. (Forge: exactly this.)
- Phase: exiled **the Steamboat itself** and no creature. ("Them" is the chosen creatures; the source is never mentioned.)
- Variations: the Steamboat leaves the battlefield later (e.g. destroyed): the three creatures return under their owners' control (610.3c). A player with three eligible creatures chooses exactly two. Tokens and Vehicles can't be chosen.

**The Nipton Lottery** ({2}{B}{R} sorcery): "Choose a creature at random. You gain control of that creature until end of turn. Untap it. It gains haste until end of turn. Then destroy all other creatures."
- Rulings: "The creature chosen at random isn't targeted, so a creature with shroud or an opponent's creature with hexproof can be chosen this way." "Players can't take actions between the time the creature is randomly chosen and the time at which the rest of the effects occur."
- Correct: one of the three creatures (seat 0's Bears, seat 1's Bears, Serra Angel) is chosen at random; seat 0 controls it until end of turn, untapped, with haste; **the other two are destroyed**. Exactly one creature remains on the battlefield. Forge: chose seat 0's Bears; seat 1's Bears and Serra Angel destroyed.
- Phase: the spell went to the graveyard with no effect; all three creatures survived.
- Variations: chosen creature is seat 1's (seat 0 controls it until end of turn, then it returns to seat 1); indestructible "other" creatures survive the destroy; only one creature on the battlefield (it's chosen, nothing destroyed).

**Armed and Armored** ({1}{W} instant): "Vehicles you control become artifact creatures until end of turn. Choose a Dwarf you control. Attach any number of Equipment you control to it."
- Ruling: "You can cast Armed and Armored even if you don't control any Vehicles or Dwarves. Whatever part of the effect that can happen does, and the rest is ignored."
- Correct: the spell has no targets (115.10a), so it can be cast on the sweep board (Plains + Wastes); it resolves and does nothing (no Vehicle, no Dwarf, no Equipment). (Forge: exactly this.)
- Phase: **refused the cast** with "No legal targets available": it treated "choose a Dwarf you control" as a target.
- Variations: with a Dwarf and two Equipment, seat 0 chooses the Dwarf on resolution and may attach both; with a Vehicle, it's an artifact creature until end of turn (with its printed P/T); a Dwarf with shroud can still be chosen.

**Colonel Autumn** ({1}{W}{B} Legendary Creature — Human Soldier 2/3): "Lifelink. Exploit (When this creature enters, you may sacrifice a creature.) Other legendary creatures you control have exploit. Whenever a creature you control exploits a creature, put a +1/+1 counter on each creature you control."
- Rulings: "You choose whether to sacrifice a creature and which creature to sacrifice as an exploit ability resolves." "You can sacrifice the creature with exploit if it's still on the battlefield. If it has an ability that triggers when it exploits a creature (or, in this case, when any creature you control exploits a creature), that ability will trigger." "You can't sacrifice more than one creature to any one exploit ability."
- Correct (702.110a, 702.110b, 603.5): the exploit trigger has no target. On resolution seat 0 may sacrifice Grizzly Bears or Colonel Autumn, or nothing (AI's choice). If it sacrifices the Bears, Autumn's last ability triggers and Autumn gets a +1/+1 counter (3/4) (Forge: exactly this). If it sacrifices Autumn itself, the ability still triggers and the Bears gets a counter (3/3). If it declines, nothing.
- Phase: logged "Colonel Autumn is targeted by Colonel Autumn" when the trigger went on the stack (the runner recorded it as a trigger target), then nothing was sacrificed. Exploit must not target, and if a creature is picked to sacrifice it must actually be sacrificed.
- Variations: exploit with a shroud creature you control (e.g. Argothian Enchantress, a 0/1 with shroud) as the one sacrificed: allowed; a "whenever this creature becomes the target" ability on your creature must not trigger from exploit; Autumn leaves before the exploit trigger resolves: you may still sacrifice a creature, but Autumn's last ability doesn't trigger (ruling).

Acceptance: the Steamboat exiles the chosen creatures, never itself; The Nipton Lottery always leaves exactly one creature (when it started with three nonindestructible ones); Armed and Armored can be cast with no Dwarf; exploit asks for no target and sacrifices the creature chosen on resolution.

## Part B: "each player chooses" / "each opponent chooses" effects do nothing

(Formerly `each-player-chooses-produces-no-result.md`.)

Root cause (observed behaviour): when a spell or replacement effect asks each player (or each opponent) to make a choice from a list (war/peace, a color, silence/snitch), phase makes no choice and applies none of the results. The board ends as if the effect didn't exist.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-archangel-of-strife`, `card-selective-obliteration`, `card-prisoner-s-dilemma`.

### 1. Cards

Oracle text from Scryfall.

- **Archangel of Strife** ({5}{W}{W} creature — Angel 6/6): "Flying. As this creature enters, each player chooses war or peace. Creatures controlled by players who chose war get +3/+0. Creatures controlled by players who chose peace get +0/+3."
  - Rulings 2011-09-22: "The active player chooses war or peace first, followed by each other player in turn order." "Archangel of Strife's bonuses apply immediately. Depending on your choice, Archangel of Strife will enter as either a 9/6 or 6/9 creature." "Archangel of Strife's second and third abilities are linked. Similarly, its second and fourth abilities are linked."
- **Selective Obliteration** ({3}{C}{C} sorcery): "Each player chooses a color. Then exile each permanent unless it's colorless or it's only the color its controller chose."
  - Rulings 2024-06-07: players choose in turn order starting with the active player; "Lands have no mana cost, so they are colorless unless an effect states otherwise." "No matter what color any player chooses, all multicolored permanents will be exiled." "The colors chosen by players affect only whether or not permanents they control will be exiled."
- **Prisoner's Dilemma** ({3}{R}{R} sorcery): "Each opponent secretly chooses silence or snitch, then the choices are revealed. If each opponent chose silence, Prisoner's Dilemma deals 4 damage to each of them. If each opponent chose snitch, Prisoner's Dilemma deals 8 damage to each of them. Otherwise, Prisoner's Dilemma deals 12 damage to each opponent who chose silence. Flashback {5}{R}{R}"

### 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): the lands for the card, Grizzly Bears (green); hand: the card, Wastes. Seat 1: Grizzly Bears (green 2/2), Serra Angel (white 4/4), Millstone (colorless artifact), Seal of Fire (red enchantment). Seat 0 casts the card.

### 3. Correct result

**Archangel of Strife.** As it enters, seat 0 then seat 1 each choose war or peace (each AI's own choice). Then, continuously:
- If seat 0 chose war: Archangel 9/6, seat 0's Grizzly Bears 5/2. Peace: Archangel 6/9, Bears 2/5.
- If seat 1 chose war: seat 1's Grizzly Bears 5/2, Serra Angel 7/4. Peace: Bears 2/5, Angel 4/7.
No outcome leaves every creature at its printed P/T. Forge: both chose war (Archangel 9/6, Bears 5/2, seat 1 Bears 5/2, Angel 7/4).

**Selective Obliteration.** Each player chooses a color (seat 0 first). Then exile every permanent that is not colorless and not exactly its controller's chosen color.
- Seat 0: lands are colorless and stay. Grizzly Bears stays only if seat 0 chose green.
- Seat 1: Millstone (colorless) stays. Of Grizzly Bears (green), Serra Angel (white), Seal of Fire (red), at most one stays: the one matching seat 1's color. If seat 1 chose green, Serra Angel and Seal of Fire are exiled (Forge's result).
- Selective Obliteration itself goes to the graveyard.

**Prisoner's Dilemma.** One opponent (seat 1) chooses silence or snitch. "Each opponent" is just seat 1, so:
- silence: 4 damage to seat 1 (20 → 16, Forge's result);
- snitch: 8 damage to seat 1 (20 → 12).
Seat 1 always takes damage.

### 4. Why

1. Archangel: "As this creature enters, each player chooses" is a replacement effect (614.1c); the choices are made before it enters (614.12a), in turn order (ruling). The +3/+0 and +0/+3 abilities are linked to that choice (607.2, ruling) and are static abilities applying in layer 7c (613.4c), including to Archangel itself.
2. Selective Obliteration and Prisoner's Dilemma: choices offered by a resolving spell are made while applying the effect (608.2d) and the instructions are then followed in order (608.2c). There is no "may" in either card: the choice and its consequence are mandatory. A player can't decline to choose (608.2d: "The player can't choose an option that's illegal or impossible").
3. Selective Obliteration's "only the color its controller chose" and the colorless exception follow the rulings above; 105.2c (colorless) for lands.

### 5. What phase did

- Archangel of Strife: no choice logged; every creature kept printed P/T (Archangel 6/6, Bears 2/2, Angel 4/4).
- Selective Obliteration: nothing exiled; seat 1 kept Grizzly Bears, Serra Angel and Seal of Fire (impossible under any choice).
- Prisoner's Dilemma: no choice, no damage (seat 1 at 20).

### 6. Variations to test

- Archangel with seat 0 choosing peace and seat 1 war (and the reverse); creatures entering later under a player's control get that player's bonus; Archangel leaving ends all bonuses; a second Archangel with different choices gives +3/+3.
- Selective Obliteration with a multicolored permanent (always exiled) and with an artifact creature that is colorless (stays).
- Prisoner's Dilemma in a three-player game: both silence → 4 each; both snitch → 8 each; mixed → 12 to each silence player, 0 to the snitch. Flashback cast from the graveyard works the same and the card is exiled after.

### 7. Acceptance checks

- After Archangel of Strife enters in a two-player game, every creature on the battlefield has +3/+0 or +0/+3 according to its controller's choice; none is unmodified.
- After Selective Obliteration, each player keeps only colorless permanents plus permanents that are exactly their chosen color; the opponent in this scenario loses at least two of Grizzly Bears, Serra Angel, Seal of Fire.
- Prisoner's Dilemma against one opponent always deals 4 or 8 damage to them.

## Part C: "for each opponent, choose a creature that player controls" does nothing

(Formerly `for-each-opponent-choose-a-creature.md`.)

Root cause (observed behaviour): abilities that, for each opponent, choose (not target) a creature that opponent controls and then act on the chosen creatures do nothing in phase. Highcliff Felidar destroys nothing; Benthic Anomaly's cast trigger creates no token.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-highcliff-felidar`, `card-benthic-anomaly`.

### 1. Cards

Oracle text from Scryfall.

- **Highcliff Felidar** ({5}{W}{W} creature — Cat Beast 5/5): "Vigilance. When this creature enters, for each opponent, choose a creature with the greatest power among creatures that player controls. Destroy those creatures."
- **Benthic Anomaly** ({6}{U} creature — Eldrazi Serpent 7/8): "Devoid (This card has no color.) When you cast this spell, for each opponent, choose a creature that player controls. Create a token that's a copy of one of those creatures, except its power is equal to the total power of those creatures, its toughness is equal to the total toughness of those creatures, and it's a colorless Eldrazi creature."
  - Rulings 2024-06-07: "Benthic Anomaly's triggered ability will resolve before Benthic Anomaly does." "The token is an Eldrazi creature instead of its other types and subtypes and is colorless instead of retaining any of its colors. It retains any supertypes it had." "Any enters-the-battlefield abilities of the copied creature will trigger when the token enters the battlefield."

### 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears. Seat 1 (the only opponent): Grizzly Bears (2/2), Serra Angel (4/4, flying, vigilance), Millstone, Seal of Fire. Seat 0 casts the card.

### 3. Correct result

**Highcliff Felidar.** Felidar enters; its trigger resolves. Seat 1's greatest power is 4, held only by Serra Angel, so Serra Angel is chosen and destroyed (seat 1 graveyard: Hill Giant, Serra Angel). Seat 1's Grizzly Bears stays. Seat 0's creatures are untouched.

**Benthic Anomaly.** The cast trigger resolves while Benthic Anomaly is still on the stack. Seat 0 chooses one creature seat 1 controls (AI choice). With one opponent, "total power/toughness of those creatures" is just that creature's. Seat 0 creates a token:
- if Serra Angel chosen: a token named Serra Angel, colorless, Creature — Eldrazi (no Angel type), 4/4, with flying and vigilance (Forge's result);
- if Grizzly Bears chosen: token named Grizzly Bears, colorless Creature — Eldrazi, 2/2.
The chosen creature stays with seat 1. Then Benthic Anomaly resolves and enters (7/8).

### 4. Why

1. "Choose" without "target" is a choice made on resolution (608.2d); nothing targets, so hexproof/protection don't matter. The instruction is mandatory: if the opponent controls a creature, one must be chosen (609.3 only excuses the impossible).
2. Highcliff Felidar: "greatest power among creatures that player controls" is evaluated when the ability resolves (608.2h). Destroy: 701.8a.
3. Benthic Anomaly: a "when you cast" trigger goes on the stack above the spell (603.3) and resolves first (ruling). The token's copiable values come from the chosen creature with the listed exceptions (707.9b); setting it to be "a colorless Eldrazi creature" replaces its creature types (205.1a; ruling above) and colors.

### 5. What phase did

- Highcliff Felidar: entered; no destruction (Serra Angel still on the battlefield). Forge destroyed Serra Angel.
- Benthic Anomaly: the spell resolved; no token was created. Forge created a 4/4 colorless Eldrazi copy of Serra Angel.

### 6. Variations to test

- Felidar when the opponent has two creatures tied for greatest power: the Felidar's controller chooses one of them; only that one is destroyed. Opponent with no creatures: nothing happens. Opponent's creature with indestructible: chosen but survives. Three players: one creature per opponent.
- Benthic Anomaly with two opponents controlling a 2/2 and a 4/4: token is a copy of one of them (caster's choice) with P/T 6/6. Benthic Anomaly countered in response to the trigger: the trigger still resolves (ruling). Chosen creature with an enters trigger: the token's copy of it triggers.
- Opponent with a hexproof creature: it can still be chosen.

### 7. Acceptance checks

- Highcliff Felidar's enter trigger destroys, for each opponent, one of that opponent's creatures with the greatest power, whenever that opponent controls a creature.
- Benthic Anomaly's cast trigger always creates a colorless Eldrazi token copy (P/T = sum over the chosen creatures) when an opponent controls a creature, before Benthic Anomaly itself resolves.
