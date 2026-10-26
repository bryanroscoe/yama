# Spec: Wave of Reckoning makes each creature deal damage to itself

Scenario: `card-wave-of-reckoning`. Observed: Forge kills all three creatures (each deals damage equal to its power to itself). Phase resolves the spell with no damage; all creatures survive.

## 1. Card

- **Wave of Reckoning** {4}{W}, Sorcery. "Each creature deals damage to itself equal to its power."

## 2. Board and actions

Sweep board: seat 0 has Plains + 4 Wastes and Grizzly Bears (2/2). Seat 1 has Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire. Seat 0 casts Wave of Reckoning; it resolves.

## 3. Correct result

- Seat 0's Grizzly Bears deals 2 damage to itself; seat 1's Grizzly Bears 2 to itself; Serra Angel 4 to itself.
- All three have lethal damage and are destroyed: seat 0's graveyard gains Grizzly Bears (and Wave of Reckoning); seat 1's graveyard gains Grizzly Bears and Serra Angel.

## 4. Why

1. The effect makes each creature the source of damage to itself, in the amount of its power as the effect is applied (608.2c, 608.2h).
2. The damage is marked on each creature (120.3e). This is simultaneous for all creatures.
3. State-based actions then destroy each creature with damage at least its toughness (704.5g).
4. This is not a fight, so 701.14c ("twice its power") does not apply.

## 5. What phase did

Logged the spell resolving; no damage was marked and no creature died.

## 6. Variations to test

- A 0-power creature (e.g. 0/4): no damage, survives.
- A 1/3 creature: 1 damage, survives with 1 damage marked.
- A creature with power above toughness and indestructible: survives with damage.
- Lifelink creature: its controller gains life equal to the damage (the creature is the source, 120.3f).
- Deathtouch creature with power 1 and toughness 4: destroyed (damage from a deathtouch source).
- A prevention shield on one creature ("prevent the next 3 damage that would be dealt to it") prevents its self-damage; the source is the creature itself, not the white spell, so protection from white on a nonwhite creature doesn't help.
- Infect creature: deals damage as -1/-1 counters to itself.

## 7. Acceptance checks

- After Wave of Reckoning every creature has damage equal to its power marked, dealt by itself.
- Creatures whose power is at least their toughness die unless something prevents it.

## Added from triage batch 3: Showstopping Surprise (a chosen creature deals damage to each other creature)

Scenario: `card-showstopping-surprise` (standard sweep board). Same shape: the source of the damage is a creature named by the effect, not the spell; phase deals no damage.

**Showstopping Surprise** ({3}{R}{R} instant): "Choose target creature you control. Turn it face up if it's face down. Then it deals damage equal to its power to each other creature."
- Ruling: "If the target creature is a face-down creature that can't be turned face up for any reason, it will remain face down on the battlefield and still deal damage equal to its power (which is very likely to be 2) to each other creature."
- Board and action: seat 0 has 2 Mountains, 3 Wastes, Grizzly Bears; seat 1 has Grizzly Bears and Serra Angel. Seat 0 casts it targeting its own Grizzly Bears (face up already).
- Correct (608.2c, 608.2h last sentence: the object does it): seat 0's Bears deals 2 damage to each other creature: seat 1's Bears (dies) and Serra Angel (2 damage marked). Seat 0's Bears takes none. (Forge: exactly this.)
- Phase: the spell resolved with no damage at all.
- Variations: the target has lifelink → its controller gains life equal to the total damage dealt (it's the source); deathtouch target → every other creature it damages dies; a face-down target is turned face up first, and then uses its face-up power; the target leaves before resolution → the spell doesn't resolve (608.2b).
- Acceptance: the chosen creature is the source of the damage, and every other creature is dealt damage equal to its power.
