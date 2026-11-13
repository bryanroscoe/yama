//! Every integration test in one binary. Each file in tests/ used to build its own binary,
//! and each of those linked the whole engine. Add a new test file here as a module. Run one file's tests with a filter, e.g.
//! `cargo test -p yama-play --test integration determinism::`.

mod decisions;
mod determinism;
mod lab_combos;
mod lab_regressions;
mod lab_regressions_candidate;
mod lab_regressions_v0122;
mod llm_pilot;
mod loading;
mod starting_seat;
mod support;
mod turns;
mod watched;
