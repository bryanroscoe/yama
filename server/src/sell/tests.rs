use super::*;
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};
use serde_json::json;

fn settings() -> Value {
    json!({"do_not_accept_at_or_below_price":0.5,"quantity_limit":4,"product_lines":[{"name":"Magic: the Gathering","possible_conditions":[{"label":"Near Mint"},{"label":"Lightly Played"},{"label":"Moderately Played","visibility":"Staff Only"}]}]})
}
fn product() -> Value {
    json!({"id":"product","display_name":"Sol Ring [Commander 2021]","product_data":{"set":"c21","collector_number_normalized":263},"variant_info":[{"id":1,"title":"Near Mint","price":2.0,"sku":"C21-263-EN-NF-1"},{"id":2,"title":"Near Mint Foil","price":4.0,"sku":"C21-263-EN-FO-1"},{"id":3,"title":"Lightly Played","price":1.5,"sku":"C21-263-EN-NF-2"},{"id":4,"title":"Moderately Played","price":1.0,"sku":"C21-263-EN-NF-3"}],"store_pass_variant_info":[{"id":1,"title":"Near Mint","selected_finish":"nonfoil","offer_price":0.75,"offer_price_credit":0.86},{"id":2,"title":"Near Mint Foil","selected_finish":"foil","offer_price":1.8,"offer_price_credit":2.07},{"id":3,"title":"Lightly Played","selected_finish":"nonfoil","offer_price":0.6,"offer_price_credit":0.69},{"id":4,"title":"Moderately Played","selected_finish":"nonfoil","offer_price":0.6,"offer_price_credit":0.69}]})
}
fn pick(ps: &[Value], finish: &str, condition: &str) -> Offer {
    match_products(
        "Sol Ring",
        "c21",
        "263",
        &Copy {
            finish: finish.into(),
            condition: condition.into(),
        },
        &settings(),
        ps,
    )
    .unwrap()
}

#[test]
fn exact_printing_finish_and_condition_only() {
    let p = product();
    let result = pick(&[p.clone()], "nonfoil", "NM");
    assert_eq!(result.status, "accepting");
    assert_eq!(result.cash_usd, Some(0.75));
    assert_eq!(result.quantity_limit, Some(4));
    assert_eq!(pick(&[p.clone()], "foil", "NM").cash_usd, Some(1.8));
    assert_eq!(pick(&[p.clone()], "nonfoil", "LP").cash_usd, Some(0.6));
    assert_eq!(pick(&[p.clone()], "etched", "NM").status, "unmatched");
    assert_eq!(pick(&[p.clone()], "nonfoil", "MP").status, "not_accepting");
    let mut wrong = p.clone();
    wrong["product_data"]["set"] = json!("cmm");
    assert_eq!(pick(&[wrong], "nonfoil", "NM").cash_usd, None);
    let mut wrong = p.clone();
    wrong["display_name"] = json!("Sol Ring Token [Commander 2021]");
    assert_eq!(pick(&[wrong], "nonfoil", "NM").status, "unmatched");
    let mut wrong = p;
    wrong["product_data"]["collector_number_normalized"] = json!(264);
    for v in wrong["variant_info"].as_array_mut().unwrap() {
        v["sku"] = json!("C21-264-EN-NF-1");
    }
    assert_eq!(pick(&[wrong], "nonfoil", "NM").status, "unmatched");
}

#[test]
fn unknown_ambiguous_and_customer_thresholds_are_not_offers() {
    let mut p = product();
    p["product_data"]
        .as_object_mut()
        .unwrap()
        .remove("collector_number_normalized");
    p["product_data"]["lang"] = json!("en");
    for v in p["variant_info"].as_array_mut().unwrap() {
        v["sku"] = json!("numeric-sku");
    }
    assert_eq!(pick(&[p], "nonfoil", "NM").status, "check_printing");
    let p = product();
    assert_eq!(
        pick(&[p.clone(), p.clone()], "nonfoil", "NM").status,
        "ambiguous"
    );
    let mut floor = p.clone();
    floor["store_pass_variant_info"][0]["offer_price"] = json!(0.5);
    assert_eq!(pick(&[floor], "nonfoil", "NM").status, "not_accepting");
    let mut too_high = p.clone();
    too_high["store_pass_variant_info"][0]["offer_price"] = json!(2.01);
    assert_eq!(pick(&[too_high], "nonfoil", "NM").status, "not_accepting");
    let mut missing = p;
    missing["store_pass_variant_info"][0]
        .as_object_mut()
        .unwrap()
        .remove("offer_price");
    let result = pick(&[missing], "nonfoil", "NM");
    assert_eq!(result.status, "unknown");
    assert_eq!(result.cash_usd, None);
}

#[test]
fn original_collector_suffix_and_front_face_are_preserved() {
    let mut p = product();
    for v in p["variant_info"].as_array_mut().unwrap() {
        v["sku"] = json!("C21-263a-EN-NF-1");
    }
    assert_eq!(collector(&p).as_deref(), Some("263a"));
    assert_eq!(pick(&[p], "nonfoil", "NM").status, "unmatched");
    assert!(matches_name(
        "Westvale Abbey [Shadows over Innistrad]",
        "Westvale Abbey // Ormendahl, Profane Prince"
    ));
    assert!(!matches_name(
        "Westvale Abbey Token [Test]",
        "Westvale Abbey // Ormendahl, Profane Prince"
    ));
    assert_eq!(normalized("00042a"), "42a");
}

async fn save(pool: &sqlx::SqlitePool, owner: &str, cash: f64) {
    let mut offer = Offer::empty("accepting", "fixture");
    offer.cash_usd = Some(cash);
    sqlx::query("INSERT INTO sell_offers VALUES(?,?, 'printing','nonfoil','NM',?,?)")
        .bind(crate::util::new_id())
        .bind(owner)
        .bind(&offer.checked_at)
        .bind(serde_json::to_string(&offer).unwrap())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn history_is_private_and_cached_checks_do_not_append_or_call_provider() {
    let (app, pool) = app().await;
    let (a, at) = user(&pool, "a@example.com").await;
    let (b, bt) = user(&pool, "b@example.com").await;
    save(&pool, &a, 1.0).await;
    save(&pool, &b, 2.0).await;
    let path = "/api/sell/mothership/printing?finish=nonfoil&condition=NM";
    assert_eq!(
        send(&app, Method::GET, path, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, rows) = send(&app, Method::GET, path, Some(&at), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["cash_usd"], 1.0);
    assert_eq!(
        send(&app, Method::GET, path, Some(&bt), None).await.1[0]["cash_usd"],
        2.0
    );
    let (status, result) = send(
        &app,
        Method::POST,
        "/api/sell/mothership/printing",
        Some(&at),
        Some(json!({"finish":"nonfoil","condition":"NM"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["cash_usd"], 1.0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sell_offers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 2);
    assert!(
        observations(
            &pool,
            &a,
            "printing",
            &Copy {
                finish: "foil".into(),
                condition: "NM".into()
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=?")
        .bind(&a)
        .execute(&pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sell_offers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn quantity_tiers_and_missing_limits_are_not_counted() {
    let mut p = product();
    p["store_pass_variant_info"][0]["threshold"] = json!(2);
    assert_eq!(pick(&[p], "nonfoil", "NM").status, "unknown");
    let mut missing = settings();
    missing.as_object_mut().unwrap().remove("quantity_limit");
    let result = match_products(
        "Sol Ring",
        "c21",
        "263",
        &Copy {
            finish: "nonfoil".into(),
            condition: "NM".into(),
        },
        &missing,
        &[product()],
    )
    .unwrap();
    assert_eq!(result.status, "unknown");
    assert_eq!(result.quantity_limit, None);
}

#[test]
fn language_matches_the_provider_variant_not_just_the_input() {
    let en = product();
    let mut ja = en.clone();
    ja["id"] = json!("japanese");
    for v in ja["variant_info"].as_array_mut().unwrap() {
        v["sku"] = json!("C21-263-JA-NF-1");
    }
    assert_eq!(pick(&[ja.clone()], "nonfoil", "NM").status, "unmatched");
    assert_eq!(pick(&[en.clone(), ja], "nonfoil", "NM").status, "accepting");
    let mut rainbow = en.clone();
    rainbow["variant_info"][0]["sku"] = json!("SLD-1589-RAINBOW-EN-JA-FO-1");
    assert_eq!(
        english(&rainbow, &rainbow["store_pass_variant_info"][0]),
        Some(false)
    );
    let mut unknown = en;
    unknown["variant_info"][0]
        .as_object_mut()
        .unwrap()
        .remove("sku");
    let conditional = pick(&[unknown], "nonfoil", "NM");
    assert_eq!(conditional.status, "check_printing");
    assert_eq!(conditional.cash_usd, Some(0.75));
    assert_eq!(conditional.quantity_limit, None);
}

#[test]
fn real_foil_separator_and_product_etched_treatments_are_distinct() {
    let mut p = product();
    p["store_pass_variant_info"][1]["title"] = json!("Near Mint - Foil");
    assert_eq!(pick(&[p.clone()], "foil", "NM").cash_usd, Some(1.8));
    p["display_name"] = json!("Sol Ring (Foil Etched) [Commander 2021]");
    let etched = pick(&[p.clone()], "etched", "NM");
    assert_eq!(etched.status, "accepting");
    assert_eq!(etched.cash_usd, Some(1.8));
    assert_eq!(pick(&[p.clone()], "foil", "NM").status, "unmatched");
    assert_eq!(pick(&[p], "nonfoil", "NM").status, "unmatched");
    let mut ordinary = product();
    ordinary["display_name"] = json!("Etched Champion [Commander 2021]");
    assert_eq!(
        variant_finish(&ordinary, &ordinary["store_pass_variant_info"][1]),
        Some("foil")
    );
}

#[test]
fn conflicting_collector_identifiers_never_produce_a_confirmed_quote() {
    let mut p = product();
    p["product_data"]["collector_number_normalized"] = json!(264);
    let result = pick(&[p], "nonfoil", "NM");
    assert_eq!(result.status, "check_printing");
    assert_eq!(result.cash_usd, None);
}

#[tokio::test]
#[ignore = "opt-in live public provider contract check"]
async fn live_public_mothership_contract() {
    let result = fetch(
        "Arcane Signet",
        "pip",
        "224",
        &Copy {
            finish: "nonfoil".into(),
            condition: "NM".into(),
        },
    )
    .await
    .unwrap();
    assert!(
        ["accepting", "not_accepting"].contains(&result.status.as_str()),
        "{result:?}"
    );
    assert_eq!(result.source, SOURCE);
    assert!(result.cash_usd.is_some());
}
