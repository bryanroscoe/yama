mod admin;
mod advisor;
mod auth;
mod bridges;
mod calendar;
mod cards;
mod collection;
mod config;
mod db;
mod datasets;
mod deck_checks;
mod deck_prices;
mod deck_research;
mod deck_scan;
mod deck_stats;
mod derived;
mod deck_import;
mod decks;
mod error;
mod game_export;
mod games;
mod lab;
mod limits;
mod mcp;
mod oauth;
mod play;
mod plan;
mod people;
mod perf;
mod playgroups;
mod precon_evidence;
mod prices;
mod public_page;
mod public_commanders;
mod public_precons;
#[cfg(test)]
mod privacy_tests;
mod routes;
mod scan;
mod sharing;
#[cfg(test)]
mod signup_tests;
mod stats;
mod table_rooms;
#[cfg(test)]
mod testutil;
mod util;
mod upgradeability;
mod view_as;
#[cfg(test)]
mod view_as_tests;
mod watch;
mod web_files;

use anyhow::Context;
use std::io::IsTerminal;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// mimalloc, as the lab's batch runner uses. On glibc's malloc the server held 2.5 GB with one lab
/// game playing (it starts at 0.7 GB), reached its 3 GB container cap, and every allocation then
/// waited on the kernel reclaiming pages: games that play in a minute or two on the batch runner
/// ran out of CPU time at turn 7 or were written off as hung (2026-10-23, run 7cc7910c). glibc
/// keeps freed memory in per-thread arenas; mimalloc gives it back.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const USAGE: &str = "\
yama-server — Yama backend

USAGE:
  yama-server serve                          Run the HTTP server
  yama-server import-cards [--oracle FILE] [--default FILE] [--rulings FILE]
                                             Import Scryfall bulk data and rulings
                                             (downloads the latest files unless both
                                             card files are given)
  yama-server import-deck-prices             Refresh sealed precon market prices once
  yama-server import-calendar                Refresh upcoming sets (Scryfall) and Commander
                                             precon lists (MTGJSON) once
  yama-server import-decks DIR --owner EMAIL [--update]
                                             Import every .txt deck list in DIR, each named
                                             after its file (Riders_of_Rohan.txt is Riders
                                             of Rohan), with the printings it names. A name
                                             a deck already has is skipped; with --update it
                                             becomes a new version of that deck (any case),
                                             unless the cards are the same
  yama-server deck archive --owner EMAIL --deck NAME
                                             Archive a deck (any case; its games stay)
  yama-server deck rename --owner EMAIL --deck NAME --to NEW
                                             Rename a deck
  yama-server collection add-deck --owner EMAIL --deck NAME [--move-same-printing |
                              --skip-same-printing] [--dry-run] [--json]
                                             Put the deck's cards in its deck box (made and
                                             linked if it has none), as Add to my
                                             collection does on the web: each card in the printing the
                                             deck names, else a default, proxies as proxies.
                                             Copies of the same printing in other boxes and
                                             binders are left there and new copies added,
                                             unless --move-same-printing moves them in or
                                             --skip-same-printing leaves those cards out.
                                             Running it again adds nothing. Prints what it
                                             does (or would, with --dry-run)
  yama-server import-mythic FILE --owner EMAIL [--dry-run] [--remove-missing] [--json]
                                             Import a Mythic Tools CSV export as the web
                                             does: adds only copies the file has more of
                                             than Yama (a newer export doesn't double
                                             anything; the same file adds nothing).
                                             --remove-missing also removes copies the file
                                             no longer lists from the containers it names
  yama-server import-plan FILE --owner EMAIL [--dry-run] [--force]
                                             Import a yama-plan/1 file (docs/plan-format.md)
                                             as EMAIL's plan, the same way the web upload
                                             does; prints the import report
  yama-server import-research FILE --owner EMAIL [--dry-run]
                                             Store private yama-research/1 notes for review;
                                             never changes decks, plans or collection cards
  yama-server research share --owner EMAIL --id ID --visibility private|link|public [--reset-link]
                                             Who can see one of EMAIL's research notes:
                                             only them, anyone with /r/<token>, or that and
                                             listed on their profile; prints the link.
                                             --reset-link makes a new link (old ones stop)
  yama-server import-dataset FILE --owner EMAIL [--dry-run]
                                             Import a private versioned yama-dataset/1
                                             JSON or gzip document; never publishes data
  yama-server commander-evidence report | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL
                                             Choose which of EMAIL's dataset sources feed the
                                             public /commanders ranking; report shows it
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
  yama-server publish-precons MANIFEST        Publish a reviewed stock-precon ranking snapshot
                                             (docs/public-precons.md); never automatic on import
  yama-server withdraw-precons               Withdraw the public ranking, keeping the catalog
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
  yama-server user session EMAIL [--hours N]  Print a session token for EMAIL's existing
                                             account, good for N hours (default 2, at most
                                             24), for the polish screenshots (docs/polish.md)
  yama-server advisor share EMAIL [--daily N] [--by ADMIN_EMAIL]
                                             Let EMAIL ask Claude on the shared API key
                                             (advisor/shared.rs), N questions a day (else
                                             the usual allowance); in the name of --by,
                                             else the first YAMA_ADMIN_EMAILS account
  yama-server advisor unshare EMAIL          Take the shared key away from EMAIL
  yama-server advisor shared                 Who has it, and this month's spend
  yama-server backup FILE                    Write a consistent copy of the database (prices and
                                             their history included)
  yama-server prices backfill                Replay the old daily price table into the price
                                             history now (the server does it once at start)
  yama-server prices verify [DATE]           Check the price history against the old daily
                                             table, every day or one (YYYY-MM-DD); read only

Configuration comes from the environment; see .env.example.";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("lab-worker-info") {
        let path = args.get(1).context("usage: yama-server lab-worker-info CARD_DATA")?;
        println!("{}", lab::remote::runtime_info(std::path::Path::new(path))?);
        return Ok(());
    }
    // The game child has no database, credentials, HTTP server or application background jobs.
    if args.first().map(String::as_str) == Some("lab-game") {
        tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter("info").init();
        let path = args.get(1).context("usage: yama-server lab-game CARD_DATA < request.json")?;
        return lab::process::child_main(PathBuf::from(path));
    }
    // Plain text when the log isn't a terminal (`docker logs`), so it can be searched; sqlx's slow
    // statements on one line, and copied into the perf summary (`perf.rs`).
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,yama_server=debug".into()))
        .with(tracing_subscriber::fmt::layer().fmt_fields(perf::LogFields).with_ansi(std::io::stdout().is_terminal()))
        .with(perf::SlowStatements)
        .init();

    let cfg = config::Config::from_env()?;
    perf::configure(cfg.slow_request_ms, cfg.slow_query_ms);
    let pool = db::connect(&cfg.database_url, std::time::Duration::from_millis(cfg.slow_query_ms)).await?;

    match args.first().map(String::as_str) {
        Some("serve") | None => routes::serve(cfg, pool).await,
        Some("import-cards") => {
            let oracle = flag_value(&args, "--oracle").map(PathBuf::from);
            let default = flag_value(&args, "--default").map(PathBuf::from);
            let rulings = flag_value(&args, "--rulings").map(PathBuf::from);
            cards::import::run(&pool, &cfg, oracle, default, rulings).await
        }
        Some("import-deck-prices") => deck_prices::refresh(&pool, &routes::http_client()).await,
        Some("import-calendar") => calendar::run_once(&pool).await,
        Some("import-decks") => {
            let dir = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-decks DIR --owner EMAIL [--update]")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let update = args.iter().any(|a| a == "--update");
            decks::cli::import_dir(&pool, std::path::Path::new(dir), &owner, update).await.map(|_| ())
        }
        Some("deck") => {
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let deck = flag_value(&args, "--deck").context("--deck NAME is required")?;
            let done = match args.get(1).map(String::as_str) {
                Some("archive") => decks::cli::archive(&pool, &owner, &deck).await?,
                Some("rename") => {
                    let to = flag_value(&args, "--to").context("--to NEW is required")?;
                    decks::cli::rename(&pool, &owner, &deck, &to).await?
                }
                _ => anyhow::bail!("usage: yama-server deck archive|rename --owner EMAIL --deck NAME [--to NEW]"),
            };
            println!("{done}");
            Ok(())
        }
        Some("collection") => match args.get(1).map(String::as_str) {
            Some("add-deck") => collection::deck_box::cli(&pool, &args[2..]).await,
            _ => anyhow::bail!("usage: yama-server collection add-deck --owner EMAIL --deck NAME [--move-same-printing] [--dry-run]"),
        },
        Some("import-mythic") => {
            let file = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-mythic FILE --owner EMAIL [--dry-run] [--remove-missing] [--json]")?;
            let owner = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let owner = decks::cli::owner_id(&pool, &owner).await?;
            let opts = collection::mythic::ImportOptions {
                dry_run: args.iter().any(|a| a == "--dry-run"),
                remove_missing: args.iter().any(|a| a == "--remove-missing"),
            };
            let text = std::fs::read_to_string(file).with_context(|| format!("reading {file}"))?;
            let report = collection::mythic::import_mythic_csv(&pool, &owner, &text, opts).await.map_err(|e| anyhow::anyhow!("{e}"))?;
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", collection::mythic::text(&report));
            }
            Ok(())
        }
        Some("import-dataset") => {
            let file=args.get(1).filter(|a|!a.starts_with("--")).context("usage: yama-server import-dataset FILE --owner EMAIL [--dry-run]")?;
            let email=flag_value(&args,"--owner").context("--owner EMAIL is required")?;
            datasets::cli(&pool,file,&email,args.iter().any(|a|a=="--dry-run")).await
        }
        Some("precon-evidence") => precon_evidence::cli(&pool, &args[1..]).await,
        Some("commander-evidence") => public_commanders::cli(&pool, &args[1..]).await,
        Some("import-research") => {
            let file = args.get(1).filter(|a| !a.starts_with("--")).context("usage: yama-server import-research FILE --owner EMAIL [--dry-run]")?;
            let email = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let owner = decks::cli::owner_id(&pool, &email).await?;
            let bytes = std::fs::read(file).with_context(|| format!("reading {file}"))?;
            anyhow::ensure!(bytes.len()<=deck_research::MAX_BYTES,"research file exceeds 4 MiB");
            let doc:serde_json::Value=serde_json::from_slice(&bytes)?;
            let targets=deck_research::validate(&doc).map_err(|e|anyhow::anyhow!("{e}"))?;
            if args.iter().any(|a| a=="--dry-run") {
                println!("{}",serde_json::json!({"valid":true,"id":doc["id"],"decks":doc["decks"].as_array().unwrap().len(),"review_targets":targets,"dry_run":true}));
            } else {
                println!("{}",deck_research::save(&pool,&owner,&doc).await.map_err(|e|anyhow::anyhow!("{e}"))?);
            }
            Ok(())
        }
        Some("research") => {
            anyhow::ensure!(args.get(1).map(String::as_str) == Some("share"), "usage: yama-server research share --owner EMAIL --id ID --visibility private|link|public [--reset-link]");
            let email = flag_value(&args, "--owner").context("--owner EMAIL is required")?;
            let id = flag_value(&args, "--id").context("--id ID is required")?;
            let visibility = flag_value(&args, "--visibility").context("--visibility private|link|public is required")?;
            let owner = decks::cli::owner_id(&pool, &email).await?;
            let err = |e: error::AppError| anyhow::anyhow!("{e}");
            // A bad visibility changes nothing, the link included.
            sharing::visibility(&visibility).map_err(err)?;
            if args.iter().any(|a| a == "--reset-link") {
                deck_research::reset_link(&pool, &owner, &id).await.map_err(err)?;
            }
            println!("{}", deck_research::set_visibility(&pool, &owner, &id, &visibility).await.map_err(err)?);
            Ok(())
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
        Some("publish-precons") => {
            let file = args.get(1).context("usage: yama-server publish-precons MANIFEST")?;
            let id = public_precons::publish_file(&pool, std::path::Path::new(file)).await?;
            println!("published precon ranking {id}");
            Ok(())
        }
        Some("withdraw-precons") => {
            public_precons::withdraw(&pool).await?;
            println!("public ranking withdrawn; the stock catalog remains available");
            Ok(())
        }
        Some("prices") => match args.get(1).map(String::as_str) {
            Some("backfill") => {
                let _writer = prices::PRICE_WRITER.lock().await;
                let days = prices::backfill::backfill_if_needed(&pool).await.map_err(|e| anyhow::anyhow!("{e}"))?;
                println!("replayed {days} days");
                println!("{}", serde_json::to_string(&prices::backfill::verify(&pool, None).await.map_err(|e| anyhow::anyhow!("{e}"))?)?);
                Ok(())
            }
            Some("verify") => {
                let date = args.get(2).map(String::as_str);
                let v = prices::backfill::verify(&pool, date).await.map_err(|e| anyhow::anyhow!("{e}"))?;
                println!("{}", serde_json::to_string(&v)?);
                anyhow::ensure!(v.mismatches == 0 && v.stale == 0, "the price history doesn't match the old table");
                Ok(())
            }
            _ => anyhow::bail!("usage: yama-server prices backfill | prices verify [DATE]"),
        },
        Some("backup") => {
            // A consistent copy of the live database (safe while the server runs).
            let to = args.get(1).context("usage: yama-server backup FILE")?;
            let job = perf::Job::start("backup", std::time::Duration::from_secs(60));
            let r = sqlx::query("VACUUM INTO ?").bind(to).execute(&pool).await;
            job.finish(&r, "");
            r?;
            println!("backed up to {to}");
            Ok(())
        }
        Some("invite") => {
            let email = args.get(1).context("usage: yama-server invite EMAIL")?;
            auth::add_invite(&pool, email, None).await?;
            println!("invited {email}");
            Ok(())
        }
        Some("advisor") => advisor::shared::cli(&pool, &cfg, &args[1..]).await,
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
            Some("session") => {
                let email = args.get(2).filter(|a| !a.starts_with("--")).context("usage: yama-server user session EMAIL [--hours N]")?;
                let hours = flag_value(&args, "--hours").map(|h| h.parse::<i64>()).transpose().context("--hours takes a whole number")?.unwrap_or(2);
                // Only the token on stdout, so a script can read it (web/scripts/polish).
                println!("{}", auth::cli_session(&pool, email, hours).await?);
                eprintln!("A session for {email}, good for {hours} hours. It signs in as them: keep it private.");
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
