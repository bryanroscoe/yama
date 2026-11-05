# Spec: problems in the LLM seat's prompt (phase-llm rendering and Yama's object key)

Root cause (observed behaviour): the text phase-llm renders for a seat, and the object key Yama adds to it, misstate or leave out facts the model needs. None of these is a rules bug: the engine's state is right and the prompt describes it wrongly or incompletely. Most of the 342 rules reports in run llm-4 trace back to them, above all to the player numbering. Each section gives the evidence, the output that should replace it, the code, and acceptance checks.

Scenario: Found by the LLM seat (commander-decks run llm-4, games named per section), not the card sweep. Report numbers are 0-based positions in `phase-issues.json`. Code is yama-phase at rev 19be58d4 (`crates/phase-llm`, `crates/engine`) and Yama's `play/src/lab.rs` on `feature/llm-seat-20261104`.

## 1. Player numbering: the log uses id + 1, the board uses id, and the log never says "You" (135 reports, 30 games, every deck)

Evidence. Report 14 (llm-3-tricky-terrain-p0-g1, seat 1, turn 28). The header says "You are Player 1. Turn 28 — CombatDamage — active player: Player 0". PLAYERS lists Player 0, You, Player 2 (−1 life) and Player 3 (−26). The log for the same turn says "T28 Untap: Turn 28 — Player 1", "... attack Player 3", "Player 3 loses the game", "Player 3 is eliminated", and earlier turns name "Player 4". Every player name in the log is the board's number plus one, and the viewer appears in the log as a numbered player, never as "You".

What it caused:
- The model thought its own spells were cast by someone else (reports 73 to 83), or that stack controllers were wrong (10, 109, 151).
- It thought it took damage that went to another seat (56 to 59, 108), and that it had been eliminated, so it passed for that reason. Report 84 (llm-3-tricky-terrain-p1-g3, seat 3): fifty "deals ... combat damage to Player 3" lines are its own attackers hitting seat 2; its reason was "Combat damage has already eliminated me, so ... I pass priority". Also 86 to 103 and 250 to 254.
- It thought sorcery-speed options were offered on an opponent's turn when it was its own (16).
- It misjudged who controls Idol of Oblivion's tokens (269, 270, 291, 292), Midnight Reaper (335), Parasitic Impetus (255), General Kreat (285) and Rapid Hybridization's token (165). The triage classed those as model errors, but each is this misreading.

Correct output. One label per seat everywhere in a prompt: "You" for the viewer and "Player N" with the engine's `PlayerId` N (0-based, as the header and the board already do) for everyone else, in the header, PLAYERS, BATTLEFIELD, STACK, COMBAT, EXILE, the object key, the turn summaries and every log line. For report 14 the log reads "T28 Untap: Turn 28 — Player 0", "... attack Player 2", "Player 2 loses the game", and the viewer's own actions read "You cast ...".

Code:
- `crates/engine/src/game/log.rs:783-790` `resolve_player_name` falls back to `format!("Player {}", id.0 + 1)`. Engine log entries are built with it, for example `TurnStarted` at `log.rs:1098-1106`.
- `crates/phase-llm/src/render/game.rs:86-92` `seat_label` renders "You" or `Player {player.0}`.
- `crates/phase-llm/src/render/history.rs:246-261` `render_log_entry` copies `LogSegment::PlayerName { name, .. }` verbatim (line 253). The segment carries `player_id` (`crates/engine/src/types/log.rs:88`), so it can be relabelled with `seat_label(player_id, viewer)`. `render_log_entry`, `summarize_turn` (`history.rs:160-181`), `push_current_cycle` (`history.rs:185-208`) and `push_history` (`history.rs:98`) need the viewer passed in. Setting `state.log_player_names` can't give each viewer its own "You", so the relabelling belongs in the renderer.
- Some log lines may carry a player only in `Text` (not a `PlayerName` segment); check every `player_seg` caller in `log.rs` emits a segment.

Acceptance checks:
- Render a four-seat game for viewer `PlayerId(1)` whose log has "Player 1 casts X" for `PlayerId(0)`: the history says "Player 0 casts X".
- An entry authored by the viewer renders "You ...", and "Turn N — ..." lines use the same label as the header's "active player".
- No prompt contains the same seat under two numbers.

## 2. Eliminated players aren't marked (38 reports, 16 games)

Evidence. Report 111 (llm-3-tricky-terrain-p1-g3): "Player 0: −49 life, 0 cards in hand, 0 cards in library ..." and "Player 2: −77 life ...", with nothing saying they have lost. Both had been eliminated (results: seat 0 on turn 35, seat 2 on turn 33) and their cards were gone. Report 257 (llm-3-hail-caesar-p1-g0) is the same. Every player shown at 0 or less life in all 342 prompts had in fact been eliminated, so the engine applied 104.3a/704.5a and 800.4a correctly; the prompt didn't say so.

Correct output. "Player 2: eliminated (turn 33)" with no other facts, or the seat left out of PLAYERS, and no empty BATTLEFIELD or GRAVEYARDS entries for it.

Code: `crates/phase-llm/src/render/game.rs:105-139` `push_players` never reads `Player::is_eliminated` (`crates/engine/src/types/player.rs:164`) or `state.eliminated_players` (`crates/engine/src/types/game_state.rs:23243`). The battlefield and graveyard sections also keep listing such seats.

Acceptance checks: with `is_eliminated = true` on one seat, its PLAYERS line says "eliminated" (or is absent), and no other section prints a heading for it.

## 3. Abilities on the stack look like spells (11 reports, 9 games)

Evidence.
- Report 210 (llm-3-creative-energy-p1-g2): "STACK: 1. Filigree Racer (controlled by You)" while Filigree Racer is on the battlefield. The entry is its enters trigger; the model reported the Racer as "both on the stack and on the battlefield".
- Report 277 (llm-3-goblin-storm-p0-g2): the top entry "Valgavoth, Harrower of Souls (controlled by Player 1)" is Valgavoth's ward trigger against Destroy Evil; the model reported "no ward trigger appears on the stack".
- Reports 152, 247, 318, 328, 329: Coalition Relic, Unstable Amulet and Dr. Madison Li triggers read as their spells "still on the stack".

Correct output. "1. Triggered ability of Filigree Racer (controlled by You): When this Vehicle enters, you get {E}{E}{E}{E}." Activated abilities likewise ("Activated ability of ..."), spells as now, with the ability's text taken from the stack entry.

Code: `crates/phase-llm/src/render/game.rs:141-159` `push_stack` prints `object_name(entry.id).or(object_name(entry.source_id))` and the controller, and ignores the entry's kind (`StackEntryKind::{Spell, ActivatedAbility, TriggeredAbility}`, `crates/engine/src/types/game_state.rs:21236`).

Acceptance checks: a `TriggeredAbility` stack entry from a permanent on the battlefield renders with "triggered ability" and its text, never as the bare permanent name.

## 4. Options don't say which ability, and same-named objects can't be told apart; the object key can't be matched to the options (15 reports, 4 games)

Evidence.
- Report 31 (llm-3-tricky-terrain-p1-g0): `[1] Sage of the Maze — Activate Ability (Ability Index: 2, Source ID: Sage of the Maze)` during an opponent's upkeep. Index 2 (0-based) is the instant-speed "Tap an untapped Gate you control: Untap this creature"; the model read it as the sorcery-speed land animation and reported an illegal offer (31 to 43). The same misreading: Poison Dart Frog index 1 (20, 22), Sage of the Maze while summoning sick (25, 26), Jolted Awake index 1 (cycling from hand, 113), Idol of Oblivion index 0 (268).
- Report 144 (llm-3-creative-energy-p0-g1): options 1 to 3 are three identical "Aethersphere Harvester — Activate Ability (Ability Index: 0, Source ID: Aethersphere Harvester)" lines and options 4 and 5 two identical "Crew Vehicle (Vehicle ID: Aethersphere Harvester)" lines, while the object key lists Objects 192, 426 and 455, all "Aethersphere Harvester". The options print names where the ids were, so nothing links an option to an object number.
- The key's own header says "what the object numbers in the options refer to", but most options show no numbers. Only target choices do ("Choose Target (Target: Object 64)").

Correct output. `[1] Sage of the Maze (Object 412) — activate: "Tap an untapped Gate you control: Untap this creature."` Each activated-ability option names its object number and quotes the ability's cost and text; each other option that names an object gives its number, so the object key applies to every option.

Code:
- `crates/phase-llm/src/render/action.rs:42-56` `describe_action` walks the serialized action generically: `ability_index` is humanized as a bare number and ids are replaced by names, so neither the ability's text nor the object number is shown.
- Yama `play/src/lab.rs:723-757` `object_key` lists numbers the options mostly don't show. Either the options keep the number next to the name, or the key is keyed the way the options are written.

Acceptance checks: rendering `ActivateAbility { source: Sage, ability_index: 2 }` includes "Tap an untapped Gate you control: Untap this creature"; two options on different objects with the same name render differently; every object number in the key appears in at least one option.

## 5. Optional cost prompts don't name the cost, the spell or the payments so far (no reports; two games ended in an engine error)

Evidence. llm-3-hail-caesar-p0-g3, seat 3, turn 34: while it cast Securitron Squadron (squad {3}) with five mana, the seat saw the same three options 347 times in a row: "Cancel Cast", "Decide Optional Cost (Pay: false)", "Decide Optional Cost (Pay: true)". Each time its reason was a variant of "Paying the squad cost once uses all 5 available mana", so it paid again, never learning it had already paid. llm-3-hail-caesar-p1-g3, turn 12 (Powder Ganger) is the same with two payments. The engine side is `squad-payments-beyond-available-mana.md`.

Correct output. "WAITING ON YOU FOR: Optional cost for Securitron Squadron: squad {3} (paid 2 times so far; total cost now {7}{W}). [1] Pay squad {3} again [2] Stop paying squad". The `WaitingFor::OptionalCostChoice` value already carries `cost`, `times_kicked`, `origin` and the pending cast (`crates/engine/src/game/casting_costs.rs:577-603`).

Code: `crates/phase-llm/src/render/action.rs:222-240` `describe_waiting_for` names a source only from `data.source.display_name`, which `OptionalCostChoice` doesn't have; `describe_action` renders the choice as "Decide Optional Cost (Pay: true)".

Acceptance checks: an `OptionalCostChoice` for a repeatable cost renders the spell's name, the cost, and the number of payments already made; the "pay" option reads differently from the "don't pay" option beyond a true/false flag.

## 6. Target selection doesn't name what is targeting (4 reports, 3 games)

Evidence.
- Report 29 (llm-3-tricky-terrain-p0-g3, seat 3, turn 35): "WAITING ON YOU FOR: Target Selection" with four of Player 2's nonbasic lands and "Cancel Cast". The pending action was Volatile Fault's "Destroy target nonbasic land an opponent controls", chosen the decision before. The model assumed Wonderscape Sage's ability, reported the targets as wrong and cancelled.
- Reports 248 and 249: "Trigger Target Selection" offers Player 2's creatures for Aetherstorm Roc's "tap up to one target creature defending player controls", read as Satya's trigger. Report 116: Aurora Shifter's reflexive trigger read as Satya's.

Correct output. "Target Selection for Volatile Fault: Destroy target nonbasic land an opponent controls." For a trigger, "Trigger Target Selection for Aetherstorm Roc's triggered ability: ...".

Code: `crates/phase-llm/src/render/action.rs:222-240` `describe_waiting_for` (as above). The source is in `state.pending_cast` for spells and activations, and in the pending trigger for triggers.

Acceptance checks: a `WaitingFor::TargetSelection` for Volatile Fault's ability renders its name and text.

## 7. Delve choices are labelled "Tap For Convoke" (4 reports, 3 games)

Evidence. Report 46 (llm-3-tricky-terrain-p1-g1): paying for Treasure Cruise, the options are `[1] Urban Evolution — Tap For Convoke (Mana Type: Colorless, Object ID: Urban Evolution)` and the same for Summary Dismissal; the object key says both are "in your graveyard". The model reported convoke offered from the graveyard on a spell without convoke. Report 41 (llm-3-tricky-terrain-p1-g0, Treasure Cruise again) lists nineteen graveyard cards this way.

Correct output. "Exile Urban Evolution from your graveyard (delve, pays {1})".

Code: `crates/engine/src/game/interaction.rs:2235-2243` emits `GameAction::TapForConvoke { object_id, mana_type: Colorless }` for delve-selectable graveyard cards (offering the exile is right), and `describe_action` prints the variant name. The renderer should describe a `TapForConvoke` whose object is in a graveyard as delve. A distinct engine action for delve would be cleaner and could go upstream.

Acceptance checks: with Treasure Cruise pending and cards in the graveyard, no option text contains "Tap For Convoke"; each says "delve" or "exile".

## 8. Tokens, copies and the command zone aren't shown (4 reports, 3 games)

Evidence.
- Report 115 (llm-3-creative-energy-p0-g3): two identical "Construct | Artifact Creature — Construct | 6/12" lines. The tapped, attacking one is Aurora Shifter copying the Stone Idol Generator token, a legal "nontoken" target for Satya; the model took it for the token.
- Report 217: two "Aetherstorm Roc" lines offered to Brudiclad's "choose a token"; the prompt can't show which are tokens.
- Reports 125 and 153: a 2/3 "Satya, Aetherflux Genius" (printed 3/5) is on the battlefield while Satya is castable from the command zone. It is a token copy; the prompt has no command-zone section, so the model couldn't see where its commander was.

Correct output. Battlefield lines mark tokens ("token") and copies ("Aurora Shifter, copying Construct"); a COMMAND ZONE section lists each player's commanders there, with commander tax.

Code: `crates/phase-llm/src/render/game.rs:472-532` `permanent_line` prints no token flag and no copy identity, and `render/game.rs` has no command-zone section. Yama's `object_key` (`play/src/lab.rs:723`) could also say "token" and "copy of X".

Acceptance checks: a token and a nontoken creature copying it render differently; a commander in the command zone appears under a COMMAND ZONE heading.

## 9. "Summoning sick" printed on lands and other noncreatures (2 reports)

Evidence. Report 71 (llm-3-creative-energy-p0-g0): "Adarkar Wastes | Land | ... | summoning sick"; report 293: Treasure tokens. The same flag shows on Izzet Generatorium, Stone Idol Generator and Dark Depths in other prompts (for example report 120).

Correct output. Print it only on a permanent that is currently a creature (302.6 applies only to creatures). A land that later becomes a creature the same turn (Lair of the Hydra) then shows it, which is when it matters.

Code: `crates/phase-llm/src/render/game.rs:494-498` prints `object.summoning_sick` for every permanent.

Acceptance checks: a land that entered this turn renders without "summoning sick"; a creature that entered this turn renders with it.

## 10. Available mana ignores mana doubling (1 report)

Evidence. Report 35 (llm-3-tricky-terrain-p1-g1): with Mana Reflection on the viewer's battlefield, the prompt says "Untapped mana sources (up to 2 more mana available now): Lush Oasis 1, Hidden Nursery 1". Summary Dismissal ({2}{U}{U}) is offered, correctly, since the two lands make 4 mana, and the model called the offer illegal.

Correct output. "Lush Oasis: 2 mana (Mana Reflection)" and "up to 4 more mana".

Code: `crates/phase-llm/src/render/game.rs:315-372` `push_available_mana` sums `mana_sources::max_mana_yield` per source without mana replacement effects (106.12, 614).

Acceptance checks: Mana Reflection plus one Forest renders 2 mana for the Forest.

## 11. Rust debug output and unbounded text in the board (no reports; seen while reading)

Evidence:
- Keywords print with `{:?}`: "Kicker(Cost { shards: [], generic: 0 })" on Thieving Skydiver (report 12; its printed kicker is {X}), "Crew { power: 1, once_per_turn: None }", "Enchant(Typed(TypedFilter { ... }))", "Ward(PayLife(2))", "Landwalk(\"Island\")", "FirstStrike".
- Counters print as `Generic("everything")`, `Generic("charge")`, `Plus1Plus1`.
- Omo's everything counter makes each affected creature's type line list every creature type (several hundred words per line in report 12).
- "Order Triggers (Order: 0, 1, 2)" options don't say which triggers are being ordered (report 300).

Correct output. Keywords as printed ("Kicker {X}", "Crew 1", "Ward—Pay 2 life", "Islandwalk", "First strike"); counters as "1 everything counter", "2 +1/+1 counters"; a creature with every creature type as "every creature type"; trigger-order options listing each trigger's source and text in the proposed order.

Code: `crates/phase-llm/src/render/game.rs:518-526` (keywords, `format!("{keyword:?}")`), `game.rs:566-586` `counter_text` (`format!("{kind:?}")`), `type_line_text` for the type list.

Acceptance checks: no rendered prompt contains `{ `, `(Cost`, `Generic(`, `Plus1Plus1` or a Rust variant name; Omo's counter renders in one short phrase.

## Variations to test (all sections)

- Render the same position for each of four viewers: each sees "You" for itself and the same numbers for the others in every section.
- A prompt early in the game (no eliminations, empty stack) is byte-for-byte unchanged by sections 2, 3 and 6 except where they apply.
- Hidden information stays hidden: face-down cards and other players' hands are not revealed by the new token, copy, stack or target text.
