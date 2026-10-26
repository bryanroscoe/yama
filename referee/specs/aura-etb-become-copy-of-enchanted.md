# Spec: Infinite Reflection makes your creatures copies of the enchanted creature

Root cause (observed behaviour): when Infinite Reflection's enters trigger resolves, phase puts seat 0's other nontoken creature into the graveyard instead of making it a copy of the enchanted creature.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-infinite-reflection` (target: seat 1's Grizzly Bears).

## 1. Card

- **Infinite Reflection** ({5}{U} enchantment — Aura): "Enchant creature. When this Aura enters attached to a creature, each other nontoken creature you control becomes a copy of that creature. Nontoken creatures you control enter as a copy of enchanted creature."
  - Rulings 2012-05-01: "Infinite Reflection can enchant a creature controlled by another player." "Creatures you control don't copy whether the enchanted creature is tapped or untapped, whether it has any counters on it, whether it has any Auras and Equipment attached to it, or any noncopy effects that have changed its power, toughness, types, color, or so on." "If Infinite Reflection leaves the battlefield or becomes attached to a different creature, none of the copy effects end."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Island, Wastes ×5, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Infinite Reflection enchanting seat 1's Grizzly Bears; its trigger resolves.

## 3. Correct result

- Infinite Reflection is on the battlefield under seat 0's control, attached to seat 1's Grizzly Bears.
- "Each other nontoken creature you control" = seat 0's Grizzly Bears. It becomes a copy of seat 1's Grizzly Bears: still a 2/2 Grizzly Bears, still controlled by seat 0, **on the battlefield**.
- Nothing goes to any graveyard. Final board identical to before apart from Infinite Reflection and the tapped lands (Forge's result).

## 4. Why

1. 707.2: the copy takes the copiable values of the enchanted creature (layer 1, 613.1a). A creature that becomes a copy of a creature remains a creature on the battlefield; nothing about it should be put into a graveyard.
2. "That creature" is the creature the Aura entered attached to (ruling: even if it moves later). "Other" excludes nothing here (the Aura isn't a creature); "you control" refers to the Aura's controller (seat 0), not the enchanted creature's controller.
3. The copy effect has no duration, so it lasts indefinitely (611.2a).

## 5. What phase did

Log: "Infinite Reflection's effect resolves", then "Grizzly Bears moves from battlefield to graveyard". Seat 0's Grizzly Bears ended in seat 0's graveyard. Infinite Reflection stayed on the battlefield.

## 6. Variations to test

The current board can't show that the copy happened (Bears copying Bears). Use a distinguishable enchanted creature:
- Enchant seat 1's Serra Angel: seat 0's Grizzly Bears becomes Serra Angel (4/4, flying, vigilance, white, Angel), controlled by seat 0.
- Enchant a creature with +1/+1 counters or an Aura: copies don't get the counters/Aura (ruling).
- A token creature seat 0 controls is not affected.
- Later, seat 0 casts Hill Giant: it enters as a copy of the enchanted creature (its own enters triggers don't trigger; the enchanted creature's do, ruling).
- Infinite Reflection destroyed afterwards: copies stay copies.
- Enchanting seat 0's own creature: the other nontoken creatures become copies of it; the enchanted creature itself is unchanged.

## 7. Acceptance checks

- After Infinite Reflection's trigger, every other nontoken creature its controller controls is still on the battlefield and has the enchanted creature's name, types, P/T and abilities.
- No creature is put into a graveyard by the trigger.
