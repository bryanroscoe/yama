//! Decisions everyone takes part in, and choosing a player (docs/game-interactions-review-2026-10-23.md,
//! "Engine decisions with no design"; the boards GTogether and GRareRules' "Choosing a player"):
//! the `Pending` shapes for them, read from the deciding seat's filtered view like every other
//! (act.rs), and [`TogetherView`], the public part of a table-wide decision that every seat's
//! board shows while it runs.
//!
//! - **Votes** (Council's Judgment, Coercive Portal): each voter in turn, for a permanent or a
//!   word. Everyone sees the votes cast so far and who votes next, unless the vote is secret
//!   (the engine scrubs the ballots from each seat's view then).
//! - **Piles** (Fact or Fiction): the opponent who separates the cards, the split, then the
//!   chooser's pile. The cards are public (revealed, on the battlefield or exiled face up), and
//!   each seat's view names them only as that seat sees them.
//! - **Villainous choice** (Ensnared by the Mara) and any other "choose A or B" as an effect
//!   resolves, in the engine's own words for each branch; everyone sees who has chosen, not what.
//! - **Coins and dice** kept or ignored (Krark's Thumb, Krark's Other Thumb), an opponent's
//!   guess, a clash's top or bottom, and redistributing life totals.
//! - **Choosing a player**: a gift's recipient, who a permanent enters under, which opponent
//!   chooses or separates or clashes, and who announces a target of an opponent's choice. One
//!   answer, `Act::ChoosePlayer`, stands for each engine action ([`player_action`]).
//!
//! A real-time contest (`PhysicalContest`) has no engine answer to send and keeps the buttons.

use std::collections::HashSet;

use engine::types::actions::GameAction;
use engine::types::game_state::{GameState, PileResult, PileSide, WaitingFor, ZoneOpponentChooserPurpose};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;
use phase_llm::render::text::one_line;
use serde::Serialize;
use serde_json::json;

use crate::Match;
use crate::act::{Answer, Choice, Kind, Pending, card, player_choice, word};
use crate::feed::Seen;

/// The card whose spell or ability is resolving now, when the decision itself names none (a
/// coin flip, a die roll, a clash's top or bottom). The engine keeps it while it resolves.
pub(crate) fn resolving_source(vs: &GameState) -> Option<ObjectId> {
    vs.resolving_stack_entry.as_ref().map(|e| e.source_id)
}

/// A seat's name in a prompt: "you" is never used here, since the board says it itself.
fn seat_name(p: PlayerId, names: &[String]) -> String {
    names.get(usize::from(p.0)).cloned().unwrap_or_else(|| format!("Player {}", p.0 + 1))
}

/// Players to choose from, as options ("p2"), each with its seat.
fn players(candidates: &[PlayerId], names: &[String]) -> Vec<Choice> {
    candidates.iter().map(|p| player_choice(*p, names)).collect()
}

/// A seat picker: one of `candidates`, answered with `Act::ChoosePlayer`.
fn seat_pick(vs: &GameState, purpose: &'static str, prompt: impl Into<String>, candidates: &[PlayerId], names: &[String], source: Option<ObjectId>) -> Pending {
    Pending::new(Kind::Pick, Answer::ChoosePlayer, purpose, prompt, players(candidates, names)).range(1, 1, false).from(vs, source)
}

/// The engine action a chosen player stands for, by the decision's purpose.
pub(crate) fn player_action(purpose: &str, seat: u8) -> Option<GameAction> {
    let opponent = PlayerId(seat);
    Some(match purpose {
        "gift" => GameAction::ChooseGiftRecipient { opponent },
        "entry_controller" => GameAction::ChooseEntryController { opponent },
        "zone_chooser" => GameAction::ChooseZoneOpponentChooser { opponent },
        "clash_opponent" => GameAction::ChooseClashOpponent { opponent },
        "announcer" => GameAction::ChooseAnnouncingOpponent { opponent },
        "pile_opponent" => GameAction::ChoosePileOpponent { opponent },
        _ => return None,
    })
}

/// The seat an engine action chooses, for the actions [`player_action`] makes.
pub(crate) fn chosen_player(action: &GameAction) -> Option<u8> {
    match action {
        GameAction::ChooseGiftRecipient { opponent }
        | GameAction::ChooseEntryController { opponent }
        | GameAction::ChooseZoneOpponentChooser { opponent }
        | GameAction::ChooseClashOpponent { opponent }
        | GameAction::ChooseAnnouncingOpponent { opponent }
        | GameAction::ChoosePileOpponent { opponent } => Some(opponent.0),
        _ => None,
    }
}

/// "Pile A" or "Pile B", as the answer names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pile {
    A,
    B,
}

impl Pile {
    pub(crate) fn side(self) -> PileSide {
        match self {
            Pile::A => PileSide::A,
            Pile::B => PileSide::B,
        }
    }
    pub(crate) fn of(side: PileSide) -> Self {
        match side {
            PileSide::A => Pile::A,
            PileSide::B => Pile::B,
        }
    }
}

/// The cards of a split's two piles, to show: pile A's with group "a", pile B's with "b".
fn pile_cards(vs: &GameState, r: &PileResult) -> Vec<Choice> {
    let side = |ids: &engine::im::Vector<ObjectId>, g: &str| {
        ids.iter()
            .map(|id| {
                let mut c = card(vs, id, false);
                c.group = Some(g.to_string());
                c
            })
            .collect::<Vec<_>>()
    };
    let mut out = side(&r.pile_a, "a");
    out.extend(side(&r.pile_b, "b"));
    out
}

/// "Vote for carnage or homage", "Vote for one of 3 permanents".
fn vote_prompt(labels: &[String], objects: usize, all_permanents: bool) -> String {
    if objects > 0 {
        return if all_permanents { "Vote for a permanent".into() } else { "Vote for a card".into() };
    }
    match labels {
        [a, b] => format!("Vote for {a} or {b}"),
        _ => "Vote for one".into(),
    }
}

/// The decisions this module describes, or `None` for any other (act.rs asks first).
pub(crate) fn of(vs: &GameState, me: PlayerId, candidates: &[GameAction], names: &[String]) -> Option<Pending> {
    let first = |pick: fn(&GameAction) -> bool| candidates.iter().find(|a| pick(a));
    let p = match &vs.waiting_for {
        // ── votes (CR 701.38) ──────────────────────────────────────────────
        WaitingFor::VoteChoice { player, remaining_votes, options, option_labels, candidate_objects, actor, source_id, .. } if actor.resolve(*player) == me => {
            let label = |i: usize, fallback: &str| option_labels.get(i).cloned().unwrap_or_else(|| fallback.to_string());
            let (choices, answer) = if candidate_objects.is_empty() {
                // A named vote: each word is answered as itself (ChooseOption).
                let words = options.iter().enumerate().map(|(i, o)| word(o.clone(), label(i, o))).collect();
                (words, Answer::ChooseOption)
            } else {
                // A vote for objects, by their place in the engine's list (two with one name stay apart).
                let cards = candidate_objects
                    .iter()
                    .enumerate()
                    .map(|(i, id)| {
                        let mut c = card(vs, id, true);
                        c.id = i.to_string();
                        c
                    })
                    .collect();
                (cards, Answer::SubmitVoteCandidate)
            };
            let all_permanents = candidate_objects.iter().all(|id| vs.battlefield.contains(id));
            let labels: Vec<String> = (0..options.len()).map(|i| label(i, &options[i])).collect();
            let mut prompt = vote_prompt(&labels, candidate_objects.len(), all_permanents);
            // Friend or foe: someone else votes on another player's behalf.
            if *player != me {
                prompt = format!("{prompt}, for {}", seat_name(*player, names));
            }
            let mut p = Pending::new(Kind::Pick, answer, "vote", prompt, choices).range(1, 1, false).from(vs, Some(*source_id));
            p.total = Some(*remaining_votes);
            p
        }
        // ── piles (CR 700.3) ───────────────────────────────────────────────
        WaitingFor::SeparatePilesChooseOpponent { player, candidates: who, source_id, .. } if *player == me => {
            seat_pick(vs, "pile_opponent", "Choose the opponent who separates the piles", who, names, Some(*source_id))
        }
        WaitingFor::SeparatePilesPartition { player, eligible, source_id, .. } if *player == me => {
            // The picked cards are pile A; the rest are pile B (CR 700.3a). A pile may be empty.
            let ids: Vec<ObjectId> = eligible.iter().copied().collect();
            let n = ids.len();
            let options = ids.iter().map(|id| card(vs, id, true)).collect();
            let mut p = Pending::new(Kind::Pick, Answer::SubmitPilePartition, "piles_split", "Separate these cards into two piles", options).range(0, n, true).from(vs, Some(*source_id));
            p.default_answer = first(|a| matches!(a, GameAction::SubmitPilePartition { .. })).map(|a| match a {
                GameAction::SubmitPilePartition { pile_a } => json!(pile_a.iter().map(|c| c.0.to_string()).collect::<Vec<_>>()),
                _ => serde_json::Value::Null,
            });
            p
        }
        WaitingFor::SeparatePilesChoice { player, current, pending, source_id, .. } if *player == me => {
            let count = |n: usize| if n == 1 { "1 card".to_string() } else { format!("{n} cards") };
            let mut a = word("a", "Pile A");
            a.text = Some(count(current.pile_a.len()));
            let mut b = word("b", "Pile B");
            b.text = Some(count(current.pile_b.len()));
            // Several players' piles (Make an Example): say whose these are.
            let prompt = if pending.is_empty() { "Choose a pile".to_string() } else { format!("Choose one of {}'s piles", seat_name(current.subject, names)) };
            let mut p = Pending::new(Kind::Pick, Answer::ChoosePile, "piles_choose", prompt, vec![a, b]).range(1, 1, false).from(vs, Some(*source_id));
            p.shown = pile_cards(vs, current);
            p
        }
        // ── a villainous choice, or any "choose A or B" as it resolves (CR 701.55a) ──
        WaitingFor::ChooseOneOfBranch { player, source_id, branches, branch_descriptions, .. } if *player == me => {
            let name = Match::name_in(vs, source_id);
            let options = (0..branches.len())
                .map(|i| {
                    let text = branch_descriptions
                        .get(i)
                        .or(branches[i].description.as_ref())
                        .map(|d| crate::act::capitalised(&one_line(&d.replace('~', &name))))
                        .unwrap_or_else(|| format!("{}", i + 1));
                    word(i.to_string(), text)
                })
                .collect();
            Pending::new(Kind::Pick, Answer::ChooseBranch, "branch", "Choose one", options).range(1, 1, false).from(vs, Some(*source_id))
        }
        // ── coins and dice (CR 705.1, 706.6) ──────────────────────────────
        WaitingFor::CoinFlipKeepChoice { player, results, keep_count } if *player == me => {
            // The engine counts heads as a win (CR 705.2).
            let options = results.iter().enumerate().map(|(i, heads)| word(i.to_string(), if *heads { "Heads" } else { "Tails" })).collect();
            let prompt = if *keep_count == 1 { "Keep one coin".to_string() } else { format!("Keep {keep_count} coins") };
            Pending::new(Kind::Pick, Answer::SelectCoinFlips, "coin", prompt, options).range(*keep_count, *keep_count, false).from(vs, resolving_source(vs))
        }
        WaitingFor::DieKeepChoice { player, results, ignorable_indices, ignore_count } if *player == me => {
            // Only the rolls the engine allows may be ignored (tied for the lowest, CR 706.6).
            let options = results
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let mut c = word(i.to_string(), r.to_string());
                    c.eligible = ignorable_indices.contains(&i);
                    c
                })
                .collect();
            let prompt = if *ignore_count == 1 { "Ignore one roll".to_string() } else { format!("Ignore {ignore_count} rolls") };
            Pending::new(Kind::Pick, Answer::SelectDieRolls, "die", prompt, options).range(*ignore_count, *ignore_count, false).from(vs, resolving_source(vs))
        }
        // ── an opponent's guess (CR 608.2d) ───────────────────────────────
        WaitingFor::OpponentGuess { player, options, source, .. } if *player == me => {
            let prompt = match options.as_slice() {
                [a, b] => format!("Guess {a} or {b}"),
                _ => "Make a guess".to_string(),
            };
            let mut p = Pending::new(Kind::Pick, Answer::ChooseOption, "guess", prompt, options.iter().map(|o| word(o.clone(), o.clone())).collect()).range(1, 1, false);
            // The card asking, as the engine names it (it may have left the battlefield).
            p.source = Some(crate::act::Source {
                id: source.prompt.identity.reference.object_id.0,
                name: source.prompt.display_name.clone(),
                controller: source.prompt.controller.0,
                art: None,
                image: None,
                artist: None,
            });
            p
        }
        // ── clash (CR 701.30) ────────────────────────────────────────────
        WaitingFor::ClashChooseOpponent { player, candidates: who, ability } if *player == me => {
            seat_pick(vs, "clash_opponent", "Choose an opponent to clash with", who, names, Some(ability.source_id))
        }
        WaitingFor::ClashCardPlacement { player, card: revealed, remaining, .. } if *player == me => {
            // Each clashing player's revealed card is public; this one is yours to place.
            let name = Match::name_in(vs, revealed);
            let options = vec![word("top", "Top"), word("bottom", "Bottom")];
            let mut p = Pending::new(Kind::Pick, Answer::ChooseTopOrBottom, "clash", format!("Put {name} on the top or bottom of your library?"), options).range(1, 1, false).from(vs, resolving_source(vs));
            p.shown = std::iter::once(revealed).chain(remaining.iter().map(|(_, c)| c)).map(|id| card(vs, id, false)).collect();
            p
        }
        // ── life totals (CR 119.7) ───────────────────────────────────────
        WaitingFor::RedistributeLifeTotals { player, options } if *player == me => {
            let choices = options
                .iter()
                .enumerate()
                .map(|(i, o)| word(i.to_string(), o.assignment.iter().map(|(p, life)| format!("{} {life}", seat_name(*p, names))).collect::<Vec<_>>().join(", ")))
                .collect();
            Pending::new(Kind::Pick, Answer::RedistributeLife, "life", "Choose how the life totals are shared out", choices).range(1, 1, false).from(vs, resolving_source(vs))
        }
        // ── choosing a player ────────────────────────────────────────────
        WaitingFor::ChooseGiftRecipient { player, candidates: who, pending_cast, .. } if *player == me => {
            seat_pick(vs, "gift", "Choose who gets the gift", who, names, Some(pending_cast.object_id))
        }
        WaitingFor::EntryControllerChoice { player, candidates: who } if *player == me => {
            // CR 614.12a: the permanent isn't on the battlefield yet, and the engine names no card.
            seat_pick(vs, "entry_controller", "Choose the opponent it enters under", who, names, None)
        }
        WaitingFor::ChooseFromZoneOpponentChooser { player, candidates: who, ability, purpose } if *player == me => {
            let prompt = match purpose {
                ZoneOpponentChooserPurpose::PerPlayerChoiceOrder => "Choose whose choice is made next",
                ZoneOpponentChooserPurpose::SubstituteChooser => "Choose the player who makes this choice",
                _ => "Choose the opponent who chooses",
            };
            seat_pick(vs, "zone_chooser", prompt, who, names, Some(ability.source_id))
        }
        WaitingFor::ChooseAnnouncingOpponent { player, candidates: who, choice_index, choice_count, pending_cast, .. } if *player == me => {
            let mut prompt = "Choose the opponent who chooses its target".to_string();
            if *choice_count > 1 {
                prompt.push_str(&format!(" ({} of {choice_count})", choice_index + 1));
            }
            seat_pick(vs, "announcer", prompt, who, names, Some(pending_cast.object_id))
        }
        _ => return None,
    };
    Some(p)
}

/// A clash's revealed cards are public (CR 701.30a), but the engine's filtered views don't name
/// them, so they're named from the game itself: only the clash's own cards, and only while its
/// players place them.
pub(crate) fn with_clash_cards(mut p: Pending, full: &GameState) -> Pending {
    let WaitingFor::ClashCardPlacement { card: mine, remaining, .. } = &full.waiting_for else { return p };
    if p.purpose != "clash" {
        return p;
    }
    let clash: Vec<u64> = std::iter::once(mine).chain(remaining.iter().map(|(_, c)| c)).map(|c| c.0).collect();
    for c in p.shown.iter_mut() {
        if let Ok(id) = c.id.parse::<u64>()
            && clash.contains(&id)
        {
            c.name = Match::name_in(full, &ObjectId(id));
        }
    }
    p.prompt = format!("Put {} on the top or bottom of your library?", Match::name_in(full, mine));
    p
}

/// The public part of a decision everyone takes part in, as one seat sees it (`View::together`):
/// the votes cast so far and who votes next, the piles and who splits and chooses, or who has
/// faced a villainous choice. Read from that seat's own filtered view, so a hidden card or a
/// secret vote stays hidden.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TogetherView {
    Vote {
        source: Seen,
        controller: u8,
        /// What is voted for, in the engine's order: a permanent (its id while it's on the
        /// battlefield) or a word.
        options: Vec<Seen>,
        /// Each vote cast so far, in order: who cast it and the option's place in `options`.
        ballots: Vec<(u8, usize)>,
        /// Everyone who votes, in the order they vote.
        voters: Vec<Voter>,
        /// The votes are secret until everyone has voted: none are shown (the engine's own rule).
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        secret: bool,
    },
    Piles {
        source: Seen,
        /// The player who chooses a pile.
        chooser: u8,
        /// The player who separates the cards, once the engine knows.
        #[serde(skip_serializing_if = "Option::is_none")]
        splitter: Option<u8>,
        /// "opponent" (the caster chooses who splits), "split" or "choose".
        step: &'static str,
        /// The cards being split, before the split.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        cards: Vec<Seen>,
        /// The two piles, once split.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pile_a: Vec<Seen>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pile_b: Vec<Seen>,
        /// The split is done but empty piles are still piles.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        split: bool,
    },
    Branch {
        source: Seen,
        controller: u8,
        /// Everyone who faces the choice, in order: "chose", "choosing" or "waiting".
        facing: Vec<(u8, &'static str)>,
    },
    /// A clash: each player's revealed card, and who is placing theirs now.
    Clash {
        source: Seen,
        cards: Vec<(u8, Seen)>,
        placing: u8,
    },
    /// A proposed shortcut (rare.rs, CR 732.2b): what repeats and how often, and who has answered.
    Shortcut {
        source: Seen,
        shortcut: crate::rare::ShortcutView,
    },
}

impl TogetherView {
    /// The card names it shows, for the viewer's card details (images and art).
    pub fn card_names(&self) -> Vec<String> {
        let all: Vec<&Seen> = match self {
            // A vote for a word names no card: only options that are cards (they have an id).
            TogetherView::Vote { source, options, .. } => std::iter::once(source).chain(options.iter().filter(|o| o.id.is_some())).collect(),
            TogetherView::Piles { source, cards, pile_a, pile_b, .. } => std::iter::once(source).chain(cards).chain(pile_a).chain(pile_b).collect(),
            TogetherView::Branch { source, .. } => vec![source],
            TogetherView::Clash { source, cards, .. } => std::iter::once(source).chain(cards.iter().map(|(_, c)| c)).collect(),
            TogetherView::Shortcut { source, .. } => vec![source],
        };
        all.into_iter().filter_map(|s| s.name.clone()).collect()
    }
}

/// One voter, and where they are in the voting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Voter {
    pub seat: u8,
    /// "voted", "voting" or "next".
    pub state: &'static str,
}

/// A card as `vs` names it, with its id while it's on the battlefield or face up in exile.
fn seen(vs: &GameState, id: &ObjectId) -> Seen {
    let o = vs.objects.get(id);
    let known = o.is_some_and(|o| !o.name.is_empty() && o.name != "Hidden Card" && !o.face_down);
    let public = o.is_some_and(|o| known && o.zone.is_public());
    Seen { id: public.then_some(id.0), name: known.then(|| Match::name_in(vs, id)), face_down: o.is_some_and(|o| o.face_down) }
}

/// The table-wide decision in progress, as `vs` (one seat's filtered view) shows it. `facing` is
/// who has faced the villainous choice now resolving, kept by `Match` (the engine keeps only who
/// is still to choose).
pub(crate) fn view(vs: &GameState, full: &GameState, facing: Option<&[PlayerId]>, names: &[String]) -> Option<TogetherView> {
    match &vs.waiting_for {
        // A shortcut being answered: everyone sees the proposal and who has answered (rare.rs).
        WaitingFor::RespondToShortcut { .. } | WaitingFor::RespondToPrecastCopyShortcut { .. } => {
            let shortcut = crate::rare::public_shortcut(vs, names)?;
            Some(TogetherView::Shortcut { source: vs.stack.last().map(|e| seen(vs, &e.source_id)).unwrap_or_default(), shortcut })
        }
        // The clash's cards were revealed to everyone (CR 701.30a); see `with_clash_cards`.
        WaitingFor::ClashCardPlacement { player, .. } => {
            let WaitingFor::ClashCardPlacement { card: c, remaining, .. } = &full.waiting_for else { return None };
            let named = |id: &ObjectId| Seen { id: None, name: Some(Match::name_in(full, id)), face_down: false };
            let cards = std::iter::once((player.0, named(c))).chain(remaining.iter().map(|(p, id)| (p.0, named(id)))).collect();
            Some(TogetherView::Clash { source: resolving_source(vs).map(|id| seen(vs, &id)).unwrap_or_default(), cards, placing: player.0 })
        }
        WaitingFor::VoteChoice { player, options, option_labels, candidate_objects, remaining_voters, ballots, controller, source_id, visibility, .. } => {
            let secret = *visibility == engine::types::ability::VoteVisibility::Secret;
            let opts = if candidate_objects.is_empty() {
                (0..options.len()).map(|i| Seen { id: None, name: Some(option_labels.get(i).cloned().unwrap_or_else(|| options[i].clone())), face_down: false }).collect()
            } else {
                candidate_objects.iter().map(|id| seen(vs, id)).collect()
            };
            let cast: Vec<(u8, usize)> = if secret { vec![] } else { ballots.iter().map(|(p, i)| (p.0, *i as usize)).collect() };
            // Who has voted (in the order they did), who votes now, and who votes later.
            let mut voters: Vec<Voter> = Vec::new();
            let mut seen_seats = HashSet::new();
            for (p, _) in ballots.iter() {
                if *p != *player && seen_seats.insert(p.0) {
                    voters.push(Voter { seat: p.0, state: "voted" });
                }
            }
            if seen_seats.insert(player.0) {
                voters.push(Voter { seat: player.0, state: "voting" });
            }
            for (p, _) in remaining_voters {
                if seen_seats.insert(p.0) {
                    voters.push(Voter { seat: p.0, state: "next" });
                }
            }
            Some(TogetherView::Vote { source: seen(vs, source_id), controller: controller.0, options: opts, ballots: cast, voters, secret })
        }
        WaitingFor::SeparatePilesChooseOpponent { chooser, eligible, source_id, .. } => Some(TogetherView::Piles {
            source: seen(vs, source_id),
            chooser: chooser.0,
            splitter: None,
            step: "opponent",
            cards: eligible.iter().map(|id| seen(vs, id)).collect(),
            pile_a: vec![],
            pile_b: vec![],
            split: false,
        }),
        WaitingFor::SeparatePilesPartition { player, eligible, chooser, source_id, .. } => Some(TogetherView::Piles {
            source: seen(vs, source_id),
            chooser: chooser.0,
            splitter: Some(player.0),
            step: "split",
            cards: eligible.iter().map(|id| seen(vs, id)).collect(),
            pile_a: vec![],
            pile_b: vec![],
            split: false,
        }),
        WaitingFor::SeparatePilesChoice { player, current, source_id, .. } => Some(TogetherView::Piles {
            source: seen(vs, source_id),
            chooser: player.0,
            splitter: None,
            step: "choose",
            cards: vec![],
            pile_a: current.pile_a.iter().map(|id| seen(vs, id)).collect(),
            pile_b: current.pile_b.iter().map(|id| seen(vs, id)).collect(),
            split: true,
        }),
        WaitingFor::ChooseOneOfBranch { player, controller, source_id, remaining_players, .. } => {
            let waiting: HashSet<PlayerId> = remaining_players.iter().copied().collect();
            let mut out: Vec<(u8, &'static str)> = facing
                .unwrap_or_default()
                .iter()
                .filter(|p| **p != *player && !waiting.contains(p))
                .map(|p| (p.0, "chose"))
                .collect();
            out.push((player.0, "choosing"));
            out.extend(remaining_players.iter().map(|p| (p.0, "waiting")));
            Some(TogetherView::Branch { source: seen(vs, source_id), controller: controller.0, facing: out })
        }
        _ => None,
    }
}

/// Who faces the villainous choice now resolving, kept from its first prompt: the engine's own
/// state names only the player choosing and those still to choose. `None` once it's over.
pub(crate) fn facing_after(state: &GameState, before: Option<(ObjectId, Vec<PlayerId>)>) -> Option<(ObjectId, Vec<PlayerId>)> {
    let WaitingFor::ChooseOneOfBranch { player, source_id, remaining_players, .. } = &state.waiting_for else { return None };
    match before {
        Some((src, list)) if src == *source_id => Some((src, list)),
        _ => Some((*source_id, std::iter::once(*player).chain(remaining_players.iter().copied()).collect())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn who_faced_a_villainous_choice_is_kept_from_its_first_prompt() {
        let mut state = GameState::new_two_player(7);
        let branch = |player: u8, remaining: Vec<PlayerId>| WaitingFor::ChooseOneOfBranch {
            player: PlayerId(player),
            controller: PlayerId(0),
            source_id: ObjectId(40),
            branches: vec![],
            branch_descriptions: vec![],
            parent_occurrences: Default::default(),
            context: Default::default(),
            continuation: None,
            replacement_applied: Default::default(),
            remaining_players: remaining,
            trigger_context: None,
        };
        state.waiting_for = branch(1, vec![PlayerId(2), PlayerId(3)]);
        let first = facing_after(&state, None);
        assert_eq!(first, Some((ObjectId(40), vec![PlayerId(1), PlayerId(2), PlayerId(3)])));
        // The next player's prompt keeps the list; another source's starts a new one.
        state.waiting_for = branch(2, vec![PlayerId(3)]);
        let kept = facing_after(&state, first);
        assert_eq!(kept.as_ref().map(|(_, who)| who.len()), Some(3));
        let Some(TogetherView::Branch { facing, .. }) = view(&state, &state, kept.as_ref().map(|(_, w)| w.as_slice()), &[]) else { panic!() };
        assert_eq!(facing, [(1, "chose"), (2, "choosing"), (3, "waiting")]);
        state.waiting_for = WaitingFor::Priority { player: PlayerId(0) };
        assert_eq!(facing_after(&state, kept), None);
    }
}
