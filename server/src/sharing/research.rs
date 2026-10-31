//! Research notes shared by link (`/r/<token>`) or on a profile: the guide part of a note only,
//! from `deck_research::public_view` (never review answers, ownership, acquisition evidence or
//! shopping). A note's page lists its decks; each deck's page shows one build at a time
//! (`?build=`), with how to pilot it, its changes from the starting list and the full list.
use super::html::{card_views, credit, not_found, page, response, scryfall};
use super::*;
use crate::public_page::{bracket_name, e, identity as pips, when};
use axum::extract::Query;
use serde_json::Value;
use std::fmt::Write;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn by(handle: &Option<String>) -> String {
    match handle {
        Some(h) => format!("Shared by <a href=\"/u/{0}\">@{0}</a>", e(h)),
        None => "Shared on Yama".into(),
    }
}

/// A card's details by name, for lists that are plain text: (type line, mana value, layout,
/// image, color identity, art crop, artist). Real cards before tokens of the same name.
type CardRow = (Option<String>, f64, Option<String>, Option<String>, String, Option<String>, Option<String>);
async fn card_by_name(pool: &SqlitePool, name: &str) -> AppResult<Option<CardRow>> {
    let front = name.split(" // ").next().unwrap_or(name);
    Ok(sqlx::query_as(
        "SELECT c.type_line, c.cmc, c.layout, c.image_normal, c.color_identity, c.image_art_crop, c.artist
         FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
         WHERE n.name = ? OR n.name = ?
         ORDER BY c.type_line LIKE 'Token%', json_extract(c.legalities, '$.commander') IS NOT 'legal'
         LIMIT 1",
    )
    .bind(name)
    .bind(front)
    .fetch_optional(pool)
    .await?)
}

fn scryfall_image(u: Option<String>) -> Option<String> {
    u.filter(|u| u.starts_with("https://cards.scryfall.io/"))
}

/// A commander's art (crop, artist, name) and color identity, for the page and tile headers.
async fn commander_art(pool: &SqlitePool, name: &str) -> AppResult<(Option<(String, Option<String>, String)>, String)> {
    let Some((_, _, _, _, ci, crop, artist)) = card_by_name(pool, name).await? else { return Ok((None, String::new())) };
    let art = scryfall_image(crop).filter(|_| artist.is_some()).map(|u| (u, artist, name.to_string()));
    Ok((art, "WUBRG".chars().filter(|c| ci.contains(*c)).collect()))
}

/// The most lines of a build's list a shared page reads. A Commander list is about 100 lines;
/// a note can hold far longer text, and a public page mustn't do work in proportion to it.
const MAX_LINES: usize = 300;

/// A build's plain-text list as cards the shared list views can show, and whether it was cut
/// at `MAX_LINES`. Every name is looked up in one query.
async fn cards_of(pool: &SqlitePool, list: &str) -> AppResult<(Vec<SharedCard>, bool)> {
    let mut lines = crate::decks::parse_list(list, true);
    let cut = lines.len() > MAX_LINES;
    lines.truncate(MAX_LINES);
    let front = |n: &str| n.split(" // ").next().unwrap_or(n).to_lowercase();
    let mut names: Vec<String> = lines.iter().flat_map(|l| [l.name.to_lowercase(), front(&l.name)]).collect();
    names.sort();
    names.dedup();
    type Row = (String, Option<String>, f64, Option<String>, Option<String>);
    // Real cards before tokens of the same name, Commander-legal ones first; the first row per
    // name wins.
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT lower(n.name), c.type_line, c.cmc, c.layout, c.image_normal
         FROM json_each(?) j JOIN card_names n ON n.name = j.value JOIN cards c ON c.oracle_id = n.oracle_id
         ORDER BY c.type_line LIKE 'Token%', json_extract(c.legalities, '$.commander') IS NOT 'legal'",
    )
    .bind(serde_json::to_string(&names).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let mut found: HashMap<String, Row> = HashMap::new();
    for row in rows {
        found.entry(row.0.clone()).or_insert(row);
    }
    let out = lines
        .into_iter()
        .map(|line| {
            let row = found.get(&line.name.to_lowercase()).or_else(|| found.get(&front(&line.name)));
            let (type_line, cmc, layout, image) = match row {
                Some((_, t, cmc, layout, image)) => (t.clone(), *cmc, layout.clone(), scryfall_image(image.clone())),
                None => (None, 0.0, None, None),
            };
            SharedCard { name: line.name, qty: line.qty, board: line.board, type_line, cmc, layout, image, printing: None }
        })
        .collect();
    Ok((out, cut))
}

async fn load(st: &AppState, address: &ClientAddress, token: &str) -> AppResult<Result<(Option<String>, Value, String), Response>> {
    limit(st, address)?;
    match crate::deck_research::shared(&st.pool, token).await {
        Ok(x) => Ok(Ok(x)),
        Err(AppError::NotFound(_)) => Ok(Err(not_found(st, "Note"))),
        Err(err) => Err(err),
    }
}

fn deck_of<'a>(doc: &'a Value, key: &str) -> Option<&'a Value> {
    doc["decks"].as_array()?.iter().find(|d| text(d, "key") == key)
}

/// The build `?build=` names, else the recommended one, else the first.
fn build_of<'a>(deck: &'a Value, wanted: Option<&str>) -> Option<&'a Value> {
    let builds = deck["builds"].as_array()?;
    wanted
        .and_then(|w| builds.iter().find(|b| text(b, "id") == w))
        .or_else(|| builds.iter().find(|b| text(b, "id") == text(deck, "recommended_build")))
        .or_else(|| builds.first())
}

fn deck_href(token: &str, deck: &str, build: Option<&str>) -> String {
    let mut path = format!("/r/{}/{}", e(token), e(deck));
    if let Some(b) = build {
        let enc: String = url::form_urlencoded::byte_serialize(b.as_bytes()).collect();
        write!(path, "?build={enc}").unwrap();
    }
    path
}

fn bracket_label(b: &Value) -> Option<String> {
    b.get("bracket").and_then(Value::as_i64).filter(|n| (1..=5).contains(n)).map(|n| format!("Bracket {n}, {}", bracket_name(n)))
}

pub(super) async fn note(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(token): Path<String>) -> AppResult<Response> {
    let (handle, doc, saved) = match load(&st, &address, &token).await? {
        Ok(x) => x,
        Err(res) => return Ok(res),
    };
    let title = text(&doc, "title");
    let decks = doc["decks"].as_array().cloned().unwrap_or_default();
    let mut body = String::new();
    if let Some(h) = &handle {
        write!(body, "<a class=\"back-link\" href=\"/u/{0}\">← @{0}</a>", e(h)).unwrap();
    }
    write!(
        body,
        "<section class=\"share-profile-head\"><p class=\"eyebrow\">{}</p><h1>{}</h1><p>{}</p><p class=\"dim\">{} {}. Saved {}.</p></section>",
        by(&handle),
        e(title),
        e(text(&doc, "summary")),
        decks.len(),
        if decks.len() == 1 { "deck" } else { "decks" },
        when(&saved),
    )
    .unwrap();
    let method = strings(&doc, "method");
    if !method.is_empty() {
        body.push_str("<details class=\"share-note-method\"><summary>How these builds were made</summary><ul>");
        for m in &method {
            write!(body, "<li>{}</li>", e(m)).unwrap();
        }
        body.push_str("</ul></details>");
    }
    body.push_str("<ul class=\"share-decks\">");
    let mut arts = Vec::new();
    for d in &decks {
        let key = text(d, "key");
        let (art, identity) = commander_art(&st.pool, text(d, "commander")).await?;
        let builds = d["builds"].as_array().cloned().unwrap_or_default();
        let recommended = builds.iter().find(|b| text(b, "id") == text(d, "recommended_build"));
        body.push_str("<li class=\"share-deck\">");
        write!(body, "<a class=\"share-deck-main\" href=\"{}\">", deck_href(&token, key, None)).unwrap();
        if let Some((url, _, _)) = &art {
            write!(body, "<img src=\"{}\" alt=\"\" loading=\"lazy\"><div class=\"art-wash\"></div>", e(url)).unwrap();
        }
        write!(
            body,
            "<span class=\"share-deck-copy\">{}<b>{}</b><span>{}</span><small>{}</small></span></a>",
            pips(&identity),
            e(text(d, "name")),
            e(text(d, "commander")),
            match recommended {
                Some(b) => format!("Recommended: {}", e(text(b, "label"))),
                None => format!("{} builds", builds.len()),
            }
        )
        .unwrap();
        if builds.len() > 1 {
            write!(body, "<nav class=\"share-deck-configs\" aria-label=\"Builds of {}\"><ul>", e(text(d, "name"))).unwrap();
            for b in &builds {
                write!(body, "<li><a href=\"{}\">{}</a></li>", deck_href(&token, key, Some(text(b, "id"))), e(text(b, "label"))).unwrap();
            }
            body.push_str("</ul></nav>");
        }
        body.push_str("</li>");
        if art.is_some() {
            arts.push(credit(&art));
        }
    }
    body.push_str("</ul>");
    if !arts.is_empty() {
        write!(body, "<p class=\"art-credits dim\">{}</p>", arts.join(" ")).unwrap();
    }
    let description = format!("{title}: Commander deck notes shared on Yama.");
    Ok(response(&headers, page(&st, &format!("/r/{token}"), title, &description, None, &body)))
}

#[derive(Deserialize, Default)]
pub(super) struct BuildQuery {
    #[serde(default)]
    build: Option<String>,
}

fn list_items(items: &[String]) -> String {
    let mut s = String::from("<ul>");
    for x in items {
        write!(s, "<li>{}</li>", e(x)).unwrap();
    }
    s.push_str("</ul>");
    s
}

fn profile_panel(p: &Value) -> String {
    let mut s = String::from("<section class=\"public-panel\" aria-labelledby=\"play-head\"><h2 id=\"play-head\">How it plays</h2>");
    for (key, label) in [("plan", "Plan"), ("pressure", "Pressure"), ("interaction", "Interaction"), ("consistency", "Consistency"), ("recovery", "Recovery"), ("pace", "Pace"), ("ceiling", "Ceiling")] {
        if !text(p, key).is_empty() {
            write!(s, "<p><span class=\"label\">{label}</span>{}</p>", e(text(p, key))).unwrap();
        }
    }
    for (key, label) in [("setup", "Setup"), ("finishers", "How it wins"), ("weaknesses", "Weaknesses")] {
        let items = strings(p, key);
        if !items.is_empty() {
            write!(s, "<h3>{label}</h3>{}", list_items(&items)).unwrap();
        }
    }
    if !text(p, "confidence").is_empty() {
        write!(s, "<p class=\"dim\">{}</p>", e(text(p, "confidence"))).unwrap();
    }
    s.push_str("</section>");
    s
}

pub(super) async fn deck(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path((token, key)): Path<(String, String)>,
    Query(q): Query<BuildQuery>,
) -> AppResult<Response> {
    let (handle, doc, saved) = match load(&st, &address, &token).await? {
        Ok(x) => x,
        Err(res) => return Ok(res),
    };
    let (Some(d), title) = (deck_of(&doc, &key), text(&doc, "title")) else { return Ok(not_found(&st, "Deck")) };
    let Some(b) = build_of(d, q.build.as_deref()) else { return Ok(not_found(&st, "Deck")) };
    let name = text(d, "name");
    let commander = text(d, "commander");
    let build_id = text(b, "id");
    let (art, identity) = commander_art(&st.pool, commander).await?;
    let (cards, cut) = cards_of(&st.pool, text(b, "list")).await?;
    let size: i64 = cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();

    let mut body = format!("<a class=\"back-link\" href=\"/r/{}\">← {}</a>", e(&token), e(title));
    body.push_str("<section class=\"public-art\">");
    if let Some((url, _, _)) = &art {
        write!(body, "<img src=\"{}\" alt=\"\" fetchpriority=\"high\"><div class=\"art-wash\"></div>", e(url)).unwrap();
    }
    write!(
        body,
        "<div class=\"art-heading\"><p class=\"eyebrow\">{}</p><h1>{}</h1><p>{}</p><div class=\"deck-meta\">{}<span>{}</span><span>Saved {}</span></div></div><p class=\"art-credit\">{}</p></section>",
        by(&handle),
        e(name),
        e(commander),
        pips(&identity),
        e(text(b, "label")),
        when(&saved),
        credit(&art),
    )
    .unwrap();

    let builds = d["builds"].as_array().cloned().unwrap_or_default();
    if builds.len() > 1 {
        body.push_str("<nav class=\"share-configs\" aria-label=\"Builds of this deck\"><span class=\"dim\">Builds</span><ul>");
        for x in &builds {
            let id = text(x, "id");
            let recommended = if id == text(d, "recommended_build") { " (recommended)" } else { "" };
            let current = if id == build_id { " aria-current=\"page\"" } else { "" };
            write!(body, "<li><a{current} href=\"{}\">{}{recommended}</a></li>", deck_href(&token, &key, Some(id)), e(text(x, "label"))).unwrap();
        }
        body.push_str("</ul></nav>");
    }

    body.push_str("<div class=\"share-status\">");
    if let Some(l) = bracket_label(b) {
        write!(body, "<span class=\"pill\">{}</span>", e(&l)).unwrap();
    }
    let gcs = strings(b, "game_changers");
    write!(body, "<span class=\"pill\">{} Game Changer{}</span>", gcs.len(), if gcs.len() == 1 { "" } else { "s" }).unwrap();
    let swaps = b["swaps"].as_array().cloned().unwrap_or_default();
    write!(body, "<a class=\"pill dashed\" href=\"#changes-head\">{} changes from the starting list</a>", swaps.len()).unwrap();
    body.push_str("</div>");

    // What the deck does and how to play it come first: the reason someone opens the link.
    body.push_str("<div class=\"share-more\">");
    write!(body, "<section class=\"public-panel\" aria-labelledby=\"about-head\"><h2 id=\"about-head\">{}</h2><p>{}</p>", e(text(b, "label")), e(text(b, "why"))).unwrap();
    if !text(d, "summary").is_empty() {
        write!(body, "<h3>The deck</h3><p>{}</p>", e(text(d, "summary"))).unwrap();
    }
    if !gcs.is_empty() {
        write!(body, "<h3>Game Changers</h3><p>{}</p>", e(&gcs.join(", "))).unwrap();
        for g in b["gc_choices"].as_array().into_iter().flatten() {
            write!(body, "<p class=\"dim\">{}: {}</p>", e(text(g, "card")), e(text(g, "reason"))).unwrap();
        }
    }
    let warnings = strings(d, "warnings");
    if !warnings.is_empty() {
        write!(body, "<h3>Good to know</h3>{}", list_items(&warnings)).unwrap();
    }
    let risks = strings(b, "risks");
    if !risks.is_empty() {
        write!(body, "<h3>Limits of this build</h3>{}", list_items(&risks)).unwrap();
    }
    body.push_str("</section>");
    if !text(d, "pilot").is_empty() {
        write!(body, "<section class=\"public-panel\" aria-labelledby=\"pilot-head\"><h2 id=\"pilot-head\">How to pilot this deck</h2><p>{}</p></section>", e(text(d, "pilot"))).unwrap();
    }
    if let Some(p) = b.get("gameplay_profile").filter(|p| p.is_object()) {
        body.push_str(&profile_panel(p));
    }
    body.push_str("</div>");

    // The changes, as a table a player can work through with the deck box open.
    write!(
        body,
        "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} in, {} out</p><h2 id=\"changes-head\">Changes from the starting list</h2></div></div>",
        swaps.iter().filter(|s| !text(s, "card_in").is_empty()).count(),
        swaps.iter().filter(|s| !text(s, "card_out").is_empty()).count(),
    )
    .unwrap();
    if swaps.is_empty() {
        body.push_str("<p class=\"dim\">This build is the starting list.</p>");
    } else {
        body.push_str("<table class=\"share-collection share-swaps\"><thead><tr><th scope=\"col\">Add</th><th scope=\"col\">Cut</th><th scope=\"col\">Why</th></tr></thead><tbody>");
        let link = |name: &str| {
            if name.is_empty() {
                "<span class=\"dim\">Nothing</span>".to_string()
            } else {
                let image = cards.iter().find(|c| c.name == name).and_then(|c| c.image.clone()).unwrap_or_default();
                format!("<a class=\"public-card-ref\" data-card-name=\"{0}\" data-card-image=\"{1}\" href=\"{2}\">{0}</a>", e(name), e(&image), e(&scryfall(name)))
            }
        };
        for s in &swaps {
            let out = text(s, "why_out");
            write!(
                body,
                "<tr><td>{}</td><td>{}</td><td>{}{}</td></tr>",
                link(text(s, "card_in")),
                link(text(s, "card_out")),
                e(text(s, "why")),
                if out.is_empty() { String::new() } else { format!("<br><span class=\"dim\">Cut: {}</span>", e(out)) },
            )
            .unwrap();
        }
        body.push_str("</tbody></table>");
    }
    body.push_str("</section>");

    write!(body, "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{size} cards</p><h2>Decklist</h2></div></div>").unwrap();
    body.push_str("<div class=\"public-actions\">");
    for (i, (format, label)) in [("names", "Download the list"), ("moxfield", "Download for Moxfield")].iter().enumerate() {
        write!(
            body,
            "<a class=\"button{}\" href=\"/r/{}/{}/{}-{format}.txt\" download>{label}</a>",
            if i == 0 { " primary" } else { "" },
            e(&token),
            e(&key),
            e(build_id)
        )
        .unwrap();
    }
    body.push_str("</div>");
    body.push_str(&card_views(&cards));
    write!(
        body,
        "<details><summary>Select the list to copy</summary><textarea readonly rows=\"14\" aria-label=\"Decklist\">{}</textarea></details></section>",
        e(&export(&cards, "names"))
    )
    .unwrap();
    if cut {
        write!(body, "<p class=\"dim\">Only the first {MAX_LINES} lines of this list are shown.</p>").unwrap();
    }
    // Unknown names stay in the list as written; say so rather than hide them.
    let unknown: Vec<&str> = cards.iter().filter(|c| c.type_line.is_none()).map(|c| c.name.as_str()).collect();
    if !unknown.is_empty() {
        write!(body, "<p class=\"dim\">Not in Yama's card data: {}.</p>", e(&unknown.join(", "))).unwrap();
    }
    let page_title = format!("{name}: {}", text(b, "label"));
    let description = format!("{page_title}. A {commander} Commander build shared on Yama.");
    let path = deck_href(&token, &key, Some(build_id)).replace("&amp;", "&");
    Ok(response(&headers, page(&st, &path, &page_title, &description, art.as_ref().map(|a| a.0.as_str()), &body)))
}

/// `/r/<token>/<deck>/<build>-<format>.txt`: a build's list as names only or with Moxfield's
/// section headers. Plain-text lists name no printing, so both are names.
pub(super) async fn download(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path((token, key, file)): Path<(String, String, String)>,
) -> AppResult<Response> {
    let Ok((_, doc, _)) = load(&st, &address, &token).await? else { return Err(AppError::NotFound("note")) };
    let stem = file.strip_suffix(".txt").ok_or(AppError::NotFound("export"))?;
    let (build_id, format) = stem.rsplit_once('-').filter(|(_, f)| matches!(*f, "names" | "moxfield")).ok_or(AppError::NotFound("export"))?;
    let d = deck_of(&doc, &key).ok_or(AppError::NotFound("deck"))?;
    let b = d["builds"].as_array().and_then(|bs| bs.iter().find(|b| text(b, "id") == build_id)).ok_or(AppError::NotFound("build"))?;
    let (cards, _) = cards_of(&st.pool, text(b, "list")).await?;
    let res = fresh(&headers, export(&cards, format), "text/plain; charset=utf-8");
    Ok(attachment(res, &file_name(&format!("{} {}", text(d, "name"), text(b, "label")), format)))
}
