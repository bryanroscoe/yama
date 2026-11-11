use super::*;
use crate::{PassMode, turns::Verdict};

fn solo(t: &mut Table) {
    for seat in 1..t.m.player_count() {
        t.m.ai.insert(PlayerId(seat as u8), crate::ai_config(crate::AiDifficulty::VeryEasy, t.m.player_count() as u8, 7, false));
    }
}

#[test]
fn solo_rewind_restores_plays_and_repeated_history_without_restoring_old_authority() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Plains").hand(0, "Sol Ring").build();
        solo(&mut t);
        t.m.prepare_board().unwrap();
        let namespace = t.m.state.interaction_session_id.clone();
        let logged = t.m.log.actions.len();
        let land = t.id("Plains");
        let play = AiDecisionContract::issue(&t.m.state, PlayerId(0)).candidates.into_iter()
            .find(|c| matches!(c.action, GameAction::PlayLand { object_id, .. } if object_id == land)).unwrap().action;
        t.m.submit(0, play).unwrap();
        t.cast(t.id("Sol Ring"));
        assert!(t.m.state.objects[&land].tapped);
        assert_eq!(t.m.view(Some(0)).rewind_steps, 2);
        assert_eq!(t.m.view(Some(1)).rewind_steps, 0);
        assert!(t.m.go_back(1, t.m.revision).is_err());
        let stale = t.m.revision;
        t.m.go_back(0, stale).unwrap();
        assert!(!t.m.state.objects[&land].tapped);
        assert_eq!(t.zone(land), Zone::Battlefield);
        assert!(t.m.revision > stale);
        assert_ne!(namespace, t.m.state.interaction_session_id);
        assert!(matches!(t.m.go_back(0, stale), Err(ChoiceError::Stale)));
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.zone(land), Zone::Hand);
        assert_eq!(t.m.view(Some(0)).rewind_steps, 0);
        assert!(!t.m.view(Some(0)).can_go_back);
        assert_eq!(t.m.rewinds.len(), 2);
        assert!(t.m.log.actions[logged..].iter().all(|a| a.action.is_actor_scoped_preference()), "undone gameplay is absent from the active replay");
        t.play_land(land);
        assert_eq!(t.m.view(Some(0)).rewind_steps, 1, "new play branches from the restored position");
    });
}

#[test]
fn solo_rewind_can_restore_fetch_payment_search_and_computer_responses() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Windswept Heath").top(0, "Forest").build();
        solo(&mut t);
        let fetch = t.id("Windswept Heath");
        let forest = t.id("Forest");
        let library = t.m.state.players[0].library.clone();
        t.activate(fetch, None);
        t.drive_answering(|_, _, d| d.pending.as_ref().filter(|p| p.purpose == "search").and_then(|p| choose_named(p, "Forest"))).unwrap();
        assert_eq!(t.zone(fetch), Zone::Graveyard);
        assert_eq!(t.zone(forest), Zone::Battlefield);
        assert_eq!(t.m.state.players[0].life, 39);
        assert!(t.m.log.actions.iter().any(|a| a.actor == PlayerId(1)));
        assert!(!t.m.solo_history.is_empty());
        while !t.m.solo_history.is_empty() { t.m.go_back(0, t.m.revision).unwrap(); }
        assert_eq!(t.zone(fetch), Zone::Battlefield);
        assert_eq!(t.zone(forest), Zone::Library);
        assert_eq!(t.m.state.players[0].life, 40);
        assert_eq!(t.m.state.players[0].library, library);
        assert!(t.m.state.stack.is_empty());
        assert_eq!(t.m.state.active_player, PlayerId(0));
        assert!(t.m.controls(0).passing.is_none());
    });
}

#[test]
fn solo_history_is_flat_bounded_and_refused_inputs_do_not_add_checkpoints() {
    big_stack(|| {
        let mut t = Board::new(2).build();
        solo(&mut t);
        for _ in 0..10 {
            let saved = t.m.solo_checkpoint(0);
            t.m.keep_solo_checkpoint(saved);
        }
        assert_eq!(t.m.solo_history.len(), 8);
        assert!(t.m.solo_history.iter().all(|s| s.solo_history.is_empty() && s.rewind.is_none()));
        assert!(t.m.choose(0, t.m.revision, usize::MAX).is_err());
        assert_eq!(t.m.solo_history.len(), 8);
        t.m.abandon();
        assert!(t.m.solo_history.is_empty());
        assert!(t.m.go_back(0, t.m.revision).is_err());
    });
}

#[test]
fn solo_rewind_checkpoint_survives_computer_progress_but_not_a_new_human_choice() {
    big_stack(|| {
        let mut t = Board::new(2).hand(0, "Plains").build();
        solo(&mut t);
        t.choose(0, |o| o.kind == OptionKind::Pass);
        let revision = t.m.revision;
        let checkpoint = t.m.view(Some(0)).rewind_checkpoint;
        t.choose(1, |o| o.kind == OptionKind::Pass);
        assert!(t.m.revision > revision);
        t.m.go_back_to(0, revision, checkpoint).unwrap();
        t.play_land(t.id("Plains"));
        assert!(matches!(t.m.go_back_to(0, t.m.revision, checkpoint), Err(ChoiceError::Stale)));
        assert_eq!(t.m.view(Some(0)).rewind_steps, 1);
    });
}

#[test]
fn solo_rewind_keeps_full_control_and_cancels_temporary_hold_in_engine_too() {
    big_stack(|| {
        for hold in [false, true] {
            let mut t = Board::new(2).hand(0, "Plains").build();
            solo(&mut t);
            if hold { t.m.set_hold(0, true); }
            t.play_land(t.id("Plains"));
            if !hold { t.m.set_full_control(0, true); }
            assert_eq!(t.m.view(Some(0)).rewind_steps, 1, "preferences do not add checkpoints");
            t.m.go_back(0, t.m.revision).unwrap();
            assert_eq!(t.m.controls(0).full_control, !hold);
            assert!(!t.m.controls(0).hold);
            let expected = if hold { crate::PriorityPassingMode::Standard } else { crate::PriorityPassingMode::FullControl };
            assert_eq!(t.m.state.priority_passing_mode(PlayerId(0)), expected);
        }
    });
}

#[test]
fn solo_rewind_preserves_current_phase_stops_in_both_boards() {
    big_stack(|| {
        use engine::types::phase::{PhaseStop, PhaseStopScope};
        for clear in [false, true] {
            let mut t = Board::new(2).hand(0, "Plains").build();
            solo(&mut t);
            let stops = vec![PhaseStop { phase: Phase::Draw, scope: PhaseStopScope::OwnTurn }];
            if clear { t.m.submit(0, GameAction::SetPhaseStops { stops: stops.clone() }).unwrap(); }
            t.play_land(t.id("Plains"));
            let current = if clear { vec![] } else { stops };
            t.m.submit(0, GameAction::SetPhaseStops { stops: current.clone() }).unwrap();
            assert_eq!(t.m.view(Some(0)).rewind_steps, 1);
            t.m.go_back(0, t.m.revision).unwrap();
            assert_eq!(t.m.state.phase_stops.get(&PlayerId(0)).cloned().unwrap_or_default(), current);
            assert_eq!(t.m.controls(0).stops.as_ref().is_some_and(|s| s.own.contains("Draw")), !clear);
        }
    });
}

#[test]
fn solo_rewind_cancels_engine_auto_pass_saved_at_an_interactive_choice() {
    big_stack(|| {
        let mut t = Board::new(2).build();
        solo(&mut t);
        // A mandatory decision can be reached while an engine turn pass is armed.
        t.m.state.auto_pass.insert(PlayerId(0), engine::types::game_state::AutoPassMode::UntilTurnBoundary { until: Default::default() });
        let checkpoint = t.m.solo_checkpoint(0);
        t.m.keep_solo_checkpoint(checkpoint);
        t.m.go_back(0, t.m.revision).unwrap();
        assert!(!t.m.state.auto_pass.contains_key(&PlayerId(0)));
        assert!(matches!(t.m.log.actions.last().unwrap().action, GameAction::CancelAutoPass));
        assert!(t.m.controls(0).passing.is_none());
    });
}

#[test]
fn solo_rewind_records_opaque_choices_and_refuses_the_old_capability_after_restore() {
    big_stack(|| {
        use engine::types::interaction::{InteractionOpportunityResponse, InteractionResponse, InteractionSubmission};
        use engine::game::interaction::resolve_interaction_response;
        let mut t = Board::new(2).hand(0, "Plains").build();
        solo(&mut t);
        t.m.prepare_board().unwrap();
        let crate::board::ServerMessage::StateUpdate { viewer_interaction, .. } = crate::board::state_update(&t.m.state, PlayerId(0), t.m.revision, "g", &Default::default()) else { panic!("state update") };
        let submission = viewer_interaction.opportunities.iter().find_map(|o| {
            let InteractionOpportunityResponse::ExactChoices { choices } = &o.response else { return None };
            choices.iter().find_map(|choice| {
                let submission = InteractionSubmission { interaction_id: o.interaction_id.clone(), response: InteractionResponse::Choose { choice_id: choice.id.clone() } };
                matches!(resolve_interaction_response(&t.m.state, PlayerId(0), &submission).ok()?, GameAction::PlayLand { .. }).then_some(submission)
            })
        }).expect("land play capability");
        t.m.submit_interaction(0, submission.clone()).unwrap();
        assert_eq!(t.m.view(Some(0)).rewind_steps, 1);
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.zone(t.id("Plains")), Zone::Hand);
        assert!(t.m.submit_interaction(0, submission).is_err());
        assert_eq!(t.m.view(Some(0)).rewind_steps, 0);
    });
}

#[test]
fn solo_rewind_restores_attack_declaration() {
    big_stack(|| {
        let mut t = Board::new(2).field(0, "Grizzly Bears").build();
        solo(&mut t);
        t.pass_until(|t| matches!(t.m.state.waiting_for, WaitingFor::DeclareAttackers { .. }));
        let before = t.m.state.waiting_for.clone();
        t.m.declare_attackers(0, t.m.revision, &[]).unwrap();
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.m.state.waiting_for, before);
        assert_eq!(t.m.state.phase, Phase::DeclareAttackers);
    });
}

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
fn solo_go_back_from_cleanup_discard_can_walk_back_to_main_phase() {
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
        let discard = t.m.state.players[0].hand[0];
        t.act(0, Act::SelectCards { cards: vec![discard.0] });
        assert_eq!(t.zone(discard), Zone::Graveyard);
        t.m.go_back(0, t.m.revision).unwrap();
        assert_eq!(t.hand(0).len(), 8);
        assert!(matches!(t.m.state.waiting_for, WaitingFor::DiscardToHandSize { .. }));
        while t.m.state.phase != Phase::PostCombatMain { t.m.go_back(0, t.m.revision).unwrap(); }
        assert_eq!(t.m.state.phase, Phase::PostCombatMain);
        assert!(matches!(t.m.state.waiting_for, WaitingFor::Priority { player } if player == PlayerId(0)));
        assert_eq!(t.hand(0).len(), 8);
    });
}
