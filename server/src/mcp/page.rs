//! Paging for list answers: `limit` plus an opaque `cursor`, and `next_cursor` in the answer.
//!
//! A cursor is where the next page starts, tied to the list it came from (its scope), so a cursor
//! from one tool or section can't be replayed against another. It holds no account data.

use crate::error::{AppError, AppResult};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

/// The farthest a cursor may point: no list a tool pages through is longer.
const MAX_OFFSET: usize = 1_000_000;

/// Where a page starts and how many items it may hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
    pub offset: usize,
    pub limit: usize,
}

impl Page {
    /// The cursor for the page after this one, when `total` items exist.
    pub fn next(&self, scope: &str, total: usize) -> Option<String> {
        let end = self.offset.saturating_add(self.limit);
        (end < total).then(|| cursor(scope, end))
    }
}

/// `limit` (1 to `max`, default `default`) and `cursor` from a tool's arguments.
pub fn page(args: &Value, scope: &str, default: usize, max: usize) -> AppResult<Page> {
    let limit = match args.get("limit").filter(|v| !v.is_null()) {
        None => default,
        Some(v) => v
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| (1..=max).contains(n))
            .ok_or_else(|| AppError::bad(format!("limit must be a whole number from 1 to {max}")))?,
    };
    let offset = match args.get("cursor").filter(|v| !v.is_null()) {
        None => 0,
        Some(v) => v.as_str().and_then(|c| decode(scope, c)).ok_or_else(|| {
            AppError::bad("cursor isn't one this tool returned for these arguments. Leave it out to start from the beginning.")
        })?,
    };
    Ok(Page { offset, limit })
}

/// The cursor for a page starting at `offset` of the list `scope` names.
pub fn cursor(scope: &str, offset: usize) -> String {
    URL_SAFE_NO_PAD.encode(format!("{scope}:{offset}"))
}

fn decode(scope: &str, cursor: &str) -> Option<usize> {
    let raw = URL_SAFE_NO_PAD.decode(cursor.trim()).ok()?;
    let text = String::from_utf8(raw).ok()?;
    let offset: usize = text.strip_prefix(scope)?.strip_prefix(':')?.parse().ok()?;
    (offset <= MAX_OFFSET).then_some(offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_cursor_only_works_for_the_list_it_came_from() {
        let first = page(&json!({}), "overview.decks", 20, 100).unwrap();
        assert_eq!(first, Page { offset: 0, limit: 20 });
        let next = first.next("overview.decks", 45).unwrap();
        assert_eq!(page(&json!({"cursor": next, "limit": 10}), "overview.decks", 20, 100).unwrap(), Page { offset: 20, limit: 10 });
        assert!(page(&json!({"cursor": next}), "overview.plans", 20, 100).is_err(), "another list's cursor");
        assert!(page(&json!({"cursor": "not a cursor"}), "overview.decks", 20, 100).is_err());
        assert!(page(&json!({"cursor": cursor("overview.decks", MAX_OFFSET + 1)}), "overview.decks", 20, 100).is_err());
        assert!(page(&json!({"limit": 0}), "overview.decks", 20, 100).is_err());
        assert!(page(&json!({"limit": 101}), "overview.decks", 20, 100).is_err());
        assert_eq!(Page { offset: 40, limit: 20 }.next("overview.decks", 45), None, "the last page has no cursor");
    }
}
