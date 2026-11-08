use super::*;
use crate::mcp::{Question, QuestionToken, Via, tools};
use crate::decks::{Board, DeckCard};
use crate::testutil;
use axum::http::{Method, StatusCode};
use axum::{Router, routing::get};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn account(st: &AppState, email: &str) -> (User, String) {
    let (id, session) = testutil::user(&st.pool, email).await;
    let user = crate::auth::user_by_id(st, &id).await.unwrap().unwrap();
    (user, session)
}

async fn seed(st: &AppState) {
    for (id, name, ty, cost, mana) in [
        (
            "commander",
            "Test Commander",
            "Legendary Creature — Wizard",
            "{2}{U}",
            "",
        ),
        ("island", "Island", "Basic Land — Island", "", "U"),
        ("ring", "Sol Ring", "Artifact", "{1}", "C"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id,name,type_line,mana_cost,cmc,oracle_text,color_identity,legalities,game_changer,produced_mana,updated_at) VALUES (?,?,?,?,?,?,'U','{\"commander\":\"legal\"}',0,?,'2026-10-27')")
            .bind(id).bind(name).bind(ty).bind(cost).bind(if id=="commander" {3.0} else if id=="ring" {1.0} else {0.0})
            .bind(if id=="ring" {"{T}: Add {C}{C}."} else {""}).bind(mana).execute(&st.pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name,oracle_id) VALUES (?,?)")
            .bind(name)
            .bind(id)
            .execute(&st.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,finishes,digital,updated_at) VALUES (?,?,?,'tst','Test','1','en','[\"nonfoil\"]',0,'2026-10-27')")
            .bind(id).bind(id).bind(name).execute(&st.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO price_snapshots (scryfall_id,date,usd) VALUES ('commander','2026-10-27',2.0),('island','2026-10-27',NULL)")
        .execute(&st.pool).await.unwrap();
}

fn valid_list() -> String {
    "Commander\n1 Test Commander\nDeck\n99 Island".into()
}

async fn mock(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{addr}/"), task)
}

#[tokio::test]
async fn analysis_keeps_prices_unknown_and_ownership_private() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    let (other, _) = account(&st, "other@example.com").await;
    sqlx::query("INSERT INTO collection_items (id,owner_id,scryfall_id,qty,created_at,updated_at) VALUES ('theirs',?,'island',99,'now','now')").bind(&other.id).execute(&st.pool).await.unwrap();
    let result = analysis::analyze(&st, &me, &json!({"list":valid_list(),"budget_usd":100.0}))
        .await
        .unwrap();
    assert_eq!(result["statistics"]["cards"], 100);
    assert_eq!(result["statistics"]["lands"], 99);
    assert_eq!(result["market"]["known_subtotal_usd"], 2.0);
    assert_eq!(result["market"]["missing_copies"], 99);
    assert_eq!(result["market"]["budget_status"], "unknown_missing_prices");
    assert!(
        result["cards"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["owned_real"] == 0)
    );
    let (deck, version) = testutil::deck(&st.pool, &other.id, "Private deck").await;
    assert!(
        analysis::analyze(&st, &me, &json!({"deck":deck}))
            .await
            .is_err()
    );
    let mine = crate::decks::create_deck_with_cards(
        &st.pool,
        &me.id,
        "Mine",
        None,
        crate::decks::resolve(&st.pool, crate::decks::parse_list(&valid_list(), true))
            .await
            .unwrap()
            .cards,
    )
    .await
    .unwrap();
    assert!(
        analysis::analyze(&st, &me, &json!({"deck":mine,"version":version}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn full_list_creation_is_staged_atomic_and_cannot_repeat() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    let via = Via::Question(Question::default());
    tools::call(
        &st,
        &me,
        &via,
        "save_deck",
        &json!({"name":"Built deck","list":valid_list()}),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks")
        .fetch_one(&st.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let change = crate::mcp::changes::list(&st.pool, &me.id, true, None)
        .await
        .unwrap()
        .remove(0);
    assert!(!tools::offered("apply_change", &me, &via));
    let applied = crate::mcp::changes::apply(&st, &me, &change.id)
        .await
        .unwrap();
    assert_eq!(applied.status, "applied");
    assert!(
        crate::mcp::changes::apply(&st, &me, &change.id)
            .await
            .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks")
        .fetch_one(&st.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let id = applied.result.unwrap()["deck_id"]
        .as_str()
        .unwrap()
        .to_string();
    tools::call(
        &st,
        &me,
        &Via::Key,
        "save_deck",
        &json!({"deck":id,"list":valid_list()}),
    )
    .await
    .unwrap();
    let change = crate::mcp::changes::list(&st.pool, &me.id, true, None)
        .await
        .unwrap()
        .remove(0);
    let cards = analysis::load(&st, &me, &json!({"deck":id}))
        .await
        .unwrap()
        .cards;
    crate::decks::insert_version(&st.pool, &id, &cards, Some("Another edit"))
        .await
        .unwrap();
    let stale = crate::mcp::changes::apply(&st, &me, &change.id)
        .await
        .unwrap();
    assert_eq!(stale.status, "pending");
    assert!(stale.error.unwrap().contains("changed after"));
    assert!(
        tools::call(
            &st,
            &me,
            &Via::Key,
            "save_deck",
            &json!({"name":"Incomplete","list":"Commander\n1 Test Commander"})
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn prerelease_cards_save_with_a_note_and_other_illegal_cards_do_not() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    // Spock: out only in a set that hasn't released. Worf: released after his legality data was
    // imported, which stays "not legal" until the next oracle import. Clown: not legal for good
    // (out long before the import). Sol Ring: reprinted in the new set beside an undated printing.
    for (id, name, released, imported) in [
        ("spock", "Spock", "2999-01-01", "2026-11-01T00:00:00Z"),
        ("worf", "Worf", "2026-11-05", "2026-11-01T00:00:00Z"),
        ("clown", "Clown", "2017-12-08", "2026-11-01T00:00:00Z"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id,name,type_line,cmc,oracle_text,color_identity,legalities,game_changer,updated_at) VALUES (?,?,'Creature','1','','U','{\"commander\":\"not_legal\"}',0,?)")
            .bind(id).bind(name).bind(imported).execute(&st.pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name,oracle_id) VALUES (?,?)").bind(name).bind(id).execute(&st.pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,finishes,digital,released_at,updated_at) VALUES (?,?,?,'new','New','1','en','[\"nonfoil\"]',0,?,'now')")
            .bind(id).bind(id).bind(name).bind(released).execute(&st.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO printings (scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,finishes,digital,released_at,updated_at) VALUES ('ring-new','ring','Sol Ring','new','New','2','en','[\"nonfoil\"]',0,'2999-01-01','now')")
        .execute(&st.pool).await.unwrap();
    let info = crate::decks::card_info(
        &st.pool,
        &["spock", "worf", "clown", "ring"].map(|id| DeckCard { oracle_id: id.into(), name: id.into(), qty: 1, board: Board::Main }),
    )
    .await
    .unwrap();
    assert_eq!(info["spock"].releases_on.as_deref(), Some("2999-01-01"));
    assert_eq!(info["worf"].releases_on.as_deref(), Some("2026-11-05"));
    assert_eq!(info["clown"].releases_on, None);
    assert_eq!(info["ring"].releases_on, None); // the 'tst' printing has no date; a dated one is out or none is
    let via = Via::Question(Question::default());
    let list = "Commander\n1 Test Commander\nDeck\n1 Spock\n1 Worf\n97 Island";
    tools::call(&st, &me, &via, "save_deck", &json!({"name":"Trek","list":list})).await.unwrap();
    let change = crate::mcp::changes::list(&st.pool, &me.id, true, None).await.unwrap().remove(0);
    let detail = change.detail.unwrap();
    assert!(detail.contains("Commander checks: no problems found."), "{detail}");
    assert!(detail.contains("Prerelease: Spock is new in a set dated 2999-01-01"), "{detail}");
    assert!(detail.contains("Prerelease: Worf is new in a set dated 2026-11-05"), "{detail}");
    assert_eq!(crate::mcp::changes::apply(&st, &me, &change.id).await.unwrap().status, "applied");
    let err = tools::call(&st, &me, &via, "save_deck", &json!({"name":"Clowns","list":"Commander\n1 Test Commander\nDeck\n1 Clown\n98 Island"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("Clown is not legal in Commander"), "{err}");
}

#[tokio::test]
async fn network_cache_preserves_observation_date_and_blocks_redirects() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let router = Router::new()
        .route(
            "/cards/search",
            get(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({"data":[],"total_cards":0,"has_more":false}))
                }
            }),
        )
        .route(
            "/redirect",
            get(|| async {
                (
                    StatusCode::FOUND,
                    [("location", "http://127.0.0.1:1/secrets")],
                )
            }),
        );
    let (base, server) = mock(router).await;
    let research = client::Research::default().with_base(Provider::Scryfall, base);
    let a = research
        .get(None, Provider::Scryfall, "/cards/search", &[])
        .await
        .unwrap();
    let b = research
        .get(None, Provider::Scryfall, "/cards/search", &[])
        .await
        .unwrap();
    assert!(!a.cached);
    assert!(b.cached);
    assert_eq!(a.fetched_at, b.fetched_at);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert!(
        research
            .get(None, Provider::Scryfall, "/redirect", &[])
            .await
            .unwrap_err()
            .to_string()
            .contains("HTTP 302")
    );
    server.abort();
}

#[tokio::test]
async fn provider_errors_limits_and_deck_sharing_are_explicit() {
    let router = Router::new()
        .route(
            "/limited",
            get(|| async { (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "15")]) }),
        )
        .route("/bad", get(|| async { "not JSON" }));
    let (base, server) = mock(router).await;
    let research = client::Research::default().with_base(Provider::Scryfall, base);
    assert!(
        research
            .get(None, Provider::Scryfall, "/bad", &[])
            .await
            .unwrap()
            .json()
            .is_err()
    );
    assert!(matches!(
        research.get(None, Provider::Scryfall, "/limited", &[]).await,
        Err(AppError::TooManyRequests {
            retry_after: 15,
            ..
        })
    ));
    assert!(matches!(
        research.get(None, Provider::Scryfall, "/limited", &[]).await,
        Err(AppError::TooManyRequests { .. })
    ));
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    assert!(
        combos(&st, &me, &json!({"list":valid_list()}))
            .await
            .unwrap_err()
            .to_string()
            .contains("share_list")
    );
    assert!(
        combos(&st, &me, &json!({"list":valid_list(),"share_list":true}))
            .await
            .unwrap_err()
            .to_string()
            .contains("disabled")
    );
    assert!(analysis::mana_probability(&json!({"library":9,"sources":10})).is_err());
    assert!(
        analysis::hands(&st, &me, &json!({"list":"Deck\n99999 Island"}))
            .await
            .is_err()
    );
    server.abort();
}

#[test]
fn public_url_and_card_list_parsers_preserve_requirements() {
    for url in [
        "http://moxfield.com/decks/a",
        "https://moxfield.com.evil.test/decks/a",
        "https://user@moxfield.com/decks/a",
        "https://moxfield.com:1234/decks/a",
        "https://archidekt.com/decks/a",
        "https://moxfield.com/decks/%2e%2e",
    ] {
        assert!(deck_url(url).is_err(), "{url}");
    }
    assert_eq!(
        deck_url("https://www.archidekt.com/decks/1/title?x=1")
            .unwrap()
            .1,
        "1"
    );
    let deck=parse_public(Provider::Archidekt,&json!({"name":"Example","categories":[{"name":"Leader","isPremier":true}],"cards":[{"quantity":1,"categories":["Leader"],"card":{"oracleCard":{"name":"Test Commander"}}},{"quantity":99,"categories":[],"card":{"oracleCard":{"name":"Island"}}}]})).unwrap();
    assert!(
        deck["list"]
            .as_str()
            .unwrap()
            .starts_with("Commander\n1 Test Commander")
    );
    let combo = combo_summary(
        &json!({"id":"x","uses":[{"quantity":2,"zoneLocations":["G"],"usedFace":1,"mustBeCommander":true,"card":{"name":"A","oracleId":"id","faces":2,"imageUri":"not kept"}}],"requires":[{"template":{"name":"A creature"},"quantity":1}],"notablePrerequisites":"Condition","description":"Steps"}),
    );
    assert_eq!(combo["uses"][0]["quantity"], 2);
    assert_eq!(combo["uses"][0]["usedFace"], 1);
    assert_eq!(combo["uses"][0]["mustBeCommander"], true);
    assert_eq!(combo["notablePrerequisites"], "Condition");
    assert_eq!(combo["description"], "Steps");
}

#[tokio::test]
async fn protocol_advertises_workflows_and_owner_checked_resources() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    let (other, _) = account(&st, "other@example.com").await;
    let (id, _) = testutil::deck(&st.pool, &other.id, "Secret deck").await;
    let token = QuestionToken::mint(&me.id, Question::default());
    let app = crate::routes::app(st);
    let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let (_, init) = testutil::send(
        &app,
        Method::POST,
        "/mcp",
        Some(&token.token),
        Some(rpc("initialize", json!({}))),
    )
    .await;
    assert!(init["result"]["capabilities"]["prompts"].is_object());
    let (_, catalog) = testutil::send(
        &app,
        Method::POST,
        "/mcp",
        Some(&token.token),
        Some(rpc("tools/list", json!({}))),
    )
    .await;
    let tools = catalog["result"]["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t["name"] == "search_scryfall" && t["annotations"]["openWorldHint"] == true)
    );
    assert!(tools.iter().any(|t| t["name"] == "save_deck"));
    assert!(!tools.iter().any(|t| t["name"] == "apply_change"));
    let (_, prompt) = testutil::send(
        &app,
        Method::POST,
        "/mcp",
        Some(&token.token),
        Some(rpc(
            "prompts/get",
            json!({"name":"build_commander","arguments":{"goals":"$100, use owned cards"}}),
        )),
    )
    .await;
    assert!(
        prompt["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("$100")
    );
    let (_, private) = testutil::send(
        &app,
        Method::POST,
        "/mcp",
        Some(&token.token),
        Some(rpc(
            "resources/read",
            json!({"uri":format!("yama://deck/{id}")}),
        )),
    )
    .await;
    assert!(private["error"].is_object());
    assert!(!private.to_string().contains("Secret deck"));
}

#[tokio::test]
async fn scryfall_pagination_does_not_skip_cards_and_recommendation_filters_stay_local() {
    let mut st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    sqlx::query("INSERT INTO collection_items (id,owner_id,scryfall_id,qty,created_at,updated_at) VALUES ('mine',?,'ring',2,'now','now')").bind(&me.id).execute(&st.pool).await.unwrap();
    let public=Router::new().route("/cards/search",get(||async {axum::Json(json!({"total_cards":3,"has_more":false,"data":[{"name":"First","oracle_id":"not-loaded","prices":{"usd":null}},{"name":"Sol Ring","oracle_id":"ring","prices":{"usd":"1.25"}},{"name":"Third"}]}))}))
        .route("/pages/commanders/test-commander.json",get(||async {axum::Json(json!({"container":{"json_dict":{"cardlists":[{"header":"Top Cards","cardviews":[{"name":"Sol Ring","num_decks":25,"potential_decks":100,"synergy":0.2},{"name":"Island","num_decks":50,"potential_decks":100,"synergy":0.1}]}]}}}))}));
    let (base, server) = mock(public).await;
    st.research = Arc::new(
        client::Research::default()
            .with_base(Provider::Scryfall, base.clone())
            .with_base(Provider::Edhrec, base),
    );
    let a = search(&st, &me, &json!({"query":"t:artifact","limit":1}))
        .await
        .unwrap();
    assert_eq!(a["next"], json!({"page":1,"offset":1}));
    assert!(a["cards"][0]["prices"]["usd"].is_null());
    let b = search(
        &st,
        &me,
        &json!({"query":"t:artifact","limit":1,"offset":1}),
    )
    .await
    .unwrap();
    assert_eq!(b["cards"][0]["owned_real"], 2);
    assert_eq!(a["price_observed_at"], b["price_observed_at"]);
    let c = search(
        &st,
        &me,
        &json!({"query":"t:artifact","limit":1,"offset":2}),
    )
    .await
    .unwrap();
    assert!(c["next"].is_null());
    let rec = recommendations(
        &st,
        &me,
        &json!({"commander":"Test Commander","owned_only":true}),
    )
    .await
    .unwrap();
    assert_eq!(rec["recommendations"].as_array().unwrap().len(), 1);
    assert_eq!(rec["recommendations"][0]["name"], "Sol Ring");
    assert_eq!(rec["recommendations"][0]["inclusion_rate"], 0.25);
    server.abort();
}

#[tokio::test]
async fn spellbook_post_preserves_groups_without_uploading_personal_context_or_caching() {
    let pool = crate::db::test_pool().await;
    let mut cfg = testutil::config();
    cfg.deck_checks = true;
    let mut st = testutil::state_with(cfg, pool).await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    let router=Router::new().route("/find-my-combos",axum::routing::post(move |headers:axum::http::HeaderMap,axum::Json(body):axum::Json<Value>| {
        let count=count.clone();async move {
            assert!(!headers.contains_key("authorization"));assert!(!headers.contains_key("cookie"));
            assert_eq!(body.as_object().unwrap().len(),2);assert_eq!(body["commanders"][0]["card"],"Test Commander");
            count.fetch_add(1,Ordering::SeqCst);
            axum::Json(json!({"count":null,"next":null,"results":{"included":[{"id":"x","uses":[{"card":{"name":"Sol Ring"},"quantity":2,"zoneLocations":["B"],"mustBeCommander":false}],"notablePrerequisites":"Setup"}],"almostIncluded":[],"almostIncludedByAddingColors":[]}}))
        }
    }));
    let (base, server) = mock(router).await;
    st.research = Arc::new(client::Research::default().with_base(Provider::Spellbook, base));
    for _ in 0..2 {
        let out = combos(&st, &me, &json!({"list":valid_list(),"share_list":true}))
            .await
            .unwrap();
        assert_eq!(
            out["groups"]["included"]["returned"][0]["uses"][0]["quantity"],
            2
        );
        assert_eq!(out["provenance"]["cached"], false);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    server.abort();
}

#[tokio::test]
async fn failed_applied_marker_rolls_back_deck_creation() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    crate::mcp::changes::save_deck(
        &st,
        &me,
        &Via::Key,
        &json!({"name":"Atomic","list":valid_list()}),
    )
    .await
    .unwrap();
    let change = crate::mcp::changes::list(&st.pool, &me.id, true, None)
        .await
        .unwrap()
        .remove(0);
    sqlx::query("CREATE TRIGGER fail_apply BEFORE UPDATE ON assistant_changes WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'test failure'); END").execute(&st.pool).await.unwrap();
    let out = crate::mcp::changes::apply(&st, &me, &change.id)
        .await
        .unwrap();
    assert_eq!(out.status, "pending");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks")
        .fetch_one(&st.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn seeded_mana_model_respects_tapped_lands_and_reports_missing_coverage() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    let args = json!({"list":valid_list(),"cost":"{1}{U}","turns":3,"trials":100,"seed":17});
    let out = mana::test(&st, &me, &args).await.unwrap();
    assert_eq!(out["by_turn"][0]["modeled_successes"], 0);
    assert_eq!(out["by_turn"][1]["modeled_successes"], 100);
    assert_eq!(out, mana::test(&st, &me, &args).await.unwrap());
    sqlx::query("UPDATE cards SET type_line='Land',oracle_text='This land enters tapped. {T}: Add {U}.' WHERE oracle_id='island'").execute(&st.pool).await.unwrap();
    let tapped = mana::test(&st, &me, &args).await.unwrap();
    assert_eq!(tapped["by_turn"][1]["modeled_successes"], 0);
    assert_eq!(tapped["by_turn"][2]["modeled_successes"], 100);
    sqlx::query("UPDATE cards SET oracle_text='{1}, {T}: Add {U}. Activate only if you control a Wizard.' WHERE oracle_id='island'").execute(&st.pool).await.unwrap();
    let conditional = mana::test(&st, &me, &args).await.unwrap();
    assert_eq!(conditional["coverage_complete"], false);
    assert_eq!(conditional["by_turn"][2]["modeled_successes"], 0);
}

#[tokio::test]
async fn market_never_substitutes_stale_foil_or_collectible_prices() {
    let st = testutil::state().await;
    seed(&st).await;
    for (id, set, finish, date, usd) in [
        ("stale", "old", "nonfoil", "2026-10-01", 0.1),
        ("gold", "wc99", "nonfoil", "2026-10-30", 0.01),
        ("foil", "new", "foil", "2026-10-30", 0.01),
    ] {
        sqlx::query("INSERT INTO printings (scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,finishes,digital,updated_at) VALUES (?,'commander','Test Commander',?,'Test','2','en',?,0,'now')")
            .bind(id).bind(set).bind(json!([finish]).to_string()).execute(&st.pool).await.unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id,date,usd) VALUES (?,?,?)")
            .bind(id)
            .bind(date)
            .bind(usd)
            .execute(&st.pool)
            .await
            .unwrap();
    }
    assert_eq!(
        analysis::cheapest(&st, "commander").await.unwrap(),
        (
            Some(2.0),
            Some("2026-10-27".into()),
            Some("commander".into())
        )
    );
    sqlx::query(
        "INSERT INTO price_snapshots (scryfall_id,date,usd) VALUES ('commander','2026-10-28',NULL)",
    )
    .execute(&st.pool)
    .await
    .unwrap();
    assert_eq!(
        analysis::cheapest(&st, "commander").await.unwrap(),
        (None, None, None)
    );
}

/// Optional read-only probes, kept out of the deterministic suite. No real account, private deck,
/// credential, card-data corpus download, lab run or paid service is involved.
#[tokio::test]
#[ignore = "contacts public research providers"]
async fn live_public_research_contracts() {
    let st = testutil::state().await;
    let (me, _) = account(&st, "probe@example.com").await;
    let cases = [
        (
            "search_scryfall",
            json!({"query":"!\"Sol Ring\" game:paper","limit":1}),
        ),
        (
            "commander_recommendations",
            json!({"commander":"Aragorn, King of Gondor","limit":2}),
        ),
        (
            "find_combos",
            json!({"query":"card:\"Sol Ring\"","limit":1}),
        ),
        // public_deck fetches only from sites the server enables (YAMA_DECK_LINK_SOURCES).
        ("rules_lookup", json!({"query":"702.19","limit":2})),
    ];
    for (name, args) in cases {
        let result = call(&st, &me, &Via::Key, name, &args)
            .await
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let result: Value = serde_json::from_str(&result).unwrap();
        assert!(result["provenance"]["retrieved_at"].is_string(), "{name}");
        eprintln!("verified {name}");
    }
}

#[tokio::test]
async fn identical_requests_share_one_fetch_and_answers_outlive_a_restart() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let router = Router::new().route(
        "/cards/search",
        get(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                axum::Json(json!({"data":[],"total_cards":0,"has_more":false}))
            }
        }),
    );
    let (base, server) = mock(router).await;
    let pool = crate::db::test_pool().await;
    let research = client::Research::default().with_base(Provider::Scryfall, base.clone()).with_store(pool.clone());
    // Two people ask at once: one fetch, and the second has its answer.
    let (a, b) = tokio::join!(
        research.get(Some("a"), Provider::Scryfall, "/cards/search", &[]),
        research.get(Some("b"), Provider::Scryfall, "/cards/search", &[])
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(a.fetched_at, b.fetched_at);
    assert!(a.cached != b.cached);
    // After a restart, from the database, with its provider and when it was fetched.
    let restarted = client::Research::default().with_base(Provider::Scryfall, base).with_store(pool.clone());
    let c = restarted.get(Some("c"), Provider::Scryfall, "/cards/search", &[]).await.unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert!(c.cached);
    assert_eq!(c.fetched_at, a.fetched_at);
    assert_eq!(c.provenance()["provider"], "Scryfall");
    server.abort();
}

#[tokio::test]
async fn public_decks_are_fetched_only_from_enabled_sites() {
    // The test environment never sets YAMA_DECK_LINK_SOURCES.
    if std::env::var("YAMA_DECK_LINK_SOURCES").is_ok() {
        return;
    }
    let st = testutil::state().await;
    let (me, _) = account(&st, "me@example.com").await;
    for (url, why) in [("https://moxfield.com/decks/8BVBQ928j0a76CqAbdmZYg", "robots.txt"), ("https://archidekt.com/decks/1", "terms")] {
        let err = call(&st, &me, &Via::Key, "public_deck", &json!({"url": url})).await.unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)), "{err}");
        assert!(err.to_string().contains(why), "{err}");
    }
}

#[tokio::test]
async fn card_printings_come_from_local_data_with_dated_prices() {
    let st = testutil::state().await;
    seed(&st).await;
    let (me, _) = account(&st, "me@example.com").await;
    // Two more Sol Rings: a cheaper paper one, and a digital one that isn't listed.
    for (id, set, digital, usd) in [("ring2", "cmm", 0, Some(1.25)), ("ring-mtgo", "prm", 1, Some(0.1))] {
        sqlx::query("INSERT INTO printings (scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,finishes,digital,updated_at) VALUES (?,'ring','Sol Ring',?,'Set','2','en','[\"nonfoil\",\"foil\"]',?,'2026-10-27')")
            .bind(id).bind(set).bind(digital).execute(&st.pool).await.unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id,date,usd) VALUES (?,'2026-10-28',?)").bind(id).bind(usd).execute(&st.pool).await.unwrap();
    }
    let out: Value = serde_json::from_str(&call(&st, &me, &Via::Key, "card_printings", &json!({"name":"Sol Ring"})).await.unwrap()).unwrap();
    assert_eq!(out["card"]["oracle_id"], "ring");
    assert_eq!(out["card"]["game_changer"], false);
    assert_eq!(out["total_printings"], 2);
    // Cheapest first; a printing with no price is last, its price unknown rather than zero.
    assert_eq!(out["printings"][0]["id"], "ring2");
    assert_eq!(out["printings"][0]["prices"]["usd"], 1.25);
    assert_eq!(out["printings"][0]["price_date"], "2026-10-28");
    assert_eq!(out["printings"][1]["id"], "ring");
    assert!(out["printings"][1]["prices"]["usd"].is_null());
    assert_eq!(out["price_sources"]["usd"], "TCGplayer market via Scryfall");
    assert_eq!(out["price_sources"]["eur_etched"], "Cardmarket via Scryfall");
    assert_eq!(out["provenance"]["provider"], "Yama");
    let paged: Value = serde_json::from_str(&call(&st, &me, &Via::Key, "card_printings", &json!({"name":"Sol Ring","limit":1})).await.unwrap()).unwrap();
    assert_eq!(paged["next"], json!({"offset": 1}));
    assert!(call(&st, &me, &Via::Key, "card_printings", &json!({"name":"Not A Card"})).await.is_err());
}
