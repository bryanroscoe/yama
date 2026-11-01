//! Deleting an account and everything it owns (admin area, People). The public privacy policy
//! (`web/public/privacy/index.html`) promises this on request.
//!
//! **What goes.** Every row the account owns: sessions, script keys, OAuth connections (grants,
//! their tokens and codes), its invite, decks and their
//! versions and checks, the collection and containers, synced ops, plans (every `plan_*` table),
//! lab runs, experiments and usage, advisor keys, settings, conversations, usage and its shared-key grant, online-play settings, calendar
//! watches, records of table games it deleted, "View as" sessions of it or by it (the audit rows go too), and the account itself. Its watched games stop, and any live online game it is in
//! ends.
//!
//! **What stays, anonymised, because other people's records depend on it:**
//! - A playgroup it owns passes to the longest-standing other account member. A playgroup with no
//!   other account member is deleted (its guest members with it); games in it stay if they are
//!   kept for another reason, without the group.
//! - Its membership in other people's playgroups becomes a guest member named "Former member", so
//!   the group's game history and stats still add up.
//! - A game it logged stays when another account sat in it or it belongs to a playgroup that
//!   lives on; the game passes to that other account (else the group's owner). Other games it
//!   logged are deleted.
//! - In every game that stays, its seat loses the account (named "Former player" unless it was a
//!   member seat), and seats lose links to its deck versions (the commander name stays).
//! - Online games it hosted or sat in lose their lobby, replay and log (`online_games`); a game
//!   kept for others that was still going is marked abandoned.
//! - Invites it sent stay, without its name on them; so do shared-key grants it made as an admin.
//!
//! Every column that can hold an account id is listed in [`USER_COLUMNS`]; a test compares that
//! list with the schema (foreign keys to `users` plus owner-like column names), so a new table
//! that forgets this fails the build's tests. `online_games.seats` (JSON) holds account ids too and
//! is handled by hand. With foreign keys on, the final `DELETE FROM users` also fails, rolling the
//! whole transaction back, if anything still points at the account.

use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde::Serialize;
use sqlx::{Sqlite, Transaction};

/// Every (table, column) that can hold an account id. Keep this in step with [`delete_rows`].
pub const USER_COLUMNS: &[(&str, &str)] = &[
    ("advisor_conversations", "owner_id"),
    ("advisor_keys", "user_id"),
    ("advisor_messages", "owner_id"),
    ("advisor_settings", "user_id"),
    ("advisor_shared_access", "granted_by"),
    ("advisor_shared_access", "user_id"),
    ("advisor_usage", "owner_id"),
    ("api_tokens", "owner_id"),
    ("applied_ops", "owner_id"),
    ("assistant_changes", "owner_id"),
    ("calendar_watches", "user_id"),
    ("collection_items", "owner_id"),
    ("containers", "owner_id"),
    ("decks", "owner_id"),
    ("deleted_games", "deleted_by"),
    ("evidence_datasets", "owner_id"),
    ("game_seats", "user_id"),
    ("games", "created_by"),
    ("invites", "invited_by"),
    ("item_aliases", "owner_id"),
    ("lab_execution_runs", "owner_id"),
    ("lab_experiments", "owner_id"),
    ("lab_runs", "owner_id"),
    ("lab_usage", "owner_id"),
    ("lab_worker_instances", "owner_id"),
    ("mythic_game_notes", "owner_id"),
    ("mythic_imports", "owner_id"),
    ("mythic_links", "owner_id"),
    ("oauth_codes", "user_id"),
    ("oauth_grants", "user_id"),
    ("online_games", "host_id"),
    ("plan_decks", "owner_id"),
    ("plan_imports", "owner_id"),
    ("plan_inputs", "owner_id"),
    ("plan_key_aliases", "owner_id"),
    ("plan_marks", "owner_id"),
    ("plan_meta", "owner_id"),
    ("plan_order_items", "owner_id"),
    ("plan_orders", "owner_id"),
    ("plan_quotes", "owner_id"),
    ("plan_reviews", "owner_id"),
    ("plan_settings", "owner_id"),
    ("plan_states", "owner_id"),
    ("plan_stores", "owner_id"),
    ("plan_swaps", "owner_id"),
    ("play_prefs", "user_id"),
    ("playgroup_members", "user_id"),
    ("playgroups", "owner_id"),
    ("precon_evidence_sources", "owner_id"),
    ("precon_evidence_simulation", "owner_id"),
    ("research_reports", "owner_id"),
    ("research_review_ops", "owner_id"),
    ("research_reviews", "owner_id"),
    ("sessions", "user_id"),
    ("view_sessions", "admin_id"),
    ("view_sessions", "target_id"),
];

/// Tables the account's own rows are simply deleted from, children before parents. Tables that
/// need more than a delete (games, playgroups, online games, invites) are handled before these.
const OWNED_DELETES: &[(&str, &str)] = &[
    // The account stops feeding shared precon evidence along with its datasets.
    ("precon_evidence_sources", "owner_id"),
    // and its chosen simulation, whose tournaments go with it.
    ("precon_evidence_simulation", "owner_id"),
    ("evidence_datasets", "owner_id"),
    ("research_reviews", "owner_id"),
    ("research_review_ops", "owner_id"),
    ("research_reports", "owner_id"),
    ("sessions", "user_id"),
    // "View as" sessions it started or that viewed it, and so their audit rows.
    ("view_sessions", "admin_id"),
    ("view_sessions", "target_id"),
    // Worker jobs reference instances; remove runs (and their jobs) before instances and keys.
    ("lab_execution_runs", "owner_id"),
    ("lab_worker_instances", "owner_id"),
    ("api_tokens", "owner_id"),
    // OAuth: codes, then grants (their tokens go with them). Registered clients hold no account.
    ("oauth_codes", "user_id"),
    ("oauth_grants", "user_id"),
    ("calendar_watches", "user_id"),
    ("deleted_games", "deleted_by"),
    // Online play: saved stops and full control.
    ("play_prefs", "user_id"),
    ("assistant_changes", "owner_id"),
    ("advisor_messages", "owner_id"),
    ("advisor_conversations", "owner_id"),
    ("advisor_usage", "owner_id"),
    ("advisor_keys", "user_id"),
    ("advisor_settings", "user_id"),
    ("advisor_shared_access", "user_id"),
    // Plans: quotes point at swaps and stores; swaps at decks, orders and items; items at orders;
    // states at decks; plan decks at the account's decks.
    ("plan_quotes", "owner_id"),
    ("plan_inputs", "owner_id"),
    ("plan_reviews", "owner_id"),
    ("plan_marks", "owner_id"),
    ("plan_key_aliases", "owner_id"),
    ("plan_swaps", "owner_id"),
    ("plan_states", "owner_id"),
    ("plan_order_items", "owner_id"),
    ("plan_orders", "owner_id"),
    ("plan_stores", "owner_id"),
    ("plan_decks", "owner_id"),
    ("plan_settings", "owner_id"),
    ("plan_imports", "owner_id"),
    ("plan_meta", "owner_id"),
    // The lab: experiment games and run ratings go with their parents.
    ("lab_experiments", "owner_id"),
    ("lab_usage", "owner_id"),
    ("lab_runs", "owner_id"),
    // Collection and decks (versions and their checks go with the deck).
    ("collection_items", "owner_id"),
    ("containers", "owner_id"),
    ("item_aliases", "owner_id"),
    ("applied_ops", "owner_id"),
    // The Mythic Tools bridge: its links, and Mythic's notes kept for this account alone.
    ("mythic_game_notes", "owner_id"),
    ("mythic_links", "owner_id"),
    ("mythic_imports", "owner_id"),
    ("decks", "owner_id"),
];

/// What a deletion did, for the admin's confirmation and the server log.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct DeleteReport {
    pub email: String,
    /// Playgroups handed to another member.
    pub playgroups_passed_on: u64,
    /// Playgroups deleted (nobody else with an account was in them).
    pub playgroups_deleted: u64,
    /// Games logged by the account that stay for other people, under another account.
    pub games_kept: u64,
    /// Games logged by the account that were deleted.
    pub games_deleted: u64,
    /// Seats in other people's games that no longer name the account.
    pub seats_anonymised: u64,
    /// Online games whose lobby, replay and log were removed.
    pub online_games_removed: u64,
    /// Rows deleted from the account's own tables, all tables together.
    pub rows_deleted: u64,
}

/// Delete the account `id` and everything it owns, in one transaction. In-memory games (watched,
/// and live online games it is in) are stopped first. "Not found" when there's no such account.
pub async fn delete_account(st: &AppState, id: &str) -> AppResult<DeleteReport> {
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("account"))?;
    st.watch.remove_owner(id);
    for game in online_games_of(&st.pool, id).await? {
        st.play.stop(&game);
    }
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut report = delete_rows(&mut tx, id).await?;
    tx.commit().await?;
    report.email = email;
    Ok(report)
}

/// Online games the account hosts or has a seat in.
async fn online_games_of(pool: &sqlx::SqlitePool, id: &str) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT o.game_id FROM online_games o
          WHERE o.host_id = ?1 OR EXISTS (SELECT 1 FROM json_each(o.seats) j WHERE json_extract(j.value, '$.user_id') = ?1)",
    )
    .bind(id)
    .fetch_all(pool)
    .await?)
}

/// The deletion itself, inside the caller's transaction (tests call it directly).
pub async fn delete_rows(tx: &mut Transaction<'_, Sqlite>, id: &str) -> AppResult<DeleteReport> {
    let mut r = DeleteReport::default();
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = ?").bind(id).fetch_one(&mut **tx).await?;

    // ── playgroups ─────────────────────────────────────────────────────────
    // Its own: pass each to the longest-standing other account member, or delete it.
    let owned: Vec<String> = sqlx::query_scalar("SELECT id FROM playgroups WHERE owner_id = ?").bind(id).fetch_all(&mut **tx).await?;
    for pg in owned {
        let heir: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM playgroup_members WHERE playgroup_id = ? AND user_id IS NOT NULL AND user_id != ?
              ORDER BY created_at, id LIMIT 1",
        )
        .bind(&pg)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(heir) = heir {
            sqlx::query("UPDATE playgroups SET owner_id = ? WHERE id = ?").bind(&heir).bind(&pg).execute(&mut **tx).await?;
            r.playgroups_passed_on += 1;
        } else {
            // Its games leave the group, and seats leave its member rows (a guest member's name
            // stays on the seat). The members go with the group.
            sqlx::query("UPDATE games SET playgroup_id = NULL WHERE playgroup_id = ?").bind(&pg).execute(&mut **tx).await?;
            sqlx::query(
                "UPDATE game_seats SET
                   guest_name = COALESCE(game_seats.guest_name, (SELECT m.guest_name FROM playgroup_members m WHERE m.id = game_seats.member_id)),
                   member_id = NULL
                 WHERE member_id IN (SELECT id FROM playgroup_members WHERE playgroup_id = ?)",
            )
            .bind(&pg)
            .execute(&mut **tx)
            .await?;
            sqlx::query("DELETE FROM playgroups WHERE id = ?").bind(&pg).execute(&mut **tx).await?;
            r.playgroups_deleted += 1;
        }
    }
    // Its membership elsewhere becomes a guest member, so other people's history still adds up.
    sqlx::query("UPDATE playgroup_members SET user_id = NULL, guest_name = 'Former member' WHERE user_id = ?")
        .bind(id)
        .execute(&mut **tx)
        .await?;

    // ── games it logged ────────────────────────────────────────────────────
    // Kept for others: another account sat in it (directly or as a member), or it belongs to a
    // playgroup that lives on. It passes to that account, else to the group's owner.
    let logged: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, playgroup_id FROM games WHERE created_by = ?").bind(id).fetch_all(&mut **tx).await?;
    for (game, playgroup) in logged {
        let other_seat: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(s.user_id, m.user_id) FROM game_seats s LEFT JOIN playgroup_members m ON m.id = s.member_id
              WHERE s.game_id = ?1 AND COALESCE(s.user_id, m.user_id) IS NOT NULL AND COALESCE(s.user_id, m.user_id) != ?2
              ORDER BY s.seat LIMIT 1",
        )
        .bind(&game)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let group_owner: Option<String> = match &playgroup {
            Some(pg) => sqlx::query_scalar("SELECT owner_id FROM playgroups WHERE id = ? AND owner_id != ?")
                .bind(pg)
                .bind(id)
                .fetch_optional(&mut **tx)
                .await?,
            None => None,
        };
        match other_seat.or(group_owner) {
            Some(heir) => {
                sqlx::query("UPDATE games SET created_by = ? WHERE id = ?").bind(&heir).bind(&game).execute(&mut **tx).await?;
                r.games_kept += 1;
            }
            None => {
                // Seats, events and the online game go with it.
                sqlx::query("DELETE FROM games WHERE id = ?").bind(&game).execute(&mut **tx).await?;
                r.games_deleted += 1;
            }
        }
    }

    // ── seats and online games in the games that stay ──────────────────────
    r.seats_anonymised = sqlx::query(
        "UPDATE game_seats SET guest_name = CASE WHEN member_id IS NULL THEN COALESCE(guest_name, 'Former player') ELSE guest_name END, user_id = NULL
          WHERE user_id = ?",
    )
    .bind(id)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    sqlx::query(
        "UPDATE game_seats SET deck_version_id = NULL
          WHERE deck_version_id IN (SELECT v.id FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE d.owner_id = ?)",
    )
    .bind(id)
    .execute(&mut **tx)
    .await?;
    let online: Vec<(String, String)> = sqlx::query_as(
        "SELECT o.game_id, o.stage FROM online_games o
          WHERE o.host_id = ?1 OR EXISTS (SELECT 1 FROM json_each(o.seats) j WHERE json_extract(j.value, '$.user_id') = ?1)",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    for (game, stage) in online {
        sqlx::query("DELETE FROM online_games WHERE game_id = ?").bind(&game).execute(&mut **tx).await?;
        if stage != "over" {
            sqlx::query("UPDATE games SET status = 'abandoned', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status = 'in_progress'")
                .bind(crate::util::now())
                .bind(&game)
                .execute(&mut **tx)
                .await?;
        }
        r.online_games_removed += 1;
    }

    // ── invites ────────────────────────────────────────────────────────────
    sqlx::query("UPDATE invites SET invited_by = NULL WHERE invited_by = ?").bind(id).execute(&mut **tx).await?;
    // Shared-key grants it made stay for the people it granted.
    sqlx::query("UPDATE advisor_shared_access SET granted_by = NULL WHERE granted_by = ?").bind(id).execute(&mut **tx).await?;
    r.rows_deleted += sqlx::query("DELETE FROM invites WHERE email = ?").bind(&email).execute(&mut **tx).await?.rows_affected();

    // ── everything it owns ─────────────────────────────────────────────────
    for (table, column) in OWNED_DELETES {
        // Table and column names come from the constant above, never from a request.
        let sql = format!("DELETE FROM {table} WHERE {column} = ?");
        r.rows_deleted += sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id).execute(&mut **tx).await?.rows_affected();
    }
    // Nothing may still name the account, whatever the foreign keys allow.
    for (table, column) in USER_COLUMNS {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?");
        let left: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).bind(id).fetch_one(&mut **tx).await?;
        if left > 0 {
            return Err(AppError::Other(anyhow::anyhow!("deleting an account left {left} rows in {table}.{column}")));
        }
    }
    let gone = sqlx::query("DELETE FROM users WHERE id = ?").bind(id).execute(&mut **tx).await?.rows_affected();
    if gone == 0 {
        return Err(AppError::NotFound("account"));
    }
    Ok(r)
}
