# Spec: Valiant Changeling's cost reduction counts creature types among creatures you control

Root cause (observed behaviour): phase reduced Valiant Changeling's cost by 3 on a board where seat 0's creatures have only one creature type between them; the reduction should be 1.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-valiant-changeling`.

## 1. Card

- **Valiant Changeling** ({5}{W}{W} creature — Shapeshifter 3/3): "This spell costs {1} less to cast for each creature type among creatures you control. This effect can't reduce the amount of mana this spell costs by more than {5}. Changeling (This card is every creature type.) Double strike"

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains ×2, Wastes ×5, Grizzly Bears (Creature — Bear), the only creature seat 0 controls. Seat 1 controls Grizzly Bears and Serra Angel (not seat 0's). Seat 0 casts Valiant Changeling.

## 3. Correct result

Creature types among creatures seat 0 controls: Bear. One type, so the cost is {1} less: total cost **{4}{W}{W}** (six mana). Seat 0 taps both Plains and four Wastes; one Wastes stays untapped (Forge's result).

## 4. Why

1. 601.2f: the total cost is determined while casting, applying cost reductions. The count uses creatures seat 0 controls on the battlefield at that time.
2. Valiant Changeling itself is on the stack while being cast; it isn't a creature seat 0 controls on the battlefield, so its own changeling doesn't count.
3. Opponent's creatures (Bear, Angel) don't count ("you control").
4. "Each creature type among" counts distinct types (205.3m), not creatures: two Bears would still count 1.

## 5. What phase did

phase tapped two Plains and two Wastes (four mana): a reduction of 3.

## 6. Variations to test

- No creatures: full cost {5}{W}{W}.
- Two Grizzly Bears: still 1 type, reduction 1.
- Grizzly Bears + Serra Angel under seat 0: Bear, Angel → reduction 2.
- A changeling creature (e.g. another Valiant Changeling) on the battlefield: every creature type → reduction capped at 5, cost {W}{W}.
- A creature with two types (e.g. Elf Warrior): counts 2.
- Opponent's creatures never count.

## 7. Acceptance checks

- With only a Grizzly Bears under the caster's control, Valiant Changeling costs six mana.
- The reduction equals the number of distinct creature types among the caster's creatures, capped at 5.
