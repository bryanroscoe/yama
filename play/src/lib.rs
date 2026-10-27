//! Online play for Yama, built on the phase-rs rules engine (local fork, see
//! docs/engine-integration.md).
//!
//! The server owns one [`Match`] per live game. Humans and AI choose from the same
//! engine-issued option list (`AiDecisionContract`), so a person can never submit an action
//! the engine wouldn't offer, and every applied action goes through the engine's own
//! re-validation. Where that list is only a sample (attacks, blocks, scry, search, trigger
//! order, X and the like), a person declares or answers in full instead (`declare_*`, and
//! [`act`] with the decision's [`Pending`]), checked and applied to a copy of the game first.
//! Each accepted action is appended to a replay log that reproduces the game from its seed.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use engine::ai_support::{AiDecisionContract, AiProposalApplication, apply_ai_action_proposal};
use engine::database::CardDatabase;
use engine::game::coverage::{card_face_gaps, card_face_has_unimplemented_parts};
use engine::types::card::PrintedCardRef;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::filter_state_for_viewer;
use engine::game::replay::{ReplayPlayer, reconstruct_initial_state};
use engine::types::format::FormatConfig;
use engine::game::mulligan::kept_hand_size_after;
use engine::types::game_state::{GameState, MulliganDecisionPhase, ReplacementChoiceKind, WaitingFor};
pub use engine::types::game_state::LoopDetectionMode;
use engine::types::identifiers::ObjectId;
use engine::game::ability_utils::declared_targets_in_chain;
use engine::game::combat::{AttackTarget, CombatRequirement, compute_attack_tax};
use engine::game::derived_views::derive_filtered_views;
use engine::types::ability::{AbilityCost, TargetRef};
use engine::types::keywords::Keyword;
use engine::types::zones::Zone;
use engine::types::actions::{GameAction, MulliganChoice, ResolveAllConsentDecision};
use engine::types::events::GameEvent;
use engine::types::game_state::{ActionResult, PriorityPassingMode, StackEntry, StackEntryKind};
use engine::types::log::{LogImportance, LogSegment, LogVisibility};
use engine::types::match_config::MatchConfig;
use engine::types::player::PlayerId;
use engine::types::replay::{RecordedActionKind, ReplayHeader, ReplayLog};
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{AiConfig, AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};

pub use phase_ai::config::AiDifficulty as Difficulty;

pub mod act;
pub mod feed;
pub mod lab;
pub mod library;
pub mod pay;
pub mod pilot;
pub mod rare;
pub mod remember;
pub mod together;
pub mod turns;
pub mod ways;

pub use act::{Act, Pending};
pub use feed::{Came, Happening, Out, Stats, Why};
pub use pay::{PayMode, PaymentView};
pub use remember::YamaAnswer;
pub use together::TogetherView;
pub use turns::{Controls, PassMode, ResolveAllView, TurnsView};

/// Engine build plus the card data it was built against. Stored with every game, because a
/// replay only reproduces under the same pair.
pub const ENGINE_VERSION: &str = "phase-v0.113.0+a3bc47c9-yama/cards-1e5608e6";

/// How many lines of game log each view carries.
const LOG_LINES: usize = 60;

/// Cards in an opening hand (CR 103.4).
const STARTING_HAND: usize = 7;

pub struct Engine {
    db: Arc<CardDatabase>,
}

/// A deck as the engine wants it: names, one entry per copy.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeatDeck {
    pub commander: Vec<String>,
    pub main: Vec<String>,
    /// A companion kept outside the game (CR 702.139a): the deck's first card on its sideboard
    /// with the companion keyword. The engine offers to reveal it only when the deck meets its
    /// condition.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub companion: Vec<String>,
}

/// How a new game is set up, besides its seed, decks and AI seats.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Setup {
    /// Who takes the first turn (seat 0 or 1), instead of the engine's d20 roll.
    pub first: Option<u8>,
    /// What the engine does about loops (CR 732), for the whole game:
    /// - `Off` (the engine's default): loops run until something breaks them. The lab keeps it,
    ///   so its results stay comparable.
    /// - `Interactive`, for games people play: a loop nobody can break that wins is taken to its
    ///   end at once (CR 732.2a); one somebody could break is offered as a shortcut, which each
    ///   other player accepts or shortens (CR 732.2b, c); and a loop of mandatory actions only, in
    ///   which nobody can win or lose, is a draw (CR 732.4, 104.4b).
    pub loops: LoopDetectionMode,
}

/// The loop setting games people play start with (see [`Setup::loops`]).
pub const PLAY_LOOPS: LoopDetectionMode = LoopDetectionMode::Interactive;

/// One card line from a Yama deck.
pub struct DeckLine<'a> {
    pub oracle_id: &'a str,
    pub name: &'a str,
    pub qty: u32,
    pub commander: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeckReport {
    /// Cards the engine doesn't know by oracle ID or name. They're left out of the game.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CardSupport {
    /// None of the engine's checks found a problem with this card.
    Full,
    /// No ability is marked unimplemented, but the parser left warnings on the card's text
    /// (for example a clause it swallowed) or phase's coverage check found a gap (an unknown
    /// keyword, an unsupported trigger mode…). It may not work fully.
    Uncertain,
    /// The engine loads the card, but some of its abilities aren't implemented.
    Partial,
    /// The engine doesn't know the card; it's left out of the game.
    Missing,
}

/// Engine support for one deck. Counts are copies; names are distinct. `supported` counts only
/// [`CardSupport::Full`] cards.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeckSupport {
    pub total: u32,
    pub supported: u32,
    pub missing: Vec<String>,
    pub partial: Vec<String>,
    pub uncertain: Vec<String>,
}

impl Engine {
    pub fn load(card_data: &Path) -> anyhow::Result<Self> {
        // Deserializing a complete string avoids serde_json's per-byte reader overhead.
        // Keep the full corpus: cards can discover names and types outside the deck lists.
        let json = std::fs::read_to_string(card_data).map_err(|e| anyhow::anyhow!("loading {}: {e}", card_data.display()))?;
        let db = CardDatabase::from_json_str(&json).map_err(|e| anyhow::anyhow!("loading {}: {e}", card_data.display()))?;
        Ok(Self { db: Arc::new(db) })
    }

    pub fn card_count(&self) -> usize {
        self.db.card_count()
    }

    /// The loaded card database, for batch runners (the lab) that share one across threads.
    pub fn database(&self) -> &Arc<CardDatabase> {
        &self.db
    }

    /// A deck line's engine card name: by oracle ID first, then by name.
    fn face_name(&self, l: &DeckLine) -> Option<&str> {
        self.db.get_face_by_oracle_id(l.oracle_id).or_else(|| self.db.get_face_by_name(l.name)).map(|f| f.name.as_str())
    }

    /// Map Yama's deck lines to engine card names: by oracle ID first, then by name.
    pub fn resolve_deck(&self, lines: &[DeckLine]) -> (SeatDeck, DeckReport) {
        let mut deck = SeatDeck { companion: vec![], commander: vec![], main: vec![] };
        let mut missing = vec![];
        for l in lines {
            let Some(name) = self.face_name(l) else {
                missing.push(l.name.to_string());
                continue;
            };
            let target = if l.commander { &mut deck.commander } else { &mut deck.main };
            for _ in 0..l.qty {
                target.push(name.to_string());
            }
        }
        (deck, DeckReport { missing })
    }

    /// How well the engine can play one card: by oracle ID first, then by name (as
    /// [`Engine::resolve_deck`] does), looking at every face it loaded for the card.
    ///
    /// - Partial: a face has an unimplemented part in its parsed abilities
    ///   (`card_face_has_unimplemented_parts`, the test behind phase's `is_card_playable`).
    /// - Uncertain: otherwise, a face has parse warnings or a gap in phase's per-face coverage
    ///   check (`card_face_gaps`).
    ///
    /// phase's coverage dashboard (`analyze_coverage`) also runs resolver, dropped-text and
    /// subtype checks that aren't public per card; on 2026-10-19 they flagged 128 more of its
    /// 35,925 faces, none in Bryan's decks. Passing every check still isn't proof a card plays
    /// correctly.
    pub fn card_support(&self, oracle_id: &str, name: &str) -> CardSupport {
        let Some(face) = self.db.get_face_by_oracle_id(oracle_id).or_else(|| self.db.get_face_by_name(name)) else {
            return CardSupport::Missing;
        };
        let other = face.scryfall_oracle_id.as_ref().and_then(|id| {
            self.db.get_other_face_by_printed_ref(&PrintedCardRef { oracle_id: id.clone(), face_name: face.name.clone() })
        });
        let faces = || std::iter::once(face).chain(other);
        if faces().any(card_face_has_unimplemented_parts) {
            CardSupport::Partial
        } else if faces().any(|f| !f.parse_warnings.is_empty() || !card_face_gaps(f).is_empty()) {
            CardSupport::Uncertain
        } else {
            CardSupport::Full
        }
    }

    /// Which cards in a deck (commander and main deck) the engine can't fully play.
    pub fn deck_support(&self, lines: &[DeckLine]) -> DeckSupport {
        let mut out = DeckSupport { total: 0, supported: 0, missing: vec![], partial: vec![], uncertain: vec![] };
        for l in lines {
            out.total += l.qty;
            match self.card_support(l.oracle_id, l.name) {
                CardSupport::Full => out.supported += l.qty,
                CardSupport::Uncertain => out.uncertain.push(l.name.to_string()),
                CardSupport::Partial => out.partial.push(l.name.to_string()),
                CardSupport::Missing => out.missing.push(l.name.to_string()),
            }
        }
        for names in [&mut out.missing, &mut out.partial, &mut out.uncertain] {
            names.sort();
            names.dedup();
        }
        out
    }

    /// A deck's companion (CR 702.139a): the first card on its sideboard (`lines`) that the engine
    /// knows has the companion keyword, by the engine's name. The engine offers to reveal it before
    /// the game only when the deck meets its condition.
    pub fn companion_of(&self, lines: &[DeckLine]) -> Option<String> {
        lines.iter().find_map(|l| {
            let face = self.db.get_face_by_oracle_id(l.oracle_id).or_else(|| self.db.get_face_by_name(l.name))?;
            face.keywords.iter().any(|k| matches!(k, Keyword::Companion(_))).then(|| face.name.clone())
        })
    }

    /// The names in `lines` the engine doesn't know, as [`Engine::resolve_deck`] reports them, but
    /// without building the deck: one lookup per line, whatever its quantity.
    pub fn unknown_cards(&self, lines: &[DeckLine]) -> Vec<String> {
        lines.iter().filter(|l| self.face_name(l).is_none()).map(|l| l.name.to_string()).collect()
    }

    /// Start a Commander game. Seat order is the order of `decks`. Loop detection stays off
    /// ([`Setup`]); games people play start with [`Engine::new_match_with`].
    pub fn new_match(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
        self.new_match_first(seed, decks, ai, None)
    }

    /// [`Engine::new_match`], with `first` taking the first turn instead of the engine's roll.
    /// phase's game setup only honours seat 0 or 1 here; to start anyone else, rotate the decks
    /// so that player is seat 0 (turn order is the same cycle).
    pub fn new_match_first(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)], first: Option<u8>) -> anyhow::Result<Match> {
        self.new_match_with(seed, decks, ai, Setup { first, ..Setup::default() })
    }

    /// Start a Commander game with the given [`Setup`].
    pub fn new_match_with(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)], setup: Setup) -> anyhow::Result<Match> {
        let Setup { first, loops } = setup;
        if first.is_some_and(|f| f > 1) {
            bail!("phase can only start seat 0 or 1; rotate the seats so the first player is seat 0");
        }
        if !(2..=6).contains(&decks.len()) {
            bail!("Commander games here have 2 to 6 players");
        }
        let lists: Vec<PlayerDeckList> = decks
            .into_iter()
            .map(|d| PlayerDeckList { main_deck: d.main, commander: d.commander, companion: d.companion, ..Default::default() })
            .collect();
        let player_count = lists.len() as u8;
        let mut it = lists.into_iter();
        let deck_list = DeckList {
            player: it.next().unwrap(),
            opponent: it.next().unwrap(),
            ai_decks: it.collect(),
            ..Default::default()
        };
        let header = ReplayHeader {
            format_config: FormatConfig::commander(),
            // The loop setting lives in the header, so the saved replay log carries it: a resumed
            // or replayed game uses the mode it started with, and a log from before the setting
            // (no `loop_detection` key) reads as off.
            match_config: MatchConfig { loop_detection: loops, ..MatchConfig::default() },
            player_count,
            first_player: first,
            seed,
            deck_data: Some(deck_list),
        };
        self.start(header, ai)
    }

    /// Rebuild a live game from its saved replay log (after a server restart).
    pub fn resume(&self, replay_json: &str, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
        let log: ReplayLog = serde_json::from_str(replay_json).context("reading replay log")?;
        let mut m = self.start(log.header.clone(), ai)?;
        let mut player = ReplayPlayer::load(log.clone(), Some(&self.db)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let n = player.len();
        if log.resolve_all_boundaries.is_empty() {
            // Step through the log exactly as the replayer does (`ReplayPlayer::seek`), keeping each
            // action's events, so the feed, the knockouts and the stats come back too (feed.rs).
            m.state = player.seek(0).map_err(|e| anyhow::anyhow!("replay diverged: {e:?}"))?.clone();
            for recorded in &log.actions {
                let applied = match recorded.kind {
                    RecordedActionKind::Submitted => engine::game::engine::apply(&mut m.state, recorded.actor, recorded.action.clone()),
                    RecordedActionKind::VerifiedAiPriorityPass { semantic_owner } => {
                        let contract = AiDecisionContract::issue(&m.state, semantic_owner);
                        apply_verified_ai_priority_pass(&mut m.state, recorded.actor, &contract, recorded.action.clone())
                    }
                };
                let result = applied.map_err(|e| anyhow::anyhow!("replay diverged at action {}: {e}", recorded.seq))?;
                if let GameAction::Concede { player_id } = &recorded.action {
                    m.conceded.insert(player_id.0);
                }
                m.replayed(&result);
            }
        } else {
            // Resolve All boundaries need the replayer's own handling; Yama never writes them.
            m.state = player.seek(n).map_err(|e| anyhow::anyhow!("replay diverged: {e:?}"))?.clone();
        }
        m.state.debug_mode = false;
        m.state.all_card_names = self.db.card_names().into();
        engine::game::install_card_db(&mut m.state, Arc::clone(&self.db));
        m.session = AiSession::arc_from_game(&m.state);
        m.rng = StdRng::seed_from_u64(log.header.seed ^ u64::from(n));
        m.revision = u64::from(n);
        // Conceding leaves no mark in the engine's state; the log says who did.
        m.conceded = log
            .actions
            .iter()
            .filter_map(|a| match &a.action {
                GameAction::Concede { player_id } => Some(player_id.0),
                _ => None,
            })
            .collect();
        m.log = log;
        m.remark(None);
        m.auto_watch = m.watch_automatic_answers();
        Ok(m)
    }

    fn start(&self, header: ReplayHeader, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
        let mut state = reconstruct_initial_state(&header, Some(&self.db)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        // Replays are reconstructed in debug mode; a live server game never is.
        state.debug_mode = false;
        state.all_card_names = self.db.card_names().into();
        let players = header.player_count;
        let ai_configs = ai.iter().map(|(seat, d)| (PlayerId(*seat), ai_config(*d, players, header.seed, AI_CLOCK))).collect();
        let session = AiSession::arc_from_game(&state);
        let mut m = Match {
            rng: StdRng::seed_from_u64(header.seed ^ 0x9e37_79b9_7f4a_7c15),
            log: ReplayLog::new(header),
            state,
            session,
            ai: ai_configs,
            revision: 0,
            lines: Vec::new(),
            names: (1..=players).map(|n| format!("Player {n}")).collect(),
            fallback: false,
            ai_thinking: std::time::Duration::ZERO,
            turn_began: (0, 0),
            moved_on: (0, 0),
            stall_limit: STALL_ACTION_LIMIT,
            costs: Costs::default(),
            marks: HashMap::new(),
            controls: HashMap::new(),
            conceded: BTreeSet::new(),
            auto_watch: Vec::new(),
            kept: HashMap::new(),
            feed: feed::Feed::default(),
            facing: None,
            remembered: Vec::new(),
            remembered_tried: None,
        };
        m.turn_began = (m.state.turn_number, 0);
        m.moved_on = (progress_mark(&m.state), 0);
        m.remark(None);
        Ok(m)
    }
}

/// A live game.
pub struct Match {
    state: GameState,
    log: ReplayLog,
    session: Arc<AiSession>,
    ai: HashMap<PlayerId, AiConfig>,
    /// Only for settling a physical contest among AI seats in games nobody replays
    /// ([`Match::settle_ai_contest`]); each AI decision gets its own ([`ai_rng`]).
    rng: StdRng,
    /// Bumped on every accepted action. Clients send it back so a stale tap is refused.
    pub revision: u64,
    lines: Vec<LogLine>,
    names: Vec<String>,
    /// When the AI finds no action, answer with phase's `fallback_action` instead of stopping
    /// (as the lab does). Off for games people play in; on for games everyone just watches.
    fallback: bool,
    /// Each person's current decision: what it looked like and the revision it was issued at.
    marks: HashMap<u8, Mark>,
    /// Each person's turn controls (turns.rs): stops, full control, a pass mode, holding priority.
    controls: HashMap<u8, Controls>,
    /// Seats that conceded (CR 104.3a), as opposed to losing; read back from the replay log.
    conceded: BTreeSet<u8>,
    /// Remembered answers the engine is about to give for people (turns.rs, `AutoWatch`).
    auto_watch: Vec<turns::AutoWatch>,
    /// Mana sources each person tapped by hand during the payment in progress that can't be
    /// undone (a painland's damage, a sacrificed Treasure), for the payment's note (pay.rs).
    kept: HashMap<u8, Vec<pay::Kept>>,
    /// What happened, for each viewer, with the knockouts and the game's numbers (feed.rs).
    feed: feed::Feed,
    /// Who faces the villainous choice now resolving, from its first prompt (together.rs): the
    /// engine keeps only who is choosing and who is still to choose.
    facing: Option<(ObjectId, Vec<PlayerId>)>,
    /// The answers Yama gives for people from memory ("Always pay for Rhystic Study"; remember.rs),
    /// saved with the game.
    remembered: Vec<remember::YamaAnswer>,
    /// A remembered answer Yama couldn't give for this seat's decision at this revision (it
    /// couldn't pay, or the engine refused): they're asked instead.
    remembered_tried: Option<(u8, u64)>,
    /// The CPU time the AI spent choosing during the last [`Match::run_ai`] ([`Busy`]).
    ai_thinking: std::time::Duration,
    /// The turn in progress, and how many actions the replay log held when it began
    /// ([`TURN_ACTION_LIMIT`]).
    turn_began: (u32, usize),
    /// The board's last [`progress_mark`], and how many actions the log held when it changed.
    moved_on: (u64, usize),
    /// Actions in a row with nothing changing on the board before the AI stops
    /// ([`STALL_ACTION_LIMIT`]).
    stall_limit: usize,
    /// CPU time spent in Yama's bookkeeping after each action ([`Match::take_costs`]).
    costs: Costs,
}

/// CPU time Yama's bookkeeping took after accepted actions, since the last
/// [`Match::take_costs`]: for benchmarks.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Costs {
    /// Telling every viewer what happened (feed.rs): each viewer's filtered copy of the game.
    pub feed: std::time::Duration,
    /// Re-issuing each person's decision to see whether it changed (`remark`).
    pub remark: std::time::Duration,
}

/// A person's decision as of its issue (see [`Decision::revision`]).
#[derive(Debug, Clone, Copy)]
struct Mark {
    fingerprint: u64,
    revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub turn: u32,
    pub text: String,
    /// Only this seat sees the line (an answer Yama gave for them). Everyone sees the rest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat: Option<u8>,
    /// An answer given automatically: its id in that seat's `TurnsView::answers`, so the line
    /// can turn it off (GLog).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<String>,
}

impl LogLine {
    fn public(turn: u32, text: String) -> Self {
        LogLine { turn, text, seat: None, auto: None }
    }
}

/// Where a person wants the game to stop for them, by step (phase's names, e.g.
/// "PreCombatMain"), on their own turns and on everyone else's. Replaces the default smart
/// stops (main phases, and an opponent's end step when a spell could be cast). Anything on the
/// stack they could answer, and every decision other than priority, still waits for them.
/// Sorted, so a seat's view comes out the same every time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stops {
    #[serde(default)]
    pub own: BTreeSet<String>,
    #[serde(default)]
    pub others: BTreeSet<String>,
}

/// What one seat may do right now.
#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    /// The revision this seat's decision was issued at. It stays the same while other seats act
    /// and this decision doesn't change (two people mulliganing at once), so an answer to it is
    /// still taken (PP-06).
    pub revision: u64,
    /// The kind of decision, e.g. "priority" or "declare attackers".
    pub prompt: String,
    pub options: Vec<OptionView>,
    /// While keeping or mulliganing: the hand sizes the buttons name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mulligan: Option<MulliganView>,
    /// The decision in Yama's own small types, for the kinds answered with [`Match::act`]
    /// (cards to pick, triggers to order, X, modes, targets, may prompts, damage splits). Read
    /// from this seat's view, so it names only cards this seat may see. Absent for decisions
    /// only the option buttons answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
    /// While declaring attackers: every creature that may attack and whom it may attack, so the
    /// board can build any declaration (the option list holds only the engine's sample).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attack: Option<AttackChoice>,
    /// While declaring blockers: every creature that may block and the attackers it may block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockChoice>,
    /// While paying: the cost, the pool and the sources this seat can use (pay.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<PaymentView>,
}

/// A person's move as the board sends it, each with the decision's revision ([`Match::ai_move_for`]).
#[doc(hidden)]
#[derive(Debug, Clone)]
pub enum PersonMove {
    /// One of the decision's options, by index (`choose`).
    Option(u64, usize),
    /// An attack declaration (`attack`).
    Attack(u64, Vec<(u64, AttackAt)>),
    /// A block declaration (`block`).
    Block(u64, Vec<(u64, u64)>),
    /// A full answer (`act`).
    Act(u64, Act),
}

/// The opening hand decision, from the engine's mulligan count and the bottom cards it would
/// take: "Keep 6" after a second mulligan in Commander, where the first one is free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MulliganView {
    /// Cards you keep if you keep now.
    pub keep: usize,
    /// Cards you'd keep after one more mulligan.
    pub next_keep: usize,
    /// Mulligans taken so far.
    pub mulligans: u8,
    /// The next mulligan is free (CR 103.5c).
    pub free: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttackChoice {
    pub attackers: Vec<AttackerChoice>,
    /// Creatures something says can't attack (CR 508.1c: Pacifism and the like), for their badge.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cant: Vec<Held>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttackerChoice {
    pub id: u64,
    /// Whom this creature may attack, as the engine lists them.
    pub targets: Vec<AttackAt>,
    /// It attacks this combat if able (CR 508.1d): the defenders it must attack, or an empty list
    /// when any of `targets` will do. The engine refuses a declaration that leaves it home.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub must: Option<Vec<AttackAt>>,
    /// The cards that make it attack, by name (empty for goad, which names no card).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub because: Vec<String>,
    /// What attacking each target costs, where something taxes it (Propaganda, Ghostly Prison;
    /// CR 508.1d), printed: "{2}". The engine asks for the total once the attack is declared.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub taxes: Vec<(AttackAt, String)>,
}

/// A creature a restriction holds back (it can't attack, or can't block), and the cards that do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Held {
    pub id: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub because: Vec<String>,
}

/// An attack target as the board names it: a player by seat, or a planeswalker or battle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttackAt {
    Player { seat: u8 },
    Planeswalker { id: u64 },
    Battle { id: u64 },
}

impl AttackAt {
    fn from_engine(t: &AttackTarget) -> Self {
        match t {
            AttackTarget::Player(p) => Self::Player { seat: p.0 },
            AttackTarget::Planeswalker(id) => Self::Planeswalker { id: id.0 },
            AttackTarget::Battle(id) => Self::Battle { id: id.0 },
        }
    }
    fn to_engine(self) -> AttackTarget {
        match self {
            Self::Player { seat } => AttackTarget::Player(PlayerId(seat)),
            Self::Planeswalker { id } => AttackTarget::Planeswalker(ObjectId(id)),
            Self::Battle { id } => AttackTarget::Battle(ObjectId(id)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockChoice {
    pub blockers: Vec<BlockerChoice>,
    /// Attackers that need more than one blocker, and how many (menace, CR 702.111b).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<(u64, u32)>,
    /// Creatures something says can't block (CR 509.1b), for their badge.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cant: Vec<Held>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockerChoice {
    pub id: u64,
    /// The attacking creatures this one may block.
    pub attackers: Vec<u64>,
    /// It blocks this combat if able (CR 509.1c).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub must: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionView {
    pub index: usize,
    pub label: String,
    /// What kind of option it is, so the board needn't read labels.
    pub kind: OptionKind,
    /// The card this option is about, so the board can offer it when you tap that card.
    pub object: Option<u64>,
    /// For an activated ability, which of the card's abilities (a planeswalker has several), so
    /// options for different abilities never merge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ability: Option<usize>,
    /// For a target choice, exactly which card or player it targets, so the board can pick the
    /// right one of several cards with the same name (clicking or dragging onto it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetView>,
    /// What a special action costs, printed ("{1}{U}" for ninjutsu, "{2}{W}{W}" to turn a card
    /// face up), where Yama words it (rare.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<String>,
}

/// What an option does, for the board's buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionKind {
    /// Pass priority: move on, or let the stack resolve.
    Pass,
    /// While paying mana by hand: let Yama pay the rest (the engine's pass during payment).
    PayRest,
    /// Back out of a spell or ability being cast.
    Cancel,
    Land,
    Spell,
    Ability,
    Keep,
    Mulligan,
    Attack,
    Block,
    Target,
    /// Someone asked to resolve the whole stack: agree (GTogether's consent tab).
    Agree,
    /// ... or keep your chance to act.
    Refuse,
    // Special actions (rare.rs; GRareCards, GRareRules), answered with their own `act`.
    /// Ninjutsu: a card in hand for an unblocked attacker (`target` is the attacker).
    Ninjutsu,
    /// Turn a face-down permanent face up.
    FaceUp,
    /// Foretell a card from hand.
    Foretell,
    /// Pay {3} to put your companion into your hand.
    Companion,
    /// Serum Powder at the mulligan.
    SerumPowder,
    Other,
}

impl OptionKind {
    fn of(action: &GameAction, waiting: &WaitingFor) -> Self {
        match action {
            GameAction::RespondResolveAllConsent { decision: ResolveAllConsentDecision::Grant, .. } => Self::Agree,
            GameAction::RespondResolveAllConsent { decision: ResolveAllConsentDecision::Decline, .. } => Self::Refuse,
            GameAction::PassPriority if matches!(waiting, WaitingFor::ManaPayment { .. }) => Self::PayRest,
            GameAction::PassPriority => Self::Pass,
            GameAction::CancelCast => Self::Cancel,
            GameAction::PlayLand { .. } => Self::Land,
            GameAction::CastSpell { .. } => Self::Spell,
            GameAction::ActivateAbility { .. } => Self::Ability,
            GameAction::MulliganDecision { choice: MulliganChoice::Keep } => Self::Keep,
            GameAction::MulliganDecision { choice: MulliganChoice::Mulligan } => Self::Mulligan,
            GameAction::DeclareAttackers { .. } => Self::Attack,
            GameAction::DeclareBlockers { .. } => Self::Block,
            GameAction::ChooseTarget { .. } | GameAction::SelectTargets { .. } => Self::Target,
            GameAction::ActivateNinjutsu { .. } => Self::Ninjutsu,
            GameAction::TurnFaceUp { .. } => Self::FaceUp,
            GameAction::Foretell { .. } => Self::Foretell,
            GameAction::CompanionToHand => Self::Companion,
            GameAction::MulliganDecision { choice: MulliganChoice::UseSerumPowder { .. } } => Self::SerumPowder,
            _ => Self::Other,
        }
    }
}

/// A target on an option: a card by object id, or a player by seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TargetView {
    Object { id: u64 },
    Player { seat: u8 },
}

impl TargetView {
    /// The one target an option picks, if it's a target choice with a single target.
    fn of(action: &GameAction) -> Option<TargetView> {
        let t = match action {
            GameAction::ChooseTarget { target: Some(t) } => t,
            GameAction::SelectTargets { targets } if targets.len() == 1 => &targets[0],
            _ => return None,
        };
        Some(match t {
            TargetRef::Object(id) => TargetView::Object { id: id.0 },
            TargetRef::Player(p) => TargetView::Player { seat: p.0 },
        })
    }
}

#[derive(Debug)]
pub enum ChoiceError {
    NotYourTurn,
    Stale,
    BadIndex,
    Rejected(String),
    /// An answer that doesn't fit the decision, in a sentence a player can read.
    DoesntFit(String),
}

impl std::fmt::Display for ChoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotYourTurn => f.write_str("it isn't your decision"),
            Self::Stale => f.write_str("the game moved on; pick again"),
            Self::BadIndex => f.write_str("that option doesn't exist"),
            Self::Rejected(why) => write!(f, "the engine refused that: {why}"),
            Self::DoesntFit(why) => f.write_str(why),
        }
    }
}

impl Match {
    /// Display names by seat, for option labels.
    pub fn set_names(&mut self, names: Vec<String>) {
        self.names = names;
    }

    pub fn player_count(&self) -> usize {
        self.state.players.len()
    }

    pub fn is_ai(&self, seat: u8) -> bool {
        self.ai.contains_key(&PlayerId(seat))
    }

    pub fn seed(&self) -> u64 {
        self.log.header.seed
    }

    /// Seats that must decide now (several during simultaneous choices such as mulligans).
    pub fn waiting_on(&self) -> Vec<u8> {
        self.state.waiting_for.acting_players().into_iter().map(|p| p.0).collect()
    }

    pub fn is_over(&self) -> bool {
        matches!(self.state.waiting_for, WaitingFor::GameOver { .. })
    }

    pub fn winner(&self) -> Option<u8> {
        self.state.game_end.as_ref().and_then(|e| e.winner).map(|p| p.0)
    }

    pub fn turn(&self) -> u32 {
        self.state.turn_number
    }

    /// The seat that took the first turn (the engine picks it when the game starts).
    pub fn starting_seat(&self) -> u8 {
        self.state.current_starting_player.0
    }

    /// Options for `seat`, or `None` if it isn't that seat's decision.
    pub fn decision(&self, seat: u8) -> Option<Decision> {
        if !self.state.waiting_for.acting_players().contains(&PlayerId(seat)) {
            return None;
        }
        // Labels come from what this seat may see, never the full state.
        self.decision_seen(&filter_state_for_viewer(&self.state, PlayerId(seat)), seat)
    }

    /// [`Match::decision`], given `vs`, the game as `seat` may see it (a view has made it already).
    fn decision_seen(&self, vs: &GameState, seat: u8) -> Option<Decision> {
        let me = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&me) {
            return None;
        }
        let contract = AiDecisionContract::issue(&self.state, me);
        let mut options: Vec<OptionView> = contract
            .candidates
            .iter()
            .enumerate()
            .map(|(index, c)| {
                // The rarer special actions word themselves and carry their cost (rare.rs).
                let (label, cost) = rare::label(&vs, &c.action, &self.names).unwrap_or_else(|| (self.label(&vs, &c.action), None));
                OptionView {
                    index,
                    label,
                    kind: OptionKind::of(&c.action, &vs.waiting_for),
                    object: c.action.source_object().map(|o| o.0).or_else(|| rare::option_object(&c.action)),
                    ability: match c.action {
                        GameAction::ActivateAbility { ability_index, .. } => Some(ability_index),
                        _ => None,
                    },
                    target: TargetView::of(&c.action).or_else(|| rare::option_target(&c.action)),
                    cost,
                }
            })
            .collect();
        self.tell_targets_apart(&vs, me, &mut options);
        let (attack, block) = Self::combat_choices(&vs, me);
        let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
        Some(Decision {
            revision: self.decision_revision(seat),
            prompt: self.prompt(&vs),
            options,
            mulligan: Self::mulligan_view(&vs, me),
            pending: Pending::of(&vs, me, &candidates, &self.names).map(|p| together::with_clash_cards(ways::with_resolving_source(p, &self.state, &vs), &self.state)),
            payment: PaymentView::of(&self.state, &vs, me, &candidates, self.kept.get(&seat).map(Vec::as_slice).unwrap_or_default()),
            attack,
            block,
        })
    }

    /// Hand sizes for the keep and mulligan buttons, from the engine's mulligan count and the
    /// bottom cards it would ask for (CR 103.5, the free first mulligan of CR 103.5c).
    fn mulligan_view(vs: &GameState, me: PlayerId) -> Option<MulliganView> {
        let WaitingFor::MulliganDecision { pending, free_first_mulligan, .. } = &vs.waiting_for else { return None };
        let entry = pending.iter().find(|e| e.player == me && e.phase == MulliganDecisionPhase::Declare)?;
        let hand = vs.players.iter().find(|p| p.id == me).map(|p| p.hand.len()).unwrap_or(0);
        let kept = kept_hand_size_after(entry.mulligan_count, *free_first_mulligan);
        // Bottom cards already put away count against what's owed (the engine's ledger).
        let prepaid = usize::from(vs.prepaid_mulligan_bottoms.get(&me).copied().unwrap_or(0));
        let owed = STARTING_HAND.saturating_sub(kept).saturating_sub(prepaid);
        Some(MulliganView {
            keep: hand.saturating_sub(owed),
            next_keep: kept_hand_size_after(entry.mulligan_count.saturating_add(1), *free_first_mulligan),
            mulligans: entry.mulligan_count,
            free: *free_first_mulligan && entry.mulligan_count == 0,
        })
    }

    /// The revision `seat`'s current decision was issued at (see [`Decision::revision`]).
    fn decision_revision(&self, seat: u8) -> u64 {
        self.marks.get(&seat).map(|m| m.revision).unwrap_or(self.revision)
    }

    /// Whether an answer sent at `revision` still answers `seat`'s current decision.
    fn current(&self, seat: u8, revision: u64) -> bool {
        revision == self.revision || revision == self.decision_revision(seat)
    }

    /// What `seat`'s decision looks like, to tell whether it changed: the engine's options for
    /// it, and for a mulligan the seat's own entry (the others' entries change as they decide).
    fn fingerprint(&self, seat: u8) -> u64 {
        use std::hash::{Hash, Hasher};
        let me = PlayerId(seat);
        let contract = AiDecisionContract::issue(&self.state, me);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for c in &contract.candidates {
            serde_json::to_string(&c.action).unwrap_or_default().hash(&mut h);
        }
        match &self.state.waiting_for {
            WaitingFor::MulliganDecision { pending, .. } => {
                serde_json::to_string(&pending.iter().find(|e| e.player == me)).unwrap_or_default().hash(&mut h);
            }
            other => std::mem::discriminant(other).hash(&mut h),
        }
        h.finish()
    }

    /// After an accepted action: keep the issue revision of every person's decision that didn't
    /// change, and start a new one for any that did. `acted` (the seat that just answered) always
    /// gets a new one, even if its next decision looks the same.
    fn remark(&mut self, acted: Option<u8>) {
        let mut next = HashMap::new();
        for seat in self.waiting_on() {
            if self.is_ai(seat) {
                continue;
            }
            let fingerprint = self.fingerprint(seat);
            let keep = self.marks.get(&seat).filter(|m| m.fingerprint == fingerprint && Some(seat) != acted).map(|m| m.revision);
            next.insert(seat, Mark { fingerprint, revision: keep.unwrap_or(self.revision) });
        }
        self.marks = next;
    }

    /// Two target options that would read the same ("Target Savannah Lions") say whose card each
    /// is: "Target Savannah Lions (yours)", "Target Savannah Lions (Sam's)".
    fn tell_targets_apart(&self, vs: &GameState, me: PlayerId, options: &mut [OptionView]) {
        let mut seen: HashMap<String, usize> = HashMap::new();
        for o in options.iter().filter(|o| matches!(o.target, Some(TargetView::Object { .. }))) {
            *seen.entry(o.label.clone()).or_default() += 1;
        }
        for o in options.iter_mut() {
            let Some(TargetView::Object { id }) = o.target else { continue };
            if seen.get(&o.label).copied().unwrap_or(0) < 2 {
                continue;
            }
            if let Some(obj) = vs.objects.get(&ObjectId(id)) {
                let whose = if obj.controller == me { "yours".to_string() } else { format!("{}'s", self.seat_name(obj.controller)) };
                o.label = format!("{} ({whose})", o.label);
            }
        }
    }

    /// The engine's own lists of who may attack (and whom) or block (and what), when `me` is
    /// declaring. They come from the seat's filtered view and name only public permanents.
    fn combat_choices(vs: &GameState, me: PlayerId) -> (Option<AttackChoice>, Option<BlockChoice>) {
        let names = |ids: &[ObjectId]| -> Vec<String> { ids.iter().map(|id| Self::name_in(vs, id)).collect() };
        match &vs.waiting_for {
            WaitingFor::DeclareAttackers {
                player, valid_attacker_ids, valid_attack_targets, valid_attack_targets_by_attacker, attacker_constraints, ..
            } if *player == me =>
            {
                let attackers = valid_attacker_ids
                    .iter()
                    .map(|id| {
                        // Older states have no per-attacker map; fall back to the shared list.
                        let targets: Vec<AttackTarget> = match valid_attack_targets_by_attacker {
                            Some(by) => by.get(id).cloned().unwrap_or_default(),
                            None => valid_attack_targets.clone(),
                        };
                        let (must, because) = match attacker_constraints.get(id) {
                            Some(CombatRequirement::MustAttack { defenders, sources }) => {
                                (Some(defenders.iter().map(AttackAt::from_engine).collect()), names(sources))
                            }
                            _ => (None, vec![]),
                        };
                        // Each target's tax on its own: the engine's per-creature breakdown, so the
                        // board can total it as the attack is aimed.
                        let taxes = targets
                            .iter()
                            .filter_map(|t| {
                                let (total, _) = compute_attack_tax(vs, &[(*id, *t)])?;
                                let printed = phase_llm::render::text::mana_cost_text(&total);
                                (!printed.is_empty()).then(|| (AttackAt::from_engine(t), printed))
                            })
                            .collect();
                        AttackerChoice { id: id.0, targets: targets.iter().map(AttackAt::from_engine).collect(), must, because, taxes }
                    })
                    .filter(|a| !a.targets.is_empty())
                    .collect();
                let mut cant: Vec<Held> = attacker_constraints
                    .iter()
                    .filter_map(|(id, c)| match c {
                        CombatRequirement::CantAttack { sources } => Some(Held { id: id.0, because: names(sources) }),
                        _ => None,
                    })
                    .collect();
                cant.sort_by_key(|h| h.id);
                (Some(AttackChoice { attackers, cant }), None)
            }
            WaitingFor::DeclareBlockers { player, valid_blocker_ids, valid_block_targets, block_requirements, blocker_constraints, .. }
                if *player == me =>
            {
                let blockers = valid_blocker_ids
                    .iter()
                    .map(|id| {
                        let mut attackers: Vec<u64> = valid_block_targets.get(id).map(|a| a.iter().map(|o| o.0).collect()).unwrap_or_default();
                        attackers.sort_unstable();
                        let must = matches!(blocker_constraints.get(id), Some(CombatRequirement::MustBlock { .. }));
                        BlockerChoice { id: id.0, attackers, must }
                    })
                    .filter(|b| !b.attackers.is_empty())
                    .collect();
                let mut needs: Vec<(u64, u32)> = block_requirements.iter().filter(|(_, r)| r.count > 1).map(|(id, r)| (id.0, r.count)).collect();
                needs.sort_unstable();
                let mut cant: Vec<Held> = blocker_constraints
                    .iter()
                    .filter_map(|(id, c)| match c {
                        CombatRequirement::CantBlock { sources } => Some(Held { id: id.0, because: names(sources) }),
                        _ => None,
                    })
                    .collect();
                cant.sort_by_key(|h| h.id);
                (None, Some(BlockChoice { blockers, needs, cant }))
            }
            _ => (None, None),
        }
    }

    /// What the current decision is about, naming the card behind it when the engine says.
    fn prompt(&self, vs: &GameState) -> String {
        let kind = phase_llm::render::action::describe_waiting_for(&vs.waiting_for);
        // Look for the source card at the top level, then one level down (tagged enums).
        let source = serde_json::to_value(&vs.waiting_for).ok().and_then(|v| {
            let top = v.as_object()?;
            std::iter::once(top)
                .chain(top.values().filter_map(|inner| inner.as_object()))
                .find_map(|fields| ["source_id", "source", "object_id"].iter().find_map(|k| fields.get(*k).and_then(|id| id.as_u64())))
                .map(|id| Self::name_in(vs, &ObjectId(id)))
        });
        match source {
            Some(name) => format!("{kind}: {name}"),
            None => kind,
        }
    }

    /// Recent public log lines, for saving alongside the replay.
    pub fn log_lines(&self) -> &[LogLine] {
        &self.lines
    }

    /// Restore saved log lines after a resume (replaying doesn't regenerate them).
    pub fn set_log_lines(&mut self, lines: Vec<LogLine>) {
        self.lines = lines;
    }

    /// Apply a human choice by its index in [`Match::decision`].
    pub fn choose(&mut self, seat: u8, revision: u64, index: usize) -> Result<(), ChoiceError> {
        if !self.current(seat, revision) {
            return Err(ChoiceError::Stale);
        }
        let owner = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&owner) {
            return Err(ChoiceError::NotYourTurn);
        }
        let contract = AiDecisionContract::issue(&self.state, owner);
        self.choose_issued(seat, contract, index)
    }

    /// [`Match::choose`], with `seat`'s decision already issued for the game as it stands.
    fn choose_issued(&mut self, seat: u8, contract: AiDecisionContract, index: usize) -> Result<(), ChoiceError> {
        let owner = PlayerId(seat);
        let action = contract.candidates.get(index).ok_or(ChoiceError::BadIndex)?.action.clone();
        let actor = contract.authorized_actor;
        // Passing over your own spell (or an empty stack) ends holding priority; passing over
        // someone else's response doesn't, so you're still asked before your own resolves.
        let passed = matches!(action, GameAction::PassPriority)
            && matches!(self.state.waiting_for, WaitingFor::Priority { .. })
            && self.state.stack.last().is_none_or(|top| top.controller == owner);
        if self.plain_passes() && matches!(action, GameAction::PassPriority) {
            if !contract.permits(&self.state, actor, &action) {
                return Err(ChoiceError::Stale);
            }
            let result = apply_interaction(&mut self.state, actor, owner, action.clone())
                .map_err(|e| ChoiceError::Rejected(self.plain_reason(owner, &e.to_string())))?;
            self.log.push_action(actor, action);
            self.accepted(&result, Some(seat));
            if passed && self.controls.get(&seat).is_some_and(|c| c.hold) {
                self.set_hold(seat, false);
            }
            return Ok(());
        }
        match apply_ai_action_proposal(&mut self.state, &contract, actor, action.clone()) {
            AiProposalApplication::AppliedStackPass { result } => {
                self.log.push_verified_ai_priority_pass(actor, owner);
                self.accepted(&result, Some(seat));
            }
            AiProposalApplication::AppliedAction { result } => {
                self.log.push_action(actor, action);
                self.accepted(&result, Some(seat));
            }
            AiProposalApplication::Stale => return Err(ChoiceError::Stale),
            AiProposalApplication::Rejected { rejection } => return Err(ChoiceError::Rejected(format!("{rejection:?}"))),
        }
        // Holding priority lasts until you pass over your own spell.
        if passed && self.controls.get(&seat).is_some_and(|c| c.hold) {
            self.set_hold(seat, false);
        }
        Ok(())
    }

    /// Declare any set of attackers, not only the engine's sample. The engine validates the
    /// declaration (CR 508.1) and refuses an illegal one; an empty list declares no attack.
    pub fn declare_attackers(&mut self, seat: u8, revision: u64, attacks: &[(u64, AttackAt)]) -> Result<(), ChoiceError> {
        let action = GameAction::DeclareAttackers {
            attacks: attacks.iter().map(|(id, at)| (ObjectId(*id), at.to_engine())).collect(),
            bands: vec![],
        };
        self.declare(seat, revision, action, |w| matches!(w, WaitingFor::DeclareAttackers { .. }))
    }

    /// Declare any set of blocks as (blocker, attacker) pairs. The engine validates them
    /// (CR 509.1, menace and the like); an empty list declares no blocks.
    pub fn declare_blockers(&mut self, seat: u8, revision: u64, blocks: &[(u64, u64)]) -> Result<(), ChoiceError> {
        let action = GameAction::DeclareBlockers { assignments: blocks.iter().map(|(b, a)| (ObjectId(*b), ObjectId(*a))).collect() };
        self.declare(seat, revision, action, |w| matches!(w, WaitingFor::DeclareBlockers { .. }))
    }

    fn declare(&mut self, seat: u8, revision: u64, action: GameAction, expected: impl Fn(&WaitingFor) -> bool) -> Result<(), ChoiceError> {
        if !self.current(seat, revision) {
            return Err(ChoiceError::Stale);
        }
        let owner = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&owner) {
            return Err(ChoiceError::NotYourTurn);
        }
        if !expected(&self.state.waiting_for) {
            return Err(ChoiceError::Stale);
        }
        let actor = AiDecisionContract::issue(&self.state, owner).authorized_actor;
        // Apply to a copy first, so a refused declaration leaves the game exactly as it was.
        let mut next = self.state.clone();
        match apply_interaction(&mut next, actor, owner, action.clone()) {
            Ok(result) => {
                self.state = next;
                self.log.push_action(actor, action);
                self.accepted(&result, Some(seat));
                Ok(())
            }
            Err(e) => Err(ChoiceError::Rejected(self.plain_reason(owner, &e.to_string()))),
        }
    }

    /// Answer `seat`'s decision with `answer` (the client's `act` message). It must fit the
    /// decision's [`Pending`] (or be a cancel the engine offers), and is applied to a copy of the
    /// game first, so a refused answer leaves the game exactly as it was.
    ///
    /// A seat's own setting ([`Act::is_preference`]: turning off a remembered answer, a trigger
    /// yield, hand order) can be sent at any time, whoever is deciding, so it carries no
    /// revision check, and it leaves everyone's decision as it was.
    pub fn act(&mut self, seat: u8, revision: u64, answer: &Act) -> Result<(), ChoiceError> {
        let preference = answer.is_preference();
        if !preference && !self.current(seat, revision) {
            return Err(ChoiceError::Stale);
        }
        // A tap by hand that can't be undone is noted for the payment (a painland's damage, a
        // sacrificed Treasure): what the engine would do, read before it does it.
        let kept = match answer {
            Act::TapMana { source, choice } => self.kept_by(seat, *source, choice.as_deref()),
            _ => None,
        };
        // Yama's own remembered answers (remember.rs): turning one off changes nothing in the game.
        if let Act::ForgetAnswer { id } = answer {
            return self.forget_answer(seat, id).map_err(ChoiceError::DoesntFit);
        }
        let answered = match answer {
            Act::RememberAnswer { accept } => self.remember_answer(seat, *accept),
            _ => act::answer(&mut self.state, PlayerId(seat), answer),
        };
        match answered {
            Ok(done) => {
                for action in done.actions {
                    self.log.push_action(done.actor, action);
                }
                self.accepted(&done.result, (!preference).then_some(seat));
                if let Some(k) = kept {
                    self.kept.entry(seat).or_default().push(k);
                }
                // Asking to resolve everything lets go of holding priority, so the engine's
                // session passes your windows too once everyone agrees.
                if matches!(answer, Act::ResolveAll) && self.controls.get(&seat).is_some_and(|c| c.hold) {
                    self.set_hold(seat, false);
                }
                Ok(())
            }
            Err(act::Refusal::NotYours) => Err(ChoiceError::NotYourTurn),
            Err(act::Refusal::DoesntFit(why)) => Err(ChoiceError::DoesntFit(why)),
            Err(act::Refusal::Engine(why)) => Err(ChoiceError::Rejected(self.plain_reason(PlayerId(seat), &why))),
        }
    }

    /// What tapping `source` (its `key` choice, or its first) would leave behind for `seat` that
    /// can't be undone, if anything.
    fn kept_by(&self, seat: u8, source: u64, key: Option<&str>) -> Option<pay::Kept> {
        let me = PlayerId(seat);
        let contract = AiDecisionContract::issue(&self.state, me);
        let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
        let action = pay::find_mana_action(&candidates, source, key)?;
        let penalty = pay::action_penalty(&self.state, me, action)?;
        let vs = filter_state_for_viewer(&self.state, me);
        Some(pay::Kept { id: source, name: Self::name_in(&vs, &ObjectId(source)), penalty })
    }

    /// The sources paying automatically would tap to cast `object` now (GCast's "Will tap"), as
    /// the engine's own preview finds them on a copy of the game. Empty when it isn't `seat`'s
    /// priority, the card can't be cast, or the engine would stop to ask (an X, a sacrifice).
    pub fn auto_tap_preview(&self, seat: u8, object: u64) -> Vec<u64> {
        let me = PlayerId(seat);
        if !matches!(self.state.waiting_for, WaitingFor::Priority { player } if player == me) {
            return vec![];
        }
        let contract = AiDecisionContract::issue(&self.state, me);
        let candidates: Vec<GameAction> = contract.candidates.iter().map(|c| c.action.clone()).collect();
        let Some(action) = pay::cast_action(&candidates, object, PayMode::Ask) else { return vec![] };
        let ids = engine::game::preview::preview_auto_payment_sources(&self.state, me, &action).unwrap_or_default();
        // Sources are permanents on the battlefield, which everyone sees.
        ids.into_iter().filter(|id| self.state.battlefield.contains(id)).map(|id| id.0).collect()
    }

    /// The engine's refusal in words a player can read: "Invalid action: ObjectId(114) must be
    /// blocked by 2 or more creatures" becomes "Roaming Throne must be blocked by 2 or more
    /// creatures". Names come from the seat's own view, so a hidden card stays "a card".
    fn plain_reason(&self, seat: PlayerId, reason: &str) -> String {
        let vs = filter_state_for_viewer(&self.state, seat);
        let mut out = String::new();
        let mut rest = reason.strip_prefix("Invalid action: ").unwrap_or(reason);
        while let Some(at) = rest.find("ObjectId(") {
            out.push_str(&rest[..at]);
            let tail = &rest[at + "ObjectId(".len()..];
            match tail.find(')').and_then(|end| tail[..end].parse::<u64>().ok().map(|id| (id, end))) {
                Some((id, end)) => {
                    out.push_str(&Self::name_in(&vs, &ObjectId(id)));
                    rest = &tail[end + 1..];
                }
                None => {
                    out.push_str("ObjectId(");
                    rest = tail;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// A card's name as `vs` (one seat's filtered view) shows it. Face-down cards stay hidden.
    pub(crate) fn name_in(vs: &GameState, id: &ObjectId) -> String {
        match vs.objects.get(id) {
            Some(o) if o.face_down => "a face-down card".into(),
            Some(o) if !o.name.is_empty() => o.name.clone(),
            _ => "a card".into(),
        }
    }

    fn seat_name(&self, p: PlayerId) -> String {
        self.names.get(p.0 as usize).cloned().unwrap_or_else(|| format!("Player {}", p.0 + 1))
    }

    /// Plain-language label for an option. Common actions get hand-written wording; the rest
    /// fall back to phase's own description.
    fn label(&self, vs: &GameState, action: &GameAction) -> String {
        let target_text = |t: &TargetRef| match t {
            TargetRef::Object(id) => Self::name_in(vs, id),
            TargetRef::Player(p) => self.seat_name(*p),
        };
        match action {
            // While paying mana by hand, the engine's pass means "pay the rest for me".
            GameAction::PassPriority if matches!(vs.waiting_for, WaitingFor::ManaPayment { .. }) => "Pay the rest".into(),
            GameAction::PassPriority => {
                if vs.stack.is_empty() { "Pass (move on)".into() } else { "Pass (let it resolve)".into() }
            }
            GameAction::PlayLand { object_id, .. } => format!("Play {}", Self::name_in(vs, object_id)),
            GameAction::CastSpell { object_id, targets, .. } if targets.is_empty() => Self::cast_label(vs, object_id),
            GameAction::CastSpell { object_id, targets, .. } => format!(
                "Cast {} targeting {}",
                Self::name_in(vs, object_id),
                targets.iter().map(|t| Self::name_in(vs, t)).collect::<Vec<_>>().join(", ")
            ),
            GameAction::ActivateAbility { source_id, ability_index } => Self::ability_label(vs, source_id, *ability_index),
            GameAction::MulliganDecision { choice: MulliganChoice::Keep } => "Keep this hand".into(),
            GameAction::MulliganDecision { choice: MulliganChoice::Mulligan } => "Mulligan".into(),
            GameAction::DeclareAttackers { attacks, .. } if attacks.is_empty() => "Don't attack".into(),
            GameAction::DeclareAttackers { attacks, .. } => {
                let mut by_target: BTreeMap<String, Vec<String>> = BTreeMap::new();
                for (attacker, target) in attacks {
                    let who = match target {
                        AttackTarget::Player(p) => self.seat_name(*p),
                        AttackTarget::Planeswalker(id) | AttackTarget::Battle(id) => Self::name_in(vs, id),
                    };
                    by_target.entry(who).or_default().push(Self::name_in(vs, attacker));
                }
                let parts: Vec<String> = by_target.into_iter().map(|(who, a)| format!("{} at {who}", a.join(", "))).collect();
                format!("Attack: {}", parts.join("; "))
            }
            GameAction::DeclareBlockers { assignments } if assignments.is_empty() => "Don't block".into(),
            GameAction::DeclareBlockers { assignments } => format!(
                "Block: {}",
                assignments.iter().map(|(b, a)| format!("{} blocks {}", Self::name_in(vs, b), Self::name_in(vs, a))).collect::<Vec<_>>().join("; ")
            ),
            GameAction::SelectTargets { targets } => format!("Target {}", targets.iter().map(target_text).collect::<Vec<_>>().join(", ")),
            GameAction::ChooseTarget { target: Some(t) } => format!("Target {}", target_text(t)),
            GameAction::ChooseTarget { target: None } => "No target".into(),
            GameAction::SelectCards { cards } if cards.is_empty() => "Choose none".into(),
            GameAction::SelectCards { cards } => format!("Choose {}", cards.iter().map(|c| Self::name_in(vs, c)).collect::<Vec<_>>().join(", ")),
            // A free-cast window (CR 608.2g): one card cast free, or finish.
            GameAction::FreeCastWindowChoice { selection: Some(id) } => format!("Cast {} without paying its mana cost", Self::name_in(vs, id)),
            GameAction::FreeCastWindowChoice { selection: None } => "Finish casting".into(),
            GameAction::DecideOptionalEffect { accept } => if *accept { "Yes".into() } else { "No".into() },
            GameAction::DecideOptionalCost { pay } => if *pay { "Pay the extra cost".into() } else { "Don't pay it".into() },
            GameAction::PayUnlessCost { pay } => if *pay { "Pay the cost".into() } else { "Don't pay".into() },
            GameAction::ChooseX { value } => format!("X = {value}"),
            // At priority the engine's equip names the Equipment twice; the creature is chosen next
            // (`Pending`, "equip").
            GameAction::Equip { equipment_id, target_id } if equipment_id == target_id => format!("Equip {}", Self::name_in(vs, equipment_id)),
            GameAction::Equip { equipment_id, target_id } => format!("Equip {} to {}", Self::name_in(vs, equipment_id), Self::name_in(vs, target_id)),
            // CR 702.143a: foretelling always costs {2}.
            GameAction::Foretell { object_id, .. } => format!("Foretell {} for {{2}}", Self::name_in(vs, object_id)),
            // Starting to crew or saddle; the creatures are chosen next (`Pending`, "crew").
            GameAction::CrewVehicle { vehicle_id, creature_ids } if creature_ids.is_empty() => format!("Crew {}", Self::name_in(vs, vehicle_id)),
            GameAction::SaddleMount { mount_id, creature_ids } if creature_ids.is_empty() => format!("Saddle {}", Self::name_in(vs, mount_id)),
            GameAction::ChooseOption { choice } => choice.clone(),
            GameAction::CancelCast => "Cancel".into(),
            GameAction::RespondResolveAllConsent { decision: ResolveAllConsentDecision::Grant, .. } => "Agree".into(),
            GameAction::RespondResolveAllConsent { decision: ResolveAllConsentDecision::Decline, .. } => "Keep priority".into(),
            GameAction::RevokeResolveAllConsent { .. } => "Take back your agreement".into(),
            GameAction::OrderTriggers { order } => {
                let names: Vec<String> = match &vs.waiting_for {
                    WaitingFor::OrderTriggers { triggers, .. } => order
                        .iter()
                        .map(|i| triggers.get(*i).map(|t| Self::name_in(vs, &t.source_id)).unwrap_or_else(|| format!("trigger {}", i + 1)))
                        .collect(),
                    _ => order.iter().map(|i| format!("trigger {}", i + 1)).collect(),
                };
                // The stack resolves last-in first; say it in the order things will happen.
                format!("Resolve {}", names.iter().rev().cloned().collect::<Vec<_>>().join(", then "))
            }
            GameAction::SelectModes { indices } => {
                let modal = match &vs.waiting_for {
                    WaitingFor::ModeChoice { modal, .. } | WaitingFor::AbilityModeChoice { modal, .. } => Some(modal),
                    _ => None,
                };
                let text: Vec<String> = indices
                    .iter()
                    .map(|i| modal.and_then(|m| m.mode_descriptions.get(*i).cloned()).unwrap_or_else(|| format!("Mode {}", i + 1)))
                    .collect();
                format!("Choose: {}", text.join(" + "))
            }
            GameAction::ChooseReplacement { index } => match &vs.waiting_for {
                // The effect picked applies first (CR 616.1e): where the one applied last decides
                // how a permanent enters, the button says how it ends up.
                WaitingFor::ReplacementChoice { candidates, kind: ReplacementChoiceKind::Order, .. }
                    if let (Some(c), Some(outcome)) = (candidates.get(*index), act::replacement_order_outcome(candidates, *index)) =>
                {
                    format!("{} first, so {outcome}", c.source_name)
                }
                WaitingFor::ReplacementChoice { candidates, .. } => candidates
                    .get(*index)
                    .map(|c| if c.description.is_empty() { c.source_name.clone() } else { c.description.clone() })
                    .unwrap_or_else(|| format!("Option {}", index + 1)),
                _ => format!("Option {}", index + 1),
            },
            _ => phase_llm::render::action::describe_action(&self.state, action),
        }
    }

    /// Casting a card, saying how when it isn't from the hand (PP-21): from exile after its
    /// adventure (CR 715.3d), for its foretell cost (CR 702.143a), with flashback or escape from a
    /// graveyard (CR 702.34a, 702.138a), or from wherever else it is.
    fn cast_label(vs: &GameState, id: &ObjectId) -> String {
        let Some(o) = vs.objects.get(id) else { return format!("Cast {}", Self::name_in(vs, id)) };
        // A card you foretold is face down in exile, and the projection keeps its name for you.
        let name = if o.face_down && o.zone == Zone::Exile && !o.name.is_empty() && o.name != "Hidden Card" { o.name.clone() } else { Self::name_in(vs, id) };
        match o.zone {
            Zone::Exile => {
                let foretold = o.casting_permissions.iter().find_map(|p| match p {
                    engine::types::ability::CastingPermission::Foretold { cost, .. } => Some(cost),
                    _ => None,
                });
                match foretold {
                    Some(cost) => format!("Cast {name} for its foretell cost {}", phase_llm::render::text::mana_cost_text(cost)),
                    None => format!("Cast {name} from exile"),
                }
            }
            Zone::Graveyard => {
                if o.keywords.iter().any(|k| matches!(k, Keyword::Flashback(_))) {
                    format!("Cast {name} with flashback")
                } else if o.keywords.iter().any(|k| matches!(k, Keyword::Escape(_))) {
                    format!("Cast {name} with escape")
                } else {
                    format!("Cast {name} from your graveyard")
                }
            }
            _ => format!("Cast {name}"),
        }
    }

    /// An activated ability in its own words: the card's text for it, with its cost ("+1: Draw two
    /// cards, then put a card from your hand on the bottom of your library."), so a planeswalker's
    /// abilities read apart (PP-04). The engine writes the card's own name as "~". Falls back to
    /// the cost, then to "Use <card>".
    pub(crate) fn ability_label(vs: &GameState, source: &ObjectId, index: usize) -> String {
        let name = Self::name_in(vs, source);
        let def = engine::game::casting::activated_ability_definitions(vs, *source).into_iter().find(|(i, _)| *i == index).map(|(_, d)| d);
        let Some(def) = def else { return format!("Use {name}") };
        if let Some(text) = def.description.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            return ability_text(text, &name);
        }
        match def.cost.as_ref().map(cost_text).filter(|c| !c.is_empty()) {
            Some(cost) => format!("{cost}: use {name}"),
            None => format!("Use {name}"),
        }
    }

    /// Pass priority for people when stopping wouldn't help them, by the rules in turns.rs
    /// (`verdict`): Arena-like smart stops, each person's own stops, full control, holding
    /// priority, trigger yields and the pass modes. Every decision other than priority (targets,
    /// blocks, mulligans) always waits. Returns how many passes were made.
    pub fn auto_pass(&mut self, humans: &[u8]) -> usize {
        self.tidy_controls(humans);
        let mut passed = 0;
        loop {
            // An answer Yama remembers for someone (remember.rs) is given before anything else.
            if self.answer_remembered(humans) {
                passed += 1;
                continue;
            }
            let mut next = None;
            for seat in self.waiting_on().into_iter().filter(|s| humans.contains(s)) {
                let Some((w, contract)) = self.window_issued(seat) else { continue };
                let c = self.controls.get(&seat).cloned().unwrap_or_default();
                match turns::verdict(&w, &c) {
                    turns::Verdict::Pass => {
                        next = Some((seat, contract));
                        break;
                    }
                    turns::Verdict::Stop => {}
                    // Something happened: the pass mode ends and they're asked.
                    turns::Verdict::Interrupt => {
                        if let Some(c) = self.controls.get_mut(&seat) {
                            c.passing = None;
                        }
                    }
                }
            }
            // The decision the window was read from is the one passed: nothing has changed since,
            // so it isn't issued again (issuing one is most of a pass's cost on a big board).
            let Some((seat, contract)) = next else { return passed };
            let Some(index) = contract.candidates.iter().position(|c| matches!(c.action, GameAction::PassPriority)) else {
                return passed;
            };
            if self.choose_issued(seat, contract, index).is_err() {
                return passed;
            }
            passed += 1;
            self.tidy_controls(humans);
        }
    }

    /// End what no longer applies: a pass mode whose turn is over (or whose seat is out), and
    /// holding priority once the stack is empty.
    fn tidy_controls(&mut self, humans: &[u8]) {
        let turn = self.state.turn_number;
        let active = self.state.active_player.0;
        let empty = self.state.stack.is_empty();
        let mut released = vec![];
        for seat in humans {
            let out = self.state.players.iter().any(|p| p.id.0 == *seat && p.is_eliminated) || self.is_over();
            let Some(c) = self.controls.get_mut(seat) else { continue };
            if c.passing.is_some_and(|p| out || p.over(turn, active == *seat)) {
                c.passing = None;
            }
            if c.hold && (empty || out) {
                released.push(*seat);
            }
        }
        for seat in released {
            self.set_hold(seat, false);
        }
    }

    /// `seat`'s priority window as the pass rules read it, if it holds priority now.
    fn window(&self, seat: u8) -> Option<turns::Window> {
        self.window_issued(seat).map(|(w, _)| w)
    }

    /// [`Match::window`], with the decision it was read from.
    fn window_issued(&self, seat: u8) -> Option<(turns::Window, AiDecisionContract)> {
        let WaitingFor::Priority { player } = &self.state.waiting_for else { return None };
        if player.0 != seat {
            return None;
        }
        let contract = AiDecisionContract::issue(&self.state, PlayerId(seat));
        let is_land_ability = |a: &GameAction| match a {
            GameAction::ActivateAbility { source_id, .. } => self
                .state
                .objects
                .get(source_id)
                .is_some_and(|o| o.card_types.core_types.iter().any(|t| format!("{t:?}") == "Land")),
            _ => false,
        };
        let others = || contract.candidates.iter().filter(|c| !matches!(c.action, GameAction::PassPriority));
        let window = turns::Window {
            phase: format!("{:?}", self.state.phase),
            your_turn: self.state.active_player.0 == seat,
            top: self.state.stack.last().map(|top| turns::Top {
                yours: top.controller.0 == seat,
                yielded: self.state.is_priority_yielded(PlayerId(seat), top),
            }),
            only_pass: others().next().is_none(),
            can_act: others().any(|c| !is_land_ability(&c.action)),
            can_cast: others().any(|c| matches!(c.action, GameAction::CastSpell { .. })),
            ninjutsu: others().any(|c| matches!(c.action, GameAction::ActivateNinjutsu { .. })),
        };
        Some((window, contract))
    }

    /// `seat`'s saved settings: their stops (`None` for the usual ones) and full control.
    pub fn set_prefs(&mut self, seat: u8, stops: Option<Stops>, full_control: bool) {
        let c = self.controls.entry(seat).or_default();
        c.stops = stops;
        c.full_control = full_control;
        self.sync_passing_mode(seat);
    }

    /// `seat`'s "Tap mana for me" setting, saved with their account.
    pub fn set_tap_mana(&mut self, seat: u8, mode: PayMode) {
        self.controls.entry(seat).or_default().tap_mana = mode;
    }

    /// Full control on or off, keeping `seat`'s stops.
    pub fn set_full_control(&mut self, seat: u8, on: bool) {
        self.controls.entry(seat).or_default().full_control = on;
        self.sync_passing_mode(seat);
    }

    /// `seat`'s own stops by step; `None` goes back to the usual ones.
    pub fn set_stops(&mut self, seat: u8, stops: Option<Stops>) {
        self.controls.entry(seat).or_default().stops = stops;
    }

    /// `seat`'s turn controls as they stand.
    pub fn controls(&self, seat: u8) -> Controls {
        self.controls.get(&seat).cloned().unwrap_or_default()
    }

    /// Start a pass mode for `seat` (GPriority), or stop one (`None`). If it's their priority
    /// now and `revision` is the board they chose from, this window is passed first: choosing
    /// a way to pass passes.
    pub fn set_passing(&mut self, seat: u8, mode: Option<PassMode>, revision: u64) -> Result<(), ChoiceError> {
        let Some(mode) = mode else {
            self.controls.entry(seat).or_default().passing = None;
            return Ok(());
        };
        if self.state.players.iter().any(|p| p.id.0 == seat && p.is_eliminated) || self.is_over() {
            return Err(ChoiceError::DoesntFit("You're out of the game.".into()));
        }
        let pass = self.window(seat).and_then(|_| {
            AiDecisionContract::issue(&self.state, PlayerId(seat)).candidates.iter().position(|c| matches!(c.action, GameAction::PassPriority))
        });
        if let Some(index) = pass.filter(|_| self.current(seat, revision)) {
            self.choose(seat, revision, index)?;
        }
        self.controls.entry(seat).or_default().passing = Some(turns::Passing { mode, turn: self.state.turn_number });
        Ok(())
    }

    /// "Hold priority": stop `seat` whenever they get priority while the stack isn't empty, even
    /// for their own spell, until they pass with their own spell on top or the stack empties
    /// (GButtons). The engine holds it too, so a stack session another seat's pass started
    /// doesn't pass that window for them.
    pub fn set_hold(&mut self, seat: u8, on: bool) {
        self.controls.entry(seat).or_default().hold = on;
        self.sync_passing_mode(seat);
    }

    /// Keep the engine's own passing mode in step with full control and holding priority:
    /// `FullControl` keeps the engine's stack sessions from passing any of the seat's windows.
    /// A change is an engine action, written to the replay log like any other.
    fn sync_passing_mode(&mut self, seat: u8) {
        let c = self.controls.get(&seat).cloned().unwrap_or_default();
        let want = if c.full_control || c.hold { PriorityPassingMode::FullControl } else { PriorityPassingMode::Standard };
        let me = PlayerId(seat);
        if self.state.priority_passing_mode(me) == want || self.is_over() || usize::from(seat) >= self.state.players.len() {
            return;
        }
        let action = GameAction::SetPriorityPassingMode { mode: want };
        match engine::game::engine::apply(&mut self.state, me, action.clone()) {
            Ok(result) => {
                self.log.push_action(me, action);
                self.accepted(&result, None);
            }
            // The engine takes this preference in any state; if it ever doesn't, Yama's own layer
            // still holds the window, and only an engine stack session could pass it.
            Err(e) => eprintln!("yama-play: couldn't set seat {seat}'s passing mode: {e}"),
        }
    }

    /// `seat` leaves the game (CR 104.3a). Allowed at any time. Every seat's view says so
    /// (`PlayerView::conceded`, and a log line).
    pub fn concede(&mut self, seat: u8) -> anyhow::Result<()> {
        let me = PlayerId(seat);
        if self.conceded.contains(&seat) {
            return Ok(());
        }
        let action = GameAction::Concede { player_id: me };
        let result = engine::game::engine::apply(&mut self.state, me, action.clone()).map_err(|e| anyhow::anyhow!("{e}"))?;
        self.log.push_action(me, action);
        self.conceded.insert(seat);
        self.controls.remove(&seat);
        self.accepted(&result, Some(seat));
        let line = LogLine::public(self.state.turn_number, format!("{} conceded.", self.seat_name(me)));
        self.lines.push(line);
        Ok(())
    }

    /// Let AI seats act until a human must decide, the game ends, or `max_steps` is reached.
    /// Returns how many actions the AI took. CPU-heavy: call from a large-stack worker thread.
    pub fn run_ai(&mut self, max_steps: usize) -> anyhow::Result<usize> {
        let ai_players: HashSet<PlayerId> = self.ai.keys().copied().collect();
        let mut steps = 0;
        self.ai_thinking = std::time::Duration::ZERO;
        while steps < max_steps && !self.is_over() {
            self.check_turn_length()?;
            let Some((owner, actor)) = eligible_ai_decision(&self.state, &ai_players) else { break };
            let contract = AiDecisionContract::issue(&self.state, owner);
            let config = &self.ai[&actor];
            let mut rng = ai_rng(self.log.header.seed, self.log.actions.len());
            let thinking = Busy::start();
            let searched = ai_search_state(&self.state);
            let chosen = choose_action_with_session(searched.as_ref(), owner, config, &mut rng, &self.session)
                .or_else(|| if self.fallback { phase_ai::search::fallback_action(&self.state, config, &contract) } else { None });
            self.ai_thinking += thinking.elapsed();
            let Some(action) = chosen else {
                bail!("AI for seat {} found no action", actor.0);
            };
            let result = if !self.plain_passes() && verified_ai_stack_pass_player(&self.state, &action).is_some() {
                let r = apply_verified_ai_priority_pass(&mut self.state, actor, &contract, action);
                if r.is_ok() {
                    self.log.push_verified_ai_priority_pass(actor, owner);
                }
                r
            } else {
                let r = apply_interaction(&mut self.state, actor, owner, action.clone());
                if r.is_ok() {
                    self.log.push_action(actor, action);
                }
                r
            };
            let result = result.map_err(|e| anyhow::anyhow!("AI action for seat {} failed: {e}", actor.0))?;
            self.accepted(&result, None);
            steps += 1;
        }
        Ok(steps)
    }

    /// Bookkeeping after the engine took an action: the revision, the log (public headline
    /// lines, plus a private line for each answer the engine gave for someone from memory), and
    /// which people's decisions changed. `acted` is the person who answered, if one did.
    fn accepted(&mut self, result: &ActionResult, acted: Option<u8>) {
        self.revision += 1;
        let busy = Busy::start();
        self.remark(acted);
        self.costs.remark += busy.elapsed();
        // A payment ends (cast, cancelled or abandoned) with its spell or ability.
        if self.state.pending_cast.is_none() {
            self.kept.clear();
        }
        for e in &result.log_entries {
            // Only public, headline entries: detail lines and anything revealing hidden cards stay out.
            if e.presentation.importance != LogImportance::Essential || e.presentation.visibility != LogVisibility::Public {
                continue;
            }
            self.lines.push(LogLine::public(e.turn, segments_text(&e.segments)));
        }
        let busy = Busy::start();
        self.feed.record(&result.events, &self.state, &self.conceded);
        self.costs.feed += busy.elapsed();
        self.note_automatic_answers(result);
        self.facing = together::facing_after(&self.state, self.facing.take());
        self.note_turn(self.log.actions.len());
        if self.lines.len() > LOG_LINES * 4 {
            self.lines.drain(..self.lines.len() - LOG_LINES);
        }
    }

    /// The answers the engine just gave for people from memory: a log line and a feed line for
    /// each, seen only by the person it answered for. Then watch for the next ones.
    fn note_automatic_answers(&mut self, result: &ActionResult) {
        let resolved: HashSet<u64> = result
            .events
            .iter()
            .filter_map(|e| match e {
                GameEvent::StackResolved { object_id } => Some(object_id.0),
                _ => None,
            })
            .collect();
        for w in std::mem::take(&mut self.auto_watch) {
            if resolved.contains(&w.entry) {
                let answer = if w.accept { "yes" } else { "no" };
                self.feed.automatic(w.seat, &w.name, w.accept, &w.id, &self.state);
                self.lines.push(LogLine {
                    turn: self.state.turn_number,
                    text: format!("Yama answered {answer} for {}, as you asked.", w.name),
                    seat: Some(w.seat),
                    auto: Some(w.id),
                });
            }
        }
        self.auto_watch = self.watch_automatic_answers();
    }

    /// Bookkeeping for an action replayed from the log on resume: the revision, the feed and the
    /// remembered answers, as [`Match::accepted`] keeps them. Log lines come back from storage.
    fn replayed(&mut self, result: &ActionResult) {
        self.revision += 1;
        self.feed.record(&result.events, &self.state, &self.conceded);
        self.note_automatic_answers(result);
        self.facing = together::facing_after(&self.state, self.facing.take());
        // While resuming, the revision counts the actions replayed so far.
        self.note_turn(self.revision as usize);
    }

    /// Keep where the turn in progress began, and when the board last moved on (`logged`: actions
    /// in the replay log so far).
    fn note_turn(&mut self, logged: usize) {
        if self.state.turn_number != self.turn_began.0 {
            self.turn_began = (self.state.turn_number, logged);
        }
        let mark = progress_mark(&self.state);
        if mark != self.moved_on.0 {
            self.moved_on = (mark, logged);
        }
    }

    /// Stop the AI when the game is going nowhere: [`STALL_ACTION_LIMIT`] actions in a row with
    /// nothing changing on the board, or [`TURN_ACTION_LIMIT`] in one turn whatever they do. Only
    /// something the engine repeats without end gets there, which its loop detection doesn't
    /// catch (Zaffai, Thunder Conductor's trigger re-entering the stack after its scry, seen
    /// 2026-10-24); a long turn that keeps changing the board (Scute Swarm doubling its copies) is
    /// left to finish. Everyone is told once, in the log; the people at the table can concede.
    fn check_turn_length(&mut self) -> anyhow::Result<()> {
        let logged = self.log.actions.len();
        let this_turn = logged.saturating_sub(self.turn_began.1);
        let still = logged.saturating_sub(self.moved_on.1);
        let long_turn = self.state.turn_number == self.turn_began.0 && this_turn >= TURN_ACTION_LIMIT;
        if still < self.stall_limit && !long_turn {
            return Ok(());
        }
        let repeating = self
            .state
            .stack
            .last()
            .and_then(|top| self.state.objects.get(&top.source_id))
            .filter(|o| !o.face_down && !o.name.is_empty())
            .map(|o| format!("{}'s ability", o.name))
            .unwrap_or_else(|| "the same step".into());
        let text = format!("The game can't go on: the rules engine keeps repeating {repeating} and this turn doesn't end. Concede to leave the game.");
        if self.lines.last().map(|l| &l.text) != Some(&text) {
            self.lines.push(LogLine::public(self.state.turn_number, text));
        }
        bail!(
            "turn {}: {still} actions with nothing changing on the board, {this_turn} this turn; the engine is repeating {repeating}; the AI has stopped",
            self.state.turn_number
        )
    }

    /// The game's loop setting, from its replay header ([`Setup::loops`]).
    pub fn loops(&self) -> LoopDetectionMode {
        self.state.loop_detection
    }

    /// The CPU time the AI spent choosing during the last [`Match::run_ai`] (the rest of that call
    /// is the engine applying its choices and Yama's bookkeeping).
    pub fn ai_thinking(&self) -> std::time::Duration {
        self.ai_thinking
    }

    /// Give the AI seats phase's wall-clock search budget back (or take it away), for measuring
    /// what [`AI_CLOCK`] changes. A game played with the clock doesn't replay its AI's choices from
    /// its seed, only from its log.
    #[doc(hidden)]
    pub fn set_ai_clock(&mut self, clock: bool) {
        let players = self.log.header.player_count;
        let seed = self.log.header.seed;
        for config in self.ai.values_mut() {
            *config = ai_config(config.difficulty, players, seed, clock);
        }
    }

    /// Whether every pass is the engine's ordinary `PassPriority`, for people and AI seats alike:
    /// in games with loop detection on. Otherwise a pass over a nonempty stack goes through
    /// phase's verified AI pass, which starts a stack-resolution session that passes for every
    /// player with nothing meaningful to do until the stack changes. That session carries the
    /// ids of the stack entries it covers, and phase's loop detection compares whole positions
    /// with it, so no two positions of a loop compare equal while one runs: a loop of mandatory
    /// triggers nobody can win would never be found to be a draw (CR 732.4). Yama's own pass
    /// layer (turns.rs) still passes for people where stopping wouldn't help them.
    fn plain_passes(&self) -> bool {
        self.state.loop_detection.samples()
    }

    /// The move phase's AI (at `level`) would make for `seat`, in the form a person sends one: an
    /// option, an attack or block declaration, or an `act` answer. For benchmarks and tests of
    /// people's moves ([`Match::send_move`]); live games never call it.
    #[doc(hidden)]
    pub fn ai_move_for(&self, seat: u8, level: AiDifficulty) -> Option<PersonMove> {
        let d = self.decision(seat)?;
        let me = PlayerId(seat);
        let config = ai_config(level, self.log.header.player_count, self.log.header.seed, false);
        let mut rng = ai_rng(self.log.header.seed ^ 0x5eed, self.log.actions.len());
        let searched = ai_search_state(&self.state);
        let fallback = || d.options.iter().find(|o| matches!(o.kind, OptionKind::Pass | OptionKind::Keep)).or(d.options.first()).map(|o| PersonMove::Option(d.revision, o.index));
        let Some(action) = choose_action_with_session(searched.as_ref(), me, &config, &mut rng, &self.session) else { return fallback() };
        let contract = AiDecisionContract::issue(&self.state, me);
        if let Some(i) = contract.candidates.iter().position(|c| c.action == action) {
            return Some(PersonMove::Option(d.revision, i));
        }
        match &action {
            GameAction::DeclareAttackers { attacks, .. } => {
                return Some(PersonMove::Attack(d.revision, attacks.iter().map(|(a, t)| (a.0, AttackAt::from_engine(t))).collect()));
            }
            GameAction::DeclareBlockers { assignments } => {
                return Some(PersonMove::Block(d.revision, assignments.iter().map(|(b, a)| (b.0, a.0)).collect()));
            }
            _ => {}
        }
        let answer = if pay::paying(&self.state.waiting_for, me) { Act::from_payment_action(&action) } else { Act::from_action(&action) };
        // An answer `act` doesn't take: the closest option instead (pass, keep, or the first).
        answer.map(|a| PersonMove::Act(d.revision, a)).or_else(fallback)
    }

    /// Send `seat`'s move as the board would ([`Match::ai_move_for`]).
    #[doc(hidden)]
    pub fn send_move(&mut self, seat: u8, mv: &PersonMove) -> Result<(), ChoiceError> {
        match mv {
            PersonMove::Option(revision, index) => self.choose(seat, *revision, *index),
            PersonMove::Attack(revision, attacks) => self.declare_attackers(seat, *revision, attacks),
            PersonMove::Block(revision, blocks) => self.declare_blockers(seat, *revision, blocks),
            PersonMove::Act(revision, answer) => self.act(seat, *revision, answer),
        }
    }

    /// The bookkeeping costs since the last call, for benchmarks.
    #[doc(hidden)]
    pub fn take_costs(&mut self) -> Costs {
        std::mem::take(&mut self.costs)
    }

    /// A lower [`STALL_ACTION_LIMIT`] for this game, so a test reaches it quickly.
    #[doc(hidden)]
    pub fn set_stall_limit(&mut self, actions: usize) {
        self.stall_limit = actions;
    }

    /// The engine's whole state, for tests and benchmarks (determinism checks, an AI playing a
    /// person's seat). It names every hidden card: never send it to anyone.
    #[doc(hidden)]
    pub fn engine_state(&self) -> &GameState {
        &self.state
    }

    /// Answer with phase's `fallback_action` when the AI finds no action (see the field).
    pub fn set_ai_fallback(&mut self, on: bool) {
        self.fallback = on;
    }

    /// Settle a physical contest (a coin flip or die roll everyone takes part in) when every
    /// contestant is an AI seat, as a headless host must: no seat acts on one. Returns whether
    /// it ran. Not written to the replay log, so only for games that are never replayed.
    pub fn settle_ai_contest(&mut self) -> bool {
        let seats: HashSet<PlayerId> = self.ai.keys().copied().collect();
        let ran = phase_ai::contest::settle_headless_contest(&mut self.state, &seats, &mut self.rng);
        if ran {
            self.revision += 1;
            self.remark(None);
        }
        ran
    }

    /// How many actions the replay log holds.
    pub fn actions_logged(&self) -> usize {
        self.log.actions.len()
    }

    /// The replay log (header + every accepted action), for persistence.
    pub fn replay_json(&self) -> String {
        serde_json::to_string(&self.log).expect("replay log serializes")
    }

    /// The board as `viewer` may see it (`None` = spectator).
    pub fn view(&self, viewer: Option<u8>) -> View {
        let state = match viewer {
            Some(seat) => filter_state_for_viewer(&self.state, PlayerId(seat)),
            None => engine::game::visibility::filter_state_for_unseated_viewer(&self.state),
        };
        self.view_of(&state, viewer, false)
    }

    /// A spectator's board with every hand face up (`View::hands`), for games with nobody to
    /// hide them from: every seat is an AI and only its owner watches. Libraries stay hidden.
    pub fn view_revealed(&self) -> View {
        self.view_of(&self.state, None, true)
    }

    /// What a stack entry targets (CR 115.1), as `vs` (one seat's board) shows it: the targets
    /// chosen for the spell or ability and the rest of its chain, in order, each once. None while
    /// it's still being cast, when the targets aren't chosen yet, and none for what an entry
    /// holds without targeting it ("return it to the battlefield").
    fn stack_targets(&self, vs: &GameState, entry: &StackEntry, viewer: Option<u8>, all_hands: bool) -> Vec<StackTarget> {
        let Some(ability) = entry.ability() else { return vec![] };
        let mut seen = HashSet::new();
        declared_targets_in_chain(ability)
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .map(|t| self.stack_target(vs, &t, viewer, all_hands))
            .collect()
    }

    /// One target as `viewer` may see it. A card in a hidden zone (a library, someone else's
    /// hand) is only "a card", without its id, so nothing can follow it there.
    fn stack_target(&self, vs: &GameState, t: &TargetRef, viewer: Option<u8>, all_hands: bool) -> StackTarget {
        match t {
            TargetRef::Player(p) => StackTarget { target: Some(TargetView::Player { seat: p.0 }), name: self.seat_name(*p), controller: Some(p.0) },
            TargetRef::Object(id) => {
                let o = vs.objects.get(id);
                let seen = o.is_some_and(|o| match o.zone {
                    Zone::Hand => all_hands || viewer == Some(o.owner.0),
                    zone => zone.is_public(),
                });
                match o.filter(|_| seen) {
                    Some(o) => StackTarget { target: Some(TargetView::Object { id: id.0 }), name: Self::name_in(vs, id), controller: Some(o.controller.0) },
                    None => StackTarget { target: None, name: "a card".into(), controller: None },
                }
            }
        }
    }

    fn view_of(&self, state: &GameState, viewer: Option<u8>, all_hands: bool) -> View {
        // The engine's presentation of this seat's board: keyword badges, blocks, and each stack
        // entry's words and chosen modes. Built from `state`, the board as this seat may see it.
        let derived = derive_filtered_views(&self.state, state, viewer.map(PlayerId));
        let mut blocks: HashMap<ObjectId, Vec<u64>> = HashMap::new();
        for (blocker, attacker) in &derived.blocker_assignment_pairs {
            blocks.entry(*blocker).or_default().push(attacker.0);
        }
        let attacker = |id: &ObjectId| state.combat.as_ref().and_then(|c| c.attackers.iter().find(|a| a.object_id == *id));
        let obj = |id: &ObjectId| -> Option<CardView> {
            let o = state.objects.get(id)?;
            let on_field = o.zone == Zone::Battlefield;
            // A face-down card in exile keeps its name for a seat that may look at it (a card it
            // foretold); the projection hides it from everyone else (GZones).
            let may_look = viewer.is_some() && o.zone == Zone::Exile && !o.name.is_empty() && o.name != "Hidden Card";
            let base = (o.base_power, o.base_toughness);
            let reshaped = on_field && base != (o.power, o.toughness);
            Some(CardView {
                id: id.0,
                name: if o.face_down && !may_look { "Face-down card".into() } else { o.name.clone() },
                face_down: o.face_down,
                under: face_down_identity(o, all_hands),
                came: if matches!(o.zone, Zone::Graveyard | Zone::Exile | Zone::Command) { self.feed.came(viewer, id.0) } else { None },
                attachments: if on_field { o.attachments.iter().map(|a| a.0).collect() } else { vec![] },
                transformed: o.transformed && !o.face_down,
                base_power: base.0.filter(|_| reshaped),
                base_toughness: base.1.filter(|_| reshaped),
                entered: o.entered_battlefield_turn.filter(|_| on_field),
                controller: o.controller.0,
                owner: o.owner.0,
                tapped: o.tapped,
                power: o.power,
                toughness: o.toughness,
                loyalty: o.loyalty,
                damage: o.damage_marked,
                counters: o.counters.iter().map(|(k, v)| (format!("{k:?}").to_lowercase(), *v)).collect(),
                types: o.card_types.core_types.iter().map(|t| format!("{t:?}")).collect(),
                attached_to: o.attached_to.as_ref().and_then(|a| serde_json::to_value(a).ok()),
                attacking: attacker(id).is_some(),
                attacks: attacker(id).map(|a| a.defending_player.0),
                attacks_card: attacker(id).and_then(|a| match a.attack_target {
                    AttackTarget::Planeswalker(t) | AttackTarget::Battle(t) => Some(t.0),
                    AttackTarget::Player(_) => None,
                }),
                blocked: attacker(id).is_some_and(|a| a.blocked),
                blocking: state.combat.as_ref().is_some_and(|c| c.blocker_to_attacker.contains_key(id)),
                blocks: if on_field { blocks.get(id).cloned().unwrap_or_default() } else { vec![] },
                keywords: if on_field { derived.battlefield_keyword_badges.get(id).map(|ks| keyword_labels(ks)).unwrap_or_default() } else { vec![] },
                commander: o.is_commander && !o.face_down,
                tax: if o.is_commander && !o.face_down { engine::game::commander::commander_tax(&state, *id) } else { 0 },
                sick: engine::game::combat::has_summoning_sickness(o),
            })
        };
        let players = state
            .players
            .iter()
            .map(|p| PlayerView {
                seat: p.id.0,
                life: p.life,
                poison: p.poison_counters,
                hand: p.hand.len(),
                library: p.library.len(),
                graveyard: p.graveyard.iter().filter_map(obj).collect(),
                eliminated: p.is_eliminated,
                conceded: self.conceded.contains(&p.id.0),
                commander_damage: state
                    .commander_damage
                    .iter()
                    .filter(|d| d.player == p.id)
                    .map(|d| (Self::name_in(&state, &d.commander), d.damage))
                    .collect(),
                companion: rare::companion_of(state, p.id).map(|(name, used)| CompanionView { name, used }),
            })
            .collect();
        View {
            revision: self.revision,
            turn: state.turn_number,
            active: state.active_player.0,
            phase: format!("{:?}", state.phase),
            waiting_on: self.waiting_on(),
            waiting: phase_llm::render::action::describe_waiting_for(&state.waiting_for),
            players,
            battlefield: state.battlefield.iter().filter_map(obj).collect(),
            stack: state
                .stack
                .iter()
                .map(|s| {
                    let name = match state.objects.get(&s.source_id) {
                        Some(o) if o.face_down => "A face-down spell".into(),
                        Some(o) if !o.name.is_empty() => o.name.clone(),
                        _ => "An ability".into(),
                    };
                    let detail = derived.stack_entry_details.get(&s.id);
                    let trigger = matches!(s.kind, StackEntryKind::TriggeredAbility { .. });
                    // An ability's own words, from the engine (a keyword action like crew is just
                    // its keyword). A spell's are its Oracle text, which the board has from the card.
                    let ability = !matches!(s.kind, StackEntryKind::Spell { .. });
                    let face_down = state.objects.get(&s.source_id).is_some_and(|o| o.face_down);
                    let text = match &s.kind {
                        StackEntryKind::KeywordAction { .. } | StackEntryKind::CombatDamage { .. } => detail.map(|d| d.kind_label.clone()),
                        _ => detail
                            .and_then(|d| d.ability_description.as_deref())
                            .filter(|t| ability && !face_down && !t.trim().is_empty())
                            .map(|d| ability_text(d, &name)),
                    };
                    StackView {
                        id: s.id.0,
                        source: s.source_id.0,
                        controller: detail.map_or(s.controller.0, |d| d.controller.0),
                        trigger,
                        ability,
                        text,
                        modes: detail.map(|d| d.selected_mode_labels.iter().map(|m| ability_text(m, &name)).collect()).unwrap_or_default(),
                        casting: detail.is_some_and(|d| d.is_pending),
                        targets: self.stack_targets(state, s, viewer, all_hands),
                        // The viewer passes for it while it's on top (a trigger yield).
                        yielded: viewer.is_some_and(|seat| {
                            self.state.stack.iter().find(|e| e.id == s.id).is_some_and(|e| self.state.is_priority_yielded(PlayerId(seat), e))
                        }),
                        under: state.objects.get(&s.source_id).filter(|o| o.face_down).and_then(|o| face_down_identity(o, all_hands)),
                        name,
                    }
                })
                .collect(),
            command_zone: state.command_zone.iter().filter_map(obj).collect(),
            exile: state.exile.iter().filter_map(obj).collect(),
            hand: viewer
                .and_then(|seat| state.players.iter().find(|p| p.id.0 == seat))
                .map(|p| p.hand.iter().filter_map(obj).collect())
                .unwrap_or_default(),
            hands: if all_hands {
                state.players.iter().map(|p| (p.id.0, p.hand.iter().filter_map(obj).collect())).collect()
            } else {
                BTreeMap::new()
            },
            // The seat's own filtered view is `state` here (`Match::view`), so it isn't made twice.
            decision: viewer.and_then(|seat| self.decision_seen(state, seat)),
            // A line only one seat may see (an answer Yama gave for them) goes to that seat alone.
            log: {
                let mut lines: Vec<LogLine> = self.lines.iter().rev().filter(|l| l.seat.is_none() || l.seat == viewer).take(LOG_LINES).cloned().collect();
                lines.reverse();
                lines
            },
            over: self.is_over(),
            winner: self.winner(),
            turns: viewer.filter(|seat| !self.is_ai(*seat)).map(|seat| self.turns_view(state, seat)),
            resolve_all: self.resolve_all_view(),
            together: together::view(state, &self.state, self.facing.as_ref().map(|(_, who)| who.as_slice()), &self.names),
            events: self.feed.recent(viewer, feed::SHOWN),
            outs: self.feed.outs().to_vec(),
            stats: self.is_over().then(|| self.feed.stats(&self.state)),
        }
    }

    /// Everything `viewer` may know happened that the feed still holds, oldest first (tests and
    /// the soak run read it whole; views carry the newest [`feed::SHOWN`]).
    pub fn events(&self, viewer: Option<u8>) -> Vec<Happening> {
        self.feed.recent(viewer, feed::KEEP)
    }

    /// The players knocked out so far, in order, each with its cause.
    pub fn outs(&self) -> &[Out] {
        self.feed.outs()
    }
}

/// Actions in a row with nothing changing on the board ([`progress_mark`]) before Yama stops the
/// AI ([`Match::run_ai`]). Real 4-player turns average under 60 actions, and a step in which
/// nothing happens is a few passes, so only something the engine repeats without end gets near it.
pub const STALL_ACTION_LIMIT: usize = 3_000;

/// Actions one turn may take, whatever they do, before Yama stops the AI: a bound for a loop that
/// keeps changing the board without end, and for a legal turn the engine can't finish in
/// reasonable time. In a soak game on 2026-10-24 Scute Swarm copies doubled on every landfall of a
/// World Shaper turn: past 3,000 actions each action took longer as the board grew, and the turn
/// was still going after 50 minutes. 12,000 is about the lab's 3,000-action loop guard once every
/// pass is its own action (four players pass for each thing that resolves).
pub const TURN_ACTION_LIMIT: usize = 12_000;

/// What the board shows of a game's progress: the turn and step, each player's life, poison and
/// whether they're out, and how many cards are in each zone. A run of actions that leaves all of
/// it as it was is going nowhere.
#[doc(hidden)]
pub fn progress_mark(state: &GameState) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    state.turn_number.hash(&mut h);
    std::mem::discriminant(&state.phase).hash(&mut h);
    for p in &state.players {
        (p.life, p.poison_counters, p.is_eliminated, p.hand.len(), p.library.len(), p.graveyard.len()).hash(&mut h);
    }
    (state.battlefield.len(), state.exile.len(), state.command_zone.len()).hash(&mut h);
    h.finish()
}

/// The position the AI searches from: the game itself, but with loop detection off unless the
/// decision is about a loop. phase's search plays lines out on copies of the game, and with loop
/// detection on every resolution in those lines copies the position again for the detector: on
/// Hard that made AI decisions take about 60% longer (docs/play-performance.md). The
/// AI's choice is still checked and applied on the real game, where loops are found.
#[doc(hidden)]
pub fn ai_search_state(state: &GameState) -> std::borrow::Cow<'_, GameState> {
    let about_a_loop = matches!(
        state.waiting_for,
        WaitingFor::LoopShortcut { .. }
            | WaitingFor::RespondToShortcut { .. }
            | WaitingFor::PrecastCopyShortcutOffer { .. }
            | WaitingFor::RespondToPrecastCopyShortcut { .. }
    );
    if state.loop_detection.is_off() || about_a_loop {
        return std::borrow::Cow::Borrowed(state);
    }
    let mut copy = state.clone();
    copy.loop_detection = LoopDetectionMode::Off;
    std::borrow::Cow::Owned(copy)
}

/// Whether AI seats in games people play search against phase's wall-clock budget (1.5 s a
/// decision) rather than to their node and depth budgets only ([`ai_config`]). Off since
/// 2026-10-24: with the clock, a decision long enough to reach the budget depends on how busy the
/// server is, so the same game doesn't play the same way twice and a loaded server plays a weaker
/// AI. Without it every AI choice depends only on the game (as in the lab), at the cost of the
/// rare long decision running past 1.5 s on Hard and VeryHard (docs/play-performance.md).
pub const AI_CLOCK: bool = false;

/// An AI seat's configuration: phase's for its level and the table size; with `clock` off, in
/// phase's measurement mode, where every choice depends only on the game (as in the lab).
fn ai_config(difficulty: AiDifficulty, players: u8, seed: u64, clock: bool) -> AiConfig {
    let config = create_config_for_players(difficulty, Platform::Native, players);
    if clock { config } else { config.into_measurement(seed) }
}

/// Time spent by the calling thread on the CPU (wall-clock time where the system doesn't say), so
/// a measurement doesn't count the time other work on the machine had the core.
#[doc(hidden)]
pub struct Busy(f64, std::time::Instant);

impl Busy {
    pub fn start() -> Self {
        Busy(lab::thread_cpu_secs().unwrap_or(0.0), std::time::Instant::now())
    }

    pub fn elapsed(&self) -> std::time::Duration {
        match lab::thread_cpu_secs() {
            Some(now) => std::time::Duration::from_secs_f64((now - self.0).max(0.0)),
            None => self.1.elapsed(),
        }
    }
}

/// The AI's randomness for one decision: from the game's seed and how many actions the replay
/// log holds, so a game rebuilt from its log after a restart decides exactly as it would have.
fn ai_rng(seed: u64, logged: usize) -> StdRng {
    StdRng::seed_from_u64(seed ^ 0x9e37_79b9_7f4a_7c15 ^ (logged as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9))
}

/// The card under a face-down object as one viewer's board may show it: the name the engine's
/// projection gives that viewer (only its controller's, CR 708.5, or everyone's once the game is
/// over, CR 708.9), or every card's when all hands are shown (a game the computer plays alone).
fn face_down_identity(o: &engine::game::game_object::GameObject, all_hands: bool) -> Option<String> {
    if !o.face_down {
        return None;
    }
    if all_hands {
        return o.back_face.as_ref().map(|b| b.name.clone()).filter(|n| !n.is_empty());
    }
    Some(o.name.clone()).filter(|n| !n.is_empty() && n != "Hidden Card")
}

/// An ability's text as a label: its card's name for "~", loyalty costs without brackets
/// ("[−3]: …" reads "−3: …"), on one line.
fn ability_text(text: &str, name: &str) -> String {
    let mut out = phase_llm::render::text::one_line(&text.replace('~', name));
    if let Some(rest) = out.strip_prefix('[')
        && let Some(end) = rest.find("]:")
        && rest[..end].chars().all(|c| matches!(c, '+' | '−' | '-' | '0'..='9' | 'X'))
    {
        out = format!("{}{}", &rest[..end], &rest[end + 1..]);
    }
    out
}

/// The engine's battlefield keyword badges in words, sentence case: "Flying", "First strike",
/// "Toxic 2". Keywords with no plain name of their own keep their first word ("Ward").
fn keyword_labels(keywords: &[Keyword]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in keywords {
        let label = keyword_label(k);
        if !label.is_empty() && !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

fn keyword_label(k: &Keyword) -> String {
    // phase's Display writes the common ones in words and falls back to Debug for the rest
    // ("Toxic(2)", "TrampleOverPlaneswalkers", "Crew { power: 1, .. }", "Ward(Mana(..))").
    let shown = k.to_string();
    let cut = shown.find(['(', '{']).unwrap_or(shown.len());
    let head = shown[..cut].trim().to_string();
    let inner = shown[cut..].trim_start_matches(['(', '{']).trim_end_matches([')', '}']).trim();
    // A keyword's own number ("Toxic 2", "Crew 1"); a nested value (Ward's cost) stays out.
    let arg = if inner.contains(['(', '{']) {
        String::new()
    } else {
        inner.split(|c: char| !c.is_ascii_digit()).find(|n| !n.is_empty()).unwrap_or("").to_string()
    };
    // "TrampleOverPlaneswalkers" and "First Strike" both become words: "Trample over planeswalkers".
    let mut words = String::new();
    for (i, c) in head.chars().enumerate() {
        if c.is_uppercase() && i > 0 && !words.ends_with(' ') {
            words.push(' ');
        }
        words.push(c);
    }
    let mut words = words.split_whitespace().map(str::to_lowercase).collect::<Vec<_>>().join(" ");
    if let Some(first) = words.get(0..1) {
        words = format!("{}{}", first.to_uppercase(), &words[1..]);
    }
    if !arg.is_empty() {
        words = format!("{words} {arg}");
    }
    words
}

/// A cost in printed form where it has one: "{2}{R}", "{T}", "+1", "{1}, {T}". Empty when the
/// engine's cost has no printed shape here (sacrifice, discard and the like).
pub(crate) fn cost_text(cost: &AbilityCost) -> String {
    match cost {
        AbilityCost::Mana { cost } => phase_llm::render::text::mana_cost_text(cost),
        AbilityCost::Tap => "{T}".into(),
        AbilityCost::Untap => "{Q}".into(),
        AbilityCost::Loyalty { amount } if *amount > 0 => format!("+{amount}"),
        AbilityCost::Loyalty { amount } if *amount < 0 => format!("−{}", amount.unsigned_abs()),
        AbilityCost::Loyalty { .. } => "0".into(),
        AbilityCost::Composite { costs } => {
            let parts: Vec<String> = costs.iter().map(cost_text).collect();
            if parts.iter().any(String::is_empty) { String::new() } else { parts.join(", ") }
        }
        _ => String::new(),
    }
}

fn segments_text(segments: &[LogSegment]) -> String {
    segments
        .iter()
        .map(|s| match s {
            LogSegment::Text(t) => t.clone(),
            LogSegment::CardName { name, .. } => name.clone(),
            LogSegment::PlayerName { name, .. } => name.clone(),
            LogSegment::Number(n) => n.to_string(),
            LogSegment::Mana(m) => m.clone(),
            LogSegment::Zone(z) => format!("{z:?}").to_lowercase(),
            LogSegment::Keyword(k) => k.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct View {
    pub revision: u64,
    pub turn: u32,
    pub active: u8,
    pub phase: String,
    pub waiting_on: Vec<u8>,
    pub waiting: String,
    pub players: Vec<PlayerView>,
    pub battlefield: Vec<CardView>,
    pub stack: Vec<StackView>,
    pub command_zone: Vec<CardView>,
    pub exile: Vec<CardView>,
    /// The viewer's own hand; empty for spectators.
    pub hand: Vec<CardView>,
    /// Every player's hand by seat, only in [`Match::view_revealed`].
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub hands: BTreeMap<u8, Vec<CardView>>,
    /// The viewer's options, when it's their decision.
    pub decision: Option<Decision>,
    pub log: Vec<LogLine>,
    pub over: bool,
    pub winner: Option<u8>,
    /// The viewer's own turn controls, yields and remembered answers (people only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<TurnsView>,
    /// Someone asked to resolve the whole stack: who, and who has agreed (everyone sees it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve_all: Option<ResolveAllView>,
    /// A decision everyone takes part in, as this viewer may see it: the votes cast so far, the
    /// piles, who has faced a villainous choice (together.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub together: Option<TogetherView>,
    /// The newest things that happened, as this viewer may know them, oldest first (feed.rs).
    pub events: Vec<Happening>,
    /// Players knocked out, in the order they went out, each with its cause.
    pub outs: Vec<Out>,
    /// The game's numbers, once it's over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Stats>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerView {
    pub seat: u8,
    pub life: i32,
    pub poison: u32,
    pub hand: usize,
    pub library: usize,
    pub graveyard: Vec<CardView>,
    pub eliminated: bool,
    /// Out because they conceded (they left the game), rather than lost.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conceded: bool,
    /// Commander damage this player has taken, by commander name.
    pub commander_damage: BTreeMap<String, u32>,
    /// The companion they revealed before the game (public, CR 702.139a), and whether it has been
    /// put into their hand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub companion: Option<CompanionView>,
}

/// A revealed companion (rare.rs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompanionView {
    pub name: String,
    /// Put into their hand already (once per game, CR 702.139a).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub used: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CardView {
    pub id: u64,
    pub name: String,
    pub controller: u8,
    pub owner: u8,
    pub tapped: bool,
    pub power: Option<i32>,
    pub toughness: Option<i32>,
    pub loyalty: Option<u32>,
    pub damage: u32,
    pub counters: BTreeMap<String, u32>,
    pub types: Vec<String>,
    pub attached_to: Option<serde_json::Value>,
    /// Declared as an attacker in the current combat.
    pub attacking: bool,
    /// The player it attacks (the planeswalker's or battle's controller, for those).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attacks: Option<u8>,
    /// The planeswalker or battle it attacks, when it attacks one (`attacks` is its controller).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attacks_card: Option<u64>,
    /// An attacker that was blocked; it stays blocked even if its blockers leave (CR 509.1h).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub blocked: bool,
    /// Declared as a blocker in the current combat.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub blocking: bool,
    /// The attackers it blocks (the engine's blocker assignments; public, CR 509.1g).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<u64>,
    /// Its keyword abilities as the engine badges them on the battlefield ("Deathtouch").
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// A commander (public in Commander; never set on a face-down card).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub commander: bool,
    /// Commander tax: {2} for each earlier cast from the command zone.
    #[serde(skip_serializing_if = "is_zero")]
    pub tax: u32,
    /// A creature that can't attack or tap yet (haste counted).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sick: bool,
    /// Face down. Its name is "Face-down card" unless this viewer may look at it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub face_down: bool,
    /// The card under a face-down card, for a viewer the engine lets look at it: its controller
    /// (CR 708.5), or everyone once the game is over (CR 708.9). Nobody else's view carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub under: Option<String>,
    /// How a card in a graveyard, exile or the command zone got there, as this viewer saw it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub came: Option<Came>,
    /// Auras, Equipment and other permanents attached to it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<u64>,
    /// A double-faced card showing its back face.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub transformed: bool,
    /// Its power and toughness before anything changed them, when something has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_power: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_toughness: Option<i32>,
    /// The turn it entered the battlefield.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entered: Option<u32>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct StackView {
    /// The stack entry.
    pub id: u64,
    /// The card or permanent it comes from.
    pub source: u64,
    pub name: String,
    pub controller: u8,
    /// A triggered ability (the kind a seat may yield to).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub trigger: bool,
    /// An ability (triggered, activated, or a keyword action such as crew), not a spell.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ability: bool,
    /// A triggered or activated ability's own words, from the engine. A spell's words are its
    /// Oracle text, which the board has from the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The modes chosen for a modal spell or ability, in the card's words.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
    /// What it targets, as the viewer may see it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<StackTarget>,
    /// Still being cast or activated: its targets and costs aren't settled yet.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub casting: bool,
    /// The viewer yielded to it: Yama passes for them while it's on top.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub yielded: bool,
    /// A face-down spell's card, for a viewer who may look at it (its caster, CR 708.5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub under: Option<String>,
}

/// A stack entry's target as one seat may see it: a card by id or a player by seat, with its
/// name. A card in a hidden zone has no `target`, only "a card".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StackTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetView>,
    pub name: String,
    /// The card's controller, or the player targeted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<u8>,
}

#[cfg(test)]
mod view_tests;

#[cfg(test)]
mod feed_tests;

#[cfg(test)]
mod pay_tests;

#[cfg(test)]
mod ways_tests;

#[cfg(test)]
mod together_tests;

#[cfg(test)]
mod rare_tests;

#[cfg(test)]
mod loop_tests;

#[cfg(test)]
mod card_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attack_targets_read_as_the_board_sends_them() {
        let at: AttackAt = serde_json::from_str(r#"{"kind":"player","seat":2}"#).unwrap();
        assert_eq!(at, AttackAt::Player { seat: 2 });
        assert_eq!(at.to_engine(), AttackTarget::Player(PlayerId(2)));
        let pw: AttackAt = serde_json::from_str(r#"{"kind":"planeswalker","id":41}"#).unwrap();
        assert_eq!(AttackAt::from_engine(&pw.to_engine()), pw);
        let list: Vec<(u64, AttackAt)> = serde_json::from_str(r#"[[7,{"kind":"battle","id":9}]]"#).unwrap();
        assert_eq!(list, vec![(7, AttackAt::Battle { id: 9 })]);
    }

    #[test]
    fn target_options_say_exactly_what_they_target() {
        let card = GameAction::ChooseTarget { target: Some(TargetRef::Object(ObjectId(77))) };
        assert_eq!(TargetView::of(&card), Some(TargetView::Object { id: 77 }));
        let player = GameAction::SelectTargets { targets: vec![TargetRef::Player(PlayerId(2))] };
        assert_eq!(TargetView::of(&player), Some(TargetView::Player { seat: 2 }));
        let two = GameAction::SelectTargets { targets: vec![TargetRef::Player(PlayerId(1)), TargetRef::Player(PlayerId(2))] };
        assert_eq!(TargetView::of(&two), None);
        assert_eq!(TargetView::of(&GameAction::PassPriority), None);
        let o = OptionView { index: 3, label: "Target Bear".into(), kind: OptionKind::Target, object: None, ability: None, target: TargetView::of(&card), cost: None };
        assert_eq!(serde_json::to_value(&o).unwrap()["target"], serde_json::json!({"kind": "object", "id": 77}));
        let pass = OptionView { index: 0, label: "Pass".into(), kind: OptionKind::Pass, object: None, ability: None, target: None, cost: None };
        assert!(serde_json::to_value(&pass).unwrap().get("target").is_none());
    }

    #[test]
    fn ability_labels_drop_loyalty_brackets_and_name_the_card() {
        assert_eq!(ability_text("[+1]: Add {R}{R}.", "Chandra"), "+1: Add {R}{R}.");
        assert_eq!(
            ability_text("[−3]: ~ deals 4 damage to target creature.", "Chandra, Torch of Defiance"),
            "−3: Chandra, Torch of Defiance deals 4 damage to target creature."
        );
        assert_eq!(ability_text("[0]: Draw a card.", "Jace"), "0: Draw a card.");
        assert_eq!(ability_text("{T}: Add {C}{C}.", "Sol Ring"), "{T}: Add {C}{C}.");
        assert_eq!(ability_text("[Not a cost]: x", "A"), "[Not a cost]: x");
        assert_eq!(cost_text(&AbilityCost::Loyalty { amount: -7 }), "−7");
        assert_eq!(cost_text(&AbilityCost::Composite { costs: vec![AbilityCost::Tap, AbilityCost::Loyalty { amount: 2 }] }), "{T}, +2");
    }

    #[test]
    fn paying_mana_by_hand_says_pay_the_rest_and_cancel() {
        let e = Engine::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/act-cards.json")).unwrap();
        let deck = SeatDeck { companion: vec![], commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
        let mut m = e.new_match(1, vec![deck.clone(), deck], &[]).unwrap();
        m.state.waiting_for = WaitingFor::ManaPayment { player: PlayerId(0), convoke_mode: None };
        assert_eq!(m.label(&m.state, &GameAction::PassPriority), "Pay the rest");
        assert_eq!(OptionKind::of(&GameAction::PassPriority, &m.state.waiting_for), OptionKind::PayRest);
        assert_eq!(m.label(&m.state, &GameAction::CancelCast), "Cancel");
        assert_eq!(OptionKind::of(&GameAction::CancelCast, &m.state.waiting_for), OptionKind::Cancel);
        m.state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
        assert_eq!(OptionKind::of(&GameAction::PassPriority, &m.state.waiting_for), OptionKind::Pass);
    }

    #[test]
    fn stops_default_missing_sides_to_empty() {
        let s: Stops = serde_json::from_str(r#"{"own":["PreCombatMain","DeclareBlockers"]}"#).unwrap();
        assert!(s.own.contains("DeclareBlockers"));
        assert!(s.others.is_empty());
    }

    #[test]
    fn card_flags_stay_out_of_the_json_when_unset() {
        let c = CardView {
            id: 1,
            name: "Bear".into(),
            controller: 0,
            owner: 0,
            tapped: false,
            power: Some(2),
            toughness: Some(2),
            loyalty: None,
            damage: 0,
            counters: BTreeMap::new(),
            types: vec!["Creature".into()],
            attached_to: None,
            ..Default::default()
        };
        let v = serde_json::to_value(&c).unwrap();
        for key in ["attacks", "attacks_card", "blocked", "blocking", "blocks", "keywords", "commander", "tax", "sick"] {
            assert!(v.get(key).is_none(), "{key} should be left out");
        }
        let v = serde_json::to_value(CardView {
            commander: true,
            tax: 4,
            attacks: Some(3),
            attacks_card: Some(40),
            blocks: vec![9],
            keywords: vec!["Deathtouch".into()],
            ..c
        })
        .unwrap();
        assert_eq!(v["commander"], true);
        assert_eq!(v["tax"], 4);
        assert_eq!(v["attacks"], 3);
        assert_eq!(v["attacks_card"], 40);
        assert_eq!(v["blocks"], serde_json::json!([9]));
        assert_eq!(v["keywords"], serde_json::json!(["Deathtouch"]));
    }

    #[test]
    fn keywords_read_as_words() {
        let labels = keyword_labels(&[
            Keyword::Flying,
            Keyword::FirstStrike,
            Keyword::Deathtouch,
            Keyword::TrampleOverPlaneswalkers,
            Keyword::Toxic(2),
            Keyword::Flying,
        ]);
        assert_eq!(labels, ["Flying", "First strike", "Deathtouch", "Trample over planeswalkers", "Toxic 2"]);
        let crew: Keyword = "Crew:1".parse().unwrap();
        assert_eq!(keyword_labels(&[crew]), ["Crew 1"]);
    }
}
