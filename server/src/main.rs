mod auth;
mod cards;
mod collection;
mod config;
mod db;
mod decks;
mod error;
mod games;
mod lab;
mod play;
mod playgroups;
mod routes;
mod table_rooms;
mod util;

use anyhow::Context;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
yama-server — Yama backend

USAGE:
  yama-server serve                          Run the HTTP server
  yama-server import-cards [--oracle FILE] [--default FILE]
                                             Import Scryfall bulk data (downloads the
                                             latest files when no FILE is given)
  yama-server import-decks DIR --owner EMAIL Import every .txt deck list in DIR
  yama-server import-precons INDEX [--playgroup FILE]
                                             Import the Commander precon catalog from
                                             commander-decks data/sim/decks/index.json and
                                             the deck files beside it
  yama-server import-lab SUMMARY [--owner EMAIL] [--name NAME]
                                             Import an analysed lab run (summary.json from
                                             commander-decks scripts/sim/analyze.py); global
                                             unless --owner is given
  yama-server invite EMAIL                   Allow EMAIL to sign in
  yama-server user add EMAIL [--name NAME] [--admin] [--password-stdin]
                                             Give EMAIL a password for password sign-in
                                             (creates the account; prints a generated
                                             password unless one is piped in)
  yama-server user remove-password EMAIL     Turn off password sign-in for EMAIL
  yama-server user list                      Every account and how it signs in
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
            cards::import::run(&pool, &cfg, oracle, default).await
        }
        Some("import-decks") => {
            let dir = args.get(1).context("usage: yama-server import-decks DIR --owner EMAIL")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            decks::import_dir(&pool, std::path::Path::new(dir), &owner).await
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
