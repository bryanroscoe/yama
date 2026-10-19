//! The seat that takes the first turn, which Yama stores as `games.first_seat` for online games.

use std::path::Path;
use yama_play::{Engine, SeatDeck};

fn deck() -> SeatDeck {
    SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Forest".into(); 99] }
}

#[test]
fn starting_seat_is_whoever_has_turn_one() {
    let e = Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/support-cards.json")).unwrap();
    let mut seen = std::collections::HashSet::new();
    for seed in 1..=12u64 {
        let m = e.new_match(seed, vec![deck(), deck(), deck()], &[]).unwrap();
        let first = m.starting_seat();
        assert!(first < 3, "seed {seed}: seat {first}");
        assert_eq!(m.turn(), 1);
        assert_eq!(m.view(None).active, first, "seed {seed}");
        seen.insert(first);
    }
    // The engine picks the starting player from the seed, not always seat 0.
    assert!(seen.len() > 1, "{seen:?}");
}
