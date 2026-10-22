//! What "Watch the AIs play" needs from a match: a chosen first player, every hand face up for
//! the owner, and AI seats that play on their own one action at a time.

use std::path::Path;
use yama_play::{Difficulty, Engine, SeatDeck};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/support-cards.json")).unwrap()
}

fn deck() -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: [vec!["Sol Ring".into()], vec!["Forest".into(); 98]].concat() }
}

#[test]
fn the_chosen_seat_goes_first() {
    let e = engine();
    for first in 0..2u8 {
        for seed in 1..=4u64 {
            let m = e.new_match_first(seed, vec![deck(), deck(), deck()], &[], Some(first)).unwrap();
            assert_eq!(m.starting_seat(), first, "seed {seed}");
        }
    }
    // phase's setup ignores any other seat, so asking for one is refused rather than rolled.
    assert!(e.new_match_first(1, vec![deck(), deck(), deck()], &[], Some(2)).is_err());
}

#[test]
fn revealed_views_show_every_hand_and_spectator_views_none() {
    let e = engine();
    let ai = [(0, Difficulty::Easy), (1, Difficulty::Easy)];
    let mut m = e.new_match_first(7, vec![deck(), deck()], &ai, Some(0)).unwrap();
    m.set_ai_fallback(true);
    let hidden = m.view(None);
    assert!(hidden.hands.is_empty() && hidden.hand.is_empty());
    let shown = m.view_revealed();
    assert_eq!(shown.hands.len(), 2);
    for p in &shown.players {
        assert_eq!(shown.hands[&p.seat].len(), p.hand, "seat {}", p.seat);
    }
    assert!(shown.decision.is_none());
    // Only revealed views carry the field at all.
    assert!(serde_json::to_value(&hidden).unwrap().get("hands").is_none());

    // Every seat is an AI: one action at a time, the game moves on with nobody deciding.
    let start = m.revision;
    for _ in 0..200 {
        if m.is_over() {
            break;
        }
        let n = m.run_ai(1).unwrap();
        if n == 0 {
            assert!(m.settle_ai_contest() || m.is_over(), "stuck at revision {}", m.revision);
        }
    }
    assert!(m.revision >= start + 200 || m.is_over(), "only {} actions", m.revision - start);
    assert!(m.turn() > 1);
}
