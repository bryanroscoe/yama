# phase parser work queue (Commander corpus)

Generated 2026-10-24 from `data/engine/card-data-eb309108eb0df708.json` (phase's card export) and the Commander corpus in `/tmp/corpus-cards.json` (174 distinct precon lists from the lab database plus the owner's 10 decks; 6,547 cards). No phase code was changed and nothing was built.

## Totals

- 412 corpus cards carry at least one `Unimplemented` node. Between them they have 502 nodes; 400 cards have one gap pattern and 12 have two or more, so they need several fixes before they are complete.
- Deck weight is the number of corpus decks that play the card: 547 deck-slots in total. The long tail dominates: 325 of the 412 cards are in one deck only. The heaviest are Study Hall (12 decks), Forge of Heroes (7), Kazuul (6), Windgrace's Judgment, Ichor Elixir and Fractured Powerstone (5 each), then Voice of Many, Stalking Leonin, Reins of Power, Hate Mirage and Dire Fleet Daredevil (4 each).
- The nodes fall into 71 patterns, a batch of 16 small parser one-offs, and 35 singleton cards that need their own engine work (at the end).
- Most gaps are in the parser. The engine already has the effect for most patterns: votes, clash, dice with modifiers, coin-flip-until-lose, energy and rad counters, `ForEachCategory`, goad, piles, planar die, `CommanderCastFromCommandZoneCount`. Patterns that need real engine work are marked.

**Ranking.** Patterns are ordered greedily. Each step takes the pattern with the best (deck weight of cards it newly completes, plus a quarter of the deck weight of every card it touches) / effort, where S = 1, M = 3, L = 8. A card counts as complete only when all its nodes are fixed, so a pattern can rise once an earlier one has cleared a card's other gap. "Completes" in each section means the cards that pattern finishes at that point in the queue. Effort is a reading of the parser, not a measurement. Engine: "parser" means existing engine types should be enough; "small engine" means a new enum leaf or tracked counter; "engine" means a new game mechanic.

**Checking a fix.** Re-export the card data and re-run the extraction: walk every card in `/tmp/corpus-unimplemented.json` for `{"type": "Unimplemented"}` nodes. Card counts across the whole card pool (not just the corpus) are quoted where they show that a shape fails everywhere.

## Queue

| # | Pattern | Effort | Engine | Cards touched (decks) | Completes (decks) |
|---|---|---|---|---|---|
| 1 | [IF_ITS_A](#1-if_its_a) | S | parser | 7 (20) | 7 (20) |
| 2 | [COMMANDER_CAST_COUNT](#2-commander_cast_count) | S | parser | 3 (15) | 3 (15) |
| 3 | [PUT_COUNTERS_EACH](#3-put_counters_each) | S | parser | 10 (13) | 8 (10) |
| 4 | [PLAYER_POP_QTY](#4-player_pop_qty) | S | parser | 7 (10) | 7 (10) |
| 5 | [ADDED_TYPES](#5-added_types) | S | parser | 8 (10) | 7 (9) |
| 6 | [EVENT_DAMAGE_QTY](#6-event_damage_qty) | S | parser | 8 (8) | 8 (8) |
| 7 | [COND_STATE](#7-cond_state) | M | parser+small engine | 15 (22) | 15 (22) |
| 8 | [QTY_GRAMMAR](#8-qty_grammar) | M | parser | 16 (21) | 15 (20) |
| 9 | [MISC_SMALL](#9-misc_small) | S×n | parser (a few need a small engine leaf) | 16 (18) | 16 (18) |
| 10 | [COND_HISTORY](#10-cond_history) | M | parser+small engine | 15 (18) | 14 (17) |
| 11 | [CAST_FROM_GY_STATIC](#11-cast_from_gy_static) | M | parser+small engine | 13 (16) | 13 (16) |
| 12 | [INSTEAD_UPGRADE](#12-instead_upgrade) | S | parser+small engine | 5 (6) | 4 (5) |
| 13 | [MANA_RESTRICT](#13-mana_restrict) | S | parser+small engine | 5 (5) | 5 (5) |
| 14 | [CAST_RIDER_EXILE_INSTEAD](#14-cast_rider_exile_instead) | S | parser | 2 (5) | 2 (5) |
| 15 | [NAMED_TOKEN](#15-named_token) | S | parser+small engine | 4 (5) | 4 (5) |
| 16 | [GOAD](#16-goad) | S | parser+small engine | 4 (5) | 4 (5) |
| 17 | [SUBJECT_BINDING](#17-subject_binding) | M | parser (Reins of Power also needs mass exchange of control) | 8 (14) | 8 (14) |
| 18 | [PLAYER_COUNTERS](#18-player_counters) | M | parser+small engine | 14 (14) | 12 (12) |
| 19 | [FLIP_UNTIL_LOSE](#19-flip_until_lose) | S | parser | 4 (4) | 4 (4) |
| 20 | [VOTE_DILEMMA](#20-vote_dilemma) | S | parser | 3 (4) | 3 (4) |
| 21 | [COMPOUND_VERB](#21-compound_verb) | S | parser | 4 (4) | 4 (4) |
| 22 | [ANIMATE_X](#22-animate_x) | S | parser | 2 (4) | 2 (4) |
| 23 | [PER_PLAYER_TARGET](#23-per_player_target) | M | parser | 7 (12) | 6 (11) |
| 24 | [PLANAR](#24-planar) | M | parser+small engine | 3 (11) | 3 (11) |
| 25 | [RELATIVE_PLAYER_SUBJECT](#25-relative_player_subject) | M | parser | 6 (11) | 6 (11) |
| 26 | [EACH_PLAYER_CHOOSES](#26-each_player_chooses) | M | parser | 8 (11) | 8 (11) |
| 27 | [KEYWORD_COST](#27-keyword_cost) | M | parser+engine | 11 (11) | 10 (10) |
| 28 | [COMBAT_RESTRICT_PLAYER](#28-combat_restrict_player) | M | parser+small engine | 5 (9) | 5 (9) |
| 29 | [OTHERWISE](#29-otherwise) | M | parser | 8 (9) | 8 (9) |
| 30 | [ACTIVATION_RESTRICT](#30-activation_restrict) | S | parser | 3 (3) | 3 (3) |
| 31 | [REFLEXIVE_THIS_WAY](#31-reflexive_this_way) | M | parser | 8 (9) | 8 (9) |
| 32 | [X_CONSTRAINT](#32-x_constraint) | S | parser+small engine | 3 (3) | 3 (3) |
| 33 | [MUTATE_COUNT](#33-mutate_count) | S | parser+small engine | 3 (3) | 3 (3) |
| 34 | [COST_MOD](#34-cost_mod) | M | parser+small engine | 8 (9) | 8 (9) |
| 35 | [CLASH](#35-clash) | S | parser | 2 (3) | 2 (3) |
| 36 | [PAY_ANY_AMOUNT](#36-pay_any_amount) | M | parser+small engine | 6 (9) | 6 (9) |
| 37 | [VOTE_SECRET](#37-vote_secret) | M | parser+small engine | 8 (8) | 8 (8) |
| 38 | [ENTERS_WITH_OTHERS](#38-enters_with_others) | M | parser | 5 (8) | 5 (8) |
| 39 | [UNLESS_NONMANA](#39-unless_nonmana) | M | parser+small engine | 5 (7) | 5 (7) |
| 40 | [FOR_EACH_CATEGORY](#40-for_each_category) | M | parser | 6 (7) | 6 (7) |
| 41 | [FACE_DOWN](#41-face_down) | M | parser+engine | 5 (7) | 5 (7) |
| 42 | [FOR_EACH_OF_THOSE](#42-for_each_of_those) | M | parser | 4 (7) | 4 (7) |
| 43 | [REPEAT_PROCESS](#43-repeat_process) | M | parser+small engine | 5 (7) | 5 (7) |
| 44 | [CHOOSE_VALUE](#44-choose_value) | M | parser+small engine | 7 (7) | 7 (7) |
| 45 | [DICE_D20_ADD](#45-dice-d20-add) | S | parser | 3 (3) | 2 (2) |
| 46 | [CHOOSE_CONSTRAINED](#46-choose_constrained) | M | parser+small engine | 6 (6) | 6 (6) |
| 47 | [COPY_PER_TARGET](#47-copy_per_target) | M | parser | 6 (6) | 6 (6) |
| 48 | [TURN_ORDER_CHOICE](#48-turn_order_choice) | M | parser+small engine | 5 (6) | 5 (6) |
| 49 | [IMPRINT_X](#49-imprint_x) | S | parser+small engine | 2 (2) | 2 (2) |
| 50 | [PILES](#50-piles) | M | parser+small engine | 3 (6) | 3 (6) |
| 51 | [ENTERS_WITH_COMPUTED](#51-enters_with_computed) | M | parser+small engine | 5 (6) | 5 (6) |
| 52 | [GRANT_CASCADE](#52-grant_cascade) | S | parser+small engine | 2 (2) | 2 (2) |
| 53 | [LIBRARY_POSITION](#53-library_position) | S | parser | 1 (2) | 1 (2) |
| 54 | [REVEAL_UNTIL](#54-reveal_until) | S | parser | 1 (2) | 1 (2) |
| 55 | [SECRET_CHOSEN_PLAYER](#55-secret_chosen_player) | M | parser+engine | 3 (6) | 3 (6) |
| 56 | [IMPULSE_FREE](#56-impulse_free) | S | parser | 2 (2) | 2 (2) |
| 57 | [COMBAT_REQUIREMENT](#57-combat_requirement) | M | parser+small engine | 6 (6) | 5 (5) |
| 58 | [DICE_ENDEAVOR](#58-dice_endeavor) | M | parser+small engine | 5 (5) | 5 (5) |
| 59 | [EMBLEM](#59-emblem) | M | parser+small engine | 5 (5) | 5 (5) |
| 60 | [MANA_CONCESSION](#60-mana_concession) | M | parser | 3 (4) | 3 (4) |
| 61 | [GAIN_ABILITIES_OF](#61-gain_abilities_of) | M | parser+small engine | 3 (4) | 3 (4) |
| 62 | [SUSPEND](#62-suspend) | M | parser+small engine | 3 (3) | 3 (3) |
| 63 | [AGGREGATE_MV_SELECTION](#63-aggregate_mv_selection) | M | parser+small engine | 2 (3) | 2 (3) |
| 64 | [AURA_ATTACH](#64-aura_attach) | M | parser+small engine | 3 (3) | 3 (3) |
| 65 | [MANA_SPEND_TRIGGER](#65-mana_spend_trigger) | M | parser+small engine | 2 (3) | 2 (3) |
| 66 | [DICE_MULTI](#66-dice_multi) | M | parser+small engine | 3 (3) | 3 (3) |
| 67 | [FORETELL](#67-foretell) | M | parser+small engine | 3 (3) | 3 (3) |
| 68 | [COMBAT_CONTROL](#68-combat_control) | L | parser+engine | 4 (6) | 4 (6) |
| 69 | [REDIRECT_ATTACK](#69-redirect_attack) | L | parser+engine | 3 (6) | 3 (6) |
| 70 | [VOTE_AGREEMENT](#70-vote_agreement) | M | parser+engine | 2 (2) | 2 (2) |
| 71 | [PER_OPPONENT_PILE](#71-per_opponent_pile) | M | parser+small engine | 2 (2) | 2 (2) |
| 72 | [TEXT_CHANGE](#72-text_change) | L | parser+engine | 2 (3) | 2 (3) |

### 1. IF_ITS_A

**Pattern:** Type check on the referred object: '… if it's a creature', '… and a loyalty counter on it if it's a planeswalker', 'If it's a land card or a creature card with …'

**Effort:** S. **Engine:** parser. **Nodes:** 7 (`unparsed_verb_arguments`×3, `unrecognized_clause_head`×2, `put_counter_tail`×1, `unparsed_condition`×1).

**Cards (7, 20 deck-slots; completes 7 for 20):** Forge of Heroes (7); Nissa, Steward of Elements (3); Trail of Mystery (3); Druidic Satchel (2); Temur War Shaman (2); Semester's End (2); Salt Road Ambushers (1)

**Examples:**

- Forge of Heroes: "Put a +1/+1 counter on it if it's a creature and a loyalty counter on it if it's a planeswalker."
- Nissa, Steward of Elements: "If it's a land card or a creature card with mana value less than or equal to the number of loyalty counters on Nissa, you may put that card onto the battlefield."
- Trail of Mystery: "Whenever a permanent you control is turned face up, if it's a creature, it gets +2/+2 until end of turn."

**Where:** 'If it's a creature card, …' as a leading sentence already works (Deadbridge Chant). Three cards (Trail of Mystery, Temur War Shaman, Salt Road Ambushers) share one trigger shape, 'Whenever a permanent you control is turned face up, if it's a creature, …', which fails on all 4 cards in the pool that use it. The intervening 'if' isn't split off the turned-face-up trigger (`oracle_trigger.rs`). Druidic Satchel's 'If it's a noncreature, nonland card' splits at the comma. The rest are trailing-clause and per-conjunct forms ('Put a +1/+1 counter on it if it's a creature and a loyalty counter on it if it's a planeswalker'). Belongs in the inline-condition split in `oracle_effect/conditions.rs` and the counter-placement tail in `oracle_effect/counter.rs` / `imperative.rs` (`put_counter_tail`). Lower each conjunct to a sub-ability gated on a type condition.

**CR:** 608.2c, 205.2a (card types), 122.1

### 2. COMMANDER_CAST_COUNT

**Pattern:** 'the number of times it's been cast from the command zone' / 'for each time they've cast a commander'

**Effort:** S. **Engine:** parser. **Nodes:** 3 (`unparsed_quantity`×2, `static_structure`×1).

**Cards (3, 15 deck-slots; completes 3 for 15):** Study Hall (12); Commander's Insight (2); Myth Unbound (1)

**Examples:**

- Study Hall: "When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game."
- Commander's Insight: "Target player draws X cards plus an additional card for each time they've cast a commander from the command zone this game."
- Myth Unbound: "Your commander costs {1} less to cast for each time it's been cast from the command zone this game."

**Where:** `QuantityRef::CommanderCastFromCommandZoneCount` exists and 'for each time you've cast your commander from the command zone' already parses (Skull Storm, Jyoti, Vanguard of the Restless). 'The number of times it's been cast from the command zone this game' is only matched as a literal inside Opal Palace's 'if you spend this mana' rider (`oracle_effect/mana.rs`, around line 2562), so Study Hall's 'scry X, where X is …' misses it. Move the phrase into `oracle_nom/quantity.rs`, then add 'they've cast a commander' (target player, Commander's Insight) and the 'costs {1} less for each time it's been cast' cost-mod (Myth Unbound, `oracle_static/cost_mod.rs`). `parse_mana_spend_trigger` already admits Scry bodies.

**CR:** 903.8 (commander tax counts casts from the command zone), 106.6 (mana with a triggered rider), 601.2f

### 3. PUT_COUNTERS_EACH

**Pattern:** Counter placement tails: '… and five loyalty counters on each other planeswalker you control', '… and three +1/+1 counters on target creature an opponent controls', 'on each permanent you control that's a creature or Vehicle', 'on each artifact that became a creature this way', 'on your Ring-bearer', 'for each creature card among those cards'

**Effort:** S. **Engine:** parser. **Nodes:** 10 (`put_counter_tail`×8, `unrecognized_clause_head`×2).

**Cards (10, 13 deck-slots; completes 8 for 10):** Ao, the Dawn Sky (2) [also needs AGGREGATE_MV_SELECTION]; Evolutionary Escalation (2); Ajani Unyielding (2); Rise and Shine (1); Animal Friend (1); Cait, Cage Brawler (1) [also needs SUBJECT_BINDING]; Garruk, Cursed Huntsman (1); Journey to the Lost City (1); Shaile, Dean of Radiance (1); Galadriel, Elven-Queen (1)

**Examples:**

- Ao, the Dawn Sky: "• Put two +1/+1 counters on each permanent you control that's a creature or Vehicle."
- Evolutionary Escalation: "At the beginning of your upkeep, put three +1/+1 counters on target creature you control and three +1/+1 counters on target creature an opponent controls."
- Ajani Unyielding: "[−9]: Put five +1/+1 counters on each creature you control and five loyalty counters on each other planeswalker you control."

**Where:** `oracle_effect/imperative.rs` (the `put_counter_tail` gap at the `PutImperativeAst::Unimplemented` site) and `oracle_effect/counter.rs`. Split 'put A on X and B on Y' into two `PutCounter`/`PutCounterAll` nodes, and accept the extra filters (Ring-bearer, 'became a creature this way', 'entered the battlefield under your control this turn').

**CR:** 122.1, 122.6, 701.54 (Ring-bearer)

### 4. PLAYER_POP_QTY

**Pattern:** 'for each opponent who controls fewer creatures than you', 'who has less life than you', 'who controls one or more of those permanents', 'each player who was dealt combat damage', 'with three or more poison counters', 'players who control at least two more lands than you'

**Effort:** S. **Engine:** parser. **Nodes:** 8 (`unparsed_quantity`×6, `unparsed_verb_arguments`×1, `where_x_binding`×1).

**Cards (7, 10 deck-slots; completes 7 for 10):** Voice of Many (4); Sudden Salvation (1); Vivien's Stampede (1); Wurmquake (1); Surveyor's Scope (1); Birth of the Imperium (1); Great Unclean One (1)

**Examples:**

- Voice of Many: "When this creature enters, draw a card for each opponent who controls fewer creatures than you."
- Sudden Salvation: "You draw a card for each opponent who controls one or more of those permanents."
- Vivien's Stampede: "At the beginning of the next main phase this turn, draw a card for each player who was dealt combat damage this turn."

**Where:** `oracle_quantity.rs::parse_for_each_opponent_player_attribute_clause` already builds `QuantityRef::PlayerCount { PlayerFilter::PlayerAttribute }` for hand size, life total, cards drawn and battlefield entries. Add attribute arms for 'controls <filter> count compared to you', comparative life, poison counters and 'was dealt combat damage this turn' (the opponent form exists). No engine work expected.

**CR:** 109.5, 122.1f (poison), 120 (damage)

### 5. ADDED_TYPES

**Pattern:** Anaphoric type/colour setting: 'They're black Zombies in addition to their other colors and types', 'It's a Spirit Detective', '~ is every nonbasic land type', '~ is all colors', 'Lands you control and land cards you own … are Deserts'

**Effort:** S. **Engine:** parser. **Nodes:** 8 (`unrecognized_clause_head`×5, `effect_structure`×2, `unknown`×1).

**Cards (8, 10 deck-slots; completes 7 for 9):** Planar Nexus (2); Grimoire of the Dead (2); Fallaji Wayfarer (1); Ghouls' Night Out (1); Afterlife from the Loam (1) [also needs PER_PLAYER_TARGET]; The War in Heaven (1); Dune Chanter (1); Otherworldly Escort (1)

**Examples:**

- Planar Nexus: "This land is every nonbasic land type."
- Grimoire of the Dead: "They're black Zombies in addition to their other colors and types."
- Fallaji Wayfarer: "Fallaji Wayfarer is all colors. This ability doesn't affect its color identity."

**Where:** `oracle_static/type_change.rs` covers the static forms; these are the effect-chain sentences after a return/create that refer back to 'they/it'. Add an anaphoric `Animate`/type-add lowering in `oracle_effect/animation.rs`. 'Every nonbasic land type' needs a land-type set constant (CR 205.3i). Dune Chanter's 'cards you own that aren't on the battlefield' needs an off-battlefield affected zone.

**CR:** 205.1b, 613.1d (layer 4), 613.1e (layer 5), 205.3i

### 6. EVENT_DAMAGE_QTY

**Pattern:** Damage/loss amounts from the event or turn: 'where X is the amount of damage ~ dealt to that player', 'the amount of damage those creatures dealt', 'damage dealt to your opponents', 'mill a card for each 1 damage dealt to them', 'the greatest amount of damage dealt by a source this turn', 'total life your opponents lost this turn', 'damage dealt to ~ this turn by sources they controlled'

**Effort:** S. **Engine:** parser. **Nodes:** 8 (`where_x_binding`×4, `unparsed_quantity`×3, `unparsed_verb_arguments`×1).

**Cards (8, 8 deck-slots; completes 8 for 8):** Venerable Warsinger (1); Grothama, All-Devouring (1); Impact Resonance (1); Quartzwood Crasher (1); Florian, Voldaren Scion (1); Mask of the Schemer (1); Anowon, the Ruin Thief (1); Notorious Throng (1)

**Examples:**

- Venerable Warsinger: "Whenever this creature deals combat damage to a player, you may return target creature card with mana value X or less from your graveyard to the battlefield, where X is the amount of damage this creature dealt to that player."
- Grothama, All-Devouring: "When Grothama leaves the battlefield, each player draws cards equal to the amount of damage dealt to Grothama this turn by sources they controlled."
- Impact Resonance: "Impact Resonance deals X damage divided as you choose among any number of target creatures, where X is the greatest amount of damage dealt by a source to a permanent or player this turn."

**Where:** `QuantityRef::EventContextAmount`, `DamageDealtThisTurn` and `LifeLostThisTurn` exist. These are where-X bindings (`where_x_binding` in `oracle_effect/imperative.rs`) and 'for each 1 damage' phrasing in `oracle_quantity.rs`. Impact Resonance (greatest single-source amount) and Grothama (by source controller) need small new aggregations.

**CR:** 120.3, 120.4, 107.3

### 7. COND_STATE

**Pattern:** Inline 'if' conditions on current state: '1/1', 'modified', 'power differs from base power', 'has a +1/+1 counter', 'three or more counters', 'face down', 'you're the defending player', 'isn't being declared as an attacker', 'cards exiled with ~', 'you control an enchanted creature'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 15 (`unparsed_condition`×14, `target_has_unknown_keyword_condition`×1).

**Cards (15, 22 deck-slots; completes 15 for 22):** Kazuul, Tyrant of the Cliffs (6); Negative Zone Portal (3); Sigil Captain (1); Concord with the Kami (1); Rhoda, Geist Avenger (1); Verity Circle (1); Ian the Reckless (1); Colfenor's Urn (1); Showstopping Surprise (1); Norn's Decree (1); Turf War (1); Jason Bright, Glowing Prophet (1); Marcus, Mutant Mayor (1); Hadana's Climb (1); Gatewatch Beacon (1)

**Examples:**

- Kazuul, Tyrant of the Cliffs: "Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}."
- Negative Zone Portal: "At the beginning of your upkeep, if there are four or more creature cards exiled with this artifact, flip a coin."
- Sigil Captain: "Whenever a creature you control enters, if that creature is 1/1, put two +1/+1 counters on it."

**Where:** `oracle_nom/condition.rs::parse_condition` and `oracle_condition.rs`. Each predicate is small. Most map onto existing filter properties (counters, P/T, face-down, attachments, `CardsExiledBySource`); a few need a new `StaticCondition`/`AbilityCondition` leaf (defending player, 'being declared as an attacker' for tapped triggers, modified).

**CR:** 603.4 (intervening 'if'), 608.2c, 506.2/508.5 (defending player), 700.9 (modified)

### 8. QTY_GRAMMAR

**Pattern:** Quantity phrases missing from the grammar: 'the number of creatures those opponents control', 'Aura you control that's attached to a creature', 'nontoken creatures you had enter …', 'difference between those players' life totals', 'total mana value of permanents destroyed this way', 'card type among those cards', 'number of colors it is', 'its base power', 'cards with a cycling ability in your graveyard', 'one plus the number of spells cast this turn', 'number of counters on it', 'that card's mana value'

**Effort:** M. **Engine:** parser. **Nodes:** 18 (`unparsed_quantity`×14, `where_x_binding`×2, `difference_drops_stated_subject`×1, `unparsed_verb_arguments`×1).

**Cards (16, 21 deck-slots; completes 15 for 20):** Call the Coppercoats (3); Sage's Reverie (3); Gyome, Master Chef (2); Profane Transfusion (1); Convert to Slime (1); Polluted Cistern (1); Vastwood Hydra (1); Jared Carthalion (1); Curie, Emergent Intelligence (1); Zenith Flare (1); Ancient Cellarspawn (1); Magus of the Mind (1) [also needs IMPULSE_FREE]; Biomantic Mastery (1); Within Range (1); Omarthis, Ghostfire Initiate (1); Jace, Mirror Mage (1)

**Examples:**

- Call the Coppercoats: "Create X 1/1 white Human Soldier creature tokens, where X is the number of creatures those opponents control."
- Sage's Reverie: "When this Aura enters, draw a card for each Aura you control that's attached to a creature."
- Gyome, Master Chef: "At the beginning of your end step, create a number of Food tokens equal to the number of nontoken creatures you had enter the battlefield under your control this turn."

**Where:** `oracle_quantity.rs` and `oracle_nom/quantity.rs`. Each phrase maps onto an existing `QuantityRef` (`ObjectCount`, `ObjectColorCount`, `BasePower`, `TrackedSetSize`, `DistinctCardTypes`, `EnteredThisTurn`, `SpellsCastThisTurn`, `CountersOn`, …) with a different filter or scope, so this is a batch of about 15 small grammar arms rather than one feature.

**CR:** 107.3, 208.1 and 613.4a (base P/T), 202.3 (mana value), 105.2 (colours)

### 9. MISC_SMALL

**Effort:** S each. **Engine:** parser (a few need a small engine leaf). **Nodes:** 17 (`unrecognized_clause_head`×6, `static_structure`×5, `unparsed_verb_arguments`×4, `additional_phase`×1, `change_zone_enters_under_anaphor`×1).

**Cards (16, 18 deck-slots; completes 16 for 18):** Darksteel Angel (2); Lightning Runner (2); Master of Predicaments (1); Domri, Anarch of Bolas (1); Invincible Hymn (1); Final-Word Phantom (1); Aradesh, the Founder (1); Ghired, Conclave Exile (1); The Beamtown Bullies (1); Motivated Pony (1); Lily Bowen, Raging Grandma (1); Thrilling Encore (1); Elbrus, the Binding Blade (1); Umbra Mystic (1); Phyrexian Ingester (1); Winged Hive Tyrant (1)

Each is a small fix of its own, listed so they can be picked off in one sitting:

- **Darksteel Angel** (2): "Creatures you control can't have -1/-1 counters put on them." `static_structure`
- **Lightning Runner** (2): "If you pay, untap all creatures you control, and after this phase, there is an additional combat phase." `additional_phase`
- **Master of Predicaments** (1): "That player guesses whether the card's mana value is greater than 4." `unrecognized_clause_head`
- **Domri, Anarch of Bolas** (1): "Creature spells you cast this turn can't be countered." `unrecognized_clause_head`
- **Invincible Hymn** (1): "Count the number of cards in your library." `unrecognized_clause_head`
- **Invincible Hymn** (1): "Your life total becomes that number." `unrecognized_clause_head`
- **Final-Word Phantom** (1): "During each opponent's end step, you may cast spells as though they had flash." `static_structure`
- **Aradesh, the Founder** (1): "Whenever a creature you control attacks, if it enlisted a creature this combat, the creature that attacked gains double strike until end of turn." `unrecognized_clause_head`
- **Ghired, Conclave Exile** (1): "The token enters tapped and attacking." `unrecognized_clause_head`
- **The Beamtown Bullies** (1): "{T}: Target opponent whose turn it is puts target nonlegendary creature card from your graveyard onto the battlefield under their control." `change_zone_enters_under_anaphor`
- **Motivated Pony** (1): "If a Food entered the battlefield under your control this turn, untap those creatures and they get an additional +2/+2 until end of turn." `unparsed_verb_arguments`
- **Lily Bowen, Raging Grandma** (1): "Otherwise, remove all but one +1/+1 counter from it, then you gain 1 life for each +1/+1 counter removed this way." `unparsed_verb_arguments`
- **Thrilling Encore** (1): "Put onto the battlefield under your control all creature cards in all graveyards that were put there from the battlefield this turn." `unparsed_verb_arguments`
- **Elbrus, the Binding Blade** (1): "When equipped creature deals combat damage to a player, unattach Elbrus, then transform it." `unparsed_verb_arguments`
- **Umbra Mystic** (1): "Auras attached to permanents you control have umbra armor." `static_structure`
- **Phyrexian Ingester** (1): "This creature gets +X/+Y, where X is the exiled creature card's power and Y is its toughness." `static_structure`
- **Winged Hive Tyrant** (1): "The Will of the Hive Mind — Other creatures you control with counters on them have flying and haste." `static_structure`

### 10. COND_HISTORY

**Pattern:** Conditions on game history: 'if no creatures died this turn', 'if that player attacked you during their last turn', 'if they attacked you and/or a planeswalker you control', 'if another Human died under your control this turn', 'if a creature card left your graveyard this turn', 'if you cycled two or more cards this turn', 'if a counter was put on ~ this turn', 'if you were the monarch as the turn began', 'if ~ and at least two other creatures attacked this combat'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 15 (`unparsed_condition`×13, `cast_time_snapshot_in_trigger`×1, `Unsupported monarch turn-began condition`×1).

**Cards (15, 18 deck-slots; completes 14 for 17):** Titan Hunter (2); O-Kagachi, Vengeful Kami (2); Ever-Watching Threshold (2); Firkraag, Cunning Instigator (1); Orator of Ojutai (1); Ludevic, Necro-Alchemist (1); White Glove Gourmand (1); Syrix, Carrier of the Flame (1); Spellpyre Phoenix (1); Laboratory Drudge (1); Zimone, All-Questioning (1); Wakka, Devoted Guardian (1); Knights of the Black Rose (1); Kytheon, Hero of Akros (1); Hot Pursuit (1) [also needs GOAD]

**Examples:**

- Titan Hunter: "At the beginning of each player's end step, if no creatures died this turn, this creature deals 4 damage to that player."
- O-Kagachi, Vengeful Kami: "Whenever O-Kagachi deals combat damage to a player, if that player attacked you during their last turn, exile target nonland permanent that player controls."
- Ever-Watching Threshold: "Whenever an opponent attacks, if they attacked you and/or a planeswalker you control, draw a card."

**Where:** `oracle_nom/condition.rs`. Many counters already exist as `QuantityRef`s (`ZoneChangeCountThisTurn`, `CounterAddedThisTurn`, `AttackedThisTurn`, `LifeLostThisTurn`, …), so most are 'quantity ≥ N' conditions with new filters. 'Last turn', 'monarch as the turn began', 'had to attack' and Orator of Ojutai's cast-time snapshot need new tracked state.

**CR:** 603.4, 700.4 ('dies'), 725 (monarch)

### 11. CAST_FROM_GY_STATIC

**Pattern:** Static permission to play from the graveyard/exile with riders: 'Once during each of your turns, you may cast … from your graveyard. If you cast a spell this way, …', 'play a land or cast …', 'cards put there from libraries this turn', 'milled this turn', 'cast ~ from your graveyard by paying … rather than its mana cost'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 13 (`static_structure`×10, `unknown`×2, `empty`×1).

**Cards (13, 16 deck-slots; completes 13 for 16):** Edgar, Master Machinist (2); Serra Paragon (2); Scourge of Nel Toth (2); Shared Fate (1); Eye of Duskmantle (1); Arcade Gannon (1); Anrakyr the Traveller (1); Share the Spoils (1); Coram, the Undertaker (1); Haldan, Avid Arcanist (1); Raul, Trouble Shooter (1); Haakon, Stromgald Scourge (1); The Eighth Doctor (1)

**Examples:**

- Edgar, Master Machinist: "Once during each of your turns, you may cast an artifact spell from your graveyard."
- Serra Paragon: "Once during each of your turns, you may play a land from your graveyard or cast a permanent spell with mana value 3 or less from your graveyard."
- Scourge of Nel Toth: "You may cast this creature from your graveyard by paying {B}{B} and sacrificing two creatures rather than paying its mana cost."

**Where:** `oracle_static/restriction.rs` and `oracle_casting.rs` (`StaticMode::GraveyardCastPermission`, `CastingPermission`). The bare 'once during each of your turns, you may cast X from your graveyard' already parses (Lurrus, Maestros Ascendancy, Rivaz). Failures come from riders: land-or-spell disjunction, 'it enters tapped' / 'it gains <exile if it would leave>', MV bound to counters on the source, provenance filters (milled or put there this turn), and per-player exile pools (Shared Fate, Share the Spoils, Haldan).

**CR:** 601.2a, 305.1 (playing lands), 118.9 (alternative costs), 702.138 (escape-like)

### 12. INSTEAD_UPGRADE

**Pattern:** 'If this spell's madness cost was paid, … instead' / spell mastery 'up to three … instead of two' / 'If you rolled 6 or higher, instead …'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 5 (`instead_condition`×3, `instead_override`×1, `unparsed_condition`×1).

**Cards (5, 6 deck-slots; completes 4 for 5):** Avacyn's Judgment (2); Nissa's Pilgrimage (1); Mr. House, President and CEO (1) [also needs DICE_MULTI]; From Under the Floorboards (1); Grave Scrabbler (1)

**Examples:**

- Avacyn's Judgment: "If this spell's madness cost was paid, it deals X damage divided as you choose among those permanents and/or players instead."
- Nissa's Pilgrimage: "Spell mastery — If there are two or more instant and/or sorcery cards in your graveyard, search your library for up to three basic Forest cards instead of two."
- Mr. House, President and CEO: "If you rolled 6 or higher, instead create that token and a Treasure token."

**Where:** `instead_condition` / `instead_override` in `oracle_effect` (`lower_instead_condition`). Add a 'madness cost was paid' condition (`AdditionalCostPaid`-style flag on the spell; `MadnessCast` exists) and the 'N instead of M' numeric override. Grave Scrabbler uses the same condition as an intervening if.

**CR:** 702.35 (madness), 614.1a, 608.2c

### 13. MANA_RESTRICT

**Pattern:** Mana spend restrictions and type choices: 'Spend this mana only to cast spells you don't own', '… only to cast a spell with devoid', 'This mana can't be spent to pay generic mana costs', 'Add one mana of any type that a Gate you control could produce', '… any type the sacrificed land could produce'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 5 (`unparsed_verb_arguments`×4, `unbound_subject`×1).

**Cards (5, 5 deck-slots; completes 5 for 5):** Thieving Varmint (1); Plaza of Harmony (1); Corrupted Crossroads (1); Jegantha, the Wellspring (1); Squandered Resources (1)

**Examples:**

- Thieving Varmint: "Spend this mana only to cast spells you don't own."
- Plaza of Harmony: "{T}: Add one mana of any type that a Gate you control could produce."
- Corrupted Crossroads: "Spend this mana only to cast a spell with devoid."

**Where:** `ManaSpendRestriction` in `types/ability.rs`, parsed in `oracle_effect/mana.rs`. Add owner, devoid and no-generic restrictions, and 'any type <filter> could produce' (the Reflecting Pool family).

**CR:** 106.6, 106.7

### 14. CAST_RIDER_EXILE_INSTEAD

**Pattern:** 'You may cast it this turn … If that spell would be put into a graveyard, exile it instead.' after a one-shot cast grant

**Effort:** S. **Engine:** parser. **Nodes:** 2 (`unparsed_replacement`×2).

**Cards (2, 5 deck-slots; completes 2 for 5):** Dire Fleet Daredevil (4); Mission Briefing (1)

**Examples:**

- Dire Fleet Daredevil: "If that spell would be put into a graveyard, exile it instead."
- Mission Briefing: "If that spell would be put into your graveyard, exile it instead."

**Where:** `oracle_effect/lower.rs` folds the rider onto a preceding `GraveyardCastPermission` or `FreeCastFromZones` (`attach_graveyard_redirect_rider_to_prior_*`). The 'you may cast it this turn [, and mana of any type can be spent]' grant (Dire Fleet Daredevil, Nita, Mission Briefing) is neither shape, so the rider falls through to `unparsed_replacement`. Add a third attach target for the one-shot cast grant.

**CR:** 614.1a, 608.2n

### 15. NAMED_TOKEN

**Pattern:** Named or self-referential tokens: 'create a Gingerbrute token', 'create a Tarmogoyf token', 'Create a ~ token', 'Create a white and black Spirit enchantment creature token' (with a CDA)

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 4 (`unparsed_verb_arguments`×4).

**Cards (4, 5 deck-slots; completes 4 for 5):** Ginger, Queen of Sweets (2); Disa the Restless (1); Tarmogoyf Nest (1); Daxos the Returned (1)

**Examples:**

- Ginger, Queen of Sweets: "At the beginning of each upkeep, if you're the monarch, create a Gingerbrute token. (the token is defined only in reminder text)"
- Disa the Restless: "Whenever one or more creatures you control deal combat damage to a player, create a Tarmogoyf token."
- Tarmogoyf Nest: "Create a Tarmogoyf Nest token"

**Where:** `oracle_effect/token.rs`. Add the missing predefined token scripts (Gingerbrute, Tarmogoyf with its CDA, a token copy named after the card) and a */* token whose P/T is a characteristic-defining ability (Daxos).

**CR:** 111.4, 111.10 (predefined tokens), 604.3 (CDAs)

### 16. GOAD

**Pattern:** Goad variants: 'They're goaded', 'that creature is also goaded', 'each creature you control is no longer goaded', 'total power of creatures goaded this way'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 6 (`unrecognized_clause_head`×4, `unparsed_quantity`×1, `where_x_binding`×1).

**Cards (4, 5 deck-slots; completes 4 for 5):** Dack Fayden, Helping Hand (2); Serene Sleuth (1); Havoc Eater (1); Hot Pursuit (1) [also needs COND_HISTORY]

**Examples:**

- Dack Fayden, Helping Hand: "They're goaded for the rest of the game."
- Serene Sleuth: "Then each creature you control is no longer goaded."
- Havoc Eater: "Put X +1/+1 counters on this creature, where X is the total power of creatures goaded this way."

**Where:** `Effect::Goad`/`GoadAll` exist. Anaphoric 'they're goaded', an un-goad effect, and Hot Pursuit's 'as long as ~ remains on the battlefield' duration. Dack Fayden's 'for each of those permanents, choose a different opponent' needs a per-object distinct-player choice.

**CR:** 701.15

### 17. SUBJECT_BINDING

**Pattern:** Compound and relational subjects: 'You and that opponent each …', 'you and defending player each …', 'You each …', 'it and Zombies you control gain …', '~'s owner draws …', 'any number of them phase out'

**Effort:** M. **Engine:** parser (Reins of Power also needs mass exchange of control). **Nodes:** 9 (`unbound_subject`×9).

**Cards (8, 14 deck-slots; completes 8 for 14):** Reins of Power (4); Eumidian Wastewaker (2); Keen Duelist (2); Pendant of Prosperity (2); Cait, Cage Brawler (1) [also needs PUT_COUNTERS_EACH]; Wand of Orcus (1); Change of Plans (1); Nelly Borca, Impulsive Accuser (1)

**Examples:**

- Reins of Power: "You and that opponent each gain control of all creatures the other controls until end of turn."
- Eumidian Wastewaker: "Whenever this creature attacks, you and defending player each discard a card or sacrifice a permanent."
- Keen Duelist: "You each lose life equal to the mana value of the card revealed by the other player."

**Where:** `oracle_effect/subject.rs` (the `unbound_subject` gap is defined there). Bind a two-player subject to a per-player loop (you + the other referenced player) and a compound object subject to a union filter. Reins of Power needs an 'exchange control of all creatures' mass form; `Effect::ExchangeControl` exists only for two objects.

**CR:** 109.5, 101.4 (simultaneous choices in APNAP order), 701.12 (exchange)

### 18. PLAYER_COUNTERS

**Pattern:** Energy and rad counters beyond the basics: 'get an amount of {E}  equal to …' (double space left by stripped reminder text), 'where X is the amount of {E} you have', 'If you would get one or more {E}, you get that many plus one', 'Activate only if you've paid or lost four or more {E}', 'get two rad counters if they don't have any', 'lose all rad counters', 'half X rad counters, rounded up', 'total number of rad counters among players', 'You gain life rather than lose life from radiation'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 15 (`unparsed_quantity`×4, `unparsed_verb_arguments`×3, `replacement_structure`×2, `unparsed_condition`×2, `where_x_binding`×1, `static_structure`×1, `unrecognized_clause_head`×1, `effect_structure`×1).

**Cards (14, 14 deck-slots; completes 12 for 12):** Izzet Generatorium (1); Overclocked Electromancer (1); Razorfield Ripper (1) [also needs KEYWORD_COST]; Survivor's Med Kit (1); Robobrain War Mind (1); The Motherlode, Excavator (1); Contaminated Drink (1); Mariposa Military Base (1); Nuclear Fallout (1); Nuka-Nuke Launcher (1); Strong, the Brutish Thespian (1); Vault 12: The Necropolis (1); Vexing Radgull (1) [also needs OTHERWISE]; Winding Constrictor (1)

**Examples:**

- Izzet Generatorium: "If you would get one or more {E} (energy counters), you get that many plus one {E} instead."
- Overclocked Electromancer: "Whenever this creature deals combat damage to a creature, if that creature was dealt excess damage this turn, you get X {E}, where X is that excess damage."
- Razorfield Ripper: "Whenever this creature or equipped creature attacks, you get {E} (an energy counter), then it gets +X/+X until end of turn, where X is the amount of {E} you have."

**Where:** `GainEnergy`, `GivePlayerCounter`, `LoseAllPlayerCounters`, `ProcessRadCounters` and `QuantityRef::PlayerCounter` exist. Start with the energy-amount arm: Scurry of Gremlins ('get an amount of {E} equal to the number of creatures you control') and Peema Aether-Seer parse, but 'the number of artifact creatures you control' (Robobrain War Mind) and 'the number of nonbasic lands that player controls' (The Motherlode) don't, so that arm seems to use a narrower quantity grammar than `oracle_nom/quantity.rs`. The fragments also show a double space where '(energy counters)' was stripped, which is worth ruling out. The rest: player-counter replacements (Izzet Generatorium, Winding Constrictor's second sentence), an 'energy paid this game' tally, rounding, an all-players sum and a radiation-life replacement.

**CR:** 107.14 (energy), 122.1, 728 (rad counters), 614.1a

### 19. FLIP_UNTIL_LOSE

**Pattern:** 'Flip a coin until you lose a flip' and 'for each flip you won' bodies

**Effort:** S. **Engine:** parser. **Nodes:** 4 (`flip_coin_until_lose_stub`×2, `unparsed_verb_arguments`×1, `unparsed_quantity`×1).

**Cards (4, 4 deck-slots; completes 4 for 4):** Zndrsplt, Eye of Wisdom (1); Okaun, Eye of Chaos (1); Fiery Gambit (1); Squee's Revenge (1)

**Examples:**

- Zndrsplt, Eye of Wisdom: "At the beginning of combat on your turn, flip a coin until you lose a flip."
- Okaun, Eye of Chaos: "At the beginning of combat on your turn, flip a coin until you lose a flip."
- Fiery Gambit: "Flip a coin until you lose a flip or choose to stop flipping. If you lose a flip, Fiery Gambit has no effect."

**Where:** `Effect::FlipCoinUntilLose` exists, and the parser emits a `flip_coin_until_lose_stub` that `consolidate_die_and_coin_defs` (`oracle_effect/lower.rs`) folds into a following 'for each flip you won' body. Zndrsplt and Okaun have no body: the flips are there only to fire their 'whenever a player wins a coin flip' triggers, so the stub is never consolidated. Let a bare stub lower to the plain effect. Squee's Revenge ('draw two cards for each flip') and Fiery Gambit ('or choose to stop flipping', 'has no effect', win-count thresholds) need the body forms.

**CR:** 705.1, 705.3

### 20. VOTE_DILEMMA

**Pattern:** Council's dilemma blocks whose per-choice bodies fail ('You mill a card for each past vote, then … equal to the total mana value of cards milled this way', 'Reveal … until you reveal a creature card for each wild vote', multi-sentence per-choice bodies)

**Effort:** S. **Engine:** parser. **Nodes:** 6 (`unrecognized_clause_head`×3, `unparsed_quantity`×3).

**Cards (3, 4 deck-slots; completes 3 for 4):** Fateful Tempest (2); Selvala's Stampede (1); Travel Through Caradhras (1)

**Examples:**

- Fateful Tempest: "Starting with you, each player votes for past or present. You mill a card for each past vote, then Fateful Tempest deals damage to each opponent equal to the total mana value of cards milled this way."
- Selvala's Stampede: "Reveal cards from the top of your library until you reveal a creature card for each wild vote."
- Travel Through Caradhras: "Council's dilemma — Starting with you, each player votes for Redhorn Pass or Mines of Moria."

**Where:** `oracle_vote.rs::parse_vote_block_ir` returns `None` when any per-choice sub-effect fails, so the whole block falls back to 'vote for X or Y' heads. Accept trailing 'for each <choice> vote' (not only leading), and multi-sentence bodies up to the next 'For each' or end. `Effect::Vote` / `VotePerChoice` already resolve these.

**CR:** 701.38 (vote), 701.38a

### 21. COMPOUND_VERB

**Pattern:** Two verbs joined by 'and' or 'then' where the second is unusual: 'draw a card and chaos ensues', 'draw a card and blight 1', 'draw a card and target opponent may draw a card', 'mill a card and choose an opponent at random', 'then amass Zombies X, where X is …'

**Effort:** S. **Engine:** parser. **Nodes:** 4 (`unparsed_verb_arguments`×4).

**Cards (4, 4 deck-slots; completes 4 for 4):** Ursine Monstrosity (1); Commence the Endgame (1); Sinister Gnarlbark (1); Tataru Taru (1)

**Examples:**

- Ursine Monstrosity: "At the beginning of combat on your turn, mill a card and choose an opponent at random."
- Commence the Endgame: "Draw two cards, then amass Zombies X, where X is the number of cards in your hand."
- Sinister Gnarlbark: "At the beginning of your end step, draw a card and blight 1."

**Where:** `oracle_effect/sequence.rs` clause splitting. Each second verb exists alone.

**CR:** 608.2c

### 22. ANIMATE_X

**Pattern:** 'become an X/X … where X is twice the number of Gates' / 'where X is the result'

**Effort:** S. **Engine:** parser. **Nodes:** 2 (`unparsed_verb_arguments`×2).

**Cards (2, 4 deck-slots; completes 2 for 4):** Sage of the Maze (2); Ebony Fly (2)

**Examples:**

- Sage of the Maze: "{T}: Until end of turn, target land you control becomes an X/X Citizen creature with haste in addition to its other types, where X is twice the number of Gates you control."
- Ebony Fly: "Until end of turn, you may have this artifact become an X/X Insect artifact creature with flying, where X is the result."

**Where:** `oracle_effect/animation.rs`: accept a `where X is …` binding on the P/T of an animate effect. The quantity grammar already parses both right-hand sides.

**CR:** 613.4b (P/T setting), 107.3

### 23. PER_PLAYER_TARGET

**Pattern:** Per-player targeting variants: 'for any number of opponents', 'for each player', 'choose target … in that player's graveyard', cast/copy per player

**Effort:** M. **Engine:** parser. **Nodes:** 8 (`unparsed_quantity`×6, `unrecognized_clause_head`×1, `unparsed_verb_arguments`×1).

**Cards (7, 12 deck-slots; completes 6 for 11):** Windgrace's Judgment (5); The Ur-Sphinx (2); Mysterious Stranger (1); Afterlife from the Loam (1) [also needs ADDED_TYPES]; Shredder, Shadow Master (1); Geth's Summons (1); Guff Rewrites History (1) [also needs RELATIVE_PLAYER_SUBJECT]

**Examples:**

- Windgrace's Judgment: "For any number of opponents, destroy target nonland permanent that player controls."
- The Ur-Sphinx: "For each player, you may cast a card that player milled this way without paying its mana cost."
- Mysterious Stranger: "When this creature enters, for each graveyard with an instant or sorcery card in it, exile target instant or sorcery card from that graveyard."

**Where:** The 'for each opponent, <verb> target X that player controls' shape already works (Grasp of Fate, Enigma Thief, Elminster's Simulacrum). Widen that recogniser to 'for any number of opponents' (optional per-player target slots), 'for each player' (includes you), graveyard-zone targets, 'for each other opponent … attacking that player' (Shredder), and 'for each player, you may cast a card that player milled this way' (Ur-Sphinx). Look near the per-player target-slot code in `oracle_target.rs` and `oracle_effect/mod.rs` (search 'that player controls').

**CR:** 601.2c (choosing targets), 115.1, 109.5

### 24. PLANAR

**Pattern:** Planar die outside Planechase: 'Roll the planar die', planar-die roll replacement, 'chaos ensues' as a cost/choice result

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`unparsed_verb_arguments`×2, `replacement_structure`×1).

**Cards (3, 11 deck-slots; completes 3 for 11):** Fractured Powerstone (5); Ichor Elixir (5); Missy (1)

**Examples:**

- Fractured Powerstone: "{T}: Roll the planar die."
- Ichor Elixir: "If you would roll one or more planar dice, instead roll that many planar dice plus one and ignore one."
- Missy: "At the beginning of your end step, each opponent faces a villainous choice — Each artifact creature you control deals 1 damage to that opponent, or you draw a card and chaos ensues."

**Where:** The engine already has `game/planechase.rs` (planar die faces, `PlanarDieRolled` event), `Effect::ChaosEnsues` and `Effect::Planeswalk`. Missing: an effect that rolls the planar die from an ability (Fractured Powerstone), the 'roll that many planar dice plus one and ignore one' replacement (`oracle_replacement.rs`; the comment on `DieRollIgnoreRule` says the chooser axis must be designed first), and 'chaos ensues' inside a villainous choice (Missy). With no planar deck, planeswalk does nothing and chaos only fires 'whenever chaos ensues' abilities, so these cards are close to vanilla in normal Commander.

**CR:** 901.9 (rolling the planar die), 207.4 (chaos symbol), 701.31 (planeswalk), 706.6 (ignoring rolls)

### 25. RELATIVE_PLAYER_SUBJECT

**Pattern:** Relative-clause player subjects: 'Each opponent attacking that player untaps …', 'Each player other than target player creates …', 'Each opponent who discarded a card with the greatest mana value … loses life', 'Each player who shuffled … reveals …', 'Each player who discarded a card this way may search …'

**Effort:** M. **Engine:** parser. **Nodes:** 6 (`unrecognized_clause_head`×5, `unparsed_quantity`×1).

**Cards (6, 11 deck-slots; completes 6 for 11):** Curse of Bounty (3); Death by Dragons (3); Scythe Specter (2); Collision of Realms (1); Borderland Explorer (1); Guff Rewrites History (1) [also needs PER_PLAYER_TARGET]

**Examples:**

- Curse of Bounty: "Each opponent attacking that player untaps all nonland permanents they control."
- Death by Dragons: "Each player other than target player creates a 5/5 red Dragon creature token with flying."
- Scythe Specter: "Each player who discarded a card with the greatest mana value among cards discarded this way loses life equal to that mana value."

**Where:** `oracle_effect/subject.rs` plus the 'who … this way' population grammar in `oracle_quantity.rs` (players who drew/searched this way already exist). Lower to a per-player loop filtered by a `PlayerFilter` (attacking-a-player, not-target, performed-action-this-way).

**CR:** 109.5, 508.6 ('attacking a player'), 608.2c

### 26. EACH_PLAYER_CHOOSES

**Pattern:** Non-targeted choices by other players: 'Each opponent chooses a creature card in their graveyard', 'Target opponent chooses X cards from their hand', 'each player chooses a nonland permanent and puts a doom counter on it', 'chooses a party', 'that player chooses an attacking creature', 'that player chooses a permanent card in your graveyard'

**Effort:** M. **Engine:** parser. **Nodes:** 9 (`unparsed_verb_arguments`×8, `choose`×1).

**Cards (8, 11 deck-slots; completes 8 for 11):** Dredge the Mire (2); Extract Brain (2); Stick Together (2); Fortunate Few (1); Neyam Shai Murad (1); The Horus Heresy (1); Eye of Doom (1); Mirkwood Trapper (1)

**Examples:**

- Dredge the Mire: "Each opponent chooses a creature card in their graveyard."
- Extract Brain: "Target opponent chooses X cards from their hand."
- Stick Together: "Each player chooses a party from among creatures they control, then sacrifices the rest."

**Where:** 'Each player chooses a creature they control' already parses (Divine Reckoning, Single Combat). Widen the chooser and zone axes in the choose-object path (`Effect::ChooseFromZone` / `ChooseObjectsIntoTrackedSet`): opponent as chooser, graveyard/hand zones, X cards, party, and a follow-on verb on the chosen object ('and puts a doom counter on it').

**CR:** 700.8 (party), 608.2c, 115.10

### 27. KEYWORD_COST

**Pattern:** Keywords with non-mana costs after an em dash: 'Squad—{1}, Discard a card', 'Morph—Sacrifice another creature', 'Morph—Return two Islands …', 'Unearth—Pay eight {E}', 'Reconfigure—Pay {2} or {E}{E}{E}', 'Madness—{2}{B}, Pay 8 life', 'Replicate—Tap an untapped Dalek you control', 'Suspend X—{X}{3}{U}', 'Gift an Octopus'

**Effort:** M. **Engine:** parser+engine. **Nodes:** 11 (`unknown`×9, `unrecognized_clause_head`×2).

**Cards (11, 11 deck-slots; completes 10 for 10):** Razorfield Ripper (1) [also needs PLAYER_COUNTERS]; Salvation Colossus (1); Exterminate! (1); Octomancer (1); Ruthless Radrat (1); Thrill-Kill Disciple (1); Gift of Doom (1) [also needs FACE_DOWN]; Aeon Chronicler (1); Psionic Ritual (1); Fathom Seer (1); Shadowgrange Archfiend (1)

**Examples:**

- Razorfield Ripper: "Reconfigure—Pay {2} or {E}{E}{E}."
- Salvation Colossus: "Unearth—Pay eight {E}."
- Exterminate!: "Replicate—Tap an untapped Dalek you control."

**Where:** 0 of 18 cards in the whole pool with 'Squad|Morph|Unearth|Madness|Reconfigure—' parse. `oracle_keyword.rs` and the `Keyword` enum carry `ManaCost` (`Morph(ManaCost)`, `Squad(ManaCost)`, `Replicate(ManaCost)`, …), so the keyword payloads need a general `AbilityCost`, and the casting/activation paths that pay them need to accept it. The cost grammar itself (`oracle_cost.rs`) already parses these costs elsewhere. Also: 'Suspend X' and 'Gift a <token>'.

**CR:** 702.37b, 702.157, 702.84, 702.151, 702.35, 702.56, 702.62, 702.174, 118 (costs)

### 28. COMBAT_RESTRICT_PLAYER

**Pattern:** Player-scoped attack/block restrictions created by an effect: 'can't attack that player', 'can't attack you this combat', 'can't attack Jaces you control', 'can't attack those players or planeswalkers they control', 'can't block with more than one creature', 'You can't sacrifice those creatures'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 6 (`unrecognized_clause_head`×6).

**Cards (5, 9 deck-slots; completes 5 for 9):** Jace, Multiverse Architect (2); Call for Aid (2); Champions of Minas Tirith (2); Chaos Dragon (2); Mirri, Weatherlight Duelist (1)

**Examples:**

- Jace, Multiverse Architect: "If they don't, creatures they control can't attack Jaces you control this turn."
- Call for Aid: "You can't attack that player this turn."
- Champions of Minas Tirith: "If they don't, they can't attack you this combat."

**Where:** Static versions live in `oracle_static/restriction.rs`/`evasion.rs`. These are one-shot `Effect::AddRestriction` / `GameRestriction` forms after 'If they don't, …' and similar. Needs restriction leaves for 'attack a specific player', 'attack planeswalkers of subtype X', 'a player can't block with more than one creature', and 'can't sacrifice' (`ProhibitedActivity`).

**CR:** 508.1c/508.1d (attack restrictions/requirements), 509.1b, 701.21 (sacrifice)

### 29. OTHERWISE

**Pattern:** 'Otherwise, …' whose preceding conditional wasn't recognised: trailing 'create a Treasure token if this is the first or second time …', 'If you reveal a card named X this way', 'If you win the flip', 'If no counters were removed this way', 'You may put that card onto the battlefield if it's …', 'If any of those cards shares a card type with that spell'

**Effort:** M. **Engine:** parser. **Nodes:** 8 (`otherwise`×8).

**Cards (8, 9 deck-slots; completes 8 for 9):** Rose Room Treasurer (2); Nazahn, Revered Bladesmith (1); Plasma Caster (1); Bounty of the Luxa (1); Vexing Radgull (1) [also needs PLAYER_COUNTERS]; Scriv, the Obligator (1); Matter Reshaper (1); Gandalf, Westward Voyager (1)

**Examples:**

- Rose Room Treasurer: "Otherwise, you may pay {X}."
- Nazahn, Revered Bladesmith: "Otherwise, put that card into your hand."
- Plasma Caster: "Otherwise, this Equipment deals 1 damage to it."

**Where:** `OtherwiseKind::Fallback` in `oracle_ir/effect_chain.rs`: 'Otherwise' only binds when the prior clause was recognised as a conditional. Each card's real gap is the condition before it. Teach the trailing-'if' form and the outcome conditions (flip won, revealed card named X, 'counters removed this way' = 0) to register as a bindable conditional.

**CR:** 608.2c, 705.3 (coin flip results)

### 30. ACTIVATION_RESTRICT

**Pattern:** Activation limits: 'Activate only during the end of combat step', 'can't activate this ability during combat', 'Activate only if you control no creatures and only during your turn'

**Effort:** S. **Engine:** parser. **Nodes:** 3 (`unrecognized_clause_head`×2, `unparsed_condition`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Djinn of Infinite Deceits (1); Defenders of Humanity (1); Desert (1)

**Examples:**

- Djinn of Infinite Deceits: "You can't activate this ability during combat."
- Defenders of Humanity: "Activate only if you control no creatures and only during your turn."
- Desert: "Activate only during the end of combat step."

**Where:** `ActivationRestriction` has DuringCombat, AfterCombat, DuringYourTurn and RequiresCondition. Add an end-of-combat-step arm and the negated and conjunctive forms.

**CR:** 602.5b

### 31. REFLEXIVE_THIS_WAY

**Pattern:** Reflexive triggers keyed to a 'this way' action: 'When you discard a nonland card this way, … that card's mana value', 'When you sacrifice one or more Zombies this way, … that many', 'When one or more nonland cards are exiled this way, …', 'When you pay this cost one or more times', 'When they do'

**Effort:** M. **Engine:** parser. **Nodes:** 8 (`zone_change_reflexive_event_source`×3, `zone_change_reflexive_unbound_referent`×2, `unrecognized_clause_head`×2, `zone_change_reflexive_scoped_body`×1).

**Cards (8, 9 deck-slots; completes 8 for 9):** Augusta, Order Returned (2); Fiery Encore (1); Three Dog, Galaxy News DJ (1); Ravenous Rotbelly (1); Yes Man, Personal Securitron (1); Bloodthirsty Adversary (1); Summon: Kujata (1); Narset of the Ancient Way (1)

**Examples:**

- Augusta, Order Returned: "When one or more nonland cards are exiled this way, put that many +1/+1 counters on target attacking creature."
- Fiery Encore: "When you discard a nonland card this way, Fiery Encore deals damage equal to that card's mana value to target creature or planeswalker."
- Three Dog, Galaxy News DJ: "When you sacrifice an Aura this way, for each other attacking creature you control, create a token that's a copy of that Aura attached to that creature."

**Where:** `oracle_effect/zone_change_reflexive.rs` (gap names `zone_change_reflexive_event_source`, `…_unbound_referent`, `…_scoped_body` come from there). Bind the reflexive trigger's event source to the preceding instruction and expose 'that card'/'that many' to the body. Fiery Encore, Narset and Summon: Kujata share one shape.

**CR:** 603.12 (reflexive triggers), 608.2c

### 32. X_CONSTRAINT

**Pattern:** 'X can't be 0' inside modal modes / 'X can't be greater than the amount of life you lost this turn / the number of players in the game'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 5 (`unrecognized_clause_head`×5).

**Cards (3, 3 deck-slots; completes 3 for 3):** Marath, Will of the Wild (1); Mortarion, Daemon Primarch (1); Open the Way (1)

**Examples:**

- Marath, Will of the Wild: "X can't be 0."
- Mortarion, Daemon Primarch: "X can't be greater than the amount of life you lost this turn."
- Open the Way: "X can't be greater than the number of players in the game."

**Where:** `oracle.rs` strips a standalone 'X can't be 0.' paragraph but not one inside a modal or chapter body; the 'can't be greater than <quantity>' form needs an upper bound on announced X (Soul Immolation's form already parses).

**CR:** 107.3, 601.2b

### 33. MUTATE_COUNT

**Pattern:** 'where X is the number of times ~ has mutated'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 4 (`where_x_binding`×3, `unparsed_quantity`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Archipelagore (1); Auspicious Starrix (1); Insatiable Hemophage (1)

**Examples:**

- Archipelagore: "Whenever this creature mutates, tap up to X target creatures, where X is the number of times this creature has mutated."
- Auspicious Starrix: "Whenever this creature mutates, exile cards from the top of your library until you exile X permanent cards, where X is the number of times this creature has mutated."
- Insatiable Hemophage: "Whenever this creature mutates, each opponent loses X life and you gain X life, where X is the number of times this creature has mutated."

**Where:** No parser match anywhere. Add a `QuantityRef` for mutations of the source (the merged-object list is `merged_components` in `game/augment.rs`, but the rules count times it mutated, so keep a counter) and parse it in `oracle_nom/quantity.rs`.

**CR:** 702.140, 702.140e

### 34. COST_MOD

**Pattern:** Cost changes with unusual scope: 'The first activated ability of an artifact you activate each turn costs {2} less', 'instant, sorcery and planeswalker spells that player casts cost {2} less', 'The next instant or sorcery spell you cast this turn costs {X} less, where X is …', 'This ability costs {2} less if it targets two creatures you control', 'costs {X} less where X is the power of the creature it targets', 'costs {2} less for each counter removed this way', 'rather than pay this spell's mana cost'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 9 (`unrecognized_clause_head`×3, `static_structure`×2, `None`×2, `unparsed_condition`×1, `unparsed_quantity`×1).

**Cards (8, 9 deck-slots; completes 8 for 9):** Marshland Bloodcaster (2); Will Kenrith (1); Wayta, Trainer Prodigy (1); Tezzeret, Betrayer of Flesh (1); Belt of Giant Strength (1); Kaza, Roil Chaser (1); Hierophant Bio-Titan (1); Invigorate (1)

**Examples:**

- Marshland Bloodcaster: "{1}{B}, {T}: Rather than pay the mana cost of the next spell you cast this turn, you may pay life equal to that spell's mana value."
- Will Kenrith: "Until your next turn, instant, sorcery, and planeswalker spells that player casts cost {2} less to cast."
- Wayta, Trainer Prodigy: "This ability costs {2} less to activate if it targets two creatures you control."

**Where:** `oracle_static/cost_mod.rs` and `Effect::ReduceNextSpellCost`. Each needs a new scope (first ability per turn, target-dependent activation cost, player-granted reduction) or a new alternative-cost condition (Invigorate, Marshland Bloodcaster).

**CR:** 601.2f, 602.2b, 118.9

### 35. CLASH

**Pattern:** 'clash with defending player' / 'draw two cards, then clash with an opponent'

**Effort:** S. **Engine:** parser. **Nodes:** 2 (`unparsed_verb_arguments`×2).

**Cards (2, 3 deck-slots; completes 2 for 3):** Marvo, Deep Operative (2); Hoarder's Greed (1)

**Examples:**

- Marvo, Deep Operative: "Whenever Marvo attacks, clash with defending player."
- Hoarder's Greed: "You lose 2 life and draw two cards, then clash with an opponent."

**Where:** `Effect::Clash` exists. Accept the 'with defending player' opponent reference and clash as the second verb of a 'then' chain.

**CR:** 701.30

### 36. PAY_ANY_AMOUNT

**Pattern:** Variable-amount actions whose amount feeds a later quantity: 'pay any amount of {R}', 'pay any amount of life', 'pay that much life', 'discard one or more land cards', 'Remove any number of counters … You draw cards and lose life equal to the number removed'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 8 (`unparsed_verb_arguments`×5, `unknown`×1, `unparsed_quantity`×1, `shared_equal_to_quantity_compound`×1).

**Cards (6, 9 deck-slots; completes 6 for 9):** Loamcrafter Faun (2); Leyline Tyrant (2); Niv-Mizzet, Ghost Counsel (2); Phyrexian Processor (1); Eventide's Shadow (1); Verrak, Warped Sengir (1)

**Examples:**

- Loamcrafter Faun: "When this creature enters, you may discard one or more land cards."
- Leyline Tyrant: "When this creature dies, you may pay any amount of {R}."
- Niv-Mizzet, Ghost Counsel: "Whenever you gain life, you may pay that much life."

**Where:** `oracle_cost.rs` / `oracle_effect/imperative.rs`. Needs a chosen-amount payment that records the amount as `PreviousEffectAmount` / `TimesCostPaidThisResolution` so 'that much' and 'the life paid as ~ entered' can read it. Phyrexian Processor also needs the amount remembered on the permanent (`NotedNumber` exists).

**CR:** 107.1b, 118.3, 601.2f

### 37. VOTE_SECRET

**Pattern:** Secret council and secret choices with player or object candidates: 'Each player secretly votes for another player/a player/a creature you don't control/up to one creature, then those votes are revealed', 'For each vote you received', 'For each creature with one or more votes, put that many …', 'secretly choose 1, 2, or 3. Then those choices are revealed. If they match, …'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 22 (`unrecognized_clause_head`×14, `otherwise`×4, `unparsed_quantity`×3, `unparsed_verb_arguments`×1).

**Cards (8, 8 deck-slots; completes 8 for 8):** Custodi Squire (1); Vault 11: Voter's Dilemma (1); Expert-Level Safe (1); Mob Verdict (1); Prisoner's Dilemma (1); Círdan the Shipwright (1); Elrond of the White Council (1); Trap the Trespassers (1)

**Examples:**

- Custodi Squire: "Will of the council — When this creature enters, starting with you, each player votes for an artifact, creature, or enchantment card in your graveyard."
- Vault 11: Voter's Dilemma: "II, III — Each player secretly votes for up to one creature, then those votes are revealed."
- Expert-Level Safe: "Then those choices are revealed."

**Where:** `oracle_vote.rs`: secret word-choice votes already parse (Elrond's opener did). Extend `parse_object_vote_block` to secret player/object candidates and the 'then those votes are revealed' tail, and add per-candidate tallies ('votes you received', 'creature with one or more votes') over `QuantityRef::VoteCount`. Prisoner's Dilemma and Expert-Level Safe are secret choices with outcome branches; they also need 'Otherwise'.

**CR:** 701.38, 701.38b (choices may be objects or players)

### 38. ENTERS_WITH_OTHERS

**Pattern:** Other permanents entering with extra counters: 'each Human creature you control enters with an additional +1/+1 counter', 'that creature enters with an additional …', 'it enters with a number of +1/+1 counters equal to …'

**Effort:** M. **Engine:** parser. **Nodes:** 5 (`unrecognized_clause_head`×2, `as_long_as_gate`×1, `replacement_structure`×1, `unparsed_quantity`×1).

**Cards (5, 8 deck-slots; completes 5 for 8):** Dearly Departed (3); Master Biomancer (2); Aberrant Return (1); Biophagus (1); The First Tyrannic War (1)

**Examples:**

- Dearly Departed: "As long as this creature is in your graveyard, each Human creature you control enters with an additional +1/+1 counter on it."
- Master Biomancer: "Each other creature you control enters with a number of additional +1/+1 counters on it equal to this creature's power and as a Mutant in addition to its other types."
- Aberrant Return: "Each of them enters with an additional -1/-1 counter on it."

**Where:** `oracle_replacement.rs` (enters-with replacements) and `Effect::AddPendingETBCounters` for one-shot forms. Gaps are the gate 'As long as ~ is in your graveyard' (Dearly Departed), the delayed one-shot form inside a spell or trigger (Aberrant Return, Biophagus, The First Tyrannic War), and Master Biomancer's 'equal to ~'s power and as a Mutant' (counters plus a type change).

**CR:** 614.1c, 614.12, 122.6

### 39. UNLESS_NONMANA

**Pattern:** 'unless' with a non-payment condition or unusual payer: 'unless they control a commander', 'unless that player sacrifices it', 'unless that land had a nonbasic land type', 'unless they sacrifice that many permanents', 'unless it's colorless or it's only the color its controller chose'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 5 (`Unsupported unless clause`×5).

**Cards (5, 7 deck-slots; completes 5 for 7):** Crimson Honor Guard (2); Enchanter's Bane (2); Wonderscape Sage (1); Archfiend of Spite (1); Selective Obliteration (1)

**Examples:**

- Crimson Honor Guard: "At the beginning of each player's end step, this creature deals 4 damage to that player unless they control a commander."
- Enchanter's Bane: "At the beginning of your end step, target enchantment deals damage equal to its mana value to its controller unless that player sacrifices it."
- Wonderscape Sage: "Then discard a card unless that land had a nonbasic land type."

**Where:** `oracle_effect/mod.rs` emits 'Unsupported unless clause'. Payment-style unless (discard/sacrifice a nonland permanent) works (Torment of Hailfire). Two shapes are missing: unless + state condition (Crimson Honor Guard, Wonderscape Sage, Selective Obliteration), which lowers to an inverted condition, and unless + 'that many'/'it' payments bound to the trigger (Archfiend of Spite, Enchanter's Bane).

**CR:** 118.12, 118.12a

### 40. FOR_EACH_CATEGORY

**Pattern:** 'for each <category>, <choose one of that category>': each nonland card type, each permanent type, each listed keyword, each kind of counter

**Effort:** M. **Engine:** parser. **Nodes:** 7 (`unparsed_quantity`×3, `unparsed_verb_arguments`×3, `unrecognized_clause_head`×1).

**Cards (6, 7 deck-slots; completes 6 for 7):** Aminatou's Augury (2); Selective Adaptation (1); Revival Experiment (1); Aetheric Amplifier (1); Denry Klin, Editor in Chief (1); Exotic Pets (1)

**Examples:**

- Aminatou's Augury: "Until end of turn, for each nonland card type, you may cast a spell of that type from among the exiled cards without paying its mana cost."
- Selective Adaptation: "Choose from among them a card with flying, a card with first strike, and so on for double strike, deathtouch, haste, hexproof, indestructible, lifelink, menace, reach, trample, and vigilance."
- Revival Experiment: "For each permanent type, return up to one card of that type from your graveyard to the battlefield."

**Where:** `Effect::ForEachCategory` / `IterationCategory` already exist (`oracle_effect/sequence.rs`). Add categories for card type among a pool, permanent type, keyword list ('and so on for double strike, …'), and counter kind ('each kind of counter you have/among creatures you control'). Aetheric Amplifier's 'double … each kind of counter you have' is the player-counter variant.

**CR:** 205.2a, 122.1, 701.10 (double)

### 41. FACE_DOWN

**Pattern:** Face-down edge cases: 'As ~ enters, turn all other nontoken creatures face down', 'face-up nontoken creatures you control gain "When ~ dies, manifest …"', 'its controller cloaks the top card', 'As ~ is turned face up, you may attach it', Vesuvan Shapeshifter's copy-while-face-up

**Effort:** M. **Engine:** parser+engine. **Nodes:** 5 (`unrecognized_clause_head`×2, `unknown`×1, `replacement_structure`×1, `static_structure`×1).

**Cards (5, 7 deck-slots; completes 5 for 7):** Whisperwood Elemental (2); Ixidron (2); Unexplained Absence (1); Gift of Doom (1) [also needs KEYWORD_COST]; Vesuvan Shapeshifter (1)

**Examples:**

- Whisperwood Elemental: "Sacrifice this creature: Until end of turn, face-up nontoken creatures you control gain "When this creature dies, manifest the top card of your library.""
- Ixidron: "As this creature enters, turn all other nontoken creatures face down."
- Unexplained Absence: "For each permanent exiled this way, its controller cloaks the top card of their library."

**Where:** Manifest, cloak, morph and `TurnFaceDown` exist. Missing: the subject 'its controller' for cloak, a face-up filter grant, the 'as turned face up' replacement, and Vesuvan's copy-until-face-down.

**CR:** 708, 701.40 (manifest), 701.58 (cloak), 702.37 (morph)

### 42. FOR_EACH_OF_THOSE

**Pattern:** 'For each of those creatures/tokens, <effect on that object>'

**Effort:** M. **Engine:** parser. **Nodes:** 4 (`unparsed_quantity`×4).

**Cards (4, 7 deck-slots; completes 4 for 7):** Hate Mirage (4); Smoke Spirits' Aid (1); Divergent Transformations (1); Goldwardens' Gambit (1)

**Examples:**

- Hate Mirage: "For each of those creatures, create a token that's a copy of that creature."
- Smoke Spirits' Aid: "For each of up to X target creatures, create a red Aura enchantment token named Smoke Blessing attached to that creature."
- Divergent Transformations: "For each of those creatures, its controller reveals cards from the top of their library until they reveal a creature card, puts that card onto the battlefield, then shuffles the rest into their library."

**Where:** 0 of 6 cards in the whole pool with this opener parse. Needs a for-each-over-previous-targets/tracked-set wrapper in `oracle_effect/sequence.rs` (where `ForEachCategory` is assembled) that binds 'that creature' to the iteration member. Hate Mirage is the high-value case (4 decks). `RetargetEachCopyToIterationMember` already exists for the copy variant.

**CR:** 608.2c, 707.2 (token copies), 609.3

### 43. REPEAT_PROCESS

**Pattern:** 'As many times as you choose, …' / 'repeat this process' / 'That opponent may repeat this process as many times as they choose'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 6 (`unrecognized_clause_head`×4, `unparsed_verb_arguments`×1, `unbound_subject`×1).

**Cards (5, 7 deck-slots; completes 5 for 7):** Dance with Calamity (2); Grist, the Hunger Tide (2); Firemind's Foresight (1); Lim-Dûl's Vault (1); Trade Secrets (1)

**Examples:**

- Dance with Calamity: "As many times as you choose, you may exile the top card of your library."
- Grist, the Hunger Tide: "If an Insect card was milled this way, put a loyalty counter on Grist and repeat this process."
- Firemind's Foresight: "Then repeat this process for instant cards with mana values 2 and 1."

**Where:** Needs a loop node (`Effect::RuntimeHandled` or a new repeat wrapper) whose continue-condition is a player choice or a resolved predicate. Parse in `oracle_effect/sequence.rs`. Firemind's Foresight is 'repeat for instant cards with mana values 2 and 1', a parameterised replay like the existing `ReplicateKind::CounterPlacement`.

**CR:** 608.2c, 609.3

### 44. CHOOSE_VALUE

**Pattern:** Choices of a value that later text reads: 'As ~ enters, choose two players', 'choose a planeswalker type', 'Choose a permanent type', 'each player chooses war or peace' + 'Creatures controlled by players who chose war get +3/+0', 'As ~ enters, exile an instant or sorcery card from your graveyard'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 9 (`unknown`×5, `unparsed_verb_arguments`×2, `static_structure`×2).

**Cards (7, 7 deck-slots; completes 7 for 7):** Deification (1); Living Lore (1); Bitter Feud (1); Creeping Renaissance (1); Sower of Discord (1); Archangel of Strife (1); Leori, Sparktouched Hunter (1)

**Examples:**

- Deification: "As this enchantment enters, choose a planeswalker type."
- Living Lore: "As this creature enters, exile an instant or sorcery card from your graveyard."
- Bitter Feud: "As this enchantment enters, choose two players."

**Where:** `ChoiceType` / `ChosenAttribute` in `types/ability.rs` (creature type, color etc. exist). Add two-player, planeswalker-type and permanent-type choices, plus per-player recorded choices that statics can read (Archangel of Strife).

**CR:** 614.12, 607.2, 205.3

### 45. DICE_D20_ADD

**Pattern:** d20 tables with a computed modifier or an ignore rule: 'Roll a d20 and add the toughness of the creature you sacrificed this way', 'Roll a d20 and add the total mana value of those cards', 'Roll two d20 and ignore the lower roll'

**Effort:** S. **Engine:** parser. **Nodes:** 9 (`unrecognized_clause_head`×5, `unparsed_verb_arguments`×3, `tracked_set_anaphor`×1).

**Cards (3, 3 deck-slots; completes 2 for 2):** Danse Macabre (1); Song of Inspiration (1); Berserker's Frenzy (1) [also needs COMBAT_CONTROL]

**Examples:**

- Danse Macabre: "Roll a d20 and add the toughness of the creature you sacrificed this way."
- Song of Inspiration: "Roll a d20 and add the total mana value of those cards."
- Berserker's Frenzy: "Roll two d20 and ignore the lower roll."

**Where:** `DieRollModifier::Add` and `DieRollIgnoreRule::Lowest` exist and the d20 table works (Diviner's Portent, Wyll's Reversal). Gaps are the modifier quantities (sacrificed-this-way toughness, tracked-set total MV) and the wording 'ignore the lower roll'. Berserker's Frenzy's 15–20 row also needs COMBAT_CONTROL.

**CR:** 706.2, 706.6

### 46. CHOOSE_CONSTRAINED

**Pattern:** Choices with constraints: 'For each different power among creatures, choose a creature with that power', 'choose any number of creatures with different powers', 'Choose a creature at random', 'choose a creature with the greatest power among creatures that player controls', 'choose another attacking creature with lesser power'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 6 (`unparsed_verb_arguments`×6).

**Cards (6, 6 deck-slots; completes 6 for 6):** Celestial Judgment (1); Sigarda's Vanguard (1); Sigardian Zealot (1); The Nipton Lottery (1); Kamiz, Obscura Oculus (1); Highcliff Felidar (1)

**Examples:**

- Celestial Judgment: "For each different power among creatures on the battlefield, choose a creature with that power."
- Sigarda's Vanguard: "Whenever this creature enters or attacks, choose any number of creatures with different powers."
- Sigardian Zealot: "At the beginning of combat on your turn, choose any number of creatures with different powers."

**Where:** Choose-object path (`ChoosePermanent`, `ObjectSelectionEligibility`, `NumberDistinctness`). Add distinct-power, random, greatest-power and relative-power constraints.

**CR:** 608.2c, 608.2d

### 47. COPY_PER_TARGET

**Pattern:** Spell/ability copies with per-copy targets: 'copy that spell for each of those creatures. The copy targets that creature', 'Each copy targets a different one of those permanents and players', 'The copy targets that token', 'the spell's controller may choose new targets', 'you may copy that ability' (if permanents were sacrificed to activate it)

**Effort:** M. **Engine:** parser. **Nodes:** 7 (`unrecognized_clause_head`×3, `unparsed_condition`×2, `unbound_subject`×1, `unparsed_quantity`×1).

**Cards (6, 6 deck-slots; completes 6 for 6):** Radiant Performer (1); Exterminator Magmarch (1); Sudden Substitution (1); Ashnod the Uncaring (1); Feather, Radiant Arbiter (1); Frontline Heroism (1)

**Examples:**

- Radiant Performer: "Each copy targets a different one of those permanents and players."
- Exterminator Magmarch: "Whenever you cast an instant or sorcery spell that targets only a single nonland permanent an opponent controls, if another opponent controls one or more nonland permanents that spell could target, choose one of those permanents."
- Sudden Substitution: "Then the spell's controller may choose new targets for it."

**Where:** `Effect::CopySpell` with `RetargetEachCopyToIterationMember` already exists. These are the sentence shapes that bind a copy's target to an iteration member or another reference. Ashnod and Unbound Flourishing also need conditions on how the original was paid.

**CR:** 707.10, 707.10c, 115.7

### 48. TURN_ORDER_CHOICE

**Pattern:** 'Starting with the next opponent in turn order, each opponent chooses … that hasn't been chosen' / 'Starting with you and proceeding in the chosen direction' / 'each player starting with you may pay any amount of mana'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 7 (`unrecognized_clause_head`×5, `unparsed_verb_arguments`×2).

**Cards (5, 6 deck-slots; completes 5 for 6):** Rejoin the Fight (2); Manifold Insights (1); Sadistic Shell Game (1); Mana-Charged Dragon (1); Order of Succession (1)

**Examples:**

- Rejoin the Fight: "Then starting with the next opponent in turn order, each opponent chooses a creature card in your graveyard that hasn't been chosen."
- Manifold Insights: "Starting with the next opponent in turn order, each opponent chooses a different nonland card from among them."
- Sadistic Shell Game: "Starting with the next opponent in turn order, each player chooses a creature you don't control."

**Where:** `parse_starting_with` exists in `oracle_vote.rs` for votes ('starting with you'). Generalise it to 'the next opponent in turn order' and a chosen direction, and add the sequential distinct-choice ('hasn't been chosen') constraint to the choose-object path (`ObjectSelectionEligibility`).

**CR:** 101.4, 101.4a (choices in turn order)

### 49. IMPRINT_X

**Pattern:** 'X is the mana value of that card' (Soul Foundry, Prototype Portal: an X activation cost fixed by the imprinted card)

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 2 (`unrecognized_clause_head`×2).

**Cards (2, 2 deck-slots; completes 2 for 2):** Soul Foundry (1); Prototype Portal (1)

**Examples:**

- Soul Foundry: "X is the mana value of that card."
- Prototype Portal: "X is the mana value of that card."

**Where:** Activation-cost X fixed by a linked exiled card. Parse in `oracle_cost.rs`, quantity `CardsExiledBySource` MV.

**CR:** 107.3, 607.2a

### 50. PILES

**Pattern:** Pile splits outside the existing shapes: 'An opponent separates those cards into two piles', 'Look at the cards in the other pile', 'separate all permanents they control into three piles … choose one at random'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 4 (`unparsed_verb_arguments`×2, `unrecognized_clause_head`×2).

**Cards (3, 6 deck-slots; completes 3 for 6):** Abstract Performance (2); Jace, Architect of Thought (3); Whims of the Fates (1)

**Examples:**

- Abstract Performance: "Look at the cards in the other pile."
- Jace, Architect of Thought: "An opponent separates those cards into two piles."
- Whims of the Fates: "Starting with you, each player separates all permanents they control into three piles."

**Where:** `oracle_separate_piles.rs` (`Effect::SeparateIntoPiles`). Gaps: the anaphoric 'those cards' source (Jace, Architect of Thought), the face-down pile plus 'look at the other pile' (Abstract Performance), and three piles chosen at random (Whims of the Fates).

**CR:** 700.3 (piles)

### 51. ENTERS_WITH_COMPUTED

**Pattern:** Self 'enters with' counters computed at cast or entry: 'As ~ enters, remove all counters from … ~ enters with a +1/+1 counter for each counter removed this way', 'When you cast this spell, each player … ~ enters with X counters, where X is …', 'enters with three +1/+1 counters if you didn't cast it from your hand'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 5 (`enters_with_clause`×4, `enters_with_gate`×1).

**Cards (5, 6 deck-slots; completes 5 for 6):** Thief of Blood (2); Naya Soulbeast (1); Epochrasite (1); Gluttonous Hellkite (1); Sin, Unending Cataclysm (1)

**Examples:**

- Thief of Blood: "As this creature enters, remove all counters from all permanents."
- Naya Soulbeast: "When you cast this spell, each player reveals the top card of their library."
- Epochrasite: "This creature enters with three +1/+1 counters on it if you didn't cast it from your hand."

**Where:** `oracle.rs::emit_enters_with_clause_gap` marks these. Needs a cast-trigger → enters-with handoff (store a number on the spell as it resolves, as `NoteNumber` does) and the `enters_with_gate` 'if you didn't cast it from your hand' condition.

**CR:** 614.1c, 614.12, 603.6, 601.2

### 52. GRANT_CASCADE

**Pattern:** 'the next instant spell and the next sorcery spell you cast this turn each have cascade' / 'you may cast spells from your hand … as you cast spells from your hand they gain cascade'

**Effort:** S. **Engine:** parser+small engine. **Nodes:** 2 (`unrecognized_clause_head`×2).

**Cards (2, 2 deck-slots; completes 2 for 2):** Smoldering Stagecoach (1); Yidris, Maelstrom Wielder (1)

**Examples:**

- Smoldering Stagecoach: "Whenever this Vehicle attacks, the next instant spell and the next sorcery spell you cast this turn each have cascade."
- Yidris, Maelstrom Wielder: "Whenever Yidris deals combat damage to a player, as you cast spells from your hand this turn, they gain cascade."

**Where:** `Effect::GrantNextSpellAbility` exists; add the two-filter 'next X and next Y' form and Yidris's turn-long grant.

**CR:** 702.85

### 53. LIBRARY_POSITION

**Pattern:** 'into its owner's library just beneath the top X cards'

**Effort:** S. **Engine:** parser. **Nodes:** 1 (`unparsed_verb_arguments`×1).

**Cards (1, 2 deck-slots; completes 1 for 2):** Underdark Rift (2)

**Examples:**

- Underdark Rift: "Put target artifact, creature, or planeswalker into its owner's library just beneath the top X cards of that library, where X is the result."

**Where:** `Effect::PutAtLibraryPosition` exists; add 'just beneath the top X cards' in `oracle_effect/imperative.rs` (Time Out has the same gap).

**CR:** 401.4

### 54. REVEAL_UNTIL

**Pattern:** 'reveal cards from the top of it until you reveal a nonland card'

**Effort:** S. **Engine:** parser. **Nodes:** 1 (`unparsed_verb_arguments`×1).

**Cards (1, 2 deck-slots; completes 1 for 2):** Creative Technique (2)

**Examples:**

- Creative Technique: "Shuffle your library, then reveal cards from the top of it until you reveal a nonland card."

**Where:** `oracle_effect/imperative.rs` RevealUntil: accept 'of it' as an anaphor for the library just shuffled.

**CR:** 701.20

### 55. SECRET_CHOSEN_PLAYER

**Pattern:** 'As ~ enters, secretly choose an opponent' + 'Reveal the player you chose: <effect>. Activate only once.'

**Effort:** M. **Engine:** parser+engine. **Nodes:** 3 (`effect_structure`×3).

**Cards (3, 6 deck-slots; completes 3 for 6):** Stalking Leonin (4); Guardian Archon (1); Emissary of Grudges (1)

**Examples:**

- Stalking Leonin: "Reveal the player you chose: Exile target creature that's attacking you if it's controlled by the chosen player."
- Guardian Archon: "Reveal the player you chose: You and target permanent you control each gain protection from the chosen player until end of turn."
- Emissary of Grudges: "Reveal the player you chose: Choose new targets for target spell or ability if it's controlled by the chosen player and if it targets you or a permanent you control."

**Where:** Activated ability whose cost is revealing a secret choice. Needs a hidden `ChosenAttribute` player choice (the open 'choose a player' choice exists) and a 'reveal the chosen player' cost in `oracle_cost.rs`. The effect bodies are ordinary once the 'chosen player' reference is bound. `effect_structure` failures today.

**CR:** 607.2 (linked abilities), 118 (costs), 406.3 (hidden choice is like face-down information)

### 56. IMPULSE_FREE

**Pattern:** 'Until end of turn, you may play lands and cast spells from among cards exiled this way without paying their mana costs'

**Effort:** S. **Engine:** parser. **Nodes:** 2 (`unrecognized_clause_head`×2).

**Cards (2, 2 deck-slots; completes 2 for 2):** Magus of the Mind (1) [also needs QTY_GRAMMAR]; Gix, Yawgmoth Praetor (1)

**Examples:**

- Magus of the Mind: "Until end of turn, you may play lands and cast spells from among cards exiled this way without paying their mana costs."
- Gix, Yawgmoth Praetor: "You may play lands and cast spells from among cards exiled this way without paying their mana costs."

**Where:** Casting-permission grant in `oracle_casting.rs`: the 'play lands and cast spells … without paying' pair fails on the 'play lands' head.

**CR:** 601.2, 305.1

### 57. COMBAT_REQUIREMENT

**Pattern:** Attack/block requirements as effects: 'During target player's next turn, creatures that player controls attack ~ if able', 'creatures your opponents control attack each combat if able', 'Creatures your opponents control block this turn if able', 'attack target opponent this turn if able', 'Each opponent must attack with at least one creature each combat if able'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 7 (`unrecognized_clause_head`×3, `unparsed_verb_arguments`×3, `unknown`×1).

**Cards (6, 6 deck-slots; completes 5 for 5):** Rowan Kenrith (1); The Akroan War (1); Brutal Hordechief (1) [also needs COMBAT_CONTROL]; Seeker of Slaanesh (1); Dulcet Sirens (1); Ravener (1)

**Examples:**

- Rowan Kenrith: "[+2]: During target player's next turn, each creature that player controls attacks if able."
- The Akroan War: "II — Until your next turn, creatures your opponents control attack each combat if able."
- Brutal Hordechief: "{3}{R/W}{R/W}: Creatures your opponents control block this turn if able, and you choose how those creatures block."

**Where:** `Effect::ForceAttack`/`ForceBlock` exist. Add player-scoped and defender-specific requirements and the 'at least one creature' requirement (Seeker of Slaanesh) in `oracle_effect/imperative.rs` and `oracle_static/restriction.rs`.

**CR:** 508.1d, 509.1c

### 58. DICE_ENDEAVOR

**Pattern:** 'Roll two dN and choose one result. <A> equal to that result. <B> equal to the other result.' (the Endeavor cycle)

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 12 (`unparsed_quantity`×6, `unparsed_verb_arguments`×5, `where_x_binding`×1).

**Cards (5, 5 deck-slots; completes 5 for 5):** Reckless Endeavor (1); Valiant Endeavor (1); Arcane Endeavor (1); Grave Endeavor (1); Wild Endeavor (1)

**Examples:**

- Reckless Endeavor: "Roll two d12 and choose one result."
- Valiant Endeavor: "Roll two d6 and choose one result."
- Arcane Endeavor: "Roll two d8 and choose one result."

**Where:** `Effect::RollDie` and `WaitingFor::DieKeepChoice` exist. Needs a two-dice roll whose results are split into 'that result' and 'the other result' quantity refs, chosen by the roller, then the two bodies. Parse in `oracle_effect/imperative.rs`; consolidation is `oracle_effect/lower.rs::consolidate_die_and_coin_defs`.

**CR:** 706.1, 706.2

### 59. EMBLEM

**Pattern:** Emblems whose text is a hard static: 'activate loyalty abilities … any time you could cast an instant', '{1}{B}, Sacrifice a creature: … where X is the sacrificed creature's power', 'prevent all but 1 of that damage', two quoted abilities joined by 'and'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 5 (`emblem_creation`×3, `unparsed_verb_arguments`×1, `unbound_subject`×1).

**Cards (5, 5 deck-slots; completes 5 for 5):** Sarkhan, the Dragonspeaker (1); Teferi, Temporal Archmage (1); Ob Nixilis of the Black Oath (1); Ajani Steadfast (1); Jace's Machinations (1)

**Examples:**

- Sarkhan, the Dragonspeaker: "[−6]: You get an emblem with "At the beginning of your draw step, draw two additional cards" and "At the beginning of your end step, discard your hand.""
- Teferi, Temporal Archmage: "[−10]: You get an emblem with "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant.""
- Ob Nixilis of the Black Oath: "[−8]: You get an emblem with "{1}{B}, Sacrifice a creature: You gain X life and draw X cards, where X is the sacrificed creature's power.""

**Where:** `Effect::CreateEmblem` exists (`try_parse_emblem_creation`). The inner abilities are the gaps: instant-speed loyalty activation (also Jace's Machinations), 'all but 1' prevention, and the two-quoted-ability split (Sarkhan).

**CR:** 114, 606.3 (loyalty timing)

### 60. MANA_CONCESSION

**Pattern:** 'mana of any type can be spent to cast that spell' / 'spend <color> mana as though it were mana of any color' attached to an unusual cast grant

**Effort:** M. **Engine:** parser. **Nodes:** 10 (`standalone_mana_spend_concession`×4, `linked_exile_resolution_cast`×3, `unrepresentable_mana_spend_concession`×2, `unparsed_verb_arguments`×1).

**Cards (3, 4 deck-slots; completes 3 for 4):** Summon: Esper Valigarmanda (2); Arvinox, the Mind Flail (1); Grell Philosopher (1)

**Examples:**

- Summon: Esper Valigarmanda: "I — Exile an instant or sorcery card from each graveyard."
- Arvinox, the Mind Flail: "For as long as those cards remain exiled, you may look at them, you may cast permanent spells from among them, and you may spend mana as though it were mana of any color to cast those spells."
- Grell Philosopher: "You may spend blue mana as though it were mana of any color to activate those abilities."

**Where:** The concession parses after the common 'you may cast it for as long as it remains exiled' grant (Gonti, Hostage Taker). The gaps are a Saga chapter that casts 'an instant or sorcery card exiled with ~' (`linked_exile_resolution_cast` in `oracle_effect/mod.rs`), 'look at them, you may cast permanent spells from among them' (Arvinox), and Grell Philosopher's blue-only ability concession (`unrepresentable_mana_spend_concession`, which needs a narrower `ManaSpendPermission`).

**CR:** 609.4b (spend mana as though any type/color), 607.2a (exiled with ~)

### 61. GAIN_ABILITIES_OF

**Pattern:** '~ has all activated abilities of all cards in exile with <kind> counters on them' / 'When you cast it this turn, ~ gains all activated abilities of that card'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`static_structure`×2, `unrecognized_clause_head`×1).

**Cards (3, 4 deck-slots; completes 3 for 4):** Havengul Lich (2); Rex, Cyber-Hound (1); Mairsil, the Pretender (1)

**Examples:**

- Havengul Lich: "When you cast it this turn, this creature gains all activated abilities of that card until end of turn."
- Rex, Cyber-Hound: "Rex has all activated abilities of all cards in exile with brain counters on them."
- Mairsil, the Pretender: "Mairsil has all activated abilities of all cards you own in exile with cage counters on them."

**Where:** `Effect::GainActivatedAbilitiesOfTarget` exists for one target. Needs a static over a counter-marked exile pool (Rex, Mairsil, with Mairsil's once-each-turn limit) and Havengul Lich's delayed cast-triggered grant.

**CR:** 113.6, 607.2a, 604.1

### 62. SUSPEND

**Pattern:** Suspend grants and counters: 'If it doesn't have suspend, it gains suspend', 'Cards exiled this way that don't have suspend gain suspend', 'Put four time counters on each of those cards that has suspend'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 4 (`put_counter_tail`×1, `keyword_anaphor_resolution_time_pick`×1, `target_opponent_does_the_same`×1, `unrecognized_clause_head`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Ecstatic Beauty (1); The Eleventh Doctor (1); The Wedding of River Song (1)

**Examples:**

- Ecstatic Beauty: "Put four time counters on each of those cards that has suspend."
- The Eleventh Doctor: "If it doesn't have suspend, it gains suspend."
- The Wedding of River Song: "Then target opponent does the same."

**Where:** Suspend exists. Needs a 'gains suspend' grant on exiled cards and a filter on 'has suspend'.

**CR:** 702.62

### 63. AGGREGATE_MV_SELECTION

**Pattern:** 'any number of … cards with total mana value N or less'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 2 (`modal_mode_unsupported_qualifier`×1, `unenforced_aggregate_resolution_selection`×1).

**Cards (2, 3 deck-slots; completes 2 for 3):** Ao, the Dawn Sky (2) [also needs PUT_COUNTERS_EACH]; Technomancer (1)

**Examples:**

- Ao, the Dawn Sky: "• Look at the top seven cards of your library."
- Technomancer: "When this creature enters, mill three cards, then return any number of artifact creature cards with total mana value 6 or less from your graveyard to the battlefield."

**Where:** `modal_mode_unsupported_qualifier` / `unenforced_aggregate_resolution_selection`. Needs an aggregate constraint on a multi-card selection (`SearchSelectionConstraint` / `KeeperConstraint` style) enforced at resolution.

**CR:** 202.3, 608.2c

### 64. AURA_ATTACH

**Pattern:** Putting Auras/Equipment onto the battlefield attached: 'put onto the battlefield attached to it any number of Aura cards that could enchant it from your graveyard and/or hand', 'For each of those tokens, you may attach an Equipment you control to it', 'Only creatures can be enchanted this way'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`unparsed_verb_arguments`×1, `unparsed_quantity`×1, `unrecognized_clause_head`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Bruna, Light of Alabaster (1); Liberated Livestock (1); Retether (1)

**Examples:**

- Bruna, Light of Alabaster: "Whenever Bruna attacks or blocks, you may attach to it any number of Auras on the battlefield and you may put onto the battlefield attached to it any number of Aura cards that could enchant it from your graveyard and/or hand."
- Liberated Livestock: "For each of those tokens, you may put an Aura card from your hand and/or graveyard onto the battlefield attached to it."
- Retether: "Only creatures can be enchanted this way."

**Where:** `ChangeZone` with an attach-to destination exists for single cards. Needs multi-card, multi-zone and per-token iteration.

**CR:** 303.4f, 301.5c

### 65. MANA_SPEND_TRIGGER

**Pattern:** 'When you spend this mana to cast a spell or activate an ability, copy that spell or ability' / '… you may exile that spell instead of putting it into its owner's graveyard'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`unrecognized_clause_head`×2, `orphaned_copy_retarget`×1).

**Cards (2, 3 deck-slots; completes 2 for 3):** Sunken Palace (2); Forger's Foundry (1)

**Examples:**

- Sunken Palace: "When you spend this mana to cast a spell or activate an ability, copy that spell or ability."
- Forger's Foundry: "When you spend this mana to cast an instant or sorcery spell with mana value 3 or less, you may exile that spell instead of putting it into its owner's graveyard as it resolves."

**Where:** `oracle_effect/mana.rs::parse_mana_spend_trigger` admits only Scry/GainLife/Draw/CopySpell bodies and spell-cast events. Needs an 'or activate an ability' spend event plus ability copying (Sunken Palace) and the exile-instead resolution rider (Forger's Foundry, reusing `ExileResolvingSpellInsteadOfGraveyard`).

**CR:** 106.6, 707.10, 608.2n

### 66. DICE_MULTI

**Pattern:** Variable dice counts and per-result effects: 'Roll X six-sided dice, where X is …', 'Create a tapped Treasure token for each even result', 'plus an additional six-sided die for each mana from Treasures spent', 'As ~ enters, roll X d6. It enters with counters equal to the total'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 4 (`unparsed_quantity`×2, `unparsed_verb_arguments`×1, `enters_with_clause`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Luck Bobblehead (1); Mr. House, President and CEO (1) [also needs INSTEAD_UPGRADE]; Neverwinter Hydra (1)

**Examples:**

- Luck Bobblehead: "{1}, {T}: Roll X six-sided dice, where X is the number of Bobbleheads you control."
- Mr. House, President and CEO: "{4}, {T}: Roll a six-sided die plus an additional six-sided die for each mana from Treasures spent to activate this ability."
- Neverwinter Hydra: "It enters with a number of +1/+1 counters on it equal to the total of those results."

**Where:** `ParitySource`/`Parity` exist (even/odd). Needs a quantity dice count, per-result tallies, mana-from-Treasures spent (`ManaSpentToCast` with a source filter), and an enters-with roll total.

**CR:** 706.1, 106.6

### 67. FORETELL

**Pattern:** Foretell cost changes and mana rider: 'The first card you foretell each turn costs {0} to foretell', 'Its foretell cost is its mana cost reduced by {2}', 'Spend this mana only to foretell cards or cast spells that have foretell'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`static_structure`×1, `unrecognized_clause_head`×1, `unparsed_verb_arguments`×1).

**Cards (3, 3 deck-slots; completes 3 for 3):** Ranar the Ever-Watchful (1); Ethereal Valkyrie (1); Niko Defies Destiny (1)

**Examples:**

- Ranar the Ever-Watchful: "The first card you foretell each turn costs {0} to foretell."
- Ethereal Valkyrie: "Its foretell cost is its mana cost reduced by {2}."
- Niko Defies Destiny: "Spend this mana only to foretell cards or cast spells that have foretell."

**Where:** Foretell exists. Needs a foretell-action cost modifier and a granted foretell cost derived from the mana cost (`oracle_static/cost_mod.rs`) and a mana restriction for the foretell special action.

**CR:** 702.143

### 68. COMBAT_CONTROL

**Pattern:** 'You choose which creatures attack/block this turn and how those creatures block'

**Effort:** L. **Engine:** parser+engine. **Nodes:** 5 (`unparsed_verb_arguments`×4, `unrecognized_clause_head`×1).

**Cards (4, 6 deck-slots; completes 4 for 6):** Odric, Master Tactician (2); Master Warcraft (2); Brutal Hordechief (1) [also needs COMBAT_REQUIREMENT]; Berserker's Frenzy (1) [also needs DICE_D20_ADD]

**Examples:**

- Odric, Master Tactician: "Whenever Odric and at least three other creatures attack, you choose which creatures block this combat and how those creatures block."
- Master Warcraft: "You choose which creatures attack this turn."
- Brutal Hordechief: "{3}{R/W}{R/W}: Creatures your opponents control block this turn if able, and you choose how those creatures block."

**Where:** Needs the engine to hand another player's attack/block declaration to the effect's controller (Master Warcraft, Odric, Brutal Hordechief, Berserker's Frenzy 15–20). Combat declaration is in `game/combat.rs`; this is a new mode, not a parser fix.

**CR:** 508.1, 509.1 (declarations), 509.1a

### 69. REDIRECT_ATTACK

**Pattern:** 'reselect which player or permanent target attacking creature is attacking'

**Effort:** L. **Engine:** parser+engine. **Nodes:** 4 (`unrecognized_clause_head`×4).

**Cards (3, 6 deck-slots; completes 3 for 6):** Misleading Signpost (3); Portal Mage (2); Capricopian (1)

**Examples:**

- Misleading Signpost: "When this artifact enters during the declare attackers step, you may reselect which player or permanent target attacking creature is attacking."
- Portal Mage: "When this creature enters during the declare attackers step, you may reselect which player or permanent target attacking creature is attacking."
- Capricopian: "{2}: Put a +1/+1 counter on this creature, then you may reselect which player this creature is attacking."

**Where:** Needs an engine action to change an attacking creature's defender mid-combat (not an attack declaration, so no requirements are re-checked) plus the Capricopian activation limit 'Only the player ~ is attacking may activate'. The parser part is small.

**CR:** 506.4, 508.1b, 506.2

### 70. VOTE_AGREEMENT

**Pattern:** 'Whenever players finish voting, each opponent who voted for a choice you voted for …'

**Effort:** M. **Engine:** parser+engine. **Nodes:** 3 (`unrecognized_clause_head`×1, `unparsed_quantity`×1, `unbound_subject`×1).

**Cards (2, 2 deck-slots; completes 2 for 2):** Erestor of the Council (1); Model of Unity (1)

**Examples:**

- Erestor of the Council: "Whenever players finish voting, each opponent who voted for a choice you voted for creates a Treasure token."
- Model of Unity: "Whenever players finish voting, you and each opponent who voted for a choice you voted for may scry 2."

**Where:** Needs a players-finished-voting trigger and per-player vote records that persist past the vote's resolution, so 'voted for a choice you voted for / didn't vote for' can be evaluated. Trigger in `oracle_trigger.rs`, `TriggerMode` plus vote ledger in the engine.

**CR:** 701.38

### 71. PER_OPPONENT_PILE

**Pattern:** Per-opponent choice with a trailing clause: 'Destroy one of them chosen at random', 'Create a token that's a copy of one of those creatures, except …'

**Effort:** M. **Engine:** parser+small engine. **Nodes:** 3 (`per_opponent_choice_trailing_clause`×3).

**Cards (2, 2 deck-slots; completes 2 for 2):** Chaos Defiler (1); Benthic Anomaly (1)

**Examples:**

- Chaos Defiler: "Destroy one of them chosen at random."
- Benthic Anomaly: "Create a token that's a copy of one of those creatures, except its power is equal to the total power of those creatures, its toughness is equal to the total toughness of those creatures, and it's a colorless Eldrazi creature."

**Where:** `oracle_effect/per_opponent_choice.rs` (`per_opponent_choice_trailing_clause`). Needs the follow-on clause over the chosen set: random pick, and Benthic Anomaly's copy with aggregate P/T.

**CR:** 608.2c, 707.9 (copy exceptions)

### 72. TEXT_CHANGE

**Pattern:** Text-changing effects: 'Change the text of that creature by replacing all instances of one creature type with Vampire', 'Exchange the text boxes of those creatures'

**Effort:** L. **Engine:** parser+engine. **Nodes:** 2 (`unrecognized_clause_head`×2).

**Cards (2, 3 deck-slots; completes 2 for 3):** New Blood (2); Exchange of Words (1)

**Examples:**

- New Blood: "Change the text of that creature by replacing all instances of one creature type with Vampire."
- Exchange of Words: "For as long as this enchantment remains on the battlefield, exchange the text boxes of those creatures."

**Where:** `oracle_effect/text_change.rs` exists (`TextSubstitution`). Creature-type replacement on a target and text-box exchange need layer-3 support in the engine.

**CR:** 612.1, 612.2, 613.1c (layer 3)

## Singletons (bespoke engine work)

Each of these cards needs its own engine feature and shares no pattern with another card. Deck weight in brackets.

- **Fealty to the Realm** (2): 'The monarch controls enchanted creature.' A control-changing static whose controller follows the monarch (CR 725, 613.1b layer 2).
- **Intet, the Dreamer** (2): Exile face down and 'you may look at that card'; play it free 'for as long as Intet remains on the battlefield'. Needs a viewer permission on face-down exile and a source-bound duration (CR 406.3, 611.2b).
- **Everlasting Torment** (2): 'All damage is dealt as though its source had wither.' A global damage-result modification (CR 702.80, 120.3).
- **Sanwell, Avenger Ace** (1): Cast cap 'a vehicle or artifact creature spell from among them' (`unrepresentable_cast_cap`). Needs a typed one-of-a-pool cast permission.
- **Fatespinner** (1): The opponent chooses a step or phase, then skips every instance of it this turn. Needs skip-all-instances of a chosen step or phase (`SkipNextStep` handles one) (CR 500.11).
- **Psychic Battle** (1): Reveal-off on targeting; the winner may change targets, and 'doesn't trigger abilities of permanents named Psychic Battle'. Bespoke (CR 115.7).
- **Space Beleren** (1): Sectors (Space sculptor): a new board partition with sector-scoped blocking and counters. Un-set style mechanic, low value.
- **Victory Chimes** (1): '{T}: A player of your choice adds {C}.' A mana ability producing mana for another player, plus 'untap during each other player's untap step' (CR 605, 106.4).
- **Leonin Arbiter** (1): 'Players can't search libraries. Any player may pay {2} for that player to ignore this effect until end of turn.' Needs a special action that buys a per-player exemption from a static until end of turn (CR 116).
- **Clara Oswald** (1): 'If ~ is your commander, choose a color before the game begins. ~ is the chosen color.' Needs a pre-game commander choice and a colour-setting CDA (CR 903, 105.3).
- **Primeval Spawn** (1): 'If ~ would enter and it wasn't cast or no mana was spent to cast it, exile it instead' (the Eldrazi Titans' replacement). Needs a cast-provenance test on an ETB replacement (CR 614.1c).
- **Goblin Welder** (1): Simultaneous sacrifice and return under 'if both targets are still legal'. Needs a simultaneous two-zone swap (CR 608.2b).
- **Enhanced Surveillance** (1): 'You may look at an additional two cards each time you surveil.' Needs a surveil-count modifier (CR 701.25).
- **Necromancy** (1): Animate-Dead-style Aura that becomes 'enchant creature put onto the battlefield with ~', with flash timing and a sacrifice-at-end-step rule (CR 303.4, 702.5).
- **Plasm Capture** (1): Counter target spell; at your next first main phase add X mana in any combination of colours, where X is that spell's MV. Delayed mana with a snapshot quantity (CR 603.7).
- **Tahngarth, First Mate** (1): Gives control to the attacking opponent and puts Tahngarth into combat attacking a chosen defender (CR 506.3, 508.4).
- **Vault 112: Sadistic Simulation** (1): Saga chapter: shuffle, exile that many from top, then play one of those cards free (`bounded_batch_cast`, `shuffle`).
- **Ion Storm** (1): Cost 'Remove a +1/+1 counter or a charge counter from a permanent you control'. A disjunctive counter-removal cost (CR 118).
- **Abandoned Sarcophagus** (1): 'If a card that has a cycling ability would be put into your graveyard from anywhere and it wasn't cycled, exile it instead.' Plus cast-cycling-cards-from-graveyard. Needs a 'was cycled' provenance on a graveyard replacement.
- **Cairn Wanderer** (1): 'The same is true for fear, first strike, …, landwalk, protection, …': `ReplicateKind::StaticGrant` exists (Odric), but landwalk and protection are keyword classes with parameters (CR 702.14, 702.16).
- **Flickerform** (1): Exile enchanted creature and all Auras attached to it, return them, and reattach the Auras to it. Bespoke multi-object blink (`attached_to_qualifier`).
- **Inquisitor Eisenhorn** (1): Reveal the first card you draw each turn as you draw it; named token Cherubael. Needs a first-draw reveal hook and a named token.
- **Cruel Entertainment** (1): Two chosen players each control the other's next turn (Mindslaver both ways). `ControlNextTurn` exists for one; this needs a crossed pair (CR 723).
- **Unbound Flourishing** (1): 'Whenever you cast a permanent spell with a mana cost that contains {X}, double the value of X.' Plus: copy an instant/sorcery/ability whose cost contains {X}. Needs an X-doubling cast modifier (CR 107.3) and an X-in-cost condition.
- **Skyway Robber** (1): '~ escapes with "Whenever ~ deals combat damage…"', a granted ability on escape, casting from linked exile (CR 702.138c).
- **Aetherflux Conduit** (1): '{T}, Pay fifty {E}: Draw seven cards. You may cast any number of spells from your hand without paying their mana costs' (`cast_target_untyped`). Needs a free-cast window with no count limit over the hand.
- **Bell Borca, Spectral Sergeant** (1): 'Note the mana value of each card as it's put into exile', 'power is equal to the greatest number noted for it this turn'. `NoteNumber` exists; needs a per-turn noted max as a CDA.
- **Happily Ever After** (1): Alt-win check: five colours among permanents, six card types among permanents and/or graveyard, and life ≥ starting life. Needs a compound win condition (CR 104.2b).
- **Altar of the Pantheon** (1): 'Your devotion to each color and each combination of colors is increased by one.' A devotion modifier (CR 700.5).
- **Infinite Reflection** (1): 'Nontoken creatures you control enter as a copy of enchanted creature.' A copy-on-ETB replacement for all entering creatures (CR 614.1c, 707.9).
- **Falkenrath Gorger** (1): Grants madness to Vampire cards you own outside the battlefield, with the madness cost equal to the mana cost (CR 702.35).
- **Glimpse the Impossible** (1): Delayed 'if any of those cards remain exiled, put them into your graveyard, then create a Spawn for each card put into your graveyard this way' (`delayed_unplayed_exile_sweep`).
- **Warp World** (1): Each player shuffles all permanents into the library, reveals that many, then puts artifact/creature/land and enchantment cards onto the battlefield in order (`reveal that many`).
- **Serene Master** (1): 'exchange its power and the power of target creature it's blocking'. Needs a two-object power exchange (CR 701.12d, 613.4).
- **Ray of Command** (1): 'When you lose control of the creature, tap it.' A delayed trigger on losing control (CR 603.7).
