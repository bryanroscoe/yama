use super::*;
use crate::{PassMode, turns::Verdict};

#[test]
fn wishclaw_names_the_opponent_who_receives_control() {
    big_stack(|| {
        let mut t = Board::new(4).field(0, "Wishclaw Talisman").lands(0, "Plains", 1).build();
        let talisman = t.id("Wishclaw Talisman");
        t.m.state.objects.get_mut(&talisman).unwrap().counters.insert(CounterType::Generic("wish".into()), 3);
        t.activate(talisman, None);
        let mut saw_choice = false;
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if p.answer != crate::act::Answer::ChooseOption || p.choice_type.as_deref() != Some("opponent") { return None; }
            saw_choice = true;
            assert_eq!(seat, 0);
            assert_eq!(p.kind, crate::act::Kind::Pick);
            assert_eq!(p.purpose, "control_recipient");
            assert_eq!(p.prompt, "Choose an opponent to gain control of Wishclaw Talisman");
            assert_eq!(p.source.as_ref().map(|s| s.name.as_str()), Some("Wishclaw Talisman"));
            assert_eq!(p.options.iter().map(|o| (o.id.as_str(), o.controller)).collect::<Vec<_>>(), [("1", Some(1)), ("2", Some(2)), ("3", Some(3))]);
            assert!(p.options.iter().all(|o| !o.name.chars().all(|c| c.is_ascii_digit())));
            Some(Act::ChooseOption { choice: "2".into() })
        }).expect("the named opponent choice resolves through the normal engine action");
        assert!(saw_choice);
        assert_eq!(t.m.state.objects[&talisman].controller, PlayerId(2));
    });
}

#[test]
fn fetchland_is_a_main_phase_action_even_without_a_castable_spell() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Windswept Heath").build();
        let fetch = t.id("Windswept Heath");
        t.play_land(fetch);
        let window = t.m.window(0).expect("still your priority after a land");
        assert!(
            window.can_act,
            "fetch activation must prevent automatic turn advance"
        );
        assert_eq!(
            crate::turns::verdict(&window, &t.m.controls(0)),
            Verdict::Stop
        );
        assert_eq!(t.m.auto_pass(&[0]), 0);
        t.activate(fetch, None);
        t.drive()
            .expect("fetch search resolves through the adapter");
        assert_eq!(t.m.state.active_player, PlayerId(0));
        assert_eq!(t.m.state.phase, Phase::PreCombatMain);
        assert_eq!(t.zone(fetch), Zone::Graveyard);
        assert_eq!(t.m.state.players[0].life, 39);
    });
}

#[test]
fn stale_pass_never_enables_a_mode_and_cancel_is_always_allowed() {
    big_stack(|| {
        let mut t = Board::new(2).build();
        assert!(matches!(
            t.m.set_passing(0, Some(PassMode::End), t.m.revision + 99),
            Err(ChoiceError::Stale)
        ));
        assert!(t.m.controls(0).passing.is_none());
        t.m.set_passing(0, None, 0).unwrap();
    });
}

#[test]
fn go_back_restores_an_empty_stack_pass_but_not_a_real_action() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Plains").build();
        t.m.prepare_board().unwrap();
        let old_namespace = t.m.state.interaction_session_id.clone();
        let original_phase = t.m.state.phase;
        let revision = t.m.revision;
        t.choose(0, |o| o.kind == OptionKind::Pass);
        assert!(t.m.view(Some(0)).can_go_back);
        assert!(!t.m.view(Some(1)).can_go_back);
        assert!(t.m.go_back(1, t.m.revision).is_err());
        t.m.go_back(0, t.m.revision).unwrap();
        assert_ne!(t.m.state.interaction_session_id, old_namespace);
        assert!(t.m.revision > revision);
        assert_eq!(t.m.state.phase, original_phase);
        assert_eq!(t.m.state.waiting_for.acting_players(), vec![PlayerId(0)]);
        assert!(!t.m.view(Some(0)).can_go_back);
        assert!(t.m.controls(0).passing.is_none());
        t.play_land(t.id("Plains"));
        assert!(t.m.go_back(0, t.m.revision).is_err());
    });
}

#[test]
fn solo_abandonment_survives_replay_without_inventing_a_winner() {
    big_stack(|| {
        let deck = SeatDeck {
            commander: vec![DEFAULT_COMMANDER.into()],
            main: vec!["Plains".into(); 99],
            ..Default::default()
        };
        let mut m = engine()
            .new_match_first(7, vec![deck.clone(), deck], &[], Some(0))
            .unwrap();
        m.abandon();
        let replay = m.replay_json();
        let resumed = engine().resume(&replay, &[]).unwrap();
        assert!(resumed.is_over());
        assert!(resumed.abandoned());
        assert!(resumed.winner().is_none());
        assert_eq!(resumed.revision, m.revision);
    });
}

#[test]
fn no_mana_cost_is_explained_without_debug_labels() {
    big_stack(|| {
        let t = Board::new(2).build();
        let cost = engine::types::ability::AbilityCost::Mana {
            cost: engine::types::mana::ManaCost::NoCost,
        };
        assert_eq!(
            crate::act::unless_cost_text(t.state(), &cost),
            "without paying its mana cost"
        );
    });
}

#[test]
fn fetched_shock_land_offers_life_payment_and_returns_to_main_phase() {
    big_stack(|| {
        let mut t = Board::new(2)
            .field(0, "Windswept Heath")
            .top(0, "Temple Garden")
            .build();
        let fetch = t.id("Windswept Heath");
        t.activate(fetch, None);
        t.m.controls.entry(0).or_default().passing = Some(crate::turns::Passing {
            mode: PassMode::Mine,
            turn: t.m.turn(),
        });
        let mut entry_choice = false;

        t.drive_answering(|t, _seat, d| {
            let p = d.pending.as_ref()?;
            if p.purpose == "search" {
                return choose_named(p, "Temple Garden");
            }
            if p.answer == Answer::ChooseReplacement && p.prompt == "Pay 2 life?" {
                entry_choice = true;
                return Some(Act::ChooseReplacement { index: 0 });
            }
            let _ = t;
            None
        })
        .unwrap();
        assert!(
            entry_choice,
            "the fetched shock land must ask before paying life"
        );
        assert_eq!(t.m.state.players[0].life, 37);
        assert_eq!(
            t.m.controls(0).passing.map(|p| p.mode),
            Some(PassMode::Mine),
            "required search and entry choices preserve passing"
        );
        let garden =
            t.m.state
                .battlefield
                .iter()
                .filter_map(|id| t.m.state.objects.get(id))
                .find(|o| o.name == "Temple Garden")
                .unwrap();
        assert!(!garden.tapped);
        assert_eq!(t.m.state.phase, Phase::PreCombatMain);
        assert_eq!(t.m.state.active_player, PlayerId(0));
    });
}

#[test]
fn chrome_mox_exposes_its_imprint_and_remembers_colors_while_tapped() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Chrome Mox").hand(0, "Opt").build();
        let mox = t.id("Chrome Mox");
        let card = t.id("Opt");
        // Public exile link is the engine's persistent source for the imprint's colors.
        t.m.state.players[0].hand.retain(|id| *id != card);
        t.m.state.exile.push_back(card);
        t.m.state.objects.get_mut(&card).unwrap().zone = Zone::Exile;
        t.m.state
            .exile_links
            .push(engine::types::game_state::ExileLink {
                exiled_id: card,
                source_id: mox,
                kind: engine::types::game_state::ExileLinkKind::TrackedBySource,
            });
        for tapped in [false, true] {
            t.m.state.objects.get_mut(&mox).unwrap().tapped = tapped;
            let view = t.m.view(Some(0));
            let shown = view.battlefield.iter().find(|c| c.id == mox.0).unwrap();
            assert_eq!(shown.mana_colors.as_deref(), Some(&["U".to_string()][..]));
            assert_eq!(shown.imprinted, vec!["Opt"]);
        }
    });
}

#[test]
fn deflecting_swat_can_target_a_tutor_without_redirecting_its_search() {
    big_stack(|| {
        let mut t = Board::new(2).active(1).hand(0, "Deflecting Swat").hand(1, "Demonic Tutor").basics(0, 1).basics(1, 1).build();
        let tutor = t.id("Demonic Tutor");
        let swat = t.id("Deflecting Swat");
        t.cast(tutor);
        t.pass_until(|t| matches!(t.m.state.waiting_for, WaitingFor::Priority { player } if player == PlayerId(0)));
        t.cast(swat);
        let mut searcher = None;
        let mut retargeted = false;
        t.drive_answering(|_, seat, d| {
            let p = d.pending.as_ref()?;
            if p.answer == Answer::ChooseTarget { return choose_named(p, "Demonic Tutor"); }
            if p.answer == Answer::RetargetSpell { retargeted = true; }
            if p.purpose == "search" { searcher = Some(seat); }
            None
        }).unwrap();
        assert_eq!(searcher, Some(1), "Tutor's controller still searches");
        assert!(!retargeted, "a nontargeted spell cannot acquire new targets");
        assert_eq!(t.zone(swat), Zone::Graveyard);
        assert_eq!(t.zone(tutor), Zone::Graveyard);
    });
}

#[test]
fn going_back_does_not_cancel_another_seats_pass_mode() {
    big_stack(|| {
        let mut t = Board::new(3).hand(0, "Plains").build();
        t.choose(0, |o| o.kind == OptionKind::Pass);
        t.m.set_passing(2, Some(PassMode::Mine), t.m.revision).unwrap();
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.m.controls(2).passing.map(|p| p.mode), Some(PassMode::Mine));
        assert!(t.m.controls(0).passing.is_none());
    });
}

#[test]
fn go_back_from_unsubmitted_cleanup_discard_restores_the_main_phase() {
    big_stack(|| {
        let mut board = Board::new(2).phase(Phase::PostCombatMain);
        for _ in 0..8 { board = board.hand(0, "Plains"); }
        let mut t = board.build();
        t.m.ai.insert(PlayerId(1), crate::ai_config(crate::Difficulty::Easy, 2, 7, crate::AI_CLOCK));
        for _ in 0..12 {
            if matches!(t.m.state.waiting_for, WaitingFor::DiscardToHandSize { .. }) { break; }
            let WaitingFor::Priority { player } = t.m.state.waiting_for else { panic!("unexpected decision: {:?}", t.m.state.waiting_for) };
            t.choose(player.0, |o| o.kind == OptionKind::Pass);
        }
        assert!(matches!(t.m.state.waiting_for, WaitingFor::DiscardToHandSize { .. }));
        assert!(t.m.view(Some(0)).can_go_back);
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.m.state.phase, Phase::PostCombatMain);
        assert!(matches!(t.m.state.waiting_for, WaitingFor::Priority { player } if player == PlayerId(0)));
        assert_eq!(t.hand(0).len(), 8);
    });
}
