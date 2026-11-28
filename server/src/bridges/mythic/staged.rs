//! One explicit exported game, through the bridge's planner and atomic game writer.
use super::*;
use crate::auth::User;
use serde_json::json;

fn request(value: &Value) -> AppResult<ImportRequest> {
    if value.to_string().len() > 256 * 1024 {
        return Err(AppError::bad("one exported game must fit in 256 KiB"));
    }
    let req: ImportRequest = serde_json::from_value(value.clone()).map_err(|_| AppError::bad("provide a bridge request with export.games containing exactly one exported game; never include credentials"))?;
    if req.export.games.len() != 1 {
        return Err(AppError::bad(
            "provide exactly one explicitly requested exported game",
        ));
    }
    Ok(req)
}

fn enabled(st: &AppState) -> AppResult<()> {
    if !st.cfg.mythic_bridge {
        return Err(AppError::bad("the Mythic Tools bridge is disabled"));
    }
    Ok(())
}

// Include the built identities and saved state, not just the display names. A member being
// linked to an account or the game being edited must invalidate the pending approval.
fn snapshot(plan: &Plan) -> Value {
    json!({"me":plan.me,"players":plan.players,"links":plan.player_links,
        "games":plan.games.iter().map(|g| json!({"id":g.mythic_id,"status":g.status,
            "action":g.action,"yama_id":g.yama_id,"seen":g.seen_yama,"saved":g.saved_yama,
            "matches":g.matches,"built":g.built.as_ref().ok().map(|b| json!({
                "fingerprint":b.fingerprint,"seats":b.seats}))})).collect::<Vec<_>>()})
}

pub(crate) async fn prepare(
    st: &AppState,
    user: &User,
    value: &Value,
) -> AppResult<(Value, String)> {
    enabled(st)?;
    st.limits.mythic_bridge.check_user(user)?;
    let req = request(value)?;
    let mut tx = st.pool.begin().await?;
    let plan = plan_in(&mut tx, &user.id, &req).await?;
    let mut frozen = snapshot(&plan);
    frozen["members"] = member_snapshot(&mut tx, &req).await?;
    frozen["subjects"] = subjects(&mut tx, &plan).await?;
    let mut subjects = std::collections::BTreeSet::from([user.id.clone()]);
    for row in frozen["members"].as_array().into_iter().flatten() {
        if let Some(id) = row[1].as_str() {
            subjects.insert(id.to_string());
        }
    }
    for id in frozen["subjects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        subjects.insert(id.to_string());
    }
    tx.commit().await?;
    let preview = serde_json::to_value(to_preview(plan)).map_err(anyhow::Error::from)?;
    let detail = serde_json::to_string_pretty(&preview).map_err(anyhow::Error::from)?;
    Ok((
        json!({"owner":user.id,"subjects":subjects,"request":req,"snapshot":frozen,"preview":preview}),
        detail,
    ))
}

pub(crate) async fn apply(st: &AppState, user: &User, payload: &Value) -> AppResult<Value> {
    enabled(st)?;
    if payload["owner"].as_str() != Some(&user.id) {
        return Err(AppError::NotFound("change"));
    }
    let req = request(&payload["request"])?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let plan = plan_in(&mut tx, &user.id, &req).await?;
    let mut current = snapshot(&plan);
    current["members"] = member_snapshot(&mut tx, &req).await?;
    current["subjects"] = subjects(&mut tx, &plan).await?;
    // Recover a successful atomic import if saving the assistant change's result was interrupted.
    // This also treats the identical export imported through the web bridge as fulfilled.
    let g = &plan.games[0];
    let old = &payload["snapshot"]["games"][0];
    let fulfilled = old["action"] == "create"
        && g.status == "unchanged"
        && old["yama_id"] == current["games"][0]["yama_id"]
        && old["built"] == current["games"][0]["built"]
        && g.saved_yama.is_some()
        && g.saved_yama == g.seen_yama;
    if !fulfilled && current != payload["snapshot"] {
        return Err(AppError::Conflict(
            "the import preview changed; discard this change and preview again".into(),
        ));
    }
    if !fulfilled && g.action != "create" {
        return Err(AppError::bad(
            "this tool only imports a missing game; use the bridge page for updates or links",
        ));
    }
    let id = g
        .yama_id
        .clone()
        .ok_or_else(|| AppError::bad("no game to import"))?;
    if !fulfilled {
        st.limits.mythic_bridge.check_user(user)?;
        let playgroup = req.playgroup_id.clone().filter(|p| !p.is_empty());
        let mut plan = plan;
        let p = plan
            .games
            .pop()
            .ok_or_else(|| AppError::bad("no game to import"))?;
        let b = p.built.map_err(AppError::bad)?;
        let game = NewGame {
            id: id.clone(),
            playgroup_id: playgroup.clone(),
            format: "commander".into(),
            starting_life: b.starting_life,
            started_at: Some(b.started_at),
            seats: b.seats,
            events: vec![],
            finish: Some(b.finish),
            note: Some(NOTE.into()),
            game_match: None,
        };
        crate::games::check_game(&mut *tx, &user.id, &game).await?;
        if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM games WHERE id=?)")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?
        {
            return Err(AppError::Conflict(
                "the game appeared during the import; preview again".into(),
            ));
        }
        crate::games::create_game_in(&mut tx, &user.id, game).await?;
        sync_in(
            &mut tx,
            &user.id,
            Sync {
                mythic: &p.mythic_id,
                yama: &id,
                fingerprint: &b.fingerprint,
                keep_yama: None,
                note: b.note.as_deref(),
                tags: &b.tags,
            },
        )
        .await?;
        if playgroup.is_some() {
            for (key, member) in &plan.player_links {
                match member {
                    Some(member) => link_in(&mut tx, &user.id, "player", key, member, None).await?,
                    None => {
                        sqlx::query("DELETE FROM mythic_links WHERE owner_id=? AND kind='player' AND mythic_id=?")
                        .bind(&user.id).bind(key).execute(&mut *tx).await?;
                    }
                }
            }
        }
        if let Some(me) = plan.me {
            link_in(&mut tx, &user.id, "player", &me, &user.id, None).await?;
        }
    }
    tx.commit().await?;
    Ok(json!({"label":"Imported Mythic Tools game","link":format!("/table/games/{id}")}))
}

async fn member_snapshot(
    conn: &mut sqlx::SqliteConnection,
    req: &ImportRequest,
) -> AppResult<Value> {
    let mut rows = match req.playgroup_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => members(&mut *conn, id).await?,
        None => vec![],
    };
    rows.sort();
    Ok(json!(rows))
}

// Candidate names can refer to accounts outside the chosen group. Keep their subjects explicit
// so account deletion can purge even already decided approvals owned by someone else.
async fn subjects(conn: &mut sqlx::SqliteConnection, plan: &Plan) -> AppResult<Value> {
    let mut ids = Vec::<String>::new();
    for candidate in plan.games.iter().flat_map(|g| &g.matches) {
        let rows: Vec<String> = sqlx::query_scalar("SELECT COALESCE(s.user_id,m.user_id) FROM game_seats s LEFT JOIN playgroup_members m ON m.id=s.member_id WHERE s.game_id=? AND COALESCE(s.user_id,m.user_id) IS NOT NULL")
            .bind(&candidate.id).fetch_all(&mut *conn).await?;
        ids.extend(rows);
    }
    ids.sort();
    ids.dedup();
    Ok(json!(ids))
}
