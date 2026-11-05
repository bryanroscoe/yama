# Spec: squad keeps offering payments the caster can't afford, then refuses "stop paying"

Root cause (observed behaviour): while a squad spell is being cast, phase offers "pay the squad cost again" at every repeat, whether or not the total cost is still affordable. After the caster has committed to more than it can pay, declining further payments (`DecideOptionalCost { pay: false }`) is refused with "Cannot pay mana cost", and the cast is left waiting on the same choice. Only `CancelCast` gets out. The heuristic AI chose `pay: false`, so two games ended in an engine error.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-hail-caesar-p1-g3), not the card sweep. Also llm-3-hail-caesar-p0-g3. Both games ended "error" in `phase-haiku-guide-results.jsonl`.

## 1. Cards

- **Powder Ganger** ({2}{R} creature — Human Rogue 2/2): "Squad {2} (As an additional cost to cast this spell, you may pay {2} any number of times. When this creature enters, create that many tokens that are copies of it.) / When this creature enters, destroy up to one target artifact."
  - Ruling 2024-03-08: "You may pay the squad cost any number of times. You will create a token that is a copy of that permanent for each time you paid the squad cost. If you paid the squad cost multiple times, the tokens will all enter the battlefield simultaneously."
  - Ruling 2024-03-08: "If the spell is countered, the squad ability will not trigger, and no tokens will be created."
- **Securitron Squadron** ({1}{W} artifact creature — Robot 2/2, vigilance): "Squad {3} ... / Whenever a creature token you control enters, put a +1/+1 counter on it."
  - Ruling 2024-03-08: "For example, if you pay Securitron Squadron's squad cost three times, then you'll create three token copies ... each of the three token copies of Securitron Squadron will have four +1/+1 counters on it."

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls Mountain ×5 and nothing else; its hand is Powder Ganger. Seat 1 controls Sol Ring. Seat 0 casts Powder Ganger and answers the squad prompts.

Second board: the same with Mountain ×3.

## 3. Correct result

First board (5 mana). The base cost is {2}{R}. One squad payment makes the total {4}{R}, which five Mountains can pay; a second would make it {6}{R}, which they can't.

- The first squad prompt offers both "pay" and "don't pay".
- After one payment, the next prompt offers only "don't pay" (and cancel); paying again isn't offered.
- Declining finishes the announcement; seat 0 taps all five Mountains, Powder Ganger resolves, its squad trigger creates one token copy, and both enters triggers ("destroy up to one target artifact") go on the stack. Sol Ring is the only artifact, so the first to resolve can destroy it and the other then destroys nothing (each says "up to one", so it may also be put on the stack with no target).

Second board (3 mana). The base cost alone uses all three Mountains, so the squad prompt offers only "don't pay" (or skips the prompt). Declining always succeeds: Powder Ganger is cast for {2}{R}, no tokens.

Whatever the offer list contains, `DecideOptionalCost { pay: false }` must never be refused with "Cannot pay mana cost". If an earlier payment did leave the total unaffordable (for example a mana source was lost in between), declining must lead to the whole cast being reversed (733.1): the card back in hand, nothing tapped or paid, priority back to seat 0. It must not leave the game waiting on a prompt whose only working answer is cancel.

## 4. Why

1. 702.157a: squad means "As an additional cost to cast this spell, you may pay [cost] any number of times"; paying it follows 601.2b and 601.2f-h.
2. 601.2b: the number of squad payments is announced while casting. 601.2f: the total cost is the mana cost plus those additional costs. 601.2h: the total is paid in full; partial payments aren't allowed and unpayable costs can't be paid. 118.3: a player can't pay a cost without the resources.
3. 733.1: if a player starts an action and can't legally complete it, the whole action is reversed and any payments are cancelled; a cast spell returns to the zone it came from.
4. So offering a squad payment that makes the total unaffordable offers an action that can only end in reversal, and refusing to let the caster stop paying is never correct.

## 5. What phase did

- llm-3-hail-caesar-p1-g3, seat 3, turn 12: with three untapped mana sources, the seat cast Powder Ganger and chose "Decide Optional Cost (Pay: true)" twice (total {6}{R}). It then chose "Pay: false"; the engine refused it ("Action not allowed: Cannot pay mana cost", waiting for OptionalCostChoice). The lab fell back to the heuristic AI, which also chose `pay: false`, and the game ended: "engine refused seat 3's action DecideOptionalCost { pay: false }: Action not allowed: Cannot pay mana cost (turn 12, active seat 3, waiting for OptionalCostChoice)".
- llm-3-hail-caesar-p0-g3, seat 3, turn 34: with five mana available, the seat cast Securitron Squadron and the engine offered "Pay: true" 347 times in a row; the seat took it each time (each prompt looked identical; see `llm-prompt-render-problems.md`). At the run's 400-decision cap the heuristic AI took over, chose `pay: false`, was refused the same way, and the game ended in the same error.
- No rules report covers these; the evidence is the lab log (`phase-haiku-guide.log`), the results file and the decision log (`phase-haiku-guide-llm.jsonl.gz`).
- Code read at rev 19be58d4:
  - `crates/engine/src/game/casting_costs.rs:1410-1465` `handle_decide_repeatable_additional_cost`: `pay: true` records a payment and calls `pay_additional_cost` with no affordability check of the new total; `pay: false` calls `finish_pending_cost_or_cast`, whose mana payment then fails.
  - "Cannot pay mana cost" is raised by the payment step (`game/casting.rs:23982`, `24562`, `24712`) and propagates as an error, leaving `WaitingFor::OptionalCostChoice` in place.
  - `crates/engine/src/ai_support/candidates.rs:2246-2257` generates both `pay: true` and `pay: false` for every `OptionalCostChoice`, unconditionally. The module comment in `game/cost_payability.rs:13` says an unpayable optional cost should skip the prompt, but that predicate covers object choices, life, energy and counters, not mana totals.

## 6. Variations to test

- Squad with exactly enough mana for N payments: "pay" is offered N times, then only "don't pay".
- Mana that can only be spent on creature spells, or Treasures and other sacrifice-for-mana sources: they count toward affordability.
- A cost reduction on the spell (for example "creature spells you cast cost {1} less"): applies once to the total (601.2f), so it allows one more squad payment only when the reduced total fits.
- Multikicker, replicate and other repeatable optional costs that share this flow (`AdditionalCostRepeatability::Repeatable`): same rule.
- A repeatable non-mana cost (for example paying life any number of times): offer "pay" only while the player can still pay the next one.
- After declining with an affordable total, the spell is cast normally and the number of tokens equals the payments made (Securitron ruling: three payments give three tokens with four counters each when the original is on the battlefield).

## 7. Acceptance checks

- On the first board, after one squad payment `legal_actions` contains no `DecideOptionalCost { pay: true }`.
- On the second board, no `pay: true` is offered at all, and `pay: false` casts Powder Ganger for {2}{R}.
- No sequence of offered actions ends with `DecideOptionalCost { pay: false }` refused; if the committed total can't be paid, declining reverses the cast and the game continues.
