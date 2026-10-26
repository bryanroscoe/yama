# Spec: "divided as you choose among any number of targets", followed by another targeted sentence

Root cause (observed behaviour): for a spell that deals damage "divided as you choose among any number of targets" and then has a second, separately targeted instruction, phase won't let the caster stop after fewer damage targets than a fixed count, and the second instruction's targets don't follow their own description. Declining another damage target is refused with "Missing required target", so the spell can't be cast with one or two damage targets. Forge (its AI) also failed to target, so there is no Forge result to compare; this spec is from the Oracle text, rulings and the CR.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-magma-opus`, `card-fiery-justice` (both `phase-error`).

## 1. Cards

Oracle text and rulings from Scryfall.

- **Magma Opus** ({6}{U}{R} instant): "Magma Opus deals 4 damage divided as you choose among any number of targets. Tap two target permanents. Create a 4/4 blue and red Elemental creature token. Draw two cards. / {U/R}{U/R}, Discard this card: Create a Treasure token."
  Rulings (2021-04-16): "You choose all targets for Magma Opus as you cast the spell. This includes up to four targets for the first effect and two target permanents for the second effect." "You also choose how the 4 damage will be divided among the first group of targets as you cast Magma Opus. You must have at least 1 damage dealt to each of those targets." "You must choose two different target permanents for the second effect. You may choose permanents that are already tapped." "The same permanent can be chosen as a target for each of the two instances of 'target.'" "If somehow all of Magma Opus's targets are illegal as it tries to resolve, none of its effects happen."
- **Fiery Justice** ({R}{G}{W} sorcery): "Fiery Justice deals 5 damage divided as you choose among any number of targets. Target opponent gains 5 life."
  Rulings (2017-03-14): "You choose how many targets Fiery Justice has and how the damage is divided as you cast it. Each target for its damage-dealing effect must receive at least 1 damage." "The target opponent for the life-gaining effect may also be a target for the damage-dealing effect." If every damage target becomes illegal but the opponent is still legal, that player still gains 5 life.

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main, empty stack) controls exactly the lands for the card (Magma Opus: Island, Mountain, 6 Wastes; Fiery Justice: Mountain, Forest, Plains) plus Grizzly Bears; hand: the card and a Wastes; library 8 Wastes. Seat 1 controls Grizzly Bears (2/2), Serra Angel (4/4 flier), Millstone (artifact), Seal of Fire (enchantment); no lands; life 20. Seat 0 casts the card for its mana cost. The referee runner picks the first damage target itself (an opponent's creature) and then declines to add more "any number" targets.

## 3. Correct result

Both spells are castable here. "Any number of targets" for a divided amount means the caster announces how many damage targets (at least one, since each must get at least 1 of the damage, and at most the damage amount), then the other targets, then the division (601.2c, 601.2d).

**Fiery Justice** with one damage target (the runner's pick, e.g. Serra Angel) and target opponent seat 1: 5 damage to Serra Angel (dies), seat 1 gains 5 life. Final: seat 1 at 25 life, Serra Angel in seat 1's graveyard, Fiery Justice in seat 0's graveyard.

**Magma Opus** with one damage target (e.g. Serra Angel, 4 damage) and two different target permanents to tap (any two permanents on the battlefield, e.g. seat 1's Millstone and Seal of Fire, or seat 1's Grizzly Bears and Millstone): Serra Angel dies, the two permanents become tapped, seat 0 creates a 4/4 blue and red Elemental token and draws two cards (two Wastes). Final: seat 0 hand 3 Wastes, library 6; Magma Opus in seat 0's graveyard.

## 4. Why

1. 601.2c: "If the spell has a variable number of targets, the player announces how many targets they will choose before they announce those targets." "Any number" lets the caster choose one damage target; nothing in the text fixes the count at the damage amount.
2. 601.2d: with a divided amount, each target must receive at least one, so the count is between 1 and the amount (4 for Magma Opus, 5 for Fiery Justice); the caster picks the count and the division.
3. 115.3: "target" appears twice in each spell; the same object or player may be chosen once per instance (rulings: a creature can be both damaged and tapped; the opponent can be both damaged and the life-gain target). Within one instance, each target must be different (Magma Opus's two tap targets).
4. 115.2 / 115.1a: "target permanents" means permanents only: an artifact or enchantment (Millstone, Seal of Fire) qualifies; a player doesn't.
5. 608.2b: the spell resolves if at least one of its targets is still legal; illegal targets just aren't affected.

## 5. What phase did

- In the sweep: after the runner chose the first damage target and declined a second ("any number" slot left empty), phase refused with "Missing required target", so neither spell could be cast.
- Probing with explicit target lists (the referee runner, hand-written scenarios):
  - Fiery Justice asked for exactly five targets: four "any target" slots and then the opponent. With [Serra Angel, seat 1's Grizzly Bears, seat 0's Grizzly Bears, seat 0, seat 1] it dealt 1, 1, 1 and 2 damage and seat 1 gained 5 life. With fewer damage targets the cast couldn't be finished.
  - Magma Opus asked for exactly four targets, every slot offering only creatures and players ("5 legal": three creatures and two players). Millstone was refused for the third and fourth slots, although those are the "tap two target permanents" slots. With [Serra Angel, seat 1's Grizzly Bears, seat 0's Grizzly Bears, seat 1] it dealt 2 damage each to the first two, tapped seat 0's Grizzly Bears, accepted seat 1 (a player) as a permanent to tap, made the Elemental and drew two.

## 6. Variations to test

- Fiery Justice with 1, 2, 3, 4 and 5 damage targets: every count is castable; each target gets at least 1; the sum is 5.
- Fiery Justice with the opponent as both a damage target and the life-gain target (ruling): legal; e.g. 5 damage to seat 1 and +5 life: seat 1 ends at 20.
- Magma Opus with one damage target and tap targets Millstone and Seal of Fire (noncreature permanents): legal; both become tapped.
- Magma Opus tapping a creature that's also a damage target (ruling): legal.
- Magma Opus choosing the same permanent twice for the two tap targets: not allowed (two different permanents).
- Magma Opus choosing a player for a tap target: not allowed.
- Magma Opus tapping lands: lands are permanents, so seat 0's own (already tapped) lands are legal tap targets (ruling: already-tapped permanents may be chosen).
- All damage targets become illegal before resolution but a tap target is still legal: no damage; the taps, token and draws still happen (608.2b). If every target is illegal, nothing happens (ruling).
- Other "divided as you choose among any number of targets" spells with no second target (e.g. Arc Lightning-style text) should also accept 1..N targets.

## 7. Acceptance checks

- On the sweep board, Fiery Justice can be cast with a single damage target and seat 1 as the opponent; Serra Angel dies and seat 1 ends at 25 life.
- On the sweep board, Magma Opus can be cast with a single damage target; the tap targets accept Millstone and Seal of Fire, refuse players, and require two different permanents; the Elemental is created and seat 0 draws two.
- Declining further "any number" targets never makes phase refuse the cast while the remaining required targets (the opponent, the two permanents) can still be chosen.
