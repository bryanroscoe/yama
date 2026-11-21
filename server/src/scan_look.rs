//! The printing look's vectors, made by the server (docs/scanner.md, "The printing look", "Vectors
//! from the server", 21 Nov 2026). Bryan wants scanning as fast as CardVision. When several
//! printings share a card's artwork, the phone compares the card with each printing's own Scryfall
//! picture through a look model (web/src/scanner/look.ts): it used to fetch and embed every
//! picture itself, about half a second each on a cold connection. The server now embeds each
//! picture once per look model and the phone asks for them first (`GET /api/scan/looks`), making
//! only what's missing itself.
//!
//! - **Exactly the phone's numbers.** The phone decodes a picture with its browser onto a canvas
//!   and runs the model with onnxruntime-web. The card data's `normal` pictures are Scryfall's
//!   WebP `grid` ones (since 14 Oct 2026; older rows are JPEG). Chrome, and so Android's WebView,
//!   decodes WebP with libwebp and JPEG with libjpeg-turbo, and its canvas keeps pixels
//!   premultiplied, which changes the colour of a translucent pixel (the card's rounded corners).
//!   Here a WebP is decoded by the image crate's decoder (the same pixels as libwebp on every
//!   picture measured) and put through that round trip ([`canvas_round_trip`]); a JPEG by
//!   libjpeg-turbo's own code (MozJPEG's decoder). Safari decodes with Apple's own, which may
//!   differ a little. The model runs in tract. tract runs the look
//!   graph as it is, but its GridSample (the warp inside the graph) takes about 290 ms an image on
//!   an M3 Pro against 10 ms for the networks, so the graph is split at its GridSample nodes: tract
//!   computes their image and sampling grid from the model's own nodes, [`grid_sample`] samples as
//!   onnxruntime's CPU kernel does, and tract runs the rest. Measured on 644 Scryfall pictures,
//!   WebP and JPEG, against Chrome and onnxruntime-web: the same pixels (a few corner pixels one
//!   level off in the WebPs) and cosine 1.000000 (docs/scanner.md).
//! - **Checked at every load:** a model's runner must reproduce onnxruntime's outputs on the
//!   synthetic scenes in `web/src/scanner/eval/look-parity-*.json` (scanner-lab/look_parity.py)
//!   within `PARITY_BOUND`, or it makes nothing (phones make their own). A look model without such a
//!   file gets no vectors from the server.
//! - **Kept** in `scan_looks` by the model file's SHA-256 and the picture's URL (what the phone
//!   keys its own cache by), as 256 float16 numbers: symbol then whole card. A new look model gets
//!   its own; a picture Scryfall replaces (a new URL) is made again and the old row goes.
//! - **Which pictures:** in the background, every printing picture of an artwork two or more
//!   printings share (the only ones the look compares), for the look slot's default model, English
//!   paper printings first, then by release, newest first; after each card import, at start and
//!   every six hours. On demand, any printing a phone asked about that wasn't made yet, for any look
//!   model on offer, before the background ones (`want`).
//! - **Scryfall:** the art supplement's fetching (scan_art.rs: cards.scryfall.io only, backoff on a
//!   429 or a 5xx, stop after four in a row) and its pace, shared: one image request at a time
//!   between the two jobs, each 100 ms after the last ended. Pictures are decoded in memory and
//!   dropped.
//! - **One run at a time** across processes (`data/scan-bundle/scan-looks.lock`), and one embedding
//!   at a time on a blocking thread, so saget gives it one core at most. Off with `YAMA_SCAN_LOOKS=0`.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::scan::{MODELS, ModelOption, Slot, Withdrawn, bundle_dir};
use crate::scan_art::{Fetch, Fetched};
use crate::util::now;
use anyhow::{Context, bail};
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;
use tract_onnx::prelude::*;

/// Each look model's expected outputs on synthetic scenes, from Python's onnxruntime
/// (scanner-lab/look_parity.py): the files web/src/scanner/eval/look.test.ts checks
/// onnxruntime-web against, each naming its model by SHA-256. Add a new look model's here.
const PARITY: &[&str] = &[include_str!("../../web/src/scanner/eval/look-parity-v0.json"), include_str!("../../web/src/scanner/eval/look-parity-v1.json")];
/// The largest difference from those a runner may show (the web test's bound for onnxruntime-web).
const PARITY_BOUND: f32 = 2e-4;
/// Each part of a vector (`symbol`, `card`).
pub const DIM: usize = 128;
/// Most printings one request may ask about (a card with more printings of one artwork is rare).
pub const MAX_IDS: usize = 64;
/// At most this many printings wait to be made on demand.
const QUEUE: usize = 2000;
/// A picture that couldn't be made is tried again after a day, up to this many times.
const MAX_TRIES: i64 = 5;
/// Gap between Scryfall image requests, shared with the art supplement (scan_art.rs).
const PAUSE: Duration = Duration::from_millis(100);
const BACKOFF: Duration = Duration::from_secs(2);
/// Scryfall's `normal` pictures are 488 × 680; anything much larger isn't one.
const MAX_SIDE: usize = 2048;
/// The advisory lock that keeps runs one at a time across processes, in `data/scan-bundle/`.
const LOCK: &str = "scan-looks.lock";
/// Scene sizes whose first half of the graph is kept prepared (Scryfall's are one or two).
const PLANS_KEPT: usize = 8;

type Plan = Arc<TypedSimplePlan>;

/// A look embedding: the set symbol's area and the whole card, each L2-normalised.
#[derive(Clone, Debug, PartialEq)]
pub struct LookVector {
    pub symbol: Vec<f32>,
    pub card: Vec<f32>,
}

impl LookVector {
    /// As kept and served: symbol then card, float16 little-endian.
    pub fn to_f16(&self) -> Vec<u8> {
        self.symbol.iter().chain(&self.card).flat_map(|v| half::f16::from_f32(*v).to_bits().to_le_bytes()).collect()
    }

    pub fn from_f16(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != DIM * 2 * 2 {
            return None;
        }
        let v: Vec<f32> = bytes.chunks_exact(2).map(|b| half::f16::from_bits(u16::from_le_bytes([b[0], b[1]])).to_f32()).collect();
        Some(Self { symbol: v[..DIM].to_vec(), card: v[DIM..].to_vec() })
    }
}

/// Embeds a printing's picture (RGBA, its own corners as the card's) with one look model.
pub trait LookEmbed: Send + Sync {
    fn embed(&self, rgba: &[u8], width: usize, height: usize) -> anyhow::Result<LookVector>;
}

/// ONNX GridSample (4-D, bilinear, zeros padding) as onnxruntime's CPU kernel computes it:
/// `x` is 1 × C × H × W, `grid` 1 × Ho × Wo × 2 (x then y, −1 to 1); returns 1 × C × Ho × Wo.
pub fn grid_sample(x: &[f32], c: usize, h: usize, w: usize, grid: &[f32], ho: usize, wo: usize, align_corners: bool) -> Vec<f32> {
    let mut out = vec![0f32; c * ho * wo];
    let (wf, hf) = (w as f32, h as f32);
    // onnxruntime's GsDenormalize.
    let denorm = |n: f32, len: f32| if align_corners { (n + 1.0) / 2.0 * (len - 1.0) } else { ((n + 1.0) * len - 1.0) / 2.0 };
    for i in 0..ho {
        for j in 0..wo {
            let g = (i * wo + j) * 2;
            let (px, py) = (denorm(grid[g], wf), denorm(grid[g + 1], hf));
            if !px.is_finite() || !py.is_finite() {
                continue;
            }
            let (x1, y1) = (px.floor() as i64, py.floor() as i64);
            let (x2, y2) = (x1.saturating_add(1), y1.saturating_add(1));
            let (dx2, dx1) = (x2 as f32 - px, px - x1 as f32);
            let (dy2, dy1) = (y2 as f32 - py, py - y1 as f32);
            for ch in 0..c {
                let plane = &x[ch * h * w..(ch + 1) * h * w];
                let at = |yy: i64, xx: i64| if xx >= 0 && yy >= 0 && (xx as usize) < w && (yy as usize) < h { plane[yy as usize * w + xx as usize] } else { 0.0 };
                out[ch * ho * wo + i * wo + j] = dy2 * (dx2 * at(y1, x1) + dx1 * at(y1, x2)) + dy1 * (dx2 * at(y2, x1) + dx1 * at(y2, x2));
            }
        }
    }
    out
}

/// One of the graph's GridSample nodes: its name, and its image's and grid's places among the
/// wires the graph's first half gives (`LookRunner::wires`).
#[derive(Clone, Debug)]
struct Sampler {
    node: String,
    x: usize,
    grid: usize,
    align_corners: bool,
}

/// One look model, run by tract and split at its GridSample nodes (module notes).
pub struct LookRunner {
    path: PathBuf,
    samplers: Vec<Sampler>,
    /// The samplers' images and grids, by ONNX wire name, each once.
    wires: Vec<String>,
    /// Per scene size (height, width): the graph up to the samplers' inputs.
    front: Mutex<HashMap<(usize, usize), Plan>>,
    /// Per samplers' output shapes: the graph from their outputs to `symbol` and `card`.
    back: Mutex<HashMap<Vec<usize>, Plan>>,
}

impl LookRunner {
    /// Load a look model and check it against its parity file (`sha256` names it there).
    pub fn load(path: &Path, sha256: &str) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let digest = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(&bytes))
        };
        anyhow::ensure!(digest == sha256, "{} isn't the pinned look model (sha256 {digest})", path.display());
        let proto = tract_onnx::onnx().proto_model_for_read(&mut &bytes[..]).context("reading the look graph")?;
        let graph = proto.graph.context("the look model has no graph")?;
        let outputs: Vec<&str> = graph.output.iter().map(|o| o.name.as_str()).collect();
        anyhow::ensure!(outputs == ["symbol", "card"], "the look graph's outputs are {outputs:?}, not symbol and card");
        let inputs: Vec<&str> = graph.input.iter().map(|o| o.name.as_str()).collect();
        anyhow::ensure!(inputs == ["scene", "quad"], "the look graph's inputs are {inputs:?}, not scene and quad");
        let mut samplers = Vec::new();
        let mut wires: Vec<String> = Vec::new();
        let mut place = |wire: &str| wires.iter().position(|w| w == wire).unwrap_or_else(|| {
            wires.push(wire.to_string());
            wires.len() - 1
        });
        for n in graph.node.iter().filter(|n| n.op_type == "GridSample") {
            let attr = |name: &str| n.attribute.iter().find(|a| a.name == name);
            let text = |name: &str, default: &str| attr(name).map_or(default.to_string(), |a| String::from_utf8_lossy(&a.s).into_owned());
            let mode = text("mode", "linear");
            anyhow::ensure!(matches!(mode.as_str(), "bilinear" | "linear"), "GridSample {} samples {mode}, not bilinear", n.name);
            anyhow::ensure!(text("padding_mode", "zeros") == "zeros", "GridSample {} pads other than with zeros", n.name);
            anyhow::ensure!(n.input.len() == 2 && n.output.len() == 1, "GridSample {} isn't one image and one grid", n.name);
            samplers.push(Sampler { node: n.name.clone(), x: place(&n.input[0]), grid: place(&n.input[1]), align_corners: attr("align_corners").is_some_and(|a| a.i != 0) });
        }
        anyhow::ensure!(!samplers.is_empty(), "the look graph has no GridSample to split at");
        let runner = Self { path: path.to_path_buf(), samplers, wires, front: Mutex::default(), back: Mutex::default() };
        runner.check(sha256)?;
        Ok(runner)
    }

    /// Its largest difference from onnxruntime's outputs on the parity scenes; an error past the bound.
    fn check(&self, sha256: &str) -> anyhow::Result<f32> {
        let parity: serde_json::Value = PARITY
            .iter()
            .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
            .find(|p| p["model"].as_str() == Some(sha256))
            .with_context(|| format!("no parity file for the look model {sha256}"))?;
        let mut worst = 0f32;
        for c in parity["cases"].as_array().context("the parity file has no cases")? {
            let (w, h) = (c["width"].as_u64().context("width")? as usize, c["height"].as_u64().context("height")? as usize);
            let q: Vec<[f32; 2]> = serde_json::from_value(c["quad"].clone())?;
            anyhow::ensure!(q.len() == 4, "a parity quad has {} corners", q.len());
            let got = self.run(&parity_scene(w, h), w, h, [q[0], q[1], q[2], q[3]])?;
            let want: (Vec<f32>, Vec<f32>) = (serde_json::from_value(c["symbol"].clone())?, serde_json::from_value(c["card"].clone())?);
            anyhow::ensure!(want.0.len() == got.symbol.len() && want.1.len() == got.card.len(), "the look model's outputs aren't the parity file's size");
            for (a, b) in got.symbol.iter().zip(&want.0).chain(got.card.iter().zip(&want.1)) {
                worst = worst.max((a - b).abs());
            }
        }
        anyhow::ensure!(worst < PARITY_BOUND, "the look model run here differs from onnxruntime by {worst:.2e}; not making vectors with it");
        tracing::info!(model = &sha256[..12], worst, "printing look model checked against onnxruntime");
        Ok(worst)
    }

    fn front(&self, h: usize, w: usize) -> anyhow::Result<Plan> {
        if let Some(p) = self.front.lock().unwrap_or_else(|e| e.into_inner()).get(&(h, w)) {
            return Ok(p.clone());
        }
        let mut m = tract_onnx::onnx().model_for_path(&self.path)?;
        m.set_input_fact(0, u8::fact([h, w, 4]).into())?;
        m.set_input_fact(1, f32::fact([4, 2]).into())?;
        m.select_outputs_by_name(self.wires.iter())?;
        let plan = m.into_optimized().context("preparing the look graph's warp")?.into_runnable()?;
        let mut plans = self.front.lock().unwrap_or_else(|e| e.into_inner());
        if plans.len() >= PLANS_KEPT {
            plans.clear();
        }
        plans.insert((h, w), plan.clone());
        Ok(plan)
    }

    fn back(&self, shapes: &[[usize; 4]]) -> anyhow::Result<Plan> {
        let key: Vec<usize> = shapes.iter().flatten().copied().collect();
        if let Some(p) = self.back.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return Ok(p.clone());
        }
        let mut m = tract_onnx::onnx().model_for_path(&self.path)?;
        m.set_input_names(self.samplers.iter().map(|s| s.node.as_str()))?;
        // Shapes recorded at export (some for the scene's own size) are worked out again.
        for node in 0..m.nodes.len() {
            for slot in 0..m.nodes[node].outputs.len() {
                m.set_outlet_fact(OutletId::new(node, slot), InferenceFact::default())?;
            }
        }
        for (i, s) in shapes.iter().enumerate() {
            m.set_input_fact(i, f32::fact(*s).into())?;
        }
        let plan = m.into_optimized().context("preparing the look graph's networks")?.into_runnable()?;
        self.back.lock().unwrap_or_else(|e| e.into_inner()).insert(key, plan.clone());
        Ok(plan)
    }

    /// The look model's embedding of the card at `quad` (corners from top-left, clockwise) in an
    /// RGBA scene.
    pub fn run(&self, rgba: &[u8], width: usize, height: usize, quad: [[f32; 2]; 4]) -> anyhow::Result<LookVector> {
        anyhow::ensure!(rgba.len() == width * height * 4, "the scene isn't {width} × {height} RGBA");
        let scene = tract_ndarray::Array3::from_shape_vec((height, width, 4), rgba.to_vec())?;
        let q = tract_ndarray::Array2::from_shape_fn((4, 2), |(i, j)| quad[i][j]);
        let wires = self.front(height, width)?.run(tvec!(scene.into_tensor().into(), q.into_tensor().into()))?;
        let mut sampled = TVec::new();
        let mut shapes = Vec::new();
        for s in &self.samplers {
            let (x, grid) = (&wires[s.x], &wires[s.grid]);
            let (xs, gs) = (x.shape(), grid.shape());
            anyhow::ensure!(xs.len() == 4 && xs[0] == 1 && gs.len() == 4 && gs[0] == 1 && gs[3] == 2, "GridSample {} has shapes {xs:?} and {gs:?}", s.node);
            let out = grid_sample(x.to_plain_array_view::<f32>()?.as_slice().context("image")?, xs[1], xs[2], xs[3], grid.to_plain_array_view::<f32>()?.as_slice().context("grid")?, gs[1], gs[2], s.align_corners);
            let shape = [1, xs[1], gs[1], gs[2]];
            sampled.push(tract_ndarray::Array4::from_shape_vec(shape, out)?.into_tensor().into());
            shapes.push(shape);
        }
        let out = self.back(&shapes)?.run(sampled)?;
        let part = |i: usize| -> anyhow::Result<Vec<f32>> { Ok(out[i].to_plain_array_view::<f32>()?.iter().copied().collect()) };
        let v = LookVector { symbol: part(0)?, card: part(1)? };
        anyhow::ensure!(v.symbol.len() == DIM && v.card.len() == DIM && v.symbol.iter().chain(&v.card).all(|x| x.is_finite()), "the look model's outputs aren't two sets of {DIM} numbers");
        Ok(v)
    }
}

impl LookEmbed for LookRunner {
    fn embed(&self, rgba: &[u8], width: usize, height: usize) -> anyhow::Result<LookVector> {
        let (w, h) = (width as f32, height as f32);
        self.run(rgba, width, height, [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]])
    }
}

/// The scene look_parity.py draws (and look.test.ts): a pattern no card is in.
fn parity_scene(w: usize, h: usize) -> Vec<u8> {
    let mut d = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let o = (y * w + x) * 4;
            d[o] = ((x * 7 + y * 3) & 255) as u8;
            d[o + 1] = ((((x * x) >> 3) + y * 5) & 255) as u8;
            d[o + 2] = (((x ^ y) * 3) & 255) as u8;
            d[o + 3] = 255;
        }
    }
    d
}

/// A printing's picture as RGBA, as the phone's browser has it on its canvas (module notes): a
/// WebP or a JPEG; anything else is refused.
pub fn decode_picture(bytes: &[u8]) -> anyhow::Result<(Vec<u8>, usize, usize)> {
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return decode_webp(bytes);
    }
    decode_jpeg(bytes)
}

/// A WebP as RGBA through the browser's canvas: the image crate's decoder (image-webp, the same
/// pixels as libwebp), then [`canvas_round_trip`].
fn decode_webp(bytes: &[u8]) -> anyhow::Result<(Vec<u8>, usize, usize)> {
    let reader = || image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::WebP);
    let (w, h) = reader().into_dimensions().context("reading the picture")?;
    let (w, h) = (w as usize, h as usize);
    anyhow::ensure!(w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE, "the picture is {w} × {h}");
    let mut px = reader().decode().context("decoding the picture")?.to_rgba8().into_raw();
    anyhow::ensure!(px.len() == w * h * 4, "the picture decoded short");
    canvas_round_trip(&mut px);
    Ok((px, w, h))
}

/// What a browser's canvas does to a translucent pixel's colour (Chrome's: measured on the
/// rounded corners of 644 Scryfall WebPs, all but 0.0001% of values the same, the rest one level
/// off): libwebp premultiplies it by its alpha (`(c × a × 32897) >> 23`) and `getImageData`
/// divides it back out, rounded; a transparent one comes back black. Opaque pixels are untouched.
pub fn canvas_round_trip(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a == 255 {
            continue;
        }
        for c in &mut p[..3] {
            let pre = (u32::from(*c) * a * 32897) >> 23;
            *c = if a == 0 { 0 } else { ((pre * 255 + a / 2) / a).min(255) as u8 };
        }
    }
}

/// A JPEG as RGBA, decoded by libjpeg-turbo's code (MozJPEG's decoder): the pixels a browser
/// built on libjpeg-turbo gives (Chrome's; checked on 644 Scryfall pictures).
fn decode_jpeg(bytes: &[u8]) -> anyhow::Result<(Vec<u8>, usize, usize)> {
    anyhow::ensure!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]), "not a JPEG or WebP");
    // The decoder reports a broken file by unwinding; caught here, it's that file's failure.
    let decoded = std::panic::catch_unwind(|| -> std::io::Result<(Vec<u8>, usize, usize)> {
        let d = mozjpeg::Decompress::new_mem(bytes)?;
        let (w, h) = d.size();
        if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
            return Err(std::io::Error::other(format!("the picture is {w} × {h}")));
        }
        let mut d = d.rgba()?;
        let px: Vec<[u8; 4]> = d.read_scanlines()?;
        d.finish()?;
        Ok((px.into_iter().flatten().collect(), w, h))
    });
    match decoded {
        Ok(Ok((px, w, h))) if px.len() == w * h * 4 => Ok((px, w, h)),
        Ok(Ok(_)) => bail!("the picture decoded short"),
        Ok(Err(e)) => Err(anyhow::Error::from(e).context("decoding the picture")),
        Err(_) => bail!("the picture won't decode"),
    }
}

/// The look options with a file of ours, one per file, and each one's model SHA-256.
fn look_files() -> Vec<(&'static ModelOption, &'static str)> {
    let mut seen = HashSet::new();
    MODELS.iter().copied().filter(|o| o.slot == Slot::Look).filter_map(|o| o.sha256().map(|s| (o, s))).filter(|(_, s)| seen.insert(*s)).collect()
}

/// The look models with a parity file (`PARITY`), by SHA-256: the only ones the server makes.
fn with_parity() -> &'static HashSet<String> {
    static SHAS: OnceLock<HashSet<String>> = OnceLock::new();
    SHAS.get_or_init(|| PARITY.iter().filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok()?["model"].as_str().map(str::to_string)).collect())
}

/// The look model a phone names by its file (`look-152f52c100f0`, as its look worker keys its
/// cache), if it's pinned, has a parity file and some option running it isn't withdrawn: its SHA-256.
fn model_of(file: &str, off: &Withdrawn) -> Option<&'static str> {
    MODELS
        .iter()
        .find(|o| o.slot == Slot::Look && o.file().is_some_and(|f| f.strip_suffix(".onnx") == Some(file)) && MODELS.iter().any(|x| x.file() == o.file() && !off.has(x)))
        .and_then(|o| o.sha256())
        .filter(|sha| with_parity().contains(*sha))
}

// ---- On demand ----

/// A data folder's background job in this process: the pictures phones asked for that weren't
/// made, (model, URL), first asked first; and the look models it can't run here.
#[derive(Default)]
struct Job {
    order: VecDeque<(String, String)>,
    set: HashSet<(String, String)>,
    /// Models whose check failed here (their run differs from onnxruntime's, or won't load): none
    /// of their vectors are made, and phones are told the server makes none, until a restart.
    broken: HashSet<String>,
}

/// Each data folder whose background job runs in this process (one in a server; tests each have
/// their own folder).
fn queues() -> &'static Mutex<HashMap<PathBuf, Job>> {
    static Q: OnceLock<Mutex<HashMap<PathBuf, Job>>> = OnceLock::new();
    Q.get_or_init(Mutex::default)
}

/// Whether this folder's job found it can't run this model.
fn broken(data_dir: &Path, model: &str) -> bool {
    queues().lock().unwrap_or_else(|e| e.into_inner()).get(data_dir).is_some_and(|j| j.broken.contains(model))
}

fn mark_broken(data_dir: &Path, model: &str) {
    if let Some(j) = queues().lock().unwrap_or_else(|e| e.into_inner()).get_mut(data_dir) {
        j.broken.insert(model.to_string());
    }
}

/// The job for this data folder runs here: asks are queued for it from now on.
fn register(data_dir: &Path) {
    queues().lock().unwrap_or_else(|e| e.into_inner()).entry(data_dir.to_path_buf()).or_default();
}

/// Make this picture for this model soon (a phone asked and it wasn't made): before the background
/// ones. False when no job runs for this folder, the queue is full or it's already waiting.
fn want(data_dir: &Path, model: &str, url: &str) -> bool {
    let mut all = queues().lock().unwrap_or_else(|e| e.into_inner());
    let Some(w) = all.get_mut(data_dir) else { return false };
    let key = (model.to_string(), url.to_string());
    if w.order.len() >= QUEUE || w.set.contains(&key) {
        return false;
    }
    w.set.insert(key.clone());
    w.order.push_back(key);
    true
}

fn next_wanted(data_dir: &Path) -> Option<(String, String)> {
    let mut all = queues().lock().unwrap_or_else(|e| e.into_inner());
    let w = all.get_mut(data_dir)?;
    let key = w.order.pop_front()?;
    w.set.remove(&key);
    Some(key)
}

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// A card import asked for a whole run (the new printings, and the tidying), not only phones' asks.
static FULL: AtomicBool = AtomicBool::new(false);

/// Fresh card data arrived: a whole run soon.
pub fn nudge() {
    FULL.store(true, Ordering::Relaxed);
    wake().notify_one();
}

// ---- The endpoint ----

pub fn router() -> Router<AppState> {
    Router::new().route("/api/scan/looks", get(looks))
}

#[derive(Deserialize)]
struct LooksQuery {
    /// The look model by its file's name without `.onnx`, as `/api/scan/bundle` lists it.
    model: String,
    /// Scryfall IDs, comma-separated; `<id>-1` for a printing's back face.
    ids: String,
}

#[derive(Serialize, Debug)]
struct Looks {
    /// The model's SHA-256, or null for a model the server makes no vectors for (unknown, withdrawn).
    model: Option<&'static str>,
    /// The printings asked about whose picture's vector is made: their ID as asked, the picture's
    /// URL (the phone uses it only when its own candidate's is the same), and the vector.
    looks: Vec<LookOut>,
    /// Printings asked about with a picture but no vector yet (each is made soon).
    missing: usize,
}

#[derive(Serialize, Debug)]
struct LookOut {
    id: String,
    url: String,
    /// symbol then card, 2 × 128 float16 little-endian, base64.
    vector: String,
}

/// A Scryfall ID as the scanner sends it: 36 characters of hex and dashes.
fn plain_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

async fn looks(State(st): State<AppState>, _user: CurrentUser, Query(q): Query<LooksQuery>) -> AppResult<Json<Looks>> {
    let mut fronts = Vec::new();
    let mut backs = Vec::new();
    for id in q.ids.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (bare, back) = id.strip_suffix("-1").map_or((id, false), |b| (b, true));
        if !plain_uuid(bare) {
            return Err(AppError::bad("ids are Scryfall IDs, comma-separated, with -1 for a back face"));
        }
        let list = if back { &mut backs } else { &mut fronts };
        if !list.contains(&bare.to_string()) {
            list.push(bare.to_string());
        }
    }
    if fronts.len() + backs.len() > MAX_IDS {
        return Err(AppError::bad(format!("at most {MAX_IDS} printings at once")));
    }
    let Some(model) = model_of(&q.model, &Withdrawn::of(&st.cfg)).filter(|m| !broken(&st.cfg.data_dir, m)) else {
        return Ok(Json(Looks { model: None, looks: vec![], missing: 0 }));
    };
    let mut out = Looks { model: Some(model), looks: vec![], missing: 0 };
    let mut queued = false;
    for (ids, back) in [(fronts, false), (backs, true)] {
        if ids.is_empty() {
            continue;
        }
        let column = if back { "p.back_image_normal" } else { "p.image_normal" };
        // Whether it's worth making now: not tried, or failed less than MAX_TRIES times and not in
        // the last day (`needed`'s rule, so a picture that keeps failing doesn't wake the job).
        let rows: Vec<(String, String, Option<Vec<u8>>, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT p.scryfall_id, {column}, l.vector, l.model IS NULL OR (l.tries < ?3 AND l.updated_at <= ?4) FROM printings p
               LEFT JOIN scan_looks l ON l.model = ?1 AND l.url = {column}
              WHERE p.scryfall_id IN (SELECT value FROM json_each(?2)) AND {column} IS NOT NULL ORDER BY p.scryfall_id"
        )))
        .bind(model)
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .bind(MAX_TRIES)
        .bind(day_ago())
        .fetch_all(&st.pool)
        .await?;
        for (id, url, vector, worth) in rows {
            let id = if back { format!("{id}-1") } else { id };
            match vector.filter(|v| v.len() == DIM * 4) {
                Some(v) => out.looks.push(LookOut { id, url, vector: base64::engine::general_purpose::STANDARD.encode(v) }),
                None => {
                    out.missing += 1;
                    // Made soon by the background job, if it runs here.
                    if worth {
                        queued |= want(&st.cfg.data_dir, model, &url);
                    }
                }
            }
        }
    }
    if queued {
        wake().notify_one();
    }
    Ok(Json(out))
}

// ---- The job ----

/// Options for one run.
#[derive(Default, Clone)]
pub struct Options {
    /// At most this many pictures (all when None).
    pub limit: Option<usize>,
    /// Only the pictures phones asked for: no background ones and no tidying (a run woken by an
    /// ask between the whole runs at start, after card imports and every six hours).
    pub asks_only: bool,
    /// Gap between image requests (default 100 ms) and the first backoff (default 2 s); tests shorten them.
    pub pause: Option<Duration>,
    pub backoff: Option<Duration>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub made: usize,
    pub failed: usize,
    /// Rows dropped: of models no longer pinned, and of pictures no printing has now.
    pub dropped: u64,
    /// Another run held the lock, so this one did nothing.
    pub busy: bool,
    /// Scryfall was unavailable and the run stopped early (why); the next run resumes.
    pub stopped: Option<String>,
    /// The look model the background ones are made for (the look slot's default on offer here);
    /// None while there's none (the bundle or the model not downloaded yet).
    pub model: Option<String>,
}

/// Look models loaded so far, by SHA-256 (loaded once per process, checked at load).
pub type Runners = HashMap<String, Arc<dyn LookEmbed>>;

/// What a run needs that tests replace: how pictures are fetched and how a model is loaded.
pub struct Deps {
    pub fetch: Fetch,
    pub load: Arc<dyn Fn(&Path, &str) -> anyhow::Result<Arc<dyn LookEmbed>> + Send + Sync>,
}

impl Deps {
    pub fn real(http: reqwest::Client) -> Self {
        Self { fetch: crate::scan_art::scryfall_fetch(http), load: Arc::new(|path, sha| Ok(Arc::new(LookRunner::load(path, sha)?) as Arc<dyn LookEmbed>)) }
    }
}

enum Problem {
    Unavailable { retry_after: Option<Duration>, why: String },
    Content(anyhow::Error),
}

/// Fetch, decode and embed one picture.
async fn make_one(url: &str, fetch: &Fetch, runner: &Arc<dyn LookEmbed>, pause: Duration) -> Result<LookVector, Problem> {
    let bytes = match crate::scan_art::paced(pause, fetch(url.to_string())).await {
        Ok(Fetched::Image(b)) => b,
        Ok(Fetched::Missing) => return Err(Problem::Content(anyhow::anyhow!("Scryfall has no such picture"))),
        Ok(Fetched::Unavailable { retry_after, why }) => return Err(Problem::Unavailable { retry_after, why }),
        Err(e) => return Err(Problem::Content(e)),
    };
    let runner = runner.clone();
    tokio::task::spawn_blocking(move || {
        let (rgba, w, h) = decode_picture(&bytes)?;
        runner.embed(&rgba, w, h)
    })
    .await
    .map_err(|e| Problem::Content(e.into()))?
    .map_err(Problem::Content)
}

async fn store(pool: &SqlitePool, model: &str, url: &str, made: Result<&LookVector, &str>) -> anyhow::Result<()> {
    match made {
        Ok(v) => {
            sqlx::query(
                "INSERT INTO scan_looks (model, url, vector, error, tries, updated_at) VALUES (?, ?, ?, NULL, 0, ?)
                 ON CONFLICT (model, url) DO UPDATE SET vector = excluded.vector, error = NULL, updated_at = excluded.updated_at",
            )
            .bind(model)
            .bind(url)
            .bind(v.to_f16())
            .bind(now())
            .execute(pool)
            .await?;
        }
        Err(e) => {
            sqlx::query(
                "INSERT INTO scan_looks (model, url, vector, error, tries, updated_at) VALUES (?, ?, NULL, ?, 1, ?)
                 ON CONFLICT (model, url) DO UPDATE SET error = excluded.error, tries = scan_looks.tries + 1, updated_at = excluded.updated_at",
            )
            .bind(model)
            .bind(url)
            .bind(e)
            .bind(now())
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

/// The background job's pictures for `model`: each printing picture of an artwork two or more
/// printings share (the face the artwork is on), not made yet and not given up on or failed in
/// the last day. English paper printings first, then by release, newest first.
async fn background(pool: &SqlitePool, model: &str) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "WITH shared AS (
           SELECT art FROM (SELECT illustration_id AS art FROM printings WHERE illustration_id IS NOT NULL
                  UNION ALL SELECT back_illustration_id FROM printings WHERE back_illustration_id IS NOT NULL)
            GROUP BY art HAVING COUNT(*) > 1),
         pictures AS (
           SELECT p.image_normal AS url, p.lang = 'en' AND IFNULL(p.digital, 0) = 0 AS paper, p.released_at
             FROM printings p JOIN shared s ON s.art = p.illustration_id WHERE p.image_normal IS NOT NULL
           UNION ALL
           SELECT p.back_image_normal, p.lang = 'en' AND IFNULL(p.digital, 0) = 0, p.released_at
             FROM printings p JOIN shared s ON s.art = p.back_illustration_id WHERE p.back_image_normal IS NOT NULL)
         SELECT url FROM pictures
          WHERE url NOT IN (SELECT url FROM scan_looks WHERE model = ?1 AND (vector IS NOT NULL OR tries >= ?2 OR updated_at > ?3))
          GROUP BY url ORDER BY MAX(paper) DESC, MAX(released_at) DESC, url",
    )
    .bind(model)
    .bind(MAX_TRIES)
    .bind(day_ago())
    .fetch_all(pool)
    .await?)
}

fn day_ago() -> String {
    (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Whether this picture still needs making for this model (made meanwhile, on an ask or in the
/// background, or failed in the last day, it doesn't).
async fn needed(pool: &SqlitePool, model: &str, url: &str) -> anyhow::Result<bool> {
    let row: Option<(bool, i64, String)> = sqlx::query_as("SELECT vector IS NOT NULL, tries, updated_at FROM scan_looks WHERE model = ? AND url = ?")
        .bind(model)
        .bind(url)
        .fetch_optional(pool)
        .await?;
    let day_ago = day_ago();
    Ok(row.is_none_or(|(made, tries, at)| !made && tries < MAX_TRIES && at <= day_ago))
}

/// One run: the pictures phones asked for, then the background ones, until done (or `limit`).
pub async fn run(pool: &SqlitePool, data_dir: &Path, off: &Withdrawn, deps: &Deps, runners: &mut Runners, opts: &Options) -> anyhow::Result<Report> {
    let dir = bundle_dir(data_dir);
    let lock = {
        let data_dir = data_dir.to_path_buf();
        tokio::task::spawn_blocking(move || crate::scan_art::lock_named(&data_dir, LOCK)).await??
    };
    let Some(_lock) = lock else {
        tracing::info!("printing look vectors: another run is going; skipping");
        return Ok(Report { busy: true, ..Report::default() });
    };
    let mut report = Report::default();
    // Vectors of look models no longer pinned (a withdrawal can be lifted, so those stay).
    if !opts.asks_only {
        let pinned: Vec<&str> = look_files().into_iter().map(|(_, s)| s).collect();
        report.dropped += sqlx::query("DELETE FROM scan_looks WHERE model NOT IN (SELECT value FROM json_each(?))")
            .bind(serde_json::to_string(&pinned)?)
            .execute(pool)
            .await?
            .rows_affected();
    }
    // The look models on offer here now (fitting this bundle, downloaded, not withdrawn), by SHA-256.
    let manifest = crate::scan::read_manifest(&dir).await;
    let on_offer = crate::scan::offered(off, &dir, manifest.as_ref()).await;
    let files: HashMap<&str, PathBuf> = on_offer.iter().filter(|o| o.slot == Slot::Look).filter_map(|o| Some((o.sha256()?, dir.join(o.file()?)))).collect();
    let default = crate::scan::default_of(Slot::Look, &on_offer).and_then(|o| o.sha256());
    report.model = default.map(str::to_string);
    let pause = opts.pause.unwrap_or(PAUSE);
    let base = opts.backoff.unwrap_or(BACKOFF);
    let mut queue: VecDeque<String> = match default {
        Some(m) if !opts.asks_only => background(pool, m).await?.into(),
        _ => VecDeque::new(),
    };
    // Models already found not to run here are skipped (`Job::broken`).
    let mut skip: HashSet<String> = files.keys().filter(|m| broken(data_dir, m)).map(|m| m.to_string()).collect();
    let mut streak = 0u32;
    let mut done = 0usize;
    let mut finished = true;
    'items: loop {
        if opts.limit.is_some_and(|l| done >= l) {
            finished = queue.is_empty();
            break;
        }
        // Phones' asks first, then the background ones.
        let (model, url, asked) = match next_wanted(data_dir) {
            Some((m, u)) => (m, u, true),
            None => match (default, queue.pop_front()) {
                (Some(m), Some(u)) => (m.to_string(), u, false),
                _ => break,
            },
        };
        let Some(path) = files.get(model.as_str()) else { continue };
        if skip.contains(&model) || !needed(pool, &model, &url).await? {
            continue;
        }
        let runner = match runners.get(&model) {
            Some(r) => r.clone(),
            None => {
                let (path, sha, load) = (path.clone(), model.clone(), deps.load.clone());
                match tokio::task::spawn_blocking(move || load(&path, &sha)).await? {
                    Ok(r) => {
                        runners.insert(model.clone(), r.clone());
                        r
                    }
                    Err(e) => {
                        tracing::warn!(model = &model[..12.min(model.len())], error = %format!("{e:#}"), "printing look vectors: can't run this look model here; phones make their own");
                        mark_broken(data_dir, &model);
                        skip.insert(model);
                        continue;
                    }
                }
            }
        };
        let made = loop {
            match make_one(&url, &deps.fetch, &runner, pause).await {
                Err(Problem::Unavailable { retry_after, why }) => {
                    streak += 1;
                    match crate::scan_art::backoff(streak, retry_after, base) {
                        Some(wait) => tokio::time::sleep(wait).await,
                        None => {
                            tracing::warn!(why, "printing look vectors: Scryfall unavailable; stopping until the next run");
                            // Kept for the next run.
                            if asked {
                                want(data_dir, &model, &url);
                            }
                            report.stopped = Some(why);
                            finished = false;
                            break 'items;
                        }
                    }
                }
                other => {
                    streak = 0;
                    break other;
                }
            }
        };
        done += 1;
        match made {
            Ok(v) => {
                store(pool, &model, &url, Ok(&v)).await?;
                report.made += 1;
            }
            Err(Problem::Content(e)) => {
                tracing::debug!(url, error = %format!("{e:#}"), "couldn't make a printing's look vector");
                store(pool, &model, &url, Err(&format!("{e:#}"))).await?;
                report.failed += 1;
            }
            Err(Problem::Unavailable { .. }) => unreachable!("handled above"),
        }
    }
    // Pictures no printing has now (Scryfall replaced them, or the printing went), once a run
    // got through everything.
    if finished && default.is_some() && !opts.asks_only {
        report.dropped += sqlx::query(
            "DELETE FROM scan_looks WHERE url NOT IN (SELECT image_normal FROM printings WHERE image_normal IS NOT NULL
               UNION SELECT back_image_normal FROM printings WHERE back_image_normal IS NOT NULL)",
        )
        .execute(pool)
        .await?
        .rows_affected();
    }
    if report.made + report.failed > 0 || report.stopped.is_some() || report.dropped > 0 {
        tracing::info!(made = report.made, failed = report.failed, dropped = report.dropped, stopped = ?report.stopped, "printing look vectors updated");
    }
    Ok(report)
}

/// The background job: once the bundle and a look model are here, run now, after every card
/// import and phones' asks (`nudge`), and every six hours.
pub fn spawn(pool: SqlitePool, data_dir: PathBuf, http: reqwest::Client, off: Withdrawn) {
    register(&data_dir);
    tokio::spawn(async move {
        let deps = Deps::real(http.clone());
        let mut runners = Runners::new();
        // A whole run at start, after a card import and every six hours; between them, a run woken
        // by phones' asks makes only those.
        let mut full = true;
        loop {
            let opts = Options { asks_only: !full, ..Options::default() };
            match run(&pool, &data_dir, &off, &deps, &mut runners, &opts).await {
                Ok(r) if r.stopped.is_some() => {
                    // Scryfall is unavailable: try again in a while rather than at the next ask.
                    tokio::time::sleep(Duration::from_secs(10 * 60)).await;
                    continue;
                }
                Ok(r) if r.model.is_none() => {
                    // No look model here yet: its download (scan.rs) starts once the bundle is here.
                    crate::scan::ensure_models(data_dir.clone(), http.clone(), off.clone()).await;
                    tokio::time::sleep(Duration::from_secs(5 * 60)).await;
                    full = true;
                    continue;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %format!("{e:#}"), "printing look vectors failed"),
            }
            full = match tokio::time::timeout(Duration::from_secs(6 * 3600), wake().notified()).await {
                Err(_) => true,
                Ok(()) => FULL.swap(false, Ordering::Relaxed),
            };
        }
    });
}

/// `yama-server scan-looks [--limit N]`: a run by hand. `yama-server scan-looks --embed MODEL.onnx
/// --out VECTORS.json PICTURE…` (WebP or JPEG): the vectors this server makes for those pictures, by file
/// name, for comparing with the phone's (web/src/scanner/eval/look.test.ts, `SCANNER_LOOK_SERVER`).
pub async fn cli(pool: &SqlitePool, cfg: &crate::config::Config, args: &[String]) -> anyhow::Result<()> {
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if let Some(model) = value("--embed") {
        let out = value("--out").context("--embed needs --out")?;
        let bytes = std::fs::read(&model)?;
        let sha = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(&bytes))
        };
        let runner = LookRunner::load(Path::new(&model), &sha)?;
        let skip: HashSet<&str> = ["--embed", "--out"].into();
        let mut vectors = serde_json::Map::new();
        let mut i = 0;
        while i < args.len() {
            if skip.contains(args[i].as_str()) {
                i += 2;
                continue;
            }
            let path = Path::new(&args[i]);
            let (rgba, w, h) = decode_picture(&std::fs::read(path)?).with_context(|| path.display().to_string())?;
            let v = runner.embed(&rgba, w, h)?;
            let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            vectors.insert(name, serde_json::json!({"symbol": v.symbol, "card": v.card}));
            i += 1;
        }
        let n = vectors.len();
        std::fs::write(&out, serde_json::to_vec(&serde_json::Value::Object(vectors))?)?;
        println!("embedded {n} pictures with {} into {out}", &sha[..12]);
        return Ok(());
    }
    let opts = Options { limit: value("--limit").map(|n| n.parse()).transpose().context("--limit takes a number")?, ..Options::default() };
    let http = crate::routes::http_client();
    let dir = bundle_dir(&cfg.data_dir);
    if !crate::scan::is_ready(&dir) {
        println!("downloading the scanner bundle {} …", crate::scan::BUNDLE_VERSION);
        crate::scan::download(&http, &dir).await?;
    }
    let off = Withdrawn::of(cfg);
    // The look models are the server's downloads (scan.rs); a run without one makes nothing.
    let mut runners = Runners::new();
    let report = run(pool, &cfg.data_dir, &off, &Deps::real(http), &mut runners, &opts).await?;
    if report.busy {
        println!("another scan-looks run is going (the server's, or another command); nothing done");
        return Ok(());
    }
    if let Some(why) = &report.stopped {
        println!("stopped early: Scryfall is unavailable ({why}); the next run picks up where this one left off");
    }
    if report.model.is_none() {
        println!("no look model is downloaded here yet (the server fetches it once the scanner bundle is here)");
    }
    println!("made {}, failed {}, dropped {}", report.made, report.failed, report.dropped);
    Ok(())
}

#[cfg(test)]
mod tests;
