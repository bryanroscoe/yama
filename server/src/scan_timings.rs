//! Scanner diagnostics' timing records (docs/scanner.md, "Scanner diagnostics").
//!
//! The struggle records (scan_diagnostics.rs) keep only the cards the scanner struggled with, so
//! they can't say how fast an ordinary scan settles or how often each rule settles a card (Bryan,
//! 20 Nov 2026). While Scanner diagnostics is on, the scanner also sends one small record, with no
//! images, for every card it settles: the milliseconds from the card appearing to the card being
//! named, the rule that named it, the art's top score and lead, the frames read, then how the
//! printing was settled and how long that took, the camera's resolution and the art model.
//!
//! Same privacy as the struggle records: owner-only (every query binds the owner), never shared
//! with an admin, refused to an admin's View as (they live under `/api/scan/diagnostics`,
//! view_as.rs `HIDDEN`), deleted with "Delete them" (`DELETE /api/scan/diagnostics`) and with the
//! account (admin/delete.rs). Kept apart from the struggle records, under their own cap ([`KEEP`]
//! records, [`KEEP_BYTES`]), so they never push those out. Read through `GET
//! /api/scan/diagnostics/timings` (a summary and a page of records) and the MCP tool
//! `get_scan_timings`.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{DefaultBodyLimit, FromRequest, Query, Request, State};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;
use std::collections::BTreeMap;

/// Most records kept per account; a new one past this drops the oldest.
pub const KEEP: i64 = 2000;
/// Most bytes kept per account (a record is a few hundred bytes); past it the oldest go.
pub const KEEP_BYTES: i64 = 2 * 1024 * 1024;
/// Longest `detail` (JSON) accepted.
const MAX_DETAIL: usize = 1024;
/// The rules that name a card (fuse.ts `LockRule`, and a close-up of the title or a typed name).
pub const RULES: [&str; 7] = ["sure", "leads", "twice", "title", "text", "closeup", "typed"];
/// How a printing is settled: the only printing (or the only one in the locked sets), the
/// collector line, the printing look when it's sure (the look option that settles, scan.rs
/// `LOOK_V1_SURE`), the person's pick, or a correction of the scanner's own.
pub const PRINTINGS: [&str; 6] = ["only", "set", "collector", "look", "picked", "corrected"];
pub const MODES: [&str; 2] = ["printing", "identity"];
/// An hour: no single card takes longer, and anything more is a clock gone wrong.
const MAX_MS: i64 = 3_600_000;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/scan/diagnostics/timings", post(add).get(get_route).layer(DefaultBodyLimit::max(16 * 1024)))
}

#[derive(Deserialize)]
struct NewTiming {
    outcome: String,
    rule: String,
    mode: String,
    #[serde(default)]
    photo: bool,
    ms: Option<f64>,
    frames: Option<f64>,
    top: Option<f64>,
    lead: Option<f64>,
    printing: Option<String>,
    printing_ms: Option<f64>,
    camera: Option<String>,
    /// The embed graph the phone's art recognizer ran (`ArtRecognizer.embed`), or "none".
    embed: Option<String>,
    /// The option each of the scanner's slots ran (scan.rs, `recorded_models`), if said.
    models: Option<Value>,
    #[serde(default)]
    detail: Option<Value>,
}

/// A whole number of milliseconds (or frames) within reason, else nothing.
fn whole(v: Option<f64>, max: i64) -> Option<i64> {
    v.filter(|n| n.is_finite() && *n >= 0.0 && *n <= max as f64).map(|n| n.round() as i64)
}

/// A score, rounded to three places, within reason.
fn score(v: Option<f64>) -> Option<f64> {
    v.filter(|n| n.is_finite() && (-2.0..=2.0).contains(n)).map(|n| (n * 1000.0).round() / 1000.0)
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, req: Request) -> AppResult<axum::response::Response> {
    st.limits.scan_timings.check_user(&user)?;
    // When it began, against "Delete them" (scan_clears.rs): before its body is read (Codex review
    // of #171: stamped after, a deletion during the read would predate it).
    let started = crate::scan_clears::stamp();
    let Json(t) = match Json::<NewTiming>::from_request(req, &st).await {
        Ok(json) => json,
        // Axum's own answer: 413 for too large, 400/415/422 for the rest.
        Err(rejection) => return Ok(rejection.into_response()),
    };
    if !crate::scan_diagnostics::OUTCOMES.contains(&t.outcome.as_str()) {
        return Err(AppError::bad(format!("outcome is one of {}", crate::scan_diagnostics::OUTCOMES.join(", "))));
    }
    if !RULES.contains(&t.rule.as_str()) {
        return Err(AppError::bad(format!("rule is one of {}", RULES.join(", "))));
    }
    if !MODES.contains(&t.mode.as_str()) {
        return Err(AppError::bad("mode is printing or identity"));
    }
    let printing = match t.printing.as_deref() {
        None => None,
        Some(p) if PRINTINGS.contains(&p) => Some(p.to_string()),
        Some(_) => return Err(AppError::bad(format!("printing is one of {}", PRINTINGS.join(", ")))),
    };
    let detail = match t.detail {
        None | Some(Value::Null) => "{}".to_string(),
        Some(d) if d.is_object() => d.to_string(),
        Some(_) => return Err(AppError::bad("detail is a JSON object")),
    };
    if detail.len() > MAX_DETAIL {
        return Err(AppError::bad("detail is too long"));
    }
    let camera = t.camera.map(|s| s.trim().chars().take(40).collect::<String>()).filter(|s| !s.is_empty());
    let bundle = crate::scan::recorded_version(&st.cfg, t.embed.as_deref()).await;
    let models = crate::scan::recorded_models(t.models.as_ref());
    // What the row holds beyond its fixed columns, near enough.
    let bytes = (96 + detail.len() + camera.as_ref().map_or(0, String::len) + bundle.len() + models.as_ref().map_or(0, String::len)) as i64;
    let id = crate::util::new_id();
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO scan_timings (id, owner_id, created_at, outcome, rule, mode, photo, ms, frames, top, lead, printing, printing_ms, camera, bundle, models, detail, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(crate::util::now())
    .bind(&t.outcome)
    .bind(&t.rule)
    .bind(&t.mode)
    .bind(t.photo)
    .bind(whole(t.ms, MAX_MS))
    .bind(whole(t.frames, 100_000))
    .bind(score(t.top))
    .bind(score(t.lead))
    .bind(&printing)
    .bind(printing.as_ref().and(whole(t.printing_ms, MAX_MS)))
    .bind(camera)
    .bind(&bundle)
    .bind(&models)
    .bind(detail)
    .bind(bytes)
    .execute(&mut *tx)
    .await?;
    crate::scan_clears::refuse_if_cleared(&mut tx, &user.id, crate::scan_clears::DIAGNOSTICS, &started).await?;
    // Keep the newest KEEP, and no more than KEEP_BYTES of them.
    sqlx::query(
        "DELETE FROM scan_timings WHERE owner_id = ?1 AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER w AS n, SUM(bytes) OVER w AS running
               FROM scan_timings WHERE owner_id = ?1
             WINDOW w AS (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING))
           WHERE n > ?2 OR running > ?3)",
    )
    .bind(&user.id)
    .bind(KEEP)
    .bind(KEEP_BYTES)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id })).into_response())
}

/// Which records a summary or page covers: from a date, one art model (the recorded bundle), one
/// mode.
#[derive(Default, Deserialize)]
pub struct Filter {
    pub since: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    created_at: String,
    outcome: String,
    rule: String,
    mode: String,
    photo: bool,
    ms: Option<i64>,
    frames: Option<i64>,
    top: Option<f64>,
    lead: Option<f64>,
    printing: Option<String>,
    printing_ms: Option<i64>,
    camera: Option<String>,
    bundle: Option<String>,
    models: Option<String>,
    detail: String,
}

impl Row {
    fn flag(&self, key: &str) -> bool {
        self.said(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// One of `detail`'s facts, as the phone sent it.
    fn said(&self, key: &str) -> Option<Value> {
        serde_json::from_str::<Value>(&self.detail).ok()?.get(key).cloned()
    }

    /// The printing look's option this card's look ran under: the one whose rule was weighed
    /// (`detail.look_option`), else the one the phone ran when the card was named (`models.look`).
    fn look(&self) -> Option<String> {
        if let Some(Value::String(o)) = self.said("look_option") {
            return Some(o);
        }
        serde_json::from_str::<Value>(self.models.as_deref()?).ok()?.get("look")?.as_str().map(str::to_owned)
    }

    /// The way of settling the printing the person said was wrong (Wrong printing), if any.
    fn printing_rejected(&self) -> Option<String> {
        serde_json::from_str::<Value>(&self.detail).ok()?.get("printing_rejected")?.as_str().filter(|p| PRINTINGS.contains(p)).map(str::to_owned)
    }

    /// The person then said it was another card: "Scan it again", or Wrong card and the right one.
    fn called_wrong(&self) -> bool {
        self.outcome == "wrong" || self.flag("card_corrected")
    }

    fn json(&self) -> Value {
        json!({
            "id": self.id, "created_at": self.created_at, "outcome": self.outcome, "rule": self.rule, "mode": self.mode,
            "photo": self.photo, "ms": self.ms, "frames": self.frames, "top": self.top, "lead": self.lead,
            "printing": self.printing, "printing_ms": self.printing_ms, "camera": self.camera, "model": self.bundle,
            "models": self.models.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()),
            "detail": serde_json::from_str::<Value>(&self.detail).unwrap_or(Value::Null),
        })
    }
}

async fn rows(pool: &SqlitePool, owner: &str, f: &Filter) -> AppResult<Vec<Row>> {
    Ok(sqlx::query_as(
        "SELECT id, created_at, outcome, rule, mode, photo, ms, frames, top, lead, printing, printing_ms, camera, bundle, models, detail
           FROM scan_timings
          WHERE owner_id = ?1 AND (?2 IS NULL OR created_at >= ?2) AND (?3 IS NULL OR bundle = ?3) AND (?4 IS NULL OR mode = ?4)
          ORDER BY created_at DESC, rowid DESC",
    )
    .bind(owner)
    .bind(f.since.as_deref())
    .bind(f.model.as_deref())
    .bind(f.mode.as_deref())
    .fetch_all(pool)
    .await?)
}

/// The value at quantile `q` of `v` (sorted here), by nearest rank; None when empty.
fn quantile(v: &mut [i64], q: f64) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    let rank = ((q * v.len() as f64).ceil() as usize).clamp(1, v.len());
    Some(v[rank - 1])
}

fn share(n: usize, of: usize) -> f64 {
    if of == 0 { 0.0 } else { (n as f64 / of as f64 * 1000.0).round() / 1000.0 }
}

/// Count, median and 90th percentile of the live camera's time to name the card, its frames, and
/// how many the person then said were another card.
fn timing(rows: &[&Row]) -> Value {
    let live: Vec<&&Row> = rows.iter().filter(|r| !r.photo && r.rule != "typed").collect();
    let mut ms: Vec<i64> = live.iter().filter_map(|r| r.ms).collect();
    let mut frames: Vec<i64> = live.iter().filter_map(|r| r.frames).collect();
    json!({
        "count": rows.len(), "timed": ms.len(),
        "median_ms": quantile(&mut ms, 0.5), "p90_ms": quantile(&mut ms, 0.9), "median_frames": quantile(&mut frames, 0.5),
        "called_wrong": rows.iter().filter(|r| r.called_wrong()).count(),
    })
}

/// Rows grouped by a key, each group with its count, share of all, and timing.
fn by<'a>(rows: &[&'a Row], key: impl Fn(&Row) -> Option<String>, name: &str, time: impl Fn(&[&'a Row]) -> Value) -> Vec<Value> {
    let mut groups: BTreeMap<String, Vec<&'a Row>> = BTreeMap::new();
    for r in rows {
        if let Some(k) = key(r) {
            groups.entry(k).or_default().push(r);
        }
    }
    let total: usize = groups.values().map(Vec::len).sum();
    let mut out: Vec<Value> = groups
        .into_iter()
        .map(|(k, g)| {
            let mut v = Map::new();
            v.insert(name.into(), json!(k));
            v.insert("count".into(), json!(g.len()));
            v.insert("share".into(), json!(share(g.len(), total)));
            if let Value::Object(t) = time(&g) {
                for (tk, tv) in t {
                    if tk != "count" {
                        v.insert(tk, tv);
                    }
                }
            }
            Value::Object(v)
        })
        .collect();
    out.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
    out
}

/// A group's timing and its rules, with how many of each the person then called wrong.
fn with_rules(g: &[&Row]) -> Value {
    let mut t = timing(g);
    t["rules"] = json!(by(g, |r| Some(r.rule.clone()), "rule", |g| json!({"count": g.len(), "called_wrong": g.iter().filter(|r| r.called_wrong()).count()})));
    t
}

/// The time from the card being named to its printing being settled.
fn printing_timing(rows: &[&Row]) -> Value {
    let mut ms: Vec<i64> = rows.iter().filter_map(|r| r.printing_ms).collect();
    json!({ "median_ms": quantile(&mut ms, 0.5), "p90_ms": quantile(&mut ms, 0.9) })
}

/// By the printing look's option (`Row::look`), in the collection only (deck and box scans don't
/// run the look): its cards, how their printings were settled and how long that took, how often
/// each way was then called wrong (Wrong printing), and how many cards' looks the rule of the
/// option that settles when sure would have settled (`detail.look_sure`, weighed on the phone under
/// any look option: every printing scored, the closest 0.10 ahead on the raw lead, no collector
/// read pointing elsewhere), and of those how many ended as another printing than the look's
/// closest (`detail.look_top_filed` false at the first filing, or a Wrong printing after filing
/// one that was). So the option can be weighed against the default on real scans. With how long
/// its looks took and where their printings' vectors came from (`look_time`, `vectors`).
fn by_look(all: &[Row]) -> Vec<Value> {
    let mut groups: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
    for r in all.iter().filter(|r| r.mode == "printing") {
        if let Some(look) = r.look() {
            groups.entry(look).or_default().push(r);
        }
    }
    let mut out: Vec<Value> = groups
        .into_iter()
        .map(|(look, g)| {
            let cards: Vec<&Row> = g.iter().copied().filter(|r| !r.flag("after_filing")).collect();
            let printed: Vec<&Row> = cards.iter().copied().filter(|r| r.printing.is_some() && !r.called_wrong()).collect();
            let corrected_after = |r: &&Row| r.flag("after_filing") && r.printing.as_deref() == Some("corrected");
            let judged: Vec<&Row> = g.iter().copied().filter(|r| !r.flag("after_filing") || corrected_after(r)).collect();
            let top_filed = |r: &Row| r.said("look_top_filed").and_then(|v| v.as_bool());
            let sure = cards.iter().filter(|r| r.flag("look_sure")).count();
            let otherwise = cards.iter().filter(|r| r.flag("look_sure") && top_filed(r) == Some(false)).count()
                + g.iter().filter(|r| corrected_after(r) && r.flag("look_sure") && top_filed(r) == Some(true)).count();
            json!({
                "look": look,
                "count": cards.len(),
                "printing": printing_timing(&printed),
                "printings": by(&printed, |r| r.printing.clone(), "printing", printing_timing),
                "printings_called_wrong": by(&judged, |r| r.printing_rejected(), "printing", |g| json!({"count": g.len()})),
                "sure_leads": sure,
                "sure_leads_filed_otherwise": otherwise,
                "look_time": look_time(&cards),
                "vectors": vectors(&cards),
            })
        })
        .collect();
    out.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
    out
}

/// A whole number from a record's `detail`, if it said one.
fn count(r: &Row, key: &str) -> Option<i64> {
    r.said(key).and_then(|v| v.as_i64()).filter(|n| (0..=MAX_MS).contains(n))
}

/// How long the looks took (`detail.look_ms`, from the look starting to every printing scored),
/// overall and split by where their vectors came from: none made on the phone (all the server's or
/// the phone's own cache), or some fetched from Scryfall and embedded there. That split is the
/// server's vectors' gain (docs/scanner.md, "Vectors from the server").
fn look_time(rows: &[&Row]) -> Value {
    let looked: Vec<&&Row> = rows.iter().filter(|r| count(r, "look_ms").is_some()).collect();
    let times = |pick: &dyn Fn(&Row) -> bool| {
        let mut ms: Vec<i64> = looked.iter().filter(|r| pick(r)).filter_map(|r| count(r, "look_ms")).collect();
        json!({ "count": ms.len(), "median_ms": quantile(&mut ms, 0.5), "p90_ms": quantile(&mut ms, 0.9) })
    };
    let made = |r: &Row| count(r, "look_made").unwrap_or(0) > 0;
    json!({ "all": times(&|_| true), "nothing_made": times(&|r| !made(r)), "some_made": times(&made) })
}

/// The printings' vectors of those looks, by where they came from: the server, the phone's own
/// cache, or fetched and embedded on the phone; and the server's share.
fn vectors(rows: &[&Row]) -> Value {
    let sum = |key: &str| rows.iter().filter_map(|r| count(r, key)).sum::<i64>();
    let (server, cached, made) = (sum("look_server"), sum("look_cached"), sum("look_made"));
    let all = server + cached + made;
    json!({ "server": server, "cached": cached, "made": made, "server_share": share(server as usize, all as usize) })
}

/// What the account's timing records say: how fast cards are named and by which rule, how their
/// printings are settled, and the same by art model; with the newest records from `offset`.
pub async fn summary(pool: &SqlitePool, owner: &str, f: &Filter, offset: usize, limit: usize) -> AppResult<Value> {
    let all = rows(pool, owner, f).await?;
    let (kept, bytes): (i64, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), SUM(bytes) FROM scan_timings WHERE owner_id = ?").bind(owner).fetch_one(pool).await?;
    // A Wrong printing after the card was filed is a record of its own for a card already counted:
    // counted apart, never as a second card.
    let refs: Vec<&Row> = all.iter().filter(|r| !r.flag("after_filing")).collect();
    // Only those whose correction was made: Wrong printing after filing, then "Keep it as it was"
    // or Skip, corrected nothing.
    let corrected_after = |r: &&Row| r.flag("after_filing") && r.printing.as_deref() == Some("corrected");
    let after_filing = all.iter().filter(corrected_after).count();
    // A card the person then said was another card: its printing was the other card's.
    let printed: Vec<&Row> = refs.iter().copied().filter(|r| r.printing.is_some() && !r.called_wrong()).collect();
    let items: Vec<Value> = all.iter().skip(offset).take(limit).map(Row::json).collect();
    Ok(json!({
        "kept": kept, "bytes": bytes.unwrap_or(0), "keep": KEEP, "keep_bytes": KEEP_BYTES,
        "count": refs.len(),
        "records": all.len(),
        "settled": timing(&refs),
        "rules": by(&refs, |r| Some(r.rule.clone()), "rule", timing),
        "printings": by(&printed, |r| r.printing.clone(), "printing", printing_timing),
        "printing_corrected_after_filing": after_filing,
        // How often each way of settling a printing was then called wrong (Wrong printing, before
        // or after filing).
        "printings_called_wrong": by(&all.iter().filter(|r| !r.flag("after_filing") || corrected_after(r)).collect::<Vec<_>>(), |r| r.printing_rejected(), "printing", |g| json!({"count": g.len()})),
        "art_models": by(&refs, |r| r.bundle.clone(), "model", with_rules),
        // By every slot's choice together (art, look, text, lock): the lead rule on or off, say.
        "settings": by(&refs, |r| r.models.clone(), "settings", with_rules)
            .into_iter()
            .map(|mut g| {
                g["settings"] = g["settings"].as_str().and_then(|m| serde_json::from_str::<Value>(m).ok()).unwrap_or(Value::Null);
                g
            })
            .collect::<Vec<_>>(),
        "modes": by(&refs, |r| Some(r.mode.clone()), "mode", timing),
        // By the printing look's option: the default against the option that settles when sure.
        "looks": by_look(&all),
        "items": items,
    }))
}

#[derive(Deserialize)]
struct GetQuery {
    since: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

async fn get_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<GetQuery>) -> AppResult<Json<Value>> {
    let f = Filter { since: q.since, model: q.model, mode: q.mode };
    let limit = q.limit.unwrap_or(50).clamp(0, 500);
    Ok(Json(summary(&st.pool, &user.id, &f, q.offset.unwrap_or(0).min(1_000_000), limit).await?))
}

/// Every timing record of an account ("Delete them" in Scan settings deletes them with the
/// struggle records). Returns how many went.
pub async fn delete_all(conn: &mut sqlx::SqliteConnection, owner: &str) -> AppResult<u64> {
    Ok(sqlx::query("DELETE FROM scan_timings WHERE owner_id = ?").bind(owner).execute(&mut *conn).await?.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    pub(crate) fn body(rule: &str, ms: i64) -> Value {
        json!({
            "outcome": "filed", "rule": rule, "mode": "printing", "ms": ms, "frames": 2, "top": 0.7812, "lead": 0.14,
            "printing": "collector", "printing_ms": 900, "camera": "2160×3840",
            "embed": format!("{}/{}", crate::scan::BUNDLE_VERSION, crate::scan::QUERY_MODEL.file().unwrap()),
            "models": {"art": "yama-art-20261118", "look": "off", "text": "auto", "lock": rule_lock(rule)},
            "detail": {"auto": true},
        })
    }

    const PATH: &str = "/api/scan/diagnostics/timings";

    /// The lock option a record says ran: the lead rule's own records ran "lead".
    fn rule_lock(rule: &str) -> &'static str {
        if rule == "leads" { "lead" } else { "sure" }
    }

    #[tokio::test]
    async fn kept_for_the_owner_only_summarised_and_deleted_with_delete_them() {
        let (app, pool) = testutil::app().await;
        let (_, mine) = testutil::user(&pool, "me@example.com").await;
        let (_, theirs) = testutil::user(&pool, "them@example.com").await;
        for (rule, ms) in [("leads", 600), ("leads", 800), ("sure", 300), ("title", 2400)] {
            let (status, res) = testutil::send(&app, Method::POST, PATH, Some(&mine), Some(body(rule, ms))).await;
            assert_eq!(status, StatusCode::OK, "{res}");
        }
        let mut typed = body("typed", 0);
        typed["printing"] = json!("picked");
        typed.as_object_mut().unwrap().remove("ms");
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&mine), Some(typed)).await;
        assert_eq!(status, StatusCode::OK);

        let (status, s) = testutil::send(&app, Method::GET, PATH, Some(&mine), None).await;
        assert_eq!(status, StatusCode::OK, "{s}");
        assert_eq!(s["count"], 5);
        assert_eq!(s["kept"], 5);
        // A typed name has no time to name it: it isn't in the timing.
        assert_eq!(s["settled"]["timed"], 4);
        assert_eq!(s["settled"]["called_wrong"], 0);
        assert_eq!(s["settled"]["median_ms"], 600);
        assert_eq!(s["settled"]["p90_ms"], 2400);
        assert_eq!(s["rules"][0]["rule"], "leads");
        assert_eq!(s["rules"][0]["count"], 2);
        assert_eq!(s["rules"][0]["share"], 0.4);
        assert_eq!(s["rules"][0]["median_ms"], 600);
        assert_eq!(s["printings"][0]["printing"], "collector");
        assert_eq!(s["printings"][0]["count"], 4);
        assert_eq!(s["printings"][0]["median_ms"], 900);
        let model = format!("{}+yama-art-20261118", crate::scan::BUNDLE_VERSION);
        assert_eq!(s["art_models"][0]["model"], model.as_str());
        assert_eq!(s["art_models"][0]["rules"][0]["rule"], "leads");
        // By each slot's choice: the lead rule's records apart from the others.
        assert_eq!(s["settings"][0]["settings"], json!({"art": "yama-art-20261118", "look": "off", "text": "auto", "lock": "sure"}));
        assert_eq!(s["settings"][0]["count"], 3);
        assert_eq!(s["settings"][1]["settings"]["lock"], "lead");
        assert_eq!(s["items"][0]["models"]["text"], "auto");
        assert_eq!(s["items"].as_array().unwrap().len(), 5);
        assert_eq!(s["items"][4]["top"], 0.781);
        assert_eq!(s["items"][4]["detail"]["auto"], true);
        // Filtered to a mode with none.
        let (_, s2) = testutil::send(&app, Method::GET, &format!("{PATH}?mode=identity"), Some(&mine), None).await;
        assert_eq!(s2["count"], 0);
        assert_eq!(s2["settled"]["median_ms"], Value::Null);

        // Someone else sees none of them, and their Delete them deletes none.
        let (_, s) = testutil::send(&app, Method::GET, PATH, Some(&theirs), None).await;
        assert_eq!(s["count"], 0);
        assert_eq!(s["kept"], 0);
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        assert_eq!(d["timings"], 0);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 5);

        // Delete them takes the timings with the struggle records.
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&mine), None).await;
        assert_eq!(d["timings"], 5);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0);
        let (status, _) = testutil::send(&app, Method::GET, PATH, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_correction_after_filing_isnt_a_second_card_and_a_wrong_card_isnt_a_success() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "me@example.com").await;
        let post = |b: Value| {
            let app = app.clone();
            let token = token.clone();
            async move { assert_eq!(testutil::send(&app, Method::POST, PATH, Some(&token), Some(b)).await.0, StatusCode::OK) }
        };
        // Filed as read from the collector line, then Wrong printing after filing: its own record.
        post(body("leads", 600)).await;
        let mut after = body("leads", 600);
        after["printing"] = json!("corrected");
        after["detail"] = json!({"after_filing": true, "printing_rejected": "only"});
        post(after).await;
        // and once more, then "Keep it as it was": no correction, nothing rejected.
        let mut kept = body("leads", 600);
        kept.as_object_mut().unwrap().remove("printing");
        kept["detail"] = json!({"after_filing": true, "printing_rejected": "collector"});
        post(kept).await;
        // Named by the lead rule, then Wrong card and the right one picked.
        let mut wrong = body("leads", 500);
        wrong["detail"] = json!({"card_corrected": true});
        post(wrong).await;
        // Wrong printing before filing, then skipped: the collector read was called wrong.
        let mut rejected = body("sure", 400);
        rejected["outcome"] = json!("skipped");
        rejected.as_object_mut().unwrap().remove("printing");
        rejected["detail"] = json!({"printing_rejected": "collector"});
        post(rejected).await;
        let (_, s) = testutil::send(&app, Method::GET, PATH, Some(&token), None).await;
        assert_eq!(s["records"], 5);
        assert_eq!(s["count"], 3, "three cards");
        assert_eq!(s["printings_called_wrong"], json!([{"printing": "collector", "count": 1, "share": 0.5}, {"printing": "only", "count": 1, "share": 0.5}]));
        assert_eq!(s["printing_corrected_after_filing"], 1);
        assert_eq!(s["rules"][0]["rule"], "leads");
        assert_eq!(s["rules"][0]["count"], 2);
        assert_eq!(s["rules"][0]["called_wrong"], 1);
        assert_eq!(s["settled"]["called_wrong"], 1);
        // The wrong card's printing isn't counted for the card filed.
        assert_eq!(s["printings"][0]["count"], 1);
        assert_eq!(s["art_models"][0]["rules"][0]["called_wrong"], 1);
    }

    #[tokio::test]
    async fn a_look_settled_printing_is_kept_apart_with_its_lead_and_its_correction_counts() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "me@example.com").await;
        let post = |b: Value| {
            let app = app.clone();
            let token = token.clone();
            async move { assert_eq!(testutil::send(&app, Method::POST, PATH, Some(&token), Some(b)).await.0, StatusCode::OK) }
        };
        let with_look = |look: &str, printing: Option<&str>, ms: i64, detail: Value| {
            let mut b = body("leads", 500);
            b["models"]["look"] = json!(look);
            match printing {
                Some(p) => b["printing"] = json!(p),
                None => drop(b.as_object_mut().unwrap().remove("printing")),
            }
            b["printing_ms"] = json!(ms);
            b["detail"] = detail;
            b
        };
        // The option that settles when sure: two settled by look (one of them then called wrong
        // before filing, and picked), one the look led too little on, read from the collector line.
        post(with_look("look-v1-sure", Some("look"), 700, json!({"look_lead": 0.142, "look_sure": true, "look_option": "look-v1-sure", "look_top_filed": true}))).await;
        post(with_look("look-v1-sure", Some("corrected"), 4000, json!({"look_lead": 0.118, "look_sure": true, "look_option": "look-v1-sure", "printing_rejected": "look", "look_top_filed": false}))).await;
        post(with_look("look-v1-sure", Some("collector"), 2500, json!({"look_lead": 0.031, "look_sure": false, "look_option": "look-v1-sure", "look_top_filed": true}))).await;
        // and a look settle filed, then Wrong printing after filing: its own record.
        post(with_look("look-v1-sure", Some("look"), 650, json!({"look_lead": 0.2, "look_sure": true, "look_option": "look-v1-sure", "look_top_filed": true}))).await;
        post(with_look("look-v1-sure", Some("corrected"), 9000, json!({"look_lead": 0.2, "look_sure": true, "look_option": "look-v1-sure", "look_top_filed": true, "after_filing": true, "printing_rejected": "look"}))).await;
        // Named under v1, switched to the option before the look was weighed: counted under the option.
        post(with_look("look-v1", Some("look"), 800, json!({"look_lead": 0.3, "look_sure": true, "look_option": "look-v1-sure", "look_top_filed": true}))).await;
        // The default, which only orders the list: picked, where the rule would have settled; and
        // one the rule wouldn't have (a collector read pointing elsewhere, or a raw lead just under
        // 0.10 that rounds to 0.1).
        post(with_look("look-v1", Some("picked"), 3000, json!({"look_lead": 0.12, "look_sure": true, "look_option": "look-v1", "look_top_filed": false}))).await;
        post(with_look("look-v1", Some("collector"), 2000, json!({"look_lead": 0.1, "look_sure": false, "look_option": "look-v1", "look_top_filed": true}))).await;
        // A deck scan doesn't run the look.
        let mut deck = with_look("off", None, 0, json!({}));
        deck["mode"] = json!("identity");
        post(deck).await;

        let (_, s) = testutil::send(&app, Method::GET, PATH, Some(&token), None).await;
        assert_eq!(s["count"], 8, "eight cards");
        let printings: BTreeMap<String, u64> = s["printings"].as_array().unwrap().iter().map(|g| (g["printing"].as_str().unwrap().to_string(), g["count"].as_u64().unwrap())).collect();
        assert_eq!(printings, BTreeMap::from([("look".into(), 3), ("collector".into(), 2), ("corrected".into(), 1), ("picked".into(), 1)]));
        // Both corrections of a look settle are counted against the look.
        assert_eq!(s["printings_called_wrong"], json!([{"printing": "look", "count": 2, "share": 1.0}]));
        let looks = s["looks"].as_array().unwrap();
        assert_eq!(looks.len(), 2, "{looks:?}");
        let sure = &looks[0];
        assert_eq!(sure["look"], "look-v1-sure");
        assert_eq!(sure["count"], 5);
        assert_eq!(sure["printing"]["median_ms"], 800);
        assert_eq!(sure["printings"][0]["printing"], "look");
        assert_eq!(sure["printings"][0]["count"], 3);
        assert_eq!(sure["printings"][0]["median_ms"], 700);
        assert_eq!(sure["printings_called_wrong"], json!([{"printing": "look", "count": 2, "share": 1.0}]));
        assert_eq!(sure["sure_leads"], 4);
        // One picked otherwise before filing, one changed by Wrong printing after filing.
        assert_eq!(sure["sure_leads_filed_otherwise"], 2);
        let default = &looks[1];
        assert_eq!(default["look"], "look-v1");
        assert_eq!(default["count"], 2);
        assert_eq!(default["printing"]["median_ms"], 2000);
        assert_eq!(default["printings_called_wrong"], json!([]));
        // The phone's own verdict counts, not the rounded lead.
        assert_eq!(default["sure_leads"], 1);
        assert_eq!(default["sure_leads_filed_otherwise"], 1);
        // The records keep the lead as sent.
        assert_eq!(s["items"][0]["models"]["look"], "off");
        let first = s["items"].as_array().unwrap().iter().find(|i| i["detail"]["look_lead"] == 0.142).unwrap();
        assert_eq!(first["printing"], "look");
    }

    #[tokio::test]
    async fn looks_say_how_long_they_took_and_where_their_vectors_came_from() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "me@example.com").await;
        let looked = |ms: i64, server: i64, cached: i64, made: i64| {
            let mut b = body("leads", 500);
            b["models"]["look"] = json!("look-v1");
            b["detail"] = json!({"look_ms": ms, "look_scored": server + cached + made, "look_server": server, "look_cached": cached, "look_made": made});
            b
        };
        // Two looks all from the server, one from the phone's cache, two that fetched pictures.
        for b in [looked(300, 4, 0, 0), looked(350, 3, 1, 0), looked(120, 0, 4, 0), looked(1600, 2, 0, 2), looked(2100, 0, 0, 5)] {
            assert_eq!(testutil::send(&app, Method::POST, PATH, Some(&token), Some(b)).await.0, StatusCode::OK);
        }
        // A look from before 21 Nov says nothing of it and counts in neither.
        let mut old = body("leads", 500);
        old["models"]["look"] = json!("look-v1");
        assert_eq!(testutil::send(&app, Method::POST, PATH, Some(&token), Some(old)).await.0, StatusCode::OK);
        let (_, s) = testutil::send(&app, Method::GET, PATH, Some(&token), None).await;
        let v1 = s["looks"].as_array().unwrap().iter().find(|l| l["look"] == "look-v1").unwrap().clone();
        assert_eq!(v1["count"], 6);
        assert_eq!(v1["look_time"]["all"], json!({"count": 5, "median_ms": 350, "p90_ms": 2100}));
        assert_eq!(v1["look_time"]["nothing_made"], json!({"count": 3, "median_ms": 300, "p90_ms": 350}));
        assert_eq!(v1["look_time"]["some_made"], json!({"count": 2, "median_ms": 1600, "p90_ms": 2100}));
        assert_eq!(v1["vectors"], json!({"server": 9, "cached": 5, "made": 7, "server_share": 0.429}));
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_known_rule_or_a_small_object() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "me@example.com").await;
        let post = |b: Value| {
            let app = app.clone();
            let token = token.clone();
            async move { testutil::send(&app, Method::POST, PATH, Some(&token), Some(b)).await.0 }
        };
        assert_eq!(post(body("guess", 1)).await, StatusCode::BAD_REQUEST);
        let mut b = body("sure", 1);
        b["outcome"] = json!("maybe");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("sure", 1);
        b["printing"] = json!("default");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("sure", 1);
        b["mode"] = json!("deck");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("sure", 1);
        b["detail"] = json!({"x": "y".repeat(MAX_DETAIL)});
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("sure", 1);
        b["detail"] = json!([1]);
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        // A clock gone wrong is kept without its time, not refused.
        let mut b = body("sure", -5);
        b["printing_ms"] = json!(f64::MAX);
        assert_eq!(post(b).await, StatusCode::OK);
        let (ms, pms): (Option<i64>, Option<i64>) = sqlx::query_as("SELECT ms, printing_ms FROM scan_timings").fetch_one(&pool).await.unwrap();
        assert_eq!((ms, pms), (None, None));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn keep_their_own_cap_and_never_push_out_the_struggle_records() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let (them, _) = testutil::user(&pool, "them@example.com").await;
        let mut tx = pool.begin().await.unwrap();
        for i in 0..KEEP {
            sqlx::query("INSERT INTO scan_timings (id, owner_id, created_at, outcome, rule, mode, detail, bytes) VALUES (?, ?, '2026-01-01T00:00:00Z', 'filed', 'sure', 'printing', '{}', 100)")
                .bind(format!("old{i}"))
                .bind(&me)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO scan_timings (id, owner_id, created_at, outcome, rule, mode, detail, bytes) VALUES ('theirs', ?, '2026-01-01T00:00:00Z', 'filed', 'sure', 'printing', '{}', ?)")
            .bind(&them)
            .bind(KEEP_BYTES)
            .execute(&mut *tx)
            .await
            .unwrap();
        // A struggle record of mine, older than every timing.
        sqlx::query("INSERT INTO scan_diagnostics (id, owner_id, created_at, outcome, detail, images, bytes) VALUES ('00000000-0000-0000-0000-000000000001', ?, '2025-01-01T00:00:00Z', 'left', '{}', '[]', 0)")
            .bind(&me)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let (status, res) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(body("leads", 500))).await;
        assert_eq!(status, StatusCode::OK);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(count, KEEP);
        let newest: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings WHERE id = ?").bind(res["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(newest, 1);
        let struggles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(struggles, 1);
        let theirs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings WHERE id = 'theirs'").fetch_one(&pool).await.unwrap();
        assert_eq!(theirs, 1);

        // The byte cap: one big old record goes when a new one would pass it.
        sqlx::query("DELETE FROM scan_timings WHERE owner_id = ?").bind(&me).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO scan_timings (id, owner_id, created_at, outcome, rule, mode, detail, bytes) VALUES ('big', ?, '2026-01-01T00:00:00Z', 'filed', 'sure', 'printing', '{}', ?)")
            .bind(&me)
            .bind(KEEP_BYTES)
            .execute(&pool)
            .await
            .unwrap();
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(body("leads", 500))).await;
        assert_eq!(status, StatusCode::OK);
        let big: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings WHERE id = 'big'").fetch_one(&pool).await.unwrap();
        assert_eq!(big, 0);
    }

    #[tokio::test]
    async fn an_upload_begun_before_delete_them_isnt_kept() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        // Delete them records its moment.
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&token), None).await;
        assert_eq!(d["deleted"], 0);
        let at: String = sqlx::query_scalar("SELECT cleared_at FROM scan_clears WHERE owner_id = ? AND kind = 'diagnostics'").bind(&me).fetch_one(&pool).await.unwrap();
        assert!(at.ends_with('Z') && at.contains('.'), "{at}");
        // A deletion later than this upload's start (as if it ran while the upload was on its way):
        // the timing record and a struggle record are refused, and nothing stays.
        sqlx::query("UPDATE scan_clears SET cleared_at = '9999-01-01T00:00:00.000Z' WHERE owner_id = ?").bind(&me).execute(&pool).await.unwrap();
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(body("sure", 400))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&token), Some(crate::scan_diagnostics::tests::body("picked"))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let rows: (i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM scan_timings WHERE owner_id = ?1), (SELECT COUNT(*) FROM scan_diagnostics WHERE owner_id = ?1)").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, (0, 0));
        let dir = crate::scan_diagnostics::owner_dir(&std::env::temp_dir(), &me);
        assert_eq!(std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0), 0, "the refused record's images went too");
        // An upload begun after the deletion is kept.
        sqlx::query("UPDATE scan_clears SET cleared_at = '2000-01-01T00:00:00.000Z' WHERE owner_id = ?").bind(&me).execute(&pool).await.unwrap();
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(body("sure", 400))).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn go_with_the_account() {
        let (app, pool) = testutil::app().await;
        let (pat, token) = testutil::user(&pool, "pat@example.com").await;
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(body("sure", 400))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, report) = testutil::send(&app, Method::DELETE, "/api/me", Some(&token), Some(json!({"confirm_email": "pat@example.com"}))).await;
        assert_eq!(status, StatusCode::OK, "{report}");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_timings WHERE owner_id = ?").bind(&pat).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 0);
    }
}
