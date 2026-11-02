use super::*;

const FIXTURE: &str = include_str!("../../../../packages/core/src/plan/fixtures/trip.json");

/// JSON equality with numbers compared as numbers: TypeScript writes 1, Rust 1.0.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-9,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[test]
fn matches_the_typescript_trip_on_the_shared_fixture() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in f["cases"].as_array().unwrap() {
        let today = case["today"].as_str().unwrap();
        let stores: Option<Vec<String>> = case.get("stores").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect());
        // A case may add fields to the bundle (store snapshot quotes, hand-added wants).
        let mut bundle = f["bundle"].clone();
        for (k, v) in case.get("with").and_then(Value::as_object).into_iter().flatten() {
            bundle[k] = v.clone();
        }
        let got = summary(&plan(&bundle, today, stores.as_deref()));
        assert!(same(&got, &case["expect"]), "{today}:\n got {got}\nwant {}", case["expect"]);
    }
}

#[test]
fn bryans_rule_at_its_edges() {
    let r = LocalBuyRule { max_usd: Some(2.0), always_ok_usd: Some(0.5), tiers: vec![(Some(1.0), 2.0), (None, 1.5)] };
    assert_eq!(judge(Some(&r), 0.5, None), Verdict::Ok);
    assert_eq!(judge(Some(&r), 0.51, None), Verdict::NoMarket);
    assert_eq!(judge(Some(&r), 1.0, Some(0.5)), Verdict::Ok);
    assert_eq!(judge(Some(&r), 1.01, Some(0.5)), Verdict::OverMarket);
    assert_eq!(judge(Some(&r), 1.5, Some(1.0)), Verdict::Ok);
    assert_eq!(judge(Some(&r), 1.51, Some(1.0)), Verdict::OverMarket);
    assert_eq!(judge(Some(&r), 2.01, Some(5.0)), Verdict::OverMax);
    assert_eq!(judge(None, 40.0, Some(1.0)), Verdict::Ok);
    assert_eq!(
        rule_text(&r),
        "Buy locally: at most $2.00; $0.50 or less whatever the market; at most 2× market when market is under $1.00; at most 1.5× market when market is $1.00 or more; an unknown market qualifies only at $0.50 or less."
    );
    assert!(foil_listing(Some("Borderless Foil")));
    assert!(!foil_listing(Some("Near Mint Non-Foil")));
}

#[test]
fn the_words_name_stores_reasons_and_never_a_zero_total() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let t = text(&plan(&f["bundle"], "2026-11-01", None));
    assert!(t.contains("1. Black Castle Gamez (their favourite, to support, Cedar Park, 3.6 mi): 2 cards, $2.00"), "{t}");
    assert!(t.contains("3. Multiverse Hobbies (maybe, one trip, Hutto, 13.4 mi): 1 card, $0.75"), "{t}");
    assert!(t.contains("  Sol Ring: https://blackcastlegamez.tcgplayerpro.com/search/products?q=Sol%20Ring&productLineName=Magic%3A%20The%20Gathering&sort=price-asc"), "{t}");
    assert!(t.contains("- Strike It Rich for Tricky Terrain: only at Alpha Strike Games, where they won't go"), "{t}");
    assert!(t.contains("Skipped: Alpha Strike Games (they won't go) has 1 needed card under the rule."), "{t}");
    assert!(t.contains("TCGplayer Mass Entry: https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Arcane%20Signet||"), "{t}");
    let t = text(&plan(&f["bundle"], "2026-11-01", Some(&["mothership".to_string()])));
    assert!(t.contains("Going this time: Mothership Books and Games."), "{t}");
    assert!(t.contains("Cart link (fills that store's cart with these; check it before paying): https://mothershipatx.com/cart/v-sol:1"), "{t}");
    assert!(t.contains("Skipped: Black Castle Gamez (left off this trip)"), "{t}");
    assert!(t.contains("- $200 and up (1, $1119.82 at market): Mox Diamond $1119.82"), "{t}");
    let mut empty = f["bundle"].clone();
    empty["quotes"] = json!([]);
    let t = text(&plan(&empty, "2026-11-01", None));
    assert!(t.contains("0 covered by 0 stores, no price before tax."), "{t}");
    assert!(!t.contains("$0.00"), "{t}");
}

#[test]
fn a_maybe_store_doesnt_bundle_and_a_non_local_store_is_named_as_such() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut b = f["bundle"].clone();
    b["swaps"].as_array_mut().unwrap().retain(|s| s["in"] != "Exotic Orchard");
    let orchard = b["quotes"].as_array().unwrap().iter().find(|q| q["card"] == "Exotic Orchard").unwrap().clone();
    for (card, price) in [("Sol Ring", 1.25), ("Fellwar Stone", 0.5), ("Swords to Plowshares", 1.0)] {
        let mut q = orchard.clone();
        q["card"] = json!(card);
        q["price"] = json!(price);
        q["variant"] = Value::Null;
        b["quotes"].as_array_mut().unwrap().push(q);
    }
    let t = plan(&b, "2026-11-01", None);
    let keys: Vec<&str> = t.stops.iter().map(|x| s(x.store, "key").unwrap()).collect();
    assert_eq!(keys, ["black-castle", "mothership"]);

    let mut b = f["bundle"].clone();
    for set in b["settings"].as_array_mut().unwrap() {
        set["rules"]["buy_local_only"] = json!(true);
    }
    b["quotes"].as_array_mut().unwrap().retain(|q| !(q["card"] == "Sol Ring" && q["store"] == "black-castle"));
    for st in b["stores"].as_array_mut().unwrap() {
        if st["key"] == "mothership" {
            st["kind"] = json!("online");
        }
    }
    let t = plan(&b, "2026-11-01", None);
    let sol = t.print.iter().find(|p| p.want.card == "Sol Ring").unwrap();
    assert_eq!((sol.reason, sol.stores.clone()), ("not-local", vec!["Mothership Books and Games".to_string()]));
    assert!(text(&t).contains("only at Mothership Books and Games, which isn't local"));
}

#[test]
fn unknown_stock_is_not_a_reason_to_go() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut b = f["bundle"].clone();
    for q in b["quotes"].as_array_mut().unwrap() {
        if q["card"] == "Exotic Orchard" {
            q["in_stock"] = Value::Null;
        }
    }
    let t = plan(&b, "2026-11-01", None);
    assert!(t.stops.iter().all(|x| s(x.store, "key") != Some("multiverse-hobbies")));
    let row = t.print.iter().find(|p| p.want.card == "Exotic Orchard").unwrap();
    assert_eq!((row.reason, row.stores.clone()), ("unknown-stock", vec!["Multiverse Hobbies".to_string()]));
    for q in b["quotes"].as_array_mut().unwrap() {
        if q["card"] == "Exotic Orchard" {
            q["in_stock"] = json!(true);
            q["currency"] = json!("CAD");
        }
    }
    let t = plan(&b, "2026-11-01", None);
    assert_eq!(t.print.iter().find(|p| p.want.card == "Exotic Orchard").unwrap().reason, "no-price");
}

#[test]
fn a_market_above_every_range_doesnt_qualify() {
    let r = LocalBuyRule { max_usd: Some(5.0), always_ok_usd: Some(0.25), tiers: vec![(Some(1.0), 2.0)] };
    assert_eq!(judge(Some(&r), 1.5, Some(0.9)), Verdict::Ok);
    assert_eq!(judge(Some(&r), 1.5, Some(2.0)), Verdict::OverMarket);
    assert_eq!(judge(Some(&r), 0.25, Some(2.0)), Verdict::Ok);
    assert!(rule_text(&r).contains("nothing qualifies when market is $1.00 or more"));
}

#[test]
fn past_the_search_limit_a_store_that_alone_has_a_needed_card_still_makes_the_trip() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut b = f["bundle"].clone();
    let pats = b["stores"].as_array().unwrap().iter().find(|x| x["key"] == "pats").unwrap().clone();
    let orchard = b["quotes"].as_array().unwrap().iter().find(|q| q["card"] == "Exotic Orchard").unwrap().clone();
    let quote = |card: &str, store: &str, price: f64| {
        let mut q = orchard.clone();
        q["card"] = json!(card);
        q["store"] = json!(store);
        q["price"] = json!(price);
        q["variant"] = Value::Null;
        q
    };
    b["quotes"].as_array_mut().unwrap().retain(|q| q["card"] != "Exotic Orchard");
    for i in 0..13 {
        let mut st = pats.clone();
        st["key"] = json!(format!("s{i}"));
        st["name"] = json!(format!("Store {i}"));
        st["sort"] = json!(20 + i);
        b["stores"].as_array_mut().unwrap().push(st);
        let (a, c) = (quote("Fellwar Stone", &format!("s{i}"), 0.5), quote("Swords to Plowshares", &format!("s{i}"), 1.0));
        b["quotes"].as_array_mut().unwrap().extend([a, c]);
    }
    let mut far = pats.clone();
    far["key"] = json!("zz");
    far["name"] = json!("Far Store");
    far["sort"] = json!(99);
    b["stores"].as_array_mut().unwrap().push(far);
    let q = quote("Exotic Orchard", "zz", 0.75);
    b["quotes"].as_array_mut().unwrap().push(q);
    let t = plan(&b, "2026-11-01", None);
    assert!(t.stops.iter().any(|x| s(x.store, "key") == Some("zz")));
    assert!(t.print.iter().all(|p| p.want.card != "Exotic Orchard"));
    // Two stores past the limit share it: one of them still comes.
    let mut far2 = pats.clone();
    far2["key"] = json!("zy");
    far2["name"] = json!("Far Store 2");
    far2["sort"] = json!(98);
    b["stores"].as_array_mut().unwrap().push(far2);
    let q = quote("Exotic Orchard", "zy", 0.75);
    b["quotes"].as_array_mut().unwrap().push(q);
    let t = plan(&b, "2026-11-01", None);
    assert!(t.print.iter().all(|p| p.want.card != "Exotic Orchard"));
    assert_eq!(t.stops.iter().filter(|x| matches!(s(x.store, "key"), Some("zz" | "zy"))).count(), 1);
}

#[test]
fn preferences_read_the_old_name_and_order_the_stores() {
    let b = json!({
        "stores": [{"key": "a", "sort": 1}, {"key": "p", "sort": 2, "kind": "printer"}, {"key": "b", "sort": 2}, {"key": "r", "sort": 0, "retired": true}, {"key": "c", "sort": 3}],
        "store_prefs": {"a": {"preference": "default"}, "c": {"preference": "maybe", "hassle": 1, "premium_usd": 0.4}},
    });
    assert_eq!(store_preference(&b, "a"), "favorite");
    assert_eq!(store_preference(&b, "b"), "ok");
    assert_eq!(store_premium(&b, "c"), 0.0, "only a favourite's premium counts");
    assert_eq!(store_premium(&b, "a"), 0.0);
    let fav = json!({"store_prefs": {"c": {"preference": "favorite", "premium_usd": 0.4}}});
    assert_eq!(store_premium(&fav, "c"), 0.4);
    let order = hassle_order(&b);
    assert_eq!((order["c"], order["a"], order["b"], order.len()), (1, 2, 3, 3), "printers and retired stores have no place");
    assert_eq!(mass_entry_url(&["Sol Ring", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "+2 Mace", "Sol Ring"]).as_deref(),
        Some("https://www.tcgplayer.com/massentry?productline=Magic&c=2%20Sol%20Ring||1%20Fable%20of%20the%20Mirror-Breaker||1%20%2B2%20Mace"));
    assert_eq!(pro_search_url(&json!({"homepage": "https://evil.com/.tcgplayerpro.com"}), "Sol Ring"), None);
    assert_eq!(pro_search_url(&json!({"homepage": "https://evil.example?next=.tcgplayerpro.com"}), "Sol Ring"), None);
    assert_eq!(pro_search_url(&json!({"homepage": "https://evil.example#.tcgplayerpro.com"}), "Sol Ring"), None);
    assert_eq!(
        pro_search_url(&json!({"homepage": "https://mversetcg.tcgplayerpro.com/"}), "Sol Ring").as_deref(),
        Some("https://mversetcg.tcgplayerpro.com/search/products?q=Sol%20Ring&productLineName=Magic%3A%20The%20Gathering&sort=price-asc")
    );
    assert_eq!(pro_search_url(&json!({"homepage": "https://patsgames.com"}), "Sol Ring"), None);
}

#[test]
fn a_cart_link_counts_copies_of_one_listing() {
    let store = serde_json::json!({"cart_url_template": "https://shop.example/cart/{items}"});
    assert_eq!(cart_url(&store, &["111", "222", "111"]).as_deref(), Some("https://shop.example/cart/111:2,222:1"));
}
