//! The per-user bundle (docs/planner-design.md section 5.3): every planner row the pages need,
//! plus card data and market prices for the names the plan mentions.
//!
//! Card names are resolved here, not at import, so a card added to Yama later (the Star Trek
//! decks) resolves without a new import. The cache key (`rev`) covers the plan revision and the
//! latest card import run, so a daily price import or a new card makes phones refetch.
//!
//! Market prices are read from `price_snapshots` and never written. A missing price is `null`
//! with no date, never 0; every price carries its date and source. All SQL here is static, with
//! id lists bound as JSON arrays (`json_each`).

use super::model;
use crate::error::AppResult;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const MARKET_SOURCE: &str = "TCGplayer market via Scryfall, cheapest non-foil";
pub const PRINTING_SOURCE: &str = "TCGplayer market via Scryfall";

/// The cache key: plan revision, the finish time of the latest card or price import, and a tag
/// for the owner. Revisions count per owner, so without the tag two people with one import each
/// would share a key, and a phone that kept the last person's bundle after a sign-out could be
/// told it was still current. `SHAPE` goes up when the bundle gains fields, so saved copies
/// without them are fetched again.
/// 3: installed states read from the owner's decks (`installed.rs`, 2026-10-28).
const SHAPE: u32 = 3;

pub async fn rev(pool: &SqlitePool, owner: &str) -> AppResult<String> {
    let revision: Option<i64> = sqlx::query_scalar("SELECT revision FROM plan_meta WHERE owner_id = ?").bind(owner).fetch_optional(pool).await?;
    let cards_at: Option<String> =
        sqlx::query_scalar("SELECT MAX(finished_at) FROM import_runs WHERE error IS NULL AND finished_at IS NOT NULL").fetch_one(pool).await?;
    // Every live deck's current version and every plan deck's link: a saved list, a switched
    // configuration or a new link changes installed states, so it changes the key.
    let lists: Vec<String> = sqlx::query_scalar(
        "SELECT id || '=' || COALESCE(current_version_id, '') || '/' || COALESCE(parent_id, '') || '/' || name AS line
         FROM decks WHERE owner_id = ? AND archived = 0
         UNION ALL SELECT 'plan:' || key || '=' || COALESCE(deck_id, '') || '/' || name FROM plan_decks WHERE owner_id = ?
         ORDER BY 1",
    )
    .bind(owner)
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let lists = lists.join(";");
    let decks_tag = &crate::util::sha256_hex(&lists)[..8];
    let digits: String = cards_at.unwrap_or_default().chars().filter(char::is_ascii_digit).collect();
    let tag = &crate::util::sha256_hex(owner)[..8];
    Ok(format!("{}-{}-{decks_tag}-{tag}-s{SHAPE}", revision.unwrap_or(0), if digits.is_empty() { "0" } else { digits.as_str() }))
}

fn parse(s: Option<&str>) -> Value {
    s.and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
}

fn parse_or(s: &str, fallback: Value) -> Value {
    serde_json::from_str(s).unwrap_or(fallback)
}

#[derive(sqlx::FromRow)]
struct MetaRow {
    revision: i64,
    head_import_id: Option<String>,
    game_changers: Option<String>,
    library: Option<String>,
    notes: String,
}

impl Default for MetaRow {
    fn default() -> Self {
        Self { revision: 0, head_import_id: None, game_changers: None, library: None, notes: "[]".into() }
    }
}

#[derive(sqlx::FromRow)]
struct ReviewRow {
    swap_key: String,
    decision: Option<String>,
    note: Option<String>,
    cut: Option<String>,
    deck_name: Option<String>,
    card: Option<String>,
    at: String,
    origin: String,
    op_id: Option<String>,
    seq: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct DeckRow {
    id: String,
    key: String,
    name: String,
    source: String,
    status: String,
    product: Option<String>,
    commander: String,
    color_identity: Option<String>,
    owner_changes: String,
    bracket: Option<String>,
    groups: String,
    notes: String,
    deck_id: Option<String>,
    sort: i64,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct StateRow {
    plan_deck_id: String,
    state: String,
    id: String,
    content_hash: String,
    computed_by: String,
    cards: String,
    log: String,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct SwapRow {
    key: String,
    deck: String,
    stage: String,
    role: String,
    parent: Option<String>,
    src: String,
    src_declared: Option<String>,
    store_label: Option<String>,
    out_name: Option<String>,
    in_name: String,
    plan_card: Option<String>,
    later_out: Option<String>,
    after_print: bool,
    tier: Option<String>,
    band: Option<String>,
    sort: i64,
    game_changer: Option<bool>,
    got: Option<String>,
    item_order: Option<String>,
    item_line: Option<i64>,
    print_order: Option<String>,
    listing: Option<String>,
    group_label: Option<String>,
    when_text: Option<String>,
    advice: Option<String>,
    why: Option<String>,
    why_out: Option<String>,
    note: Option<String>,
    upgrade: Option<String>,
    retired_at: Option<String>,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct OrderRow {
    id: String,
    ext_key: String,
    kind: String,
    status: String,
    vendor: String,
    store: Option<String>,
    order_number: Option<String>,
    date_ordered: Option<String>,
    placed_by: Option<String>,
    date_fulfilled: Option<String>,
    fulfillment: Option<String>,
    currency: String,
    subtotal: Option<f64>,
    subtotal_note: Option<String>,
    shipping: Option<f64>,
    tax: Option<f64>,
    total: Option<f64>,
    card_stock: Option<String>,
    evidence: Option<String>,
    issues: String,
    note: Option<String>,
    origin: String,
    retired_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    order_id: String,
    line: i64,
    card_name: String,
    qty: i64,
    listing: Option<String>,
    set_code: Option<String>,
    collector_number: Option<String>,
    finish: Option<String>,
    scryfall_id: Option<String>,
    received_set_code: Option<String>,
    received_collector_number: Option<String>,
    received_note: Option<String>,
    deck_key: Option<String>,
    replaces: Option<String>,
    role: Option<String>,
    unit_price: Option<f64>,
    arrived: Option<bool>,
}

#[derive(sqlx::FromRow, Serialize)]
struct QuoteRow {
    swap: Option<String>,
    card: String,
    kind: String,
    store: Option<String>,
    store_label: Option<String>,
    checked: String,
    result: Option<String>,
    in_stock: Option<bool>,
    price: Option<f64>,
    price_from_text: bool,
    currency: String,
    printing: Option<String>,
    set: Option<String>,
    num: Option<String>,
    printing_from_text: bool,
    scryfall_id: Option<String>,
    variant: Option<String>,
    url: Option<String>,
    source: String,
    origin: String,
}

#[derive(sqlx::FromRow)]
struct CardRow {
    oracle_id: String,
    name: String,
    type_line: String,
    cmc: f64,
    color_identity: String,
    layout: Option<String>,
    image_small: Option<String>,
    image_normal: Option<String>,
    image_art_crop: Option<String>,
    artist: Option<String>,
    faces: Option<String>,
}

#[derive(sqlx::FromRow)]
struct MarketRow {
    oracle_id: String,
    scryfall_id: String,
    set_code: String,
    collector_number: String,
    set_name: String,
    date: String,
    usd: f64,
}

#[derive(sqlx::FromRow)]
struct PrintingPrice {
    scryfall_id: String,
    set_code: String,
    collector_number: String,
    date: Option<String>,
    usd: Option<f64>,
    usd_foil: Option<f64>,
}

/// Names the plan mentions, collected once.
#[derive(Default)]
struct Names(BTreeSet<String>);

impl Names {
    fn add(&mut self, name: Option<&str>) {
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            self.0.insert(n.to_string());
        }
    }
}

/// Printings named by quotes and order items: by id, or by set and number.
#[derive(Default)]
struct Printings {
    ids: BTreeSet<String>,
    pairs: BTreeSet<(String, String)>,
}

impl Printings {
    fn add(&mut self, id: Option<&str>, set: Option<&str>, num: Option<&str>) {
        if let Some(id) = id.filter(|s| !s.trim().is_empty()) {
            self.ids.insert(id.trim().to_string());
        } else if let (Some(s), Some(n)) = (set.filter(|s| !s.trim().is_empty()), num.filter(|n| !n.trim().is_empty())) {
            self.pairs.insert((s.trim().to_lowercase(), n.trim().to_string()));
        }
    }
}

pub async fn load_bundle(pool: &SqlitePool, owner: &str) -> AppResult<Value> {
    let rev = rev(pool, owner).await?;
    let mut names = Names::default();
    let mut printings = Printings::default();

    // Head
    let meta: Option<MetaRow> =
        sqlx::query_as("SELECT revision, head_import_id, game_changers, library, notes FROM plan_meta WHERE owner_id = ?")
            .bind(owner)
            .fetch_optional(pool)
            .await?;
    let MetaRow { revision, head_import_id, game_changers, library, notes: plan_notes } = meta.unwrap_or_default();
    let head = match &head_import_id {
        None => Value::Null,
        Some(id) => {
            #[allow(clippy::type_complexity)]
            let row: Option<(String, String, String, String, bool, String, String)> = sqlx::query_as(
                "SELECT id, imported_at, content_hash, via, forced, meta, report FROM plan_imports WHERE id = ? AND owner_id = ?",
            )
            .bind(id)
            .bind(owner)
            .fetch_optional(pool)
            .await?;
            match row {
                None => Value::Null,
                Some((id, imported_at, content_hash, via, forced, meta, report)) => {
                    let report = parse_or(&report, json!({}));
                    let m = parse_or(&meta, json!({}));
                    json!({
                        "import_id": id, "imported_at": imported_at, "content_hash": content_hash, "via": via, "forced": forced,
                        "app": m.get("app"), "guide_version": m.get("guide_version"), "guide_date": m.get("guide_date"),
                        "git_sha": m.get("git_sha"), "dirty": m.get("dirty"), "generated_at": m.get("generated_at"),
                        "warnings": report.get("warnings").cloned().unwrap_or(json!([])),
                        "export_warnings": report.get("export_warnings").cloned().unwrap_or(json!([])),
                    })
                }
            }
        }
    };

    // Settings and stores
    let settings: Vec<(String, String, Option<String>, String)> =
        sqlx::query_as("SELECT effective_from, rules, note, origin FROM plan_settings WHERE owner_id = ? ORDER BY effective_from")
            .bind(owner)
            .fetch_all(pool)
            .await?;
    let settings: Vec<Value> = settings
        .into_iter()
        .map(|(from, rules, note, origin)| json!({"effective_from": from, "rules": parse_or(&rules, json!({})), "note": note, "origin": origin}))
        .collect();
    #[allow(clippy::type_complexity)]
    let stores: Vec<(String, String, Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64, String, Option<String>)> =
        sqlx::query_as(
            "SELECT key, name, short_name, kind, cart_url_template, homepage, location, note, print_tiers, sort, origin, retired_at
             FROM plan_stores WHERE owner_id = ? ORDER BY sort, key",
        )
        .bind(owner)
        .fetch_all(pool)
        .await?;
    let stores: Vec<Value> = stores
        .into_iter()
        .map(|(key, name, short, kind, cart, homepage, location, note, tiers, sort, origin, retired_at)| {
            json!({
                "key": key, "name": name, "short": short, "kind": kind, "cart_url_template": cart, "homepage": homepage,
                "location": location, "note": note, "print_tiers": parse(tiers.as_deref()), "sort": sort, "origin": origin,
                "retired": retired_at.is_some(), "retired_at": retired_at,
            })
        })
        .collect();

    // Decks and their current lists
    let deck_rows: Vec<DeckRow> = sqlx::query_as(
        "SELECT id, key, name, source, status, product, commander, color_identity, owner_changes, bracket, groups, notes, deck_id,
                sort, updated_at
         FROM plan_decks WHERE owner_id = ? ORDER BY status = 'archived', sort, key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let state_rows: Vec<StateRow> = sqlx::query_as(
        "SELECT plan_deck_id, state, id, content_hash, computed_by, cards, log, updated_at FROM plan_states
         WHERE owner_id = ? AND current = 1",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut states_by_deck: HashMap<String, Vec<(StateRow, Vec<Value>)>> = HashMap::new();
    for s in state_rows {
        let cards: Vec<Value> = serde_json::from_str(&s.cards).unwrap_or_default();
        for c in &cards {
            names.add(c.get("name").and_then(Value::as_str));
        }
        states_by_deck.entry(s.plan_deck_id.clone()).or_default().push((s, cards));
    }
    for d in &deck_rows {
        let commander = parse_or(&d.commander, json!([]));
        for c in commander.as_array().into_iter().flatten() {
            names.add(c.as_str());
        }
        for oc in parse_or(&d.owner_changes, json!([])).as_array().into_iter().flatten() {
            names.add(oc.get("in").and_then(Value::as_str));
            names.add(oc.get("out").and_then(Value::as_str));
        }
        let bracket = parse(d.bracket.as_deref());
        for (_, bag) in model::bracket_bags(Some(&bracket)) {
            names.add(bag.get("in").and_then(Value::as_str));
            names.add(bag.get("out").and_then(Value::as_str));
        }
        for n in model::bracket_extras(Some(&bracket)) {
            names.add(Some(n));
        }
    }

    // Swaps, with their links as keys (owners checked on every SET NULL link)
    let swap_rows: Vec<SwapRow> = sqlx::query_as(
        "SELECT s.ext_key AS key, d.key AS deck, s.stage, s.role, p.ext_key AS parent, s.src, s.src_declared, s.store_label,
                s.out_name, s.in_name, s.plan_card, s.later_out, s.after_print, s.tier, s.band, s.sort, s.game_changer, s.got,
                io.ext_key AS item_order, i.line AS item_line, po.ext_key AS print_order, s.listing, s.group_label, s.when_text,
                s.advice, s.why, s.why_out, s.note, s.upgrade, s.retired_at, s.updated_at
         FROM plan_swaps s
         JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
         LEFT JOIN plan_swaps p ON p.id = s.parent_id AND p.owner_id = s.owner_id
         LEFT JOIN plan_order_items i ON i.id = s.order_item_id AND i.owner_id = s.owner_id
         LEFT JOIN plan_orders io ON io.id = i.order_id AND io.owner_id = s.owner_id
         LEFT JOIN plan_orders po ON po.id = s.print_order_id AND po.owner_id = s.owner_id
         WHERE s.owner_id = ?
         ORDER BY d.sort, d.key, s.stage DESC, s.sort, s.ext_key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    // Installed, from each plan deck's Yama deck (null where there's no deck to read).
    let installs = super::installed::load(pool, owner).await?;
    let swaps: Vec<Value> = swap_rows
        .into_iter()
        .map(|s| {
            for n in [Some(s.in_name.as_str()), s.out_name.as_deref(), s.plan_card.as_deref(), s.later_out.as_deref()] {
                names.add(n);
            }
            let order_item = match (&s.item_order, s.item_line) {
                (Some(o), Some(l)) => json!({"order": o, "line": l}),
                _ => Value::Null,
            };
            json!({
                "key": s.key, "deck": s.deck, "stage": s.stage, "role": s.role, "parent": s.parent, "src": s.src,
                "src_declared": s.src_declared, "store_label": s.store_label, "out": s.out_name, "in": s.in_name,
                "plan_card": s.plan_card, "later_out": s.later_out, "after_print": s.after_print, "tier": s.tier,
                "band": s.band, "group": s.group_label, "sort": s.sort, "game_changer": s.game_changer,
                "got": parse(s.got.as_deref()), "order_item": order_item, "print_order": s.print_order,
                "listing": s.listing, "when": s.when_text, "advice": s.advice, "why": s.why, "why_out": s.why_out,
                "note": s.note, "upgrade": parse(s.upgrade.as_deref()), "deck_installed": installs.swaps.get(&s.key),
                "deck_superseded": installs.superseded.contains_key(&s.key),
                "retired": s.retired_at.is_some(), "retired_at": s.retired_at, "updated_at": s.updated_at,
            })
        })
        .collect();
    let aliases: BTreeMap<String, String> = super::aliases(pool, owner).await?.into_iter().collect();

    // Orders and items
    let order_rows: Vec<OrderRow> = sqlx::query_as(
        "SELECT o.id, o.ext_key, o.kind, o.status, o.vendor, st.key AS store, o.order_number, o.date_ordered, o.placed_by,
                o.date_fulfilled, o.fulfillment, o.currency, o.subtotal, o.subtotal_note, o.shipping, o.tax, o.total,
                o.card_stock, o.evidence, o.issues, o.note, o.origin, o.retired_at
         FROM plan_orders o LEFT JOIN plan_stores st ON st.id = o.store_id AND st.owner_id = o.owner_id
         WHERE o.owner_id = ? ORDER BY COALESCE(o.date_ordered, o.placed_by), o.ext_key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let item_rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT order_id, line, card_name, qty, listing, set_code, collector_number, finish, scryfall_id, received_set_code,
                received_collector_number, received_note, deck_key, replaces, role, unit_price, arrived
         FROM plan_order_items WHERE owner_id = ? ORDER BY order_id, line",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut items_by_order: HashMap<String, Vec<Value>> = HashMap::new();
    for it in item_rows {
        names.add(Some(&it.card_name));
        printings.add(it.scryfall_id.as_deref(), it.set_code.as_deref(), it.collector_number.as_deref());
        printings.add(None, it.received_set_code.as_deref(), it.received_collector_number.as_deref());
        let received = if it.received_set_code.is_some() || it.received_collector_number.is_some() || it.received_note.is_some() {
            json!({"set": it.received_set_code, "num": it.received_collector_number, "note": it.received_note})
        } else {
            Value::Null
        };
        items_by_order.entry(it.order_id.clone()).or_default().push(json!({
            "line": it.line, "card": it.card_name, "qty": it.qty, "listing": it.listing, "set": it.set_code,
            "num": it.collector_number, "finish": it.finish, "scryfall_id": it.scryfall_id, "received": received,
            "arrived": it.arrived, "deck": it.deck_key, "replaces": it.replaces, "role": it.role, "unit_price": it.unit_price,
        }));
    }
    let orders: Vec<Value> = order_rows
        .into_iter()
        .map(|o| {
            json!({
                "key": o.ext_key, "kind": o.kind, "status": o.status, "vendor": o.vendor, "store": o.store,
                "order_number": o.order_number, "date_ordered": o.date_ordered, "placed_by": o.placed_by,
                "date_fulfilled": o.date_fulfilled, "fulfillment": o.fulfillment, "currency": o.currency,
                "subtotal": o.subtotal, "subtotal_note": o.subtotal_note, "shipping": o.shipping, "tax": o.tax,
                "total": o.total, "card_stock": o.card_stock, "evidence": o.evidence,
                "issues": parse_or(&o.issues, json!([])), "note": o.note, "origin": o.origin,
                "retired": o.retired_at.is_some(), "retired_at": o.retired_at,
                "items": items_by_order.remove(&o.id).unwrap_or_default(),
            })
        })
        .collect();

    // Quotes
    let quotes: Vec<QuoteRow> = sqlx::query_as(
        "SELECT s.ext_key AS swap, q.card_name AS card, q.kind, st.key AS store, q.store_label, q.checked_on AS checked, q.result,
                q.in_stock, q.price, q.price_from_text, q.currency, q.printing, q.set_code AS \"set\", q.collector_number AS num,
                q.printing_from_text, q.scryfall_id, q.variant, q.url, q.source, q.origin
         FROM plan_quotes q
         LEFT JOIN plan_swaps s ON s.id = q.swap_id AND s.owner_id = q.owner_id
         LEFT JOIN plan_stores st ON st.id = q.store_id AND st.owner_id = q.owner_id
         WHERE q.owner_id = ? ORDER BY q.card_name, q.kind, q.checked_on, q.rowid",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    for q in &quotes {
        names.add(Some(&q.card));
        printings.add(q.scryfall_id.as_deref(), q.set.as_deref(), q.num.as_deref());
    }

    // Answers, ticks and marks, and what the export side did with inbox items. `seq` is the op
    // that set an answer or mark (null when it came from an import); a page compares it with
    // `pulled_through` to say whether the export side has picked it up.
    let review_rows: Vec<ReviewRow> = sqlx::query_as(
        "SELECT r.swap_key, r.decision, r.note, r.cut, r.deck_name, r.card, r.at, r.origin, r.op_id, i.seq
         FROM plan_reviews r LEFT JOIN plan_inputs i ON i.owner_id = r.owner_id AND i.op_id = r.op_id WHERE r.owner_id = ?",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let reviews: Map<String, Value> = review_rows
        .into_iter()
        .map(|r| {
            (
                r.swap_key,
                json!({"decision": r.decision, "note": r.note, "cut": r.cut, "deck": r.deck_name, "card": r.card, "at": r.at,
                       "origin": r.origin, "op_id": r.op_id, "seq": r.seq}),
            )
        })
        .collect();
    #[allow(clippy::type_complexity)]
    let mark_rows: Vec<(String, String, i64, String, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT m.swap_key, m.kind, m.value, m.payload, m.at, m.op_id, i.seq
         FROM plan_marks m LEFT JOIN plan_inputs i ON i.owner_id = m.owner_id AND i.op_id = m.op_id WHERE m.owner_id = ?",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut marks: Map<String, Value> = Map::new();
    for (key, kind, value, payload, at, op_id, seq) in mark_rows {
        let entry = marks.entry(key).or_insert_with(|| json!({}));
        entry[kind] = json!({"value": value == 1, "at": at, "payload": parse_or(&payload, json!({})), "op_id": op_id, "seq": seq});
    }
    let (pulled_through, pulled_at): (i64, Option<String>) = sqlx::query_as("SELECT pulled_through, pulled_at FROM plan_meta WHERE owner_id = ?")
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .unwrap_or((0, None));
    let pending_pull: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_inputs WHERE owner_id = ? AND for_export = 1 AND status = 'applied' AND seq > ?")
        .bind(owner)
        .bind(pulled_through)
        .fetch_one(pool)
        .await?;
    let outcomes: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT op_id, outcome, outcome_at FROM plan_inputs WHERE owner_id = ? AND outcome IS NOT NULL ORDER BY seq")
            .bind(owner)
            .fetch_all(pool)
            .await?;
    let outcomes: Vec<Value> = outcomes.into_iter().map(|(op_id, outcome, at)| json!({"op_id": op_id, "outcome": outcome, "outcome_at": at})).collect();
    let ideas = super::inputs::ideas(pool, owner).await?;

    // Cards: names resolved now, so cards added to Yama since the import are found.
    let name_list: Vec<String> = names.0.iter().cloned().collect();
    let resolved = super::resolve_names(pool, &name_list).await?;
    let ids: BTreeSet<&String> = resolved.values().collect();
    let ids_json = serde_json::to_string(&ids).map_err(anyhow::Error::from)?;
    let card_rows: Vec<CardRow> = sqlx::query_as(
        "SELECT oracle_id, name, type_line, cmc, color_identity, layout, image_small, image_normal, image_art_crop, artist, faces
         FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(&ids_json)
    .fetch_all(pool)
    .await?;
    let cards: Map<String, Value> = card_rows
        .into_iter()
        .map(|c| {
            let v = json!({
                "name": c.name, "type_line": c.type_line, "cmc": c.cmc, "color_identity": c.color_identity, "layout": c.layout,
                "image_small": c.image_small, "image_art_crop": c.image_art_crop, "faces": parse(c.faces.as_deref()),
                // The full card (Review shows it) and who painted the art crop, for the credit line.
                "image_normal": c.image_normal, "artist": c.artist,
            });
            (c.oracle_id, v)
        })
        .collect();

    // Market: the cheapest non-foil price per card, from printings priced within three days of
    // the card's newest price, so a printing that dropped out of the price data months ago can't
    // pose as today's market. `cur` is materialized once from the id list; inlined twice, SQLite
    // scanned every printing for `fresh` (1.3 s on the real card data, 0.2 s this way).
    //
    // Only real, tournament-legal paper copies count, as in commander-decks' benchmarks (Counterspell
    // is $2.15 for FDC #61 there, not $1.34 for a gold-bordered World Championship Decks copy). The
    // printings table has no border, oversized or set-type column, so the sets that aren't real cards
    // are listed here: World Championship Decks and Pro Tour Collector Set (gold borders), Collectors'
    // Edition and Intl. Collectors' Edition (square corners), 30th Anniversary Edition, and the
    // oversized sets (by name, plus the Legacy and Vintage Championship cards). Planes, schemes and
    // Vanguard cards have their own oracle ids, so they never share a market with a real card.
    let market_rows: Vec<MarketRow> = sqlx::query_as(
        "WITH ids AS (SELECT DISTINCT value AS oracle_id FROM json_each(?1)),
         cur AS MATERIALIZED (
           SELECT p.oracle_id, p.scryfall_id, p.set_code, p.collector_number, p.set_name, ps.date, ps.usd
           FROM ids
           JOIN printings p ON p.oracle_id = ids.oracle_id
            AND p.set_code NOT IN ('wc97', 'wc98', 'wc99', 'wc00', 'wc01', 'wc02', 'wc03', 'wc04', 'ptc',
                                   'ced', 'cei', '30a', 'olgc', 'ovnt')
            AND p.set_name NOT LIKE '%Oversized%' AND p.set_name NOT LIKE '%Display Commanders%'
           JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
            AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
         ),
         fresh AS (SELECT oracle_id, MAX(date) AS newest FROM cur GROUP BY oracle_id),
         ranked AS (
           SELECT cur.*, ROW_NUMBER() OVER (PARTITION BY cur.oracle_id ORDER BY cur.usd, cur.date DESC, cur.scryfall_id) AS rn
           FROM cur JOIN fresh ON fresh.oracle_id = cur.oracle_id
           WHERE cur.usd IS NOT NULL AND cur.date >= date(fresh.newest, '-3 days')
         )
         SELECT oracle_id, scryfall_id, set_code, collector_number, set_name, date, usd FROM ranked WHERE rn = 1",
    )
    .bind(&ids_json)
    .fetch_all(pool)
    .await?;
    let mut prices_as_of: Option<String> = None;
    let mut newest = |d: &str| {
        if prices_as_of.as_deref().is_none_or(|p| d > p) {
            prices_as_of = Some(d.to_string());
        }
    };
    let mut market: Map<String, Value> = ids.iter().map(|id| ((*id).clone(), Value::Null)).collect();
    for m in market_rows {
        newest(&m.date);
        market.insert(
            m.oracle_id,
            json!({
                "usd": m.usd, "printing": format!("{} ({}) #{}", m.set_name, m.set_code.to_uppercase(), m.collector_number),
                "set": m.set_code, "num": m.collector_number, "scryfall_id": m.scryfall_id, "date": m.date, "source": MARKET_SOURCE,
            }),
        );
    }

    // Each named printing's own latest price, for comparing a listing with its printing.
    let pairs: Vec<&(String, String)> = printings.pairs.iter().collect();
    let pair_ids: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT j.key,
           (SELECT p.scryfall_id FROM printings p
            WHERE p.set_code = json_extract(j.value, '$[0]') AND p.collector_number = json_extract(j.value, '$[1]')
            ORDER BY (p.lang = 'en') DESC, p.scryfall_id LIMIT 1)
         FROM json_each(?) j",
    )
    .bind(serde_json::to_string(&pairs).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let mut printing_ids: Map<String, Value> = Map::new();
    let mut all_ids: BTreeSet<String> = printings.ids.clone();
    for (i, id) in pair_ids {
        if let (Some((set, num)), Some(id)) = (pairs.get(i as usize), id) {
            printing_ids.insert(format!("{set}/{num}"), json!(id));
            all_ids.insert(id);
        }
    }
    let printing_rows: Vec<PrintingPrice> = sqlx::query_as(
        "SELECT p.scryfall_id, p.set_code, p.collector_number, ps.date, ps.usd, ps.usd_foil
         FROM printings p
         LEFT JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
          AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
         WHERE p.scryfall_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&all_ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let mut market_by_printing: Map<String, Value> = Map::new();
    for p in printing_rows {
        if let Some(d) = &p.date {
            newest(d);
        }
        printing_ids.entry(format!("{}/{}", p.set_code, p.collector_number)).or_insert_with(|| json!(p.scryfall_id));
        market_by_printing.insert(
            p.scryfall_id,
            json!({"usd": p.usd, "usd_foil": p.usd_foil, "date": p.date, "set": p.set_code, "num": p.collector_number, "source": PRINTING_SOURCE}),
        );
    }

    // Decks last: each list says which of its names Yama doesn't know yet.
    let decks: Vec<Value> = deck_rows
        .into_iter()
        .map(|d| {
            let mut states = Map::new();
            for (s, cards) in states_by_deck.remove(&d.id).unwrap_or_default() {
                let mut unresolved: Vec<String> = Vec::new();
                for c in &cards {
                    if let Some(n) = c.get("name").and_then(Value::as_str).map(str::trim)
                        && !resolved.contains_key(n)
                        && !unresolved.iter().any(|u| u == n)
                    {
                        unresolved.push(n.to_string());
                    }
                }
                states.insert(
                    s.state.clone(),
                    json!({
                        "id": s.id, "content_hash": s.content_hash, "computed_by": s.computed_by, "updated_at": s.updated_at,
                        "cards": cards, "log": parse_or(&s.log, json!([])), "unresolved": unresolved,
                    }),
                );
            }
            json!({
                "key": d.key, "name": d.name, "source": d.source, "status": d.status, "product": d.product,
                "commander": parse_or(&d.commander, json!([])), "color_identity": d.color_identity,
                "owner_changes": parse_or(&d.owner_changes, json!([])), "bracket": parse(d.bracket.as_deref()),
                "groups": parse_or(&d.groups, json!([])), "notes": parse_or(&d.notes, json!([])), "deck_id": d.deck_id,
                "yama_deck": installs.decks.get(&d.id),
                "sort": d.sort, "updated_at": d.updated_at, "states": states,
            })
        })
        .collect();
    let unresolved: Vec<&String> = names.0.iter().filter(|n| !resolved.contains_key(*n)).collect();
    let names_map: BTreeMap<&String, &String> = resolved.iter().collect();

    Ok(json!({
        "rev": rev, "revision": revision, "head": head,
        "notes": parse_or(&plan_notes, json!([])), "game_changers": parse(game_changers.as_deref()), "library": parse(library.as_deref()),
        "settings": settings, "stores": stores, "decks": decks, "swaps": swaps, "aliases": aliases,
        "orders": orders, "quotes": quotes, "reviews": reviews, "marks": marks,
        "inputs": {"pending_pull": pending_pull, "pulled_through": pulled_through, "pulled_at": pulled_at, "outcomes": outcomes, "ideas": ideas},
        "names": names_map, "unresolved": unresolved, "cards": cards,
        "market": market, "market_by_printing": market_by_printing, "printing_ids": printing_ids,
        "prices_as_of": prices_as_of,
    }))
}
