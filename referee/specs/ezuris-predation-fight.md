# Spec: Ezuri's Predation's Beasts fight

Scenario: `card-ezuri-s-predation`. Observed: both engines create two 4/4 Phyrexian Beast tokens for seat 0. In Forge they fight seat 1's Grizzly Bears and Serra Angel (Bears and Angel die, one Beast dies, the other has 2 damage). In phase nothing fights: both Beasts are undamaged and seat 1 keeps both creatures.

## 1. Card

- **Ezuri's Predation** {5}{G}{G}{G}, Sorcery. "For each creature your opponents control, create a 4/4 green Phyrexian Beast creature token. Each of those tokens fights a different one of those creatures."

Rulings (2015-11-04):
- "You choose which Beast is fighting which creature an opponent controls."
- "Each of the "fights" happens at the same time."
- "Players can't cast spells or activate any abilities in between the Beasts entering the battlefield and fighting the other creatures."
- "If Ezuri's Predation creates more than one token for any given creature (due to an effect such as the one Doubling Season creates), the extra tokens won't fight any creature."

## 2. Board and actions

Sweep board: seat 0 has 3 Forests + 5 Wastes and Grizzly Bears. Seat 1 has Grizzly Bears (2/2), Serra Angel (4/4 flying, vigilance), Millstone, Seal of Fire. Seat 0 casts Ezuri's Predation; it resolves.

## 3. Correct result

- Two Beasts are created (seat 1 controls two creatures; seat 0's own Bears doesn't count).
- One Beast fights seat 1's Grizzly Bears, the other fights Serra Angel (pairing is seat 0's choice; with two Beasts of identical stats the outcome is the same).
- Simultaneously: Beast A deals 4 to Grizzly Bears and takes 2; Beast B deals 4 to Serra Angel and takes 4.
- State-based actions: Grizzly Bears, Serra Angel and Beast B are destroyed. Final: seat 0 has one Phyrexian Beast 4/4 with 2 damage, plus its own Grizzly Bears; seat 1's graveyard has Grizzly Bears, Serra Angel, Hill Giant.

## 4. Why

1. Instructions in order (608.2c): count the creatures opponents control when the effect is applied (608.2h): 2. Create that many Beasts (111.1).
2. Then each Beast fights a different one of those creatures: each deals damage equal to its power to the other (701.14a). Damage is marked (120.3e).
3. After the spell resolves, state-based actions destroy creatures with lethal damage (704.5g).

## 5. What phase did

Created both tokens but performed no fights.

## 6. Variations to test

- Opponent controls no creatures: no tokens, no fights.
- Opponent controls three creatures: three Beasts, three separate fights, none shared.
- Doubling Season (or similar) doubling the tokens: only one Beast per opponent creature fights; extras don't.
- An opponent creature with protection from green: the fight still happens but damage from the green Beast to it is prevented; the creature still deals its damage to the Beast.
- Two opponents (multiplayer): Beasts for every creature of every opponent.

## 7. Acceptance checks

- Every Beast created for an opponent's creature fights exactly that one creature, and no two Beasts fight the same creature.
- Damage is dealt both ways, all fights at once, and lethal damage destroys creatures right after the spell resolves.
