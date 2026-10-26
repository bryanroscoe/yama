# Spec: "Counter target spell. Create X ..., where X is that spell's mana value"

Root cause (observed behaviour): after countering the target spell, phase takes X as 0 and creates no tokens. X should be the countered spell's mana value, from its last known information (the spell has just left the stack).

Scenarios (card sweep, standard sweep board with the counterspell rule; see `referee/README.md` and `referee/sweep.py`): `card-spell-swindle`, `card-access-denied` (both `differ`).

## 1. Cards

Oracle text and rulings from Scryfall.

- **Spell Swindle** ({3}{U}{U} instant): "Counter target spell. Create X Treasure tokens, where X is that spell's mana value. (They're artifacts with '{T}, Sacrifice this token: Add one mana of any color.')" Rulings (2017-09-29): "For spells with {X} in their mana costs, use the value chosen for X to determine the spell's mana value." "You may target a spell that can't be countered. When Spell Swindle resolves, the target spell will be unaffected, but you'll still get Treasures."
- **Access Denied** ({3}{U}{U} instant): "Counter target spell. Create X 1/1 colorless Thopter artifact creature tokens with flying, where X is that spell's mana value."
- **Lightning Bolt** ({R} instant, mana value 1): "Lightning Bolt deals 3 damage to any target."

## 2. Board and actions

Standard sweep board plus the counterspell rule: seat 1 also controls a Mountain and has Lightning Bolt in hand. Seat 1 casts Lightning Bolt targeting seat 0's Grizzly Bears. With the Bolt on the stack, seat 0 (Island, Island, 3 Wastes) casts the counterspell targeting the Bolt. Both resolve in turn.

## 3. Correct result

The counterspell counters Lightning Bolt (it goes to seat 1's graveyard; seat 0's Grizzly Bears survives), then creates X = 1 token:

- Spell Swindle: one Treasure token under seat 0's control (untapped).
- Access Denied: one 1/1 colorless Thopter artifact creature token with flying under seat 0's control.

Forge's final state matches this (Treasure / Thopter present); phase's has no token.

## 4. Why

1. 608.2h: "If the effect requires information from a specific object ... the effect uses the current information of that object if it's in the public zone it was expected to be in; if it's no longer in that zone ... the effect uses the object's last known information." "That spell" was on the stack; after "Counter target spell" it's in the graveyard, so its mana value comes from its last known information as a spell on the stack: 1 for Lightning Bolt.
2. 202.3: mana value is the total mana in the mana cost ({R} = 1). For a spell with {X}, the value of X chosen while casting counts (ruling).
3. The Spell Swindle ruling shows X doesn't depend on the counter succeeding: even an uncounterable target still gives Treasures equal to its mana value.
4. 111.1 / 111.10a: Treasure tokens are created as described; the Thopter's characteristics are given by the text.

## 5. What phase did

Logged "Spell Swindle counters Lightning Bolt" / "Access Denied counters Lightning Bolt", Lightning Bolt to the graveyard, then "effect resolves" with no token created. Final: no Treasure / no Thopter.

## 6. Variations to test

- Counter a spell with a larger mana value (e.g. Serra Angel as a creature spell, mana value 5): five Treasures / five Thopters.
- Counter a spell with {X} in its cost cast with X = 3 (e.g. an {X}{R} spell): mana value 4, four tokens.
- Target a spell that can't be countered (ruling): the spell stays on the stack and still resolves; tokens equal to its mana value are still created.
- The target spell leaves the stack before the counterspell resolves (e.g. it's countered by something else): the counterspell's only target is illegal, so it doesn't resolve and makes no tokens (608.2b).
- A copy of a spell (mana value copied from the original, 707.10) as the target: tokens equal to that mana value.

## 7. Acceptance checks

- On the sweep board, Spell Swindle ends with Lightning Bolt in seat 1's graveyard and exactly one Treasure under seat 0's control.
- On the sweep board, Access Denied ends with Lightning Bolt in seat 1's graveyard and exactly one 1/1 flying Thopter under seat 0's control.
- X equals the countered spell's mana value as it last existed on the stack, never 0 just because the spell has been countered.
