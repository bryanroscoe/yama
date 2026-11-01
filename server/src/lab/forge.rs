//! Forge as a second engine for Lab runs.
//!
//! Forge (https://github.com/Card-Forge/forge, GPL-3.0) runs as a separate program in its own
//! container, `yama-forge` (deploy/Dockerfile.forge-worker, the worker in `forge-worker/`). No
//! Forge code is in Yama: Yama sends the worker a game (the schedule line and the seats' card
//! lists) over HTTP and stores the result line the worker sends back.
//!
//! - **Who talks to whom.** Yama calls the worker, never the other way round, on a private Docker
//!   network only `yama` and `yama-forge` share, with a shared secret in `x-forge-secret` (like the
//!   advisor sidecar). Yama gets no new inbound route; the worker publishes no port.
//! - **Which games.** Every scheduled game names its engine (`lab_experiment_games.engine`). The
//!   lab worker plays only `phase` games; [`super::worker::LabWorker::run_forge`] hands `forge`
//!   games to the Forge worker, up to the slots it reports, with the same order and the same
//!   one-experiment-at-a-time rule.
//! - **A worker that's down.** Games wait. The worker's status is checked every few seconds; after
//!   [`OFFLINE_AFTER`] without an answer the Lab says "Forge worker offline" on runs with Forge
//!   games still to play. A game whose request fails goes back in the queue; one that fails
//!   [`FORGE_MAX_ATTEMPTS`] times is written off as an error.
//! - **Cards Forge doesn't know.** The worker checks names against Forge's own card scripts
//!   (`/check`). Yama keeps the answers per worker version ([`ForgeCards`]) and uses them like
//!   phase's unknown cards: a tested list with such cards is refused, and precons with them are
//!   left out of a Forge field.
//! - **Labels.** Forge results carry the worker's engine label ("forge 2.0.16-745401a4+yama3.54567890": Yama's Forge
//!   build, deploy/Dockerfile.forge-worker), card data and runner, so they are never pooled with
//!   phase results or another Forge build. A "both" experiment keeps two summaries.

use super::experiments::LabCard;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use yama_play::lab::{End, GameResult, GameSpec};

/// Forge's fixed AI profiles (its "Random" profiles draw from the seed, so they're left out).
pub const FORGE_PROFILES: [&str; 4] = ["Default", "Cautious", "Reckless", "Experimental"];
pub const DEFAULT_PROFILE: &str = "Default";
/// Forge's wall-clock limit per game (its `-c`). The phase lab caps CPU time at 600 s; Forge games
/// are slower and its limit is wall time, so it gets longer (the batch runs used 900 s).
pub const FORGE_MAX_SECONDS: u64 = 900;
/// A Forge game counts as this many games against the daily allowance: Forge plays a game in
/// about 4 minutes where phase takes about one, on a worker with few slots.
pub const FORGE_WEIGHT: u32 = 2;
/// Requests for one game that may fail (worker restarted, network) before it is written off.
pub const FORGE_MAX_ATTEMPTS: i64 = 3;
/// Without an answer for this long, the worker counts as offline.
pub const OFFLINE_AFTER: Duration = Duration::from_secs(60);
/// How often the worker's status is checked, and Forge games are handed out.
pub const POLL: Duration = Duration::from_secs(5);
/// Extra time on top of a game's own limit before Yama gives up waiting for the worker's answer
/// (the worker kills a JVM 180 s after its limit).
const PLAY_GRACE: Duration = Duration::from_secs(300);
/// Names sent to the worker's card check at once.
const CHECK_CHUNK: usize = 2_000;

/// Which engines play an experiment's games.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineMode {
    /// The server's own rules engine (phase).
    #[default]
    Phase,
    /// Forge only.
    Forge,
    /// Every pod on each engine, side by side.
    Both,
}

impl EngineMode {
    pub fn parse(s: Option<&str>) -> Result<EngineMode, String> {
        match s.map(str::trim).unwrap_or("phase") {
            "" | "phase" => Ok(EngineMode::Phase),
            "forge" => Ok(EngineMode::Forge),
            "both" => Ok(EngineMode::Both),
            other => Err(format!("engine {other:?}: use phase, forge or both")),
        }
    }
    pub fn phase(self) -> bool {
        matches!(self, EngineMode::Phase | EngineMode::Both)
    }
    pub fn forge(self) -> bool {
        matches!(self, EngineMode::Forge | EngineMode::Both)
    }
    /// What `games` games per engine count against the daily allowance.
    pub fn cost(self, games: u32) -> u32 {
        match self {
            EngineMode::Phase => games,
            EngineMode::Forge => games * FORGE_WEIGHT,
            EngineMode::Both => games + games * FORGE_WEIGHT,
        }
    }
}

/// An experiment's engines, frozen in its spec. Missing on experiments from before Forge: phase.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Engines {
    #[serde(default)]
    pub mode: EngineMode,
    /// The Forge AI profile every Forge seat plays (Forge has no Easy/Medium/Hard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge_ai: Option<String>,
}

impl Engines {
    pub fn profile(&self) -> &str {
        self.forge_ai.as_deref().unwrap_or(DEFAULT_PROFILE)
    }
}

/// A Forge AI profile as Forge names it; unknown profiles are refused.
pub fn canonical_profile(s: Option<&str>) -> Result<String, String> {
    let s = s.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_PROFILE);
    FORGE_PROFILES
        .iter()
        .find(|p| p.eq_ignore_ascii_case(s))
        .map(|p| (*p).to_string())
        .ok_or_else(|| format!("forge_ai {s:?}: use {}", FORGE_PROFILES.join(", ")))
}

/// What the worker says about itself (`GET /status`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForgeStatus {
    /// Its engine label, "forge 2.0.16-745401a4+yama3.54567890": what its result lines carry.
    pub engine: String,
    #[serde(default)]
    pub card_data: String,
    #[serde(default)]
    pub runner: String,
    /// Games it plays at once.
    pub slots: usize,
    /// Games it is playing now.
    #[serde(default)]
    pub running: usize,
    #[serde(default)]
    pub profiles: Vec<String>,
}

/// One seat's list as the worker gets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForgeCard {
    pub name: String,
    pub qty: u32,
    #[serde(default)]
    pub commander: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForgeDeck {
    /// The deck id the schedule line names.
    pub id: String,
    pub cards: Vec<ForgeCard>,
}

/// One game for the worker (`POST /play`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForgePlay {
    /// "experiment/game": the worker answers a repeated key from what it has (playing or played).
    pub key: String,
    pub profile: String,
    pub spec: GameSpec,
    pub decks: Vec<ForgeDeck>,
}

impl ForgePlay {
    pub fn new(experiment: &str, spec: &GameSpec, profile: &str, decks: &[Arc<super::experiments::LabList>]) -> ForgePlay {
        ForgePlay {
            key: format!("{experiment}/{}", spec.game),
            profile: profile.to_string(),
            spec: spec.clone(),
            decks: spec
                .decks
                .iter()
                .zip(decks)
                .map(|(id, l)| ForgeDeck {
                    id: id.clone(),
                    cards: l.cards.iter().map(|c| ForgeCard { name: c.name.clone(), qty: c.qty, commander: c.commander }).collect(),
                })
                .collect(),
        }
    }
}

/// The Forge worker as Yama talks to it: HTTP in the server, a fake in tests.
pub trait ForgeClient: Send + Sync + 'static {
    fn status(&self) -> BoxFuture<'static, Result<ForgeStatus, String>>;
    /// Of `names`, the ones Forge doesn't know.
    fn check(&self, names: Vec<String>) -> BoxFuture<'static, Result<Vec<String>, String>>;
    /// Play one game to its end and return its result line.
    fn play(&self, req: ForgePlay) -> BoxFuture<'static, Result<GameResult, String>>;
}

/// The worker over HTTP on the private network.
pub struct HttpForge {
    http: reqwest::Client,
    url: String,
    secret: String,
}

impl HttpForge {
    pub fn new(http: reqwest::Client, url: String, secret: String) -> Self {
        Self { http, url, secret }
    }
}

#[derive(Deserialize)]
struct PlayAnswer {
    result: Option<GameResult>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct CheckAnswer {
    unknown: Vec<String>,
}

async fn error_text(res: reqwest::Response) -> String {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or(body);
    format!("the Forge worker answered {status}: {}", msg.chars().take(300).collect::<String>())
}

impl ForgeClient for HttpForge {
    fn status(&self) -> BoxFuture<'static, Result<ForgeStatus, String>> {
        let req = self.http.get(format!("{}/status", self.url)).header("x-forge-secret", &self.secret).timeout(Duration::from_secs(5));
        Box::pin(async move {
            let res = req.send().await.map_err(|e| format!("the Forge worker didn't answer: {e}"))?;
            if !res.status().is_success() {
                return Err(error_text(res).await);
            }
            res.json::<ForgeStatus>().await.map_err(|e| format!("the Forge worker's status wasn't readable: {e}"))
        })
    }

    fn check(&self, names: Vec<String>) -> BoxFuture<'static, Result<Vec<String>, String>> {
        let req = self
            .http
            .post(format!("{}/check", self.url))
            .header("x-forge-secret", &self.secret)
            .timeout(Duration::from_secs(60))
            .json(&serde_json::json!({ "names": names }));
        Box::pin(async move {
            let res = req.send().await.map_err(|e| format!("the Forge worker didn't answer: {e}"))?;
            if !res.status().is_success() {
                return Err(error_text(res).await);
            }
            Ok(res.json::<CheckAnswer>().await.map_err(|e| format!("the Forge worker's card check wasn't readable: {e}"))?.unknown)
        })
    }

    fn play(&self, req: ForgePlay) -> BoxFuture<'static, Result<GameResult, String>> {
        let wait = Duration::from_secs(req.spec.max_seconds) + PLAY_GRACE;
        let req = self.http.post(format!("{}/play", self.url)).header("x-forge-secret", &self.secret).timeout(wait).json(&req);
        Box::pin(async move {
            let res = req.send().await.map_err(|e| format!("the Forge worker didn't answer: {e}"))?;
            if !res.status().is_success() {
                return Err(error_text(res).await);
            }
            let a = res.json::<PlayAnswer>().await.map_err(|e| format!("the Forge worker's answer wasn't readable: {e}"))?;
            match (a.result, a.error) {
                (Some(r), _) => Ok(r),
                (None, e) => Err(e.unwrap_or_else(|| "the Forge worker sent no result".into())),
            }
        })
    }
}

/// Which card names Forge knows, as the worker answered them, for one worker version.
#[derive(Default)]
pub struct ForgeCards {
    engine: String,
    known: Mutex<HashMap<String, bool>>,
}

impl ForgeCards {
    pub fn new(engine: &str) -> Self {
        Self { engine: engine.to_string(), known: Mutex::default() }
    }
    pub fn engine(&self) -> &str {
        &self.engine
    }
    /// Names not asked about yet.
    pub fn missing(&self, names: impl IntoIterator<Item = String>) -> Vec<String> {
        let known = self.known.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen = HashSet::new();
        names.into_iter().filter(|n| !known.contains_key(n) && seen.insert(n.clone())).collect()
    }
    pub fn record(&self, asked: &[String], unknown: &[String]) {
        let bad: HashSet<&String> = unknown.iter().collect();
        let mut known = self.known.lock().unwrap_or_else(|e| e.into_inner());
        for n in asked {
            known.insert(n.clone(), !bad.contains(n));
        }
    }
    /// Names in `cards` Forge doesn't know. A name never asked about counts as unknown only when
    /// `strict`: without the worker's answer it's better to let the game say so than to refuse.
    pub fn unknown(&self, cards: &[LabCard], strict: bool) -> Vec<String> {
        let known = self.known.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<String> = Vec::new();
        for c in cards {
            let bad = match known.get(&c.name) {
                Some(k) => !k,
                None => strict,
            };
            if bad && !out.contains(&c.name) {
                out.push(c.name.clone());
            }
        }
        out
    }
}

/// Ask the worker about every name in `names` it hasn't been asked about, in chunks.
pub async fn ensure_cards(client: &dyn ForgeClient, cards: &ForgeCards, names: impl IntoIterator<Item = String>) -> Result<(), String> {
    let missing = cards.missing(names);
    for chunk in missing.chunks(CHECK_CHUNK) {
        let unknown = client.check(chunk.to_vec()).await?;
        cards.record(chunk, &unknown);
    }
    Ok(())
}

/// The worker as the Lab and the admin pages see it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ForgeView {
    /// YAMA_FORGE_URL and YAMA_FORGE_SECRET are set.
    pub configured: bool,
    /// It answered within the last minute.
    pub online: bool,
    pub engine: Option<String>,
    pub runner: Option<String>,
    pub slots: usize,
    /// Games Yama has handed it that haven't come back.
    pub playing: usize,
    pub profiles: Vec<String>,
    /// When it last answered (RFC 3339).
    pub last_seen: Option<String>,
    /// Why the last status check failed.
    pub error: Option<String>,
}

/// What creating a run needs to know about Forge.
#[derive(Clone, Default)]
pub struct ForgeAccess {
    /// The worker, when this server has one (it may be offline).
    pub client: Option<Arc<dyn ForgeClient>>,
    /// Its answers about card names so far, while it is online.
    pub cards: Option<Arc<ForgeCards>>,
    /// Its engine label while it is online ("forge 2.0.16-745401a4+yama3.54567890").
    pub engine: Option<String>,
}

/// What Yama knows about the worker right now.
#[derive(Default)]
pub struct ForgeLive {
    pub status: Option<ForgeStatus>,
    pub last_ok: Option<Instant>,
    pub last_seen: Option<String>,
    pub error: Option<String>,
    pub cards: Option<Arc<ForgeCards>>,
}

impl ForgeLive {
    pub fn online(&self) -> bool {
        self.status.is_some() && self.last_ok.is_some_and(|t| t.elapsed() < OFFLINE_AFTER)
    }
    pub fn view(&self, configured: bool, playing: usize) -> ForgeView {
        let s = self.status.as_ref();
        ForgeView {
            configured,
            online: configured && self.online(),
            engine: s.map(|s| s.engine.clone()),
            runner: s.map(|s| s.runner.clone()),
            slots: s.map_or(0, |s| s.slots),
            playing,
            profiles: s.map(|s| s.profiles.clone()).unwrap_or_default(),
            last_seen: self.last_seen.clone(),
            error: self.error.clone(),
        }
    }
}

/// A result line for a Forge game Yama gave up on (never played, or no answer), labelled as Forge.
pub fn failed_result(spec: &GameSpec, engine: Option<&ForgeStatus>, profile: &str, why: String) -> GameResult {
    let mut r = GameResult::new(spec, engine.map_or("forge", |s| s.card_data.as_str()));
    r.difficulty = profile.to_string();
    r.engine = engine.map_or_else(|| "forge".to_string(), |s| s.engine.clone());
    r.runner = engine.map_or_else(|| "yama forge dispatch".to_string(), |s| s.runner.clone());
    r.end = End::Error;
    r.error = Some(why);
    r
}

/// Check a worker's result line against the game it was asked to play: the same game, seed and
/// seats, and a Forge label. Anything else is stored as an error, never as a result.
pub fn checked_result(spec: &GameSpec, engine: Option<&ForgeStatus>, profile: &str, r: GameResult) -> GameResult {
    let problem = if r.game != spec.game {
        Some(format!("the Forge worker answered for game {} instead", r.game))
    } else if r.seed != spec.seed || r.decks != spec.decks {
        Some("the Forge worker's result names other seats or another shuffle".to_string())
    } else if !r.engine.starts_with("forge") {
        Some(format!("the Forge worker's result says engine {:?}", r.engine))
    } else if r.winner.is_some_and(|w| usize::from(w) >= spec.decks.len()) || r.placements.iter().flatten().any(|s| usize::from(*s) >= spec.decks.len()) {
        Some("the Forge worker's result names a seat that isn't in the game".to_string())
    } else {
        None
    };
    match problem {
        Some(why) => failed_result(spec, engine, profile, why),
        None => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> GameSpec {
        GameSpec { game: "g1-f".into(), seed: 7, decks: vec!["base".into(), "o1".into()], difficulty: "Easy".into(), max_turns: 120, max_actions: 1, max_seconds: 900, pilots: None }
    }

    #[test]
    fn engine_modes_parse_and_count() {
        assert_eq!(EngineMode::parse(None), Ok(EngineMode::Phase));
        assert_eq!(EngineMode::parse(Some("both")), Ok(EngineMode::Both));
        assert!(EngineMode::parse(Some("xmage")).is_err());
        assert_eq!(EngineMode::Forge.cost(100), 100 * FORGE_WEIGHT);
        assert_eq!(EngineMode::Both.cost(100), 100 + 100 * FORGE_WEIGHT);
        assert_eq!(canonical_profile(Some("reckless")).unwrap(), "Reckless");
        assert_eq!(canonical_profile(None).unwrap(), "Default");
        assert!(canonical_profile(Some("Random")).is_err());
    }

    #[test]
    fn a_result_for_another_game_or_engine_is_stored_as_an_error() {
        let s = spec();
        let status = ForgeStatus { engine: "forge 2.0.15".into(), card_data: "forge res 2.0.15".into(), runner: "w".into(), slots: 2, running: 0, profiles: vec![] };
        let mut good = GameResult::new(&s, "forge res 2.0.15");
        good.engine = "forge 2.0.15".into();
        good.end = End::Win;
        good.winner = Some(1);
        good.placements = vec![vec![1], vec![0]];
        assert_eq!(checked_result(&s, Some(&status), "Default", good.clone()), good);

        let mut other = good.clone();
        other.game = "g2-f".into();
        let r = checked_result(&s, Some(&status), "Default", other);
        assert_eq!(r.end, End::Error);
        assert_eq!(r.engine, "forge 2.0.15");

        let mut phase = good.clone();
        phase.engine = "phase-rs v0.113.0".into();
        assert_eq!(checked_result(&s, Some(&status), "Default", phase).end, End::Error);

        let mut seat = good;
        seat.winner = Some(5);
        assert_eq!(checked_result(&s, Some(&status), "Default", seat).end, End::Error);
    }

    #[test]
    fn card_answers_are_kept_and_unasked_names_wait_for_the_worker() {
        let cards = ForgeCards::new("forge 2.0.15");
        let list = |names: &[&str]| -> Vec<LabCard> { names.iter().map(|n| LabCard { name: (*n).into(), qty: 1, commander: false, oracle_id: None }).collect() };
        assert_eq!(cards.missing(vec!["A".into(), "B".into(), "A".into()]), vec!["A".to_string(), "B".to_string()]);
        cards.record(&["A".into(), "B".into()], &["B".into()]);
        assert!(cards.missing(vec!["A".into(), "B".into()]).is_empty());
        assert_eq!(cards.unknown(&list(&["A", "B", "C"]), false), vec!["B".to_string()]);
        assert_eq!(cards.unknown(&list(&["A", "B", "C"]), true), vec!["B".to_string(), "C".to_string()]);
    }
}
