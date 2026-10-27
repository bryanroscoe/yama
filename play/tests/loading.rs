//! Changing the input transport must retain every face, including cards outside a pod.
use std::collections::BTreeMap;
use std::path::Path;

use engine::database::CardDatabase;
use yama_play::Engine;

fn compare(path: &Path) {
    let previous = CardDatabase::from_export(path).unwrap();
    let current = Engine::load(path).unwrap();
    let current = current.database();
    assert_eq!(previous.card_count(), current.card_count());
    assert_eq!(previous.card_names(), current.card_names());
    assert_eq!(
        previous.creature_type_vocabulary(),
        current.creature_type_vocabulary()
    );
    // Index by storage key rather than printed name: meld backs can share printed names.
    let faces: BTreeMap<_, _> = current.face_iter().collect();
    for (key, face) in previous.face_iter() {
        assert_eq!(
            serde_json::to_value(face).unwrap(),
            serde_json::to_value(faces[key]).unwrap(),
            "{key}"
        );
        assert_eq!(
            previous.printings_for_key(key),
            current.printings_for_key(key),
            "{key}"
        );
        assert_eq!(
            previous.is_front_face_key(key),
            current.is_front_face_key(key),
            "{key}"
        );
    }
}

#[test]
fn fixture_corpus_survives_loading_change() {
    compare(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/support-cards.json"));
}

#[test]
#[ignore = "requires full card export in YAMA_ENGINE_CARD_DATA"]
fn full_corpus_survives_loading_change() {
    compare(Path::new(
        &std::env::var("YAMA_ENGINE_CARD_DATA").expect("set YAMA_ENGINE_CARD_DATA"),
    ));
}
