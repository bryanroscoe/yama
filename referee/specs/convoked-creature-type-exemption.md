# Spec: Everything Comes to Dust spares creatures sharing a type with a convoking creature

Root cause (observed behaviour): phase convoked Everything Comes to Dust with a Grizzly Bears, then exiled every creature, including both Grizzly Bears. The exemption for creatures that share a creature type with a creature that convoked the spell is ignored. (Related: `shared-creature-type-counts.md`, a separate shared-type counting issue.)

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-everything-comes-to-dust`.

## 1. Card

- **Everything Comes to Dust** ({7}{W}{W}{W} sorcery): "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.) Exile all creatures except those that share a creature type with a creature that convoked this spell, all artifacts, and all enchantments."
  - Ruling 2024-01-12: "You can tap any untapped creature you control to convoke a spell, even one you haven't controlled continuously since the beginning of your most recent turn."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains ×3, Wastes ×7, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Everything Comes to Dust. How to pay is each engine's choice:
- phase tapped seat 0's Grizzly Bears for {1} (convoke) plus 3 Plains and 6 Wastes;
- Forge tapped all 10 lands (3 Plains, 7 Wastes): no convoke.

## 3. Correct result

**With phase's payment (Grizzly Bears convoked):**
- Grizzly Bears (a Bear) convoked. Creatures that share a creature type with it: seat 0's Grizzly Bears and seat 1's Grizzly Bears. **Both stay.**
- Exiled: Serra Angel (no Bear type), Millstone (artifact), Seal of Fire (enchantment).

**With no convoke (Forge's payment):** every creature, artifact and enchantment is exiled (Forge's result; correct).

## 4. Why

1. 702.51c: "A creature tapped to pay for mana in a spell's total cost this way is said to have 'convoked' that spell."
2. The card reads: exile (all creatures except those that share a creature type with a creature that convoked this spell), (all artifacts), and (all enchantments). Creature types: 205.3m. Sharing a type means having at least one creature type in common; the convoking creature shares a type with itself.
3. Which creatures convoked is fixed at casting; their creature types are checked on resolution, using last known information if a convoking creature has left the battlefield (608.2h).

## 5. What phase did

Exiled Serra Angel, Millstone, Seal of Fire and both Grizzly Bears, although seat 0's Grizzly Bears had been tapped for convoke.

## 6. Variations to test

- Convoke with a changeling creature: every creature with at least one creature type is spared (702.73a).
- Convoke with two creatures of different types (e.g. Bear and Angel): creatures sharing either type are spared.
- A convoking creature that leaves the battlefield before resolution: its types still count (last known information).
- Opponent's creature sharing a type with the convoking creature is spared too (no controller restriction).
- A creature-artifact (e.g. an artifact creature Bear): it's an artifact, so it's exiled by "all artifacts" regardless.
- No convoke: everything is exiled (negative control).

## 7. Acceptance checks

- When a Grizzly Bears convokes Everything Comes to Dust, every Bear on the battlefield survives and all other creatures, all artifacts and all enchantments are exiled.
- Without convoke, all creatures, artifacts and enchantments are exiled.
