//! Reading a tool's arguments: one set of helpers and one set of messages for every tool
//! (2026-11-11; before, `tools.rs`, `changes.rs` and `research/` each had their own, and a value
//! that was too long was reported as missing).
//!
//! An argument left out, `null` or blank is absent. A wrong type or a value out of range is the
//! caller's mistake and says which argument and what it takes.

use crate::error::{AppError, AppResult};
use serde_json::Value;

/// The longest a name, key or id may be.
pub const TEXT: usize = 300;

/// A required text argument of at most `TEXT` characters.
pub fn text<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    text_max(args, key, TEXT)
}

/// A required text argument of at most `max` characters.
pub fn text_max<'a>(args: &'a Value, key: &str, max: usize) -> AppResult<&'a str> {
    opt_text(args, key, max)?.ok_or_else(|| AppError::bad(format!("{key} is missing")))
}

/// An optional text argument, trimmed.
pub fn opt_text<'a>(args: &'a Value, key: &str, max: usize) -> AppResult<Option<&'a str>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) if s.trim().chars().count() > max => Err(AppError::bad(format!("{key} is too long: at most {max} characters"))),
        Some(Value::String(s)) => Ok(Some(s.trim())),
        Some(_) => Err(AppError::bad(format!("{key} must be text"))),
    }
}

/// As `opt_text`, owned.
pub fn opt_string(args: &Value, key: &str, max: usize) -> AppResult<Option<String>> {
    Ok(opt_text(args, key, max)?.map(String::from))
}

/// A true-or-false argument; `default` when it's left out.
pub fn flag(args: &Value, key: &str, default: bool) -> AppResult<bool> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(AppError::bad(format!("{key} must be true or false"))),
    }
}

/// A whole number from `min` to `max`; `default` when it's left out.
pub fn int(args: &Value, key: &str, default: i64, min: i64, max: i64) -> AppResult<i64> {
    let n = match args.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v.as_i64().ok_or_else(|| AppError::bad(format!("{key} must be an integer")))?,
    };
    if !(min..=max).contains(&n) {
        return Err(AppError::bad(format!("{key} must be between {min} and {max}")));
    }
    Ok(n)
}

/// A number, `null` to clear it, or left out: `None` when left out, `Some(None)` for `null`.
pub fn opt_number(args: &Value, key: &str) -> AppResult<Option<Option<f64>>> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => v.as_f64().filter(|n| n.is_finite()).map(|n| Some(Some(n))).ok_or_else(|| AppError::bad(format!("{key} must be a number or null"))),
    }
}

/// A list of card names, at most `max`; left out means none.
pub fn names(args: &Value, key: &str, max: usize) -> AppResult<Vec<String>> {
    let Some(v) = args.get(key).filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let list = v.as_array().ok_or_else(|| AppError::bad(format!("{key} must be a list of card names")))?;
    if list.len() > max {
        return Err(AppError::bad(format!("{key}: at most {max} cards at a time")));
    }
    list.iter()
        .map(|n| n.as_str().map(str::trim).filter(|n| !n.is_empty() && n.len() <= 200).map(String::from).ok_or_else(|| AppError::bad(format!("{key} must be a list of card names"))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message<T: std::fmt::Debug>(r: AppResult<T>) -> String {
        r.unwrap_err().to_string()
    }

    #[test]
    fn a_missing_a_wrong_and_a_too_long_value_each_say_so() {
        let args = json!({"deck": "  Elf Ball ", "blank": "  ", "none": null, "number": 7, "long": "x".repeat(301), "yes": true, "n": 12, "half": 1.5});
        assert_eq!(text(&args, "deck").unwrap(), "Elf Ball");
        for absent in ["nothing", "blank", "none"] {
            assert_eq!(message(text(&args, absent)), format!("{absent} is missing"));
            assert_eq!(opt_text(&args, absent, TEXT).unwrap(), None);
        }
        assert_eq!(message(text(&args, "number")), "number must be text");
        // Too long used to be reported as missing, which sent the caller looking for a typo.
        assert_eq!(message(text(&args, "long")), "long is too long: at most 300 characters");
        assert_eq!(text_max(&args, "long", 400).unwrap().len(), 301);
        assert_eq!(opt_string(&args, "deck", TEXT).unwrap().as_deref(), Some("Elf Ball"));

        assert!(flag(&args, "yes", false).unwrap());
        assert!(flag(&args, "nothing", true).unwrap() && flag(&args, "none", true).unwrap());
        assert_eq!(message(flag(&args, "deck", false)), "deck must be true or false");
        assert_eq!(int(&args, "n", 1, 1, 20).unwrap(), 12);
        assert_eq!(int(&args, "nothing", 5, 1, 20).unwrap(), 5);
        assert_eq!(message(int(&args, "n", 1, 1, 10)), "n must be between 1 and 10");
        assert_eq!(message(int(&args, "half", 1, 1, 10)), "half must be an integer");
        assert_eq!(opt_number(&args, "half").unwrap(), Some(Some(1.5)));
        assert_eq!(opt_number(&args, "none").unwrap(), Some(None));
        assert_eq!(opt_number(&args, "nothing").unwrap(), None);
        assert_eq!(message(opt_number(&args, "deck")), "deck must be a number or null");
    }

    #[test]
    fn card_names_are_a_bounded_list_of_text() {
        assert_eq!(names(&json!({}), "add", 3).unwrap(), Vec::<String>::new());
        assert_eq!(names(&json!({"add": [" Sol Ring ", "Forest"]}), "add", 3).unwrap(), vec!["Sol Ring", "Forest"]);
        assert_eq!(message(names(&json!({"add": "Sol Ring"}), "add", 3)), "add must be a list of card names");
        assert_eq!(message(names(&json!({"add": ["Sol Ring", 7]}), "add", 3)), "add must be a list of card names");
        assert_eq!(message(names(&json!({"add": ["a", "b", "c", "d"]}), "add", 3)), "add: at most 3 cards at a time");
    }
}
