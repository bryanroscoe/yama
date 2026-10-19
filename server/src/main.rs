mod auth;
mod cards;
mod collection;
mod config;
mod db;
mod deck_checks;
mod decks;
mod error;
mod game_export;
mod games;
mod play;
mod playgroups;
mod routes;
mod stats;
mod table_rooms;
mod util;

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
  yama-server import-decks DIR --owner EMAIL Import every .txt deck list in DIR
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
            let rulings = flag_value(&args, "--rulings").map(PathBuf::from);
            cards::import::run(&pool, &cfg, oracle, default, rulings).await
        }
        Some("import-decks") => {
            let dir = args.get(1).context("usage: yama-server import-decks DIR --owner EMAIL")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            decks::import_dir(&pool, std::path::Path::new(dir), &owner).await
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
