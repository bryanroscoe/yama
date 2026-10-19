//! Engine support for deck cards, on a five-card slice of phase's card data
//! (tests/fixtures/support-cards.json, taken from card-data-eb309108eb0df708.json with the
//! printing lists and diagnostics removed).

use std::path::Path;
use yama_play::{CardSupport, DeckLine, DeckSupport, Engine};

fn engine() -> Engine {
    Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/support-cards.json")).unwrap()
}

const SOL_RING: &str = "6ad8011d-3471-4369-9d68-b264cc027487";
const PORTAL: &str = "8430ae03-2d4c-4031-aa29-4d53815ded78";
const BALLISTA: &str = "b6811c31-fcd3-4d00-89d5-cf974575a87c";
const FOREST: &str = "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6";

#[test]
fn card_support_finds_unimplemented_parts_on_either_face() {
    let e = engine();
    assert_eq!(e.card_support(SOL_RING, "Sol Ring"), CardSupport::Full);
    assert_eq!(e.card_support(FOREST, "Forest"), CardSupport::Full);
    // Negative Zone Portal has an Unimplemented node in phase v0.113.0's parse.
    assert_eq!(e.card_support(PORTAL, "Negative Zone Portal"), CardSupport::Partial);
    // Ballista Watcher's front face is fine; its back face (Ballista Wielder) isn't.
    assert_eq!(e.card_support(BALLISTA, "Ballista Watcher // Ballista Wielder"), CardSupport::Partial);
    // Unknown oracle ID: falls back to the name.
    assert_eq!(e.card_support("no-such-id", "Sol Ring"), CardSupport::Full);
    assert_eq!(e.card_support("no-such-id", "Not a Card"), CardSupport::Missing);
}

#[test]
fn deck_support_counts_copies_and_lists_names_once() {
    let e = engine();
    let line = |oracle_id, name, qty, commander| DeckLine { oracle_id, name, qty, commander };
    let lines = [
        line(BALLISTA, "Ballista Watcher // Ballista Wielder", 1, true),
        line(SOL_RING, "Sol Ring", 1, false),
        line(PORTAL, "Negative Zone Portal", 1, false),
        line("x", "Not a Card", 1, false),
        line(FOREST, "Forest", 30, false),
    ];
    assert_eq!(
        e.deck_support(&lines),
        DeckSupport {
            total: 34,
            supported: 31,
            missing: vec!["Not a Card".into()],
            partial: vec!["Ballista Watcher // Ballista Wielder".into(), "Negative Zone Portal".into()],
        }
    );
}
