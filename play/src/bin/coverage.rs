//! Card coverage: what the phase engine knows about every card in Bryan's decks and in the
//! Commander precon catalog, and the card fixture the per-card tests play on.
//!
//! For each card name it records Yama's own verdict ([`yama_play::CardSupport`], the one the deck
//! pages and the lab show) and the reasons behind it, face by face:
//!
//! - the gaps phase's coverage dashboard finds (`analyze_coverage`: unimplemented effects,
//!   triggers and statics the registries don't know, resolver features with no runtime, text
//!   the parser dropped, parse warnings), each with the Oracle text it came from;
//! - which of those make the card "partly unimplemented" (`card_face_has_unimplemented_parts`).
//!
//! It reads, from a commander-decks checkout (read only):
//!
//! - `decks/compare/*.txt`: Bryan's stock, now and after lists for each deck;
//! - `data/shopping/candidates.json`: cards proposed for his decks;
//! - `data/sim/decks/precons/multiverse-reforged.txt`: the Multiverse Reforged precon;
//! - `data/sim/decks/index.json` and the deck files it names: the precon catalog.
//!
//! It writes:
//!
//! - `<out>.json` and `<out>.md` (default `docs/card-coverage`);
//! - with `--fixture PATH`, the slice of phase's card data the per-card tests load: every face
//!   of Bryan's cards and of the few extra cards the test boards use ([`HELPERS`]), without
//!   printings, legalities, rulings and metadata, one card per line;
//! - with `--smoke PATH`, the list of smoke tests (play/src/card_tests/smoke_cards.rs), one per
//!   card in Bryan's decks. An `#[ignore = "..."]` already on a card's line is kept.
//!
//! Usage (from the repository root):
//!
//!   cargo run -p yama-play --bin coverage -- <card-data.json> <commander-decks dir> \
//!       [--out docs/card-coverage] [--fixture play/tests/fixtures/deck-cards.json] \
//!       [--smoke play/src/card_tests/smoke_cards.rs]
//!
//! The JSON is the machine-readable copy; the Markdown has the summary and Bryan's cards in full.
//! The "Engine bugs found" section of the Markdown is kept by hand: the tool copies it over from
//! the file it replaces.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use engine::database::CardDatabase;
use engine::game::coverage::{CardCoverageResult, analyze_coverage, card_face_gaps, card_face_has_unimplemented_parts};
use engine::types::card::CardFace;
use serde::Serialize;
use serde_json::Value;
use yama_play::{CardSupport, Engine};

#[path = "../card_tests/plain.rs"]
#[allow(dead_code)]
mod plain;

/// Cards the per-card test boards use besides Bryan's own: basic lands for mana, a vanilla
/// creature on each side, a plain artifact and enchantment to aim at, cards in graveyards and
/// libraries, and vanilla legends (Jedit Ojanen is the boards' usual commander).
pub const HELPERS: &[&str] = &[
    "Plains",
    "Island",
    "Swamp",
    "Mountain",
    "Forest",
    "Wastes",
    "Grizzly Bears",
    "Savannah Lions",
    "Serra Angel",
    "Isamaru, Hound of Konda",
    "Jedit Ojanen",
    "Spellbook",
    "Ghostly Prison",
    "Lightning Bolt",
    "Divination",
    "Jace Beleren",
    "Elite Vanguard",
    "Elvish Visionary",
    "Hill Giant",
    "Craw Wurm",
    "Memnite",
    "Opt",
];

/// The order the decks are listed in, by their file name in decks/compare/.
const DECK_ORDER: &[&str] = &[
    "fantastic-four",
    "riders-of-rohan",
    "lorehold-spirit",
    "prismari-artistry",
    "revival-trance",
    "world-shaper",
    "tricky-terrain",
    "multiverse-reforged",
];

/// One card list line: a name and whether it's the deck's commander.
struct Line {
    name: String,
    commander: bool,
}

/// A deck list file: "Commander" and "Deck" headings, then "N Name" lines.
fn read_list(path: &Path) -> anyhow::Result<Vec<Line>> {
    let text = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
    let mut commander = false;
    let mut out = vec![];
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match line {
            "Commander" => commander = true,
            "Deck" | "Sideboard" => commander = false,
            _ => {
                let Some((qty, name)) = line.split_once(' ') else { continue };
                if qty.parse::<u32>().is_ok() {
                    out.push(Line { name: name.trim().to_string(), commander });
                }
            }
        }
    }
    Ok(out)
}

/// "riders-of-rohan" reads "Riders of Rohan".
fn deck_title(slug: &str) -> String {
    slug.split('-')
        .enumerate()
        .map(|(i, w)| {
            if i > 0 && matches!(w, "of" | "the" | "and" | "a") {
                w.to_string()
            } else {
                let mut c = w.chars();
                c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Lists in the order a deck goes through them: stock first, candidates last.
fn list_rank(list: &str) -> usize {
    ["stock", "precon", "now", "after-local-buys", "after-prints", "proposed-bracket-3", "candidate"].iter().position(|l| *l == list).unwrap_or(7)
}

/// A card's lists in a deck, in [`list_rank`] order.
fn ordered(lists: &BTreeSet<String>) -> Vec<String> {
    let mut v: Vec<String> = lists.iter().cloned().collect();
    v.sort_by_key(|l| (list_rank(l), l.clone()));
    v
}

fn slug(title: &str) -> String {
    title.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")
}

/// Where a card is used: deck slug to the lists it's in ("stock", "now", "after-prints",
/// "candidate"...).
type Uses = BTreeMap<String, BTreeSet<String>>;

/// Bryan's cards: name to where each is used, and each deck's commander.
struct Bryan {
    uses: BTreeMap<String, Uses>,
    commanders: BTreeMap<String, String>,
    /// Candidates by card name: (deck slug, the candidate's id, why).
    candidates: BTreeMap<String, Vec<(String, String)>>,
}

fn read_bryan(decks: &Path) -> anyhow::Result<Bryan> {
    let mut b = Bryan { uses: BTreeMap::new(), commanders: BTreeMap::new(), candidates: BTreeMap::new() };
    let mut files: Vec<PathBuf> = std::fs::read_dir(decks.join("decks/compare"))?.flatten().map(|e| e.path()).collect();
    files.retain(|p| p.extension().is_some_and(|e| e == "txt"));
    files.sort();
    for path in &files {
        let stem = path.file_stem().unwrap().to_string_lossy();
        // "fantastic-four-3-after-prints": the deck, then a step number, then the list's name.
        let Some((deck, list)) = stem.match_indices('-').find_map(|(i, _)| {
            let rest = &stem[i + 1..];
            let (n, list) = rest.split_once('-')?;
            (n.len() == 1 && n.chars().all(|c| c.is_ascii_digit())).then(|| (stem[..i].to_string(), list.to_string()))
        }) else {
            anyhow::bail!("can't read the deck and list from {}", path.display());
        };
        for line in read_list(path)? {
            if line.commander {
                b.commanders.entry(deck.clone()).or_insert_with(|| line.name.clone());
            }
            b.uses.entry(line.name).or_default().entry(deck.clone()).or_default().insert(list.clone());
        }
    }
    let precon = decks.join("data/sim/decks/precons/multiverse-reforged.txt");
    for line in read_list(&precon)? {
        b.uses.entry(line.name).or_default().entry("multiverse-reforged".into()).or_default().insert("precon".into());
    }
    let candidates: Value = serde_json::from_str(&std::fs::read_to_string(decks.join("data/shopping/candidates.json"))?)?;
    for c in candidates["candidates"].as_array().into_iter().flatten() {
        let (Some(name), Some(deck)) = (c["inn"].as_str(), c["deck"].as_str()) else { continue };
        let deck = slug(deck);
        b.uses.entry(name.to_string()).or_default().entry(deck.clone()).or_default().insert("candidate".into());
        let id = c["id"].as_str().unwrap_or_default().to_string();
        b.candidates.entry(name.to_string()).or_default().push((deck, id));
    }
    Ok(b)
}

/// The precon catalog: card name to the decks it's in (by the index's deck id).
fn read_catalog(decks: &Path) -> anyhow::Result<(BTreeMap<String, BTreeSet<String>>, usize)> {
    let index: Value = serde_json::from_str(&std::fs::read_to_string(decks.join("data/sim/decks/index.json"))?)?;
    let mut cards: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut n = 0;
    for d in index["decks"].as_array().into_iter().flatten() {
        if d["kind"].as_str() != Some("precon") {
            continue;
        }
        let (Some(id), Some(file)) = (d["id"].as_str(), d["file"].as_str()) else { continue };
        n += 1;
        for line in read_list(&decks.join(file))? {
            cards.entry(line.name).or_default().insert(id.to_string());
        }
    }
    Ok((cards, n))
}

/// One gap phase reports for a face: its handler ("Effect:Unimplemented", "Trigger:Phase"...)
/// and the Oracle text it came from.
#[derive(Debug, Clone, Serialize)]
struct Gap {
    handler: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FaceReport {
    name: String,
    types: String,
    /// A part of this face is unimplemented: the card is "partly unimplemented".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unimplemented: bool,
    /// Every gap the coverage dashboard finds on this face.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    gaps: Vec<Gap>,
    /// The parser's warnings, as phase words them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CardReport {
    name: String,
    /// Yama's verdict: "full", "uncertain", "partial" or "missing".
    support: CardSupport,
    /// phase's coverage dashboard calls every face supported (no gap of any kind).
    phase_supported: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    faces: Vec<FaceReport>,
    /// What the generic smoke test checks for this card (play/src/card_tests/plain.rs); empty
    /// when it can only check that the card plays without an error.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    smoke_checks: Vec<String>,
}

fn types_line(face: &CardFace) -> String {
    let t = &face.card_type;
    let mut words: Vec<String> = t.supertypes.iter().map(|s| s.to_string()).collect();
    words.extend(t.core_types.iter().map(|c| c.to_string()));
    let mut line = words.join(" ");
    if !t.subtypes.is_empty() {
        line.push_str(" — ");
        line.push_str(&t.subtypes.join(" "));
    }
    line
}

struct Analyst<'a> {
    db: &'a CardDatabase,
    engine: &'a Engine,
    /// Dashboard results by face name (lowercase).
    dashboard: HashMap<String, &'a CardCoverageResult>,
    /// Face names by oracle id, in the database's scan order.
    faces_by_oracle: HashMap<String, Vec<String>>,
}

impl<'a> Analyst<'a> {
    /// Every face of the card `name` resolves to: the one the name loads, then its others.
    fn faces(&self, name: &str) -> Vec<&'a CardFace> {
        let Some(face) = self.db.get_face_by_name(name) else { return vec![] };
        let mut out = vec![face];
        if let Some(others) = face.scryfall_oracle_id.as_ref().and_then(|id| self.faces_by_oracle.get(id)) {
            for other in others {
                if let Some(f) = self.db.get_face_by_name(other) {
                    if !out.iter().any(|o| o.name == f.name) {
                        out.push(f);
                    }
                }
            }
        }
        out
    }

    fn report(&self, name: &str) -> CardReport {
        let support = self.engine.card_support("", name);
        let faces: Vec<FaceReport> = self
            .faces(name)
            .into_iter()
            .map(|f| {
                let dash = self.dashboard.get(&f.name.to_lowercase());
                let mut gaps: Vec<Gap> = dash
                    .map(|d| d.gap_details.iter().map(|g| Gap { handler: g.handler.clone(), text: g.source_text.clone() }).collect())
                    .unwrap_or_default();
                // The per-face check Yama's verdict also reads; the dashboard usually has these.
                for handler in card_face_gaps(f) {
                    if !gaps.iter().any(|g| g.handler == handler) {
                        gaps.push(Gap { handler, text: None });
                    }
                }
                FaceReport {
                    name: f.name.clone(),
                    types: types_line(f),
                    unimplemented: card_face_has_unimplemented_parts(f),
                    gaps,
                    warnings: f.parse_warnings.iter().map(|w| w.to_string()).collect(),
                }
            })
            .collect();
        let phase_supported = !faces.is_empty() && faces.iter().all(|f| f.gaps.is_empty() && f.warnings.is_empty());
        let smoke_checks = self.db.get_face_by_name(name).map(|f| plain::expectations(f).iter().map(|e| e.label()).collect()).unwrap_or_default();
        CardReport { name: name.to_string(), support, phase_supported, faces, smoke_checks }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
struct Counts {
    cards: usize,
    full: usize,
    uncertain: usize,
    partial: usize,
    missing: usize,
    /// No gap at all by phase's dashboard (a stricter test than Yama's "full").
    phase_supported: usize,
}

impl Counts {
    fn add(&mut self, c: &CardReport) {
        self.cards += 1;
        match c.support {
            CardSupport::Full => self.full += 1,
            CardSupport::Uncertain => self.uncertain += 1,
            CardSupport::Partial => self.partial += 1,
            CardSupport::Missing => self.missing += 1,
        }
        if c.phase_supported {
            self.phase_supported += 1;
        }
    }
}

#[derive(Serialize)]
struct BryanCard {
    #[serde(flatten)]
    card: CardReport,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    commander: bool,
    decks: Uses,
}

#[derive(Serialize)]
struct CatalogCard {
    #[serde(flatten)]
    card: CardReport,
    /// How many catalog precons the card is in.
    precons: usize,
}

#[derive(Serialize)]
struct DeckCounts {
    deck: String,
    commander: String,
    list: String,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Serialize)]
struct Report {
    generated: String,
    engine: &'static str,
    card_data: String,
    sources: Vec<String>,
    fields: BTreeMap<&'static str, &'static str>,
    bryan: Counts,
    bryan_decks: Vec<DeckCounts>,
    catalog: Counts,
    catalog_precons: usize,
    bryan_cards: Vec<BryanCard>,
    /// Catalog cards that aren't fully supported, with their gaps; the fully supported ones are
    /// in `catalog_full` by name.
    catalog_cards: Vec<CatalogCard>,
    catalog_full: Vec<String>,
}

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let positional: Vec<&String> = args.iter().skip(1).take_while(|a| !a.starts_with("--")).collect();
    let (Some(card_data), Some(decks)) = (positional.first(), positional.get(1)) else {
        anyhow::bail!("usage: coverage <card-data.json> <commander-decks dir> [--out docs/card-coverage] [--fixture PATH] [--smoke PATH]");
    };
    let decks = Path::new(decks.as_str());
    let out = arg_after(&args, "--out").unwrap_or_else(|| "docs/card-coverage".into());

    let t = Instant::now();
    let engine = Engine::load(Path::new(card_data.as_str()))?;
    let db = engine.database().as_ref();
    eprintln!("card data: {} faces in {:.1}s", engine.card_count(), t.elapsed().as_secs_f64());
    let t = Instant::now();
    let summary = analyze_coverage(db);
    eprintln!("phase coverage: {} of {} faces supported, in {:.1}s", summary.supported_cards, summary.total_cards, t.elapsed().as_secs_f64());

    let mut faces_by_oracle: HashMap<String, Vec<String>> = HashMap::new();
    for (_, face) in db.face_iter() {
        if let Some(id) = &face.scryfall_oracle_id {
            faces_by_oracle.entry(id.clone()).or_default().push(face.name.clone());
        }
    }
    for names in faces_by_oracle.values_mut() {
        names.sort();
        names.dedup();
    }
    let analyst = Analyst {
        db,
        engine: &engine,
        dashboard: summary.cards.iter().map(|c| (c.card_name.to_lowercase(), c)).collect(),
        faces_by_oracle,
    };

    let bryan = read_bryan(decks)?;
    let (catalog, catalog_precons) = read_catalog(decks)?;
    let commanders: BTreeSet<&String> = bryan.commanders.values().collect();

    let mut bryan_counts = Counts::default();
    let mut bryan_cards = vec![];
    let mut reports: HashMap<String, CardReport> = HashMap::new();
    for (name, uses) in &bryan.uses {
        let card = analyst.report(name);
        bryan_counts.add(&card);
        reports.insert(name.clone(), card.clone());
        bryan_cards.push(BryanCard { card, commander: commanders.contains(name), decks: uses.clone() });
    }

    // Each deck's lists: the cards in them, by Yama's verdict.
    let mut lists: BTreeMap<(usize, String, usize, String), Counts> = BTreeMap::new();
    for (name, uses) in &bryan.uses {
        for (deck, in_lists) in uses {
            let order = DECK_ORDER.iter().position(|d| d == deck).unwrap_or(DECK_ORDER.len());
            for list in in_lists {
                lists.entry((order, deck.clone(), list_rank(list), list.clone())).or_default().add(&reports[name]);
            }
        }
    }
    let bryan_decks = lists
        .into_iter()
        .map(|((_, deck, _, list), counts)| DeckCounts {
            commander: bryan.commanders.get(&deck).cloned().unwrap_or_default(),
            deck: deck_title(&deck),
            list,
            counts,
        })
        .collect();

    let mut catalog_counts = Counts::default();
    let mut catalog_cards = vec![];
    let mut catalog_full = vec![];
    for (name, precons) in &catalog {
        let card = reports.get(name).cloned().unwrap_or_else(|| analyst.report(name));
        catalog_counts.add(&card);
        if card.support == CardSupport::Full {
            catalog_full.push(name.clone());
        } else {
            catalog_cards.push(CatalogCard { card, precons: precons.len() });
        }
    }

    let fields = BTreeMap::from([
        ("support", "Yama's verdict (play/src/lib.rs, Engine::card_support), the one the deck pages and the lab show. full: no problem found; uncertain: no unimplemented part, but parse warnings or a coverage gap; partial: some part is unimplemented in phase; missing: phase doesn't know the card."),
        ("phase_supported", "phase's own coverage dashboard (engine::game::coverage::analyze_coverage) finds no gap of any kind on any face. Stricter than support = full: it also runs resolver, dropped-text and subtype checks."),
        ("faces[].unimplemented", "the face has an unimplemented part (card_face_has_unimplemented_parts): this is what makes a card partial."),
        ("faces[].gaps", "every gap the dashboard reports for the face, with the Oracle text it came from."),
        ("faces[].warnings", "the Oracle parser's warnings on the face."),
        ("smoke_checks", "what the generic smoke test checks the card did (play/src/card_tests/plain.rs). Empty: the smoke test only checks the card plays (cast or played, abilities activated) without an error or a stuck decision."),
        ("decks", "Bryan's deck (file name in commander-decks decks/compare) to the lists the card is in: stock, now, after-prints (and Multiverse Reforged's after-local-buys, proposed-bracket-3, precon), candidate (data/shopping/candidates.json)."),
    ]);
    let report = Report {
        generated: today(),
        engine: yama_play::ENGINE_VERSION,
        card_data: Path::new(card_data.as_str()).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        sources: vec![
            "commander-decks decks/compare/*.txt".into(),
            "commander-decks data/shopping/candidates.json".into(),
            "commander-decks data/sim/decks/precons/multiverse-reforged.txt".into(),
            format!("commander-decks data/sim/decks/index.json ({catalog_precons} precons)"),
        ],
        fields,
        bryan: bryan_counts,
        bryan_decks,
        catalog: catalog_counts,
        catalog_precons,
        bryan_cards,
        catalog_cards,
        catalog_full,
    };

    let json_path = PathBuf::from(format!("{out}.json"));
    let md_path = PathBuf::from(format!("{out}.md"));
    std::fs::write(&json_path, serde_json::to_string_pretty(&report)? + "\n")?;
    let kept = std::fs::read_to_string(&md_path).ok().and_then(|old| kept_section(&old));
    let smoke_path = arg_after(&args, "--smoke").unwrap_or_else(|| "play/src/card_tests/smoke_cards.rs".into());
    let ignored = smoke_ignores(Path::new(&smoke_path));
    std::fs::write(&md_path, markdown(&report, &bryan, kept.as_deref(), &ignored))?;
    eprintln!("wrote {} and {}", json_path.display(), md_path.display());

    if let Some(path) = arg_after(&args, "--fixture") {
        let n = write_fixture(&analyst, bryan.uses.keys(), Path::new(&path))?;
        eprintln!("wrote {path}: {n} faces");
    }
    if let Some(path) = arg_after(&args, "--smoke") {
        let n = write_smoke_list(&bryan, Path::new(&path))?;
        eprintln!("wrote {path}: {n} cards");
    }
    Ok(())
}

/// Today's date (UTC) as YYYY-MM-DD.
fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

const BUGS_HEADING: &str = "## Engine bugs found";

/// The hand-kept "Engine bugs found" section of an earlier report, up to the next "## " heading.
fn kept_section(old: &str) -> Option<String> {
    let start = old.find(BUGS_HEADING)?;
    let rest = &old[start + BUGS_HEADING.len()..];
    let end = rest.find("\n## ").map(|i| i + 1).unwrap_or(rest.len());
    Some(format!("{BUGS_HEADING}{}", &rest[..end]))
}

fn support_word(s: CardSupport) -> &'static str {
    match s {
        CardSupport::Full => "full",
        CardSupport::Uncertain => "uncertain",
        CardSupport::Partial => "partial",
        CardSupport::Missing => "missing",
    }
}

fn pct(n: usize, of: usize) -> String {
    if of == 0 { "0%".into() } else { format!("{:.1}%", n as f64 * 100.0 / of as f64) }
}

/// A table cell: no pipes or line breaks.
fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

fn gap_text(g: &Gap) -> String {
    match &g.text {
        Some(t) => format!("{} (\"{}\")", g.handler, cell(t.trim())),
        None => g.handler.clone(),
    }
}

/// What's wrong with a card, in one cell: each face's gaps and warnings.
fn problems(c: &CardReport) -> String {
    let several = c.faces.len() > 1;
    let mut parts = vec![];
    for f in &c.faces {
        let mut bits: Vec<String> = f.gaps.iter().map(gap_text).collect();
        bits.extend(f.warnings.iter().filter(|w| !f.gaps.iter().any(|g| g.text.as_deref() == Some(w.as_str()))).map(|w| format!("warning: {}", cell(w))));
        if bits.is_empty() {
            continue;
        }
        let joined = bits.join("; ");
        parts.push(if several { format!("{}: {joined}", f.name) } else { joined });
    }
    parts.join(" / ")
}

fn uses_text(uses: &Uses) -> String {
    uses.iter().map(|(deck, lists)| format!("{} ({})", deck_title(deck), ordered(lists).join(", "))).collect::<Vec<_>>().join("; ")
}

fn markdown(r: &Report, bryan: &Bryan, kept: Option<&str>, ignored: &HashMap<String, String>) -> String {
    let mut s = String::new();
    let b = &r.bryan;
    let c = &r.catalog;
    let _ = writeln!(s, "# Card coverage in the phase engine\n");
    let _ = writeln!(
        s,
        "Generated {} by `play/src/bin/coverage.rs` from card data `{}` ({}). The machine-readable copy is \
         [card-coverage.json](card-coverage.json). Regenerate with:\n",
        r.generated, r.card_data, r.engine
    );
    let _ = writeln!(
        s,
        "```sh\ncargo run -p yama-play --bin coverage -- data/engine/{} ../commander-decks \\\n    \
         --fixture play/tests/fixtures/deck-cards.json --smoke play/src/card_tests/smoke_cards.rs\n```\n",
        r.card_data
    );
    let _ = writeln!(s, "## What the words mean\n");
    let _ = writeln!(s, "- **full**: none of the engine's checks found a problem. Passing them isn't proof a card plays correctly; the per-card tests are.");
    let _ = writeln!(s, "- **uncertain**: nothing is marked unimplemented, but the parser left a warning (often a clause it swallowed) or phase's coverage check found a gap. It may not work fully.");
    let _ = writeln!(s, "- **partial** (partly unimplemented): some ability, trigger, static or cost is unimplemented. The engine plays the rest of the card.");
    let _ = writeln!(s, "- **missing**: the engine doesn't know the card; it's left out of the game.");
    let _ = writeln!(s, "- **phase clean**: phase's own coverage dashboard finds no gap of any kind on any face. It runs more checks than Yama's verdict (resolver features, dropped text, subtypes), so a full card can still have a dashboard gap.\n");
    let _ = writeln!(s, "## The per-card tests\n");
    let _ = writeln!(s, "The tests are in `play/src/card_tests/` and run with the rest of the play crate (`cargo test -p yama-play`). They play each card on the real engine through Yama's own answers (`Match::act` and the option buttons), on `play/tests/fixtures/deck-cards.json`, the slice of the card data above that holds every card in this report's first table.\n");
    let _ = writeln!(s, "- **Smoke tests** (`smoke.rs`, one per card, listed in `smoke_cards.rs`): the card is played where it's used (a land played and tapped, anything else cast, in answer to an opponent's spell if it needs one), and every ability the engine offers for it, in hand and on the battlefield, is activated. Each step must finish with no panic, no engine refusal, no decision Yama can't answer and a game that settles; then the card must have done the plain thing in its smoke checks below.");
    let _ = writeln!(s, "- **Specific tests** check the rules outcome the Oracle text and rulings describe: the eight commanders (`commanders.rs`), the cards the decks are built around (`key_cards.rs`), and every partly unimplemented card and those the parser warned about (`partial.rs`).");
    let _ = writeln!(s, "- A test that shows phase is wrong is kept and marked `#[ignore = \"phase bug: ...\"]`; each is listed under Engine bugs found.\n");
    let _ = writeln!(s, "## Summary\n");
    let _ = writeln!(s, "| | Cards | Full | Uncertain | Partial | Missing | Phase clean |");
    let _ = writeln!(s, "|---|---:|---:|---:|---:|---:|---:|");
    for (label, n) in [("Bryan's decks and candidates", b), (&*format!("Precon catalog ({} precons)", r.catalog_precons), c)] {
        let _ = writeln!(
            s,
            "| {label} | {} | {} ({}) | {} | {} | {} | {} ({}) |",
            n.cards,
            n.full,
            pct(n.full, n.cards),
            n.uncertain,
            n.partial,
            n.missing,
            n.phase_supported,
            pct(n.phase_supported, n.cards)
        );
    }
    let _ = writeln!(s, "\nBy deck and list (distinct cards, basic lands counted once):\n");
    let _ = writeln!(s, "| Deck | Commander | List | Cards | Full | Uncertain | Partial | Missing |");
    let _ = writeln!(s, "|---|---|---|---:|---:|---:|---:|---:|");
    for d in &r.bryan_decks {
        let n = &d.counts;
        let _ = writeln!(s, "| {} | {} | {} | {} | {} | {} | {} | {} |", d.deck, d.commander, d.list, n.cards, n.full, n.uncertain, n.partial, n.missing);
    }
    let _ = writeln!(s);
    match kept {
        Some(section) => {
            s.push_str(section.trim_end());
            s.push_str("\n\n");
        }
        None => {
            let _ = writeln!(s, "{BUGS_HEADING}\n\nNone recorded yet.\n");
        }
    }

    let _ = writeln!(s, "## Bryan's cards that aren't fully supported\n");
    let _ = writeln!(s, "| Card | Support | Decks | What phase reports |");
    let _ = writeln!(s, "|---|---|---|---|");
    let mut not_full: Vec<&BryanCard> = r.bryan_cards.iter().filter(|c| c.card.support != CardSupport::Full).collect();
    not_full.sort_by_key(|c| (c.card.support != CardSupport::Partial, c.card.support != CardSupport::Missing, c.card.name.clone()));
    for bc in not_full {
        let name = if bc.commander { format!("{} (commander)", bc.card.name) } else { bc.card.name.clone() };
        let _ = writeln!(s, "| {} | {} | {} | {} |", cell(&name), support_word(bc.card.support), cell(&uses_text(&bc.decks)), problems(&bc.card));
    }

    let _ = writeln!(s, "\n## Bryan's cards in full\n");
    let _ = writeln!(s, "Every card in his lists and candidates, by deck (a card in several decks is listed under each). Smoke checks are what the generic smoke test checks beyond playing without an error; \"plays\" means only that.\n");
    for deck in DECK_ORDER {
        let mut names: Vec<&String> = bryan.uses.iter().filter(|(_, u)| u.contains_key(*deck)).map(|(n, _)| n).collect();
        if names.is_empty() {
            continue;
        }
        names.sort();
        let commander = bryan.commanders.get(*deck).cloned().unwrap_or_default();
        let _ = writeln!(s, "### {} ({commander}, {} cards)\n", deck_title(deck), names.len());
        let _ = writeln!(s, "| Card | Lists | Support | Phase clean | Smoke checks | Notes |");
        let _ = writeln!(s, "|---|---|---|---|---|---|");
        for name in names {
            let bc = r.bryan_cards.iter().find(|c| &c.card.name == name).unwrap();
            let lists = ordered(&bc.decks[*deck]).join(", ");
            let checks = match ignored.get(name.as_str()) {
                Some(attr) => format!("ignored: {}", ignore_reason(attr)),
                None if bc.card.smoke_checks.is_empty() => "plays".to_string(),
                None => bc.card.smoke_checks.join(", "),
            };
            let mut notes = problems(&bc.card);
            if let Some(c) = bryan.candidates.get(name) {
                let ids: Vec<&str> = c.iter().filter(|(d, _)| d == deck).map(|(_, id)| id.as_str()).collect();
                if !ids.is_empty() {
                    notes = format!("candidate {}{}{notes}", ids.join(", "), if notes.is_empty() { "" } else { "; " });
                }
            }
            let _ = writeln!(
                s,
                "| {} | {lists} | {} | {} | {} | {} |",
                cell(name),
                support_word(bc.card.support),
                if bc.card.phase_supported { "yes" } else { "no" },
                cell(&checks),
                notes
            );
        }
        let _ = writeln!(s);
    }

    let _ = writeln!(s, "## The precon catalog\n");
    let _ = writeln!(
        s,
        "{} distinct cards in {} precons. Partly unimplemented cards, by how many precons they're in (the JSON has every card that isn't fully supported, with its gaps):\n",
        c.cards, r.catalog_precons
    );
    let _ = writeln!(s, "| Card | Precons | What phase reports |");
    let _ = writeln!(s, "|---|---:|---|");
    let mut partial: Vec<&CatalogCard> = r.catalog_cards.iter().filter(|c| c.card.support == CardSupport::Partial).collect();
    partial.sort_by(|a, b| b.precons.cmp(&a.precons).then_with(|| a.card.name.cmp(&b.card.name)));
    for cc in partial {
        let _ = writeln!(s, "| {} | {} | {} |", cell(&cc.card.name), cc.precons, problems(&cc.card));
    }
    let missing: Vec<&str> = r.catalog_cards.iter().filter(|c| c.card.support == CardSupport::Missing).map(|c| c.card.name.as_str()).collect();
    if !missing.is_empty() {
        let _ = writeln!(s, "\nMissing from the card data: {}.", missing.join(", "));
    }
    // The most common gaps among catalog cards that aren't fully supported.
    let mut handlers: BTreeMap<String, usize> = BTreeMap::new();
    for cc in &r.catalog_cards {
        let mut seen = BTreeSet::new();
        for f in &cc.card.faces {
            for g in &f.gaps {
                seen.insert(g.handler.clone());
            }
        }
        for h in seen {
            *handlers.entry(h).or_default() += 1;
        }
    }
    let mut top: Vec<(String, usize)> = handlers.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let _ = writeln!(s, "\nThe most common gaps among the catalog's uncertain and partial cards:\n");
    let _ = writeln!(s, "| Gap | Cards |");
    let _ = writeln!(s, "|---|---:|");
    for (h, n) in top.into_iter().take(25) {
        let _ = writeln!(s, "| {} | {n} |", cell(&h));
    }
    s
}

/// Write the per-card tests' card data: every face of Bryan's cards and of [`HELPERS`], one card
/// per line, without printings, legalities, rulings and metadata. Returns how many faces.
fn write_fixture<'a>(analyst: &Analyst, names: impl Iterator<Item = &'a String>, path: &Path) -> anyhow::Result<usize> {
    let mut faces: BTreeSet<String> = BTreeSet::new();
    for name in names.map(String::as_str).chain(HELPERS.iter().copied()) {
        for f in analyst.faces(name) {
            faces.insert(f.name.clone());
        }
    }
    let subset: serde_json::Map<String, Value> = serde_json::from_str(&analyst.db.export_subset_json(&faces))?;
    let mut sorted: Vec<(String, Value)> = subset.into_iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::from("{\n");
    for (i, (key, mut entry)) in sorted.iter().cloned().enumerate() {
        if let Some(o) = entry.as_object_mut() {
            for drop in ["printings", "legalities", "rulings", "metadata", "rarities"] {
                o.remove(drop);
            }
        }
        let sep = if i + 1 < sorted.len() { "," } else { "" };
        let _ = writeln!(out, "{}: {}{sep}", serde_json::to_string(&key)?, serde_json::to_string(&entry)?);
    }
    out.push_str("}\n");
    std::fs::write(path, out)?;
    Ok(sorted.len())
}

const RUST_KEYWORDS: &[&str] = &[
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box",
    "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen",
];

/// A card name as a test function name: "Éowyn, Shieldmaiden" reads "eowyn_shieldmaiden".
fn test_name(card: &str) -> String {
    let mut out = String::new();
    for ch in card.chars() {
        let ch = match ch {
            'á' | 'à' | 'â' | 'ä' | 'Á' | 'À' | 'Â' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'Ó' | 'Ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ü' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_').to_string();
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) || RUST_KEYWORDS.contains(&out.as_str()) {
        format!("card_{out}")
    } else {
        out
    }
}

/// The `#[ignore = "..."]` attribute on each card's line of a smoke test list, by card name.
fn smoke_ignores(path: &Path) -> HashMap<String, String> {
    let mut ignores: HashMap<String, String> = HashMap::new();
    let Ok(old) = std::fs::read_to_string(path) else { return ignores };
    let mut pending: Option<String> = None;
    for line in old.lines().map(str::trim) {
        if line.starts_with("#[ignore") {
            pending = Some(line.to_string());
        } else if let Some(attr) = pending.take() {
            // `name("Card", "Commander");`
            if let Some(card) = line.split('"').nth(1) {
                ignores.insert(card.to_string(), attr);
            }
        }
    }
    ignores
}

/// The reason in an `#[ignore = "..."]` attribute.
fn ignore_reason(attr: &str) -> String {
    attr.split_once('=').map(|(_, r)| r.trim().trim_end_matches(']').trim().trim_matches('"').replace("\\\"", "\"")).unwrap_or_default()
}

/// Write the smoke test list: one line per card in Bryan's decks, with the commander of the first
/// deck it's in, keeping any `#[ignore = "..."]` an earlier list had on that card.
fn write_smoke_list(bryan: &Bryan, path: &Path) -> anyhow::Result<usize> {
    let ignores = smoke_ignores(path);
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut out = String::new();
    out.push_str(
        "// One smoke test per card in Bryan's decks and candidates (play/src/card_tests/smoke.rs), with the\n\
         // commander of the first deck it's in. Written by `coverage --smoke` (play/src/bin/coverage.rs);\n\
         // an `#[ignore = \"...\"]` line above a card is kept when the list is written again.\n\n\
         smoke! {\n",
    );
    let mut n = 0;
    for (name, uses) in &bryan.uses {
        let deck = DECK_ORDER.iter().find(|d| uses.contains_key(**d)).copied().or_else(|| uses.keys().next().map(String::as_str)).unwrap_or_default();
        let commander = bryan.commanders.get(deck).cloned().unwrap_or_default();
        let mut f = test_name(name);
        let k = used.entry(f.clone()).or_default();
        *k += 1;
        if *k > 1 {
            f = format!("{f}_{k}");
        }
        if let Some(attr) = ignores.get(name) {
            let _ = writeln!(out, "    {attr}");
        }
        let _ = writeln!(out, "    {f}({}, {});", serde_json::to_string(name)?, serde_json::to_string(&commander)?);
        n += 1;
    }
    out.push_str("}\n");
    std::fs::write(path, out)?;
    Ok(n)
}
