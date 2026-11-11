//! One definition per tool (2026-11-11): its name and the older names it still answers to, its
//! title and description, what kind of thing it does, who is offered it, its arguments, the
//! function that runs it and, for a staging tool, the function that applies what it staged.
//!
//! Before, a tool was spread over a table for the list, a `match` for the call and, for staged
//! changes, a second `match` for the apply, in two files with two table shapes; adding a tool
//! meant touching each, and nothing said they agreed. `tools/list`, `tools/call` and applying a
//! staged change now all read the same entry.
//!
//! The entries live beside their code: `tools::TOOLS` (Yama's own data and the staged writes) and
//! `research::TOOLS` (card research, analysis and outside sources), listed in that order.

use super::{Via, changes};
use crate::auth::User;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;

/// Who is calling: the server, the account, and how it got in.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub st: &'a AppState,
    pub user: &'a User,
    pub via: &'a Via,
}

pub type Answer<'a, T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

/// Runs a tool: the caller and its JSON arguments in, text for the assistant out.
pub type Handler = for<'a> fn(Ctx<'a>, &'a Value) -> Answer<'a, String>;

/// Applies a staged change: the stored payload in, what applying made out (a label and a link).
pub type Apply = for<'a> fn(&'a AppState, &'a User, Pending<'a>, &'a Value) -> Answer<'a, Value>;

/// The staged change being applied, as far as applying needs it.
#[derive(Clone, Copy)]
pub struct Pending<'a> {
    pub id: &'a str,
    pub summary: &'a str,
}

/// What a tool does. It decides the annotations a client shows the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Reads what Yama holds.
    Read,
    /// Reads, and asks a service outside Yama (Scryfall, EDHREC, Commander Spellbook, a deck site,
    /// Wizards' rules page).
    Outside,
    /// Stores a pending change for the person to review, and changes nothing else.
    Stage,
    /// Changes something directly: a research note or a stated preference, or applying or
    /// discarding a staged change. `destroys` says whether it can replace or remove something.
    Write { destroys: bool },
}

/// Who is offered a tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offer {
    Everyone,
    /// Tools that start simulations: admins and power users (`User::power`, 2026-10-31).
    Power,
    /// Applying and discarding: outside clients, after the person's yes. Never Ask Claude.
    Appliers,
}

/// What a staging tool stores, and how that is applied when the person says yes.
#[derive(Clone, Copy)]
pub struct Staging {
    /// `assistant_changes.kind`. Stored kinds never change, whatever the tool is called.
    pub kind: &'static str,
    pub apply: Apply,
}

pub struct Tool {
    pub name: &'static str,
    /// Older names `tools/call` still answers to. They are not listed.
    pub aliases: &'static [&'static str],
    pub title: &'static str,
    pub description: &'static str,
    pub kind: Kind,
    pub offer: Offer,
    /// Counts against the account's card-search rate limit.
    pub search: bool,
    /// The JSON Schema of its arguments. A staging tool's also gets `op_id`.
    pub schema: fn() -> Value,
    pub handler: Handler,
    /// For `Kind::Stage`: what it stages.
    pub stages: Option<Staging>,
}

/// A tool's handler from an `async fn(Ctx<'_>, &Value) -> AppResult<String>`.
macro_rules! run {
    ($f:path) => {
        |c, args| Box::pin($f(c, args))
    };
}
pub(super) use run;

/// Every tool, in the order `tools/list` gives them.
pub fn all() -> impl Iterator<Item = &'static Tool> {
    super::tools::TOOLS.iter().chain(super::research::TOOLS.iter())
}

/// The tool a call names: by its name, or by an older name it still answers to.
pub fn find(name: &str) -> Option<&'static Tool> {
    all().find(|t| t.name == name || t.aliases.contains(&name))
}

pub fn offered_to(tool: &Tool, user: &User, via: &Via) -> bool {
    match tool.offer {
        Offer::Everyone => true,
        Offer::Power => user.power,
        Offer::Appliers => via.may_apply(),
    }
}

fn annotations(kind: Kind) -> Value {
    match kind {
        Kind::Read => json!({"readOnlyHint": true, "openWorldHint": false}),
        Kind::Outside => json!({"readOnlyHint": true, "openWorldHint": true}),
        // Staging adds a pending row and nothing else: never destructive. A repeat stages a
        // second change unless the call carries an op_id.
        Kind::Stage => json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}),
        Kind::Write { destroys } => json!({"readOnlyHint": false, "destructiveHint": destroys, "idempotentHint": true, "openWorldHint": false}),
    }
}

/// The `op_id` argument every staging tool takes (`changes::op_id`).
fn op_id_schema() -> Value {
    json!({"type": "string", "minLength": 8, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$",
           "description": "Optional: your own id for this call, a new UUID each time you stage something. Calling again with the same op_id and the same arguments answers with the change already staged instead of staging another, so a retry after a lost reply is safe. Never reuse one for a different change: that is refused."})
}

/// `tools/list` for this caller.
pub fn list(user: &User, via: &Via) -> Vec<Value> {
    all()
        .filter(|t| offered_to(t, user, via))
        .map(|t| {
            let mut schema = (t.schema)();
            if t.stages.is_some() {
                schema["properties"]["op_id"] = op_id_schema();
            }
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": schema,
                "annotations": annotations(t.kind),
            })
        })
        .collect()
}

/// `tools/call`. Whether the caller is offered the tool is the route's check (`tools::offered`).
pub async fn call(st: &AppState, user: &User, via: &Via, name: &str, args: &Value) -> AppResult<String> {
    let tool = find(name).ok_or_else(|| AppError::bad(format!("unknown tool \"{name}\"")))?;
    // A staging call repeated with its op_id answers with the change it staged the first time,
    // before any check that would now fail because that change was applied.
    if let Some(staging) = &tool.stages {
        if let Some(op) = changes::op(staging.kind, args)? {
            if let Some(again) = changes::staged_before(st, user, via, &op).await? {
                return Ok(again);
            }
        }
    }
    if tool.search {
        st.limits.search.check_user(user)?;
    }
    (tool.handler)(Ctx { st, user, via }, args).await
}

/// How a stored change of this kind is applied.
pub fn applier(kind: &str) -> Option<Apply> {
    all().filter_map(|t| t.stages.as_ref()).find(|s| s.kind == kind).map(|s| s.apply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_name_is_one_tool_and_staging_tools_say_what_they_stage() {
        let mut names = BTreeSet::new();
        for t in all() {
            assert!(names.insert(t.name), "{} is defined twice", t.name);
            for alias in t.aliases {
                assert!(names.insert(*alias), "{alias} names two tools");
            }
            assert_eq!(t.kind == Kind::Stage, t.stages.is_some(), "{}: a staging tool, and only one, says what it stages", t.name);
            assert_eq!(find(t.name).map(|f| f.name), Some(t.name));
        }
        // Every kind a staging tool stores can be applied, and nothing else can.
        for t in all() {
            if let Some(s) = &t.stages {
                assert!(applier(s.kind).is_some(), "{}", s.kind);
            }
        }
        assert!(applier("no_such_kind").is_none());
        assert!(find("no_such_tool").is_none());
    }
}
