# Card coverage in the phase engine

Generated 2026-10-24 by `play/src/bin/coverage.rs` from card data `card-data-eb309108eb0df708.json` (phase-v0.113.0+0571ee32-yama1/cards-eb309108). The machine-readable copy is [card-coverage.json](card-coverage.json). Regenerate with:

```sh
cargo run -p yama-play --bin coverage -- data/engine/card-data-eb309108eb0df708.json ../commander-decks \
    --fixture play/tests/fixtures/deck-cards.json --smoke play/src/card_tests/smoke_cards.rs
```

## What the words mean

- **full**: none of the engine's checks found a problem. Passing them isn't proof a card plays correctly; the per-card tests are.
- **uncertain**: nothing is marked unimplemented, but the parser left a warning (often a clause it swallowed) or phase's coverage check found a gap. It may not work fully.
- **partial** (partly unimplemented): some ability, trigger, static or cost is unimplemented. The engine plays the rest of the card.
- **missing**: the engine doesn't know the card; it's left out of the game.
- **phase clean**: phase's own coverage dashboard finds no gap of any kind on any face. It runs more checks than Yama's verdict (resolver features, dropped text, subtypes), so a full card can still have a dashboard gap.

## The per-card tests

The tests are in `play/src/card_tests/` and run with the rest of the play crate (`cargo test -p yama-play`). They play each card on the real engine through Yama's own answers (`Match::act` and the option buttons), on `play/tests/fixtures/deck-cards.json`, the slice of the card data above that holds every card in this report's first table.

- **Smoke tests** (`smoke.rs`, one per card, listed in `smoke_cards.rs`): the card is played where it's used (a land played and tapped, anything else cast, in answer to an opponent's spell if it needs one), and every ability the engine offers for it, in hand and on the battlefield, is activated. Each step must finish with no panic, no engine refusal, no decision Yama can't answer and a game that settles; then the card must have done the plain thing in its smoke checks below.
- **Specific tests** check the rules outcome the Oracle text and rulings describe: the eight commanders (`commanders.rs`), the cards the decks are built around (`key_cards.rs`), and every partly unimplemented card and those the parser warned about (`partial.rs`).
- A test that shows phase is wrong is kept and marked `#[ignore = "phase bug: ..."]`; each is listed under Engine bugs found.

## Summary

| | Cards | Full | Uncertain | Partial | Missing | Phase clean |
|---|---:|---:|---:|---:|---:|---:|
| Bryan's decks and candidates | 779 | 731 (93.8%) | 14 | 34 | 0 | 730 (93.7%) |
| Precon catalog (174 precons) | 6429 | 5864 (91.2%) | 150 | 415 | 0 | 5851 (91.0%) |

By deck and list (distinct cards, basic lands counted once):

| Deck | Commander | List | Cards | Full | Uncertain | Partial | Missing |
|---|---|---|---:|---:|---:|---:|---:|
| Fantastic Four | Mister Fantastic | stock | 87 | 86 | 0 | 1 | 0 |
| Fantastic Four | Mister Fantastic | now | 87 | 86 | 0 | 1 | 0 |
| Fantastic Four | Mister Fantastic | after-prints | 87 | 86 | 0 | 1 | 0 |
| Riders of Rohan | Éowyn, Shieldmaiden | stock | 84 | 77 | 3 | 4 | 0 |
| Riders of Rohan | Éowyn, Shieldmaiden | now | 83 | 78 | 2 | 3 | 0 |
| Riders of Rohan | Éowyn, Shieldmaiden | after-prints | 85 | 84 | 1 | 0 | 0 |
| Riders of Rohan | Éowyn, Shieldmaiden | candidate | 7 | 6 | 0 | 1 | 0 |
| Lorehold Spirit | Quintorius, History Chaser | stock | 85 | 79 | 0 | 6 | 0 |
| Lorehold Spirit | Quintorius, History Chaser | now | 85 | 79 | 0 | 6 | 0 |
| Lorehold Spirit | Quintorius, History Chaser | after-prints | 85 | 82 | 0 | 3 | 0 |
| Prismari Artistry | Rootha, Mastering the Moment | stock | 87 | 80 | 3 | 4 | 0 |
| Prismari Artistry | Rootha, Mastering the Moment | now | 87 | 83 | 2 | 2 | 0 |
| Prismari Artistry | Rootha, Mastering the Moment | after-prints | 88 | 85 | 3 | 0 | 0 |
| Revival Trance | Terra, Herald of Hope | stock | 93 | 90 | 0 | 3 | 0 |
| Revival Trance | Terra, Herald of Hope | now | 93 | 90 | 0 | 3 | 0 |
| Revival Trance | Terra, Herald of Hope | after-prints | 93 | 91 | 0 | 2 | 0 |
| World Shaper | Hearthhull, the Worldseed | stock | 87 | 84 | 0 | 3 | 0 |
| World Shaper | Hearthhull, the Worldseed | now | 87 | 85 | 0 | 2 | 0 |
| World Shaper | Hearthhull, the Worldseed | after-prints | 88 | 86 | 0 | 2 | 0 |
| Tricky Terrain | Omo, Queen of Vesuva | stock | 95 | 86 | 4 | 5 | 0 |
| Tricky Terrain | Omo, Queen of Vesuva | now | 95 | 87 | 4 | 4 | 0 |
| Tricky Terrain | Omo, Queen of Vesuva | after-prints | 95 | 88 | 4 | 3 | 0 |
| Multiverse Reforged | Jace, Multiverse Architect | stock | 93 | 84 | 3 | 6 | 0 |
| Multiverse Reforged | Jace, Multiverse Architect | precon | 93 | 84 | 3 | 6 | 0 |
| Multiverse Reforged | Jace, Multiverse Architect | after-local-buys | 93 | 87 | 3 | 3 | 0 |
| Multiverse Reforged | Jace, Multiverse Architect | proposed-bracket-3 | 93 | 88 | 1 | 4 | 0 |
| Multiverse Reforged | Jace, Multiverse Architect | candidate | 30 | 28 | 0 | 2 | 0 |

## Engine bugs found

Found by the per-card tests on 2026-10-24, against phase at 678e4be (patches 0001 to 0008) and card data eb309108. Each has a test kept in `play/src/card_tests/` with `#[ignore = "phase bug: ..."]`; run them with `cargo test -p yama-play card_tests -- --ignored` (each fails until phase is fixed). Ranked by how often it would matter in Bryan's games: his commanders first, then cards in the lists he plays now and the after-prints plans, by how often the broken part comes up; stock-only cards (already cut) and unapproved candidates last. Eight of these cards are "full" in the coverage report above and six more only "uncertain": passing phase's checks isn't proof a card works.

Where a bug is in the parse (the card data), the location is phase's Oracle parser (`crates/engine/src/parser/`) and the gap handler the coverage report names; where it's in the rules code, the file is given.

### Every game, or most turns

1. **Jace, Multiverse Architect** (Multiverse Reforged's commander). Rules: at the beginning of combat on each opponent's turn, they may pay {2}; if they don't, their creatures can't attack Jaces you control this turn. phase: the "can't attack Jaces" half is unimplemented (parser, `Effect:unrecognized_clause_head`), so an opponent who doesn't pay attacks Jace anyway. Test `commanders::jace_keeps_attackers_off_unless_they_pay`.
2. **Adeline, Resplendent Cathar** (Riders of Rohan, after-prints). Rules: whenever you attack, for each opponent create a 1/1 Human that's tapped and attacking that player (ruling: one for each opponent, attacking that opponent). phase: makes one token per opponent, but all attack the same player; the parse keeps only the count and `enters_attacking`, and `crates/engine/src/game/effects/token.rs:1080` (`combat::enter_attacking`) picks one defender for each. Test `key_cards::adeline_makes_an_attacking_human_for_each_opponent`.
3. **Resonating Lute** (Prismari Artistry, now and after-prints). Rules: lands you control have "{T}: Add two mana of any one color", spent only on instants and sorceries. phase: tapping a land for it works, but a spell that needs it (Divination with two Islands) is never offered, because the castability check plans one mana per land (`crates/engine/src/game/casting.rs:21329`, `can_pay_cost_after_auto_tap`). In Yama a person only taps mana while paying, so the spell can't be cast at all. Test `key_cards::resonating_lute_doubles_land_mana_for_spells`.
4. **Study Hall** (Lorehold Spirit and Prismari Artistry, now). Rules: {1}, {T}: add one mana of any color. phase: a spell that also needs generic mana and whose colour only Study Hall makes (Augusta, {2}{W}, with a Mountain and three Wastes) isn't offered; the same castability check as the Lute. A {W} spell alone works. Its "scry X when you spend this mana on your commander" is unimplemented too (`Effect:unparsed_quantity`). Tests `partial::study_hall_pays_for_a_colour_with_generic_mana_too` and `partial::study_hall_scries_when_its_mana_casts_the_commander`.
5. **Furygale Flocking** (Prismari Artistry, every list). Rules: for each opponent, two 3/3 Elementals with flying that attack that opponent this turn if able, and gain haste. phase: the tokens have no flying, and only some get haste (the parse swallowed the clause, `Swallow:Condition_If`). Test `partial::furygale_flocking_makes_two_flyers_per_opponent`.
6. **Planar Nexus** (Tricky Terrain, every list). Rules: it's every nonbasic land type (Gate, Desert, Cave, Locus and the rest). phase: it has no land types (`Effect:effect_structure`), so it does nothing for the deck's type payoffs. Test `partial::planar_nexus_is_every_nonbasic_land_type`.
7. **Hashep Oasis** (Tricky Terrain, every list). Rules: {1}{G}{G}, {T}, sacrifice a Desert: target creature gets +3/+3; ruling: the Desert may be the Oasis itself. phase: offers the Oasis as the Desert, then refuses it: it sacrifices first and then can't pay {T} ("source is not on the battlefield", `crates/engine/src/game/costs.rs:774`). Smoke test `hashep_oasis`.
8. **Lazotep Quarry** (Tricky Terrain, every list). Rules: {X}{2}, {T}, sacrifice a Desert: exile a creature card with mana value X from your graveyard and make a 4/4 black Zombie copy. phase: offers the ability, then refuses it (an {X} cost with a sacrifice of another permanent isn't handled: `crates/engine/src/game/casting_costs.rs:6819`; a `debug_assert` panics in debug builds, release refuses). Smoke test `lazotep_quarry`.
9. **Spark Double** (Multiverse Reforged, proposed Bracket 3). Rules (ruling): copying a planeswalker, it enters with the printed loyalty plus one, and isn't legendary. phase: the copy of Jace enters with 1 loyalty counter, not 5; the intrinsic loyalty counters are worked out from the spell before it becomes a copy (`crates/engine/src/game/stack.rs:2867`). Test `key_cards::spark_double_copies_jace_with_one_more_loyalty_and_no_legend_rule`.
10. **Windgrace's Judgment** (World Shaper, every list). Rules: for any number of opponents, destroy target nonland permanent that player controls. phase: it can't be cast at all (`Effect:unrecognized_clause_head`). Test `partial::windgraces_judgment_destroys_one_per_opponent`.
11. **Sage of the Maze** and **Sunken Palace** (Tricky Terrain, every list). Sage's {T}: a land becomes an X/X Citizen with haste is unimplemented (`Effect:unparsed_verb_arguments`); Sunken Palace's mana doesn't copy the spell it pays for (`Effect:unrecognized_clause_head`). Tests `partial::sage_of_the_maze_animates_a_land`, `partial::sunken_palace_copies_the_spell_its_mana_casts`.

### When the card is played

12. **Summon: Esper Valigarmanda** (Revival Trance, every list): chapter I exiles the card, but chapters II to IV never let you cast it (`Effect:linked_exile_resolution_cast`). Test `partial::summon_esper_valigarmanda_casts_what_it_exiled`.
13. **Edgar, Master Machinist** (Revival Trance, every list): casting an artifact from the graveyard once each turn isn't offered (`Effect:static_structure`). Test `partial::edgar_casts_an_artifact_from_the_graveyard`.
14. **Augusta, Order Returned** and **Serra Paragon** (Lorehold Spirit, every list): Augusta's attack trigger exiles the cards but puts no counters (`Effect:zone_change_reflexive_event_source`); Serra Paragon offers nothing from the graveyard (`Effect:static_structure`). Tests `partial::augusta_grows_an_attacker_for_each_nonland_card_exiled`, `partial::serra_paragon_plays_a_land_from_the_graveyard`.
15. **Hex Magic** (Fantastic Four, after-prints): exiles nothing and draws nothing; "exile all the cards from your hand" parses as a move with no cards. Test `key_cards::hex_magic_swaps_your_hand_and_lets_you_play_the_old_one`.
16. **Negative Zone Portal** (Fantastic Four, every list): the upkeep coin flip with four creature cards exiled never happens (`Effect:unparsed_condition`), so its drawback never applies. Test `partial::negative_zone_portal_flips_a_coin_with_four_creatures_exiled`.
17. **Teferi's Reproach**, **Jhoira, Weatherlight Corsair**, **Darksteel Angel** and **The Ur-Sphinx** (Multiverse Reforged precon and after-local-buys). Teferi's Reproach phases nothing out; Jhoira takes the historic permanent but you lose no life; Darksteel Angel doesn't stop -1/-1 counters on your creatures; The Ur-Sphinx mills but never lets you cast the milled cards. Tests in `partial.rs`.
18. **Archfiend of Depravity** and **Sepulchral Primordial** (Multiverse Reforged proposed Bracket 3; Revival Trance stock, and Primordial in its now list). Archfiend's end step trigger asks its controller to target a creature and sacrifices nothing; Sepulchral Primordial gets one target in all instead of one in each opponent's graveyard. Tests in `key_cards.rs`.
19. **Crown of Gondor** (Riders of Rohan, now): equip doesn't cost {3} less for the monarch (`Swallow:Condition_If`). Test `partial::crown_of_gondor_equips_for_one_as_the_monarch`.
20. Cards in the now lists that the plans cut: **Abstract Performance** (an opponent picks one card, not a pile; the other seven stay in exile), **Fateful Tempest** (no council's dilemma), **Ao, the Dawn Sky** (no death modes), **Call for Aid** (haste goes to the player, not the creatures, so they can't attack; and "you can't attack that player" is missing), **Champions of Minas Tirith** and **Fealty to the Realm** (their monarch effects), **Rejoin the Fight** (the second opponent may pick the card the first chose), **Eumidian Wastewaker** (no discard or sacrifice), **Nissa, Steward of Elements** (her [0] puts nothing onto the battlefield, not even a land). Tests in `partial.rs`.

### Stock-only and candidate cards

21. **Creative Technique** (Prismari stock): "reveal until a nonland card" is unimplemented; it exiles and recasts itself, as long as you keep saying yes. **Dance with Calamity** exiles one card at most and offers no free cast. **Venerable Warsinger**'s X is unbound, so nothing can be returned. **Dearly Departed**, **Loamcrafter Faun**, **Wonderscape Sage** (never discards), **Mirrorwing Dragon** (no copies), **Selfless Squire** (no counters): their marked parts do nothing. **Dack Fayden, Helping Hand**, **Ginger, Queen of Sweets** and **Niv-Mizzet, Ghost Counsel** (Multiverse Reforged precon) likewise. **Jace's Machinations** (candidate) makes no Jace token and gives no instant-speed loyalty abilities. Tests in `partial.rs`.

### Other findings

- phase offers some actions it then refuses: Hashep Oasis above, and Ultimate Nullification (Fantastic Four stock), whose cast is offered with no legendary creature to sacrifice and then refused, "Cannot pay required additional cost" (`crates/engine/src/game/casting_costs.rs:1513`).
- Paying automatically can spend a colour you need next on generic mana: casting Éowyn ({2}{U}{R}{W}) from ten basic lands tapped all three Plains, leaving no white for Akroma's Will. Not a rules error; "Tap mana for me" off avoids it.
- Yama, not phase: the free-cast window of Improvisation Capstone and Abstract Performance ("cast spells from among them") has no Pending, and its option buttons read "Free Cast Window Choice (Selection: 59)" with an object id instead of the card's name.
- Yama, not phase: when a land's "enters tapped" and Spelunking's "enters untapped" compete, the option buttons read "Enters untapped" and "Enters tapped", but each picks which effect applies first, so "Enters untapped" leaves the land tapped (phase warns about this, `crates/engine/src/game/replacement.rs:1537`). Yama's Pending asks the right question ("Choose which effect applies first"), so it only misleads where the buttons are shown.

## Bryan's cards that aren't fully supported

| Card | Support | Decks | What phase reports |
|---|---|---|---|
| Abstract Performance | partial | Prismari Artistry (stock, now) | Effect:unparsed_verb_arguments ("Look at the cards in the other pile") |
| Ao, the Dawn Sky | partial | Lorehold Spirit (stock, now); Riders of Rohan (candidate) | Effect:modal_mode_unsupported_qualifier ("Look at the top seven cards of your library. Put any number of nonland permanent cards with total mana value 4 or less from among them onto the battlefield. Put the rest on the bottom of your library in a random order."); Effect:put_counter_tail ("Put two +1/+1 counters on each permanent you control that's a creature or Vehicle") |
| Augusta, Order Returned | partial | Lorehold Spirit (stock, now, after-prints) | Effect:zone_change_reflexive_event_source ("When one or more nonland cards are exiled this way, put that many +1/+1 counters on target attacking creature") |
| Call for Aid | partial | Riders of Rohan (stock, now) | Effect:unrecognized_clause_head ("can't attack that player") |
| Champions of Minas Tirith | partial | Riders of Rohan (stock, now) | Effect:unrecognized_clause_head ("can't attack you") |
| Creative Technique | partial | Prismari Artistry (stock) | Effect:unparsed_verb_arguments ("reveal cards from the top of it until you reveal a nonland card") |
| Dack Fayden, Helping Hand | partial | Multiverse Reforged (stock, precon) | Effect:unparsed_quantity ("For each of those permanents, choose a different opponent"); Effect:unrecognized_clause_head ("They're goaded") |
| Dance with Calamity | partial | Prismari Artistry (stock) | Effect:unrecognized_clause_head ("As many times as you choose") |
| Darksteel Angel | partial | Multiverse Reforged (stock, precon, after-local-buys, proposed-bracket-3) | Effect:static_structure ("Creatures you control can't have -1/-1 counters put on them.") |
| Dearly Departed | partial | Riders of Rohan (stock) | Effect:as_long_as_gate ("As long as ~ is in your graveyard, each Human creature you control enters with an additional +1/+1 counter on it.") |
| Deification | partial | Lorehold Spirit (now, after-prints); Multiverse Reforged (proposed-bracket-3, candidate) | Effect:unknown ("As ~ enters, choose a planeswalker type."); Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — As long as you control a creature, if damage dealt to a planeswalker you control of the chosen type would result in all loyalty counters on") |
| Edgar, Master Machinist | partial | Revival Trance (stock, now, after-prints) | Effect:static_structure ("Once during each of your turns, you may cast an artifact spell from your graveyard. If you cast a spell this way, that artifact enters tapped.") |
| Eumidian Wastewaker | partial | World Shaper (stock, now) | Effect:unbound_subject ("you and defending player each discard a card or sacrifice a permanent") |
| Fateful Tempest | partial | Lorehold Spirit (stock, now) | Effect:unparsed_quantity ("mill a card for each past vote"); Effect:unrecognized_clause_head ("Council's dilemma — Starting with you, each player votes for past or present. You mill a card for each past vote, then ~ deals damage to each opponent equal to the total mana value of cards milled this way. Exile the top card of your library for each present vote. Until the end of your next turn, you may play the exiled cards.") |
| Fealty to the Realm | partial | Riders of Rohan (stock, now) | Effect:unknown ("The monarch controls enchanted creature.") |
| Ginger, Queen of Sweets | partial | Multiverse Reforged (stock, precon) | Effect:unparsed_verb_arguments ("create a Gingerbrute token") |
| Jace's Machinations | partial | Multiverse Reforged (proposed-bracket-3, candidate) | Effect:unbound_subject ("Until end of turn, you may activate loyalty abilities of Jace planeswalkers you control on any player's turn any time you could cast an instant. Empower Jace 8.") |
| Jace, Multiverse Architect (commander) | partial | Multiverse Reforged (stock, precon, after-local-buys, proposed-bracket-3) | Effect:unrecognized_clause_head ("creatures they control can't attack Jaces you control") |
| Loamcrafter Faun | partial | World Shaper (stock) | Effect:unparsed_verb_arguments ("discard one or more land cards") |
| Negative Zone Portal | partial | Fantastic Four (stock, now, after-prints) | Effect:unparsed_condition ("if there are four or more creature cards exiled with ~, flip a coin. If you lose the flip, sacrifice ~ and return a card exiled with it at random to its owner's hand") |
| Nissa, Steward of Elements | partial | Tricky Terrain (stock, now) | Effect:unrecognized_clause_head ("or a creature card with mana value less than or equal to the number of loyalty counters on ~") |
| Niv-Mizzet, Ghost Counsel | partial | Multiverse Reforged (stock, precon) | Effect:unparsed_verb_arguments ("pay that much life") |
| Planar Nexus | partial | Tricky Terrain (stock, now, after-prints) | Effect:effect_structure ("~ is every nonbasic land type.") |
| Rejoin the Fight | partial | Revival Trance (stock, now) | Effect:unrecognized_clause_head ("starting with the next opponent in turn order") |
| Sage of the Maze | partial | Tricky Terrain (stock, now, after-prints) | Effect:unparsed_verb_arguments ("{T}: Until end of turn, target land you control becomes an X/X Citizen creature with haste in addition to its other types, where X is twice the number of Gates you control. Activate only as a sorcery.") |
| Serra Paragon | partial | Lorehold Spirit (stock, now, after-prints) | Effect:static_structure ("Once during each of your turns, you may play a land from your graveyard or cast a permanent spell with mana value 3 or less from your graveyard. If you do, it gains "When ~ is put into a graveyard from the battlefield, exile it and you gain 2 life."") |
| Squandered Resources | partial | World Shaper (after-prints) | Effect:unparsed_verb_arguments ("Sacrifice a land: Add one mana of any type the sacrificed land could produce.") |
| Study Hall | partial | Lorehold Spirit (stock, now); Prismari Artistry (stock, now) | Effect:unparsed_quantity ("When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game") |
| Summon: Esper Valigarmanda | partial | Revival Trance (stock, now, after-prints) | Effect:linked_exile_resolution_cast ("an instant or sorcery card exiled with ~"); Effect:standalone_mana_spend_concession ("mana of any type can be spent to cast that spell") |
| Sunken Palace | partial | Tricky Terrain (stock, now, after-prints) | Effect:orphaned_copy_retarget ("You may choose new targets for the copy"); Effect:unrecognized_clause_head ("When you spend this mana to cast a spell or activate an ability, copy that spell or ability") |
| The Ur-Sphinx | partial | Multiverse Reforged (stock, precon, after-local-buys) | Effect:unparsed_quantity ("For each player, you may cast a card that player milled this way without paying its mana cost") |
| Venerable Warsinger | partial | Lorehold Spirit (stock) | Effect:where_x_binding ("where X is the amount of damage ~ dealt to that player") |
| Windgrace's Judgment | partial | World Shaper (stock, now, after-prints) | Effect:unrecognized_clause_head ("For any number of opponents, destroy target nonland permanent that player controls.") |
| Wonderscape Sage | partial | Tricky Terrain (stock) | Effect:Unsupported unless clause ("discard a card unless that land had a nonbasic land type (unless: that land had a nonbasic land type)") |
| Combat Celebrant | uncertain | Riders of Rohan (stock, now, after-prints) | Swallow:Duration_ThisTurn ("[warning:swallowed-clause] Duration_ThisTurn — If this creature hasn't been exerted this turn, you may exert it as it attacks. When you do, untap all other creatures you control and after") |
| Crown of Gondor | uncertain | Riders of Rohan (stock, now) | Swallow:Condition_If ("[warning:swallowed-clause] Condition_If — Equip {4}. This ability costs {3} less to activate if you're the monarch.") |
| Furygale Flocking | uncertain | Prismari Artistry (stock, now, after-prints) | Swallow:Condition_If ("[warning:swallowed-clause] Condition_If — For each opponent, create two 3/3 blue and red Elemental creature tokens with flying that attack that opponent this turn if able. They gain") |
| Jhoira, Weatherlight Corsair | uncertain | Multiverse Reforged (stock, precon, after-local-buys) | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Whenever Jhoira enters or attacks, target opponent reveals cards from the top of their library until they reveal a historic permanent card.") |
| Mana Reflection | uncertain | Tricky Terrain (stock, now, after-prints) | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — If you tap a permanent for mana, it produces twice as much of that mana instead.") |
| Mirrorwing Dragon | uncertain | Prismari Artistry (stock) | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Flying Whenever a player casts an instant or sorcery spell that targets only this creature, that player copies that spell for each other cre") |
| Mizzix's Mastery | uncertain | Prismari Artistry (after-prints) | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Exile target card that's an instant or sorcery from your graveyard. For each card exiled this way, copy it, and you may cast the copy withou") |
| Selfless Squire | uncertain | Riders of Rohan (stock) | Trigger:Whenever damage that would be dealt to you is prevented ("Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on ~.") |
| Serra's Emissary | uncertain | Multiverse Reforged (stock, precon, after-local-buys, proposed-bracket-3) | Replacement:as_enters_projection |
| Teferi's Reproach | uncertain | Multiverse Reforged (stock, precon, after-local-buys) | Swallow:Duration_NextTurn ("[warning:swallowed-clause] Duration_NextTurn — Choose target opponent. Until that player's next turn, they gain protection from everything and their life total can't change. All nonland p") |
| Twinflame | uncertain | Prismari Artistry (stock, now, after-prints) | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Choose any number of target creatures you control. For each of them, create a token that's a copy of that creature, except it has haste. Exi") |
| Urza's Mine | uncertain | Tricky Terrain (stock, now, after-prints) | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead.") |
| Urza's Power Plant | uncertain | Tricky Terrain (stock, now, after-prints) | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Mine and an Urza's Tower, add {C}{C} instead.") |
| Urza's Tower | uncertain | Tricky Terrain (stock, now, after-prints) | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead.") |

## Bryan's cards in full

Every card in his lists and candidates, by deck (a card in several decks is listed under each). Smoke checks are what the generic smoke test checks beyond playing without an error; "plays" means only that.

### Fantastic Four (Mister Fantastic, 125 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Alicia Masters, Skilled Sculptor | stock, now, after-prints | full | yes | enters, printed 0/4 |  |
| Annie Joins Up | stock, now, after-prints | full | yes | enters |  |
| Arcane Denial | now, after-prints | full | yes | resolves |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Arid Mesa | after-prints | full | yes | plays as a land |  |
| Avengers Tower | now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Baxter Building | stock | full | yes | plays as a land, adds mana |  |
| Beast Within | now, after-prints | full | yes | resolves |  |
| Black Bolt, Inhuman King | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Bloom Tender | after-prints | full | yes | enters, printed 1/1, adds mana |  |
| Botanical Sanctum | now, after-prints | full | yes | plays as a land, adds mana |  |
| Bovine Intervention | stock | full | yes | resolves |  |
| Brainstorm | now | full | yes | resolves, draws 3 |  |
| Canopy Vista | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Chromatic Lantern | stock, now, after-prints | full | yes | enters, adds mana |  |
| Cinder Glade | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Cleansing Nova | stock, now | full | yes | resolves |  |
| Clever Concealment | stock, now, after-prints | full | yes | resolves |  |
| Clifftop Retreat | stock | full | yes | plays as a land, adds mana |  |
| Collective Effort | stock | full | yes | resolves |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Cosmic Crucible | stock, now, after-prints | full | yes | enters |  |
| Council of Reeds | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Crystal, Inhuman Princess | stock, now, after-prints | full | yes | enters, printed 2/3, adds mana |  |
| Cultivate | stock, now, after-prints | full | yes | resolves |  |
| Cut a Deal | stock | full | yes | resolves, draws 1 |  |
| Deep Analysis | stock | full | yes | resolves |  |
| Dragon Man, Reformed Robot | stock, now | full | yes | enters |  |
| Evolving Wilds | stock, now | full | yes | plays as a land |  |
| Exotic Orchard | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Expressive Iteration | stock, now, after-prints | full | yes | resolves |  |
| Fabled Passage | stock, now, after-prints | full | yes | plays as a land |  |
| Faeburrow Elder | after-prints | full | yes | enters, printed 0/0, adds mana |  |
| Fantastic Elasticity | stock, now, after-prints | full | yes | resolves |  |
| Farseek | stock, now, after-prints | full | yes | resolves |  |
| Fellwar Stone | now, after-prints | full | yes | enters, adds mana |  |
| First Family | stock, now, after-prints | full | yes | resolves |  |
| Flame On! | stock, now, after-prints | full | yes | resolves |  |
| Flooded Strand | after-prints | full | yes | plays as a land |  |
| Forest | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Franklin Richards, Ascendant | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Galactus, Devourer of Worlds | stock, now | full | yes | enters, printed 12/12 |  |
| Galvanic Iteration | stock, now, after-prints | full | yes | resolves |  |
| Genesis Ultimatum | stock | full | yes | resolves |  |
| Glacial Fortress | stock | full | yes | plays as a land, adds mana |  |
| H.E.R.B.I.E., Lovable Robot | stock, now, after-prints | full | yes | enters, printed 1/1, adds mana |  |
| Hex Magic | after-prints | full | yes | resolves |  |
| Hinterland Harbor | stock | full | yes | plays as a land, adds mana |  |
| Hull Breach | stock, now, after-prints | full | yes | resolves |  |
| Human Torch | stock, now, after-prints | full | yes | enters, printed 3/2 |  |
| Improvisation Capstone | after-prints | full | yes | resolves |  |
| Into the Time Vortex | stock | full | yes | resolves |  |
| Invisible Force Field | stock, now, after-prints | full | yes | resolves |  |
| Invisible Woman | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Island | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| It's Clobberin' Time! | stock, now, after-prints | full | yes | resolves |  |
| Izzet Signet | now, after-prints | full | yes | enters |  |
| King Solomon's Frogs | now, after-prints | full | yes | enters |  |
| Lightning Greaves | stock, now, after-prints | full | yes | enters |  |
| Lockjaw, Slobbering Teleporter | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Medusa, Inhuman Queen | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Mind's Dilation | stock, now, after-prints | full | yes | enters |  |
| Mirage Mirror | stock | full | yes | enters |  |
| Mister Fantastic | stock, now, after-prints | full | yes | enters, printed 2/4 |  |
| Mister Fantastic, Reed Richards | stock | full | yes | enters, printed 2/4 |  |
| Misty Rainforest | after-prints | full | yes | plays as a land |  |
| Monica Rambeau | now, after-prints | full | yes | enters, printed 3/3 |  |
| Monologue Tax | stock | full | yes | enters |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Namor, Atlantean King | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Nature's Lore | now, after-prints | full | yes | resolves |  |
| Negative Zone Portal | stock, now, after-prints | partial | no | enters | Effect:unparsed_condition ("if there are four or more creature cards exiled with ~, flip a coin. If you lose the flip, sacrifice ~ and return a card exiled with it at random to its owner's hand") |
| Nova Flame | stock, now | full | yes | resolves |  |
| Path of Ancestry | stock, now | full | yes | plays as a land, adds mana |  |
| Path of Discovery | stock, now | full | yes | enters |  |
| Path to Exile | stock, now, after-prints | full | yes | resolves |  |
| Plains | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Power Pack | stock, now | full | yes | enters, printed 4/4 |  |
| Prairie Stream | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Promise of Loyalty | stock, now, after-prints | full | yes | resolves |  |
| Quantum Misalignment | stock, now, after-prints | full | yes | resolves |  |
| Radiant Summit | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Raise the Palisade | after-prints | full | yes | resolves |  |
| Razorverge Thicket | now, after-prints | full | yes | plays as a land, adds mana |  |
| Recurring Insight | stock, now | full | yes | resolves |  |
| Rejuvenating Springs | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Restoration Seminar | now, after-prints | full | yes | resolves |  |
| Rootbound Crag | stock | full | yes | plays as a land, adds mana |  |
| Savannah | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Scalding Tarn | after-prints | full | yes | plays as a land |  |
| Scorched Geyser | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Seachrome Coast | now, after-prints | full | yes | plays as a land, adds mana |  |
| Seize the Day | stock, now, after-prints | full | yes | resolves |  |
| Silver Surfer, Galactus's Herald | stock | full | yes | enters, printed 4/5 |  |
| Sodden Verdure | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Sulfur Falls | stock, now | full | yes | plays as a land, adds mana |  |
| Sundown Pass | now, after-prints | full | yes | plays as a land, adds mana |  |
| Sunpetal Grove | stock | full | yes | plays as a land, adds mana |  |
| Swords to Plowshares | now, after-prints | full | yes | resolves |  |
| Taiga | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Taigam, Ojutai Master | after-prints | full | yes | enters, printed 3/4 |  |
| Talisman of Conviction | now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Talisman of Progress | now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Taunt from the Rampart | stock, now, after-prints | full | yes | resolves |  |
| Teferi's Protection | after-prints | full | yes | resolves |  |
| Terramorph | stock | full | yes | resolves |  |
| Terramorphic Expanse | stock, now | full | yes | plays as a land |  |
| The Fantastic Four | after-prints | full | yes | enters, printed 4/4 |  |
| The Fantasticar | stock | full | yes | enters |  |
| The Scarlet Witch | now | full | yes | enters, printed 2/3 |  |
| The Thing | stock, now, after-prints | full | yes | enters, printed 5/5 |  |
| Three Visits | stock, now, after-prints | full | yes | resolves |  |
| Tragic Arrogance | stock, now, after-prints | full | yes | resolves |  |
| Training Compound | now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Ultimate Nullification | stock | full | yes | resolves |  |
| Unstable Molecule Suit | stock, now, after-prints | full | yes | enters |  |
| Valeria Richards, Precocious | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Volcanic Island | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| West Coast Expansion | now, after-prints | full | yes | resolves |  |
| Whirlwind of Thought | stock, now, after-prints | full | yes | enters |  |
| Willie Lumpkin, Postman | stock | full | yes | enters, printed 1/3 |  |
| Windswept Heath | after-prints | full | yes | plays as a land |  |
| Wooded Foothills | after-prints | full | yes | plays as a land |  |
| World at War | after-prints | full | yes | resolves |  |

### Riders of Rohan (Éowyn, Shieldmaiden, 137 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Adeline, Resplendent Cathar | after-prints | full | yes | enters |  |
| Aetherize | candidate | full | yes | resolves | candidate rohan-flyers-aetherize |
| Akroma's Will | after-prints | full | yes | resolves |  |
| Anointed Procession | after-prints | full | yes | enters |  |
| Ao, the Dawn Sky | candidate | partial | no | enters, printed 5/4 | candidate rohan-flyers-ao; Effect:modal_mode_unsupported_qualifier ("Look at the top seven cards of your library. Put any number of nonland permanent cards with total mana value 4 or less from among them onto the battlefield. Put the rest on the bottom of your library in a random order."); Effect:put_counter_tail ("Put two +1/+1 counters on each permanent you control that's a creature or Vehicle") |
| Aragorn, King of Gondor | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Archangel of Tithes | candidate | full | yes | enters, printed 3/5 | candidate rohan-flyers-archangel-of-tithes |
| Archivist of Gondor | stock, now | full | yes | enters, printed 2/3 |  |
| Arid Mesa | after-prints | full | yes | plays as a land |  |
| Aurelia, the Warleader | after-prints | full | yes | enters, printed 3/4 |  |
| Banishing Light | stock, candidate | full | yes | enters | candidate rohan-flyers-banishing-light |
| Bastion Protector | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Battlefield Forge | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Beregond of the Guard | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Blade Historian | after-prints | full | yes | enters, printed 2/3 |  |
| Boromir, Gondor's Hope | stock, now, after-prints | full | yes | enters, printed 3/4 |  |
| Boromir, Warden of the Tower | now, after-prints | full | yes | enters, printed 3/3 |  |
| Boros Charm | after-prints | full | yes | resolves |  |
| Brazen Borrower | candidate | full | yes | enters, printed 3/1 | candidate rohan-flyers-brazen-borrower |
| Call for Aid | stock, now | partial | no | resolves | Effect:unrecognized_clause_head ("can't attack that player") |
| Cavern of Souls | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Champions of Minas Tirith | stock, now | partial | no | enters, printed 4/6 | Effect:unrecognized_clause_head ("can't attack you") |
| Clever Concealment | after-prints | full | yes | resolves |  |
| Clifftop Retreat | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Combat Celebrant | stock, now, after-prints | uncertain | no | enters, printed 4/1 | Swallow:Duration_ThisTurn ("[warning:swallowed-clause] Duration_ThisTurn — If this creature hasn't been exerted this turn, you may exert it as it attacks. When you do, untap all other creatures you control and after") |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Commander's Sphere | stock | full | yes | enters, adds mana |  |
| Coppercoat Vanguard | after-prints | full | yes | enters, printed 2/2 |  |
| Court of Ire | stock | full | yes | enters |  |
| Crown of Gondor | stock, now | uncertain | no | enters | Swallow:Condition_If ("[warning:swallowed-clause] Condition_If — Equip {4}. This ability costs {3} less to activate if you're the monarch.") |
| Cyclonic Rift | after-prints | full | yes | resolves |  |
| Dearly Departed | stock | partial | no | enters, printed 5/5 | Effect:as_long_as_gate ("As long as ~ is in your graveyard, each Human creature you control enters with an additional +1/+1 counter on it.") |
| Deflecting Swat | after-prints | full | yes | resolves |  |
| Denethor, Stone Seer | stock | full | yes | enters, printed 1/3 |  |
| Deserted Beach | now, after-prints | full | yes | plays as a land, adds mana |  |
| Door of Destinies | stock, now | full | yes | enters |  |
| Earthquake | stock, now | full | yes | resolves |  |
| Erkenbrand, Lord of Westfold | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Esper Sentinel | after-prints | full | yes | enters, printed 1/1 |  |
| Evolving Wilds | stock, now | full | yes | plays as a land |  |
| Exotic Orchard | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Faramir, Steward of Gondor | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Fealty to the Realm | stock, now | partial | no | enters | Effect:unknown ("The monarch controls enchanted creature.") |
| Fellwar Stone | now, after-prints | full | yes | enters, adds mana |  |
| Field of Ruin | stock | full | yes | plays as a land, adds mana |  |
| Fiend Hunter | stock, now, after-prints | full | yes | enters, printed 1/3 |  |
| Fierce Guardianship | after-prints | full | yes | resolves |  |
| Flamerush Rider | stock, now | full | yes | enters, printed 3/3 |  |
| Flawless Maneuver | after-prints | full | yes | resolves |  |
| Flooded Strand | after-prints | full | yes | plays as a land |  |
| Flowering of the White Tree | after-prints | full | yes | enters |  |
| Forth Eorlingas! | stock, now, after-prints | full | yes | resolves |  |
| Frontier Warmonger | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Frontline Medic | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Furycalm Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Generous Gift | now, after-prints | full | yes | resolves |  |
| Gilraen, Dúnedain Protector | stock, now, after-prints | full | yes | enters, printed 2/3 |  |
| Gimli of the Glittering Caves | stock, now | full | yes | enters, printed 1/1 |  |
| Glacial Fortress | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Grey Host Reinforcements | stock, now | full | yes | enters, printed 1/1 |  |
| Hallowed Fountain | now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Harsh Mentor | stock | full | yes | enters, printed 2/2 |  |
| Heirloom Blade | stock, now | full | yes | enters |  |
| Herald's Horn | stock, now, after-prints | full | yes | enters |  |
| Horn of Gondor | now, after-prints | full | yes | enters, makes 1 token |  |
| Horn of the Mark | after-prints | full | yes | enters |  |
| Humble Defector | stock | full | yes | enters, printed 2/1 |  |
| Increasing Devotion | stock, now | full | yes | resolves, makes 5 tokens |  |
| Inspiring Vantage | now, after-prints | full | yes | plays as a land, adds mana |  |
| Island | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Izzet Signet | now, after-prints | full | yes | enters |  |
| Kindred Discovery | now, after-prints | full | yes | enters |  |
| Levitation | candidate | full | yes | enters | candidate rohan-flyers-levitation |
| Loran of the Third Path | now, after-prints | full | yes | enters, printed 2/1 |  |
| Lossarnach Captain | stock | full | yes | enters, printed 3/1 |  |
| Lost to Legend | stock, now | full | yes | resolves |  |
| Marshal's Anthem | stock, now | full | yes | enters |  |
| Moonshaker Cavalry | after-prints | full | yes | enters, printed 6/6 |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Oath of Eorl | stock, now | full | yes | enters |  |
| Palace Jailer | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Path of Ancestry | stock, now | full | yes | plays as a land, adds mana |  |
| Path to Exile | stock, now, after-prints | full | yes | resolves |  |
| Plains | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Plateau | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Port Town | stock | full | yes | plays as a land, adds mana |  |
| Prairie Stream | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Prince Imrahil the Fair | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Professional Face-Breaker | after-prints | full | yes | enters, printed 2/3 |  |
| Raise the Palisade | after-prints | full | yes | resolves |  |
| Recruiter of the Guard | now, after-prints | full | yes | enters, printed 1/1 |  |
| Reinforced Ronin | now | full | yes | enters, printed 2/2 |  |
| Rhystic Study | after-prints | full | yes | enters |  |
| Riders of Rohan | stock, now, after-prints | full | yes | enters, printed 4/4, makes 2 tokens |  |
| Rising of the Day | now, after-prints | full | yes | enters |  |
| Roaming Throne | after-prints | full | yes | enters, printed 4/4 |  |
| Rogue's Passage | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Scalding Tarn | after-prints | full | yes | plays as a land |  |
| Secluded Courtyard | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Selfless Squire | stock | uncertain | no | enters, printed 1/1 | Trigger:Whenever damage that would be dealt to you is prevented ("Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on ~.") |
| Settle the Wreckage | candidate | full | yes | resolves | candidate rohan-flyers-settle-the-wreckage |
| Shared Animosity | stock, now, after-prints | full | yes | enters |  |
| Smothering Tithe | after-prints | full | yes | enters |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Steam Vents | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sulfur Falls | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Sundown Pass | now, after-prints | full | yes | plays as a land, adds mana |  |
| Sunset Revelry | stock | full | yes | resolves |  |
| Supreme Verdict | stock, now | full | yes | resolves |  |
| Swords to Plowshares | stock, now, after-prints | full | yes | resolves |  |
| Talisman of Conviction | stock, now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Talisman of Progress | stock, now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Taunt from the Rampart | stock, now, after-prints | full | yes | resolves |  |
| Teferi's Protection | after-prints | full | yes | resolves |  |
| Terramorphic Expanse | stock, now | full | yes | plays as a land |  |
| Thalia's Lieutenant | after-prints | full | yes | enters, printed 1/1 |  |
| The One Ring | after-prints | full | yes | enters |  |
| Thought Vessel | stock, now, after-prints | full | yes | enters, adds mana |  |
| Throne of the High City | stock, now | full | yes | plays as a land, adds mana |  |
| Théoden, King of Rohan | stock, now, after-prints | full | yes | enters, printed 2/3 |  |
| Tranquil Cove | stock | full | yes | plays as a land, adds mana |  |
| Tundra | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Unbreakable Formation | stock, now | full | yes | resolves |  |
| Vanquisher's Banner | stock, now | full | yes | enters |  |
| Verge Rangers | stock, now | full | yes | enters, printed 3/3 |  |
| Village Bell-Ringer | stock | full | yes | enters, printed 1/4 |  |
| Visions of Glory | stock, now | full | yes | resolves |  |
| Volcanic Island | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Wayfarer's Bauble | stock, now, after-prints | full | yes | enters |  |
| Weathered Wayfarer | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Westfold Rider | now | full | yes | enters, printed 3/1 |  |
| Wind-Scarred Crag | stock | full | yes | plays as a land, adds mana |  |
| Windbrisk Heights | stock | full | yes | plays as a land, adds mana |  |
| Zealous Conscripts | stock, now | full | yes | enters, printed 3/3 |  |
| Éomer, King of Rohan | stock, now | full | yes | enters, printed 2/2 |  |
| Éowyn, Shieldmaiden | stock, now, after-prints | full | yes | enters, printed 5/4 |  |

### Lorehold Spirit (Quintorius, History Chaser, 127 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Advanced Reconstruction | stock, now, after-prints | full | yes | enters |  |
| Akroma's Will | after-prints | full | yes | resolves |  |
| Ancient Tomb | after-prints | full | yes | plays as a land, adds mana |  |
| Angel of Indemnity | stock, now | full | yes | enters, printed 5/5 |  |
| Anger | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Anointed Procession | after-prints | full | yes | enters |  |
| Antiquities on the Loose | now | full | yes | resolves, makes 2 tokens |  |
| Ao, the Dawn Sky | stock, now | partial | no | enters, printed 5/4 | Effect:modal_mode_unsupported_qualifier ("Look at the top seven cards of your library. Put any number of nonland permanent cards with total mana value 4 or less from among them onto the battlefield. Put the rest on the bottom of your library in a random order."); Effect:put_counter_tail ("Put two +1/+1 counters on each permanent you control that's a creature or Vehicle") |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Archaeomancer's Map | stock, now | full | yes | enters |  |
| Arid Mesa | after-prints | full | yes | plays as a land |  |
| Ark of Hunger | after-prints | full | yes | enters |  |
| Atsushi, the Blazing Sky | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Augusta, Order Returned | stock, now, after-prints | partial | no | enters, printed 1/3 | Effect:zone_change_reflexive_event_source ("When one or more nonland cards are exiled this way, put that many +1/+1 counters on target attacking creature") |
| Bag of Holding | now, after-prints | full | yes | enters |  |
| Balefire Liege | stock | full | yes | enters, printed 2/4 |  |
| Banon, the Returners' Leader | after-prints | full | yes | enters, printed 1/3 |  |
| Battlefield Forge | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Bitterthorn, Nissa's Animus | stock | full | yes | enters, makes 1 token |  |
| Boros Signet | now, after-prints | full | yes | enters |  |
| Caretaker's Talent | after-prints | full | yes | enters |  |
| Ceaseless Conflict | stock, now, after-prints | full | yes | resolves |  |
| Claim Jumper | stock, now | full | yes | enters, printed 3/3 |  |
| Clever Concealment | after-prints | full | yes | resolves |  |
| Clifftop Retreat | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Conspiracy Theorist | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Containment Construct | stock, now, after-prints | full | yes | enters, printed 2/1 |  |
| Currency Converter | stock, now, after-prints | full | yes | enters |  |
| Deflecting Swat | after-prints | full | yes | resolves |  |
| Deification | now, after-prints | partial | no | enters | Effect:unknown ("As ~ enters, choose a planeswalker type."); Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — As long as you control a creature, if damage dealt to a planeswalker you control of the chosen type would result in all loyalty counters on") |
| Drumbellower | stock | full | yes | enters, printed 2/1 |  |
| Eiganjo, Seat of the Empire | after-prints | full | yes | plays as a land, adds mana |  |
| Elegant Parlor | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Emeria, the Sky Ruin | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Enlightened Tutor | after-prints | full | yes | resolves |  |
| Esper Sentinel | after-prints | full | yes | enters, printed 1/1 |  |
| Excava, the Risen Past | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Exotic Orchard | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Fable of the Mirror-Breaker | after-prints | full | yes | enters |  |
| Fabled Passage | stock, now, after-prints | full | yes | plays as a land |  |
| Faithless Looting | stock, now, after-prints | full | yes | resolves, draws 2 |  |
| Fateful Tempest | stock, now | partial | no | resolves | Effect:unparsed_quantity ("mill a card for each past vote"); Effect:unrecognized_clause_head ("Council's dilemma — Starting with you, each player votes for past or present. You mill a card for each past vote, then ~ deals damage to each opponent equal to the total mana value of cards milled this way. Exile the top card of your library for each present vote. Until the end of your next turn, you may play the exiled cards.") |
| Fellwar Stone | stock, now, after-prints | full | yes | enters, adds mana |  |
| Fields of Strife | stock, now | full | yes | plays as a land, adds mana |  |
| Furycalm Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Garrison Excavator | now | full | yes | enters, printed 3/4 |  |
| Ghost Vacuum | now, after-prints | full | yes | enters |  |
| Glittering Massif | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Guardian Scalelord | stock, now | full | yes | enters, printed 3/4 |  |
| Guardian of Faith | stock, now | full | yes | enters, printed 3/2 |  |
| Hofri Ghostforge | stock, now, after-prints | full | yes | enters, printed 4/5 |  |
| Inspiring Vantage | now, after-prints | full | yes | plays as a land, adds mana |  |
| Jeska's Will | after-prints | full | yes | resolves |  |
| Kami of Ancient Law | stock, now | full | yes | enters, printed 2/2 |  |
| Karmic Guide | stock, now | full | yes | enters, printed 2/2 |  |
| Kirol, History Buff | stock | full | yes | enters, printed 2/3 |  |
| Laelia, the Blade Reforged | stock, now | full | yes | enters, printed 2/2 |  |
| Lion Sash | now, after-prints | full | yes | enters, printed 1/1 |  |
| Loran of the Third Path | after-prints | full | yes | enters, printed 2/1 |  |
| Lorehold Archivist | stock, now, after-prints | full | yes | enters, printed 3/2 |  |
| Lorehold Campus | stock | full | yes | plays as a land, adds mana |  |
| Lorehold Charm | stock, now, after-prints | full | yes | resolves |  |
| Lotus Field | stock, now | full | yes | plays as a land, adds mana |  |
| Marsh Flats | after-prints | full | yes | plays as a land |  |
| Millikin | stock, now, after-prints | full | yes | enters, printed 0/1 |  |
| Mind Stone | stock, now, after-prints | full | yes | enters, adds mana |  |
| Mistveil Plains | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Mondrak, Glory Dominus | after-prints | full | yes | enters, printed 4/4 |  |
| Monologue Tax | stock | full | yes | enters |  |
| Moonshaker Cavalry | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Naktamun Lorespinner | stock | full | yes | enters, printed 3/3 |  |
| Ojer Taq, Deepest Foundation | after-prints | full | yes | enters, printed 6/6 |  |
| On Wings of Gold | after-prints | full | yes | enters |  |
| Patchwork Banner | stock, now | full | yes | enters, adds mana |  |
| Path to Exile | stock, now, after-prints | full | yes | resolves |  |
| Perpetual Timepiece | stock | full | yes | enters |  |
| Plains | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Plateau | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Primary Research | stock, now | full | yes | enters |  |
| Prismatic Vista | after-prints | full | yes | plays as a land |  |
| Purphoros, God of the Forge | after-prints | full | yes | enters, printed 6/5 |  |
| Pursue the Past | now | full | yes | resolves, gains 2 life |  |
| Quintorius, Field Historian | stock, now | full | yes | enters, printed 2/4 |  |
| Quintorius, History Chaser | stock, now, after-prints | full | yes | enters, loyalty 5 |  |
| Quintorius, Loremaster | stock, now | full | yes | enters, printed 3/5 |  |
| Radiant Summit | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Relic Retriever | stock, now, after-prints | full | yes | enters, printed 2/1 |  |
| Relic of Progenitus | after-prints | full | yes | enters |  |
| Remorseful Cleric | stock | full | yes | enters, printed 2/1 |  |
| Rip Apart | stock, now, after-prints | full | yes | resolves |  |
| Rugged Prairie | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Sacred Foundry | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sacred Peaks | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Secret Rendezvous | stock | full | yes | resolves |  |
| Seize the Spoils | stock | full | yes | resolves, draws 2, makes 1 token |  |
| Selfless Spirit | stock, now, after-prints | full | yes | enters, printed 2/1 |  |
| Serra Paragon | stock, now, after-prints | partial | no | enters, printed 3/4 | Effect:static_structure ("Once during each of your turns, you may play a land from your graveyard or cast a permanent spell with mana value 3 or less from your graveyard. If you do, it gains "When ~ is put into a graveyard from the battlefield, exile it and you gain 2 life."") |
| Sevinne's Reclamation | stock, now, after-prints | full | yes | resolves |  |
| Shenanigans | now | full | yes | resolves |  |
| Skyclave Apparition | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Smothering Tithe | after-prints | full | yes | enters |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Spectator Seating | after-prints | full | yes | plays as a land, adds mana |  |
| Spirit of Resilience | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Spiteful Banditry | after-prints | full | yes | enters |  |
| Squee, Goblin Nabob | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Staff of the Storyteller | stock, now, after-prints | full | yes | enters, makes 1 token |  |
| Study Hall | stock, now | partial | no | plays as a land, adds mana | Effect:unparsed_quantity ("When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game") |
| Sun Titan | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Sunscorched Divide | stock, now | full | yes | plays as a land |  |
| Swords to Plowshares | stock, now, after-prints | full | yes | resolves |  |
| Talisman of Conviction | now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Teferi's Protection | after-prints | full | yes | resolves |  |
| Temple of Triumph | stock, now | full | yes | plays as a land, adds mana |  |
| Terramorphic Expanse | stock, now | full | yes | plays as a land |  |
| Teshar, Ancestor's Apostle | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| The One Ring | after-prints | full | yes | enters |  |
| Thrilling Discovery | now | full | yes | resolves, gains 2 life |  |
| Tocasia's Welcome | stock, now, after-prints | full | yes | enters |  |
| Tragic Arrogance | stock, now | full | yes | resolves |  |
| Turbulent Steppe | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Vanguard of the Restless | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Venerable Warsinger | stock | partial | no | enters, printed 3/3 | Effect:where_x_binding ("where X is the amount of damage ~ dealt to that player") |
| Wave of Reckoning | stock, now | full | yes | resolves |  |
| White Orchid Phantom | stock, now, after-prints | full | yes | enters, printed 2/2 |  |

### Prismari Artistry (Rootha, Mastering the Moment, 128 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Abrade | stock, now | full | yes | resolves |  |
| Abstract Paintmage | now, after-prints | full | yes | enters, printed 2/2 |  |
| Abstract Performance | stock, now | partial | no | resolves | Effect:unparsed_verb_arguments ("Look at the cards in the other pile") |
| Aether Gale | stock, now | full | yes | resolves |  |
| Ancient Tomb | after-prints | full | yes | plays as a land, adds mana |  |
| Arcane Denial | stock, now | full | yes | resolves |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Archmage Emeritus | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Ashling, Rekindled | now, after-prints | full | yes | enters, printed 1/3 |  |
| Big Score | stock | full | yes | resolves, draws 2, makes 2 tokens |  |
| Blasphemous Act | stock, now, after-prints | full | yes | resolves |  |
| Bloodstained Mire | after-prints | full | yes | plays as a land |  |
| Brazen Borrower | stock, now | full | yes | enters, printed 3/1 |  |
| Brudiclad, Telchor Engineer | stock | full | yes | enters, printed 4/4 |  |
| Cascade Bluffs | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Chain Reaction | stock | full | yes | resolves |  |
| Chandra's Ignition | after-prints | full | yes | resolves |  |
| Chaos Warp | stock, now, after-prints | full | yes | resolves |  |
| Coastal Peak | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Creative Technique | stock | partial | no | resolves | Effect:unparsed_verb_arguments ("reveal cards from the top of it until you reveal a nonland card") |
| Curiosity Crafter | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Cursed Mirror | stock, now, after-prints | full | yes | enters, adds mana |  |
| Cyclonic Rift | after-prints | full | yes | resolves |  |
| Dance with Calamity | stock | partial | no | resolves | Effect:unrecognized_clause_head ("As many times as you choose") |
| Deep Analysis | stock | full | yes | resolves |  |
| Deflecting Swat | after-prints | full | yes | resolves |  |
| Determined Iteration | stock, now, after-prints | full | yes | enters |  |
| Dig Through Time | stock, now, after-prints | full | yes | resolves |  |
| Dirgur Focusmage | stock, now, after-prints | full | yes | enters, printed 1/4 |  |
| Exotic Orchard | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Expressive Iteration | stock, now, after-prints | full | yes | resolves |  |
| Fabled Passage | stock, now, after-prints | full | yes | plays as a land |  |
| Faerie Mastermind | stock, now | full | yes | enters, printed 2/1 |  |
| Fellwar Stone | stock, now, after-prints | full | yes | enters, adds mana |  |
| Ferrous Lake | stock, now, after-prints | full | yes | plays as a land |  |
| Fierce Guardianship | after-prints | full | yes | resolves |  |
| Fiery Emancipation | after-prints | full | yes | enters |  |
| Flooded Strand | after-prints | full | yes | plays as a land |  |
| Frostboil Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Full Throttle | now, after-prints | full | yes | resolves |  |
| Furygale Flocking | stock, now, after-prints | uncertain | no | resolves | Swallow:Condition_If ("[warning:swallowed-clause] Condition_If — For each opponent, create two 3/3 blue and red Elemental creature tokens with flying that attack that opponent this turn if able. They gain") |
| Galazeth Prismari | stock, now, after-prints | full | yes | enters, printed 3/4, makes 1 token |  |
| Goblin Electromancer | now | full | yes | enters, printed 2/2 |  |
| Goldspan Dragon | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Hall of Oracles | stock, now | full | yes | plays as a land, adds mana |  |
| Harmonic Prodigy | stock, now, after-prints | full | yes | enters, printed 1/3 |  |
| Inspired Skypainter | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Into the Story | now, after-prints | full | yes | resolves, draws 4 |  |
| Island | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Izzet Signet | now, after-prints | full | yes | enters |  |
| Jeska's Will | after-prints | full | yes | resolves |  |
| Leitmotif Composer | stock, now | full | yes | enters, printed 2/2 |  |
| Lightning Greaves | stock, now, after-prints | full | yes | enters |  |
| Magma Opus | stock, now, after-prints | full | yes | resolves, makes 1 token, draws 2 |  |
| Magnus the Red | after-prints | full | yes | enters, printed 4/5 |  |
| Mana Confluence | after-prints | full | yes | plays as a land |  |
| Mana Drain | after-prints | full | yes | resolves |  |
| Mana Geyser | stock, now, after-prints | full | yes | resolves |  |
| Manaform Hellkite | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Mirrorwing Dragon | stock | uncertain | no | enters, printed 4/5 | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Flying Whenever a player casts an instant or sorcery spell that targets only this creature, that player copies that spell for each other cre") |
| Mizzix's Mastery | after-prints | uncertain | no | resolves | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Exile target card that's an instant or sorcery from your graveyard. For each card exiled this way, copy it, and you may cast the copy withou") |
| Molten Tributary | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Molten-Core Maestro | now | full | yes | enters, printed 2/2 |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Muddle, the Ever-Changing | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Mystic Sanctuary | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Mystical Tutor | after-prints | full | yes | resolves |  |
| Otawara, Soaring City | after-prints | full | yes | plays as a land, adds mana |  |
| Path of Ancestry | stock, now | full | yes | plays as a land, adds mana |  |
| Plargg and Nassari | stock | full | yes | enters, printed 5/4 |  |
| Polluted Delta | after-prints | full | yes | plays as a land |  |
| Prismari Campus | stock, now | full | yes | plays as a land, adds mana |  |
| Prismari Charm | stock, now, after-prints | full | yes | resolves |  |
| Prismari Command | stock, now, after-prints | full | yes | resolves |  |
| Prismari Pianist | stock, now, after-prints | full | yes | enters, printed 2/1 |  |
| Rapturous Moment | now | full | yes | resolves, draws 3 |  |
| Reality Shift | stock, now, after-prints | full | yes | resolves |  |
| Redoubled Stormsinger | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Reliquary Tower | stock, now | full | yes | plays as a land, adds mana |  |
| Renegade Bull | stock | full | yes | enters, printed 0/5 |  |
| Replication Technique | stock | full | yes | resolves |  |
| Resculpt | stock, now, after-prints | full | yes | resolves |  |
| Resonating Lute | now, after-prints | full | yes | enters |  |
| Restless Spire | stock, now | full | yes | plays as a land, adds mana |  |
| Rhystic Study | after-prints | full | yes | enters |  |
| Rionya, Fire Dancer | stock, now, after-prints | full | yes | enters, printed 3/4 |  |
| Rite of Replication | stock, now, after-prints | full | yes | resolves |  |
| Roaming Throne | after-prints | full | yes | enters, printed 4/4 |  |
| Rootha, Mastering the Moment | stock, now, after-prints | full | yes | enters, printed 3/4 |  |
| Rootha, Mercurial Artist | stock | full | yes | enters, printed 1/4 |  |
| Rousing Refrain | stock, now | full | yes | resolves |  |
| Sanar, Unfinished Genius | now | full | yes | enters, printed 0/4 |  |
| Scalding Tarn | after-prints | full | yes | plays as a land |  |
| Scorched Geyser | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Shark Typhoon | now, after-prints | full | yes | enters |  |
| Shivan Reef | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Solemn Simulacrum | stock | full | yes | enters, printed 2/2 |  |
| Spectacle Summit | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Splatter Technique | now | full | yes | resolves |  |
| Steam Vents | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Storm-Kiln Artist | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Stormcarved Coast | now, after-prints | full | yes | plays as a land, adds mana |  |
| Stormcatch Mentor | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Study Hall | stock, now | partial | no | plays as a land, adds mana | Effect:unparsed_quantity ("When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game") |
| Sulfur Falls | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Surge to Victory | stock, now, after-prints | full | yes | resolves |  |
| Talisman of Creativity | stock, now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Temple of Epiphany | stock, now | full | yes | plays as a land, adds mana |  |
| Temple of the False God | stock | full | yes | plays as a land, adds mana |  |
| Terramorphic Expanse | stock, now | full | yes | plays as a land |  |
| Terror of the Peaks | after-prints | full | yes | enters, printed 5/4 |  |
| The One Ring | after-prints | full | yes | enters |  |
| The Scarlet Witch | after-prints | full | yes | enters, printed 2/3 |  |
| Throes of Chaos | stock | full | yes | resolves |  |
| Thunderclap Drake | stock, now, after-prints | full | yes | enters, printed 2/1 |  |
| Training Center | after-prints | full | yes | plays as a land, adds mana |  |
| Treasure Cruise | stock, now, after-prints | full | yes | resolves, draws 3 |  |
| Turbulent Springs | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Twinflame | stock, now, after-prints | uncertain | no | resolves | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Choose any number of target creatures you control. For each of them, create a token that's a copy of that creature, except it has haste. Exi") |
| Veyran, Voice of Duality | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Volcanic Island | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Volcanic Salvo | stock, now, after-prints | full | yes | resolves |  |
| Volcanic Torrent | stock | full | yes | resolves |  |
| Wisdom of Ages | now | full | yes | resolves |  |
| Wooded Foothills | after-prints | full | yes | plays as a land |  |
| Zaffai and the Tempests | now | full | yes | enters, printed 5/7 |  |

### Revival Trance (Terra, Herald of Hope, 135 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Accursed Marauder | now | full | yes | enters, printed 2/1 |  |
| Alesha, Who Laughs at Fate | now, after-prints | full | yes | enters, printed 2/2 |  |
| Angel of the Ruins | stock | full | yes | enters, printed 5/7 |  |
| Anger | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Archfiend of Depravity | stock | full | yes | enters, printed 5/4 |  |
| Arid Mesa | after-prints | full | yes | plays as a land |  |
| Ash Barrens | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Aurelia, the Warleader | after-prints | full | yes | enters, printed 3/4 |  |
| Badlands | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Banon, the Returners' Leader | stock, now, after-prints | full | yes | enters, printed 1/3 |  |
| Battlefield Forge | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Bedevil | stock | full | yes | resolves |  |
| Big Score | stock | full | yes | resolves, draws 2, makes 2 tokens |  |
| Blackcleave Cliffs | now, after-prints | full | yes | plays as a land, adds mana |  |
| Blood Crypt | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Bloodstained Mire | after-prints | full | yes | plays as a land |  |
| Braids, Arisen Nightmare | after-prints | full | yes | enters, printed 3/3 |  |
| Brotherhood Regalia | after-prints | full | yes | enters |  |
| Buried Alive | now, after-prints | full | yes | resolves |  |
| Celes, Rune Knight | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Clifftop Retreat | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Coin of Fate | stock | full | yes | enters |  |
| Combustible Gearhulk | stock | full | yes | enters, printed 6/6 |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Commander's Sphere | stock | full | yes | enters, adds mana |  |
| Concealed Courtyard | now, after-prints | full | yes | plays as a land, adds mana |  |
| Crackling Doom | stock, now, after-prints | full | yes | resolves |  |
| Cyan, Vengeful Samurai | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Deflecting Swat | after-prints | full | yes | resolves |  |
| Demolition Field | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Demonic Tutor | after-prints | full | yes | resolves |  |
| Desolate Mire | stock | full | yes | plays as a land |  |
| Dragonskull Summit | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Edgar, Master Machinist | stock, now, after-prints | partial | no | enters, printed 2/4 | Effect:static_structure ("Once during each of your turns, you may cast an artifact spell from your graveyard. If you cast a spell this way, that artifact enters tapped.") |
| Espers to Magicite | stock, now, after-prints | full | yes | resolves |  |
| Evolving Wilds | stock, now | full | yes | plays as a land |  |
| Exotic Orchard | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Faithless Looting | now, after-prints | full | yes | resolves, draws 2 |  |
| Fear of Missing Out | now, after-prints | full | yes | enters, printed 2/3, draws 1 |  |
| Fetid Heath | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Flayer of the Hatebound | stock, now | full | yes | enters, printed 4/2 |  |
| Foreboding Ruins | stock, now | full | yes | plays as a land, adds mana |  |
| Furycalm Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Gaius van Baelsar | now | full | yes | enters, printed 3/2 |  |
| Gau, Feral Youth | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| General Leo Cristophe | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Geothermal Bog | stock | full | yes | plays as a land, adds mana, adds mana |  |
| Godless Shrine | now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Gogo, Mysterious Mime | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Graven Cairns | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Harmonic Prodigy | now, after-prints | full | yes | enters, printed 1/3 |  |
| Haunted Ridge | now, after-prints | full | yes | plays as a land, adds mana |  |
| High Market | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Imperial Recruiter | after-prints | full | yes | enters, printed 1/1 |  |
| Interceptor, Shadow's Hound | stock, now | full | yes | enters, printed 4/3 |  |
| Isolated Chapel | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Karmic Guide | after-prints | full | yes | enters, printed 2/2 |  |
| Kefka, Dancing Mad | stock, now | full | yes | enters, printed 6/6 |  |
| Key to the City | stock, now, after-prints | full | yes | enters |  |
| Laughing Mad | stock, now | full | yes | resolves, draws 2 |  |
| Legions to Ashes | stock, now, after-prints | full | yes | resolves |  |
| Locke, Treasure Hunter | stock, now, after-prints | full | yes | enters, printed 2/3 |  |
| Loran of the Third Path | after-prints | full | yes | enters, printed 2/1 |  |
| Luminous Broodmoth | after-prints | full | yes | enters, printed 3/4 |  |
| Marsh Flats | after-prints | full | yes | plays as a land |  |
| Meteor Golem | stock | full | yes | enters, printed 3/3 |  |
| Millikin | stock, now, after-prints | full | yes | enters, printed 0/1 |  |
| Mind Stone | stock, now, after-prints | full | yes | enters, adds mana |  |
| Mog, Moogle Warrior | stock, now, after-prints | full | yes | enters, printed 1/2 |  |
| Morbid Opportunist | stock, now, after-prints | full | yes | enters, printed 1/3 |  |
| Mortify | stock, now | full | yes | resolves |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Night's Whisper | stock, now | full | yes | resolves, draws 2 |  |
| Nomad Outpost | stock, now | full | yes | plays as a land, adds mana |  |
| Palace Jailer | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Path of Ancestry | stock, now | full | yes | plays as a land, adds mana |  |
| Phoenix Down | stock, now | full | yes | enters |  |
| Pitiless Plunderer | stock, now, after-prints | full | yes | enters, printed 1/4 |  |
| Plains | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Plateau | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Priest of Fell Rites | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Reanimate | stock, now, after-prints | full | yes | resolves |  |
| Rejoin the Fight | stock, now | partial | no | resolves | Effect:unrecognized_clause_head ("starting with the next opponent in turn order") |
| Ripples of Undeath | after-prints | full | yes | enters |  |
| Rise of the Dark Realms | stock | full | yes | resolves |  |
| Rogue's Passage | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Rugged Prairie | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Ruin Grinder | stock, now | full | yes | enters, printed 7/4 |  |
| Ruinous Ultimatum | stock, now, after-prints | full | yes | resolves |  |
| Sabin, Master Monk | stock | full | yes | enters, printed 4/3 |  |
| Sacred Foundry | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sacred Peaks | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Scrubland | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Selfless Spirit | after-prints | full | yes | enters, printed 2/1 |  |
| Sepulchral Primordial | stock, now | full | yes | enters, printed 5/4 |  |
| Setzer, Wandering Gambler | stock, now | full | yes | enters, printed 2/2, makes 1 token |  |
| Shadow, Mysterious Assassin | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Shadowblood Ridge | stock | full | yes | plays as a land |  |
| Shineshadow Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Siegfried, Famed Swordsman | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Smoldering Marsh | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Smothering Tithe | after-prints | full | yes | enters |  |
| Snort | stock | full | yes | resolves |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Solemn Simulacrum | stock, now | full | yes | enters, printed 2/2 |  |
| Stitch Together | stock, now | full | yes | resolves |  |
| Stitcher's Supplier | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Strago and Relm | stock, now | full | yes | enters, printed 1/3 |  |
| Sulfurous Springs | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Summon: Esper Valigarmanda | stock, now, after-prints | partial | no | enters, printed 3/3 | Effect:linked_exile_resolution_cast ("an instant or sorcery card exiled with ~"); Effect:standalone_mana_spend_concession ("mana of any type can be spent to cast that spell") |
| Sun Titan | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Sundown Pass | now, after-prints | full | yes | plays as a land, adds mana |  |
| Sunlit Marsh | stock | full | yes | plays as a land, adds mana, adds mana |  |
| Sunscorched Divide | stock | full | yes | plays as a land |  |
| Swamp | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Swiftfoot Boots | stock, now, after-prints | full | yes | enters |  |
| Sword of Feast and Famine | after-prints | full | yes | enters |  |
| Swords to Plowshares | now, after-prints | full | yes | resolves |  |
| Talisman of Conviction | stock, now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Talisman of Hierarchy | now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Talisman of Indulgence | stock, now, after-prints | full | yes | enters, adds mana, adds mana |  |
| Teferi's Protection | after-prints | full | yes | resolves |  |
| Terra, Herald of Hope | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| The Falcon, Airship Restored | stock, now, after-prints | full | yes | enters |  |
| The One Ring | after-prints | full | yes | enters |  |
| The Reaver Cleaver | after-prints | full | yes | enters |  |
| The Warring Triad | stock, now, after-prints | full | yes | enters, printed 5/5 |  |
| Thrill of Possibility | now | full | yes | resolves, draws 2 |  |
| Tragic Arrogance | stock, now, after-prints | full | yes | resolves |  |
| Umaro, Raging Yeti | stock, now | full | yes | enters, printed 6/6 |  |
| Vampiric Tutor | after-prints | full | yes | resolves |  |
| Vile Entomber | now, after-prints | full | yes | enters, printed 2/2 |  |
| Wayfarer's Bauble | stock, now, after-prints | full | yes | enters |  |
| Yawgmoth, Thran Physician | after-prints | full | yes | enters, printed 2/4 |  |

### World Shaper (Hearthhull, the Worldseed, 122 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Aftermath Analyst | stock, now, after-prints | full | yes | enters, printed 1/3 |  |
| Ancient Greenwarden | after-prints | full | yes | enters, printed 5/7 |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Augur of Autumn | stock, now, after-prints | full | yes | enters, printed 2/3 |  |
| Azusa, Lost but Seeking | after-prints | full | yes | enters, printed 1/2 |  |
| Badlands | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Baloth Prime | stock, now, after-prints | full | yes | enters, printed 10/10 |  |
| Bayou | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Beast Within | stock, now, after-prints | full | yes | resolves |  |
| Binding the Old Gods | stock, now | full | yes | enters |  |
| Blasphemous Act | stock, now, after-prints | full | yes | resolves |  |
| Blood Crypt | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Bloodstained Mire | after-prints | full | yes | plays as a land |  |
| Bojuka Bog | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Boseiju, Who Endures | after-prints | full | yes | plays as a land, adds mana |  |
| Braids, Arisen Nightmare | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Cabaretti Courtyard | stock, now, after-prints | full | yes | plays as a land |  |
| Canyon Slough | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Centaur Vinecrasher | stock, now | full | yes | enters, printed 1/1 |  |
| Cinder Glade | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Conduit of Worlds | now, after-prints | full | yes | enters |  |
| Crop Rotation | now, after-prints | full | yes | resolves |  |
| Cultivate | stock | full | yes | resolves |  |
| Dakmor Salvage | stock, now | full | yes | plays as a land, adds mana |  |
| Deflecting Swat | after-prints | full | yes | resolves |  |
| Escape Tunnel | stock, now, after-prints | full | yes | plays as a land |  |
| Escape to the Wilds | stock, now | full | yes | resolves |  |
| Eumidian Hatchery | stock, now, after-prints | full | yes | plays as a land |  |
| Eumidian Wastewaker | stock, now | partial | no | enters, printed 4/4 | Effect:unbound_subject ("you and defending player each discard a card or sacrifice a permanent") |
| Evendo Brushrazer | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Evolving Wilds | stock, now, after-prints | full | yes | plays as a land |  |
| Exploration Broodship | stock, now, after-prints | full | yes | enters |  |
| Fabled Passage | stock, now, after-prints | full | yes | plays as a land |  |
| Farseek | stock, now, after-prints | full | yes | resolves |  |
| Festering Thicket | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Field of the Dead | after-prints | full | yes | plays as a land, adds mana |  |
| Finale of Devastation | after-prints | full | yes | resolves |  |
| Forest | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Formless Genesis | stock, now | full | yes | resolves, makes 1 token |  |
| Gaea's Cradle | after-prints | full | yes | plays as a land, adds mana |  |
| Gaze of Granite | stock | full | yes | resolves |  |
| God-Eternal Bontu | stock | full | yes | enters, printed 5/6 |  |
| Groundskeeper | stock | full | yes | enters, printed 1/1 |  |
| Hammer of Purphoros | stock | full | yes | enters |  |
| Harrow | stock, now, after-prints | full | yes | resolves |  |
| Hearthhull, the Worldseed | stock, now, after-prints | full | yes | enters |  |
| Heroic Intervention | after-prints | full | yes | resolves |  |
| Horizon Explorer | stock, now, after-prints | full | yes | enters, printed 2/4 |  |
| Icetill Explorer | after-prints | full | yes | enters, printed 2/4 |  |
| Infernal Grasp | stock, now, after-prints | full | yes | resolves |  |
| Juri, Master of the Revue | stock, now | full | yes | enters, printed 1/1 |  |
| Karplusan Forest | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Korvold, Fae-Cursed King | stock, now, after-prints | full | yes | enters, printed 4/4 |  |
| Life from the Loam | now, after-prints | full | yes | resolves |  |
| Llanowar Wastes | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Loamcrafter Faun | stock | partial | no | enters, printed 3/3 | Effect:unparsed_verb_arguments ("discard one or more land cards") |
| Loot, Exuberant Explorer | now, after-prints | full | yes | enters, printed 1/4 |  |
| Lotus Cobra | after-prints | full | yes | enters, printed 2/1 |  |
| Maestros Theater | stock, now, after-prints | full | yes | plays as a land |  |
| Mayhem Devil | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Mazirek, Kraul Death Priest | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Moraug, Fury of Akoum | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Mountain | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Mountain Valley | stock, now | full | yes | plays as a land |  |
| Multani, Yavimaya's Avatar | stock | full | yes | enters, printed 0/0 |  |
| Myriad Landscape | stock, now | full | yes | plays as a land, adds mana |  |
| Nature's Lore | stock, now, after-prints | full | yes | resolves |  |
| Night's Whisper | stock, now | full | yes | resolves, draws 2 |  |
| Omnath, Locus of Rage | stock, now, after-prints | full | yes | enters, printed 5/5 |  |
| Oracle of Mul Daya | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Overgrown Tomb | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Pest Infestation | stock, now, after-prints | full | yes | resolves |  |
| Planetary Annihilation | stock, now | full | yes | resolves |  |
| Putrefy | stock, now | full | yes | resolves |  |
| Rakdos Charm | stock, now, after-prints | full | yes | resolves |  |
| Rampaging Baloths | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Ramunap Excavator | now, after-prints | full | yes | enters, printed 2/3 |  |
| Riveteers Overlook | stock, now, after-prints | full | yes | plays as a land |  |
| Rocky Tar Pit | stock, now | full | yes | plays as a land |  |
| Roiling Regrowth | stock | full | yes | resolves |  |
| Sabotender | now | full | yes | enters, printed 2/1 |  |
| Sakura-Tribe Elder | now | full | yes | enters, printed 1/1 |  |
| Satyr Wayfinder | stock | full | yes | enters, printed 1/1 |  |
| Scapeshift | after-prints | full | yes | resolves |  |
| Scouring Swarm | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Scute Swarm | after-prints | full | yes | enters, printed 1/1 |  |
| Sheltered Thicket | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Skyshroud Claim | stock, now, after-prints | full | yes | resolves |  |
| Smoldering Marsh | stock, now | full | yes | plays as a land, adds mana, adds mana |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Soul of Windgrace | stock, now, after-prints | full | yes | enters, printed 5/4 |  |
| Spelunking | now, after-prints | full | yes | enters, draws 1 |  |
| Splendid Reclamation | stock, now, after-prints | full | yes | resolves |  |
| Springbloom Druid | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Sprouting Goblin | stock | full | yes | enters, printed 2/2 |  |
| Squandered Resources | after-prints | partial | no | enters | Effect:unparsed_verb_arguments ("Sacrifice a land: Add one mana of any type the sacrificed land could produce.") |
| Stomping Ground | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sulfurous Springs | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Swamp | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Sylvan Safekeeper | after-prints | full | yes | enters, printed 1/1 |  |
| Szarel, Genesis Shepherd | stock, now, after-prints | full | yes | enters, printed 2/5 |  |
| Taiga | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Tannuk, Memorial Ensign | after-prints | full | yes | enters, printed 2/4 |  |
| Tear Asunder | stock, now, after-prints | full | yes | resolves |  |
| Terramorphic Expanse | stock, now, after-prints | full | yes | plays as a land |  |
| The Gitrog Monster | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| The One Ring | after-prints | full | yes | enters |  |
| Tireless Provisioner | now, after-prints | full | yes | enters, printed 3/2 |  |
| Tireless Tracker | stock, now, after-prints | full | yes | enters, printed 3/2 |  |
| Titania, Protector of Argoth | stock, now, after-prints | full | yes | enters, printed 5/3 |  |
| Twilight Mire | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Uurg, Spawn of Turg | stock, now | full | yes | enters |  |
| Verdant Catacombs | after-prints | full | yes | plays as a land |  |
| Vernal Fen | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Viridescent Bog | stock, now | full | yes | plays as a land |  |
| Wastes | stock, now | full | yes | plays as a land, adds mana |  |
| Windgrace's Judgment | stock, now, after-prints | partial | no | resolves | Effect:unrecognized_clause_head ("For any number of opponents, destroy target nonland permanent that player controls.") |
| Wooded Foothills | after-prints | full | yes | plays as a land |  |
| World Breaker | stock, now | full | yes | enters, printed 5/7 |  |
| Worldsoul's Rage | stock, now, after-prints | full | yes | resolves |  |
| Zuran Orb | now, after-prints | full | yes | enters |  |

### Tricky Terrain (Omo, Queen of Vesuva, 132 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Acidic Slime | stock, now, after-prints | full | yes | enters, printed 2/2 |  |
| Aesi, Tyrant of Gyre Strait | after-prints | full | yes | enters, printed 5/5 |  |
| Aggressive Biomancy | stock, now | full | yes | resolves |  |
| Ancient Greenwarden | after-prints | full | yes | enters, printed 5/7 |  |
| Apex Devastator | stock, now | full | yes | enters, printed 10/10 |  |
| Arcane Denial | stock, now, after-prints | full | yes | resolves |  |
| Arcane Signet | stock, now, after-prints | full | yes | enters, adds mana |  |
| Aven Courier | now, after-prints | full | yes | enters, printed 1/1 |  |
| Avenger of Zendikar | stock, now, after-prints | full | yes | enters, printed 5/5 |  |
| Azami, Lady of Scrolls | now, after-prints | full | yes | enters, printed 0/2 |  |
| Azusa, Lost but Seeking | after-prints | full | yes | enters, printed 1/2 |  |
| Basilisk Gate | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Beast Within | stock, now, after-prints | full | yes | resolves |  |
| Blast Zone | stock, now | full | yes | plays as a land, adds mana |  |
| Breeding Pool | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Chromatic Lantern | stock | full | yes | enters, adds mana |  |
| Cloudpost | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Command Tower | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Copy Land | stock, now, after-prints | full | yes | enters |  |
| Counterspell | now, after-prints | full | yes | resolves |  |
| Crop Rotation | now, after-prints | full | yes | resolves |  |
| Curse of the Swine | stock, now, after-prints | full | yes | resolves |  |
| Cyclonic Rift | after-prints | full | yes | resolves |  |
| Dark Depths | stock, now, after-prints | full | yes | plays as a land |  |
| Desert Warfare | stock | full | yes | enters |  |
| Desert of the Indomitable | stock, now | full | yes | plays as a land, adds mana |  |
| Desert of the Mindful | stock, now | full | yes | plays as a land, adds mana |  |
| Dreamroot Cascade | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Drown in Dreams | stock, now | full | yes | resolves |  |
| Dryad of the Ilysian Grove | stock, now, after-prints | full | yes | enters, printed 2/4 |  |
| Elvish Archdruid | now, after-prints | full | yes | enters, printed 2/2, adds mana |  |
| Elvish Rejuvenator | stock | full | yes | enters, printed 1/1 |  |
| Eureka Moment | stock, now | full | yes | resolves, draws 2 |  |
| Evacuation | stock, now | full | yes | resolves |  |
| Expedition Map | stock, now, after-prints | full | yes | enters |  |
| Exploration | after-prints | full | yes | enters |  |
| Field of the Dead | after-prints | full | yes | plays as a land, adds mana |  |
| Finale of Revelation | stock, now, after-prints | full | yes | resolves |  |
| Flooded Grove | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Floriferous Vinewall | stock, now | full | yes | enters, printed 0/2 |  |
| Fog Bank | stock, now | full | yes | enters, printed 0/2 |  |
| Forest | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Gaea's Cradle | after-prints | full | yes | plays as a land, adds mana |  |
| Glimmerpost | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Growth Spiral | stock, now, after-prints | full | yes | resolves, draws 1 |  |
| Hakbal of the Surging Soul | after-prints | full | yes | enters, printed 3/3 |  |
| Harmonize | stock, now | full | yes | resolves, draws 3 |  |
| Hashep Oasis | stock, now, after-prints | full | yes | ignored: phase bug: paying "Sacrifice a Desert" with Hashep Oasis itself is refused (it sacrifices first, then can't tap) |  |
| Herald of Hoofbeats | after-prints | full | yes | enters, printed 3/3 |  |
| Heroic Intervention | after-prints | full | yes | resolves |  |
| Hidden Cataract | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Hidden Nursery | stock, now | full | yes | plays as a land, adds mana |  |
| Hinterland Harbor | now, after-prints | full | yes | plays as a land, adds mana |  |
| Horizon of Progress | stock, now, after-prints | full | yes | plays as a land |  |
| Hour of Promise | stock, now, after-prints | full | yes | resolves |  |
| Hydra Broodmaster | stock, now | full | yes | enters, printed 7/7 |  |
| Hydroid Krasis | stock, now, after-prints | full | yes | enters, printed 0/0 |  |
| Island | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Jyoti, Moag Ancient | stock, now, after-prints | full | yes | enters, printed 2/4 |  |
| Lair of the Hydra | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Lazotep Quarry | stock, now, after-prints | full | yes | ignored: phase bug: an {X} ability with "Sacrifice a Desert" can't be activated (casting_costs.rs: non-self sacrifice cost unhandled) |  |
| Lightning Greaves | after-prints | full | yes | enters |  |
| Lord of the Unreal | after-prints | full | yes | enters, printed 2/2 |  |
| Lumbering Falls | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Lush Oasis | stock | full | yes | plays as a land, adds mana |  |
| Magus of the Candelabra | stock, now, after-prints | full | yes | enters, printed 1/2 |  |
| Mana Reflection | stock, now, after-prints | uncertain | no | enters | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — If you tap a permanent for mana, it produces twice as much of that mana instead.") |
| March from Velis Vel | stock, now | full | yes | resolves |  |
| Maskwood Nexus | after-prints | full | yes | enters |  |
| Mirage Mirror | stock, now | full | yes | enters |  |
| Misty Rainforest | after-prints | full | yes | plays as a land |  |
| Mossborn Hydra | after-prints | full | yes | enters, printed 0/0 |  |
| Natural Order | after-prints | full | yes | resolves |  |
| Nesting Grounds | now, after-prints | full | yes | plays as a land, adds mana |  |
| Nissa, Steward of Elements | stock, now | partial | no | enters | Effect:unrecognized_clause_head ("or a creature card with mana value less than or equal to the number of loyalty counters on ~") |
| Oblivion Stone | stock, now | full | yes | enters |  |
| Omo, Queen of Vesuva | stock, now, after-prints | full | yes | enters, printed 1/5 |  |
| Oracle of Mul Daya | now, after-prints | full | yes | enters, printed 2/2 |  |
| Overflowing Basin | stock, now, after-prints | full | yes | plays as a land |  |
| Planar Nexus | stock, now, after-prints | partial | no | plays as a land, adds mana | Effect:effect_structure ("~ is every nonbasic land type.") |
| Poison Dart Frog | stock, now | full | yes | enters, printed 1/1, adds mana |  |
| Pongify | stock, now, after-prints | full | yes | resolves |  |
| Priest of Titania | after-prints | full | yes | enters, printed 1/1, adds mana |  |
| Propaganda | stock, now, after-prints | full | yes | enters |  |
| Quandrix Campus | stock | full | yes | plays as a land, adds mana |  |
| Rampaging Baloths | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Rampant Frogantua | stock, now | full | yes | enters, printed 3/3 |  |
| Ramunap Excavator | stock, now, after-prints | full | yes | enters, printed 2/3 |  |
| Replication Technique | stock, now | full | yes | resolves |  |
| Roaming Throne | after-prints | full | yes | enters, printed 4/4 |  |
| Sage of the Maze | stock, now, after-prints | partial | no | enters, printed 1/3, adds mana | Effect:unparsed_verb_arguments ("{T}: Until end of turn, target land you control becomes an X/X Citizen creature with haste in addition to its other types, where X is twice the number of Gates you control. Activate only as a sorcery.") |
| Satyr Wayfinder | stock | full | yes | enters, printed 1/1 |  |
| Scute Swarm | stock, now, after-prints | full | yes | enters, printed 1/1 |  |
| Seer's Sundial | stock, now | full | yes | enters |  |
| Simic Growth Chamber | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Simic Guildgate | stock, now | full | yes | plays as a land, adds mana |  |
| Skullwinder | stock | full | yes | enters, printed 1/3 |  |
| Sodden Verdure | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Sol Ring | stock, now, after-prints | full | yes | enters, adds mana |  |
| Spelunking | now, after-prints | full | yes | enters, draws 1 |  |
| Summary Dismissal | stock | full | yes | resolves |  |
| Sunken Palace | stock, now, after-prints | partial | no | plays as a land, adds mana | Effect:orphaned_copy_retarget ("You may choose new targets for the copy"); Effect:unrecognized_clause_head ("When you spend this mana to cast a spell or activate an ability, copy that spell or ability") |
| Sylvan Scrying | stock | full | yes | resolves |  |
| Talon Gates of Madara | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Tatyova, Benthic Druid | stock, now, after-prints | full | yes | enters, printed 3/3 |  |
| Tatyova, Steward of Tides | now, after-prints | full | yes | enters, printed 3/3 |  |
| Temple of Mystery | stock, now | full | yes | plays as a land, adds mana |  |
| Terastodon | stock, now, after-prints | full | yes | enters, printed 9/9 |  |
| The One Ring | after-prints | full | yes | enters |  |
| Thespian's Stage | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Thornwood Falls | stock, now | full | yes | plays as a land, adds mana |  |
| Timber Protector | after-prints | full | yes | enters, printed 4/6 |  |
| Tireless Provisioner | now, after-prints | full | yes | enters, printed 3/2 |  |
| Treasure Cruise | stock | full | yes | resolves, draws 3 |  |
| Trenchpost | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Tropical Island | after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Ulvenwald Hydra | stock, now, after-prints | full | yes | enters |  |
| Urban Evolution | stock, now, after-prints | full | yes | resolves, draws 3 |  |
| Uro, Titan of Nature's Wrath | stock, now, after-prints | full | yes | enters, printed 6/6 |  |
| Urza's Mine | stock, now, after-prints | uncertain | no | plays as a land, adds mana | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead.") |
| Urza's Power Plant | stock, now, after-prints | uncertain | no | plays as a land, adds mana | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Mine and an Urza's Tower, add {C}{C} instead.") |
| Urza's Tower | stock, now, after-prints | uncertain | no | plays as a land, adds mana | Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — {T}: Add {C}. If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead.") |
| Verdant Catacombs | after-prints | full | yes | plays as a land |  |
| Vesuva | stock, now, after-prints | full | yes | plays as a land |  |
| Vineglimmer Snarl | stock, now | full | yes | plays as a land, adds mana |  |
| Vivien Reid | stock, now | full | yes | enters, loyalty 5 |  |
| Volatile Fault | stock, now, after-prints | full | yes | plays as a land, adds mana |  |
| Whelming Wave | after-prints | full | yes | resolves |  |
| Wonderscape Sage | stock | partial | no | enters, printed 1/3 | Effect:Unsupported unless clause ("discard a card unless that land had a nonbasic land type (unless: that land had a nonbasic land type)") |
| Wooded Foothills | after-prints | full | yes | plays as a land |  |
| Yavimaya Coast | stock, now, after-prints | full | yes | plays as a land, adds mana, adds mana |  |
| Yavimaya, Cradle of Growth | stock, now, after-prints | full | yes | plays as a land |  |

### Multiverse Reforged (Jace, Multiverse Architect, 123 cards)

| Card | Lists | Support | Phase clean | Smoke checks | Notes |
|---|---|---|---|---|---|
| Agent of Treachery | after-local-buys, proposed-bracket-3, candidate | full | yes | enters, printed 2/3 | candidate jace-agent-of-treachery |
| Akroma, Angel of Fury | stock, precon | full | yes | enters, printed 6/6 |  |
| Angel of the Ruins | after-local-buys, proposed-bracket-3, candidate | full | yes | enters, printed 5/7 | candidate jace-angel-of-the-ruins |
| Arcane Denial | proposed-bracket-3, candidate | full | yes | resolves | candidate jace-arcane-denial |
| Arcane Signet | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana |  |
| Archfiend of Depravity | after-local-buys, proposed-bracket-3, candidate | full | yes | enters, printed 5/4 | candidate jace-archfiend-of-depravity |
| Archfiend of Despair | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 6/6 |  |
| Archon of Cruelty | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 6/6 |  |
| Ardyn, the Usurper | after-local-buys, proposed-bracket-3, candidate | full | yes | enters, printed 4/4 | candidate jace-ardyn |
| Ashen Rider | proposed-bracket-3, candidate | full | yes | enters, printed 5/5 | candidate jace-ashen-rider |
| Avacyn, Angel of Horror | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 8/8 |  |
| Azorius Signet | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |
| Battlefield Forge | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Bitterblossom | proposed-bracket-3, candidate | full | yes | enters | candidate jace-bitterblossom |
| Brainstorm | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves, draws 3 |  |
| Brainsurge | stock, precon, after-local-buys | full | yes | resolves, draws 4 |  |
| Caves of Koilos | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Chaos Warp | after-local-buys, proposed-bracket-3, candidate | full | yes | resolves | candidate jace-chaos-warp |
| Chromatic Lantern | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana |  |
| Clifftop Retreat | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Command Tower | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Consecrated Sphinx | candidate | full | yes | enters, printed 4/6 | candidate jace-consecrated-sphinx |
| Contaminated Landscape | stock, precon, after-local-buys | full | yes | plays as a land, adds mana |  |
| Counterspell | after-local-buys, proposed-bracket-3, candidate | full | yes | resolves | candidate jace-counterspell |
| Currency Converter | stock, precon, after-local-buys | full | yes | enters |  |
| Cursed Mirror | stock, precon, after-local-buys | full | yes | enters, adds mana |  |
| Dack Fayden, Helping Hand | stock, precon | partial | no | enters, printed 4/6 | Effect:unparsed_quantity ("For each of those permanents, choose a different opponent"); Effect:unrecognized_clause_head ("They're goaded") |
| Darksteel Angel | stock, precon, after-local-buys, proposed-bracket-3 | partial | no | enters, printed 4/4 | Effect:static_structure ("Creatures you control can't have -1/-1 counters put on them.") |
| Deification | proposed-bracket-3, candidate | partial | no | enters | candidate jace-deification; Effect:unknown ("As ~ enters, choose a planeswalker type."); Swallow:Replacement_Instead ("[warning:swallowed-clause] Replacement_Instead — As long as you control a creature, if damage dealt to a planeswalker you control of the chosen type would result in all loyalty counters on") |
| Demonic Tutor | candidate | full | yes | resolves | candidate jace-demonic-tutor |
| Despark | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Dimir Signet | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |
| Dreadhorde Invasion | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |
| Drowned Catacomb | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Elesh Norn, Grand Cenobite | proposed-bracket-3, candidate | full | yes | enters, printed 4/7 | candidate jace-elesh-norn |
| Elspeth, Sun's Champion | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, loyalty 4 |  |
| Exotic Orchard | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Fabled Passage | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land |  |
| Fact or Fiction | stock, precon, after-local-buys | full | yes | resolves |  |
| Fatehold Charm | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Fellwar Stone | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana |  |
| Fetid Heath | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Fierce Guardianship | candidate | full | yes | resolves | candidate jace-fierce-guardianship |
| Flawless Maneuver | stock, precon, after-local-buys | full | yes | resolves |  |
| Frostboil Snarl | proposed-bracket-3, candidate | full | yes | plays as a land, adds mana | candidate jace-frostboil-snarl |
| Furycalm Snarl | proposed-bracket-3, candidate | full | yes | plays as a land, adds mana | candidate jace-furycalm-snarl |
| Ginger, Queen of Sweets | stock, precon | partial | no | enters, printed 6/4 | Effect:unparsed_verb_arguments ("create a Gingerbrute token") |
| Glacial Fortress | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Grand Crescendo | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Grave Titan | after-local-buys, proposed-bracket-3, candidate | full | yes | enters, printed 6/6 | candidate jace-grave-titan |
| Identity Echo | proposed-bracket-3, candidate | full | yes | enters | candidate jace-identity-echo |
| Island | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Isolated Chapel | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Izzet Signet | stock, precon, after-local-buys | full | yes | enters |  |
| Jace's Machinations | proposed-bracket-3, candidate | partial | no | resolves | candidate jace-jaces-machinations; Effect:unbound_subject ("Until end of turn, you may activate loyalty abilities of Jace planeswalkers you control on any player's turn any time you could cast an instant. Empower Jace 8.") |
| Jace, Multiverse Architect | stock, precon, after-local-buys, proposed-bracket-3 | partial | no | enters, loyalty 4 | Effect:unrecognized_clause_head ("creatures they control can't attack Jaces you control") |
| Jhoira, Weatherlight Corsair | stock, precon, after-local-buys | uncertain | no | enters, printed 4/5 | Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Whenever Jhoira enters or attacks, target opponent reveals cards from the top of their library until they reveal a historic permanent card.") |
| Kher Keep | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Lingering Souls | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves, makes 2 tokens |  |
| Martial Coup | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Mass Polymorph | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Memnarch, the Warden | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 8/9, makes 2 tokens |  |
| Mountain | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Mystic Gate | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Nissa, Leyline Tamer | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 5/5 |  |
| Niv-Mizzet, Ghost Counsel | stock, precon | partial | no | enters, printed 4/4 | Effect:unparsed_verb_arguments ("pay that much life") |
| Oath of Teferi | proposed-bracket-3, candidate | full | yes | enters | candidate jace-oath-of-teferi |
| Ob Nixilis, the Ascended | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 4/4 |  |
| Occult Epiphany | stock, precon, after-local-buys | full | yes | resolves |  |
| Omnath, Locus of the Void | stock, precon, after-local-buys | full | yes | enters, printed 6/6 |  |
| Overlord of the Mistmoors | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, printed 6/6 |  |
| Path of Ancestry | stock, precon, after-local-buys | full | yes | plays as a land, adds mana |  |
| Path to Exile | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Perilous Landscape | stock, precon, after-local-buys | full | yes | plays as a land, adds mana |  |
| Plains | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Plan for All Outcomes | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |
| Polymorph | proposed-bracket-3, candidate | full | yes | resolves | candidate jace-polymorph |
| Port Town | after-local-buys, proposed-bracket-3, candidate | full | yes | plays as a land, adds mana | candidate jace-port-town |
| Prairie Stream | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Proteus Staff | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |
| Radiant Summit | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Rakdos Signet | stock, precon | full | yes | enters |  |
| Reflecting Pool | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Restless Anchorage | stock, precon | full | yes | plays as a land, adds mana |  |
| Restless Spire | stock, precon, after-local-buys | full | yes | plays as a land, adds mana |  |
| Rhystic Study | proposed-bracket-3, candidate | full | yes | enters | candidate jace-rhystic-study |
| Secure the Wastes | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Sepulchral Primordial | proposed-bracket-3, candidate | full | yes | enters, printed 5/4 | candidate jace-sepulchral-primordial |
| Serra's Emissary | stock, precon, after-local-buys, proposed-bracket-3 | uncertain | no | enters, printed 7/7 | Replacement:as_enters_projection |
| Shark Typhoon | stock, precon, after-local-buys | full | yes | enters |  |
| Shineshadow Snarl | proposed-bracket-3, candidate | full | yes | plays as a land, adds mana | candidate jace-shineshadow-snarl |
| Shivan Reef | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Skrelv's Hive | stock, precon, after-local-buys, proposed-bracket-3 | full | no | enters | ResolverFeature:static_condition:OpponentPoisonAtLeast |
| Smoldering Marsh | proposed-bracket-3, candidate | full | yes | plays as a land, adds mana, adds mana | candidate jace-smoldering-marsh |
| Smothering Tithe | proposed-bracket-3, candidate | full | yes | enters | candidate jace-smothering-tithe |
| Sol Ring | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana |  |
| Spark Double | proposed-bracket-3, candidate | full | yes | enters, printed 0/0 | candidate jace-spark-double |
| Staff of the Storyteller | stock, precon, after-local-buys | full | yes | enters, makes 1 token |  |
| Stroke of Midnight | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Sulfur Falls | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Sulfurous Springs | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Sunfall | stock, precon | full | yes | resolves |  |
| Sunken Ruins | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Swamp | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana |  |
| Swords to Plowshares | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Synthetic Destiny | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Talisman of Creativity | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana, adds mana |  |
| Talisman of Dominance | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana, adds mana |  |
| Talisman of Indulgence | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana, adds mana |  |
| Talisman of Progress | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters, adds mana, adds mana |  |
| Tamiyo, Upriser Crowned | stock, precon, after-local-buys | full | yes | enters, printed 3/5 |  |
| Teferi's Protection | proposed-bracket-3, candidate | full | yes | resolves | candidate jace-teferis-protection |
| Teferi's Reproach | stock, precon, after-local-buys | uncertain | no | resolves | Swallow:Duration_NextTurn ("[warning:swallowed-clause] Duration_NextTurn — Choose target opponent. Until that player's next turn, they gain protection from everything and their life total can't change. All nonland p") |
| The Ur-Sphinx | stock, precon, after-local-buys | partial | no | enters, printed 10/10 | Effect:unparsed_quantity ("For each player, you may cast a card that player milled this way without paying its mana cost") |
| Transmogrify | proposed-bracket-3, candidate | full | yes | resolves | candidate jace-transmogrify |
| Turbulent Crater | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Turbulent Shore | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Turbulent Wetlands | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Underground River | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | plays as a land, adds mana, adds mana |  |
| Venser, Fervent Forger | stock, precon | full | yes | enters, printed 5/3 |  |
| Whirlwind of Thought | stock, precon, after-local-buys | full | yes | enters |  |
| White Sun's Twilight | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | resolves |  |
| Windcrag Siege | stock, precon, after-local-buys, proposed-bracket-3 | full | yes | enters |  |

## The precon catalog

6429 distinct cards in 174 precons. Partly unimplemented cards, by how many precons they're in (the JSON has every card that isn't fully supported, with its gaps):

| Card | Precons | What phase reports |
|---|---:|---|
| Study Hall | 10 | Effect:unparsed_quantity ("When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game") |
| Forge of Heroes | 7 | Effect:put_counter_tail ("Put a +1/+1 counter on it if it's a creature and a loyalty counter on it") |
| Duplicant | 6 | Static:Unrecognized(a card exiled with ~ is a creature card) |
| Kazuul, Tyrant of the Cliffs | 6 | Effect:unparsed_condition ("if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}") |
| Fractured Powerstone | 5 | Effect:unparsed_verb_arguments ("{T}: Roll the planar die. Activate only as a sorcery.") |
| Ichor Elixir | 5 | Effect:replacement_structure ("If you would roll one or more planar dice, instead roll that many planar dice plus one and ignore one.") |
| Dire Fleet Daredevil | 4 | Effect:unparsed_replacement ("If that spell would be put into a graveyard, exile it instead") |
| Hate Mirage | 4 | Effect:unparsed_quantity ("For each of those creatures, create a token that's a copy of that creature") |
| Reins of Power | 4 | Effect:unbound_subject ("You and that opponent each gain control of all creatures the other controls until end of turn") |
| Stalking Leonin | 4 | Effect:effect_structure ("Reveal the player you chose: Exile target creature that's attacking you if it's controlled by the chosen player. Activate only once.") |
| Voice of Many | 4 | Effect:unparsed_quantity ("draw a card for each opponent who controls fewer creatures than you") |
| Windgrace's Judgment | 4 | Effect:unrecognized_clause_head ("For any number of opponents, destroy target nonland permanent that player controls.") |
| Call the Coppercoats | 3 | Effect:unparsed_quantity ("Create X 1/1 white Human Soldier creature tokens, where X is the number of creatures those opponents control") |
| Curse of Bounty | 3 | Effect:unrecognized_clause_head ("attacking that player untaps all nonland permanents they control") |
| Dearly Departed | 3 | Effect:as_long_as_gate ("As long as ~ is in your graveyard, each Human creature you control enters with an additional +1/+1 counter on it.") |
| Death by Dragons | 3 | Effect:unrecognized_clause_head ("Each player other than target player creates a 5/5 red Dragon creature token with flying.") |
| Hooded Horror | 3 | Static:Unrecognized(as long as defending player controls the most creatures or i) |
| Jace, Architect of Thought | 3 | Effect:unrecognized_clause_head ("An opponent separates those cards into two piles"); ParseWarning:target-fallback ("[warning:target-fallback] parse_target could not classify 'pile into your hand and the other'"); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — [−8]: For each player, search that player's library for a nonland card and exile it, then that player shuffles. You may cast those cards w") |
| Misleading Signpost | 3 | Effect:unrecognized_clause_head ("reselect which player or permanent target attacking creature is attacking") |
| Sage's Reverie | 3 | Effect:unparsed_quantity ("draw a card for each Aura you control that's attached to a creature"); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature.") |
| Trail of Mystery | 3 | Effect:unparsed_verb_arguments ("if it's a creature, it gets +2/+2 until end of turn") |
| Ajani Unyielding | 2 | Effect:unrecognized_clause_head ("five loyalty counters on each other planeswalker you control") |
| Aminatou's Augury | 2 | Effect:unparsed_quantity ("for each nonland card type, you may cast a spell of that type from among the exiled cards without paying its mana cost") |
| Avacyn's Judgment | 2 | Effect:instead_condition ("If this spell's madness cost was paid, it deals X damage divided as you choose among those permanents and/or players instead") |
| Chaos Dragon | 2 | Effect:unrecognized_clause_head ("~ can't attack those players or planeswalkers they control") |
| Commander's Insight | 2 | Effect:unparsed_quantity ("Target player draws X cards plus an additional card for each time they've cast a commander from the command zone this game.") |
| Creative Technique | 2 | Effect:unparsed_verb_arguments ("reveal cards from the top of it until you reveal a nonland card") |
| Crimson Honor Guard | 2 | Effect:Unsupported unless clause ("~ deals 4 damage to that player unless they control a commander (unless: they control a commander)") |
| Dance with Calamity | 2 | Effect:unrecognized_clause_head ("As many times as you choose") |
| Dredge the Mire | 2 | Effect:unparsed_verb_arguments ("Each opponent chooses a creature card in their graveyard. Put those cards onto the battlefield under your control.") |
| Druidic Satchel | 2 | Effect:unrecognized_clause_head ("nonland card, you gain 2 life") |
| Ebony Fly | 2 | Effect:unparsed_verb_arguments ("have ~ become an X/X Insect artifact creature with flying, where X is the result") |
| Enchanter's Bane | 2 | Effect:Unsupported unless clause ("target enchantment deals damage equal to its mana value to its controller unless that player sacrifices it (unless: that player sacrifices it)") |
| Ever-Watching Threshold | 2 | Effect:unparsed_condition ("if they attacked you and/or a planeswalker you control, draw a card") |
| Everlasting Torment | 2 | Effect:effect_structure ("All damage is dealt as though its source had wither.") |
| Evolutionary Escalation | 2 | Effect:unrecognized_clause_head ("three +1/+1 counters on target creature an opponent controls") |
| Extract Brain | 2 | Effect:unparsed_verb_arguments ("Target opponent chooses X cards from their hand. Look at those cards. You may cast a spell from among them without paying its mana cost.") |
| Grimoire of the Dead | 2 | Effect:unrecognized_clause_head ("They're black Zombies in addition to their other colors and types") |
| Grist, the Hunger Tide | 2 | Effect:unrecognized_clause_head ("repeat this process") |
| Gyome, Master Chef | 2 | Effect:unparsed_quantity ("create a number of Food tokens equal to the number of nontoken creatures you had enter the battlefield under your control") |
| Havengul Lich | 2 | Effect:unrecognized_clause_head ("When you cast it this turn, ~ gains all activated abilities of that card") |
| Intet, the Dreamer | 2 | Effect:unparsed_verb_arguments ("look at that card") |
| Ixidron | 2 | Effect:unknown ("As ~ enters, turn all other nontoken creatures face down.") |
| Keen Duelist | 2 | Effect:unbound_subject ("You each lose life equal to the mana value of the card revealed by the other player") |
| Leyline Tyrant | 2 | Effect:unparsed_verb_arguments ("pay any amount of {R}") |
| Lightning Runner | 2 | Effect:additional_phase ("untap all creatures you control, and after this phase, there is an additional combat phase") |
| Loamcrafter Faun | 2 | Effect:unparsed_verb_arguments ("discard one or more land cards") |
| Marshland Bloodcaster | 2 | Effect:unrecognized_clause_head ("{1}{B}, {T}: Rather than pay the mana cost of the next spell you cast this turn, you may pay life equal to that spell's mana value.") |
| Marvo, Deep Operative | 2 | Effect:unparsed_verb_arguments ("clash with defending player"); Trigger:Whenever you win a clash ("Whenever you win a clash, draw a card. Then you may cast a spell from your hand with mana value 8 or less without paying its mana cost.") |
| Master Biomancer | 2 | Effect:replacement_structure ("Each other creature you control enters with a number of additional +1/+1 counters on it equal to ~'s power and as a Mutant in addition to its other types.") |
| Master Warcraft | 2 | Effect:unparsed_verb_arguments ("You choose which creatures attack this turn.") |
| New Blood | 2 | Effect:unrecognized_clause_head ("Change the text of that creature by replacing all instances of one creature type with Vampire") |
| Nissa, Steward of Elements | 2 | Effect:unrecognized_clause_head ("or a creature card with mana value less than or equal to the number of loyalty counters on ~") |
| O-Kagachi, Vengeful Kami | 2 | Effect:unparsed_condition ("if that player attacked you during their last turn, exile target nonland permanent that player controls") |
| Odric, Master Tactician | 2 | Effect:unparsed_verb_arguments ("choose which creatures block this combat and how those creatures block") |
| Pendant of Prosperity | 2 | Effect:unbound_subject ("~'s owner draws a card, then that player may put a land card from their hand onto the battlefield") |
| Portal Mage | 2 | Effect:unrecognized_clause_head ("reselect which player or permanent target attacking creature is attacking") |
| Rose Room Treasurer | 2 | Effect:otherwise ("Otherwise") |
| Scourge of Nel Toth | 2 | Effect:static_structure ("You may cast ~ from your graveyard by paying {B}{B} and sacrificing two creatures rather than paying its mana cost.") |
| Scythe Specter | 2 | Effect:unparsed_quantity ("who discarded a card with the greatest mana value among cards discarded this way loses life equal to that mana value") |
| Semester's End | 2 | Effect:unparsed_condition ("Each of them enters with an additional +1/+1 counter on it if it's a creature and an additional loyalty counter on it") |
| Stick Together | 2 | Effect:unparsed_verb_arguments ("Each player chooses a party from among creatures they control, then sacrifices the rest.") |
| Temur War Shaman | 2 | Effect:unparsed_verb_arguments ("if it's a creature, you may have it fight target creature you don't control") |
| Thief of Blood | 2 | Effect:enters_with_clause ("As ~ enters, remove all counters from all permanents. ~ enters with a +1/+1 counter on it for each counter removed this way.") |
| Titan Hunter | 2 | Effect:unparsed_condition ("if no creatures died this turn, ~ deals 4 damage to that player") |
| Underdark Rift | 2 | Effect:unparsed_verb_arguments ("Put target artifact, creature, or planeswalker into its owner's library just beneath the top X cards of that library, where X is the result") |
| Whisperwood Elemental | 2 | Effect:unrecognized_clause_head ("Sacrifice ~: Until end of turn, face-up nontoken creatures you control gain "When ~ dies, manifest the top card of your library."") |
| Abandoned Sarcophagus | 1 | Effect:unparsed_replacement ("If a card that has a cycling ability would be put into your graveyard from anywhere and it wasn't cycled, exile it instead") |
| Aberrant Return | 1 | Effect:unrecognized_clause_head ("Each of them enters with an additional -1/-1 counter on it") |
| Abstract Performance | 1 | Effect:unparsed_verb_arguments ("Look at the cards in the other pile") |
| Aeon Chronicler | 1 | Effect:unknown ("Suspend X—{X}{3}{U}.") |
| Aetherflux Conduit | 1 | Effect:cast_target_untyped ("any number of spells from your hand without paying their mana costs") |
| Aetheric Amplifier | 1 | Effect:unparsed_quantity ("Double the number of each kind of counter you have") |
| Afterlife from the Loam | 1 | Effect:unparsed_quantity ("For each player, choose up to one target creature card in that player's graveyard. Put those cards onto the battlefield under your control. They're Zombies in addition to their other types."); Effect:unrecognized_clause_head ("They're Zombies in addition to their other types") |
| Ajani Steadfast | 1 | Effect:emblem_creation ("[−7]: You get an emblem with "If a source would deal damage to you or a planeswalker you control, prevent all but 1 of that damage."") |
| Altar of the Pantheon | 1 | Effect:unknown ("Your devotion to each color and each combination of colors is increased by one."); Effect:unrecognized_clause_head ("a Demigod, or a legendary enchantment") |
| Ancient Cellarspawn | 1 | Effect:difference_drops_stated_subject ("target opponent loses life equal to the difference") |
| Animal Friend | 1 | Effect:put_counter_tail ("Put a +1/+1 counter on that token for each Aura and Equipment attached to ~ other than Animal Friend") |
| Anowon, the Ruin Thief | 1 | Effect:unparsed_quantity ("mill a card for each 1 damage dealt to them") |
| Anrakyr the Traveller | 1 | Effect:empty |
| Ao, the Dawn Sky | 1 | Effect:modal_mode_unsupported_qualifier ("Look at the top seven cards of your library. Put any number of nonland permanent cards with total mana value 4 or less from among them onto the battlefield. Put the rest on the bottom of your library in a random order."); Effect:put_counter_tail ("Put two +1/+1 counters on each permanent you control that's a creature or Vehicle") |
| Aradesh, the Founder | 1 | Effect:unrecognized_clause_head ("the creature that attacked gains double strike") |
| Arcade Gannon | 1 | Effect:unknown ("For Auld Lang Syne — Once during each of your turns, you may cast an artifact or Human spell from your graveyard with mana value less than or equal to the number of quest counters on ~.") |
| Arcane Endeavor | 1 | Effect:unparsed_quantity ("Draw cards equal to that result"); Effect:unparsed_verb_arguments ("Roll two d8 and choose one result. Draw cards equal to that result. Then you may cast an instant or sorcery spell with mana value less than or equal to the other result from your hand without paying its mana cost.") |
| Archangel of Strife | 1 | Effect:static_structure ("Creatures controlled by players who chose war get +3/+0."); Effect:unknown ("As ~ enters, each player chooses war or peace.") |
| Archfiend of Spite | 1 | Effect:Unsupported unless clause ("that source's controller loses that much life unless they sacrifice that many permanents of their choice (unless: they sacrifice that many permanents of their choice)"); Trigger:Whenever a source an opponent controls deals damage to ~ ("Whenever a source an opponent controls deals damage to ~, that source's controller loses that much life unless they sacrifice that many permanents of their choice.") |
| Archipelagore | 1 | Effect:where_x_binding ("where X is the number of times ~ has mutated") |
| Arvinox, the Mind Flail | 1 | Effect:standalone_mana_spend_concession ("spend mana as though it were mana of any color to cast those spells"); Effect:unparsed_verb_arguments ("look at them, you may cast permanent spells from among them") |
| Ashnod the Uncaring | 1 | Effect:unparsed_condition ("if one or more permanents were sacrificed to activate it, you may copy that ability. You may choose new targets for the copy") |
| Augusta, Order Returned | 1 | Effect:zone_change_reflexive_event_source ("When one or more nonland cards are exiled this way, put that many +1/+1 counters on target attacking creature") |
| Auspicious Starrix | 1 | Effect:where_x_binding ("where X is the number of times ~ has mutated") |
| Bell Borca, Spectral Sergeant | 1 | Effect:static_structure ("~'s power is equal to the greatest number noted for it this turn."); Effect:unknown ("Note the mana value of each card as it's put into exile.") |
| Belt of Giant Strength | 1 | Cost:where X is the power of the creature it targets ("where X is the power of the creature it targets"); Cost:{10}. This ability costs {X} less to activate ("{10}. This ability costs {X} less to activate"); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Equip {10}. This ability costs {X} less to activate, where X is the power of the creature it targets.") |
| Benthic Anomaly | 1 | Effect:per_opponent_choice_trailing_clause ("Create a token that's a copy of one of those creatures, except its power is equal to the total power of those creatures, its toughness is equal to the total toughness of those creatures, and it's a colorless Eldrazi creature") |
| Berserker's Frenzy | 1 | Effect:unparsed_verb_arguments ("Roll two d20 and ignore the lower roll."); Effect:unrecognized_clause_head ("1—14 \| Choose any number of creatures. They block this turn if able.") |
| Biomantic Mastery | 1 | Effect:unparsed_quantity ("draw a card for each creature another target player controls") |
| Biophagus | 1 | Effect:unrecognized_clause_head ("that creature enters with an additional +1/+1 counter on it") |
| Birth of the Imperium | 1 | Effect:unparsed_quantity ("Draw two cards for each opponent who controls fewer creatures than you") |
| Bitter Feud | 1 | Effect:unknown ("As ~ enters, choose two players.") |
| Bloodthirsty Adversary | 1 | Effect:unrecognized_clause_head ("When you pay this cost one or more times, put that many +1/+1 counters on ~, then exile up to that many target instant and/or sorcery cards with mana value 3 or less from your graveyard and copy them") |
| Borderland Explorer | 1 | Effect:unrecognized_clause_head ("who discarded a card this way may search their library for a basic land card") |
| Bounty of the Luxa | 1 | Effect:otherwise ("Otherwise") |
| Bruna, Light of Alabaster | 1 | Effect:unparsed_verb_arguments ("put onto the battlefield attached to it any number of Aura cards that could enchant it from your graveyard and/or hand") |
| Brutal Hordechief | 1 | Effect:unparsed_verb_arguments ("choose how those creatures block"); Effect:unrecognized_clause_head ("{3}{R/W}{R/W}: Creatures your opponents control block this turn if able, and you choose how those creatures block.") |
| Cairn Wanderer | 1 | Effect:unknown ("the same is true for landwalk, protection") |
| Cait, Cage Brawler | 1 | Effect:put_counter_tail ("Put two +1/+1 counters on ~ if you discarded the card with the greatest mana value among those cards or tied for greatest"); Effect:unbound_subject ("you and defending player each draw a card, then discard a card") |
| Call for Aid | 1 | Effect:unrecognized_clause_head ("can't attack that player") |
| Capricopian | 1 | Effect:unrecognized_clause_head ("reselect which player ~ is attacking") |
| Celestial Judgment | 1 | Effect:unparsed_verb_arguments ("For each different power among creatures on the battlefield, choose a creature with that power. Destroy each creature not chosen this way.") |
| Champions of Minas Tirith | 1 | Effect:unrecognized_clause_head ("can't attack you") |
| Change of Plans | 1 | Effect:unbound_subject ("any number of them phase out") |
| Chaos Defiler | 1 | Effect:per_opponent_choice_trailing_clause ("Destroy one of them chosen at random") |
| Clara Oswald | 1 | Effect:unknown ("Impossible Girl — If ~ is your commander, choose a color before the game begins. ~ is the chosen color.") |
| Colfenor's Urn | 1 | Effect:unparsed_condition ("if three or more cards have been exiled with ~, sacrifice it. If you do, return those cards to the battlefield under their owner's control") |
| Collision of Realms | 1 | Effect:unrecognized_clause_head ("who shuffled a nontoken creature into their library this way reveals cards from the top of their library until they reveal a creature card") |
| Commence the Endgame | 1 | Effect:unparsed_verb_arguments ("Draw two cards, then amass Zombies X, where X is the number of cards in your hand.") |
| Concord with the Kami | 1 | Effect:unparsed_condition ("Draw a card if you control an enchanted creature") |
| Contaminated Drink | 1 | Effect:unparsed_quantity ("get half X rad counters, rounded up") |
| Convert to Slime | 1 | Effect:unparsed_quantity ("Delirium — Then if there are four or more card types among cards in your graveyard, create an X/X green Ooze creature token, where X is the total mana value of permanents destroyed this way.") |
| Coram, the Undertaker | 1 | Effect:static_structure ("During each of your turns, you may play a land and cast a spell from among cards in graveyards that were put there from libraries this turn.") |
| Corrupted Crossroads | 1 | Effect:unparsed_verb_arguments ("Spend this mana only to cast a spell with devoid") |
| Creeping Renaissance | 1 | Effect:unparsed_verb_arguments ("Choose a permanent type. Return all cards of the chosen type from your graveyard to your hand.") |
| Cruel Entertainment | 1 | Effect:unrecognized_clause_head ("The first player controls the second player during the second player's next turn, and the second player controls the first player during the first player's next turn") |
| Curie, Emergent Intelligence | 1 | Effect:unparsed_quantity ("draw cards equal to its base power"); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — {1}{U}, Exile another nontoken artifact creature you control: Curie becomes a copy of the exiled creature, except it has "Whenever this crea") |
| Custodi Squire | 1 | Effect:unrecognized_clause_head ("vote for an artifact, creature, or enchantment card in your graveyard") |
| Círdan the Shipwright | 1 | Effect:unparsed_quantity ("draw a card for each vote they received"); Effect:unrecognized_clause_head ("vote for a player") |
| Dack Fayden, Helping Hand | 1 | Effect:unparsed_quantity ("For each of those permanents, choose a different opponent"); Effect:unrecognized_clause_head ("They're goaded") |
| Danse Macabre | 1 | Effect:unparsed_verb_arguments ("Roll a d20 and add the toughness of the creature you sacrificed this way"); Effect:unrecognized_clause_head ("1—14 \| Return a creature card put into a graveyard this way to the battlefield under your control.") |
| Darksteel Angel | 1 | Effect:static_structure ("Creatures you control can't have -1/-1 counters put on them.") |
| Daxos the Returned | 1 | Effect:unparsed_verb_arguments ("{1}{W}{B}: Create a white and black Spirit enchantment creature token. It has "~'s power and toughness are each equal to the number of experience counters you have."") |
| Defenders of Humanity | 1 | Effect:unparsed_condition ("Activate only if you control no creatures and only during your turn") |
| Denry Klin, Editor in Chief | 1 | Effect:unparsed_verb_arguments ("put the same number of each kind of counter on that creature") |
| Desert | 1 | Effect:unrecognized_clause_head ("Activate only during the end of combat step") |
| Disa the Restless | 1 | Effect:unparsed_verb_arguments ("create a Tarmogoyf token"); Trigger:Whenever a Lhurgoyf permanent card is put into your graveyard from anywhere other than the battlefield ("Whenever a Lhurgoyf permanent card is put into your graveyard from anywhere other than the battlefield, put it onto the battlefield.") |
| Divergent Transformations | 1 | Effect:unparsed_quantity ("For each of those creatures, its controller reveals cards from the top of their library until they reveal a creature card, puts that card onto the battlefield, then shuffles the rest into their library") |
| Djinn of Infinite Deceits | 1 | Effect:unrecognized_clause_head ("can't activate this ability during combat") |
| Domri, Anarch of Bolas | 1 | Effect:unrecognized_clause_head ("Creature spells you cast this turn can't be countered") |
| Dulcet Sirens | 1 | Effect:unparsed_verb_arguments ("{U}, {T}: Target creature attacks target opponent this turn if able.") |
| Dune Chanter | 1 | Effect:unknown ("Lands you control and land cards you own that aren't on the battlefield are Deserts in addition to their other types.") |
| Ecstatic Beauty | 1 | Effect:put_counter_tail ("Put four time counters on each of those cards that has suspend") |
| Edgar, Master Machinist | 1 | Effect:static_structure ("Once during each of your turns, you may cast an artifact spell from your graveyard. If you cast a spell this way, that artifact enters tapped.") |
| Elbrus, the Binding Blade | 1 | Elbrus, the Binding Blade: Effect:unparsed_verb_arguments ("unattach ~") |
| Elrond of the White Council | 1 | Effect:unrecognized_clause_head ("the voter chooses a creature they control") |
| Emissary of Grudges | 1 | Effect:effect_structure ("Reveal the player you chose: Choose new targets for target spell or ability if it's controlled by the chosen player and if it targets you or a permanent you control. Activate only once.") |
| Enhanced Surveillance | 1 | Effect:effect_structure ("You may look at an additional two cards each time you surveil.") |
| Epochrasite | 1 | Effect:enters_with_gate ("~ enters with three +1/+1 counters on it if you didn't cast it from your hand.") |
| Erestor of the Council | 1 | Effect:unparsed_quantity ("scry X, where X is the number of opponents who voted for a choice you didn't vote for"); Effect:unrecognized_clause_head ("who voted for a choice you voted for creates a Treasure token") |
| Ethereal Valkyrie | 1 | Effect:unrecognized_clause_head ("Its foretell cost is its mana cost reduced by {2}") |
| Eumidian Wastewaker | 1 | Effect:unbound_subject ("you and defending player each discard a card or sacrifice a permanent") |
| Eventide's Shadow | 1 | Effect:shared_equal_to_quantity_compound ("You draw cards and lose life equal to the number of counters removed this way"); Effect:unparsed_verb_arguments ("Remove any number of counters from among permanents on the battlefield. You draw cards and lose life equal to the number of counters removed this way.") |
| Exchange of Words | 1 | Effect:unrecognized_clause_head ("~ the text boxes of those creatures") |
| Exotic Pets | 1 | Effect:unparsed_verb_arguments ("put a counter of that kind on either of those tokens"); Effect:unrecognized_clause_head ("for each kind of counter among creatures you control") |
| Expert-Level Safe | 1 | Effect:otherwise ("Otherwise"); Effect:unrecognized_clause_head ("those choices are revealed") |
| Exterminate! | 1 | Effect:unrecognized_clause_head ("Replicate—Tap an untapped Dalek you control. Destroy target creature. Its controller loses 3 life.") |
| Exterminator Magmarch | 1 | Effect:unparsed_condition ("if another opponent controls one or more nonland permanents that spell could target, choose one of those permanents. Copy that spell. The copy targets the chosen permanent") |
| Eye of Doom | 1 | Effect:unparsed_verb_arguments ("choose a nonland permanent") |
| Eye of Duskmantle | 1 | Effect:static_structure ("You may play lands and cast spells from among cards in your graveyard you've surveilled this turn. If you cast a spell this way, you pay life equal to its mana value rather than paying its mana cost.") |
| Falkenrath Gorger | 1 | Effect:static_structure ("Each Vampire creature card you own that isn't on the battlefield has madness. The madness cost is equal to its mana cost.") |
| Fallaji Wayfarer | 1 | Effect:effect_structure ("~ is all colors. This ability doesn't affect its color identity.") |
| Fateful Tempest | 1 | Effect:unparsed_quantity ("mill a card for each past vote"); Effect:unrecognized_clause_head ("Council's dilemma — Starting with you, each player votes for past or present. You mill a card for each past vote, then ~ deals damage to each opponent equal to the total mana value of cards milled this way. Exile the top card of your library for each present vote. Until the end of your next turn, you may play the exiled cards.") |
| Fatespinner | 1 | Effect:unbound_subject ("The player skips each instance of the chosen step or phase this turn") |
| Fathom Seer | 1 | Effect:unknown ("Morph—Return two Islands you control to their owner's hand.") |
| Fealty to the Realm | 1 | Effect:unknown ("The monarch controls enchanted creature.") |
| Feather, Radiant Arbiter | 1 | Effect:unparsed_quantity ("for each of those creatures, copy that spell"); Effect:unrecognized_clause_head ("The copy targets that creature") |
| Fiery Encore | 1 | Effect:zone_change_reflexive_event_source ("When you discard a nonland card this way, ~ deals damage equal to that card's mana value to target creature or planeswalker") |
| Fiery Gambit | 1 | Effect:unparsed_verb_arguments ("have no effect") |
| Final-Word Phantom | 1 | Effect:static_structure ("During each opponent's end step, you may cast spells as though they had flash.") |
| Firemind's Foresight | 1 | Effect:unrecognized_clause_head ("repeat this process for instant cards with mana values 2 and 1") |
| Firkraag, Cunning Instigator | 1 | Effect:unparsed_condition ("if that creature had to attack this combat, you put a +1/+1 counter on ~ and you draw a card") |
| Flickerform | 1 | Effect:attached_to_qualifier ("all Auras attached to it") |
| Florian, Voldaren Scion | 1 | Effect:where_x_binding ("where X is the total amount of life your opponents lost this turn") |
| Forger's Foundry | 1 | Effect:unrecognized_clause_head ("When you spend this mana to cast an instant or sorcery spell with mana value 3 or less, you may exile that spell instead of putting it into its owner's graveyard as it resolves") |
| Fortunate Few | 1 | Effect:unparsed_verb_arguments ("choose a nonland permanent they don't control that hasn't been chosen this way") |
| From Under the Floorboards | 1 | Effect:instead_condition ("If this spell's madness cost was paid, instead create X of those tokens") |
| Frontline Heroism | 1 | Effect:unrecognized_clause_head ("The copy targets that token") |
| Galadriel, Elven-Queen | 1 | Effect:put_counter_tail ("put a +1/+1 counter on your Ring-bearer") |
| Gandalf, Westward Voyager | 1 | Effect:otherwise ("Otherwise") |
| Garruk, Cursed Huntsman | 1 | Effect:put_counter_tail ("put a loyalty counter on each ~ you control") |
| Gatewatch Beacon | 1 | Effect:unparsed_condition ("if ~ has loyalty counters on it, you may move a loyalty counter from ~ onto that planeswalker") |
| Geth's Summons | 1 | Effect:unparsed_quantity ("Corrupted — For each opponent who has three or more poison counters as you cast this spell, put up to one target creature card from that player's graveyard onto the battlefield under your control.") |
| Ghired, Conclave Exile | 1 | Effect:unrecognized_clause_head ("The token enters tapped and attacking") |
| Ghouls' Night Out | 1 | Effect:unrecognized_clause_head ("They're black Zombies in addition to their other colors and types") |
| Gift of Doom | 1 | Effect:replacement_structure ("As ~ is turned face up, you may attach it to a creature."); Effect:unknown ("Morph—Sacrifice another creature.") |
| Ginger, Queen of Sweets | 1 | Effect:unparsed_verb_arguments ("create a Gingerbrute token") |
| Gix, Yawgmoth Praetor | 1 | Effect:unrecognized_clause_head ("play lands") |
| Glimpse the Impossible | 1 | Effect:delayed_unplayed_exile_sweep (""); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — Exile the top three cards of your library. You may play those cards this turn. At the beginning of the next end step, if any of those cards") |
| Gluttonous Hellkite | 1 | Effect:enters_with_clause ("When you cast this spell, each player sacrifices X creatures. ~ enters with two +1/+1 counters on it for each creature sacrificed this way.") |
| Goblin Welder | 1 | Effect:unbound_subject ("that player simultaneously sacrifices the artifact") |
| Goldwardens' Gambit | 1 | Effect:unparsed_quantity ("For each of those tokens, you may attach an Equipment you control to it") |
| Grave Endeavor | 1 | Effect:unparsed_quantity ("gain X life, where X is the other result"); Effect:unparsed_verb_arguments ("Roll two d10 and choose one result. Return a creature card from your graveyard to the battlefield with a number of +1/+1 counters on it equal to that result. Then each opponent loses X life and you gain X life, where X is the other result."); Effect:where_x_binding ("where X is the other result") |
| Grave Scrabbler | 1 | Effect:unparsed_condition ("if its madness cost was paid, you may return target creature card from a graveyard to its owner's hand") |
| Great Unclean One | 1 | Effect:unparsed_quantity ("for each opponent who has less life than you") |
| Grell Philosopher | 1 | Effect:unrepresentable_mana_spend_concession ("spend blue mana as though it were mana of any color to activate those abilities") |
| Grothama, All-Devouring | 1 | Effect:unparsed_verb_arguments ("draw cards equal to the amount of damage dealt to ~ this turn by sources they controlled") |
| Guardian Archon | 1 | Effect:effect_structure ("Reveal the player you chose: You and target permanent you control each gain protection from the chosen player until end of turn. Activate only once.") |
| Guff Rewrites History | 1 | Effect:unparsed_quantity ("For each player, choose target nonenchantment, nonland permanent that player controls. Those permanents' owners shuffle them into their libraries. Each player who controlled one of those permanents exiles cards from the top of their library until they exile a nonland card, then puts the rest on the bottom of their library in a random order. Each player may cast the nonland card they exiled without paying its mana cost."); Effect:unparsed_verb_arguments ("shuffle them into their libraries"); Effect:unrecognized_clause_head ("who controlled one of those permanents exiles cards from the top of their library until they exile a nonland card") |
| Haakon, Stromgald Scourge | 1 | Effect:static_structure ("You may cast this card from your graveyard, but not from anywhere else.") |
| Hadana's Climb | 1 | Hadana's Climb: Effect:target_has_unknown_keyword_condition ("if that creature has three or more +1/+1 counters on it, transform ~") |
| Haldan, Avid Arcanist | 1 | Effect:static_structure ("You may play lands and cast noncreature spells from among cards you exiled that have fetch counters on them, and you may spend mana as though it were mana of any color to cast those spells.") |
| Happily Ever After | 1 | Effect:unrecognized_clause_head ("there are six or more card types among permanents you control and/or cards in your graveyard, and your life total is greater than or equal to your starting life total") |
| Havoc Eater | 1 | Effect:where_x_binding ("where X is the total power of creatures goaded this way") |
| Hierophant Bio-Titan | 1 | Effect:static_structure ("This spell costs {2} less to cast for each counter removed this way.") |
| Highcliff Felidar | 1 | Effect:unparsed_verb_arguments ("choose a creature with the greatest power among creatures that player controls") |
| Hoarder's Greed | 1 | Effect:unparsed_verb_arguments ("draw two cards, then clash with an opponent") |
| Hot Pursuit | 1 | Effect:unparsed_condition ("if two or more players have lost the game, gain control of all goaded and/or suspected creatures until end of turn. Untap them. They gain haste until end of turn"); Effect:unrecognized_clause_head ("As long as ~ remains on the battlefield") |
| Ian the Reckless | 1 | Effect:unparsed_condition ("if it's modified, you may have it deal damage equal to its power to you and any target") |
| Impact Resonance | 1 | Effect:where_x_binding ("~ deals X damage divided as you choose among any number of target creatures, where X is the greatest amount of damage dealt by a source to a permanent or player this turn.") |
| Infinite Reflection | 1 | Effect:replacement_structure ("Nontoken creatures you control enter as a copy of enchanted creature.") |
| Inquisitor Eisenhorn | 1 | Effect:effect_structure ("You may reveal the first card you draw each turn as you draw it. Whenever you reveal an instant or sorcery card this way, create Cherubael, a legendary 4/4 black Demon creature token with flying.") |
| Insatiable Hemophage | 1 | Effect:unparsed_quantity ("gain X life, where X is the number of times ~ has mutated"); Effect:where_x_binding ("where X is the number of times ~ has mutated") |
| Invigorate | 1 | Effect:unrecognized_clause_head ("If you control a Forest, rather than pay this spell's mana cost, you may have an opponent gain 3 life. Target creature gets +4/+4 until end of turn.") |
| Invincible Hymn | 1 | Effect:unrecognized_clause_head ("Count the number of cards in your library. Your life total becomes that number.") |
| Ion Storm | 1 | Cost:Remove a +1/+1 counter or a charge counter from a permanent you control ("Remove a +1/+1 counter or a charge counter from a permanent you control") |
| Izzet Generatorium | 1 | Effect:replacement_structure ("If you would get one or more {E} , you get that many plus one {E} instead."); Effect:unparsed_condition ("Activate only if you've paid or lost four or more {E}") |
| Jace, Mirror Mage | 1 | Effect:unparsed_quantity ("Remove a number of loyalty counters equal to that card's mana value from ~") |
| Jace, Multiverse Architect | 1 | Effect:unrecognized_clause_head ("creatures they control can't attack Jaces you control") |
| Jared Carthalion | 1 | Effect:unparsed_quantity ("put a number of +1/+1 counters on it equal to the number of colors it is"); Swallow:Condition_If ("[warning:swallowed-clause] Condition_If — [−6]: Return target multicolored card from your graveyard to your hand. If that card was all colors, draw a card and create two Treasure t") |
| Jason Bright, Glowing Prophet | 1 | Effect:unparsed_condition ("if its power was different from its base power, draw a card") |
| Jegantha, the Wellspring | 1 | Effect:unbound_subject ("This mana can't be spent to pay generic mana costs") |
| Journey to the Lost City | 1 | Effect:put_counter_tail ("put a +1/+1 counter on it for each creature card among those cards") |
| Kamiz, Obscura Oculus | 1 | Effect:unparsed_verb_arguments ("choose another attacking creature with lesser power") |
| Kaza, Roil Chaser | 1 | Effect:unparsed_quantity ("{T}: The next instant or sorcery spell you cast this turn costs {X} less to cast, where X is the number of Wizards you control as this ability resolves.") |
| Kianne, Corrupted Memory | 1 | Static:Unrecognized(~'s power is even); Static:Unrecognized(~'s power is odd) |
| Knights of the Black Rose | 1 | Effect:Unsupported monarch turn-began condition ("if you were the monarch as the turn began, that player loses 2 life and you gain 2 life") |
| Kosei, Penitent Warlord | 1 | Static:Unrecognized(~ is enchanted, equipped, and has a counter on it) |
| Kytheon, Hero of Akros | 1 | Kytheon, Hero of Akros: Effect:unparsed_condition ("if ~ and at least two other creatures attacked this combat, exile ~, then return him to the battlefield transformed under his owner's control") / Gideon, Battle-Forged: Effect:unparsed_verb_arguments ("[+2]: Up to one target creature an opponent controls attacks ~ during its controller's next turn if able.") |
| Laboratory Drudge | 1 | Effect:unparsed_condition ("draw a card if you've cast a spell from a graveyard or activated an ability of a card in a graveyard") |
| Leonin Arbiter | 1 | Effect:static_structure ("Players can't search libraries. Any player may pay {2} for that player to ignore this effect until end of turn.") |
| Leori, Sparktouched Hunter | 1 | Effect:unparsed_verb_arguments ("choose a planeswalker type"); Trigger:you activate an ability of a planeswalker of that type ("you activate an ability of a planeswalker of that type") |
| Liberated Livestock | 1 | Effect:unparsed_quantity ("For each of those tokens, you may put an Aura card from your hand and/or graveyard onto the battlefield attached to it") |
| Lily Bowen, Raging Grandma | 1 | Effect:unparsed_verb_arguments ("remove all but one +1/+1 counter from it") |
| Lim-Dûl's Vault | 1 | Effect:unparsed_verb_arguments ("put the last cards you looked at this way on top in any order"); Effect:unrecognized_clause_head ("As many times as you choose") |
| Living Lore | 1 | Effect:unknown ("As ~ enters, exile an instant or sorcery card from your graveyard.") |
| Luck Bobblehead | 1 | Effect:unparsed_quantity ("Create a tapped Treasure token for each even result"); Effect:unparsed_verb_arguments ("{1}, {T}: Roll X six-sided dice, where X is the number of Bobbleheads you control. Create a tapped Treasure token for each even result. If you rolled 6 exactly seven times, you win the game.") |
| Ludevic, Necro-Alchemist | 1 | Effect:unparsed_condition ("draw a card if a player other than you lost life") |
| Magus of the Mind | 1 | Effect:unrecognized_clause_head ("play lands"); Effect:where_x_binding ("where X is one plus the number of spells cast this turn") |
| Mairsil, the Pretender | 1 | Effect:static_structure ("~ has all activated abilities of all cards you own in exile with cage counters on them. You may activate each of those abilities only once each turn.") |
| Mana-Charged Dragon | 1 | Effect:unrecognized_clause_head ("starting with you may pay any amount of mana") |
| Manifold Insights | 1 | Effect:unparsed_verb_arguments ("choose a different nonland card from among them"); Effect:unrecognized_clause_head ("Starting with the next opponent in turn order") |
| Marath, Will of the Wild | 1 | Effect:unrecognized_clause_head ("X can't be 0") |
| Marcus, Mutant Mayor | 1 | Effect:unparsed_condition ("draw a card if that creature has a +1/+1 counter on it") |
| Mariposa Military Base | 1 | Effect:static_structure ("You may have ~ enter tapped. If you do, you get two rad counters.") |
| Mask of the Schemer | 1 | Effect:where_x_binding ("where X is the amount of damage it dealt to that player") |
| Master of Predicaments | 1 | Effect:unrecognized_clause_head ("That player guesses whether the card's mana value is greater than 4") |
| Matter Reshaper | 1 | Effect:otherwise ("Otherwise") |
| Mirkwood Trapper | 1 | Effect:unparsed_verb_arguments ("choose an attacking creature") |
| Mirri, Weatherlight Duelist | 1 | Effect:unrecognized_clause_head ("can't block with more than one creature") |
| Mission Briefing | 1 | Effect:unparsed_replacement ("If that spell would be put into your graveyard, exile it instead") |
| Missy | 1 | Effect:unparsed_verb_arguments ("you draw a card and chaos ensues") |
| Mob Verdict | 1 | Effect:unparsed_quantity ("For each vote you received, draw a card"); Effect:unrecognized_clause_head ("Secret council — Each player secretly votes for another player, then those votes are revealed. For each vote an opponent received, ~ deals 2 damage to that player and each creature that player controls. For each vote you received, draw a card.") |
| Model of Unity | 1 | Effect:unbound_subject ("you and each opponent who voted for a choice you voted for may scry 2") |
| Mortarion, Daemon Primarch | 1 | Effect:unrecognized_clause_head ("X can't be greater than the amount of life you lost this turn") |
| Motivated Pony | 1 | Effect:unparsed_verb_arguments ("they get an additional +2/+2") |
| Mr. House, President and CEO | 1 | Effect:instead_condition ("If you rolled 6 or higher, instead create that token and a Treasure token"); Effect:unparsed_quantity ("{4}, {T}: Roll a six-sided die plus an additional six-sided die for each mana from Treasures spent to activate this ability.") |
| Mysterious Stranger | 1 | Effect:unparsed_quantity ("for each graveyard with an instant or sorcery card in it, exile target instant or sorcery card from that graveyard") |
| Myth Unbound | 1 | Effect:static_structure ("Your commander costs {1} less to cast for each time it's been cast from the command zone this game."); Trigger:Whenever your commander is put into the command zone from anywhere ("Whenever your commander is put into the command zone from anywhere, draw a card.") |
| Narset of the Ancient Way | 1 | Effect:zone_change_reflexive_unbound_referent ("When you discard a nonland card this way, ~ deals damage equal to that card's mana value to target creature or planeswalker") |
| Naya Soulbeast | 1 | Effect:enters_with_clause ("When you cast this spell, each player reveals the top card of their library. ~ enters with X +1/+1 counters on it, where X is the total mana value of all cards revealed this way.") |
| Nazahn, Revered Bladesmith | 1 | Effect:otherwise ("Otherwise") |
| Necromancy | 1 | Effect:granter_reference_unreached ("When ~ enters, if it's on the battlefield, it becomes an Aura with "enchant creature put onto the battlefield with ~." Put target creature card from a graveyard onto the battlefield under your control and attach ~ to it. When ~ leaves the battlefield, that creature's controller sacrifices it.") |
| Negative Zone Portal | 1 | Effect:unparsed_condition ("if there are four or more creature cards exiled with ~, flip a coin. If you lose the flip, sacrifice ~ and return a card exiled with it at random to its owner's hand") |
| Nelly Borca, Impulsive Accuser | 1 | Effect:unbound_subject ("you and the controller of those creatures each draw a card") |
| Neverwinter Hydra | 1 | Effect:enters_with_clause ("As ~ enters, roll X d6. It enters with a number of +1/+1 counters on it equal to the total of those results.") |
| Neyam Shai Murad | 1 | Effect:choose ("choose a permanent card in your graveyard") |
| Nightkin Ambusher | 1 | Static:Unrecognized(as long as defending player has a rad counter) |
| Niko Defies Destiny | 1 | Effect:unparsed_verb_arguments ("Spend this mana only to foretell cards or cast spells that have foretell") |
| Nissa's Pilgrimage | 1 | Effect:instead_override ("Spell mastery — If there are two or more instant and/or sorcery cards in your graveyard, search your library for up to three basic Forest cards instead of two.") |
| Niv-Mizzet, Ghost Counsel | 1 | Effect:unparsed_verb_arguments ("pay that much life") |
| Norn's Decree | 1 | Effect:unparsed_condition ("if one or more players being attacked are poisoned, the attacking player draws a card") |
| Notorious Throng | 1 | Effect:unparsed_quantity ("Create X 1/1 black Faerie Rogue creature tokens with flying, where X is the damage dealt to your opponents this turn. If this spell's prowl cost was paid, take an extra turn after this one.") |
| Nuclear Fallout | 1 | Effect:unparsed_quantity ("Each creature gets twice -X/-X until end of turn. Each player gets X rad counters.") |
| Nuka-Nuke Launcher | 1 | Effect:unrecognized_clause_head ("until the end of defending player's next turn, that player gets two rad counters whenever they cast a spell") |
| Ob Nixilis of the Black Oath | 1 | Effect:emblem_creation ("[−8]: You get an emblem with "{1}{B}, Sacrifice a creature: You gain X life and draw X cards, where X is the sacrificed creature's power."") |
| Octomancer | 1 | Effect:unknown ("Gift an Octopus") |
| Okaun, Eye of Chaos | 1 | Effect:flip_coin_until_lose_stub ("pending consolidation") |
| Omarthis, Ghostfire Initiate | 1 | Effect:unparsed_verb_arguments ("manifest a number of cards from the top of your library equal to the number of counters on it") |
| Open the Way | 1 | Effect:unrecognized_clause_head ("X can't be greater than the number of players in the game. Reveal cards from the top of your library until you reveal X land cards. Put those land cards onto the battlefield tapped and the rest on the bottom of your library in a random order.") |
| Orator of Ojutai | 1 | Effect:cast_time_snapshot_in_trigger ("if you revealed a Dragon card or controlled a Dragon as you cast this spell, draw a card") |
| Order of Succession | 1 | Effect:unparsed_verb_arguments ("choose a creature controlled by the next player in that direction"); Effect:unrecognized_clause_head ("Starting with you and proceeding in the chosen direction") |
| Otherworldly Escort | 1 | Effect:unrecognized_clause_head ("It's a Spirit Detective") |
| Overclocked Electromancer | 1 | Effect:unparsed_quantity ("get X {E}, where X is that excess damage") |
| Phyrexian Ingester | 1 | Effect:static_structure ("~ gets +X/+Y, where X is the exiled creature card's power and Y is its toughness.") |
| Phyrexian Processor | 1 | Effect:unknown ("As ~ enters, pay any amount of life."); Effect:unparsed_quantity ("{4}, {T}: Create an X/X black Phyrexian Minion creature token, where X is the life paid as ~ entered.") |
| Planar Nexus | 1 | Effect:effect_structure ("~ is every nonbasic land type.") |
| Plasm Capture | 1 | Effect:unrecognized_clause_head ("At the beginning of your next first main phase, add X mana in any combination of colors, where X is that spell's mana value") |
| Plasma Caster | 1 | Effect:otherwise ("Otherwise") |
| Plaza of Harmony | 1 | Effect:unparsed_verb_arguments ("{T}: Add one mana of any type that a Gate you control could produce.") |
| Polluted Cistern | 1 | Polluted Cistern: Effect:unparsed_quantity ("lose 1 life for each card type among those cards") |
| Primeval Spawn | 1 | Effect:unparsed_replacement ("If ~ would enter and it wasn't cast or no mana was spent to cast it, exile it instead") |
| Prisoner's Dilemma | 1 | Effect:otherwise ("Otherwise"); Effect:unparsed_verb_arguments ("Each opponent secretly chooses silence or snitch, then the choices are revealed. If each opponent chose silence, ~ deals 4 damage to each of them. If each opponent chose snitch, ~ deals 8 damage to each of them. Otherwise, ~ deals 12 damage to each opponent who chose silence.") |
| Profane Transfusion | 1 | Effect:unparsed_quantity ("create an X/X colorless Horror artifact creature token, where X is the difference between those players' life totals") |
| Prototype Portal | 1 | Effect:unrecognized_clause_head ("X is the mana value of that card") |
| Psionic Ritual | 1 | Effect:unrecognized_clause_head ("Replicate—Tap an untapped Horror you control. Exile target instant or sorcery card from a graveyard and copy it. You may cast the copy without paying its mana cost.") |
| Psychic Battle | 1 | Effect:unbound_subject ("The player who reveals the card with the greatest mana value may change the target or targets"); Effect:unrecognized_clause_head ("the target or targets remain unchanged"); Trigger:Whenever a player chooses one or more targets ("Whenever a player chooses one or more targets, each player reveals the top card of their library. The player who reveals the card with the greatest mana value may change the target or targets. If two or more cards are tied for greatest, the target or targets remain unchanged. Changing targets this way doesn't trigger abilities of permanents named Psychic Battle.") |
| Quartzwood Crasher | 1 | Effect:unparsed_quantity ("create an X/X green Dinosaur Beast creature token with trample, where X is the amount of damage those creatures dealt to that player") |
| Radiant Performer | 1 | Effect:unbound_subject ("Each copy targets a different one of those permanents and players") |
| Ranar the Ever-Watchful | 1 | Effect:static_structure ("The first card you foretell each turn costs {0} to foretell."); Trigger:Whenever one or more cards are put into exile from your hand or a spell or ability you control exiles one or more permanents from the battlefield ("Whenever one or more cards are put into exile from your hand or a spell or ability you control exiles one or more permanents from the battlefield, create a 1/1 white Spirit creature token with flying.") |
| Raul, Trouble Shooter | 1 | Effect:static_structure ("Once during each of your turns, you may cast a spell from among cards in your graveyard that were milled this turn.") |
| Ravener | 1 | Effect:unparsed_verb_arguments ("attack target opponent this turn if able") |
| Ravenous Rotbelly | 1 | Effect:zone_change_reflexive_scoped_body ("When you sacrifice one or more Zombies this way, each opponent sacrifices that many creatures of their choice") |
| Ray of Command | 1 | Effect:unrecognized_clause_head ("When you lose control of the creature, tap it") |
| Razorfield Ripper | 1 | Effect:unknown ("Reconfigure—Pay {2} or {E}{E}{E}."); Effect:where_x_binding ("where X is the amount of {E} you have") |
| Reckless Endeavor | 1 | Effect:unparsed_quantity ("deal damage equal to that result to each creature"); Effect:unparsed_verb_arguments ("Roll two d12 and choose one result. ~ deals damage equal to that result to each creature. Then create a number of Treasure tokens equal to the other result.") |
| Rejoin the Fight | 1 | Effect:unrecognized_clause_head ("starting with the next opponent in turn order") |
| Retether | 1 | Effect:unrecognized_clause_head ("Only creatures can be enchanted this way") |
| Revival Experiment | 1 | Effect:unparsed_quantity ("For each permanent type, return up to one card of that type from your graveyard to the battlefield. You lose 3 life for each card returned this way. Exile ~.") |
| Rex, Cyber-Hound | 1 | Effect:static_structure ("~ has all activated abilities of all cards in exile with brain counters on them.") |
| Rhoda, Geist Avenger | 1 | Effect:unparsed_condition ("if it isn't being declared as an attacker, put a +1/+1 counter on ~") |
| Rise and Shine | 1 | Effect:put_counter_tail ("Put four +1/+1 counters on each artifact that became a creature this way") |
| Robobrain War Mind | 1 | Effect:unparsed_verb_arguments ("get an amount of {E}  equal to the number of artifact creatures you control") |
| Rowan Kenrith | 1 | Effect:unparsed_verb_arguments ("attack if able"); Effect:unrecognized_clause_head ("[+2]: During target player's next turn, each creature that player controls attacks if able.") |
| Ruthless Radrat | 1 | Effect:unknown ("Squad—Exile four cards from your graveyard.") |
| Sadistic Shell Game | 1 | Effect:unrecognized_clause_head ("Starting with the next opponent in turn order, each player chooses a creature you don't control. Destroy the chosen creatures.") |
| Sage of the Maze | 1 | Effect:unparsed_verb_arguments ("{T}: Until end of turn, target land you control becomes an X/X Citizen creature with haste in addition to its other types, where X is twice the number of Gates you control. Activate only as a sorcery.") |
| Salt Road Ambushers | 1 | Effect:unparsed_verb_arguments ("if it's a creature, put two +1/+1 counters on it") |
| Salvation Colossus | 1 | Effect:unknown ("Unearth—Pay eight {E}.") |
| Sanwell, Avenger Ace | 1 | Effect:unrepresentable_cast_cap ("a vehicle or artifact creature spell from among them") |
| Sarkhan, the Dragonspeaker | 1 | Effect:unparsed_verb_arguments ("draw two additional cards" and "At the beginning of your end step") |
| Scriv, the Obligator | 1 | Effect:otherwise ("Otherwise") |
| Seeker of Slaanesh | 1 | Effect:unknown ("Allure of Slaanesh — Each opponent must attack with at least one creature each combat if able.") |
| Selective Adaptation | 1 | Effect:unparsed_verb_arguments ("Choose from among them a card with flying, a card with first strike, and so on for double strike, deathtouch, haste, hexproof, indestructible, lifelink, menace, reach, trample, and vigilance") |
| Selective Obliteration | 1 | Effect:Unsupported unless clause ("exile each permanent unless it's colorless or it's only the color its controller chose (unless: it's colorless or it's only the color its controller chose)") |
| Selvala's Stampede | 1 | Effect:unrecognized_clause_head ("Council's dilemma — Starting with you, each player votes for wild or free. Reveal cards from the top of your library until you reveal a creature card for each wild vote. Put those creature cards onto the battlefield, then shuffle the rest into your library. You may put a permanent card from your hand onto the battlefield for each free vote.") |
| Serene Master | 1 | Effect:unparsed_verb_arguments ("exchange its power and the power of target creature it's blocking") |
| Serene Sleuth | 1 | Effect:unrecognized_clause_head ("each creature you control is no longer goaded") |
| Serra Paragon | 1 | Effect:static_structure ("Once during each of your turns, you may play a land from your graveyard or cast a permanent spell with mana value 3 or less from your graveyard. If you do, it gains "When ~ is put into a graveyard from the battlefield, exile it and you gain 2 life."") |
| Shadowgrange Archfiend | 1 | Effect:unknown ("Madness—{2}{B}, Pay 8 life.") |
| Shaile, Dean of Radiance | 1 | Shaile, Dean of Radiance: Effect:put_counter_tail ("{T}: Put a +1/+1 counter on each creature that entered the battlefield under your control this turn.") |
| Share the Spoils | 1 | Effect:unknown ("During each player's turn, that player may play a land or cast a spell from among cards exiled with ~, and they may spend mana as though it were mana of any color to cast that spell. When they do, exile the top card of their library.") |
| Shared Fate | 1 | Effect:static_structure ("Each player may look at cards they exiled with ~, and they may play lands and cast spells from among those cards.") |
| Showstopping Surprise | 1 | Effect:unparsed_condition ("Turn it face up if it's face down") |
| Shredder, Shadow Master | 1 | Effect:unparsed_quantity ("for each other opponent, create a token that's a copy of ~ tapped and attacking that player, except it isn't legendary") |
| Sigarda's Vanguard | 1 | Effect:unparsed_verb_arguments ("choose creatures with different powers") |
| Sigardian Zealot | 1 | Effect:unparsed_verb_arguments ("choose creatures with different powers") |
| Sigil Captain | 1 | Effect:unparsed_condition ("if that creature is 1/1, put two +1/+1 counters on it") |
| Sin, Unending Cataclysm | 1 | Effect:enters_with_clause ("As ~ enters, remove all counters from any number of artifacts, creatures, and enchantments. ~ enters with X +1/+1 counters on it, where X is twice the number of counters removed this way.") |
| Sinister Gnarlbark | 1 | Effect:unparsed_verb_arguments ("draw a card and blight 1") |
| Skyway Robber | 1 | Effect:effect_structure ("~ escapes with "Whenever ~ deals combat damage to a player, you may cast an artifact, instant, or sorcery spell from among cards exiled with ~ without paying its mana cost."") |
| Smoke Spirits' Aid | 1 | Effect:unparsed_quantity ("For each of up to X target creatures, create a red Aura enchantment token named Smoke Blessing attached to that creature. Those tokens have enchant creature and "When enchanted creature dies, it deals 1 damage to its controller and you create a Treasure token."") |
| Smoldering Stagecoach | 1 | Effect:unrecognized_clause_head ("the next instant spell and the next sorcery spell you cast this turn each have cascade") |
| Song of Inspiration | 1 | Effect:tracked_set_anaphor ("You gain life equal to their total mana value"); Effect:unparsed_verb_arguments ("Roll a d20 and add the total mana value of those cards"); Effect:unrecognized_clause_head ("1—14 \| Return those cards to your hand.") |
| Soul Foundry | 1 | Effect:unrecognized_clause_head ("X is the mana value of that card") |
| Sower of Discord | 1 | Effect:unknown ("As ~ enters, choose two players."); Trigger:Whenever damage is dealt to one of the chosen players ("Whenever damage is dealt to one of the chosen players, the other chosen player also loses that much life.") |
| Space Beleren | 1 | Effect:put_counter_tail ("[−1]: Put a +1/+1 counter on each creature in the sector of your choice."); Effect:unknown ("Space sculptor"); Effect:unrecognized_clause_head ("[+1]: Creatures in each sector can be blocked this turn only by creatures in the same sector.") |
| Spellpyre Phoenix | 1 | Effect:unparsed_condition ("if you cycled two or more cards this turn, return this card from your graveyard to your hand") |
| Squee's Revenge | 1 | Effect:unparsed_quantity ("draw two cards for each flip") |
| Strong, the Brutish Thespian | 1 | Effect:effect_structure ("You gain life rather than lose life from radiation.") |
| Sudden Salvation | 1 | Effect:unparsed_quantity ("draw a card for each opponent who controls one or more of those permanents") |
| Sudden Substitution | 1 | Effect:unrecognized_clause_head ("the spell's controller may choose new targets for it") |
| Summon: Esper Valigarmanda | 1 | Effect:linked_exile_resolution_cast ("an instant or sorcery card exiled with ~"); Effect:standalone_mana_spend_concession ("mana of any type can be spent to cast that spell") |
| Summon: Kujata | 1 | Effect:zone_change_reflexive_event_source ("When you discard a card this way, ~ deals damage equal to that card's mana value to each opponent") |
| Sunken Palace | 1 | Effect:orphaned_copy_retarget ("You may choose new targets for the copy"); Effect:unrecognized_clause_head ("When you spend this mana to cast a spell or activate an ability, copy that spell or ability") |
| Surveyor's Scope | 1 | Effect:where_x_binding ("{T}, Exile ~: Search your library for up to X basic land cards, where X is the number of players who control at least two more lands than you. Put those cards onto the battlefield, then shuffle.") |
| Survivor's Med Kit | 1 | Effect:unparsed_verb_arguments ("lose all rad counters") |
| Syrix, Carrier of the Flame | 1 | Effect:unparsed_condition ("if a creature card left your graveyard this turn, target Phoenix you control deals damage equal to its power to any target") |
| Tahngarth, First Mate | 1 | Effect:unrecognized_clause_head ("~ is attacking that player or planeswalker") |
| Tarmogoyf Nest | 1 | Effect:unparsed_verb_arguments ("{1}{G}, {T}: Create a ~ token.") |
| Tataru Taru | 1 | Effect:unparsed_verb_arguments ("draw a card and target opponent may draw a card") |
| Technomancer | 1 | Effect:unenforced_aggregate_resolution_selection ("return any number of cards with total mana value X or less") |
| Teferi, Temporal Archmage | 1 | Effect:emblem_creation ("[−10]: You get an emblem with "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant."") |
| Tezzeret, Betrayer of Flesh | 1 | Effect:static_structure ("The first activated ability of an artifact you activate each turn costs {2} less to activate.") |
| The Akroan War | 1 | Effect:unrecognized_clause_head ("creatures your opponents control attack each combat if able") |
| The Beamtown Bullies | 1 | Effect:change_zone_enters_under_anaphor ("{T}: Target opponent whose turn it is puts target nonlegendary creature card from your graveyard onto the battlefield under their control. It gains haste. Goad it. At the beginning of the next end step, exile it.") |
| The Eighth Doctor | 1 | Effect:static_structure ("Once during each of your turns, you may play a historic land or cast a historic permanent spell from your graveyard. If you do, it gains "If ~ would leave the battlefield, exile it instead of putting it anywhere else."") |
| The Eleventh Doctor | 1 | Effect:keyword_anaphor_resolution_time_pick ("If it doesn't have suspend, it gains suspend") |
| The First Tyrannic War | 1 | Effect:unparsed_quantity ("it enters with a number of +1/+1 counters on it equal to the number of lands you control") |
| The Horus Heresy | 1 | Effect:unparsed_verb_arguments ("choose a creature") |
| The Motherlode, Excavator | 1 | Effect:unparsed_verb_arguments ("get an amount of {E}  equal to the number of nonbasic lands that player controls") |
| The Nipton Lottery | 1 | Effect:unparsed_verb_arguments ("Choose a creature at random. You gain control of that creature until end of turn. Untap it. It gains haste until end of turn. Then destroy all other creatures.") |
| The Ur-Sphinx | 1 | Effect:unparsed_quantity ("For each player, you may cast a card that player milled this way without paying its mana cost") |
| The War in Heaven | 1 | Effect:unrecognized_clause_head ("They're artifacts in addition to their other types") |
| The Wedding of River Song | 1 | Effect:target_opponent_does_the_same ("target opponent does the same"); Effect:unrecognized_clause_head ("Cards exiled this way that don't have suspend gain suspend") |
| Thieving Varmint | 1 | Effect:unparsed_verb_arguments ("Spend this mana only to cast spells you don't own") |
| Three Dog, Galaxy News DJ | 1 | Effect:zone_change_reflexive_unbound_referent ("When you sacrifice an Aura this way, for each other attacking creature you control, create a token that's a copy of that Aura attached to that creature") |
| Thrill-Kill Disciple | 1 | Effect:unknown ("Squad—{1}, Discard a card.") |
| Thrilling Encore | 1 | Effect:unparsed_verb_arguments ("Put onto the battlefield under your control all creature cards in all graveyards that were put there from the battlefield this turn.") |
| Trade Secrets | 1 | Effect:unbound_subject ("That opponent may repeat this process as many times as they choose") |
| Trap the Trespassers | 1 | Effect:unparsed_quantity ("For each creature with one or more votes, put that many stun counters on it, then tap it"); Effect:unrecognized_clause_head ("Secret council — Each player secretly votes for a creature you don't control, then those votes are revealed. For each creature with one or more votes, put that many stun counters on it, then tap it.") |
| Travel Through Caradhras | 1 | Effect:unparsed_quantity ("For each Redhorn Pass vote, search your library for a basic land card"); Effect:unrecognized_clause_head ("Council's dilemma — Starting with you, each player votes for Redhorn Pass or Mines of Moria. For each Redhorn Pass vote, search your library for a basic land card and put it onto the battlefield tapped. If you search your library this way, shuffle. For each Mines of Moria vote, return a card from your graveyard to your hand.") |
| Turf War | 1 | Effect:unparsed_condition ("if that player controls one or more lands with contested counters on them, that creature's controller gains control of one of those lands of their choice and untaps it"); Swallow:DynamicQty ("[warning:swallowed-clause] DynamicQty — When this enchantment enters, for each player, put a contested counter on target land that player controls.") |
| Umbra Mystic | 1 | Effect:static_structure ("Auras attached to permanents you control have umbra armor.") |
| Unbound Flourishing | 1 | Effect:unparsed_condition ("if that spell's mana cost or that ability's activation cost contains {X}, copy that spell or ability. You may choose new targets for the copy"); Effect:unparsed_quantity ("double the value of X") |
| Unexplained Absence | 1 | Effect:unrecognized_clause_head ("its controller cloaks the top card of their library") |
| Ursine Monstrosity | 1 | Effect:unparsed_verb_arguments ("mill a card and choose an opponent at random") |
| Valiant Endeavor | 1 | Effect:unparsed_quantity ("create a number of 2/2 white Knight creature tokens with vigilance equal to the other result"); Effect:unparsed_verb_arguments ("Roll two d6 and choose one result. Destroy each creature with power greater than or equal to that result. Then create a number of 2/2 white Knight creature tokens with vigilance equal to the other result.") |
| Vastwood Hydra | 1 | Effect:unparsed_quantity ("distribute a number of +1/+1 counters equal to the number of +1/+1 counters on ~ among any number of creatures you control") |
| Vault 112: Sadistic Simulation | 1 | Effect:bounded_batch_cast ("play one of those cards without paying its mana cost"); Effect:shuffle ("shuffle your library, then exile that many cards from the top") |
| Vault 11: Voter's Dilemma | 1 | Effect:otherwise ("Otherwise"); Effect:unrecognized_clause_head ("vote for up to one creature") |
| Vault 12: The Necropolis | 1 | Effect:unparsed_quantity ("Create X 2/2 black Zombie Mutant creature tokens, where X is the total number of rad counters among players") |
| Venerable Warsinger | 1 | Effect:where_x_binding ("where X is the amount of damage ~ dealt to that player") |
| Verity Circle | 1 | Effect:unparsed_condition ("if it isn't being declared as an attacker, you may draw a card") |
| Verrak, Warped Sengir | 1 | Effect:unparsed_verb_arguments ("pay that much life again") |
| Vesuvan Shapeshifter | 1 | Effect:static_structure ("As ~ enters or is turned face up, you may choose another creature on the battlefield. If you do, until ~ is turned face down, it becomes a copy of that creature, except it has "At the beginning of your upkeep, you may turn ~ face down."") |
| Vexing Radgull | 1 | Effect:otherwise ("Otherwise"); Effect:unparsed_condition ("get two rad counters if they don't have any rad counters") |
| Victory Chimes | 1 | Effect:unrecognized_clause_head ("{T}: A player of your choice adds {C}.") |
| Vivien's Stampede | 1 | Effect:unparsed_quantity ("draw a card for each player who was dealt combat damage") |
| Wakka, Devoted Guardian | 1 | Effect:unparsed_condition ("if a counter was put on ~ this turn, put a +1/+1 counter on each other creature you control") |
| Wand of Orcus | 1 | Effect:unbound_subject ("it and Zombies you control gain deathtouch until end of turn") |
| Warp World | 1 | Effect:unparsed_verb_arguments ("reveal that many cards from the top of their library") |
| Wayta, Trainer Prodigy | 1 | Effect:unparsed_condition ("This ability costs {2} less to activate if it targets two creatures you control") |
| Whims of the Fates | 1 | Effect:unparsed_verb_arguments ("choose one of their piles at random and sacrifices those permanents"); Effect:unrecognized_clause_head ("Starting with you, each player separates all permanents they control into three piles. Then each player chooses one of their piles at random and sacrifices those permanents.") |
| White Glove Gourmand | 1 | Effect:unparsed_condition ("if another Human died under your control this turn, create a Food token") |
| Wild Endeavor | 1 | Effect:unparsed_quantity ("Create a number of 3/3 green Beast creature tokens equal to that result"); Effect:unparsed_verb_arguments ("Roll two d4 and choose one result. Create a number of 3/3 green Beast creature tokens equal to that result. Then search your library for a number of basic land cards equal to the other result, put them onto the battlefield tapped, then shuffle.") |
| Will Kenrith | 1 | Effect:unrecognized_clause_head ("instant, sorcery, and planeswalker spells that player casts cost {2} less to cast") |
| Winding Constrictor | 1 | Effect:replacement_structure ("If you would get one or more counters, you get that many plus one of each of those kinds of counters instead.") |
| Winged Hive Tyrant | 1 | Effect:static_structure ("The Will of the Hive Mind — Other creatures you control with counters on them have flying and haste.") |
| Within Range | 1 | Effect:unparsed_quantity ("lose life equal to the number of creatures attacking them") |
| Wonderscape Sage | 1 | Effect:Unsupported unless clause ("discard a card unless that land had a nonbasic land type (unless: that land had a nonbasic land type)") |
| Wurmquake | 1 | Effect:unparsed_quantity ("for each opponent with three or more poison counters"); Effect:unparsed_verb_arguments ("create another one of those tokens") |
| Yavimaya Bloomsage | 1 | Channel: Effect:unrecognized_clause_head ("Until end of turn, any time you could activate a mana ability, you may pay 1 life. If you do, add {C}.") |
| Yes Man, Personal Securitron | 1 | Effect:unrecognized_clause_head ("When they do, you draw two cards") |
| Yidris, Maelstrom Wielder | 1 | Effect:unrecognized_clause_head ("as you cast spells from your hand") |
| Zenith Flare | 1 | Effect:unparsed_quantity ("gain X life, where X is the number of cards with a cycling ability in your graveyard"); Effect:where_x_binding ("~ deals X damage to any target and you gain X life, where X is the number of cards with a cycling ability in your graveyard.") |
| Zimone, All-Questioning | 1 | Effect:unparsed_condition ("if a land entered the battlefield under your control this turn and you control a prime number of lands, create Primo, the Indivisible, a legendary 0/0 green and blue Fractal creature token, then put that many +1/+1 counters on it") |
| Zndrsplt, Eye of Wisdom | 1 | Effect:flip_coin_until_lose_stub ("pending consolidation") |

The most common gaps among the catalog's uncertain and partial cards:

| Gap | Cards |
|---|---:|
| Effect:unrecognized_clause_head | 104 |
| Effect:unparsed_verb_arguments | 86 |
| Effect:unparsed_quantity | 64 |
| Swallow:DynamicQty | 51 |
| Swallow:Condition_If | 39 |
| Effect:unparsed_condition | 36 |
| Effect:static_structure | 27 |
| Effect:unknown | 25 |
| Effect:unbound_subject | 15 |
| Effect:where_x_binding | 13 |
| Effect:otherwise | 11 |
| Effect:put_counter_tail | 11 |
| Effect:effect_structure | 10 |
| Swallow:Replacement_Instead | 8 |
| Replacement:as_enters_projection | 7 |
| Effect:replacement_structure | 6 |
| ParseWarning:target-fallback | 6 |
| Swallow:Duration_ThisTurn | 6 |
| Effect:Unsupported unless clause | 5 |
| Effect:enters_with_clause | 5 |
| Swallow:Optional_YouMay | 5 |
| Effect:unparsed_replacement | 4 |
| Effect:emblem_creation | 3 |
| Effect:instead_condition | 3 |
| Effect:zone_change_reflexive_event_source | 3 |
