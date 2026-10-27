//! One cold-process database load. Use /usr/bin/time for process CPU and peak RSS.
//! cargo run --release -p yama-play --bin loadbench -- reader|current CARD_DATA
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use engine::database::CardDatabase;
use yama_play::Engine;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "usage: loadbench reader|current CARD_DATA");
    let path = Path::new(&args[2]);
    let started = Instant::now();
    let db = match args[1].as_str() {
        "reader" => Arc::new(CardDatabase::from_export(path).map_err(|e| anyhow::anyhow!("{e}"))?),
        "current" => Engine::load(path)?.database().clone(),
        _ => anyhow::bail!("mode must be reader or current"),
    };
    println!(
        "{}",
        serde_json::json!({
            "mode": args[1], "cards": db.card_count(), "load_s": started.elapsed().as_secs_f64(),
            "runner": yama_play::lab::RUNNER,
        })
    );
    Ok(())
}
