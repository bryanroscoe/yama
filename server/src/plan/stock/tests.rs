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
        // Ten products, none the card itself: the in-stock search that follows fails in the mock.
        // Full both times: the in-stock search is saturated too, and none of these is the card.
        "\"Lots\"" | "title:\"Lots\" available:true" => json!({"resources": {"results": {"products": (0..10).map(|i| json!({"title": format!("Lots More {i}"), "handle": format!("lots-{i}")})).collect::<Vec<_>>()}}}),
        "\"Popular\"" => json!({"resources": {"results": {"products": (0..10).map(|i| json!({"title": format!("Popular Things {i}"), "handle": format!("popular-things-{i}")})).collect::<Vec<_>>()}}}),
        "\"Neg\"" => json!({"resources": {"results": {"products": [{"title": "Neg [NEG - 1]", "handle": "neg-1"}]}}}),
        "\"Odd\"" => json!({"resources": {"results": {"products": [{"title": "Odd [ODD - 1]", "handle": "odd-1"}]}}}),
        "\"Untitled\"" => json!({"resources": {"results": {"products": [{"title": "Untitled [U - 1]", "handle": "untitled-1"}]}}}),
        "\"Many\"" => json!({"resources": {"results": {"products": (0..10).map(|i| json!({"title": format!("Many Things {i}"), "handle": format!("many-{i}")})).collect::<Vec<_>>()}}}),
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
        // Variants without availability: unreadable, so the card is unknown.
        "popular-things-0.js" => json!({"title": "Popular Things 0", "variants": []}),
        "popular-a.js" => json!({"title": "Popular [PP - 1]", "variants": [{"id": 7, "title": "Near Mint / English / Normal", "price": 50, "available": true}]}),
        "popular-b.js" => json!({"title": "Popular [PP - 2]", "variants": [{"id": 8, "title": "Near Mint / English / Normal", "price": 30, "available": false}]}),
        // A negative price is no price: unreadable.
        "neg-1.js" => json!({"title": "Neg [NEG - 1]", "variants": [{"id": 9, "title": "Near Mint", "price": -100, "available": true}]}),
        "untitled-1.js" => json!({"title": "", "variants": [{"id": 2, "title": "Near Mint", "price": 100, "available": true}]}),
        "odd-1.js" => json!({"title": "Odd [ODD - 1]", "variants": [{"id": 1, "title": "Near Mint", "price": 100}]}),
        "fellwar-stone-drk.js" => json!({"title": "Fellwar Stone [DRK - 103]", "variants": [
            {"id": 131, "title": "Damaged / English / Normal", "price": 975, "available": false},
        ]}),
        _ => return None,
    })
}

fn catalog() -> Value {
    json!({"filters": [], "products": {"totalItems": 4, "items": [
        {"id": 1, "name": "Sol Ring", "lowestPrice": 1.25, "setName": "Commander Masters", "setUrlName": "commander-masters", "productUrlName": "sol-ring", "productLineName": "Magic: The Gathering"},
        {"id": 2, "name": "Exotic Orchard (Borderless)", "lowestPrice": 0.5, "setName": "Foundations", "setUrlName": "foundations", "productUrlName": "exotic-orchard-borderless", "productLineName": "Magic: The Gathering"},
        {"id": 3, "name": "Shared Roots", "lowestPrice": null, "setName": "Mystical Archive", "productLineName": "Magic: The Gathering"},
        {"id": 4, "name": "Fellwar Stone (Japanese)", "lowestPrice": 0.1, "setName": "Promos", "productLineName": "Magic: The Gathering"},
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
        .route(
            "/search",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                let page: usize = q["page"].parse().unwrap();
                match q["q"].as_str() {
                    // The search pages fail: the card is unknown.
                    "\"Many\"" => Err(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
                    // Every page adds more: past the page cap, the card is unknown.
                    "\"Lots\"" => Ok(axum::response::Html(format!("<a href=\"/products/lots-p{page}-a\">x</a>"))),
                    // Page 1 repeats a suggestion (popthing), page 2 adds two printings (one in
                    // stock), page 3 repeats page 2: complete.
                    "\"Popular\"" => Ok(axum::response::Html(match page {
                        1 => "<a href=\"/products/popular-things-0\">x</a> <a href=\"/products/other-thing\">c</a>".to_string(),
                        _ => "<a href=\"/products/popular-a\">a</a> <a href=\"/products/popular-b?variant=8\">b</a>".to_string(),
                    })),
                    _ => Ok(axum::response::Html(String::new())),
                }
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
    assert_eq!(title_name("Sol Ring - Foil"), "Sol Ring", "a variant suffix isn't part of the name");
    assert_eq!(variant_parts("Near Mint / JP / Normal").1.as_deref(), Some("Japanese"), "an abbreviated language");
    assert_eq!(set_and_number("Sol Ring [C21 - 263]"), (Some("c21".into()), Some("263".into())));
    assert_eq!(set_and_number("Sol Ring [Commander Masters]"), (None, None));
    assert_eq!(variant_parts("Near Mint / English / Foil"), (Some("Near Mint".into()), Some("English".into()), "foil"));
    assert_eq!(variant_parts("Lightly Played / Japanese / Normal"), (Some("Lightly Played".into()), Some("Japanese".into()), "nonfoil"));
    assert_eq!(variant_parts("Normal / Near Mint"), (Some("Near Mint".into()), None, "nonfoil"));
    assert_eq!(variant_parts("Foil / Near Mint"), (Some("Near Mint".into()), None, "foil"));
    assert_eq!(title_finish("Sol Ring (Foil)"), Some("foil"));
    assert_eq!(title_finish("Sol Ring [Etched Foil]"), Some("etched"));
    assert_eq!(title_finish("Sol Ring (Non-Foil)"), None);
    assert_eq!(title_finish("Foilborn Sprite"), None, "a word in the name isn't a finish");
    assert_eq!(title_finish("Etched Champion [SOM - 6]"), None, "nor is a whole word of the card's name");
    assert_eq!(title_finish("Etched Champion [SOM - 6] - Near Mint Foil"), Some("foil"), "a variant suffix is");
    assert_eq!(title_finish("MTG - Etched Champion"), None, "nor a store's prefix");
    assert_eq!(title_finish("Sol Ring - Foil [C21 - 263]"), Some("foil"), "a qualifier before the set");
    assert_eq!(title_language("Sol Ring - Japanese [C21 - 263]").as_deref(), Some("Japanese"));
    assert_eq!(title_language("Sol Ring (Japanese)").as_deref(), Some("Japanese"));
    assert_eq!(title_language("Sol Ring [C21 - 263] (JP)").as_deref(), Some("Japanese"));
    assert_eq!(title_language("Sol Ring [C21 - 263]"), None, "a set code isn't a language");
    assert_eq!(title_language("Sol Ring (Borderless)"), None);
    assert_eq!(card_key("Brazen Borrower // Petty Theft"), "brazen borrower");
    assert_eq!(card_key("  Urza’s  Saga "), "urza's saga");

    let (n, found) = shopify_suggest(&suggest("\"Sol Ring\""), "Sol Ring").unwrap();
    assert_eq!(shopify_suggest(&json!({"errors": "nope"}), "Sol Ring"), None, "an unreadable answer isn't \"none found\"");
    assert_eq!(shopify_suggest(&json!({"resources": {"results": {"products": [{"title": "Sol Ring [C21 - 263]"}]}}}), "Sol Ring"), None, "a product without a handle");
    assert_eq!(
        search_page_handles("<a href=\"/products/sol-ring-c21?x=1\"></a><a href=\"/products/sol-ring-c21\"></a><a href=\"/products/mana-crypt\"></a><a href=\"/products/urzas-saga-mh2\"></a>", "Sol Ring"),
        ["sol-ring-c21"]
    );
    assert_eq!(search_page_handles("<a href=\"/products/urzas-saga-mh2\">", "Urza’s Saga"), ["urzas-saga-mh2"]);
    assert_eq!(n, 4);
    assert_eq!(found.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["sol-ring-c21-263", "sol-ring-etched-cmm-410"]);
    let l = shopify_product(&product("sol-ring-c21-263.js").unwrap(), "Sol Ring", "https://patsgames.com", "sol-ring-c21-263");
    assert_eq!(l.len(), 4);
    assert!(l[0].url.as_deref().unwrap().ends_with("?variant=111"));
    assert!(l[1].url.as_deref().unwrap().ends_with("?variant=112"));
    assert_eq!((l[0].price, l[0].finish, l[0].variant.as_deref(), l[0].set_code.as_deref()), (Some(1.5), Some("nonfoil"), Some("111"), Some("c21")));
    assert_eq!(l[1].finish, Some("foil"));
    let etched = shopify_product(&product("sol-ring-etched-cmm-410.js").unwrap(), "Sol Ring", "https://patsgames.com", "x");
    assert_eq!(etched[0].finish, Some("etched"), "the product title says etched");

    let (total, l) = pro_catalog(&catalog(), "https://bc.tcgplayerpro.com").unwrap();
    assert!(pro_catalog(&json!({"products": {}}), "https://bc.tcgplayerpro.com").is_none(), "an unreadable answer isn't an empty catalog");
    assert!(pro_catalog(&json!({"products": {"totalItems": 1, "items": [{"id": 1, "lowestPrice": 1.0}]}}), "https://bc.tcgplayerpro.com").is_none(), "a product without a name");
    assert!(pro_catalog(&json!({"products": {"totalItems": 1, "items": [{"name": "Sol Ring", "lowestPrice": -1.0}]}}), "https://bc.tcgplayerpro.com").is_none(), "a negative price");
    assert!(pro_catalog(&json!({"products": {"totalItems": -1, "items": []}}), "https://bc.tcgplayerpro.com").is_none(), "a negative total");
    assert!(pro_catalog(&json!({"products": {"totalItems": 0, "items": [{"name": "Sol Ring"}]}}), "https://bc.tcgplayerpro.com").is_none(), "more products than the total");
    assert!(pro_catalog(&json!({"products": {"totalItems": 1, "items": [{"name": " "}]}}), "https://bc.tcgplayerpro.com").is_none(), "a blank name");
    assert!(pro_catalog(&json!({"products": {"totalItems": 1, "items": [{"name": "Sol Ring", "lowestPrice": "1.00"}]}}), "https://bc.tcgplayerpro.com").is_none(), "a price that isn't a number");
    assert_eq!((total, l.len()), (4, 4));
    assert_eq!(l[3].language.as_deref(), Some("Japanese"));
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
    let nameless = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": [{"price": 1.0, "condition": "Near Mint"}]}]});
    let no_condition = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": [{"name": "Sol Ring", "price": 1.0}]}]});
    assert_eq!(yestcg_store(&no_condition, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "a hit without a condition is unknown");
    let blank = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": [{"name": "Sol Ring", "condition": " ", "price": 1.0}]}]});
    assert_eq!(yestcg_store(&blank, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "a blank condition is unknown");
    let l = shopify_product(&json!({"title": "Sol Ring [C21 - 263]", "variants": [{"id": 5, "title": "", "public_title": "Near Mint / Japanese / Foil", "price": 100, "available": true}]}), "Sol Ring", "https://x", "h");
    assert_eq!((l[0].finish, l[0].language.as_deref()), (Some("foil"), Some("Japanese")), "a blank title falls back to public_title");
    let negative = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": [{"name": "Sol Ring", "condition": "Near Mint", "price": -2.0}]}]});
    assert_eq!(yestcg_store(&negative, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "a negative price is unknown");
    assert_eq!(yestcg_store(&nameless, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "a hit without a name is unknown");
    let bad_qty = json!({"results": [{"store": "M", "base": "https://mversetcg.tcgplayerpro.com", "ok": true, "hits": [{"name": "Sol Ring", "condition": "Near Mint", "price": 1.0, "qty": "3"}]}]});
    assert_eq!(yestcg_store(&bad_qty, "mversetcg.tcgplayerpro.com", "Sol Ring"), Some(None), "a quantity that isn't a whole number is unknown");
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
    let cards: Vec<String> = ["Sol Ring", "Fellwar Stone", "Fail Me", "Exotic Orchard", "Many", "Lots", "Odd", "Untitled", "Popular", "Neg"].map(String::from).to_vec();
    let refs: Vec<&str> = cards.iter().map(String::as_str).collect();
    snapshot(&pool, &owner, "s-pats", "pats", "shopify", Some(&refs)).await;
    snapshot(&pool, &owner, "s-bc", "black-castle", "tcgplayer_pro", None).await;
    snapshot(&pool, &owner, "s-mv", "multiverse-hobbies", "yestcg", Some(&refs)).await;
    snapshot(&pool, &owner, "s-mv2", "multiverse-too", "yestcg", Some(&refs)).await;
    let t = |id: &str, store: &str, kind: Kind, host: Option<&str>| Target { snapshot: id.into(), store: store.into(), kind, base: base.clone(), host: host.map(String::from) };
    let job = Job { refresh_catalog: false,
        owner: owner.clone(),
        cards: cards.clone(),
        targets: vec![t("s-pats", "pats", Kind::Shopify, None), t("s-bc", "black-castle", Kind::Pro, None), t("s-mv", "multiverse-hobbies", Kind::YesTcg, Some("mversetcg.tcgplayerpro.com")), t("s-mv2", "multiverse-too", Kind::YesTcg, Some("mversetcg.tcgplayerpro.com"))],
    };
    run(pool.clone(), crate::routes::http_client(), job, None).await;

    let snaps = snapshots(&pool, &owner, 10).await.unwrap();
    let by = |s: &str| snaps.iter().find(|x| x["id"] == s).unwrap().clone();
    // Pat's: Fail Me couldn't be read, so it's partial; only available variants are kept.
    assert_eq!(by("s-pats")["status"], "partial", "{snaps:?}");
    assert_eq!(by("s-pats")["failed"], 6, "Fail Me; Many, whose search pages failed; Lots, past the page cap; Odd, unreadable variants; Untitled, no title; Neg, a negative price");
    assert_eq!(by("s-pats")["listings"], 5, "three available Sol Ring variants, the etched one, and Popular's one in stock");
    assert!(by("s-pats")["raw"] == true);
    assert_eq!(by("s-bc")["status"], "ok");
    assert_eq!(by("s-bc")["listings"], 4);
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
    assert!(at("pats", "Many").is_empty(), "a failed follow-up search leaves the card unknown");
    assert!(at("pats", "Lots").is_empty(), "more printings than Yama reads leaves the card unknown");
    assert!(at("pats", "Neg").is_empty());
    // Suggest was full, so the search pages found both printings; the one in stock is the answer.
    let popular = at("pats", "Popular");
    assert_eq!((popular.len(), popular[0]["price"].as_f64(), popular[0]["set"].as_str()), (1, Some(0.5), Some("pp")), "{popular:?}");
    // Black Castle's catalog: Exotic Orchard "from" its lowest price, Fellwar Stone not in the catalog.
    let orchard = at("black-castle", "Exotic Orchard");
    assert_eq!((orchard[0]["price"].as_f64(), orchard[0]["in_stock"].as_bool()), (Some(0.5), Some(true)));
    assert!(orchard[0]["result"].as_str().unwrap().contains("lowest listed price"));
    assert_eq!(at("black-castle", "Fellwar Stone")[0]["result"], "Not in the store's catalog");
    // Multiverse through YesTCG, with quantities.
    assert!(at("multiverse-hobbies", "Sol Ring").iter().any(|q| q["result"].as_str().unwrap().contains("3 in stock")));
    // A second store with the same homepage gets the same answer.
    assert!(at("multiverse-too", "Sol Ring").iter().any(|q| q["result"].as_str().unwrap().contains("3 in stock")));
    assert_eq!(at("multiverse-too", "Sol Ring").len(), at("multiverse-hobbies", "Sol Ring").len(), "and not twice over");
    assert_eq!(by("s-mv")["listings"], 2);

    // A newer snapshot of the same store supersedes the older one for the cards it covers only.
    snapshot(&pool, &owner, "s-pats2", "pats", "shopify", Some(&["Sol Ring"])).await;
    let job = Job { refresh_catalog: false, owner: owner.clone(), cards: vec!["Sol Ring".into()], targets: vec![Target { snapshot: "s-pats2".into(), store: "pats".into(), kind: Kind::Shopify, base: format!("{base}/nothing-here"), host: None }] };
    run(pool.clone(), crate::routes::http_client(), job, None).await;
    assert_eq!(snapshots(&pool, &owner, 10).await.unwrap()[0]["status"], "error", "every request failed");
    // An error snapshot answers nothing, so the older one still counts.
    assert_eq!(store_quotes(&pool, &owner, &cards).await.unwrap().iter().filter(|q| q["store"] == "pats" && q["card"] == "Sol Ring").count(), 3);

    // A catalog read only in part answers for nothing; the older full catalog still counts.
    snapshot(&pool, &owner, "s-bc2", "black-castle", "tcgplayer_pro", None).await;
    sqlx::query("UPDATE store_snapshots SET status = 'partial', fetched_at = '2099-01-01T00:00:00Z', error = 'page 2 failed' WHERE id = 's-bc2'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO store_listings (snapshot_id, owner_id, card_name, card_key, price, available, price_kind) VALUES ('s-bc2', ?, 'Sol Ring', 'sol ring', 0.9, 1, 'from')")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    let bc = |card: &str| q.iter().filter(|x| x["store"] == "black-castle" && x["card"] == card).cloned().collect::<Vec<_>>();
    assert_eq!(bc("Sol Ring")[0]["origin"], "snapshot:s-bc", "a page not read may hold a cheaper printing");
    assert_eq!(bc("Fellwar Stone")[0]["origin"], "snapshot:s-bc");

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

    // Another store in the same check finishing later doesn't make this store's read newer.
    for (id, store, fetched) in [("s-x1", "multiverse-hobbies", "2099-05-01T10:01:00Z"), ("s-x2", "black-castle", "2099-05-01T10:10:00Z")] {
        snapshot(&pool, &owner, id, store, "tcgplayer_pro", None).await;
        sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2099-05-01T10:00:00Z', fetched_at = ?, check_id = 'cx' WHERE id = ?").bind(fetched).bind(id).execute(&pool).await.unwrap();
    }
    snapshot(&pool, &owner, "s-ximp", "multiverse-hobbies", "import", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2099-05-01T10:05:00Z', fetched_at = '2099-05-01T10:05:00Z' WHERE id = 's-ximp'").execute(&pool).await.unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    assert_eq!(q.iter().find(|x| x["store"] == "multiverse-hobbies" && x["card"] == "Sol Ring").unwrap()["origin"], "snapshot:s-ximp");
    sqlx::query("DELETE FROM store_snapshots WHERE id IN ('s-x1', 's-x2', 's-ximp')").execute(&pool).await.unwrap();

    // A check that finished after an import counts over it, even though it was asked for first.
    snapshot(&pool, &owner, "s-late", "multiverse-hobbies", "tcgplayer_pro", None).await;
    sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2099-03-01T10:00:00Z', fetched_at = '2099-03-01T10:10:00Z' WHERE id = 's-late'").execute(&pool).await.unwrap();
    snapshot(&pool, &owner, "s-imp", "multiverse-hobbies", "import", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2099-03-01T10:05:00Z', fetched_at = '2099-03-01T10:05:00Z' WHERE id = 's-imp'").execute(&pool).await.unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    assert_eq!(q.iter().find(|x| x["store"] == "multiverse-hobbies" && x["card"] == "Sol Ring").unwrap()["origin"], "snapshot:s-late");

    // Two checks started in the same second stay apart by their check ids: the newer direct read
    // counts over an older YesTCG one.
    for (id, source, check, fetched) in [("s-c1", "yestcg", "c1", "2099-04-01T00:00:02Z"), ("s-c2", "tcgplayer_pro", "c2", "2099-04-01T00:00:09Z")] {
        snapshot(&pool, &owner, id, "multiverse-hobbies", source, if source == "yestcg" { Some(&["Sol Ring"]) } else { None }).await;
        sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2099-04-01T00:00:00Z', fetched_at = ?, check_id = ? WHERE id = ?").bind(fetched).bind(check).bind(id).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO store_listings (snapshot_id, owner_id, card_name, card_key, price, available, price_kind) VALUES ('s-c2', ?, 'Sol Ring', 'sol ring', 0.4, 1, 'from')").bind(&owner).execute(&pool).await.unwrap();
    let q = store_quotes(&pool, &owner, &cards).await.unwrap();
    assert_eq!(q.iter().find(|x| x["store"] == "multiverse-hobbies" && x["card"] == "Sol Ring").unwrap()["origin"], "snapshot:s-c2");

    // A check left running by a restart shows as failed when read.
    snapshot(&pool, &owner, "s-old", "pats", "shopify", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET requested_at = '2026-01-01T00:00:00Z' WHERE id = 's-old'").execute(&pool).await.unwrap();
    // One this server is still fetching stays running, however long it takes.
    snapshot(&pool, &owner, "s-long", "pats", "shopify", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET requested_at = '2026-01-01T00:00:00Z' WHERE id = 's-long'").execute(&pool).await.unwrap();
    active().lock().unwrap().insert("s-long".into());
    let all = snapshots(&pool, &owner, 50).await.unwrap();
    assert_eq!(all.iter().find(|x| x["id"] == "s-old").unwrap()["status"], "error");
    assert_eq!(all.iter().find(|x| x["id"] == "s-long").unwrap()["status"], "running");
    active().lock().unwrap().remove("s-long");

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

#[tokio::test]
async fn a_staged_check_applied_again_reads_nothing() {
    let st = crate::testutil::state().await;
    let (owner, _) = user(&st.pool, "bryan@example.com").await;
    store_row(&st.pool, &owner, "pats", "Pat's Games", "https://patsgames.com", 1).await;
    snapshot(&st.pool, &owner, "s-done", "pats", "shopify", Some(&["Sol Ring"])).await;
    sqlx::query("UPDATE store_snapshots SET status = 'ok', fetched_at = requested_at, change_id = 'chg-1' WHERE id = 's-done'").execute(&st.pool).await.unwrap();
    let body = CheckBody { stores: Some(vec!["pats".into()]), cards: Some(vec!["Sol Ring".into()]), yestcg: false, refresh_catalog: false };
    let again = start(&st, &owner, &body, "assistant", Some("chg-1")).await.unwrap();
    assert_eq!(again["already"], true);
    assert_eq!(again["snapshots"][0]["id"], "s-done");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ?").bind(&owner).fetch_one(&st.pool).await.unwrap();
    assert_eq!(n, 1, "nothing new was started");
}

#[tokio::test]
async fn pruning_keeps_the_days_reads_so_the_cap_holds() {
    let st = crate::testutil::state().await;
    let (owner, _) = user(&st.pool, "bryan@example.com").await;
    store_row(&st.pool, &owner, "pats", "Pat's Games", "https://patsgames.com", 1).await;
    for i in 0..(DAILY_SNAPSHOTS + 3) {
        let id = format!("p{i:02}");
        snapshot(&st.pool, &owner, &id, "pats", "shopify", Some(&["Sol Ring"])).await;
        sqlx::query("UPDATE store_snapshots SET status = 'ok', fetched_at = requested_at WHERE id = ?").bind(&id).execute(&st.pool).await.unwrap();
    }
    // An old one past the newest 20 goes; today's all stay, and so does one a pending change started.
    for id in ["old", "old-pending"] {
        snapshot(&st.pool, &owner, id, "pats", "shopify", Some(&["Sol Ring"])).await;
        sqlx::query("UPDATE store_snapshots SET status = 'ok', requested_at = '2026-01-01T00:00:00Z', fetched_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(id).execute(&st.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO assistant_changes (id, owner_id, kind, summary, payload, via, created_at) VALUES ('chg-p', ?, 'check_stores', 's', '{}', 'key', 'now')")
        .bind(&owner)
        .execute(&st.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_snapshots SET change_id = 'chg-p' WHERE id = 'old-pending'").execute(&st.pool).await.unwrap();
    let mut tx = st.pool.begin().await.unwrap();
    prune(&mut tx, &owner, "pats").await.unwrap();
    tx.commit().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ?").bind(&owner).fetch_one(&st.pool).await.unwrap();
    assert_eq!(n, DAILY_SNAPSHOTS + 4, "the day's reads and the pending change's read stay; the other old one goes");
    let body = CheckBody { stores: Some(vec!["pats".into()]), cards: Some(vec!["Sol Ring".into()]), yestcg: false, refresh_catalog: false };
    assert!(matches!(start(&st, &owner, &body, "page", None).await, Err(AppError::TooManyRequests { .. })));
}

#[tokio::test]
async fn store_answers_are_shared_between_checks_and_retry_after_is_honoured() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let challenges = std::sync::Arc::new(AtomicUsize::new(0));
    let challenged = challenges.clone();
    let app = Router::new()
        .route(
            "/data",
            get(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"products": []}))
                }
            }),
        )
        .route(
            "/challenge",
            get(move || {
                let challenged = challenged.clone();
                async move {
                    challenged.fetch_add(1, Ordering::SeqCst);
                    "<html>Just a moment...</html>"
                }
            }),
        )
        .route("/busy", get(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "600")], "") }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let http = crate::routes::http_client();
    // Two people's checks: one request, and the second records the answer as shared.
    let (mut raw_a, mut raw_b) = (Raw::default(), Raw::default());
    let url = format!("{base}/data");
    assert_eq!(Fetcher::new(http.clone(), None).send(Kind::Shopify, "GET", &url, None, &mut raw_a).await.unwrap(), json!({"products": []}));
    assert_eq!(Fetcher::new(http.clone(), None).send(Kind::Shopify, "GET", &url, None, &mut raw_b).await.unwrap(), json!({"products": []}));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(raw_b.items[0]["shared"], true);
    // A 200 that isn't the JSON asked for (a bot challenge) is never shared: each check asks.
    let url = format!("{base}/challenge");
    for _ in 0..2 {
        assert!(Fetcher::new(http.clone(), None).send(Kind::Shopify, "GET", &url, None, &mut raw_a).await.is_err());
    }
    assert_eq!(challenges.load(Ordering::SeqCst), 2);
    // Nor is a search page with nothing on it, which looks just like one.
    let mut f = Fetcher::new(http.clone(), None);
    f.page(Kind::Shopify, &url, &mut raw_a).await.unwrap();
    f.page(Kind::Shopify, &url, &mut raw_a).await.unwrap();
    assert_eq!(challenges.load(Ordering::SeqCst), 4);
    // A store that asks for ten minutes isn't waited out inside a check.
    let started = Instant::now();
    let err = Fetcher::new(http.clone(), None).page(Kind::Shopify, &format!("{base}/busy"), &mut raw_a).await.unwrap_err();
    assert!(err.contains("wait 600 s"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // ...and the next check, any account's, stops without asking again for the whole ten minutes.
    let asked = raw_a.items.len();
    let err = Fetcher::new(http, None).send(Kind::Shopify, "GET", &format!("{base}/data2"), None, &mut raw_a).await.unwrap_err();
    assert!(err.contains("wait 5") || err.contains("wait 6"), "{err}");
    assert_eq!(raw_a.items.len(), asked, "no request was made");
}

#[tokio::test]
async fn a_check_queued_behind_a_429_sends_nothing() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let (h1, h2) = (hits.clone(), hits.clone());
    let app = Router::new()
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "600")], "")
            }),
        )
        .route(
            "/after",
            get(move || {
                let h = h1.clone();
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    Json(json!({}))
                }
            }),
        )
        .route(
            "/",
            get(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "5")], "") }),
        )
        .route(
            "/api/decksearch",
            get(move || {
                let h = h2.clone();
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    Json(json!({}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let http = crate::routes::http_client();
    // Check A holds the store's lock while it waits for an answer, which turns out to be a 429...
    let (http_a, slow) = (http.clone(), format!("{base}/slow"));
    let a = tokio::spawn(async move { Fetcher::new(http_a, None).send(Kind::Shopify, "GET", &slow, None, &mut Raw::default()).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    // ...and check B, already queued behind it, sends nothing once it's told.
    let err = Fetcher::new(http.clone(), None).send(Kind::Shopify, "GET", &format!("{base}/after"), None, &mut Raw::default()).await.unwrap_err();
    assert!(err.contains("wait"), "{err}");
    assert!(a.await.unwrap().is_err());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn yestcg_answering_its_cookie_request_with_429_stops_the_check() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let app = Router::new()
        .route("/", get(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "5")], "") }))
        .route(
            "/api/decksearch",
            get(move || {
                let h = h.clone();
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    Json(json!({}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut f = Fetcher::new(crate::routes::http_client(), None);
    let cards = vec!["Sol Ring".to_string()];
    let hosts = vec!["store.example".to_string()];
    let found = fetch_yestcg(&mut f, &base, &cards, &hosts, &mut Raw::default()).await;
    let store = &found["store.example"];
    assert!(store.errors.iter().any(|e| e.contains("wait 5 s")), "{:?}", store.errors);
    assert_eq!(store.failed, cards);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_429_without_retry_after_still_holds_the_store() {
    let app = Router::new().route("/unsaid", get(|| async { axum::http::StatusCode::TOO_MANY_REQUESTS }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let url = format!("{base}/unsaid");
    let (http, u) = (crate::routes::http_client(), url.clone());
    // The check gets its 429, then waits out the hold before trying again; stop it there.
    let check = tokio::spawn(async move { Fetcher::new(http, None).send(Kind::Shopify, "GET", &u, None, &mut Raw::default()).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    check.abort();
    let left = held(&host_of(&url).unwrap());
    assert!(left > Duration::from_secs(50) && left <= UNSAID_HOLD, "{left:?}");
}

#[tokio::test]
async fn checks_queued_for_the_same_answer_share_one_request() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let app = Router::new().route(
        "/slow",
        get(move || {
            let h = h.clone();
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(200)).await;
                Json(json!({"products": []}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let http = crate::routes::http_client();
    let url = format!("{base}/slow");
    // Three checks ask at once; the store's lock queues them, and the two behind the first
    // find its answer when their turn comes.
    let ask = || {
        let (http, url) = (http.clone(), url.clone());
        tokio::spawn(async move { Fetcher::new(http, None).send(Kind::Shopify, "GET", &url, None, &mut Raw::default()).await.unwrap() })
    };
    let (a, b, c) = (ask(), ask(), ask());
    for answer in [a.await.unwrap(), b.await.unwrap(), c.await.unwrap()] {
        assert_eq!(answer, json!({"products": []}));
    }
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[test]
fn variant_selected_low_stock_counts() {
    let page = r#"<form id="product-form-main"><input name="id" value="123"></form><div id="Inventory-main"><svg></svg>Low stock! Only 1 left</div>"#;
    assert_eq!(shopify_variant_quantity(page, "123"), Some(1));
    assert_eq!(shopify_variant_quantity(&format!("<div><div>{page}</div></div>"), "123"), Some(1));
    assert_eq!(shopify_variant_quantity(page, "456"), None);
    assert_eq!(shopify_variant_quantity(&page.replace("Only 1 left", "In stock"), "123"), None);
    assert_eq!(shopify_variant_quantity(&page.replace("Only 1 left", "Only 2 left"), "123"), Some(2));
    assert_eq!(shopify_variant_quantity(&page.replace("Only 1 left", "4 in stock"), "123"), Some(4));
    assert_eq!(shopify_variant_quantity(&page.replace("Inventory-main", "Inventory-other"), "123"), None);
    assert_eq!(shopify_variant_quantity(r#"<div class="product-card">Only 1 left</div>"#, "123"), None);
    assert_eq!(shopify_variant_quantity(&format!("{page}{page}"), "123"), None);
}

#[tokio::test]
async fn cached_prices_keep_their_date_while_new_quantity_checks_take_precedence() {
    let (_,pool)=app().await;
    let (owner,_)=user(&pool,"reader@example.com").await;
    let price_date="2026-11-01T00:00:00Z";
    for (id,qty,date) in [("z-old",1,"2026-11-10T00:00:00Z"),("a-new",2,"2026-11-11T00:00:00Z")] {
        snapshot(&pool,&owner,id,"pats","shopify",Some(&["Sol Ring"])).await;
        let listing=Listing {card:"Sol Ring".into(),qty:Some(qty),quantity_checked_at:Some(date.into()),price:Some(1.75),available:Some(true),..Default::default()};
        let found=Found {listings:vec![listing],cached_at:Some(price_date.into()),..Default::default()};
        finish(&pool,&owner,id,&found,Some(1),None).await.unwrap();
        let completed:String=sqlx::query_scalar("SELECT fetched_at FROM store_snapshots WHERE id=?").bind(id).fetch_one(&pool).await.unwrap();
        assert_ne!(completed,price_date);
        sqlx::query("UPDATE store_snapshots SET fetched_at=?,check_id=? WHERE id=?").bind(date).bind(id).bind(id).execute(&pool).await.unwrap();
    }
    let quotes=store_quotes(&pool,&owner,&["Sol Ring".into()]).await.unwrap();
    assert_eq!(quotes[0]["qty"],2);
    assert_eq!(quotes[0]["checked"],price_date);
    assert_eq!(quotes[0]["quantity_checked_at"],"2026-11-11T00:00:00Z");
}

#[test]
fn a_cached_sold_out_variant_can_restock_without_a_catalog_refresh() {
    let cached=json!({"title":"Card A [Set]","variants":[{"id":123,"title":"Near Mint / English / Normal","price":175,"available":false},{"id":456,"title":"Near Mint / English / Foil","price":200,"available":true}]});
    let mut listings=shopify_product(&cached,"Card A","https://mothershipatx.com","card-a");
    assert!(refresh_variant_availability(&mut listings,&json!({"variants":[{"id":123,"available":true},{"id":456,"available":false}]})));
    let selected:Vec<_>=listings.iter().filter(|l|l.available==Some(true)).collect();
    assert_eq!(selected.len(),1);assert_eq!(selected[0].variant.as_deref(),Some("123"));
    assert_eq!(selected[0].price,Some(1.75));
    let html=r#"<form id="product-form-main"><input name="id" value="123"></form><div id="Inventory-main">Only 1 left</div>"#;
    assert_eq!(shopify_variant_quantity(html,"123"),Some(1));
    assert!(!refresh_variant_availability(&mut listings,&json!({"variants":[{"id":123,"available":true}]})),"a truncated answer is not proof another variant is sold out");
    assert!(!refresh_variant_availability(&mut listings,&json!({"variants":[{"id":123,"available":true},{"id":123,"available":false}]})));
}

#[test]
fn failed_catalog_only_refresh_is_an_error_even_without_requested_cards() {
    let failed=Found {errors:vec!["catalog fetch failed; previous cache preserved".into()],..Default::default()};
    assert_eq!(status_of(&failed,Some(0)),"error");
    assert_eq!(status_of(&Found::default(),Some(0)),"ok","an empty successful catalog refresh is valid");
    let partial=Found {errors:vec!["one card failed".into()],failed:vec!["Card A".into()],..Default::default()};
    assert_eq!(status_of(&partial,Some(2)),"partial","a mixed card check still reports partial coverage");
}

#[tokio::test]
async fn duplicate_printing_failures_preserve_the_other_cards_valid_quote() {
    let (_,pool)=app().await;
    let (owner,_)=user(&pool,"reader@example.com").await;
    snapshot(&pool,&owner,"partial-printings","pats","shopify",Some(&["Card A","Card B"])).await;
    let found=Found {
        failed:vec!["Card A".into()," card a ".into()],
        errors:vec!["printing one failed".into(),"printing two failed".into()],
        listings:vec![Listing {card:"Card B".into(),price:Some(0.5),qty:Some(1),available:Some(true),..Default::default()}],
        ..Default::default()
    };
    finish(&pool,&owner,"partial-printings",&found,Some(2),None).await.unwrap();
    let (status,failed):(String,String)=sqlx::query_as("SELECT status,failed FROM store_snapshots WHERE id='partial-printings'").fetch_one(&pool).await.unwrap();
    assert_eq!(status,"partial");assert_eq!(serde_json::from_str::<Value>(&failed).unwrap(),json!(["Card A"]));
    let quotes=store_quotes(&pool,&owner,&["Card A".into(),"Card B".into()]).await.unwrap();
    assert_eq!(quotes.len(),1);assert_eq!(quotes[0]["card"],"Card B");assert_eq!(quotes[0]["qty"],1);
}

/// Shopify refuses `/products.json` for some stores (Mothership and Pat's answered every request
/// with 429 on 2026-11-12, even the first). The refresh asks once, not three times, and the
/// cards still get their own search.
#[tokio::test]
async fn a_refused_catalog_is_asked_once_and_the_cards_are_still_searched() {
    let (_, pool) = app().await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = calls.clone();
    let app = Router::new()
        .route(
            "/products.json",
            get(move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    (axum::http::StatusCode::TOO_MANY_REQUESTS, [("retry-after", "1")], "")
                }
            }),
        )
        .route("/search/suggest.json", get(|Query(q): Query<HashMap<String, String>>| async move { Json(suggest(&q["q"])) }))
        .route("/products/{h}", get(|AxPath(h): AxPath<String>| async move { product(&h).map(Json).ok_or(axum::http::StatusCode::NOT_FOUND) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut f = Fetcher::new(reqwest::Client::new(), None);
    let found = fetch_shopify_catalog(&pool, &mut f, &base, &["Sol Ring".into()], true, "9999", &mut Raw::default()).await;
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "a refused catalog isn't asked again");
    assert!(found.errors[0].starts_with("Catalog unavailable") && found.errors[0].contains("each card was searched instead"), "{:?}", found.errors);
    assert!(found.failed.is_empty(), "{:?}", found.failed);
    assert!(found.listings.iter().any(|l| l.card == "Sol Ring" && l.available == Some(true)));
    assert!(!f.first_429, "the catalog's give-up-at-once setting doesn't outlive it");
    let only = fetch_shopify_catalog(&pool, &mut f, &base, &[], true, "9999", &mut Raw::default()).await;
    assert_eq!(status_of(&only, Some(0)), "error", "a catalog-only refresh that was refused is still an error");
    server.abort();
}

/// Shapes copied from real Storefront API answers (Mothership and Pat's, 2026-11-13).
fn storefront_answer(q: &str, after: Option<&str>) -> Value {
    let variant = |id: u64, options: &str, price: &str, available: bool| json!({"id": format!("gid://shopify/ProductVariant/{id}"), "title": options, "availableForSale": available, "price": {"amount": price}});
    let product = |title: &str, handle: &str, vendor: &str, variants: Vec<Value>| json!({"title": title, "handle": handle, "vendor": vendor, "variants": {"pageInfo": {"hasNextPage": false}, "nodes": variants}});
    let page = |next: Option<&str>, nodes: Vec<Value>| json!({"data": {"search": {"pageInfo": {"hasNextPage": next.is_some(), "endCursor": next}, "nodes": nodes}}});
    match (q, after) {
        ("title:\"Path to Exile\"", None) => page(
            Some("page-2"),
            vec![
                product(
                    "Path to Exile [Assassin's Creed]",
                    "path-to-exile-assassins-creed",
                    "Assassin's Creed",
                    vec![variant(48711641858216, "Near Mint", "1.5", true), variant(48711642087592, "Near Mint Foil", "1.75", true), variant(48711641890984, "Lightly Played", "1.25", false)],
                ),
                // A hit that isn't a product, and another card's product.
                json!({}),
                product("Path to Exile Token", "path-to-exile-token", "Tokens", vec![variant(1, "Near Mint", "0.25", true)]),
            ],
        ),
        ("title:\"Path to Exile\"", Some("page-2")) => {
            page(None, vec![product("Path to Exile [MFP - 1]", "path-to-exile-magicfest-cards-207337", "MagicFest Cards", vec![variant(47754214310106, "Near Mint / English / Normal", "9.25", true)])])
        }
        // A card named like a set: the store's titles end in the set's name, so every card of
        // the set matches, and the card itself is on the last of eight pages.
        ("title:\"Long Set\"", after) => {
            let n: u64 = after.and_then(|a| a.strip_prefix("page-")).and_then(|n| n.parse().ok()).unwrap_or(1);
            if n < 8 {
                let next = format!("page-{}", n + 1);
                page(Some(next.as_str()), vec![product("Other Card [Long Set]", "other-card-long-set", "Long Set", vec![variant(n, "Near Mint", "1", true)])])
            } else {
                page(None, vec![product("Long Set [Other Set]", "long-set-other-set", "Other Set", vec![variant(900, "Near Mint", "2.5", true)])])
            }
        }
        // A search that never ends.
        ("title:\"Endless Set\"", _) => page(Some("more"), vec![]),
        _ => page(None, vec![]),
    }
}

/// Storefronts refuse `/products/<handle>.js` now, so a card is read from the Storefront API
/// alone: every page, each in-stock variant with its own cart id, and no other request.
#[tokio::test]
async fn a_shopify_store_is_read_through_its_storefront_api() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let app = Router::new().route(
        STOREFRONT_PATH,
        post(move |Json(q): Json<Value>| {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Json(storefront_answer(q["variables"]["q"].as_str().unwrap_or_default(), q["variables"]["after"].as_str()))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut f = Fetcher::new(reqwest::Client::new(), None);
    let mut raw = Raw::default();
    let found = fetch_shopify(&mut f, &base, &["Path to Exile".to_string(), "Absent Card".to_string()], &mut raw).await;
    assert!(found.failed.is_empty() && found.errors.is_empty(), "{:?} {:?}", found.failed, found.errors);
    assert_eq!(calls.load(Ordering::SeqCst), 3, "two pages for the first card, one for the card the store doesn't have");
    assert!(raw.items.iter().all(|i| i["method"] == "POST"), "nothing but the API was asked");
    let got: Vec<(String, f64, &str, String)> = found.listings.iter().map(|l| (l.variant.clone().unwrap(), l.price.unwrap(), l.finish.unwrap(), l.url.clone().unwrap())).collect();
    assert_eq!(
        got,
        vec![
            ("48711641858216".to_string(), 1.5, "nonfoil", format!("{base}/products/path-to-exile-assassins-creed?variant=48711641858216")),
            ("48711642087592".to_string(), 1.75, "foil", format!("{base}/products/path-to-exile-assassins-creed?variant=48711642087592")),
            ("47754214310106".to_string(), 9.25, "nonfoil", format!("{base}/products/path-to-exile-magicfest-cards-207337?variant=47754214310106")),
        ],
        "in-stock variants only, of the card only"
    );
    assert!(found.listings.iter().all(|l| l.card == "Path to Exile" && l.available == Some(true) && l.qty.is_none()), "the API gives no stock counts");
    assert_eq!(found.listings[2].condition.as_deref(), Some("Near Mint"));
    assert_eq!(found.listings[2].language.as_deref(), Some("English"));
    assert_eq!(found.listings[0].set_name.as_deref(), Some("Assassin's Creed"));
    server.abort();
}

#[test]
fn a_storefront_page_that_cant_be_read_in_full_is_unknown() {
    let page = |nodes: Value| json!({"data": {"search": {"pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": nodes}}});
    let ok = json!([{"title": "Sol Ring [C21]", "handle": "sol-ring-c21", "vendor": "Commander 2021", "variants": {"pageInfo": {"hasNextPage": false}, "nodes": [
        {"id": "gid://shopify/ProductVariant/7", "title": "Near Mint", "availableForSale": true, "price": {"amount": "2.0"}}
    ]}}]);
    let (listings, next) = storefront_page(&page(ok.clone()), "Sol Ring", "https://shop.example").unwrap();
    assert_eq!(next, None);
    assert_eq!(listings.len(), 1);
    assert_eq!(listings[0].price, Some(2.0));
    assert_eq!(listings[0].url.as_deref(), Some("https://shop.example/products/sol-ring-c21?variant=7"));
    // No search result: the API is off or throttled, not "nothing in stock".
    assert!(storefront_page(&json!({"errors": [{"message": "Throttled"}]}), "Sol Ring", "https://shop.example").is_none());
    // A next page without its cursor can't be followed.
    assert!(storefront_page(&json!({"data": {"search": {"pageInfo": {"hasNextPage": true, "endCursor": null}, "nodes": []}}}), "Sol Ring", "https://shop.example").is_none());
    for (path, bad) in [
        ("/0/variants/pageInfo/hasNextPage", json!(true)),
        ("/0/variants/nodes/0/id", json!("gid://shopify/ProductVariant/abc")),
        ("/0/variants/nodes/0/price/amount", json!("free")),
        ("/0/variants/nodes/0/price/amount", json!("-1")),
        ("/0/variants/nodes/0/availableForSale", json!(null)),
        ("/0/variants/nodes/0/title", json!("")),
        ("/0/handle", json!("bad/handle")),
    ] {
        let mut nodes = ok.clone();
        *nodes.pointer_mut(path).unwrap() = bad;
        assert!(storefront_page(&page(nodes), "Sol Ring", "https://shop.example").is_none(), "{path}");
    }
    // Another card's unreadable product doesn't make this card unknown.
    let mut other = ok.clone();
    other[0]["title"] = json!("Sol Talisman [MH1]");
    other[0]["handle"] = json!("bad/handle");
    assert!(storefront_page(&page(other), "Sol Ring", "https://shop.example").unwrap().0.is_empty());
    assert!(storefront_refused("https://shop.example/api/2025-10/graphql.json: HTTP 404") && !storefront_refused("https://shop.example/api/2025-10/graphql.json: HTTP 429"));
    assert!(!storefront_refused("https://shop.example/api/2025-10/graphql.json: the answer wasn't JSON"), "a challenge page may pass");
    // Only a store that keeps the API from the public counts as not offering it.
    assert!(storefront_denied(&json!({"errors": [{"message": "Access denied", "extensions": {"code": "ACCESS_DENIED"}}]})));
    assert!(storefront_denied(&json!({"products": []})), "not a GraphQL answer");
    assert!(!storefront_denied(&json!({"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]})));
    assert!(!storefront_denied(&json!({"errors": [{"message": "Internal error", "extensions": {"code": "INTERNAL_SERVER_ERROR"}}], "data": null})));
}

/// A throttled answer leaves its card unknown; it doesn't send the rest of the check to the
/// `.js` reads storefronts refuse. Nor does a saved catalog, for a store that offers the API.
#[tokio::test]
async fn a_passing_storefront_failure_or_a_saved_catalog_never_reaches_the_refused_reads() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_, pool) = app().await;
    let old = std::sync::Arc::new(AtomicUsize::new(0));
    let (o1, o2) = (old.clone(), old.clone());
    let app = Router::new()
        .route(
            "/products.json",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                Json(if q.get("page").map(String::as_str) == Some("1") {
                    json!({"products": [{"handle": "path-to-exile-assassins-creed", "title": "Path to Exile [Assassin's Creed]", "variants": [{"id": 48711641858216u64, "title": "Near Mint", "price": "1.50", "available": true}]}]})
                } else {
                    json!({"products": []})
                })
            }),
        )
        .route(
            "/products/{h}",
            get(move || {
                let o = o1.clone();
                async move {
                    o.fetch_add(1, Ordering::SeqCst);
                    axum::http::StatusCode::TOO_MANY_REQUESTS
                }
            }),
        )
        .route(
            "/search/suggest.json",
            get(move || {
                let o = o2.clone();
                async move {
                    o.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"resources": {"results": {"products": []}}}))
                }
            }),
        )
        .route(
            STOREFRONT_PATH,
            post(|Json(q): Json<Value>| async move {
                let asked = q["variables"]["q"].as_str().unwrap_or_default();
                Json(if asked == "title:\"Busy Card\"" { json!({"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]}) } else { storefront_answer(asked, q["variables"]["after"].as_str()) })
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut f = Fetcher::new(reqwest::Client::new(), None);
    // Throttled on the very first card, before anything is answered.
    let cards = vec!["Busy Card".to_string(), "Path to Exile".to_string()];
    let found = fetch_shopify(&mut f, &base, &cards, &mut Raw::default()).await;
    assert_eq!(found.failed, vec!["Busy Card".to_string()]);
    assert!(found.errors[0].contains("Throttled"), "{:?}", found.errors);
    assert_eq!(found.listings.len(), 3, "the next card is still read through the API");
    // With a catalog saved, and again reusing it.
    let wanted = vec!["Path to Exile".to_string()];
    for refresh in [true, false] {
        let found = fetch_shopify_catalog(&pool, &mut f, &base, &wanted, refresh, "9999", &mut Raw::default()).await;
        assert!(found.failed.is_empty() && found.errors.is_empty(), "{:?} {:?}", found.failed, found.errors);
        assert_eq!(found.listings.len(), 3);
        assert!(found.cached_at.is_none(), "live prices, not the catalog's date");
    }
    assert_eq!(old.load(Ordering::SeqCst), 0, "neither suggest.json nor a product .js was asked");
    server.abort();
}

// ── live stock (live.rs) ────────────────────────────────────────────────────

/// A card in Yama's card data, with one priced printing when `usd` is given.
async fn known_card(pool: &SqlitePool, oracle: &str, name: &str, usd: Option<f64>) {
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES (?, ?, 'Instant', 'W', '{}', 'now')")
        .bind(oracle)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oracle).execute(pool).await.unwrap();
    if let Some(usd) = usd {
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?, ?, ?, 'tst', 'Test Set', '7', 'en', 'now')")
            .bind(format!("p-{oracle}"))
            .bind(oracle)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO price_latest (scryfall_id, date, usd) VALUES (?, '2026-11-12', ?)").bind(format!("p-{oracle}")).bind(usd).execute(pool).await.unwrap();
    }
}

/// A storefront that answers like [`storefront_answer`], throttling "Busy Card". Returns its
/// origin, how many requests it has had, and its task.
async fn live_store() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>, tokio::task::JoinHandle<()>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let app = Router::new().route(
        STOREFRONT_PATH,
        post(move |Json(q): Json<Value>| {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                let asked = q["variables"]["q"].as_str().unwrap_or_default();
                Json(if asked == "title:\"Busy Card\"" { json!({"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]}) } else { storefront_answer(asked, q["variables"]["after"].as_str()) })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, calls, server)
}

/// A card named like a set ("Urza's Saga" at Mothership, 13 Nov 2026) matches every card of that
/// set: all of the pages are read to find the card itself. A search with more pages than Yama
/// reads leaves that card unknown, and is that card's trouble: the store answered every time, so
/// its reader doesn't back off.
#[tokio::test]
async fn a_card_named_like_a_set_is_found_among_the_sets_cards() {
    use std::sync::atomic::Ordering;
    let (_app, pool) = app().await;
    let (base, calls, server) = live_store().await;
    let mut f = Fetcher::new(reqwest::Client::new(), None);
    let found = fetch_shopify(&mut f, &base, &["Long Set".to_string()], &mut Raw::default()).await;
    assert!(found.failed.is_empty() && found.errors.is_empty(), "{:?} {:?}", found.failed, found.errors);
    assert_eq!(calls.load(Ordering::SeqCst), 8, "every page of the set");
    let got: Vec<(&str, Option<f64>, String)> = found.listings.iter().map(|l| (l.card.as_str(), l.price, l.url.clone().unwrap_or_default())).collect();
    assert_eq!(got, vec![("Long Set", Some(2.5), format!("{base}/products/long-set-other-set?variant=900"))], "the card, not the set's other cards");

    live::want(&pool, std::slice::from_ref(&base), &[(card_key("Endless Set"), "Endless Set".to_string())], &[], 0).await.unwrap();
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Unreadable);
    let (checked, error): (Option<String>, Option<String>) = sqlx::query_as("SELECT checked_at, error FROM store_live WHERE card_key = 'endless set'").fetch_one(&pool).await.unwrap();
    assert!(checked.is_none(), "unknown, never \"not in stock\"");
    assert!(error.is_some_and(|e| e.contains(&format!("more than {} in-stock printings", STOREFRONT_PAGES * 25))));
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Idle, "and not asked again straight away");
    server.abort();
}

/// The sourcing page's cards are remembered for the person's Shopify stores, read one card at a
/// time, and served with the date of each answer and the card's cheapest market. A name that
/// isn't a card is never asked of a store.
#[tokio::test]
async fn wanted_cards_are_read_in_the_background_and_served_with_their_dates() {
    use std::sync::atomic::Ordering;
    const REAL: &str = "https://mothershipatx.com";
    let (app, pool) = app().await;
    let (owner, token) = user(&pool, "live@example.com").await;
    store_row(&pool, &owner, "mothership", "Mothership", REAL, 1).await;
    store_row(&pool, &owner, "castle", "Black Castle", "https://blackcastlegamez.tcgplayerpro.com", 2).await;
    known_card(&pool, "o-path", "Path to Exile", Some(1.4)).await;
    known_card(&pool, "o-absent", "Absent Card", None).await;
    let ask = |since: Option<&str>| json!({"cards": ["Path to Exile", "Absent Card", "Not A Card", "path to exile"], "since": since});
    let (s, first) = send(&app, Method::POST, "/api/plan/stock/live", Some(&token), Some(ask(None))).await;
    assert_eq!(s.as_u16(), 200, "{first}");
    assert_eq!(first["stores"].as_array().unwrap().len(), 1, "only the store read card by card: {first}");
    assert_eq!((first["stores"][0]["key"].as_str(), first["stores"][0]["origin"].as_str()), (Some("mothership"), Some(REAL)));
    assert_eq!((first["stores"][0]["wanted"].as_i64(), first["stores"][0]["read"].as_i64()), (Some(2), Some(0)));
    assert_eq!(first["unknown"], json!(["Not A Card"]));
    assert_eq!(first["answers"], json!([]));
    let wanted: Vec<(String, String)> = sqlx::query_as("SELECT base, card_name FROM store_live ORDER BY card_name").fetch_all(&pool).await.unwrap();
    assert_eq!(wanted, vec![(REAL.to_string(), "Absent Card".to_string()), (REAL.to_string(), "Path to Exile".to_string())]);

    // The reader, pointed at a storefront on this machine.
    let (base, calls, server) = live_store().await;
    sqlx::query("UPDATE store_live SET base = ?").bind(&base).execute(&pool).await.unwrap();
    let mut f = Fetcher::new(reqwest::Client::new(), None);
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Read);
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Read);
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Idle, "both are fresh");
    assert_eq!(calls.load(Ordering::SeqCst), 3, "two pages for one card, one for the card the store doesn't have");
    sqlx::query("UPDATE store_live SET base = ?").bind(REAL).execute(&pool).await.unwrap();

    let (_, second) = send(&app, Method::POST, "/api/plan/stock/live", Some(&token), Some(ask(None))).await;
    assert_eq!((second["stores"][0]["read"].as_i64(), second["stores"][0]["fresh"].as_i64(), second["stores"][0]["failed"].as_i64()), (Some(2), Some(2), Some(0)), "{second}");
    assert_eq!(second["stores"][0]["failed_cards"], json!([]));
    assert_eq!(second["reading"], false, "this server started no readers");
    assert!(second["hurry_left"].as_u64().is_some_and(|left| left > 0));
    let answers = second["answers"].as_array().unwrap();
    let path = answers.iter().find(|a| a["card"] == "Path to Exile").expect("the card's answer");
    assert_eq!(path["origin"], REAL);
    assert!(path["checked_at"].as_str().is_some_and(|at| at.starts_with("20")));
    let prices: Vec<f64> = path["listings"].as_array().unwrap().iter().map(|l| l["price"].as_f64().unwrap()).collect();
    assert_eq!(prices, vec![1.5, 1.75, 9.25], "in-stock variants only");
    assert_eq!(path["listings"][1]["finish"], "foil");
    assert_eq!(path["listings"][0]["variant"], "48711641858216");
    let absent = answers.iter().find(|a| a["card"] == "Absent Card").expect("asked and not found");
    assert_eq!(absent["listings"], json!([]), "not in stock, which is an answer");
    assert_eq!(second["markets"]["Path to Exile"]["usd"], 1.4);
    assert_eq!(second["markets"]["Path to Exile"]["date"], "2026-11-12");
    assert!(second["markets"].get("Absent Card").is_none(), "a card without a price has no market, never zero");

    // Only what changed since the page last asked.
    let (_, later) = send(&app, Method::POST, "/api/plan/stock/live", Some(&token), Some(ask(second["at"].as_str()))).await;
    assert_eq!(later["answers"], json!([]));
    assert_eq!(later["stores"][0]["read"].as_i64(), Some(2));

    // Another account without the store sees nothing, and too many cards are refused.
    let (_, other) = user(&pool, "other@example.com").await;
    let (_, none) = send(&app, Method::POST, "/api/plan/stock/live", Some(&other), Some(ask(None))).await;
    assert_eq!((none["stores"].clone(), none["answers"].clone()), (json!([]), json!([])));
    let many: Vec<String> = (0..=live::MAX_WANTED).map(|i| format!("Card {i}")).collect();
    let (s, _) = send(&app, Method::POST, "/api/plan/stock/live", Some(&token), Some(json!({"cards": many}))).await;
    assert_eq!(s.as_u16(), 400);
    server.abort();
}

/// A read that fails keeps the last answer and waits before it is tried again; a card about to
/// be ordered is read before the rest, and only when its answer isn't already new.
#[tokio::test]
async fn a_failed_read_waits_and_a_hurried_card_goes_first() {
    let (_app, pool) = app().await;
    let (base, _calls, server) = live_store().await;
    let bases = vec![base.clone()];
    let card = |name: &str| (card_key(name), name.to_string());
    let mut f = Fetcher::new(reqwest::Client::new(), None);

    live::want(&pool, &bases, &[card("Busy Card")], &[], 300).await.unwrap();
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Failed);
    let (checked, error): (Option<String>, Option<String>) = sqlx::query_as("SELECT checked_at, error FROM store_live WHERE card_key = 'busy card'").fetch_one(&pool).await.unwrap();
    assert!(checked.is_none() && error.is_some_and(|e| e.contains("Throttled")));
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Idle, "not asked again straight away");

    // Two cards read yesterday: both are due, and the hurried one is read first.
    live::want(&pool, &bases, &[card("Absent Card"), card("Path to Exile")], &[], 300).await.unwrap();
    sqlx::query("UPDATE store_live SET checked_at = '2026-01-01T00:00:00.000Z', tried_at = '2026-01-01T00:00:00.000Z', listings = '[]' WHERE card_key != 'busy card'").execute(&pool).await.unwrap();
    assert_eq!(live::want(&pool, &bases, &[card("Absent Card"), card("Path to Exile")], &[card_key("Path to Exile")], 300).await.unwrap(), 1);
    assert_eq!(live::want(&pool, &bases, &[card("Path to Exile")], &[card_key("Path to Exile")], 300).await.unwrap(), 0, "already waiting to be read first");
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Read);
    let read_first: Vec<String> = sqlx::query_scalar("SELECT card_key FROM store_live WHERE checked_at > '2026-06-01'").fetch_all(&pool).await.unwrap();
    assert_eq!(read_first, vec!["path to exile".to_string()]);
    assert_eq!(live::want(&pool, &bases, &[card("Path to Exile")], &[card_key("Path to Exile")], 300).await.unwrap(), 0, "its answer is new: nothing to hurry");
    // A card whose answer is new takes none of the places: with one place, the stale card gets it.
    sqlx::query("UPDATE store_live SET rush_at = NULL").execute(&pool).await.unwrap();
    assert_eq!(live::want(&pool, &bases, &[], &[card_key("Path to Exile"), card_key("Absent Card")], 1).await.unwrap(), 1);
    let hurried: Vec<String> = sqlx::query_scalar("SELECT card_key FROM store_live WHERE rush_at IS NOT NULL").fetch_all(&pool).await.unwrap();
    assert_eq!(hurried, vec!["absent card".to_string()]);
    assert_eq!(live::want(&pool, &bases, &[], &[card_key("Absent Card")], 0).await.unwrap(), 0, "no allowance, nothing hurried");

    // A card nobody has asked about for weeks is left alone, with its last answer kept.
    sqlx::query("UPDATE store_live SET wanted_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
    assert_eq!(live::step(&pool, &mut f, &base, Duration::ZERO).await.unwrap(), live::Step::Idle);
    let kept: Option<String> = sqlx::query_scalar("SELECT listings FROM store_live WHERE card_key = 'absent card'").fetch_one(&pool).await.unwrap();
    assert_eq!(kept.as_deref(), Some("[]"));
    server.abort();
}
