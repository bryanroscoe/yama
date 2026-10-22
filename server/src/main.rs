mod advisor;
mod auth;
mod calendar;
mod cards;
mod collection;
mod config;
mod db;
mod deck_checks;
mod deck_import;
mod decks;
mod error;
mod game_export;
mod games;
mod lab;
mod limits;
mod play;
mod plan;
mod playgroups;
#[cfg(test)]
mod privacy_tests;
mod routes;
#[cfg(test)]
mod signup_tests;
mod stats;
mod table_rooms;
#[cfg(test)]
mod testutil;
mod util;
mod watch;

use anyhow::Context;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
yama-server — Yama backend

USAGE:
  yama-server serve                          Run the HTTP server
  yama-server import-cards [--oracle FILE] [--default FILE] [--rulings FILE]
                                             Import Scryfall bulk data and rulings
                                             (downloads the latest files unless both
                                             card files are given)
  yama-server import-calendar                Refresh upcoming sets (Scryfall) and Commander
                                             precon lists (MTGJSON) once
  yama-server import-decks DIR --owner EMAIL Import every .txt deck list in DIR
  yama-server import-plan FILE --owner EMAIL [--dry-run] [--force]
                                             Import a yama-plan/1 file (docs/plan-format.md)
                                             as EMAIL's plan, the same way the web upload
                                             does; prints the import report
  yama-server import-precons INDEX [--playgroup FILE]
                                             Import the Commander precon catalog from
                                             commander-decks data/sim/decks/index.json and
                                             the deck files beside it
  yama-server import-lab SUMMARY [--owner EMAIL] [--name NAME]
                                             Import an analysed lab run (summary.json from
                                             commander-decks scripts/sim/analyze.py); global
                                             unless --owner is given. A global run may rate
                                             precons only; one with a user's lists needs
                                             --owner
  yama-server invite EMAIL                   Allow EMAIL to sign in (with open sign-up,
                                             give it the full allowance)
  yama-server user add EMAIL [--name NAME] [--admin] [--password-stdin]
                                             Give EMAIL a password for password sign-in
                                             (creates the account; prints a generated
                                             password unless one is piped in)
  yama-server user remove-password EMAIL     Turn off password sign-in for EMAIL
  yama-server user disable EMAIL             Turn EMAIL's account off: its sessions end and
                                             every way of signing in refuses it
  yama-server user enable EMAIL              Turn it back on
  yama-server user list                      Every account, how it signs in, and whether
                                             it's invited or turned off
  yama-server backup FILE                    Write a consistent copy of the database

Configuration comes from the environment; see .env.example.";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,yama_server=debug".into()))
        .init();

    let cfg = config::Config::from_env()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pool = db::connect(&cfg.database_url).await?;

    match args.first().map(String::as_str) {
        Some("serve") | None => routes::serve(cfg, pool).await,
        Some("import-cards") => {
            let oracle = flag_value(&args, "--oracle").map(PathBuf::from);
            let default = flag_value(&args, "--default").map(PathBuf::from);
            let rulings = flag_value(&args, "--rulings").map(PathBuf::from);
            cards::import::run(&pool, &cfg, oracle, default, rulings).await
        }
        Some("import-calendar") => calendar::run_once(&pool).await,
        Some("import-decks") => {
            let dir = args.get(1).context("usage: yama-server import-decks DIR --owner EMAIL")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            decks::import_dir(&pool, std::path::Path::new(dir), &owner).await
        }
        Some("import-plan") => {
            let file = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-plan FILE --owner EMAIL [--dry-run] [--force]")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let dry_run = args.iter().any(|a| a == "--dry-run");
            let force = args.iter().any(|a| a == "--force");
            let report = plan::import::import_file(&pool, std::path::Path::new(file), &owner, dry_run, force).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("import-precons") => {
            let index = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-precons INDEX [--playgroup FILE]")?;
            let playgroup = flag_value(&args, "--playgroup").map(PathBuf::from);
            let r = lab::import_precons(&pool, std::path::Path::new(index), playgroup.as_deref()).await?;
            println!(
                "precons: {} added, {} updated, {} unchanged; {} lists that aren't precons skipped; {} repeats the index leaves out",
                r.added, r.updated, r.unchanged, r.skipped, r.left_out
            );
            if !r.unresolved.is_empty() {
                println!("{} card names Yama's card data doesn't know (kept without an oracle id):", r.unresolved.len());
                for n in &r.unresolved {
                    println!("  {n}");
                }
            }
            if !r.not_in_index.is_empty() {
                println!("in Yama but not in this index (left as they are): {}", r.not_in_index.join(", "));
            }
            Ok(())
        }
        Some("import-lab") => {
            let summary = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-lab SUMMARY [--owner EMAIL] [--name NAME]")?;
            let owner = flag_value(&args, "--owner");
            let name = flag_value(&args, "--name");
            let r = lab::import_run(&pool, std::path::Path::new(summary), owner.as_deref(), name.as_deref()).await?;
            let scope = owner.map_or("global".to_string(), |o| format!("owned by {o}"));
            println!("run {} ({}, {scope}): {}, {} decks rated; id {}", r.name, r.kind, r.outcome, r.ratings, r.id);
            Ok(())
        }
        Some("backup") => {
            // A consistent copy of the live database (safe while the server runs).
            let to = args.get(1).context("usage: yama-server backup FILE")?;
            sqlx::query("VACUUM INTO ?").bind(to).execute(&pool).await?;
            println!("backed up to {to}");
            Ok(())
        }
        Some("invite") => {
            let email = args.get(1).context("usage: yama-server invite EMAIL")?;
            auth::add_invite(&pool, email, None).await?;
            println!("invited {email}");
            Ok(())
        }
        Some("user") => match args.get(1).map(String::as_str) {
            Some("add") => {
                let email = args.get(2).filter(|a| !a.starts_with("--")).context("usage: yama-server user add EMAIL")?;
                let password = if args.iter().any(|a| a == "--password-stdin") {
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line)?;
                    Some(line.trim_end_matches(['\r', '\n']).to_string())
                } else {
                    None
                };
                let admin = args.iter().any(|a| a == "--admin");
                let generated = auth::add_local_user(&pool, email, flag_value(&args, "--name").as_deref(), admin, password).await?;
                println!("{email} can sign in with a password{}", if admin { " (admin)" } else { "" });
                if let Some(p) = generated {
                    println!("password: {p}");
                    println!("It isn't stored anywhere readable; run this again to set a new one.");
                }
                Ok(())
            }
            Some("remove-password") => {
                let email = args.get(2).context("usage: yama-server user remove-password EMAIL")?;
                if auth::remove_local_password(&pool, email).await? {
                    println!("{email} can no longer sign in with a password");
                } else {
                    println!("{email} had no password");
                }
                Ok(())
            }
            Some(cmd @ ("disable" | "enable")) => {
                let email = args.get(2).with_context(|| format!("usage: yama-server user {cmd} EMAIL"))?;
                let disable = cmd == "disable";
                if auth::set_disabled_by_email(&pool, email, disable).await? {
                    if disable {
                        println!("{email} is turned off: signed out everywhere, and sign-in is refused");
                    } else {
                        println!("{email} can sign in again");
                    }
                } else {
                    println!("there's no account for {email}");
                }
                Ok(())
            }
            Some("list") => auth::list_users(&pool).await,
            _ => {
                eprintln!("{USAGE}");
                std::process::exit(2);
            }
        },
        Some(_) => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}
