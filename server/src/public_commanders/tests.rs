use super::*;
use crate::testutil::{state, user};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

const SHA: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn an_average_commander_scores_fifty_and_a_better_one_more() {
    let avg = from_counts(250, 1000, None, 0.25).unwrap();
    assert!(close(score(avg.mu), 50.0, 1e-9));
    let good = from_counts(400, 1000, None, 0.25).unwrap();
    assert!(score(good.mu) > 60.0);
    // Few games are pulled toward average more than many at the same rate.
    let few = from_counts(8, 20, None, 0.25).unwrap();
    assert!(few.mu < good.mu && few.var > good.var);
    // Pilots cap the evidence: 1,000 games by two pilots count as eight.
    let two_pilots = from_counts(400, 1000, Some(2), 0.25).unwrap();
    assert!(two_pilots.var > good.var);
    assert!(from_counts(5, 0, None, 0.25).is_none());
    assert!(from_counts(5, 4, None, 0.25).is_none());
}

#[test]
fn a_source_score_round_trips_and_combining_adds_certainty() {
    let e = from_score(71.65, 68.04, 74.99).unwrap();
    assert!(close(score(e.mu), 71.65, 1e-9));
    assert!(from_score(50.0, 60.0, 70.0).is_none());
    assert!(from_score(0.0, 0.0, 10.0).is_none());

    let prior = prior_var(0.3, PRIOR);
    assert!(prior_var(0.3, 400.0) < prior, "a stronger prior is narrower");
    let one = combine(&[(e, prior)]).unwrap();
    assert!(close(one.mu, e.mu, 1e-9) && close(one.var, e.var, 1e-12), "one source passes through");
    // Two sources that agree: the product of posteriors over one prior, so the prior counts once.
    let both = combine(&[(e, prior), (e, prior)]).unwrap();
    let precision = 2.0 / e.var - 1.0 / prior;
    assert!(close(both.mu, 2.0 * e.mu / e.var / precision, 1e-9));
    assert!(close(both.var, 1.0 / precision, 1e-12));
    assert!(both.var < e.var);
    // The order of the sources never changes the result, even with different priors.
    let a = (from_counts(400, 1000, None, 0.25).unwrap(), prior_var(0.25, PRIOR));
    let b = (from_counts(500, 1000, None, 0.367).unwrap(), prior_var(0.367, PRIOR));
    let ab = combine(&[a, b]).unwrap();
    let ba = combine(&[b, a]).unwrap();
    assert!(close(ab.mu, ba.mu, 1e-12) && close(ab.var, ba.var, 1e-15));
    // A bound that underflows can't make a NaN score.
    assert!(from_score(50.0, 5e-324, 75.0).is_none());
    assert!(combine(&[(Estimate { mu: f64::NAN, var: 1.0 }, prior)]).is_none());
    // Disagreeing sources land between them, nearer the surer one.
    let sure = Estimate { mu: 0.4, var: 0.001 };
    let unsure = Estimate { mu: -0.4, var: 0.1 };
    let mixed = combine(&[(sure, f64::INFINITY), (unsure, f64::INFINITY)]).unwrap();
    assert!(mixed.mu > 0.3 && mixed.mu < 0.4);
    assert!(combine(&[]).is_none());
}

async fn card(pool: &SqlitePool, oracle: &str, name: &str, colors: &str, printing: &str) {
    sqlx::query("INSERT INTO cards(oracle_id,name,type_line,color_identity,legalities,image_art_crop,artist,updated_at) VALUES (?,?,'Legendary Creature',?,'{}',?,'Test Artist','now')")
        .bind(oracle).bind(name).bind(colors).bind(format!("https://cards.scryfall.io/art_crop/{oracle}.jpg"))
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO card_names(name, oracle_id) VALUES (?,?)").bind(name).bind(oracle).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO printings(scryfall_id,oracle_id,name,set_code,set_name,collector_number,lang,updated_at) VALUES (?,?,?,'tst','Test','1','en','now')")
        .bind(printing).bind(oracle).bind(name).execute(pool).await.unwrap();
}

fn document(id: &str, source: &str, records: Vec<Value>) -> Value {
    json!({"schema":"yama-dataset/1","id":id,"title":format!("{source} commanders"),"generated_at":"2026-10-31T00:00:00Z",
        "source":{"name":source,"url":"https://example.com/source","attribution":format!("{source} attribution"),"license":"Test licence"},
        "method":"Test","coverage":{},
        "sources":[{"sha256":SHA,"url":"https://example.com/data","retrieved_at":"2026-10-31T00:00:00Z","source_as_of":null,"captured_at":null,"flags":[],"transformation":null,"original_response_sha256":null}],
        "records":records})
}

fn counts(id: u32, name: &str, printing: &str, wins: u64, games: u64) -> Value {
    json!({"id":format!("commander:{id}"),"kind":"commander","entity":format!("pg:commander:{id}"),"sources":[SHA],
        "data":{"id":id,"name":name,"scryfall_id":printing,"game_win_count":wins,"game_played_count":games,"pilot_count":games / 2}})
}

fn scored(ids: &[&str], name: &str, s: f64, lo: f64, hi: f64, games: u64) -> Value {
    // Dataset keys allow no "+", so pairs join with "." as the Mythic converter does.
    let key = ids.join(".");
    json!({"id":format!("mythic:{key}"),"kind":"commander","entity":format!("mythic:commander:{key}"),"sources":[SHA],
        "data":{"name":name,"oracle_ids":ids,"score_0_100":s,"interval_low":lo,"interval_high":hi,"games":games,"decks":games / 3,"baseline":0.367,"prior_strength":100,"win_rate":0.30}})
}

async fn import(pool: &SqlitePool, owner: &str, doc: &Value) {
    crate::datasets::import(pool, owner, &serde_json::to_vec(doc).unwrap(), false).await.unwrap();
}

async fn fixture() -> (AppState, String) {
    let st = state().await;
    let pool = &st.pool;
    card(pool, "o-strong", "Strong Commander", "BG", "p-strong").await;
    card(pool, "o-weak", "Weak Commander", "U", "p-weak").await;
    card(pool, "o-alchemy", "A-Strong Commander", "BG", "p-strong-alchemy").await;
    card(pool, "o-mythic", "Mythic Only", "R", "p-mythic").await;
    card(pool, "o-partner-a", "Partner A", "W", "p-a").await;
    card(pool, "o-partner-b", "Partner B", "R", "p-b").await;
    let (owner, _) = user(pool, "operator@example.com").await;
    let mut pg = vec![
        counts(1, "Strong Commander", "p-strong", 450, 1000),
        // Playgroup lists an Alchemy twin under the same printing: it merges into one commander.
        counts(2, "A-Strong Commander", "p-strong", 50, 100),
        counts(3, "Weak Commander", "p-weak", 150, 1000),
        // No printing known: matched by its unique name.
        counts(4, "Partner A", "p-unknown", 18, 60),
        counts(5, "Nobody Knows", "p-nothing", 30, 100),
    ];
    for i in 0..20 {
        pg.push(counts(100 + i, "Partner B", "p-b", 300, 1000));
    }
    import(pool, &owner, &document("pg", "Playgroup.gg", pg)).await;
    import(
        pool,
        &owner,
        &document(
            "mythic",
            "Mythic Tools",
            vec![
                scored(&["o-strong"], "Strong Commander", 70.0, 65.0, 75.0, 4000),
                scored(&["o-mythic"], "Mythic Only", 40.0, 30.0, 50.0, 500),
                scored(&["o-partner-a", "o-partner-b"], "Partner A + Partner B", 55.0, 45.0, 65.0, 800),
            ],
        ),
    )
    .await;
    sqlx::query("INSERT INTO precons(id, lab_id, name, set_code, commanders, cards, source, content_sha256, imported_at, notes) VALUES ('pair-precon','precons/pair','Pair Precon','TST','[]',?, 'MTGJSON','hash','2026-10-27','[]')")
        .bind(json!([{"name":"Partner A","oracle_id":"o-partner-a","qty":1,"board":"commander"},{"name":"Partner B","oracle_id":"o-partner-b","qty":1,"board":"commander"}]).to_string())
        .execute(pool).await.unwrap();
    (st, owner)
}

#[tokio::test]
async fn only_enabled_sources_feed_the_ranking_and_they_combine() {
    let (st, owner) = fixture().await;
    let pool = &st.pool;
    assert!(derive(pool).await.unwrap().commanders.is_empty(), "nothing shows until a source is enabled");

    enable(pool, &owner, "Playgroup.gg").await.unwrap();
    let pg_only = derive(pool).await.unwrap();
    assert_eq!(pg_only.sources.len(), 1);
    assert!(pg_only.agreement.is_none());
    let strong = pg_only.commanders.iter().find(|c| c.key == "o-strong").unwrap();
    assert_eq!(strong.games, 1100, "the Alchemy twin's games merge into the card");
    assert_eq!(strong.name, "Strong Commander");
    assert_eq!(strong.color_identity, "BG");
    assert!(strong.art.as_ref().unwrap().url.starts_with("https://cards.scryfall.io/"));
    assert!(pg_only.commanders.iter().any(|c| c.key == "o-partner-a"), "a name resolves when the printing doesn't");
    assert!(!pg_only.commanders.iter().any(|c| c.name == "Nobody Knows"), "an unknown card is left out, not guessed");
    assert_eq!(pg_only.commanders[0].key, "o-strong");
    assert_eq!(pg_only.commanders.last().unwrap().key, "o-weak");

    enable(pool, &owner, "Mythic Tools").await.unwrap();
    let both = derive(pool).await.unwrap();
    assert_eq!(both.sources.len(), 2);
    let combined = both.commanders.iter().find(|c| c.key == "o-strong").unwrap();
    assert_eq!(combined.sources.len(), 2);
    assert_eq!(combined.games, 5100);
    assert_eq!(combined.win_rate_games, 5100);
    assert_eq!(combined.win_rate_sources, 2);
    assert!(close(combined.win_rate.unwrap(), (500.0 + 0.30 * 4000.0) / 5100.0, 1e-12));
    assert!(combined.hi - combined.lo < strong.hi - strong.lo, "a second source narrows the interval");
    let mythic_only = both.commanders.iter().find(|c| c.key == "o-mythic").unwrap();
    assert!(close(mythic_only.score, 40.0, 1e-6));
    let pair = both.commanders.iter().find(|c| c.key == "o-partner-a+o-partner-b").unwrap();
    assert_eq!(pair.name, "Partner A + Partner B");
    assert_eq!(pair.color_identity, "WR");
    assert_eq!(pair.precons.len(), 1);
    assert_eq!(pair.precons[0].id, "pair-precon");
    // A partner on its own leads the pair's precon too.
    let single = both.commanders.iter().find(|c| c.key == "o-partner-b").unwrap();
    assert_eq!(single.precons[0].name, "Pair Precon");
    assert!(both.commanders.iter().find(|c| c.key == "o-weak").unwrap().precons.is_empty());

    // Stopping a source takes it straight back out.
    disable(pool, &owner, "Mythic Tools").await.unwrap();
    assert_eq!(derive(pool).await.unwrap().sources.len(), 1);
    // Mythic never reaches the precon evidence.
    assert!(crate::precon_evidence::load(pool, Utc::now()).await.unwrap().report.source_labels.is_empty());
}

#[tokio::test]
async fn a_new_revision_replaces_the_old_figures() {
    let (st, owner) = fixture().await;
    let pool = &st.pool;
    enable(pool, &owner, "Playgroup.gg").await.unwrap();
    let before = derive(pool).await.unwrap();
    import(pool, &owner, &document("pg", "Playgroup.gg", vec![counts(3, "Weak Commander", "p-weak", 900, 1000), counts(1, "Strong Commander", "p-strong", 100, 1000)])).await;
    let after = derive(pool).await.unwrap();
    assert_eq!(after.commanders[0].key, "o-weak");
    assert_ne!(before.commanders[0].key, after.commanders[0].key);
}

#[tokio::test]
async fn the_public_page_lists_commanders_without_signing_in() {
    let (st, owner) = fixture().await;
    enable(&st.pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&st.pool, &owner, "Mythic Tools").await.unwrap();
    let app = crate::routes::app(st);
    let get = |path: &str| Request::get(path).header("x-forwarded-for", "203.0.113.9").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(get("/commanders?g=0")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers().get("content-security-policy").is_some());
    let html = String::from_utf8(to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    for text in ["Strong Commander", "Partner A + Partner B", "Mythic Tools", "Playgroup.gg attribution", "Test licence", "href=\"/precons/pair-precon\"", "Art by Test Artist"] {
        assert!(html.contains(text), "{text} missing");
    }
    assert!(html.contains("Combined win rate") && html.contains("Method and sources"));
    assert!(html.contains("<details class=\"commander-sources\"><summary>2 sources</summary>"));
    // The precon a commander leads is a line under its name; one that leads none says nothing,
    // instead of a "Precon" column reading "None" on nearly every row.
    assert!(html.contains("<small class=\"commander-precon\">Precon: <a href=\"/precons/pair-precon\">Pair Precon</a>"), "{html}");
    assert!(!html.contains("data-label=\"Precon\"") && !html.contains(">None</span>") && !html.contains("Its precon rank"));
    assert!(!html.contains("<th scope=\"col\">Mythic Tools"), "source names stay in collapsed details");
    assert!(!html.contains("0–100, 50 is average"));
    assert!(!html.contains("operator@example.com"), "no account details");
    assert!(html.contains("action=\"/commanders\" data-live"), "the form filters live");
    assert!(html.contains("<div id=\"results\" data-matched=\""), "the script swaps this container");
    assert!(html.contains("</div></nav></div></main>"), "the page's rows and Next link sit inside it");
    // The default floor hides commanders with few games; a search and colors narrow the list.
    let html = String::from_utf8(to_bytes(app.clone().oneshot(get("/commanders")).await.unwrap().into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(!html.contains("Partner A</strong>"));
    let html = String::from_utf8(to_bytes(app.clone().oneshot(get("/commanders?g=0&c=U")).await.unwrap().into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("Weak Commander") && !html.contains("Strong Commander</strong>"));
    assert!(!html.contains("<h2>Strong Commander</h2>"), "the featured commander follows the color filter");
    // A source's chip lists only what it covers, keeping each commander's overall rank.
    let html = String::from_utf8(to_bytes(app.clone().oneshot(get("/commanders?g=0&src=s%3AMythic+Tools")).await.unwrap().into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("Mythic Only</strong>") && !html.contains("Weak Commander</strong>"));
    assert!(!html.contains("<h2>Strong Commander</h2>") || html.contains("Strong Commander</strong>"), "the featured commander is one the filter lists");
    assert!(html.contains("href=\"/commanders?g=0&amp;src=s%3AMythic+Tools&amp;page=1\""), "the chip links to the filter");
    let html = String::from_utf8(to_bytes(app.clone().oneshot(get("/commanders?g=0&src=all")).await.unwrap().into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("Strong Commander</strong>") && !html.contains("Mythic Only</strong>") && html.contains("<summary>2 sources</summary>"));
    let html = String::from_utf8(to_bytes(app.clone().oneshot(get("/commanders?g=0&q=weak")).await.unwrap().into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("Not covered"), "a source without the commander says so rather than showing no games");
    assert!(!html.contains("Rank #1<"), "a search keeps the overall rank");
    let res = app.clone().oneshot(get("/commanders?src=Mythic+Tools")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let res = app.clone().oneshot(get("/commanders?c=X")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let res = app.clone().oneshot(get("/commanders?g=7")).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn observed_rates_use_games_not_source_count_or_adjusted_scores() {
    let make = |rate, games| Figure {
        source: "Test".into(),
        games,
        win_rate: rate,
        decks: None,
        score: 99.0,
        estimate: None,
        prior_var: f64::INFINITY,
    };
    let a = make(Some(0.4), 100);
    let b = make(Some(0.2), 900);
    let legacy = make(None, 1_000_000);
    let (rate, games, sources) = combined_win_rate(&[a.clone(), b.clone(), legacy]).unwrap();
    assert!(close(rate, 0.22, 1e-12));
    assert_eq!((games, sources), (1000, 2));
    assert!(close(combined_win_rate(&[b, a]).unwrap().0, rate, 1e-12));
    assert_eq!(
        combined_win_rate(&[make(Some(0.0), 100)]),
        Some((0.0, 100, 1))
    );
    assert_eq!(
        combined_win_rate(&[make(Some(1.0), 100)]),
        Some((1.0, 100, 1))
    );
    assert!(combined_win_rate(&[make(None, 100), make(Some(0.5), 0)]).is_none());
    assert!(combined_win_rate(&[make(Some(0.5), u64::MAX), make(Some(0.5), 1)]).is_none());
}

#[tokio::test]
async fn legacy_scores_do_not_invent_a_rate_or_dilute_known_games() {
    let (st, owner) = fixture().await;
    let mut legacy = scored(
        &["o-strong"],
        "Strong Commander",
        99.0,
        98.0,
        99.9,
        1_000_000,
    );
    legacy["data"].as_object_mut().unwrap().remove("win_rate");
    import(
        &st.pool,
        &owner,
        &document("mythic", "Mythic Tools", vec![legacy.clone()]),
    )
    .await;
    enable(&st.pool, &owner, "Playgroup.gg").await.unwrap();
    enable(&st.pool, &owner, "Mythic Tools").await.unwrap();
    let r = derive(&st.pool).await.unwrap();
    let c = r.commanders.iter().find(|c| c.key == "o-strong").unwrap();
    assert!(close(c.win_rate.unwrap(), 500.0 / 1100.0, 1e-12));
    assert_eq!((c.win_rate_games, c.win_rate_sources), (1100, 1));
    // Invalid imported rate values stay unknown rather than turning into a percentage.
    for rate in [json!(-0.1), json!(1.1), json!("NaN"), json!("inf")] {
        legacy["data"]["win_rate"] = rate;
        assert!(matches!(
            parse(&legacy["data"]).unwrap().shape,
            Shape::Score { win_rate: None, .. }
        ));
    }
    disable(&st.pool, &owner, "Playgroup.gg").await.unwrap();
    let r = derive(&st.pool).await.unwrap();
    assert_eq!(r.commanders[0].win_rate, None);
    assert_eq!(r.commanders[0].win_rate_games, 0);
}

#[tokio::test]
async fn all_wins_or_no_wins_are_still_real_observed_rates() {
    let (st, owner) = fixture().await;
    enable(&st.pool, &owner, "Playgroup.gg").await.unwrap();
    for wins in [0, 100] {
        import(&st.pool, &owner, &document("pg", "Playgroup.gg", vec![counts(1, "Strong Commander", "p-strong", wins, 100)])).await;
        let r = derive(&st.pool).await.unwrap();
        assert_eq!(r.commanders.len(), 1);
        assert_eq!(r.commanders[0].win_rate, Some(wins as f64 / 100.0));
        assert_eq!(r.commanders[0].win_rate_games, 100);
    }
}

#[tokio::test]
async fn zero_game_source_details_never_show_a_percentage() {
    let (st, owner) = fixture().await;
    let mut zero = scored(&["o-mythic"], "Mythic Only", 50.0, 30.0, 70.0, 0);
    zero["data"]["win_rate"] = json!(0.0);
    import(&st.pool, &owner, &document("mythic", "Mythic Tools", vec![zero])).await;
    enable(&st.pool, &owner, "Mythic Tools").await.unwrap();
    let r = derive(&st.pool).await.unwrap();
    assert_eq!(r.commanders[0].sources[0].win_rate, None);
    let app = crate::routes::app(st);
    let res = app.oneshot(Request::get("/commanders?g=0").header("x-forwarded-for", "203.0.113.19").body(Body::empty()).unwrap()).await.unwrap();
    let html = String::from_utf8(to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("Win rate unavailable"));
    assert!(!html.contains("0.0%"));
}
