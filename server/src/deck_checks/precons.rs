//! Commander Spellbook's answer for each public stock precon list (`precon_checks`).
//!
//! A stock list is public catalog data, so asking Spellbook about one sends nothing of anyone's.
//! These rows are apart from people's deck checks in both directions: a person's check is never
//! read for a stock list, and a stock check never answers for a person's deck.
//!
//! The deck-check worker asks about one stock list at a time when no person's deck is waiting,
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
        let hash = list_hash(&cards);
        if due(state.get(&hash), now) {
            return Ok(Some((id, hash, cards)));
        }
    }
    Ok(None)
}

/// Ask Spellbook about one stock list that is due, and store the answer or the failure. `Ok(false)`
/// when none is due. With `pacer`, the request waits for Spellbook's shared turn and a 429 holds
/// everyone off, as for a person's deck ([`run_one`]).
pub(super) async fn run_next(pool: &SqlitePool, http: &reqwest::Client, url: &str, pacer: Option<&Research>) -> Result<bool, CheckError> {
    let failed = |what: &str, e: &dyn std::fmt::Display| CheckError::Failed(format!("couldn't {what}: {e}"));
    let Some((id, hash, cards)) = next(pool).await.map_err(|e| failed("read the stock lists", &e))? else {
        return Ok(false);
    };
    if let Some(pacer) = pacer {
        pacer.pace(Provider::Spellbook).await;
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
            sqlx::query(
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
            .await
        }
        Err(e) => {
            sqlx::query(
                "INSERT INTO precon_checks (list_hash, source, precon_id, attempts, last_attempt_at, error) VALUES (?, ?, ?, 1, ?, ?)
                 ON CONFLICT (list_hash, source) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, error = excluded.error",
            )
            .bind(&hash)
            .bind(SPELLBOOK)
            .bind(&id)
            .bind(&started)
            .bind(e.to_string())
            .execute(pool)
            .await
        }
    };
    stored.map_err(|e| failed("save a stock list's check", &e))?;
    outcome.map(|_| true)
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
        assert!(run_next(&pool, &http, &url, None).await.unwrap());
        // Answered: nothing is due until the answer is old.
        assert!(!run_next(&pool, &http, &url, None).await.unwrap());

        let lists = crate::public_precons::stock_lists(&pool).await.unwrap();
        let found = results(&pool).await.unwrap();
        let r = &found[&list_hash(&lists[0].1)];
        assert_eq!((r.bracket_tag.as_str(), r.bracket), ("R", Some(4)));
        assert!(r.game_changers.iter().any(|g| g == "Rhystic Study"), "{:?}", r.game_changers);

        // A corrected stock list is a different list: it is asked about, and reads its own answer.
        sqlx::query("UPDATE precons SET cards = ? WHERE id = 'riders-of-rohan'")
            .bind(serde_json::json!([{ "name": "Éowyn, Shieldmaiden", "oracle_id": ROHAN, "qty": 1, "board": "commander" }]).to_string())
            .execute(&pool)
            .await
            .unwrap();
        assert!(run_next(&pool, &http, &url, None).await.unwrap());
        assert_eq!(results(&pool).await.unwrap().len(), 2);

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
        assert!(run_next(&pool, &http, &good, None).await.unwrap());
        // The answer goes stale, and Spellbook is down when it is asked again.
        sqlx::query("UPDATE precon_checks SET checked_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        let down = super::super::tests::fake_spellbook(500).await;
        assert!(matches!(run_next(&pool, &http, &down, None).await, Err(CheckError::Failed(_))));
        let (attempts, error): (i64, Option<String>) = sqlx::query_as("SELECT attempts, error FROM precon_checks").fetch_one(&pool).await.unwrap();
        assert_eq!(attempts, 1);
        assert!(error.is_some_and(|e| e.contains("500")));
        // The old answer still reads, and the next try waits out its pause.
        assert_eq!(results(&pool).await.unwrap().len(), 1);
        assert!(!run_next(&pool, &http, &good, None).await.unwrap());
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
