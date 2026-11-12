//! Phase v0.122 acceptance on unchanged historical seeds, decks and limits.
//! The v0.119 provenance and control remain frozen in their separate metadata.
//! Run candidate_v0122 with verified parser-matched data and one test thread.

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0122_lorehold_priority_session_finishes() {
    super::lab_regressions_candidate::check_current(include_str!("fixtures/lab-regressions/d566002e-18-variant.json"), include_str!("fixtures/lab-regressions/candidate-v0122.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the priority-session defect"]
fn candidate_v0122_tricky_terrain_priority_session_finishes() {
    super::lab_regressions_candidate::check_current(include_str!("fixtures/lab-regressions/12ea113b-8-base.json"), include_str!("fixtures/lab-regressions/candidate-v0122.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the Adventure-offer defect"]
fn candidate_v0122_multiverse_adventure_offer_finishes() {
    super::lab_regressions_candidate::check_current(include_str!("fixtures/lab-regressions/8b516e4e-147-solo.json"), include_str!("fixtures/lab-regressions/candidate-v0122.json"));
}

#[test]
#[ignore = "full seeded scenario; candidate acceptance for the combat-tax defect"]
fn candidate_v0122_multiverse_combat_tax_finishes() {
    super::lab_regressions_candidate::check_current(include_str!("fixtures/lab-regressions/8b516e4e-143-solo.json"), include_str!("fixtures/lab-regressions/candidate-v0122.json"));
}

#[test]
#[ignore = "full seeded scenario on pinned card data"]
fn candidate_v0122_world_shaper_control() {
    super::lab_regressions_candidate::check_current(include_str!("fixtures/lab-regressions/24915300-25-base.json"), include_str!("fixtures/lab-regressions/candidate-v0122.json"));
}
