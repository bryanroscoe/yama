//! The cards in Bryan's decks that phase only partly implements (docs/card-coverage.md lists
//! each with the part phase marks unimplemented). Each test plays the card and checks what its
//! Oracle text and rulings say should happen, the unimplemented part included. Where phase
//! falls short the test stays, ignored, with the reason. Jace, Multiverse Architect's test is
//! with the commanders.

use engine::types::counter::CounterType;
use engine::types::identifiers::ObjectId;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::zones::Zone;

use super::{Board, Table, big_stack};
use crate::act::Answer;
use crate::{Act, AttackAt, Decision, OptionKind, TargetView};

/// Answers for seat 0 by what each decision is: `rules` gives the answer, or `None` for the
/// drive's own.
fn by_answer(rules: impl Fn(&Table, &crate::Pending) -> Option<Act>) -> impl FnMut(&Table, u8, &Decision) -> Option<Act> {
    move |t, seat, d| {
        let p = d.pending.as_ref()?;
        if seat != t.tester {
            return None;
        }
        rules(t, p)
    }
}

fn offers(p: &crate::Pending, id: ObjectId) -> bool {
    p.options.iter().any(|o| o.id == id.0.to_string())
}

fn ids_of(p: &crate::Pending, n: usize) -> Vec<u64> {
    p.options.iter().filter(|o| o.eligible).take(n).filter_map(|o| o.id.parse().ok()).collect()
}

// ── Prismari Artistry ───────────────────────────────────────────────────────────────────────

/// "Exile the top four cards of your library in a face-down pile, then exile the top four
/// cards of your library in a face-up pile. An opponent chooses one of those piles. Put that
/// pile into your graveyard. Look at the cards in the other pile. You may cast a spell from
/// among them without paying its mana cost. Put the rest into your hand."
#[test]
#[ignore = "phase bug: Abstract Performance has an opponent pick one card, not a pile; it goes to the graveyard and the other seven stay in exile, none to your hand"]
fn abstract_performance_splits_eight_cards_into_piles() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Abstract Performance").lands(0, "Island", 6).build();
        let spell = t.id("Abstract Performance");
        let library = t.library_len(0);
        t.cast(spell);
        t.drive().unwrap();
        assert_eq!(t.library_len(0), library - 8);
        let grave = t.graveyard(0).iter().filter(|n| *n != "Abstract Performance").count();
        assert_eq!(grave, 4, "one pile in the graveyard");
        let other = t.hand(0).len() + t.state().battlefield.iter().filter(|id| t.state().objects[*id].controller.0 == 0 && !t.state().objects[*id].name.contains("Island")).count();
        assert!(other >= 3, "the other pile went to the hand (or was cast): {other}");
    });
}

/// "Shuffle your library, then reveal cards from the top of it until you reveal a nonland card.
/// Exile that card ... You may cast the exiled card without paying its mana cost." (Without the
/// demonstrate copy.) The library is all Grizzly Bears and basic lands; whichever Bears is
/// revealed is cast.
#[test]
#[ignore = "phase bug: Creative Technique's \"reveal until a nonland card\" is unimplemented; it exiles and recasts Creative Technique itself, again and again"]
fn creative_technique_casts_the_first_nonland_card_free() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Creative Technique").lands(0, "Mountain", 5).build();
        let spell = t.id("Creative Technique");
        let bears_before = t.state().battlefield.iter().filter(|id| t.state().objects[*id].name == "Grizzly Bears").count();
        t.cast(spell);
        // No demonstrate copy.
        t.drive_answering(by_answer(|_, p| {
            (p.answer == Answer::DecideOptionalEffect && p.prompt.contains("Demonstrate")).then_some(Act::DecideOptionalEffect { accept: false })
        }))
        .unwrap();
        let bears_after = t.state().battlefield.iter().filter(|id| t.state().objects[*id].name == "Grizzly Bears").count();
        assert_eq!(bears_after, bears_before + 1, "the revealed Bears was cast");
        assert_eq!(t.zone(spell), Zone::Graveyard, "Creative Technique itself is done");
    });
}

/// "Shuffle your library. As many times as you choose, you may exile the top card of your
/// library. If the total mana value of the cards exiled this way is 13 or less, you may cast
/// any number of spells from among those cards without paying their mana costs." Saying yes three
/// times exiles three cards; the library is lands and Grizzly Bears, so a Bears is among them
/// or the total is 0, and either way the creature spells among them may be cast free.
#[test]
#[ignore = "phase bug: Dance with Calamity exiles one card at most (\"as many times as you choose\" is unimplemented) and offers no free cast"]
fn dance_with_calamity_exiles_as_many_as_you_like() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Dance with Calamity").lands(0, "Mountain", 8).build();
        let spell = t.id("Dance with Calamity");
        let library = t.library_len(0);
        t.cast(spell);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::DecideOptionalEffect).then_some(Act::DecideOptionalEffect { accept: true }))).unwrap();
        assert!(t.library_len(0) <= library - 3, "three or more exiled: {} left of {library}", t.library_len(0));
    });
}

// ── Lorehold Spirit ─────────────────────────────────────────────────────────────────────────

/// "When Ao dies, choose one — ... Put two +1/+1 counters on each permanent you control that's
/// a creature or Vehicle."
#[test]
#[ignore = "phase bug: Ao, the Dawn Sky's death modes are unimplemented (put_counter_tail and the look-at-seven mode)"]
fn ao_puts_two_counters_on_each_creature_when_it_dies() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Ao, the Dawn Sky").field(0, "Grizzly Bears").hand(0, "Lightning Bolt").hand(0, "Lightning Bolt").lands(0, "Mountain", 2).build();
        let (ao, bears) = (t.id("Ao, the Dawn Sky"), t.id("Grizzly Bears"));
        let bolts = [t.ids[2], t.ids[3]];
        for b in bolts {
            t.cast(b);
            t.drive_answering(by_answer(|_, p| match p.answer {
                Answer::ChooseTarget if offers(p, ao) => Some(Act::ChooseTarget { target: Some(TargetView::Object { id: ao.0 }) }),
                Answer::SelectModes => Some(Act::SelectModes { indices: vec![1] }),
                _ => None,
            }))
            .unwrap();
        }
        assert_eq!(t.zone(ao), Zone::Graveyard, "Ao died");
        assert_eq!(t.counters(bears, CounterType::Plus1Plus1), 2);
    });
}

/// "Whenever Augusta attacks, each player exiles a card from their graveyard. When one or more
/// nonland cards are exiled this way, put that many +1/+1 counters on target attacking
/// creature."
#[test]
#[ignore = "phase bug: Augusta's reflexive \"when one or more nonland cards are exiled this way\" is unimplemented; no counters"]
fn augusta_grows_an_attacker_for_each_nonland_card_exiled() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Augusta, Order Returned").grave(0, "Grizzly Bears").grave(1, "Lightning Bolt").build();
        let augusta = t.id("Augusta, Order Returned");
        t.attack(&[(augusta, 1)]);
        t.drive_aiming(&[augusta]);
        assert!(t.graveyard(0).is_empty() && t.graveyard(1).is_empty(), "each player exiled a card");
        assert_eq!(t.counters(augusta, CounterType::Plus1Plus1), 2, "two nonland cards");
    });
}

/// "Once during each of your turns, you may play a land from your graveyard or cast a permanent
/// spell with mana value 3 or less from your graveyard."
#[test]
#[ignore = "phase bug: Serra Paragon's graveyard permission is unimplemented; nothing in the graveyard is offered"]
fn serra_paragon_plays_a_land_from_the_graveyard() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Serra Paragon").grave(0, "Forest").grave(0, "Spellbook").lands(0, "Plains", 2).build();
        let (forest, book) = (t.id("Forest"), t.id("Spellbook"));
        let d = t.decision(0);
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(forest.0)), "the Forest can be played");
        assert!(d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(book.0)), "Spellbook can be cast");
    });
}

/// "Council's dilemma — Starting with you, each player votes for past or present. You mill a
/// card for each past vote, then Fateful Tempest deals damage to each opponent equal to the
/// total mana value of cards milled this way."
#[test]
#[ignore = "phase bug: Fateful Tempest's council's dilemma is unimplemented; no votes, mills or damage"]
fn fateful_tempest_mills_for_past_votes_and_burns() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Fateful Tempest").lands(0, "Mountain", 3).top(0, "Craw Wurm").top(0, "Hill Giant").build();
        let spell = t.id("Fateful Tempest");
        t.cast(spell);
        t.drive_answering(|_, _, d| {
            let p = d.pending.as_ref()?;
            let past = p.options.iter().find(|o| o.name.to_lowercase().contains("past"))?;
            Some(Act::ChooseOption { choice: past.id.clone() })
        })
        .unwrap();
        assert!(t.graveyard(0).contains(&"Hill Giant".to_string()) && t.graveyard(0).contains(&"Craw Wurm".to_string()), "two past votes milled two");
        assert_eq!(t.life(1), 30, "4 + 6 mana value");
    });
}

/// "Whenever this creature deals combat damage to a player, you may return target creature
/// card with mana value X or less from your graveyard to the battlefield, where X is the amount
/// of damage this creature dealt to that player."
#[test]
#[ignore = "phase bug: Venerable Warsinger's X (\"the amount of damage dealt to that player\") is unbound, so no creature card is a legal target"]
fn venerable_warsinger_returns_a_creature_up_to_its_damage() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Venerable Warsinger").grave(0, "Grizzly Bears").grave(0, "Craw Wurm").build();
        let (singer, bears, wurm) = (t.id("Venerable Warsinger"), t.id("Grizzly Bears"), t.id("Craw Wurm"));
        t.attack(&[(singer, 1)]);
        let mut offered = vec![];
        t.advance_answering(Phase::PostCombatMain, |_, seat, d| {
            let p = d.pending.as_ref()?;
            if seat == 0 && p.answer == Answer::ChooseTarget {
                offered = p.options.iter().map(|o| o.id.clone()).collect();
                return offers(p, bears).then(|| Act::ChooseTarget { target: Some(TargetView::Object { id: bears.0 }) });
            }
            (seat == 0 && p.answer == Answer::DecideOptionalEffect).then_some(Act::DecideOptionalEffect { accept: true })
        });
        assert_eq!(t.life(1), 37);
        assert!(t.on_field(bears), "mana value 2, damage 3: returned");
        assert!(!offered.contains(&wurm.0.to_string()), "mana value 6 isn't");
    });
}

/// "{T}: Add {C}. {1}, {T}: Add one mana of any color. When you spend this mana to cast your
/// commander, scry X, where X is the number of times it's been cast from the command zone this
/// game." The mana works; the scry is unimplemented.
#[test]
fn study_hall_makes_any_colour_for_one() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Study Hall").lands(0, "Wastes", 1).build();
        let hall = t.id("Study Hall");
        let actions = t.mana_actions(hall);
        assert!(!actions.is_empty());
        let mut best = 0;
        for a in actions {
            let snap = t.m.state.clone();
            if let Ok(n) = t.tap_for_mana(a) {
                best = best.max(n);
            }
            t.m.state = snap;
        }
        assert_eq!(best, 1);
    });
}

/// A spell whose colour only Study Hall's "{1}, {T}: Add one mana of any color" can make.
#[test]
fn study_hall_pays_for_a_colour_you_have_no_land_for() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Study Hall").lands(0, "Wastes", 1).hand(0, "Savannah Lions").build();
        let lions = t.id("Savannah Lions");
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(lions.0)), "Savannah Lions ({{W}}) can be cast");
        t.cast(lions);
        t.drive().unwrap();
        assert!(t.on_field(lions));
    });
}

/// The same with generic mana to pay as well: Augusta ({2}{W}) with a Mountain, three Wastes and
/// Study Hall ({W} from Study Hall, paid with a Wastes; the Mountain and a Wastes for {2}).
#[test]
fn study_hall_pays_for_a_colour_with_generic_mana_too() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Study Hall").lands(0, "Mountain", 1).lands(0, "Wastes", 3).hand(0, "Augusta, Order Returned").build();
        let augusta = t.id("Augusta, Order Returned");
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(augusta.0)));
        t.cast(augusta);
        t.drive().unwrap();
        assert!(t.on_field(augusta));
    });
}

#[test]
fn study_hall_scries_when_its_mana_casts_the_commander() {
    big_stack(|| {
        // Quintorius ({2}{R}{W}) after one cast: {R} from the Mountain, {W} only from Study Hall
        // (paid with a Wastes), Wastes for the rest.
        let mut t = Board::new(2).commander(0, "Quintorius, History Chaser").field(0, "Study Hall").lands(0, "Mountain", 1).lands(0, "Wastes", 6).build();
        let q = *t.state().command_zone.iter().find(|id| t.state().objects[*id].owner.0 == 0).unwrap();
        t.m.state.commander_cast_count.insert(q, 1);
        t.cast(q);
        let mut scried = false;
        t.drive_answering(|_, seat, d| {
            if seat == 0 && d.pending.as_ref().is_some_and(|p| p.purpose == "scry") {
                scried = true;
            }
            None
        })
        .unwrap();
        assert!(t.on_field(q), "Quintorius was cast");
        assert!(t.tapped(t.id("Study Hall")), "with Study Hall's mana");
        assert!(scried, "a scry for the earlier cast");
    });
}

/// "As this enchantment enters, choose a planeswalker type. Planeswalkers you control of the
/// chosen type have hexproof."
#[test]
fn deification_gives_the_chosen_planeswalkers_hexproof() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Deification").lands(0, "Plains", 2).field(0, "Jace, Multiverse Architect").build();
        let (deification, jace) = (t.id("Deification"), t.id("Jace, Multiverse Architect"));
        t.cast(deification);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::ChooseOption).then(|| Act::ChooseOption { choice: "Jace".into() }))).unwrap();
        assert!(t.has(jace, Keyword::Hexproof));
    });
}

// ── Riders of Rohan ─────────────────────────────────────────────────────────────────────────

/// "Gain control of all creatures target opponent controls until end of turn. Untap those
/// creatures. They gain haste until end of turn. You can't attack that player this turn."
#[test]
#[ignore = "phase bug: Call for Aid's \"they gain haste\" goes to the targeted player, not the creatures, so they can't attack"]
fn call_for_aid_borrows_an_opponents_creatures_with_haste() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Call for Aid").lands(0, "Mountain", 5).field(1, "Hill Giant").build();
        let (spell, giant) = (t.id("Call for Aid"), t.id("Hill Giant"));
        t.m.state.objects.get_mut(&giant).unwrap().tapped = true;
        t.cast(spell);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::ChooseTarget).then_some(Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }))).unwrap();
        assert_eq!(t.controller(giant), 0);
        assert!(!t.tapped(giant), "untapped");
        assert!(t.has(giant, Keyword::Haste));
    });
}

#[test]
#[ignore = "phase bug: Call for Aid's \"you can't attack that player this turn\" is unimplemented (and the creatures get no haste)"]
fn call_for_aid_cant_attack_the_player_it_borrowed_from() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Call for Aid").lands(0, "Mountain", 5).field(1, "Hill Giant").build();
        let (spell, giant) = (t.id("Call for Aid"), t.id("Hill Giant"));
        t.cast(spell);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::ChooseTarget).then_some(Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }))).unwrap();
        t.advance_to(Phase::DeclareAttackers);
        let attack = t.decision(0).attack.expect("Ana declares attackers");
        let targets = &attack.attackers.iter().find(|a| a.id == giant.0).expect("the Giant may attack").targets;
        assert!(!targets.contains(&AttackAt::Player { seat: 1 }), "not Ben: {targets:?}");
        assert!(targets.contains(&AttackAt::Player { seat: 2 }));
    });
}

/// "At the beginning of combat on each opponent's turn, if you're the monarch, that opponent may
/// pay {X}, where X is the number of cards in their hand. If they don't, they can't attack you
/// this combat."
#[test]
#[ignore = "phase bug: Champions of Minas Tirith's \"they can't attack you this combat\" is unimplemented"]
fn champions_of_minas_tirith_keep_attackers_off_the_monarch() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Champions of Minas Tirith").lands(0, "Plains", 6).field(1, "Grizzly Bears").hand(1, "Opt").build();
        let (champions, bears) = (t.id("Champions of Minas Tirith"), t.id("Grizzly Bears"));
        t.cast(champions);
        t.drive().unwrap();
        assert!(t.state().monarch == Some(engine::types::player::PlayerId(0)), "Ana is the monarch");
        // On to Ben's turn: he has one card in hand and doesn't pay.
        t.advance_to(Phase::End);
        t.tester = 0;
        t.m.state.objects.get_mut(&bears).unwrap().summoning_sick = false;
        t.advance_to(Phase::BeginCombat);
        assert_eq!(t.state().active_player.0, 1, "Ben's turn");
        t.advance_to(Phase::DeclareAttackers);
        let attack = t.decision(1).attack.expect("Ben declares attackers");
        let targets = &attack.attackers.iter().find(|a| a.id == bears.0).expect("the Bears may attack").targets;
        assert!(!targets.contains(&AttackAt::Player { seat: 0 }), "not the monarch: {targets:?}");
    });
}

/// "As long as this creature is in your graveyard, each Human creature you control enters with
/// an additional +1/+1 counter on it."
#[test]
#[ignore = "phase bug: Dearly Departed's graveyard ability (\"as long as ~ is in your graveyard\") is unimplemented"]
fn dearly_departed_gives_humans_a_counter_from_the_graveyard() {
    big_stack(|| {
        let mut t = Board::new(2).grave(0, "Dearly Departed").hand(0, "Elite Vanguard").lands(0, "Plains", 1).build();
        let vanguard = t.id("Elite Vanguard");
        t.cast(vanguard);
        t.drive().unwrap();
        assert_eq!(t.counters(vanguard, CounterType::Plus1Plus1), 1);
    });
}

/// "When this Aura enters, you become the monarch. The monarch controls enchanted creature."
#[test]
#[ignore = "phase bug: Fealty to the Realm's \"the monarch controls enchanted creature\" is unimplemented"]
fn fealty_to_the_realm_gives_the_creature_to_the_monarch() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Fealty to the Realm").lands(0, "Island", 5).field(1, "Hill Giant").build();
        let (aura, giant) = (t.id("Fealty to the Realm"), t.id("Hill Giant"));
        t.cast(aura);
        t.drive_aiming(&[giant]);
        assert_eq!(t.state().monarch, Some(engine::types::player::PlayerId(0)));
        assert_eq!(t.controller(giant), 0, "the monarch controls it");
    });
}

// ── Revival Trance ──────────────────────────────────────────────────────────────────────────

/// "Once during each of your turns, you may cast an artifact spell from your graveyard. If you
/// cast a spell this way, that artifact enters tapped."
#[test]
#[ignore = "phase bug: Edgar, Master Machinist's graveyard casting is unimplemented"]
fn edgar_casts_an_artifact_from_the_graveyard() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Edgar, Master Machinist").grave(0, "Spellbook").lands(0, "Plains", 1).build();
        let book = t.id("Spellbook");
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(book.0)));
    });
}

/// "Mill three cards. Then starting with the next opponent in turn order, each opponent chooses
/// a creature card in your graveyard that hasn't been chosen. Return each card chosen this way
/// to the battlefield under your control." Ben picks the Hill Giant; Cy mustn't be offered it.
#[test]
#[ignore = "phase bug: Rejoin the Fight offers the second opponent the card the first already chose, so as few as one creature comes back"]
fn rejoin_the_fight_returns_a_different_creature_per_opponent() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Rejoin the Fight").lands(0, "Swamp", 6).grave(0, "Hill Giant").grave(0, "Craw Wurm").build();
        let (spell, giant, wurm) = (t.id("Rejoin the Fight"), t.id("Hill Giant"), t.id("Craw Wurm"));
        t.cast(spell);
        let mut cy_offered = vec![];
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if p.answer != Answer::SelectCards {
                return None;
            }
            match seat {
                1 => Some(Act::SelectCards { cards: vec![giant.0] }),
                2 => {
                    cy_offered = p.options.iter().map(|o| o.id.clone()).collect();
                    Some(Act::SelectCards { cards: vec![wurm.0] })
                }
                _ => None,
            }
        })
        .unwrap();
        assert!(!cy_offered.contains(&giant.0.to_string()), "the Giant was already chosen");
        assert!(t.on_field(giant) && t.on_field(wurm), "both came back");
    });
}

/// "II, III, IV — Add {R} for each lore counter on this Saga. You may cast an instant or sorcery
/// card exiled with this Saga, and mana of any type can be spent to cast that spell." Chapter
/// I exiled Divination from Ben's graveyard.
#[test]
#[ignore = "phase bug: Summon: Esper Valigarmanda can't cast the card it exiled (linked exile cast is unimplemented)"]
fn summon_esper_valigarmanda_casts_what_it_exiled() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Summon: Esper Valigarmanda").lands(0, "Mountain", 4).grave(1, "Divination").build();
        let (saga, div) = (t.id("Summon: Esper Valigarmanda"), t.id("Divination"));
        t.cast(saga);
        t.drive_aiming(&[div]);
        assert_eq!(t.zone(div), Zone::Exile, "chapter I exiled it");
        // Ben's turn, then Ana's: chapter II after her draw step.
        t.advance_to(Phase::PreCombatMain);
        t.advance_to(Phase::PreCombatMain);
        assert_eq!(t.state().active_player.0, 0);
        t.drive().unwrap();
        assert_eq!(t.counters(saga, CounterType::Lore), 2);
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(div.0)), "Divination may be cast");
    });
}

// ── World Shaper ────────────────────────────────────────────────────────────────────────────

/// "Whenever this creature attacks, you and defending player each discard a card or sacrifice a
/// permanent. You draw a card for each land card put into a graveyard this way."
#[test]
#[ignore = "phase bug: Eumidian Wastewaker's \"you and defending player each discard a card or sacrifice a permanent\" is unimplemented"]
fn eumidian_wastewaker_draws_for_each_land_discarded() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Eumidian Wastewaker").hand(0, "Forest").hand(1, "Swamp").build();
        let w = t.id("Eumidian Wastewaker");
        t.attack(&[(w, 1)]);
        t.drive().unwrap();
        assert!(t.hand(0).is_empty() && t.hand(1).is_empty(), "both discarded");
        assert_eq!(t.drawn(0), 2, "two lands");
    });
}

/// "When this creature enters, you may discard one or more land cards. When you do, return up
/// to that many target nonland permanent cards from your graveyard to your hand."
#[test]
#[ignore = "phase bug: Loamcrafter Faun's \"discard one or more land cards\" is unimplemented"]
fn loamcrafter_faun_trades_lands_for_permanents() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Loamcrafter Faun").hand(0, "Forest").hand(0, "Swamp").lands(0, "Forest", 3).grave(0, "Grizzly Bears").grave(0, "Spellbook").build();
        let faun = t.id("Loamcrafter Faun");
        t.cast(faun);
        t.drive_answering(by_answer(|_, p| match p.answer {
            Answer::SelectCards => Some(Act::SelectCards { cards: ids_of(p, 2) }),
            _ => None,
        }))
        .unwrap();
        let hand = t.hand(0);
        assert!(hand.contains(&"Grizzly Bears".to_string()) && hand.contains(&"Spellbook".to_string()), "{hand:?}");
    });
}

/// "Sacrifice a land: Add one mana of any type the sacrificed land could produce."
#[test]
#[ignore = "phase bug: Squandered Resources' mana ability is unimplemented"]
fn squandered_resources_turns_a_land_into_its_mana() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Squandered Resources").lands(0, "Forest", 1).build();
        let sr = t.id("Squandered Resources");
        let action = t.mana_actions(sr).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(1));
        assert_eq!(t.state().players[0].mana_pool.count_color(engine::types::mana::ManaType::Green), 1);
        assert_eq!(t.graveyard(0), vec!["Forest".to_string()]);
    });
}

/// "For any number of opponents, destroy target nonland permanent that player controls."
#[test]
fn windgraces_judgment_destroys_one_per_opponent() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Windgrace's Judgment").lands(0, "Swamp", 2).lands(0, "Forest", 3).field(1, "Hill Giant").field(2, "Spellbook").build();
        let (spell, giant, book) = (t.id("Windgrace's Judgment"), t.id("Hill Giant"), t.id("Spellbook"));
        t.cast(spell);
        t.drive_aiming(&[giant, book]);
        assert_eq!(t.zone(giant), Zone::Graveyard);
        assert_eq!(t.zone(book), Zone::Graveyard);
    });
}

// ── Tricky Terrain ──────────────────────────────────────────────────────────────────────────

/// "[0]: Look at the top card of your library. If it's a land card or a creature card with mana
/// value less than or equal to the number of loyalty counters on Nissa, you may put that card
/// onto the battlefield."
#[test]
#[ignore = "phase bug: Nissa, Steward of Elements' [0] puts nothing onto the battlefield, not even a land (\"or a creature card with mana value up to her loyalty\" is unimplemented)"]
fn nissa_puts_a_small_creature_from_the_top_onto_the_battlefield() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Nissa, Steward of Elements").top(0, "Grizzly Bears").build();
        let (nissa, bears) = (t.id("Nissa, Steward of Elements"), t.id("Grizzly Bears"));
        t.set_loyalty(nissa, 3);
        t.activate_labelled(nissa, |l| l.starts_with('0'));
        t.drive().unwrap();
        assert!(t.on_field(bears));
    });
}

#[test]
#[ignore = "phase bug: Nissa, Steward of Elements' [0] puts nothing onto the battlefield, not even a land"]
fn nissa_puts_a_land_from_the_top_onto_the_battlefield() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Nissa, Steward of Elements").top(0, "Forest").build();
        let (nissa, forest) = (t.id("Nissa, Steward of Elements"), t.id("Forest"));
        t.set_loyalty(nissa, 3);
        t.activate_labelled(nissa, |l| l.starts_with('0'));
        t.drive().unwrap();
        assert!(t.on_field(forest));
    });
}

/// "This land is every nonbasic land type."
#[test]
fn planar_nexus_is_every_nonbasic_land_type() {
    big_stack(|| {
        let t = Board::new(2).field(0, "Planar Nexus").build();
        let nexus = t.id("Planar Nexus");
        let types = t.subtypes(nexus);
        for kind in ["Cave", "Desert", "Gate", "Lair", "Locus", "Mine", "Power-Plant", "Sphere", "Tower", "Urza's"] {
            assert!(types.contains(&kind.to_string()), "{kind}: {types:?}");
        }
        assert!(!types.contains(&"Forest".to_string()), "no basic types");
    });
}

/// "{T}: Until end of turn, target land you control becomes an X/X Citizen creature with haste
/// in addition to its other types, where X is twice the number of Gates you control."
#[test]
#[ignore = "phase bug: Sage of the Maze's land-animating ability is unimplemented"]
fn sage_of_the_maze_animates_a_land() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Sage of the Maze").field(0, "Forest").build();
        let (sage, forest) = (t.id("Sage of the Maze"), t.id("Forest"));
        t.activate_labelled(sage, |l| l.contains("Citizen"));
        t.drive_aiming(&[forest]);
        assert!(t.is_creature(forest));
        assert!(t.has(forest, Keyword::Haste));
    });
}

/// "{1}{U}, {T}, Exile seven cards from your graveyard: Add {U}. When you spend this mana to cast
/// a spell or activate an ability, copy that spell or ability."
#[test]
#[ignore = "phase bug: Sunken Palace's \"when you spend this mana ..., copy that spell\" is unimplemented"]
fn sunken_palace_copies_the_spell_its_mana_casts() {
    big_stack(|| {
        let mut b = Board::new(2).field(0, "Sunken Palace").lands(0, "Island", 3).hand(0, "Opt");
        for _ in 0..7 {
            b = b.grave(0, "Grizzly Bears");
        }
        let mut t = b.build();
        let (palace, opt) = (t.id("Sunken Palace"), t.id("Opt"));
        let action = t.mana_actions(palace).into_iter().find(|a| format!("{a:?}").contains("ability_index: 1") || format!("{a:?}").contains("Some(1)")).expect("the exile ability");
        t.tap_for_mana(action).unwrap();
        t.act(0, Act::CastSpell { object: opt.0, payment: crate::pay::PayMode::Auto });
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 2, "Opt and its copy");
    });
}

/// "{T}, Return a land you control to its owner's hand: Draw a card. Then discard a card unless
/// that land had a nonbasic land type."
#[test]
#[ignore = "phase bug: Wonderscape Sage never discards (\"discard a card unless that land had a nonbasic land type\" is unimplemented)"]
fn wonderscape_sage_discards_after_returning_a_basic() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Wonderscape Sage").field(0, "Forest").build();
        let sage = t.id("Wonderscape Sage");
        t.activate(sage, None);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1);
        assert_eq!(t.hand(0).len(), 1, "drew one, discarded one, and the Forest came back: {:?}", t.hand(0));
    });
}

#[test]
fn wonderscape_sage_keeps_the_card_after_returning_a_nonbasic_type() {
    big_stack(|| {
        // Sunken Palace is a Cave.
        let mut t = Board::new(2).field(0, "Wonderscape Sage").field(0, "Sunken Palace").build();
        let sage = t.id("Wonderscape Sage");
        t.activate(sage, None);
        t.drive().unwrap();
        assert_eq!(t.drawn(0), 1);
        assert_eq!(t.hand(0).len(), 2, "the Palace and the card drawn: {:?}", t.hand(0));
    });
}

// ── Fantastic Four ──────────────────────────────────────────────────────────────────────────

/// "{2}, {T}: Exile target card from an opponent's graveyard. If it's a creature card, draw a
/// card."
#[test]
fn negative_zone_portal_exiles_and_draws_for_a_creature() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Negative Zone Portal").lands(0, "Wastes", 2).grave(1, "Grizzly Bears").build();
        let (portal, bears) = (t.id("Negative Zone Portal"), t.id("Grizzly Bears"));
        t.activate(portal, None);
        t.drive_aiming(&[bears]);
        assert_eq!(t.zone(bears), Zone::Exile);
        assert_eq!(t.drawn(0), 1);
    });
}

/// "At the beginning of your upkeep, if there are four or more creature cards exiled with this
/// artifact, flip a coin. If you lose the flip, sacrifice this artifact and return a card
/// exiled with it at random to its owner's hand."
#[test]
#[ignore = "phase bug: Negative Zone Portal's upkeep coin flip is unimplemented; with four creatures exiled nothing happens"]
fn negative_zone_portal_flips_a_coin_with_four_creatures_exiled() {
    big_stack(|| {
        let mut b = Board::new(2).field(0, "Negative Zone Portal").lands(0, "Wastes", 8);
        for _ in 0..4 {
            b = b.grave(1, "Grizzly Bears");
        }
        let mut t = b.build();
        let portal = t.id("Negative Zone Portal");
        for _ in 0..4 {
            t.refresh(0);
            t.activate(portal, None);
            t.drive().unwrap();
        }
        assert_eq!(t.graveyard(1).len(), 0, "four Bears exiled");
        assert_eq!(t.drawn(0), 4, "a card for each creature");
        // Ben's upkeep, then Ana's, with the Portal's trigger on the stack.
        t.advance_to(Phase::Upkeep);
        t.advance_to(Phase::Upkeep);
        assert_eq!(t.state().active_player.0, 0);
        // Neither the feed nor the log tells of coins: let it resolve through the engine and read
        // its events.
        let mut flipped = false;
        for _ in 0..10 {
            if t.state().stack.is_empty() {
                break;
            }
            let seat = t.state().waiting_for.acting_players()[0];
            let result = engine::game::engine::apply(&mut t.m.state, seat, engine::types::actions::GameAction::PassPriority).expect("a pass");
            flipped |= result.events.iter().any(|e| matches!(e, engine::types::events::GameEvent::CoinFlipped { .. }));
        }
        assert!(flipped, "a coin was flipped at Ana's upkeep");
    });
}

// ── Multiverse Reforged ─────────────────────────────────────────────────────────────────────

/// "When Dack Fayden enters, reveal cards from the top of your library until you reveal X
/// creature cards, where X is the number of opponents you have. Put those creature cards onto
/// the battlefield, then shuffle. They're goaded for the rest of the game. For each of those
/// permanents, choose a different opponent. Each opponent gains control of the permanent for
/// which they were chosen."
#[test]
#[ignore = "phase bug: Dack Fayden's \"they're goaded\" and \"each opponent gains control\" are unimplemented"]
fn dack_fayden_gives_each_opponent_a_goaded_creature() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Dack Fayden, Helping Hand").lands(0, "Plains", 6).top(0, "Hill Giant").top(0, "Craw Wurm").build();
        let (dack, giant, wurm) = (t.id("Dack Fayden, Helping Hand"), t.id("Hill Giant"), t.id("Craw Wurm"));
        t.cast(dack);
        t.drive().unwrap();
        assert!(t.on_field(giant) && t.on_field(wurm), "two creatures for two opponents");
        let mut owners = vec![t.controller(giant), t.controller(wurm)];
        owners.sort();
        assert_eq!(owners, vec![1, 2], "one each");
    });
}

/// "Creatures you control can't have -1/-1 counters put on them." Yawgmoth puts one on Ana's
/// Bears.
#[test]
fn darksteel_angel_stops_minus_counters_on_your_creatures() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Darksteel Angel").field(0, "Grizzly Bears").field(1, "Yawgmoth, Thran Physician").field(1, "Savannah Lions").active(1).build();
        let (bears, yawg) = (t.id("Grizzly Bears"), t.id("Yawgmoth, Thran Physician"));
        t.tester = 1;
        t.activate_labelled(yawg, |l| l.contains("-1/-1"));
        t.drive_aiming(&[bears]);
        assert_eq!(t.counters(bears, CounterType::Minus1Minus1), 0);
    });
}

/// "At the beginning of each upkeep, if you're the monarch, create a Gingerbrute token."
#[test]
#[ignore = "phase bug: Ginger, Queen of Sweets' \"create a Gingerbrute token\" is unimplemented"]
fn ginger_makes_a_gingerbrute_each_upkeep_for_the_monarch() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Ginger, Queen of Sweets").lands(0, "Wastes", 6).build();
        let ginger = t.id("Ginger, Queen of Sweets");
        t.cast(ginger);
        t.drive().unwrap();
        assert_eq!(t.state().monarch, Some(engine::types::player::PlayerId(0)));
        t.advance_to(Phase::Upkeep);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1, "a Gingerbrute at Ben's upkeep");
        assert_eq!(t.state().objects[&tokens[0]].name, "Gingerbrute");
    });
}

/// "Until end of turn, you may activate loyalty abilities of Jace planeswalkers you control on
/// any player's turn any time you could cast an instant. Empower Jace 8."
#[test]
#[ignore = "phase bug: Jace's Machinations makes no Jace token (empower Jace does nothing)"]
fn jaces_machinations_empowers_a_jace_token_with_eight() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Jace's Machinations").lands(0, "Island", 3).build();
        let spell = t.id("Jace's Machinations");
        t.cast(spell);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1, "a Jace token");
        assert_eq!(t.counters(tokens[0], CounterType::Loyalty), 8);
    });
}

#[test]
#[ignore = "phase bug: Jace's Machinations' \"activate loyalty abilities of Jace planeswalkers any time you could cast an instant\" is unimplemented"]
fn jaces_machinations_lets_jace_act_at_instant_speed() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Jace's Machinations").hand(0, "Opt").lands(0, "Island", 4).field(0, "Jace, Multiverse Architect").build();
        let (spell, opt, jace) = (t.id("Jace's Machinations"), t.id("Opt"), t.id("Jace, Multiverse Architect"));
        t.cast(spell);
        t.drive().unwrap();
        // With Opt on the stack, Jace's abilities are offered.
        t.cast(opt);
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Ability && o.object == Some(jace.0)));
    });
}

/// "Whenever you gain life, you may pay that much life. If you do, draw that many cards. {T}:
/// Each opponent loses 1 life and you gain 1 life."
#[test]
#[ignore = "phase bug: Niv-Mizzet, Ghost Counsel's \"pay that much life\" is unimplemented, so gaining life draws nothing"]
fn niv_mizzet_ghost_counsel_turns_life_gained_into_cards() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Niv-Mizzet, Ghost Counsel").build();
        let niv = t.id("Niv-Mizzet, Ghost Counsel");
        t.activate(niv, None);
        t.drive().unwrap();
        assert_eq!(t.life(1), 39);
        assert_eq!(t.life(0), 40, "gained 1, paid 1");
        assert_eq!(t.drawn(0), 1);
    });
}

/// "Whenever one or more Sphinxes you control attack, each player mills that many cards. For
/// each player, you may cast a card that player milled this way without paying its mana cost."
#[test]
#[ignore = "phase bug: The Ur-Sphinx's \"for each player, you may cast a card that player milled\" is unimplemented"]
fn the_ur_sphinx_casts_a_milled_card_from_each_player() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "The Ur-Sphinx").top(0, "Grizzly Bears").top(1, "Hill Giant").build();
        let (sphinx, bears, giant) = (t.id("The Ur-Sphinx"), t.id("Grizzly Bears"), t.id("Hill Giant"));
        t.attack(&[(sphinx, 1)]);
        t.drive().unwrap();
        assert!(t.on_field(bears) && t.on_field(giant), "both milled creatures cast free");
    });
}

// ── Cards phase parses with warnings ("uncertain" in the report) ────────────────────────────
//
// Not partly unimplemented, but the parser swallowed a clause or found a gap; these check the
// clause it swallowed.

/// "{T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead."
/// (and Tower's {C}{C}{C}): with all three, the Tron lands make seven.
#[test]
fn urza_lands_make_seven_together() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Urza's Mine").field(0, "Urza's Power Plant").field(0, "Urza's Tower").build();
        let mut total = 0;
        for name in ["Urza's Mine", "Urza's Power Plant", "Urza's Tower"] {
            let id = t.id(name);
            let action = t.mana_actions(id).into_iter().next().expect("a mana ability");
            total += t.tap_for_mana(action).unwrap();
        }
        assert_eq!(total, 7);
    });
}

#[test]
fn urza_lands_make_one_each_apart() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Urza's Mine").field(0, "Urza's Tower").build();
        let mine = t.id("Urza's Mine");
        let action = t.mana_actions(mine).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(1), "no Power-Plant");
    });
}

/// "If you tap a permanent for mana, it produces twice as much of that mana instead."
#[test]
fn mana_reflection_doubles_a_lands_mana() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mana Reflection").field(0, "Forest").build();
        let forest = t.id("Forest");
        let action = t.mana_actions(forest).into_iter().next().expect("a mana ability");
        assert_eq!(t.tap_for_mana(action), Ok(2));
    });
}

/// "Choose any number of target creatures you control. For each of them, create a token that's a
/// copy of that creature, except it has haste. Exile those tokens at the beginning of the next
/// end step."
#[test]
fn twinflame_copies_a_creature_with_haste() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Twinflame").lands(0, "Mountain", 2).field(0, "Hill Giant").build();
        let (spell, giant) = (t.id("Twinflame"), t.id("Hill Giant"));
        t.cast(spell);
        t.drive_aiming(&[giant]);
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 1);
        assert_eq!(t.state().objects[&tokens[0]].name, "Hill Giant");
        assert!(t.has(tokens[0], Keyword::Haste));
        t.advance_to(Phase::End);
        t.drive().unwrap();
        assert!(t.tokens(0).is_empty(), "exiled at the end step");
    });
}

/// "If this creature hasn't been exerted this turn, you may exert it as it attacks. When you do,
/// untap all other creatures you control and after this phase, there is an additional combat
/// phase."
#[test]
fn combat_celebrant_exerts_for_another_combat() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Combat Celebrant").field(0, "Grizzly Bears").build();
        let (celebrant, bears) = (t.id("Combat Celebrant"), t.id("Grizzly Bears"));
        t.attack(&[(celebrant, 1), (bears, 1)]);
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 0 && p.answer == Answer::ChooseExert).then_some(Act::ChooseExert { exert: true })
        })
        .unwrap();
        assert!(!t.tapped(bears), "the Bears untapped");
        t.advance_to(Phase::EndCombat);
        t.advance_to(Phase::BeginCombat);
        assert_eq!(t.state().active_player.0, 0, "a second combat this turn");
        assert_eq!(t.state().turn_number, 3);
    });
}

/// "Equip {4}. This ability costs {3} less to activate if you're the monarch."
#[test]
fn crown_of_gondor_equips_for_one_as_the_monarch() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Crown of Gondor").field(0, "Grizzly Bears").lands(0, "Plains", 1).build();
        let (crown, bears) = (t.id("Crown of Gondor"), t.id("Grizzly Bears"));
        t.m.state.monarch = Some(engine::types::player::PlayerId(0));
        assert!(t.decision(0).options.iter().any(|o| o.kind == OptionKind::Ability && o.object == Some(crown.0)), "equip offered for {{1}}");
        t.activate(crown, None);
        t.drive_aiming(&[bears]);
        assert_eq!(t.state().objects[&crown].attached_to, Some(engine::game::game_object::AttachTarget::Object(bears)));
    });
}

/// "This spell costs {1} less to cast for each instant and sorcery card in your graveyard. For
/// each opponent, create two 3/3 blue and red Elemental creature tokens with flying that attack
/// that opponent this turn if able. They gain haste until end of turn."
#[test]
fn furygale_flocking_makes_two_flyers_per_opponent() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Furygale Flocking").lands(0, "Mountain", 10).build();
        let spell = t.id("Furygale Flocking");
        t.cast(spell);
        t.drive().unwrap();
        let tokens = t.tokens(0);
        assert_eq!(tokens.len(), 4, "two for each of two opponents");
        for k in tokens {
            assert_eq!(t.pt(k), (3, 3));
            assert!(t.has(k, Keyword::Flying) && t.has(k, Keyword::Haste));
        }
    });
}

/// "When this creature enters, prevent all damage that would be dealt to you this turn. Whenever
/// damage that would be dealt to you is prevented, put that many +1/+1 counters on this
/// creature."
#[test]
#[ignore = "phase bug: Selfless Squire gets no counters when damage to you is prevented (the trigger mode is unsupported)"]
fn selfless_squire_grows_from_prevented_damage() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Selfless Squire").lands(0, "Plains", 4).hand(1, "Lightning Bolt").lands(1, "Mountain", 1).build();
        let (squire, bolt) = (t.id("Selfless Squire"), t.id("Lightning Bolt"));
        t.cast(squire);
        t.drive().unwrap();
        t.pass_until(|t| t.m.waiting_on().first() == Some(&0) && t.settled());
        // Ben bolts Ana, in Ana's turn.
        t.m.state.priority_player = engine::types::player::PlayerId(1);
        t.m.state.waiting_for = engine::types::game_state::WaitingFor::Priority { player: engine::types::player::PlayerId(1) };
        t.m.remark(None);
        t.act(1, Act::CastSpell { object: bolt.0, payment: crate::pay::PayMode::Auto });
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            (seat == 1 && p.answer == Answer::ChooseTarget).then_some(Act::ChooseTarget { target: Some(TargetView::Player { seat: 0 }) })
        })
        .unwrap();
        assert_eq!(t.life(0), 40, "prevented");
        assert_eq!(t.counters(squire, CounterType::Plus1Plus1), 3);
    });
}

/// "As this creature enters, choose a card type. You and creatures you control have protection
/// from the chosen card type."
#[test]
fn serras_emissary_protects_from_the_chosen_type() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Serra's Emissary").lands(0, "Plains", 7).field(0, "Grizzly Bears").build();
        let (angel, bears) = (t.id("Serra's Emissary"), t.id("Grizzly Bears"));
        t.cast(angel);
        t.drive_answering(by_answer(|_, p| super::choose_named(p, "Instant"))).unwrap();
        assert!(t.state().objects[&bears].keywords.iter().any(|k| matches!(k, Keyword::Protection(_))), "the Bears have protection");
        assert!(t.state().objects[&angel].keywords.iter().any(|k| matches!(k, Keyword::Protection(_))));
    });
}

/// "Choose target opponent. Until that player's next turn, they gain protection from everything
/// and their life total can't change. All nonland permanents they control phase out."
#[test]
#[ignore = "phase bug: Teferi's Reproach doesn't phase out the opponent's nonland permanents"]
fn teferis_reproach_phases_out_an_opponents_board() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Teferi's Reproach").lands(0, "Plains", 3).field(1, "Hill Giant").lands(1, "Island", 1).build();
        let (spell, giant, island) = (t.id("Teferi's Reproach"), t.id("Hill Giant"), t.id("Island"));
        t.cast(spell);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::ChooseTarget).then_some(Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }))).unwrap();
        let phased_in = t.state().battlefield_phased_in_ids();
        assert!(!phased_in.contains(&giant), "the Giant phased out");
        assert!(phased_in.contains(&island), "lands stay");
    });
}

/// "Whenever Jhoira enters or attacks, target opponent reveals cards from the top of their
/// library until they reveal a historic permanent card. You put that card onto the battlefield
/// under your control and lose life equal to that permanent's mana value."
#[test]
#[ignore = "phase bug: Jhoira takes the historic permanent but you lose no life for its mana value"]
fn jhoira_steals_a_historic_permanent_from_the_top() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Jhoira, Weatherlight Corsair").lands(0, "Swamp", 6).top(1, "Grizzly Bears").top(1, "Spellbook").build();
        let (jhoira, book) = (t.id("Jhoira, Weatherlight Corsair"), t.id("Spellbook"));
        // Ben's library: Grizzly Bears on top, then Spellbook (an artifact: historic).
        t.cast(jhoira);
        t.drive_answering(by_answer(|_, p| (p.answer == Answer::ChooseTarget).then_some(Act::ChooseTarget { target: Some(TargetView::Player { seat: 1 }) }))).unwrap();
        assert!(t.on_field(book) && t.controller(book) == 0, "Ana has Ben's Spellbook");
        assert_eq!(t.life(0), 39, "mana value 1");
    });
}

/// "Exile target card that's an instant or sorcery from your graveyard. For each card exiled this
/// way, copy it, and you may cast the copy without paying its mana cost."
#[test]
fn mizzixs_mastery_casts_a_copy_of_a_graveyard_spell() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Mizzix's Mastery").lands(0, "Mountain", 4).grave(0, "Divination").build();
        let (spell, div) = (t.id("Mizzix's Mastery"), t.id("Divination"));
        t.cast(spell);
        t.drive_answering(by_answer(|_, p| match p.answer {
            Answer::ChooseTarget | Answer::SelectCards if offers(p, div) => {
                Some(if p.answer == Answer::ChooseTarget { Act::ChooseTarget { target: Some(TargetView::Object { id: div.0 }) } } else { Act::SelectCards { cards: vec![div.0] } })
            }
            _ => None,
        }))
        .unwrap();
        assert_eq!(t.zone(div), Zone::Exile);
        assert_eq!(t.drawn(0), 2, "the copy of Divination resolved");
    });
}

/// "Whenever a player casts an instant or sorcery spell that targets only this creature, that
/// player copies that spell for each other creature they control that the spell could target."
#[test]
#[ignore = "phase bug: Mirrorwing Dragon doesn't copy a spell that targets it for each other creature"]
fn mirrorwing_dragon_copies_a_spell_for_each_other_creature() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Mirrorwing Dragon").field(0, "Grizzly Bears").field(0, "Savannah Lions").hand(0, "Lightning Bolt").lands(0, "Mountain", 1).build();
        let (dragon, bolt, bears, lions) = (t.id("Mirrorwing Dragon"), t.id("Lightning Bolt"), t.id("Grizzly Bears"), t.id("Savannah Lions"));
        t.cast(bolt);
        t.drive_aiming(&[dragon]);
        assert_eq!(t.zone(bears), Zone::Graveyard, "a copy hit the Bears");
        assert_eq!(t.zone(lions), Zone::Graveyard, "and the Lions");
    });
}
