//! Sections: a container inside another (Bryan, 2026-11-15: one big box with dividers, some with
//! sub-dividers). `containers.parent_id` is the container a section sits in; NULL is top level.
//!
//! - Names are unique among siblings (same owner, kind and parent), so "Plains" can be a section
//!   of two boxes. A path names one container: "Big box/Bulk Basic/Plains" (or with " › ").
//! - A container can't sit inside itself or one of its own sections, and nesting stops at
//!   [`MAX_DEPTH`] levels.
//! - A container that still has sections can't be deleted; move or delete them first.
//! - Cards stay in the container they were filed in. Counts and values roll up to the parents
//!   (`collection::containers_for`).

use crate::error::{AppError, AppResult};
use sqlx::SqliteConnection;
use std::collections::HashMap;

/// The most levels from a top-level box down to its deepest section: a box, a section and a
/// sub-section are three. Kept small so a path stays readable and walking up never runs long.
pub const MAX_DEPTH: usize = 8;

/// How a path is shown: "Big box › Bulk Basic › Plains".
pub const SHOWN: &str = " › ";

/// One container, as far as the tree needs it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Node {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
}

/// Every container the owner has, in no order.
pub async fn nodes(conn: &mut SqliteConnection, owner: &str) -> AppResult<Vec<Node>> {
    Ok(sqlx::query_as("SELECT id, kind, name, parent_id FROM containers WHERE owner_id = ?").bind(owner).fetch_all(conn).await?)
}

/// The owner's containers indexed for walking up and down.
pub struct Tree {
    pub nodes: Vec<Node>,
    by_id: HashMap<String, usize>,
    children: HashMap<Option<String>, Vec<usize>>,
}

impl Tree {
    pub fn new(nodes: Vec<Node>) -> Tree {
        let by_id = nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
        let mut children: HashMap<Option<String>, Vec<usize>> = HashMap::new();
        for (i, n) in nodes.iter().enumerate() {
            children.entry(n.parent_id.clone()).or_default().push(i);
        }
        // Siblings by name (then kind, then id, so the order is stable).
        for list in children.values_mut() {
            list.sort_by(|&a, &b| {
                let (a, b) = (&nodes[a], &nodes[b]);
                a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.kind.cmp(&b.kind)).then_with(|| a.id.cmp(&b.id))
            });
        }
        Tree { nodes, by_id, children }
    }

    pub async fn load(conn: &mut SqliteConnection, owner: &str) -> AppResult<Tree> {
        Ok(Tree::new(nodes(conn, owner).await?))
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.by_id.get(id).map(|&i| &self.nodes[i])
    }

    /// The container's own sections, by name.
    pub fn children(&self, id: Option<&str>) -> impl Iterator<Item = &Node> {
        self.children.get(&id.map(String::from)).into_iter().flatten().map(|&i| &self.nodes[i])
    }

    /// From the top-level container down to this one (ids). A parent that isn't there (it
    /// shouldn't happen) ends the walk; so does a loop, which the writes below never make.
    pub fn ancestry(&self, id: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        let mut at = self.get(id);
        while let Some(n) = at {
            if out.len() > MAX_DEPTH * 2 || out.iter().any(|o: &&Node| o.id == n.id) {
                break;
            }
            out.push(n);
            at = n.parent_id.as_deref().and_then(|p| self.get(p));
        }
        out.reverse();
        out
    }

    /// Names from the top-level container down to this one.
    pub fn path(&self, id: &str) -> Vec<String> {
        self.ancestry(id).into_iter().map(|n| n.name.clone()).collect()
    }

    /// The path as shown: "Big box › Bulk Basic › Plains".
    pub fn shown(&self, id: &str) -> String {
        self.path(id).join(SHOWN)
    }

    /// How many levels down: 0 for a top-level container.
    pub fn depth(&self, id: &str) -> usize {
        self.ancestry(id).len().saturating_sub(1)
    }

    /// This container and every section under it, depth first.
    pub fn subtree(&self, id: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        if let Some(n) = self.get(id) {
            self.walk(n, 0, &mut out);
        }
        out
    }

    fn walk<'a>(&'a self, n: &'a Node, level: usize, out: &mut Vec<&'a Node>) {
        if level > MAX_DEPTH * 2 || out.iter().any(|o| o.id == n.id) {
            return;
        }
        out.push(n);
        for c in self.children(Some(&n.id)) {
            self.walk(c, level + 1, out);
        }
    }

    /// How many levels the container's subtree has: 1 for one with no sections.
    pub fn height(&self, id: &str) -> usize {
        let base = self.depth(id);
        self.subtree(id).iter().map(|n| self.depth(&n.id) - base + 1).max().unwrap_or(1)
    }

    /// Every container in tree order: top-level ones by kind then name, each followed by its
    /// sections. Containers whose parent is missing come last (shouldn't happen).
    pub fn ordered(&self) -> Vec<&Node> {
        let mut roots: Vec<&Node> = self.children(None).collect();
        roots.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
        let mut out = Vec::new();
        for r in roots {
            self.walk(r, 0, &mut out);
        }
        for n in &self.nodes {
            if !out.iter().any(|o| o.id == n.id) {
                out.push(n);
            }
        }
        out
    }
}

/// The parts of a path someone typed: split on "/" and "›" (either way of writing it), trimmed,
/// blanks dropped. "Big box › Bulk Basic/Plains" is three parts.
pub fn parts(path: &str) -> Vec<String> {
    path.split(['/', '›']).map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect()
}

/// Containers a typed name or path names, matched ignoring case: the id itself; a container whose
/// whole name is the text (names may hold "/"); or a path from a top-level container down (a
/// name that holds "/" can be a step too). A path's first step may also start lower down, so
/// "Bulk Basic/Plains" finds "Big box › Bulk Basic › Plains" when that's the only one.
pub fn find<'a>(tree: &'a Tree, wanted: &str) -> Vec<&'a Node> {
    let wanted = wanted.trim();
    if let Some(n) = tree.get(wanted) {
        return vec![n];
    }
    let mut whole: Vec<&Node> = tree.nodes.iter().filter(|n| n.name.eq_ignore_ascii_case(wanted)).collect();
    // Several with that name: the one written exactly so ("Plains", not "plains"), then the one at
    // the top level (a section is named by its path).
    let rules: [fn(&&Node, &str) -> bool; 2] = [|n, w| n.name == w, |n, _| n.parent_id.is_none()];
    for narrower in rules {
        let fewer: Vec<&Node> = whole.iter().copied().filter(|n| narrower(n, wanted)).collect();
        if whole.len() > 1 && !fewer.is_empty() {
            whole = fewer;
        }
    }
    if !whole.is_empty() {
        return whole;
    }
    let steps = parts(wanted);
    if steps.len() < 2 {
        return Vec::new();
    }
    // Every container could be the first step; keep those the rest of the path leads down from.
    let mut found: Vec<&Node> = Vec::new();
    for start in &tree.nodes {
        descend(tree, start, &steps, &mut found);
    }
    // A path from the top wins over one that starts lower down.
    let from_top: Vec<&Node> = found.iter().copied().filter(|n| tree.ancestry(&n.id).first().is_some_and(|top| path_starts(top, &steps))).collect();
    let mut out = if from_top.is_empty() { found } else { from_top };
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// Whether `steps` begin with the name of `top` (one step, or several joined by "/").
fn path_starts(top: &Node, steps: &[String]) -> bool {
    (1..=steps.len()).any(|k| steps[..k].join("/").eq_ignore_ascii_case(&top.name))
}

/// Whether `at` is the first step of `steps` and the rest lead down from it; each container they
/// end on goes in `out`.
fn descend<'a>(tree: &'a Tree, at: &'a Node, steps: &[String], out: &mut Vec<&'a Node>) {
    for k in 1..=steps.len() {
        if !steps[..k].join("/").eq_ignore_ascii_case(&at.name) {
            continue;
        }
        let rest = &steps[k..];
        if rest.is_empty() {
            out.push(at);
            continue;
        }
        for child in tree.children(Some(&at.id)) {
            descend(tree, child, rest, out);
        }
    }
}

/// Whether `parent` can hold `id` (moving `id`, with its sections, under it): not itself, not one
/// of its own sections, and the result no deeper than [`MAX_DEPTH`]. `id` is None for a container
/// that doesn't exist yet.
pub fn check_parent(tree: &Tree, id: Option<&str>, parent: &str) -> AppResult<()> {
    let p = tree.get(parent).ok_or(AppError::NotFound("container"))?;
    if let Some(id) = id {
        if tree.ancestry(&p.id).iter().any(|a| a.id == id) {
            return Err(AppError::bad(if p.id == id {
                "A container can't go inside itself.".to_string()
            } else {
                format!("{} is one of its own sections, so it can't go there.", tree.shown(&p.id))
            }));
        }
    }
    let height = id.map(|i| tree.height(i)).unwrap_or(1);
    if tree.depth(&p.id) + 1 + height > MAX_DEPTH {
        return Err(AppError::bad(format!("Sections go at most {MAX_DEPTH} levels deep; {} is too far down for that.", tree.shown(&p.id))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, name: &str, parent: Option<&str>) -> Node {
        Node { id: id.into(), kind: "box".into(), name: name.into(), parent_id: parent.map(String::from) }
    }

    fn tree() -> Tree {
        Tree::new(vec![
            node("big", "Big box", None),
            node("bb", "Bulk Basic", Some("big")),
            node("pl", "Plains", Some("bb")),
            node("is", "Island", Some("bb")),
            node("other", "Deck spares", None),
            node("pl2", "Plains", Some("other")),
            node("wu", "W/U", Some("big")),
            node("wu1", "Fliers", Some("wu")),
        ])
    }

    #[test]
    fn paths_depth_and_order() {
        let t = tree();
        assert_eq!(t.shown("pl"), "Big box › Bulk Basic › Plains");
        assert_eq!(t.depth("pl"), 2);
        assert_eq!(t.depth("big"), 0);
        assert_eq!(t.height("big"), 3);
        assert_eq!(t.height("pl"), 1);
        let order: Vec<&str> = t.ordered().iter().map(|n| n.id.as_str()).collect();
        assert_eq!(order, ["big", "bb", "is", "pl", "wu", "wu1", "other", "pl2"]);
        let sub: Vec<&str> = t.subtree("bb").iter().map(|n| n.id.as_str()).collect();
        assert_eq!(sub, ["bb", "is", "pl"]);
    }

    #[test]
    fn a_path_or_a_unique_name_finds_one_container() {
        let t = tree();
        let ids = |w: &str| find(&t, w).iter().map(|n| n.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("Big box/Bulk Basic/Plains"), ["pl"]);
        assert_eq!(ids("big box › bulk basic › plains"), ["pl"]);
        assert_eq!(ids("Bulk Basic/Plains"), ["pl"], "a path can start lower down");
        assert_eq!(ids("Island"), ["is"]);
        assert_eq!(ids("Plains").len(), 2, "a name two sections share is ambiguous");
        let mut more = tree().nodes;
        more.push(node("top-bb", "Bulk Basic", None));
        more.push(node("lower", "plains", Some("other")));
        let t2 = Tree::new(more);
        let ids2 = |w: &str| find(&t2, w).iter().map(|n| n.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids2("Bulk Basic"), ["top-bb"], "the top-level one; the section has a path");
        assert_eq!(ids2("Big box/Bulk Basic"), ["bb"]);
        assert_eq!(ids2("plains"), ["lower"], "written exactly so");
        assert_eq!(ids("Deck spares/Plains"), ["pl2"]);
        // A name with a slash in it: whole, or as a step.
        assert_eq!(ids("W/U"), ["wu"]);
        assert_eq!(ids("Big box/W/U/Fliers"), ["wu1"]);
        assert_eq!(ids("pl2"), ["pl2"], "an id");
        assert!(ids("Big box/Nowhere").is_empty());
    }

    #[test]
    fn no_loops_and_no_deeper_than_the_limit() {
        let t = tree();
        assert!(check_parent(&t, Some("big"), "big").is_err(), "itself");
        assert!(check_parent(&t, Some("big"), "pl").is_err(), "one of its own sections");
        assert!(check_parent(&t, Some("pl"), "other").is_ok());
        assert!(check_parent(&t, None, "pl").is_ok());
        assert!(matches!(check_parent(&t, None, "nope"), Err(AppError::NotFound(_))));
        // A chain MAX_DEPTH long can't take one more level.
        let mut nodes = vec![node("0", "L0", None)];
        for i in 1..MAX_DEPTH {
            nodes.push(node(&i.to_string(), &format!("L{i}"), Some(&(i - 1).to_string())));
        }
        nodes.push(node("x", "X", None));
        nodes.push(node("y", "Y", Some("x")));
        let deep = Tree::new(nodes);
        let last = (MAX_DEPTH - 1).to_string();
        assert!(check_parent(&deep, None, &last).is_err());
        assert!(check_parent(&deep, None, &(MAX_DEPTH - 2).to_string()).is_ok());
        assert!(check_parent(&deep, Some("x"), &(MAX_DEPTH - 2).to_string()).is_err(), "x brings a section with it");
    }

    async fn printing(pool: &sqlx::SqlitePool, id: &str, name: &str, usd: f64) {
        sqlx::query("INSERT OR IGNORE INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES (?, ?, 'Artifact', '', '{}', 'now')")
            .bind(format!("o-{id}")).bind(name).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?, ?, ?, 'tst', 'Test Set', ?, 'en', 'now')")
            .bind(id).bind(format!("o-{id}")).bind(name).bind(id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES (?, '2026-11-15', ?)").bind(id).bind(usd).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn sections_nest_roll_up_move_and_keep_names_unique_among_siblings() {
        use crate::testutil::{app, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::{Value, json};
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "collector@example.com").await;
        let (_, other) = user(&pool, "other@example.com").await;
        let make = |body: Value| send(&app, Method::POST, "/api/containers", Some(&token), Some(body));
        let id = |v: (StatusCode, Value)| {
            assert_eq!(v.0, StatusCode::OK, "{v:?}");
            v.1["id"].as_str().unwrap().to_string()
        };
        let big = id(make(json!({"kind": "box", "name": "Big box"})).await);
        let basic = id(make(json!({"name": "Bulk Basic", "parent_id": big})).await);
        let plains = id(make(json!({"name": "Plains", "parent_id": basic})).await);
        let spares = id(make(json!({"kind": "box", "name": "Deck spares"})).await);
        // The same name in another box is fine; in the same one it is the one already there.
        let plains2 = id(make(json!({"name": "Plains", "parent_id": spares})).await);
        assert_ne!(plains, plains2);
        assert_eq!(id(make(json!({"name": "Plains", "parent_id": basic})).await), plains);
        // A section can't go in someone else's box, and a kind is needed at the top level.
        assert_eq!(send(&app, Method::POST, "/api/containers", Some(&other), Some(json!({"name": "X", "parent_id": big}))).await.0, StatusCode::NOT_FOUND);
        assert_eq!(make(json!({"name": "No kind"})).await.0, StatusCode::BAD_REQUEST);
        let kind: String = sqlx::query_scalar("SELECT kind FROM containers WHERE id = ?").bind(&plains).fetch_one(&pool).await.unwrap();
        assert_eq!(kind, "box", "a section takes its parent's kind");
        let deck_box = id(make(json!({"kind": "deck", "name": "Riders"})).await);
        let bag = id(make(json!({"name": "Swap bag", "parent_id": deck_box})).await);
        let kind: String = sqlx::query_scalar("SELECT kind FROM containers WHERE id = ?").bind(&bag).fetch_one(&pool).await.unwrap();
        assert_eq!(kind, "box", "a section of a deck box is a box, not another deck");
        for gone in [bag, deck_box] {
            assert_eq!(send(&app, Method::DELETE, &format!("/api/containers/{gone}"), Some(&token), None).await.0, StatusCode::OK);
        }

        // Cards in a section count in it and roll up to every box above it.
        printing(&pool, "p1", "Plains", 0.10).await;
        printing(&pool, "p2", "Sol Ring", 2.00).await;
        let add = |op_id: &str, sid: &str, qty: i64, container: &str| {
            json!({"op_id": op_id, "kind": "add", "scryfall_id": sid, "qty": qty, "container_id": container})
        };
        let ops = json!([add("a1", "p1", 10, &plains), add("a2", "p2", 1, &basic), add("a3", "p2", 2, &big)]);
        assert_eq!(send(&app, Method::POST, "/api/collection/ops", Some(&token), Some(ops)).await.0, StatusCode::OK);
        let (_, list) = send(&app, Method::GET, "/api/containers", Some(&token), None).await;
        let rows = list.as_array().unwrap();
        let order: Vec<&str> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(order, ["Big box", "Bulk Basic", "Plains", "Deck spares", "Plains"], "tree order");
        let row = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap().clone();
        assert_eq!(row(&plains)["path"], json!(["Big box", "Bulk Basic", "Plains"]));
        assert_eq!((row(&plains)["depth"].as_i64(), row(&big)["sections"].as_i64()), (Some(2), Some(1)));
        assert_eq!(row(&big)["parent_id"], Value::Null);
        assert_eq!(row(&basic)["parent_id"], json!(big));
        assert_eq!((row(&big)["copies"].as_i64(), row(&big)["total_copies"].as_i64()), (Some(2), Some(13)));
        assert_eq!((row(&basic)["copies"].as_i64(), row(&basic)["total_copies"].as_i64()), (Some(1), Some(11)));
        assert_eq!(row(&big)["market_value_usd"].as_f64(), Some(4.0));
        assert_eq!(row(&big)["total_market_value_usd"].as_f64(), Some(7.0));
        // A box's cards, with or without its sections'.
        let cards = |q: String| {
            let (app, token) = (app.clone(), token.clone());
            async move { send(&app, Method::GET, &q, Some(&token), None).await.1.as_array().unwrap().iter().map(|i| i["qty"].as_i64().unwrap()).sum::<i64>() }
        };
        assert_eq!(cards(format!("/api/collection?container={big}")).await, 2);
        assert_eq!(cards(format!("/api/collection?container={big}&sections=1")).await, 13);
        assert_eq!(cards(format!("/api/collection?container={basic}&sections=1")).await, 11);
        assert_eq!(send(&app, Method::GET, &format!("/api/collection?container={big}&sections=1"), Some(&other), None).await.1, json!([]), "someone else's box lists nothing");

        let edit = |id: &str, body: Value| {
            let (app, token, path) = (app.clone(), token.clone(), format!("/api/containers/{id}"));
            async move { send(&app, Method::PATCH, &path, Some(&token), Some(body)).await.0 }
        };
        // No loops: not into itself, not into one of its own sections.
        assert_eq!(edit(&big, json!({"parent_id": big})).await, StatusCode::BAD_REQUEST);
        assert_eq!(edit(&big, json!({"parent_id": plains})).await, StatusCode::BAD_REQUEST);
        // Moving Plains next to the other Plains clashes; renamed on the way, it doesn't.
        assert_eq!(edit(&plains, json!({"parent_id": spares})).await, StatusCode::CONFLICT);
        assert_eq!(edit(&plains, json!({"parent_id": spares, "name": "Plains (old)"})).await, StatusCode::OK);
        assert_eq!(edit(&plains, json!({"name": "Plains"})).await, StatusCode::CONFLICT, "a sibling has the name now");
        // To the top level (null), and a rename alone leaves it where it is.
        assert_eq!(edit(&basic, json!({"parent_id": null})).await, StatusCode::OK);
        assert_eq!(edit(&basic, json!({"name": "Basics"})).await, StatusCode::OK);
        let (name, parent): (String, Option<String>) = sqlx::query_as("SELECT name, parent_id FROM containers WHERE id = ?").bind(&basic).fetch_one(&pool).await.unwrap();
        assert_eq!((name.as_str(), parent), ("Basics", None));
        assert_eq!(send(&app, Method::PATCH, &format!("/api/containers/{spares}"), Some(&other), Some(json!({"parent_id": null}))).await.0, StatusCode::NOT_FOUND);
        assert_eq!(edit(&spares, json!({"parent_id": "nope"})).await, StatusCode::NOT_FOUND);

        // A box with sections can't be deleted; once they're gone, it can, and its cards stay.
        let delete = |id: &str| {
            let (app, token, path) = (app.clone(), token.clone(), format!("/api/containers/{id}"));
            async move { send(&app, Method::DELETE, &path, Some(&token), None).await }
        };
        let (status, body) = delete(&spares).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
        assert_eq!(delete(&plains).await.0, StatusCode::OK);
        let in_spares: i64 = sqlx::query_scalar("SELECT SUM(qty) FROM collection_items WHERE owner_id = ? AND container_id = ?").bind(&owner).bind(&spares).fetch_one(&pool).await.unwrap();
        assert_eq!(in_spares, 10, "a deleted section's cards go into the box it was in");
        assert_eq!(delete(&plains2).await.0, StatusCode::OK);
        assert_eq!(delete(&spares).await.0, StatusCode::OK);
        let loose: i64 = sqlx::query_scalar("SELECT SUM(qty) FROM collection_items WHERE owner_id = ? AND container_id IS NULL").bind(&owner).fetch_one(&pool).await.unwrap();
        assert_eq!(loose, 10, "a deleted top-level box's cards are unfiled, not lost");

        // An import naming a box that was moved into another finds it there.
        let (_, list) = send(&app, Method::GET, "/api/containers", Some(&token), None).await;
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(edit(&basic, json!({"parent_id": big})).await, StatusCode::OK);
        assert_eq!(crate::collection::ensure_container(&pool, &owner, "box", "Basics").await.unwrap(), basic);
    }

    #[tokio::test]
    async fn the_migration_keeps_every_container_and_every_card_filed() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use std::str::FromStr;
        let opts = SqliteConnectOptions::from_str("sqlite::memory:").unwrap().foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
        let mut before = sqlx::migrate!("./migrations");
        before.migrations = std::borrow::Cow::Owned(before.migrations.iter().filter(|m| m.version < 98).cloned().collect());
        before.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@b.c', 'A', 'now')").execute(&pool).await.unwrap();
        for (id, kind, name) in [("c1", "box", "Bulk"), ("c2", "binder", "Bulk"), ("c3", "deck", "Riders")] {
            sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?, 'u1', ?, ?, 'then')").bind(id).bind(kind).bind(name).execute(&pool).await.unwrap();
        }
        for (id, container) in [("i1", Some("c1")), ("i2", Some("c3")), ("i3", None)] {
            sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, container_id, created_at, updated_at) VALUES (?, 'u1', ?, 2, ?, 'then', 'then')")
                .bind(id).bind(format!("s-{id}")).bind(container).execute(&pool).await.unwrap();
        }
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let filed: Vec<(String, Option<String>)> = sqlx::query_as("SELECT id, container_id FROM collection_items ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(filed, [("i1".into(), Some("c1".into())), ("i2".into(), Some("c3".into())), ("i3".into(), None)]);
        let kept: Vec<(String, String, String, String, Option<String>)> =
            sqlx::query_as("SELECT id, kind, name, created_at, parent_id FROM containers ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(kept.len(), 3);
        assert!(kept.iter().all(|c| c.3 == "then" && c.4.is_none()), "{kept:?}");
        // Foreign keys are back on, and still point at the rebuilt table.
        let on: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&pool).await.unwrap();
        assert_eq!(on, 1);
        let broken: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check").fetch_all(&pool).await.unwrap();
        assert!(broken.is_empty(), "{broken:?}");
        sqlx::query("DELETE FROM containers WHERE id = 'c1'").execute(&pool).await.unwrap();
        let unfiled: Option<String> = sqlx::query_scalar("SELECT container_id FROM collection_items WHERE id = 'i1'").fetch_one(&pool).await.unwrap();
        assert_eq!(unfiled, None, "deleting a container still unfiles its cards");
        // Sibling names: the same name under another parent is fine, under the same one it isn't.
        let add = |id: &'static str, name: &'static str, parent: Option<&'static str>| {
            sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at, parent_id) VALUES (?, 'u1', 'box', ?, 'now', ?)").bind(id).bind(name).bind(parent)
        };
        add("s1", "Plains", Some("c3")).execute(&pool).await.unwrap();
        add("s2", "Plains", None).execute(&pool).await.unwrap();
        assert!(add("s3", "Plains", Some("c3")).execute(&pool).await.is_err());
        assert!(add("s4", "Bulk", Some("nope")).execute(&pool).await.is_err(), "a parent that isn't there");
        assert!(sqlx::query("DELETE FROM containers WHERE id = 'c3'").execute(&pool).await.is_err(), "a container with sections");
    }
}

