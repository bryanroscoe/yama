//! What happened in a game, for each viewer (PP-02; docs/game-interactions-review-2026-10-23.md,
//! build plan section 11).
//!
//! Every action's `ActionResult.events` comes through [`Feed::record`] right after the action, so
//! the AI's batches and Yama's auto-passes are covered step by step. For each seat, and once for
//! spectators, the engine's own `filter_events_for_viewer` decides which events that viewer may
//! receive, and card names come from that viewer's projection of the game
//! (`filter_state_for_viewer`). What's left is turned into Yama's small [`What`] list, kept in a
//! ring buffer per viewer.
//!
//! Only facts the engine states go in: a cast, a move between zones with the engine's reason for
//! it (destroyed, sacrificed, discarded, milled, countered), damage, life, attacks and blocks,
//! tokens, counters, reveals, draws, knockouts and the end. The board writes them as plain
//! sentences (web/src/play/feed.ts); nothing here summarises or advises.
//!
//! Alongside the feed, public facts that need the whole game are tallied from every event (the
//! game-over stats), and each knockout is kept with its cause. The engine's `PlayerEliminated`
//! carries no cause, so the cause is Yama's reading of the board at that moment (commander damage,
//! poison, life, an empty library), marked `inferred`; a concession is Yama's own record.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use engine::game::filter_events_for_viewer;
use engine::game::filter_state_for_viewer;
use engine::game::visibility::filter_state_for_unseated_viewer;
use engine::game::combat::AttackTarget;
use engine::types::ability::TargetRef;
use engine::types::card_type::CoreType;
use engine::types::events::{ActivatedAbilityKind, GameEvent};
use engine::types::game_state::{GameState, ZoneChangeRecord};
use engine::types::identifiers::ObjectId;
use engine::types::player::{PlayerCounterKind, PlayerId};
use engine::types::zones::Zone;
use serde::Serialize;

/// Happenings kept per viewer.
pub const KEEP: usize = 1000;
/// Happenings each view carries (the newest).
pub const SHOWN: usize = 300;

/// The name phase gives a card a viewer may not identify (`game/visibility.rs`).
const HIDDEN: &str = "Hidden Card";

/// A seat, or `None` for anyone watching who isn't seated.
type Viewer = Option<u8>;

/// One thing that happened, as one viewer may know it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Happening {
    /// Increases through the game; a viewer's happenings are in order.
    pub seq: u64,
    pub turn: u32,
    /// Whose turn it was.
    pub active: u8,
    #[serde(flatten)]
    pub what: What,
}

/// A card as one viewer may know it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Seen {
    /// Its id while it sits where this viewer sees it (a public zone, or their own hand), so the
    /// board can point at it. A card that went somewhere hidden loses it: nobody follows it there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    /// `None` for a card this viewer can't identify.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Face down: unnamed for everyone who may not look at it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub face_down: bool,
}

/// What something was done to: a player or a card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Hit {
    Player { seat: u8 },
    Card { card: Seen },
}

/// The engine's reason for a move between zones, where it gives one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    Moved,
    Destroyed,
    Sacrificed,
    Discarded,
    Milled,
    Countered,
    /// Its owner left the game, taking it with them (CR 800.4a).
    Left,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum What {
    /// A turn began.
    Turn { seat: u8 },
    Cast { seat: u8, card: Seen },
    Land { seat: u8, card: Seen },
    /// An activated ability other than a mana ability (a loyalty ability, crew, a tap ability).
    Activated { seat: u8, card: Seen },
    /// A card moved between zones. `by` is what destroyed or countered it, when the engine says.
    Moved {
        card: Seen,
        owner: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<&'static str>,
        to: &'static str,
        how: How,
        #[serde(skip_serializing_if = "Option::is_none")]
        by: Option<Seen>,
        /// A creature as it moved, so leaving the battlefield for a graveyard reads "died".
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        creature: bool,
    },
    /// `life` is the player's total before and after, when the engine reported it with the damage.
    Damage {
        source: Seen,
        #[serde(skip_serializing_if = "Option::is_none")]
        by: Option<u8>,
        to: Hit,
        amount: u32,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        combat: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        life: Option<[i32; 2]>,
    },
    Life {
        seat: u8,
        delta: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<i32>,
    },
    Poison { seat: u8, delta: i32 },
    Attack { seat: u8, attacks: Vec<Attacked> },
    /// Blocks declared by `seat`: each blocker with the attacker it blocks.
    Block { seat: u8, blocks: Vec<[Seen; 2]> },
    Token { seat: u8, card: Seen, count: u32 },
    Counters { card: Seen, counter: String, delta: i32 },
    Control { card: Seen, from: u8, to: u8 },
    Transformed { card: Seen },
    /// Cards revealed to everyone (CR 701.20a).
    Revealed { seat: u8, cards: Vec<Seen> },
    /// Cards `seat` looked at privately (CR 701.20e: "look at target player's hand"). Only that
    /// seat's feed has it.
    Looked {
        seat: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        whose: Option<u8>,
        cards: Vec<Seen>,
    },
    /// Cards drawn: named only for whoever may see them, a count for everyone else.
    Drew { seat: u8, count: u32, cards: Vec<Seen> },
    /// An answer Yama gave for `seat` from memory ("Always pay"); only that seat's feed has it.
    /// `answer` is its id in the seat's remembered answers, so the log can turn it off.
    Automatic { seat: u8, name: String, accept: bool, answer: String },
    /// `seat` is out of the game; the cause is in the view's `outs`.
    Out { seat: u8 },
    Over {
        #[serde(skip_serializing_if = "Option::is_none")]
        winner: Option<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Attacked {
    pub card: Seen,
    pub at: Hit,
}

/// How a card in a graveyard, exile or the command zone got there, for the zone sheet's captions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Came {
    pub turn: u32,
    pub how: How,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<&'static str>,
}

/// A player knocked out, in the order they went out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Out {
    pub seat: u8,
    pub turn: u32,
    /// Their life total when they went out.
    pub life: i32,
    pub why: Why,
    /// The cause is Yama's reading of the board, not something the engine stated.
    pub inferred: bool,
    /// Players with the same `batch` went out at the same moment.
    pub batch: u64,
}

/// Why a player is out. Everything but a concession is read from the board as they went out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Why {
    Conceded,
    /// 21 or more combat damage from one commander (CR 704.5u): its name and its owner's seat.
    Commander { name: String, seat: u8, damage: u32 },
    Poison { count: u32 },
    Life { life: i32 },
    /// Drew from an empty library (CR 704.5b).
    Library,
    Unknown,
}

/// The game's public numbers for each seat, for the end of the game.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SeatStats {
    pub seat: u8,
    pub spells: u32,
    pub lands: u32,
    pub drew: u32,
    /// Damage this seat's sources dealt to players.
    pub damage: u32,
    /// Combat damage this seat's commanders dealt to players.
    pub commander_damage: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stats {
    pub turns: u32,
    pub seats: Vec<SeatStats>,
}

#[derive(Debug, Default)]
pub(crate) struct Feed {
    seq: u64,
    batch: u64,
    /// Turn and active seat as the last batch left them (a batch can start a new turn).
    cursor: Option<(u32, u8)>,
    by: BTreeMap<Viewer, VecDeque<Happening>>,
    came: BTreeMap<Viewer, HashMap<u64, Came>>,
    outs: Vec<Out>,
    tally: BTreeMap<u8, SeatStats>,
    /// The private look last noted, so a look that stays open across actions is noted once.
    look: Option<(u8, Vec<ObjectId>)>,
}

impl Feed {
    /// Take one action's events: tally them, and add what each viewer may know to their feed.
    /// `state` is the game right after the action; `conceded` holds the seats that conceded.
    pub(crate) fn record(&mut self, events: &[GameEvent], state: &GameState, conceded: &BTreeSet<u8>) {
        self.batch += 1;
        let start = self.cursor.unwrap_or((state.turn_number, state.active_player.0));
        self.tally(events, state, conceded);
        if events.iter().any(worth_telling) {
            let seats = state.players.iter().map(|p| Some(p.id.0));
            for viewer in seats.chain(std::iter::once(None)) {
                let shown = filter_events_for_viewer(events, state, viewer_id(viewer));
                let mut lens = Lens { state, viewer, vs: None };
                let (whats, arrivals) = convert(&shown, events, state, &mut lens, start);
                let came = self.came.entry(viewer).or_default();
                for (id, arrived) in arrivals {
                    match arrived {
                        Some(c) => came.insert(id, c),
                        None => came.remove(&id),
                    };
                }
                for (turn, active, what) in whats {
                    self.push(viewer, turn, active, what);
                }
            }
        }
        self.private_look(state);
        self.cursor = Some((state.turn_number, state.active_player.0));
    }

    /// An answer Yama gave for `seat` from memory, in that seat's feed only.
    pub(crate) fn automatic(&mut self, seat: u8, name: &str, accept: bool, answer: &str, state: &GameState) {
        let what = What::Automatic { seat, name: name.to_string(), accept, answer: answer.to_string() };
        self.push(Some(seat), state.turn_number, state.active_player.0, what);
    }

    fn push(&mut self, viewer: Viewer, turn: u32, active: u8, what: What) {
        self.seq += 1;
        let feed = self.by.entry(viewer).or_default();
        feed.push_back(Happening { seq: self.seq, turn, active, what });
        while feed.len() > KEEP {
            feed.pop_front();
        }
    }

    /// The newest happenings `viewer` may know, oldest first.
    pub(crate) fn recent(&self, viewer: Viewer, n: usize) -> Vec<Happening> {
        let Some(feed) = self.by.get(&viewer) else { return vec![] };
        feed.iter().skip(feed.len().saturating_sub(n)).cloned().collect()
    }

    /// How a card in a public zone got there, as `viewer` saw it happen.
    pub(crate) fn came(&self, viewer: Viewer, id: u64) -> Option<Came> {
        self.came.get(&viewer)?.get(&id).copied()
    }

    pub(crate) fn outs(&self) -> &[Out] {
        &self.outs
    }

    /// The game's numbers for each seat, as they stand.
    pub(crate) fn stats(&self, state: &GameState) -> Stats {
        let seats = state
            .players
            .iter()
            .map(|p| {
                let seat = p.id.0;
                let mut s = self.tally.get(&seat).cloned().unwrap_or_default();
                s.seat = seat;
                // The engine keeps commander damage by commander; each commander's owner dealt it.
                s.commander_damage = state
                    .commander_damage
                    .iter()
                    .filter(|d| state.objects.get(&d.commander).is_some_and(|o| o.owner == p.id))
                    .map(|d| d.damage)
                    .sum();
                s
            })
            .collect();
        Stats { turns: state.turn_number, seats }
    }

    /// Public counts and knockouts, from every event of the action (nothing here names a card
    /// anyone couldn't see).
    fn tally(&mut self, events: &[GameEvent], state: &GameState, conceded: &BTreeSet<u8>) {
        let controller = |id: &ObjectId| state.objects.get(id).map(|o| o.controller.0);
        for e in events {
            match e {
                GameEvent::SpellCast { controller: c, .. } => self.stat(c.0).spells += 1,
                GameEvent::LandPlayed { player_id, .. } => self.stat(player_id.0).lands += 1,
                // Only the count: which card was drawn stays with whoever may see it.
                GameEvent::CardDrawn { player_id, .. } => self.stat(player_id.0).drew += 1,
                GameEvent::DamageDealt { source_id, target: TargetRef::Player(_), amount, .. } => {
                    if let Some(seat) = controller(source_id) {
                        self.stat(seat).damage += amount;
                    }
                }
                GameEvent::PlayerEliminated { player_id } if !self.outs.iter().any(|o| o.seat == player_id.0) => {
                    let why = why_out(state, *player_id, conceded);
                    let inferred = !matches!(why, Why::Conceded | Why::Unknown);
                    let life = state.players.iter().find(|p| p.id == *player_id).map(|p| p.life).unwrap_or(0);
                    self.outs.push(Out { seat: player_id.0, turn: state.turn_number, life, why, inferred, batch: self.batch });
                }
                _ => {}
            }
        }
    }

    fn stat(&mut self, seat: u8) -> &mut SeatStats {
        self.tally.entry(seat).or_insert_with(|| SeatStats { seat, ..Default::default() })
    }

    /// A private look (CR 701.20e) open now, noted once for the seat looking.
    fn private_look(&mut self, state: &GameState) {
        let now = state.private_look_player.filter(|_| !state.private_look_ids.is_empty()).map(|p| (p.0, state.private_look_ids.clone()));
        if now.is_some() && now != self.look {
            let (seat, ids) = now.clone().unwrap();
            // Names as the seat looking sees them: the engine shows them the cards it's looking at.
            let mut lens = Lens { state, viewer: Some(seat), vs: None };
            let cards: Vec<Seen> = ids.iter().map(|id| lens.seen(*id, &HashMap::new())).collect();
            let whose = ids.first().and_then(|id| state.objects.get(id)).map(|o| o.owner.0);
            self.push(Some(seat), state.turn_number, state.active_player.0, What::Looked { seat, whose, cards });
        }
        self.look = now;
    }
}

/// The engine's viewer id: a seat, or one no seat has, which the engine treats as a spectator.
fn viewer_id(viewer: Viewer) -> PlayerId {
    PlayerId(viewer.unwrap_or(u8::MAX))
}

/// Why `player` is out, read from the board as they went out.
fn why_out(state: &GameState, player: PlayerId, conceded: &BTreeSet<u8>) -> Why {
    if conceded.contains(&player.0) {
        return Why::Conceded;
    }
    let commander = state
        .commander_damage
        .iter()
        .filter(|d| d.player == player && d.damage >= 21)
        .max_by_key(|d| d.damage)
        .and_then(|d| state.objects.get(&d.commander).map(|o| (o, d.damage)));
    if let Some((o, damage)) = commander {
        return Why::Commander { name: o.name.clone(), seat: o.owner.0, damage };
    }
    let Some(p) = state.players.iter().find(|p| p.id == player) else { return Why::Unknown };
    if p.poison_counters >= 10 {
        Why::Poison { count: p.poison_counters }
    } else if p.life <= 0 {
        Why::Life { life: p.life }
    } else if p.drew_from_empty_library {
        Why::Library
    } else {
        Why::Unknown
    }
}

/// Whether an event may give anyone a line (the rest is mana, priority and bookkeeping).
fn worth_telling(e: &GameEvent) -> bool {
    match e {
        GameEvent::AbilityActivated { kind, .. } => *kind != ActivatedAbilityKind::Mana,
        GameEvent::PlayerCounterChanged { counter_kind, .. } => *counter_kind == PlayerCounterKind::Poison,
        GameEvent::TurnStarted { .. }
        | GameEvent::SpellCast { .. }
        | GameEvent::LandPlayed { .. }
        | GameEvent::ZoneChanged { .. }
        | GameEvent::LifeChanged { .. }
        | GameEvent::DamageDealt { .. }
        | GameEvent::AttackersDeclared { .. }
        | GameEvent::BlockersDeclared { .. }
        | GameEvent::TokenCreated { .. }
        | GameEvent::CounterAdded { .. }
        | GameEvent::CounterRemoved { .. }
        | GameEvent::ControllerChanged { .. }
        | GameEvent::Transformed { .. }
        | GameEvent::CardsRevealed { .. }
        | GameEvent::CardDrawn { .. }
        | GameEvent::PlayerEliminated { .. }
        | GameEvent::GameOver { .. } => true,
        _ => false,
    }
}

/// One viewer's projection of the game, made only when a name is needed.
struct Lens<'a> {
    state: &'a GameState,
    viewer: Viewer,
    vs: Option<GameState>,
}

impl Lens<'_> {
    fn get(&mut self) -> &GameState {
        let (state, viewer) = (self.state, self.viewer);
        self.vs.get_or_insert_with(|| match viewer {
            Some(seat) => filter_state_for_viewer(state, PlayerId(seat)),
            None => filter_state_for_unseated_viewer(state),
        })
    }

    /// A card as this viewer knows it now. `known` holds names fixed earlier in the batch by a
    /// move seen face up (a card that has since left keeps the name it had).
    fn seen(&mut self, id: ObjectId, known: &HashMap<ObjectId, String>) -> Seen {
        let viewer = self.viewer;
        let vs = self.get();
        let o = vs.objects.get(&id);
        let visible = o.is_some_and(|o| !o.name.is_empty() && o.name != HIDDEN);
        let here = o.is_some_and(|o| visible && (o.zone.is_public() || (o.zone == Zone::Hand && viewer == Some(o.owner.0))));
        let face_down = o.is_some_and(|o| o.face_down && o.zone.is_public());
        let name = known.get(&id).cloned().or_else(|| o.filter(|_| visible).map(|o| o.name.clone()));
        Seen { id: here.then_some(id.0), name, face_down: face_down && !known.contains_key(&id) }
    }

    fn controller(&mut self, id: ObjectId) -> Option<u8> {
        self.get().objects.get(&id).map(|o| o.controller.0)
    }
}

/// CR 400.2 + CR 406.3 + CR 708.9: the card's face was public as it left `from` (the engine's
/// log narrates a move only when it was, on one side or the other: `game/log.rs`).
fn departed_face_up(from: Zone, record: &ZoneChangeRecord) -> bool {
    let left_face_down = record.trigger_source_context().is_some_and(|c| c.face_down);
    from.is_public() && (from == Zone::Battlefield || (from == Zone::Stack && record.to_zone != Zone::Battlefield) || !left_face_down)
}

/// Lower-case zone words for the board.
pub(crate) fn zone_word(z: Zone) -> &'static str {
    match z {
        Zone::Library => "library",
        Zone::Hand => "hand",
        Zone::Battlefield => "battlefield",
        Zone::Graveyard => "graveyard",
        Zone::Stack => "stack",
        Zone::Exile => "exile",
        Zone::Command => "command",
    }
}

/// What a move this viewer saw means for a card's caption: how it got to a graveyard, exile or
/// the command zone, or `None` when it went anywhere else (its old caption no longer applies).
type Arrival = (u64, Option<Came>);

/// One viewer's events (`shown`, already filtered for them) as happenings, each with the turn and
/// active seat it happened in, and the captions the moves they saw give cards. `all` is the
/// action's full event list, used only for counts and for which players left the game in it.
fn convert(shown: &[GameEvent], all: &[GameEvent], state: &GameState, lens: &mut Lens, start: (u32, u8)) -> (Vec<(u32, u8, What)>, Vec<Arrival>) {
    let viewer = lens.viewer;
    // Names fixed by moves seen face up, and tokens' names (a token that died is gone after).
    let mut known: HashMap<ObjectId, String> = HashMap::new();
    // The engine's reason for each card's move, from the events beside it.
    let mut how: HashMap<ObjectId, (How, Option<ObjectId>)> = HashMap::new();
    let mut drawn: HashSet<ObjectId> = HashSet::new();
    let mut lands: HashSet<ObjectId> = HashSet::new();
    let leaving: HashSet<PlayerId> = all
        .iter()
        .filter_map(|e| match e {
            GameEvent::PlayerEliminated { player_id } => Some(*player_id),
            _ => None,
        })
        .collect();
    for e in shown {
        match e {
            GameEvent::ZoneChanged { object_id, from: Some(from), to, record } => {
                let arrived_up = to.is_public() && !state.objects.get(object_id).is_some_and(|o| o.face_down);
                if departed_face_up(*from, record) || arrived_up {
                    known.entry(*object_id).or_insert_with(|| record.name.clone());
                }
            }
            GameEvent::TokenCreated { object_id, name, .. } => {
                known.insert(*object_id, name.clone());
            }
            GameEvent::CreatureDestroyed { object_id, source_id } => {
                how.insert(*object_id, (How::Destroyed, *source_id));
            }
            GameEvent::PermanentSacrificed { object_id, .. } => {
                how.insert(*object_id, (How::Sacrificed, None));
            }
            GameEvent::Discarded { object_id, .. } => {
                how.insert(*object_id, (How::Discarded, None));
            }
            GameEvent::Milled { object_id, .. } => {
                how.insert(*object_id, (How::Milled, None));
            }
            GameEvent::SpellCountered { object_id, countered_by, .. } => {
                how.insert(*object_id, (How::Countered, Some(*countered_by)));
            }
            GameEvent::CardDrawn { object_id, .. } => {
                drawn.insert(*object_id);
            }
            GameEvent::LandPlayed { object_id, .. } => {
                lands.insert(*object_id);
            }
            _ => {}
        }
    }
    // Life lost to damage reads as one line with the damage ("Terra dealt 3 damage to you, 41 → 38"):
    // the engine reports the life change just before the damage event that caused it.
    let mut folded: HashSet<usize> = HashSet::new();
    let mut totals: HashMap<usize, [i32; 2]> = HashMap::new();
    for (i, e) in shown.iter().enumerate() {
        let GameEvent::LifeChanged { player_id, amount, new_total } = e else { continue };
        if *amount >= 0 {
            continue;
        }
        let next = shown[i + 1..].iter().enumerate().find_map(|(k, x)| match x {
            GameEvent::ReplacementApplied { .. } | GameEvent::PlayerCounterChanged { .. } => None,
            GameEvent::DamageDealt { target: TargetRef::Player(p), amount: d, .. } if p == player_id && i64::from(*d) == -i64::from(*amount) => Some(Some(i + 1 + k)),
            _ => Some(None),
        });
        if let Some(Some(j)) = next {
            folded.insert(i);
            if let Some(after) = new_total.0 {
                totals.insert(j, [after - amount, after]);
            }
        }
    }

    let (mut turn, mut active) = start;
    let mut out: Vec<(u32, u8, What)> = Vec::new();
    let mut arrivals: Vec<Arrival> = Vec::new();
    let mut drew: BTreeMap<u8, Vec<Seen>> = BTreeMap::new();
    for (i, e) in shown.iter().enumerate() {
        let what = match e {
            GameEvent::TurnStarted { player_id, turn_number } => {
                (turn, active) = (*turn_number, player_id.0);
                Some(What::Turn { seat: player_id.0 })
            }
            GameEvent::SpellCast { controller, object_id, .. } => Some(What::Cast { seat: controller.0, card: lens.seen(*object_id, &known) }),
            GameEvent::LandPlayed { object_id, player_id, .. } => Some(What::Land { seat: player_id.0, card: lens.seen(*object_id, &known) }),
            GameEvent::AbilityActivated { player_id, source_id, kind, .. } if *kind != ActivatedAbilityKind::Mana => {
                Some(What::Activated { seat: player_id.0, card: lens.seen(*source_id, &known) })
            }
            GameEvent::ZoneChanged { object_id, from: Some(from), to, record } => {
                let arrived_down = state.objects.get(object_id).is_some_and(|o| o.face_down);
                let face_up = departed_face_up(*from, record) || (to.is_public() && !arrived_down);
                let left = leaving.contains(&record.owner) && *to == Zone::Exile;
                // Its caption in the zone it reached, as far as this viewer saw (GZones).
                if from != to {
                    let caption = matches!(to, Zone::Graveyard | Zone::Exile | Zone::Command) && !arrived_down && face_up;
                    let how = if left { How::Left } else { how.get(object_id).map(|h| h.0).unwrap_or(How::Moved) };
                    arrivals.push((object_id.0, caption.then_some(Came { turn, how, from: Some(zone_word(*from)) })));
                }
                let skip = from == to
                    // Casting (the cast line covers it) and a permanent spell resolving.
                    || *to == Zone::Stack
                    || (*from == Zone::Stack && *to == Zone::Battlefield)
                    || (lands.contains(object_id) && *to == Zone::Battlefield)
                    || drawn.contains(object_id)
                    // A player leaving the game takes everything they own with them (CR 800.4a);
                    // their knockout says so.
                    || left
                    // Neither side was face up: nothing anyone could name (game/log.rs does the same).
                    || !face_up;
                (!skip).then(|| {
                    let (h, by) = how.get(object_id).copied().unwrap_or((How::Moved, None));
                    let here = (to.is_public() && !arrived_down) || (*to == Zone::Hand && viewer == Some(record.owner.0));
                    What::Moved {
                        card: Seen { id: here.then_some(object_id.0), name: Some(record.name.clone()), face_down: false },
                        owner: record.owner.0,
                        from: Some(zone_word(*from)),
                        to: zone_word(*to),
                        how: h,
                        by: by.map(|b| lens.seen(b, &known)).filter(|s| s.name.is_some()),
                        creature: record.core_types.contains(&CoreType::Creature),
                    }
                })
            }
            GameEvent::LifeChanged { .. } if folded.contains(&i) => None,
            GameEvent::LifeChanged { player_id, amount, new_total } if *amount != 0 => Some(What::Life { seat: player_id.0, delta: *amount, total: new_total.0 }),
            GameEvent::DamageDealt { source_id, target, amount, is_combat, .. } if *amount > 0 => {
                let to = match target {
                    TargetRef::Player(p) => Hit::Player { seat: p.0 },
                    TargetRef::Object(o) => Hit::Card { card: lens.seen(*o, &known) },
                };
                Some(What::Damage {
                    source: lens.seen(*source_id, &known),
                    by: lens.controller(*source_id),
                    to,
                    amount: *amount,
                    combat: *is_combat,
                    life: totals.get(&i).copied(),
                })
            }
            GameEvent::PlayerCounterChanged { player, counter_kind: PlayerCounterKind::Poison, delta } if *delta != 0 => {
                Some(What::Poison { seat: player.0, delta: *delta })
            }
            GameEvent::AttackersDeclared { attacker_ids, defending_player, attacks, .. } => {
                let list: Vec<(ObjectId, AttackTarget)> = if attacks.is_empty() {
                    attacker_ids.iter().map(|a| (*a, AttackTarget::Player(*defending_player))).collect()
                } else {
                    attacks.clone()
                };
                let attacks: Vec<Attacked> = list
                    .iter()
                    .map(|(a, t)| Attacked {
                        card: lens.seen(*a, &known),
                        at: match t {
                            AttackTarget::Player(p) => Hit::Player { seat: p.0 },
                            AttackTarget::Planeswalker(o) | AttackTarget::Battle(o) => Hit::Card { card: lens.seen(*o, &known) },
                        },
                    })
                    .collect();
                (!attacks.is_empty()).then(|| What::Attack { seat: active, attacks })
            }
            GameEvent::BlockersDeclared { assignments } => {
                // One line per player blocking.
                let mut by_seat: BTreeMap<u8, Vec<[Seen; 2]>> = BTreeMap::new();
                for (blocker, attacker) in assignments {
                    let seat = lens.controller(*blocker).unwrap_or(active);
                    let pair = [lens.seen(*blocker, &known), lens.seen(*attacker, &known)];
                    by_seat.entry(seat).or_default().push(pair);
                }
                for (seat, blocks) in by_seat {
                    out.push((turn, active, What::Block { seat, blocks }));
                }
                None
            }
            GameEvent::TokenCreated { object_id, source_id, .. } => {
                let card = lens.seen(*object_id, &known);
                let seat = lens.controller(*object_id).or_else(|| lens.controller(*source_id)).unwrap_or(active);
                // A run of the same token reads as one line ("2 Zombie tokens").
                if let Some((_, _, What::Token { seat: s, card: c, count })) = out.last_mut()
                    && *s == seat
                    && c.name == card.name
                {
                    *count += 1;
                    None
                } else {
                    Some(What::Token { seat, card, count: 1 })
                }
            }
            GameEvent::CounterAdded { object_id, counter_type, count, .. } if *count > 0 => {
                counters(&mut out, lens.seen(*object_id, &known), counter_type, i64::from(*count))
            }
            GameEvent::CounterRemoved { object_id, counter_type, count } if *count > 0 => {
                counters(&mut out, lens.seen(*object_id, &known), counter_type, -i64::from(*count))
            }
            GameEvent::ControllerChanged { object_id, old_controller, new_controller } if old_controller != new_controller => {
                Some(What::Control { card: lens.seen(*object_id, &known), from: old_controller.0, to: new_controller.0 })
            }
            GameEvent::Transformed { object_id } => Some(What::Transformed { card: lens.seen(*object_id, &known) }),
            // Names in the order revealed. The ids are left out: a revealed card usually goes back
            // to a hand or a library, and the reveal mustn't let anyone follow it there.
            GameEvent::CardsRevealed { player, card_names, .. } => Some(What::Revealed {
                seat: player.0,
                cards: card_names.iter().map(|n| Seen { id: None, name: Some(n.clone()), face_down: false }).collect(),
            }),
            GameEvent::CardDrawn { player_id, object_id, .. } => {
                let card = lens.seen(*object_id, &known);
                drew.entry(player_id.0).or_default().push(card);
                None
            }
            GameEvent::PlayerEliminated { player_id } => Some(What::Out { seat: player_id.0 }),
            GameEvent::GameOver { winner } => Some(What::Over { winner: winner.map(|w| w.0) }),
            _ => None,
        };
        if let Some(w) = what {
            out.push((turn, active, w));
        }
    }
    // Draws: the cards for whoever saw them drawn, a count for everyone else (hand sizes are public).
    let mut counts: BTreeMap<u8, u32> = BTreeMap::new();
    for e in all {
        if let GameEvent::CardDrawn { player_id, .. } = e {
            *counts.entry(player_id.0).or_default() += 1;
        }
    }
    for (seat, count) in counts {
        let cards = drew.remove(&seat).unwrap_or_default();
        out.push((turn, active, What::Drew { seat, count, cards }));
    }
    (out, arrivals)
}

/// Counters on a card, folded into the line before when it's the same card and kind.
fn counters(out: &mut [(u32, u8, What)], card: Seen, kind: &engine::types::counter::CounterType, delta: i64) -> Option<What> {
    let counter = format!("{kind:?}").to_lowercase();
    let delta = i32::try_from(delta).unwrap_or(i32::MAX);
    if let Some((_, _, What::Counters { card: c, counter: k, delta: d })) = out.last_mut()
        && *c == card
        && *k == counter
        && (*d > 0) == (delta > 0)
    {
        *d += delta;
        return None;
    }
    Some(What::Counters { card, counter, delta })
}

impl Happening {
    /// Every card name this happening shows, for the board's card details (art in the log, images
    /// in the reveal panel).
    pub fn card_names(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut add = |s: &Seen| {
            if let Some(n) = &s.name {
                out.push(n.clone());
            }
        };
        match &self.what {
            What::Cast { card, .. }
            | What::Land { card, .. }
            | What::Activated { card, .. }
            | What::Token { card, .. }
            | What::Counters { card, .. }
            | What::Control { card, .. }
            | What::Transformed { card } => add(card),
            What::Moved { card, by, .. } => {
                add(card);
                if let Some(b) = by {
                    add(b);
                }
            }
            What::Damage { source, to, .. } => {
                add(source);
                if let Hit::Card { card } = to {
                    add(card);
                }
            }
            What::Attack { attacks, .. } => {
                for a in attacks {
                    add(&a.card);
                    if let Hit::Card { card } = &a.at {
                        add(card);
                    }
                }
            }
            What::Block { blocks, .. } => {
                for [b, a] in blocks {
                    add(b);
                    add(a);
                }
            }
            What::Revealed { cards, .. } | What::Looked { cards, .. } | What::Drew { cards, .. } => cards.iter().for_each(&mut add),
            What::Turn { .. } | What::Life { .. } | What::Poison { .. } | What::Automatic { .. } | What::Out { .. } | What::Over { .. } => {}
        }
        out
    }
}
