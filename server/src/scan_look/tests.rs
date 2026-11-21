use super::*;
use crate::testutil;
use axum::http::{Method, StatusCode};
use std::sync::Mutex as StdMutex;

const V1: &str = "152f52c100f0080c98e0ce7063b6fe9444e0c8654b1142772339af84138b79e7";
const V0: &str = "58acfa166105c3001445589ec11db98d5ed61f1a70a63dc133dca00fa6bd271d";

#[test]
fn grid_sample_is_onnxruntimes_bilinear_with_zeros_outside() {
    // One channel, 2 × 2: 0 1 / 2 3.
    let x = [0.0, 1.0, 2.0, 3.0];
    // align_corners: −1 and 1 are the corner pixels' centres; 0 is the middle.
    let grid = [-1.0, -1.0, 1.0, 1.0, 0.0, 0.0, 1.0, -1.0];
    assert_eq!(grid_sample(&x, 1, 2, 2, &grid, 1, 4, true), vec![0.0, 3.0, 1.5, 1.0]);
    // Without it −1 and 1 are the picture's edges: half a pixel outside, mixed with the zeros there.
    let out = grid_sample(&x, 1, 2, 2, &[-1.0, -1.0, 0.0, 0.0], 1, 2, false);
    assert_eq!(out, vec![0.0, 1.5]);
    let out = grid_sample(&x, 1, 2, 2, &[1.0, 1.0], 1, 1, false);
    assert!((out[0] - 0.75).abs() < 1e-6, "{out:?}");
    // Far outside: nothing.
    assert_eq!(grid_sample(&x, 1, 2, 2, &[5.0, 5.0, f32::NAN, 0.0], 1, 2, true), vec![0.0, 0.0]);
    // Channels are sampled alike.
    let two = [0.0, 1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 13.0];
    assert_eq!(grid_sample(&two, 2, 2, 2, &[0.0, 0.0], 1, 1, true), vec![1.5, 11.5]);
}

#[test]
fn vectors_are_kept_as_float16_symbol_then_card() {
    let v = LookVector { symbol: (0..DIM).map(|i| i as f32 / 1000.0).collect(), card: (0..DIM).map(|i| -(i as f32) / 500.0).collect() };
    let bytes = v.to_f16();
    assert_eq!(bytes.len(), 512);
    let back = LookVector::from_f16(&bytes).unwrap();
    for (a, b) in v.symbol.iter().chain(&v.card).zip(back.symbol.iter().chain(&back.card)) {
        assert!((a - b).abs() <= a.abs() / 1000.0 + 1e-6, "{a} {b}");
    }
    assert_eq!(back.symbol.len(), DIM);
    assert!(LookVector::from_f16(&bytes[..510]).is_none());
}

fn jpeg(w: u32, h: u32, shade: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, _| image::Rgb([shade, (x % 255) as u8, 100]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

#[test]
fn pictures_are_decoded_to_rgba_and_broken_ones_refused() {
    let (px, w, h) = decode_jpeg(&jpeg(48, 32, 200)).unwrap();
    assert_eq!((w, h, px.len()), (48, 32, 48 * 32 * 4));
    assert!(px.chunks_exact(4).all(|p| p[3] == 255 && p[0].abs_diff(200) < 8 && p[2].abs_diff(100) < 8));
    // A grey JPEG comes out as RGBA too.
    let grey = image::GrayImage::from_fn(16, 8, |_, _| image::Luma([90]));
    let mut out = std::io::Cursor::new(Vec::new());
    grey.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    let (px, w, h) = decode_jpeg(&out.into_inner()).unwrap();
    assert_eq!((w, h), (16, 8));
    assert!(px.chunks_exact(4).all(|p| p[0] == p[1] && p[1] == p[2] && p[0].abs_diff(90) < 4));
    // Not a JPEG, or one cut short: an error for that picture, never a crash.
    assert!(decode_jpeg(b"GIF89a....").is_err());
    let whole = jpeg(64, 64, 10);
    assert!(decode_jpeg(&whole[..40]).is_err());
    assert!(decode_jpeg(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).is_err());
}

#[test]
fn every_look_model_of_ours_has_a_parity_file() {
    let files = look_files();
    assert!(files.iter().any(|(_, s)| *s == V1) && files.iter().any(|(_, s)| *s == V0));
    // look-v1-sure runs v1's file: listed once.
    assert_eq!(files.iter().filter(|(_, s)| *s == V1).count(), 1);
    for (o, sha) in files {
        let found = PARITY.iter().filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok()).any(|p| p["model"] == sha);
        assert!(found, "{} has no web/src/scanner/eval/look-parity-*.json, so the server would make no vectors for it", o.id);
    }
}

#[test]
fn a_phone_names_the_model_by_its_file_and_withdrawn_ones_get_nothing() {
    let off = |ids: &[&str]| {
        let mut cfg = testutil::config();
        cfg.scan_withdrawn = ids.iter().map(|s| s.to_string()).collect();
        Withdrawn::of(&cfg)
    };
    assert_eq!(model_of("look-152f52c100f0", &off(&[])), Some(V1));
    assert_eq!(model_of("look-58acfa166105", &off(&[])), Some(V0));
    // v1 withdrawn alone: the option that settles still runs its file.
    assert_eq!(model_of("look-152f52c100f0", &off(&["look-v1"])), Some(V1));
    assert_eq!(model_of("look-152f52c100f0", &off(&["look-v1", "look-v1-sure"])), None);
    assert_eq!(model_of("look-58acfa166105", &off(&["look-v0"])), None);
    // Not a look model, or not one of ours.
    assert_eq!(model_of("query-b6d9f6a1a0c8", &off(&[])), None);
    assert_eq!(model_of("look-000000000000", &off(&[])), None);
    assert_eq!(model_of("../look-152f52c100f0", &off(&[])), None);
}

/// A bundle folder with a manifest and the look models' files (the right size; never run here).
fn fake_bundle(data_dir: &Path, models: &[&str]) {
    let dir = bundle_dir(data_dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), serde_json::json!({"recogniser": {"sha256": "x"}, "constants": {"scene": 640}}).to_string()).unwrap();
    for sha in models {
        let f = std::fs::File::create(dir.join(format!("look-{}.onnx", &sha[..12]))).unwrap();
        f.set_len(9_292_149).unwrap();
    }
}

fn url(id: &str, back: bool) -> String {
    format!("https://cards.scryfall.io/normal/{}/a/a/{id}.jpg?1700000000", if back { "back" } else { "front" })
}

/// Printings: art `shared` on three (one Japanese, one digital), `alone` on one, and a two-faced
/// card whose back art two printings share.
async fn seed(pool: &SqlitePool) {
    sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('o1', 'Sol Ring', 'normal', '', '', 1, '2026-11-21'), ('o2', 'Front // Back', 'transform', '', '', 1, '2026-11-21')")
        .execute(pool)
        .await
        .unwrap();
    // (id, oracle, set, lang, digital, released, art, back art)
    let rows: [(&str, &str, &str, &str, i64, &str, &str, Option<&str>); 7] = [
        ("aa000000-0000-0000-0000-000000000001", "o1", "ecc", "en", 0, "2025-08-01", "shared", None),
        ("aa000000-0000-0000-0000-000000000002", "o1", "c21", "en", 0, "2021-04-23", "shared", None),
        ("aa000000-0000-0000-0000-000000000003", "o1", "c21", "ja", 0, "2021-04-23", "shared", None),
        ("aa000000-0000-0000-0000-000000000004", "o1", "lea", "en", 0, "1993-08-05", "alone", None),
        ("aa000000-0000-0000-0000-000000000005", "o1", "prm", "en", 1, "2026-01-01", "shared", None),
        ("aa000000-0000-0000-0000-000000000006", "o2", "isd", "en", 0, "2011-09-30", "front1", Some("backs")),
        ("aa000000-0000-0000-0000-000000000007", "o2", "dbl", "en", 0, "2021-11-19", "front2", Some("backs")),
    ];
    for (id, oracle, set, lang, digital, released, art, back) in rows {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, digital, released_at, image_normal, back_image_normal, illustration_id, back_illustration_id, updated_at)
             VALUES (?, ?, 'Card', ?, 'Set', '1', ?, ?, ?, ?, ?, ?, ?, '2026-11-21')",
        )
        .bind(id).bind(oracle).bind(set).bind(lang).bind(digital).bind(released)
        .bind(url(id, false)).bind(back.map(|_| url(id, true)))
        .bind(art).bind(back)
        .execute(pool).await.unwrap();
    }
}

/// A stand-in look model: each part a unit vector from the picture's mean colour.
struct MeanColour;
impl LookEmbed for MeanColour {
    fn embed(&self, rgba: &[u8], _: usize, _: usize) -> anyhow::Result<LookVector> {
        let mut v = vec![0f32; DIM];
        for p in rgba.chunks_exact(4) {
            v[0] += p[0] as f32;
            v[1] += p[1] as f32;
            v[2] += p[2] as f32 + 1.0;
        }
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        let v: Vec<f32> = v.into_iter().map(|x| x / n).collect();
        Ok(LookVector { symbol: v.clone(), card: v })
    }
}

/// Serves a JPEG for every picture but `missing`; records each request.
fn fake(asked: Arc<StdMutex<Vec<String>>>, missing: &'static str, loads: Arc<StdMutex<Vec<String>>>) -> Deps {
    Deps {
        fetch: Arc::new(move |u: String| {
            asked.lock().unwrap().push(u.clone());
            Box::pin(async move { Ok(if u.contains(missing) { Fetched::Missing } else { Fetched::Image(jpeg(24, 32, if u.contains("/back/") { 220 } else { 30 })) }) })
        }),
        load: Arc::new(move |path: &Path, sha: &str| {
            assert!(path.ends_with(format!("look-{}.onnx", &sha[..12])), "{path:?}");
            loads.lock().unwrap().push(sha.to_string());
            Ok(Arc::new(MeanColour) as Arc<dyn LookEmbed>)
        }),
    }
}

fn quick() -> Options {
    Options { pause: Some(Duration::ZERO), backoff: Some(Duration::from_millis(1)), ..Options::default() }
}

async fn made(pool: &SqlitePool, model: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT url FROM scan_looks WHERE model = ? AND vector IS NOT NULL ORDER BY url").bind(model).fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn the_background_makes_the_default_models_vectors_for_shared_art_only() {
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path(), &[V0, V1]);
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let (asked, loads) = (Arc::new(StdMutex::new(Vec::new())), Arc::new(StdMutex::new(Vec::new())));
    let deps = fake(asked.clone(), "aa000000-0000-0000-0000-000000000005", loads.clone());
    let mut runners = Runners::new();
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    // The shared art's English paper printings first (newest first), then the others; the back
    // faces that share art by their back picture; never the art one printing has.
    let a = |n: u8, back: bool| url(&format!("aa000000-0000-0000-0000-00000000000{n}"), back);
    assert_eq!(*asked.lock().unwrap(), vec![a(1, false), a(7, true), a(2, false), a(6, true), a(5, false), a(3, false)]);
    assert_eq!((r.made, r.failed, r.stopped.as_deref(), r.model.as_deref()), (5, 1, None, Some(V1)));
    // Only the slot's default (v1), loaded once.
    assert_eq!(*loads.lock().unwrap(), vec![V1.to_string()]);
    assert_eq!(made(&pool, V1).await.len(), 5);
    assert!(made(&pool, V0).await.is_empty());
    let (error, tries): (String, i64) = sqlx::query_as("SELECT error, tries FROM scan_looks WHERE url = ?").bind(a(5, false)).fetch_one(&pool).await.unwrap();
    assert!(error.contains("no such picture"), "{error}");
    assert_eq!(tries, 1);

    // Done: the next run fetches nothing (the failed one waits a day).
    asked.lock().unwrap().clear();
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    assert_eq!((r.made, r.failed), (0, 0));
    assert!(asked.lock().unwrap().is_empty());
    // A day later it's tried again, up to five times.
    sqlx::query("UPDATE scan_looks SET updated_at = '2026-01-01T00:00:00Z' WHERE vector IS NULL").execute(&pool).await.unwrap();
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    assert_eq!(r.failed, 1);
    let tries: i64 = sqlx::query_scalar("SELECT tries FROM scan_looks WHERE vector IS NULL").fetch_one(&pool).await.unwrap();
    assert_eq!(tries, 2);
    sqlx::query("UPDATE scan_looks SET updated_at = '2026-01-01T00:00:00Z', tries = 5 WHERE vector IS NULL").execute(&pool).await.unwrap();
    asked.lock().unwrap().clear();
    run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    assert!(asked.lock().unwrap().is_empty());

    // Scryfall replaced a picture: its new URL is made, and the old row goes once a run is done.
    sqlx::query("UPDATE printings SET image_normal = replace(image_normal, '1700000000', '1800000000') WHERE scryfall_id = 'aa000000-0000-0000-0000-000000000001'")
        .execute(&pool)
        .await
        .unwrap();
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    assert_eq!((r.made, r.dropped), (1, 1));
    let now = made(&pool, V1).await;
    assert!(now.iter().any(|u| u.ends_with("000000000001.jpg?1800000000")) && !now.iter().any(|u| u.ends_with("000000000001.jpg?1700000000")));

    // A look model no longer pinned: its rows go.
    sqlx::query("INSERT INTO scan_looks (model, url, vector, tries, updated_at) VALUES ('0000', ?, x'00', 0, '2026-11-21')").bind(a(2, false)).execute(&pool).await.unwrap();
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut runners, &quick()).await.unwrap();
    assert_eq!(r.dropped, 1);
    // With no look model here, nothing is made and the run says so.
    let none = tempfile::tempdir().unwrap();
    fake_bundle(none.path(), &[]);
    let r = run(&pool, none.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &quick()).await.unwrap();
    assert_eq!((r.made, r.model), (0, None));
}

#[tokio::test]
async fn scryfall_unavailable_stops_the_run_charging_nothing() {
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path(), &[V1]);
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let calls = Arc::new(StdMutex::new(0));
    let c = calls.clone();
    let deps = Deps {
        fetch: Arc::new(move |_| {
            *c.lock().unwrap() += 1;
            Box::pin(async { Ok(Fetched::Unavailable { retry_after: None, why: "HTTP 503".into() }) })
        }),
        load: Arc::new(|_: &Path, _: &str| Ok(Arc::new(MeanColour) as Arc<dyn LookEmbed>)),
    };
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &quick()).await.unwrap();
    assert_eq!(r.stopped.as_deref(), Some("HTTP 503"));
    assert_eq!(*calls.lock().unwrap(), 4);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_looks").fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn a_model_that_fails_its_check_makes_nothing_and_phones_are_told() {
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path(), &[V1]);
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    register(data.path());
    let (asked, loads) = (Arc::new(StdMutex::new(Vec::new())), Arc::new(StdMutex::new(0)));
    let (a, l) = (asked.clone(), loads.clone());
    let deps = Deps {
        fetch: Arc::new(move |u: String| {
            a.lock().unwrap().push(u);
            Box::pin(async { Ok(Fetched::Missing) })
        }),
        load: Arc::new(move |_: &Path, _: &str| {
            *l.lock().unwrap() += 1;
            anyhow::bail!("the look model run here differs from onnxruntime by 1.0e-1")
        }),
    };
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &quick()).await.unwrap();
    assert_eq!((r.made, r.failed), (0, 0));
    assert!(asked.lock().unwrap().is_empty());
    // Not tried again in this process: the next run doesn't load it.
    run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &quick()).await.unwrap();
    assert_eq!(*loads.lock().unwrap(), 1);
    // And phones hear the server makes none for it, so they make their own without asking again.
    let (_, token) = testutil::user(&pool, "broken@example.com").await;
    let mut cfg = testutil::config();
    cfg.data_dir = data.path().to_path_buf();
    cfg.offline = true;
    let app = crate::routes::app(testutil::state_with(cfg, pool).await);
    let (status, body) = testutil::send(&app, Method::GET, "/api/scan/looks?model=look-152f52c100f0&ids=aa000000-0000-0000-0000-000000000001", Some(&token), None).await;
    assert_eq!((status, body["model"].clone(), body["missing"].clone()), (StatusCode::OK, serde_json::Value::Null, serde_json::json!(0)));
}

#[tokio::test]
async fn a_run_woken_by_an_ask_makes_only_the_asks() {
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path(), &[V1]);
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    register(data.path());
    let one = url("aa000000-0000-0000-0000-000000000004", false);
    assert!(want(data.path(), V1, &one));
    assert!(!want(data.path(), V1, &one), "already waiting");
    // A row of an unpinned model and one of a picture no printing has: left for a whole run.
    for (model, u) in [("0000", url("aa000000-0000-0000-0000-000000000001", false)), (V1, "https://cards.scryfall.io/normal/front/a/a/gone.jpg".to_string())] {
        sqlx::query("INSERT INTO scan_looks (model, url, vector, tries, updated_at) VALUES (?, ?, NULL, 0, '2026-01-01')").bind(model).bind(u).execute(&pool).await.unwrap();
    }
    let asked = Arc::new(StdMutex::new(Vec::new()));
    let deps = fake(asked.clone(), "nothing-missing", Arc::new(StdMutex::new(Vec::new())));
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &Options { asks_only: true, ..quick() }).await.unwrap();
    assert_eq!((r.made, r.dropped), (1, 0));
    assert_eq!(*asked.lock().unwrap(), vec![one.clone()]);
    // An ask for a picture that failed in the last day isn't queued: it would only wake the job.
    sqlx::query("UPDATE scan_looks SET vector = NULL, tries = 1, updated_at = ? WHERE url = ?").bind(now()).bind(&one).execute(&pool).await.unwrap();
    let (_, token) = testutil::user(&pool, "asks@example.com").await;
    let mut cfg = testutil::config();
    cfg.data_dir = data.path().to_path_buf();
    cfg.offline = true;
    let app = crate::routes::app(testutil::state_with(cfg, pool.clone()).await);
    let (_, body) = testutil::send(&app, Method::GET, "/api/scan/looks?model=look-152f52c100f0&ids=aa000000-0000-0000-0000-000000000004", Some(&token), None).await;
    assert_eq!(body["missing"], 1);
    assert!(next_wanted(data.path()).is_none());
    // The whole run does the rest, and tidies.
    let r = run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &quick()).await.unwrap();
    assert_eq!((r.made, r.dropped), (6, 2));
}

#[tokio::test]
async fn phones_get_the_vectors_made_and_their_asks_are_made_first() {
    let data = tempfile::tempdir().unwrap();
    fake_bundle(data.path(), &[V0, V1]);
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let (_, token) = testutil::user(&pool, "looks@example.com").await;
    let mut cfg = testutil::config();
    cfg.data_dir = data.path().to_path_buf();
    cfg.offline = true;
    let app = crate::routes::app(testutil::state_with(cfg, pool.clone()).await);
    register(data.path());
    let id = |n: u8| format!("aa000000-0000-0000-0000-00000000000{n}");
    let v = LookVector { symbol: vec![0.5; DIM], card: vec![-0.25; DIM] };
    // Made for v1: printing 1's front and printing 6's back; for v0, printing 2's front.
    for (model, u) in [(V1, url(&id(1), false)), (V1, url(&id(6), true)), (V0, url(&id(2), false))] {
        store(&pool, model, &u, Ok(&v)).await.unwrap();
    }
    let ask = |model: &str, ids: &str| format!("/api/scan/looks?model={model}&ids={ids}");
    let (status, body) = testutil::send(&app, Method::GET, &ask("look-152f52c100f0", &format!("{},{},{},{}-1,{}-1", id(1), id(2), id(4), id(6), id(7))), Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["model"], V1);
    let looks = body["looks"].as_array().unwrap();
    let got: Vec<(&str, &str)> = looks.iter().map(|l| (l["id"].as_str().unwrap(), l["url"].as_str().unwrap())).collect();
    let (one, six) = (url(&id(1), false), url(&id(6), true));
    assert_eq!(got, vec![(id(1).as_str(), one.as_str()), (format!("{}-1", id(6)).as_str(), six.as_str())]);
    let bytes = base64::engine::general_purpose::STANDARD.decode(looks[0]["vector"].as_str().unwrap()).unwrap();
    assert_eq!(LookVector::from_f16(&bytes).unwrap(), v);
    // 2 is made for v0 only (keyed by the model), 4 and 7's back aren't made: all three asked for.
    assert_eq!(body["missing"], 3);
    // v0's own.
    let (_, body) = testutil::send(&app, Method::GET, &ask("look-58acfa166105", &id(2)), Some(&token), None).await;
    assert_eq!((body["model"].as_str(), body["looks"].as_array().unwrap().len()), (Some(V0), 1));

    // The asks are made first, for the model asked about, then the background ones.
    let asked = Arc::new(StdMutex::new(Vec::new()));
    let deps = fake(asked.clone(), "nothing-missing", Arc::new(StdMutex::new(Vec::new())));
    run(&pool, data.path(), &Withdrawn::default(), &deps, &mut Runners::new(), &Options { limit: Some(3), ..quick() }).await.unwrap();
    assert_eq!(*asked.lock().unwrap(), vec![url(&id(2), false), url(&id(4), false), url(&id(7), true)]);
    assert!(made(&pool, V1).await.contains(&url(&id(4), false)), "the art one printing has, made because a phone asked");

    // A model the server makes nothing for, or one withdrawn: nothing, and the phone makes its own.
    let (status, body) = testutil::send(&app, Method::GET, &ask("look-000000000000", &id(1)), Some(&token), None).await;
    assert_eq!((status, body["model"].clone(), body["looks"].as_array().unwrap().len()), (StatusCode::OK, serde_json::Value::Null, 0));
    // Bad or too many IDs.
    let (status, _) = testutil::send(&app, Method::GET, &ask("look-152f52c100f0", "../etc"), Some(&token), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let many: Vec<String> = (0..=MAX_IDS).map(|i| format!("aa000000-0000-0000-0000-{i:012}")).collect();
    let (status, _) = testutil::send(&app, Method::GET, &ask("look-152f52c100f0", &many.join(",")), Some(&token), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Signed in only, as the other scan routes.
    let (status, _) = testutil::send(&app, Method::GET, &ask("look-152f52c100f0", &id(1)), None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn withdrawn_models_are_served_nothing() {
    let data = tempfile::tempdir().unwrap();
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let (_, token) = testutil::user(&pool, "looks@example.com").await;
    store(&pool, V1, &url("aa000000-0000-0000-0000-000000000001", false), Ok(&LookVector { symbol: vec![0.1; DIM], card: vec![0.1; DIM] })).await.unwrap();
    let mut cfg = testutil::config();
    cfg.data_dir = data.path().to_path_buf();
    cfg.offline = true;
    cfg.scan_withdrawn = vec!["look-v1".into(), "look-v1-sure".into()];
    let app = crate::routes::app(testutil::state_with(cfg, pool).await);
    let (status, body) = testutil::send(&app, Method::GET, "/api/scan/looks?model=look-152f52c100f0&ids=aa000000-0000-0000-0000-000000000001", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["model"], serde_json::Value::Null);
    assert!(body["looks"].as_array().unwrap().is_empty());
}

/// The real model against onnxruntime's outputs, and one picture made with it:
/// `SCANNER_LOOK_MODEL=<yama-look-v1.onnx> cargo test -p yama-server scan_look -- --ignored`.
#[test]
#[ignore = "needs a look model file (SCANNER_LOOK_MODEL)"]
fn the_real_model_matches_onnxruntime() {
    let path = std::env::var("SCANNER_LOOK_MODEL").expect("SCANNER_LOOK_MODEL");
    let sha = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(std::fs::read(&path).unwrap()))
    };
    let runner = LookRunner::load(Path::new(&path), &sha).unwrap();
    let (rgba, w, h) = decode_jpeg(&jpeg(488, 680, 90)).unwrap();
    let v = runner.embed(&rgba, w, h).unwrap();
    let norm = |x: &[f32]| x.iter().map(|a| a * a).sum::<f32>().sqrt();
    assert!((norm(&v.symbol) - 1.0).abs() < 1e-4 && (norm(&v.card) - 1.0).abs() < 1e-4);
}
