//! A smoke test for every card in Bryan's decks and candidates (the list is smoke_cards.rs,
//! written by play/src/bin/coverage.rs). Each puts the card where it's used and plays it through
//! Yama's own answers ([`Table::drive`]):
//!
//! - a land is played from the hand, and each of its mana abilities is used;
//! - anything else is cast from the hand, paid automatically, and resolved (a spell that needs
//!   another spell to aim at is cast in answer to an opponent's Divination);
//! - every ability the engine offers for the card, in the hand or on the battlefield, is
//!   activated on a copy of the game, and every mana ability is used.
//!
//! Each step must finish with no panic, no engine refusal, no answer `act` refuses, no decision
//! nobody can answer and a game that settles. Then the card must have done what it most plainly
//! says, where plain.rs can tell: entered, has its printed power and toughness or loyalty,
//! resolved, drew, gained life, made tokens, added mana. The coverage report lists what was
//! checked for each card ("plays" where nothing more could be).
//!
//! The board: seat 0 (Ana) has the card's deck commander, four of each basic land and two
//! Wastes, Grizzly Bears, Isamaru (a legend) and Spellbook to pay costs with, Grizzly Bears and an
//! Island in hand, and Savannah Lions, Lightning Bolt and a Forest in the graveyard. Seat 1 (Ben) has two creatures (Savannah
//! Lions tapped), Spellbook, Ghostly Prison, Jace Beleren and three Islands, with cards in hand and
//! graveyard; seat 2 (Cy) has Grizzly Bears, Serra Angel (a permanent of mana value 5) and two
//! Forests. Everyone has 40 life.

use engine::types::game_state::GameState;
use engine::types::identifiers::ObjectId;
use engine::types::zones::Zone;

use super::plain::{Plain, expectations};
use super::{Board, DEFAULT_COMMANDER, Table, ability_options, big_stack, engine};
use crate::feed::What;
use crate::pay::PayMode;
use crate::{Act, OptionKind};

/// The smoke board with `card` first in seat 0's hand, so it is `ids[0]`. With `respond`, it's
/// seat 1's turn and seat 1 has Divination in hand to cast first.
fn board(card: &str, commander: &str, respond: bool) -> Table {
    let mut b = Board::new(3)
        .commander(0, commander)
        .hand(0, card)
        .hand(0, "Grizzly Bears")
        .hand(0, "Island")
        .basics(0, 4)
        .lands(0, "Wastes", 2)
        .field(0, "Grizzly Bears")
        .field(0, "Spellbook")
        .grave(0, "Savannah Lions")
        .grave(0, "Lightning Bolt")
        .grave(0, "Forest")
        .field(1, "Grizzly Bears")
        .field(1, "Savannah Lions")
        .field(1, "Spellbook")
        .field(1, "Ghostly Prison")
        .field(1, "Jace Beleren")
        .lands(1, "Island", 3)
        .hand(1, "Lightning Bolt")
        .grave(1, "Grizzly Bears")
        .grave(1, "Lightning Bolt")
        .field(2, "Grizzly Bears")
        .field(2, "Serra Angel")
        .lands(2, "Forest", 2);
    // A legend to sacrifice.
    b = b.field(0, "Isamaru, Hound of Konda");
    if respond {
        b = b.hand(1, "Divination").active(1);
    }
    let mut t = b.build();
    // A tapped creature to aim at.
    let lions = t.ids.iter().copied().find(|id| t.m.state.objects[id].name == "Savannah Lions" && t.m.state.objects[id].controller.0 == 1).unwrap();
    t.m.state.objects.get_mut(&lions).unwrap().tapped = true;
    t
}

/// Put the game back to `snap` (a copy taken earlier), for the next try from the same spot.
fn restore(t: &mut Table, snap: &GameState) {
    t.m.state = snap.clone();
    t.m.remark(None);
}

/// Seat 0's option to cast `id`, if the engine offers one.
fn can_cast(t: &Table, id: ObjectId) -> bool {
    t.m.decision(0).is_some_and(|d| d.options.iter().any(|o| o.kind == OptionKind::Spell && o.object == Some(id.0)))
}

/// What a smoke run found: what it checked, and what went wrong.
#[derive(Debug, Default)]
pub(crate) struct Smoke {
    pub checked: Vec<String>,
    pub problems: Vec<String>,
}

impl Smoke {
    fn check(&mut self, what: &Plain, ok: bool, detail: impl FnOnce() -> String) {
        self.checked.push(what.label());
        if !ok {
            self.problems.push(format!("didn't {}: {}", what.label(), detail()));
        }
    }

    /// Answer everything until the stack is empty, noting what went wrong as `step`.
    fn drive(&mut self, t: &mut Table, step: &str) -> bool {
        match t.drive() {
            Ok(d) => {
                for r in d.act_refused {
                    self.problems.push(format!("{step}: act refused the engine's own answer: {r}"));
                }
                true
            }
            Err(e) => {
                self.problems.push(format!("{step}: {e}"));
                false
            }
        }
    }

    /// Activate each ability the engine offers for `id` now, each on a copy of the game, and use
    /// each of its mana abilities.
    fn abilities(&mut self, t: &mut Table, id: ObjectId, plain: &[Plain], place: &str) {
        let snap = t.m.state.clone();
        let Some(d) = t.m.decision(0) else { return };
        let name = t.m.state.objects[&id].name.clone();
        for ability in ability_options(&d, id) {
            restore(t, &snap);
            let step = format!("activating {name}'s ability {ability} {place}");
            let d = t.decision(0);
            let Some(o) = d.options.iter().find(|o| o.kind == OptionKind::Ability && o.object == Some(id.0) && o.ability.unwrap_or(usize::MAX) == ability) else { continue };
            if let Err(e) = t.m.choose(0, d.revision, o.index) {
                self.problems.push(format!("{step}: refused: {e}"));
                continue;
            }
            self.drive(t, &step);
        }
        restore(t, &snap);
        let actions = t.mana_actions(id);
        let wants_mana = plain.iter().any(|p| matches!(p, Plain::AddsMana { .. }));
        if wants_mana && place == "on the battlefield" {
            if actions.is_empty() {
                self.problems.push(format!("{name} offers no mana ability on the battlefield"));
            }
        }
        for action in actions {
            restore(t, &snap);
            let added = t.tap_for_mana(action.clone());
            if wants_mana {
                let what = Plain::AddsMana { ability: 0 };
                match added {
                    Ok(n) => self.check(&what, n > 0, || format!("{action:?} added nothing")),
                    Err(e) => self.check(&what, false, || format!("{action:?} refused: {e}")),
                }
            } else if let Err(e) = added {
                self.problems.push(format!("tapping {name} for mana ({action:?}) refused: {e}"));
            }
        }
        restore(t, &snap);
        self.checked.dedup();
    }
}

/// Tokens made for seat 0 so far, as the feed tells it (a token that dies at once still counts).
fn tokens_made(t: &Table) -> u32 {
    t.happened().iter().map(|w| match w {
        What::Token { seat: 0, count, .. } => *count,
        _ => 0,
    }).sum()
}

/// The card as it first stood on the battlefield: its base power and toughness and its loyalty.
#[derive(Debug, Clone, Copy)]
struct Entered {
    base: (Option<i32>, Option<i32>),
    loyalty: Option<u32>,
}

/// Answer everything, noting when `id` is first on the battlefield (it may leave again on its own
/// trigger, as a Courtyard or Uro does).
fn drive_noting_entry(s: &mut Smoke, t: &mut Table, id: ObjectId, step: &str) -> (bool, Option<Entered>) {
    let mut entered: Option<Entered> = None;
    let mut note = |t: &Table| {
        if entered.is_none() && t.on_field(id) {
            let o = &t.state().objects[&id];
            entered = Some(Entered { base: (o.base_power, o.base_toughness), loyalty: o.loyalty });
        }
    };
    let ok = match t.drive_watching(&mut note) {
        Ok(d) => {
            for r in d.act_refused {
                s.problems.push(format!("{step}: no answer of the engine's that act takes: {r}"));
            }
            true
        }
        Err(e) => {
            s.problems.push(format!("{step}: {e}"));
            false
        }
    };
    (ok, entered)
}

/// Play `card` as smoke.rs's header says, with `commander` as seat 0's commander (a commander's
/// own test plays it from the hand, with Jedit Ojanen in the command zone).
pub(crate) fn run(card: &str, commander: &str) -> Smoke {
    let mut s = Smoke::default();
    let face = engine().database().get_face_by_name(card).unwrap_or_else(|| panic!("{card} isn't in the fixture"));
    let plain = expectations(face);
    let commander = if card == commander { DEFAULT_COMMANDER } else { commander };
    let mut t = board(card, commander, false);
    let id = t.ids[0];

    // Abilities it has in the hand (cycling, channel and the like).
    s.abilities(&mut t, id, &plain, "in the hand");

    let entered;
    if plain.contains(&Plain::PlaysAsLand) {
        if !t.decision(0).options.iter().any(|o| o.kind == OptionKind::Land && o.object == Some(id.0)) {
            s.check(&Plain::PlaysAsLand, false, || "no option to play it".into());
            return s;
        }
        t.play_land(id);
        let (_, e) = drive_noting_entry(&mut s, &mut t, id, "playing it");
        s.check(&Plain::PlaysAsLand, e.is_some(), || format!("it's in {:?}", t.zone(id)));
        entered = e;
    } else {
        if !can_cast(&t, id) {
            // Something to answer: an opponent's spell on the stack, on their turn.
            t = board(card, commander, true);
            let divination = t.id("Divination");
            t.cast(divination);
            // Ben and then Cy let it be; Ana gets priority with Divination on the stack.
            while t.m.waiting_on().first().is_some_and(|s| *s != 0) {
                let seat = t.m.waiting_on()[0];
                t.choose(seat, |o| o.kind == OptionKind::Pass);
            }
            if !can_cast(&t, id) {
                s.problems.push("the engine offers no way to cast it, on an empty stack in Ana's main phase or in answer to a spell".into());
                return s;
            }
        }
        let drawn = t.drawn(0);
        let gained = t.state().players[0].life_gained_this_turn;
        let tokens = tokens_made(&t);
        if let Err(e) = t.try_act(0, &Act::CastSpell { object: id.0, payment: PayMode::Auto }) {
            s.problems.push(format!("casting it was refused: {e}"));
            return s;
        }
        let (ok, e) = drive_noting_entry(&mut s, &mut t, id, "casting it");
        if !ok {
            return s;
        }
        entered = e;
        for p in &plain {
            match p {
                Plain::Enters => s.check(p, entered.is_some(), || format!("it's in {:?}", t.zone(id))),
                Plain::Resolves => {
                    let z = t.zone(id);
                    s.check(p, matches!(z, Zone::Graveyard | Zone::Exile | Zone::Library | Zone::Hand | Zone::Command), || format!("it's in {z:?}"));
                }
                Plain::Draws(n) => {
                    let now = t.drawn(0);
                    s.check(p, now >= drawn + n, || format!("{} drawn", now - drawn));
                }
                Plain::GainsLife(n) => {
                    let now = t.state().players[0].life_gained_this_turn;
                    s.check(p, now >= gained + n, || format!("{} gained", now - gained));
                }
                Plain::MakesTokens(n) => {
                    let now = tokens_made(&t);
                    s.check(p, now >= tokens + n, || format!("{} tokens made", now - tokens));
                }
                Plain::PrintedPt(..) | Plain::Loyalty(_) | Plain::PlaysAsLand | Plain::AddsMana { .. } => {}
            }
        }
    }
    // What it was as it entered (it may have become a copy of something since, or left).
    if let Some(e) = entered {
        for p in &plain {
            match p {
                Plain::PrintedPt(pw, tg) => s.check(p, e.base == (Some(*pw), Some(*tg)), || format!("its base power and toughness were {:?}", e.base)),
                Plain::Loyalty(n) => s.check(p, e.loyalty == Some(*n), || format!("its loyalty was {:?}", e.loyalty)),
                _ => {}
            }
        }
    }

    // Its abilities on the battlefield, with everything untapped and awake, while it's still the
    // card it was (not a copy of something else).
    if t.on_field(id) && t.settled() && t.state().active_player.0 == 0 && t.state().objects[&id].name == face.name {
        t.refresh(0);
        s.abilities(&mut t, id, &plain, "on the battlefield");
    }
    s
}

/// One card's smoke test: panics with every problem found.
pub(crate) fn smoke(card: &'static str, commander: &'static str) {
    let s = big_stack(move || run(card, commander));
    assert!(s.problems.is_empty(), "{card}:\n  {}", s.problems.join("\n  "));
}

macro_rules! smoke {
    ($($(#[$attr:meta])* $name:ident($card:literal, $commander:literal);)*) => {
        $(
            #[test]
            $(#[$attr])*
            fn $name() {
                smoke($card, $commander);
            }
        )*
    };
}

include!("smoke_cards.rs");
