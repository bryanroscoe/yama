//! Reading the history: a printing's prices on each observed day, and one series' changes.

use super::{SCRYFALL, SCRYFALL_SERIES, date_of, day_of};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sqlx::SqlitePool;

/// A printing's prices on one observed day (the card sheet's chart and table).
#[derive(Debug, Serialize, PartialEq)]
pub struct DayPoint {
    pub date: String,
    pub usd: Option<f64>,
    pub usd_foil: Option<f64>,
    pub usd_etched: Option<f64>,
    pub eur: Option<f64>,
    pub eur_foil: Option<f64>,
    pub eur_etched: Option<f64>,
    pub tix: Option<f64>,
}

/// `from`/`to` (YYYY-MM-DD, either optional) as days.
pub fn range(from: Option<&str>, to: Option<&str>) -> AppResult<(i64, i64)> {
    let day = |d: Option<&str>, default: i64| match d.map(str::trim).filter(|d| !d.is_empty()) {
        None => Ok(default),
        Some(d) => day_of(d).ok_or_else(|| AppError::bad(format!("{d:?} isn't a date (YYYY-MM-DD)"))),
    };
    Ok((day(from, i64::MIN)?, day(to, i64::MAX)?))
}

/// `feed`'s observed days in `[from, to]`, and the printing's rows on or before `to`, oldest first.
async fn read(pool: &SqlitePool, feed: &str, scryfall_id: &str, from: i64, to: i64) -> AppResult<(Vec<i64>, Vec<(i64, i64, Option<i64>)>)> {
    let days: Vec<i64> = sqlx::query_scalar("SELECT day FROM price_observation WHERE feed = ? AND day BETWEEN ? AND ? ORDER BY day")
        .bind(feed)
        .bind(from)
        .bind(to)
        .fetch_all(pool)
        .await?;
    let rows: Vec<(i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT pp.day, pp.series, pp.cents FROM price_point pp JOIN price_printing k ON k.id = pp.printing
          WHERE k.scryfall_id = ? AND pp.day <= ? ORDER BY pp.day",
    )
    .bind(scryfall_id)
    .bind(to)
    .fetch_all(pool)
    .await?;
    Ok((days, rows))
}

/// One printing's prices on each observed day in `[from, to]` on which it had any, oldest first.
/// Days nobody read, and days it had no price at all, are left out, as the old daily table had no
/// row for them. One read of the days and one of the printing's rows, walked here.
pub async fn history(pool: &SqlitePool, scryfall_id: &str, from: i64, to: i64) -> AppResult<Vec<DayPoint>> {
    let (days, rows) = read(pool, SCRYFALL, scryfall_id, from, to).await?;
    let mut values = [None::<i64>; 7];
    let mut next = rows.iter().peekable();
    let mut out = Vec::new();
    for day in days {
        while let Some((_, series, cents)) = next.next_if(|(d, ..)| *d <= day) {
            if let Some(i) = SCRYFALL_SERIES.iter().position(|(id, _)| id == series) {
                values[i] = *cents;
            }
        }
        if values.iter().all(Option::is_none) {
            continue;
        }
        let v = |i: usize| values[i].map(|c| c as f64 / 100.0);
        out.push(DayPoint { date: date_of(day), usd: v(0), usd_foil: v(1), usd_etched: v(2), eur: v(3), eur_foil: v(4), eur_etched: v(5), tix: v(6) });
    }
    Ok(out)
}

/// One series of a printing over `[from, to]` (the MCP `price_history` tool): the observed days,
/// the value on the first and the last, and each change between, a missing price as `None`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Changes {
    pub observed_days: usize,
    pub first: Option<(String, Option<f64>)>,
    pub last: Option<(String, Option<f64>)>,
    pub low: Option<(String, f64)>,
    pub high: Option<(String, f64)>,
    pub changes: Vec<(String, Option<f64>)>,
}

/// One series' changes over its own feed's observed days in `[from, to]`.
pub async fn changes(pool: &SqlitePool, scryfall_id: &str, series: i64, from: i64, to: i64) -> AppResult<Changes> {
    let feed: Option<String> = sqlx::query_scalar("SELECT feed FROM price_series WHERE id = ?").bind(series).fetch_optional(pool).await?;
    let feed = feed.ok_or_else(|| AppError::bad(format!("no price series {series}")))?;
    let (days, rows) = read(pool, &feed, scryfall_id, from, to).await?;
    let mut value = None::<i64>;
    let mut next = rows.iter().filter(|(_, s, _)| *s == series).peekable();
    let mut out = Changes { observed_days: days.len(), first: None, last: None, low: None, high: None, changes: Vec::new() };
    let mut previous: Option<Option<i64>> = None;
    for day in days {
        while let Some((_, _, cents)) = next.next_if(|(d, ..)| *d <= day) {
            value = *cents;
        }
        let date = date_of(day);
        let price = value.map(|c| c as f64 / 100.0);
        if out.first.is_none() {
            out.first = Some((date.clone(), price));
        } else if previous != Some(value) {
            out.changes.push((date.clone(), price));
        }
        if let Some(p) = price {
            if out.low.as_ref().is_none_or(|(_, l)| p < *l) {
                out.low = Some((date.clone(), p));
            }
            if out.high.as_ref().is_none_or(|(_, h)| p > *h) {
                out.high = Some((date.clone(), p));
            }
        }
        out.last = Some((date, price));
        previous = Some(value);
    }
    Ok(out)
}
