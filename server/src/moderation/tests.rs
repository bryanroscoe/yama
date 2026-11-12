//! Reports, takedowns and the public text filter, through the whole router.
use crate::testutil::{app, deck, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use serde_json::json;
use sqlx::SqlitePool;
use tower::ServiceExt;

/// A signed-out GET: (status, headers, body text).
async fn page(app: &Router, path: &str) -> (StatusCode, HeaderMap, String) {
    let res = app.clone().oneshot(Request::builder().uri(path).body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).into_owned())
}

/// The report form sent as a browser sends it, signed out: (status, where it redirects, body).
async fn report(app: &Router, fields: &[(&str, &str)]) -> (StatusCode, String, String) {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
    let req = Request::builder().method(Method::POST).uri("/report").header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from(body)).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let to = res.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, to, String::from_utf8_lossy(&bytes).into_owned())
}

async fn admin(pool: &SqlitePool, email: &str) -> (String, String) {
    let (id, token) = user(pool, email).await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&id).execute(pool).await.unwrap();
    (id, token)
}

/// A deck of `owner`'s shared as `visibility`: (deck id, share token).
async fn shared(app: &Router, pool: &SqlitePool, owner: &str, auth: &str, name: &str, visibility: &str) -> (String, String) {
    let (id, _) = deck(pool, owner, name).await;
    let (status, _) = send(app, Method::PATCH, &format!("/api/decks/{id}"), Some(auth), Some(json!({ "visibility": visibility }))).await;
    assert_eq!(status, StatusCode::OK);
    let token: String = sqlx::query_scalar("SELECT share_token FROM decks WHERE id = ?").bind(&id).fetch_one(pool).await.unwrap();
    (id, token)
}

async fn reports(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM content_reports").fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn anyone_can_report_a_shared_deck_or_a_profile_without_an_account() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "builder@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "builder" }))).await;
    let (id, token) = shared(&app, &pool, &owner, &auth, "Reported deck", "public").await;

    // Both pages carry the link, and the form is a plain page that search engines skip.
    let (status, _, deck_page) = page(&app, &format!("/d/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(deck_page.contains(&format!("href=\"/d/{token}/report\"")), "the deck page links to its report form");
    let (_, _, profile_page) = page(&app, "/u/builder").await;
    assert!(profile_page.contains("href=\"/u/builder/report\""), "the profile links to its report form");
    let (status, headers, form) = page(&app, &format!("/d/{token}/report")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get("x-robots-tag").unwrap(), "noindex");
    assert!(headers.get("content-security-policy").is_some());
    assert!(form.contains("action=\"/report\"") && form.contains(&format!("name=\"target\" value=\"{token}\"")), "{form}");
    for (value, _) in super::REASONS {
        assert!(form.contains(&format!("value=\"{value}\"")), "{value}");
    }
    assert!(!form.contains("style="), "public pages allow no inline styles");

    // Sending it stores the report and comes back to the form's page with a thank-you.
    let (status, to, _) = report(&app, &[("kind", "deck"), ("target", &token), ("reason", "spam"), ("details", "  Sells cards\u{7}\nin the description  ")]).await;
    assert_eq!((status, to.as_str()), (StatusCode::SEE_OTHER, format!("/d/{token}/report?sent=1").as_str()));
    let (_, _, thanks) = page(&app, &to).await;
    assert!(thanks.contains("the report was sent") && !thanks.contains("<form"), "{thanks}");
    let row: (String, String, Option<String>, String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT kind, owner_id, deck_id, reason, details, resolved_at FROM content_reports").fetch_one(&pool).await.unwrap();
    assert_eq!(row, ("deck".into(), owner.clone(), Some(id.clone()), "spam".into(), Some("Sells cards\nin the description".into()), None));
    // Nothing about the sender is stored: the table has no column for it.
    let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('content_reports')").fetch_all(&pool).await.unwrap();
    assert_eq!(columns, ["id", "kind", "owner_id", "deck_id", "reason", "details", "created_at", "resolved_at", "resolution", "resolved_by", "note"]);

    // The same report again adds nothing; a different one does. A profile report names no deck.
    report(&app, &[("kind", "deck"), ("target", &token), ("reason", "spam"), ("details", "Sells cards\nin the description")]).await;
    assert_eq!(reports(&pool).await, 1);
    report(&app, &[("kind", "deck"), ("target", &token), ("reason", "hateful")]).await;
    assert_eq!(reports(&pool).await, 2);
    let (status, to, _) = report(&app, &[("kind", "profile"), ("target", "builder"), ("reason", "other"), ("details", "x".repeat(5000).as_str())]).await;
    assert_eq!((status, to.as_str()), (StatusCode::SEE_OTHER, "/u/builder/report?sent=1"));
    let (deck_id, details): (Option<String>, String) = sqlx::query_as("SELECT deck_id, details FROM content_reports WHERE kind = 'profile'").fetch_one(&pool).await.unwrap();
    assert_eq!((deck_id, details.len()), (None, super::MAX_DETAILS));

    // No reason picked: back to the form, which says so; nothing stored.
    let (status, to, _) = report(&app, &[("kind", "deck"), ("target", &token), ("reason", "because")]).await;
    assert_eq!((status, to.as_str()), (StatusCode::SEE_OTHER, format!("/d/{token}/report?missing=1").as_str()));
    assert!(page(&app, &to).await.2.contains("role=\"alert\""));
    assert_eq!(reports(&pool).await, 3);

    // What isn't shared can't be reported, and looks like any page that isn't there.
    let (private, _) = deck(&pool, &owner, "Private deck").await;
    let private_token: String = sqlx::query_scalar("SELECT share_token FROM decks WHERE id = ?").bind(&private).fetch_one(&pool).await.unwrap();
    assert_eq!(page(&app, &format!("/d/{private_token}/report")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(report(&app, &[("kind", "deck"), ("target", &private_token), ("reason", "spam")]).await.0, StatusCode::NOT_FOUND);
    assert_eq!(report(&app, &[("kind", "profile"), ("target", "nobody-here"), ("reason", "spam")]).await.0, StatusCode::NOT_FOUND);
    assert_eq!(report(&app, &[("kind", "game"), ("target", &token), ("reason", "spam")]).await.0, StatusCode::NOT_FOUND);
    assert_eq!(page(&app, "/u/nobody-here/report").await.0, StatusCode::NOT_FOUND);
    assert_eq!(reports(&pool).await, 3);
    // The downloads beside the form still answer.
    assert_eq!(page(&app, &format!("/d/{token}/names.txt")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn reports_are_limited_per_address_and_one_page_cannot_pile_them_up() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "target@example.com").await;
    let (_, token) = shared(&app, &pool, &owner, &auth, "Flooded deck", "link").await;
    // Five an hour from one address (every request here has the same one, none). A report that
    // says what an open one already says is thanked and not stored, and still counts for its
    // sender, so the limit never tells them whether the page was reported before.
    for details in ["report 0", "report 0", "report 0", "report 1", "report 2"] {
        let (status, _, _) = report(&app, &[("kind", "deck"), ("target", &token), ("reason", "other"), ("details", details)]).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{details}");
    }
    // The sixth is refused with a page, and isn't stored.
    let (status, _, body) = report(&app, &[("kind", "deck"), ("target", &token), ("reason", "other"), ("details", "one too many")]).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body.contains("Too many reports"), "{body}");
    assert_eq!(reports(&pool).await, 3);
    // A page keeps at most twenty open reports.
    let (id, owner_id): (String, String) = sqlx::query_as("SELECT id, owner_id FROM decks WHERE share_token = ?").bind(&token).fetch_one(&pool).await.unwrap();
    for i in 0..30 {
        super::file_report(&pool, super::Target::Deck { id: &id, owner: &owner_id }, "spam", &format!("flood {i}")).await.unwrap();
    }
    assert_eq!(reports(&pool).await, 20);
    assert!(super::file_report(&pool, super::Target::Deck { id: &id, owner: &owner_id }, "nonsense", "").await.is_err());
}

/// Reports sent at the same moment are admitted one at a time, so they can't all pass the
/// limit before any of them is counted.
#[tokio::test]
async fn reports_arriving_together_still_meet_the_limit() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "target@example.com").await;
    let (_, token) = shared(&app, &pool, &owner, &auth, "Flooded deck", "public").await;
    let sent: Vec<_> = (0..12)
        .map(|i| {
            let (app, token) = (app.clone(), token.clone());
            tokio::spawn(async move { report(&app, &[("kind", "deck"), ("target", &token), ("reason", "spam"), ("details", &format!("at once {i}"))]).await.0 })
        })
        .collect();
    let mut taken = 0;
    for s in sent {
        match s.await.unwrap() {
            StatusCode::SEE_OTHER => taken += 1,
            status => assert_eq!(status, StatusCode::TOO_MANY_REQUESTS),
        }
    }
    assert_eq!((taken, reports(&pool).await), (5, 5));
}

#[tokio::test]
async fn an_admin_takes_a_deck_down_and_it_stays_private_until_restored() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "builder@example.com").await;
    let (admin_id, admin_auth) = admin(&pool, "admin@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "builder" }))).await;
    crate::sharing::list_publicly(&pool, &owner).await.unwrap();
    let (id, token) = shared(&app, &pool, &owner, &auth, "Spam deck", "public").await;
    let (other, other_token) = shared(&app, &pool, &owner, &auth, "Fine deck", "public").await;
    report(&app, &[("kind", "deck"), ("target", &token), ("reason", "spam"), ("details", "ads")]).await;
    report(&app, &[("kind", "deck"), ("target", &other_token), ("reason", "other")]).await;
    report(&app, &[("kind", "profile"), ("target", "builder"), ("reason", "hateful")]).await;

    // Only an admin sees the list or acts on it; to anyone else the routes aren't there.
    for (method, path) in [
        (Method::GET, "/api/admin/moderation".to_string()),
        (Method::POST, "/api/admin/moderation/takedowns".to_string()),
        (Method::POST, "/api/admin/moderation/reports/x/dismiss".to_string()),
        (Method::POST, "/api/admin/moderation/takedowns/x/restore".to_string()),
    ] {
        let body = (method == Method::POST).then(|| json!({ "deck": id, "reason": "mine" }));
        assert_eq!(send(&app, method.clone(), &path, Some(&auth), body.clone()).await.0, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(send(&app, method, &path, None, body).await.0, StatusCode::UNAUTHORIZED, "{path}");
    }
    let (status, list) = send(&app, Method::GET, "/api/admin/moderation", Some(&admin_auth), None).await;
    assert_eq!(status, StatusCode::OK);
    let open = list["open"].as_array().unwrap();
    assert_eq!(open.len(), 3);
    let spam = open.iter().find(|r| r["reason"] == "spam").unwrap();
    assert_eq!((&spam["deck_name"], &spam["deck_token"], &spam["handle"], &spam["owner_email"]), (&json!("Spam deck"), &json!(token), &json!("builder"), &json!("builder@example.com")));
    assert_eq!(spam["details"], "ads");
    assert_eq!(list["reasons"][0], json!(["spam", "Spam or advertising"]));

    // A takedown needs a reason. It takes the page's address as well as an id.
    let takedowns = "/api/admin/moderation/takedowns";
    assert_eq!(send(&app, Method::POST, takedowns, Some(&admin_auth), Some(json!({ "deck": id, "reason": "  " }))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::POST, takedowns, Some(&admin_auth), Some(json!({ "deck": "no-such-deck", "reason": "spam" }))).await.0, StatusCode::NOT_FOUND);
    assert!(crate::sharing::deck_listed(&pool, &id).await.unwrap());
    let (status, list) =
        send(&app, Method::POST, takedowns, Some(&admin_auth), Some(json!({ "deck": format!("https://yama.ing/d/{token}?x=1"), "reason": "Advertising in the description" }))).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    // Its reports are resolved with it; the others stay open.
    assert_eq!(list["open"].as_array().unwrap().len(), 2);
    let resolved = &list["resolved"][0];
    assert_eq!((&resolved["resolution"], &resolved["note"], &resolved["deck_taken_down"]), (&json!("taken_down"), &json!("Advertising in the description"), &json!(true)));
    let down = &list["takedowns"][0];
    assert_eq!(
        (&down["deck_name"], &down["admin_email"], &down["reason"], &down["was_visibility"], &down["restored_at"]),
        (&json!("Spam deck"), &json!("admin@example.com"), &json!("Advertising in the description"), &json!("public"), &json!(null))
    );
    let recorded: (String, String, Option<String>) = sqlx::query_as("SELECT deck_id, owner_id, admin_id FROM deck_takedowns").fetch_one(&pool).await.unwrap();
    assert_eq!(recorded, (id.clone(), owner.clone(), Some(admin_id.clone())));
    assert_eq!(send(&app, Method::POST, takedowns, Some(&admin_auth), Some(json!({ "deck": id, "reason": "again" }))).await.0, StatusCode::CONFLICT);

    // The deck is private: its page, its downloads, its report form, the copy API and the
    // profile no longer have it, and it is not listed.
    let visibility = || async { sqlx::query_scalar::<_, String>("SELECT visibility FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap() };
    assert_eq!(visibility().await, "private");
    for path in [format!("/d/{token}"), format!("/d/{token}/names.txt"), format!("/d/{token}/report"), format!("/api/public/decks/{token}")] {
        assert_eq!(page(&app, &path).await.0, StatusCode::NOT_FOUND, "{path}");
    }
    let (_, _, profile) = page(&app, "/u/builder").await;
    assert!(!profile.contains("Spam deck") && profile.contains("Fine deck"));
    assert!(!crate::sharing::deck_listed(&pool, &id).await.unwrap());
    assert!(crate::sharing::deck_listed(&pool, &other).await.unwrap());

    // Its owner can't share it again, one deck at a time or all at once, and is told why. Other
    // changes to the deck still save.
    let path = format!("/api/decks/{id}");
    for v in ["public", "link"] {
        let (status, body) = send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": v }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{v}");
        assert!(body["error"].as_str().unwrap().contains("Advertising in the description"), "{body}");
    }
    assert_eq!(send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": "private", "name": "Renamed" }))).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::POST, "/api/me/sharing/decks", Some(&auth), Some(json!({ "visibility": "public" }))).await.0, StatusCode::OK);
    assert_eq!(visibility().await, "private");
    // Even a visibility written some other way doesn't bring the page back while it stands.
    sqlx::query("UPDATE decks SET visibility = 'public' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::NOT_FOUND);
    assert!(!crate::sharing::deck_listed(&pool, &id).await.unwrap());
    sqlx::query("UPDATE decks SET visibility = 'private' WHERE id = ?").bind(&id).execute(&pool).await.unwrap();

    // Restored: still private, and its owner may share it again.
    let takedown: String = sqlx::query_scalar("SELECT id FROM deck_takedowns").fetch_one(&pool).await.unwrap();
    let restore = format!("/api/admin/moderation/takedowns/{takedown}/restore");
    let (status, list) = send(&app, Method::POST, &restore, Some(&admin_auth), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(list["takedowns"][0]["restored_at"].is_string());
    assert_eq!(send(&app, Method::POST, &restore, Some(&admin_auth), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(visibility().await, "private");
    assert_eq!(send(&app, Method::PATCH, &path, Some(&auth), Some(json!({ "visibility": "public" }))).await.0, StatusCode::OK);
    assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::OK);

    // A report that needs nothing done is dismissed, once.
    let profile_report: String = sqlx::query_scalar("SELECT id FROM content_reports WHERE kind = 'profile'").fetch_one(&pool).await.unwrap();
    let dismiss = format!("/api/admin/moderation/reports/{profile_report}/dismiss");
    let (status, list) = send(&app, Method::POST, &dismiss, Some(&admin_auth), Some(json!({ "note": "Nothing wrong with it" }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["open"].as_array().unwrap().len(), 1);
    let (resolution, by, note): (String, String, String) =
        sqlx::query_as("SELECT resolution, resolved_by, note FROM content_reports WHERE id = ?").bind(&profile_report).fetch_one(&pool).await.unwrap();
    assert_eq!((resolution.as_str(), by, note.as_str()), ("dismissed", admin_id, "Nothing wrong with it"));
    assert_eq!(send(&app, Method::POST, &dismiss, Some(&admin_auth), Some(json!({}))).await.0, StatusCode::NOT_FOUND);
}

/// A deck's configurations carry its name and most of its list, so a takedown covers the
/// family, whichever of them was named, and a configuration made afterwards.
#[tokio::test]
async fn a_takedown_covers_the_deck_and_its_configurations() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "builder@example.com").await;
    let (_, admin_auth) = admin(&pool, "admin@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "builder" }))).await;
    let (main, main_token) = shared(&app, &pool, &owner, &auth, "Buy at my shop", "public").await;
    let configure = |label: &'static str| {
        let (app, auth, main) = (app.clone(), auth.clone(), main.clone());
        async move {
            let (status, made) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&auth), Some(json!({ "configuration": label, "op_id": format!("config-{label}") }))).await;
            assert_eq!(status, StatusCode::OK, "{made}");
            made["id"].as_str().unwrap().to_string()
        }
    };
    let token_of = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, String>("SELECT share_token FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    // A configuration starts as public as the deck it copies.
    let budget = configure("budget").await;
    let budget_token = token_of(budget.clone()).await;
    assert_eq!(page(&app, &format!("/d/{budget_token}")).await.0, StatusCode::OK);
    report(&app, &[("kind", "deck"), ("target", &budget_token), ("reason", "spam")]).await;

    // Taking the configuration down takes the main deck down with it, on the main deck's record.
    let (status, list) = send(&app, Method::POST, "/api/admin/moderation/takedowns", Some(&admin_auth), Some(json!({ "deck": budget_token, "reason": "Advertising" }))).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!((&list["takedowns"][0]["deck_id"], &list["takedowns"][0]["was_visibility"]), (&json!(main), &json!("public")));
    assert_eq!(list["open"].as_array().unwrap().len(), 0, "the configuration's report is resolved with it");
    for token in [&main_token, &budget_token] {
        assert_eq!(page(&app, &format!("/d/{token}")).await.0, StatusCode::NOT_FOUND);
    }
    // Naming the main deck again is the same takedown.
    assert_eq!(send(&app, Method::POST, "/api/admin/moderation/takedowns", Some(&admin_auth), Some(json!({ "deck": main, "reason": "again" }))).await.0, StatusCode::CONFLICT);

    // A configuration made now can't stand in for it, attached or moved out on its own.
    let later = configure("later").await;
    for body in [json!({ "visibility": "public" }), json!({ "visibility": "link", "parent_id": null })] {
        let (status, refused) = send(&app, Method::PATCH, &format!("/api/decks/{later}"), Some(&auth), Some(body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert!(refused["error"].as_str().unwrap().contains("Advertising"), "{refused}");
    }
    assert_eq!(send(&app, Method::PATCH, &format!("/api/decks/{later}"), Some(&auth), Some(json!({ "parent_id": null }))).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::PATCH, &format!("/api/decks/{later}"), Some(&auth), Some(json!({ "visibility": "public" }))).await.0, StatusCode::FORBIDDEN);
    send(&app, Method::POST, "/api/me/sharing/decks", Some(&auth), Some(json!({ "visibility": "public" }))).await;
    let shared_again: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE owner_id = ? AND visibility <> 'private'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(shared_again, 0);

    // Restoring lifts it from every deck it locked, the one moved out on its own too.
    let takedown: String = sqlx::query_scalar("SELECT id FROM deck_takedowns").fetch_one(&pool).await.unwrap();
    assert_eq!(send(&app, Method::POST, &format!("/api/admin/moderation/takedowns/{takedown}/restore"), Some(&admin_auth), None).await.0, StatusCode::OK);
    for id in [&main, &budget, &later] {
        assert_eq!(send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&auth), Some(json!({ "visibility": "public" }))).await.0, StatusCode::OK);
    }
}

#[tokio::test]
async fn public_pages_mask_slurs_and_take_links_out_of_public_decks() {
    let (app, pool) = app().await;
    let (owner, auth) = user(&pool, "builder@example.com").await;
    let (_, viewer) = user(&pool, "viewer@example.com").await;
    send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "builder" }))).await;
    let describe = |id: String, auth: String| {
        let app = app.clone();
        async move {
            let body = json!({ "description": "Retard tribal.\n\nBuy singles at https://spam.example/cheap and www.spam.com." });
            assert_eq!(send(&app, Method::PATCH, &format!("/api/decks/{id}"), Some(&auth), Some(body)).await.0, StatusCode::OK);
        }
    };
    let (public, public_token) = shared(&app, &pool, &owner, &auth, "Faggot Stompy spam.com", "public").await;
    let (link, link_token) = shared(&app, &pool, &owner, &auth, "Faggot Stompy by link", "link").await;
    describe(public.clone(), auth.clone()).await;
    describe(link.clone(), auth.clone()).await;

    // A public deck: the slur is masked and the links are gone, on its page, its profile tile,
    // the copy API and the signed-in view of the profile.
    let (_, _, html) = page(&app, &format!("/d/{public_token}")).await;
    assert!(html.contains("*** Stompy [link removed]"), "the name is filtered");
    assert!(html.contains("*** tribal.") && html.contains("Buy singles at [link removed] and [link removed]."), "the description is filtered");
    assert!(!html.to_lowercase().contains("faggot") && !html.to_lowercase().contains("retard") && !html.contains("spam.example") && !html.contains("spam.com"));
    let (_, _, profile) = page(&app, "/u/builder").await;
    assert!(profile.contains("*** Stompy [link removed]") && !profile.to_lowercase().contains("faggot"));
    let (_, copy) = send(&app, Method::GET, &format!("/api/public/decks/{public_token}"), None, None).await;
    assert_eq!(copy["name"], "*** Stompy [link removed]");
    let (status, seen) = send(&app, Method::GET, "/api/people/builder/decks", Some(&viewer), None).await;
    assert_eq!((status, seen[0]["name"].as_str()), (StatusCode::OK, Some("*** Stompy [link removed]")), "{seen}");
    assert!(!seen.to_string().to_lowercase().contains("faggot"), "{seen}");

    // A deck shared by link: the slur is masked, the links its owner sent to friends stay.
    let (_, _, html) = page(&app, &format!("/d/{link_token}")).await;
    assert!(html.contains("*** Stompy by link") && html.contains("https://spam.example/cheap") && html.contains("*** tribal."));

    // The owner's own copy is untouched: the filter is for public pages only.
    let (_, mine) = send(&app, Method::GET, &format!("/api/decks/{public}"), Some(&auth), None).await;
    assert_eq!(mine["name"], "Faggot Stompy spam.com");

    // A handle with one of the words in it is refused, like a reserved one.
    for bad in ["faggot", "the-faggot-king", "xXn1ggerXx"] {
        let (status, body) = send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": bad }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
    }
    let (_, me) = send(&app, Method::GET, "/api/me/sharing", Some(&auth), None).await;
    assert_eq!(me["handle"], "builder");
    // The filter is for choosing a handle, not for finding one: a handle someone already has
    // still opens their profile and can be kept, and an honest word that holds one isn't refused.
    sqlx::query("UPDATE users SET handle = 'old-n1gger-handle' WHERE id = ?").bind(&owner).execute(&pool).await.unwrap();
    assert_eq!(page(&app, "/u/old-n1gger-handle").await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "old-n1gger-handle" }))).await.0, StatusCode::OK);
    assert_eq!(send(&app, Method::PUT, "/api/me/sharing", Some(&auth), Some(json!({ "handle": "fire-retardant" }))).await.0, StatusCode::OK);
}
