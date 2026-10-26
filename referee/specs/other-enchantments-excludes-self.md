# Spec: Ancestral Mask counts only *other* enchantments

Root cause (observed behaviour): phase counts Ancestral Mask itself among "each other enchantment on the battlefield", giving +2/+2 too much.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-ancestral-mask` (target: seat 1's Grizzly Bears).

## 1. Card

- **Ancestral Mask** ({2}{G} enchantment — Aura): "Enchant creature. Enchanted creature gets +2/+2 for each other enchantment on the battlefield."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Forest, Wastes ×2, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone (artifact), Seal of Fire (the only enchantment). Seat 0 casts Ancestral Mask enchanting seat 1's Grizzly Bears.

## 3. Correct result

Enchantments on the battlefield: Ancestral Mask and Seal of Fire. "Each other enchantment" excludes Ancestral Mask: count = 1. Seat 1's Grizzly Bears is **4/4** (2/2 + 2/2).

## 4. Why

"Other" excludes the object the ability is on (here, Ancestral Mask). The bonus is a static ability applying in layer 7c (613.4c), counted continuously (611.3a). Enchantments controlled by any player count ("on the battlefield").

## 5. What phase did

Seat 1's Grizzly Bears was 6/6 (+4/+4: two enchantments counted). Forge: 4/4.

## 6. Variations to test

- Mask alone (no other enchantments): +0/+0, creature stays 2/2.
- Two Ancestral Masks on the same creature with Seal of Fire out: each Mask counts the other Mask and Seal (2 each), creature gets +8/+8.
- An enchantment creature, an Aura on another creature, a Saga, a Role token: each counts as an enchantment.
- An enchantment leaving or entering changes the bonus immediately.
- Other cards with "for each other [type]" counts should exclude their own source the same way.

## 7. Acceptance checks

- With one other enchantment on the battlefield, the enchanted creature gets exactly +2/+2 from Ancestral Mask.
- Ancestral Mask never counts itself.
