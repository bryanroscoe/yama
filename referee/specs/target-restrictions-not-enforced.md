# Spec: targets that don't fit the target description are accepted

Root cause (observed behaviour): phase accepts, and its target choice offers, objects or players that don't match the "target [something]" description: a battlefield creature for "card ... from your graveyard", a player for "exiled card", a creature for "another target player", and a creature whose mana value is too high for "with mana value less than or equal to the number of cards in its controller's graveyard". When nothing fits, phase casts the spell (or puts the trigger on the stack) with the wrong target instead of refusing the cast / removing the trigger. Forge rejected each of phase's target lists ("... is not a legal target").

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-rooting-moloch`, `card-runic-repetition`, `card-cruel-entertainment`, `card-drown-in-the-loch`.

## 1. Cards

Oracle text and rulings from Scryfall.

- **Rooting Moloch** ({4}{R} creature — Lizard 4/4): "When this creature enters, exile target card with a cycling ability from your graveyard. Until the end of your next turn, you may play that card. Cycling {2}."
- **Runic Repetition** ({2}{U} sorcery): "Return target exiled card with flashback you own to your hand." Rulings (2011-09-22): the card could have been exiled for any reason; a card given flashback by another effect loses it once it leaves the stack and can't be targeted (unless it has flashback itself); a face-down exiled card can't be targeted.
- **Cruel Entertainment** ({6}{B} sorcery): "Choose target player and another target player. The first player controls the second player during the second player's next turn, and the second player controls the first player during the first player's next turn." Ruling (2016-11-08): "Cruel Entertainment's controller may be one of its targets."
- **Drown in the Loch** ({U}{B} instant): "Choose one — • Counter target spell with mana value less than or equal to the number of cards in its controller's graveyard. • Destroy target creature with mana value less than or equal to the number of cards in its controller's graveyard."
- Board cards: Grizzly Bears (2/2, mana value 2), Serra Angel (4/4, mana value 5), Hill Giant (creature card, mana value 4), Divination (sorcery card, no cycling, no flashback), Lightning Bolt ({R} instant, mana value 1).

## 2. Board and actions

Standard sweep board: seat 0 (active, precombat main) controls the lands for the card plus Grizzly Bears; hand: the card and a Wastes; graveyard **Hill Giant, Divination**; library 8 Wastes; exile empty. Seat 1 controls Grizzly Bears, Serra Angel, Millstone, Seal of Fire; hand 2 Wastes; graveyard **Hill Giant**; library 8 Wastes; exile empty.

- `card-rooting-moloch`: seat 0 casts Rooting Moloch; it resolves; its enters trigger goes on the stack.
- `card-runic-repetition`, `card-cruel-entertainment`: seat 0 casts the sorcery.
- `card-drown-in-the-loch`: seat 1 (with an extra Mountain) first casts Lightning Bolt targeting seat 0's Grizzly Bears; with the Bolt on the stack, seat 0 casts Drown in the Loch. Phase chose the second mode targeting seat 1's Grizzly Bears.

## 3. Correct result

**Rooting Moloch.** The target must be a card with a cycling ability in seat 0's graveyard. Hill Giant and Divination have no cycling ability, so there is no legal target and the trigger is removed from the stack (603.3d). Nothing is exiled. Final: Rooting Moloch on the battlefield, graveyards unchanged. (Same board as phase's final state; the wrong part is the target.)

**Runic Repetition.** The target must be a card in exile with flashback that seat 0 owns. Exile is empty, so the spell has no legal target and can't be cast (601.2, 601.2c). Final: Runic Repetition still in seat 0's hand, lands untapped.

**Cruel Entertainment.** Both targets are players, and "another target player" must be a different player from the first (115.1a, 115.3). With two players the targets are seat 0 and seat 1 in some order (ruling: the caster may be one). On resolution the player-control effects are set up for each one's next turn (nothing visible on the final board this turn). A permanent (Grizzly Bears) is not a legal choice for either slot.

**Drown in the Loch.** Number of cards in each graveyard while Drown is cast: seat 0 has 2 (Hill Giant, Divination), seat 1 has 1 (Hill Giant; Lightning Bolt is on the stack, not in the graveyard).
- Destroy mode: legal targets are creatures whose mana value ≤ the card count of **their own controller's** graveyard. Seat 1's Grizzly Bears (2 > 1) and Serra Angel (5 > 1) are illegal; seat 0's Grizzly Bears (2 ≤ 2) is legal.
- Counter mode: Lightning Bolt (mana value 1 ≤ 1 card in seat 1's graveyard) is legal.
So the choice phase made (destroy seat 1's Grizzly Bears) must not be allowed. A legal play on this board is to counter the Bolt (both Bears survive; seat 1's graveyard then has Hill Giant and Lightning Bolt) or to destroy seat 0's own Bears.

## 4. Why

1. 115.1a / 115.1d / 601.2c: each target must be "an appropriate object or player" for the description after "target": its card type, zone ("from your graveyard", "exiled"), owner/controller and every other quality.
2. 115.2: only permanents can be targeted unless the text says it targets an object in another zone or a player. "Target card ... from your graveyard" targets a graveyard card, never a permanent; "target exiled card" targets a card in exile, never a player; "target player" targets only players.
3. 115.3: "another target player" means a second, different player.
4. "Its controller's graveyard" refers to the controller of the targeted spell or creature, so each candidate is measured against its own controller's graveyard.
5. 601.2: if a required target can't be chosen, the spell can't be cast. 603.3d: a triggered ability with no legal choice for a required target is removed from the stack.

## 5. What phase did

- Rooting Moloch: logged "Grizzly Bears is targeted by Rooting Moloch" (seat 1's Bears, on the battlefield); the trigger then resolved doing nothing.
- Runic Repetition: target written as seat 1 (a player); cast and resolved doing nothing.
- Cruel Entertainment: targets written as [seat 1, seat 1's Grizzly Bears]; the spell went to the graveyard without resolving.
- Drown in the Loch: destroyed seat 1's Grizzly Bears (mana value 2, while seat 1's graveyard had 1 card). Then the Bolt killed seat 0's Bears. Final: both Bears in their owners' graveyards.

## 6. Variations to test

- Rooting Moloch with a cycling card in seat 0's graveyard (e.g. another Rooting Moloch): it's exiled; seat 0 may cast it (paying its costs) until the end of its next turn; it can't be cycled from exile (ruling). A cycling card in seat 1's graveyard is not a legal target ("your graveyard").
- Runic Repetition with Think Twice (instant with flashback) exiled under seat 0's ownership: it returns to seat 0's hand. With a card given flashback by another effect, or a face-down exiled card: not targetable (rulings). A flashback card seat 1 owns: not targetable ("you own").
- Cruel Entertainment in a three-player game: any two different players, the caster included.
- Drown in the Loch counter mode: a spell with mana value 2 cast by a player with 1 card in their graveyard can't be targeted; with 2 or more it can. Destroy mode with seat 1's graveyard at 2 cards: seat 1's Grizzly Bears becomes a legal target.
- Drown in the Loch when the count changes before resolution (e.g. the graveyard is exiled in response): the target is checked again on resolution (608.2b) and the spell does nothing if it's now illegal.

## 7. Acceptance checks

- Rooting Moloch's trigger never targets a permanent; with no cycling card in its controller's graveyard it is removed and nothing happens.
- Runic Repetition can't be cast when its owner has no exiled card with flashback.
- Cruel Entertainment only accepts two different players as targets.
- On the sweep board, Drown in the Loch can't destroy seat 1's Grizzly Bears (1 card in seat 1's graveyard) but can counter the Lightning Bolt or destroy seat 0's Grizzly Bears.

---

## Part B (sweep v6, batch 6): more restrictions not enforced

Same root cause: a target that doesn't fit its description is accepted. Scenarios (standard sweep board): `card-soul-s-majesty` ("you control" ignored), `card-dimension-x-pizzasaur` (mana value limit ignored), `card-profane-transfusion` (one player chosen for both slots of "two target players"). All `forge-error`: Forge refused phase's target list.

### B.1 Cards (Oracle text and rulings, Scryfall)

- **Soul's Majesty** ({4}{G} sorcery): "Draw cards equal to the power of target creature you control." Ruling (2009-02-01): "Soul's Majesty's only target is the creature. If that creature becomes an illegal target by the time Soul's Majesty would resolve, the entire spell doesn't resolve."
- **Dimension X Pizzasaur** ({3}{B} Artifact Creature — Food Alien Mutant 2/1): "When this creature enters, put two +1/+1 counters on target creature. When you do, destroy up to one target creature with mana value less than or equal to the number of counters among permanents you control. {2}, {T}, Sacrifice this creature: You gain 3 life and each opponent loses 3 life." Ruling (2026-01-27): the second target is chosen when the reflexive ability triggers, after the counters are put on.
- **Profane Transfusion** ({6}{B}{B}{B} sorcery): "Two target players exchange life totals. You create an X/X colorless Horror artifact creature token, where X is the difference between those players' life totals." (The missing Horror token is a separate fault: `exchange-life-totals-difference-token.md`.)

### B.2 Correct result

- **Soul's Majesty**: the only legal target is seat 0's own Grizzly Bears (power 2); seat 0 draws two. Seat 1's Grizzly Bears and Serra Angel are not legal targets. (phase targeted seat 1's Bears, also power 2, so the board happens to match; with Serra Angel it drew four.)
- **Dimension X Pizzasaur**: phase's AI put the two +1/+1 counters on **seat 1's** Grizzly Bears (a legal, if odd, choice). Seat 0 then controls no permanent with a counter, so the number is 0, and no creature on the board has mana value 0 or less (Pizzasaur 4, Bears 2, Serra Angel 5). The reflexive trigger ("up to one") has no legal target, so nothing is destroyed. Final: seat 1's Grizzly Bears 4/4 with two +1/+1 counters, still on the battlefield.
  With the counters on seat 0's own Grizzly Bears instead, the number is 2 and seat 1's Grizzly Bears (mana value 2) is a legal target and may be destroyed; Serra Angel (5) is not.
- **Profane Transfusion**: "two target players" is one instance of "target", so the two players must be different (115.3): with two players, seat 0 and seat 1. Both have 20 life, so nothing changes; X = 0 and the 0/0 Horror token is put into the graveyard at once (704.5f). The final board equals phase's; the difference is the illegal target list.

### B.3 Why

1. 115.1a / 601.2c: each target must fit everything after "target", including "you control" and "with mana value less than or equal to ...".
2. 603.12 / ruling: the reflexive trigger's target is chosen when it triggers, so the count of counters among permanents seat 0 controls is taken then (after the first effect): 0 here. 603.3d: with no legal choice it's put on the stack with no target (it says "up to one") and does nothing.
3. 115.3: the same player can't be chosen twice for one instance of "target".

### B.4 What phase did

- Soul's Majesty: accepted seat 1's Grizzly Bears (sweep) and seat 1's Serra Angel (probe: drew four cards).
- Dimension X Pizzasaur: put the counters on seat 1's Bears, then the reflexive trigger targeted and destroyed that same Bears (mana value 2 with 0 counters on seat 0's permanents). Probe with the reflexive target scripted as Serra Angel (mana value 5) after the counters went on seat 1's Bears: Serra Angel was destroyed. With the counters on seat 0's own Bears and seat 1's Bears as the second target, the result was right.
- Profane Transfusion: logged "Player 2 is targeted" twice: seat 1 for both slots. (With [seat 0, seat 1] given explicitly and seat 0 at 10 life, the exchange itself was right: seat 0 20, seat 1 10.)

### B.5 Variations to test

- Soul's Majesty when seat 0 controls no creature: can't be cast. Target seat 0's creature, then it leaves before resolution: no cards drawn (ruling).
- Pizzasaur when an opponent controls a creature token with no mana cost (e.g. a 1/1 Spirit token, mana value 0): that token is a legal reflexive target even with 0 counters among seat 0's permanents. With three counters among seat 0's permanents (e.g. a planeswalker's loyalty counters count too): creatures of mana value up to 3.
- Pizzasaur's count includes counters of every kind on every permanent seat 0 controls (lore, loyalty, +1/+1 ...), but not counters on players or on opponents' permanents.
- Profane Transfusion in a three-player game: any two different players, the caster included.

### B.6 Acceptance checks

- Soul's Majesty only accepts a creature seat 0 controls.
- On the sweep board with the counters on seat 1's Bears, Pizzasaur's reflexive trigger destroys nothing; with the counters on seat 0's Bears it may destroy seat 1's Bears but never Serra Angel.
- Profane Transfusion never accepts the same player for both targets.
