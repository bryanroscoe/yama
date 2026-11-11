//! Paging for list answers: `limit` plus an opaque `cursor`, and `next_cursor` in the answer.
//!
//! A cursor is where the next page starts, tied to the list it came from (its scope), so a cursor
//! from one tool or section can't be replayed against another. It holds the scope and a number:
//! at most the caller's own filter (a plan key), never a row.
//!
//! It counts from the start of the list. A list the conversation itself shortens (proposals once
//! answered, changes once applied) shifts under it, so those tools say to start again without a
//! cursor after something on the list was dealt with.

use crate::error::{AppError, AppResult};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

/// The farthest a cursor may point: no list a tool pages through is longer.
const MAX_OFFSET: usize = 8_000_000;

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

/// Where a list starts: at `cursor` when the call has one, else where the tool's older argument
/// (`offset`, `page`) puts it. Every list takes `cursor`; the older arguments still work.
pub fn start(args: &Value, scope: &str, older: usize) -> AppResult<usize> {
    match args.get("cursor").filter(|v| !v.is_null()) {
        None => Ok(older),
        Some(v) => v.as_str().and_then(|c| decode(scope, c)).ok_or_else(|| {
            AppError::bad("cursor isn't one this tool returned for these arguments. Leave it out to start from the beginning.")
        }),
    }
}

/// The scope of a list whose rows depend on the call's other arguments: the tool, and a digest
/// of those arguments, so a cursor continues the same list and no other.
pub fn scope(tool: &str, parts: &[&str]) -> String {
    format!("{tool}.{}", &crate::util::sha256_hex(&parts.join("\u{1f}"))[..12])
}

/// Drop rows from the end until the page serializes to at most `budget` characters, keeping at
/// least one. True when any were dropped: the caller's `next_cursor` then starts at the first
/// one left out, so a page that would be too long is a shorter page, never an error.
pub fn fit(rows: &mut Vec<Value>, budget: usize) -> bool {
    let mut size: usize = rows.iter().map(|r| r.to_string().len() + 1).sum();
    let before = rows.len();
    while size > budget && rows.len() > 1 {
        if let Some(last) = rows.pop() {
            size -= last.to_string().len() + 1;
        }
    }
    rows.len() < before
}

/// What the rows of one page may weigh, leaving room for what goes around them.
pub const PAGE_BUDGET: usize = 30_000;

/// The cursor for a page starting at `offset` of the list `scope` names.
pub fn cursor(scope: &str, offset: usize) -> String {
    URL_SAFE_NO_PAD.encode(format!("{scope}:{offset}"))
}

pub(super) fn decode(scope: &str, cursor: &str) -> Option<usize> {
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

        // A list that used to page by offset: the cursor wins, the old argument still works.
        let games = scope("games", &["all", "newest", "krenko"]);
        assert_eq!(start(&json!({}), &games, 0).unwrap(), 0);
        assert_eq!(start(&json!({}), &games, 50).unwrap(), 50, "the older offset");
        assert_eq!(start(&json!({"cursor": cursor(&games, 30)}), &games, 50).unwrap(), 30);
        assert!(start(&json!({"cursor": cursor(&games, 30)}), &scope("games", &["all", "newest", "atraxa"]), 0).is_err(), "another search's cursor");
        assert_ne!(scope("games", &["a", "bc"]), scope("games", &["ab", "c"]), "the parts don't run together");

        // A page that would be too long is a shorter page.
        let row = json!({"name": "x".repeat(98)});
        let mut rows = vec![row.clone(); 50];
        assert!(fit(&mut rows, 1_000) && rows.len() == 9, "{} rows", rows.len());
        let mut one = vec![json!({"name": "y".repeat(5_000)})];
        assert!(!fit(&mut one, 1_000) && one.len() == 1, "one row is always given");
        let mut few = vec![row; 3];
        assert!(!fit(&mut few, 1_000) && few.len() == 3);
    }
}
