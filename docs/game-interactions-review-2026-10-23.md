# Game interactions design review, 2026-10-23

**What was reviewed:**
- the 33 artboards on the canvas page "Game interactions": `design/screens/G*.dc.html`, `BoardBase.dc.html` and `BoardBasePhone.dc.html` (uncommitted);
- the "Game interactions" section of `design/README.md` (lines 37-72) and `design/tokens.md`;
- `docs/play-polish-requirements.md` (the PP numbers);
- Yama's online board and server on `main` as of today, including the 2026-10-22 drag-and-drop and motion work (`380965c`, `52e6563`);
- the decision types in the phase fork.

This review is read-only: nothing was changed in either repo. The boards were read as source (markup plus their `text/x-dc` scripts), not rendered.

**How to read the references:**
- **Engine paths** are under `../yama-phase/crates/engine/src/`.
  - `game_state.rs` means `types/game_state.rs`; its `WaitingFor` enum runs from line 14808 to 17474.
  - `actions.rs` means `types/actions.rs`; `GameAction` starts at line 157.
- **Yama paths:**
  - `Board.tsx`, `model.ts`, `drag.ts`, `DragLayer.tsx`, `BoardMotion.tsx`, `Tiles.tsx`, `types.ts` and `board.css` are in `web/src/play/`.
  - `lib.rs` is `play/src/lib.rs`, and `play.rs` is `server/src/play.rs`.
- **Distance from the design:**
  - **None:** nothing like it today.
  - **Partial:** the decision can be made, but not the designed way, or not in full.
  - **Close:** works much as designed, with polish left.

## Summary for Bryan

1. **Coverage.** The boards cover the main decisions of a Commander game on a laptop: mulligan, priority and stops, casting, targets, mana, modes and X, responses, trigger order, attacks, blocks, the damage split, scry, search, a handful of other prompts, zones, knockouts, game over and the log. Ten of them have a phone version.
2. **Quality.** The work is careful and consistent. The copy is plain, the main-button labels follow PP-32, combat and targeting happen on the board with arrows, and most mocks are interactive enough to show their states.
3. **Close already.** Drag to cast, on-board targets, attack and block planning, the spell spotlight and life ticks landed on 2026-10-22, so targeting and combat are close.
4. **Far off.** Scry, multi-card search, trigger order, the damage split, manual mana, and modes and X are not close. Yama still answers those through the AI's sampled option list, not the engine's full set of answers.
5. **Uncovered decisions.** phase has about 140 kinds of decision and the boards draw about 20. Common Commander ones with no design include:
   - "may" prompts and replacement-effect order;
   - surveil and dig, effect discards and sacrifice costs;
   - sacrificing a Treasure while paying;
   - votes and piles, clones, proliferate, crew and equip;
   - attack taxes and loop shortcuts.
6. **Things the engine can't supply.** Several boards promise things the engine doesn't give:
   - plain-language card summaries and "since your last turn" digests;
   - attack-trigger previews such as Adeline's;
   - "always pay" for Rhystic Study, and "always the command zone";
   - undoing a painland tap;
   - the reason a player lost;
   - a replay viewer.
7. **The five rules.** They mostly hold, with these exceptions:
   - The colour rule clashes with `tokens.md`, where amber already means "warning" and green means "playable".
   - It also clashes with the seat colours: Sam's is nearly the "bad" red and Jules's nearly the "good" green.
   - The dialog boards show two main buttons.
   - Space and right-click each get two jobs.
   - Art crops on tiles and portraits carry no credit.
8. **Phone.** The biggest phone gap is that no board shows how to play a card from your hand. The phone inspector design also drops the option buttons, which are how you play a card on a phone today.

## Board by board

| Interaction | Laptop / phone | PP | Engine decision | Yama today | Distance | Notes |
|---|---|---|---|---|---|---|
| Mulligan | GMulligan / GMulliganPhone | 51 | `MulliganDecision` game_state.rs:14867; the bottom step is its `BottomCards` phase (`game/mulligan.rs:499`), answered with `SelectCards` (actions.rs:310); `GameAction::MulliganDecision` actions.rs:267 | Keep and Mulligan buttons found by their labels (Board.tsx:890-897; labels lib.rs:706-707). The bottom step is one button per combination from the AI sample (Board.tsx:1996-2002) | Partial | "Keep N" is the hand size (Board.tsx:894), so after a mulligan it says "Keep 7" when you'll keep 6. The design fixes that. The d20 line needs the starting-player event, and Yama keeps no events; it has only `starting_seat` (lib.rs:467). Opponents' "Mulliganed once" needs each seat's count from `pending`, which isn't in the View. In the mock, "Start over" resets the whole mulligan, not just the tray. The bottom order isn't chosen. "First mulligan is free" is hard-coded; use `free_first_mulligan`. Picked cards are amber. The phone board has no art credit |
| Priority, passing, stops | GPriority / no board (a dock button on phone boards) | 33, 34, 36 (and 7) | `Priority` game_state.rs:14809; `PassPriority` actions.rs:158, `SetAutoPass` :760, `CancelAutoPass` :764, `SetPhaseStops` :769, `SetPriorityPassingMode` :774; the engine's own pass loop is `game/engine.rs:10010` | Two-row stop ladder in the strip and a sheet (Board.tsx:1469-1511, 1066-1100), applied by Yama's own `should_auto_pass` (lib.rs:794-839). Full-control checkbox (Board.tsx:1082-1094, play.rs:303-310). Stops are saved per device in localStorage (Board.tsx:191-197) | Close for stops; none for pass modes | "Saved for every game" needs per-user storage on the server. Enter and "Pass to my turn" map to `SetAutoPass`, but the engine runs those sessions inside `apply`, beside Yama's own pass layer, so the two must be made to agree. "Pass the rest of this turn" has no engine equivalent and needs a Yama flag. A bare Ctrl key for full control clashes with browser shortcuts and with PP-34's Ctrl / Ctrl+Shift split. No phone sheet for stops or modes (PP-33, PP-69) |
| Main button, every state | GButtons / the dock | 32 | Label derived from `WaitingFor`, phase, stack and combat | `controls` (Board.tsx:865-905), `passLabel` (model.ts:279-288), Space (Board.tsx:354-367), disabled "Waiting for X" with art (Board.tsx:867-874) | Close for priority, attack, block, mulligan and waiting; none for the rest | Today any non-empty stack reads "Resolve" (model.ts:280); the design separates "Resolve" from "Let it resolve". "Your spell on the stack: Resolve, Resolve all" conflicts with PP-07, where your own spell resolves without asking; Yama does stop there today (lib.rs:825-827). States not drawn: may prompts, modes, X, the scry, search, trigger and damage confirms, spectators, "you're out", and a draw. The "End turn" and "Pass to my turn" secondaries need the pass modes |
| Playing a card, using a permanent | GCast / no phone board | 25, 28 (and 30) | Priority candidates `CastSpell` actions.rs:173 (carries `payment_mode`), `PlayLand` :169, `ActivateAbility` :188. Follow-ups `ModalFaceChoice` game_state.rs:16139, `AlternativeCastChoice` :16164, `CastingVariantChoice` :16225, `CastOffer` :16123, `ChooseManaColor` :16695. Auto-tap preview `preview_auto_payment_sources` `game/preview.rs:204` | Drag past the line (drag.ts:8-67, Board.tsx:681-726), double-click (Board.tsx:574-578). A card with several ways to play gets selected, and the rail lists them (Board.tsx:718-721) | Close for drag and double-click; partial for the menu; none for the auto-tap preview and mana abilities | Activated abilities are all labelled "Use X" (lib.rs:705) and merged by `dedupe` (model.ts:270-272), so a planeswalker's second and third abilities can't be reached (PP-04 is still open). The Command Tower menu also needs mana abilities at priority, which the AI sample doesn't offer. "Will tap" marks a preview in amber (rule 3) |
| Paying mana | GPay / GPayPhone | 29, 30, 31 | `ManaPayment` game_state.rs:14888, raised only when auto-pay isn't choice-free (`game/casting_costs.rs:15858-15876`). `TapLandForMana` actions.rs:282, `ActivateManaSource` :288, `UntapLandForMana` :296, `SpendPoolMana` :302. `PassPriority` here means "pay the rest" (`game/engine.rs:13867`); `CancelCast` engine.rs:13495. `ManaSourceSelection` :14899, `PhyrexianPayment` :17466 | Every cast uses Auto through the AI sample. When the engine does ask, the pay-the-rest option is labelled "Pass (let it resolve)" (lib.rs:695-697) and becomes the main button, reading "Resolve" (Board.tsx:898-899, model.ts:280) | None | Untap is only offered for pure mana sources (`game/mana_sources.rs:281`, `:1145`). Battlefield Forge's damage can't be undone, but the mock gives the life back. "Tap mana for me" needs `CastSpell.payment_mode` sent outside the AI sample. There are two "pay the rest" buttons and two cancel buttons, in the panel and in the rail. "Undo is no longer possible" is a button label. The Treasure prompt isn't drawn, though "ask before sacrificing" is the default. The phone button says "Cast" after casting |
| Choosing targets | GTarget / GTargetPhone | 26 | `TargetSelection` game_state.rs:14959 (`selection.current_legal_targets`, `mode_labels`), `TriggerTargetSelection` :15881. `ChooseTarget` actions.rs:341, `SelectTargets` :338, `CancelCast` :384. A lone target is picked by the engine (`auto_select_targets`, `game/ability_utils.rs:1653`) | Amber rings and a crosshair; click, or drag onto a target; an aim arrow from the parked card or the top of the stack (Board.tsx:322-343, 457-478, 617-660; board.css:214-235). Each option carries its exact target (lib.rs:377-410, 498-513) | Close for picking; partial overall | A click commits at once today; the design holds the pick until "Cast it". The engine moves on after each slot and recomputes the next slot's legal targets, so only the current slot can be held; earlier slots back out only through `CancelCast`. The banner, the "0 of 1" count and the numbered marks are missing. Today's aim arrow is amber and dashed (board.css:1963); the design's is blue. The laptop board treats "Zombie ×2" as one target, while the phone board splits it. In the mock, "Cancel" clears the pick, not the cast. The stack has no targets (lib.rs:1110-1113), so an auto-picked target is never shown |
| Modes and X | GModes / no phone board | 27 | `ModeChoice` game_state.rs:16011 and `AbilityModeChoice` :16264, answered with `SelectModes` actions.rs:496. `ChooseXValue` :14948 (`min`, `max`, `x_cost_previews`), answered with `ChooseX` :877. `max_x_value` `game/casting_costs.rs:15240` | One button per mode combination (lib.rs:749-758), one per sampled X value (lib.rs:734) | Partial | The mode titles and advice ("Good against a board wipe") are invented; the engine gives `mode_descriptions` only. "Choose two" isn't drawn. The engine usually asks X after targets (the comment at game_state.rs:14935); the mock asks X first, then "Choose targets". Fireball's target-count control is card-specific, not an engine decision. `max` counts Treasures, sacrifice and life-payment sources, and can over-count (`casting_costs.rs:15312-15320`), so "Max" may mean sacrificing. "You have 10 mana available" isn't engine data. The dialog's "Next" sits beside the rail's "Next" |
| Responding to a spell | GRespond / GRespondPhone | 46, 47. The README also lists 45, which is the combat preview | `Priority` with a non-empty stack. Stack details from `derive_filtered_views` (`game/derived_views.rs:2110`; `DerivedViews` :615) | "Respond to X" title (model.ts:296), stack names and owners only (Board.tsx:1813-1855), playable cards ringed, spotlight on opponents' spells (BoardMotion.tsx:289-314) | Partial | The ability text, target chips, "Targeted by Sam" badge and seat-coloured arrow need stack targets in the View (PP-03). "Computer and Jules passed" needs each seat's pass state. "Free right now" needs each option's effective cost (`legal_actions_for_viewer`, `ai_support/mod.rs:2608`), and Fierce Guardianship's free cost is only chosen after casting (`AlternativeCastChoice`). Notes such as "Counter it" should come from the Oracle text. The mock keeps the spotlight up while you decide; PP-47 has it fly to the stack after 600-900 ms |
| Ordering triggers | GTriggers / no phone board | 48 | `OrderTriggers` game_state.rs:15160, answered with `OrderTriggers` actions.rs:364. Saved orders `game/triggers.rs:7846`; `SetTriggerOrderTemplate` actions.rs:796 | One button per order from the sample: every order up to 4 triggers, only two above that (lib.rs:738-748) | Partial | "Saved for next time" shows before you press Done. Duplicate triggers aren't numbered (#1, #2). The trigger text is paraphrased (Goblin Rabblemaster's is wrong); use `PendingTriggerSummary.description`. The dialog's Done sits beside the rail's Done |
| Reading a card | GInspector / GInspectorPhone | 23, 24 | None: read-only | Inspector with the card's options, image, other face, facts, Oracle text and rulings (Board.tsx:2054-2101). Opened by right-click and long-press (Tiles.tsx:25-64). Hover preview after 150 ms (Board.tsx:583-589) | Partial | "In plain words" and "Related" need per-card text that the engine can't give. "Came in turn 6 from the command zone" needs per-object history. The design drops the card's option buttons, and on a phone they're how you play cards today (Board.tsx:571, 1149-1156). "Space while pointing" clashes with Space as the main button. The hover delay is 0.5 s, against PP-24's 150 ms. There's no Oracle text as text, and no flip button. "Point at it" has nothing on the server behind it. Set and collector number aren't in `CardMeta` (play.rs:1041-1059) |
| Declaring attackers | GAttack / GAttackPhone | 40, 44 (and part of 45) | `DeclareAttackers` game_state.rs:14975 (`valid_attack_targets_by_attacker`, `attacker_constraints`), answered with `DeclareAttackers` actions.rs:192. Follow-ups `ExertChoice` :15102, `EnlistChoice` :15113, `CombatTaxPayment` :17448 | Any subset at any defender (lib.rs:609-615, 517-535). Toggle; aim by clicking a pane; drag onto a defender; "Attack with all"; Reset; plan arrows; strip summary (Board.tsx:498-526, 604-613, 664-680, 733-747, 838-852, 875-882, 1886-1914) | Close | Today's attack arrows are red (board.css:1955-1957); the design's are blue. "Everything at" each opponent and the defender-art chips are new. Lethal and commander-damage notes are client arithmetic. The Adeline line is a card-specific trigger preview that nothing in the engine provides. Must-attack and can't-attack badges aren't drawn, and Yama doesn't send `attacker_constraints`. Planeswalker and battle defenders, exert, enlist and attack taxes aren't drawn |
| Declaring blockers | GBlock / GBlockPhone | 41, 44 (and part of 45) | `DeclareBlockers` game_state.rs:15009 (`block_requirements`, `blocker_constraints`, `must_be_blocked_targets`, `block_capacities`), answered with `DeclareBlockers` actions.rs:201. `lethal_damage_needed` `game/combat_damage.rs:1469`; `commander_lethal_headroom` `game/commander.rs:102` | Any set of blocks (lib.rs:619-622). Click a blocker, then an attacker; drag; Reset; rail list (Board.tsx:527-553, 673-678, 883-889, 1917-1950). Yama sends only the blockers and their legal attackers (lib.rs:536-547) | Partial | There's no "Attacking you" lane: attackers stay in the attacker's pane. The fate badges need keywords such as deathtouch, which `CardView` doesn't have (lib.rs:1073-1103). Menace's "needs 2", must-block and one creature blocking several aren't drawn, and Yama drops those fields. Attacks on other players aren't shown on this board |
| Combat damage assignment | GDamage / no phone board | 43 | `AssignCombatDamage` game_state.rs:17293, answered with `AssignCombatDamage` actions.rs:801, asked when `needs_interactive_assignment` (`game/combat_damage.rs:1057`). The same widget serves `AssignBlockerDamage` :17320 and `DistributeAmong` :17330 | The default split only, as one sampled option | None | The mock starts with 2 left; PP-43 wants the engine's default split filled in, so one Done accepts it. It uses a dialog instead of steppers on the blockers (rule 2). "Survives" is amber. The dialog's Done sits beside the rail's Done. Divide-the-damage spells aren't drawn |
| Watching other players' combat | GCombatView / no phone board | 42 | `state.combat` `game/combat.rs:319`; `blocker_assignment_pairs` in the derived views | `attacking`, `attacks` and `blocking` on each card (lib.rs:952-954). Strip text and "is declaring blockers" (model.ts:234-252, Board.tsx:843-852, 1022-1034) | Partial | No arrows for other players' combat: `PlanArrows` draws only your own plan (Board.tsx:838-841). A blocker doesn't say which attacker it blocks. The copy "You still get priority in each combat step" contradicts PP-07 and today's stops (lib.rs:834-837). The pulse loops forever |
| Scry | GScry / GScryPhone | 49 | `ScryChoice` game_state.rs:15289, answered with `SelectCards`: the cards kept on top, in order. The rest go to the bottom in the engine's order (`game/engine_resolution_choices.rs:2016-2043`) | Sampled options only: none, all, or one card | None | "Order doesn't matter" for the bottom matches the engine. "Done, draw" is Preordain's wording. Card images for the deciding seat need library cards in `view_names` (play.rs:1023-1039). Surveil, dig and reveal-until aren't drawn. Phone cards are 140 px, so scry 3 overflows a 390 px screen |
| Library search | GSearch / no phone board | 50 | `SearchChoice` game_state.rs:15561 (`count`, `up_to`, `allows_partial_find`, `constraint`, `split`), answered with `SelectCards`; then `SearchPartitionChoice` :15607. The sample's cap is 12 cards (`ai_support/candidates.rs:1495`) | Sampled list buttons. A search for 2 or more cards sees at most 12 | Partial for one card; none for 2 or more | "Find nothing" should show only with `up_to` or `allows_partial_find`. Not drawn: picking several ("Done (1/2)"), the Cultivate split, "with different names", and other players seeing "Sam is searching". The picked card turns white, not amber |
| Other choices | GChoices / GChoicesPhone | 35, 52 | `UnlessPayment` game_state.rs:16476, answered with `PayUnlessCost` actions.rs:628. `NamedChoice` :15938 (`choice_type`, `options`, `free_entry`), answered with `ChooseOption` :448. `DiscardToHandSize` :16021 with `SelectCards`. `CommanderZoneChoice` :17040 | "Pay the cost" and "Don't pay" (lib.rs:733); one button per named option (lib.rs:736); discards and the command-zone choice as sampled buttons | Partial | "For the rest of this game" (Rhystic Study) and "Always choose the command zone" have no engine auto-choice; the engine remembers only "may" triggers and replacement choices (actions.rs:348, 622, 789). Yama would have to answer for you and log each answer. The colour hint and the Pithing Needle advice are invented context. Name-a-card autocomplete needs names from Yama's card table. The phone board lacks the remember control, naming, colour and the command zone |
| Graveyard, exile and reveals | GZones / no phone board | 22 (and 52) | Zones in the state; `revealed_cards`; `CardsRevealed` events | Zone sheet: a grid with a name and type filter, newest first (Board.tsx:2019-2052), opened from the headers and piles (Board.tsx:1231-1237, 1690-1696). Reveals: none | Close for the graveyard and exile; none for reveals | Captions such as "Died in combat, turn 8" need per-card history from an event feed (PP-02). The reveal panel hides after 4 s; PP-52 says reveals stay until dismissed. There's no command zone or emblems tab. Today's sheet already works on a phone |
| A player knocked out | GKnockout / no phone board | 18, 61 | `PlayerEliminated { player_id }` types/events.rs:1617, with no reason | A narrow "Out" column (Board.tsx:1647-1662), the turn read from the log (Board.tsx:449), "You're out" (Board.tsx:953, 1217) | Partial | The cause ("21 commander damage from your Éowyn") isn't in the event; Yama must infer it from life, poison, commander damage or a concession. Your own knockout ("Keep watching", "Leave", PP-61) isn't drawn. The design uses a full-width strip at the top; today it's a column |
| Game over | GGameOver / GGameOverPhone | 61 | `GameOver { winner }` game_state.rs:15120; `GameEnd` :21155 | Title and "Back to Play online" (Board.tsx:945-948, 1001-1003); the winner's moment (BoardMotion.tsx:346) | Partial | Rematch and the stats (length, damage dealt) need new server work and events. "Watch the replay" points at PP-60, which doesn't exist. "Count toward group stats" is chosen when the game is created today (play.rs:483, 720), not afterwards. A draw isn't drawn |
| Game log, since your last turn | GLog / no phone board | 58, 59 | `GameLogEntry` segments, category and importance (`types/log.rs`) | Essential public lines flattened to text and trimmed to 60 (lib.rs:52, 885-897, 1019-1031); a log sheet and 3 recent lines (Board.tsx:1051-1064, 1272-1279) | Partial | The "Since your last turn" lines are summaries of board changes, non-events ("didn't attack") and advice ("Your spells will ask about paying {1}"). Nothing in the engine writes these. "42 → 36" needs life events. Hover-to-highlight needs the card ids that Yama flattens away. The filters differ from PP-58's. The "You" tag is amber |

BoardBase and BoardBasePhone are the backdrops for the dialog boards, not interactions of their own; their problems are listed under the consistency check.

## Engine decisions with no design

**The scale of the gap:**
- phase has about 140 kinds of `WaitingFor` (game_state.rs:14808-17474), and the boards draw about 20.
- Every other one still works in Yama through the index buttons: the AI's sampled options, labelled by `Match::label` (lib.rs:689-769). So nothing is unplayable, but it plays like a form, and some legal answers aren't in the sample.

**A generic design would cover most of them.** Rather than a board per decision, design the generic shapes that phase's interaction contract already uses (`InteractionResponseSpec`, `types/interaction.rs:958`), plus a yes/no strip:
- Select: pick N cards or objects;
- Sequence: put them in order;
- Relations: pair things up;
- AssignAmounts and AssignDamage: split a number;
- Number;
- Text: a name or other typed answer.

Each should show the source card, a plain question and a counter. Those few widgets cover nearly all of the list below.

**Likely in Bryan's games:**
- **"May" prompts:**
  - `OptionalEffectChoice` :16293, answered with `DecideOptionalEffect` actions.rs:607, or the remembering form `DecideOptionalEffectAndRemember` :622;
  - `OpponentMayChoice` :16352;
  - `ResolutionOptionalPaymentChoice` :16315;
  - `TributeChoice` :16333.

  PP-52 asks that the prompt say what the effect does ("Draw a card?"); GChoices draws only the unless-payment kind.
- **Choosing among replacement effects:** `ReplacementChoice` :15123, answered with `ChooseReplacement` actions.rs:344 or `ChooseReplacementAndRemember` :348. This comes up with token and counter doublers (Anointed Procession).
- **During payment:**
  - Treasure and other sacrificial mana: `ManaSourceSelection` :14899;
  - Phyrexian mana: `PhyrexianPayment` :17466;
  - convoke and delve: `TapForConvoke` actions.rs:686;
  - assist: `AssistChoosePlayer` :14912, `AssistPayment` :14926;
  - mana abilities that have costs: `PayManaAbilityMana` :16677, `ManaAbilityManaPayment` :16686;
  - choosing a colour of mana: `ChooseManaColor` :16695.
- **Extra and alternative costs:**
  - `OptionalCostChoice` :16029 (kicker);
  - `PayCost` :16627 (sacrifice or discard as a cost);
  - `ActivationCostOneOfChoice` :16641, `CostTypeChoice` :16652, `UnlessPaymentChooseCost` :16510;
  - ward: `WardDiscardChoice` :16540, `WardSacrificeChoice` :16556;
  - `UnlessBounceChoice` :16572, `CollectEvidenceChoice` :16702, `HarmonizeTapChoice` :16711, `BlightChoice` :16659, `DefilerPayment` :16069, `OrderCostReductions` :16100, `SpliceOffer` :16062.
- **Looking at the library:**
  - `SurveilChoice` :15538;
  - `DigChoice` :15398 ("look at the top N, take some");
  - `DigRestSplitChoice` :15461, `RevealChoice` :15542, `RevealUntilBottomOrder` :15335, `RevealUntilKeptChoice` :16723, `TopOrBottomChoice` :16753;
  - the Cultivate split: `SearchPartitionChoice` :15607;
  - `ManifestDreadChoice` :15874, `LearnChoice` :15868, `DrawnThisTurnTopdeckChoice` :15858, `MiracleReveal` :16345;
  - ripple: :15298 and :15314.
- **Choosing cards while an effect resolves:**
  - discards: `DiscardChoice` :15734, `ConniveDiscard` :15725;
  - `EffectZoneChoice` :15754, `ChooseFromZoneChoice` :15634, `ChooseObjectsSelection` :17081, `CategoryChoice` :17100;
  - `KeepWithinTotalPowerChoice` :17177, `KeepExactPermanentsChoice` :17205, `EachPlayerCopyChosenSelection` :17140, `BeholdChoice` :15657.
- **Counters and tokens:**
  - `ProliferateChoice` :17058, `PopulateChoice` :16758;
  - dividing counters: `MoveCountersDistribution` :17338, `RemoveCountersChoice` :17354, and the cost form `ChooseRemoveCounterCostDistribution` actions.rs:315;
  - `TimeTravelChoice` :17071, `PayAmountChoice` :17367 (energy), `ChooseTokenHost` :15235.
- **Targets beyond one card:**
  - any number of targets: `MultiTargetSelection` :16253;
  - dividing damage: `DistributeAmong` :17330;
  - new targets for copies: `CopyRetarget` :17239;
  - changing targets: `RetargetChoice` :17379;
  - a target of an opponent's choosing: `ChooseAnnouncingOpponent` :16802;
  - `SpellCopyOrderChoice` :15679.
- **Choosing an object that isn't a target:**
  - clones: `CopyTargetChoice` :15166;
  - `ReturnAsAuraTarget` :15205, `EquipTarget` :15244, `ExploreChoice` :15183, `DamageSourceChoice` :16005.
- **Choosing a player:**
  - `EntryControllerChoice` :15149, `ChooseGiftRecipient` :16049, `ClashChooseOpponent` :16768;
  - `ChooseFromZoneOpponentChooser` :16783, `SeparatePilesChooseOpponent` :16941.
- **Everyone takes part:**
  - votes: `VoteChoice` :16845, answered with `SubmitVoteCandidate` actions.rs:458 (Council's dilemma cards are Commander staples);
  - piles: `SeparatePilesPartition` :16968, `SeparatePilesChoice` :17003;
  - villainous choice: `ChooseOneOfBranch` :15686;
  - `OpponentGuess` :15976, `ClashCardPlacement` :16816, `RedistributeLifeTotals` :15358;
  - coin flips and dice: `CoinFlipKeepChoice` :15365, `DieKeepChoice` :15389, `PhysicalContest` :16834.
- **Combat extras:**
  - attack taxes such as Propaganda and Ghostly Prison: `CombatTaxPayment` :17448;
  - `ExertChoice` :15102, `EnlistChoice` :15113;
  - `CrewVehicle` :15250, `SaddleMount` :15277, `StationTarget` :15269;
  - `EntryAttackTargetChoice` :14839, `BattleProtectorChoice` :17051, `AssignBlockerDamage` :17320.
- **Permanents and rules:**
  - the legend rule: `ChooseLegend` :17031;
  - the ring-bearer: `ChooseRingBearer` :16580;
  - dungeons: `ChooseDungeon` :16602, `ChooseDungeonRoom` :16608;
  - `ChooseRoomDoor` :16591, `PairChoice` :16322, `CipherEncodeChoice` :16218, `ChoosePermanentTypeSlot` :16237;
  - meld: `MeldPairChoice` :14826, `MeldAttackTargetChoice` :14832;
  - untap choices: `UntapChoice` :15068, `ChooseUntapSubset` :15087.
- **Jace, Multiverse Architect:** `EmpowerJaceChoice` :15666 picks among Jace planeswalker tokens. This matters for the Multiverse Reforged deck Bryan bought.
- **Ways to cast, after you choose to cast:**
  - `CastOffer` :16123, whose kinds (`CastOfferKind`, game_state.rs:10991) are adventure, miracle, madness, paradigm, cascade and discover; cascade is answered with `CascadeChoice` actions.rs:715, discover with `DiscoverChoice` :704;
  - `ModalFaceChoice` :16139, `AlternativeCastChoice` :16164, `CastingVariantChoice` :16225;
  - mutate: `MutateMergeChoice` :16208. The engine supports mutate.
  - GCast's "a small menu opens" covers choosing between ways before casting, not these prompts.
- **Companion:** supported by the engine through `CompanionReveal` :17023, `DeclareCompanion` actions.rs:696 and `CompanionToHand` :702. Nothing is drawn for revealing a companion or paying to put it into your hand.
- **Mulligan extras:**
  - GMulligan picks the bottom cards but not their order;
  - Serum Powder (`UseSerumPowder`) isn't drawn.
- **Loops and Resolve all:**
  - loop shortcuts: `LoopShortcut` :16373, `RespondToShortcut` :16448, `PrecastCopyShortcutOffer` :16457, `RespondToPrecastCopyShortcut` :16465;
  - `RepeatDecision` :16746;
  - the other players' consent to "Resolve all": `ResolveAllConsent` :14814, `ResolveAllReady` :14820. GButtons offers "Resolve all", but not the prompt the other players then see.
- **Priority actions with no board:**
  - ninjutsu `ActivateNinjutsu` actions.rs:535 and foretell :184;
  - morph: `PlayFaceDown` :416, `TurnFaceUp` :436;
  - `Transform` :413 and hand order `ReorderHand` :279;
  - trigger yields (`SetPriorityYield` :782, PP-35) and the "may" auto-answers (`SetMayTriggerAutoChoice` :789);
  - conceding, `Concede` :961, which appears only in a footnote on GKnockout.

**Not needed in Commander:**
- between-games choices: `BetweenGamesSideboard` :15912, `BetweenGamesChoosePlayDraw` :15932;
- Alchemy: `SpellbookDraft` :15995, `SpecializeColor` :16616;
- Planechase: `ArrangePlanarDeckTopChoice` :15349;
- Tiny Leaders: `OpeningHandBottomCards` :14884.

## Consistency check

The five rules are in `design/README.md:41-46`.

### One main button

The boards that keep this rule:
- GMulligan, GTarget, GAttack, GBlock, GKnockout and GGameOver, with one primary each;
- the phone boards.

**Dialog boards show two main buttons.** These boards import BoardBase, whose rail button stays visible beside the dialog, and give the dialog its own primary as well:

| Board | Dialog's own buttons | Rail's buttons |
|---|---|---|
| GModes | "Next" and "Choose targets" | "Next" |
| GTriggers | "Done" | "Done" |
| GDamage | "Done" | "Done" |
| GScry | "Done, draw" | "Done" |
| GSearch | "Reveal Monastery Mentor" | "Done" and "Find nothing" |

The overlay covers only the left 1100 px, so the rail button looks live.

**GPay doubles both buttons:** "Pay the rest for me" and "Cancel" in the panel, beside "Pay the rest" and "Cancel the spell" in the rail.

**Fix:** either the dialog's button is the main button and the rail button hides, or the dialog has no confirm and the rail's button confirms. Bryan should pick one (question 6).

**GButtons is incomplete as "every state".** It lists 12 states. It leaves out:
- may prompts, modes, X, and the trigger, scry, search and damage confirms;
- spectators, "you're out", and a draw.

### Choices on the board

The boards that put choices on the board:
- GTarget, GAttack, GBlock and GPay on a laptop, each drawing its own board at fixed positions;
- GCombatView.

GBlock improves on today's board: the attackers move into an "Attacking you" lane.

The boards that use a dialog where the choice is about something on the board:
- **GDamage** splits damage among blockers that are on the board.
- **GChoices** discards from the hand.
- **GTriggers** orders triggers whose sources are on the board. This one is defensible, since the triggers aren't permanents.

Library and mode choices rightly use dialogs. The phone boards use sheets throughout, which is reasonable at 390 px.

### Amber means pickable; your arrows are blue

**It holds on:** GTarget, GTargetPhone and GBlock (attackers turn amber once a blocker is picked), and GAttack, GBlock and GTarget (your arrows are blue).

**It breaks in these places:**
- **Amber used for things you can't pick:**
  - GCast's "Will tap" preview;
  - GDamage's "Survives" tag;
  - GLog's "You" tag;
  - the GInspector commander note;
  - GAttack's commander-damage warning.
- **Amber used for picked cards:** cards sent to the bottom in GMulligan, and discards in GChoices. Meanwhile GSearch marks its picked card white.
- **Pickable but not amber:** pickable mana sources in GPay are green.

**The root cause is `design/tokens.md`.** It defines amber as `--warn` ("need it, waiting", line 18) and as the stop colour (line 22), and it makes "has options" green (line 115). Today's code follows the tokens:
- green for playable cards (board.css:193-196);
- amber for targets (board.css:214-235);
- red attack arrows, white block arrows and amber aim arrows (board.css:1946-1974).

One rule needs choosing (question 1).

**Seat colours clash with status colours.** The seat colours exist only in the boards (`--sam #f08a70`, `--jules #6fd49a`, `--me #6cb0f5`, and `#f1e4bc` for the computer); they aren't in `tokens.md`:
- Sam's is nearly `--bad` (`#f07a62`).
- Jules's is nearly `--good` (`#8fd3a8`), which makes a red/green pair; PP-65 asks for a palette without one.
- The computer's is the white mana fill used for "Add white" in GCast.
- Your blue is close to `--stop-opp` (`#7fb0ff`), which means "opponents' turns" in the stop ladder.
- Nothing is drawn for 5 or 6 seats.

### Nothing commits until you press; Esc backs out

**Holds in:** GAttack, GBlock, GTriggers, GScry, GSearch and GDamage, where the plan stays in the browser until confirmed. GTarget holds too, for the current slot only (see the table).

**Breaks in these places:**
- **GPay.** Each tap is a real engine action that puts mana into your pool. Only pure mana can be undone (`game/mana_sources.rs:281`), so a painland or a Treasure is committed the moment you click.
- **Right-click has two jobs.** "Right-click backs out" (README; GTarget's rail) conflicts with "right-click reads a card" (GCast, GChoices, GZones, GInspector, PP-23, and today's `Tiles.tsx:52-57`).
- **Space has two jobs.** GInspector's "press Space while pointing at a card" conflicts with Space as the main button (GButtons, GPriority, `Board.tsx:354-367`).
- **Today's code clears your work on every new board.** Any new revision clears a plan or selection in progress (`Board.tsx:292-308`, PP-06). Rule 4 needs that fixed for mulligans and other simultaneous decisions.
- **Esc is mentioned only on** GCast, GTarget, GAttack ("Esc clears") and GInspector.
- **No phone board mentions the Android back gesture** (PP-69), except the inspector's "Swipe down".

### Card art credits the artist

Credits are present on:
- laptop opponent headers ("Art: name");
- GTriggers rows;
- GKnockout's strip;
- GGameOver;
- GScry, GSearch and GChoices (the source card);
- GInspector and GInspectorPhone.

**Missing credits:**
- **Your own portrait.** Your commander's art crop in the portrait (BoardBase.dc.html:92; GPay, GTarget, GAttack, GBlock, GRespond) never names Craig Elliott.
- **Battlefield tiles.** The art crops on tiles (Grave Titan, Adeline, the lands, Sol Ring and so on) are credited nowhere on the laptop boards. `tokens.md:95` wants the credit, or the full card, in the same view. PP-13 relies on "the full card is one hover away", which is weaker than Scryfall's "same interface" rule. Today the app credits only the commanders' artists (`Board.tsx:941`). This applies to the whole board, not just these mocks.
- **Phone boards.** GTargetPhone, GAttackPhone, GBlockPhone and GMulliganPhone use art crops on tabs and tiles with no credit line. BoardBasePhone and GGameOverPhone have one.
- **Other crops:**
  - GLog's rows (its footer names no artists);
  - GCast's Command Tower menu;
  - GDamage's Terra row.

### Phone parity

**Phone boards exist for:** mulligan, paying, targets, responding, reading a card, attackers, blockers, scry, other choices and game over.

**No phone board for:**
- the stops and pass modes (PP-33's sheet, PP-69's long-press on the portrait);
- the casting gestures (PP-25's flick up; PP-68's hand drawer);
- modes and X, trigger order, the damage split, others' combat, search, zones, knockouts and the log.

**Most serious:** no board shows how to play a card from your hand on a phone. GInspectorPhone ends in "Point at it" and "Close", with no option buttons. Today a tap opens the card with its options (`Board.tsx:571`, `1149-1156`), and that is the only way to play on a phone, because drag is laptop-only (`Board.tsx:616`).

**Smaller gaps:**
- The phone version of "Other choices" lacks the "rest of this game" control, card naming, colour and the command zone.
- Phone scry overflows at 3 cards.

### Other cross-board points

- **A wrong PP number.** The README's table maps GRespond to PP-45. PP-45 is the combat "If no one responds" preview, which GAttack's lethal note and GBlock's "Outcomes assume no tricks" partly answer.
- **Undrawn layouts:** a spectator view (PP-32: no primary button) and 5- and 6-seat layouts.
- **Undrawn states:**
  - you yourself knocked out (PP-61);
  - a drawn game;
  - the "harmful spell on your own creature" warning (PP-37);
  - "No attacks" asking twice (PP-37).
- **Copy that needs another look:**
  - "Undo is no longer possible" used as a button (GPay);
  - "Start over" resets the whole mulligan, not just the tray (GMulligan);
  - "Done, draw" is specific to Preordain (GScry);
  - "Hand priority on" (GPriority);
  - "Saved for next time" appears before submitting (GTriggers);
  - "You still get priority in each combat step" (GCombatView).
- **A looping animation.** GCombatView's pulse loops forever. That's at odds with PP-28's "no looping pulse", and with reduced motion if it isn't switched off there.
- **Plain style rules hold.** No board uses middle dots or all-caps labels.

## Build plan

Each slice ships on its own and leaves the game playable. They are ordered by how much they improve play. S, M and L are the PP document's effort sizes.

### 1. A fix pass (S)

**What:**
- Label activated abilities from the ability's text and cost, and stop merging options that point at different abilities. This makes a planeswalker's three abilities reachable (PP-04).
- Label the payment step "Pay the rest" and "Cancel" instead of "Resolve".
- "Let it resolve" for an opponent's spell; "Resolve" for yours.
- "Keep N" from the engine's owed bottom cards.
- Keep a plan or selection in progress across new boards that don't change your decision (PP-06).
- Recolour the arrows once the colour rule is settled.

**Files:** `lib.rs` (689-769, plus a mulligan count), `model.ts` (270-288), `Board.tsx` (292-308, 496, 890-899, 1955-1957), `board.css` (1946-1974), `DragLayer.tsx` (99-110), and tests in `model.test.ts`.

### 2. One path for real answers (M)

**What:**
- **A generic `act` message.** It carries a whitelist of `GameAction` kinds: `SelectCards`, `OrderTriggers`, `SelectModes`, `ChooseX`, `ChooseTarget`, `CancelCast`, `PayUnlessCost`, `DecideOptionalEffect`, `ChooseOption`, `ChooseReplacement`, `AssignCombatDamage`, `DistributeAmong`, and later the mana actions. Each answer is checked against the expected `WaitingFor` and applied to a copy first, exactly as `declare` already does for attacks and blocks (`lib.rs:624-647`).
- **A `pending` payload on `Decision`.** It carries the seat's filtered `WaitingFor` in Yama's own small types: cards, count, min and max, `up_to`, mode text, X previews, trigger summaries, and blockers with their lethal minimums.
- **Library cards for the deciding seat.** Add the cards in the current decision to `view_names` (`play.rs:1023-1039`).
- **Soak coverage** that drives seats through `act` (`play/src/bin/soak.rs`).

phase's own interaction contract (`derive_viewer_interaction`, `game/interaction.rs:8898`; `submit_interaction_with_rejection`, `:11613`) is the fuller answer (L). Adopt it later, once these widgets show which shapes matter.

**Files:** `lib.rs`; `play.rs` (`ClientMessage::Act` and `Cmd::Act`, next to `Attack` and `Block` at lines 70-83 and 988-997); `types.ts`.

### 3. Card choices (M)

**What:** one card-picker widget that picks N of M, with a counter, an optional order and two piles. It serves:
- GScry and GScryPhone, including surveil, dig and reveal;
- GSearch, including multi-card searches and the "find nothing" rule;
- the GMulligan bottom tray;
- discards in GChoices.

This slice fixes the "can't make legal plays" gaps for scry and tutors.

**Reuse:** the FLIP card flights in `BoardMotion.tsx` for cards moving between piles, `HandCard` and the `Sheet` component.

**Files:** a new `web/src/play/CardChoice.tsx`, `Board.tsx` (`DecisionBody`, 1861-2016), `board.css`.

### 4. Stack and targets (M)

**What:**
- **Richer stack items** from `derive_filtered_views` (`game/derived_views.rs:2110`): text, targets and controller, so `StackView` and the stack list gain target chips (PP-03, PP-46).
- **GTarget:** the banner, the count, numbered marks, a confirm per slot, Cancel through `CancelCast`, blue arrows, and token piles that open up while targeting.
- **GRespond:** "Targeted by" badges and other players' targets drawn in their seat colour.

**Reuse:** almost all of the 2026-10-22 work:
- `targetIndex` and `targetDrop` (`drag.ts:93-126`);
- `aimTo`, `aimOrigin` and the parked card (`Board.tsx:625-660`);
- `PlanArrows`, with one new tone per seat;
- the spotlight (`BoardMotion.tsx:289-314`).

**Files:** `lib.rs` (`view_of`, 936-1016), `types.ts`, `Board.tsx` (`StackList`, the aiming code), `DragLayer.tsx`, `board.css`.

### 5. Combat polish (M)

**What:**
- **GAttack:** "everything at" each opponent, and the defender chips.
- **GBlock:** the incoming lane, and simple outcome numbers (damage through, life after, commander damage).
- **GCombatView:** everyone's combat drawn with arrows. This needs `blocker_to_attacker` on each card.
- **Constraint badges and menace chips.** Send `attacker_constraints` and `block_requirements` (`lib.rs:517-550`).
- **Keywords for deathtouch.** Add keywords from the derived views' `battlefield_keyword_badges`.

**Reuse:** nearly everything from 2026-10-22: `toggleAttack`, the attack and block drags, `PlanArrows`, `combatLines`, and the life `Tick` with its float.

**Files:** `lib.rs`, `model.ts`, `Board.tsx`, `board.css`.

### 6. Turn controls (M; L if moved onto the engine's own pass sessions)

**What:**
- GPriority's pass-mode menu, with Enter, Shift+Enter and P.
- "Resolve all".
- Stops and full control saved per user on the server.
- The GButtons labels.
- A phone sheet for stops and pass modes.

**First, decide** whether Yama's own pass layer stays (`lib.rs:777-839`) or the engine's `SetAutoPass` sessions take over.

**Files:** `lib.rs`; `play.rs` (a `prefs` message and per-user settings in a new migration); `Board.tsx` (`Ladder` and the controls); `model.ts`.

### 7. Modes, X, trigger order and other prompts (M)

**What:**
- **GModes:** mode tiles from `mode_descriptions`, multi-select, and an X stepper with `x_cost_previews` and Max.
- **GTriggers:** an ordered list with drag handles, plus arrows on a phone.
- **GChoices:** unless-payments, named choices with free entry and card-name search, the command zone, and "may" prompts with "remember" where the engine supports it.

**Builds on:** the `act` path from slice 2.

**Files:** a new `web/src/play/Prompts.tsx`, `Board.tsx`, and the payload in `lib.rs`.

### 8. Damage split (S)

**What:** GDamage's steppers, filled in with the engine's default split. The same widget serves `DistributeAmong` and `AssignBlockerDamage`.

**Files:** `Prompts.tsx` and `Board.tsx`.

### 9. Paying by hand (L)

**What:**
- Mana abilities per object, from `legal_actions_for_viewer` (`ai_support/mod.rs:2608`, PP-04's `by_object`).
- Tapping and untapping on the board.
- Pool chips; "Pay the rest" and "Cancel".
- The "Tap mana for me" setting, sending `CastSpell.payment_mode` through `act`.
- The Treasure prompt (`ManaSourceSelection`).
- GCast's auto-tap preview (`preview_auto_payment_sources`, `game/preview.rs:204`, rate-limited).

**Files:** `lib.rs`, `play.rs`, `Board.tsx`, and a new `PaymentPanel.tsx`.

### 10. Inspector, zones and reveals (M)

**What:**
- GInspector, without the "In plain words" tab until Bryan picks where that text comes from. It keeps the option buttons, and adds keywords and a flip button.
- GZones' tabs, including the command zone.
- A reveal overlay. This needs the revealed cards in the View.

**Files:** `Board.tsx` (`Inspector` 2054-2101, `ZoneSheet` 2019-2052), `lib.rs` (`view_of`), `Tiles.tsx`.

### 11. Event feed and endings (L)

**What:**
- **PP-02's per-seat events:** keep `ActionResult.events` in `accepted` (`lib.rs:885-897`) and filter them with `filter_events_for_viewer` (`game/visibility.rs:3245`).
- **Then the screens that need them:**
  - GLog's rich lines, and a factual "since your last turn" with no advice;
  - GZones' "how it got here" captions;
  - GKnockout's cause, and your own knockout;
  - GGameOver's stats and Rematch.

**Reuse:** `BoardMotion.tsx` can move from comparing boards to playing events one piece at a time.

**Files:** `lib.rs`, `play.rs` (a ring buffer per match), and the log and end-of-game components.

### Phone work

Each slice ships the phone versions the design has. Two phone items need a design decision first:
- how to play a card from the hand (question 5);
- the stops and pass-modes sheet.

## Questions for Bryan

1. **Colours.** Should amber mean "pick this" (the README) or "warning" (`tokens.md`)? Suggested: green for "you can play or use it", amber for "pick it for this choice", and an icon plus wording for warnings.
2. **Seat colours.** May the seat colours become a fixed, colour-blind-safe palette that keeps away from the red and green status colours (PP open question 5)?
3. **Generated text.** Who writes the "In plain words" card summaries and the "since your last turn" digest? The options are:
   - hand-written;
   - an AI summary per card, cached (this shares your Claude limit);
   - drop them, and show the Oracle text and plain log facts instead.
4. **Answers Yama would give for you.** "Always pay" for Rhystic Study and "always the command zone" aren't engine features. May Yama answer for you, logging each answer?
5. **Playing a card on a phone.** Keep today's tap that opens the card with its options, add flick-up, or both? The phone inspector design removes the options.
6. **Dialogs.** Should a dialog's own button be the main button (with the rail's hidden), or should every confirm come from the rail?
7. **Right-click and Space.** Should right-click back out, or read a card? And should Space only ever press the main button?
8. **Your own spell on the stack.** Should it resolve without asking (PP-07), or stop with "Resolve" and "Resolve all" (GButtons)?
