//! Versioned private source evidence. Importing does not publish, alter decks or log games.
mod model;
mod recency;
#[cfg(test)]
mod tests;

use crate::admin::AdminUser;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{NaiveDate, Utc};
use flate2::{Compression, read::MultiGzDecoder, write::GzEncoder};
use model::{Document, Kind, Observation};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::io::{Read, Write};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/datasets", get(list_route))
        .route(
            "/api/datasets/import",
            post(import_route).layer(DefaultBodyLimit::max(model::MAX_UPLOAD)),
        )
        .route("/api/datasets/{id}", get(read_route))
        .route("/api/datasets/{id}/export", get(export_route))
        .layer(axum::middleware::from_fn(
            |req: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(req).await;
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                response
            },
        ))
}

pub fn decode(input: &[u8]) -> AppResult<Vec<u8>> {
    let bytes = if input.starts_with(&[0x1f, 0x8b]) {
        if input.len() > model::MAX_UPLOAD {
            return Err(AppError::bad("compressed dataset exceeds 32 MiB"));
        }
        let mut out = Vec::new();
        MultiGzDecoder::new(input)
            .take((model::MAX_BYTES + 1) as u64)
            .read_to_end(&mut out)
            .map_err(|_| AppError::bad("invalid gzip dataset"))?;
        out
    } else {
        input.to_vec()
    };
    if bytes.len() > model::MAX_BYTES {
        return Err(AppError::bad("decoded dataset exceeds 128 MiB"));
    }
    Ok(bytes)
}

pub async fn import(
    pool: &SqlitePool,
    owner: &str,
    bytes: &[u8],
    dry_run: bool,
) -> AppResult<Value> {
    if bytes.len() > model::MAX_BYTES {
        return Err(AppError::bad("decoded dataset exceeds 128 MiB"));
    }
    let doc: Document = serde_json::from_slice(bytes)
        .map_err(|e| AppError::bad(format!("invalid dataset: {e}")))?;
    let counts = doc.validate()?;
    let hash = sha256_hex(
        std::str::from_utf8(bytes).map_err(|_| AppError::bad("dataset must be UTF-8 JSON"))?,
    );
    if dry_run {
        return Ok(
            json!({"id":doc.id,"valid":true,"dry_run":true,"content_hash":hash,"records":counts,"source_documents":doc.sources.len()}),
        );
    }
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(bytes).map_err(anyhow::Error::from)?;
    let gz = gz.finish().map_err(anyhow::Error::from)?;
    let metadata = json!({"id":doc.id,"title":doc.title,"generated_at":doc.generated_at,"source":doc.source,
        "method":doc.method,"coverage":doc.coverage,"sources":doc.sources,"records":counts});
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM evidence_datasets WHERE owner_id=? AND external_id=?")
            .bind(owner)
            .bind(&doc.id)
            .fetch_optional(&mut *tx)
            .await?;
    let dataset = match existing {
        Some(id) => id,
        None => {
            let id = new_id();
            sqlx::query("INSERT INTO evidence_datasets(id,owner_id,external_id) VALUES(?,?,?)")
                .bind(&id)
                .bind(owner)
                .bind(&doc.id)
                .execute(&mut *tx)
                .await?;
            id
        }
    };
    let previous: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM evidence_dataset_revisions WHERE dataset_id=? AND content_hash=?",
    )
    .bind(&dataset)
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(revision) = previous {
        let active:i64=sqlx::query_scalar("SELECT r.revision FROM evidence_datasets d JOIN evidence_dataset_revisions r ON r.id=d.current_revision_id WHERE d.id=?")
            .bind(&dataset).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        return Ok(
            json!({"id":doc.id,"changed":false,"revision":revision,"active_revision":active,"content_hash":hash,"records":counts}),
        );
    }
    let revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision),0)+1 FROM evidence_dataset_revisions WHERE dataset_id=?",
    )
    .bind(&dataset)
    .fetch_one(&mut *tx)
    .await?;
    let id = new_id();
    sqlx::query("INSERT INTO evidence_dataset_revisions(id,dataset_id,revision,content_hash,metadata,document_gz,imported_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(&dataset).bind(revision).bind(&hash).bind(metadata.to_string()).bind(gz).bind(now()).execute(&mut *tx).await?;
    for record in &doc.records {
        sqlx::query("INSERT INTO evidence_dataset_records(revision_id,id,kind,entity,search_label,document) VALUES(?,?,?,?,?,?)")
            .bind(&id).bind(&record.id).bind(record.kind.as_str()).bind(&record.entity).bind(record.label().to_lowercase())
            .bind(serde_json::to_string(record).map_err(anyhow::Error::from)?).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE evidence_datasets SET current_revision_id=? WHERE id=?")
        .bind(&id)
        .bind(&dataset)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(
        json!({"id":doc.id,"changed":true,"revision":revision,"active_revision":revision,"content_hash":hash,"records":counts}),
    )
}

fn compact(metadata: &str, revision: i64, hash: &str, imported: &str) -> AppResult<Value> {
    let mut out: Value = serde_json::from_str(metadata).map_err(anyhow::Error::from)?;
    let count = out["sources"].as_array().map_or(0, Vec::len);
    out.as_object_mut().unwrap().remove("sources");
    out["source_documents"] = json!(count);
    out["revision"] = json!(revision);
    out["content_hash"] = json!(hash);
    out["imported_at"] = json!(imported);
    out["visibility"] = json!("private");
    Ok(out)
}

pub async fn list(pool: &SqlitePool, owner: &str) -> AppResult<Value> {
    let rows:Vec<(String,i64,String,String)>=sqlx::query_as("SELECT r.metadata,r.revision,r.content_hash,r.imported_at FROM evidence_datasets d JOIN evidence_dataset_revisions r ON r.id=d.current_revision_id WHERE d.owner_id=? ORDER BY r.imported_at DESC,d.external_id LIMIT 100")
        .bind(owner).fetch_all(pool).await?;
    let values:Result<Vec<_>,AppError>=rows.into_iter().map(|(meta,rev,hash,at)| {
        let head=compact(&meta,rev,&hash,&at)?;
        Ok(json!({"id":head["id"],"title":head["title"],"revision":head["revision"],"content_hash":head["content_hash"],
            "source":{"name":head["source"]["name"],"url":head["source"]["url"]},"records":head["records"],
            "source_documents":head["source_documents"],"imported_at":head["imported_at"],"visibility":"private"}))
    }).collect();
    Ok(json!(values?))
}

struct Revision {
    id: String,
    metadata: String,
    revision: i64,
    hash: String,
    imported: String,
}
async fn revision(
    pool: &SqlitePool,
    owner: &str,
    key: &str,
    number: Option<i64>,
) -> AppResult<Revision> {
    if number.is_some_and(|n| n < 1) {
        return Err(AppError::bad("revision must be positive"));
    }
    let row:Option<(String,String,i64,String,String)>=sqlx::query_as("SELECT r.id,r.metadata,r.revision,r.content_hash,r.imported_at FROM evidence_datasets d JOIN evidence_dataset_revisions r ON r.dataset_id=d.id WHERE d.owner_id=? AND d.external_id=? AND ((? IS NULL AND r.id=d.current_revision_id) OR r.revision=?)")
        .bind(owner).bind(key).bind(number).bind(number).fetch_optional(pool).await?;
    let Some((id, metadata, revision, hash, imported)) = row else {
        return Err(AppError::NotFound("dataset"));
    };
    Ok(Revision {
        id,
        metadata,
        revision,
        hash,
        imported,
    })
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadQuery {
    pub revision: Option<i64>,
    pub section: Option<String>,
    pub kind: Option<Kind>,
    pub entity: Option<String>,
    pub search: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub as_of: Option<NaiveDate>,
    pub half_life_days: Option<u32>,
}
impl ReadQuery {
    fn validate(&self) -> AppResult<(i64, i64, u32)> {
        let (limit, offset, half) = (
            self.limit.unwrap_or(10),
            self.offset.unwrap_or(0),
            self.half_life_days
                .unwrap_or(recency::DEFAULT_HALF_LIFE_DAYS),
        );
        if !(1..=50).contains(&limit)
            || !(0..=200_000).contains(&offset)
            || !(1..=3650).contains(&half)
        {
            return Err(AppError::bad(
                "limit must be 1–50, offset 0–200000, half_life_days 1–3650",
            ));
        }
        if self
            .section
            .as_deref()
            .is_some_and(|s| !matches!(s, "records" | "sources"))
            || self.entity.as_ref().is_some_and(|s| !model::key(s))
            || self.search.as_ref().is_some_and(|s| s.len() > 240)
        {
            return Err(AppError::bad("invalid dataset section, entity or search"));
        }
        Ok((limit, offset, half))
    }
}

fn projection(mut record: Value) -> Value {
    if record["kind"] == "commander_history" {
        let d = &record["data"];
        let weekly = d["graphs"]["weekly_games_played"].as_object();
        let elo = d["graphs"]["elo_rating"].as_array();
        let mut weeks: Vec<_> = weekly.into_iter().flat_map(|m| m.keys()).collect();
        weeks.sort();
        record["data"] = json!({"id":d["id"],"name":d["name"],"stats":d["stats"],"cached_elo":d["cached_elo"],
            "weekly_points":weeks.len(),"first_week":weeks.first(),"last_week":weeks.last(),
            "elo_points":elo.map_or(0,Vec::len),"latest_elo_point":elo.and_then(|e|e.last()),
            "note":"Full graphs retained in the private dataset export. ELO sequence positions have no inferred calendar dates."});
    }
    if record["data"].to_string().len() > 16_384 {
        let bytes = record["data"].to_string().len();
        record["data"] = json!({"omitted":true,"bytes":bytes,"note":"Large data retained in the private dataset export."});
    }
    record
}

pub async fn read(pool: &SqlitePool, owner: &str, key: &str, q: ReadQuery) -> AppResult<Value> {
    let (limit, offset, half) = q.validate()?;
    let r = revision(pool, owner, key, q.revision).await?;
    let head = compact(&r.metadata, r.revision, &r.hash, &r.imported)?;
    if q.section.as_deref() == Some("sources") {
        let meta: Value = serde_json::from_str(&r.metadata).map_err(anyhow::Error::from)?;
        let all = meta["sources"].as_array().unwrap();
        let sources: Vec<_> = all
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .cloned()
            .collect();
        let next = offset + sources.len() as i64;
        return Ok(
            json!({"dataset":head,"sources":sources,"next_offset":(next<(all.len() as i64)).then_some(next)}),
        );
    }
    let search = q.search.as_ref().map(|s| s.to_lowercase());
    let rows:Vec<String>=sqlx::query_scalar("SELECT document FROM evidence_dataset_records WHERE revision_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR entity=?) AND (? IS NULL OR instr(search_label,?)>0) ORDER BY id LIMIT ? OFFSET ?")
        .bind(&r.id).bind(q.kind.map(Kind::as_str)).bind(q.kind.map(Kind::as_str)).bind(&q.entity).bind(&q.entity)
        .bind(&search).bind(&search).bind(limit+1).bind(offset).fetch_all(pool).await?;
    let more = rows.len() > limit as usize;
    let mut records = Vec::new();
    let mut budget = 0;
    for row in rows.into_iter().take(limit as usize) {
        let mut value = projection(serde_json::from_str(&row).map_err(anyhow::Error::from)?);
        if budget + value.to_string().len() > 256_000 {
            value["data"] = json!({"omitted":true,"note":"Response byte budget; narrow the entity or download the private dataset export."});
        }
        budget += value.to_string().len();
        records.push(value);
    }
    let mut summaries = Vec::new();
    let mut summary_note = None;
    if let Some(entity) = &q.entity {
        if q.kind.is_none() || q.kind == Some(Kind::Performance) {
            let rows:Vec<String>=sqlx::query_scalar("SELECT document FROM evidence_dataset_records WHERE revision_id=? AND entity=? AND kind='performance' ORDER BY id LIMIT 10001")
                .bind(&r.id).bind(entity).fetch_all(pool).await?;
            if rows.len() > 10_000 {
                summary_note = Some(
                    "Too many observations for a bounded monthly summary; records remain available.",
                );
            } else {
                let meta: Value = serde_json::from_str(&r.metadata).map_err(anyhow::Error::from)?;
                let partial: std::collections::HashSet<&str> = meta["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| {
                        s["flags"].as_array().is_some_and(|flags| {
                            flags.iter().any(|f| f == "partial_archive_capture")
                        })
                    })
                    .filter_map(|s| s["sha256"].as_str())
                    .collect();
                let observations: Result<Vec<Observation>, serde_json::Error> = rows
                    .into_iter()
                    .map(|s| {
                        let record: Value = serde_json::from_str(&s)?;
                        let mut o: Observation = serde_json::from_value(record["data"].clone())?;
                        if record["sources"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|s| partial.contains(s))
                        {
                            o.quality_flags.push("partial_archive_capture".into());
                        }
                        Ok(o)
                    })
                    .collect();
                summaries = recency::summaries(
                    &observations.map_err(anyhow::Error::from)?,
                    q.as_of.unwrap_or_else(|| Utc::now().date_naive()),
                    half,
                );
                if summaries.len() > 50 {
                    summaries.clear();
                    summary_note = Some(
                        "Too many cohorts for a bounded monthly summary; records remain available.",
                    );
                }
            }
        }
    }
    Ok(
        json!({"dataset":head,"records":records,"next_offset":more.then_some(offset+limit),
        "monthly_summaries":summaries,"summary_note":summary_note,
        "recency_policy":{"half_life_days":half,"calendar_months":"sample and exponential recency weighted at month midpoints; descriptive source-rate average",
            "cumulative_snapshots":"preserved separately, never summed","rolling_windows":"preserved separately, never pooled","unknown_periods":"excluded from recency averages"}}),
    )
}

async fn list_route(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> AppResult<Json<Value>> {
    Ok(Json(list(&st.pool, &user.id).await?))
}
async fn read_route(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<ReadQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(read(&st.pool, &user.id, &id, q).await?))
}
async fn import_route(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    // Require a non-simple content type, as JSON extractors on the other write APIs do.
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split(';').next())
        .map(str::trim);
    if !content_type.is_some_and(|c| {
        c.eq_ignore_ascii_case("application/json") || c.eq_ignore_ascii_case("application/gzip")
    }) {
        return Err(AppError::bad(
            "use Content-Type application/json or application/gzip",
        ));
    }
    let bytes = decode(&body)?;
    Ok(Json(import(&st.pool, &user.id, &bytes, false).await?))
}
#[derive(Deserialize)]
struct ExportQuery {
    revision: Option<i64>,
}
async fn export_route(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> AppResult<(HeaderMap, Vec<u8>)> {
    let r = revision(&st.pool, &user.id, &id, q.revision).await?;
    let bytes: Vec<u8> =
        sqlx::query_scalar("SELECT document_gz FROM evidence_dataset_revisions WHERE id=?")
            .bind(r.id)
            .fetch_one(&st.pool)
            .await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/gzip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        "attachment; filename=dataset.json.gz".parse().unwrap(),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok((headers, bytes))
}

pub async fn cli(pool: &SqlitePool, file: &str, email: &str, dry_run: bool) -> anyhow::Result<()> {
    let owner = crate::decks::cli::owner_id(pool, email).await?;
    let mut encoded = Vec::new();
    std::fs::File::open(file)?
        .take((model::MAX_BYTES + 1) as u64)
        .read_to_end(&mut encoded)?;
    if encoded.len() > model::MAX_BYTES {
        anyhow::bail!("dataset file exceeds 128 MiB")
    }
    let bytes = decode(&encoded).map_err(|e| anyhow::anyhow!("{e}"))?;
    let report = import(pool, &owner, &bytes, dry_run)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
