//! Online play for Yama, built on the phase-rs rules engine (local fork, see
//! docs/engine-integration.md).
//!
//! The server owns one [`Match`] per live game. Humans and AI choose from the same
//! engine-issued option list (`AiDecisionContract`), so a person can never submit an action
//! the engine wouldn't offer, and every applied action goes through the engine's own
//! re-validation. Each accepted action is appended to a replay log that reproduces the game
//! from its seed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use engine::ai_support::{AiDecisionContract, AiProposalApplication, apply_ai_action_proposal};
use engine::database::CardDatabase;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::filter_state_for_viewer;
use engine::game::replay::{ReplayPlayer, reconstruct_initial_state};
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::game::combat::AttackTarget;
use engine::types::ability::TargetRef;
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

pub mod lab;

/// Engine build plus the card data it was built against. Stored with every game, because a
/// replay only reproduces under the same pair.
pub const ENGINE_VERSION: &str = "phase-v0.113.0+0571ee32-yama1/cards-eb309108";

/// How many lines of game log each view carries.
const LOG_LINES: usize = 60;

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

    /// The names in `lines` the engine doesn't know, as [`Engine::resolve_deck`] reports them, but
    /// without building the deck: one lookup per line, whatever its quantity.
    pub fn unknown_cards(&self, lines: &[DeckLine]) -> Vec<String> {
        lines.iter().filter(|l| self.face_name(l).is_none()).map(|l| l.name.to_string()).collect()
    }

    /// Start a Commander game. Seat order is the order of `decks`.
    pub fn new_match(&self, seed: u64, decks: Vec<SeatDeck>, ai: &[(u8, AiDifficulty)]) -> anyhow::Result<Match> {
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
            first_player: None,
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
        Ok(Match {
            rng: StdRng::seed_from_u64(header.seed ^ 0x9e37_79b9_7f4a_7c15),
            log: ReplayLog::new(header),
            state,
            session,
            ai: ai_configs,
            revision: 0,
            lines: Vec::new(),
            names: (1..=players).map(|n| format!("Player {n}")).collect(),
        })
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub turn: u32,
    pub text: String,
}

/// What one seat may do right now.
#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub revision: u64,
    /// The kind of decision, e.g. "priority" or "declare attackers".
    pub prompt: String,
    pub options: Vec<OptionView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionView {
    pub index: usize,
    pub label: String,
    /// The card this option is about, so the board can offer it when you tap that card.
    pub object: Option<u64>,
}

#[derive(Debug)]
pub enum ChoiceError {
    NotYourTurn,
    Stale,
    BadIndex,
    Rejected(String),
}

impl std::fmt::Display for ChoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotYourTurn => f.write_str("it isn't your decision"),
            Self::Stale => f.write_str("the game moved on; pick again"),
            Self::BadIndex => f.write_str("that option doesn't exist"),
            Self::Rejected(why) => write!(f, "the engine refused that: {why}"),
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

    /// Options for `seat`, or `None` if it isn't that seat's decision.
    pub fn decision(&self, seat: u8) -> Option<Decision> {
        let me = PlayerId(seat);
        if !self.state.waiting_for.acting_players().contains(&me) {
            return None;
        }
        let contract = AiDecisionContract::issue(&self.state, me);
        // Labels come from what this seat may see, never the full state.
        let vs = filter_state_for_viewer(&self.state, me);
        let options = contract
            .candidates
            .iter()
            .enumerate()
            .map(|(index, c)| OptionView {
                index,
                label: self.label(&vs, &c.action),
                object: c.action.source_object().map(|o| o.0),
            })
            .collect();
        Some(Decision { revision: self.revision, prompt: self.prompt(&vs), options })
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
        if revision != self.revision {
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
                self.accepted(&result.log_entries);
                Ok(())
            }
            AiProposalApplication::AppliedAction { result } => {
                self.log.push_action(actor, action);
                self.accepted(&result.log_entries);
                Ok(())
            }
            AiProposalApplication::Stale => Err(ChoiceError::Stale),
            AiProposalApplication::Rejected { rejection } => Err(ChoiceError::Rejected(format!("{rejection:?}"))),
        }
    }

    /// A card's name as `vs` (one seat's filtered view) shows it. Face-down cards stay hidden.
    fn name_in(vs: &GameState, id: &ObjectId) -> String {
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
            GameAction::ActivateAbility { source_id, .. } => format!("Use {}", Self::name_in(vs, source_id)),
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

    /// Pass priority for people when stopping wouldn't help them, like Arena's smart stops:
    /// a person stops in their own main phases, whenever the stack has something they could
    /// respond to, and at an opponent's end step if they could cast a spell. Every other
    /// decision (targets, blocks, mulligans) always waits. Seats in `full_control` stop at
    /// every priority. Returns how many passes were made.
    pub fn auto_pass(&mut self, humans: &[u8], full_control: &HashSet<u8>) -> usize {
        let mut passed = 0;
        loop {
            let Some(seat) = self.waiting_on().into_iter().find(|s| humans.contains(s) && self.should_auto_pass(*s, full_control)) else {
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

    fn should_auto_pass(&self, seat: u8, full_control: &HashSet<u8>) -> bool {
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
        if !self.state.stack.is_empty() {
            return false; // something to respond to
        }
        let mine = self.state.active_player.0 == seat;
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
        self.accepted(&result.log_entries);
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
            let Some(action) = choose_action_with_session(&self.state, owner, config, &mut self.rng, &self.session) else {
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
            self.accepted(&result.log_entries);
            steps += 1;
        }
        Ok(steps)
    }

    fn accepted(&mut self, entries: &[GameLogEntry]) {
        self.revision += 1;
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
            decision: viewer.and_then(|seat| self.decision(seat)),
            log: self.lines.iter().rev().take(LOG_LINES).rev().cloned().collect(),
            over: self.is_over(),
            winner: self.winner(),
        }
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
}

#[derive(Debug, Clone, Serialize)]
pub struct StackView {
    pub name: String,
    pub controller: u8,
}
