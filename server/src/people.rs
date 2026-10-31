//! People to seat at a game logged or started at the table: anyone on Yama who picked a profile
//! handle (`sharing.rs`) can be found by it, and their public decks offered for their seat.
//! Only what their profile already shows: the handle and the public decks, never a display name,
//! email or anything private. Finding someone doesn't put games on their record: a seat holds an
//! account only through a playgroup (`games.rs`, `resolve_seat`), so a seat found here is a guest
//! named by the handle, and a public deck's list is kept only on its owner's own seat.
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::sharing::{deck_face, parse_handle};
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/people", get(search)).route("/api/people/{handle}/decks", get(decks))
}

/// Most matches a search returns.
const MATCHES: i64 = 8;

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct Found {
    handle: String,
}

/// The start of a handle as typed ("@sag", "Sag"): lowercase, the leading @ dropped. None if it's
/// too short to search or has characters no handle has.
fn handle_prefix(q: &str) -> Option<String> {
    let h = q.trim().trim_start_matches('@').to_ascii_lowercase();
    let shape = h.len() >= 2 && h.len() <= 30 && h.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_');
    shape.then_some(h)
}

/// Handles starting with `q`, the exact one first. Not your own: you're already "You".
async fn search(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(p): Query<SearchParams>) -> AppResult<Json<Vec<Found>>> {
    st.limits.people.check_user(&user)?;
    let Some(prefix) = handle_prefix(&p.q) else { return Ok(Json(vec![])) };
    // `_` is a LIKE wildcard and handles can hold it.
    let pattern = format!("{}%", prefix.replace('_', "\\_"));
    let found = sqlx::query_as(
        "SELECT handle FROM users
         WHERE handle LIKE ? ESCAPE '\\' AND disabled_at IS NULL AND id <> ?
         ORDER BY handle <> ?, length(handle), handle LIMIT ?",
    )
    .bind(pattern)
    .bind(&user.id)
    .bind(&prefix)
    .bind(MATCHES)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(found))
}

#[derive(Serialize)]
struct PublicDeck {
    name: String,
    commanders: Vec<String>,
    color_identity: String,
    /// The first commander's art crop and its artist.
    art: Option<String>,
    artist: Option<String>,
    card_count: i64,
    version_id: Option<String>,
}

/// A handle's public decks, as their profile lists them, with each public configuration as a
/// deck of its own ("Riders of Rohan (stock)"), since each is its own list. Not found for a handle
/// nobody has, or a disabled account's.
async fn decks(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(handle): Path<String>) -> AppResult<Json<Vec<PublicDeck>>> {
    st.limits.people.check_user(&user)?;
    let handle = parse_handle(&handle).map_err(|_| AppError::NotFound("profile"))?;
    let owner: String = sqlx::query_scalar("SELECT id FROM users WHERE handle = ? AND disabled_at IS NULL")
        .bind(&handle)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("profile"))?;
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT d.name, d.parent_id, d.configuration, d.current_version_id FROM decks d
         LEFT JOIN decks p ON p.id = d.parent_id
         WHERE d.owner_id = ? AND d.archived = 0 AND d.visibility = 'public' AND d.share_token IS NOT NULL
         ORDER BY lower(COALESCE(p.name, d.name)), d.parent_id IS NOT NULL, lower(COALESCE(d.configuration, d.name))",
    )
    .bind(&owner)
    .fetch_all(&st.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (name, parent, configuration, version) in rows {
        let face = deck_face(&st.pool, version.as_deref()).await?;
        let name = match (&parent, &configuration) {
            (Some(_), Some(c)) if !name.contains(c.as_str()) => format!("{name} ({c})"),
            _ => name,
        };
        let (art, artist) = face.art.map(|(url, artist, _)| (Some(url), artist)).unwrap_or_default();
        out.push(PublicDeck { name, commanders: face.commanders, color_identity: face.color_identity, art, artist, card_count: face.card_count, version_id: version });
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::handle_prefix;
    use crate::testutil::{app, deck, send, user};
    use axum::http::{Method, StatusCode};
    use serde_json::json;

    #[test]
    fn prefixes_are_what_a_handle_could_start_with() {
        assert_eq!(handle_prefix(" @SaG ").as_deref(), Some("sag"));
        assert_eq!(handle_prefix("s"), None);
        assert_eq!(handle_prefix("sa%"), None);
        assert_eq!(handle_prefix("Bryan Roscoe"), None);
    }

    #[tokio::test]
    async fn people_are_found_by_handle_only_with_their_public_decks() {
        let (app, pool) = app().await;
        let (me, mt) = user(&pool, "me@example.com").await;
        let (sam, _) = user(&pool, "sam@example.com").await;
        let (gone, _) = user(&pool, "gone@example.com").await;
        let (_nameless, _) = user(&pool, "samantha@example.com").await;
        for (id, h) in [(&me, "sage"), (&sam, "sa_m"), (&gone, "sam")] {
            sqlx::query("UPDATE users SET handle = ? WHERE id = ?").bind(h).bind(id).execute(&pool).await.unwrap();
        }
        sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = ?").bind(&gone).execute(&pool).await.unwrap();

        // By handle, never by display name ("samantha" has no handle); not yourself, not a
        // disabled account; `_` matches itself only.
        let (s, found) = send(&app, Method::GET, "/api/people?q=%40SA", Some(&mt), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(found, json!([{ "handle": "sa_m" }]));
        assert_eq!(send(&app, Method::GET, "/api/people?q=saxm", Some(&mt), None).await.1, json!([]));
        assert_eq!(send(&app, Method::GET, "/api/people?q=samantha", Some(&mt), None).await.1, json!([]));
        assert_eq!(send(&app, Method::GET, "/api/people?q=sa", None, None).await.0, StatusCode::UNAUTHORIZED);

        // Only public decks, with nothing the profile doesn't show.
        let (public, version) = deck(&pool, &sam, "Riders of Rohan").await;
        let (_private, _) = deck(&pool, &sam, "Secret brew").await;
        let (stock, stock_version) = deck(&pool, &sam, "Riders of Rohan").await;
        sqlx::query("UPDATE decks SET visibility = 'public' WHERE id IN (?, ?)").bind(&public).bind(&stock).execute(&pool).await.unwrap();
        sqlx::query("UPDATE decks SET parent_id = ?, configuration = 'stock' WHERE id = ?").bind(&public).bind(&stock).execute(&pool).await.unwrap();
        let (s, decks) = send(&app, Method::GET, "/api/people/@Sa_M/decks", Some(&mt), None).await;
        assert_eq!(s, StatusCode::OK);
        let decks = decks.as_array().unwrap();
        // The main list, then its public configuration as a deck of its own.
        assert_eq!(decks.len(), 2, "{decks:?}");
        assert_eq!(decks[0]["name"], "Riders of Rohan");
        assert_eq!(decks[0]["commanders"], json!(["Test Commander"]));
        assert_eq!(decks[0]["version_id"], json!(version));
        assert_eq!(decks[1]["name"], "Riders of Rohan (stock)");
        assert_eq!(decks[1]["version_id"], json!(stock_version));
        assert_eq!(send(&app, Method::GET, "/api/people/sam/decks", Some(&mt), None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(send(&app, Method::GET, "/api/people/nobody/decks", Some(&mt), None).await.0, StatusCode::NOT_FOUND);
    }
}
