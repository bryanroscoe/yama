# Spec: gaining control of a set of creatures (chosen, "all creatures", or swapped) changes nothing

Root cause (observed behaviour): effects that give a player control of a set of creatures (creatures chosen during resolution, all creatures, or all creatures another player controls) change no controller in phase. The rest of the same spell (untapping, +1/+1 counters) happens. A single *targeted* control change (Act of Aggression, same sweep) works.

Merged from two specs written in parallel: `gain-control-of-chosen-or-all-creatures.md` (Part A) and `reins-of-power-control-swap.md` (Part B).

Cards: Insurrection, Order of Succession, Elrond of the White Council (Part A); Reins of Power (Part B).

Related: `monarch-controls-enchanted.md` (Fealty to the Realm: the monarch never gains control of the enchanted creature), `choices-on-resolution-not-acted-on.md` (other choices made on resolution that are never acted on).

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: gaining control of creatures that are chosen (not targeted) or "all creatures"

(Formerly `gain-control-of-chosen-or-all-creatures.md`.)

Root cause (observed behaviour): effects that give a player control of a set of creatures chosen during resolution, or of all creatures, change no controller in phase. The rest of the same spell (untapping, +1/+1 counters) happens. A single *targeted* control change (Act of Aggression, same sweep) works.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-insurrection`, `card-order-of-succession`, `card-elrond-of-the-white-council`.

### 1. Cards

Oracle text from Scryfall.

- **Insurrection** ({5}{R}{R}{R} sorcery): "Untap all creatures and gain control of them until end of turn. They gain haste until end of turn."
  - Ruling 2004-10-04: "You untap all creatures, control all creatures, and give all creatures haste."
- **Order of Succession** ({3}{U} sorcery): "Choose left or right. Starting with you and proceeding in the chosen direction, each player chooses a creature controlled by the next player in that direction. Each player gains control of the creature they chose."
  - Rulings 2013-10-17: "Order of Succession doesn't target any players or creatures." "All players will gain control of the creatures they chose simultaneously." "If the next player in the chosen direction controls no creatures, you won't gain control of anything."
- **Elrond of the White Council** ({3}{G}{U} legendary creature 3/3): "Secret council — When Elrond enters, each player secretly votes for fellowship or aid, then those votes are revealed. For each fellowship vote, the voter chooses a creature they control. You gain control of each creature chosen this way, and they gain "This creature can't attack its owner." Then for each aid vote, put a +1/+1 counter on each creature you control."
  - Ruling 2023-06-16: "After the votes are revealed, starting with the player whose turn it is and proceeding in turn order, each player who voted fellowship chooses a creature they control for each of their fellowship votes. Then the controller of Elrond of the White Council's ability gains control of those creatures and they gain the listed ability. Finally, that player puts a +1/+1 counter on each creature they control for each aid vote."

### 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts the card.

### 3. Correct result

**Insurrection.** Seat 0 controls all three creatures until end of turn: its own Grizzly Bears plus seat 1's Grizzly Bears and Serra Angel (owner still seat 1), all untapped, all with haste. Seat 1 controls only Millstone and Seal of Fire.

**Order of Succession.** Two players, so left and right give the same result. Seat 0 chooses a creature seat 1 controls (Grizzly Bears or Serra Angel); seat 1 chooses a creature seat 0 controls (seat 0's Grizzly Bears, the only one). Simultaneously each gains control of the chosen creature, permanently. Forge: seat 0 took Serra Angel, seat 1 took seat 0's Grizzly Bears.

**Elrond.** In this run phase itself recorded votes seat 0 = aid, seat 1 = fellowship (Forge: the same). With those votes:
1. Seat 1 (fellowship voter) chooses a creature seat 1 controls: Grizzly Bears or Serra Angel.
2. Seat 0 gains control of it (permanently); it gains "This creature can't attack its owner."
3. One aid vote: seat 0 puts a +1/+1 counter on each creature seat 0 controls, which now includes the gained creature: Elrond, seat 0's Grizzly Bears, and the gained creature.
Forge: seat 1 chose Serra Angel; seat 0 controls Serra Angel 5/5 with a +1/+1 counter.

### 4. Why

1. A resolving spell's control-changing effect creates a continuous effect in layer 2 (613.1b) whose affected set is fixed when it begins (611.2c). "Gain control of them" / "gains control of the creature they chose" / "You gain control of each creature chosen this way" are mandatory instructions (608.2c).
2. None of these targets (Order of Succession ruling; Elrond's creatures are chosen; Insurrection says "all"), so targeting rules don't apply; choices are made on resolution (608.2d).
3. Insurrection's duration is "until end of turn" (611.2a); Order of Succession's and Elrond's have no stated duration and last indefinitely.
4. Elrond: the ruling fixes the order: control first, then counters, so the gained creature gets the aid counter.

### 5. What phase did

- Insurrection: seat 1 still controlled Grizzly Bears and Serra Angel.
- Order of Succession: no creature changed controller.
- Elrond: votes recorded (fellowship 1, aid 1), counters put on seat 0's Grizzly Bears and Elrond, but seat 1 chose no creature and no control changed; Serra Angel stayed with seat 1 without a counter.

### 6. Variations to test

- Insurrection: tapped creatures untap; at cleanup, control returns to each owner/previous controller; summoning-sick creatures can attack this turn (haste).
- Order of Succession when the next player controls no creatures: the chooser gains nothing, others still exchange. Three players, left vs right give different results.
- Elrond with both players voting fellowship: each chooses one of their own creatures and seat 0 gains control of both (choosing its own creature changes nothing). Both voting aid: two +1/+1 counters on each creature seat 0 controls, no control change. Gained creature can't attack its owner afterwards.
- Elrond's gained creatures stay under seat 0's control after Elrond leaves the battlefield.

### 7. Acceptance checks

- After Insurrection resolves, the caster controls every creature on the battlefield, untapped and with haste, until the turn ends.
- After Order of Succession in a two-player game where both players control a creature, each player controls one creature the other used to control.
- After Elrond's trigger with any fellowship vote from a player who controls a creature, Elrond's controller controls the creature that player chose, and it receives the aid counters that follow.

## Part B: Reins of Power swaps control of creatures until end of turn

(Formerly `reins-of-power-control-swap.md`.)

Scenario: `card-reins-of-power`. Observed: Forge ends with seat 0 controlling seat 1's Grizzly Bears and Serra Angel and seat 1 controlling seat 0's Grizzly Bears. Phase changes no control.

### 1. Card

- **Reins of Power** {2}{U}{U}, Instant. "Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other controls until end of turn. Those creatures gain haste until end of turn."

Rulings:
- 2007-05-01: "You only untap creatures controlled by you and the targeted opponent, not all creatures."
- 2004-10-04: "It is perfectly legal for either or both players to have zero creatures. They give control of all their zero creatures as instructed."

### 2. Board and actions

Sweep board: seat 0 has 2 Islands + 2 Wastes and Grizzly Bears. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Reins of Power targeting seat 1 (scripted); it resolves in seat 0's main phase.

### 3. Correct result (until end of turn)

- Seat 0 controls: its lands, seat 1's Grizzly Bears (owner seat 1) and Serra Angel (owner seat 1).
- Seat 1 controls: seat 0's Grizzly Bears (owner seat 0), Millstone, Seal of Fire.
- All three creatures are untapped and have haste.
- At cleanup (514.2) the effects end and each creature returns to its owner's control.

### 4. Why

1. Instructions in order (608.2c). Untap first: every creature seat 0 or seat 1 controls.
2. "Gain control of all creatures the other controls": the sets are fixed when the effect begins (611.2c): seat 1's two creatures go to seat 0, seat 0's one creature goes to seat 1. Both happen as part of the same effect, so the second swap doesn't move back creatures just gained.
3. Control-changing effects apply in layer 2 (613.1b). Haste is granted in layer 6 (613.1f) to "those creatures" (the three swapped creatures).
4. Haste lets the gained creatures attack this turn (702.10b, 302.6).

### 5. What phase did

Resolved the spell without changing any controller.

### 6. Variations to test

- Tapped creatures on both sides: all untapped, then swapped.
- Seat 0 has no creatures: seat 0 gains seat 1's creatures, seat 1 gains nothing.
- A creature entering after Reins resolves is not swapped (set fixed at 611.2c).
- At the cleanup step control returns to the owners and haste ends.
- Seat 0 can attack with the gained Grizzly Bears and Serra Angel this turn (haste).
- Lands and noncreature permanents never change control.

### 7. Acceptance checks

- After Reins of Power resolves, each player controls exactly the creatures the other player controlled just before, untapped and with haste.
- Control reverts at end of turn.
