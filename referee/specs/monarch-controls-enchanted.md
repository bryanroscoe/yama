# Spec: Fealty to the Realm gives control of the enchanted creature to the monarch

Scenario: `card-fealty-to-the-realm`. Observed: both engines make seat 0 the monarch. Forge moves seat 1's Grizzly Bears to seat 0's control; phase leaves it under seat 1's control.

## 1. Card

- **Fealty to the Realm** {4}{U}, Enchantment — Aura. "Enchant creature. When this Aura enters, you become the monarch. The monarch controls enchanted creature. Enchanted creature attacks each combat if able and can't attack you."

Rulings (2023-06-16):
- "The timestamp of Fealty to the Realm's control-changing effect is the time at which it entered the battlefield and won't change when another player becomes the monarch."
- "In the case where Fealty to the Realm is enchanting a creature but there is no monarch, the second ability will create a control-changing effect with the timestamp mentioned above, but that effect won't do anything until a player becomes the monarch."

## 2. Board and actions

Sweep board. Seat 0 casts Fealty to the Realm targeting seat 1's Grizzly Bears (scripted). It enters attached; its enters trigger resolves and seat 0 becomes the monarch.

## 3. Correct result

- Seat 0 is the monarch.
- Seat 0 controls Grizzly Bears (owner seat 1), with Fealty to the Realm attached.
- (The monarch's end-step draw isn't reached in this run.)

## 4. Why

1. "The monarch controls enchanted creature" is a static ability (611.3) whose control-changing effect applies in layer 2 (613.1b).
2. Before the trigger resolves there is no monarch (725.1), so the effect does nothing (ruling). Once seat 0 becomes the monarch, the effect gives seat 0 control of the enchanted creature, continuously, as long as seat 0 is the monarch.

## 5. What phase did

Made seat 0 the monarch but didn't change control of the enchanted creature.

## 6. Variations to test

- Fealty on seat 0's own creature: seat 0 keeps it while monarch.
- Another player becomes the monarch later (e.g. combat damage to the monarch, 725.2): that player controls the enchanted creature from then on.
- A later control-changing effect (newer timestamp) on the creature: it wins over Fealty while it lasts.
- Fealty leaves the battlefield: the creature returns to its owner's control (or to whatever other effect applies).
- The enchanted creature must attack each combat if able and can't attack seat 0 (the Aura's controller).

## 7. Acceptance checks

- After Fealty to the Realm's trigger resolves, the creature it enchants is controlled by the monarch.
- Control follows the monarch designation as it changes.
