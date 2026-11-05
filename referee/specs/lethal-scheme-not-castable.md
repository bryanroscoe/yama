# Spec: Lethal Scheme is never offered as a cast

Root cause (observed behaviour): phase never lists Lethal Scheme as a legal cast, even with plenty of mana, black sources and targets. Other convoke spells (Hour of Reckoning in the same deck) are offered and cast normally, so convoke alone isn't the cause. The cause wasn't located; this spec records the behaviour and the correct result.

Scenario: Found by the LLM seat (commander-decks run llm-4, game llm-3-hail-caesar-p1-g0), not the card sweep.

## 1. Card

- **Lethal Scheme** ({2}{B}{B} instant): "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.) / Destroy target creature or planeswalker. Each creature that convoked this spell connives. (Draw a card, then discard a card. If you discarded a nonland card, put a +1/+1 counter on that creature.)"
  - Ruling 2024-01-12: "When calculating a spell's total cost, include any alternative costs, additional costs, or anything else that increases or reduces the cost to cast the spell. Convoke applies after the total cost is calculated."
  - Ruling 2022-04-29: "You can't tap more creatures to convoke Lethal Scheme than it takes to pay for its total cost."
  - Ruling 2022-04-29: "If a resolving spell or ability instructs a specific creature to connive but that creature has left the battlefield, the creature still connives. If you discard a nonland card this way, you won't put a +1/+1 counter on anything."
  - Ruling 2022-04-29: "When multiple creatures are instructed to connive simultaneously, they connive one at a time in the order of their controller's choice."

## 2. Board and actions

Two players, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls Swamp ×4 and no creatures; its hand is Lethal Scheme; its library is 8 Wastes. Seat 1 controls Grizzly Bears. Seat 0 asks for its legal actions and casts Lethal Scheme targeting seat 1's Grizzly Bears, paying with the four Swamps.

Second board (convoke): seat 0 controls Swamp ×2 and two untapped Grizzly Bears of its own (green, so each pays only generic), and its hand is Lethal Scheme and Wastes. Seat 1 controls Serra Angel. Seat 0 casts Lethal Scheme targeting Serra Angel, paying {B}{B} with the Swamps and {2} by tapping both Bears.

## 3. Correct result

First board: the cast is legal and offered. Lethal Scheme resolves: seat 1's Grizzly Bears is destroyed. No creature convoked it, so nothing connives. Seat 0's Swamps are tapped and Lethal Scheme is in seat 0's graveyard.

Second board: the cast is legal and offered. On resolution Serra Angel is destroyed, then each of seat 0's two Bears connives, one at a time in seat 0's order: seat 0 draws a card (a Wastes), then discards a card. Discarding Wastes (a land) puts no counter on that Bear; discarding a nonland card would put a +1/+1 counter on it.

## 4. Why

1. 601.2 and 117.1a: a player with priority may cast an instant whenever no rule or effect prevents it. Nothing on these boards (or the evidence boards) restricts casting.
2. 601.2c: "target creature or planeswalker" has a legal target on both boards.
3. 702.51a and the 2024 ruling: convoke is an optional way to pay; a spell with convoke can always be paid entirely with mana. 601.2h: four Swamps pay {2}{B}{B}.
4. 701.50a (connive): the conniving creature's controller draws a card, then discards a card; if a nonland card was discarded, a +1/+1 counter goes on the creature.

## 5. What phase did

- llm-3-hail-caesar-p1-g0, seat 0, turn 36 (report 257) and turn 38 (report 259), the seat's own precombat main phase with an empty stack. Lethal Scheme was in hand. Available mana was 8 and then 9 sources (Swamp ×2, Nomad Outpost and Path of Ancestry make {B}). Player 2 controlled Y'shtola, Yes Man, Fandaniel, Hildibrand Manderville and others. The options were Pass, The Nipton Lottery and Caesar or Arcane Signet; Lethal Scheme was not among them. On turn 38 the seat also controlled Caesar and a Soldier token that could have convoked.
- Across all 5,394 LLM decisions in the run (`phase-haiku-guide-llm.jsonl.gz`), Lethal Scheme appears in an option only once, as a card to discard. It is never offered as a cast.
- In the same game (turn 29) the seat cast Hour of Reckoning ({4}{W}{W}{W}, convoke) and tapped Keeper of the Accord, Pitiless Plunderer, Butch DeLoria and a Soldier token for convoke, so convoke payment works.
- Triage reading of the card data: the parse is clean, `Destroy` on the target, then `Connive` on creatures with `FilterProp::ConvokedSource`.
- Code not located. Suspects, in order:
  - `spell_has_legal_targets_with_probe` (`crates/engine/src/game/casting.rs`, called at line 21327 of `can_cast_object_now_with_probe`): whether the connive clause's `ConvokedSource` population is treated as a targeted slot with no legal choice before any creature has convoked. `FilterProp::ConvokedSource` is evaluated at `game/filter.rs:10108` (`source.convoked_creatures.contains(&object_id)`), which is empty during the castability check.
  - The mana-feasibility probe for a convoke spell whose colored pips are black, compared with Hour of Reckoning (white). The convoke options in the payment step (`ConvokeMode`, `game/interaction.rs:2244`) run only after a cast is chosen, so they are a weaker suspect.

## 6. Variations to test

- Lethal Scheme targeting seat 0's own creature: legal ("target creature", no controller restriction).
- A planeswalker as the only target: legal.
- No creature or planeswalker on the battlefield: not castable (601.2c).
- Seat 0 tries to convoke with three creatures for a {2}{B}{B} cost already partly paid: it may tap only as many as the remaining cost needs (ruling).
- A convoking creature that left the battlefield before resolution still connives; a nonland discard then puts no counter anywhere (ruling).
- Another card that refers to the creatures that convoked it (Venerated Loxodon: "When this creature enters, put a +1/+1 counter on each creature that convoked it"): check it is castable, to see whether the fault is in the convoked-creature reference.

## 7. Acceptance checks

- On both boards, `legal_actions` contains `CastSpell` for Lethal Scheme.
- On the first board the cast resolves with seat 1's Grizzly Bears in the graveyard and no draw; on the second, Serra Angel is destroyed and each convoking Bear connives once.
