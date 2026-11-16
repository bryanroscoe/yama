//! The scanner's art supplement: artworks the pinned ManaVault bundle (scan.rs) doesn't know yet,
//! embedded here so a new set is recognised by its art within a day of reaching Scryfall instead
//! of waiting for the next bundle (docs/scanner.md, "Extending the gallery").
//!
//! - **Which arts:** English paper printings in Yama's card data with an illustration ID and an
//!   art crop, whose illustration the bundle's `arts.json` doesn't list, in the layouts the bundle
//!   embeds (not split or flip halves, battles or `Card`-typed inserts). Only new ones: each is
//!   embedded once per bundle version and kept in `scan_arts`.
//! - **How:** Scryfall's `art_crop` JPEG, resized straight to 128 × 128 with OpenCV's `INTER_AREA`
//!   rule, /255 and ImageNet-normalised, through the embedding half of the bundle's own
//!   `embed.onnx` (from its normalised input, node `/Div_5`, to `embeddings`), run by tract. That
//!   is exactly how ManaVault builds a gallery row (oracle `degrade.clean_view`, `data.to_tensor`,
//!   `index.ArtIndex`), so the vectors score like the bundle's own. Each run first re-embeds three
//!   artworks the bundle has and stops if they don't match their gallery rows.
//! - **Frame and penalty:** the frame from the crop's aspect and the card's layout (oracle
//!   `detect.frame_of`), and the bundle's rare-frame penalty. No hub penalty: that needs
//!   ManaVault's 3,000 background scans, and it is at most a few thousandths for half the gallery.
//! - **Served:** `supplement-<hash>.json` (and `.gz`) next to the bundle in
//!   `data/scan-bundle/<version>/`, immutable like the bundle; `GET /api/scan/bundle` names the
//!   current one. The art worker scores its rows next to the search graph's (`gallery.ts`).
//! - **When:** after each card-data import (the scheduler and `import-cards`), when the server
//!   starts, and every six hours; `yama-server scan-arts` runs it by hand. Off with
//!   `YAMA_SCAN_SUPPLEMENT=0`.
//! - **Scryfall:** one image request at a time, 100 ms apart, with Yama's User-Agent. Images are
//!   decoded in memory and dropped; only the 128 numbers are kept. A 429, a 5xx or a network
//!   failure says nothing about the artwork: the run backs off (Retry-After, else doubling up to a
//!   minute) and stops after four in a row, charging nothing; the next run resumes. Only a missing
//!   image (404, 410), a refused one (other 4xx) or one that won't decode counts against it.
//! - **One run at a time** across processes (the server's job, `scan-arts`, `import-cards`): an
//!   advisory lock on `data/scan-bundle/scan-arts.lock`; a second runner skips with a log line.
//! - **Publication is atomic:** each file is written to a unique temporary name in the same folder,
//!   synced and renamed; an existing file of the same content-addressed name is checked byte for
//!   byte (and its `.gz` unzipped) and rewritten if damaged; the pointer is written last.

use crate::scan::{BUNDLE_VERSION, bundle_dir, is_ready};
use crate::util::now;
use anyhow::{Context, bail};
use base64::Engine;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// Side of the embedder's square input.
pub const INPUT: usize = 128;
/// The embedder's input inside `embed.onnx`: the node (`/Div_5`, whose output is
/// `/Div_5_output_0`) that yields the ImageNet-normalised N × 3 × 128 × 128 crops, after the
/// graph's own warp and cuts. tract names a wire by the node that makes it.
const EMBED_INPUT: &str = "/Div_5";
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];
/// Pointer to the current supplement file, inside the bundle folder.
const CURRENT: &str = "supplement.current";
/// Gap between Scryfall image requests (their API asks for 50 to 100 ms).
const PAUSE: Duration = Duration::from_millis(100);
/// After Scryfall is unavailable: wait this long, doubling each time in a row, up to `BACKOFF_CAP`.
const BACKOFF: Duration = Duration::from_secs(2);
const BACKOFF_CAP: Duration = Duration::from_secs(60);
/// A Retry-After longer than this ends the run instead of waiting it out.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(5 * 60);
/// This many unavailable answers in a row end the run (nothing charged; the next run resumes).
const UNAVAILABLE_IN_A_ROW: u32 = 4;
/// The advisory lock that keeps runs one at a time across processes, in `data/scan-bundle/`.
const LOCK: &str = "scan-arts.lock";
/// At most this many new artworks per run; the next run goes on.
const PER_RUN: usize = 3000;
/// A failed artwork is tried again after a day, up to this many times.
const MAX_TRIES: i64 = 5;
/// The check against the bundle's own rows: each must come out at least this close.
const PARITY: f32 = 0.97;

/// Layouts the bundle embeds (oracle `catalog.ART_LAYOUTS` and `FACE_LAYOUTS`, less split and flip,
/// whose halves are cut from the whole card instead of an art crop).
const LAYOUTS: [&str; 16] = [
    "normal", "leveler", "saga", "class", "case", "mutate", "prototype", "token", "emblem", "adventure", "prepare", "meld",
    "transform", "modal_dfc", "reversible_card", "double_faced_token",
];
const TOKEN_LAYOUTS: [&str; 3] = ["token", "double_faced_token", "emblem"];
/// Frames whose rows pay the bundle's frame penalty (oracle `detect.RARE_FRAMES`).
const RARE_FRAMES: [&str; 13] = [
    "tall", "token_tall", "emblem", "right", "left", "room_0", "room_1", "split_0", "split_1", "aftermath_0", "aftermath_1", "flip_0", "flip_1",
];

/// The frame of an artwork from its crop's aspect (width / height) and layout: oracle
/// `detect.frame_of` for the layouts this module embeds.
pub fn frame_of(aspect: f64, layout: &str) -> &'static str {
    let token = TOKEN_LAYOUTS.contains(&layout);
    if aspect < 0.6 {
        return if matches!(layout, "class" | "case") { "left" } else { "right" };
    }
    if layout == "emblem" && (0.97..1.1).contains(&aspect) {
        return "emblem";
    }
    if token && (0.94..0.96).contains(&aspect) {
        return "token_tall";
    }
    if aspect < 1.1 {
        "tall"
    } else if aspect < 1.3 {
        if token { "token" } else { "old" }
    } else if aspect < 1.44 {
        "modern"
    } else {
        "extended"
    }
}

/// OpenCV's `resize(..., INTER_AREA)` of an RGB image: each output pixel the area-weighted mean
/// of the source pixels under it (`computeResizeAreaTab`), rounded half to even. When either
/// side grows, OpenCV falls back to bilinear, and so does this.
pub fn resize_area(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    if ow > w || oh > h {
        return resize_linear(src, w, h, ow, oh);
    }
    let tab = |ssize: usize, dsize: usize| -> Vec<Vec<(usize, f32)>> {
        let scale = ssize as f64 / dsize as f64;
        (0..dsize)
            .map(|dx| {
                let fsx1 = dx as f64 * scale;
                let fsx2 = fsx1 + scale;
                let cell = scale.min(ssize as f64 - fsx1);
                let mut sx2 = fsx2.floor() as isize;
                sx2 = sx2.min(ssize as isize - 1);
                let sx1 = (fsx1.ceil() as isize).min(sx2);
                let mut out = Vec::new();
                if sx1 as f64 - fsx1 > 1e-3 {
                    out.push(((sx1 - 1) as usize, ((sx1 as f64 - fsx1) / cell) as f32));
                }
                for sx in sx1..sx2 {
                    out.push((sx as usize, (1.0 / cell) as f32));
                }
                if fsx2 - sx2 as f64 > 1e-3 {
                    out.push((sx2 as usize, ((fsx2 - sx2 as f64).min(1.0).min(cell) / cell) as f32));
                }
                out
            })
            .collect()
    };
    let (xs, ys) = (tab(w, ow), tab(h, oh));
    let mut out = vec![0u8; ow * oh * 3];
    let mut row = vec![0f32; ow * 3];
    for (dy, ytab) in ys.iter().enumerate() {
        let mut acc = vec![0f32; ow * 3];
        for &(sy, wy) in ytab {
            row.fill(0.0);
            for (dx, xtab) in xs.iter().enumerate() {
                for &(sx, wx) in xtab {
                    let s = (sy * w + sx) * 3;
                    for c in 0..3 {
                        row[dx * 3 + c] += src[s + c] as f32 * wx;
                    }
                }
            }
            for (a, r) in acc.iter_mut().zip(&row) {
                *a += r * wy;
            }
        }
        for (i, a) in acc.iter().enumerate() {
            out[dy * ow * 3 + i] = a.round_ties_even().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// OpenCV's bilinear resize (pixel centres at +0.5, edges clamped).
fn resize_linear(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    let mut out = vec![0u8; ow * oh * 3];
    let (sx, sy) = (w as f32 / ow as f32, h as f32 / oh as f32);
    for y in 0..oh {
        let fy = ((y as f32 + 0.5) * sy - 0.5).max(0.0);
        let y0 = (fy.floor() as usize).min(h - 1);
        let y1 = (y0 + 1).min(h - 1);
        let ty = fy - y0 as f32;
        for x in 0..ow {
            let fx = ((x as f32 + 0.5) * sx - 0.5).max(0.0);
            let x0 = (fx.floor() as usize).min(w - 1);
            let x1 = (x0 + 1).min(w - 1);
            let tx = fx - x0 as f32;
            for c in 0..3 {
                let p = |xx: usize, yy: usize| src[(yy * w + xx) * 3 + c] as f32;
                let top = p(x0, y0) + (p(x1, y0) - p(x0, y0)) * tx;
                let bottom = p(x0, y1) + (p(x1, y1) - p(x0, y1)) * tx;
                out[(y * ow + x) * 3 + c] = (top + (bottom - top) * ty).round_ties_even().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// An art crop (JPEG or WebP) as the embedder's 128 × 128 RGB input, and the crop's aspect.
pub fn prepare(image: &[u8]) -> anyhow::Result<(Vec<u8>, f64)> {
    let img = image::load_from_memory(image).context("decoding the art crop")?.to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    anyhow::ensure!(w >= 8 && h >= 8, "the art crop is {w} × {h}");
    Ok((resize_area(img.as_raw(), w, h, INPUT, INPUT), w as f64 / h as f64))
}

/// Turns a prepared 128 × 128 RGB art into an L2-normalised vector.
pub trait Embed: Send + Sync {
    fn embed(&self, rgb: &[u8]) -> anyhow::Result<Vec<f32>>;
}

type Plan = Arc<tract_onnx::prelude::TypedSimplePlan>;

/// The embedding half of the bundle's `embed.onnx`, run by tract.
pub struct Embedder {
    plan: Plan,
}

impl Embedder {
    pub fn load(embed_onnx: &Path) -> anyhow::Result<Self> {
        use tract_onnx::prelude::*;
        let mut model = tract_onnx::onnx().model_for_path(embed_onnx).with_context(|| format!("reading {}", embed_onnx.display()))?;
        model.set_input_names([EMBED_INPUT]).context("the embedding graph has no normalised input where expected")?;
        // The export recorded every wire's shape for its batch of 17 frame cuts; forget them so
        // tract infers them again for one art crop at a time.
        for node in 0..model.nodes.len() {
            for slot in 0..model.nodes[node].outputs.len() {
                model.set_outlet_fact(OutletId::new(node, slot), InferenceFact::default())?;
            }
        }
        model.set_input_fact(0, f32::fact([1, 3, INPUT, INPUT]).into())?;
        let plan = model.into_optimized().context("preparing the embedding graph")?.into_runnable()?;
        Ok(Self { plan })
    }
}

impl Embed for Embedder {
    fn embed(&self, rgb: &[u8]) -> anyhow::Result<Vec<f32>> {
        use tract_onnx::prelude::*;
        anyhow::ensure!(rgb.len() == INPUT * INPUT * 3, "expected a {INPUT} × {INPUT} RGB image");
        let input = tract_ndarray::Array4::from_shape_fn((1, 3, INPUT, INPUT), |(_, c, y, x)| {
            (rgb[(y * INPUT + x) * 3 + c] as f32 / 255.0 - MEAN[c]) / STD[c]
        });
        let out = self.plan.run(tvec!(input.into_tensor().into()))?;
        Ok(out[0].to_plain_array_view::<f32>()?.iter().copied().collect())
    }
}

/// The bundle's own gallery vectors (`search.onnx`'s `gallery` initializer), for the parity check.
fn bundle_vectors(search_onnx: &Path) -> anyhow::Result<(usize, Vec<u16>)> {
    use tract_onnx::prelude::Framework;
    let proto = tract_onnx::onnx().proto_model_for_path(search_onnx)?;
    let graph = proto.graph.context("the search graph has no graph")?;
    let t = graph.initializer.iter().find(|t| t.name == "gallery").context("the search graph has no gallery")?;
    // TensorProto data type 10 is float16.
    anyhow::ensure!(t.data_type == 10 && t.dims.len() == 2, "the search graph's gallery isn't float16 rows");
    let dim = t.dims[1] as usize;
    let raw = &t.raw_data;
    anyhow::ensure!(raw.len() == t.dims[0] as usize * dim * 2, "the search graph's gallery is the wrong size");
    Ok((dim, raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect()))
}

/// What the job needs from the bundle folder.
struct Bundle {
    /// Illustration IDs the bundle already has.
    known: HashSet<String>,
    /// `(row, printing ID)` of each bundle row, for the parity check.
    rows: Vec<String>,
    frame_names: Vec<String>,
    frame_penalty: f64,
}

fn read_bundle(dir: &Path) -> anyhow::Result<Bundle> {
    let slim: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(crate::scan::ARTS))?)?;
    let columns: Vec<String> = serde_json::from_value(slim["columns"].clone())?;
    let col = |n: &str| columns.iter().position(|c| c == n).with_context(|| format!("arts index has no {n}"));
    let (id, ill) = (col("id")?, col("illustration_id")?);
    let rows = slim["rows"].as_array().context("arts index has no rows")?;
    let known = rows.iter().filter_map(|r| r[ill].as_str().map(String::from)).collect();
    let ids = rows.iter().map(|r| r[id].as_str().unwrap_or_default().to_string()).collect();
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json"))?)?;
    let frame_names: Vec<String> = serde_json::from_value(manifest["constants"]["frame_names"].clone()).context("manifest has no frame names")?;
    let frame_penalty = manifest["gallery"]["frame_penalty"].as_f64().unwrap_or(0.02);
    Ok(Bundle { known, rows: ids, frame_names, frame_penalty })
}

/// Scryfall's art crop JPEG for a printing's face, from its ID (`art_crop/<face>/<a>/<b>/<id>.jpg`).
/// ManaVault's gallery is built from these. Scryfall stops serving them on 2027-01-01
/// (cards/import.rs); the same crop as WebP (`art/…/<id>.webp`) is [`art_url`].
fn art_crop_url(scryfall_id: &str, back: bool) -> Option<String> {
    face_url(scryfall_id, back, "art_crop", "jpg")
}

/// Scryfall's WebP art crop for a printing's face, from its ID.
fn art_url(scryfall_id: &str, back: bool) -> Option<String> {
    face_url(scryfall_id, back, "art", "webp")
}

fn face_url(scryfall_id: &str, back: bool, kind: &str, ext: &str) -> Option<String> {
    let id = scryfall_id.strip_suffix("-1").unwrap_or(scryfall_id);
    let mut chars = id.chars();
    let (a, b) = (chars.next()?, chars.next()?);
    if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    Some(format!("https://cards.scryfall.io/{kind}/{}/{a}/{b}/{id}.{ext}", if back { "back" } else { "front" }))
}

/// What fetching one image found.
#[derive(Debug)]
pub enum Fetched {
    Image(Vec<u8>),
    /// The host has no such image (404, 410): try the next URL, then it counts against the artwork.
    Missing,
    /// Rate-limited (429), the host failing (5xx, 408) or the network: nothing about this artwork.
    Unavailable { retry_after: Option<Duration>, why: String },
}

/// Fetches an image by URL. An error is about this image (refused, too large) and counts
/// against the artwork; a host or network problem is `Fetched::Unavailable`.
pub type Fetch = Arc<dyn Fn(String) -> futures_util::future::BoxFuture<'static, anyhow::Result<Fetched>> + Send + Sync>;

/// How an HTTP status reads for one image: None for success.
pub fn classify(status: u16, retry_after: Option<&str>) -> Option<anyhow::Result<Fetched>> {
    match status {
        200..=299 => None,
        404 | 410 => Some(Ok(Fetched::Missing)),
        408 | 429 | 500..=599 => Some(Ok(Fetched::Unavailable {
            // Seconds only; an HTTP date falls back to the run's own backoff.
            retry_after: retry_after.and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs),
            why: format!("HTTP {status}"),
        })),
        _ => Some(Err(anyhow::anyhow!("refused: HTTP {status}"))),
    }
}

/// Fetches from Scryfall's image host only.
pub fn scryfall_fetch(http: reqwest::Client) -> Fetch {
    Arc::new(move |url: String| {
        let http = http.clone();
        Box::pin(async move {
            let parsed = url::Url::parse(&url)?;
            if parsed.scheme() != "https" || parsed.host_str() != Some("cards.scryfall.io") {
                bail!("not a Scryfall image: {url}");
            }
            let unavailable = |e: reqwest::Error| Fetched::Unavailable { retry_after: None, why: format!("{e}") };
            let res = match http.get(&url).timeout(Duration::from_secs(30)).send().await {
                Ok(res) => res,
                Err(e) => return Ok(unavailable(e)),
            };
            let retry_after = res.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).map(String::from);
            if let Some(outcome) = classify(res.status().as_u16(), retry_after.as_deref()) {
                return outcome;
            }
            let bytes = match res.bytes().await {
                Ok(b) => b,
                Err(e) => return Ok(unavailable(e)),
            };
            anyhow::ensure!(bytes.len() < 10_000_000, "{url} is too large");
            Ok(Fetched::Image(bytes.to_vec()))
        })
    })
}

/// Why an artwork wasn't embedded.
enum Problem {
    /// Scryfall can't be asked right now; the artwork isn't charged.
    Unavailable { retry_after: Option<Duration>, why: String },
    /// Something about this artwork (no image, refused, won't decode).
    Content(anyhow::Error),
}

impl From<anyhow::Error> for Problem {
    fn from(e: anyhow::Error) -> Self {
        Problem::Content(e)
    }
}

/// The wait before trying again after `streak` unavailable answers in a row, or None to end the run.
fn backoff(streak: u32, retry_after: Option<Duration>, base: Duration) -> Option<Duration> {
    if streak >= UNAVAILABLE_IN_A_ROW || retry_after.is_some_and(|r| r > RETRY_AFTER_CAP) {
        return None;
    }
    let doubling = base.saturating_mul(1 << streak.saturating_sub(1).min(16)).min(BACKOFF_CAP);
    Some(retry_after.map_or(doubling, |r| r.max(doubling)))
}

/// The cross-process lock for one run (`flock`, released when the file closes), or None while
/// another run holds it.
pub(crate) fn lock_runs(data_dir: &Path) -> anyhow::Result<Option<std::fs::File>> {
    let root = data_dir.join("scan-bundle");
    std::fs::create_dir_all(&root)?;
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(root.join(LOCK))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

#[derive(sqlx::FromRow, Clone)]
struct Candidate {
    art: String,
    scryfall_id: String,
    face: i64,
    name: String,
    set_code: String,
    collector_number: String,
    layout: String,
    type_line: Option<String>,
    url: Option<String>,
}

/// Options for one run.
#[derive(Default, Clone)]
pub struct Options {
    /// Only these sets (lower case); all when empty.
    pub sets: Vec<String>,
    /// At most this many new artworks (default `PER_RUN`).
    pub limit: Option<usize>,
    /// Also embed artworks the bundle has (for evals; then `out` must be set, so nothing served
    /// changes).
    pub include_known: bool,
    /// Write the supplement here instead of the bundle folder.
    pub out: Option<PathBuf>,
    /// Skip the parity check (tests with a stand-in embedder).
    pub skip_parity: bool,
    /// Gap between image requests (default 100 ms) and the first backoff (default 2 s); tests shorten them.
    pub pause: Option<Duration>,
    pub backoff: Option<Duration>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub embedded: usize,
    pub failed: usize,
    /// Rows in the supplement written.
    pub rows: usize,
    /// The supplement's file name, when there is one.
    pub file: Option<String>,
    /// Another run held the lock, so this one did nothing.
    pub busy: bool,
    /// Scryfall was unavailable and the run stopped early (why); the next run resumes.
    pub stopped: Option<String>,
}

/// One run: embed what's new, then rewrite the supplement. One at a time across processes.
pub async fn run(pool: &SqlitePool, data_dir: &Path, fetch: Fetch, embedder: Option<Arc<dyn Embed>>, opts: &Options) -> anyhow::Result<Report> {
    let dir = bundle_dir(data_dir);
    if !is_ready(&dir) {
        bail!("the scanner bundle {BUNDLE_VERSION} isn't downloaded yet");
    }
    let lock = {
        let data_dir = data_dir.to_path_buf();
        tokio::task::spawn_blocking(move || lock_runs(&data_dir)).await??
    };
    let Some(_lock) = lock else {
        tracing::info!("scanner art supplement: another run (this process or another) is going; skipping");
        return Ok(Report { busy: true, ..Report::default() });
    };
    let pause = opts.pause.unwrap_or(PAUSE);
    let base = opts.backoff.unwrap_or(BACKOFF);
    anyhow::ensure!(!opts.include_known || opts.out.is_some(), "--include-known needs --out");
    let bundle = tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || read_bundle(&dir)
    })
    .await??;
    sqlx::query("DELETE FROM scan_arts WHERE bundle <> ?").bind(BUNDLE_VERSION).execute(pool).await?;

    let todo = candidates(pool, &bundle, opts).await?;
    let mut report = Report::default();
    if !todo.is_empty() {
        let embedder = match embedder {
            Some(e) => e,
            None => {
                let path = dir.join("embed.onnx");
                Arc::new(tokio::task::spawn_blocking(move || Embedder::load(&path)).await??) as Arc<dyn Embed>
            }
        };
        if !opts.skip_parity {
            parity(&dir, &bundle, &fetch, &embedder, pause).await?;
        }
        tracing::info!(arts = todo.len(), "scanner art supplement: embedding new artworks");
        let mut streak = 0u32;
        'artworks: for c in todo {
            let outcome = loop {
                match embed_one(&c, &fetch, &embedder, pause).await {
                    Err(Problem::Unavailable { retry_after, why }) => {
                        streak += 1;
                        match backoff(streak, retry_after, base) {
                            Some(wait) => {
                                tracing::debug!(why, ?wait, "scanner art supplement: Scryfall unavailable; waiting");
                                tokio::time::sleep(wait).await;
                            }
                            None => {
                                tracing::warn!(why, "scanner art supplement: Scryfall unavailable; stopping until the next run");
                                report.stopped = Some(why);
                                break 'artworks;
                            }
                        }
                    }
                    other => {
                        streak = 0;
                        break other;
                    }
                }
            };
            match outcome {
                Err(Problem::Unavailable { .. }) => unreachable!("handled above"),
                Ok((aspect, vector)) => {
                    let frame = frame_of(aspect, &c.layout);
                    let Some(index) = bundle.frame_names.iter().position(|f| f == frame) else {
                        store_failure(pool, &c, &format!("the bundle has no frame {frame}")).await?;
                        report.failed += 1;
                        continue;
                    };
                    let penalty = if RARE_FRAMES.contains(&frame) { bundle.frame_penalty } else { 0.0 };
                    let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
                    sqlx::query(
                        "INSERT INTO scan_arts (illustration_id, bundle, scryfall_id, name, set_code, collector_number, layout, frame, penalty, vector, error, tries, updated_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0,?)
                         ON CONFLICT (illustration_id, bundle) DO UPDATE SET scryfall_id = excluded.scryfall_id, name = excluded.name,
                           set_code = excluded.set_code, collector_number = excluded.collector_number, layout = excluded.layout,
                           frame = excluded.frame, penalty = excluded.penalty, vector = excluded.vector, error = NULL, updated_at = excluded.updated_at",
                    )
                    .bind(&c.art)
                    .bind(BUNDLE_VERSION)
                    .bind(row_id(&c))
                    .bind(face_name(&c))
                    .bind(&c.set_code)
                    .bind(&c.collector_number)
                    .bind(&c.layout)
                    .bind(index as i64)
                    .bind(penalty)
                    .bind(blob)
                    .bind(now())
                    .execute(pool)
                    .await?;
                    report.embedded += 1;
                }
                Err(Problem::Content(e)) => {
                    tracing::debug!(art = %c.art, error = %format!("{e:#}"), "couldn't embed an artwork");
                    store_failure(pool, &c, &format!("{e:#}")).await?;
                    report.failed += 1;
                }
            }
        }
    }
    let target = opts.out.clone().unwrap_or_else(|| dir.clone());
    let only: Option<HashSet<String>> = (!opts.sets.is_empty()).then(|| opts.sets.iter().cloned().collect());
    let (rows, file) = write_supplement(pool, &target, &bundle, opts.include_known, only.as_ref()).await?;
    report.rows = rows;
    report.file = file;
    if report.embedded + report.failed > 0 || report.stopped.is_some() {
        tracing::info!(embedded = report.embedded, failed = report.failed, rows = report.rows, stopped = ?report.stopped, "scanner art supplement updated");
    }
    Ok(report)
}

fn row_id(c: &Candidate) -> String {
    if c.face == 1 { format!("{}-1", c.scryfall_id) } else { c.scryfall_id.clone() }
}

/// The face's own name: `Front // Back` splits for a back face, as the bundle names its rows.
fn face_name(c: &Candidate) -> String {
    let parts: Vec<&str> = c.name.split(" // ").collect();
    if c.face == 1 && parts.len() > 1 { parts[1].to_string() } else if parts.len() > 1 && !matches!(c.layout.as_str(), "adventure" | "prepare") {
        parts[0].to_string()
    } else {
        c.name.clone()
    }
}

async fn store_failure(pool: &SqlitePool, c: &Candidate, error: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO scan_arts (illustration_id, bundle, scryfall_id, name, set_code, collector_number, layout, vector, error, tries, updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,?,1,?)
         ON CONFLICT (illustration_id, bundle) DO UPDATE SET error = excluded.error, tries = scan_arts.tries + 1, updated_at = excluded.updated_at",
    )
    .bind(&c.art)
    .bind(BUNDLE_VERSION)
    .bind(row_id(c))
    .bind(face_name(c))
    .bind(&c.set_code)
    .bind(&c.collector_number)
    .bind(&c.layout)
    .bind(error)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

/// Illustrations to embed this run: not in the bundle (unless `include_known`), not done, not
/// failed in the last day or too often. One printing per illustration, the newest.
async fn candidates(pool: &SqlitePool, bundle: &Bundle, opts: &Options) -> anyhow::Result<Vec<Candidate>> {
    let rows: Vec<Candidate> = sqlx::query_as(
        "SELECT p.illustration_id AS art, p.scryfall_id, 0 AS face, p.name, p.set_code, p.collector_number,
                IFNULL(c.layout, 'normal') AS layout, c.type_line, p.image_art_crop AS url, p.released_at
           FROM printings p LEFT JOIN cards c ON c.oracle_id = p.oracle_id
          WHERE p.lang = 'en' AND IFNULL(p.digital, 0) = 0 AND p.illustration_id IS NOT NULL AND p.image_art_crop IS NOT NULL
         UNION ALL
         SELECT p.back_illustration_id, p.scryfall_id, 1, p.name, p.set_code, p.collector_number,
                IFNULL(c.layout, 'normal'), c.type_line, NULL, p.released_at
           FROM printings p LEFT JOIN cards c ON c.oracle_id = p.oracle_id
          WHERE p.lang = 'en' AND IFNULL(p.digital, 0) = 0 AND p.back_illustration_id IS NOT NULL AND p.back_image_normal IS NOT NULL
         ORDER BY released_at DESC, set_code, collector_number, scryfall_id",
    )
    .fetch_all(pool)
    .await?;
    let settled: HashSet<String> = sqlx::query_scalar(
        "SELECT illustration_id FROM scan_arts WHERE bundle = ?1
           AND (vector IS NOT NULL OR tries >= ?2 OR updated_at > ?3)",
    )
    .bind(BUNDLE_VERSION)
    .bind(MAX_TRIES)
    .bind((chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    let limit = opts.limit.unwrap_or(PER_RUN);
    Ok(rows
        .into_iter()
        .filter(|c| opts.sets.is_empty() || opts.sets.contains(&c.set_code))
        .filter(|c| LAYOUTS.contains(&c.layout.as_str()))
        // Inserts typed just `Card` (decklists, ads, helpers): the bundle leaves them out too.
        .filter(|c| !c.type_line.as_deref().is_some_and(|t| t.split("//").any(|p| p.trim() == "Card")))
        .filter(|c| opts.include_known || !bundle.known.contains(&c.art))
        .filter(|c| !settled.contains(&c.art))
        .filter(|c| seen.insert(c.art.clone()))
        .take(limit)
        .collect())
}

/// Download, decode, resize and embed one artwork, pausing first so requests stay 100 ms apart.
async fn embed_one(c: &Candidate, fetch: &Fetch, embedder: &Arc<dyn Embed>, pause: Duration) -> Result<(f64, Vec<f32>), Problem> {
    // The JPEG ManaVault embeds; once Scryfall drops those (2027), the WebP of the same crop, and
    // last the URL the card data stored. The parity check refuses vectors that stop matching.
    let back = c.face == 1;
    let mut urls: Vec<String> = art_crop_url(&c.scryfall_id, back).into_iter().chain(art_url(&c.scryfall_id, back)).collect();
    urls.extend(c.url.clone().filter(|u| !urls.contains(u)));
    let mut bytes = None;
    for url in urls {
        tokio::time::sleep(pause).await;
        match fetch(url).await? {
            Fetched::Image(b) => {
                bytes = Some(b);
                break;
            }
            Fetched::Missing => {}
            Fetched::Unavailable { retry_after, why } => return Err(Problem::Unavailable { retry_after, why }),
        }
    }
    let bytes = bytes.context("Scryfall has no art crop for it")?;
    let embedder = embedder.clone();
    let done = tokio::task::spawn_blocking(move || {
        let (rgb, aspect) = prepare(&bytes)?;
        let v = embedder.embed(&rgb)?;
        anyhow::ensure!(v.len() == 128 && v.iter().all(|x| x.is_finite()), "the embedding isn't 128 numbers");
        Ok((aspect, v))
    })
    .await
    .map_err(anyhow::Error::from)??;
    Ok(done)
}

/// Re-embed three artworks the bundle has and compare them with the bundle's own rows: if this
/// embedder doesn't reproduce the bundle (a new graph, a changed crop), nothing new is served.
async fn parity(dir: &Path, bundle: &Bundle, fetch: &Fetch, embedder: &Arc<dyn Embed>, pause: Duration) -> anyhow::Result<()> {
    let search = dir.join("search.onnx");
    let (dim, vectors) = tokio::task::spawn_blocking(move || bundle_vectors(&search)).await??;
    let n = bundle.rows.len();
    anyhow::ensure!(n * dim == vectors.len() && n > 0, "the bundle's gallery and arts index disagree");
    let mut worst = 1f32;
    let mut tried = 0;
    for row in [n / 7, n / 2, n - 1 - n / 5] {
        let id = &bundle.rows[row];
        let c = Candidate {
            art: String::new(),
            scryfall_id: id.clone(),
            face: i64::from(id.ends_with("-1")),
            name: String::new(),
            set_code: String::new(),
            collector_number: String::new(),
            layout: String::new(),
            type_line: None,
            url: None,
        };
        let v = match embed_one(&c, fetch, embedder, pause).await {
            Ok((_, v)) => v,
            // Nothing is charged: the run ends and the next one tries again.
            Err(Problem::Unavailable { why, .. }) => bail!("Scryfall is unavailable ({why}); trying again next run"),
            Err(Problem::Content(_)) => continue,
        };
        tried += 1;
        let cos: f32 = vectors[row * dim..(row + 1) * dim].iter().zip(&v).map(|(g, q)| half::f16::from_bits(*g).to_f32() * q).sum();
        worst = worst.min(cos);
    }
    anyhow::ensure!(tried > 0, "couldn't fetch any of the bundle's own artworks to check the embedder against");
    anyhow::ensure!(worst >= PARITY, "the embedder doesn't reproduce the bundle's own rows (cosine {worst:.4}); not serving a supplement from it");
    tracing::debug!(worst, tried, "scanner art supplement: embedder matches the bundle");
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Done {
    illustration_id: String,
    scryfall_id: String,
    name: String,
    set_code: String,
    collector_number: String,
    layout: String,
    frame: i64,
    penalty: f64,
    vector: Vec<u8>,
}

/// Write the supplement (rows the bundle doesn't have, gallery order by set and number) as
/// `supplement-<hash>.json` and `.gz` in `dir`, point `supplement.current` at it and drop older
/// ones (the one before stays, for a phone that asked a moment ago). No rows, no file.
async fn write_supplement(pool: &SqlitePool, dir: &Path, bundle: &Bundle, include_known: bool, sets: Option<&HashSet<String>>) -> anyhow::Result<(usize, Option<String>)> {
    let done: Vec<Done> = sqlx::query_as(
        "SELECT illustration_id, scryfall_id, name, set_code, collector_number, layout, frame, penalty, vector
           FROM scan_arts WHERE bundle = ? AND vector IS NOT NULL AND frame IS NOT NULL
          ORDER BY set_code, length(collector_number), collector_number, illustration_id",
    )
    .bind(BUNDLE_VERSION)
    .fetch_all(pool)
    .await?;
    let done: Vec<Done> = done
        .into_iter()
        .filter(|d| include_known || !bundle.known.contains(&d.illustration_id))
        .filter(|d| sets.is_none_or(|s| s.contains(&d.set_code)))
        .filter(|d| d.vector.len() == 128 * 4)
        .collect();
    let counts: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
        "SELECT art, COUNT(*) FROM (SELECT illustration_id AS art FROM printings WHERE illustration_id IS NOT NULL
           UNION ALL SELECT back_illustration_id FROM printings WHERE back_illustration_id IS NOT NULL) GROUP BY art",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    tokio::fs::create_dir_all(dir).await?;
    if done.is_empty() {
        let _ = tokio::fs::remove_file(dir.join(CURRENT)).await;
        return Ok((0, None));
    }
    let mut halves = Vec::with_capacity(done.len() * 128 * 2);
    for d in &done {
        for b in d.vector.chunks_exact(4) {
            let v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            halves.extend_from_slice(&half::f16::from_f32(v).to_bits().to_le_bytes());
        }
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "bundle": BUNDLE_VERSION,
        "dim": 128,
        "columns": ["id", "name", "set", "number", "illustration_id", "layout", "printings"],
        "rows": done.iter().map(|d| serde_json::json!([d.scryfall_id, d.name, d.set_code, d.collector_number, d.illustration_id, d.layout, counts.get(&d.illustration_id).copied().unwrap_or(1)])).collect::<Vec<_>>(),
        "frames": done.iter().map(|d| d.frame).collect::<Vec<_>>(),
        "penalties": done.iter().map(|d| d.penalty).collect::<Vec<_>>(),
        "vectors": base64::engine::general_purpose::STANDARD.encode(&halves),
    }))?;
    let hash = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(&body))[..16].to_string()
    };
    let name = format!("supplement-{hash}.json");
    let previous = tokio::fs::read_to_string(dir.join(CURRENT)).await.ok();
    let (folder, file, body) = (dir.to_path_buf(), name.clone(), body);
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        // Temporary files a crashed run left (the lock says no other run is writing).
        remove_temporaries(&folder);
        // The name is the content's hash, so a file already there must hold exactly this; a run
        // cut short before this fix could have left one truncated.
        if std::fs::read(folder.join(&file)).ok().as_deref() != Some(&body[..]) {
            write_atomic(&folder, &file, &body)?;
        }
        let gz = format!("{file}.gz");
        if !gzip_holds(&folder.join(&gz), &body) {
            write_atomic(&folder, &gz, &crate::scan::gzip(&body)?)?;
        }
        // The pointer last, once both files are whole.
        write_atomic(&folder, CURRENT, file.as_bytes())
    })
    .await??;
    // Older supplements: all but this one and the one it replaced.
    let keep: HashSet<String> = [Some(name.clone()), previous.map(|p| p.trim().to_string())].into_iter().flatten().collect();
    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            let file = e.file_name().to_string_lossy().to_string();
            let base = file.strip_suffix(".gz").unwrap_or(&file);
            if base.starts_with("supplement-") && base.ends_with(".json") && !keep.contains(base) {
                let _ = tokio::fs::remove_file(e.path()).await;
            }
        }
    }
    Ok((done.len(), Some(name)))
}

/// Write `bytes` to `dir/name` whole or not at all: a unique temporary file in the same folder,
/// synced, then renamed over the name (and the folder synced, so the rename survives a crash).
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let tmp = dir.join(format!(".{name}.{}-{nanos}-{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create_new(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, dir.join(name))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow::Error::from(e).context(format!("writing {}", dir.join(name).display())));
    }
    if let Ok(folder) = std::fs::File::open(dir) {
        let _ = folder.sync_all();
    }
    Ok(())
}

/// Whether `path` is a gzip of exactly `body`.
fn gzip_holds(path: &Path, body: &[u8]) -> bool {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else { return false };
    let mut out = Vec::with_capacity(body.len());
    flate2::read::GzDecoder::new(file).take(body.len() as u64 + 1).read_to_end(&mut out).is_ok() && out == body
}

/// Delete temporary files `write_atomic` left behind in a run that didn't finish.
fn remove_temporaries(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(".supplement") && name.ends_with(".tmp") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The current supplement's file name in the bundle folder, if there is one.
pub async fn current(data_dir: &Path) -> Option<(String, u64)> {
    let dir = bundle_dir(data_dir);
    let name = tokio::fs::read_to_string(dir.join(CURRENT)).await.ok()?.trim().to_string();
    if !name.starts_with("supplement-") || name.contains('/') {
        return None;
    }
    let bytes = tokio::fs::metadata(dir.join(&name)).await.ok()?.len();
    Some((name, bytes))
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Fresh card data arrived: run soon (a no-op when the background job isn't running).
pub fn nudge() {
    wake().notify_one();
}

/// The background job: once the bundle is here, run now, after every card import (`nudge`) and
/// every six hours.
pub fn spawn(pool: SqlitePool, data_dir: PathBuf, http: reqwest::Client) {
    tokio::spawn(async move {
        loop {
            if is_ready(&bundle_dir(&data_dir)) {
                match run(&pool, &data_dir, scryfall_fetch(http.clone()), None, &Options::default()).await {
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %format!("{e:#}"), "scanner art supplement failed"),
                }
                let _ = tokio::time::timeout(Duration::from_secs(6 * 3600), wake().notified()).await;
            } else {
                // scan::ensure downloads it (started alongside this); look again shortly.
                crate::scan::ensure(data_dir.clone(), http.clone()).await;
                tokio::time::sleep(Duration::from_secs(5 * 60)).await;
            }
        }
    });
}

/// `yama-server scan-arts [--sets trk,trc] [--limit N] [--include-known --out DIR]`.
pub async fn cli(pool: &SqlitePool, data_dir: &Path, args: &[String]) -> anyhow::Result<()> {
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let opts = Options {
        sets: value("--sets").map(|s| s.split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect()).unwrap_or_default(),
        limit: value("--limit").map(|n| n.parse()).transpose().context("--limit takes a number")?,
        include_known: args.iter().any(|a| a == "--include-known"),
        out: value("--out").map(PathBuf::from),
        ..Options::default()
    };
    let http = crate::routes::http_client();
    let dir = bundle_dir(data_dir);
    if !is_ready(&dir) {
        println!("downloading the scanner bundle {BUNDLE_VERSION} …");
        crate::scan::download(&http, &dir).await?;
    }
    let report = run(pool, data_dir, scryfall_fetch(http), None, &opts).await?;
    if report.busy {
        println!("another scan-arts run is going (the server's, or another command); nothing done");
        return Ok(());
    }
    if let Some(why) = &report.stopped {
        println!("stopped early: Scryfall is unavailable ({why}); the next run picks up where this one left off");
    }
    println!(
        "embedded {}, failed {}; supplement: {} rows{}",
        report.embedded,
        report.failed,
        report.rows,
        report.file.map(|f| format!(" in {f}")).unwrap_or_default()
    );
    Ok(())
}

#[cfg(test)]
mod tests;
