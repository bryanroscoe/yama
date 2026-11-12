//! Commander Spellbook's answer for each public stock precon list (`precon_checks`).
//!
//! A stock list is public catalog data, so asking Spellbook about one sends nothing of anyone's.
//! These rows are apart from people's deck checks in both directions: a person's check is never
//! read for a stock list, and a stock check never answers for a person's deck.
//!
//! The deck-check worker asks about one stock list at a time when no person's deck is due,
//! through the same pacer, so people's checks always go first.
use super::*;

/// A stored answer older than this is asked again: Wizards changes the Game Changers list and
/// Spellbook adds combos.
const REFRESH_DAYS: i64 = 30;

/// What is kept of an answer (`precon_checks.result`).
#[derive(Serialize, Deserialize)]
struct Stored {
    bracket_tag: String,
    game_changers: Vec<String>,
    mld: Vec<String>,
    extra_turns: Vec<String>,
    combos: Vec<Combo>,
    unrecognized: Vec<String>,
}

impl Stored {
    fn result(self, checked_at: String) -> CheckResult {
        let (bracket_label, bracket) = bracket_of_tag(&self.bracket_tag);
        CheckResult {
            checked_at,
            bracket_tag: self.bracket_tag,
            bracket_label,
            bracket,
            game_changers: self.game_changers,
            mld: self.mld,
            extra_turns: self.extra_turns,
            combos: self.combos,
            unrecognized: self.unrecognized,
        }
    }
}

/// Every stored answer, by the hash of the list it was asked about ([`list_hash`]).
pub async fn results(pool: &SqlitePool) -> sqlx::Result<HashMap<String, CheckResult>> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT list_hash, checked_at, result FROM precon_checks WHERE source = ? AND checked_at IS NOT NULL AND result IS NOT NULL")
            .bind(SPELLBOOK)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().filter_map(|(hash, at, json)| Some((hash, serde_json::from_str::<Stored>(&json).ok()?.result(at)))).collect())
}

/// The stored answer for one list, by its hash ([`list_hash`]): [`results`] for a single page.
pub async fn result(pool: &SqlitePool, hash: &str) -> sqlx::Result<Option<CheckResult>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT checked_at, result FROM precon_checks WHERE source = ? AND list_hash = ? AND checked_at IS NOT NULL AND result IS NOT NULL")
            .bind(SPELLBOOK)
            .bind(hash)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(at, json)| Some(serde_json::from_str::<Stored>(&json).ok()?.result(at))))
}

/// Whether a list with this stored state is due a request now: never asked, an answer older than
/// [`REFRESH_DAYS`], or a failed try whose pause has run out. After [`MAX_ATTEMPTS`] failures it
/// rests for [`REFRESH_DAYS`] and then starts over.
fn due(state: Option<&(Option<String>, i64, Option<String>)>, now: DateTime<Utc>) -> bool {
    let Some((checked_at, attempts, last_attempt_at)) = state else { return true };
    let stale = stamp_of(now - chrono::Duration::days(REFRESH_DAYS));
    if *attempts >= MAX_ATTEMPTS {
        return last_attempt_at.as_ref().is_none_or(|t| *t < stale);
    }
    if *attempts > 0 {
        return due_at(*attempts, last_attempt_at.as_deref(), now) <= now;
    }
    checked_at.as_ref().is_none_or(|t| *t < stale)
}

/// The next stock list to ask about: its precon, its hash and its cards.
async fn next(pool: &SqlitePool) -> anyhow::Result<Option<(String, String, Vec<DeckCard>)>> {
    let state: HashMap<String, (Option<String>, i64, Option<String>)> =
        sqlx::query_as::<_, (String, Option<String>, i64, Option<String>)>("SELECT list_hash, checked_at, attempts, last_attempt_at FROM precon_checks WHERE source = ?")
            .bind(SPELLBOOK)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(hash, at, attempts, last)| (hash, (at, attempts, last)))
            .collect();
    let now = Utc::now();
    for (id, cards) in crate::public_precons::stock_lists(pool).await? {
        // Spellbook takes oracle ids: a list with none Yama knows has nothing to ask about.
        if !cards.iter().any(|c| c.board != Board::Side && c.qty > 0 && !c.oracle_id.is_empty()) {
            continue;
        }
        let hash = list_hash(&cards);
        if due(state.get(&hash), now) {
            return Ok(Some((id, hash, cards)));
        }
    }
    Ok(None)
}

/// What a stock list's turn did.
#[derive(Debug, PartialEq)]
pub(super) enum Turn {
    /// Asked Spellbook and stored the answer.
    Asked,
    /// A person's deck fell due while this waited for its turn: theirs goes first.
    Yielded,
    /// No stock list is due.
    Idle,
}

/// Ask Spellbook about one stock list that is due, and store the answer or the failure. With
/// `pacer`, the request waits for Spellbook's shared turn and a 429 holds everyone off, as for a
/// person's deck ([`run_one`]). That wait can be long, so a person's deck that fell due meanwhile
/// takes the turn instead.
pub(super) async fn run_next(pool: &SqlitePool, http: &reqwest::Client, url: &str, pacer: Option<&Research>) -> Result<Turn, CheckError> {
    let failed = |what: &str, e: &dyn std::fmt::Display| CheckError::Failed(format!("couldn't {what}: {e}"));
    let Some((id, hash, cards)) = next(pool).await.map_err(|e| failed("read the stock lists", &e))? else {
        return Ok(Turn::Idle);
    };
    if let Some(pacer) = pacer {
        pacer.pace(Provider::Spellbook).await;
        if matches!(next_pending(pool).await, Ok(Next::Due(_))) {
            return Ok(Turn::Yielded);
        }
    }
    let started = stamp();
    // Spellbook takes oracle ids; a card Yama's data doesn't know has none to send.
    let known: Vec<DeckCard> = cards.into_iter().filter(|c| !c.oracle_id.is_empty()).collect();
    let outcome = fetch(http, url, &known, &id, &started).await;
    if let (Some(pacer), Err(CheckError::RateLimited(wait))) = (pacer, &outcome) {
        pacer.hold_off(Provider::Spellbook, *wait);
    }
    let stored = match &outcome {
        Ok((r, _)) => {
            let kept = Stored {
                bracket_tag: r.bracket_tag.clone(),
                game_changers: r.game_changers.clone(),
                mld: r.mld.clone(),
                extra_turns: r.extra_turns.clone(),
                combos: r.combos.clone(),
                unrecognized: r.unrecognized.clone(),
            };
            let saved = sqlx::query(
                "INSERT INTO precon_checks (list_hash, source, precon_id, checked_at, result, attempts, last_attempt_at, error) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)
                 ON CONFLICT (list_hash, source) DO UPDATE SET precon_id = excluded.precon_id, checked_at = excluded.checked_at, result = excluded.result,
                    attempts = 0, last_attempt_at = excluded.last_attempt_at, error = NULL",
            )
            .bind(&hash)
            .bind(SPELLBOOK)
            .bind(&id)
            .bind(&r.checked_at)
            .bind(json(&kept))
            .bind(&r.checked_at)
            .execute(pool)
            .await;
            // Answers for lists this precon no longer has are never read again.
            match saved {
                Ok(_) => sqlx::query("DELETE FROM precon_checks WHERE precon_id = ? AND source = ? AND list_hash != ?").bind(&id).bind(SPELLBOOK).bind(&hash).execute(pool).await,
                Err(e) => Err(e),
            }
        }
        Err(e) => {
            sqlx::query(
                "INSERT INTO precon_checks (list_hash, source, precon_id, attempts, last_attempt_at, error) VALUES (?, ?, ?, 1, ?, ?)
                 ON CONFLICT (list_hash, source) DO UPDATE SET
                    attempts = CASE WHEN precon_checks.attempts >= ? THEN 1 ELSE precon_checks.attempts + 1 END,
                    last_attempt_at = excluded.last_attempt_at, error = excluded.error",
            )
            .bind(&hash)
            .bind(SPELLBOOK)
            .bind(&id)
            .bind(&started)
            .bind(e.to_string())
            // A row at the limit is only tried again after its long rest ([`due`]): a failure
            // then starts a new round of tries, not another month's wait.
            .bind(MAX_ATTEMPTS)
            .execute(pool)
            .await
        }
    };
    stored.map_err(|e| failed("save a stock list's check", &e))?;
    outcome.map(|_| Turn::Asked)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROHAN: &str = "98a2a642-a30a-43e7-b47f-4776c22d1cb0";

    async fn precon(pool: &SqlitePool, id: &str, cards: serde_json::Value) {
        sqlx::query(
            "INSERT INTO precons (id, lab_id, name, set_code, commanders, cards, source, content_sha256, imported_at) VALUES (?, ?, ?, 'LTC', '[]', ?, 'test', 'hash', '2026-11-11T00:00:00Z')",
        )
        .bind(id)
        .bind(format!("precons/{id}"))
        .bind(id)
        .bind(cards.to_string())
        .execute(pool)
        .await
        .unwrap();
    }

    fn rohan() -> serde_json::Value {
        serde_json::json!([
            { "name": "Éowyn, Shieldmaiden", "oracle_id": ROHAN, "qty": 1, "board": "commander" },
            { "name": "Rhystic Study", "oracle_id": "53236dd7-845a-444c-96d5-f41ed7325d8f", "qty": 1, "board": "main" },
            { "name": "Not in the card data", "oracle_id": null, "qty": 1, "board": "main" },
        ])
    }

    #[tokio::test]
    async fn a_stock_list_is_asked_once_and_its_answer_is_read_by_its_hash() {
        let pool = crate::db::test_pool().await;
        precon(&pool, "riders-of-rohan", rohan()).await;
        let url = super::super::tests::fake_spellbook(200).await;
        let http = crate::routes::http_client();
        assert_eq!(run_next(&pool, &http, &url, None).await.unwrap(), Turn::Asked);
        // Answered: nothing is due until the answer is old.
        assert_eq!(run_next(&pool, &http, &url, None).await.unwrap(), Turn::Idle);

        let lists = crate::public_precons::stock_lists(&pool).await.unwrap();
        let found = results(&pool).await.unwrap();
        let r = &found[&list_hash(&lists[0].1)];
        assert_eq!((r.bracket_tag.as_str(), r.bracket), ("R", Some(4)));
        assert!(r.game_changers.iter().any(|g| g == "Rhystic Study"), "{:?}", r.game_changers);
        // One list's page reads the same answer on its own.
        assert_eq!(result(&pool, &list_hash(&lists[0].1)).await.unwrap().as_ref(), Some(r));
        assert_eq!(result(&pool, "no-such-list").await.unwrap(), None);

        // A corrected stock list is a different list: it is asked about, and reads its own answer.
        sqlx::query("UPDATE precons SET cards = ? WHERE id = 'riders-of-rohan'")
            .bind(serde_json::json!([{ "name": "Éowyn, Shieldmaiden", "oracle_id": ROHAN, "qty": 1, "board": "commander" }]).to_string())
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(run_next(&pool, &http, &url, None).await.unwrap(), Turn::Asked);
        // The answer for the list it no longer has is gone.
        let now = crate::public_precons::stock_lists(&pool).await.unwrap();
        let kept = results(&pool).await.unwrap();
        assert_eq!(kept.keys().collect::<Vec<_>>(), [&list_hash(&now[0].1)]);

        // No person's deck check was made or read.
        let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_version_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(people, 0);
    }

    #[tokio::test]
    async fn a_failed_try_waits_and_keeps_the_last_answer() {
        let pool = crate::db::test_pool().await;
        precon(&pool, "riders-of-rohan", rohan()).await;
        let http = crate::routes::http_client();
        let good = super::super::tests::fake_spellbook(200).await;
        assert_eq!(run_next(&pool, &http, &good, None).await.unwrap(), Turn::Asked);
        // The answer goes stale, and Spellbook is down when it is asked again.
        sqlx::query("UPDATE precon_checks SET checked_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        let down = super::super::tests::fake_spellbook(500).await;
        assert!(matches!(run_next(&pool, &http, &down, None).await, Err(CheckError::Failed(_))));
        let (attempts, error): (i64, Option<String>) = sqlx::query_as("SELECT attempts, error FROM precon_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(attempts, 1);
        assert!(error.is_some_and(|e| e.contains("500")));
        // The old answer still reads, and the next try waits out its pause.
        assert_eq!(results(&pool).await.unwrap().len(), 1);
        assert_eq!(run_next(&pool, &http, &good, None).await.unwrap(), Turn::Idle);
    }

    #[tokio::test]
    async fn a_failure_after_the_long_rest_starts_a_new_round_of_tries() {
        let pool = crate::db::test_pool().await;
        precon(&pool, "riders-of-rohan", rohan()).await;
        let http = crate::routes::http_client();
        let down = super::super::tests::fake_spellbook(500).await;
        assert!(run_next(&pool, &http, &down, None).await.is_err());
        // Given up a month ago.
        sqlx::query("UPDATE precon_checks SET attempts = ?, last_attempt_at = '2026-01-01T00:00:00.000Z'").bind(MAX_ATTEMPTS).execute(&pool).await.unwrap();
        assert!(run_next(&pool, &http, &down, None).await.is_err());
        let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM precon_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(attempts, 1);
        // So the next try waits a minute, not another month.
        assert_eq!(run_next(&pool, &http, &down, None).await.unwrap(), Turn::Idle);
        sqlx::query("UPDATE precon_checks SET last_attempt_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        assert!(run_next(&pool, &http, &down, None).await.is_err());
    }

    #[tokio::test]
    async fn a_persons_deck_that_fell_due_takes_the_turn() {
        let pool = crate::db::test_pool().await;
        precon(&pool, "riders-of-rohan", rohan()).await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@example.com', 'A', '2026-10-19T00:00:00Z')").execute(&pool).await.unwrap();
        let cards = vec![DeckCard { oracle_id: ROHAN.into(), name: "Éowyn, Shieldmaiden".into(), qty: 1, board: Board::Commander }];
        crate::decks::create_deck_with_cards(&pool, "u1", "Rohan", None, cards).await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(_)));
        let pacer = Research::new(false, pool.clone());
        let url = super::super::tests::fake_spellbook(200).await;
        assert_eq!(run_next(&pool, &crate::routes::http_client(), &url, Some(&pacer)).await.unwrap(), Turn::Yielded);
        // Nothing was asked about the stock list, and the person's check still waits its turn.
        let stock: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM precon_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(stock, 0);
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(_)));
    }

    #[tokio::test]
    async fn a_list_with_no_known_card_is_never_asked_about() {
        let pool = crate::db::test_pool().await;
        precon(&pool, "unknown", serde_json::json!([{ "name": "Not in the card data", "oracle_id": null, "qty": 1, "board": "commander" }])).await;
        let url = super::super::tests::fake_spellbook(200).await;
        assert_eq!(run_next(&pool, &crate::routes::http_client(), &url, None).await.unwrap(), Turn::Idle);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM precon_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn due_follows_age_failures_and_the_long_rest() {
        let now = Utc::now();
        let days = |n: i64| Some(stamp_of(now - chrono::Duration::days(n)));
        assert!(due(None, now));
        assert!(!due(Some(&(days(1), 0, days(1))), now));
        assert!(due(Some(&(days(31), 0, days(31))), now));
        // One failure a minute ago waits; one from an hour ago is due.
        assert!(!due(Some(&(None, 1, Some(stamp_of(now - chrono::Duration::seconds(10))))), now));
        assert!(due(Some(&(None, 1, Some(stamp_of(now - chrono::Duration::hours(1))))), now));
        // Given up: rests a month, then starts over.
        assert!(!due(Some(&(None, MAX_ATTEMPTS, days(2))), now));
        assert!(due(Some(&(None, MAX_ATTEMPTS, days(31))), now));
    }
}
