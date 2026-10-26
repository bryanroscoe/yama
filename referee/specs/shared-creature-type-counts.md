# Spec: counting creatures that share a creature type

Root cause (observed behaviour): effects whose number is "creatures that share a creature type" come out too low in phase. Coat of Arms ignores matches among other players' creatures; Skemfar Shadowsage gets X = 0 where it should be 1.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-coat-of-arms`, `card-skemfar-shadowsage`.

## 1. Cards

Oracle text from Scryfall.

- **Coat of Arms** ({5} artifact): "Each creature gets +1/+1 for each other creature on the battlefield that shares at least one creature type with it. (For example, if two Goblin Warriors and a Goblin Shaman are on the battlefield, each gets +2/+2.)"
  - Ruling 2004-10-04: "If a creature has more than one creature type, and one of those types matches the creature you are calculating for, then count that creature. Only one type needs to match in order to get counted."
  - Ruling 2009-10-01: "Sharing multiple creature types doesn't give an additional bonus. Coat of Arms counts creatures, not creature types."
- **Skemfar Shadowsage** ({3}{B} Creature — Elf Cleric 2/5): "When this creature enters, choose one — • Each opponent loses X life, where X is the greatest number of creatures you control that have a creature type in common. • You gain X life, where X is the greatest number of creatures you control that have a creature type in common."
  - Ruling 2021-02-05: "The amount of life lost or gained is calculated as the triggered ability resolves based on the creatures you control at that time, including Skemfar Shadowsage itself if it's still under your control. You'll always use the greatest number possible. You don't need to choose any creature types."

## 2. Board and actions

Seat 0 (active, main phase 1) controls the lands for the card and a Grizzly Bears (Bear). Seat 1 controls Grizzly Bears (Bear), Serra Angel (Angel), Millstone, Seal of Fire.

- `card-coat-of-arms`: seat 0 casts Coat of Arms; it resolves.
- `card-skemfar-shadowsage`: seat 0 casts Skemfar Shadowsage; its enters trigger resolves (mode is the AI's choice).

## 3. Correct result

**Coat of Arms.** Creatures on the battlefield: seat 0 Grizzly Bears (Bear), seat 1 Grizzly Bears (Bear), seat 1 Serra Angel (Angel).
- Each Grizzly Bears shares Bear with the other Grizzly Bears: +1/+1, so both are **3/3**.
- Serra Angel shares no type with anyone: stays **4/4**.

**Skemfar Shadowsage.** When the trigger resolves, seat 0 controls Grizzly Bears (Bear) and Skemfar Shadowsage (Elf Cleric). No two share a type, but any single creature is a group of one that has its own types in common, so X = **1**.
- Drain mode: seat 1 goes 20 → **19**.
- Gain mode: seat 0 goes 20 → **21**.
Either way exactly one life total changes by 1.

## 4. Why

1. Coat of Arms says "each other creature on the battlefield", not "you control" (the battlefield is shared by all players, 400.1/110.1). Its ability is a static ability (604.1) whose effect applies in layer 7c (613.4c) and is recomputed continuously (611.3a). Controller doesn't matter, only the shared creature type (rulings above).
2. Skemfar's X is computed on resolution (608.2h). "The greatest number of creatures you control that have a creature type in common": with at least one creature that has a creature type, the greatest such group has at least one member. The ruling confirms Shadowsage itself counts and that the greatest possible number is used.

## 5. What phase did

- Coat of Arms: both Grizzly Bears stayed 2/2 (Forge: 3/3 each). phase appears to count only matches among one controller's creatures, or none at all.
- Skemfar Shadowsage: the trigger resolved and no life total changed (seat 0 20, seat 1 20). Forge: seat 1 lost 1 (drain mode, X = 1).

## 6. Variations to test

- **Coat of Arms, same controller.** Two Grizzly Bears both under seat 0 and Coat of Arms: each 3/3.
- **Coat of Arms, multiple types.** Goblin Warrior, Goblin Shaman, Elf Warrior: Goblin Warrior shares with both (+2/+2), Goblin Shaman shares with Goblin Warrior only (+1/+1), Elf Warrior shares with Goblin Warrior only (+1/+1). Matches the card's reminder example extended.
- **Coat of Arms, changeling.** A changeling creature shares a type with every creature that has any creature type, and every such creature counts it.
- **Coat of Arms, no creature type.** A creature with no creature types (e.g. a manifested 2/2) shares with nothing and gets nothing.
- **Skemfar, real group.** Seat 0 controls two Elves besides Shadowsage: X = 3 (Shadowsage is an Elf).
- **Skemfar, mixed types.** Ruling example: seat 0 controls Giant Wizard, Giant Warrior, Elf Warrior, Kor Warrior and Shadowsage (Elf Cleric). Warriors = 3, Elves = 2, Giants = 2, so X = 3.
- **Skemfar, Shadowsage gone.** If Shadowsage left the battlefield before resolution and seat 0 controls only Grizzly Bears, X = 1; with no creatures at all, X = 0.

## 7. Acceptance checks

- With Coat of Arms out, a Grizzly Bears is 3/3 whenever any other Bear is on the battlefield, whoever controls it.
- A creature sharing no type with any other creature gets no bonus.
- Skemfar Shadowsage entering next to one unrelated creature makes the opponent lose 1 life (drain) or its controller gain 1 life (gain); it never resolves for 0 while its controller controls a creature with a creature type.
