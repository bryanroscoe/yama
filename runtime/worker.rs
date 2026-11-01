//! Private stdin/stdout protocol. Built ONLY against the manifest's frozen adapter and Phase.
//! No network, database, account credentials, or caller-chosen code paths.
use anyhow::{Context, bail, ensure};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use yama_play::{Difficulty, Engine, Match};

fn field<T: DeserializeOwned>(v: &Value, key: &str) -> anyhow::Result<T> {
    serde_json::from_value(v[key].clone()).with_context(|| format!("invalid {key}"))
}
fn state(m: &Match, humans: &[u8]) -> Value {
    let mut views = vec![(None, m.view(None))];
    for &seat in humans {
        views.push((Some(seat), m.view(Some(seat))));
    }
    json!({"views": views, "replay": m.replay_json(), "log": m.log_lines(),
        "answers": m.remembered(), "revision": m.revision, "over": m.is_over(),
        "winner": m.winner(), "turn": m.turn(), "first": m.starting_seat()})
}
fn command(m: &mut Match, v: &Value) -> anyhow::Result<bool> {
    let seat = field(v, "seat")?;
    let choice =
        |r: Result<(), yama_play::ChoiceError>| r.map_err(|e| anyhow::anyhow!(e.to_string()));
    match v["type"].as_str().unwrap_or("") {
        "choose" => choice(m.choose(seat, field(v, "revision")?, field(v, "index")?))?,
        "attack" => choice(m.declare_attackers(
            seat,
            field(v, "revision")?,
            &field::<Vec<_>>(v, "attacks")?,
        ))?,
        "block" => {
            choice(m.declare_blockers(seat, field(v, "revision")?, &field::<Vec<_>>(v, "blocks")?))?
        }
        "act" => choice(m.act(seat, field(v, "revision")?, &field(v, "action")?))?,
        "concede" => m.concede(seat)?,
        "prefs" => {
            let was = m.controls(seat).full_control;
            let full = field(v, "full_control")?;
            m.set_prefs(seat, field(v, "stops")?, full);
            m.set_tap_mana(seat, field(v, "tap_mana")?);
            return Ok(was && !full);
        }
        "full_control" => {
            let on = field(v, "on")?;
            m.set_full_control(seat, on);
            return Ok(!on);
        }
        "stops" => {
            m.set_stops(seat, field(v, "stops")?);
            return Ok(false);
        }
        "pass" => {
            let mode = field(v, "mode")?;
            choice(m.set_passing(seat, mode, field(v, "revision")?))?;
            return Ok(mode.is_some());
        }
        "hold" => {
            m.set_hold(seat, field(v, "on")?);
            return Ok(false);
        }
        _ => bail!("unsupported runtime command"),
    }
    Ok(true)
}
fn run() -> anyhow::Result<()> {
    let manifest: Value = serde_json::from_str(include_str!("historical.json"))?;
    ensure!(
        yama_play::ENGINE_VERSION == manifest["identity"].as_str().unwrap(),
        "adapter identity mismatch"
    );
    let mut out = std::io::stdout().lock();
    writeln!(
        out,
        "{}",
        json!({"hello":manifest,"source":serde_json::from_str::<Value>(include_str!("historical-source.json"))?})
    )?;
    out.flush()?;
    let mut engine: Option<(String, Engine)> = None;
    let mut games: std::collections::HashMap<String, (Match, Vec<u8>)> =
        std::collections::HashMap::new();
    for line in std::io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line?)?;
        let result = (|| -> anyhow::Result<Value> {
            let session: String = field(&v, "session")?;
            match v["op"].as_str().unwrap_or("") {
                "open" => {
                    ensure!(!games.contains_key(&session), "already open");
                    // Identity is checked before any replay parsing, data bytes before schema parsing.
                    ensure!(
                        v["identity"] == manifest["identity"],
                        "saved runtime identity mismatch"
                    );
                    let path: String = field(&v, "data")?;
                    if engine.is_none() {
                        engine = Some((
                            path.clone(),
                            Engine::load_verified(
                                std::path::Path::new(&path),
                                manifest["card_sha256"].as_str().unwrap(),
                            )?,
                        ));
                    }
                    let (loaded_path, engine) = engine.as_ref().unwrap();
                    ensure!(
                        loaded_path == &path,
                        "historical data configuration changed"
                    );
                    let ai: Vec<(u8, String)> = field(&v, "ai")?;
                    let ai: Vec<_> = ai
                        .iter()
                        .map(|(s, d)| (*s, Difficulty::from_label(d)))
                        .collect();
                    let mut m = engine.resume(&field::<String>(&v, "replay")?, &ai)?;
                    m.set_names(field(&v, "names")?);
                    if !v["log"].is_null() {
                        m.set_log_lines(field(&v, "log")?);
                    }
                    if !v["answers"].is_null() {
                        m.set_remembered(field(&v, "answers")?);
                    }
                    let humans: Vec<u8> = field(&v, "humans")?;
                    let result = json!({"state":state(&m,&humans)});
                    games.insert(session, (m, humans));
                    Ok(result)
                }
                "close" => {
                    games.remove(&session);
                    Ok(json!({"closed":true}))
                }
                "view" => Ok(
                    json!({"view":games.get(&session).context("not open")?.0.view(field(&v,"viewer")?)}),
                ),
                "preview" => Ok(
                    json!({"sources":games.get(&session).context("not open")?.0.auto_tap_preview(field(&v,"seat")?,field(&v,"object")?)}),
                ),
                "command" => {
                    let (m, humans) = games.get_mut(&session).context("not open")?;
                    let advance = command(m, &v)?;
                    if advance {
                        m.auto_pass(&humans);
                    }
                    Ok(json!({"state":state(m,&humans),"advance":advance}))
                }
                "batch" => {
                    let (m, humans) = games.get_mut(&session).context("not open")?;
                    let mut moved = 0;
                    let mut fault = None;
                    let settled = loop {
                        let passed = m.auto_pass(&humans);
                        moved += passed;
                        let acted = match m.run_ai(40usize.saturating_sub(moved).max(1)) {
                            Ok(n) => n,
                            Err(e) => {
                                fault = Some(e.to_string());
                                break true;
                            }
                        };
                        moved += acted;
                        let settled = passed + acted == 0 || m.is_over();
                        if settled || moved >= 40 {
                            moved += m.auto_pass(&humans);
                            break settled;
                        }
                    };
                    Ok(
                        json!({"state":state(m,&humans),"moved":moved,"settled":settled,"fault":fault}),
                    )
                }
                _ => bail!("unsupported runtime operation"),
            }
        })();
        let response = match result {
            Ok(v) => v,
            Err(e) => json!({"error":format!("{e:#}")}),
        };
        writeln!(out, "{response}")?;
        out.flush()?;
    }
    Ok(())
}
fn fixture(path: &str) -> anyhow::Result<()> {
    let manifest: Value = serde_json::from_str(include_str!("historical.json"))?;
    let engine = Engine::load_verified(
        std::path::Path::new(path),
        manifest["card_sha256"].as_str().unwrap(),
    )?;
    let deck = |commander: &str, basic: &str| yama_play::SeatDeck {
        commander: vec![commander.into()],
        main: vec![basic.into(); 99],
        companion: vec![],
    };
    let mut m = engine.new_match_first(
        19,
        vec![
            deck("Arcanis the Omnipotent", "Island"),
            deck("Krenko, Mob Boss", "Mountain"),
        ],
        &[(1, Difficulty::Easy)],
        Some(0),
    )?;
    m.set_names(vec!["Ana".into(), "Ben".into()]);
    m.run_ai(40)?;
    let live = state(&m, &[0]);
    m.concede(0)?;
    println!("{}", json!({"live":live,"over":state(&m,&[0])}));
    Ok(())
}
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    std::thread::Builder::new()
        .stack_size(32 << 20)
        .spawn(move || {
            if args.get(1).map(String::as_str) == Some("--fixture") {
                fixture(args.get(2).context("fixture needs card data")?)
            } else if args.get(1).map(String::as_str) == Some("--verify-data") {
                ensure!(
                    args.len() == 3,
                    "usage: historical-runtime --verify-data PATH"
                );
                let manifest: Value = serde_json::from_str(include_str!("historical.json"))?;
                let source: Value = serde_json::from_str(include_str!("historical-source.json"))?;
                ensure!(
                    yama_play::ENGINE_VERSION == manifest["identity"].as_str().unwrap(),
                    "adapter identity mismatch"
                );
                ensure!(
                    source["yama"] == manifest["yama"] && source["phase"] == manifest["phase"],
                    "source provenance mismatch"
                );
                let engine = Engine::load_verified(
                    std::path::Path::new(&args[2]),
                    manifest["card_sha256"].as_str().unwrap(),
                )?;
                println!(
                    "{}",
                    json!({"verified":true,"cards":engine.card_count(),"source":source})
                );
                Ok(())
            } else {
                run()
            }
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("historical runtime panicked"))?
}
