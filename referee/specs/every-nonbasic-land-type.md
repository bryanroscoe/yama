# Spec: Planar Nexus is every nonbasic land type

Scenario: `card-planar-nexus`. Observed: Forge's Planar Nexus has types [Cave, Desert, Gate, Lair, Land, Locus, Mine, Omenpath, Planet, Power-Plant, Sphere, Tower, Town, Urza's]; phase's has only [Land].

## 1. Card

- **Planar Nexus**, Land. "This land is every nonbasic land type. (Nonbasic land types include Cave, Desert, Gate, Lair, Locus, Mine, Power-Plant, Sphere, Tower, and Urza's.) {T}: Add {C}. {1}, {T}: Add one mana of any color."

Rulings (2024-06-07):
- "The list of nonbasic land types in the reminder text is exhaustive as of the release of Modern Horizons 3. The full list of land types can always be found in the Comprehensive Rules of Magic."
- "Since Planar Nexus has the subtypes Urza's, Mine, Power-Plant, and Tower, it will satisfy all of the requirements for the abilities of Urza's Mine, Urza's Power Plant, and Urza's Tower to add additional mana."

## 2. Board and actions

Sweep board; seat 0 plays Planar Nexus from hand as its land for the turn.

## 3. Correct result

Planar Nexus has card type Land and land types: Cave, Desert, Gate, Lair, Locus, Mine, Planet, Power-Plant, Sphere, Tower, Town, Urza's. It has none of Forest, Island, Mountain, Plains, Swamp. It is not "Omenpath" (Forge's extra entry is a Forge error: Omenpath isn't in the CR's land type list).

## 4. Why

1. 205.3i (CR effective 25 Sept 2026) lists the land types: Cave, Desert, Forest, Gate, Island, Lair, Locus, Mine, Mountain, Plains, Planet, Power-Plant, Sphere, Swamp, Tower, Town, Urza's. Forest, Island, Mountain, Plains and Swamp are the basic land types (305.6); the rest are nonbasic.
2. "This land is every nonbasic land type" is a characteristic-defining ability (604.3, 604.3a: it defines the object's own subtypes, is printed on it, and has no condition). It works in every zone (604.3) and is applied first within layer 4 (613.3).
3. So Planar Nexus has all twelve nonbasic land types, and no basic land type (so no intrinsic mana abilities beyond its printed ones).

## 5. What phase did

Planar Nexus had no land subtypes at all.

Note: Omo, Queen of Vesuva's "every land type" (scenario `card-omo-queen-of-vesuva`) gives phase the full CR list correctly; there Forge's extra "Omenpath" is the error.

## 6. Variations to test

- In the library or hand: a search for "a Gate card" or "a Desert card" can find Planar Nexus (CDA works in all zones).
- With Urza's Tower and Urza's Mine on the battlefield: the Tower adds {C}{C}{C} (Planar Nexus counts as Urza's Mine and Power-Plant).
- With a Desert-matters card (e.g. counting Deserts you control): Planar Nexus counts.
- Under Blood Moon: Planar Nexus is nonbasic, so it becomes only a Mountain (Blood Moon's later effect sets its subtype, 305.7); it loses its other land types and abilities.
- A copy of Planar Nexus (e.g. Copy Land copying it) also has every nonbasic land type.
- Planar Nexus is not a basic land and has no basic land type.

## 7. Acceptance checks

- On the battlefield, Planar Nexus's subtypes are exactly the twelve nonbasic land types of 205.3i.
- It has no basic land types.
- Effects that look for a specific nonbasic land type (Gate, Desert, Urza's, etc.) find it, in any zone.
