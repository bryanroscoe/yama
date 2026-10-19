//! Planner slice 4: inputs, the inbox and script keys, through the real router on an in-memory
//! database. The fixture is synthetic; Bryan's plan data stays out of this repo.

use super::inputs;
use crate::testutil::{app, send, user};
use crate::util::{now, sha256_hex};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

const P1: &str = "alpha-p1";
const P2: &str = "alpha-p2";
const PLANNED: &str = "plan|Alpha Deck|New Card|Old Card";

fn list() -> Value {
    json!([{"name": "Test Commander", "qty": 1, "board": "commander"}, {"name": "Forest", "qty": 99, "board": "main"}])
}

/// One imported deck with a planned swap and two proposals, one store, and the given reviews.
fn doc(reviews: Value) -> Value {
    json!({
        "format": "yama-plan/1",
        "meta": {"app": "commander-decks", "guide_version": 6, "git_sha": "abc1234"},
        "plan": {
            "stores": [{"key": "shop", "name": "Example Games", "kind": "local"}],
            "decks": [{"key": "alpha", "name": "Alpha Deck", "commander": ["Test Commander"],
                       "states": {"stock": {"cards": list()}, "now": {"cards": list()}, "after": {"cards": list()}}}],
            "swaps": [
                {"key": PLANNED, "deck": "alpha", "stage": "planned", "role": "swap", "src": "owned", "out": "Old Card", "in": "New Card",
                 "got": {"how": "pulled", "product": "A pack"}},
                {"key": P1, "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": "Forest", "in": "Proposal One"},
                {"key": P2, "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy", "out": null, "in": "Proposal Two"}
            ],
            "reviews": reviews
        }
    })
}

async fn import(app: &Router, token: &str, d: &Value) -> Value {
    let (status, report) = post_raw(app, Some(token), "/api/plan/import", d.to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    report
}

async fn post_raw(app: &Router, token: Option<&str>, path: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(Method::POST).uri(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let res = app.clone().oneshot(req.body(Body::from(body)).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn setup() -> (Router, SqlitePool, String, String) {
    let (app, pool) = app().await;
    let (id, token) = user(&pool, "bryan@example.com").await;
    import(&app, &token, &doc(json!({}))).await;
    (app, pool, id, token)
}

async fn ops(app: &Router, token: &str, ops: Value) -> Value {
    let (status, body) = send(app, Method::POST, "/api/plan/inputs", Some(token), Some(ops)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn review(op_id: &str, key: &str, decision: Option<&str>, note: Option<&str>, cut: Option<&str>, at: &str) -> Value {
    json!({"op_id": op_id, "device_id": "phone", "kind": "review", "at": at, "swap_key": key, "deck_key": "alpha",
           "decision": decision, "note": note, "cut": cut})
}

/// (decision, note, cut, at, origin) of the stored answer.
async fn answer(pool: &SqlitePool, owner: &str, key: &str) -> Option<(Option<String>, Option<String>, Option<String>, String, String)> {
    sqlx::query_as("SELECT decision, note, cut, at, origin FROM plan_reviews WHERE owner_id = ? AND swap_key = ?")
        .bind(owner)
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn revision(pool: &SqlitePool, owner: &str) -> i64 {
    sqlx::query_scalar("SELECT revision FROM plan_meta WHERE owner_id = ?").bind(owner).fetch_one(pool).await.unwrap()
}

async fn make_key(app: &Router, session: &str, name: &str) -> (String, String) {
    let (status, body) = send(app, Method::POST, "/api/me/tokens", Some(session), Some(json!({"name": name}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (body["id"].as_str().unwrap().to_string(), body["token"].as_str().unwrap().to_string())
}

// ── inputs ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_duplicate_op_id_is_answered_duplicate_and_writes_nothing() {
    let (app, pool, id, token) = setup().await;
    let op = review("op-1", P1, Some("want"), None, None, "2026-10-19T01:00:00Z");
    let first = ops(&app, &token, json!([op.clone()])).await;
    assert_eq!(first["results"][0]["status"], "applied");
    let seq = first["results"][0]["seq"].as_i64().unwrap();
    let rev = revision(&pool, &id).await;
    assert_eq!(first["revision"], rev);

    // The same op again (a retry after a lost reply), even with other content, changes nothing.
    let mut changed = op.clone();
    changed["decision"] = json!("no");
    let again = ops(&app, &token, json!([op, changed])).await;
    for r in again["results"].as_array().unwrap() {
        assert_eq!((r["status"].as_str(), r["original"].as_str(), r["seq"].as_i64()), (Some("duplicate"), Some("applied"), Some(seq)));
    }
    assert_eq!(answer(&pool, &id, P1).await.unwrap().0.as_deref(), Some("want"));
    assert_eq!(revision(&pool, &id).await, rev, "a batch of duplicates doesn't bump the revision");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_inputs").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn a_bad_op_is_rejected_while_the_rest_apply_and_a_retry_gets_the_same_rejection() {
    let (app, pool, id, token) = setup().await;
    let batch = json!([
        review("ok-1", P1, Some("want"), None, None, "2026-10-19T01:00:00Z"),
        {"op_id": "bad-1", "kind": "review", "at": "2026-10-19T01:00:00Z", "swap_key": P2, "decision": "maybe"},
        {"op_id": "bad-2", "kind": "dance", "at": "2026-10-19T01:00:00Z"},
        {"op_id": "bad-3", "kind": "review", "swap_key": P2, "decision": "no", "at": "yesterday"},
        {"op_id": "bad-4", "kind": "bought", "at": "2026-10-19T01:00:00Z", "swap_key": P1, "value": true, "on": "2026-10-19", "price_paid": -1},
        {"op_id": "bad-5", "kind": "bought", "at": "2026-10-19T01:00:00Z", "swap_key": P1, "value": true, "on": "2026-10-19", "store_key": "nowhere"},
        {"op_id": "bad-6", "kind": "review", "at": "2026-10-19T01:00:00Z", "swap_key": P2, "note": "x".repeat(2001)},
        {"kind": "review", "at": "2026-10-19T01:00:00Z", "swap_key": P2},
        "not an object",
        {"op_id": "ok-2", "kind": "installed", "at": "2026-10-19T01:00:00Z", "swap_key": PLANNED, "value": true}
    ]);
    let r = ops(&app, &token, batch.clone()).await;
    let statuses: Vec<&str> = r["results"].as_array().unwrap().iter().map(|x| x["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["applied", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "applied"]);
    let errors: Vec<String> = r["results"].as_array().unwrap().iter().map(|x| x["error"].as_str().unwrap_or("").to_string()).collect();
    assert!(errors[1].starts_with("decision:"), "{}", errors[1]);
    assert!(errors[2].starts_with("kind:"), "{}", errors[2]);
    assert!(errors[3].starts_with("at:"), "{}", errors[3]);
    assert!(errors[4].starts_with("price_paid:"), "{}", errors[4]);
    assert!(errors[5].starts_with("store_key:"), "{}", errors[5]);
    assert!(errors[6].starts_with("note:"), "{}", errors[6]);
    assert!(errors[7].starts_with("op_id:"), "{}", errors[7]);
    assert!(r["results"][7]["op_id"].is_null() && r["results"][7]["seq"].is_null(), "an op with no id isn't stored");
    assert!(errors[8].starts_with("op_id:"), "{}", errors[8]);

    // Both good ops landed; the bad ones wrote nothing but their own record.
    assert_eq!(answer(&pool, &id, P1).await.unwrap().0.as_deref(), Some("want"));
    assert!(answer(&pool, &id, P2).await.is_none());
    let marks: Vec<(String, String, i64)> = sqlx::query_as("SELECT swap_key, kind, value FROM plan_marks").fetch_all(&pool).await.unwrap();
    assert_eq!(marks, vec![(PLANNED.to_string(), "installed".to_string(), 1)]);
    let stored: Vec<(String, String, bool)> =
        sqlx::query_as("SELECT op_id, status, for_export FROM plan_inputs ORDER BY seq").fetch_all(&pool).await.unwrap();
    assert_eq!(stored.len(), 8);
    assert!(stored.iter().filter(|s| s.1 == "rejected").all(|s| !s.2), "rejected ops aren't for the export side");

    // A retry of the whole batch: every stored op is a duplicate with its first result.
    let again = ops(&app, &token, batch).await;
    for (i, x) in again["results"].as_array().unwrap().iter().enumerate() {
        if i == 7 || i == 8 {
            assert_eq!(x["status"], "rejected");
            continue;
        }
        assert_eq!(x["status"], "duplicate", "{i}");
        assert_eq!(x["original"], r["results"][i]["status"], "{i}");
        assert_eq!(x["error"], r["results"][i]["error"], "{i}");
        assert_eq!(x["seq"], r["results"][i]["seq"], "{i}");
    }

    // Not a JSON array at all: 400 that says what's expected.
    let (status, body) = post_raw(&app, Some(&token), "/api/plan/inputs", b"{\"op_id\": 1}".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().starts_with("body: expected a JSON array"), "{body}");
}

#[tokio::test]
async fn reviews_are_full_records_a_clear_is_a_tombstone_and_installed_toggles() {
    let (app, pool, id, token) = setup().await;
    ops(&app, &token, json!([review("a", P1, Some("want"), Some("try it"), Some("Forest"), "2026-10-19T01:00:00Z")])).await;
    let a = answer(&pool, &id, P1).await.unwrap();
    assert_eq!((a.0.as_deref(), a.1.as_deref(), a.2.as_deref(), a.4.as_str()), (Some("want"), Some("try it"), Some("Forest"), "yama"));

    // A full record replaces the whole answer: the note and cut it leaves out are gone.
    ops(&app, &token, json!([review("b", P1, Some("unsure"), None, None, "2026-10-19T01:01:00Z")])).await;
    let a = answer(&pool, &id, P1).await.unwrap();
    assert_eq!((a.0.as_deref(), a.1, a.2), (Some("unsure"), None, None));

    // All empty (blank strings too) is a clear: kept as a tombstone with its time.
    ops(&app, &token, json!([review("c", P1, None, Some("  "), Some(""), "2026-10-19T01:02:00Z")])).await;
    let a = answer(&pool, &id, P1).await.unwrap();
    assert_eq!((a.0, a.1, a.2, a.3.as_str()), (None, None, None, "2026-10-19T01:02:00Z"));
    let (deck, card): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT deck_name, card FROM plan_reviews WHERE swap_key = ?").bind(P1).fetch_one(&pool).await.unwrap();
    assert_eq!((deck.as_deref(), card.as_deref()), (Some("Alpha Deck"), Some("Proposal One")), "kept readable for orphan lists");

    // The bundle shows the tombstone with the op that made it; the page treats it as no answer.
    let (_, b) = send(&app, Method::GET, "/api/plan/bundle", Some(&token), None).await;
    let r = &b["reviews"][P1];
    assert_eq!((r["decision"].is_null(), r["origin"].as_str(), r["op_id"].as_str()), (true, Some("yama"), Some("c")));
    assert!(r["seq"].as_i64().is_some());

    // Installed: set, cleared (kept as value 0 so a stale set can't win), set again.
    for (i, value) in [true, false, true].into_iter().enumerate() {
        let at = format!("2026-10-19T02:0{i}:00Z");
        ops(&app, &token, json!([{"op_id": format!("i{i}"), "kind": "installed", "at": at, "swap_key": PLANNED, "value": value}])).await;
        let v: i64 = sqlx::query_scalar("SELECT value FROM plan_marks WHERE swap_key = ? AND kind = 'installed'").bind(PLANNED).fetch_one(&pool).await.unwrap();
        assert_eq!(v == 1, value);
    }
    // An older tap that arrives late doesn't undo a newer one.
    ops(&app, &token, json!([{"op_id": "late", "kind": "installed", "at": "2026-10-19T01:59:00Z", "swap_key": PLANNED, "value": false}])).await;
    let (_, b) = send(&app, Method::GET, "/api/plan/bundle", Some(&token), None).await;
    assert_eq!(b["marks"][PLANNED]["installed"]["value"], true);
    assert_eq!(b["marks"][PLANNED]["installed"]["op_id"], "i2");

    // "Bought it" is a claim: no order, no list change.
    let orders_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_orders").fetch_one(&pool).await.unwrap();
    let r = ops(&app, &token, json!([{"op_id": "buy", "kind": "bought", "at": "2026-10-19T03:00:00Z", "swap_key": P1, "value": true,
                                      "store_key": "shop", "store_label": "Example Games", "price_paid": null, "qty": 1, "on": "2026-10-18"}])).await;
    assert_eq!(r["results"][0]["status"], "applied");
    let orders_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_orders").fetch_one(&pool).await.unwrap();
    assert_eq!(orders_before, orders_after);
    let payload: String = sqlx::query_scalar("SELECT payload FROM plan_marks WHERE kind = 'bought'").fetch_one(&pool).await.unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload, json!({"store_key": "shop", "store_label": "Example Games", "price_paid": null, "qty": 1, "on": "2026-10-18"}));
    let _ = id;
}

/// Run `steps` (an op or a document) in the given order on a fresh database; return the answer.
async fn run_order(order: &[usize]) -> (Option<String>, String, String) {
    let (app, pool, id, token) = setup().await;
    for &i in order {
        match i {
            0 => {
                ops(&app, &token, json!([review("yama-op", P1, Some("unsure"), None, None, "2026-10-19T12:00:00Z")])).await;
            }
            1 => {
                let older = json!({P1: {"decision": "no", "note": null, "cut": null, "deck": "Alpha Deck", "card": "Proposal One", "at": "2026-10-19T11:00:00Z"}});
                import(&app, &token, &doc(older)).await;
            }
            _ => {
                let newer = json!({P1: {"decision": "want", "note": "from the Mac", "cut": null, "deck": "Alpha Deck", "card": "Proposal One", "at": "2026-10-19T13:00:00Z"}});
                import(&app, &token, &doc(newer)).await;
            }
        }
    }
    let a = answer(&pool, &id, P1).await.unwrap();
    (a.0, a.3, a.4)
}

#[tokio::test]
async fn every_order_of_an_op_and_two_document_answers_ends_the_same() {
    let orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for order in orders {
        let got = run_order(&order).await;
        assert_eq!(got, (Some("want".into()), "2026-10-19T13:00:00Z".into(), "import".into()), "order {order:?}");
    }
}

#[tokio::test]
async fn ties_go_to_yama_then_to_the_larger_op_id_in_any_order() {
    let at = "2026-10-19T12:00:00Z";
    let doc_answer = json!({P1: {"decision": "no", "note": null, "cut": null, "at": at}});
    for yama_first in [true, false] {
        let (app, pool, id, token) = setup().await;
        let a = review("op-a", P1, Some("want"), None, None, at);
        let b = review("op-b", P1, Some("unsure"), None, None, at);
        if yama_first {
            ops(&app, &token, json!([b.clone(), a.clone()])).await;
            import(&app, &token, &doc(doc_answer.clone())).await;
        } else {
            import(&app, &token, &doc(doc_answer.clone())).await;
            ops(&app, &token, json!([a, b])).await;
        }
        let r = answer(&pool, &id, P1).await.unwrap();
        assert_eq!((r.0.as_deref(), r.4.as_str()), (Some("unsure"), "yama"), "yama first: {yama_first}");
    }
}

#[tokio::test]
async fn a_device_clock_in_the_future_is_clamped_and_times_are_whole_seconds() {
    let (_app, pool, id, _token) = setup().await;
    let received = chrono::DateTime::parse_from_rfc3339("2026-10-19T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let batch = vec![
        review("far", P1, Some("want"), None, None, "2027-01-01T00:00:00Z"),
        review("near", P2, Some("want"), None, None, "2026-10-19T12:04:59.750Z"),
        json!({"op_id": "offset", "kind": "installed", "at": "2026-10-19T06:30:00-05:00", "swap_key": PLANNED, "value": true}),
    ];
    let r = inputs::apply_ops(&pool, &id, batch, received).await.unwrap();
    assert!(r.results.iter().all(|x| x.status == "applied"), "{:?}", r.results);
    assert_eq!(answer(&pool, &id, P1).await.unwrap().3, "2026-10-19T12:00:00Z", "clamped to the time it arrived");
    assert_eq!(answer(&pool, &id, P2).await.unwrap().3, "2026-10-19T12:04:59Z", "within five minutes: kept, whole seconds");
    let at: String = sqlx::query_scalar("SELECT at FROM plan_marks").fetch_one(&pool).await.unwrap();
    assert_eq!(at, "2026-10-19T11:30:00Z");
    let client_at: String = sqlx::query_scalar("SELECT client_at FROM plan_inputs WHERE op_id = 'far'").fetch_one(&pool).await.unwrap();
    assert_eq!(client_at, "2026-10-19T12:00:00Z");
}

// ── the inbox ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn seq_is_global_the_inbox_returns_export_ops_after_the_cursor_and_ack_moves_it() {
    let (app, pool, a_id, a_session) = setup().await;
    let (b_id, b_session) = user(&pool, "friend@example.com").await;
    // B has an imported deck and a deck made in Yama; answers on the Yama-made one stay in Yama.
    let mut both = doc(json!({}));
    both["plan"]["decks"].as_array_mut().unwrap().push(json!({
        "key": "mine", "name": "Mine", "source": "yama", "commander": ["Test Commander"],
        "states": {"stock": {"cards": list()}, "now": {"cards": list()}, "after": {"cards": list()}}}));
    both["plan"]["swaps"].as_array_mut().unwrap().push(json!({
        "key": "y|mine-p1", "deck": "mine", "stage": "proposed", "role": "swap", "src": "buy", "out": null, "in": "Mine One"}));
    import(&app, &b_session, &both).await;

    // Interleaved ops from two people: seqs keep going up across them.
    let mut seqs = vec![];
    for (i, who) in [&a_session, &b_session, &a_session, &b_session].into_iter().enumerate() {
        let r = ops(&app, who, json!([review(&format!("op-{i}"), P1, Some("want"), None, None, "2026-10-19T01:00:00Z")])).await;
        seqs.push(r["results"][0]["seq"].as_i64().unwrap());
    }
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
    ops(&app, &b_session, json!([review("b-own", "y|mine-p1", Some("no"), None, None, "2026-10-19T01:00:00Z")])).await;
    let (key_id, key) = make_key(&app, &a_session, "commander-decks").await;

    // A's inbox: only A's ops, oldest first, with the deck and card names the repo uses.
    let (status, inbox) = send(&app, Method::GET, "/api/plan/inbox", Some(&key), None).await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    let got: Vec<&str> = inbox["ops"].as_array().unwrap().iter().map(|o| o["op_id"].as_str().unwrap()).collect();
    assert_eq!(got, ["op-0", "op-2"]);
    let o = &inbox["ops"][0];
    assert_eq!((o["key"].as_str(), o["deck"].as_str(), o["card"].as_str(), o["orphan"].as_bool()), (Some(P1), Some("Alpha Deck"), Some("Proposal One"), Some(false)));
    assert_eq!(o["record"], json!({"decision": "want", "note": null, "cut": null}));
    assert_eq!((inbox["pulled_through"].as_i64(), inbox["through"].as_i64(), inbox["more"].as_bool()), (Some(0), Some(seqs[2]), Some(false)));

    // B's own-deck answer never reaches an inbox; B's imported-deck answers reach only B's.
    let b_inbox = inputs::inbox(&pool, &b_id, None).await.unwrap();
    assert_eq!(b_inbox.ops.iter().map(|o| o.op_id.as_str()).collect::<Vec<_>>(), ["op-1", "op-3"]);
    let own_export: bool = sqlx::query_scalar("SELECT for_export FROM plan_inputs WHERE op_id = 'b-own'").fetch_one(&pool).await.unwrap();
    assert!(!own_export);

    // Ack moves the cursor; the next pull is empty; ack can't move it back or past A's newest op.
    let rev = revision(&pool, &a_id).await;
    let (status, acked) = send(&app, Method::POST, "/api/plan/inbox/ack", Some(&key), Some(json!({"through": inbox["through"]}))).await;
    assert_eq!(status, StatusCode::OK, "{acked}");
    assert_eq!(acked["pulled_through"], inbox["through"]);
    assert_eq!(revision(&pool, &a_id).await, rev + 1, "the bundle learns the answers were picked up");
    let (_, empty) = send(&app, Method::GET, "/api/plan/inbox", Some(&key), None).await;
    assert_eq!(empty["ops"], json!([]));
    assert_eq!(empty["through"], inbox["through"]);
    let (_, back) = send(&app, Method::POST, "/api/plan/inbox/ack", Some(&key), Some(json!({"through": 1}))).await;
    assert_eq!(back["pulled_through"], inbox["through"]);
    let (_, far) = send(&app, Method::POST, "/api/plan/inbox/ack", Some(&key), Some(json!({"through": 1_000_000}))).await;
    assert_eq!(far["pulled_through"], inbox["through"], "never past this owner's newest op");
    let next = ops(&app, &a_session, json!([{"op_id": "idea-1", "kind": "idea", "at": "2026-10-19T02:00:00Z", "deck_key": "alpha", "in": "Sol Ring", "why": "Ramp"}])).await;
    let (_, later) = send(&app, Method::GET, "/api/plan/inbox", Some(&key), None).await;
    assert_eq!(later["ops"].as_array().unwrap().len(), 1, "{later}");
    assert_eq!(later["ops"][0]["seq"], next["results"][0]["seq"]);
    assert_eq!(later["ops"][0]["record"], json!({"in": "Sol Ring", "out": null, "why": "Ramp"}));
    assert_eq!(later["ops"][0]["deck"], "Alpha Deck");
    // `after` reads again from any point without moving the cursor.
    let (_, again) = send(&app, Method::GET, "/api/plan/inbox?after=0", Some(&key), None).await;
    assert_eq!(again["ops"].as_array().unwrap().len(), 3);

    // The bundle counts what waits and lists the idea.
    let (_, b) = send(&app, Method::GET, "/api/plan/bundle", Some(&a_session), None).await;
    assert_eq!((b["inputs"]["pending_pull"].as_i64(), b["inputs"]["pulled_through"].as_i64()), (Some(1), inbox["through"].as_i64()));
    assert_eq!(b["inputs"]["ideas"][0]["in"], "Sol Ring");
    let _ = key_id;
}

#[tokio::test]
async fn an_answer_on_a_key_that_matches_nothing_is_kept_for_the_export_side() {
    let (app, pool, id, token) = setup().await;
    let gone = "plan|Alpha Deck|Gone Card|Old Card";
    ops(&app, &token, json!([review("orphan", gone, Some("want"), None, None, "2026-10-19T01:00:00Z")])).await;
    assert_eq!(answer(&pool, &id, gone).await.unwrap().0.as_deref(), Some("want"));
    let inbox = inputs::inbox(&pool, &id, None).await.unwrap();
    let o = &inbox.ops[0];
    assert!(o.orphan && o.key.is_none(), "{o:?}");
    assert_eq!(o.deck.as_deref(), Some("Alpha Deck"), "the deck_key the page sent still names the deck");

    // An alias carries a later op to the renamed swap.
    let mut renamed = doc(json!({}));
    renamed["plan"]["aliases"] = json!([{"old": gone, "new": PLANNED}]);
    import(&app, &token, &renamed).await;
    let inbox = inputs::inbox(&pool, &id, Some(0)).await.unwrap();
    assert_eq!((inbox.ops[0].key.as_deref(), inbox.ops[0].orphan), (Some(PLANNED), false));
}

// ── script keys ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_key_works_on_sync_routes_and_nowhere_else() {
    let (app, pool, id, session) = setup().await;
    let (key_id, key) = make_key(&app, &session, "commander-decks on the Mac").await;
    assert!(key.starts_with("yama_pat_") && key.len() == 9 + 64, "{key}");

    // Sync routes take it, as the owner.
    let (status, head) = send(&app, Method::GET, "/api/plan/head", Some(&key), None).await;
    assert_eq!(status, StatusCode::OK, "{head}");
    assert_eq!(head["git_sha"], "abc1234");
    let mut d = doc(json!({}));
    d["meta"]["git_sha"] = json!("def5678");
    d["plan"]["swaps"][1]["why"] = json!("changed");
    let (status, report) = post_raw(&app, Some(&key), "/api/plan/import", d.to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let via: String = sqlx::query_scalar("SELECT via FROM plan_imports WHERE id = ?").bind(report["import_id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(via, "token");
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM plan_imports WHERE id = ?").bind(report["import_id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(owner, id);
    let used: Option<String> = sqlx::query_scalar("SELECT last_used_at FROM api_tokens WHERE id = ?").bind(&key_id).fetch_one(&pool).await.unwrap();
    assert!(used.is_some());
    for path in ["/api/plan/inbox"] {
        assert_eq!(send(&app, Method::GET, path, Some(&key), None).await.0, StatusCode::OK, "{path}");
    }
    assert_eq!(send(&app, Method::POST, "/api/plan/inbox/ack", Some(&key), Some(json!({"through": 0}))).await.0, StatusCode::OK);
    // A session still works on sync routes (the browser upload).
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&session), None).await.0, StatusCode::OK);

    // Every other route refuses it, including making more keys and the WebSocket ?token= path.
    for (method, path, body) in [
        (Method::GET, "/api/me", None),
        (Method::GET, "/api/plan/bundle", None),
        (Method::GET, "/api/plan/imports", None),
        (Method::POST, "/api/plan/inputs", Some(json!([]))),
        (Method::GET, "/api/me/tokens", None),
        (Method::POST, "/api/me/tokens", Some(json!({"name": "another"}))),
        (Method::DELETE, &*format!("/api/me/tokens/{key_id}"), None),
        (Method::GET, "/api/decks", None),
        (Method::GET, "/api/invites", None),
    ] {
        let (status, _) = send(&app, method.clone(), path, Some(&key), body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    let ws = Request::builder()
        .uri(format!("/api/play/some-game/ws?token={key}"))
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "upgrade")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.clone().oneshot(ws).await.unwrap().status(), StatusCode::UNAUTHORIZED);

    // A made-up key, a key with another scope, an expired key and a revoked key all get 401.
    let fake = format!("yama_pat_{}", "0".repeat(64));
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&fake), None).await.0, StatusCode::UNAUTHORIZED);
    let (other_id, other) = make_key(&app, &session, "other scope").await;
    sqlx::query("UPDATE api_tokens SET scopes = '[\"lab:read\"]' WHERE id = ?").bind(&other_id).execute(&pool).await.unwrap();
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&other), None).await.0, StatusCode::UNAUTHORIZED);
    let (old_id, old) = make_key(&app, &session, "expired").await;
    sqlx::query("UPDATE api_tokens SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").bind(&old_id).execute(&pool).await.unwrap();
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&old), None).await.0, StatusCode::UNAUTHORIZED);
    let (status, revoked) = send(&app, Method::DELETE, &format!("/api/me/tokens/{key_id}"), Some(&session), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(revoked["revoked_at"].is_string());
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::UNAUTHORIZED);
    // Revoking again keeps the first time.
    let (_, again) = send(&app, Method::DELETE, &format!("/api/me/tokens/{key_id}"), Some(&session), None).await;
    assert_eq!(again["revoked_at"], revoked["revoked_at"]);
}

#[tokio::test]
async fn listing_keys_never_shows_a_key_and_keys_are_per_user() {
    let (app, pool, _id, session) = setup().await;
    let (key_id, key) = make_key(&app, &session, "commander-decks").await;
    let (status, list) = send(&app, Method::GET, "/api/me/tokens", Some(&session), None).await;
    assert_eq!(status, StatusCode::OK);
    let text = list.to_string();
    assert!(!text.contains(&key) && !text.contains(&sha256_hex(&key)) && !text.contains("token"), "{text}");
    assert_eq!(list[0]["id"], key_id.as_str());
    assert_eq!(list[0]["scopes"], json!(["plan:sync"]));
    assert!(list[0]["expires_at"].as_str().unwrap() > now().as_str());

    // Another person can't see or revoke it, and gets 404 rather than 403.
    let (_, other) = user(&pool, "friend@example.com").await;
    let (_, theirs) = send(&app, Method::GET, "/api/me/tokens", Some(&other), None).await;
    assert_eq!(theirs, json!([]));
    assert_eq!(send(&app, Method::DELETE, &format!("/api/me/tokens/{key_id}"), Some(&other), None).await.0, StatusCode::NOT_FOUND);
    // A key reads only its owner's plan: the friend's key sees an empty inbox and head.
    let (_, their_key) = make_key(&app, &other, "theirs").await;
    let (_, head) = send(&app, Method::GET, "/api/plan/head", Some(&their_key), None).await;
    assert!(head["head_hash"].is_null() && head["revision"] == 0, "{head}");

    // Bad requests.
    assert_eq!(send(&app, Method::POST, "/api/me/tokens", Some(&session), Some(json!({"name": " "}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::POST, "/api/me/tokens", Some(&session), Some(json!({"name": "x", "days": 9999}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::POST, "/api/me/tokens", None, Some(json!({"name": "x"}))).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoking_an_invite_revokes_keys_and_user_add_leaves_them() {
    let (app, pool) = app().await;
    let (_, admin_session) = user(&pool, "admin@example.com").await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE email = 'admin@example.com'").execute(&pool).await.unwrap();
    let (_, session) = user(&pool, "friend@example.com").await;
    let (_, key) = make_key(&app, &session, "friend's script").await;

    // `yama-server user add` gives a password and ends sessions, but a key keeps working.
    crate::auth::add_local_user(&pool, "friend@example.com", None, false, Some("a long enough password".into())).await.unwrap();
    assert_eq!(send(&app, Method::GET, "/api/me", Some(&session), None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::OK);
    let revoked: Option<String> = sqlx::query_scalar("SELECT revoked_at FROM api_tokens").fetch_one(&pool).await.unwrap();
    assert!(revoked.is_none());

    // Taking back the invite revokes it.
    let (status, _) = send(&app, Method::DELETE, "/api/invites/friend@example.com", Some(&admin_session), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(send(&app, Method::GET, "/api/plan/head", Some(&key), None).await.0, StatusCode::UNAUTHORIZED);
    let revoked: Option<String> = sqlx::query_scalar("SELECT revoked_at FROM api_tokens").fetch_one(&pool).await.unwrap();
    assert!(revoked.is_some());
}
