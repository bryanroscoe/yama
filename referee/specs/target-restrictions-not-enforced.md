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

---

## Part C (LLM seat, run llm-4, 2026-11-05): a trigger's "another target player" hits creatures, and "creature that's blocking equipped creature" accepts any creature

Same root cause: the target description loses part of its text, so objects that don't fit it are offered and accepted. The Lord of Pain is the same phrase as Cruel Entertainment above ("another target player"), this time in a triggered ability. Plasma Caster loses a relative clause.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-goblin-storm-p0-g0), not the card sweep. Plasma Caster: game llm-3-science-p1-g2.

### C.1 Cards (Oracle text and rulings, Scryfall)

- **The Lord of Pain** ({3}{B}{R} legendary creature — Human Assassin 5/5, menace): "Your opponents can't gain life. / Whenever a player casts their first spell each turn, choose another target player. The Lord of Pain deals damage equal to that spell's mana value to the chosen player."
  - Ruling 2024-09-20: "The Lord of Pain's last ability must target a player other than the one who cast the spell that caused the ability to trigger. That means that if it's just you and one other player in the game, you'll have to target yourself when that player casts their first spell each turn."
  - Ruling 2024-09-20: "If a spell has {X} in its mana cost, use the value chosen for X when determining that spell's mana value."
- **Plasma Caster** ({1}{R} artifact — Equipment): "Equipped creature gets +1/+1. / Whenever equipped creature attacks, you get {E}{E} (two energy counters). / Pay {E}{E}: Choose target creature that's blocking equipped creature. Flip a coin. If you win the flip, exile the chosen creature. Otherwise, this Equipment deals 1 damage to it. / Equip {2}"
  - Ruling 2024-03-08: "If Plasma Caster is no longer on the battlefield or no longer attached to the same creature when its third ability resolves, the ability will still resolve as normal."
  - Ruling 2024-03-08: "If the target creature is no longer on the battlefield or no longer blocking the equipped creature when Plasma Caster's third ability tries to resolve, it won't resolve and none of its effects happen. You won't flip a coin."

### C.2 Board and actions

- **The Lord of Pain.** Three players at 20 life (commander format is fine at 40). Seat 0 controls The Lord of Pain. Seat 1 is active in its precombat main phase, controls Mountain ×4 and Grizzly Bears, and casts Hill Giant ({3}{R}, mana value 4) as its first spell of the turn. Seat 2 controls Serra Angel. Seat 0 chooses the trigger's target.
- **Plasma Caster.** Two players. Seat 0 controls Plasma Caster, unattached, and Grizzly Bears, and has 2 energy; seat 1 controls Hill Giant. Seat 0 asks for its legal actions in its precombat main phase. (A blocked-creature case needs combat, which the referee runner doesn't script yet; write it as a phase test.)

### C.3 Correct result

- **The Lord of Pain.** The legal targets are seat 0 and seat 2: players other than seat 1, the caster. No creature is a legal target. If seat 0 targets seat 2, seat 2 goes to 16 life; if it targets itself, seat 0 goes to 16. Grizzly Bears and Serra Angel are undamaged. In a two-player game where seat 1 casts the spell, seat 0 must target itself (ruling). When seat 0 casts its own first spell, the target must be seat 1 or seat 2.
- **Plasma Caster.** Plasma Caster is attached to nothing, so no creature is "blocking equipped creature". The ability has no legal target and can't be activated: it isn't in `legal_actions`, and seat 0 keeps its 2 energy. The same holds when Plasma Caster is attached to a creature that isn't blocked, and outside combat. When equipped Grizzly Bears attacks and is blocked by Hill Giant, Hill Giant is the only legal target.

### C.4 Why

1. 115.1a and 601.2c: each target must fit the whole description after "target". "Another target player" is a player; 115.2 allows only permanents to be targeted unless the text says otherwise, and here it says player.
2. "Another" here means other than the player who cast the spell (ruling), not "another object than the source".
3. 602.2b and 601.2c: an activated ability needs a legal choice for each required target; with none it can't be activated. 509.1 and 506.4: a creature becomes a blocking creature when blockers are declared in the declare blockers step, and stops being one if it is removed from combat.
4. 301.5a: the equipped creature is the creature the Equipment is attached to. An unattached Plasma Caster has no equipped creature, so no creature can be blocking it. (`equipped-creature-condition-when-unattached.md` covers a related gap for static conditions.)

### C.5 What phase did

- llm-3-goblin-storm-p0-g0, seat 0, turn 30 (reports 265 and 266). The Lord of Pain was controlled by seat 2 (log "Player 3", which cast it on turn 27). The log shows:
  - "T28 PreCombatMain: Player 4 casts Atarka, World Render", "Redcap Gutter-Dweller is targeted by The Lord of Pain", "The Lord of Pain deals 7 damage to Redcap Gutter-Dweller" (Redcap is the viewer's creature);
  - "T29 PreCombatMain: Player 1 casts Zada, Hedron Grinder", "Atarka, World Render is targeted by The Lord of Pain", "The Lord of Pain deals 4 damage to Atarka, World Render", "Atarka, World Render is destroyed";
  - "T30 PreCombatMain: Player 2 casts Tidus, Yuna's Guardian", "Redcap Gutter-Dweller is targeted by The Lord of Pain", "The Lord of Pain deals 3 damage to Redcap Gutter-Dweller".
  The damage equals each spell's mana value, so the trigger and amount are right; the target is a creature and no player took damage.
  Triage reading of the card data: `TargetOnly { target: Typed { type_filters: [], properties: [Another] } }`, then `DealDamage { target: SourceChosenPlayer }`. The noun "player" is lost.
- llm-3-science-p1-g2, seat 2, turns 27 and 29 (reports 332 and 337). Plasma Caster was unattached (seat 2's Rex, Cyber-Hound and Dr. Madison Li showed no "attached"), and nothing was blocking: on turn 27 the viewer was attacking in the declare attackers step, before blockers; on turn 29 it was another player's beginning of combat. `[1] Plasma Caster — Activate Ability (Ability Index: 0)` was offered both times. The seat didn't choose it, so the target list wasn't exercised. Triage reading of the card data: `PayEnergy 2 → TargetOnly { Typed [Creature], controller: null }`; the relative clause is lost.
- Code read at rev 19be58d4: both parses look like the "legacy, best-effort TargetOnly fallback" in `crates/engine/src/parser/oracle_effect/imperative.rs:5016-5028`. After `try_parse_two_targets` and `parse_effect` decline the "choose target ..." clause, it calls `parse_target_with_ctx(rest, ctx)` and discards the unparsed remainder (`let (target, _) = ...`), so whatever the target parser doesn't recognise ("player" after "another target", "that's blocking equipped creature") is silently dropped. The fallback should refuse (leave the clause unimplemented) when the remainder isn't empty, rather than keep a broader target.

### C.6 Variations to test

- The Lord of Pain's controller casts its own first spell: the target is any other player; in two-player, the opponent.
- A second spell by the same player in a turn: no trigger.
- An X spell: damage equals the spell's mana value with the chosen X (ruling).
- Plasma Caster equipped to a creature blocked by two creatures: either blocker is a legal target; no other creature is.
- Plasma Caster's target stops blocking (removed from combat) before resolution: the ability doesn't resolve and no coin is flipped (ruling).
- Other "choose another target player" and "choose target creature that's blocking/blocked by ..." texts that reach the same fallback.

### C.7 Acceptance checks

- The Lord of Pain's trigger never lists a creature or planeswalker as a target, and never lists the caster of the triggering spell.
- On the C.2 board, after seat 1 casts Hill Giant, the only life change is 4 damage to seat 0 or seat 2, and no creature has damage marked.
- With Plasma Caster unattached, or attached to an unblocked creature, its ability is not in `legal_actions`.
