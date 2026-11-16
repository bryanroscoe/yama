//! What the computer learned about a list's combos before playing it (`yama_play::ComboPlan`).
//!
//! A computer's seat is told the combos Commander Spellbook lists in its deck (`crate::combos`).
//! Rehearsing them (`yama_play::Engine::learn_combos`) shows which it can win with: those it then
//! looks for with its tutors, holding back the spell that finishes them; the rest it does not
//! chase. Rehearsing takes up to a few seconds a combo, so it is done once per list and engine,
//! in the background, one list at a time, and kept here. A game that starts before the answer is
//! in plays as before: its seat rehearses up to four of its combos itself, in its first turns.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use yama_play::{ComboPlan, Engine, SeatCombo, SeatDeck};

use crate::decks::DeckCard;

/// The combos kept for `list_hash` under the running engine, each with its plan (none for one the
/// rehearsal could not set out); `None` when the list hasn't been rehearsed under this engine.
pub async fn stored(pool: &SqlitePool, list_hash: &str) -> sqlx::Result<Option<Vec<SeatCombo>>> {
    let row: Option<String> = sqlx::query_scalar("SELECT combos FROM combo_plans WHERE list_hash = ? AND engine = ?")
        .bind(list_hash)
        .bind(yama_play::ENGINE_VERSION)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|json| serde_json::from_str(&json).ok()))
}

/// Give each of `found` the plan kept for it in `kept`. Whether every one of them was rehearsed
/// (a combo listed since the rehearsal was not).
pub fn attach(found: &mut [SeatCombo], kept: &[SeatCombo]) -> bool {
    let mut all = true;
    for combo in found.iter_mut() {
        match kept.iter().find(|k| k.id == combo.id) {
            Some(k) => combo.plan = k.plan.clone(),
            None => all = false,
        }
    }
    all
}

/// A seed for `list_hash`'s practice game: the same list rehearses the same way every time.
fn seed_of(list_hash: &str) -> u64 {
    u64::from_str_radix(list_hash.get(..16).unwrap_or("0"), 16).unwrap_or(0)
}

/// Rehearse `combos` in `deck` and keep the answer under `list_hash` for the running engine.
/// Runs the engine on its own thread, with its stack.
pub async fn learn(pool: &SqlitePool, engine: Arc<Engine>, list_hash: &str, deck: SeatDeck, combos: Vec<SeatCombo>) -> anyhow::Result<Vec<SeatCombo>> {
    let seed = seed_of(list_hash);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let to_learn = combos.clone();
    std::thread::Builder::new().name("combo-plans".into()).stack_size(crate::play::STACK).spawn(move || {
        let _ = tx.send(engine.learn_combos(&deck, &to_learn, seed));
    })?;
    let learned = rx.await.map_err(|_| anyhow::anyhow!("the rehearsal thread stopped"))??;
    let mut planned = combos;
    for combo in planned.iter_mut() {
        combo.plan = learned.iter().find(|(id, _)| *id == combo.id).map(|(_, plan)| plan.clone());
    }
    sqlx::query(
        "INSERT INTO combo_plans (list_hash, engine, combos, learned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (list_hash, engine) DO UPDATE SET combos = excluded.combos, learned_at = excluded.learned_at",
    )
    .bind(list_hash)
    .bind(yama_play::ENGINE_VERSION)
    .bind(serde_json::to_string(&planned)?)
    .bind(crate::util::now())
    .execute(pool)
    .await?;
    // A plan learned on an earlier engine is no use once this one runs.
    sqlx::query("DELETE FROM combo_plans WHERE list_hash = ? AND engine != ?").bind(list_hash).bind(yama_play::ENGINE_VERSION).execute(pool).await?;
    Ok(planned)
}

/// Lists waiting longest: a burst of new lists past this is left for later games to ask again.
const MAX_PENDING: usize = 16;

/// Lists waiting to be rehearsed, or being rehearsed: one at a time, so a burst of new games
/// can't take every core. A list whose rehearsal failed isn't tried again until the server
/// restarts.
pub struct Planner {
    pending: Mutex<HashSet<String>>,
    failed: Mutex<HashSet<String>>,
    gate: tokio::sync::Semaphore,
}

impl Default for Planner {
    fn default() -> Self {
        Self::new()
    }
}

impl Planner {
    pub fn new() -> Self {
        Self { pending: Mutex::new(HashSet::new()), failed: Mutex::new(HashSet::new()), gate: tokio::sync::Semaphore::new(1) }
    }

    /// Rehearse `combos` in `deck` in the background and keep the answer under `list_hash`,
    /// unless that list is already waiting, failed before, or too many are waiting.
    pub fn request(self: &Arc<Self>, pool: SqlitePool, engine: Arc<Engine>, list_hash: String, deck: SeatDeck, combos: Vec<SeatCombo>) {
        if combos.is_empty() || self.failed.lock().unwrap().contains(&list_hash) {
            return;
        }
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING || !pending.insert(list_hash.clone()) {
                return;
            }
        }
        let me = self.clone();
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let count = combos.len();
            if let Ok(_permit) = me.gate.acquire().await {
                match learn(&pool, engine, &list_hash, deck, combos).await {
                    Ok(planned) => {
                        let wins = planned.iter().filter(|c| matches!(c.plan, Some(ComboPlan::Wins { .. }))).count();
                        tracing::info!(list = %list_hash, combos = count, wins, secs = started.elapsed().as_secs_f32(), "rehearsed a list's combos");
                    }
                    Err(error) => {
                        tracing::warn!(list = %list_hash, error = %format!("{error:#}"), "couldn't rehearse a list's combos");
                        me.failed.lock().unwrap().insert(list_hash.clone());
                    }
                }
            }
            me.pending.lock().unwrap().remove(&list_hash);
        });
    }
}

/// The computer's plan for `cards`, for the deck analysis (MCP `get_deck_analysis`): the combos
/// Spellbook lists in it that a practice game won with, those it didn't, and whether the answer is
/// still being worked out. For a saved deck (`saved`), asking starts the work when there's no
/// answer yet; a pasted list is only looked up, so trying lists out costs no rehearsals.
pub async fn for_analysis(st: &crate::routes::AppState, cards: &[DeckCard], saved: bool) -> Value {
    let note = "What Yama's computer opponent learned about this list's combos before playing it: each \
        combo Commander Spellbook lists in it is set out on a practice game of the list, as though earlier \
        turns had drawn and played it, and the computer looks for a line that wins. `wins` it can play: in \
        a game it fetches their missing cards with its tutors and holds back the cards the winning line \
        casts (`holds`, and `with`: the spell outside the combo that finishes it). `no_win` it doesn't chase (it still plays one if it happens to hold all of it). A miss \
        can be the engine's: a card it can't yet run, a choice it can't make, a win that comes from \
        attacking. Worked out once per list and engine version, in the background.";
    if !st.cfg.ai_combos {
        return json!({"status": "off", "note": note});
    }
    let engine = match st.play.engine() {
        Ok(engine) => engine,
        Err(_) => return json!({"status": "engine_unavailable", "note": note}),
    };
    let listed = match crate::combos::in_list(&st.pool, cards, yama_play::MAX_SEAT_COMBOS * 3).await {
        Ok(Some(found)) => found,
        Ok(None) => return json!({"status": "no_combo_catalog", "note": note}),
        Err(error) => {
            tracing::warn!(%error, "couldn't look up a list's combos for its plan");
            return json!({"status": "unavailable", "note": note});
        }
    };
    let lines = crate::play::deck_lines(cards);
    let as_listed: Vec<yama_play::ListedCombo> = listed.iter().map(|c| yama_play::ListedCombo { id: &c.id, cards: &c.cards }).collect();
    let mut found = engine.resolve_combos(&lines, &as_listed);
    if found.is_empty() {
        return json!({"status": "no_combos", "engine": yama_play::ENGINE_VERSION, "note": note});
    }
    let hash = crate::deck_checks::list_hash(cards);
    let kept = stored(&st.pool, &hash).await.unwrap_or_else(|error| {
        tracing::warn!(%error, "couldn't read a list's combo plans");
        None
    });
    let covered = kept.as_deref().is_some_and(|kept| attach(&mut found, kept));
    if !covered && saved {
        let (deck, _) = crate::play::resolve(&engine, cards);
        st.play.plans.request(st.pool.clone(), engine.clone(), hash.clone(), deck, found.iter().map(|c| SeatCombo { plan: None, ..c.clone() }).collect());
    }
    let link = |id: &str| format!("https://commanderspellbook.com/combo/{id}/");
    let wins: Vec<Value> = found
        .iter()
        .filter_map(|c| match &c.plan {
            Some(ComboPlan::Wins { with, cast }) => Some(json!({"id": c.id, "cards": c.cards, "with": with, "holds": cast, "link": link(&c.id)})),
            _ => None,
        })
        .collect();
    let no_win: Vec<Value> = found
        .iter()
        .filter(|c| matches!(c.plan, Some(ComboPlan::NoWin)))
        .map(|c| json!({"id": c.id, "cards": c.cards, "link": link(&c.id)}))
        .collect();
    let not_rehearsed = found.iter().filter(|c| c.plan.is_none()).count();
    json!({
        "status": if covered { "ready" } else if saved { "working" } else { "not_learned" },
        "engine": yama_play::ENGINE_VERSION,
        "combos": found.len(),
        "wins": wins,
        "no_win": no_win,
        "not_rehearsed": not_rehearsed,
        "note": note,
    })
}
