use super::*;
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};
use serde_json::json;

/// A finished Mythic game: Bryan (account 1) against Chris (account 2) and a guest Bryan keeps.
fn mythic_game(id: i64, started: &str, winner: i64, note: Option<&str>) -> Value {
    json!({ "game": {
        "id": id, "started_at": started, "ended_at": started, "active": true, "formatid": 6,
        "created_by": 1, "winner": winner, "winners": [{ "id": winner, "firstname": "x" }],
        "note": note, "tags": [],
        "players": [
            { "id": 2, "firstname": "Chris", "position": 1, "lifetotal": 40, "startingplayer": false,
              "deck": { "name": "Avengers Assemble", "commander_name": "Captain America, First Avenger" } },
            { "id": 1, "firstname": "Bryan", "position": 0, "lifetotal": 40, "startingplayer": true,
              "deck": { "name": "Prossh", "commander_name": "Prossh, Skyraider of Kher" } },
            { "id": null, "managed_player_id": 77, "firstname": "Dana", "position": 2, "lifetotal": 40,
              "deck": { "name": "Big Red" } }
        ]
    }})
}

fn export(games: Vec<Value>) -> Value {
    json!({ "source": "mythic.tools", "me": { "id": 1, "name": "Bryan" }, "games": games })
}

async fn group(app: &axum::Router, token: &str) -> (String, Vec<Value>) {
    let (s, g) = send(app, Method::POST, "/api/playgroups", Some(token), Some(json!({ "name": "Magic Bros" }))).await;
    assert_eq!(s, StatusCode::OK, "{g}");
    (g["id"].as_str().unwrap().to_string(), g["members"].as_array().unwrap().clone())
}

#[tokio::test]
async fn imports_once_then_updates_what_mythic_changed() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    let one = || export(vec![mythic_game(10, "2026-10-04T01:35:04.551Z", 2, None), mythic_game(11, "2026-10-11T01:00:00Z", 1, None)]);

    let (s, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": one() }))).await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!(p["me"], "1");
    assert_eq!(p["counts"]["new"], 2);
    let g = &p["games"][0];
    assert_eq!(g["action"], "create");
    // Seats in Mythic's order; Bryan's own seat is his.
    assert_eq!(g["seats"][0]["name"], "Bryan");
    assert_eq!(g["seats"][0]["me"], true);
    assert_eq!(g["seats"][1]["won"], true);
    // A preview writes nothing.
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);

    let (s, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": one() }))).await;
    assert_eq!(s, StatusCode::OK, "{a}");
    assert_eq!(a["created"], 2);
    let id = derived_id(&bryan, "10");
    let (status, note, by): (String, Option<String>, String) =
        sqlx::query_as("SELECT status, note, created_by FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!((status.as_str(), note.as_deref(), by.as_str()), ("finished", Some(NOTE), bryan.as_str()));
    let seats: Vec<(i64, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT seat, user_id, guest_name, commander_name FROM game_seats WHERE game_id = ? ORDER BY seat").bind(&id).fetch_all(&pool).await.unwrap();
    assert_eq!(seats[0], (0, Some(bryan.clone()), None, Some("Prossh, Skyraider of Kher".into())));
    assert_eq!(seats[1].2.as_deref(), Some("Chris"));
    assert_eq!(seats[2].2.as_deref(), Some("Dana"));
    let (winner, first): (Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT winner_seat, first_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!((winner, first), (Some(1), Some(0)));

    // The same file again: nothing to do.
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": one() }))).await;
    assert_eq!(p["counts"]["unchanged"], 2, "{p}");
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": one() }))).await;
    assert_eq!((a["created"].as_i64(), a["skipped"].as_i64()), (Some(0), Some(2)));

    // Mythic changed the winner: that game is saved again, in place.
    let changed = export(vec![mythic_game(10, "2026-10-04T01:35:04.551Z", 1, None)]);
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": changed }))).await;
    assert_eq!(a["updated"], 1, "{a}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(0));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 2);

    // Deleted in Yama: it stays deleted.
    let (s, _) = send(&app, Method::DELETE, &format!("/api/games/{id}"), Some(&token), None).await;
    assert_eq!(s, StatusCode::OK);
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": changed }))).await;
    assert_eq!(p["games"][0]["status"], "deleted");
    assert_eq!(p["games"][0]["action"], "skip");
}

#[tokio::test]
async fn players_are_matched_to_members_the_person_confirms() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    let (chris, chris_token) = user(&pool, "chris@example.com").await;
    let (pg, _) = group(&app, &token).await;
    let code: String = sqlx::query_scalar("SELECT join_code FROM playgroups WHERE id = ?").bind(&pg).fetch_one(&pool).await.unwrap();
    let (s, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&chris_token), Some(json!({ "code": code }))).await;
    assert_eq!(s, StatusCode::OK);
    let chris_member: String =
        sqlx::query_scalar("SELECT id FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?").bind(&pg).bind(&chris).fetch_one(&pool).await.unwrap();
    let file = || export(vec![mythic_game(20, "2026-10-04T01:35:04Z", 2, None)]);

    // Chris is suggested by name, but nothing is matched until the person says so.
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": file(), "playgroup_id": pg }))).await;
    let row = p["players"].as_array().unwrap().iter().find(|r| r["mythic_id"] == "2").unwrap().clone();
    assert_eq!(row["suggested"], chris_member.as_str());
    assert!(row["member_id"].is_null());

    // A member of another group is refused.
    let (s, _) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token),
        Some(json!({ "export": file(), "playgroup_id": pg, "players": { "2": "someone-else" } }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // One member can't be two players, nor anyone but the importer be the importer's member.
    let bryan_member: String =
        sqlx::query_scalar("SELECT id FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?").bind(&pg).bind(&bryan).fetch_one(&pool).await.unwrap();
    for players in [json!({ "2": chris_member, "managed:77": chris_member }), json!({ "2": bryan_member })] {
        let (s, r) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token),
            Some(json!({ "export": file(), "playgroup_id": pg, "players": players }))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{r}");
    }

    let (s, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": file(), "playgroup_id": pg, "players": { "2": chris_member } }))).await;
    assert_eq!(s, StatusCode::OK, "{a}");
    let id = derived_id(&bryan, "20");
    let seat: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT member_id, user_id FROM game_seats WHERE game_id = ? AND seat = 1").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(seat, (Some(chris_member.clone()), Some(chris.clone())));

    // Saying "I'm Chris" with Bryan's old pick of Chris's member still on the page: that pick isn't
    // saved, and Chris's own match (here, the guest Dana's player) stays.
    let (s, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": file(), "playgroup_id": pg, "me": "1", "players": { "managed:77": chris_member, "1": chris_member } }))).await;
    assert_eq!(s, StatusCode::OK, "{a}");
    let kept: Option<String> = sqlx::query_scalar("SELECT mythic_id FROM mythic_links WHERE owner_id = ? AND kind = 'player' AND yama_id = ?")
        .bind(&bryan).bind(&chris_member).fetch_optional(&pool).await.unwrap();
    assert_eq!(kept.as_deref(), Some("managed:77"));
    let (s, _) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": file(), "playgroup_id": pg, "players": { "2": chris_member, "managed:77": null } }))).await;
    assert_eq!(s, StatusCode::OK);

    // The match is remembered for the next import.
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(21, "2026-10-12T01:00:00Z", 1, None)]), "playgroup_id": pg }))).await;
    let row = p["players"].as_array().unwrap().iter().find(|r| r["mythic_id"] == "2").unwrap().clone();
    assert_eq!(row["member_id"], chris_member.as_str());
}

#[tokio::test]
async fn mythic_notes_stay_with_the_importer() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    let (_, chris_token) = user(&pool, "chris@example.com").await;
    let file = export(vec![mythic_game(30, "2026-10-04T01:35:04Z", 2, Some("Chris misplayed the combo"))]);
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": file }))).await;
    assert_eq!(a["created"], 1, "{a}");
    let id = derived_id(&bryan, "30");
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(note.as_deref(), Some(NOTE));
    let (s, n) = send(&app, Method::GET, &format!("/api/bridges/mythic/games/{id}/note"), Some(&token), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(n["note"], "Chris misplayed the combo");
    let (s, _) = send(&app, Method::GET, &format!("/api/bridges/mythic/games/{id}/note"), Some(&chris_token), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_game_already_in_yama_is_offered_and_only_linked() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    // Someone else's game the same evening, three players but not Bryan: never offered.
    let other = crate::util::new_id();
    let (s, _) = send(&app, Method::POST, "/api/games", Some(&token), Some(json!({
        "id": other, "started_at": "2026-10-04T19:00:00Z",
        "seats": [{ "seat": 0, "guest_name": "X" }, { "seat": 1, "guest_name": "Y" }, { "seat": 2, "guest_name": "Z" }],
        "finish": { "winner_seat": 0, "ended_at": "2026-10-04T19:00:00Z" }
    }))).await;
    assert_eq!(s, StatusCode::OK);
    // Logged by hand that evening, Bryan and two others.
    let hand = crate::util::new_id();
    let (s, r) = send(&app, Method::POST, "/api/games", Some(&token), Some(json!({
        "id": hand, "started_at": "2026-10-04T20:00:00Z",
        "seats": [{ "seat": 0, "user_id": bryan }, { "seat": 1, "guest_name": "B" }, { "seat": 2, "guest_name": "C" }],
        "finish": { "winner_seat": 0, "ended_at": "2026-10-04T20:00:00Z" }, "note": "Logged after the game"
    }))).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let file = || export(vec![mythic_game(40, "2026-10-04T12:00:00Z", 2, None)]);

    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": file() }))).await;
    assert_eq!(p["games"][0]["status"], "match", "{p}");
    assert_eq!(p["games"][0]["action"], "skip");
    let offered = p["games"][0]["matches"].as_array().unwrap();
    assert_eq!(offered.len(), 1, "{p}");
    assert_eq!(offered[0]["id"], hand.as_str());
    assert!(offered[0]["players"].as_array().unwrap().iter().any(|n| n == "bryan"), "{p}");

    let choice = json!({ "40": format!("link:{hand}") });
    // A game that isn't offered for it (another week) can't be chosen, however the choice came.
    let far = crate::util::new_id();
    let (s, _) = send(&app, Method::POST, "/api/games", Some(&token), Some(json!({
        "id": far, "started_at": "2026-10-11T20:00:00Z",
        "seats": [{ "seat": 0, "user_id": bryan }, { "seat": 1, "guest_name": "B" }, { "seat": 2, "guest_name": "C" }],
        "finish": { "winner_seat": 0, "ended_at": "2026-10-11T20:00:00Z" }
    }))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": file(), "choices": { "40": format!("link:{far}") } }))).await;
    assert_eq!(s, StatusCode::CONFLICT);

    // The same Yama game can't be chosen for two Mythic games.
    let mut twin = mythic_game(41, "2026-10-04T13:00:00Z", 2, None);
    twin["game"]["id"] = json!(41);
    let both = json!({ "40": format!("link:{hand}"), "41": format!("link:{hand}") });
    let (s, _) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(40, "2026-10-04T12:00:00Z", 2, Some("Close one")), twin]), "choices": both }))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mythic_links WHERE kind = 'game'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);

    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(40, "2026-10-04T12:00:00Z", 2, Some("Close one"))]), "choices": choice }))).await;
    assert_eq!(a["linked"], 1, "{a}");
    // Mythic's note is kept for the importer, beside the game logged by hand.
    let (s, n) = send(&app, Method::GET, &format!("/api/bridges/mythic/games/{hand}/note"), Some(&token), None).await;
    assert_eq!((s, n["note"].as_str()), (StatusCode::OK, Some("Close one")));
    // Nothing was written to the game logged by hand.
    let (n, note): (i64, Option<String>) =
        sqlx::query_as("SELECT (SELECT COUNT(*) FROM games), note FROM games WHERE id = ?").bind(&hand).fetch_one(&pool).await.unwrap();
    assert_eq!((n, note.as_deref()), (3, Some("Logged after the game")));
    // Mythic's note changed since (file() has none): only the private note follows.
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": file() }))).await;
    assert_eq!((p["games"][0]["status"].as_str(), p["games"][0]["action"].as_str()), (Some("linked"), Some("note")));
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": file() }))).await;
    assert_eq!(a["notes"], 1, "{a}");
    let (s, _) = send(&app, Method::GET, &format!("/api/bridges/mythic/games/{hand}/note"), Some(&token), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": file() }))).await;
    assert_eq!((p["games"][0]["status"].as_str(), p["games"][0]["action"].as_str()), (Some("linked"), Some("skip")));
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM games WHERE id = ?").bind(&hand).fetch_one(&pool).await.unwrap();
    assert_eq!(note.as_deref(), Some("Logged after the game"));
}

#[tokio::test]
async fn games_yama_cant_store_are_listed_not_imported() {
    let (app, pool) = app().await;
    let (_, token) = user(&pool, "bryan@example.com").await;
    let mut unfinished = mythic_game(50, "2026-10-04T01:00:00Z", 1, None);
    unfinished["game"]["ended_at"] = Value::Null;
    unfinished["game"]["winner"] = Value::Null;
    unfinished["game"]["winners"] = json!([]);
    let mut other_format = mythic_game(51, "2026-10-04T01:00:00Z", 1, None);
    other_format["game"]["formatid"] = json!(1);
    let mut no_format = mythic_game(52, "2026-10-04T01:00:00Z", 1, None);
    no_format["game"]["formatid"] = Value::Null;
    let mut no_end = mythic_game(53, "2026-10-04T01:00:00Z", 1, None);
    no_end["game"]["ended_at"] = Value::Null;
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": export(vec![unfinished, other_format, no_format, no_end]) }))).await;
    assert_eq!((a["created"].as_i64(), a["skipped"].as_i64()), (Some(0), Some(4)), "{a}");
}

#[tokio::test]
async fn a_guest_player_can_win() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    // Dana, kept by Bryan without a Mythic account, won.
    let mut g = mythic_game(60, "2026-10-04T01:00:00Z", 77, None);
    g["game"]["winners"] = json!([{ "id": 77 }]);
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": export(vec![g]) }))).await;
    assert_eq!(a["created"], 1, "{a}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(derived_id(&bryan, "60")).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(2));
}

#[tokio::test]
async fn a_changed_mythic_note_never_rewrites_the_game() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(70, "2026-10-04T01:00:00Z", 2, Some("first"))]) }))).await;
    assert_eq!(a["created"], 1, "{a}");
    let id = derived_id(&bryan, "70");
    // A fun rating alone is an edit in Yama too.
    sqlx::query("UPDATE game_seats SET fun = 5 WHERE game_id = ? AND seat = 0").bind(&id).execute(&pool).await.unwrap();
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(70, "2026-10-04T01:00:00Z", 1, Some("first"))]) }))).await;
    assert_eq!(p["games"][0]["status"], "conflict", "{p}");
    // Edited in Yama afterwards: Bryan won after all.
    sqlx::query("UPDATE games SET winner_seat = 0 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();

    // Only Mythic's note changed: the note follows, the game keeps the edit.
    let file = json!({ "export": export(vec![mythic_game(70, "2026-10-04T01:00:00Z", 2, Some("second"))]) });
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(file.clone())).await;
    assert_eq!((p["games"][0]["status"].as_str(), p["games"][0]["action"].as_str()), (Some("note"), Some("note")), "{p}");
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(file.clone())).await;
    assert_eq!(a["notes"], 1, "{a}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(0));
    let (_, n) = send(&app, Method::GET, &format!("/api/bridges/mythic/games/{id}/note"), Some(&token), None).await;
    assert_eq!(n["note"], "second");
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(file)).await;
    assert_eq!(p["games"][0]["status"], "unchanged");

    // Now Mythic changes the game itself: Yama's edit is a conflict, kept unless the person
    // chooses Mythic's version.
    let changed = || json!([mythic_game(70, "2026-10-04T01:00:00Z", 77, Some("second"))]);
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": { "games": changed() } }))).await;
    assert_eq!((p["games"][0]["status"].as_str(), p["games"][0]["action"].as_str()), (Some("conflict"), Some("skip")), "{p}");
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token), Some(json!({ "export": { "games": changed() }, "me": "1" }))).await;
    assert_eq!(a["skipped"], 1, "{a}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(0));
    // Keeping Yama's version settles it: asked once, not again.
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": { "games": changed() }, "me": "1", "choices": { "70": "keep" } }))).await;
    assert_eq!(a["kept"], 1, "{a}");
    let (_, p) = send(&app, Method::POST, "/api/bridges/mythic/games/preview", Some(&token), Some(json!({ "export": { "games": changed() } }))).await;
    assert_eq!(p["games"][0]["status"], "unchanged", "{p}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(0));

    // Mythic changes again, and this time the person takes Mythic's version.
    let changed = || json!([mythic_game(70, "2026-10-04T01:00:00Z", 77, Some("third"))]);
    sqlx::query("UPDATE game_seats SET fun = 4 WHERE game_id = ? AND seat = 0").bind(&id).execute(&pool).await.unwrap();
    let mut g = changed();
    g[0]["game"]["ended_at"] = json!("2026-10-04T02:00:00Z");
    let changed = move || g.clone();
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": { "games": changed() }, "me": "1", "choices": { "70": "update" } }))).await;
    assert_eq!(a["updated"], 1, "{a}");
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(2));
}

#[test]
fn derived_ids_are_stable_uuids_per_person() {
    let a = derived_id("u1", "10");
    assert_eq!(a, derived_id("u1", "10"));
    assert_ne!(a, derived_id("u2", "10"));
    assert!(uuid::Uuid::parse_str(&a).is_ok());
}

#[tokio::test]
async fn a_yama_edit_during_apply_is_not_overwritten() {
    let (app, pool) = app().await;
    let (bryan, token) = user(&pool, "bryan@example.com").await;
    let (_, a) = send(&app, Method::POST, "/api/bridges/mythic/games/apply", Some(&token),
        Some(json!({ "export": export(vec![mythic_game(80, "2026-10-04T01:00:00Z", 2, None)]) }))).await;
    assert_eq!(a["created"], 1, "{a}");
    let id = derived_id(&bryan, "80");
    // The plan saw the game one way; by the time Apply writes it, someone edited it in Yama.
    let seen = yama_print(&pool, &id).await.unwrap();
    sqlx::query("UPDATE games SET winner_seat = 0 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
    let game = NewGame {
        id: id.clone(),
        playgroup_id: None,
        format: "commander".into(),
        starting_life: 40,
        started_at: Some("2026-10-04T01:00:00+00:00".into()),
        seats: vec![Seat {
            seat: 0, member_id: None, user_id: Some(bryan.clone()), guest_name: None, ai_kind: None, deck_version_id: None,
            deck_label: None, commander_name: None, final_life: None, eliminated_turn: None, eliminated_by_seat: None, fun: None, display_name: None,
        }],
        events: vec![],
        finish: Some(Finish { winner_seat: None, turns: None, ended_at: None, first_seat: None, win_condition: None, seats: vec![] }),
        note: Some(NOTE.into()),
    };
    let sync = Sync { mythic: "80", yama: &id, fingerprint: "a b", keep_yama: None, note: None, tags: &[] };
    let r = save_game(&pool, &bryan, game, Some(&seen), sync).await;
    assert!(matches!(r, Err(AppError::Conflict(_))));
    let winner: Option<i64> = sqlx::query_scalar("SELECT winner_seat FROM games WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(winner, Some(0));
}
