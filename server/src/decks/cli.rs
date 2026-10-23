//! Deck commands for the server's command line (`main.rs`): `import-decks` and `deck archive` /
//! `deck rename`. They fix up someone's decks from the server (Bryan's from saget), so they match
//! deck names the way people type them (any case) and refuse a name that fits two decks.

use super::{Board, DeckCard, create_deck_with_cards, find_by_name, insert_version, load_version_cards};
use crate::deck_import::{read_list, save_prints};
use anyhow::{Context, bail};
use sqlx::SqlitePool;
use std::collections::BTreeMap;

/// The account for `email`, which must have signed in once.
pub async fn owner_id(pool: &SqlitePool, email: &str) -> anyhow::Result<String> {
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = lower(trim(?))").bind(email).fetch_optional(pool).await?;
    id.with_context(|| format!("no user {email}; sign in once first"))
}

/// The live deck called `name` (any case), or a message saying why there isn't exactly one.
pub async fn deck_id(pool: &SqlitePool, owner: &str, name: &str) -> anyhow::Result<(String, String)> {
    match find_by_name(pool, owner, name).await.map_err(|e| anyhow::anyhow!("{e}"))? {
        Some(hit) => Ok(hit),
        None => bail!("no deck called {name:?} (archived decks don't count)"),
    }
}

/// What `import-decks` did with one file.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Created { cards: i64 },
    /// `--update`: a new version of `deck` (its name as saved). `printings` counts the printings
    /// saved with it.
    Updated { deck: String, added: i64, removed: i64, printings: usize },
    /// `--update`: the same cards as the deck's current version (no new version). Printings the
    /// file names are still kept.
    Unchanged { deck: String, printings: usize },
    /// Without `--update`, a live deck already has exactly this name.
    Skipped,
    /// `--update`, and two live decks have the name (any case).
    Ambiguous(String),
    Empty,
}

/// `import-decks DIR --owner EMAIL [--update]`: every `.txt` list in `dir`, named after its file
/// (`Riders_of_Rohan.txt` is "Riders of Rohan"). Lists are read as the web import reads them, with
/// the printings they name (`deck_import::read_list`).
///
/// Without `update` a file whose name is already a live deck's (exactly, as before 2026-10-23) is
/// skipped. With `update` a file whose name matches a live deck's in any case becomes a new
/// version of it, unless the cards are the same; a file matching none makes a new deck.
pub async fn import_dir(pool: &SqlitePool, dir: &std::path::Path, owner_email: &str, update: bool) -> anyhow::Result<Vec<(String, Outcome)>> {
    let owner = owner_id(pool, owner_email).await?;
    let mut paths: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let name = path.file_stem().unwrap().to_string_lossy().replace('_', " ");
        let text = std::fs::read_to_string(&path)?;
        let file_name = path.file_name().map(|f| f.to_string_lossy().to_string());
        let outcome = import_one(pool, &owner, &name, &text, file_name.as_deref(), update).await?;
        print_outcome(&name, &outcome);
        out.push((name, outcome));
    }
    Ok(out)
}

async fn import_one(pool: &SqlitePool, owner: &str, name: &str, text: &str, file_name: Option<&str>, update: bool) -> anyhow::Result<Outcome> {
    let target = if update {
        match find_by_name(pool, owner, name).await {
            Ok(hit) => hit,
            Err(e) => return Ok(Outcome::Ambiguous(e.to_string())),
        }
    } else {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = ? AND name = ? AND archived = 0")
            .bind(owner)
            .bind(name)
            .fetch_optional(pool)
            .await?;
        if exists.is_some() {
            return Ok(Outcome::Skipped);
        }
        None
    };
    let Some(list) = read_list(pool, text, file_name).await.map_err(|e| anyhow::anyhow!("{e}"))?.into_iter().next() else {
        return Ok(Outcome::Empty);
    };
    if list.cards.is_empty() {
        return Ok(Outcome::Empty);
    }
    if !list.unknown.is_empty() {
        println!("  {name}: no card matches {} (left out)", list.unknown.join(", "));
    }
    let Some((deck_id, deck)) = target else {
        let cards = list.cards.iter().map(|c| c.qty).sum();
        let id = create_deck_with_cards(pool, owner, name, Some("commander-decks"), list.cards).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        save_prints(pool, &id, &list.prints).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        return Ok(Outcome::Created { cards });
    };
    let current: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&deck_id).fetch_one(pool).await?;
    let old = match &current {
        Some(v) => load_version_cards(pool, v).await.map_err(|e| anyhow::anyhow!("{e}"))?,
        None => vec![],
    };
    let (added, removed) = changes(&old, &list.cards);
    save_prints(pool, &deck_id, &list.prints).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    if added == 0 && removed == 0 && current.is_some() {
        return Ok(Outcome::Unchanged { deck, printings: list.prints.len() });
    }
    let note = format!("updated from {}", file_name.unwrap_or("a file"));
    insert_version(pool, &deck_id, &list.cards, Some(&note)).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Outcome::Updated { deck, added, removed, printings: list.prints.len() })
}

/// Copies going in and out between two lists, by card and board (a new commander counts).
pub fn changes(old: &[DeckCard], new: &[DeckCard]) -> (i64, i64) {
    let tally = |cards: &[DeckCard]| {
        let mut m: BTreeMap<(String, String), i64> = BTreeMap::new();
        for c in cards {
            let board = match c.board {
                Board::Commander => "commander",
                Board::Main => "main",
                Board::Side => "side",
            };
            *m.entry((board.to_string(), c.oracle_id.clone())).or_insert(0) += c.qty;
        }
        m
    };
    let (before, after) = (tally(old), tally(new));
    let added = after.iter().map(|(k, n)| (n - before.get(k).copied().unwrap_or(0)).max(0)).sum();
    let removed = before.iter().map(|(k, n)| (n - after.get(k).copied().unwrap_or(0)).max(0)).sum();
    (added, removed)
}

fn print_outcome(name: &str, o: &Outcome) {
    match o {
        Outcome::Created { cards } => println!("imported {name}: {cards} cards"),
        Outcome::Updated { deck, added, removed, printings } => {
            println!("updated {deck} (from {name}): new version, {added} in, {removed} out, {printings} printings kept")
        }
        Outcome::Unchanged { deck, printings } => println!("unchanged {deck} (from {name}): same cards, no new version ({printings} printings kept)"),
        Outcome::Skipped => println!("skip {name}: already imported (--update makes a new version)"),
        Outcome::Ambiguous(why) => println!("skip {name}: {why}"),
        Outcome::Empty => println!("skip {name}: no cards in the file"),
    }
}

/// `deck archive --owner EMAIL --deck NAME`.
pub async fn archive(pool: &SqlitePool, owner_email: &str, deck: &str) -> anyhow::Result<String> {
    let owner = owner_id(pool, owner_email).await?;
    let (id, name) = deck_id(pool, &owner, deck).await?;
    super::archive(pool, &owner, &id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(format!("archived {name} ({id}); its versions and games stay"))
}

/// `deck rename --owner EMAIL --deck NAME --to NEW`. Refuses a new name another live deck has,
/// so later commands can still tell them apart.
pub async fn rename(pool: &SqlitePool, owner_email: &str, deck: &str, to: &str) -> anyhow::Result<String> {
    let owner = owner_id(pool, owner_email).await?;
    let (id, name) = deck_id(pool, &owner, deck).await?;
    if let Some((other, other_name)) = find_by_name(pool, &owner, to).await.map_err(|e| anyhow::anyhow!("{e}"))?
        && other != id
    {
        bail!("another deck is already called {other_name:?} ({other})");
    }
    super::rename(pool, &owner, &id, to).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(format!("renamed {name} to {} ({id})", to.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_import::deck_prints;

    async fn seed(pool: &SqlitePool) -> String {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','bryan@example.com','Bryan','now')").execute(pool).await.unwrap();
        for (oid, name, tl, set, num) in [
            ("o-omo", "Omo, Queen of Vesuva", "Legendary Creature — Shapeshifter", "m3c", "2"),
            ("o-sol", "Sol Ring", "Artifact", "c21", "263"),
            ("o-sig", "Arcane Signet", "Artifact", "c21", "236"),
        ] {
            sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES (?,?,?,'now')").bind(oid).bind(name).bind(tl).execute(pool).await.unwrap();
            sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?,?)").bind(name).bind(oid).execute(pool).await.unwrap();
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?,?,?,?,'S',?,'en','[\"nonfoil\",\"foil\"]','now')")
                .bind(format!("p-{set}-{num}"))
                .bind(oid)
                .bind(name)
                .bind(set)
                .bind(num)
                .execute(pool)
                .await
                .unwrap();
        }
        "u1".into()
    }

    fn dir(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (name, text) in files {
            std::fs::write(d.path().join(name), text).unwrap();
        }
        d
    }

    async fn versions(pool: &SqlitePool, deck: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?").bind(deck).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn update_makes_a_version_with_printings_and_skips_unchanged_lists() {
        let pool = crate::db::test_pool().await;
        let owner = seed(&pool).await;
        let first = dir(&[("Tricky_Terrain.txt", "1 Omo, Queen of Vesuva\n1 Sol Ring\n")]);
        let r = import_dir(&pool, first.path(), "bryan@example.com", false).await.unwrap();
        assert_eq!(r, vec![("Tricky Terrain".to_string(), Outcome::Created { cards: 2 })]);
        let (id, _) = find_by_name(&pool, &owner, "tricky terrain").await.unwrap().unwrap();
        let cards = load_version_cards(&pool, &sqlx::query_scalar::<_, String>("SELECT current_version_id FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap()).await.unwrap();
        assert!(cards.iter().any(|c| c.name == "Omo, Queen of Vesuva" && c.board == Board::Commander));

        // Without --update the same name is skipped, as before.
        let again = import_dir(&pool, first.path(), "bryan@example.com", false).await.unwrap();
        assert_eq!(again[0].1, Outcome::Skipped);

        // --update with a new card and a printing, under a lower-case file name.
        let newer = dir(&[("tricky_terrain.txt", "Commander\n1 Omo, Queen of Vesuva (M3C) 2\n\nDeck\n1 Sol Ring (C21) 263 *F*\n1 Arcane Signet\n")]);
        let r = import_dir(&pool, newer.path(), "bryan@example.com", true).await.unwrap();
        assert_eq!(r[0].1, Outcome::Updated { deck: "Tricky Terrain".into(), added: 1, removed: 0, printings: 2 });
        assert_eq!(versions(&pool, &id).await, 2);
        let prints = deck_prints(&pool, &id).await.unwrap();
        assert_eq!(prints["o-sol"].set_code, "c21");
        assert_eq!(prints["o-sol"].finish, "foil");

        // The same list again adds no version.
        let r = import_dir(&pool, newer.path(), "bryan@example.com", true).await.unwrap();
        assert_eq!(r[0].1, Outcome::Unchanged { deck: "Tricky Terrain".into(), printings: 2 });
        assert_eq!(versions(&pool, &id).await, 2);
        let decks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks").fetch_one(&pool).await.unwrap();
        assert_eq!(decks, 1);
    }

    #[tokio::test]
    async fn update_refuses_a_name_two_decks_share() {
        let pool = crate::db::test_pool().await;
        let owner = seed(&pool).await;
        for name in ["Tricky Terrain", "tricky terrain"] {
            create_deck_with_cards(&pool, &owner, name, None, vec![]).await.unwrap();
        }
        let d = dir(&[("Tricky_Terrain.txt", "1 Omo, Queen of Vesuva\n")]);
        let r = import_dir(&pool, d.path(), "bryan@example.com", true).await.unwrap();
        assert!(matches!(&r[0].1, Outcome::Ambiguous(why) if why.contains("2 decks")), "{r:?}");
        assert!(archive(&pool, "bryan@example.com", "TRICKY TERRAIN").await.unwrap_err().to_string().contains("2 decks"));
    }

    #[tokio::test]
    async fn archive_and_rename_by_name() {
        let pool = crate::db::test_pool().await;
        let owner = seed(&pool).await;
        let a = create_deck_with_cards(&pool, &owner, "Riders of Rohan", None, vec![]).await.unwrap();
        create_deck_with_cards(&pool, &owner, "Fantastic Four", None, vec![]).await.unwrap();

        assert!(rename(&pool, "bryan@example.com", "riders of rohan", "fantastic four").await.unwrap_err().to_string().contains("already called"));
        assert!(rename(&pool, "bryan@example.com", "riders of rohan", "  ").await.is_err());
        rename(&pool, "bryan@example.com", "riders of rohan", "Rohan Riders").await.unwrap();
        let name: String = sqlx::query_scalar("SELECT name FROM decks WHERE id = ?").bind(&a).fetch_one(&pool).await.unwrap();
        assert_eq!(name, "Rohan Riders");

        archive(&pool, "bryan@example.com", "rohan riders").await.unwrap();
        let archived: bool = sqlx::query_scalar("SELECT archived FROM decks WHERE id = ?").bind(&a).fetch_one(&pool).await.unwrap();
        assert!(archived);
        // Archived decks aren't found by name any more, so a new deck can take it.
        assert!(archive(&pool, "bryan@example.com", "Rohan Riders").await.unwrap_err().to_string().contains("no deck"));
        assert!(archive(&pool, "nobody@example.com", "Fantastic Four").await.unwrap_err().to_string().contains("no user"));
    }
}
