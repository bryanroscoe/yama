use super::*;
use crate::testutil::{app, send, user};
use axum::Router;
use axum::extract::{Path as AxPath, Query};
use axum::http::Method;
use axum::routing::{get, post};

/// Shapes copied from real answers (Pat's suggest and product .js, Black Castle's catalog, YesTCG's
/// Austin search; commander-decks data/prices/local-2026-10-31-cedh and multiverse-2026-11-01).
fn suggest(card: &str) -> Value {
    match card {
        "\"Sol Ring\"" => json!({"resources": {"results": {"products": [
            {"title": "Sol Ring [C21 - 263]", "handle": "sol-ring-c21-263", "available": true},
            {"title": "Sol Ring (Etched Foil) [CMM - 410]", "handle": "sol-ring-etched-cmm-410", "available": true},
            {"title": "Sol Ring Token", "handle": "sol-ring-token", "available": true},
            {"title": "Sol Talisman [MH1 - 236]", "handle": "sol-talisman", "available": true},
        ]}}}),
        "\"Fellwar Stone\"" => json!({"resources": {"results": {"products": [
            {"title": "Fellwar Stone [DRK - 103]", "handle": "fellwar-stone-drk", "available": false},
        ]}}}),
        _ => json!({"resources": {"results": {"products": []}}}),
    }
}

fn product(handle: &str) -> Option<Value> {
    Some(match handle {
        "sol-ring-c21-263.js" => json!({"title": "Sol Ring [C21 - 263]", "vendor": "Commander 2021", "variants": [
            {"id": 111, "title": "Near Mint / English / Normal", "price": 150, "available": true},
            {"id": 112, "title": "Near Mint / English / Foil", "price": 400, "available": true},
            {"id": 113, "title": "Lightly Played / Japanese / Normal", "price": 100, "available": true},
            {"id": 114, "title": "Damaged / English / Normal", "price": 75, "available": false},
        ]}),
        "sol-ring-etched-cmm-410.js" => json!({"title": "Sol Ring (Etched Foil) [CMM - 410]", "vendor": "Commander Masters", "variants": [
            {"id": 121, "title": "Near Mint / English", "price": 250, "available": true},
        ]}),
        "fellwar-stone-drk.js" => json!({"title": "Fellwar Stone [DRK - 103]", "variants": [
            {"id": 131, "title": "Damaged / English / Normal", "price": 975, "available": false},
        ]}),
        _ => return None,
    })
}

fn catalog() -> Value {
    json!({"filters": [], "products": {"totalItems": 3, "items": [
        {"id": 1, "name": "Sol Ring", "lowestPrice": 1.25, "setName": "Commander Masters", "setUrlName": "commander-masters", "productUrlName": "sol-ring", "productLineName": "Magic: The Gathering"},
        {"id": 2, "name": "Exotic Orchard (Borderless)", "lowestPrice": 0.5, "setName": "Foundations", "setUrlName": "foundations", "productUrlName": "exotic-orchard-borderless", "productLineName": "Magic: The Gathering"},
        {"id": 3, "name": "Shared Roots", "lowestPrice": null, "setName": "Mystical Archive", "productLineName": "Magic: The Gathering"},
    ]}})
}

fn yestcg(q: &str, base: &str) -> Value {
    let hits = match q {
        "Sol Ring" => json!([{"name": "Sol Ring (0263)", "set": "Commander 2021", "condition": "Normal / Near Mint", "price": 1.1, "qty": 3, "url": format!("{base}/x")},
                              {"name": "Sol Ring (Borderless)", "set": "Commander Masters", "condition": "Foil / Near Mint", "price": 4.0, "qty": 1}]),
        _ => json!([]),
    };
    json!({"card": q, "market": "austin", "results": [
        {"store": "Multiverse Hobbies", "platform": "TCGplayer Pro", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": hits},
        {"store": "Space Goblin", "platform": "TCGplayer Pro", "base": "https://spacegoblinmtg.tcgplayerpro.com", "ok": false, "error": "HTTP 404", "hits": []},
    ]})
}

/// A mock of every store kind on 127.0.0.1. "Fail Me" fails at Shopify with 500 (retried, then given up).
async fn mock() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let b2 = base.clone();
    let app = Router::new()
        .route(
            "/search/suggest.json",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                if q["q"].contains("Fail Me") {
                    return Err(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
                }
                Ok(Json(suggest(&q["q"])))
            }),
        )
        .route("/products/{h}", get(|AxPath(h): AxPath<String>| async move { product(&h).map(Json).ok_or(axum::http::StatusCode::NOT_FOUND) }))
        .route("/api/catalog/search", post(|| async { Json(catalog()) }))
        .route("/", get(|| async { ([("set-cookie", "sid=abc; Path=/; HttpOnly")], "home") }))
        .route(
            "/api/decksearch",
            get(move |headers: axum::http::HeaderMap, Query(q): Query<HashMap<String, String>>| {
                let base = b2.clone();
                async move {
                    if headers.get("cookie").and_then(|c| c.to_str().ok()) != Some("sid=abc") {
                        return Err(axum::http::StatusCode::FORBIDDEN);
                    }
                    Ok(Json(yestcg(&q["q"], &base)))
                }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

#[test]
fn connectors_come_from_a_fixed_list() {
    assert_eq!(direct_connector(Some("https://patsgames.com")), Some((Kind::Shopify, "https://patsgames.com".into())));
    assert_eq!(direct_connector(Some("https://www.mothershipatx.com/")), Some((Kind::Shopify, "https://mothershipatx.com".into())));
    assert_eq!(direct_connector(Some("https://blackcastlegamez.tcgplayerpro.com")), Some((Kind::Pro, "https://blackcastlegamez.tcgplayerpro.com".into())));
    // Any other host, plain http, a port or a lookalike gets nothing.
    for bad in ["https://evil.example", "http://patsgames.com", "https://patsgames.com:8443", "https://x.tcgplayerpro.com.evil.example", "https://a.b.tcgplayerpro.com", "https://alphastrikegames.app", "not a url"] {
        assert_eq!(direct_connector(Some(bad)), None, "{bad}");
    }
    assert_eq!(direct_connector(None), None);
}

#[test]
fn titles_and_variants_parse() {
    assert_eq!(title_name("Sol Ring [C21 - 263]"), "Sol Ring");
    assert_eq!(title_name("MTG - Sol Ring (Etched Foil) [CMM - 410]"), "Sol Ring");
    assert_eq!(set_and_number("Sol Ring [C21 - 263]"), (Some("c21".into()), Some("263".into())));
    assert_eq!(set_and_number("Sol Ring [Commander Masters]"), (None, None));
    assert_eq!(variant_parts("Near Mint / English / Foil"), (Some("Near Mint".into()), Some("English".into()), "foil"));
    assert_eq!(variant_parts("Lightly Played / Japanese / Normal"), (Some("Lightly Played".into()), Some("Japanese".into()), "nonfoil"));
    assert_eq!(variant_parts("Normal / Near Mint"), (Some("Near Mint".into()), None, "nonfoil"));
    assert_eq!(variant_parts("Foil / Near Mint"), (Some("Near Mint".into()), None, "foil"));
    assert_eq!(card_key("Brazen Borrower // Petty Theft"), "brazen borrower");
    assert_eq!(card_key("  Urza’s  Saga "), "urza's saga");

    let (n, found) = shopify_suggest(&suggest("\"Sol Ring\""), "Sol Ring").unwrap();
    assert_eq!(shopify_suggest(&json!({"errors": "nope"}), "Sol Ring"), None, "an unreadable answer isn't \"none found\"");
    assert_eq!(n, 4);
    assert_eq!(found.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["sol-ring-c21-263", "sol-ring-etched-cmm-410"]);
    let l = shopify_product(&product("sol-ring-c21-263.js").unwrap(), "Sol Ring", "https://patsgames.com", "sol-ring-c21-263");
    assert_eq!(l.len(), 4);
    assert_eq!((l[0].price, l[0].finish, l[0].variant.as_deref(), l[0].set_code.as_deref()), (Some(1.5), Some("nonfoil"), Some("111"), Some("c21")));
    assert_eq!(l[1].finish, Some("foil"));
    let etched = shopify_product(&product("sol-ring-etched-cmm-410.js").unwrap(), "Sol Ring", "https://patsgames.com", "x");
    assert_eq!(etched[0].finish, Some("etched"), "the product title says etched");

    let (total, l) = pro_catalog(&catalog(), "https://bc.tcgplayerpro.com").unwrap();
    assert!(pro_catalog(&json!({"products": {}}), "https://bc.tcgplayerpro.com").is_none(), "an unreadable answer isn't an empty catalog");
    assert_eq!((total, l.len()), (3, 3));
    assert_eq!((l[1].card.as_str(), l[1].price, l[1].from_price), ("Exotic Orchard", Some(0.5), true));
    assert_eq!(l[0].url.as_deref(), Some("https://bc.tcgplayerpro.com/catalog/magic/commander-masters/sol-ring/1"));
    assert_eq!(l[2].price, None, "a missing price stays missing");

    let y = yestcg("Sol Ring", "https://mversetcg.tcgplayerpro.com");
    let mv = yestcg_store(&y, "mversetcg.tcgplayerpro.com", "Sol Ring").unwrap().unwrap();
    assert_eq!(mv.len(), 2);
    assert_eq!((mv[0].qty, mv[0].finish, mv[1].finish), (Some(3), Some("nonfoil"), Some("foil")));
    assert_eq!(yestcg_store(&y, "spacegoblinmtg.tcgplayerpro.com", "Sol Ring"), Some(None), "a store YesTCG says failed is unknown");
    assert_eq!(yestcg_store(&y, "patsgames.com", "Sol Ring"), None, "not in YesTCG's answer");
    let broken = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true}]});
    assert_eq!(yestcg_store(&broken, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "no hit list is unknown, not none");
}

async fn store_row(pool: &SqlitePool, owner: &str, key: &str, name: &str, homepage: &str, sort: i64) {
    sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, homepage, sort, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', ?, ?, 'import', 'now', 'now')")
        .bind(format!("{owner}-{key}"))
        .bind(owner)
        .bind(key)
        .bind(name)
        .bind(homepage)
        .bind(sort)
        .execute(pool)
        .await
        .unwrap();
}

async fn snapshot(pool: &SqlitePool, owner: &str, id: &str, store: &str, source: &str, cards: Option<&[&str]>) {
    sqlx::query("INSERT INTO store_snapshots (id, owner_id, store_key, source, cards, query, requested_at, status, via) VALUES (?, ?, ?, ?, ?, 'q', ?, 'running', 'page')")
        .bind(id)
        .bind(owner)
        .bind(store)
        .bind(source)
        .bind(cards.map(|c| json!(c).to_string()))
        .bind(now())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_check_reads_each_store_and_the_bundle_quotes_the_newest_answer() {
    let base = mock().await;
    let (_app, pool) = app().await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    let cards: Vec<String> = ["Sol Ring", "Fellwar Stone", "Fail Me", "Exotic Orchard"].map(String::from).to_vec();
    let refs: Vec<&str> = cards.iter().map(String::as_str).collect();
    snapshot(&pool, &owner, "s-pats", "pats", "shopify", Some(&refs)).await;
    snapshot(&pool, &owner, "s-bc", "black-castle", "tcgplayer_pro", None).await;
    snapshot(&pool, &owner, "s-mv", "multiverse-hobbies", "yestcg", Some(&refs)).await;
    let t = |id: &str, store: &str, kind: Kind, host: Option<&str>| Target { snapshot: id.into(), store: store.into(), kind, base: base.clone(), host: host.map(String::from) };
    let job = Job {
        owner: owner.clone(),
        cards: cards.clone(),
        targets: vec![t("s-pats", "pats", Kind::Shopify, None), t("s-bc", "black-castle", Kind::Pro, None), t("s-mv", "multiverse-hobbies", Kind::YesTcg, Some("mversetcg.tcgplayerpro.com"))],
    };
    run(pool.clone(), crate::routes::http_client(), job, None).await;

    let snaps = snapshots(&pool, &owner, 10).await.unwrap();
    let by = |s: &str| snaps.iter().find(|x| x["id"] == s).unwrap().clone();
    // Pat's: Fail Me couldn't be read, so it's partial; only available variants are kept.
    assert_eq!(by("s-pats")["status"], "partial", "{snaps:?}");
    assert_eq!(by("s-pats")["failed"], 1);
    assert_eq!(by("s-pats")["listings"], 4, "three available Sol Ring variants and the etched one");
    assert!(by("s-pats")["raw"] == true);
    assert_eq!(by("s-bc")["status"], "ok");
    assert_eq!(by("s-bc")["listings"], 3);
    assert_eq!(by("s-bc")["cards"], Value::Null, "a whole catalog");
    assert_eq!(by("s-mv")["status"], "ok");
    // The raw answers are kept, gzipped, with every request.
    let raw: Vec<u8> = sqlx::query_scalar("SELECT raw_gz FROM store_snapshots WHERE id = 's-pats'").fetch_one(&pool).await.unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&raw[..]), &mut text).unwrap();
    assert!(text.contains("sol-ring-c21-263.js") && text.contains("\"status\":500"), "{text}");

    let quotes = store_quotes(&pool, &owner, &cards).await.unwrap();
    let at = |store: &str, card: &str| quotes.iter().filter(|q| q["store"] == store && q["card"] == card).cloned().collect::<Vec<_>>();
    // Pat's Sol Ring: English copies only (the Japanese one is left out), each with its cart line.
    let pats_sol = at("pats", "Sol Ring");
    assert_eq!(pats_sol.len(), 3, "{pats_sol:?}");
    assert!(pats_sol.iter().all(|q| q["in_stock"] == true && q["variant"].is_string()));
    assert!(pats_sol.iter().any(|q| q["price"] == 1.5 && q["set"] == "c21" && q["num"] == "263" && q["result"].as_str().unwrap().contains("non-foil")));
    assert!(pats_sol.iter().any(|q| q["result"].as_str().unwrap().contains("etched")));
    // Fellwar Stone was listed but sold out: not in stock. Fail Me is unknown: no quote at all.
    let fellwar = at("pats", "Fellwar Stone");
    assert_eq!((fellwar.len(), &fellwar[0]["in_stock"]), (1, &json!(false)));
    assert!(at("pats", "Fail Me").is_empty());
    // Black Castle's catalog: Exotic Orchard "from" its lowest price, Fellwar Stone not in the catalog.
    let orchard = at("black-castle", "Exotic Orchard");
    assert_eq!((orchard[0]["price"].as_f64(), orchard[0]["in_stock"].as_bool()), (Some(0.5), Some(true)));
    assert!(orchard[0]["result"].as_str().unwrap().contains("lowest listed price"));
    assert_eq!(at("black-castle", "Fellwar Stone")[0]["result"], "Not in the store's catalog");
    // Multiverse through YesTCG, with quantities.
    assert!(at("multiverse-hobbies", "Sol Ring").iter().any(|q| q["result"].as_str().unwrap().contains("3 in stock")));

    // A newer snapshot of the same store supersedes the older one for the cards it covers only.
    snapshot(&pool, &owner, "s-pats2", "pats", "shopify", Some(&["Sol Ring"])).await;
    let job = Job { owner: owner.clone(), cards: vec!["Sol Ring".into()], targets: vec![Target { snapshot: "s-pats2".into(), store: "pats".into(), kind: Kind::Shopify, base: format!("{base}/nothing-here"), host: None }] };
    run(pool.clone(), crate::routes::http_client(), job, None).await;
    assert_eq!(snapshots(&pool, &owner, 10).await.unwrap()[0]["status"], "error", "every request failed");
    // An error snapshot answers nothing, so the older one still counts.
    assert_eq!(store_quotes(&pool, &owner, &cards).await.unwrap().iter().filter(|q| q["store"] == "pats" && q["card"] == "Sol Ring").count(), 3);

    // A catalog read only in part answers for the cards it listed; the rest are unknown, not absent.
    snapshot(&pool, &owner, "s-bc2", "black-castle", "tcgplayer_pro", None).await;
    sqlx::query("UPDATE store_snapshots SET status = 'partial', fetched_at = '2099-01-01T00:00:00Z', error = 'page 2 failed' WHERE id = 's-bc2'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO store_listings (snapshot_id, owner_id, card_name, card_key, price, available, price_kind) VALUES ('s-bc2', ?, 'Sol Ring', 'sol ring', 0.9, 1, 'from')")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    let bc = |card: &str| q.iter().filter(|x| x["store"] == "black-castle" && x["card"] == card).cloned().collect::<Vec<_>>();
    assert_eq!(bc("Sol Ring")[0]["price"], 0.9, "the newer partial catalog answers for what it listed");
    assert_eq!(bc("Fellwar Stone")[0]["origin"], "snapshot:s-bc", "and the older full catalog still answers for the rest");

    // One check that read a store directly and through YesTCG: YesTCG's answer counts, whichever
    // finished last; a listing with no copies left is out of stock.
    for (id, source, fetched) in [("s-mv-direct", "tcgplayer_pro", "2099-02-01T00:00:09Z"), ("s-mv-yes", "yestcg", "2099-02-01T00:00:05Z")] {
        snapshot(&pool, &owner, id, "multiverse-hobbies", source, if source == "yestcg" { Some(&["Sol Ring"]) } else { None }).await;
        sqlx::query("UPDATE store_snapshots SET status = 'ok', fetched_at = ?, requested_at = '2099-02-01T00:00:00Z' WHERE id = ?").bind(fetched).bind(id).execute(&pool).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO store_listings (snapshot_id, owner_id, card_name, card_key, price, available, qty, price_kind) VALUES
         ('s-mv-direct', ?1, 'Sol Ring', 'sol ring', 0.5, 1, NULL, 'from'), ('s-mv-yes', ?1, 'Sol Ring', 'sol ring', 0.75, 1, 0, 'each')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    let mv: Vec<&Value> = q.iter().filter(|x| x["store"] == "multiverse-hobbies" && x["card"] == "Sol Ring").collect();
    assert_eq!((mv.len(), &mv[0]["origin"], &mv[0]["in_stock"]), (1, &json!("snapshot:s-mv-yes"), &json!(false)), "{mv:?}");

    // A check left running by a restart shows as failed when read.
    snapshot(&pool, &owner, "s-old", "pats", "shopify", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET requested_at = '2026-01-01T00:00:00Z' WHERE id = 's-old'").execute(&pool).await.unwrap();
    let all = snapshots(&pool, &owner, 50).await.unwrap();
    assert_eq!(all.iter().find(|x| x["id"] == "s-old").unwrap()["status"], "error");

    // Someone else sees none of it.
    let (other, _) = user(&pool, "other@example.com").await;
    assert!(store_quotes(&pool, &other, &cards).await.unwrap().is_empty());
    assert!(snapshots(&pool, &other, 10).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_check_route_picks_connectors_limits_and_imports() {
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "bryan@example.com").await;
    store_row(&pool, &owner, "card-gurus", "Card Gurus", "https://example.com", 1).await;
    // Nothing to check at a store Yama can't read, and no snapshot is made.
    let (s, v) = send(&app, Method::POST, "/api/plan/stock/check", Some(&token), Some(json!({"stores": ["card-gurus"], "cards": ["Sol Ring"]}))).await;
    assert!(s.is_success(), "{v}");
    assert_eq!(v["snapshots"], json!([]));
    assert!(v["skipped"][0]["why"].as_str().unwrap().contains("import a snapshot"), "{v}");
    let (s, _) = send(&app, Method::POST, "/api/plan/stock/check", Some(&token), Some(json!({"stores": ["nowhere"]}))).await;
    assert_eq!(s.as_u16(), 400);
    let many: Vec<String> = (0..=MAX_CARDS).map(|i| format!("Card {i}")).collect();
    let (s, _) = send(&app, Method::POST, "/api/plan/stock/check", Some(&token), Some(json!({"stores": ["card-gurus"], "cards": many}))).await;
    assert_eq!(s.as_u16(), 400);

    // A running check blocks another; the daily cap counts fetched snapshots.
    snapshot(&pool, &owner, "r1", "card-gurus", "shopify", Some(&["Sol Ring"])).await;
    let (s, _) = send(&app, Method::POST, "/api/plan/stock/check", Some(&token), Some(json!({"cards": ["Sol Ring"]}))).await;
    assert_eq!(s.as_u16(), 409);
    sqlx::query("UPDATE store_snapshots SET status = 'ok', fetched_at = requested_at").execute(&pool).await.unwrap();
    for i in 0..DAILY_SNAPSHOTS {
        snapshot(&pool, &owner, &format!("d{i}"), "card-gurus", "shopify", Some(&["Sol Ring"])).await;
    }
    sqlx::query("UPDATE store_snapshots SET status = 'ok', fetched_at = requested_at").execute(&pool).await.unwrap();
    store_row(&pool, &owner, "pats", "Pat's Games", "https://patsgames.com", 2).await;
    let (s, v) = send(&app, Method::POST, "/api/plan/stock/check", Some(&token), Some(json!({"stores": ["pats"], "cards": ["Sol Ring"]}))).await;
    assert_eq!(s.as_u16(), 429, "{v}");

    // An imported snapshot (Black Castle from a browser tab) lands like a fetched one.
    let file = json!({
        "format": "yama-store-snapshot/1", "store": "pats", "source": "browser tab", "fetched_at": "2026-11-01T16:24:00Z",
        "cards": ["Sol Ring", "Mana Vault"],
        "listings": [{"card": "Sol Ring", "title": "Sol Ring [C21 - 263]", "set": "C21", "number": "263", "finish": "nonfoil", "condition": "Near Mint", "price": 1.0, "available": true, "variant": 555}],
    });
    let (s, v) = send(&app, Method::POST, "/api/plan/stock/import", Some(&token), Some(file.clone())).await;
    assert!(s.is_success(), "{v}");
    let q = store_quotes(&pool, &owner, &["Sol Ring".into(), "Mana Vault".into()]).await.unwrap();
    assert!(q.iter().any(|q| q["card"] == "Sol Ring" && q["price"] == 1.0 && q["variant"] == "555" && q["set"] == "c21"), "{q:?}");
    assert!(q.iter().any(|q| q["card"] == "Mana Vault" && q["in_stock"] == false));
    let mut bad = file.clone();
    bad["store"] = json!("nowhere");
    assert_eq!(send(&app, Method::POST, "/api/plan/stock/import", Some(&token), Some(bad)).await.0.as_u16(), 400);
    let mut bad = file.clone();
    bad["listings"][0]["price"] = json!(-1);
    assert_eq!(send(&app, Method::POST, "/api/plan/stock/import", Some(&token), Some(bad)).await.0.as_u16(), 400);
    let mut bad = file.clone();
    bad["listings"][0]["qty"] = json!(-1);
    assert_eq!(send(&app, Method::POST, "/api/plan/stock/import", Some(&token), Some(bad)).await.0.as_u16(), 400, "a quantity is never dropped");
    // A listing that doesn't say whether it's available is unknown stock.
    let mut quiet = file.clone();
    quiet["fetched_at"] = json!("2026-11-01T17:00:00Z");
    quiet["listings"][0].as_object_mut().unwrap().remove("available");
    assert!(send(&app, Method::POST, "/api/plan/stock/import", Some(&token), Some(quiet)).await.0.is_success());
    let q = store_quotes(&pool, &owner, &["Sol Ring".into()]).await.unwrap();
    assert_eq!(q.iter().find(|q| q["store"] == "pats" && q["card"] == "Sol Ring").unwrap()["in_stock"], Value::Null);

    // Another account can't import into these stores, and doesn't see the snapshots.
    let (_, other) = user(&pool, "other@example.com").await;
    assert_eq!(send(&app, Method::POST, "/api/plan/stock/import", Some(&other), Some(file)).await.0.as_u16(), 400);
    let (_, v) = send(&app, Method::GET, "/api/plan/stock", Some(&other), None).await;
    assert_eq!(v["snapshots"], json!([]));
}
