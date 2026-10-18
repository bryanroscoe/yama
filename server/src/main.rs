mod auth;
mod cards;
mod collection;
mod config;
mod db;
mod decks;
mod error;
mod games;
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
  yama-server invite EMAIL                   Allow EMAIL to sign in

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
        Some("invite") => {
            let email = args.get(1).context("usage: yama-server invite EMAIL")?;
            auth::add_invite(&pool, email, None).await?;
            println!("invited {email}");
            Ok(())
        }
        Some(_) => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}
