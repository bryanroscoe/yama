//! The data files phase's board reads at run time (`/api/play/board-data/…`; the board is built
//! with `DATA_BASE_URL` pointing here). Only the two a game needs are served; the rest (phase's
//! deck catalogue, coverage, translations) are a 404, which the board treats as missing.
//!
//! - `scryfall-data.json`: every card's images and basics by oracle id and by name, in the shape
//!   phase's `scripts/gen-scryfall-images.sh` writes, built from Yama's own Scryfall copy. Images
//!   still load from Scryfall in the browser; nothing is bundled.
//! - `card-data.json`: the engine's card data, the same file the server's engine loads, for the
//!   board's in-browser engine (card previews and their rules details).

use super::*;
use axum::http::{HeaderValue, header};
use axum::response::IntoResponse;
use std::sync::OnceLock;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/play/board-data/scryfall-data.json", get(scryfall_data))
        .route("/api/play/board-data/card-data.json", get(card_data))
}

#[derive(sqlx::FromRow)]
struct CardRow {
    oracle_id: String,
    name: String,
    layout: Option<String>,
    mana_cost: Option<String>,
    cmc: f64,
    type_line: String,
    colors: String,
    color_identity: String,
    keywords: String,
    image_normal: Option<String>,
    image_art_crop: Option<String>,
    back_image_normal: Option<String>,
    faces: Option<String>,
    artist: Option<String>,
}

#[derive(Deserialize)]
struct StoredFace {
    name: String,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    type_line: Option<String>,
}

/// One face's images, as phase reads them (`faces[]` in scryfall-data.json).
#[derive(Serialize)]
struct FaceImages {
    normal: Option<String>,
    art_crop: Option<String>,
    artist: Option<String>,
    orientation: &'static str,
}

/// One card's entry, as phase reads it.
#[derive(Serialize)]
struct Entry {
    oracle_id: String,
    face_names: Vec<String>,
    faces: Vec<FaceImages>,
    layout: String,
    name: String,
    mana_cost: String,
    cmc: f64,
    type_line: String,
    colors: Vec<String>,
    color_identity: Vec<String>,
    keywords: Vec<String>,
}

/// Printed sideways (the board turns it to read it): split cards and Rooms as a whole, and a
/// battle face.
fn orientation(layout: &str, type_line: &str) -> &'static str {
    let types = type_line.split(" — ").next().unwrap_or_default();
    if layout == "split" || types.split(' ').any(|t| t == "Battle") { "landscape" } else { "portrait" }
}

/// Yama keeps colours as letters ("WU"); phase reads Scryfall's arrays.
fn letters(colors: &str) -> Vec<String> {
    colors.chars().map(|c| c.to_string()).collect()
}

fn entry(c: CardRow) -> Entry {
    let layout = c.layout.unwrap_or_else(|| "normal".into());
    let stored: Vec<StoredFace> = c.faces.as_deref().and_then(|f| serde_json::from_str(f).ok()).unwrap_or_default();
    let (face_names, faces) = if stored.is_empty() {
        (
            vec![c.name.to_lowercase()],
            vec![FaceImages { normal: c.image_normal.clone(), art_crop: c.image_art_crop.clone(), artist: c.artist.clone(), orientation: orientation(&layout, &c.type_line) }],
        )
    } else {
        let faces = stored
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let type_line = f.type_line.as_deref().unwrap_or(&c.type_line);
                // A two-sided card has a second image; split, adventure and flip cards share one.
                // Yama keeps the art crop of the front only, so a back face shows its whole card.
                let back = i > 0 && c.back_image_normal.is_some();
                let normal = if back { c.back_image_normal.clone() } else { c.image_normal.clone() };
                let art_crop = if back { normal.clone() } else { c.image_art_crop.clone() };
                // A back face must never inherit the front illustration's artist.
                let artist = if c.back_image_normal.is_some() {
                    f.artist.clone().or_else(|| if back { None } else { c.artist.clone() })
                } else {
                    c.artist.clone().or_else(|| stored.first().and_then(|front| front.artist.clone()))
                };
                FaceImages { normal, art_crop, artist, orientation: orientation(&layout, type_line) }
            })
            .collect();
        (stored.iter().map(|f| f.name.to_lowercase()).collect(), faces)
    };
    Entry {
        oracle_id: c.oracle_id,
        face_names,
        faces,
        layout,
        mana_cost: c.mana_cost.unwrap_or_default(),
        cmc: c.cmc,
        type_line: c.type_line,
        colors: letters(&c.colors),
        color_identity: letters(&c.color_identity),
        keywords: serde_json::from_str(&c.keywords).unwrap_or_default(),
        name: c.name,
    }
}

/// The whole map, keyed by oracle id, by name and by the front face's name (all lowercased), as
/// phase's script keys it.
fn build(rows: Vec<CardRow>) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for c in rows {
        let e = entry(c);
        let mut keys = vec![e.oracle_id.to_lowercase(), e.name.to_lowercase()];
        if let Some(front) = e.face_names.first().filter(|f| **f != keys[1]) {
            keys.push(front.clone());
        }
        let value = serde_json::to_value(&e).unwrap_or_default();
        for k in keys {
            out.entry(k).or_insert_with(|| value.clone());
        }
    }
    out
}

/// The built map, gzipped, with the card table's last change it was built from.
static SCRYFALL_DATA: OnceLock<tokio::sync::Mutex<Option<(String, Arc<[u8]>)>>> = OnceLock::new();

async fn scryfall_data(State(st): State<AppState>, _u: CurrentUser) -> AppResult<Response> {
    let changed: Option<String> = sqlx::query_scalar("SELECT MAX(updated_at) FROM cards").fetch_one(&st.pool).await?;
    let changed = changed.unwrap_or_default();
    let mut cached = SCRYFALL_DATA.get_or_init(Default::default).lock().await;
    let body = match &*cached {
        Some((at, body)) if *at == changed => body.clone(),
        _ => {
            let rows: Vec<CardRow> = sqlx::query_as(
                "SELECT oracle_id, name, layout, mana_cost, cmc, type_line, colors, color_identity, keywords,
                        image_normal, image_art_crop, back_image_normal, faces, artist FROM cards",
            )
            .fetch_all(&st.pool)
            .await?;
            let body: Arc<[u8]> = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
                use std::io::Write;
                let json = serde_json::to_vec(&build(rows))?;
                let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                gz.write_all(&json)?;
                Ok(gz.finish()?)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))??
            .into();
            *cached = Some((changed, body.clone()));
            body
        }
    };
    let mut res = axum::body::Body::from(axum::body::Bytes::from_owner(body)).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(res)
}

async fn card_data(State(st): State<AppState>, _u: CurrentUser, req: axum::extract::Request) -> AppResult<Response> {
    let Some(path) = st.cfg.engine_card_data.clone().filter(|p| p.exists()) else {
        return Err(AppError::NotFound("card data"));
    };
    let mut file = tower_http::services::ServeFile::new(path);
    let res = file.try_call(req).await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(res.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, layout: &str, type_line: &str, faces: Option<&str>, back: Option<&str>) -> CardRow {
        CardRow {
            oracle_id: format!("ID-{name}"),
            name: name.into(),
            layout: Some(layout.into()),
            mana_cost: Some("{1}{R}".into()),
            cmc: 2.0,
            type_line: type_line.into(),
            colors: "WU".into(),
            color_identity: "WU".into(),
            keywords: r#"["Flying"]"#.into(),
            image_normal: Some("front.jpg".into()),
            image_art_crop: Some("front-art.jpg".into()),
            back_image_normal: back.map(Into::into),
            faces: faces.map(Into::into),
            artist: Some("Front Artist".into()),
        }
    }

    #[test]
    fn keys_and_faces_as_phase_reads_them() {
        let map = build(vec![
            row("Grizzly Bears", "normal", "Creature — Bear", None, None),
            row(
                "Invasion of Alara // Awaken the Maelstrom",
                "transform",
                "Battle — Siege // Sorcery",
                Some(r#"[{"name":"Invasion of Alara","type_line":"Battle — Siege"},{"name":"Awaken the Maelstrom","type_line":"Sorcery"}]"#),
                Some("back.jpg"),
            ),
            row("Fire // Ice", "split", "Instant // Instant", Some(r#"[{"name":"Fire"},{"name":"Ice"}]"#), None),
        ]);
        let bears = &map["grizzly bears"];
        assert_eq!(map["id-grizzly bears"], *bears);
        assert_eq!(bears["face_names"], serde_json::json!(["grizzly bears"]));
        assert_eq!(bears["faces"][0], serde_json::json!({"normal": "front.jpg", "art_crop": "front-art.jpg", "artist": "Front Artist", "orientation": "portrait"}));
        assert_eq!(bears["colors"], serde_json::json!(["W", "U"]));
        assert_eq!(bears["keywords"], serde_json::json!(["Flying"]));
        let battle = &map["invasion of alara"];
        assert_eq!(map["invasion of alara // awaken the maelstrom"], *battle);
        assert_eq!(battle["faces"][0]["orientation"], "landscape");
        assert_eq!(battle["faces"][1], serde_json::json!({"normal": "back.jpg", "art_crop": "back.jpg", "artist": null, "orientation": "portrait"}));
        let split = &map["fire // ice"];
        assert_eq!(split["faces"][1]["normal"], "front.jpg");
        assert_eq!(split["faces"][1]["orientation"], "landscape");
    }

    #[test]
    fn credits_are_bound_to_the_displayed_printing_and_face() {
        let mut card = row("Front // Back", "transform", "Creature // Creature",
            Some(r#"[{"name":"Front","artist":"Face A"},{"name":"Back","artist":"Face B"}]"#), Some("back.jpg"));
        card.artist = Some("Different root credit".into());
        let map = build(vec![card]);
        assert_eq!(map["front"]["faces"][0]["artist"], "Face A");
        assert_eq!(map["front"]["faces"][1]["artist"], "Face B");
        assert_eq!(map["front"]["faces"][1]["normal"], "back.jpg");
    }
}
