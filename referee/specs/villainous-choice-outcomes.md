# Spec: Villainous choice options performed wrongly (wrong library, or nothing at all)

Scenarios: `card-ensnared-by-the-mara`, `card-this-is-how-it-ends` (card sweep, batch 2).

In both cards an opponent faces a villainous choice. In phase, either the chosen option was also applied to the caster's library, or neither option happened. (Sycorax Commander and Hunted by The Family in the same batch handled their villainous choices correctly in phase, apart from the type-line problem in `creature-type-setting-keeps-old-types.md`.)

## 1. Cards

- **Ensnared by the Mara** {2}{R}{R}, Sorcery. "Each opponent faces a villainous choice — They exile cards from the top of their library until they exile a nonland card, then you may cast that card without paying its mana cost, or that player exiles the top four cards of their library and Ensnared by the Mara deals damage equal to the total mana value of those exiled cards to that player."
  - Ruling 2023-10-13: "The opponent chooses whether to exile cards from the top of their library until they exile a nonland card or to exile the top four cards of their library."
- **This Is How It Ends** {3}{B}, Instant. "Target creature's owner shuffles it into their library, then faces a villainous choice — They lose 5 life, or they shuffle another creature they own into their library."
- Rulings for both (2023-10-13): "When a player faces a villainous choice, they first choose one of the two options, then all actions in the chosen option are performed." "A player facing a villainous choice can always choose either option, even if one or both of the options are impossible."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

- `card-ensnared-by-the-mara`: lands Mountain, Mountain, Wastes, Wastes. Seat 0 casts Ensnared by the Mara (no targets); it resolves. Seat 1 is the only opponent.
- `card-this-is-how-it-ends`: lands Swamp + 3 Wastes. Seat 0 casts This Is How It Ends targeting **seat 1's Grizzly Bears**; it resolves.

## 3. Correct result

**Ensnared by the Mara.** Seat 1 picks an option (its AI's choice); either way only **seat 1's** library is touched:
- Option 1: seat 1 exiles cards from the top of its library until it exiles a nonland card. All 8 are Wastes, so all 8 are exiled and no nonland card is found; nothing is cast. Seat 1: library 0, exile 8 Wastes. (This is what Forge did.)
- Option 2: seat 1 exiles the top four cards of its library; their total mana value is 0, so 0 damage. Seat 1: library 4, exile 4 Wastes, life 20.
- In both cases seat 0's library stays at 8 and seat 0's exile stays empty.

**This Is How It Ends.** Seat 1's Grizzly Bears is shuffled into seat 1's library (9 cards). Then seat 1 picks an option and it is performed:
- "lose 5 life": seat 1 goes to 15. (Forge's choice.)
- "shuffle another creature they own into their library": seat 1's only other creature, Serra Angel, is shuffled into seat 1's library (10 cards); life stays 20.
- One of the two must happen. Ending with seat 1 at 20 life **and** Serra Angel still on the battlefield is not a legal result.

## 4. Why

1. 701.55a: "[A player] faces a villainous choice — [A], or [B]" means that player chooses A or B, "then all actions in the chosen option are performed."
2. 701.55b: a player may pick an impossible option and then does as much as possible. Here both options of both cards are possible.
3. Ensnared: every action in both options is done by and to "they"/"that player", the opponent facing the choice; "their library" is that opponent's library. Nothing in the text acts on the caster's library. With several opponents, each one goes through the whole process in turn (701.55d), each on their own library.
4. This Is How It Ends: "another creature they own" means a creature permanent (109.2) on the battlefield owned by the target's owner, other than the first one. Serra Angel qualifies. If seat 1 picks that option, Serra Angel is shuffled away; if it picks the life option, it loses 5 (119.3).

## 5. What phase did

- Ensnared by the Mara: four Wastes were exiled from **seat 1's** library and four more from **seat 0's** library (seat 0: library 4, exile 4 Wastes). Seat 1's life stayed 20.
- This Is How It Ends: Grizzly Bears was shuffled into seat 1's library, then nothing else happened: seat 1 stayed at 20 life and Serra Angel stayed on the battlefield. The log shows several further "shuffles their library" entries but no life loss and no creature moving.

## 6. Variations to test

- Ensnared with seat 1's library holding a nonland card in third position and seat 1 choosing option 1: two lands and the nonland card are exiled; seat 0 may cast the nonland card free.
- Ensnared, option 2, with nonland cards among the top four: damage equals their total mana value, dealt to seat 1.
- Ensnared in a three-player game: each opponent chooses and acts in turn order, each on their own library; the caster's library is never touched.
- This Is How It Ends when the target's owner owns no other creature: choosing the shuffle option does nothing (701.55b), choosing the life option still costs 5 life.
- This Is How It Ends targeting a creature seat 1 controls but seat 0 owns: it goes into seat 0's library and **seat 0** (the owner) faces the choice.

## 7. Acceptance checks

- After Ensnared by the Mara on this board, seat 0's library still has 8 cards and seat 0's exile is empty; seat 1 has either 0 cards in library and 8 Wastes in exile, or 4 and 4.
- After This Is How It Ends on this board, seat 1's Grizzly Bears is in its library, and either seat 1 is at 15 life with Serra Angel on the battlefield, or seat 1 is at 20 life with Serra Angel in its library (library 10).
