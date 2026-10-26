# Spec: a bestow card cast normally needs no target

Root cause (observed behaviour): phase refused to cast Noble Quarry for its mana cost, as a creature, with "No legal targets available". A bestow card cast without bestow is an ordinary creature spell and has no target.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-noble-quarry` (verdict `phase-error`).

## 1. Card

Oracle text and rulings from Scryfall.

- **Noble Quarry** ({2}{G} Enchantment Creature — Unicorn 1/1): "Bestow {5}{G} (If you cast this card for its bestow cost, it's an Aura spell with enchant creature. It becomes a creature again if it's not attached.) All creatures able to block this creature or enchanted creature do so. Enchanted creature gets +1/+1."
  - 2013-09-15: "On the stack, a spell with bestow is either a creature spell or an Aura spell. It's never both, although it's an enchantment spell in either case."

## 2. Board and actions

Seat 0 (active, main phase 1): Forest + 2 Wastes (exactly {2}{G}), Grizzly Bears; hand Noble Quarry and a Wastes. Seat 0 casts Noble Quarry for its mana cost (the runner declines alternative costs, so not bestowed). No targets are given.

## 3. Correct result

The cast is legal. Seat 0 taps Forest + 2 Wastes; Noble Quarry resolves and enters as a 1/1 enchantment creature under seat 0's control. (Forge: exactly this.)

## 4. Why

1. 702.103a: bestow is an alternative cost the player *may* choose; if not chosen, the card is cast as normal for its mana cost.
2. 702.103b: only a spell cast bestowed becomes an Aura spell with enchant creature, and only then must its controller choose a target (601.2c). A creature spell has no target.
3. 601.2c: "A spell may require some targets only if an alternative or additional cost ... was chosen for it; otherwise, the spell is cast as though it did not require those targets."
4. Even if bestow had been chosen, a legal target existed (either Grizzly Bears, Serra Angel), but seat 0 couldn't pay {5}{G} with three lands, so the bestow cast wasn't possible here anyway.

## 5. What phase did

`phase refused CastSpell { ... targets: [] ... }: Action not allowed: No legal targets available`. Noble Quarry stayed in hand.

## 6. Variations to test

- **Normal cast with no creatures on the battlefield at all:** still castable as a creature.
- **Bestow cast** with {5}{G} available and a creature to target: becomes an Aura attached to that creature (+1/+1 and the lure ability); if the target is gone on resolution, it resolves as a creature instead (702.103e).
- **Bestow unavailable without a target:** with {5}{G} but no creature on the battlefield, choosing bestow is not possible; the normal cast still is.
- **Other bestow cards** (e.g. Boon Satyr, Nighthowler): same rule.
- **Put onto the battlefield without casting:** it's an enchantment creature, never an Aura (ruling).

## 7. Acceptance checks

- A bestow card can be cast for its mana cost as a creature spell with no target, whatever is on the battlefield.
- Only when cast for its bestow cost does it ask for a creature target.
