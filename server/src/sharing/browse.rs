//! Browse: the decks that are listed publicly ([`LISTED`]), newest first, with filters. One
//! listing serves the Browse page (`GET /api/public/browse`, no account needed) and the public
//! decks shown on precon and commander pages, so they cannot disagree about what is listed.
//!
//! What a tile shows comes from the deck's current version, read once and kept
//! (`deck_version_faces`, migration 0086): commanders, colors, the commander's art with its
//! artist, the card count, and the precon the list reads as started from. Whether a deck is
//! listed is asked of the live tables on every request, never of the kept rows, so a deck made
//! private, taken down or archived leaves the listing at once.
//!
//! A deck's configurations are its owner's other builds of it. The listing shows the main deck,
//! and a configuration only when its main deck isn't listed itself, as the profile does.
use super::*;
use std::collections::HashSet;

/// Decks on one page of the listing.
pub(crate) const PER_PAGE: usize = 24;
/// Kept faces read again after this many days: card data (an artist's credit, a color identity
/// fix) and the precon lists change now and then.
const FACE_DAYS: i64 = 7;
/// Faces made in one batch, and the most batches one request makes. The listing only shows
/// decks whose face is kept, so a request makes every face that is due before it lists; the
/// cap is there so that a database with far more listed decks than Yama has ever had cannot
/// hold a request for minutes (it says so in the log, and the next request carries on).
const FACES_AT_ONCE: usize = 200;
const FACE_BATCHES: usize = 50;

/// One request at a time makes faces; the others wait and then find them made.
static MAKING_FACES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// A list reads as started from a precon when it still holds at least this share of the
/// precon's own cards (basic lands aside).
const PRECON_SHARE: f64 = 0.5;

#[derive(Deserialize, Default)]
pub(crate) struct Filter {
    /// Part of a deck's name as its tile shows it, or of a commander's name.
    #[serde(default)]
    pub(crate) q: Option<String>,
    /// Part of a commander's name.
    #[serde(default)]
    pub(crate) commander: Option<String>,
    /// Colors the deck's identity includes: letters of WUBRG. C alone: colorless decks.
    #[serde(default)]
    pub(crate) colors: Option<String>,
    /// The bracket its owner declares, 1 to 5.
    #[serde(default)]
    pub(crate) bracket: Option<String>,
    /// `any`: started from some precon. Otherwise a precon's id.
    #[serde(default)]
    pub(crate) precon: Option<String>,
    /// From 0.
    #[serde(default)]
    pub(crate) page: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct Art {
    pub(crate) url: String,
    pub(crate) artist: String,
    pub(crate) card: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct PreconRef {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// One listed deck, as a tile shows it. Nothing here but the name is typed by its owner, and
/// the name comes through the public text filter.
#[derive(Serialize, Clone)]
pub(crate) struct ListedDeck {
    /// Its shared page is `/d/<token>`.
    pub(crate) token: String,
    pub(crate) name: String,
    pub(crate) handle: String,
    pub(crate) commanders: Vec<String>,
    pub(crate) color_identity: String,
    pub(crate) art: Option<Art>,
    /// As its owner declares it.
    pub(crate) bracket: Option<i64>,
    pub(crate) card_count: i64,
    /// When its current list was saved.
    pub(crate) updated_at: String,
    pub(crate) precon: Option<PreconRef>,
}

#[derive(Serialize)]
pub(crate) struct Listing {
    pub(crate) decks: Vec<ListedDeck>,
    /// The page shown, from 0: the one asked for, or the last there is.
    pub(crate) page: usize,
    pub(crate) pages: usize,
    /// Decks matching the filters, on every page together.
    pub(crate) total: i64,
}

fn trimmed(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The colors asked for, as a JSON array of letters for the query: "ub", "U B" or "BU" is
/// `["U","B"]`; "C" (or "colorless") is `[]`, which asks for colorless decks. Anything else is
/// refused rather than read as "no filter".
fn colors_asked(raw: &str) -> AppResult<String> {
    let upper = raw.to_ascii_uppercase();
    if upper == "C" || upper == "COLORLESS" {
        return Ok("[]".into());
    }
    let letters: Vec<char> = upper.chars().filter(|c| !c.is_whitespace() && *c != ',').collect();
    if letters.is_empty() || !letters.iter().all(|c| "WUBRG".contains(*c)) {
        return Err(AppError::bad("colors are letters of WUBRG, or C for colorless"));
    }
    let asked: Vec<String> = "WUBRG".chars().filter(|c| letters.contains(c)).map(String::from).collect();
    Ok(serde_json::to_string(&asked).map_err(anyhow::Error::from)?)
}

const BASICS: [&str; 6] = ["plains", "island", "swamp", "mountain", "forest", "wastes"];

fn is_basic(name: &str) -> bool {
    let lower = name.to_lowercase();
    BASICS.contains(&lower.strip_prefix("snow-covered ").unwrap_or(&lower))
}

/// A precon's own cards (basic lands aside), each by its oracle id when the precon list has one
/// and by its lower-case name.
struct PreconList {
    /// The precon the list is filed under: an earlier one with the same hundred cards, if any.
    id: String,
    cards: Vec<(Option<String>, String)>,
}

async fn precon_lists(pool: &SqlitePool) -> AppResult<Vec<PreconList>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as("SELECT id, cards, same_list_as FROM precons ORDER BY id").fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, cards, same)| {
            let cards: Vec<serde_json::Value> = serde_json::from_str(&cards).ok()?;
            let cards: Vec<(Option<String>, String)> = cards
                .iter()
                .filter_map(|c| {
                    let name = c["name"].as_str()?;
                    (!is_basic(name)).then(|| (c["oracle_id"].as_str().map(str::to_string), name.to_lowercase()))
                })
                .collect();
            Some(PreconList { id: same.unwrap_or(id), cards })
        })
        .collect())
}

/// The precon a list reads as started from: the one with the most of its own cards still in the
/// list, if that is at least [`PRECON_SHARE`] of them. A brew that merely shares staples with a
/// precon doesn't reach it; a precon with its upgrades swapped in does.
fn started_from(cards: &[DeckCard], precons: &[PreconList]) -> Option<String> {
    let in_deck: Vec<&DeckCard> = cards.iter().filter(|c| c.board != Board::Side && c.qty > 0).collect();
    let ids: HashSet<&str> = in_deck.iter().map(|c| c.oracle_id.as_str()).collect();
    let names: HashSet<String> = in_deck.iter().map(|c| c.name.to_lowercase()).collect();
    precons
        .iter()
        .filter(|p| p.cards.len() >= 30)
        .map(|p| {
            let kept = p.cards.iter().filter(|(id, name)| id.as_deref().is_some_and(|id| ids.contains(id)) || names.contains(name)).count();
            (kept, p)
        })
        .filter(|(kept, p)| *kept as f64 >= p.cards.len() as f64 * PRECON_SHARE)
        // The most kept; between equals, the first by id, so the answer doesn't move.
        .max_by(|(a, pa), (b, pb)| a.cmp(b).then_with(|| pb.id.cmp(&pa.id)))
        .map(|(_, p)| p.id.clone())
}

/// Make (or make again) the kept face of every listed deck's current version that has none, or
/// an old one, so the listing that follows is complete. Most requests find nothing to do, with
/// one query.
async fn refresh_faces(pool: &SqlitePool) -> AppResult<()> {
    let old = (chrono::Utc::now() - chrono::Duration::days(FACE_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    if faces_due(pool, &old).await?.is_empty() {
        return Ok(());
    }
    let _making = MAKING_FACES.lock().await;
    let precons = precon_lists(pool).await?;
    for _ in 0..FACE_BATCHES {
        let due = faces_due(pool, &old).await?;
        if due.is_empty() {
            return Ok(());
        }
        for version in due {
            make_face(pool, &version, &precons).await?;
        }
    }
    tracing::warn!("Browse: more deck faces are due than one request makes; the listing is incomplete until the next requests finish them");
    Ok(())
}

/// The current versions of listed decks whose face is missing or older than `old`: one batch.
async fn faces_due(pool: &SqlitePool, old: &str) -> AppResult<Vec<String>> {
    // `LISTED` is a constant; the value is bound.
    Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT d.current_version_id FROM decks d JOIN users u ON u.id = d.owner_id
           LEFT JOIN deck_version_faces f ON f.version_id = d.current_version_id
          WHERE {LISTED} AND d.current_version_id IS NOT NULL AND (f.version_id IS NULL OR f.made_at < ?)
          LIMIT {FACES_AT_ONCE}"
    )))
    .bind(old)
    .fetch_all(pool)
    .await?)
}

/// Read one version's face from its cards and keep it.
async fn make_face(pool: &SqlitePool, version: &str, precons: &[PreconList]) -> AppResult<()> {
    {
        let face = deck_face(pool, Some(version)).await?;
        let cards = crate::decks::load_version_cards(pool, version).await?;
        let (art_url, art_artist, art_card) = match face.art {
            Some((url, Some(artist), card)) => (Some(url), Some(artist), Some(card)),
            _ => (None, None, None),
        };
        sqlx::query(
            "INSERT INTO deck_version_faces (version_id, commanders, color_identity, card_count, art_url, art_artist, art_card, precon_id, made_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(version_id) DO UPDATE SET commanders = excluded.commanders, color_identity = excluded.color_identity,
                 card_count = excluded.card_count, art_url = excluded.art_url, art_artist = excluded.art_artist, art_card = excluded.art_card,
                 precon_id = excluded.precon_id, made_at = excluded.made_at",
        )
        .bind(version)
        .bind(serde_json::to_string(&face.commanders).map_err(anyhow::Error::from)?)
        .bind(&face.color_identity)
        .bind(face.card_count)
        .bind(art_url)
        .bind(art_artist)
        .bind(art_card)
        .bind(started_from(&cards, precons))
        .bind(now())
        .execute(pool)
        .await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Row {
    token: String,
    name: String,
    handle: String,
    commanders: String,
    color_identity: String,
    card_count: i64,
    art_url: Option<String>,
    art_artist: Option<String>,
    art_card: Option<String>,
    bracket: Option<i64>,
    updated_at: String,
    precon_id: Option<String>,
    precon_name: Option<String>,
}

/// One page of the listing. `per_page` decks at most; a page past the end is the last page.
pub(crate) async fn listed(pool: &SqlitePool, filter: &Filter, per_page: usize) -> AppResult<Listing> {
    // Typed text is matched here, not by the database, against what a tile shows: the name
    // after the public text filter (so searching for a word the filter masks finds nothing by
    // it) and the commanders' names, ignoring case for every letter (SQLite's LIKE folds ASCII
    // only: "éowyn" would not find "Éowyn, Shieldmaiden").
    let q = trimmed(&filter.q).map(str::to_lowercase);
    let commander = trimmed(&filter.commander).map(str::to_lowercase);
    let colors = match trimmed(&filter.colors) {
        Some(c) => Some(colors_asked(c)?),
        None => None,
    };
    let bracket = match trimmed(&filter.bracket) {
        Some(b) => Some(b.parse::<i64>().ok().filter(|b| (1..=5).contains(b)).ok_or_else(|| AppError::bad("brackets go from 1 to 5"))?),
        None => None,
    };
    let precon = match trimmed(&filter.precon) {
        Some(p) if p.eq_ignore_ascii_case("any") => Some("*".to_string()),
        // A precon with the same hundred cards as an earlier one shares that one's decks
        // (`PreconList::id`), so either id finds them.
        Some(p) => Some(sqlx::query_scalar("SELECT COALESCE(same_list_as, id) FROM precons WHERE id = ?").bind(p).fetch_optional(pool).await?.unwrap_or_else(|| p.to_string())),
        None => None,
    };
    let page = match trimmed(&filter.page) {
        Some(p) => p.parse::<usize>().map_err(|_| AppError::bad("page is a number from 0"))?,
        None => 0,
    };
    // A face that can't be made must not take Browse down for everyone: the decks whose
    // faces are kept are still listed.
    if let Err(err) = refresh_faces(pool).await {
        tracing::warn!(error = ?err, "Browse: making deck faces failed; listing the ones already kept");
    }
    let matched: Option<String> = if q.is_some() || commander.is_some() {
        let named: Vec<(String, String, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT d.id, d.name, f.commanders FROM decks d JOIN users u ON u.id = d.owner_id
               JOIN deck_version_faces f ON f.version_id = d.current_version_id WHERE {LISTED}"
        )))
        .fetch_all(pool)
        .await?;
        let leads = |commanders: &[String], needle: &str| commanders.iter().any(|c| c.to_lowercase().contains(needle));
        let ids: Vec<String> = named
            .into_iter()
            .filter(|(_, name, commanders)| {
                let commanders: Vec<String> = serde_json::from_str(commanders).unwrap_or_default();
                q.as_deref().is_none_or(|n| public_text(name, true).to_lowercase().contains(n) || leads(&commanders, n)) && commander.as_deref().is_none_or(|n| leads(&commanders, n))
            })
            .map(|(id, _, _)| id)
            .collect();
        Some(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
    } else {
        None
    };
    // Listed, with a kept face, and not a configuration of a deck that is itself listed. The
    // owner is the same for a deck and its main deck, so only the deck's own state is asked.
    // Every part of this SQL is a constant; each filter is bound (NULL: no filter). `?4` is the
    // decks the typed text matched.
    let matching = format!(
        "FROM decks d JOIN users u ON u.id = d.owner_id
           JOIN deck_versions v ON v.id = d.current_version_id
           JOIN deck_version_faces f ON f.version_id = d.current_version_id
           LEFT JOIN precons p ON p.id = f.precon_id
          WHERE {LISTED}
            AND (d.parent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM decks m WHERE m.id = d.parent_id AND m.visibility = 'public' AND m.archived = 0 AND m.taken_down_at IS NULL))
            AND (?1 IS NULL OR CASE WHEN ?1 = '[]' THEN f.color_identity = ''
                                    ELSE NOT EXISTS (SELECT 1 FROM json_each(?1) l WHERE instr(f.color_identity, l.value) = 0) END)
            AND (?2 IS NULL OR d.bracket = ?2)
            AND (?3 IS NULL OR (?3 = '*' AND p.id IS NOT NULL) OR f.precon_id = ?3)
            AND (?4 IS NULL OR d.id IN (SELECT value FROM json_each(?4)))"
    );
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) {matching}")))
        .bind(&colors)
        .bind(bracket)
        .bind(&precon)
        .bind(&matched)
        .fetch_one(pool)
        .await?;
    let per_page = per_page.max(1);
    let pages = usize::try_from(total).unwrap_or(0).div_ceil(per_page).max(1);
    let page = page.min(pages - 1);
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT d.share_token AS token, d.name, u.handle, f.commanders, f.color_identity, f.card_count, f.art_url, f.art_artist, f.art_card,
                d.bracket, v.created_at AS updated_at, f.precon_id, p.name AS precon_name
         {matching}
         ORDER BY v.created_at DESC, d.id
         LIMIT ?5 OFFSET ?6"
    )))
    .bind(&colors)
    .bind(bracket)
    .bind(&precon)
    .bind(&matched)
    .bind(per_page as i64)
    .bind((page * per_page) as i64)
    .fetch_all(pool)
    .await?;
    let decks = rows
        .into_iter()
        .map(|r| ListedDeck {
            token: r.token,
            name: public_text(&r.name, true),
            handle: r.handle,
            commanders: serde_json::from_str(&r.commanders).unwrap_or_default(),
            color_identity: r.color_identity,
            art: match (r.art_url, r.art_artist, r.art_card) {
                (Some(url), Some(artist), Some(card)) => Some(Art { url, artist, card }),
                _ => None,
            },
            bracket: r.bracket,
            card_count: r.card_count,
            updated_at: r.updated_at,
            precon: r.precon_id.zip(r.precon_name).map(|(id, name)| PreconRef { id, name }),
        })
        .collect();
    Ok(Listing { decks, page, pages, total })
}

/// `GET /api/public/browse`: the Browse page's data. No account is asked for or read.
pub(super) async fn list(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, axum::extract::Query(filter): axum::extract::Query<Filter>) -> AppResult<Response> {
    limit(&st, &address)?;
    let listing = listed(&st.pool, &filter, PER_PAGE).await?;
    Ok(fresh(&headers, serde_json::to_string(&listing).map_err(anyhow::Error::from)?, "application/json"))
}

// ── on the public precon and commander pages ───────────────────────────────

/// Decks shown on a precon's page before the rest are a link to Browse.
const ON_A_PAGE: usize = 6;

/// "Counterpunch" as a query value: `Counterpunch`, "Krenko, Mob Boss" as `Krenko%2C+Mob+Boss`.
fn query_value(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// Listed decks as the tiles a profile uses, with one line of art credits under them. Every
/// piece of text is escaped here; the names came through the public text filter in [`listed`].
fn tiles(decks: &[ListedDeck]) -> String {
    use crate::public_page::{e, identity as pips};
    use std::fmt::Write;
    let mut s = String::from("<ul class=\"share-decks\">");
    for d in decks {
        write!(s, "<li class=\"share-deck\"><a class=\"share-deck-main\" href=\"/d/{}\">", e(&d.token)).unwrap();
        if let Some(art) = &d.art {
            write!(s, "<img src=\"{}\" alt=\"\" loading=\"lazy\"><div class=\"art-wash\"></div>", e(&art.url)).unwrap();
        }
        write!(
            s,
            "<span class=\"share-deck-copy\">{}<b>{}</b><span>{}</span><small>{} cards, by @{}</small></span></a></li>",
            pips(&d.color_identity),
            e(&d.name),
            e(&if d.commanders.is_empty() { "No commander set".to_string() } else { d.commanders.join(" and ") }),
            d.card_count,
            e(&d.handle)
        )
        .unwrap();
    }
    s.push_str("</ul>");
    let credits: Vec<String> = decks.iter().filter_map(|d| d.art.as_ref()).map(|a| format!("{}. Art by {}, © Wizards of the Coast.", e(&a.card), e(&a.artist))).collect();
    if !credits.is_empty() {
        write!(s, "<details class=\"art-credits dim\"><summary>Art credits</summary><p>{}</p></details>", credits.join(" ")).unwrap();
    }
    s
}

/// The section of a precon's public page that lists the public decks started from it: the
/// newest few as tiles and a link to the rest in Browse. Empty when there are none, so a precon
/// nobody has built on shows nothing. A precon with the same hundred cards as an earlier one
/// shares that one's decks ([`listed`] resolves it).
pub(crate) async fn precon_section(pool: &SqlitePool, precon: &str) -> AppResult<String> {
    use crate::public_page::e;
    let found = listed(pool, &Filter { precon: Some(precon.to_string()), ..Filter::default() }, ON_A_PAGE).await?;
    if found.total == 0 {
        return Ok(String::new());
    }
    let more = if found.total as usize > found.decks.len() { format!("Browse all {} ↗", found.total) } else { "Open in Browse ↗".to_string() };
    Ok(format!(
        "<section class=\"list-section listed-decks\" aria-labelledby=\"listed-head\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} public {}</p><h2 id=\"listed-head\">Decks started from this precon</h2></div><a href=\"/decks/browse?precon={}\">{more}</a></div><p class=\"dim\">Decks Yama players made public that still hold at least half of this precon's own cards, newest first.</p>{}</section>",
        found.total,
        if found.total == 1 { "deck" } else { "decks" },
        e(&query_value(precon)),
        tiles(&found.decks)
    ))
}

/// How many listed decks each commander leads, by the commander's name in lower case. One
/// query for a whole page of commanders.
pub(crate) async fn commander_counts(pool: &SqlitePool) -> AppResult<HashMap<String, i64>> {
    // As in `listed`: a face that can't be made must not take the ranking page down.
    if let Err(err) = refresh_faces(pool).await {
        tracing::warn!(error = ?err, "commander ranking: making deck faces failed; counting the ones already kept");
    }
    // `LISTED` is a constant; nothing is bound.
    let rows: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.value, COUNT(*) FROM decks d JOIN users u ON u.id = d.owner_id
           JOIN deck_version_faces f ON f.version_id = d.current_version_id, json_each(f.commanders) c
          WHERE {LISTED}
            AND (d.parent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM decks m WHERE m.id = d.parent_id AND m.visibility = 'public' AND m.archived = 0 AND m.taken_down_at IS NULL))
          GROUP BY c.value"
    )))
    .fetch_all(pool)
    .await?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    for (name, n) in rows {
        *counts.entry(name.to_lowercase()).or_default() += n;
    }
    Ok(counts)
}

/// A line under a commander on the ranking page: how many public decks it leads, linked to
/// them in Browse. Nothing when there are none.
pub(crate) fn commander_link(name: &str, counts: &HashMap<String, i64>) -> String {
    match counts.get(&name.to_lowercase()) {
        Some(n) if *n > 0 => format!(
            "<small class=\"commander-precon\"><a href=\"/decks/browse?commander={}\">{} public {}</a> on Yama</small>",
            crate::public_page::e(&query_value(name)),
            n,
            if *n == 1 { "deck" } else { "decks" }
        ),
        _ => String::new(),
    }
}

/// The most deck pages the sitemap names (a sitemap file may hold 50,000 addresses).
const IN_SITEMAP: i64 = 20_000;

/// The listed decks' pages for the sitemap, the most recently saved first: each deck's share
/// token and the day its current list was saved. Configurations are left to their main deck's
/// page, which links to them, as in the listing.
pub(crate) async fn sitemap_decks(pool: &SqlitePool) -> AppResult<Vec<(String, String)>> {
    // `LISTED` and the limit are constants.
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT d.share_token, substr(v.created_at, 1, 10) FROM decks d JOIN users u ON u.id = d.owner_id
           JOIN deck_versions v ON v.id = d.current_version_id
          WHERE {LISTED}
            AND (d.parent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM decks m WHERE m.id = d.parent_id AND m.visibility = 'public' AND m.archived = 0 AND m.taken_down_at IS NULL))
          ORDER BY v.created_at DESC, d.id LIMIT {IN_SITEMAP}"
    )))
    .fetch_all(pool)
    .await?)
}
