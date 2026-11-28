//! Atomic subset creation and historical game reassignment. Never searches arbitrary accounts.
use super::*;
use sqlx::SqliteConnection;
use std::collections::BTreeSet;

fn strings(args: &Value, key: &str, max: usize) -> AppResult<Vec<String>> {
    let values = args[key]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= max)
        .ok_or_else(|| AppError::bad(format!("{key} needs 1 to {max} entries")))?;
    let mut out = BTreeSet::new();
    for v in values {
        let s = v
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 300)
            .ok_or_else(|| AppError::bad(format!("{key} entries must be nonempty text")))?;
        if !out.insert(s.to_string()) {
            return Err(AppError::bad(format!("{key} has duplicates")));
        }
    }
    Ok(out.into_iter().collect())
}

// Capture the complete relevant state under one database snapshot, then compare again under
// BEGIN IMMEDIATE. Result fields are never written, even when remapping member references.
async fn snapshot(conn: &mut SqliteConnection, owner: &str, args: &Value) -> AppResult<Value> {
    let source = arg::text(args, "source_playgroup")?;
    let group: Option<String> =
        sqlx::query_scalar("SELECT name FROM playgroups WHERE id=? AND owner_id=?")
            .bind(source)
            .bind(owner)
            .fetch_optional(&mut *conn)
            .await?;
    let group = group.ok_or(AppError::NotFound("owned playgroup"))?;
    let names = strings(args, "members", 100)?;
    let mut all = crate::playgroups::members(&mut *conn, source).await?;
    // Older groups predate the owner's membership row. Ownership still makes them a member.
    if !all.iter().any(|m| m.user_id.as_deref() == Some(owner)) {
        let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=? AND disabled_at IS NULL")
            .bind(owner).fetch_one(&mut *conn).await?;
        all.push(crate::playgroups::Member { id: String::new(), user_id: Some(owner.into()), guest_name: None, display_name: name, handle: None });
    }
    let mut members = Vec::new();
    for name in names {
        let matches: Vec<_> = all
            .iter()
            .filter(|m| m.display_name == name && m.user_id.is_some())
            .collect();
        if matches.len() != 1 {
            return Err(AppError::bad(format!(
                "{name} must name exactly one account member in the source playgroup"
            )));
        }
        let m = matches[0];
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)",
        )
        .bind(m.user_id.as_deref())
        .fetch_one(&mut *conn)
        .await?;
        if !active {
            return Err(AppError::bad("Selected members must have active accounts"));
        }
        members.push(json!({"id": m.id, "user_id": m.user_id, "name": m.display_name}));
    }
    if !members.iter().any(|m| m["user_id"] == owner) {
        return Err(AppError::bad("Include yourself in members"));
    }
    let mut games = Vec::new();
    for id in strings(args, "games", 200)? {
        let game: Option<String> = sqlx::query_scalar("SELECT json_object('id',id,'group',playgroup_id,'started_at',started_at,'ended_at',ended_at,'winner',winner_seat,'turns',turns,'note',note) FROM games WHERE id=? AND created_by=? AND mode='in_person' AND status='finished' AND (playgroup_id=? OR playgroup_id IS NULL)")
            .bind(&id).bind(owner).bind(source).fetch_optional(&mut *conn).await?;
        let game: Value = serde_json::from_str(&game.ok_or(AppError::NotFound(
            "owned finished game in source group or ungrouped",
        ))?)
        .map_err(anyhow::Error::from)?;
        let seats: Vec<(i64, Option<String>, Option<String>, Option<String>)> = sqlx::query_as("SELECT s.seat,s.member_id,COALESCE(s.user_id,m.user_id),s.ai_kind FROM game_seats s LEFT JOIN playgroup_members m ON m.id=s.member_id WHERE s.game_id=? ORDER BY s.seat")
            .bind(&id).fetch_all(&mut *conn).await?;
        let mut saved = Vec::new();
        let mut users = BTreeSet::new();
        for (seat, member, user, ai) in seats {
            let Some(u) = user.filter(|_| ai.is_none()) else {
                return Err(AppError::bad(
                    "Only games with identified account seats can move",
                ));
            };
            let Some(m) = members.iter().find(|m| m["user_id"] == u) else {
                return Err(AppError::bad(
                    "A selected game has a player outside the selected members",
                ));
            };
            if member
                .as_deref()
                .is_some_and(|id| Some(id) != m["id"].as_str())
                || !users.insert(u.clone())
            {
                return Err(AppError::bad(
                    "A selected game's seats do not match the source members",
                ));
            }
            let revision: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(revision),0) FROM history_correction_targets WHERE game_id=?",
            )
            .bind(&id)
            .fetch_one(&mut *conn)
            .await?;
            saved.push(json!({"seat":seat,"member_id":member,"user_id":u,"revision":revision}));
        }
        if users.len() != members.len() {
            return Err(AppError::bad(
                "Every selected game must have exactly the selected account members",
            ));
        }
        games.push(json!({"game":game,"seats":saved}));
    }
    Ok(json!({"source":source,"source_name":group,"members":members,"games":games}))
}

pub(crate) async fn split(
    st: &AppState,
    user: &User,
    via: &Via,
    args: &Value,
) -> AppResult<String> {
    let name = crate::playgroups::clean_name(
        arg::text(args, "name")?,
        "playgroup",
        crate::playgroups::NAME_MAX,
    )?;
    let mut tx = st.pool.begin().await?;
    let before = snapshot(&mut tx, &user.id, args).await?;
    tx.commit().await?;
    let summary = format!(
        "Create playgroup {name} and move {} games",
        before["games"].as_array().unwrap().len()
    );
    let detail = format!(
        "Members: {}. From: {}. Games: {}. Only group membership references change; results and events stay. Old offline writes to these games will be refused; history editing in the app will be disabled.",
        before["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["name"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join(", "),
        before["source_name"].as_str().unwrap(),
        strings(args, "games", 200)?.join(", ")
    );
    let subjects: Vec<_> = before["members"].as_array().unwrap().iter().map(|m| m["user_id"].clone()).collect();
    stage(
        st,
        user,
        via,
        args,
        Staged {
            kind: "split_playgroup",
            summary,
            detail,
            payload: json!({"name":name,"group_id":new_id(),"args":args,"before":before,"subjects":subjects}),
        },
    )
    .await
}

pub(super) async fn apply(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    let group = arg::text(p, "group_id")?;
    let result =
        json!({"label":format!("Created {} and moved games",arg::text(p,"name")?),"link":"/group"});
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    if !first_apply(&mut tx, &user.id, id, "split_playgroup").await? {
        return Ok(result);
    }
    st.limits.playgroup_writes.check_user(user)?;
    let before = snapshot(&mut tx, &user.id, &p["args"]).await?;
    if before != p["before"] {
        return Err(AppError::Conflict(
            "The group or games changed; stage a fresh split for review".into(),
        ));
    }
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups WHERE owner_id=?")
        .bind(&user.id)
        .fetch_one(&mut *tx)
        .await?;
    if owned >= crate::playgroups::OWNED_MAX {
        return Err(AppError::bad("Owned playgroup limit reached"));
    }
    let code = crate::playgroups::fresh_code(&mut tx).await?;
    sqlx::query("INSERT INTO playgroups(id,name,owner_id,join_code,created_at) VALUES(?,?,?,?,?)")
        .bind(group)
        .bind(arg::text(p, "name")?)
        .bind(&user.id)
        .bind(code)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    let mut mapping = HashMap::new();
    let mut subjects = Vec::new();
    for member in before["members"].as_array().unwrap() {
        let u = member["user_id"].as_str().unwrap();
        let m = new_id();
        sqlx::query(
            "INSERT INTO playgroup_members(id,playgroup_id,user_id,created_at) VALUES(?,?,?,?)",
        )
        .bind(&m)
        .bind(group)
        .bind(u)
        .bind(now())
        .execute(&mut *tx)
        .await?;
        subjects.push(u);
        mapping.insert(u, m);
    }
    let mut changes = Vec::new();
    for item in before["games"].as_array().unwrap() {
        let game = item["game"]["id"].as_str().unwrap();
        sqlx::query("UPDATE games SET playgroup_id=? WHERE id=?")
            .bind(group)
            .bind(game)
            .execute(&mut *tx)
            .await?;
        for seat in item["seats"].as_array().unwrap() {
            let n = seat["seat"].as_i64().unwrap();
            let member = &mapping[seat["user_id"].as_str().unwrap()];
            sqlx::query("UPDATE game_seats SET member_id=? WHERE game_id=? AND seat=?")
                .bind(member)
                .bind(game)
                .bind(n)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO history_correction_targets(game_id,kind,seat,revision) VALUES(?,'player',?,1) ON CONFLICT(game_id,kind,seat) DO UPDATE SET revision=revision+1")
                .bind(game).bind(n).execute(&mut *tx).await?;
        }
        changes.push(json!({"game_id":game,"kind":"playgroup","before":item,"after_playgroup":group,"after_members":mapping}));
    }
    sqlx::query("INSERT INTO history_corrections(id,owner_id,actor,reason,request,changes,subjects,created_at) VALUES(?,?,'mcp','Approved playgroup split',?,?,?,?)")
        .bind(format!("mcp-{id}")).bind(&user.id).bind(p["args"].to_string()).bind(json!(changes).to_string()).bind(json!(subjects).to_string()).bind(now()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (AppState, User, Value) {
        let st = crate::testutil::state().await;
        let (owner, _) = crate::testutil::user(&st.pool, "owner@example.com").await;
        let (friend, _) = crate::testutil::user(&st.pool, "friend@example.com").await;
        sqlx::query("INSERT INTO playgroups(id,name,owner_id,join_code,created_at) VALUES('source','Source',?,'CODE','now')").bind(&owner).execute(&st.pool).await.unwrap();
        for (id, u) in [("a", &owner), ("b", &friend)] {
            sqlx::query("INSERT INTO playgroup_members(id,playgroup_id,user_id,created_at) VALUES(?,'source',?,'now')").bind(id).bind(u).execute(&st.pool).await.unwrap();
        }
        for (id, group) in [("grouped", Some("source")), ("loose", None)] {
            sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at,playgroup_id,winner_seat,turns,note) VALUES(?,'in_person',?,'finished','day',?,1,7,'keep')")
                .bind(id).bind(&owner).bind(group).execute(&st.pool).await.unwrap();
            for (seat, m, u) in [(0, "a", &owner), (1, "b", &friend)] {
                sqlx::query("INSERT INTO game_seats(game_id,seat,member_id,user_id,final_life) VALUES(?,?,?,?,?)")
                    .bind(id).bind(seat).bind(group.map(|_|m)).bind(if group.is_some() && seat == 1 { None } else { Some(u) }).bind(22).execute(&st.pool).await.unwrap();
            }
            sqlx::query("INSERT INTO game_events(game_id,seq,kind,payload,created_at) VALUES(?,1,'test','{}','day')").bind(id).execute(&st.pool).await.unwrap();
        }
        let user = User {
            id: owner,
            email: "owner@example.com".into(),
            display_name: "owner".into(),
            is_admin: false,
            limited: false,
            power: false,
            guest: false,
        };
        (
            st,
            user,
            json!({"source_playgroup":"source","name":"Pair","members":["owner","friend"],"games":["grouped","loose"]}),
        )
    }

    async fn proposal(st: &AppState, u: &User, args: &Value) -> (String, Value) {
        split(st, u, &Via::Key, args).await.unwrap();
        let (id, p): (String, String) =
            sqlx::query_as("SELECT id,payload FROM assistant_changes ORDER BY rowid DESC LIMIT 1")
                .fetch_one(&st.pool)
                .await
                .unwrap();
        (id, serde_json::from_str(&p).unwrap())
    }

    #[tokio::test]
    async fn split_preserves_results_remaps_seats_audits_and_retries() {
        let (st, u, args) = fixture().await;
        let (id, p) = proposal(&st, &u, &args).await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "staging writes no group");
        let result = apply(&st, &u, &id, &p).await.unwrap();
        assert_eq!(apply(&st, &u, &id, &p).await.unwrap(), result);
        let rows: Vec<(String, i64, i64, String)> =
            sqlx::query_as("SELECT playgroup_id,winner_seat,turns,note FROM games")
                .fetch_all(&st.pool)
                .await
                .unwrap();
        for (group, winner, turns, note) in rows {
            assert_eq!(group, p["group_id"]);
            assert_eq!((winner, turns, note), (1, 7, "keep".into()));
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_seats s JOIN playgroup_members m ON m.id=s.member_id JOIN games g ON g.id=s.game_id WHERE m.playgroup_id=g.playgroup_id AND s.final_life=22").fetch_one(&st.pool).await.unwrap();
        assert_eq!(count, 4);
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_events")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(events, 2);
        let fences: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_correction_targets")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(fences, 4);
        let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_corrections")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(audits, 1);
        let old: crate::games::NewGame =
            serde_json::from_value(json!({"id":"grouped","playgroup_id":"source","seats":[]}))
                .unwrap();
        let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        assert!(matches!(
            crate::games::create_game_in(&mut tx, &u.id, old).await,
            Err(AppError::Conflict(_))
        ));
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn audit_failure_rolls_back_group_seats_and_fences() {
        let (st, u, args) = fixture().await;
        let (id, p) = proposal(&st, &u, &args).await;
        sqlx::query("CREATE TRIGGER fail_split_audit BEFORE INSERT ON history_corrections BEGIN SELECT RAISE(ABORT,'test failure'); END").execute(&st.pool).await.unwrap();
        assert!(apply(&st, &u, &id, &p).await.is_err());
        let group_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(group_count, 1);
        let fences: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_correction_targets")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(fences, 0);
        let changed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM game_seats WHERE member_id NOT IN ('a','b')")
                .fetch_one(&st.pool)
                .await
                .unwrap();
        assert_eq!(changed, 0);
    }

    #[tokio::test]
    async fn disabled_members_are_refused_on_stage_and_apply() {
        let (st, u, args) = fixture().await;
        let (id, p) = proposal(&st, &u, &args).await;
        sqlx::query("UPDATE users SET disabled_at='now' WHERE display_name='friend'")
            .execute(&st.pool)
            .await
            .unwrap();
        assert!(apply(&st, &u, &id, &p).await.is_err());
        assert!(split(&st, &u, &Via::Key, &args).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM applied_ops")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn stale_or_foreign_proposals_fail_without_partial_writes() {
        let (st, u, args) = fixture().await;
        let (id, p) = proposal(&st, &u, &args).await;
        sqlx::query("UPDATE games SET note='changed' WHERE id='loose'")
            .execute(&st.pool)
            .await
            .unwrap();
        assert!(apply(&st, &u, &id, &p).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let ops: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM applied_ops")
            .fetch_one(&st.pool)
            .await
            .unwrap();
        assert_eq!(ops, 0);
        let mut foreign = u.clone();
        foreign.id = "other".into();
        assert!(split(&st, &foreign, &Via::Key, &args).await.is_err());
        // A game with an extra player cannot be brought into a smaller private group.
        let mut bad = args.clone();
        bad["members"] = json!(["owner"]);
        assert!(split(&st, &u, &Via::Key, &bad).await.is_err());
    }
    #[tokio::test]
    async fn an_applied_retry_works_after_exhausting_the_write_allowance() {
        let (st, u, args) = fixture().await;
        let (id, p) = proposal(&st, &u, &args).await;
        let result = apply(&st, &u, &id, &p).await.unwrap();
        while st.limits.playgroup_writes.check_user(&u).is_ok() {}
        assert_eq!(apply(&st, &u, &id, &p).await.unwrap(), result);
    }

    #[tokio::test]
    async fn legacy_owners_without_member_rows_can_split() {
        let (st, u, args) = fixture().await;
        sqlx::query("UPDATE game_seats SET member_id=NULL WHERE member_id='a'").execute(&st.pool).await.unwrap();
        sqlx::query("DELETE FROM playgroup_members WHERE id='a'").execute(&st.pool).await.unwrap();
        let (id, p) = proposal(&st, &u, &args).await;
        apply(&st, &u, &id, &p).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroup_members WHERE user_id=?").bind(&u.id).fetch_one(&st.pool).await.unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn deleting_a_selected_account_purges_split_proposals_in_every_state() {
        for status in ["pending", "applied", "discarded"] {
            let (st, u, args) = fixture().await;
            let (id, _) = proposal(&st, &u, &args).await;
            sqlx::query("UPDATE assistant_changes SET status=? WHERE id=?").bind(status).bind(&id).execute(&st.pool).await.unwrap();
            let friend: String = sqlx::query_scalar("SELECT user_id FROM playgroup_members WHERE id='b'").fetch_one(&st.pool).await.unwrap();
            let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            crate::admin::delete::delete_rows(&mut tx, &friend).await.unwrap();
            tx.commit().await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_changes WHERE id=?").bind(id).fetch_one(&st.pool).await.unwrap();
            assert_eq!(count, 0, "{status} proposal retains no deleted subject data");
        }
    }

    #[tokio::test]
    async fn a_deleted_subject_cannot_be_restaged_from_a_stale_snapshot() {
        let (st, u, args) = fixture().await;
        let (_, payload) = proposal(&st, &u, &args).await;
        let friend: String = sqlx::query_scalar("SELECT user_id FROM playgroup_members WHERE id='b'").fetch_one(&st.pool).await.unwrap();
        let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        crate::admin::delete::delete_rows(&mut tx, &friend).await.unwrap();
        tx.commit().await.unwrap();
        let result = stage(&st, &u, &Via::Key, &args, Staged { kind: "split_playgroup", summary: "old subject".into(), detail: "old subject".into(), payload }).await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_changes").fetch_one(&st.pool).await.unwrap();
        assert_eq!(count, 0);
    }

}
