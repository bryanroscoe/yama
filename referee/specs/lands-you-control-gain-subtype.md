# Spec: "Lands you control ... are Deserts in addition to their other types"

Root cause (observed behaviour): Dune Chanter's static type-adding ability doesn't apply in phase; seat 0's lands stay without the Desert subtype.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-dune-chanter`.

## 1. Card

Oracle text from Scryfall (no rulings published).

- **Dune Chanter** ({2}{G} Creature — Plant Druid 2/3): "Reach. Lands you control and land cards you own that aren't on the battlefield are Deserts in addition to their other types. Lands you control have '{T}: Add one mana of any color.' {T}: Mill two cards. You gain 1 life for each land card milled this way."

## 2. Board and actions

Seat 0 (active, main phase 1): Forest + 2 Wastes, Grizzly Bears; hand Dune Chanter and a Wastes; library 8 Wastes. Seat 0 casts Dune Chanter (tapping all three lands); it resolves.

## 3. Correct result

While Dune Chanter is on the battlefield:

- Seat 0's Forest is **Land — Forest Desert** (still basic, still taps for {G}), each Wastes is **Land — Desert** (still basic).
- Every land seat 0 controls also has "{T}: Add one mana of any color."
- Land cards seat 0 owns outside the battlefield (the Wastes in hand and the 8 Wastes in its library) are Deserts too.
- Seat 1's permanents are unaffected (seat 1 controls no lands here anyway).

Forge reported Forest as [Desert, Forest, Land] and each Wastes as [Desert, Land].

## 4. Why

1. A static ability (604.1) generating a type-changing effect, applied in layer 4 (613.1d); the effect that grants the mana ability applies in layer 6 (613.1f).
2. "In addition to their other types" keeps all existing types (205.1b); Desert is a land type (205.3i), so the lands gain it alongside Forest.
3. 611.3a: a static ability's effect applies at every moment to whatever its text describes, so lands that enter later are also Deserts.
4. Adding a subtype doesn't remove the basic supertype or the land's own mana ability (305.6 only gives abilities from basic land types; Desert grants none).

## 5. What phase did

Forest stayed [Forest, Land]; both Wastes stayed [Land]. (Whether phase granted the any-color mana ability can't be seen in the final state.)

## 6. Variations to test

- **Desert counts see them:** with Dune Chanter out, anything that counts or checks "Deserts you control" counts every land seat 0 controls.
- **Cards in other zones:** a land card in hand, library and graveyard has the Desert subtype (e.g. "whenever a Desert card is put into your graveyard" — Yuma, Proud Protector's third ability — triggers when a Wastes is milled with Dune Chanter's {T} ability).
- **Opponent's lands:** a land seat 1 controls is not a Desert.
- **Mana ability:** a Wastes can produce {G}, {R}, etc. while Dune Chanter is on the battlefield.
- **Dune Chanter leaves:** all the added types and the granted ability go away.
- **Later type-setting effect on a nonbasic land:** if a later effect sets a nonbasic land's subtype (e.g. Blood Moon entering after Dune Chanter: "Nonbasic lands are Mountains"), apply layer-4 effects in timestamp order (613.7): Dune Chanter's Desert is added first, then Blood Moon replaces the land types with Mountain (205.1a). With Blood Moon earlier and Dune Chanter later, the land is a Mountain Desert.

## 7. Acceptance checks

- With Dune Chanter on the battlefield, every land its controller controls has the Desert subtype in addition to its other types and keeps its basic supertype.
- Land cards its controller owns in hand, library, graveyard and exile are Deserts.
- Lands other players control are unchanged.
