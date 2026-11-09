//! Reviewed stock lists not yet present in the imported benchmark catalog.
//! Inserts missing catalog rows only; no account decks, ratings or existing lists change.
use super::PreconCard;
use crate::util::{now, sha256_hex};
use serde::Deserialize;
use sqlx::SqlitePool;

const STOCK: &str = include_str!("../../resources/star-trek-precons.json");

#[derive(Deserialize)]
struct Stock {
    id: String,
    name: String,
    set_code: String,
    set_name: String,
    released: String,
    commanders: Vec<String>,
    color_identity: String,
    cards: Vec<PreconCard>,
    source: String,
}

pub async fn missing_stock(pool: &SqlitePool) -> anyhow::Result<u64> {
    let decks: Vec<Stock> = serde_json::from_str(STOCK)?;
    let stamp = now();
    let mut tx = pool.begin().await?;
    let mut added = 0;
    for d in decks {
        let cards = serde_json::to_string(&d.cards)?;
        added += sqlx::query(
            "INSERT INTO precons(id,lab_id,name,set_code,set_name,released,commanders,color_identity,cards,source,content_sha256,imported_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(&d.id).bind(format!("precons/{}", d.id)).bind(&d.name)
        .bind(&d.set_code).bind(&d.set_name).bind(&d.released)
        .bind(serde_json::to_string(&d.commanders)?).bind(&d.color_identity)
        .bind(&cards).bind(format!("MTGJSON {} (reviewed 2026-11-09)", d.source))
        .bind(sha256_hex(&cards)).bind(&stamp)
        .execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decks::Board;

    #[tokio::test]
    async fn adds_four_complete_stock_lists_without_ratings_and_preserves_existing_rows() {
        let pool = crate::db::test_pool().await;
        assert_eq!(missing_stock(&pool).await.unwrap(), 4);
        let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id, cards, released, playgroup FROM precons ORDER BY id",
        ).fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 4);
        for (_, text, release, real) in &rows {
            let cards: Vec<PreconCard> = serde_json::from_str(text).unwrap();
            assert_eq!(cards.iter().map(|c| c.qty).sum::<u32>(), 100);
            assert_eq!(cards.iter().filter(|c| c.board == Board::Commander).map(|c| c.qty).sum::<u32>(), 1);
            assert!(cards.iter().all(|c| c.qty > 0 && c.oracle_id.as_ref().is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())));
            assert_eq!(release, "2026-11-13");
            assert!(real.is_none());
        }
        assert_eq!(rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["federation-fleet", "klingon-fury", "landing-party", "we-are-the-borg"]);
        sqlx::query("UPDATE precons SET name='Existing corrected list', imported_at='preserve' WHERE id='landing-party'").execute(&pool).await.unwrap();
        assert_eq!(missing_stock(&pool).await.unwrap(), 0);
        let row: (String, String) = sqlx::query_as("SELECT name,imported_at FROM precons WHERE id='landing-party'").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("Existing corrected list".into(), "preserve".into()));
        let published: i64 = sqlx::query_scalar("SELECT count(*) FROM precon_publications").fetch_one(&pool).await.unwrap();
        assert_eq!(published, 0);
    }
}
