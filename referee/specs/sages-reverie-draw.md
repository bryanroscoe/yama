# Spec: Sage's Reverie's enters trigger counts Auras you control on any creature

Scenario: `card-sage-s-reverie`. Observed: both engines attach Sage's Reverie to seat 1's Grizzly Bears and agree on its P/T (the static +1/+1 works in phase). Forge's seat 0 draws one card from the enters trigger; phase's seat 0 draws none, and no trigger appears in phase's log.

## 1. Card

- **Sage's Reverie** {3}{W}, Enchantment — Aura. "Enchant creature. When this Aura enters, draw a card for each Aura you control that's attached to a creature. Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature."

Rulings (2014-11-24):
- "Count the number of Auras you control attached to creatures as the enters-the-battlefield ability resolves to determine how many cards to draw. This will include Sage's Reverie as long as it's still on the battlefield at that time."
- "An Aura doesn't necessarily need the enchant creature ability for the abilities of Sage's Reverie to count it."

## 2. Board and actions

Sweep board. Seat 0 casts Sage's Reverie targeting seat 1's Grizzly Bears (scripted). It resolves, entering attached to that creature under seat 0's control.

## 3. Correct result

- The enters trigger triggers and resolves: Auras seat 0 controls that are attached to a creature = 1 (Sage's Reverie itself; the creature's controller doesn't matter). Seat 0 draws 1 card: hand two Wastes, library 7.
- Seat 1's Grizzly Bears is 3/3 (both engines agree).

## 4. Why

1. An Aura spell resolving becomes a permanent attached to its target (303.4); entering triggers its "When this Aura enters" ability (603.6a).
2. On resolution the count is made (608.2h): Sage's Reverie is controlled by seat 0 (the caster) and is attached to a creature. "You control" is about the Aura, not the creature.
3. So seat 0 draws one card (121.1).

## 5. What phase did

No draw; the enters trigger either didn't trigger or counted zero.

## 6. Variations to test

- Sage's Reverie on seat 0's own Grizzly Bears: still draws 1.
- Seat 0 already controls another Aura attached to an opponent's creature: draws 2, and the enchanted creature gets +2/+2.
- An Aura controlled by the opponent attached to seat 0's creature: not counted.
- Sage's Reverie leaves the battlefield before the trigger resolves: it isn't counted (ruling).
- An Aura with "enchant permanent" attached to a creature counts (ruling).

## 7. Acceptance checks

- Casting Sage's Reverie on an opponent's creature, with no other Auras, draws its controller exactly one card.
- The enters trigger appears and resolves every time Sage's Reverie enters.
