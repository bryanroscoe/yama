//! The eight commanders of Bryan's decks, each checked against its Oracle text and rulings
//! (phase's card data carries the rulings; card-data-eb309108eb0df708.json).

use engine::types::counter::CounterType;
use engine::types::identifiers::ObjectId;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::zones::Zone;

use super::{Board, Table, big_stack};
use crate::act::Answer;
use crate::{Act, AttackAt, OptionKind, TargetView};

/// The id of seat `seat`'s commander in the command zone.
fn in_command_zone(t: &Table, seat: u8) -> ObjectId {
    *t.state().command_zone.iter().find(|id| t.state().objects[*id].owner.0 == seat).expect("a commander in the command zone")
}

// ── every commander ─────────────────────────────────────────────────────────────────────────

/// CR 903.8: a commander is cast from the command zone; it then costs {2} more for each time
/// it was cast from there before (the commander tax).
fn casts_from_the_command_zone(commander: &'static str) {
    big_stack(move || {
        for before in [0, 1] {
            let mut t = Board::new(2).commander(0, commander).basics(0, 4).build();
            let id = in_command_zone(&t, 0);
            t.m.state.commander_cast_count.insert(id, before);
            assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(id.0)), "{commander} is offered from the command zone");
            t.cast(id);
            t.drive().unwrap();
            assert!(t.on_field(id), "{commander} resolved onto the battlefield");
            let mv = t.state().objects[&id].mana_cost.mana_value();
            let lands_tapped = t.state().battlefield.iter().filter(|l| **l != id && t.tapped(**l)).count() as u32;
            assert_eq!(lands_tapped, mv + 2 * before, "{commander} cast from the command zone after {before} casts");
            assert_eq!(t.state().commander_cast_count.get(&id).copied(), Some(before + 1), "the cast was counted");
        }
    });
}

#[test]
fn mister_fantastic_casts_from_the_command_zone() {
    casts_from_the_command_zone("Mister Fantastic");
}

#[test]
fn eowyn_casts_from_the_command_zone() {
    casts_from_the_command_zone("Éowyn, Shieldmaiden");
}

#[test]
fn quintorius_casts_from_the_command_zone() {
    casts_from_the_command_zone("Quintorius, History Chaser");
}

#[test]
fn rootha_casts_from_the_command_zone() {
    casts_from_the_command_zone("Rootha, Mastering the Moment");
}

#[test]
fn terra_casts_from_the_command_zone() {
    casts_from_the_command_zone("Terra, Herald of Hope");
}

#[test]
fn hearthhull_casts_from_the_command_zone() {
    casts_from_the_command_zone("Hearthhull, the Worldseed");
}

#[test]
fn omo_casts_from_the_command_zone() {
    casts_from_the_command_zone("Omo, Queen of Vesuva");
}

#[test]
fn jace_casts_from_the_command_zone() {
    casts_from_the_command_zone("Jace, Multiverse Architect");
}

// ── Mister Fantastic (Fantastic Four) ───────────────────────────────────────────────────────

/// "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, draw
/// a card."
#[test]
fn mister_fantastic_draws_at_combat_after_a_noncreature_spell() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mister Fantastic").hand(0, "Opt").basics(0, 1).build();
        let opt = t.id("Opt");
        t.cast(opt);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1, "Opt drew");
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2, "Mister Fantastic drew at the beginning of combat");
    });
}

#[test]
fn mister_fantastic_draws_nothing_without_a_noncreature_spell() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mister Fantastic").hand(0, "Grizzly Bears").basics(0, 1).build();
        let bears = t.id("Grizzly Bears");
        t.cast(bears);
        t.drive().unwrap();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 0, "a creature spell doesn't count");
    });
}

/// "{R}{G}{W}{U}, {T}: Copy target triggered ability you control twice." Elvish Visionary's
/// enters trigger, copied twice, draws three cards in all.
#[test]
fn mister_fantastic_copies_a_triggered_ability_twice() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mister Fantastic").hand(0, "Elvish Visionary").basics(0, 2).build();
        let (mf, elf) = (t.id("Mister Fantastic"), t.id("Elvish Visionary"));
        t.cast(elf);
        // The Visionary resolves; its trigger goes on the stack and Ana gets priority.
        t.pass_until(|t| t.on_field(elf) && t.state().stack.last().is_some_and(|e| e.source_id == elf));
        t.activate(mf, None);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 3, "the trigger and its two copies each drew");
        assert!(t.tapped(mf));
    });
}

// ── Éowyn, Shieldmaiden (Riders of Rohan) ───────────────────────────────────────────────────

/// "At the beginning of combat on your turn, if another Human entered the battlefield under
/// your control this turn, create two 2/2 red Human Knight creature tokens with trample and
/// haste. Then if you control six or more Humans, draw a card."
#[test]
fn eowyn_makes_two_knights_after_another_human_enters() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Éowyn, Shieldmaiden").hand(0, "Elite Vanguard").basics(0, 1).build();
        let vanguard = t.id("Elite Vanguard");
        t.cast(vanguard);
        t.drive().unwrap();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 2, "two Knights");
        for k in tokens {
            assert_eq!(t.pt(k), (2, 2));
            let types = t.subtypes(k);
            assert!(types.contains(&"Human".to_string()) && types.contains(&"Knight".to_string()), "{types:?}");
            assert!(t.has(k, Keyword::Trample) && t.has(k, Keyword::Haste));
        }
        assert_eq!(t.drawn(0), 0, "four Humans isn't six");
    });
}

#[test]
fn eowyn_draws_with_six_humans() {
    big_stack(|| {
        // Éowyn, two Vanguards already there, one cast this turn and the two Knights: six.
        let mut t = Board::new(2)
            .field(0, "Éowyn, Shieldmaiden")
            .field(0, "Elite Vanguard")
            .field(0, "Elite Vanguard")
            .hand(0, "Elite Vanguard")
            .basics(0, 1)
            .build();
        let vanguard = t.ids[3];
        t.cast(vanguard);
        t.drive().unwrap();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert_eq!(t.tokens(0).len(), 2);
        assert_eq!(t.drawn(0), 1, "six Humans draw a card");
    });
}

/// Ruling: if another Human didn't enter before the beginning of combat, the ability doesn't
/// trigger at all.
#[test]
fn eowyn_does_nothing_without_a_new_human() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Éowyn, Shieldmaiden").field(0, "Elite Vanguard").basics(0, 1).build();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert!(t.tokens(0).is_empty());
    });
}

// ── Quintorius, History Chaser (Lorehold Spirit) ─────────────────────────────────────────────

/// "Whenever one or more cards leave your graveyard, create a 3/2 red and white Spirit creature
/// token." Ghost Vacuum exiles one.
#[test]
fn quintorius_makes_a_spirit_when_a_card_leaves_your_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Quintorius, History Chaser").field(0, "Ghost Vacuum").grave(0, "Lightning Bolt").build();
        let (vacuum, bolt) = (t.id("Ghost Vacuum"), t.id("Lightning Bolt"));
        t.activate(vacuum, Some(0));
        t.drive_aiming(&[bolt]);
        assert_eq!(t.zone(bolt), Zone::Exile);
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1, "one Spirit");
        assert_eq!(t.pt(tokens[0]), (3, 2));
        assert!(t.subtypes(tokens[0]).contains(&"Spirit".to_string()));
    });
}

/// Ruling: if several cards leave your graveyard at the same time, it triggers only once.
/// Ultimate Nullification exiles all graveyards at once.
#[test]
fn quintorius_triggers_once_for_cards_leaving_together() {
    big_stack(|| {
        let mut t = Board::new(2)
            .field(0, "Quintorius, History Chaser")
            .field(0, "Isamaru, Hound of Konda")
            .hand(0, "Ultimate Nullification")
            .grave(0, "Lightning Bolt")
            .grave(0, "Opt")
            .grave(0, "Divination")
            .basics(0, 2)
            .build();
        let spell = t.id("Ultimate Nullification");
        t.cast(spell);
        t.drive().unwrap();
        assert!(t.graveyard(0).is_empty(), "the graveyard is gone: {:?}", t.graveyard(0));
        assert_eq!(t.tokens(0).len(), 1, "one Spirit for the cards that left together");
    });
}

/// "[+1]: You may discard a card. If you do, draw two cards, then mill a card."
#[test]
fn quintorius_plus_one_loots_and_mills() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Quintorius, History Chaser").hand(0, "Opt").build();
        let (q, opt) = (t.id("Quintorius, History Chaser"), t.id("Opt"));
        let library = t.library_len(0);
        t.activate_labelled(q, |l| l.starts_with('+'));
        t.drive_answering(|t, seat, d| {
            let p = d.pending.as_ref()?;
            match p.answer {
                Answer::DecideOptionalEffect if seat == 0 => Some(Act::DecideOptionalEffect { accept: true }),
                Answer::SelectCards if seat == 0 && t.zone(opt) == Zone::Hand => Some(Act::SelectCards { cards: vec![opt.0] }),
                _ => None,
            }
        })
        .unwrap();
        assert_eq!(t.zone(opt), Zone::Graveyard, "Opt was discarded");
        assert_eq!(t.drawn(0), 2);
        assert_eq!(t.library_len(0), library - 3, "drew two and milled one");
        assert_eq!(t.state().objects[&q].loyalty, Some(6));
    });
}

/// "[−4]: Spirits you control gain double strike and vigilance until end of turn."
#[test]
fn quintorius_minus_four_arms_the_spirits() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Quintorius, History Chaser").field(0, "Ghost Vacuum").grave(0, "Lightning Bolt").build();
        let (q, vacuum) = (t.id("Quintorius, History Chaser"), t.id("Ghost Vacuum"));
        t.activate(vacuum, Some(0));
        t.drive().unwrap();
        let spirit = t.tokens(0)[0];
        t.activate_labelled(q, |l| l.starts_with('−'));
        t.drive().unwrap();
        assert!(t.has(spirit, Keyword::DoubleStrike) && t.has(spirit, Keyword::Vigilance));
        assert_eq!(t.state().objects[&q].loyalty, Some(1));
    });
}

// ── Rootha, Mastering the Moment (Prismari Artistry) ─────────────────────────────────────────

/// "At the beginning of combat on your turn, if you've cast an instant or sorcery spell this
/// turn, create an X/X blue and red Elemental creature token with flying and haste, where X is
/// the greatest mana value among instant and sorcery spells you've cast this turn."
#[test]
fn rootha_makes_an_elemental_as_big_as_the_biggest_spell() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Rootha, Mastering the Moment").hand(0, "Lightning Bolt").hand(0, "Divination").basics(0, 2).build();
        let (bolt, div) = (t.id("Lightning Bolt"), t.id("Divination"));
        t.cast(bolt);
        t.drive().unwrap();
        t.cast(div);
        t.drive().unwrap();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1);
        let e = tokens[0];
        assert_eq!(t.pt(e), (3, 3), "Divination's mana value");
        assert!(t.has(e, Keyword::Flying) && t.has(e, Keyword::Haste));
        assert!(t.subtypes(e).contains(&"Elemental".to_string()));
    });
}

#[test]
fn rootha_does_nothing_without_an_instant_or_sorcery() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Rootha, Mastering the Moment").build();
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert!(t.tokens(0).is_empty());
    });
}

// ── Terra, Herald of Hope (Revival Trance) ──────────────────────────────────────────────────

/// "Trance — At the beginning of combat on your turn, mill two cards. Terra gains flying until
/// end of turn."
#[test]
fn terra_mills_two_and_flies_at_combat() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Terra, Herald of Hope").build();
        let terra = t.id("Terra, Herald of Hope");
        let library = t.library_len(0);
        assert!(!t.has(terra, Keyword::Flying));
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        assert_eq!(t.library_len(0), library - 2);
        assert_eq!(t.graveyard(0).len(), 2);
        assert!(t.has(terra, Keyword::Flying));
    });
}

/// "Whenever Terra deals combat damage to a player, you may pay {2}. When you do, return target
/// creature card with power 3 or less from your graveyard to the battlefield tapped."
#[test]
fn terra_returns_a_small_creature_after_combat_damage() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Terra, Herald of Hope").grave(0, "Grizzly Bears").grave(0, "Craw Wurm").basics(0, 1).build();
        let (terra, bears, wurm) = (t.id("Terra, Herald of Hope"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        t.attack(&[(terra, 1)]);
        let mut offered = vec![];
        t.advance_answering(Phase::PostCombatMain, |_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat == 0 && p.answer == Answer::ChooseTarget && p.options.iter().any(|o| o.id == bears.0.to_string()) {
                offered = p.options.iter().map(|o| o.id.clone()).collect();
                return Some(Act::ChooseTarget { target: Some(TargetView::Object { id: bears.0 }) });
            }
            None
        });
        assert_eq!(t.life(1), 37, "Terra hit for 3");
        assert!(t.on_field(bears), "the Bears came back");
        assert!(t.tapped(bears), "tapped");
        assert!(!offered.is_empty(), "the reflexive trigger asked for a target");
        assert!(!offered.contains(&wurm.0.to_string()), "Craw Wurm has power 6: not a legal target");
    });
}

// ── Hearthhull, the Worldseed (World Shaper) ────────────────────────────────────────────────

/// "Station (Tap another creature you control: Put charge counters equal to its power on this
/// Spacecraft. Station only as a sorcery.)"
#[test]
fn hearthhull_stations_with_a_creatures_power() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Hearthhull, the Worldseed").field(0, "Grizzly Bears").build();
        let (h, bears) = (t.id("Hearthhull, the Worldseed"), t.id("Grizzly Bears"));
        t.choose(0, |o| o.label.contains("Station"));
        t.drive().unwrap();
        assert!(t.tapped(bears), "the Bears were tapped for it");
        assert_eq!(t.counters(h, CounterType::Generic("charge".into())), 2);
    });
}

/// "2+ | {1}, {T}, Sacrifice a land: Draw two cards. You may play an additional land this
/// turn." The land sacrificed doesn't drain anyone yet: "Whenever you sacrifice a land, each
/// opponent loses 2 life" is part of the 8+ tier.
#[test]
fn hearthhull_sacrifices_a_land_to_draw_two_and_play_another() {
    big_stack(|| {
        let mut t = Board::new(3).field(0, "Hearthhull, the Worldseed").lands(0, "Forest", 3).hand(0, "Forest").build();
        let h = t.id("Hearthhull, the Worldseed");
        t.m.state.objects.get_mut(&h).unwrap().counters.insert(CounterType::Generic("charge".into()), 2);
        // A land was played this turn already: only the extra land drop lets the next one in.
        t.m.state.lands_played_this_turn = 1;
        t.m.state.players[0].lands_played_this_turn = 1;
        assert!(!t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land));
        t.activate_labelled(h, |l| l.contains("Draw two"));
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
        let forests = t.state().battlefield.iter().filter(|id| t.state().objects[*id].name == "Forest").count();
        assert_eq!(forests, 2, "a Forest was sacrificed");
        assert_eq!((t.life(1), t.life(2)), (40, 40), "no drain below 8 counters");
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land), "another land may be played this turn");
    });
}

/// "8+ | ... Whenever you sacrifice a land, each opponent loses 2 life."
#[test]
fn hearthhull_drains_each_opponent_for_a_land_at_eight() {
    big_stack(|| {
        let mut t = Board::new(3).field(0, "Hearthhull, the Worldseed").lands(0, "Forest", 3).build();
        let h = t.id("Hearthhull, the Worldseed");
        t.m.state.objects.get_mut(&h).unwrap().counters.insert(CounterType::Generic("charge".into()), 8);
        t.activate_labelled(h, |l| l.contains("Draw two"));
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2);
        assert_eq!((t.life(1), t.life(2)), (38, 38), "each opponent lost 2");
    });
}

/// "8+ | Flying, vigilance, haste" and "It's an artifact creature at 8+."
#[test]
fn hearthhull_is_a_creature_at_eight() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Hearthhull, the Worldseed").field(0, "Craw Wurm").field(0, "Grizzly Bears").build();
        let h = t.id("Hearthhull, the Worldseed");
        assert!(!t.is_creature(h), "not a creature below 8");
        for _ in 0..2 {
            t.choose(0, |o| o.label.contains("Station"));
            t.drive().unwrap();
        }
        assert_eq!(t.counters(h, CounterType::Generic("charge".into())), 8);
        assert!(t.is_creature(h), "a creature at 8");
        assert_eq!(t.pt(h), (6, 7));
        assert!(t.has(h, Keyword::Flying) && t.has(h, Keyword::Vigilance) && t.has(h, Keyword::Haste));
    });
}

// ── Omo, Queen of Vesuva (Tricky Terrain) ───────────────────────────────────────────────────

/// "Whenever Omo enters or attacks, put an everything counter on each of up to one target land
/// and up to one target creature. Each land with an everything counter on it is every land type
/// in addition to its other types. Each nonland creature with an everything counter on it is
/// every creature type."
#[test]
fn omo_makes_a_land_every_land_type_and_a_creature_every_creature_type() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Omo, Queen of Vesuva").field(0, "Wastes").field(0, "Grizzly Bears").basics(0, 1).build();
        let (omo, wastes, bears) = (t.id("Omo, Queen of Vesuva"), t.id("Wastes"), t.id("Grizzly Bears"));
        t.cast(omo);
        t.drive_aiming(&[wastes, bears]);
        let everything = CounterType::Generic("everything".into());
        assert_eq!(t.counters(wastes, everything.clone()), 1);
        assert_eq!(t.counters(bears, everything), 1);
        let land_types = t.subtypes(wastes);
        for kind in ["Plains", "Island", "Swamp", "Mountain", "Forest", "Desert", "Gate", "Cave"] {
            assert!(land_types.contains(&kind.to_string()), "Wastes is a {kind}: {land_types:?}");
        }
        // CR 305.6: a land with a basic land type has that type's mana ability.
        t.refresh(0);
        let ways = t.mana_actions(wastes).len();
        assert!(ways >= 5, "Wastes taps for every colour now ({ways} ways)");
        let creature_types = t.subtypes(bears);
        for kind in ["Bear", "Elf", "Human", "Spirit", "Zombie"] {
            assert!(creature_types.contains(&kind.to_string()), "the Bears are a {kind}: {creature_types:?}");
        }
    });
}

// ── Jace, Multiverse Architect (Multiverse Reforged) ────────────────────────────────────────

/// "[+1]: Draw two cards, then put a card from your hand on the bottom of your library."
#[test]
fn jace_plus_one_draws_two_and_bottoms_one() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Jace, Multiverse Architect").hand(0, "Opt").build();
        let (jace, opt) = (t.id("Jace, Multiverse Architect"), t.id("Opt"));
        t.activate_labelled(jace, |l| l.starts_with('+'));
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::SelectCards).then(|| Act::SelectCards { cards: vec![opt.0] })
        })
        .unwrap();
        assert_eq!(t.drawn(0), 2);
        assert_eq!(t.hand(0).len(), 2, "one of three went to the bottom");
        assert_eq!(t.state().players[0].library.last(), Some(&opt), "Opt is on the bottom");
        assert_eq!(t.state().objects[&jace].loyalty, Some(5));
    });
}

/// "[−3]: Exile another target planeswalker or creature you control. Reveal cards from the top
/// of your library until you reveal a creature or planeswalker card. Put that card onto the
/// battlefield and the rest on the bottom of your library in a random order."
#[test]
fn jace_minus_three_trades_a_creature_for_the_next_one_in_the_library() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Jace, Multiverse Architect").field(0, "Grizzly Bears").top(0, "Opt").top(0, "Hill Giant").build();
        let (jace, bears, opt, giant) = (t.id("Jace, Multiverse Architect"), t.id("Grizzly Bears"), t.id("Opt"), t.id("Hill Giant"));
        t.activate_labelled(jace, |l| l.starts_with('−'));
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Exile);
        assert!(t.on_field(giant), "Hill Giant, the first creature revealed, came in");
        assert_eq!(t.state().players[0].library.last(), Some(&opt), "Opt went to the bottom");
        assert_eq!(t.state().objects[&jace].loyalty, Some(1));
    });
}

/// "At the beginning of combat on each opponent's turn, they may pay {2}. If they don't,
/// creatures they control can't attack Jaces you control this turn."
#[test]
#[ignore = "phase bug: Jace, Multiverse Architect's \"can't attack Jaces you control\" is unimplemented, so an opponent who doesn't pay can still attack him"]
fn jace_keeps_attackers_off_unless_they_pay() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Jace, Multiverse Architect").field(1, "Grizzly Bears").lands(1, "Island", 2).active(1).build();
        let (jace, bears) = (t.id("Jace, Multiverse Architect"), t.id("Grizzly Bears"));
        t.tester = 1;
        t.advance_to(Phase::BeginCombat);
        // Ben doesn't pay.
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            match p.answer {
                Answer::PayUnlessCost if seat == 1 => Some(Act::PayUnlessCost { pay: false }),
                Answer::DecideOptionalEffect if seat == 1 => Some(Act::DecideOptionalEffect { accept: false }),
                _ => None,
            }
        })
        .unwrap();
        t.advance_to(Phase::DeclareAttackers);
        let attack = t.decision(1).attack.expect("Ben declares attackers");
        let targets = &attack.attackers.iter().find(|a| a.id == bears.0).expect("the Bears may attack").targets;
        assert!(!targets.contains(&AttackAt::Planeswalker { id: jace.0 }), "the Bears can't attack Jace: {targets:?}");
    });
}

/// The other side of the choice: an opponent who pays {2} attacks Jace as usual.
#[test]
fn jace_can_be_attacked_by_an_opponent_who_pays() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Jace, Multiverse Architect").field(1, "Grizzly Bears").lands(1, "Island", 2).active(1).build();
        let (jace, bears) = (t.id("Jace, Multiverse Architect"), t.id("Grizzly Bears"));
        t.tester = 1;
        t.advance_to(Phase::BeginCombat);
        t.drive().unwrap();
        t.advance_to(Phase::DeclareAttackers);
        let attack = t.decision(1).attack.expect("Ben declares attackers");
        let targets = &attack.attackers.iter().find(|a| a.id == bears.0).expect("the Bears may attack").targets;
        assert!(targets.contains(&AttackAt::Planeswalker { id: jace.0 }), "{targets:?}");
    });
}
