# Spec: an activated ability with "X can't be 0" is offered when only X = 0 is affordable

Root cause (observed behaviour): phase lists Lair of the Hydra's "{X}{G}" ability as a legal action when its controller has only one mana. The affordability check prices the ability with X = 0, so it reads {G} as payable; the "X can't be 0" minimum is applied only after the action has been chosen, where the engine cancels it ("Minimum legal X value 1 exceeds maximum payable X value 0"). The offer list therefore holds an action the engine will refuse.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-tricky-terrain-p0-g1), not the card sweep. Also seen in llm-3-tricky-terrain-p1-g1.

## 1. Card

- **Lair of the Hydra** (land): "If you control two or more other lands, this land enters tapped. / {T}: Add {G}. / {X}{G}: Until end of turn, this land becomes an X/X green Hydra creature. It's still a land. X can't be 0."
  - Ruling 2021-07-23: "If you turn Lair of the Hydra into a creature but haven't controlled it continuously since your most recent turn began, you won't be able to activate its mana ability or attack with it."

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls Lair of the Hydra (tapped) and one untapped Forest, and has no mana in its pool. Seat 0 asks for its legal actions.

Second board: the same with two untapped Forests.

## 3. Correct result

First board: the {X}{G} ability is not a legal action. Its smallest legal cost is {1}{G} (X = 1), which one Forest can't pay. `legal_actions` doesn't contain it; the only actions are passing priority and anything else the board allows.

Second board: the ability is legal. Activating it, seat 0 must choose X = 1 (the only affordable legal value), pays {1}{G} with both Forests, and Lair of the Hydra becomes a 1/1 green Hydra creature land until end of turn.

## 4. Why

1. 107.3 and 602.2b: the player announces X as part of activating the ability (601.2b), then determines and pays the total cost (601.2f-h). "X can't be 0" means 0 isn't a legal announcement, so the cheapest total cost is {1}{G}.
2. 118.3 and 601.2h: a player can't pay a cost without the resources to pay it fully; partial payments aren't allowed.
3. 602.2: an activation that can't be completed is not a legal action. If it is started anyway, 733.1 reverses it; it should not be offered in the first place.

## 5. What phase did

- llm-3-tricky-terrain-p0-g1, seat 1: on turns 14 to 16 the only untapped source was Arcane Signet ("up to 1 more mana available now"); on turns 27 and 28 it was one Treasure. Lair of the Hydra was tapped each time. `[1] Lair of the Hydra — Activate Ability (Ability Index: 1)` was offered at every priority (reports 0 to 7 and 11 to 15; report 12 is turn 28, upkeep, with only the Treasure untapped).
- llm-3-tricky-terrain-p1-g1, seat 1, turn 30 (report 45): the only mana was one {G} floating in the pool, with no untapped source; the ability was offered.
- The seat never chose it in those positions, so the engine's refusal was not exercised in this run. On turn 26 of p0-g1, with more mana, it chose it and the activation was accepted.
- Code read at rev 19be58d4:
  - `crates/engine/src/game/casting.rs:27938-27952`, in `activation_verdict`: `cost_not_payable` asks `can_pay_ability_cost_now` (`casting.rs:27010`) about the ability's cost as written, so the {X} part is priced at 0. `min_x_value` isn't consulted.
  - `crates/engine/src/game/casting_costs.rs:16777-16829`, in `enter_payment_step`: after the activation has started, `min > max` cancels the cast with "Minimum legal X value {min} exceeds maximum payable X value {max}". The same check exists for X in additional costs at `casting_costs.rs:10411-10416`.
  - `min_x_value` is parsed from the "X can't be 0" annotation (`parser/oracle.rs:13012`, `x_annotation_min_value`, stored at `oracle.rs:13106`).

## 6. Variations to test

- Lair of the Hydra untapped plus nothing else: Lair can tap itself for {G}, but the ability has no {T} in its cost, so Lair's own {G} and nothing else is still only 1 mana: not offered. Lair untapped plus one Forest: offered (X = 1 using both).
- One untapped source that makes two mana (Sol Ring): {C}{C} can't pay {G}, so not offered; Sol Ring plus a Forest: offered, X up to 2.
- A spell with "X can't be 0" in the same position (for example a spell with {X}{G} and the same annotation): not castable with one mana. Check `can_cast_object_now` applies the same minimum.
- An ability with {X} and no minimum (Blast Zone's "{X}{X}, {T}"): still offered when only X = 0 is affordable, since X = 0 is legal there.

## 7. Acceptance checks

- On the first board, `legal_actions` has no `ActivateAbility` for Lair of the Hydra's second ability; on the second board it has one.
- No position offers an X ability whose minimum X can't be paid, so the "Minimum legal X value ... exceeds maximum payable X value" refusal is never reached from an offered action.
