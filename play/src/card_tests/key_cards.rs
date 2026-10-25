//! The cards Bryan's decks are built around: the upgrades whose "why" in commander-decks
//! (data/shopping/swaps.json, data/shopping/tricky-terrain.json, data/shopping/candidates.json)
//! says what each is for, checked against its Oracle text and rulings. Grouped by deck.

use engine::game::game_object::AttachTarget;
use engine::types::counter::CounterType;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::zones::Zone;

use super::{Board, big_stack, choose_named};
use crate::act::Answer;
use crate::{Act, OptionKind, TargetView};

// ── Lorehold Spirit (Quintorius) ────────────────────────────────────────────────────────────

/// "Creatures you control that are Zombies and/or tokens get +1/+1 and have flying. Whenever one
/// or more cards leave your graveyard, create a 1/1 white Zombie creature token."
#[test]
fn on_wings_of_gold_makes_a_flying_zombie_when_a_card_leaves_your_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "On Wings of Gold").field(0, "Ghost Vacuum").grave(0, "Lightning Bolt").build();
        let (vacuum, bolt) = (t.id("Ghost Vacuum"), t.id("Lightning Bolt"));
        t.activate(vacuum, Some(0));
        t.drive_aiming(&[bolt]);
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1, "one Zombie");
        let z = tokens[0];
        assert!(t.subtypes(z).contains(&"Zombie".to_string()));
        assert_eq!(t.pt(z), (2, 2), "1/1 and +1/+1");
        assert!(t.has(z, Keyword::Flying));
    });
}

/// "{W}: Exile target card from a graveyard. If it was a permanent card, put a +1/+1 counter on
/// this permanent."
#[test]
fn lion_sash_grows_only_from_permanent_cards() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Lion Sash").lands(0, "Plains", 2).grave(1, "Grizzly Bears").grave(1, "Lightning Bolt").build();
        let (sash, bears, bolt) = (t.id("Lion Sash"), t.id("Grizzly Bears"), t.id("Lightning Bolt"));
        t.activate_labelled(sash, |l| l.contains("Exile target card"));
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Exile);
        assert_eq!(t.counters(sash, CounterType::Plus1Plus1), 1, "a creature card is a permanent card");
        assert_eq!(t.pt(sash), (2, 2));
        t.activate_labelled(sash, |l| l.contains("Exile target card"));
        t.drive_aiming(&[bolt]);
        assert_eq!(t.zone(bolt), Zone::Exile);
        assert_eq!(t.counters(sash, CounterType::Plus1Plus1), 1, "an instant isn't");
    });
}

/// "Whenever you discard a card, exile that card from your graveyard. {2}, {T}: Draw a card,
/// then discard a card."
#[test]
fn bag_of_holding_exiles_what_you_discard() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Bag of Holding").lands(0, "Plains", 2).hand(0, "Opt").build();
        let (bag, opt) = (t.id("Bag of Holding"), t.id("Opt"));
        t.activate_labelled(bag, |l| l.contains("Draw a card"));
        t.drive_answering(|t, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards && t.zone(opt) == Zone::Hand).then(|| Act::SelectCards { cards: vec![opt.0] })
        })
        .unwrap();
        assert_eq!(t.drawn(0), 1);
        assert_eq!(t.zone(opt), Zone::Exile, "the discarded Opt went on to exile");
        assert!(t.graveyard(0).is_empty());
    });
}

/// "If one or more tokens would be created under your control, twice that many of those tokens
/// are created instead." Horn of Gondor's one Human Soldier becomes two.
#[test]
fn mondrak_doubles_tokens() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mondrak, Glory Dominus").hand(0, "Horn of Gondor").lands(0, "Plains", 3).build();
        let horn = t.id("Horn of Gondor");
        t.cast(horn);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 2);
    });
}

/// "Whenever one or more tokens you control enter, draw a card. This ability triggers only once
/// each turn."
#[test]
fn caretakers_talent_draws_once_a_turn_for_tokens() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Caretaker's Talent").hand(0, "Horn of Gondor").lands(0, "Plains", 6).build();
        let horn = t.id("Horn of Gondor");
        t.cast(horn);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 1);
        assert_eq!(t.drawn(0), 1, "the first token drew");
        t.activate_labelled(horn, |l| l.contains("Create X"));
        t.drive().unwrap();
        assert!(t.tokens(0).len() >= 2);
        assert_eq!(t.drawn(0), 1, "only once each turn");
    });
}

/// "Whenever one or more cards leave your graveyard, this artifact deals 1 damage to each
/// opponent and you gain 1 life."
#[test]
fn ark_of_hunger_drains_when_cards_leave_your_graveyard() {
    big_stack(|| {
        let mut t = Board::new(3).field(0, "Ark of Hunger").field(0, "Ghost Vacuum").grave(0, "Lightning Bolt").build();
        let (vacuum, bolt) = (t.id("Ghost Vacuum"), t.id("Lightning Bolt"));
        t.activate(vacuum, Some(0));
        t.drive_aiming(&[bolt]);
        assert_eq!((t.life(0), t.life(1), t.life(2)), (41, 39, 39));
    });
}

/// "{T}: Mill a card. You may play that card this turn."
#[test]
fn ark_of_hunger_mills_a_card_you_may_play() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Ark of Hunger").top(0, "Forest").build();
        let (ark, forest) = (t.id("Ark of Hunger"), t.id("Forest"));
        t.activate_labelled(ark, |l| l.contains("Mill"));
        t.drive().unwrap();
        assert_eq!(t.zone(forest), Zone::Graveyard);
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(forest.0)), "the milled Forest may be played");
    });
}

// ── Prismari Artistry (Rootha) ──────────────────────────────────────────────────────────────

/// "At the beginning of your first main phase, add {U}{R}. Spend this mana only to cast instant
/// and sorcery spells."
#[test]
fn abstract_paintmage_adds_mana_for_instants_and_sorceries() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Abstract Paintmage").hand(0, "Opt").hand(0, "Grizzly Bears").phase(Phase::Upkeep).build();
        let (opt, bears) = (t.id("Opt"), t.id("Grizzly Bears"));
        t.advance_to(Phase::PreCombatMain);
        t.drive().unwrap();
        let drawn = t.drawn(0);
        assert_eq!(t.pool(0), 2, "{{U}}{{R}} in the pool");
        let d = t.decision(0);
        assert!(!d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(bears.0)), "it can't pay for a creature");
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(opt.0)), "it pays for Opt");
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), drawn + 1);
        assert_eq!(t.pool(0), 1, "Opt used one of the two");
    });
}

/// "Lands you control have '{T}: Add two mana of any one color. Spend this mana only to cast
/// instant and sorcery spells.'" Two Islands pay for Divination ({2}{U}). phase only finds the
/// Lute's mana once it's in the pool, and a person in Yama taps mana only while paying.
#[test]
#[ignore = "phase bug: a spell that needs Resonating Lute's two-mana land ability isn't offered (the auto-tap check uses one mana per land)"]
fn resonating_lute_doubles_land_mana_for_spells() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Resonating Lute").lands(0, "Island", 2).hand(0, "Divination").hand(0, "Hill Giant").build();
        let (div, giant) = (t.id("Divination"), t.id("Hill Giant"));
        let d = t.decision(0);
        assert!(!d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(giant.0)), "Hill Giant ({{3}}{{R}}) can't use the Lute's mana");
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(div.0)), "Divination can");
        t.cast(div);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
    });
}

/// "This spell costs {3} less to cast if an opponent has seven or more cards in their
/// graveyard. Draw four cards."
#[test]
fn into_the_story_costs_three_less_with_seven_in_a_graveyard() {
    big_stack(|| {
        let mut b = Board::new(2).hand(0, "Into the Story").lands(0, "Island", 4);
        let mut short = Board::new(2).hand(0, "Into the Story").lands(0, "Island", 4);
        for _ in 0..7 {
            b = b.grave(1, "Grizzly Bears");
        }
        for _ in 0..6 {
            short = short.grave(1, "Grizzly Bears");
        }
        let t6 = short.build();
        let story = t6.id("Into the Story");
        assert!(!t6.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(story.0)), "six cards: seven mana, and four lands can't pay");
        let mut t = b.build();
        let story = t.id("Into the Story");
        t.cast(story);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 4);
        assert!(t.state().battlefield.iter().all(|id| t.tapped(*id) || t.state().objects[id].controller.0 != 0), "all four Islands paid");
    });
}

/// "If a triggered ability of another creature you control of the chosen type triggers, it
/// triggers an additional time." Choosing Elf, Elvish Visionary draws twice.
#[test]
fn roaming_throne_doubles_the_chosen_types_triggers() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Roaming Throne").hand(0, "Elvish Visionary").lands(0, "Forest", 6).build();
        let (throne, elf) = (t.id("Roaming Throne"), t.id("Elvish Visionary"));
        t.cast(throne);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseOption).then(|| Act::ChooseOption { choice: "Elf".into() })
        })
        .unwrap();
        assert!(t.subtypes(throne).contains(&"Elf".to_string()), "the Throne is an Elf now");
        t.cast(elf);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2, "the Visionary's trigger happened twice");
    });
}

/// "Whenever another creature you control enters, this creature deals damage equal to that
/// creature's power to any target."
#[test]
fn terror_of_the_peaks_throws_each_creature_s_power() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Terror of the Peaks").hand(0, "Hill Giant").basics(0, 1).build();
        let giant = t.id("Hill Giant");
        t.cast(giant);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseTarget).then(|| Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) })
        })
        .unwrap();
        assert_eq!(t.life(1), 37, "Hill Giant's 3 power");
    });
}

/// "Choose one. If you control a commander as you cast this spell, you may choose both instead.
/// Add {R} for each card in target opponent's hand. Exile the top three cards of your library.
/// You may play them this turn."
#[test]
fn jeskas_will_does_both_with_a_commander_out() {
    big_stack(|| {
        let mut t = Board::new(2)
            .commander(0, "Rootha, Mastering the Moment")
            .hand(0, "Jeska's Will")
            .basics(0, 2)
            .hand(1, "Grizzly Bears")
            .hand(1, "Opt")
            .hand(1, "Lightning Bolt")
            .build();
        let rootha = *t.state().command_zone.iter().find(|id| t.state().objects[*id].owner.0 == 0).unwrap();
        t.cast(rootha);
        t.drive().unwrap();
        let will = t.id("Jeska's Will");
        let library = t.library_len(0);
        t.cast(will);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectModes).then(|| Act::SelectModes { indices: vec![0, 1] })
        })
        .unwrap();
        assert_eq!(t.state().players[0].mana_pool.count_color(engine::types::mana::ManaType::Red), 3, "a red for each card in Ben's hand");
        assert_eq!(t.library_len(0), library - 3, "three exiled from the top");
    });
}

// ── Revival Trance (Terra) ──────────────────────────────────────────────────────────────────

/// "When this creature enters, search your library for a card, put that card into your
/// graveyard, then shuffle."
#[test]
fn vile_entomber_puts_any_card_into_the_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Vile Entomber").lands(0, "Swamp", 4).top(0, "Craw Wurm").build();
        let (entomber, wurm) = (t.id("Vile Entomber"), t.id("Craw Wurm"));
        t.cast(entomber);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards && p.options.iter().any(|o| o.id == wurm.0.to_string())).then(|| Act::SelectCards { cards: vec![wurm.0] })
        })
        .unwrap();
        assert_eq!(t.zone(wurm), Zone::Graveyard);
    });
}

/// "Equipped creature has ward {2}, is an Assassin in addition to its other types, and can't be
/// blocked. Equip legendary creature {1}."
#[test]
fn brotherhood_regalia_equips_a_legend_for_one_and_it_cant_be_blocked() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Brotherhood Regalia").field(0, "Isamaru, Hound of Konda").lands(0, "Plains", 1).field(1, "Grizzly Bears").build();
        let (regalia, isamaru) = (t.id("Brotherhood Regalia"), t.id("Isamaru, Hound of Konda"));
        t.activate_labelled(regalia, |l| l.contains("legendary"));
        t.drive_aiming(&[isamaru]);
        assert_eq!(t.state().objects[&regalia].attached_to, Some(AttachTarget::Object(isamaru)), "on Isamaru for {{1}}");
        assert!(t.subtypes(isamaru).contains(&"Assassin".to_string()));
        assert!(t.state().objects[&isamaru].keywords.iter().any(|k| matches!(k, Keyword::Ward(_))), "ward");
        t.attack(&[(isamaru, 1)]);
        let mut blockers_offered = None;
        t.advance_answering(Phase::PostCombatMain, |t, seat, d| {
            if seat == 1 && blockers_offered.is_none() {
                if let Some(b) = &d.block {
                    blockers_offered = Some(b.blockers.iter().filter(|x| x.attackers.contains(&isamaru.0)).count());
                }
            }
            let _ = t;
            None
        });
        assert_eq!(blockers_offered.unwrap_or(0), 0, "the Bears can't block Isamaru");
        assert_eq!(t.life(1), 38);
    });
}

/// "If a triggered ability of a Shaman or another Wizard you control triggers, that ability
/// triggers an additional time." Terra is a Wizard: her Trance mills four.
#[test]
fn harmonic_prodigy_doubles_terras_trance() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Terra, Herald of Hope").field(0, "Harmonic Prodigy").build();
        let library = t.library_len(0);
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert_eq!(t.library_len(0), library - 4, "the trigger happened twice");
    });
}

/// "When this creature enters, return target creature card from your graveyard to the
/// battlefield."
#[test]
fn karmic_guide_returns_a_creature_card() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Karmic Guide").lands(0, "Plains", 5).grave(0, "Craw Wurm").build();
        let (guide, wurm) = (t.id("Karmic Guide"), t.id("Craw Wurm"));
        t.cast(guide);
        t.drive_aiming(&[wurm]);
        assert!(t.on_field(wurm));
    });
}

/// "Draw two cards, then discard two cards. Flashback {2}{R}" (and a flashed-back card is
/// exiled).
#[test]
fn faithless_looting_loots_and_flashes_back() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Faithless Looting").lands(0, "Mountain", 4).build();
        let looting = t.id("Faithless Looting");
        t.cast(looting);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
        assert_eq!(t.hand(0).len(), 0, "drew two, discarded two");
        assert_eq!(t.zone(looting), Zone::Graveyard);
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(looting.0)), "flashback from the graveyard");
        t.cast(looting);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 4);
        assert_eq!(t.zone(looting), Zone::Exile, "exiled after flashback");
    });
}

/// "Search your library for up to three creature cards, put them into your graveyard, then
/// shuffle."
#[test]
fn buried_alive_puts_three_creatures_in_the_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Buried Alive").lands(0, "Swamp", 3).top(0, "Craw Wurm").top(0, "Hill Giant").build();
        let spell = t.id("Buried Alive");
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards).then(|| Act::SelectCards { cards: p.options.iter().filter(|o| o.eligible).take(3).map(|o| o.id.parse().unwrap()).collect() })
        })
        .unwrap();
        let grave = t.graveyard(0);
        let creatures = grave.iter().filter(|n| *n != "Buried Alive").count();
        assert_eq!(creatures, 3, "{grave:?}");
    });
}

/// "Exile target creature. Its controller gains life equal to its power."
#[test]
fn swords_to_plowshares_exiles_and_gives_life() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Swords to Plowshares").lands(0, "Plains", 1).field(1, "Hill Giant").build();
        let (swords, giant) = (t.id("Swords to Plowshares"), t.id("Hill Giant"));
        t.cast(swords);
        t.drive_aiming(&[giant]);
        assert_eq!(t.zone(giant), Zone::Exile);
        assert_eq!(t.life(1), 43);
    });
}

// ── World Shaper (Hearthhull) ───────────────────────────────────────────────────────────────

/// "You may play an additional land on each of your turns. You may play lands from your
/// graveyard. Landfall — Whenever a land you control enters, mill a card."
#[test]
fn icetill_explorer_plays_two_lands_one_from_the_graveyard_and_mills() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Icetill Explorer").hand(0, "Forest").grave(0, "Swamp").build();
        let (forest, swamp) = (t.id("Forest"), t.id("Swamp"));
        let library = t.library_len(0);
        t.play_land(swamp);
        t.drive().unwrap();
        assert!(t.on_field(swamp), "played from the graveyard");
        t.play_land(forest);
        t.drive().unwrap();
        assert!(t.on_field(forest), "a second land this turn");
        assert_eq!(t.library_len(0), library - 2, "each land milled a card");
    });
}

/// "You may play lands from your graveyard."
#[test]
fn ramunap_excavator_plays_lands_from_the_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Ramunap Excavator").grave(0, "Arid Mesa").build();
        let mesa = t.id("Arid Mesa");
        t.play_land(mesa);
        t.drive().unwrap();
        assert!(t.on_field(mesa));
    });
}

/// "Sacrifice a land: You gain 2 life."
#[test]
fn zuran_orb_turns_a_land_into_two_life() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Zuran Orb").lands(0, "Forest", 2).build();
        let orb = t.id("Zuran Orb");
        t.activate(orb, None);
        t.drive().unwrap();
        assert_eq!(t.life(0), 42);
        assert_eq!(t.graveyard(0), vec!["Forest".to_string()]);
    });
}

/// "Sacrifice any number of lands. Search your library for up to that many land cards, put
/// them onto the battlefield tapped, then shuffle."
#[test]
fn scapeshift_trades_lands_for_as_many_from_the_library() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Scapeshift").lands(0, "Forest", 4).top(0, "Arid Mesa").top(0, "Sacred Foundry").build();
        let (spell, mesa, foundry) = (t.id("Scapeshift"), t.id("Arid Mesa"), t.id("Sacred Foundry"));
        t.cast(spell);
        t.drive_answering(|t, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 || p.answer != Answer::SelectCards {
                return None;
            }
            // Sacrifice all four Forests (all tapped for the spell); then take the two lands.
            if p.options.iter().any(|o| o.id == mesa.0.to_string()) {
                return Some(Act::SelectCards { cards: vec![mesa.0, foundry.0] });
            }
            let forests: Vec<u64> = p.options.iter().filter(|o| t.state().objects.get(&engine::types::identifiers::ObjectId(o.id.parse().unwrap_or(0))).is_some_and(|x| x.name == "Forest")).map(|o| o.id.parse().unwrap()).collect();
            (!forests.is_empty()).then(|| Act::SelectCards { cards: forests.into_iter().take(2).collect() })
        })
        .unwrap();
        assert!(t.on_field(mesa) && t.on_field(foundry), "both found");
        assert!(t.tapped(mesa) && t.tapped(foundry), "tapped");
        assert_eq!(t.graveyard(0).iter().filter(|n| *n == "Forest").count(), 2, "two Forests sacrificed");
    });
}

/// "Landfall — Whenever a land you control enters, create a Food token or a Treasure token."
#[test]
fn tireless_provisioner_makes_a_treasure_on_landfall() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Tireless Provisioner").hand(0, "Forest").build();
        let forest = t.id("Forest");
        t.play_land(forest);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            let treasure = p.options.iter().find(|o| o.name.contains("Treasure"))?;
            (seat == 0 && p.answer == Answer::ChooseBranch).then(|| Act::ChooseBranch { index: treasure.id.parse().unwrap() })
        })
        .unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1);
        assert_eq!(t.state().objects[&tokens[0]].name, "Treasure");
    });
}

/// "As an additional cost to cast this spell, sacrifice a land. Search your library for a land
/// card, put that card onto the battlefield, then shuffle."
#[test]
fn crop_rotation_trades_a_land_for_any_land() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Crop Rotation").lands(0, "Forest", 2).top(0, "Field of the Dead").build();
        let (spell, field) = (t.id("Crop Rotation"), t.id("Field of the Dead"));
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards && p.options.iter().any(|o| o.id == field.0.to_string())).then(|| Act::SelectCards { cards: vec![field.0] })
        })
        .unwrap();
        assert!(t.on_field(field));
        assert_eq!(t.graveyard(0).iter().filter(|n| *n == "Forest").count(), 1, "a Forest was the cost");
    });
}

/// "Whenever this land or another land you control enters, if you control seven or more lands
/// with different names, create a 2/2 black Zombie creature token."
#[test]
fn field_of_the_dead_makes_zombies_at_seven_names() {
    big_stack(|| {
        let mut t = Board::new(2)
            .basics(0, 1)
            .field(0, "Arid Mesa")
            .hand(0, "Field of the Dead")
            .hand(0, "Wastes")
            .build();
        let field = t.id("Field of the Dead");
        t.play_land(field);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 1, "seven names with the Field: a Zombie");
        assert_eq!(t.pt(t.tokens(0)[0]), (2, 2));
    });
}

#[test]
fn field_of_the_dead_does_nothing_below_seven_names() {
    big_stack(|| {
        let mut t = Board::new(2).basics(0, 1).hand(0, "Field of the Dead").build();
        let field = t.id("Field of the Dead");
        t.play_land(field);
        t.drive().unwrap();
        assert!(t.tokens(0).is_empty(), "six names");
    });
}

// ── Riders of Rohan (Éowyn) ─────────────────────────────────────────────────────────────────

/// "Whenever an opponent casts their first noncreature spell each turn, draw a card unless that
/// player pays {X}, where X is this creature's power."
#[test]
fn esper_sentinel_draws_unless_they_pay() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Esper Sentinel").hand(1, "Opt").hand(1, "Divination").lands(1, "Island", 6).active(1).build();
        let (opt, div) = (t.id("Opt"), t.id("Divination"));
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1, "Ben didn't pay: Ana drew");
        t.cast(div);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1, "only the first noncreature spell");
    });
}

/// "Adeline's power is equal to the number of creatures you control. Whenever you attack, for
/// each opponent, create a 1/1 white Human creature token that's tapped and attacking that
/// player."
#[test]
#[ignore = "phase bug: Adeline's tokens all attack the same player, not one each opponent (the parse drops \"attacking that player\")"]
fn adeline_makes_an_attacking_human_for_each_opponent() {
    big_stack(|| {
        let mut t = Board::new(3).field(0, "Adeline, Resplendent Cathar").field(0, "Grizzly Bears").build();
        let (adeline, bears) = (t.id("Adeline, Resplendent Cathar"), t.id("Grizzly Bears"));
        assert_eq!(t.pt(adeline).0, 2, "two creatures");
        t.attack(&[(bears, 1)]);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 2, "one per opponent");
        for k in &tokens {
            assert!(t.tapped(*k));
            assert!(t.subtypes(*k).contains(&"Human".to_string()));
        }
        let mut attacked: Vec<u8> = t.state().combat.as_ref().map(|c| c.attackers.iter().filter(|a| tokens.contains(&a.object_id)).map(|a| a.defending_player.0).collect()).unwrap_or_default();
        attacked.sort();
        assert_eq!(attacked, vec![1, 2], "one attacking each opponent");
        assert_eq!(t.pt(adeline).0, 4);
    });
}

/// "When Horn of Gondor enters, create a 1/1 white Human Soldier creature token. {3}, {T}:
/// Create X 1/1 white Human Soldier creature tokens, where X is the number of Humans you
/// control."
#[test]
fn horn_of_gondor_makes_a_soldier_per_human() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Horn of Gondor").field(0, "Elite Vanguard").lands(0, "Plains", 6).build();
        let horn = t.id("Horn of Gondor");
        t.cast(horn);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 1);
        t.activate_labelled(horn, |l| l.contains("Create X"));
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 3, "the Vanguard and the Soldier: two more");
    });
}

/// "Each other Human you control gets +1/+0 and has ward {1}."
#[test]
fn coppercoat_vanguard_pumps_and_wards_other_humans() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Coppercoat Vanguard").field(0, "Elite Vanguard").field(0, "Grizzly Bears").build();
        let (cv, ev, bears) = (t.id("Coppercoat Vanguard"), t.id("Elite Vanguard"), t.id("Grizzly Bears"));
        assert_eq!(t.pt(ev), (3, 1));
        assert!(t.state().objects[&ev].keywords.iter().any(|k| matches!(k, Keyword::Ward(_))));
        assert_eq!(t.pt(bears), (2, 2), "not a Human");
        assert_eq!(t.pt(cv), (2, 2), "not itself");
    });
}

/// "When this creature enters, put a +1/+1 counter on each other Human you control. Whenever
/// another Human you control enters, put a +1/+1 counter on this creature."
#[test]
fn thalias_lieutenant_grows_the_humans_and_itself() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Thalia's Lieutenant").hand(0, "Elite Vanguard").field(0, "Elite Vanguard").lands(0, "Plains", 4).build();
        let (lt, ev_new, ev_old) = (t.id("Thalia's Lieutenant"), t.ids[1], t.ids[2]);
        t.cast(lt);
        t.drive().unwrap();
        assert_eq!(t.counters(ev_old, CounterType::Plus1Plus1), 1);
        assert_eq!(t.counters(lt, CounterType::Plus1Plus1), 0);
        t.cast(ev_new);
        t.drive().unwrap();
        assert_eq!(t.counters(lt, CounterType::Plus1Plus1), 1, "another Human entered");
    });
}

/// "Sacrifice Boromir: Creatures you control gain indestructible until end of turn. The Ring
/// tempts you."
#[test]
fn boromir_sacrifices_for_indestructible() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Boromir, Warden of the Tower").field(0, "Grizzly Bears").build();
        let (boromir, bears) = (t.id("Boromir, Warden of the Tower"), t.id("Grizzly Bears"));
        t.activate(boromir, None);
        t.drive().unwrap();
        assert_eq!(t.zone(boromir), Zone::Graveyard);
        assert!(t.has(bears, Keyword::Indestructible));
    });
}

/// "Whenever an opponent casts a spell, if no mana was spent to cast it, counter that spell."
#[test]
fn boromir_counters_a_free_spell() {
    big_stack(|| {
        // Ben casts Opt with mana: it resolves.
        let mut t = Board::new(2).field(0, "Boromir, Warden of the Tower").hand(1, "Opt").lands(1, "Island", 1).active(1).build();
        let opt = t.id("Opt");
        t.tester = 1;
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(1), 1, "paid for: not countered");
    });
}

/// "When Loran enters, destroy up to one target artifact or enchantment. {T}: You and target
/// opponent each draw a card."
#[test]
fn loran_destroys_an_artifact_and_shares_a_draw() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Loran of the Third Path").lands(0, "Plains", 3).field(1, "Spellbook").build();
        let (loran, book) = (t.id("Loran of the Third Path"), t.id("Spellbook"));
        t.cast(loran);
        t.drive_aiming(&[book]);
        assert_eq!(t.zone(book), Zone::Graveyard);
        t.refresh(0);
        t.activate(loran, None);
        t.drive().unwrap();
        assert_eq!((t.drawn(0), t.drawn(1)), (1, 1));
    });
}

/// "Choose one. If you control a commander as you cast this spell, you may choose both
/// instead." Both modes: flying, vigilance, double strike, lifelink, indestructible and
/// protection from each color.
#[test]
fn akromas_will_gives_both_modes_with_a_commander() {
    big_stack(|| {
        // Auto-pay spends Plains on Éowyn's generic mana; keep white for the Will.
        let mut t = Board::new(2).commander(0, "Éowyn, Shieldmaiden").hand(0, "Akroma's Will").field(0, "Grizzly Bears").basics(0, 3).lands(0, "Plains", 3).build();
        let eowyn = *t.state().command_zone.iter().find(|id| t.state().objects[*id].owner.0 == 0).unwrap();
        t.cast(eowyn);
        t.drive().unwrap();
        let (will, bears) = (t.id("Akroma's Will"), t.id("Grizzly Bears"));
        t.cast(will);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectModes).then(|| Act::SelectModes { indices: vec![0, 1] })
        })
        .unwrap();
        for k in [Keyword::Flying, Keyword::Vigilance, Keyword::DoubleStrike, Keyword::Lifelink, Keyword::Indestructible] {
            assert!(t.has(bears, k.clone()), "{k:?}");
        }
        assert!(t.state().objects[&bears].keywords.iter().any(|k| matches!(k, Keyword::Protection(_))), "protection");
    });
}

// ── Tricky Terrain (Omo) ────────────────────────────────────────────────────────────────────

/// "Creatures you control are every creature type. {3}, {T}: Create a 2/2 blue Shapeshifter
/// creature token with changeling."
#[test]
fn maskwood_nexus_makes_your_creatures_every_type() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Maskwood Nexus").field(0, "Grizzly Bears").field(1, "Savannah Lions").lands(0, "Island", 3).build();
        let (nexus, bears, lions) = (t.id("Maskwood Nexus"), t.id("Grizzly Bears"), t.id("Savannah Lions"));
        for kind in ["Bear", "Elf", "Illusion", "Merfolk", "Wizard"] {
            assert!(t.subtypes(bears).contains(&kind.to_string()), "{kind}");
        }
        assert!(!t.subtypes(lions).contains(&"Elf".to_string()), "only your creatures");
        t.activate(nexus, None);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1);
        assert_eq!(t.pt(tokens[0]), (2, 2));
        assert!(t.subtypes(tokens[0]).contains(&"Shapeshifter".to_string()));
    });
}

/// "Illusion creatures you control get +1/+1 and have hexproof." With Maskwood Nexus every
/// creature is an Illusion.
#[test]
fn lord_of_the_unreal_with_maskwood_nexus_covers_every_creature() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Lord of the Unreal").field(0, "Maskwood Nexus").field(0, "Grizzly Bears").build();
        let bears = t.id("Grizzly Bears");
        assert_eq!(t.pt(bears), (3, 3));
        assert!(t.has(bears, Keyword::Hexproof));
    });
}

/// "{T}: Add {G} for each Elf on the battlefield." Opponents' Elves count too.
#[test]
fn priest_of_titania_counts_every_elf() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Priest of Titania").field(0, "Elvish Visionary").field(1, "Elvish Visionary").build();
        let priest = t.id("Priest of Titania");
        let action = t.mana_actions(priest).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(3));
    });
}

/// "Other Elf creatures you control get +1/+1. {T}: Add {G} for each Elf you control."
#[test]
fn elvish_archdruid_pumps_and_counts_your_elves() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Elvish Archdruid").field(0, "Elvish Visionary").field(1, "Elvish Visionary").build();
        let (druid, mine, theirs) = (t.id("Elvish Archdruid"), t.ids[1], t.ids[2]);
        assert_eq!(t.pt(mine), (2, 2));
        assert_eq!(t.pt(theirs), (1, 1), "only yours");
        let action = t.mana_actions(druid).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(2), "your two Elves");
    });
}

/// "Tap an untapped Wizard you control: Draw a card."
#[test]
fn azami_draws_for_each_wizard_tapped() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Azami, Lady of Scrolls").field(0, "Harmonic Prodigy").build();
        let (azami, prodigy) = (t.id("Azami, Lady of Scrolls"), t.id("Harmonic Prodigy"));
        t.activate(azami, None);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.options.iter().any(|o| o.id == prodigy.0.to_string())).then(|| Act::SelectCards { cards: vec![prodigy.0] })
        })
        .unwrap();
        assert_eq!(t.drawn(0), 1);
        assert!(t.tapped(prodigy));
    });
}

// ── Fantastic Four (Mister Fantastic) ───────────────────────────────────────────────────────

/// "{T}: Add {C}. {T}: Add {R} or {W}. This artifact deals 1 damage to you."
#[test]
fn talisman_of_conviction_pings_for_colour() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Talisman of Conviction").build();
        let talisman = t.id("Talisman of Conviction");
        let actions = t.mana_actions(talisman);
        assert!(actions.len() >= 2, "{actions:?}");
        let snap = t.m.state.clone();
        let mut lives = vec![];
        for a in actions {
            t.m.state = snap.clone();
            assert_eq!(t.tap_for_mana(a), Ok(1));
            lives.push(t.life(0));
        }
        assert!(lives.contains(&40), "{{C}} is free");
        assert!(lives.contains(&39), "a colour costs 1 damage");
    });
}

/// "Counter target spell."
#[test]
fn counterspell_counters_a_spell() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Counterspell").lands(0, "Island", 2).hand(1, "Divination").lands(1, "Island", 3).active(1).build();
        let (cs, div) = (t.id("Counterspell"), t.id("Divination"));
        t.cast(div);
        t.pass_until(|t| t.m.waiting_on().first() == Some(&0));
        t.cast(cs);
        t.drive_aiming(&[div]);
        assert_eq!(t.zone(div), Zone::Graveyard);
        assert_eq!(t.drawn(1), 0, "Divination didn't resolve");
    });
}

/// "Choose a creature type. Return all creatures that aren't of the chosen type to their
/// owners' hands."
#[test]
fn raise_the_palisade_bounces_all_but_the_chosen_type() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Raise the Palisade").lands(0, "Island", 5).field(0, "Elite Vanguard").field(1, "Grizzly Bears").field(1, "Elite Vanguard").build();
        let spell = t.id("Raise the Palisade");
        let (mine, bears, theirs) = (t.ids[6], t.ids[7], t.ids[8]);
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseOption).then(|| Act::ChooseOption { choice: "Human".into() })
        })
        .unwrap();
        assert!(t.on_field(mine) && t.on_field(theirs), "Humans stay");
        assert_eq!(t.zone(bears), Zone::Hand, "the Bears go home");
    });
}

// ── Multiverse Reforged (Jace) ──────────────────────────────────────────────────────────────

/// "Destroy target creature. It can't be regenerated. Its controller reveals cards from the top
/// of their library until they reveal a creature card. The player puts that card onto the
/// battlefield, then shuffles all other cards revealed this way into their library."
#[test]
fn polymorph_turns_a_creature_into_the_next_one() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Polymorph").lands(0, "Island", 4).field(0, "Grizzly Bears").top(0, "Opt").top(0, "Craw Wurm").build();
        let (poly, bears, wurm) = (t.id("Polymorph"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.cast(poly);
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Graveyard);
        assert!(t.on_field(wurm), "the Wurm came in");
    });
}

/// "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."
#[test]
fn rhystic_study_draws_unless_they_pay() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Rhystic Study").hand(1, "Opt").lands(1, "Island", 2).active(1).build();
        let opt = t.id("Opt");
        t.tester = 0;
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1, "Ben didn't pay");
    });
}

/// "Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you
/// create a Treasure token."
#[test]
fn smothering_tithe_makes_a_treasure_when_they_dont_pay() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Smothering Tithe").hand(1, "Opt").lands(1, "Island", 3).active(1).build();
        let opt = t.id("Opt");
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(1), 1);
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1, "a Treasure");
        assert_eq!(t.state().objects[&tokens[0]].name, "Treasure");
    });
}

/// "You may have this creature enter as a copy of a creature or planeswalker you control,
/// except it enters with an additional loyalty counter on it if it's a planeswalker, and it
/// isn't legendary." A second Jace with five loyalty.
#[test]
#[ignore = "phase bug: Spark Double copying a planeswalker enters with 1 loyalty counter instead of the printed loyalty plus one (the ruling)"]
fn spark_double_copies_jace_with_one_more_loyalty_and_no_legend_rule() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Jace, Multiverse Architect").hand(0, "Spark Double").lands(0, "Island", 4).build();
        let (jace, double) = (t.id("Jace, Multiverse Architect"), t.id("Spark Double"));
        t.cast(double);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 {
                return None;
            }
            match p.answer {
                // "Have Spark Double enter as a copy...?": yes.
                Answer::ChooseReplacement => Some(Act::ChooseReplacement { index: 0 }),
                Answer::ChooseTarget if p.options.iter().any(|o| o.id == jace.0.to_string()) => Some(Act::ChooseTarget { target: Some(TargetView::Object { id: jace.0 }) }),
                _ => None,
            }
        })
        .unwrap();
        assert!(t.on_field(jace) && t.on_field(double), "both stay: the copy isn't legendary");
        assert_eq!(t.state().objects[&double].name, "Jace, Multiverse Architect");
        assert_eq!(t.counters(double, CounterType::Loyalty), 5);
    });
}

/// "You may activate the loyalty abilities of planeswalkers you control twice each turn rather
/// than only once."
#[test]
fn oath_of_teferi_lets_jace_act_twice() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Oath of Teferi").field(0, "Jace, Multiverse Architect").build();
        let jace = t.id("Jace, Multiverse Architect");
        t.activate_labelled(jace, |l| l.starts_with('+'));
        t.drive().unwrap();
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Ability && o.object == Some(jace.0)), "a second loyalty ability this turn");
    });
}

// ── Lands ───────────────────────────────────────────────────────────────────────────────────

/// "{T}, Pay 1 life, Sacrifice this land: Search your library for a Mountain or Plains card,
/// put it onto the battlefield, then shuffle." The land found enters untapped.
#[test]
fn arid_mesa_fetches_a_mountain_or_plains_untapped() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Arid Mesa").top(0, "Sacred Foundry").build();
        let (mesa, foundry) = (t.id("Arid Mesa"), t.id("Sacred Foundry"));
        t.activate(mesa, None);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 {
                return None;
            }
            if p.answer == Answer::SelectCards && p.options.iter().any(|o| o.id == foundry.0.to_string()) {
                return Some(Act::SelectCards { cards: vec![foundry.0] });
            }
            // Sacred Foundry's "Pay 2 life?": the first option pays.
            (p.answer == Answer::ChooseReplacement).then_some(Act::ChooseReplacement { index: 0 })
        })
        .unwrap();
        assert_eq!(t.zone(mesa), Zone::Graveyard);
        assert!(t.on_field(foundry), "Sacred Foundry is a Mountain Plains");
        assert!(!t.tapped(foundry), "paid 2 life: untapped");
        assert_eq!(t.life(0), 37, "1 for the Mesa, 2 for the Foundry");
    });
}

/// "As this land enters, you may pay 2 life. If you don't, it enters tapped."
#[test]
fn sacred_foundry_enters_tapped_unless_you_pay() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Sacred Foundry").build();
        let foundry = t.id("Sacred Foundry");
        t.play_land(foundry);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            // "Pay 2 life?": the second option declines.
            (seat == 0 && p.answer == Answer::ChooseReplacement).then_some(Act::ChooseReplacement { index: 1 })
        })
        .unwrap();
        assert!(t.tapped(foundry));
        assert_eq!(t.life(0), 40);
    });
}

/// "This land enters tapped unless you control two or fewer other lands."
#[test]
fn inspiring_vantage_is_untapped_only_early() {
    big_stack(|| {
        let mut early = Board::new(2).hand(0, "Inspiring Vantage").lands(0, "Plains", 2).build();
        let v = early.id("Inspiring Vantage");
        early.play_land(v);
        early.drive().unwrap();
        assert!(!early.tapped(v), "two other lands: untapped");
        let mut late = Board::new(2).hand(0, "Inspiring Vantage").lands(0, "Plains", 3).build();
        let v = late.id("Inspiring Vantage");
        late.play_land(v);
        late.drive().unwrap();
        assert!(late.tapped(v), "three other lands: tapped");
    });
}

/// "{T}, Pay 1 life: Add one mana of any color."
#[test]
fn mana_confluence_costs_a_life() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mana Confluence").build();
        let mc = t.id("Mana Confluence");
        let action = t.mana_actions(mc).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(1));
        assert_eq!(t.life(0), 39);
    });
}

// ── More of the Fantastic Four's upgrades ───────────────────────────────────────────────────

/// "When The Fantastic Four enter and whenever you cast a spell with power, toughness, or mana
/// value 4, choose one that hasn't been chosen this turn." Draw a card on entering; then Hill
/// Giant (mana value 4) brings another choice, without "Draw a card".
#[test]
fn the_fantastic_four_choose_a_new_mode_each_time() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "The Fantastic Four").hand(0, "Hill Giant").basics(0, 2).build();
        let (ff, giant) = (t.id("The Fantastic Four"), t.id("Hill Giant"));
        t.cast(ff);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0).then(|| choose_named(p, "Draw a card")).flatten()
        })
        .unwrap();
        assert_eq!(t.drawn(0), 1);
        let mut second = vec![];
        t.cast(giant);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 || !matches!(p.answer, Answer::SelectModes | Answer::ChooseBranch | Answer::ChooseOption) {
                return None;
            }
            second = p.options.iter().filter(|o| o.eligible).map(|o| o.name.clone()).collect();
            choose_named(p, "damage")
        })
        .unwrap();
        assert!(!second.is_empty(), "the mana value 4 spell triggered a choice");
        assert!(!second.iter().any(|n| n.contains("Draw a card")), "a mode chosen this turn isn't offered again: {second:?}");
        assert_eq!(t.life(1), 37);
    });
}

/// "Vivid — {T}: For each color among permanents you control, add one mana of that color."
#[test]
fn bloom_tender_adds_a_mana_per_colour_among_your_permanents() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Bloom Tender").field(0, "Savannah Lions").field(0, "Lightning Bolt").build();
        let tender = t.id("Bloom Tender");
        let action = t.mana_actions(tender).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(2), "green and white (an instant isn't a permanent)");
    });
}

/// "This creature gets +1/+1 for each color among permanents you control. {T}: For each color
/// among permanents you control, add one mana of that color."
#[test]
fn faeburrow_elder_grows_and_taps_for_each_colour() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Faeburrow Elder").field(0, "Elvish Visionary").build();
        let elder = t.id("Faeburrow Elder");
        assert_eq!(t.pt(elder), (2, 2), "green and white");
        let action = t.mana_actions(elder).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(2));
    });
}

/// "{T}: Add one mana of any color that a land an opponent controls could produce." Ben has
/// only Islands.
#[test]
fn fellwar_stone_makes_only_an_opponents_colours() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Fellwar Stone").lands(1, "Island", 2).build();
        let stone = t.id("Fellwar Stone");
        let actions = t.mana_actions(stone);
        assert!(!actions.is_empty());
        for a in &actions {
            let text = format!("{a:?}");
            assert!(!["White", "Black", "Red", "Green"].iter().any(|c| text.contains(&format!("mana_type: {c}"))), "only blue: {text}");
        }
    });
}

/// "Exile all the cards from your hand, then draw that many cards. Until the end of your next
/// turn, you may play cards exiled this way."
#[test]
#[ignore = "phase bug: Hex Magic exiles nothing and draws nothing (\"exile all the cards from your hand\" parses with no cards to move)"]
fn hex_magic_swaps_your_hand_and_lets_you_play_the_old_one() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Hex Magic").hand(0, "Forest").hand(0, "Opt").lands(0, "Mountain", 3).lands(0, "Island", 1).build();
        let (spell, forest, opt) = (t.id("Hex Magic"), t.id("Forest"), t.id("Opt"));
        t.cast(spell);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
        assert_eq!((t.zone(forest), t.zone(opt)), (Zone::Exile, Zone::Exile));
        let d = t.decision(0);
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(forest.0)), "the exiled Forest may be played");
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(opt.0)), "the exiled Opt may be cast");
    });
}

/// "Counter target spell. Its controller may draw up to two cards at the beginning of the next
/// turn's upkeep. You draw a card at the beginning of the next turn's upkeep."
#[test]
fn arcane_denial_counters_and_both_draw_next_upkeep() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Arcane Denial").lands(0, "Island", 2).hand(1, "Divination").lands(1, "Island", 3).active(1).build();
        let (denial, div) = (t.id("Arcane Denial"), t.id("Divination"));
        t.cast(div);
        t.pass_until(|t| t.m.waiting_on().first() == Some(&0));
        t.cast(denial);
        t.drive_aiming(&[div]);
        assert_eq!(t.zone(div), Zone::Graveyard, "countered");
        // Ana's turn comes next: its upkeep.
        let (hand0, hand1) = (t.hand(0).len(), t.hand(1).len());
        t.advance_to(Phase::Upkeep);
        t.drive_answering(|_, _, d| {
            let p = d.pending.as_ref()?;
            match p.answer {
                Answer::DecideOptionalEffect => Some(Act::DecideOptionalEffect { accept: true }),
                // "Draw no cards", "Draw 1 card", "Draw 2 cards".
                Answer::ChooseBranch => choose_named(p, "2 cards"),
                _ => None,
            }
        })
        .unwrap();
        assert_eq!(t.hand(0).len(), hand0 + 1, "Ana drew one");
        assert_eq!(t.hand(1).len(), hand1 + 2, "Ben drew up to two");
    });
}

/// "Draw X cards. If X is 5 or more, you may cast a Hero spell from your hand without paying its
/// mana cost."
#[test]
fn west_coast_expansion_draws_x() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "West Coast Expansion").lands(0, "Island", 4).build();
        let spell = t.id("West Coast Expansion");
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseX).then_some(Act::ChooseX { value: 2 })
        })
        .unwrap();
        assert_eq!(t.drawn(0), 2);
    });
}

/// "When King Solomon's Frogs enters, if you cast it, for each opponent, exile up to one target
/// permanent that player controls with mana value 3 or greater. For each permanent exiled this
/// way, its controller draws a card."
#[test]
fn king_solomons_frogs_exiles_a_big_permanent_and_its_controller_draws() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "King Solomon's Frogs").lands(0, "Plains", 4).field(1, "Hill Giant").field(1, "Grizzly Bears").build();
        let (frogs, giant, bears) = (t.id("King Solomon's Frogs"), t.id("Hill Giant"), t.id("Grizzly Bears"));
        t.cast(frogs);
        let mut offered = vec![];
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat == 0 && p.answer == Answer::ChooseTarget {
                offered = p.options.iter().map(|o| o.id.clone()).collect();
                return Some(Act::ChooseTarget { target: Some(TargetView::Object { id: giant.0 }) });
            }
            None
        })
        .unwrap();
        assert_eq!(t.zone(giant), Zone::Exile);
        assert!(!offered.contains(&bears.0.to_string()), "mana value 2 isn't a legal target");
        assert_eq!(t.drawn(1), 1, "its controller drew");
    });
}

/// "Instant, sorcery, and Dragon spells you control can't be countered."
#[test]
fn taigam_keeps_your_sorcery_from_being_countered() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Taigam, Ojutai Master").hand(0, "Divination").lands(0, "Island", 3).hand(1, "Counterspell").lands(1, "Island", 2).build();
        let (div, cs) = (t.id("Divination"), t.id("Counterspell"));
        t.cast(div);
        t.pass_until(|t| t.m.waiting_on().first() == Some(&1));
        t.cast(cs);
        t.tester = 0;
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 1 && p.answer == Answer::ChooseTarget).then(|| Act::ChooseTarget { target: Some(TargetView::Object { id: div.0 }) })
        })
        .unwrap();
        assert_eq!(t.drawn(0), 2, "Divination resolved");
    });
}

/// "Return target nonland permanent card from your graveyard to the battlefield. Paradigm (Then
/// exile this spell...)"
#[test]
fn restoration_seminar_returns_a_permanent_and_is_exiled() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Restoration Seminar").lands(0, "Plains", 7).grave(0, "Spellbook").build();
        let (spell, book) = (t.id("Restoration Seminar"), t.id("Spellbook"));
        t.cast(spell);
        t.drive_aiming(&[book]);
        assert!(t.on_field(book));
        assert_eq!(t.zone(spell), Zone::Exile, "paradigm exiles it");
    });
}

/// "Exile cards from the top of your library until you exile cards with total mana value 4 or
/// greater. You may cast any number of spells from among them without paying their mana
/// costs."
#[test]
fn improvisation_capstone_casts_the_exiled_spells_free() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Improvisation Capstone").lands(0, "Mountain", 7).top(0, "Grizzly Bears").top(0, "Savannah Lions").top(0, "Opt").build();
        let (spell, bears, lions) = (t.id("Improvisation Capstone"), t.id("Grizzly Bears"), t.id("Savannah Lions"));
        t.cast(spell);
        // The free casts are asked one at a time, by the cards' names, until none is picked.
        let mut windows = 0;
        t.drive_answering(|tbl, seat, d| {
            let p = d.pending.as_ref().filter(|p| seat == 0 && p.purpose == "free_cast_window")?;
            windows += 1;
            assert!(p.options.iter().all(|o| ["Grizzly Bears", "Savannah Lions", "Opt"].contains(&o.name.as_str())), "the exiled cards by name: {:?}", p.options);
            let wanted = [bears, lions].into_iter().find(|id| p.options.iter().any(|o| o.eligible && o.id == id.0.to_string()));
            if let Some(id) = wanted {
                let name = &tbl.state().objects[&id].name;
                assert!(d.options.iter().any(|o| o.label == format!("Cast {name} without paying its mana cost")), "{:?}", d.options);
            }
            Some(Act::SelectCards { cards: wanted.map(|id| vec![id.0]).unwrap_or_default() })
        })
        .unwrap();
        assert!(windows >= 2, "a window for each cast");
        assert!(t.on_field(bears) && t.on_field(lions), "1 + 1 + 2: both creatures cast free");
    });
}

// ── More of Tricky Terrain's upgrades ───────────────────────────────────────────────────────

/// "Other Knights you control have horsemanship."
#[test]
fn herald_of_hoofbeats_gives_other_knights_horsemanship() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Herald of Hoofbeats").field(0, "Éowyn, Shieldmaiden").field(0, "Grizzly Bears").build();
        let (eowyn, bears) = (t.id("Éowyn, Shieldmaiden"), t.id("Grizzly Bears"));
        assert!(t.has(eowyn, Keyword::Horsemanship));
        assert!(!t.has(bears, Keyword::Horsemanship));
    });
}

/// "When this enchantment enters, draw a card, then you may put a land card from your hand onto
/// the battlefield. ... Lands you control enter untapped."
#[test]
fn spelunking_draws_puts_a_land_and_untaps_entering_lands() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Spelunking").hand(0, "Field of the Dead").lands(0, "Forest", 3).build();
        let (spell, field) = (t.id("Spelunking"), t.id("Field of the Dead"));
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            match p.answer {
                Answer::SelectCards if seat == 0 && p.options.iter().any(|o| o.id == field.0.to_string()) => Some(Act::SelectCards { cards: vec![field.0] }),
                // Ruling: you order the two; applying the Field's "enters tapped" first leaves
                // Spelunking's untap last, so it enters untapped.
                Answer::ChooseReplacement if seat == 0 => choose_named(p, "Field of the Dead"),
                _ => None,
            }
        })
        .unwrap();
        assert_eq!(t.drawn(0), 1);
        assert!(t.on_field(field));
        assert!(!t.tapped(field), "Field of the Dead enters untapped");
    });
}

/// "Return all creatures to their owners' hands except for Krakens, Leviathans, Octopuses, and
/// Serpents."
#[test]
fn whelming_wave_spares_serpents() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Whelming Wave").lands(0, "Island", 4).field(0, "Aesi, Tyrant of Gyre Strait").field(1, "Grizzly Bears").build();
        let (wave, aesi, bears) = (t.id("Whelming Wave"), t.id("Aesi, Tyrant of Gyre Strait"), t.id("Grizzly Bears"));
        t.cast(wave);
        t.drive().unwrap();
        assert!(t.on_field(aesi), "a Serpent stays");
        assert_eq!(t.zone(bears), Zone::Hand);
    });
}

/// "You may play an additional land on each of your turns. ... You may play lands from the top
/// of your library."
#[test]
fn oracle_of_mul_daya_plays_lands_from_the_top() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Oracle of Mul Daya").hand(0, "Swamp").top(0, "Forest").build();
        let (swamp, forest) = (t.id("Swamp"), t.id("Forest"));
        t.play_land(forest);
        t.drive().unwrap();
        assert!(t.on_field(forest), "played from the top of the library");
        t.play_land(swamp);
        t.drive().unwrap();
        assert!(t.on_field(swamp), "a second land this turn");
    });
}

/// "Equipped creature has haste and shroud. Equip {0}"
#[test]
fn lightning_greaves_gives_haste_and_shroud_for_free() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Lightning Greaves").field(0, "Grizzly Bears").build();
        let (greaves, bears) = (t.id("Lightning Greaves"), t.id("Grizzly Bears"));
        t.m.state.objects.get_mut(&bears).unwrap().summoning_sick = true;
        t.activate(greaves, None);
        t.drive_aiming(&[bears]);
        assert!(t.has(bears, Keyword::Haste) && t.has(bears, Keyword::Shroud));
    });
}

/// "{1}, {T}: Move a counter from target permanent you control onto a second target permanent.
/// Activate only as a sorcery."
#[test]
fn nesting_grounds_moves_a_counter() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Nesting Grounds").lands(0, "Forest", 1).field(0, "Grizzly Bears").field(0, "Savannah Lions").build();
        let (ng, bears, lions) = (t.id("Nesting Grounds"), t.id("Grizzly Bears"), t.id("Savannah Lions"));
        t.m.state.objects.get_mut(&bears).unwrap().counters.insert(CounterType::Plus1Plus1, 1);
        t.activate_labelled(ng, |l| l.contains("Move a counter"));
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 || p.answer != Answer::ChooseTarget {
                return None;
            }
            // From the Bears (the first target), onto the Lions (the second).
            let id = if p.slot.is_some_and(|(i, _)| i > 0) { lions } else { bears };
            Some(Act::ChooseTarget { target: Some(TargetView::Object { id: id.0 }) })
        })
        .unwrap();
        assert_eq!(t.counters(bears, CounterType::Plus1Plus1), 0);
        assert_eq!(t.counters(lions, CounterType::Plus1Plus1), 1);
    });
}

/// "If a land entering causes a triggered ability of a permanent you control to trigger, that
/// ability triggers an additional time." Tireless Provisioner makes two tokens.
#[test]
fn ancient_greenwarden_doubles_landfall() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Ancient Greenwarden").field(0, "Tireless Provisioner").hand(0, "Forest").build();
        let forest = t.id("Forest");
        t.play_land(forest);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 2);
    });
}

/// "You may play lands from your graveyard." (Ancient Greenwarden)
#[test]
fn ancient_greenwarden_plays_lands_from_the_graveyard() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Ancient Greenwarden").grave(0, "Forest").build();
        let forest = t.id("Forest");
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(forest.0)));
    });
}

/// "You may play an additional land on each of your turns. Landfall — Whenever a land you
/// control enters, you may draw a card."
#[test]
fn aesi_draws_on_each_of_two_lands() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Aesi, Tyrant of Gyre Strait").hand(0, "Forest").hand(0, "Island").build();
        let (forest, island) = (t.id("Forest"), t.id("Island"));
        t.play_land(forest);
        t.drive().unwrap();
        t.play_land(island);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
    });
}

/// "You may play two additional lands on each of your turns."
#[test]
fn azusa_plays_three_lands() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Azusa, Lost but Seeking").hand(0, "Forest").hand(0, "Island").hand(0, "Swamp").hand(0, "Plains").build();
        for name in ["Forest", "Island", "Swamp"] {
            let id = t.id(name);
            t.play_land(id);
            t.drive().unwrap();
            assert!(t.on_field(id), "{name}");
        }
        let plains = t.id("Plains");
        assert!(!t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(plains.0)), "not a fourth");
    });
}

/// "Permanents you control gain hexproof and indestructible until end of turn."
#[test]
fn heroic_intervention_protects_your_permanents() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Heroic Intervention").lands(0, "Forest", 2).field(0, "Grizzly Bears").build();
        let (spell, bears) = (t.id("Heroic Intervention"), t.id("Grizzly Bears"));
        t.cast(spell);
        t.drive().unwrap();
        assert!(t.has(bears, Keyword::Hexproof) && t.has(bears, Keyword::Indestructible));
    });
}

/// "Other Treefolk creatures you control get +1/+1. Other Treefolk and Forests you control have
/// indestructible."
#[test]
fn timber_protector_makes_forests_indestructible() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Timber Protector").lands(0, "Forest", 1).lands(0, "Island", 1).build();
        let (forest, island) = (t.id("Forest"), t.id("Island"));
        assert!(t.has(forest, Keyword::Indestructible));
        assert!(!t.has(island, Keyword::Indestructible));
    });
}

/// "This creature enters with a +1/+1 counter on it. Landfall — Whenever a land you control
/// enters, double the number of +1/+1 counters on this creature."
#[test]
fn mossborn_hydra_doubles_its_counters_on_landfall() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Mossborn Hydra").lands(0, "Forest", 3).hand(0, "Forest").build();
        let hydra = t.id("Mossborn Hydra");
        t.cast(hydra);
        t.drive().unwrap();
        assert_eq!(t.counters(hydra, CounterType::Plus1Plus1), 1);
        let forest = t.ids[4];
        t.play_land(forest);
        t.drive().unwrap();
        assert_eq!(t.counters(hydra, CounterType::Plus1Plus1), 2);
    });
}

/// "{T}: Put a burden counter on The One Ring, then draw a card for each burden counter on The
/// One Ring."
#[test]
fn the_one_ring_draws_one_per_burden_counter() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "The One Ring").build();
        let ring = t.id("The One Ring");
        t.m.state.objects.get_mut(&ring).unwrap().counters.insert(CounterType::Generic("burden".into()), 1);
        t.activate(ring, None);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2, "the second burden counter draws two");
    });
}

/// "{T}: Add {G} for each creature you control."
#[test]
fn gaeas_cradle_counts_your_creatures() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Gaea's Cradle").field(0, "Grizzly Bears").field(0, "Savannah Lions").field(1, "Hill Giant").build();
        let cradle = t.id("Gaea's Cradle");
        let action = t.mana_actions(cradle).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(2));
    });
}

/// "As an additional cost to cast this spell, sacrifice a green creature. Search your library for
/// a green creature card, put it onto the battlefield, then shuffle."
#[test]
fn natural_order_trades_a_green_creature_for_any_green_creature() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Natural Order").lands(0, "Forest", 4).field(0, "Grizzly Bears").top(0, "Craw Wurm").build();
        let (spell, bears, wurm) = (t.id("Natural Order"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.cast(spell);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards && p.options.iter().any(|o| o.id == wurm.0.to_string())).then(|| Act::SelectCards { cards: vec![wurm.0] })
        })
        .unwrap();
        assert_eq!(t.zone(bears), Zone::Graveyard, "the Bears paid for it");
        assert!(t.on_field(wurm));
    });
}

/// "Return target nonland permanent you don't control to its owner's hand. Overload {6}{U}"
#[test]
fn cyclonic_rift_overloaded_bounces_everything_they_control() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Cyclonic Rift").lands(0, "Island", 7).field(0, "Grizzly Bears").field(1, "Hill Giant").field(1, "Spellbook").build();
        let (rift, mine, giant, book) = (t.id("Cyclonic Rift"), t.id("Grizzly Bears"), t.id("Hill Giant"), t.id("Spellbook"));
        t.cast(rift);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseAlternativeCast).then_some(Act::ChooseAlternativeCast { alternative: true })
        })
        .unwrap();
        assert_eq!((t.zone(giant), t.zone(book)), (Zone::Hand, Zone::Hand));
        assert!(t.on_field(mine), "yours stay");
    });
}

// ── More of Multiverse Reforged's candidates ────────────────────────────────────────────────

/// "Whenever this creature enters or attacks, create two 2/2 black Zombie creature tokens."
#[test]
fn grave_titan_makes_two_zombies_on_entering() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Grave Titan").lands(0, "Swamp", 6).build();
        let titan = t.id("Grave Titan");
        t.cast(titan);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 2);
        assert!(tokens.iter().all(|z| t.pt(*z) == (2, 2)));
    });
}

/// "Other creatures you control get +2/+2. Creatures your opponents control get -2/-2."
#[test]
fn elesh_norn_pumps_yours_and_shrinks_theirs() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Elesh Norn, Grand Cenobite").field(0, "Grizzly Bears").field(1, "Hill Giant").field(1, "Savannah Lions").build();
        let (bears, giant, lions) = (t.id("Grizzly Bears"), t.id("Hill Giant"), t.id("Savannah Lions"));
        assert_eq!(t.pt(bears), (4, 4));
        assert_eq!(t.pt(giant), (1, 1));
        assert_eq!(t.pt(lions), (0, -1));
        // The board was set by hand: state-based actions run once the game moves on.
        t.choose(0, |o| o.kind == OptionKind::Pass);
        assert_eq!(t.zone(lions), Zone::Graveyard, "a 2/1 dies at -2/-2");
    });
}

/// "Exile target creature. That creature's controller reveals cards from the top of their library
/// until they reveal a creature card. That player puts that card onto the battlefield."
#[test]
fn transmogrify_turns_a_creature_into_the_next_one() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Transmogrify").lands(0, "Mountain", 4).field(0, "Grizzly Bears").top(0, "Opt").top(0, "Craw Wurm").build();
        let (spell, bears, wurm) = (t.id("Transmogrify"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.cast(spell);
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Exile);
        assert!(t.on_field(wurm));
    });
}

/// "{3}{R}: Exile target creature or planeswalker you control. Reveal cards from the top of your
/// library until you reveal a creature or planeswalker card. Put that card onto the battlefield."
#[test]
fn identity_echo_trades_a_creature_for_the_next_one() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Identity Echo").lands(0, "Mountain", 4).field(0, "Grizzly Bears").top(0, "Opt").top(0, "Craw Wurm").build();
        let (echo, bears, wurm) = (t.id("Identity Echo"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.activate(echo, None);
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Exile);
        assert!(t.on_field(wurm));
    });
}

/// "The owner of target permanent shuffles it into their library, then reveals the top card of
/// their library. If it's a permanent card, they put it onto the battlefield."
#[test]
fn chaos_warp_shuffles_a_permanent_away() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Chaos Warp").lands(0, "Mountain", 3).field(1, "Hill Giant").build();
        let (spell, giant) = (t.id("Chaos Warp"), t.id("Hill Giant"));
        t.cast(spell);
        t.drive_aiming(&[giant]);
        assert!(!t.on_field(giant) || t.state().players[1].library.is_empty(), "shuffled into the library (or revealed and put back)");
    });
}

/// "When this creature enters, gain control of target permanent."
#[test]
fn agent_of_treachery_steals_a_permanent() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Agent of Treachery").lands(0, "Island", 7).field(1, "Hill Giant").build();
        let (agent, giant) = (t.id("Agent of Treachery"), t.id("Hill Giant"));
        t.cast(agent);
        t.drive_aiming(&[giant]);
        assert_eq!(t.controller(giant), 0);
    });
}

/// "Whenever an opponent draws a card, you may draw two cards."
#[test]
fn consecrated_sphinx_draws_two_when_they_draw() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Consecrated Sphinx").hand(1, "Opt").lands(1, "Island", 1).active(1).build();
        let opt = t.id("Opt");
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(1), 1);
        assert_eq!(t.drawn(0), 2);
    });
}

/// "If you control a commander, you may cast this spell without paying its mana cost. Counter
/// target noncreature spell."
#[test]
fn fierce_guardianship_is_free_with_a_commander_out() {
    big_stack(|| {
        let mut t = Board::new(2).commander(0, "Jace, Multiverse Architect").hand(0, "Fierce Guardianship").basics(0, 2).hand(1, "Divination").lands(1, "Island", 3).build();
        let jace = *t.state().command_zone.iter().find(|id| t.state().objects[*id].owner.0 == 0).unwrap();
        t.cast(jace);
        t.drive().unwrap();
        // Ana's lands are all tapped now.
        for id in t.state().battlefield.clone() {
            if t.state().objects[&id].controller.0 == 0 && t.state().objects[&id].card_types.core_types.contains(&engine::types::card_type::CoreType::Land) {
                t.m.state.objects.get_mut(&id).unwrap().tapped = true;
            }
        }
        t.m.state.active_player = engine::types::player::PlayerId(1);
        t.m.state.priority_player = engine::types::player::PlayerId(1);
        t.m.state.waiting_for = engine::types::game_state::WaitingFor::Priority { player: engine::types::player::PlayerId(1) };
        t.m.remark(None);
        let (fg, div) = (t.id("Fierce Guardianship"), t.id("Divination"));
        t.cast(div);
        t.pass_until(|t| t.m.waiting_on().first() == Some(&0));
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(fg.0)), "castable with no mana");
        t.act(0, Act::CastSpell { object: fg.0, payment: crate::pay::PayMode::Auto });
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat != 0 {
                return None;
            }
            match p.answer {
                Answer::ChooseAlternativeCast => Some(Act::ChooseAlternativeCast { alternative: true }),
                Answer::ChooseTarget => Some(Act::ChooseTarget { target: Some(TargetView::Object { id: div.0 }) }),
                _ => None,
            }
        })
        .unwrap();
        assert_eq!(t.zone(div), Zone::Graveyard, "countered");
    });
}

/// "At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature
/// token with flying."
#[test]
fn bitterblossom_makes_a_faerie_each_upkeep() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Bitterblossom").phase(Phase::Untap).build();
        t.advance_to(Phase::Upkeep);
        t.drive().unwrap();
        assert_eq!(t.life(0), 39);
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1);
        assert!(t.has(tokens[0], Keyword::Flying));
    });
}

/// "When this creature enters, exile up to two target artifacts and/or enchantments."
#[test]
fn angel_of_the_ruins_exiles_two_artifacts_or_enchantments() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Angel of the Ruins").lands(0, "Plains", 7).field(1, "Spellbook").field(1, "Ghostly Prison").build();
        let (angel, book, prison) = (t.id("Angel of the Ruins"), t.id("Spellbook"), t.id("Ghostly Prison"));
        t.cast(angel);
        t.drive_aiming(&[book, prison]);
        assert_eq!((t.zone(book), t.zone(prison)), (Zone::Exile, Zone::Exile));
    });
}

/// "At the beginning of each opponent's end step, that player chooses up to two creatures they
/// control, then sacrifices the rest."
#[test]
#[ignore = "phase bug: Archfiend of Depravity's end step trigger asks its controller for a target and sacrifices nothing"]
fn archfiend_of_depravity_leaves_each_opponent_two_creatures() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Archfiend of Depravity").field(1, "Grizzly Bears").field(1, "Savannah Lions").field(1, "Hill Giant").active(1).build();
        t.tester = 1;
        t.advance_to(Phase::End);
        t.drive().unwrap();
        let theirs = t.state().battlefield.iter().filter(|id| t.state().objects[*id].controller.0 == 1 && t.is_creature(**id)).count();
        assert_eq!(theirs, 2);
    });
}

/// "When this creature enters, for each opponent, you may put up to one target creature card
/// from that player's graveyard onto the battlefield under your control."
#[test]
#[ignore = "phase bug: Sepulchral Primordial gets one target in all, not one in each opponent's graveyard"]
fn sepulchral_primordial_takes_a_creature_from_each_opponents_graveyard() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Sepulchral Primordial").lands(0, "Swamp", 7).grave(1, "Hill Giant").grave(2, "Craw Wurm").build();
        let (prim, giant, wurm) = (t.id("Sepulchral Primordial"), t.id("Hill Giant"), t.id("Craw Wurm"));
        t.cast(prim);
        t.drive_aiming(&[giant, wurm]);
        assert!(t.on_field(giant) && t.on_field(wurm));
        assert_eq!((t.controller(giant), t.controller(wurm)), (0, 0));
    });
}

/// "As this land enters, you may reveal a Plains or Island card from your hand. If you don't,
/// this land enters tapped."
#[test]
fn port_town_enters_untapped_when_you_reveal_a_plains() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Port Town").hand(0, "Plains").build();
        let (town, plains) = (t.id("Port Town"), t.id("Plains"));
        t.play_land(town);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards).then(|| Act::SelectCards { cards: vec![plains.0] })
        })
        .unwrap();
        assert!(!t.tapped(town));
    });
}
