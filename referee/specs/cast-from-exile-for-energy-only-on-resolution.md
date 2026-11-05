# Spec: Amped Raptor's "you may cast that card" becomes a permanent, energy-blind permission

Root cause (observed behaviour): when Amped Raptor's enters trigger exiles a nonland card, phase doesn't let its controller cast the card while the trigger resolves. Instead it attaches a permission with no time limit, so the card can be cast from exile at normal timing on any later turn. The offer also ignores whether the player has enough energy; the engine only refuses the cast after the player chooses it ("Not enough energy").

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-creative-energy-p1-g1), not the card sweep. Also seen in llm-3-creative-energy-p1-g3 and llm-3-creative-energy-p0-g3.

## 1. Card

- **Amped Raptor** ({1}{R} creature — Dinosaur 2/1, first strike): "When this creature enters, you get {E}{E} (two energy counters). Then if you cast it from your hand, exile cards from the top of your library until you exile a nonland card. You may cast that card by paying an amount of {E} equal to its mana value rather than paying its mana cost."
  - Ruling 2024-06-07: "You choose whether or not to cast the exiled nonland card as Amped Raptor's triggered ability resolves. If you do, you do so as part of the resolution of that ability. You can't wait to cast it later in the turn. Timing restrictions based on the card's type are ignored."
  - Ruling 2024-06-07: "Any land cards exiled with Amped Raptor's triggered ability will remain in exile. If you choose not to cast the exiled nonland card (either because you don't have enough {E} or you just don't want to), that card will remain in exile as well."
  - Ruling 2024-06-07: "If you cast a spell for another cost 'rather than paying its mana cost,' you can't choose to cast it for any alternative costs. You can, however, pay additional costs, such as kicker costs. If the spell has any mandatory additional costs, those must be paid to cast it."
- Cards it exiled in the evidence: **Swords to Plowshares** ({W} instant, mana value 1: "Exile target creature. Its controller gains life equal to its power."), **Coveted Jewel** ({6} artifact, mana value 6) and **Blaster Hulk** ({6}{R}{R} artifact creature, mana value 8).

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack, 0 energy. Seat 0 controls Mountain ×2; its hand is Amped Raptor; its library, top first, is Mountain, Swords to Plowshares, Wastes ×6. Seat 1 controls Grizzly Bears. Seat 0 casts Amped Raptor from its hand; it resolves and its enters trigger resolves.

Second board: the same, but the library is Mountain, Coveted Jewel, Wastes ×6.

## 3. Correct result

First board. As the trigger resolves, seat 0 gets {E}{E} (2 energy), exiles Mountain, then Swords to Plowshares, and stops. Still during the resolution, seat 0 chooses whether to cast Swords to Plowshares by paying {E} (its mana value is 1):

- If it casts it, it pays 1 {E} (1 energy left), chooses a target (seat 1's Grizzly Bears, or Amped Raptor itself), and Swords becomes the topmost object on the stack while the trigger finishes resolving. No player gets priority between the cast and the end of the trigger's resolution (608.2g). Then Swords resolves normally.
- If it declines, Swords to Plowshares stays in exile for the rest of the game. It is never offered as a cast again, on this turn or any later one.

Mountain stays in exile either way.

Second board. Coveted Jewel's mana value is 6 and seat 0 has 2 {E}, so it can't pay. It isn't offered as a cast (not during resolution, not later). Coveted Jewel stays in exile and seat 0 keeps its 2 energy.

## 4. Why

1. 608.2g: if an effect allows a player to cast a spell during resolution, they do so then, following 601.2a-i, and no player receives priority after it's cast. No other spells can normally be cast during resolution. The ruling applies this to Amped Raptor: the choice is made as the trigger resolves, and "you can't wait to cast it later in the turn".
2. The ruling: timing restrictions based on card type are ignored for that cast (so Coveted Jewel, an artifact, could be cast during the trigger's resolution in any step if the energy were there).
3. 118.9 and 601.2f: "rather than paying its mana cost" makes the energy amount the spell's cost. 107.14 and 118.3: a player can't pay {E} they don't have, so with less energy than the card's mana value the cast can't be made and must not be offered.
4. 611.2a does not apply: no effect here grants a lasting permission, unlike "until end of turn, you may cast that card" cards.

## 5. What phase did

- llm-3-creative-energy-p1-g1, seat 1 (log "Player 2"): Amped Raptor's trigger on turn 6 exiled Mountain, Mystic Gate and Swords to Plowshares. No decision was offered during the resolution. From turn 6 through turn 17, `[1] Swords to Plowshares — Cast Spell (Card ID: 181 ...)` was offered at almost every priority (reports 155 to 209, 46 reports), with the object key "Object 181 = Swords to Plowshares (in exile (your))". On turn 17, in an opponent's end step, the seat cast it (log: "T17 End: Esika's Chariot is targeted by Swords to Plowshares", "Player 2 casts Swords to Plowshares"), and the engine accepted it. Its energy went from 2 to 1.
- llm-3-creative-energy-p1-g3, seat 3: Coveted Jewel (mana value 6) was offered from exile on turns 8, 12 and 16 with 2 or 3 energy (reports 226 to 231). On turn 16 the seat chose it and the engine refused it: "CastSpell { object_id: ObjectId(312) ... }: Action not allowed: Not enough energy" (`phase-haiku-guide.log`).
- llm-3-creative-energy-p0-g3, seat 3, turn 20: Blaster Hulk was offered the same way and refused with "Not enough energy" (`phase-haiku-guide.log`; no rules report, the refusal was logged by the lab).
- Code read at rev 19be58d4:
  - `crates/engine/src/parser/oracle_effect/mod.rs:12428-12438` turns the clause into `Effect::GrantCastingPermission { permission: CastingPermission::ExileWithEnergyCost, target: ParentTarget }`.
  - `crates/engine/src/types/ability.rs:5472-5474`: `ExileWithEnergyCost` is a unit variant, with no duration, no resolution scope and no cleanup. Compare `ExileWithAltCost`, which carries `resolution_cleanup` (`types/ability.rs:5231-5235`, used at `game/casting.rs:4734`, `14927`, `14959`, `17374`) for exactly the "cast it as this resolves" shape.
  - `crates/engine/src/game/casting.rs:3899-3901` accepts the permission whenever `obj.owner == player`, at any later time.
  - The energy is checked only when the cast is being paid (`game/casting_costs.rs:9443-9483` builds a `PayEnergy` cost; `casting_costs.rs:10893-10904` refuses "Not enough energy"), not when the cast is offered.

## 6. Variations to test

- Amped Raptor cast from the command zone, put onto the battlefield, or copied as a token: it wasn't cast from hand, so it gets {E}{E} and exiles nothing.
- The exiled card is an instant with a target and no legal target exists: it can't be cast; it stays in exile.
- The exiled card has a mandatory additional cost (for example Deadly Dispute's sacrifice): the cast needs that cost paid as well; with nothing to sacrifice it can't be cast (ruling).
- The exiled card has kicker: seat 0 may pay the kicker in mana on top of the energy (ruling).
- The exiled card has {X} in its mana cost: the energy owed is its mana value in exile, where X counts as 0 (202.3e).
- Seat 0 has exactly as much energy as the mana value: it may cast it and ends with 0.
- With two Amped Raptor triggers in one turn, each offers only its own exiled card, each only during its own resolution.

## 7. Acceptance checks

- After the trigger resolves and the cast is declined, the exiled card never appears in `legal_actions` again.
- During the resolution, the cast is offered only when the player has at least as much energy as the card's mana value; with less, no cast offer is made at all (so the engine never has to answer "Not enough energy" to an offered action).
- On the first board, casting Swords to Plowshares during the resolution leaves seat 0 with 1 energy and Swords on the stack before anyone gets priority.
