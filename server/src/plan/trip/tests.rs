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
        let got = summary(&plan(&f["bundle"], today));
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
    let t = text(&plan(&f["bundle"], "2026-11-01"));
    assert!(t.contains("1. Pat's Games (your usual store): 2 cards, $1.50"), "{t}");
    assert!(t.contains("3. Multiverse Hobbies (maybe, one trip, Hutto, 13.4 mi): 1 card, $0.75"), "{t}");
    assert!(t.contains("Cart link (replaces what's in that cart): https://patsgames.com/cart/v-fell:1,v-swords:1"), "{t}");
    assert!(t.contains("- Strike It Rich for Tricky Terrain: only at Alpha Strike Games, where they won't go"), "{t}");
    assert!(t.contains("Skipped: Alpha Strike Games (you won't go) has 1 needed card under the rule."), "{t}");
    assert!(t.contains("- $200 and up (1, $1119.82 at market): Mox Diamond $1119.82"), "{t}");
    let mut empty = f["bundle"].clone();
    empty["quotes"] = json!([]);
    let t = text(&plan(&empty, "2026-11-01"));
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
    let t = plan(&b, "2026-11-01");
    let keys: Vec<&str> = t.stops.iter().map(|x| s(x.store, "key").unwrap()).collect();
    assert_eq!(keys, ["pats", "mothership"]);

    let mut b = f["bundle"].clone();
    for set in b["settings"].as_array_mut().unwrap() {
        set["rules"]["buy_local_only"] = json!(true);
    }
    for st in b["stores"].as_array_mut().unwrap() {
        if st["key"] == "mothership" {
            st["kind"] = json!("online");
        }
    }
    let t = plan(&b, "2026-11-01");
    let sol = t.print.iter().find(|p| p.want.card == "Sol Ring").unwrap();
    assert_eq!((sol.reason, sol.stores.clone()), ("not-local", vec!["Mothership Books and Games".to_string()]));
    assert!(text(&t).contains("only at Mothership Books and Games, which isn't local"));
}
