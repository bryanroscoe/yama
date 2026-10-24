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

use std::collections::{BTreeMap, HashMap, HashSet};
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
use engine::types::game_state::{GameState, MulliganDecisionPhase, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::game::combat::AttackTarget;
use engine::types::ability::{AbilityCost, TargetRef};
use engine::types::actions::{GameAction, MulliganChoice};
use engine::types::log::{GameLogEntry, LogImportance, LogSegment, LogVisibility};
use engine::types::match_config::MatchConfig;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::replay::{ReplayHeader, ReplayLog};
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{AiConfig, AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};

pub use phase_ai::config::AiDifficulty as Difficulty;

pub mod act;
pub mod lab;
pub mod pilot;

pub use act::{Act, Pending};

/// Engine build plus the card data it was built against. Stored with every game, because a
/// replay only reproduces under the same pair.
pub const ENGINE_VERSION: &str = "phase-v0.113.0+0571ee32-yama1/cards-eb309108";

/// How many lines of game log each view carries.
const LOG_LINES: usize = 60;

/// Cards in an opening hand (CR 103.4).
const STARTING_HAND: usize = 7;

pub struct Engine {
    db: Arc<CardDatabase>,
}

/// A deck as the engine wants it: names, one entry per copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeatDeck {
    pub commander: Vec<String>,
    pub main: Vec<String>,
}

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
        let db = CardDatabase::from_export(card_data).map_err(|e| anyhow::anyhow!("loading {}: {e}", card_data.display()))?;
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
        let mut deck = SeatDeck { commander: vec![], main: vec![] };
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

    /// The names in `lines` the engine doesn't know, as [`Engine::resolve_deck`] reports them, but
    /// without building the deck: one lookup per line, whatever its quantity.
    pub fn unknown_cards(&self, lines: &[DeckLine]) -> Vec<String> {
        lines.iter().filter(|l| self.face_name(l).is_none()).map(|l| l.name.to_string()).collect()
    }

    /// Start a Commander game. Seat order is the order of `decks`.
    pub fn new_match(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
        self.new_match_first(seed, decks, ai, None)
    }

    /// [`Engine::new_match`], with `first` taking the first turn instead of the engine's roll.
    /// phase's game setup only honours seat 0 or 1 here; to start anyone else, rotate the decks
    /// so that player is seat 0 (turn order is the same cycle).
    pub fn new_match_first(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)], first: Option<u8>) -> anyhow::Result<Match> {
        if first.is_some_and(|f| f > 1) {
            bail!("phase can only start seat 0 or 1; rotate the seats so the first player is seat 0");
        }
        if !(2..=6).contains(&decks.len()) {
            bail!("Commander games here have 2 to 6 players");
        }
        let lists: Vec<PlayerDeckList> = decks
            .into_iter()
            .map(|d| PlayerDeckList { main_deck: d.main, commander: d.commander, ..Default::default() })
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
            match_config: MatchConfig::default(),
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
        let mut state = player.seek(n).map_err(|e| anyhow::anyhow!("replay diverged: {e:?}"))?.clone();
        state.debug_mode = false;
        state.all_card_names = self.db.card_names().into();
        engine::game::install_card_db(&mut state, Arc::clone(&self.db));
        m.session = AiSession::arc_from_game(&state);
        m.rng = StdRng::seed_from_u64(log.header.seed ^ u64::from(n));
        m.revision = u64::from(n);
        m.state = state;
        m.log = log;
        m.remark(None);
        Ok(m)
    }

    fn start(&self, header: ReplayHeader, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
        let mut state = reconstruct_initial_state(&header, Some(&self.db)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        // Replays are reconstructed in debug mode; a live server game never is.
        state.debug_mode = false;
        state.all_card_names = self.db.card_names().into();
        let players = header.player_count;
        let ai_configs = ai
            .iter()
            .map(|(seat, d)| (PlayerId(*seat), create_config_for_players(*d, Platform::Native, players)))
            .collect();
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
            marks: HashMap::new(),
        };
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
}

/// Where a person wants the game to stop for them, by step (phase's names, e.g.
/// "PreCombatMain"), on their own turns and on everyone else's. Replaces the default smart
/// stops (main phases, and an opponent's end step when a spell could be cast). Anything on the
/// stack they could answer, and every decision other than priority, still waits for them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stops {
    #[serde(default)]
    pub own: HashSet<String>,
    #[serde(default)]
    pub others: HashSet<String>,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct AttackerChoice {
    pub id: u64,
    /// Whom this creature may attack, as the engine lists them.
    pub targets: Vec<AttackAt>,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockerChoice {
    pub id: u64,
    /// The attacking creatures this one may block.
    pub attackers: Vec<u64>,
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
    Other,
}

impl OptionKind {
    fn of(action: &GameAction, waiting: &WaitingFor) -> Self {
        match action {
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
        let me = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&me) {
            return None;
        }
        let contract = AiDecisionContract::issue(&self.state, me);
        // Labels come from what this seat may see, never the full state.
        let vs = filter_state_for_viewer(&self.state, me);
        let mut options: Vec<OptionView> = contract
            .candidates
            .iter()
            .enumerate()
            .map(|(index, c)| OptionView {
                index,
                label: self.label(&vs, &c.action),
                kind: OptionKind::of(&c.action, &vs.waiting_for),
                object: c.action.source_object().map(|o| o.0),
                ability: match c.action {
                    GameAction::ActivateAbility { ability_index, .. } => Some(ability_index),
                    _ => None,
                },
                target: TargetView::of(&c.action),
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
            pending: Pending::of(&vs, me, &candidates, &self.names),
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
        match &vs.waiting_for {
            WaitingFor::DeclareAttackers { player, valid_attacker_ids, valid_attack_targets, valid_attack_targets_by_attacker, .. }
                if *player == me =>
            {
                let attackers = valid_attacker_ids
                    .iter()
                    .map(|id| {
                        // Older states have no per-attacker map; fall back to the shared list.
                        let targets = match valid_attack_targets_by_attacker {
                            Some(by) => by.get(id).map(|ts| ts.iter().map(AttackAt::from_engine).collect()).unwrap_or_default(),
                            None => valid_attack_targets.iter().map(AttackAt::from_engine).collect(),
                        };
                        AttackerChoice { id: id.0, targets }
                    })
                    .filter(|a| !a.targets.is_empty())
                    .collect();
                (Some(AttackChoice { attackers }), None)
            }
            WaitingFor::DeclareBlockers { player, valid_blocker_ids, valid_block_targets, .. } if *player == me => {
                let blockers = valid_blocker_ids
                    .iter()
                    .map(|id| {
                        let mut attackers: Vec<u64> = valid_block_targets.get(id).map(|a| a.iter().map(|o| o.0).collect()).unwrap_or_default();
                        attackers.sort_unstable();
                        BlockerChoice { id: id.0, attackers }
                    })
                    .filter(|b| !b.attackers.is_empty())
                    .collect();
                (None, Some(BlockChoice { blockers }))
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
        let action = contract.candidates.get(index).ok_or(ChoiceError::BadIndex)?.action.clone();
        let actor = contract.authorized_actor;
        match apply_ai_action_proposal(&mut self.state, &contract, actor, action.clone()) {
            AiProposalApplication::AppliedStackPass { result } => {
                self.log.push_verified_ai_priority_pass(actor, owner);
                self.accepted(&result.log_entries, Some(seat));
                Ok(())
            }
            AiProposalApplication::AppliedAction { result } => {
                self.log.push_action(actor, action);
                self.accepted(&result.log_entries, Some(seat));
                Ok(())
            }
            AiProposalApplication::Stale => Err(ChoiceError::Stale),
            AiProposalApplication::Rejected { rejection } => Err(ChoiceError::Rejected(format!("{rejection:?}"))),
        }
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
                self.accepted(&result.log_entries, Some(seat));
                Ok(())
            }
            Err(e) => Err(ChoiceError::Rejected(self.plain_reason(owner, &e.to_string()))),
        }
    }

    /// Answer `seat`'s decision with `answer` (the client's `act` message). It must fit the
    /// decision's [`Pending`] (or be a cancel the engine offers), and is applied to a copy of the
    /// game first, so a refused answer leaves the game exactly as it was.
    pub fn act(&mut self, seat: u8, revision: u64, answer: &Act) -> Result<(), ChoiceError> {
        if !self.current(seat, revision) {
            return Err(ChoiceError::Stale);
        }
        match act::answer(&mut self.state, PlayerId(seat), answer) {
            Ok(done) => {
                self.log.push_action(done.actor, done.action);
                self.accepted(&done.result.log_entries, Some(seat));
                Ok(())
            }
            Err(act::Refusal::NotYours) => Err(ChoiceError::NotYourTurn),
            Err(act::Refusal::DoesntFit(why)) => Err(ChoiceError::DoesntFit(why)),
            Err(act::Refusal::Engine(why)) => Err(ChoiceError::Rejected(self.plain_reason(PlayerId(seat), &why))),
        }
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
            GameAction::CastSpell { object_id, targets, .. } if targets.is_empty() => format!("Cast {}", Self::name_in(vs, object_id)),
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
            GameAction::DecideOptionalEffect { accept } => if *accept { "Yes".into() } else { "No".into() },
            GameAction::DecideOptionalCost { pay } => if *pay { "Pay the extra cost".into() } else { "Don't pay it".into() },
            GameAction::PayUnlessCost { pay } => if *pay { "Pay the cost".into() } else { "Don't pay".into() },
            GameAction::ChooseX { value } => format!("X = {value}"),
            GameAction::Equip { equipment_id, target_id } => format!("Equip {} to {}", Self::name_in(vs, equipment_id), Self::name_in(vs, target_id)),
            GameAction::ChooseOption { choice } => choice.clone(),
            GameAction::CancelCast => "Cancel".into(),
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
                WaitingFor::ReplacementChoice { candidates, .. } => candidates
                    .get(*index)
                    .map(|c| if c.description.is_empty() { c.source_name.clone() } else { c.description.clone() })
                    .unwrap_or_else(|| format!("Option {}", index + 1)),
                _ => format!("Option {}", index + 1),
            },
            _ => phase_llm::render::action::describe_action(&self.state, action),
        }
    }

    /// An activated ability in its own words: the card's text for it, with its cost ("+1: Draw two
    /// cards, then put a card from your hand on the bottom of your library."), so a planeswalker's
    /// abilities read apart (PP-04). The engine writes the card's own name as "~". Falls back to
    /// the cost, then to "Use <card>".
    fn ability_label(vs: &GameState, source: &ObjectId, index: usize) -> String {
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

    /// Pass priority for people when stopping wouldn't help them, like Arena's smart stops:
    /// a person stops in their own main phases, whenever someone else's spell or ability is on
    /// top of the stack and they could respond, and at an opponent's end step if they could cast
    /// a spell. Their own spell on top resolves without asking. Every other
    /// decision (targets, blocks, mulligans) always waits. Seats in `full_control` stop at
    /// every priority; seats with their own `stops` stop at the steps they chose instead of
    /// the main phases and end step. Returns how many passes were made.
    pub fn auto_pass(&mut self, humans: &[u8], full_control: &HashSet<u8>, stops: &HashMap<u8, Stops>) -> usize {
        let mut passed = 0;
        loop {
            let Some(seat) = self.waiting_on().into_iter().find(|s| humans.contains(s) && self.should_auto_pass(*s, full_control, stops.get(s))) else {
                return passed;
            };
            let contract = AiDecisionContract::issue(&self.state, PlayerId(seat));
            let Some(index) = contract.candidates.iter().position(|c| matches!(c.action, GameAction::PassPriority)) else {
                return passed;
            };
            if self.choose(seat, self.revision, index).is_err() {
                return passed;
            }
            passed += 1;
        }
    }

    fn should_auto_pass(&self, seat: u8, full_control: &HashSet<u8>, stops: Option<&Stops>) -> bool {
        let WaitingFor::Priority { player } = &self.state.waiting_for else { return false };
        if player.0 != seat {
            return false;
        }
        let contract = AiDecisionContract::issue(&self.state, PlayerId(seat));
        // Land abilities (fetchlands and the like) don't make a stop worthwhile on their own;
        // you still get them whenever you do stop.
        let is_land_ability = |a: &GameAction| match a {
            GameAction::ActivateAbility { source_id, .. } => self
                .state
                .objects
                .get(source_id)
                .is_some_and(|o| o.card_types.core_types.iter().any(|t| format!("{t:?}") == "Land")),
            _ => false,
        };
        let mut others = contract
            .candidates
            .iter()
            .filter(|c| !matches!(c.action, GameAction::PassPriority) && !is_land_ability(&c.action))
            .peekable();
        let anything_else = contract.candidates.iter().any(|c| !matches!(c.action, GameAction::PassPriority));
        if !anything_else {
            return true; // nothing else is legal
        }
        if full_control.contains(&seat) {
            return false;
        }
        if others.peek().is_none() {
            return true; // only land abilities
        }
        if let Some(top) = self.state.stack.last() {
            // Your own spell or ability on top resolves without asking you (PP-07; Bryan's
            // decision 8, 2026-10-23). Everyone else still gets to respond, and if someone does,
            // you're asked about theirs. Someone else's on top: you could respond, so stop.
            return top.controller.0 == seat;
        }
        let mine = self.state.active_player.0 == seat;
        if let Some(stops) = stops {
            // The person's own stops: wait at the steps they chose, on their turns or others'.
            let phase = format!("{:?}", self.state.phase);
            return !(if mine { &stops.own } else { &stops.others }).contains(&phase);
        }
        match self.state.phase {
            Phase::PreCombatMain | Phase::PostCombatMain => !mine,
            Phase::End => mine || !others.any(|c| matches!(c.action, GameAction::CastSpell { .. })),
            _ => true,
        }
    }

    /// `seat` leaves the game (CR 104.3a). Allowed at any time.
    pub fn concede(&mut self, seat: u8) -> anyhow::Result<()> {
        let me = PlayerId(seat);
        let action = GameAction::Concede { player_id: me };
        let result = engine::game::engine::apply(&mut self.state, me, action.clone()).map_err(|e| anyhow::anyhow!("{e}"))?;
        self.log.push_action(me, action);
        self.accepted(&result.log_entries, Some(seat));
        Ok(())
    }

    /// Let AI seats act until a human must decide, the game ends, or `max_steps` is reached.
    /// Returns how many actions the AI took. CPU-heavy: call from a large-stack worker thread.
    pub fn run_ai(&mut self, max_steps: usize) -> anyhow::Result<usize> {
        let ai_players: HashSet<PlayerId> = self.ai.keys().copied().collect();
        let mut steps = 0;
        while steps < max_steps && !self.is_over() {
            let Some((owner, actor)) = eligible_ai_decision(&self.state, &ai_players) else { break };
            let contract = AiDecisionContract::issue(&self.state, owner);
            let config = &self.ai[&actor];
            let chosen = choose_action_with_session(&self.state, owner, config, &mut self.rng, &self.session)
                .or_else(|| if self.fallback { phase_ai::search::fallback_action(&self.state, config, &contract) } else { None });
            let Some(action) = chosen else {
                bail!("AI for seat {} found no action", actor.0);
            };
            let result = if verified_ai_stack_pass_player(&self.state, &action).is_some() {
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
            self.accepted(&result.log_entries, None);
            steps += 1;
        }
        Ok(steps)
    }

    /// Bookkeeping after the engine took an action: the revision, the public log, and which
    /// people's decisions changed. `acted` is the person who answered, if one did.
    fn accepted(&mut self, entries: &[GameLogEntry], acted: Option<u8>) {
        self.revision += 1;
        self.remark(acted);
        for e in entries {
            // Only public, headline entries: detail lines and anything revealing hidden cards stay out.
            if e.presentation.importance != LogImportance::Essential || e.presentation.visibility != LogVisibility::Public {
                continue;
            }
            self.lines.push(LogLine { turn: e.turn, text: segments_text(&e.segments) });
        }
        if self.lines.len() > LOG_LINES * 4 {
            self.lines.drain(..self.lines.len() - LOG_LINES);
        }
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

    fn view_of(&self, state: &GameState, viewer: Option<u8>, all_hands: bool) -> View {
        let obj = |id: &ObjectId| -> Option<CardView> {
            let o = state.objects.get(id)?;
            Some(CardView {
                id: id.0,
                name: if o.face_down { "Face-down card".into() } else { o.name.clone() },
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
                attacking: state.combat.as_ref().is_some_and(|c| c.attackers.iter().any(|a| a.object_id == *id)),
                attacks: state.combat.as_ref().and_then(|c| c.attackers.iter().find(|a| a.object_id == *id)).map(|a| a.defending_player.0),
                blocking: state.combat.as_ref().is_some_and(|c| c.blocker_to_attacker.contains_key(id)),
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
                commander_damage: state
                    .commander_damage
                    .iter()
                    .filter(|d| d.player == p.id)
                    .map(|d| (Self::name_in(&state, &d.commander), d.damage))
                    .collect(),
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
                .map(|s| StackView {
                    name: match state.objects.get(&s.source_id) {
                        Some(o) if o.face_down => "A face-down spell".into(),
                        Some(o) if !o.name.is_empty() => o.name.clone(),
                        _ => "An ability".into(),
                    },
                    controller: s.controller.0,
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
            decision: viewer.and_then(|seat| self.decision(seat)),
            log: self.lines.iter().rev().take(LOG_LINES).rev().cloned().collect(),
            over: self.is_over(),
            winner: self.winner(),
        }
    }
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
    /// Commander damage this player has taken, by commander name.
    pub commander_damage: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize)]
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
    /// Declared as a blocker in the current combat.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub blocking: bool,
    /// A commander (public in Commander; never set on a face-down card).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub commander: bool,
    /// Commander tax: {2} for each earlier cast from the command zone.
    #[serde(skip_serializing_if = "is_zero")]
    pub tax: u32,
    /// A creature that can't attack or tap yet (haste counted).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sick: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct StackView {
    pub name: String,
    pub controller: u8,
}

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
        let o = OptionView { index: 3, label: "Target Bear".into(), kind: OptionKind::Target, object: None, ability: None, target: TargetView::of(&card) };
        assert_eq!(serde_json::to_value(&o).unwrap()["target"], serde_json::json!({"kind": "object", "id": 77}));
        let pass = OptionView { index: 0, label: "Pass".into(), kind: OptionKind::Pass, object: None, ability: None, target: None };
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
        let deck = SeatDeck { commander: vec!["Combat Celebrant".into()], main: vec!["Mountain".into(); 99] };
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
            attacking: false,
            attacks: None,
            blocking: false,
            commander: false,
            tax: 0,
            sick: false,
        };
        let v = serde_json::to_value(&c).unwrap();
        for key in ["attacks", "blocking", "commander", "tax", "sick"] {
            assert!(v.get(key).is_none(), "{key} should be left out");
        }
        let v = serde_json::to_value(CardView { commander: true, tax: 4, attacks: Some(3), ..c }).unwrap();
        assert_eq!(v["commander"], true);
        assert_eq!(v["tax"], 4);
        assert_eq!(v["attacks"], 3);
    }
}
