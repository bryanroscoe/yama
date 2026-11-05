# Spec: a spell whose required additional cost is a sacrifice is offered with nothing to sacrifice

Root cause (observed behaviour): phase offers Deadly Dispute as a legal cast when its caster controls no artifact and no creature. The castability gate for required additional costs checks life payments and unparsed costs, but not whether a required sacrifice has anything to sacrifice.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-hail-caesar-p0-g1), not the card sweep.

## 1. Card

- **Deadly Dispute** ({1}{B} instant): "As an additional cost to cast this spell, sacrifice an artifact or creature. / Draw two cards and create a Treasure token. (It's an artifact with "{T}, Sacrifice this token: Add one mana of any color.")"
  - No rulings.

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls Swamp ×2 and nothing else; its hand is Deadly Dispute; its library is 8 Wastes. Seat 1 controls Grizzly Bears and Millstone. Seat 0 asks for its legal actions, then tries to cast Deadly Dispute.

Second board: the same, and seat 0 also controls a Treasure token.

## 3. Correct result

First board: Deadly Dispute can't be cast. It isn't in `legal_actions`, and a submitted `CastSpell` for it is refused without moving the card or tapping lands. Seat 1's Grizzly Bears and Millstone are not acceptable sacrifices: they are seat 1's.

Second board: Deadly Dispute can be cast, and the only legal sacrifice is seat 0's Treasure. Seat 0 taps both Swamps for {1}{B}, sacrifices the Treasure as the additional cost, and on resolution draws two cards and creates a new Treasure. (The Treasure can't do both jobs: if seat 0 sacrificed it for mana during 601.2g, nothing would be left to pay the additional cost and the cast would be reversed, 733.1. An automatic payer must not spend it as mana here.)

## 4. Why

1. 601.2b and 601.2f-h: an additional cost is part of the total cost, and the total cost must be paid in full; "partial payments are not allowed. Unpayable costs can't be paid" (601.2h). 118.3: a player can't pay a cost without having the resources to pay it fully.
2. 701.21a: to sacrifice a permanent, its controller moves it from the battlefield to its owner's graveyard. A player can sacrifice only a permanent they control.
3. 733.1: a cast that can't be completed is reversed, so it isn't a legal action and shouldn't be offered.

## 5. What phase did

- llm-3-hail-caesar-p0-g1, seat 1, turn 10 (report 241), seat 1's draw step: the viewer controlled Smoldering Marsh and Nomad Outpost, with no artifact or creature. `[1] Deadly Dispute — Cast Spell (... Payment Mode: Type Auto)` was offered at four priorities that turn. The seat passed each time, so what the engine does after choosing it wasn't exercised.
- Later in the same game (turn 18), with permanents to sacrifice, the cast reached a "Pay Cost" step offering Sol Ring, Caesar, Legion's Emperor and Frog Lizard.
- Triage reading of the card data: `additional_cost: Required(Sacrifice { target: Or[Artifact, Creature], controller: null, count: 1 })`.
- Code read at rev 19be58d4: `crates/engine/src/game/casting.rs:21210-21233`, in `can_cast_object_now_with_probe`. For `AdditionalCost::Required` it refuses an unpayable `PayLife` (`find_pay_life_cost`) and an `Unimplemented` cost, and nothing else. A required `Sacrifice` reaches the offer list unchecked. `game/cost_payability.rs` (module comment, lines 1-20) says it is the gate for "Paying a `Required` additional cost (if unpayable, the spell cannot be cast)", so the fix likely belongs in calling that predicate here.

## 6. Variations to test

- Seat 0 controls only a creature (Grizzly Bears): castable; the Bears is the sacrifice.
- Seat 0 controls only a land: not castable (a land isn't an artifact or creature). An artifact land: castable.
- The only creature seat 0 controls is phased out: not castable (a phased-out permanent is treated as though it doesn't exist, 702.26b).
- Other required sacrifices with the same gap: Village Rites ("sacrifice a creature"), Bone Splinters, Fling. Each must be refused with nothing of the stated kind.
- With the `controller: null` filter, the payment step must list only permanents the caster controls; it must never offer an opponent's artifact or creature.
- A required additional cost that is a different object choice (discard a card with an empty hand, exile a card from your graveyard with an empty graveyard): same rule, not castable.

## 7. Acceptance checks

- On the first board, `legal_actions` has no `CastSpell` for Deadly Dispute and a submitted cast is refused with no state change.
- On the second board, Deadly Dispute is castable, the sacrifice choice lists only the Treasure, and after resolution seat 0 has drawn two cards and controls one (new) Treasure.
