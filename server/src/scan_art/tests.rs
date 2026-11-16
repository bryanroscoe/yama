use super::*;
use crate::testutil;
use axum::http::{Method, StatusCode};
use std::sync::Mutex as StdMutex;

#[test]
fn frames_follow_the_crop_aspect_and_layout() {
    assert_eq!(frame_of(626.0 / 457.0, "normal"), "modern");
    assert_eq!(frame_of(1.62, "normal"), "extended");
    assert_eq!(frame_of(1.24, "normal"), "old");
    assert_eq!(frame_of(1.2, "token"), "token");
    assert_eq!(frame_of(0.947, "token"), "token_tall");
    assert_eq!(frame_of(1.047, "emblem"), "emblem");
    assert_eq!(frame_of(0.88, "normal"), "tall");
    assert_eq!(frame_of(0.415, "saga"), "right");
    assert_eq!(frame_of(0.415, "class"), "left");
}

#[test]
fn area_resize_averages_like_opencv() {
    // 4 × 2 to 2 × 1: each output pixel is the mean of a 2 × 2 block.
    let src: Vec<u8> = [0u8, 10, 20, 30, 40, 50, 60, 70].iter().flat_map(|&v| [v, v, v]).collect();
    let out = resize_area(&src, 4, 2, 2, 1);
    assert_eq!(out, vec![25, 25, 25, 45, 45, 45]);
    // 3 to 2 across: weights 2/3 and 1/3 of the middle pixel (OpenCV gives 3 and 7 here, ties to even).
    let src: Vec<u8> = [0u8, 6, 12].iter().flat_map(|&v| [v, v, v]).collect();
    let out = resize_area(&src, 3, 1, 2, 1);
    assert_eq!(out, vec![2, 2, 2, 10, 10, 10]);
    // A grown side falls back to bilinear and still keeps the size.
    assert_eq!(resize_area(&[9; 3], 1, 1, 4, 4), vec![9; 48]);
}

#[test]
fn art_crop_urls_come_from_the_printing_id() {
    assert_eq!(art_crop_url("fca1528c-84cc-42d2-99ae-9f10f0e28743", false).unwrap(), "https://cards.scryfall.io/art_crop/front/f/c/fca1528c-84cc-42d2-99ae-9f10f0e28743.jpg");
    assert_eq!(art_crop_url("63ba8eef-b834-4031-b0a1-0f8505d53813-1", true).unwrap(), "https://cards.scryfall.io/art_crop/back/6/3/63ba8eef-b834-4031-b0a1-0f8505d53813.jpg");
    assert!(art_crop_url("../x", false).is_none());
}

/// A stand-in for the graph: the crop's mean colour as a unit vector (enough to tell crops apart).
struct MeanColour;
impl Embed for MeanColour {
    fn embed(&self, rgb: &[u8]) -> anyhow::Result<Vec<f32>> {
        let mut v = vec![0f32; 128];
        for (i, p) in rgb.chunks_exact(3).enumerate() {
            v[i % 3] += p[0] as f32;
            v[3 + i % 3] += p[1] as f32 + 1.0;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        Ok(v.into_iter().map(|x| x / norm).collect())
    }
}

fn jpeg(w: u32, h: u32, shade: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, _| image::Rgb([shade, (x % 255) as u8, 100]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

/// A bundle folder that `is_ready` accepts, knowing the illustration `known`.
fn fake_bundle(data_dir: &Path) {
    let dir = bundle_dir(data_dir);
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["detector.onnx", "embed.onnx", "search.onnx", "arts.slim.json.gz"] {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    let frame_names = ["modern", "old", "extended", "tall", "right", "left", "room_0", "room_1", "split_0", "split_1", "aftermath_0", "aftermath_1", "flip_0", "flip_1", "token", "token_tall", "emblem"];
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&serde_json::json!({"constants": {"frame_names": frame_names}, "gallery": {"frame_penalty": 0.02}})).unwrap()).unwrap();
    std::fs::write(
        dir.join(crate::scan::ARTS),
        serde_json::to_vec(&serde_json::json!({"columns": ["id", "name", "set", "number", "illustration_id", "layout", "printings"], "rows": [["old1", "Sol Ring", "ecc", "57", "known", "normal", 3]]})).unwrap(),
    )
    .unwrap();
}

async fn seed(pool: &SqlitePool) {
    for (oracle, name, layout, type_line) in [
        ("o1", "Tricorder", "normal", "Artifact"),
        ("o2", "Sol Ring", "normal", "Artifact"),
        ("o3", "Front // Back", "transform", "Creature // Creature"),
        ("o4", "Fire // Ice", "split", "Instant // Instant"),
        ("o5", "Decklist", "normal", "Card"),
        ("o6", "Saga Thing", "saga", "Enchantment — Saga"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, type_line, color_identity, colors, cmc, updated_at) VALUES (?, ?, ?, ?, '', '', 1, '2026-11-15')")
            .bind(oracle).bind(name).bind(layout).bind(type_line).execute(pool).await.unwrap();
    }
    // (id, oracle, name, set, number, lang, digital, art, back art)
    let rows: [(&str, &str, &str, &str, &str, &str, i64, Option<&str>, Option<&str>); 9] = [
        ("aa000000-0000-0000-0000-000000000001", "o1", "Tricorder", "trk", "270", "en", 0, Some("new1"), None),
        // Same art, older printing: one row per illustration.
        ("aa000000-0000-0000-0000-000000000002", "o1", "Tricorder", "trc", "9", "en", 0, Some("new1"), None),
        ("aa000000-0000-0000-0000-000000000003", "o2", "Sol Ring", "trc", "1", "en", 0, Some("known"), None),
        ("aa000000-0000-0000-0000-000000000004", "o3", "Front // Back", "trk", "5", "en", 0, Some("new2"), Some("new3")),
        ("aa000000-0000-0000-0000-000000000005", "o4", "Fire // Ice", "trk", "6", "en", 0, Some("split"), None),
        ("aa000000-0000-0000-0000-000000000006", "o5", "Decklist", "trk", "7", "en", 0, Some("insert"), None),
        ("aa000000-0000-0000-0000-000000000007", "o1", "Tricorder", "ytrk", "8", "en", 1, Some("digital"), None),
        ("aa000000-0000-0000-0000-000000000008", "o1", "Tricorder", "trk", "270", "ja", 0, Some("japanese"), None),
        ("ab000000-0000-0000-0000-000000000009", "o6", "Saga Thing", "trk", "9", "en", 0, Some("saga"), None),
    ];
    for (id, oracle, name, set, number, lang, digital, art, back) in rows {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, digital, released_at, image_art_crop, back_image_normal, illustration_id, back_illustration_id, updated_at)
             VALUES (?, ?, ?, ?, 'Set', ?, ?, ?, ?, 'https://cards.scryfall.io/art/front/a/a/x.webp', ?, ?, ?, '2026-11-15')",
        )
        .bind(id).bind(oracle).bind(name).bind(set).bind(number).bind(lang).bind(digital)
        .bind(if set == "trk" { "2026-11-13" } else { "2026-11-01" })
        .bind(back.map(|_| "https://cards.scryfall.io/normal/back/a/a/x.jpg"))
        .bind(art).bind(back)
        .execute(pool).await.unwrap();
    }
}

/// Serves art crops by URL; records each request. The saga's crop is half-width; one printing has none.
fn fake_fetch(asked: Arc<StdMutex<Vec<String>>>) -> Fetch {
    Arc::new(move |url: String| {
        asked.lock().unwrap().push(url.clone());
        Box::pin(async move {
            Ok(if url.contains("/back/") {
                Some(jpeg(626, 457, 200))
            } else if url.contains("ab000000") {
                Some(jpeg(300, 720, 50))
            } else if url.contains("art_crop/front/a/a/aa000000-0000-0000-0000-000000000004") {
                None
            } else if url.ends_with(".webp") {
                Some(jpeg(626, 457, 120))
            } else {
                Some(jpeg(626, 457, 10))
            })
        })
    })
}

#[tokio::test]
async fn embeds_only_new_artworks_once_and_writes_a_content_addressed_supplement() {
    let pool = crate::db::test_pool().await;
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path());
    seed(&pool).await;
    let asked = Arc::new(StdMutex::new(Vec::new()));
    let opts = Options { skip_parity: true, ..Options::default() };
    let embedder: Arc<dyn Embed> = Arc::new(MeanColour);

    let report = run(&pool, data.path(), fake_fetch(asked.clone()), Some(embedder.clone()), &opts).await.unwrap();
    // Tricorder (once), Front's front (from the stored WebP: no JPEG), its back, the saga.
    assert_eq!((report.embedded, report.failed, report.rows), (4, 0, 4));
    let file = report.file.clone().unwrap();
    assert!(file.starts_with("supplement-") && file.ends_with(".json"));
    let dir = bundle_dir(data.path());
    assert!(dir.join(&file).exists() && dir.join(format!("{file}.gz")).exists());
    assert_eq!(current(data.path()).await.unwrap().0, file);
    // Never the bundle's own art, a split half, an insert, a digital or a Japanese printing.
    let urls = asked.lock().unwrap().clone();
    assert!(urls.iter().all(|u| !u.contains("-000000000003") && !u.contains("-000000000005") && !u.contains("-000000000006") && !u.contains("-000000000007")));

    let s: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(&file)).unwrap()).unwrap();
    assert_eq!(s["bundle"], BUNDLE_VERSION);
    let rows = s["rows"].as_array().unwrap();
    let names: Vec<_> = rows.iter().map(|r| r[1].as_str().unwrap()).collect();
    assert_eq!(names, ["Front", "Back", "Saga Thing", "Tricorder"]);
    assert_eq!(rows[1][0], "aa000000-0000-0000-0000-000000000004-1");
    assert_eq!(rows[1][4], "new3");
    // Tricorder's art is printed twice (all languages count); its newest printing names it.
    assert_eq!(rows[3][6], 2);
    assert_eq!(rows[3][2], "trk");
    // modern is frame 0; the saga's half-width crop is `right` (4), which pays the rare-frame penalty.
    assert_eq!(s["frames"], serde_json::json!([0, 0, 4, 0]));
    assert_eq!(s["penalties"], serde_json::json!([0.0, 0.0, 0.02, 0.0]));
    let halves = base64::engine::general_purpose::STANDARD.decode(s["vectors"].as_str().unwrap()).unwrap();
    assert_eq!(halves.len(), 4 * 128 * 2);
    let first: f32 = halves[..256].chunks_exact(2).map(|b| half::f16::from_bits(u16::from_le_bytes([b[0], b[1]])).to_f32().powi(2)).sum();
    assert!((first - 1.0).abs() < 0.01, "unit vectors, got {first}");

    // Nothing new: no requests, and the same file.
    asked.lock().unwrap().clear();
    let again = run(&pool, data.path(), fake_fetch(asked.clone()), Some(embedder.clone()), &opts).await.unwrap();
    assert_eq!((again.embedded, again.failed, again.file.as_deref()), (0, 0, Some(file.as_str())));
    assert!(asked.lock().unwrap().is_empty());

    // A new printing brings one more row and a new file; the previous file stays for a while.
    sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, digital, image_art_crop, illustration_id, updated_at) VALUES ('ac000000-0000-0000-0000-00000000000a', 'o1', 'Tricorder', 'tre', 'Set', '1', 'en', 0, 'https://cards.scryfall.io/art/front/a/c/x.webp', 'new4', '2026-11-16')")
        .execute(&pool).await.unwrap();
    let third = run(&pool, data.path(), fake_fetch(asked.clone()), Some(embedder.clone()), &opts).await.unwrap();
    assert_eq!((third.embedded, third.rows), (1, 5));
    let newer = third.file.unwrap();
    assert_ne!(newer, file);
    assert!(dir.join(&file).exists());
    // And once more: the oldest goes.
    sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, digital, image_art_crop, illustration_id, updated_at) VALUES ('ad000000-0000-0000-0000-00000000000b', 'o1', 'Tricorder', 'tre', 'Set', '2', 'en', 0, 'https://cards.scryfall.io/art/front/a/d/x.webp', 'new5', '2026-11-16')")
        .execute(&pool).await.unwrap();
    run(&pool, data.path(), fake_fetch(asked.clone()), Some(embedder), &opts).await.unwrap();
    assert!(!dir.join(&file).exists() && !dir.join(format!("{file}.gz")).exists());
    assert!(dir.join(&newer).exists());

    // Only some sets, written elsewhere, including art the bundle has: what the evals use.
    let out = tempfile::tempdir().unwrap();
    let eval = Options { sets: vec!["trc".into()], include_known: true, out: Some(out.path().to_path_buf()), skip_parity: true, ..Options::default() };
    let r = run(&pool, data.path(), fake_fetch(asked.clone()), Some(Arc::new(MeanColour)), &eval).await.unwrap();
    assert_eq!((r.embedded, r.rows), (1, 1));
    let s: serde_json::Value = serde_json::from_slice(&std::fs::read(out.path().join(r.file.unwrap())).unwrap()).unwrap();
    assert_eq!(s["rows"][0][4], "known");
    // ... which the served supplement still leaves out.
    let served: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(current(data.path()).await.unwrap().0)).unwrap()).unwrap();
    assert!(served["rows"].as_array().unwrap().iter().all(|r| r[4] != "known"));
}

#[tokio::test]
async fn a_failed_artwork_waits_a_day_and_rows_of_other_bundles_go() {
    let pool = crate::db::test_pool().await;
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path());
    seed(&pool).await;
    sqlx::query("INSERT INTO scan_arts (illustration_id, bundle, scryfall_id, name, set_code, collector_number, layout, frame, penalty, vector, updated_at) VALUES ('new1', 'retrain-old', 'x', 'X', 'trk', '1', 'normal', 0, 0, x'00', '2026-11-01')")
        .execute(&pool).await.unwrap();
    let broken: Fetch = Arc::new(|_url: String| Box::pin(async { Ok(Some(b"not an image".to_vec())) }));
    let opts = Options { skip_parity: true, ..Options::default() };
    let r = run(&pool, data.path(), broken.clone(), Some(Arc::new(MeanColour)), &opts).await.unwrap();
    assert_eq!((r.embedded, r.failed, r.rows, r.file), (0, 4, 0, None));
    let old: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_arts WHERE bundle <> ?").bind(BUNDLE_VERSION).fetch_one(&pool).await.unwrap();
    assert_eq!(old, 0);
    let error: String = sqlx::query_scalar("SELECT error FROM scan_arts WHERE illustration_id = 'new1'").fetch_one(&pool).await.unwrap();
    assert!(error.contains("decoding"), "{error}");
    // Within the day: not tried again.
    let r = run(&pool, data.path(), broken, Some(Arc::new(MeanColour)), &opts).await.unwrap();
    assert_eq!(r.failed, 0);
    // A day later it is, and then it works.
    sqlx::query("UPDATE scan_arts SET updated_at = '2026-01-01T00:00:00Z'").execute(&pool).await.unwrap();
    let r = run(&pool, data.path(), fake_fetch(Arc::default()), Some(Arc::new(MeanColour)), &opts).await.unwrap();
    assert_eq!((r.embedded, r.rows), (4, 4));
    // Until the bundle is downloaded, nothing runs.
    let empty = tempfile::tempdir().unwrap();
    assert!(run(&pool, empty.path(), fake_fetch(Arc::default()), Some(Arc::new(MeanColour)), &opts).await.is_err());
}

#[tokio::test]
async fn the_bundle_route_names_the_supplement_and_serves_it_immutable() {
    let pool = crate::db::test_pool().await;
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path());
    seed(&pool).await;
    let opts = Options { skip_parity: true, ..Options::default() };
    let file = run(&pool, data.path(), fake_fetch(Arc::default()), Some(Arc::new(MeanColour)), &opts).await.unwrap().file.unwrap();
    let mut cfg = testutil::config();
    cfg.data_dir = data.path().to_path_buf();
    cfg.offline = true;
    let app = crate::routes::app(testutil::state_with(cfg.clone(), pool.clone()).await);
    let (_, token) = testutil::user(&pool, "scan@example.com").await;
    let (status, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["files"]["supplement"], format!("/scan-bundle/{BUNDLE_VERSION}/{file}"));
    assert!(info["bytes"]["supplement"].as_u64().unwrap() > 1000);

    let res = tower::ServiceExt::oneshot(app.clone(), axum::http::Request::get(format!("/scan-bundle/{BUNDLE_VERSION}/{file}")).body(axum::body::Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[axum::http::header::CACHE_CONTROL], "public, max-age=31536000, immutable");

    // Switched off: not offered.
    cfg.scan_supplement = false;
    let off = crate::routes::app(testutil::state_with(cfg, pool.clone()).await);
    let (_, info) = testutil::send(&off, Method::GET, "/api/scan/bundle", Some(&token), None).await;
    assert!(info["files"]["supplement"].is_null());
    assert_eq!(info["bytes"]["supplement"], 0);
}
