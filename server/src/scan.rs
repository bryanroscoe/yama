//! The card scanner's server side (web/src/scanner, docs/scanner.md).
//!
//! - The art recognition bundle: three ONNX graphs and an index of artworks, published by
//!   ManaVault (MPL-2.0, github.com/cfbender/manavault). One pinned version is downloaded once into
//!   `data/scan-bundle/<version>/`, checked against the SHA-256 sums below, and served to the app
//!   from `/scan-bundle/<version>/` so phones never fetch it from GitHub and it works offline once
//!   cached. Nothing is downloaded until the server's card imports run or someone opens the scanner.
//! - Yama's own query embedder (`QUERY_MODEL`, docs/scanner.md, "Yama's query embedder"): a
//!   fine-tuned copy of the bundle's `embed.onnx`, published as a release asset of this
//!   repository, downloaded and checked the same way into the bundle's folder under its own name,
//!   and served as the bundle's embed graph while it fits the bundle's gallery.
//! - `GET /api/scan/printings`: every printing that shares a recognised artwork, so the scanner
//!   only has to tell those apart (collector line, or the person picks).
//! - `GET /api/scan/sets` and `GET /api/scan/set?code=`: the sets to lock a scan to, and one set's
//!   printings with their artworks, so a locked scan matches only that set's art and files its
//!   printing without reading the collector line (docs/scanner.md, "Set lock").

use crate::auth::CurrentUser;
use crate::cards::{Printing, PRINTING_SELECT};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use anyhow::Context;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::AssertSqlSafe;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;

/// The pinned bundle. To move to a newer one, change the tag, sizes and sums (from the release's
/// SHA256SUMS and manifest.json), check the search graph's inputs still match `recognizer.ts`
/// (this one added `mask`), run the recognizer eval (docs/scanner.md) and note the result.
pub const BUNDLE_VERSION: &str = "gallery-20261106T183001884398Z";
const RELEASE_URL: &str = "https://github.com/cfbender/manavault/releases/download/scanner-bundle-";
const FILES: [(&str, u64, &str); 5] = [
    ("manifest.json", 2_146, "cee5b38ede2100bb05fed174988bb296fb1a7944b41d8393547d499ecd0610ca"),
    ("detector.onnx", 12_576_317, "1e8cdd520dce3570ca2f24c270ac39cc7ac0639d0504c3032b7850fbf8c0c771"),
    ("embed.onnx", 5_118_408, "f71739bbe6804cd442ddb0a40ec1f22f62c47991fc9cf7a4f445257e8081fb7c"),
    ("search.onnx", 14_240_610, "02a7352f2479c40beb6d463a11eba4c3bf3a26e87d2730afeed87dd29d32d938"),
    ("arts.json", 18_083_400, "df8164150343bb5dc85b39b5d1ba3893c124105eef1d6af9f393bb038d7d977f"),
];
/// The artwork index reduced to what the scanner reads (about a third of arts.json), gzipped.
pub(crate) const ARTS: &str = "arts.slim.json";
/// After a failed download, wait this long before trying again.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

/// A part of the scanner whose model the app can switch on the fly (docs/scanner.md, "Models you
/// can switch"; Bryan, 20 Nov 2026: "We should have the ability to switch scanners on the fly if
/// need be by the way we want to be able to try a lot of things here and switch between models
/// when things break").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Slot {
    /// The card finder: the detector that places the card's corners in the frame.
    Detector,
    /// The art match's query side: what the camera sees, embedded to search the bundle's gallery.
    Art,
    /// The printing look: the card compared with each candidate printing's own picture.
    Look,
    /// The text reader.
    Text,
    /// The rule that settles a card by its art.
    Lock,
}

pub(crate) const SLOTS: [Slot; 5] = [Slot::Detector, Slot::Art, Slot::Look, Slot::Text, Slot::Lock];

impl Slot {
    /// What the app, `/api/scan/bundle` and records call it.
    pub fn key(self) -> &'static str {
        match self {
            Slot::Detector => "detector",
            Slot::Art => "art",
            Slot::Look => "look",
            Slot::Text => "text",
            Slot::Lock => "lock",
        }
    }
}

/// Where an option's model comes from.
pub(crate) enum Source {
    /// Nothing to download from here: the app's own code (a text reader, a lock rule), or off.
    App,
    /// One of the pinned bundle's files.
    Bundle(&'static str),
    /// A file of ours, pinned by size and SHA-256: downloaded once into the bundle's folder as
    /// `<prefix>-<first 12 of the sum>.onnx`, checked the way the bundle's files are, and served
    /// from there (immutable, like them).
    File { prefix: &'static str, url: &'static str, bytes: u64, sha256: &'static str },
}

/// One option for a slot. To add one: a new const below, listed in `MODELS`, with its file pinned
/// (all of url, bytes and sha256) and its licence; the app offers it in Scan settings once the
/// server has it (docs/scanner.md, "Models you can switch").
pub(crate) struct ModelOption {
    pub slot: Slot,
    /// What the app chooses it by, records name it by, and `YAMA_SCAN_WITHDRAW` withdraws it by.
    pub id: &'static str,
    /// Its name in Scan settings.
    pub label: &'static str,
    /// A sentence on what it is, for Scan settings.
    pub note: &'static str,
    pub licence: Option<&'static str>,
    pub source: Source,
    /// The bundle manifest's `recogniser.sha256` whose gallery its vectors compare with (a query
    /// model is trained against one checkpoint's gallery; a bundle from another gets none of it).
    pub recogniser: Option<&'static str>,
    /// The slot's default while it's on offer.
    pub default: bool,
    /// What the slot does with nothing of ours: never withdrawn, so a slot always has an option.
    pub base: bool,
    /// What the app must say it can run (`GET /api/scan/bundle?can=…`) to be offered it: an option a
    /// web build from before it can't run (an Android app can run last deploy's build for a session).
    /// Never a slot's base or `files.embed`, and a default only with an option every app runs standing
    /// in for it (`STANDS_IN`), which apps that don't say they can run it get instead.
    pub needs: Option<&'static str>,
    /// A look option that also settles the printing by itself when it's sure (look.ts,
    /// `lookSettles`: every printing scored, the closest `LOOK_SETTLE_LEAD` ahead of the next, and
    /// nothing the collector line read pointing to another). Sent to the app as `settles`.
    pub settles: bool,
}

const RECOGNISER_20261026: &str = "eb6558461672b30c8b699570cc1669c4baa1a31d5fd28d617800e8a1f4d2e2c3";

/// The bundle's own `embed.onnx`, ManaVault's query model.
const BUNDLE_ART: ModelOption = ModelOption {
    slot: Slot::Art,
    id: "bundle",
    label: "ManaVault's art model",
    note: "The art bundle's own model, trained on clean captures of bare cards.",
    licence: Some("MPL-2.0"),
    source: Source::Bundle("embed.onnx"),
    recogniser: None,
    default: false,
    base: true,
    needs: None,
    settles: false,
};

/// Yama's own query embedder (docs/scanner.md, "Yama's query embedder", 18 Nov 2026): the bundle's
/// `embed.onnx` with its embedding half fine-tuned on simulated sleeved, glare and blue-box
/// captures against the bundle's frozen gallery (scanner-lab/). Derived from ManaVault's MPL-2.0
/// weights, so the file is MPL-2.0; it is a release asset of this repository. Phones run it in
/// place of the bundle's `embed.onnx`: same inputs (`scene`, `quad`) and output (`embeddings`).
/// The gallery side stays the bundle's (search.onnx, arts.json, and scan_art.rs's supplement,
/// which embeds new art with the bundle's own `embed.onnx`). Offered only with a bundle made by
/// the recogniser it was trained against. To pin a newer one, add it as another option (or
/// change all of url, bytes and sha256 together) and run the recognizer eval (docs/scanner.md).
pub(crate) const QUERY_MODEL: ModelOption = ModelOption {
    slot: Slot::Art,
    id: "yama-art-20261118",
    label: "Yama's art model, 18 Nov",
    note: "Fine-tuned for sleeved cards, glare and deck boxes: on real sleeved photos one photo's scores qualify for an art lock on 94% of cards, against 85% for ManaVault's.",
    licence: Some("MPL-2.0"),
    source: Source::File {
        prefix: "query",
        url: "https://github.com/bryanroscoe/yama/releases/download/scanner-art-20261118/yama-art-20261118.onnx",
        bytes: 5_139_404,
        sha256: "52420d900728e25e2c4733c7fce45dbea0ae7f4f244fa027421a0f00cdd8faee",
    },
    recogniser: Some(RECOGNISER_20261026),
    default: false,
    base: false,
    needs: None,
    settles: false,
};

/// The same weights as QUERY_MODEL, with an extra `cuts` input (int64) naming the frame cuts to embed;
/// the others' rows come back as zeros. The app (recognizer.ts, `FIRST_STAGE`) embeds the modern
/// and old cuts first and the other 15 only when those don't settle the frame: the same results on
/// the real photos and the held-out simulated captures, the art match about four times faster on one
/// WASM thread (docs/scanner.md, "Speed"). Made by `scanner-lab/cascade.py` from QUERY_MODEL's file
/// (MPL-2.0, as that file is). A web build from before `cuts` can't run it, so it's listed only to
/// apps that say they can (`needs`), and never served as `files.embed`. The art slot's default
/// since 22 Nov 2026 (docs/scanner.md, "The faster models as the defaults"): an app that can't feed
/// `cuts`, and `files.embed`, get QUERY_MODEL in its place (`STANDS_IN`).
pub(crate) const QUERY_CASCADE: ModelOption = ModelOption {
    slot: Slot::Art,
    id: "yama-art-20261118-cascade",
    label: "Yama's art model, 18 Nov, two cuts first",
    note: "The same model, matching the art as modern and old frames first and the rarer frames only when those don't settle it: the same results on the test photos, about 45 ms less a frame on a laptop.",
    licence: Some("MPL-2.0"),
    source: Source::File {
        prefix: "query",
        url: "https://github.com/bryanroscoe/yama/releases/download/scanner-models-20261120/yama-art-20261118-cascade.onnx",
        bytes: 5_140_073,
        sha256: "103b3d9af4982466ae3d69fb1528f2a82f23cb411bda32c4b2ec782f60d1048b",
    },
    recogniser: Some(RECOGNISER_20261026),
    default: true,
    base: false,
    needs: Some("cuts"),
    settles: false,
};

/// The bundle's own `detector.onnx` (ManaVault, MPL-2.0): four turned views of each window a look.
const BUNDLE_DETECTOR: ModelOption = ModelOption {
    slot: Slot::Detector,
    id: "bundle-detector",
    label: "ManaVault's card finder",
    note: "The art bundle's own: it looks at each window four ways round and takes their vote.",
    licence: Some("MPL-2.0"),
    source: Source::Bundle("detector.onnx"),
    recogniser: None,
    default: false,
    base: true,
    needs: None,
    settles: false,
};

/// Yama's own card finder (docs/scanner.md, "Speed"; scanner-lab/corners_*.py): torchvision's
/// MobileNetV3-Small (BSD-3-Clause, ImageNet weights) with a small decoder, trained on simulated
/// captures with fingers and thumbs over corners. One view a look; it places the card's corners as
/// printed, covered ones included. Same input (`window`) and outputs (`quad`, `up`, `centre`,
/// `short`) as the bundle's detector, so recognizer.ts runs it unchanged. Offered only with a bundle
/// whose detector reads a 256 px window and votes over four views (`fits`), as the pinned one does.
/// The card finder slot's default since 22 Nov 2026 (docs/scanner.md, "The faster models as the
/// defaults"); until it's downloaded, or if it's withdrawn, the bundle's runs (the slot's base).
pub(crate) const CORNERS_MODEL: ModelOption = ModelOption {
    slot: Slot::Detector,
    id: "yama-corners-20261120",
    label: "Yama's card finder, 20 Nov",
    note: "One look at each window instead of four, so it finds a card about four times faster, and it places a corner a finger covers.",
    licence: Some("Yama's own; initialised from torchvision's MobileNetV3-Small (BSD-3-Clause)"),
    source: Source::File {
        prefix: "corners",
        url: "https://github.com/bryanroscoe/yama/releases/download/scanner-models-20261120/yama-corners-20261120.onnx",
        bytes: 4_140_304,
        sha256: "18f9d6aab2a4688d8c576eee6e09e9f449cf8ebb38e2ccceabf148ad1b557dd3",
    },
    recogniser: None,
    default: true,
    base: false,
    needs: None,
    settles: false,
};

const LOOK_OFF: ModelOption = ModelOption {
    slot: Slot::Look,
    id: "off",
    label: "Off",
    note: "Printings that share the art are listed newest first, after any the collector line read.",
    licence: None,
    source: Source::App,
    recogniser: None,
    default: false,
    base: true,
    needs: None,
    settles: false,
};

/// Yama's printing look models (docs/scanner.md, "The printing look", 20 Nov 2026): compare the
/// card in the camera's frame with each printing that shares its art, by that printing's own
/// Scryfall picture, to order the printing list. Same interface as the bundle's `embed.onnx`
/// (`scene`, `quad`), outputs `symbol` and `card` (1 × 128, L2-normalised); they warp the card
/// themselves. Trained by Yama from torchvision's ImageNet MobileNetV3-Small weights
/// (BSD-3-Clause); release assets of this repository. They only order the list: they never file
/// a printing (`LOOK_V1_SURE` below, an option, does when it's sure). v0, the first; v1 (the
/// default) has a set-symbol network trained on the graph's own crops over all 78,063 English
/// paper printings that share an artwork, and v0's whole-card one.
const LOOK_V0: ModelOption = ModelOption {
    slot: Slot::Look,
    id: "look-v0",
    label: "Yama's look model v0",
    note: "The first look model: on real sleeved photos the right printing comes first 57% of the time, against 41% newest first. It never files a printing by itself.",
    licence: Some("Yama's licence; base weights BSD-3-Clause (torchvision)"),
    source: Source::File {
        prefix: "look",
        url: "https://github.com/bryanroscoe/yama/releases/download/scanner-look-20261120/yama-look-v0.onnx",
        bytes: 9_292_149,
        sha256: "58acfa166105c3001445589ec11db98d5ed61f1a70a63dc133dca00fa6bd271d",
    },
    recogniser: None,
    default: false,
    base: false,
    needs: None,
    settles: false,
};

const LOOK_V1: ModelOption = ModelOption {
    slot: Slot::Look,
    id: "look-v1",
    label: "Yama's look model v1",
    note: "Compares the card with each printing's own picture and lists the closest first: on real sleeved photos the right printing comes first 87% of the time (v0 57%, newest first 41%). It never files a printing by itself.",
    licence: Some("Yama's licence; base weights BSD-3-Clause (torchvision)"),
    source: Source::File {
        prefix: "look",
        url: "https://github.com/bryanroscoe/yama/releases/download/scanner-look-20261120/yama-look-v1.onnx",
        bytes: 9_292_149,
        sha256: "152f52c100f0080c98e0ce7063b6fe9444e0c8654b1142772339af84138b79e7",
    },
    recogniser: None,
    default: true,
    base: false,
    needs: None,
    settles: false,
};

/// v1 that also settles the printing by itself when it's sure (docs/scanner.md, "Settling by
/// look", 20 Nov 2026): once it has scored every printing that shares the art and the closest
/// leads the next by 0.10 or more, the app settles that printing as the collector line would
/// (look.ts, `lookSettles`), unless the collector line has read something pointing to another
/// printing. v1's own pinned file, so nothing more to download and the same embedding cache. Not
/// the default: on one tester's 98 real sleeved photos (640 px) that lead settled 45 alone, none
/// wrong, which still allows about one in 15 wrong. Listed only to apps that run the rule
/// (`can=settle`): an older build would run it as plain v1 and record it as this. Withdrawing
/// `look-v1` doesn't withdraw this (the same weights): withdraw both if the weights are at fault.
const LOOK_V1_SURE: ModelOption = ModelOption {
    slot: Slot::Look,
    id: "look-v1-sure",
    label: "Yama's look model v1, settles when sure",
    note: "v1, and when the closest printing is well ahead of the next it settles that printing by itself, with Wrong printing to change it: on real sleeved photos it settled 45 of 98 alone with none wrong. Otherwise it lists the closest first, as v1 does.",
    licence: LOOK_V1.licence,
    source: LOOK_V1.source,
    recogniser: None,
    default: false,
    base: false,
    needs: Some("settle"),
    settles: true,
};

const TEXT_AUTO: ModelOption = ModelOption {
    slot: Slot::Text,
    id: "auto",
    label: "Automatic",
    note: "Google ML Kit in the Android app, PaddleOCR in a browser, and Tesseract when either can't start. Skips any reader this server has withdrawn.",
    licence: None,
    source: Source::App,
    recogniser: None,
    default: true,
    base: true,
    needs: None,
    settles: false,
};

const TEXT_MLKIT: ModelOption = ModelOption {
    slot: Slot::Text,
    id: "mlkit",
    label: "Google ML Kit",
    note: "On the device, in the Android app only.",
    licence: Some("ML Kit terms"),
    source: Source::App,
    recogniser: None,
    default: false,
    base: false,
    needs: None,
    settles: false,
};

const TEXT_PADDLE: ModelOption = ModelOption {
    slot: Slot::Text,
    id: "paddle",
    label: "PaddleOCR (PP-OCRv5)",
    note: "In the browser, with Tesseract taking over if it fails.",
    licence: Some("Apache-2.0"),
    source: Source::App,
    recogniser: None,
    default: false,
    base: false,
    needs: None,
    settles: false,
};

const TEXT_TESSERACT: ModelOption = ModelOption {
    slot: Slot::Text,
    id: "tesseract",
    label: "Tesseract",
    note: "In the browser: the first reader the scanner had, slower and weaker on small print.",
    licence: Some("Apache-2.0"),
    source: Source::App,
    recogniser: None,
    default: false,
    base: false,
    needs: None,
    settles: false,
};

/// The lead rule (fuse.ts, `leads`; 18 Nov 2026, PR #166).
const LOCK_LEAD: ModelOption = ModelOption {
    slot: Slot::Lock,
    id: "lead",
    label: "Art that leads",
    note: "Settles a card by its art at 0.82, or when it scores 0.65 and leads every other card by 0.10 on two frames in a row; otherwise reads the title.",
    licence: None,
    source: Source::App,
    recogniser: None,
    default: true,
    base: false,
    needs: None,
    settles: false,
};

/// The lead rule, read when the card has come to rest (web/src/scanner/gate.ts; 21 Nov 2026):
/// the placement gate decides when a card is read, the lead rule what the read settles. Opt-in
/// until Scanner diagnostics' timing records support it. A web build from before it doesn't know
/// the id and so doesn't offer it (models.ts, `LOCK_RULES`).
const LOCK_LEAD_GATE: ModelOption = ModelOption {
    slot: Slot::Lock,
    id: "lead-gate",
    label: "Art that leads, read when the card is still",
    note: "Reads a card once it has come to rest, from the sharpest frame, rather than on every frame: at most five tries, then \"No match, move the card\". Settles by the same rules as Art that leads. To try on a phone.",
    licence: None,
    source: Source::App,
    recogniser: None,
    default: false,
    base: false,
    needs: None,
    settles: false,
};

/// The rule before the lead rule: sure scores only.
const LOCK_SURE: ModelOption = ModelOption {
    slot: Slot::Lock,
    id: "sure",
    label: "Sure scores only",
    note: "Settles a card by its art only at 0.82, or at 0.62 on two frames once its title couldn't be read; otherwise reads the title. The rule before 18 Nov 2026.",
    licence: None,
    source: Source::App,
    recogniser: None,
    default: false,
    base: true,
    needs: None,
    settles: false,
};

/// Every option the server knows, by slot. The app is offered those on offer (`offered`).
pub(crate) const MODELS: &[&ModelOption] = &[&BUNDLE_DETECTOR, &CORNERS_MODEL, &BUNDLE_ART, &QUERY_MODEL, &QUERY_CASCADE, &LOOK_OFF, &LOOK_V0, &LOOK_V1, &LOOK_V1_SURE, &TEXT_AUTO, &TEXT_MLKIT, &TEXT_PADDLE, &TEXT_TESSERACT, &LOCK_LEAD, &LOCK_LEAD_GATE, &LOCK_SURE];

impl ModelOption {
    /// Its file in the bundle's folder, if it has one. A file of ours is never `embed.onnx`, which
    /// scan_art.rs embeds new art with.
    pub fn file(&self) -> Option<String> {
        match &self.source {
            Source::App => None,
            Source::Bundle(name) => Some((*name).to_string()),
            Source::File { prefix, sha256, .. } => Some(format!("{prefix}-{}.onnx", &sha256[..12])),
        }
    }

    /// The SHA-256 its file of ours is pinned to (what the look's vectors are kept by, scan_look.rs).
    pub fn sha256(&self) -> Option<&'static str> {
        match self.source {
            Source::File { sha256, .. } => Some(sha256),
            _ => None,
        }
    }

    /// Its file's size, once downloaded (and unzipped).
    fn bytes(&self) -> Option<u64> {
        match &self.source {
            Source::App => None,
            Source::Bundle(name) => FILES.iter().find(|(f, _, _)| f == name).map(|(_, bytes, _)| *bytes),
            Source::File { bytes, .. } => Some(*bytes),
        }
    }

    /// Whether it works with the bundle this manifest describes (its vectors compare with the gallery).
    fn fits(&self, manifest: &serde_json::Value) -> bool {
        let gallery = self.recogniser.is_none_or(|r| manifest.pointer("/recogniser/sha256").and_then(serde_json::Value::as_str) == Some(r));
        // A card finder of ours was trained on the pinned bundle's window: 256 px, its vote scaled
        // for four views.
        let constant = |k: &str| manifest.pointer(&format!("/constants/{k}")).and_then(serde_json::Value::as_u64);
        let window = self.slot != Slot::Detector || !matches!(self.source, Source::File { .. }) || (constant("det_input") == Some(256) && constant("rotations") == Some(4));
        gallery && window
    }

    /// Its file is downloaded and whole in `dir` (a file of ours had its checksum checked before
    /// it got its name), or it has none to wait for.
    async fn is_in(&self, dir: &Path) -> bool {
        match (&self.source, self.file()) {
            (Source::File { bytes, .. }, Some(file)) => tokio::fs::metadata(dir.join(file)).await.is_ok_and(|m| m.is_file() && m.len() == *bytes),
            _ => true,
        }
    }
}

/// What the server's switches take off offer: `YAMA_SCAN_WITHDRAW=look-v0,yama-art-20261118`
/// (option ids), and `YAMA_SCAN_QUERY_MODEL=0` (every art model of ours). A withdrawn option
/// isn't offered or downloaded; an app that chose it runs its slot's default instead, and goes
/// back to it if it's offered again. A slot's base option is never withdrawn.
#[derive(Clone, Debug, Default)]
pub struct Withdrawn {
    ids: Vec<String>,
    art: bool,
}

impl Withdrawn {
    pub fn of(cfg: &crate::config::Config) -> Self {
        Withdrawn { ids: cfg.scan_withdrawn.clone(), art: !cfg.scan_query_model }
    }

    pub(crate) fn has(&self, o: &ModelOption) -> bool {
        !o.base && (self.ids.iter().any(|id| id == o.id) || (self.art && o.slot == Slot::Art))
    }
}

/// The options on offer now, in `MODELS` order: not withdrawn, fitting this bundle, and with
/// their file here. Without a ready bundle (`manifest` None) no option with a file is.
pub(crate) async fn offered(off: &Withdrawn, dir: &Path, manifest: Option<&serde_json::Value>) -> Vec<&'static ModelOption> {
    let mut out = Vec::new();
    for &o in MODELS {
        let ready = match &o.source {
            Source::App => true,
            _ => manifest.is_some_and(|m| o.fits(m)) && o.is_in(dir).await,
        };
        if ready && !off.has(o) {
            out.push(o);
        }
    }
    out
}

/// When a slot's default isn't on offer (still downloading after a deploy, withdrawn because it
/// broke, or needing what an app can't run), the option that stands in for it before the slot's
/// base: the default before it. So `YAMA_SCAN_WITHDRAW=look-v1` puts phones back on v0, not off,
/// and an app that can't feed the cascade its `cuts` runs the same model whole.
const STANDS_IN: &[(&str, &str)] = &[("look-v1", "look-v0"), ("yama-art-20261118-cascade", "yama-art-20261118")];

/// The option a slot runs unless the app chooses another: its default if on offer, else what
/// stands in for it (`STANDS_IN`, in turn), else its base, else the first on offer.
pub(crate) fn default_of(slot: Slot, offered: &[&'static ModelOption]) -> Option<&'static ModelOption> {
    let all: Vec<&'static ModelOption> = offered.iter().copied().filter(|o| o.slot == slot).collect();
    let mut want = MODELS.iter().find(|o| o.slot == slot && o.default).map(|o| o.id);
    for _ in 0..=STANDS_IN.len() {
        let Some(id) = want else { break };
        if let Some(o) = all.iter().find(|o| o.id == id) {
            return Some(o);
        }
        want = STANDS_IN.iter().find(|(from, _)| *from == id).map(|(_, to)| *to);
    }
    all.iter().find(|o| o.base).or(all.first()).copied()
}

pub fn router(data_dir: &Path) -> Router<AppState> {
    // Public like /ocr/: model files, no one's data. The version is in the path, so they never change.
    let files = Router::new()
        .nest_service(&format!("/scan-bundle/{BUNDLE_VERSION}"), ServeDir::new(bundle_dir(data_dir)).precompressed_gzip())
        .layer(axum::middleware::map_response(|mut res: axum::response::Response| async move {
            if res.status().is_success() {
                res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
            }
            res
        }));
    Router::new()
        .route("/api/scan/bundle", get(bundle_info))
        .route("/api/scan/printings", get(printings_by_art))
        .route("/api/scan/sets", get(scan_sets))
        .route("/api/scan/set", get(set_printings))
        .merge(files)
}

pub(crate) fn bundle_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("scan-bundle").join(BUNDLE_VERSION)
}

enum Fetch {
    Idle,
    Running,
    Failed(String, Instant),
}

fn fetch_state() -> &'static Mutex<Fetch> {
    static STATE: OnceLock<Mutex<Fetch>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Fetch::Idle))
}

/// Each model file's download, by option id.
fn model_state() -> &'static Mutex<HashMap<&'static str, Fetch>> {
    static STATE: OnceLock<Mutex<HashMap<&'static str, Fetch>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn is_ready(dir: &Path) -> bool {
    FILES.iter().all(|(name, _, _)| *name == "arts.json" || dir.join(name).exists()) && dir.join(format!("{ARTS}.gz")).exists()
}

/// Download the bundle in the background unless it's here, already downloading, or failed
/// recently. Returns the last failure, if any.
pub async fn ensure(data_dir: PathBuf, http: reqwest::Client) -> Option<String> {
    let dir = bundle_dir(&data_dir);
    if is_ready(&dir) {
        return None;
    }
    let mut state = fetch_state().lock().await;
    match &*state {
        Fetch::Running => return None,
        Fetch::Failed(e, at) if at.elapsed() < RETRY_AFTER => return Some(e.clone()),
        _ => {}
    }
    *state = Fetch::Running;
    tokio::spawn(async move {
        let result = download(&http, &dir).await;
        let mut state = fetch_state().lock().await;
        *state = match result {
            Ok(()) => {
                tracing::info!(version = BUNDLE_VERSION, "scanner bundle ready");
                Fetch::Idle
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "scanner bundle download failed");
                Fetch::Failed(format!("{e:#}"), Instant::now())
            }
        };
    });
    None
}

pub(crate) async fn download(http: &reqwest::Client, dir: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    for (name, bytes, sha) in FILES {
        let path = dir.join(name);
        if path.exists() || (name == "arts.json" && dir.join(format!("{ARTS}.gz")).exists()) {
            continue;
        }
        fetch_checked(http, &format!("{RELEASE_URL}{BUNDLE_VERSION}/{name}"), dir, name, bytes, sha).await?;
    }
    let raw = tokio::fs::read(dir.join("arts.json")).await?;
    let slim = tokio::task::spawn_blocking(move || slim_arts(&raw)).await??;
    let gz = dir.join(format!("{ARTS}.gz"));
    let part = dir.join(format!("{ARTS}.gz.part"));
    tokio::fs::write(&part, gzip(&slim)?).await?;
    // ServeDir serves the .gz to browsers that accept it; the plain file is for anything else.
    tokio::fs::write(dir.join(ARTS), &slim).await?;
    tokio::fs::rename(&part, &gz).await?;
    let _ = tokio::fs::remove_file(dir.join("arts.json")).await;
    if let Some(root) = dir.parent() {
        remove_other_bundles(root).await;
    }
    Ok(())
}

/// Download `url` to `dir/name`, which it gets only once its size and SHA-256 are the pinned ones.
async fn fetch_checked(http: &reqwest::Client, url: &str, dir: &Path, name: &str, bytes: u64, sha: &str) -> anyhow::Result<()> {
    let part = dir.join(format!("{name}.part"));
    let res = http.get(url).timeout(crate::util::DOWNLOAD_TOTAL).send().await?.error_for_status().with_context(|| format!("downloading {url}"))?;
    let mut file = tokio::fs::File::create(&part).await?;
    let mut hash = Sha256::new();
    let mut got = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = crate::util::next_chunk(&mut stream).await? {
        got += chunk.len() as u64;
        if got > bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            anyhow::bail!("{name} is larger than expected");
        }
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let digest = hex::encode(hash.finalize());
    if got != bytes || digest != sha {
        let _ = tokio::fs::remove_file(&part).await;
        anyhow::bail!("{name}: checksum or size mismatch ({got} bytes, sha256 {digest})");
    }
    tokio::fs::rename(&part, dir.join(name)).await?;
    Ok(())
}

/// Download the files of the options that fit this bundle and aren't withdrawn into the bundle's
/// folder in the background, each unless it's there, already downloading or failed recently, or
/// the bundle (its manifest) isn't here yet. A failure only means phones can't choose that option
/// a while longer (the slot's default runs instead); it's logged, and the next call at least
/// `RETRY_AFTER` later tries again (a scanner open, or the server's start).
pub async fn ensure_models(data_dir: PathBuf, http: reqwest::Client, off: Withdrawn) {
    let dir = bundle_dir(&data_dir);
    let Some(manifest) = read_manifest(&dir).await else { return };
    for o in wanted(&off, &manifest) {
        let Source::File { url, bytes, sha256, .. } = o.source else { continue };
        if o.is_in(&dir).await {
            continue;
        }
        let mut states = model_state().lock().await;
        match states.get(o.id) {
            Some(Fetch::Running) => continue,
            Some(Fetch::Failed(_, at)) if at.elapsed() < RETRY_AFTER => continue,
            _ => {}
        }
        states.insert(o.id, Fetch::Running);
        drop(states);
        let (http, dir, file) = (http.clone(), dir.clone(), o.file().unwrap_or_default());
        tokio::spawn(async move {
            let result = download_model(&http, url, bytes, sha256, &file, &dir).await;
            let mut states = model_state().lock().await;
            let state = match result {
                Ok(()) => {
                    tracing::info!(model = o.id, "scanner model ready");
                    Fetch::Idle
                }
                Err(e) => {
                    tracing::warn!(model = o.id, error = %format!("{e:#}"), "scanner model download failed; its slot's default runs meanwhile");
                    Fetch::Failed(format!("{e:#}"), Instant::now())
                }
            };
            states.insert(o.id, state);
        });
    }
}

/// The options whose files `ensure_models` fetches for the bundle this manifest describes: ours,
/// not withdrawn, and fitting its gallery; one per file (`look-v1-sure` runs v1's), so a file is
/// never downloaded twice at once into the same `.part`.
fn wanted(off: &Withdrawn, manifest: &serde_json::Value) -> Vec<&'static ModelOption> {
    let mut files: Vec<String> = Vec::new();
    MODELS
        .iter()
        .copied()
        .filter(|o| matches!(o.source, Source::File { .. }) && !off.has(o) && o.fits(manifest))
        .filter(|o| {
            let file = o.file().unwrap_or_default();
            let first = !files.contains(&file);
            files.push(file);
            first
        })
        .collect()
}

/// Fetch one pinned file into `dir` as `file`, then tidy the folder (`remove_unpinned`).
async fn download_model(http: &reqwest::Client, url: &str, bytes: u64, sha256: &str, file: &str, dir: &Path) -> anyhow::Result<()> {
    fetch_checked(http, url, dir, file, bytes, sha256).await?;
    let mut keep = pinned_files();
    keep.push(file.to_string());
    remove_unpinned(dir, &keep).await;
    Ok(())
}

/// The files of every option of ours in `MODELS`, withdrawn or not (a withdrawal can be lifted).
fn pinned_files() -> Vec<String> {
    MODELS.iter().filter(|o| matches!(o.source, Source::File { .. })).filter_map(|o| o.file()).collect()
}

/// The file name prefixes of the options of ours (`query`, `look`).
fn pinned_prefixes() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = MODELS.iter().filter_map(|o| if let Source::File { prefix, .. } = o.source { Some(prefix) } else { None }).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Delete model files of ours that `MODELS` no longer pins, and unfinished downloads of files it
/// doesn't name, but keep `keep` (every pinned file, and downloads of them under way) and, for each
/// kind (`query-…`, `look-…`), the newest other one: a phone that read the bundle info just before
/// a pin moved may still ask for it (as scan_art.rs keeps the supplement it replaced).
async fn remove_unpinned(dir: &Path, keep: &[String]) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    let prefixes = pinned_prefixes();
    let mut older: Vec<(&'static str, std::time::SystemTime, PathBuf, String)> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(prefix) = prefixes.iter().copied().find(|p| name.starts_with(&format!("{p}-"))) else { continue };
        if keep.iter().any(|k| *k == name || format!("{k}.part") == name) {
            continue;
        }
        if name.ends_with(".onnx") {
            let modified = entry.metadata().await.and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            older.push((prefix, modified, entry.path(), name));
        } else if name.ends_with(".onnx.part") {
            older.push((prefix, std::time::UNIX_EPOCH, entry.path(), name));
        }
    }
    // Newest first; the first complete one of each kind stays.
    older.sort_by(|a, b| b.1.cmp(&a.1));
    let mut kept: Vec<&str> = Vec::new();
    for (prefix, _, path, name) in older {
        if name.ends_with(".onnx") && !kept.contains(&prefix) {
            kept.push(prefix);
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => tracing::info!(file = %name, "removed an older scanner model"),
            Err(e) => tracing::warn!(file = %name, error = %e, "couldn't remove an older scanner model"),
        }
    }
}

pub(crate) async fn read_manifest(dir: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&tokio::fs::read(dir.join("manifest.json")).await.ok()?).ok()
}

/// The art model a phone that doesn't say which it chose runs: the art slot's default on offer to
/// a web build that asks for nothing more (one that doesn't say predates every `needs`).
async fn default_art(cfg: &crate::config::Config, dir: &Path) -> Option<&'static ModelOption> {
    if !is_ready(dir) {
        return None;
    }
    let manifest = read_manifest(dir).await?;
    let plain: Vec<&'static ModelOption> = offered(&Withdrawn::of(cfg), dir, Some(&manifest)).await.into_iter().filter(|o| o.needs.is_none()).collect();
    default_of(Slot::Art, &plain)
}

/// The bundle a kept scan photo or diagnostic is recorded with: the bundle version the phone ran,
/// plus `+<art model>` when it ran one of Yama's query models. `embed` is what the phone's art
/// recognizer says it runs (`ArtRecognizer.embed`: `<bundle version>/<embed file>`), or "none"
/// while it reads text only (recorded with the pinned version):
/// - the bundle's `embed.onnx`: the version alone;
/// - a query model in `MODELS`: `+<its id>`; another pin's (a tab open across a change):
///   `+query-<sha>`, never relabelled as a current one;
/// - anything else, or a version that isn't a plain name: `+unknown`;
/// - not said (a web build from before it was sent): the pinned version, and the art model such a
///   build runs by default (`default_art`) if the server offers one of ours now, the best guess.
pub(crate) async fn recorded_version(cfg: &crate::config::Config, embed: Option<&str>) -> String {
    let model = |file: &str| -> Option<String> {
        if file == "embed.onnx" {
            return Some(String::new());
        }
        if let Some(o) = MODELS.iter().find(|o| o.slot == Slot::Art && matches!(o.source, Source::File { .. }) && o.file().as_deref() == Some(file)) {
            return Some(format!("+{}", o.id));
        }
        let sha = file.strip_prefix("query-")?.strip_suffix(".onnx")?;
        (sha.len() == 12 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| format!("+query-{sha}"))
    };
    match embed {
        Some("none") => BUNDLE_VERSION.to_string(),
        Some(said) => match said.split_once('/') {
            Some((version, file)) if plain_id(version) => format!("{version}{}", model(file).unwrap_or_else(|| "+unknown".into())),
            _ => format!("{BUNDLE_VERSION}+unknown"),
        },
        None => match default_art(cfg, &bundle_dir(&cfg.data_dir)).await {
            Some(o) if matches!(o.source, Source::File { .. }) => format!("{BUNDLE_VERSION}+{}", o.id),
            _ => BUNDLE_VERSION.to_string(),
        },
    }
}

/// A short plain name: letters, digits, `-`, `_` and `.`, starting with a letter or digit.
fn plain_id(v: &str) -> bool {
    (1..=64).contains(&v.len()) && v.starts_with(|c: char| c.is_ascii_alphanumeric()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// The options a phone says it ran, per slot (`{"art": "yama-art-20261118", "look": "off",
/// "text": "auto", "lock": "lead"}`), as kept with a scan photo or diagnostic (JSON text): known
/// slots only, each a plain id. An id the registry doesn't know now is kept as said (a tab open
/// across a change, or an option since removed). Anything else is dropped; None when nothing is left.
pub(crate) fn recorded_models(said: Option<&serde_json::Value>) -> Option<String> {
    let said = said?.as_object()?;
    let kept: serde_json::Map<String, serde_json::Value> = SLOTS
        .iter()
        .filter_map(|slot| {
            let id = said.get(slot.key())?.as_str()?;
            plain_id(id).then(|| (slot.key().to_string(), serde_json::Value::from(id)))
        })
        .collect();
    (!kept.is_empty()).then(|| serde_json::Value::Object(kept).to_string())
}

/// Once this version is ready, drop the folders of earlier pinned bundles (about 45 MB each). They
/// are this module's own downloads; a server rolled back to one fetches it again.
async fn remove_other_bundles(root: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
        if is_dir && entry.file_name() != BUNDLE_VERSION {
            match tokio::fs::remove_dir_all(entry.path()).await {
                Ok(()) => tracing::info!(path = %entry.path().display(), "removed an older scanner bundle"),
                Err(e) => tracing::warn!(path = %entry.path().display(), error = %e, "couldn't remove an older scanner bundle"),
            }
        }
    }
}

#[derive(Deserialize)]
struct ArtRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    set: String,
    #[serde(default)]
    collector_number: Option<String>,
    #[serde(default)]
    illustration_id: Option<String>,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    printing_count: Option<u32>,
}

/// arts.json as columns and rows, in gallery order (the row index is the search graph's index).
fn slim_arts(raw: &[u8]) -> anyhow::Result<Vec<u8>> {
    let rows: Vec<ArtRow> = serde_json::from_slice(raw).context("reading arts.json")?;
    let rows: Vec<_> = rows
        .into_iter()
        .map(|r| (r.id, r.name, r.set, r.collector_number.unwrap_or_default(), r.illustration_id, r.layout.unwrap_or_else(|| "normal".into()), r.printing_count.unwrap_or(1)))
        .collect();
    Ok(serde_json::to_vec(&serde_json::json!({
        "version": BUNDLE_VERSION,
        "columns": ["id", "name", "set", "number", "illustration_id", "layout", "printings"],
        "rows": rows,
    }))?)
}

pub(crate) fn gzip(data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    std::io::Write::write_all(&mut enc, data)?;
    Ok(enc.finish()?)
}

#[derive(Serialize)]
struct BundleInfo {
    version: &'static str,
    /// False while the server is still downloading it (the scanner reads text meanwhile).
    ready: bool,
    error: Option<String>,
    files: BundleFiles,
    /// Size of each file once downloaded (and unzipped), for a progress bar.
    bytes: BundleBytes,
    /// `manifest.constants`, as the recognizer reads them.
    constants: Option<serde_json::Value>,
    /// What each slot can run, by slot key (`art`, `look`, `text`, `lock`): the options on offer
    /// and the default (docs/scanner.md, "Models you can switch"). `files.embed` is the art model a
    /// build that asks for nothing more runs by default, for web builds from before this.
    models: BTreeMap<&'static str, SlotInfo>,
}

#[derive(Serialize)]
struct SlotInfo {
    /// The option the slot runs unless the app chooses another on offer; null when none is.
    default: Option<&'static str>,
    options: Vec<OptionInfo>,
}

#[derive(Serialize)]
struct OptionInfo {
    id: &'static str,
    label: &'static str,
    note: &'static str,
    licence: Option<&'static str>,
    /// Where the app fetches its file (immutable), when it has one.
    file: Option<String>,
    bytes: Option<u64>,
    /// A look option that settles the printing when it's sure (`ModelOption::settles`); left out when not.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    settles: bool,
}

#[derive(Serialize)]
struct BundleBytes {
    detector: u64,
    embed: u64,
    search: u64,
    arts: u64,
    supplement: u64,
}

#[derive(Serialize)]
struct BundleFiles {
    detector: String,
    embed: String,
    search: String,
    arts: String,
    /// Artworks Yama embedded itself that the bundle doesn't know (scan_art.rs), or null.
    supplement: Option<String>,
}

#[derive(Deserialize, Default)]
struct BundleQuery {
    /// What the app can run, comma-separated: `cuts`, an art model's `cuts` input (recognizer.ts);
    /// `settle`, a look option that settles when sure (look.ts, `lookSettles`).
    can: Option<String>,
}

async fn bundle_info(State(st): State<AppState>, _user: CurrentUser, Query(q): Query<BundleQuery>) -> AppResult<Json<BundleInfo>> {
    let dir = bundle_dir(&st.cfg.data_dir);
    let error = if st.cfg.offline {
        (!is_ready(&dir)).then(|| crate::error::offline("the scanner's download site").to_string())
    } else {
        ensure(st.cfg.data_dir.clone(), st.http.clone()).await
    };
    let ready = is_ready(&dir);
    let manifest: Option<serde_json::Value> = if ready {
        Some(serde_json::from_slice(&tokio::fs::read(dir.join("manifest.json")).await.map_err(anyhow::Error::from)?).map_err(anyhow::Error::from)?)
    } else {
        None
    };
    let constants = manifest.as_ref().and_then(|m| m.get("constants").cloned());
    let off = Withdrawn::of(&st.cfg);
    if ready && !st.cfg.offline {
        ensure_models(st.cfg.data_dir.clone(), st.http.clone(), off.clone()).await;
    }
    let url = |f: &str| format!("/scan-bundle/{BUNDLE_VERSION}/{f}");
    let on_offer = offered(&off, &dir, manifest.as_ref()).await;
    // Listed to this app: what it can run (an option that needs more, only when it says it can).
    let can: Vec<&str> = q.can.as_deref().unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    let listed: Vec<&'static ModelOption> = on_offer.iter().copied().filter(|o| o.needs.is_none_or(|n| can.contains(&n))).collect();
    let models = SLOTS
        .iter()
        .map(|&slot| {
            let options = listed
                .iter()
                .filter(|o| o.slot == slot)
                .map(|o| OptionInfo { id: o.id, label: o.label, note: o.note, licence: o.licence, file: o.file().map(|f| url(&f)), bytes: o.bytes(), settles: o.settles })
                .collect();
            (slot.key(), SlotInfo { default: default_of(slot, &listed).map(|o| o.id), options })
        })
        .collect();
    // The art slot's default for a build that asks for nothing more (the cascade's stand-in) as the
    // bundle's embed graph, for web builds that read only this: Yama's query model once it's here,
    // under a different file name, so the phone's cache (keyed by URL) fetches it once and drops the
    // other.
    let plain: Vec<&'static ModelOption> = on_offer.iter().copied().filter(|o| o.needs.is_none()).collect();
    let art = default_of(Slot::Art, &plain).filter(|o| o.file().is_some()).unwrap_or(&BUNDLE_ART);
    let size = |f: &str| FILES.iter().find(|(name, _, _)| *name == f).map_or(0, |(_, bytes, _)| *bytes);
    let arts = if ready { tokio::fs::metadata(dir.join(ARTS)).await.map_or(0, |m| m.len()) } else { 0 };
    let supplement = if ready && st.cfg.scan_supplement { crate::scan_art::current(&st.cfg.data_dir).await } else { None };
    Ok(Json(BundleInfo {
        version: BUNDLE_VERSION,
        ready,
        error,
        files: BundleFiles {
            detector: url("detector.onnx"),
            embed: url(&art.file().unwrap_or_else(|| "embed.onnx".into())),
            search: url("search.onnx"),
            arts: url(ARTS),
            supplement: supplement.as_ref().map(|(name, _)| url(name)),
        },
        bytes: BundleBytes {
            detector: size("detector.onnx"),
            embed: art.bytes().unwrap_or_else(|| size("embed.onnx")),
            search: size("search.onnx"),
            arts,
            supplement: supplement.map_or(0, |(_, bytes)| bytes),
        },
        constants,
        models,
    }))
}

#[derive(Deserialize)]
struct ArtParams {
    /// Scryfall illustration ID of the recognised art.
    art: Option<String>,
    /// Scryfall ID of a printing with that art (a back face may end in `-1`).
    id: Option<String>,
    /// Or a card or face name, when the card was read as text.
    name: Option<String>,
}

#[derive(Serialize)]
struct ArtPrintings {
    /// True when these are exactly the printings with that art. False when they are all the
    /// card's printings (asked by name, or Yama's card data has no illustration IDs for it yet).
    same_art: bool,
    printings: Vec<Printing>,
}

const ORDER: &str = "ORDER BY p.lang = 'en' DESC, p.released_at DESC, p.set_code, p.collector_number";

async fn printings_by_art(State(st): State<AppState>, _user: CurrentUser, Query(p): Query<ArtParams>) -> AppResult<Json<ArtPrintings>> {
    if let Some(art) = p.art.as_deref().filter(|a| !a.is_empty()) {
        let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!(
            "{PRINTING_SELECT} WHERE p.illustration_id = ?1 OR p.back_illustration_id = ?1 {ORDER}"
        )))
        .bind(art)
        .fetch_all(&st.pool)
        .await?;
        if !printings.is_empty() {
            return Ok(Json(ArtPrintings { same_art: true, printings }));
        }
    }
    let (oracle_sql, key) = match (p.id.as_deref(), p.name.as_deref()) {
        (Some(id), _) if !id.is_empty() => ("SELECT oracle_id FROM printings WHERE scryfall_id = ?1", id.strip_suffix("-1").unwrap_or(id)),
        // A card's own name wins over another card's face with the same name (Brainstorm, and the
        // adventure face called Brainstorm). Failing that, every card with that face is offered.
        (_, Some(name)) if !name.trim().is_empty() => (
            "SELECT oracle_id FROM cards WHERE name = ?1 COLLATE NOCASE
             UNION SELECT oracle_id FROM card_names WHERE name = ?1
               AND NOT EXISTS (SELECT 1 FROM cards WHERE name = ?1 COLLATE NOCASE)",
            name.trim(),
        ),
        _ => return Err(AppError::BadRequest("give art and id, or name".into())),
    };
    let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!("{PRINTING_SELECT} WHERE p.oracle_id IN ({oracle_sql}) {ORDER}")))
        .bind(key)
        .fetch_all(&st.pool)
        .await?;
    if printings.is_empty() {
        return Err(AppError::NotFound("card"));
    }
    Ok(Json(ArtPrintings { same_art: false, printings }))
}

#[derive(Serialize, sqlx::FromRow)]
struct ScanSet {
    code: String,
    name: String,
    released_at: Option<String>,
    /// English printings in Yama's card data.
    cards: i64,
}

/// Every set with English printings, newest first, for the set lock's picker.
async fn scan_sets(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<Vec<ScanSet>>> {
    let sets = sqlx::query_as::<_, ScanSet>(
        "SELECT set_code AS code, MAX(set_name) AS name, MAX(released_at) AS released_at, COUNT(*) AS cards
           FROM printings WHERE lang = 'en' GROUP BY set_code ORDER BY MAX(released_at) DESC, set_code",
    )
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(sets))
}

#[derive(Deserialize)]
struct SetParams {
    code: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct SetPrinting {
    #[sqlx(flatten)]
    #[serde(flatten)]
    printing: Printing,
    illustration_id: Option<String>,
    back_illustration_id: Option<String>,
}

#[derive(Serialize)]
struct SetPrintings {
    code: String,
    name: String,
    printings: Vec<SetPrinting>,
}

/// One set's printings with their artworks: what a scan locked to the set may match.
async fn set_printings(State(st): State<AppState>, _user: CurrentUser, Query(p): Query<SetParams>) -> AppResult<Json<SetPrintings>> {
    let code = p.code.trim().to_lowercase();
    let select = PRINTING_SELECT.replacen("p.artist,", "p.artist, p.illustration_id, p.back_illustration_id,", 1);
    let printings = sqlx::query_as::<_, SetPrinting>(AssertSqlSafe(format!("{select} WHERE p.set_code = ? ORDER BY p.lang = 'en' DESC, p.collector_number")))
        .bind(&code)
        .fetch_all(&st.pool)
        .await?;
    let Some(first) = printings.first() else { return Err(AppError::NotFound("set")) };
    let name = first.printing.set_name.clone();
    Ok(Json(SetPrintings { code, name, printings }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    #[tokio::test]
    async fn a_ready_bundle_removes_older_ones_only() {
        let root = tempfile::tempdir().unwrap();
        for dir in [BUNDLE_VERSION, "retrain-20261026T052522727512Z"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
            std::fs::write(root.path().join(dir).join("search.onnx"), b"x").unwrap();
        }
        std::fs::write(root.path().join("note.txt"), b"not a bundle").unwrap();
        remove_other_bundles(root.path()).await;
        assert!(root.path().join(BUNDLE_VERSION).join("search.onnx").exists());
        assert!(!root.path().join("retrain-20261026T052522727512Z").exists());
        assert!(root.path().join("note.txt").exists());
    }

    /// A bundle folder `is_ready` accepts, whose manifest names `recogniser`.
    fn ready_bundle(data_dir: &Path, recogniser: &str) -> PathBuf {
        let dir = bundle_dir(data_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({"version": BUNDLE_VERSION, "recogniser": {"sha256": recogniser}, "constants": {"scene": 640, "det_input": 256, "rotations": 4}});
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        for f in ["detector.onnx", "embed.onnx", "search.onnx", "arts.slim.json.gz"] {
            std::fs::write(dir.join(f), b"bundle").unwrap();
        }
        assert!(is_ready(&dir));
        dir
    }

    const RECOGNISER: &str = RECOGNISER_20261026;

    fn query_file() -> String {
        QUERY_MODEL.file().unwrap()
    }

    fn query_bytes() -> u64 {
        QUERY_MODEL.bytes().unwrap()
    }

    /// An option marked to settle that isn't a look option, or that an app from before the rule would be offered.
    fn o_settles_wrongly(o: &ModelOption) -> bool {
        o.settles && (o.slot != Slot::Look || o.needs != Some("settle") || o.default || o.base)
    }

    #[test]
    fn every_slot_has_one_base_at_most_one_default_and_pinned_files() {
        let mut ids = std::collections::HashSet::new();
        for o in MODELS {
            assert!(plain_id(o.id) && o.id == o.id.to_lowercase(), "{}", o.id);
            // YAMA_SCAN_WITHDRAW names an option by its id alone.
            assert!(ids.insert(o.id), "{} twice", o.id);
            assert!(!o.label.is_empty() && !o.note.is_empty(), "{}", o.id);
            if let Source::File { prefix, url, bytes, sha256 } = o.source {
                assert!(url.starts_with("https://github.com/bryanroscoe/yama/releases/download/"), "{url}");
                assert!(bytes > 0 && sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{}", o.id);
                assert!(prefix.bytes().all(|b| b.is_ascii_lowercase()), "{prefix}");
                assert!(o.licence.is_some(), "{} has no licence", o.id);
                assert_ne!(o.file().as_deref(), Some("embed.onnx"));
            }
            // Only a model of ours can be tied to a gallery.
            assert!(o.recogniser.is_none() || matches!(o.source, Source::File { .. }), "{}", o.id);
            assert!(!o.base || o.recogniser.is_none(), "a base option must always fit: {}", o.id);
            // Some apps can't run it, so it's never a slot's base, and a default only with an
            // option every app can run standing in for it (STANDS_IN, in turn).
            assert!(o.needs.is_none() || !o.base, "{} needs {:?} and is a base", o.id, o.needs);
            if o.default && o.needs.is_some() {
                let mut at = o.id;
                let plain = (0..=STANDS_IN.len()).find_map(|_| {
                    at = STANDS_IN.iter().find(|(from, _)| *from == at)?.1;
                    MODELS.iter().find(|m| m.id == at).filter(|m| m.needs.is_none())
                });
                assert!(plain.is_some_and(|p| p.slot == o.slot), "{} needs {:?} and nothing every app runs stands in for it", o.id, o.needs);
            }
        }
        // Two options share a file only as the same pin (look-v1-sure runs look-v1's), never two
        // pins under one name.
        for a in MODELS {
            for b in MODELS {
                if let (Source::File { url: ua, bytes: ba, sha256: sa, .. }, Source::File { url: ub, bytes: bb, sha256: sb, .. }) = (&a.source, &b.source) {
                    if a.file() == b.file() {
                        assert!(ua == ub && ba == bb && sa == sb && a.slot == b.slot, "{} and {} share a file name but not a pin", a.id, b.id);
                    }
                }
            }
            // Only a look option settles a printing, and only for apps that run the rule.
            assert!(!o_settles_wrongly(a), "{} settles but isn't a look option listed to apps that can", a.id);
        }
        // What stands in for a default is another option of the same slot, and the chain ends.
        for (from, to) in STANDS_IN {
            let (a, b) = (MODELS.iter().find(|o| o.id == *from).unwrap(), MODELS.iter().find(|o| o.id == *to).unwrap());
            assert_eq!(a.slot, b.slot, "{from} → {to}");
            assert!(!b.base && from != to, "{from} → {to}");
        }
        for slot in SLOTS {
            let of: Vec<_> = MODELS.iter().filter(|o| o.slot == slot).collect();
            assert_eq!(of.iter().filter(|o| o.base).count(), 1, "{slot:?} needs exactly one base option");
            assert!(of.iter().filter(|o| o.default).count() <= 1, "{slot:?} has two defaults");
        }
        assert_eq!(query_file(), "query-52420d900728.onnx");
    }

    #[tokio::test]
    async fn the_query_model_is_served_only_when_it_fits_is_allowed_and_is_whole() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), RECOGNISER);
        let mut cfg = testutil::config();
        cfg.data_dir = data.path().to_path_buf();
        let with_query = format!("{BUNDLE_VERSION}+{}", QUERY_MODEL.id);

        // What the server would serve (a client that doesn't say what it loaded).
        // Not downloaded yet, or cut short: the bundle's own.
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        std::fs::write(dir.join(query_file()), b"short").unwrap();
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        std::fs::write(dir.join(query_file()), vec![0u8; query_bytes() as usize]).unwrap();
        assert_eq!(recorded_version(&cfg, None).await, with_query);
        // Switched off, or withdrawn by id.
        cfg.scan_query_model = false;
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        cfg.scan_query_model = true;
        cfg.scan_withdrawn = vec![QUERY_MODEL.id.to_string()];
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        cfg.scan_withdrawn = vec!["look-v0".into(), "bundle".into()];
        assert_eq!(recorded_version(&cfg, None).await, with_query);
        cfg.scan_withdrawn = vec![];
        // A bundle from another recogniser checkpoint: its own embed graph.
        ready_bundle(data.path(), "0000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        ready_bundle(data.path(), RECOGNISER);
        assert_eq!(recorded_version(&cfg, None).await, with_query);
        // What the phone says it ran wins over what the server serves now.
        let said = |file: &str| format!("{BUNDLE_VERSION}/{file}");
        assert_eq!(recorded_version(&cfg, Some(said("embed.onnx").as_str())).await, BUNDLE_VERSION);
        assert_eq!(recorded_version(&cfg, Some("none")).await, BUNDLE_VERSION);
        cfg.scan_query_model = false;
        assert_eq!(recorded_version(&cfg, Some(said(&query_file()).as_str())).await, with_query);
        cfg.scan_query_model = true;
        // Another pin's model keeps its own name, and a tab open across a bundle change its own
        // bundle; anything else is unknown, never a guess.
        assert_eq!(recorded_version(&cfg, Some(said("query-0123456789ab.onnx").as_str())).await, format!("{BUNDLE_VERSION}+query-0123456789ab"));
        assert_eq!(recorded_version(&cfg, Some("gallery-20261018T0Z/query-52420d900728.onnx")).await, "gallery-20261018T0Z+yama-art-20261118");
        assert_eq!(recorded_version(&cfg, Some("gallery-20261018T0Z/embed.onnx")).await, "gallery-20261018T0Z");
        for odd in [said("query-../x.onnx"), said("query-0123456789AB.onnx"), said("something.onnx"), said("")] {
            assert_eq!(recorded_version(&cfg, Some(odd.as_str())).await, format!("{BUNDLE_VERSION}+unknown"), "{odd}");
        }
        for odd in ["embed.onnx", "", "../../etc/embed.onnx", "a b/embed.onnx"] {
            assert_eq!(recorded_version(&cfg, Some(odd)).await, format!("{BUNDLE_VERSION}+unknown"), "{odd}");
        }
        // A bundle that isn't ready yet.
        std::fs::remove_file(dir.join("search.onnx")).unwrap();
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
    }

    /// Each slot's option ids, in order, and its default.
    fn slot(info: &serde_json::Value, key: &str) -> (Vec<String>, serde_json::Value) {
        let ids = info["models"][key]["options"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_string()).collect();
        (ids, info["models"][key]["default"].clone())
    }

    #[tokio::test]
    async fn bundle_info_names_the_query_model_or_else_the_bundles_embed() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), RECOGNISER);
        let pool = crate::db::test_pool().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        // Offline, so a missing query model is never fetched from GitHub here.
        let app_with = |on: bool, withdrawn: &[&str]| {
            let pool = pool.clone();
            let mut cfg = testutil::config();
            cfg.data_dir = data.path().to_path_buf();
            cfg.offline = true;
            cfg.scan_query_model = on;
            cfg.scan_withdrawn = withdrawn.iter().map(|s| s.to_string()).collect();
            async move { crate::routes::app(testutil::state_with(cfg, pool).await) }
        };
        let bundle_embed = format!("/scan-bundle/{BUNDLE_VERSION}/embed.onnx");
        let query_embed = format!("/scan-bundle/{BUNDLE_VERSION}/{}", query_file());
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // Not downloaded: the bundle's embed graph, as before, and the only art option.
        let app = app_with(true, &[]).await;
        let (status, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(info["ready"], true);
        assert_eq!(info["error"], serde_json::Value::Null);
        assert_eq!(info["files"]["embed"], bundle_embed.as_str());
        assert_eq!(info["bytes"]["embed"], 5_118_408);
        assert_eq!(slot(&info, "art"), (ids(&["bundle"]), "bundle".into()));
        assert_eq!(info["models"]["art"]["options"][0]["file"], bundle_embed.as_str());
        assert_eq!(info["models"]["art"]["options"][0]["licence"], "MPL-2.0");
        // The slots that need nothing downloaded are there whatever the bundle; the look model
        // isn't downloaded yet, so its slot is off.
        assert_eq!(slot(&info, "look"), (ids(&["off"]), "off".into()));
        assert_eq!(slot(&info, "text"), (ids(&["auto", "mlkit", "paddle", "tesseract"]), "auto".into()));
        assert_eq!(slot(&info, "lock"), (ids(&["lead", "lead-gate", "sure"]), "lead".into()));
        assert_eq!(info["models"]["lock"]["options"][0]["file"], serde_json::Value::Null);

        // Downloaded: the query model, served from the bundle's folder like its files, and the default.
        let model: Vec<u8> = (0..query_bytes()).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join(query_file()), &model).unwrap();
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["files"]["embed"], query_embed.as_str());
        assert_eq!(info["bytes"]["embed"], query_bytes());
        assert_eq!(slot(&info, "art"), (ids(&["bundle", QUERY_MODEL.id]), QUERY_MODEL.id.into()));
        let art = &info["models"]["art"]["options"][1];
        assert_eq!(art["file"], query_embed.as_str());
        assert_eq!(art["bytes"], query_bytes());
        assert_eq!(art["label"], QUERY_MODEL.label);
        assert_eq!(info["files"]["detector"], format!("/scan-bundle/{BUNDLE_VERSION}/detector.onnx").as_str());
        assert_eq!(info["files"]["search"], format!("/scan-bundle/{BUNDLE_VERSION}/search.onnx").as_str());
        assert_eq!(info["constants"]["scene"], 640);
        let res = tower::ServiceExt::oneshot(app.clone(), axum::http::Request::get(&query_embed).body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.len() as u64, query_bytes());
        assert!(body == model);
        // The bundle's own stays where scan_art.rs reads it.
        assert_eq!(std::fs::read(dir.join("embed.onnx")).unwrap(), b"bundle");

        // A look model once it's here: offered. Until v1, the default, is here too (it downloads
        // after a deploy), v0 stands in for it.
        let v0 = LOOK_V0.file().unwrap();
        std::fs::write(dir.join(&v0), vec![1u8; LOOK_V0.bytes().unwrap() as usize]).unwrap();
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0"]), "look-v0".into()));
        assert_eq!(info["models"]["look"]["options"][1]["file"], format!("/scan-bundle/{BUNDLE_VERSION}/look-58acfa166105.onnx").as_str());
        assert_eq!(info["models"]["look"]["options"][1]["bytes"], 9_292_149);
        let v1 = LOOK_V1.file().unwrap();
        assert_eq!(v1, "look-152f52c100f0.onnx");
        std::fs::write(dir.join(&v1), vec![2u8; LOOK_V1.bytes().unwrap() as usize]).unwrap();
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1"]), "look-v1".into()));
        // It doesn't replace the art model's file.
        assert_eq!(info["files"]["embed"], query_embed.as_str());

        // Switched off, or withdrawn: the bundle's, and no other art option.
        for off in [app_with(false, &[]).await, app_with(true, &[QUERY_MODEL.id]).await] {
            let (_, info) = testutil::send(&off, Method::GET, "/api/scan/bundle", Some(&token), None).await;
            assert_eq!(info["files"]["embed"], bundle_embed.as_str());
            assert_eq!(info["bytes"]["embed"], 5_118_408);
            assert_eq!(slot(&info, "art"), (ids(&["bundle"]), "bundle".into()));
        }

        // Withdrawing a default drops the slot to its base; a base option can't be withdrawn.
        let some = app_with(true, &["lead", "paddle", "sure", "bundle", "auto", "off", "nothing-like-it"]).await;
        let (_, info) = testutil::send(&some, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        // (The gate's option is its own id: withdrawing "lead" leaves it on offer, never as the default.)
        assert_eq!(slot(&info, "lock"), (ids(&["lead-gate", "sure"]), "sure".into()));
        assert_eq!(slot(&info, "text"), (ids(&["auto", "mlkit", "tesseract"]), "auto".into()));
        assert_eq!(slot(&info, "art"), (ids(&["bundle", QUERY_MODEL.id]), QUERY_MODEL.id.into()));
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1"]), "look-v1".into()));
        // Withdrawing v1 (it broke) puts everyone on the default back on v0; both, the look off.
        let no_v1 = app_with(true, &["look-v1"]).await;
        let (_, info) = testutil::send(&no_v1, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0"]), "look-v0".into()));
        let no_look = app_with(true, &["look-v0", "look-v1"]).await;
        let (_, info) = testutil::send(&no_look, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off"]), "off".into()));

        // A bundle from another recogniser: the bundle's, though the file is here.
        ready_bundle(data.path(), "eb6558461672b30c8b699570cc1669c4baa1a31d5fd28d617800e8a1f4d2e2c4");
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["files"]["embed"], bundle_embed.as_str());
        assert_eq!(slot(&info, "art"), (ids(&["bundle"]), "bundle".into()));

        // No bundle yet: nothing for the art slot, the rest as ever.
        std::fs::remove_file(dir.join("search.onnx")).unwrap();
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["ready"], false);
        assert_eq!(slot(&info, "art"), (vec![], serde_json::Value::Null));
        assert_eq!(slot(&info, "text").1, "auto");
    }

    #[tokio::test]
    async fn the_card_finder_and_the_cascade_are_the_defaults_once_here_and_an_older_app_keeps_what_it_can_run() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), RECOGNISER);
        let pool = crate::db::test_pool().await;
        let (_, token) = testutil::user(&pool, "finder@example.com").await;
        let mut cfg = testutil::config();
        cfg.data_dir = data.path().to_path_buf();
        cfg.offline = true;
        let app = crate::routes::app(testutil::state_with(cfg, pool).await);
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let file = |o: &ModelOption| format!("/scan-bundle/{BUNDLE_VERSION}/{}", o.file().unwrap());

        // Nothing of ours downloaded: the bundle's card finder, served as its detector.onnx.
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "detector"), (ids(&["bundle-detector"]), "bundle-detector".into()));
        assert_eq!(info["models"]["detector"]["options"][0]["file"], file(&BUNDLE_DETECTOR).as_str());
        assert_eq!(info["files"]["detector"], file(&BUNDLE_DETECTOR).as_str());

        // Downloaded: Yama's card finder is the default (the bundle's still served as files.detector,
        // for web builds that read only that). The cascade is listed, and the art default, only to an
        // app that says it can feed `cuts`: one from before can't run it, so it gets the same model
        // whole (STANDS_IN), which also stays files.embed.
        for o in [&CORNERS_MODEL, &QUERY_MODEL, &QUERY_CASCADE] {
            std::fs::write(dir.join(o.file().unwrap()), vec![0u8; o.bytes().unwrap() as usize]).unwrap();
        }
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(slot(&info, "detector"), (ids(&["bundle-detector", "yama-corners-20261120"]), "yama-corners-20261120".into()));
        assert_eq!(info["models"]["detector"]["options"][1]["file"], file(&CORNERS_MODEL).as_str());
        assert_eq!(slot(&info, "art"), (ids(&["bundle", "yama-art-20261118"]), "yama-art-20261118".into()));
        assert_eq!(info["files"]["embed"], file(&QUERY_MODEL).as_str());
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle?can=cuts", Some(&token), None).await;
        assert_eq!(slot(&info, "art"), (ids(&["bundle", "yama-art-20261118", "yama-art-20261118-cascade"]), "yama-art-20261118-cascade".into()));
        assert_eq!(info["files"]["embed"], file(&QUERY_MODEL).as_str());
        assert_eq!(info["files"]["detector"], file(&BUNDLE_DETECTOR).as_str());
        // A phone that doesn't say which art model it ran predates `cuts`: recorded with the whole model.
        let mut cfg = testutil::config();
        cfg.data_dir = data.path().to_path_buf();
        cfg.offline = true;
        assert_eq!(recorded_version(&cfg, None).await, format!("{BUNDLE_VERSION}+yama-art-20261118"));
        // Withdrawn, Yama's card finder gives way to the bundle's, and the cascade to the whole model.
        cfg.scan_withdrawn = vec!["yama-corners-20261120".into(), "yama-art-20261118-cascade".into()];
        let pool2 = crate::db::test_pool().await;
        let (_, token2) = testutil::user(&pool2, "finder2@example.com").await;
        let app2 = crate::routes::app(testutil::state_with(cfg, pool2).await);
        let (_, info) = testutil::send(&app2, Method::GET, "/api/scan/bundle?can=cuts", Some(&token2), None).await;
        assert_eq!(slot(&info, "detector"), (ids(&["bundle-detector"]), "bundle-detector".into()));
        assert_eq!(slot(&info, "art"), (ids(&["bundle", "yama-art-20261118"]), "yama-art-20261118".into()));
        assert_eq!(CORNERS_MODEL.file().unwrap(), "corners-18f9d6aab2a4.onnx");
        assert_eq!(QUERY_CASCADE.file().unwrap(), "query-103b3d9af498.onnx");
        // A bundle whose detector reads another window gets none of ours.
        let other = serde_json::json!({"recogniser": {"sha256": RECOGNISER}, "constants": {"det_input": 320, "rotations": 4}});
        assert!(!CORNERS_MODEL.fits(&other) && BUNDLE_DETECTOR.fits(&other));
        assert!(CORNERS_MODEL.fits(&serde_json::json!({"constants": {"det_input": 256, "rotations": 4}})));
    }

    #[tokio::test]
    async fn the_look_that_settles_when_sure_shares_v1s_file_and_is_an_option_never_the_default() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), RECOGNISER);
        let pool = crate::db::test_pool().await;
        let (_, token) = testutil::user(&pool, "sure@example.com").await;
        let app_with = |withdrawn: &[&str]| {
            let pool = pool.clone();
            let mut cfg = testutil::config();
            cfg.data_dir = data.path().to_path_buf();
            cfg.offline = true;
            cfg.scan_withdrawn = withdrawn.iter().map(|s| s.to_string()).collect();
            async move { crate::routes::app(testutil::state_with(cfg, pool).await) }
        };
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // v1's own file: nothing more to download, and the app's embedding cache is the same.
        assert_eq!(LOOK_V1_SURE.file(), LOOK_V1.file());
        assert_eq!(LOOK_V1_SURE.bytes(), LOOK_V1.bytes());
        assert!(LOOK_V1_SURE.settles && !LOOK_V1.settles && !LOOK_V1_SURE.default && !LOOK_V1_SURE.base);
        let app = app_with(&[]).await;
        // Not downloaded yet: not on offer, like v1.
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle?can=cuts,settle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off"]), "off".into()));
        for o in [&LOOK_V0, &LOOK_V1] {
            std::fs::write(dir.join(o.file().unwrap()), vec![3u8; o.bytes().unwrap() as usize]).unwrap();
        }
        // An app from before the rule isn't offered it (it would run it as plain v1).
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle?can=cuts", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1"]), "look-v1".into()));
        assert!(info["models"]["look"]["options"].as_array().unwrap().iter().all(|o| o.get("settles").is_none()));
        // One that runs it: listed after v1, with v1's file, marked to settle; v1 stays the default.
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle?can=cuts,settle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1", "look-v1-sure"]), "look-v1".into()));
        let sure = &info["models"]["look"]["options"][3];
        assert_eq!(sure["file"], info["models"]["look"]["options"][2]["file"]);
        assert_eq!(sure["file"], format!("/scan-bundle/{BUNDLE_VERSION}/look-152f52c100f0.onnx").as_str());
        assert_eq!(sure["bytes"], 9_292_149);
        assert_eq!(sure["settles"], true);
        assert_eq!(sure["label"], "Yama's look model v1, settles when sure");
        assert!(sure["note"].as_str().unwrap().contains("45 of 98"));
        assert!(info["models"]["look"]["options"][2].get("settles").is_none());
        // Withdrawn like any option, by its id alone: v1 stays.
        let no_sure = app_with(&["look-v1-sure"]).await;
        let (_, info) = testutil::send(&no_sure, Method::GET, "/api/scan/bundle?can=settle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1"]), "look-v1".into()));
        // Withdrawing v1 alone leaves it (the default falls back to v0); both, and only v0 is left.
        let no_v1 = app_with(&["look-v1"]).await;
        let (_, info) = testutil::send(&no_v1, Method::GET, "/api/scan/bundle?can=settle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0", "look-v1-sure"]), "look-v0".into()));
        let neither = app_with(&["look-v1", "look-v1-sure"]).await;
        let (_, info) = testutil::send(&neither, Method::GET, "/api/scan/bundle?can=settle", Some(&token), None).await;
        assert_eq!(slot(&info, "look"), (ids(&["off", "look-v0"]), "look-v0".into()));
        // Recorded by its own id.
        let kept = recorded_models(Some(&serde_json::json!({"look": "look-v1-sure"}))).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&kept).unwrap(), serde_json::json!({"look": "look-v1-sure"}));
    }

    #[tokio::test]
    async fn a_phone_that_ran_the_cascade_is_recorded_with_it() {
        let said = |file: &str| format!("{BUNDLE_VERSION}/{file}");
        let cfg = testutil::config();
        assert_eq!(recorded_version(&cfg, Some(&said("query-103b3d9af498.onnx"))).await, format!("{BUNDLE_VERSION}+yama-art-20261118-cascade"));
        let kept = recorded_models(Some(&serde_json::json!({"detector": "yama-corners-20261120", "art": "yama-art-20261118-cascade", "zzz": "x"}))).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&kept).unwrap(), serde_json::json!({"detector": "yama-corners-20261120", "art": "yama-art-20261118-cascade"}));
    }

    #[test]
    fn only_files_of_ours_that_fit_and_arent_withdrawn_are_downloaded() {
        // As the pinned bundle's manifest: its recogniser and detector constants.
        let fits = serde_json::json!({"recogniser": {"sha256": RECOGNISER}, "constants": {"det_input": 256, "rotations": 4}});
        let other = serde_json::json!({"recogniser": {"sha256": "0".repeat(64)}, "constants": {"det_input": 256, "rotations": 4}});
        let ids = |v: Vec<&'static ModelOption>| v.iter().map(|o| o.id).collect::<Vec<_>>();
        // One option per file: look-v1-sure runs look-v1's, downloaded once.
        let all: Vec<&str> = MODELS.iter().filter(|o| matches!(o.source, Source::File { .. }) && o.id != LOOK_V1_SURE.id).map(|o| o.id).collect();
        assert!(all.contains(&QUERY_MODEL.id) && all.contains(&LOOK_V1.id));
        assert_eq!(ids(wanted(&Withdrawn::default(), &fits)), all);
        // With v1 withdrawn, the option that settles still has its file fetched (by its own id).
        let mut v1_off = testutil::config();
        v1_off.scan_withdrawn = vec![LOOK_V1.id.into()];
        let got = ids(wanted(&Withdrawn::of(&v1_off), &fits));
        assert!(got.contains(&LOOK_V1_SURE.id) && !got.contains(&LOOK_V1.id), "{got:?}");
        // A bundle from another checkpoint: no art model of ours (anything else of ours still).
        assert!(!ids(wanted(&Withdrawn::default(), &other)).contains(&QUERY_MODEL.id));
        let mut cfg = testutil::config();
        cfg.scan_withdrawn = vec![QUERY_MODEL.id.into()];
        assert!(!ids(wanted(&Withdrawn::of(&cfg), &fits)).contains(&QUERY_MODEL.id));
        cfg.scan_withdrawn = vec![];
        cfg.scan_query_model = false;
        assert!(!ids(wanted(&Withdrawn::of(&cfg), &fits)).contains(&QUERY_MODEL.id));
    }

    #[test]
    fn the_models_a_phone_ran_are_kept_by_slot() {
        let kept = |v: serde_json::Value| recorded_models(Some(&v)).map(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap());
        assert_eq!(
            kept(serde_json::json!({"art": "yama-art-20261118", "look": "off", "text": "paddle", "lock": "sure"})),
            Some(serde_json::json!({"art": "yama-art-20261118", "look": "off", "text": "paddle", "lock": "sure"}))
        );
        // An option the registry doesn't know (a tab open across a change) is kept as said;
        // other slots, odd ids and other types are dropped.
        assert_eq!(
            kept(serde_json::json!({"art": "yama-art-20990101", "look": "../x", "text": 3, "colour": "blue"})),
            Some(serde_json::json!({"art": "yama-art-20990101"}))
        );
        assert_eq!(kept(serde_json::json!({"art": ""})), None);
        assert_eq!(kept(serde_json::json!("art")), None);
        assert_eq!(recorded_models(None), None);
    }

    #[tokio::test]
    async fn a_model_download_is_checked_and_keeps_only_the_pin_before() {
        let served = axum::Router::new()
            .route("/good", get(|| async { "model" }))
            .route("/bad", get(|| async { "modem" }))
            .route("/long", get(|| async { "model and more" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
        let sha = hex::encode(Sha256::digest(b"model"));
        let file = format!("query-{}.onnx", &sha[..12]);
        let dir = tempfile::tempdir().unwrap();
        let http = crate::routes::http_client();
        std::fs::write(dir.path().join("embed.onnx"), b"bundle").unwrap();
        let day = std::time::Duration::from_secs(24 * 3600);
        // The pin just before is the newest file, though not the last name, so only time order keeps it.
        for (name, age) in [("query-aaaaaaaaaaaa.onnx", 2), ("query-000000000000.onnx", 1)] {
            let f = std::fs::File::create(dir.path().join(name)).unwrap();
            std::io::Write::write_all(&mut &f, b"older pin").unwrap();
            f.set_modified(std::time::SystemTime::now() - day * age).unwrap();
        }
        std::fs::write(dir.path().join("query-111111111111.onnx.part"), b"older, unfinished").unwrap();
        // Another pinned option's download under way, and a pinned file whatever its age.
        std::fs::write(dir.path().join(format!("{}.part", query_file())), b"downloading").unwrap();
        std::fs::write(dir.path().join("supplement-abc.json"), b"{}").unwrap();
        // Another kind of model keeps its own pin before, whatever the query models do; and both
        // look pins stay, with a download of one under way.
        let f = std::fs::File::create(dir.path().join("look-000000000000.onnx")).unwrap();
        f.set_modified(std::time::SystemTime::now() - day * 3).unwrap();
        let (v0, v1) = (LOOK_V0.file().unwrap(), LOOK_V1.file().unwrap());
        for name in [v0.clone(), format!("{v1}.part")] {
            let f = std::fs::File::create(dir.path().join(&name)).unwrap();
            f.set_modified(std::time::SystemTime::now() - day * 5).unwrap();
        }

        // Wrong bytes or too many: nothing named, nothing left over, older pins untouched.
        for path in ["/bad", "/long"] {
            let err = download_model(&http, &format!("{base}{path}"), 5, &sha, &file, dir.path()).await.unwrap_err();
            assert!(format!("{err:#}").contains(&file), "{err:#}");
            assert!(!dir.path().join(&file).exists());
            assert!(!dir.path().join(format!("{file}.part")).exists());
            assert!(dir.path().join("query-000000000000.onnx").exists());
        }

        download_model(&http, &format!("{base}/good"), 5, &sha, &file, dir.path()).await.unwrap();
        assert_eq!(std::fs::read(dir.path().join(&file)).unwrap(), b"model");
        // The pin just before stays for phones that still name it; older ones and leftovers go.
        assert!(dir.path().join("query-000000000000.onnx").exists());
        assert!(!dir.path().join("query-aaaaaaaaaaaa.onnx").exists());
        assert!(!dir.path().join("query-111111111111.onnx.part").exists());
        assert!(dir.path().join(format!("{}.part", query_file())).exists(), "a pinned option's download under way stays");
        assert_eq!(std::fs::read(dir.path().join("embed.onnx")).unwrap(), b"bundle");
        assert!(dir.path().join("supplement-abc.json").exists());
        assert!(dir.path().join("look-000000000000.onnx").exists());
        assert!(dir.path().join(&v0).exists() && dir.path().join(format!("{v1}.part")).exists());
        server.abort();
    }

    #[tokio::test]
    async fn printings_that_share_the_art_or_else_the_whole_card() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('o', 'Sol Ring', 'normal', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('sol ring', 'o')").execute(&pool).await.unwrap();
        for (id, set, art, released) in [("p1", "ecc", Some("i1"), "2026-01-01"), ("p2", "c21", Some("i1"), "2021-04-23"), ("p3", "lea", Some("i0"), "1993-08-05"), ("p4", "cmm", None, "2023-08-04")] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, released_at, illustration_id, updated_at) VALUES (?, 'o', 'Sol Ring', ?, 'Set', '1', 'en', ?, ?, '2026-10-28')")
                .bind(id).bind(set).bind(released).bind(art).execute(&pool).await.unwrap();
        }
        let ids = |v: &serde_json::Value| v["printings"].as_array().unwrap().iter().map(|p| p["scryfall_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();

        let (status, body) = testutil::send(&app, Method::GET, "/api/scan/printings?art=i1&id=p1", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["same_art"], true);
        assert_eq!(ids(&body), ["p1", "p2"]);

        // An art Yama has no illustration IDs for yet: every printing of the card, newest first.
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?art=unknown&id=p1-1", Some(&token), None).await;
        assert_eq!(body["same_art"], false);
        assert_eq!(ids(&body), ["p1", "p4", "p2", "p3"]);

        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Sol%20Ring", Some(&token), None).await;
        assert_eq!(ids(&body).len(), 4);

        // A standalone card and another card's face share the name: the standalone card's printings only.
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('adv', 'Big Score // Sol Ring', 'adventure', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('sol ring', 'adv')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('a1', 'adv', 'Big Score // Sol Ring', 'woe', 'Set', '9', 'en', '2026-10-28')")
            .execute(&pool).await.unwrap();
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=sol%20ring", Some(&token), None).await;
        assert_eq!(ids(&body).len(), 4);
        // A face name alone offers its card.
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('big score', 'adv')").execute(&pool).await.unwrap();
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Big%20Score", Some(&token), None).await;
        assert_eq!(ids(&body), ["a1"]);

        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Nothing", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?art=i1&id=p1", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sets_and_one_sets_printings_with_their_art() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('o', 'Sol Ring', 'normal', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        for (id, set, name, num, lang, art, released) in [
            ("p1", "ecc", "Edge of Eternities Commander", "57", "en", Some("i1"), "2025-08-01"),
            ("p1j", "ecc", "Edge of Eternities Commander", "57", "ja", Some("i1"), "2025-08-01"),
            ("p2", "c21", "Commander 2021", "263", "en", Some("i2"), "2021-04-23"),
        ] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, released_at, illustration_id, updated_at) VALUES (?, 'o', 'Sol Ring', ?, ?, ?, ?, ?, ?, '2026-10-28')")
                .bind(id).bind(set).bind(name).bind(num).bind(lang).bind(released).bind(art).execute(&pool).await.unwrap();
        }
        let (status, sets) = testutil::send(&app, Method::GET, "/api/scan/sets", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sets[0]["code"], "ecc");
        assert_eq!(sets[0]["name"], "Edge of Eternities Commander");
        assert_eq!(sets[0]["cards"], 1);
        assert_eq!(sets[1]["code"], "c21");

        let (status, set) = testutil::send(&app, Method::GET, "/api/scan/set?code=ECC", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(set["name"], "Edge of Eternities Commander");
        let printings = set["printings"].as_array().unwrap();
        assert_eq!(printings.len(), 2);
        assert_eq!(printings[0]["scryfall_id"], "p1");
        assert_eq!(printings[0]["illustration_id"], "i1");
        assert_eq!(printings[0]["set_code"], "ecc");

        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/set?code=zzz", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/sets", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn slim_arts_keeps_gallery_order_and_fields() {
        let raw = br#"[{"id":"a","name":"Sol Ring","set":"ecc","collector_number":"57","illustration_id":"i1","layout":"normal","printing_count":3,"url":"x","frame":"modern"},
                       {"id":"b-1","name":"Back","set":"mid","illustration_id":null}]"#;
        let v: serde_json::Value = serde_json::from_slice(&slim_arts(raw).unwrap()).unwrap();
        assert_eq!(v["rows"][0], serde_json::json!(["a", "Sol Ring", "ecc", "57", "i1", "normal", 3]));
        assert_eq!(v["rows"][1], serde_json::json!(["b-1", "Back", "mid", "", null, "normal", 1]));
    }
}
