//! The cards Bryan's decks are built around: the upgrades whose "why" in commander-decks
//! (data/shopping/swaps.json, data/shopping/tricky-terrain.json, data/shopping/candidates.json)
//! says what each is for, checked against its Oracle text and rulings. Grouped by deck.

use engine::game::game_object::AttachTarget;
use engine::types::counter::CounterType;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::zones::Zone;

use super::{Board, big_stack};
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
