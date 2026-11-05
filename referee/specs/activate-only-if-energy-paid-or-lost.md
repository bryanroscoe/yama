# Spec: "Activate only if you've paid or lost four or more {E} this turn" is ignored

Root cause (observed behaviour): phase offers and accepts Izzet Generatorium's "{T}: Draw a card" on turns when its controller has paid or lost no energy. The activation restriction isn't parsed, and an activated ability whose restriction became unparsed text is still treated as legal, so the card draws a card every turn.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-creative-energy-p1-g0), not the card sweep. Also seen in llm-3-creative-energy-p1-g1.

## 1. Card

- **Izzet Generatorium** ({U}{R} artifact): "If you would get one or more {E} (energy counters), you get that many plus one {E} instead. / {T}: Draw a card. Activate only if you've paid or lost four or more {E} this turn."
  - Ruling 2024-06-07: "To pay one or more {E}, you lose that many energy counters. You can't pay more energy counters than you have."
  - Ruling 2024-06-07: "Energy counters aren't mana. They don't go away as steps, phases, and turns end."
  - Ruling 2024-06-07: "If you control two Izzet Generatoriums (Generatoria?), the number of {E} you get is the original number plus two."

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls Izzet Generatorium (untapped; it is not a creature, so summoning sickness doesn't matter) and has 3 energy and has paid or lost none this turn. Its library is 8 Wastes. Seat 0 tries to activate Izzet Generatorium's {T} ability.

The referee scenario format has no energy field yet. Until it has one, write this as a phase test that sets `Player::energy` directly, or give seat 0 energy with a card that grants it.

## 3. Correct result

The activation is illegal: seat 0 hasn't paid or lost four or more {E} this turn. `legal_actions` doesn't include it, and a submitted `ActivateAbility` is refused. Izzet Generatorium stays untapped and seat 0 draws nothing.

## 4. Why

1. 602.1b: "Activate only if ..." is an activation instruction. It restricts when a player can activate the ability, is not part of its effect, and functions at all times. 602.5: a player can't begin to activate an ability that's prohibited from being activated, which this one is while its condition is false.
2. 107.14 and the rulings: to pay {E}, a player removes one energy counter from themselves. The condition counts energy counters the player lost this turn, whether paid for a cost or lost to another effect. Energy the player still has doesn't count, and neither does energy paid on an earlier turn.
3. 601.2 and 602.2: an action the rules don't permit isn't a legal action, so it must not be offered.

## 5. What phase did

- llm-3-creative-energy-p1-g0, seat 0, turn 21 (reports 117 to 120): the viewer cast Izzet Generatorium and Stone Idol Generator in its precombat main phase. Its energy only rose that turn (4, then 8 after Satya's attack trigger). `[1] Izzet Generatorium — Activate Ability (Ability Index: 1)` was offered at every priority. The seat activated it on turns 21, 26, 28, 31 and 33, and the engine accepted every activation.
- llm-3-creative-energy-p1-g1, seat 1, turn 18 (reports 211 to 213): offered with 1 energy, no energy paid that turn, and accepted when chosen.
- 43 reports in all, across the two games. Some later offers were legal: on turn 25 of p1-g0 the viewer's energy fell from 5 to 1, so 4 had been paid by then. The reports from before that drop (122 to 124) are not.
- Triage reading of the card data (export `cbd552b41f962f5b`): the ability is `Activated { cost: Tap, effect: Draw 1 }` with no `activation_restrictions`, and a sub-ability `Unimplemented "unparsed_condition: Activate only if you've paid or lost four or more {E}"`. The first ability (the energy replacement) is `Unimplemented` too.
- Code read at rev 19be58d4:
  - `crates/engine/src/parser/oracle.rs:12751-12773` sends the "activate only if" text to `commit_requires_condition` (`oracle.rs:12234`). That returns `false` when `parse_restriction_condition` can't read the condition, and the text is left in the ability, where it becomes `Effect::Unimplemented`. That part works as documented.
  - `crates/engine/src/game/casting.rs:27786` `activation_verdict` checks `activation_restrictions`, timing, summoning sickness and cost, but never refuses an ability that carries an unparsed restriction. Compare `casting.rs:21229-21232`, which refuses a spell whose required additional cost is `Unimplemented`.
  - phase has no "energy paid or lost this turn" quantity. The phrase appears only in parser guards that leave it unparsed (`parser/oracle_cost.rs:1860`, `parser/oracle_static/static_helpers.rs:889`).

Related: `cost-reduction-per-counter-with-no-counters.md` (Blaster Hulk's "costs {1} less for each {E} you've paid or lost this turn") needs the same per-turn quantity.

## 6. Variations to test

- Seat 0 pays exactly 4 {E} earlier in the turn (for example to an "unless you pay" or a "Pay {E}{E}" ability twice): the activation becomes legal. It stays legal for the rest of that turn even after energy is gained again.
- Seat 0 pays 3 {E}: still illegal. Pays 2, then loses 2 to another effect: legal (paid or lost, summed).
- Seat 0 paid 4 {E} on its previous turn and none this turn: illegal (the count resets each turn).
- An opponent paid 4 {E} this turn and seat 0 none: illegal ("you've").
- Seat 0 has 10 energy and has paid none: illegal (having energy isn't paying it).
- The replacement ability: seat 0 controls Izzet Generatorium and an effect says it gets {E}{E}. It gets 3. With two Generatoriums it gets 4 (ruling).
- Until the per-turn count exists, the ability must fail closed: never offered, never accepted.

## 7. Acceptance checks

- With Izzet Generatorium untapped and 0 {E} paid or lost this turn, `can_activate_ability_now(.., ability_index 1)` is false and `legal_actions` doesn't contain the activation.
- After seat 0 pays four {E} in the same turn, the activation is legal; on the next turn, with nothing paid, it is illegal again.
- A generic check: any activated ability whose "Activate only if ..." text didn't parse is not activatable.
