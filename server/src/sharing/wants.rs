//! "Looking for": the cards on someone's shopping list, shared on their profile when they turn it
//! on (`users.wants_public`), at `/u/<handle>/wants`, and the signed-in comparison with a friend
//! (`/api/sharing/compare/<handle>`): the cards on their list you have, and the cards on your list
//! in their shared collection.
//!
//! Public wants merge explicit wishes with real-card gaps across saved main decks and approved
//! buy/print upgrades. Unapproved upgrades stay private unless their owner opts to include them publicly. Public HTML
//! carries card names, quantities and dated market prices; each viewer's inventory is fetched
//! separately with no-store. No deck names, containers, acquisition notes or prices paid leave
//! their account.
use super::html;
use super::*;
use crate::public_page::{e, usd, when};
use std::fmt::Write;

/// One card on the list, its wants added up.
#[derive(Serialize, Clone, Debug)]
pub(crate) struct WantLine {
    pub(crate) name: String,
    #[serde(skip)]
    pub(crate) oracle_id: Option<String>,
    pub(crate) qty: i64,
    /// A reason to go to a store: a planned buy, a proposal they want, a card they added as "need".
    /// Otherwise one they'd pick up along the way, or a real copy for the wishlist.
    pub(crate) needed: bool,
    pub(crate) pending: bool,
    pub(crate) pending_qty: i64,
    pub(crate) image: Option<String>,
    pub(crate) type_line: Option<String>,
    /// The card's cheapest non-foil market price and its date; none is unknown, never $0.
    pub(crate) market: Option<f64>,
    pub(crate) market_date: Option<String>,
}

/// Bound public list work, allowing large collections and upgrade plans.
const MAX_CARDS: usize = 10000;

/// Each owner's list with the plan bundle's cache key it was made from (`bundle::rev`, which
/// changes with their plan, decks, wants, research and every card or price import). Reading a
/// list loads the whole bundle, so a public page mustn't do it on every visit.
type Cached = HashMap<String, (String, Vec<WantLine>)>;
static CACHE: std::sync::OnceLock<std::sync::Mutex<Cached>> = std::sync::OnceLock::new();
const CACHE_OWNERS: usize = 256;

/// Someone's shopping list as cards (needed first, then by name).
pub(crate) async fn want_lines(pool: &SqlitePool, owner: &str) -> AppResult<Vec<WantLine>> {
    let include_pending: bool = sqlx::query_scalar("SELECT wants_include_pending FROM users WHERE id = ?")
        .bind(owner)
        .fetch_one(pool)
        .await?;
    let mut rev = crate::plan::bundle::rev(pool, owner).await?;
    rev.push_str(if include_pending { "/pending" } else { "/approved" });
    // Deck gaps change when copies are added, edited or removed, independently of plan revisions.
    let collection: Vec<String> = sqlx::query_scalar(
        "SELECT i.id || '/' || i.scryfall_id || '/' || i.qty || '/' || i.proxy || '/' || COALESCE(i.container_id, '') || '/' || COALESCE(c.kind, '')
         FROM collection_items i LEFT JOIN containers c ON c.id = i.container_id AND c.owner_id = i.owner_id WHERE i.owner_id = ? ORDER BY i.id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    rev.push_str(&crate::util::sha256_hex(&collection.join(";")));
    let boxes: Vec<String> = sqlx::query_scalar("SELECT id || '/' || COALESCE(container_id, '') FROM decks WHERE owner_id = ? AND archived = 0 AND parent_id IS NULL ORDER BY id")
        .bind(owner)
        .fetch_all(pool)
        .await?;
    rev.push_str(&crate::util::sha256_hex(&boxes.join(";")));
    let cache = CACHE.get_or_init(Default::default);
    if let Some((r, lines)) = cache.lock().expect("want list cache").get(owner)
        && *r == rev
    {
        return Ok(lines.clone());
    }
    let lines = load_lines(pool, owner, include_pending).await?;
    let mut c = cache.lock().expect("want list cache");
    if c.len() >= CACHE_OWNERS && !c.contains_key(owner) {
        c.clear();
    }
    c.insert(owner.to_string(), (rev, lines.clone()));
    Ok(lines)
}

async fn load_lines(pool: &SqlitePool, owner: &str, include_pending: bool) -> AppResult<Vec<WantLine>> {
    let bundle = crate::plan::bundle::load_bundle(pool, owner).await?;
    // Keep source semantics until after canonicalization: manual wishes are extra copies,
    // whereas a watchlist entry and a derived deck gap can describe the same acquisition.
    // (name, quantity, needed, pending, source: manual=0/watchlist=1/derived=2)
    let mut named: Vec<(String, i64, bool, bool, u8)> = Vec::new();
    for w in crate::plan::trip::trip_wants(&bundle) {
        let source = match w.source {
            "want" => 0,
            "wishlist" => 1,
            _ => continue,
        };
        if !w.card.trim().is_empty() {
            named.push((w.card, 1, w.needed, false, source));
        }
    }
    named.extend(
        super::want_sources::needs(pool, owner, &bundle, include_pending)
            .await?
            .into_iter()
            .map(|(name, qty, pending)| (name, qty, !pending, pending, 2)),
    );
    let written: Vec<String> = named.iter().map(|l| l.0.clone()).collect();
    let resolved = super::want_sources::resolve_names(pool, &written).await?;
    let ids: Vec<&String> = resolved.values().collect();
    let details: HashMap<String, (String, Option<String>, Option<String>)> = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        "SELECT oracle_id,name,type_line,image_normal FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, name, typ, image)| (id, (name, typ, image)))
    .collect();
    let mut merged: HashMap<String, (WantLine, i64, i64, i64, i64)> = HashMap::new();
    for (name, qty, needed, pending, source) in named {
        let oid = resolved.get(&name);
        let detail = oid.and_then(|id| details.get(id));
        let key = oid.cloned().unwrap_or_else(|| format!("name:{}", name.to_lowercase()));
        let entry = merged.entry(key).or_insert_with(|| {
            (
                WantLine {
                    name: detail.map(|d| d.0.clone()).unwrap_or(name),
                    oracle_id: oid.cloned(),
                    qty: 0,
                    needed: false,
                    pending: false,
                    pending_qty: 0,
                    image: detail.and_then(|d| d.2.clone()).filter(|u| u.starts_with("https://cards.scryfall.io/")),
                    type_line: detail.and_then(|d| d.1.clone()),
                    market: None,
                    market_date: None,
                },
                0,
                0,
                0,
                0,
            )
        });
        match source {
            0 => entry.1 += qty,
            1 => entry.2 = entry.2.max(qty),
            _ if pending => entry.4 += qty,
            _ => entry.3 += qty,
        };
        entry.0.needed |= needed;
        entry.0.pending |= pending;
    }
    let mut out: Vec<WantLine> = merged
        .into_values()
        .map(|(mut line, manual, wishlist, confirmed, pending)| {
            line.qty = manual + wishlist.max(confirmed + pending);
            line.pending_qty = pending;
            line
        })
        .collect();
    out.sort_by(|a, b| b.needed.cmp(&a.needed).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out.truncate(MAX_CARDS);
    let ids: Vec<&str> = out.iter().filter_map(|l| l.oracle_id.as_deref()).collect();
    let prices = crate::deck_prices::cheapest_for(pool, &ids).await?;
    for l in &mut out {
        if let Some(p) = l.oracle_id.as_ref().and_then(|id| prices.get(id)) {
            l.market = Some(p.usd);
            l.market_date = Some(p.date.clone());
        }
    }
    Ok(out)
}

/// A shared list by handle: not found unless the profile exists and shares it.
pub(crate) async fn shared_wants(pool: &SqlitePool, handle: &str) -> AppResult<(Sharer, Vec<WantLine>)> {
    let sharer = sharer_by_handle(pool, handle).await?;
    if !sharer.wants_public {
        return Err(AppError::NotFound("list"));
    }
    let lines = want_lines(pool, &sharer.id).await?;
    Ok((sharer, lines))
}

#[derive(Deserialize, Default)]
pub(super) struct ListQuery {
    #[serde(default)]
    q: String,
}

fn card_row(l: &WantLine) -> String {
    let image = l
        .image
        .as_ref()
        .map(|u| format!("<img src=\"{}\" alt=\"\" loading=\"lazy\" width=\"64\" height=\"89\">", e(u)))
        .unwrap_or_default();
    let price = match (l.market, &l.market_date) {
        (Some(p), Some(d)) => format!("{} each, {}", usd(Some(p)), when(d)),
        _ => "No market price".into(),
    };
    format!(
        "<li class=\"want-row\" data-name=\"{}\" data-search=\"{}\" data-kind=\"{}\" data-pending=\"{has_pending}\"><a class=\"public-card-ref want-card\" data-card-name=\"{}\" data-card-image=\"{}\" href=\"{}\">{image}<span><b>{}</b><small>{}</small></span></a><span class=\"want-qty\"><b>{}</b><span>wanted</span></span><span class=\"want-owned\" hidden></span><span class=\"want-price\">{}</span></li>",
        e(&l.name),
        e(&format!("{} {}", l.name, l.type_line.as_deref().unwrap_or_default()).to_lowercase()),
        if l.needed {
            "needed"
        } else if l.pending {
            "pending"
        } else {
            "wishlist"
        },
        e(&l.name),
        e(l.image.as_deref().unwrap_or_default()),
        e(&html::scryfall(&l.name)),
        e(&l.name),
        e(&format!(
            "{}{}",
            l.type_line.as_deref().unwrap_or_default(),
            if l.pending {
                format!(" — includes pending upgrades ({})", l.pending_qty)
            } else {
                String::new()
            }
        )),
        l.qty,
        e(&price),
        has_pending = l.pending,
    )
}

pub(super) async fn page(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(handle): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = match shared_wants(&st.pool, &handle).await {
        Ok(x) => x,
        Err(AppError::NotFound(_)) => return Ok(html::not_found(&st, "List")),
        Err(err) => return Err(err),
    };
    let h = sharer.handle.clone().unwrap_or_default();
    let copies: i64 = lines.iter().map(|l| l.qty).sum();
    let mut body = format!(
        "<div class=\"want-page\" data-want-handle=\"{}\"><a class=\"back-link\" href=\"/u/{0}\">← @{0}</a><header class=\"want-heading\"><div><h1>@{0}'s want list</h1><p class=\"dim\">{} cards, {copies} copies</p></div><a class=\"button\" href=\"/u/{0}/wants.txt\" download>Download list</a></header>",
        e(&h),
        lines.len()
    );
    body.push_str(if sharer.wants_include_pending {
        "<p class=\"want-explainer\">Cards for decks and upgrades, including pending ideas, plus the wish list.</p>"
    } else {
        "<p class=\"want-explainer\">Missing real cards for decks and approved upgrades, based on the collection, plus the wish list.</p>"
    });
    body.push_str("<label class=\"want-pending-option\" hidden><input type=\"checkbox\"> Include pending upgrades on my public want list</label><p class=\"want-save-error\" role=\"status\"></p>");
    write!(body, "<form class=\"want-toolbar\" method=\"get\"><label class=\"want-search\"><span class=\"sr-only\">Search this want list</span><input type=\"search\" name=\"q\" value=\"{}\" placeholder=\"Search cards or types\" maxlength=\"200\" autocomplete=\"off\"></label><button type=\"submit\">Search</button><label class=\"want-filter\" hidden><span class=\"sr-only\">Show cards</span><select><option value=\"all\">All cards</option><option value=\"needed\">Decks and upgrades</option><option value=\"wishlist\">Wish list</option><option value=\"pending\">Pending upgrades</option><option value=\"spare\" disabled>Your spare copies</option><option value=\"owned\" disabled>Cards you own</option></select></label></form>", e(&query.q.chars().take(200).collect::<String>())).unwrap();
    write!(body, "<p class=\"want-account dim\"><a href=\"/signin?next=%2Fu%2F{}%2Fwants\">Sign in</a> to see your copies and whether they're in decks. <a href=\"/sharing/compare/{}\">Compare collections</a></p><p class=\"want-result dim\" role=\"status\"></p><ul class=\"want-list\">", e(&h), e(&h)).unwrap();
    // All rows stay in the document for instant searching. The ordinary GET form also works
    // without JavaScript; the initial query is applied progressively by the same filter.
    let search = query.q.to_lowercase();
    for line in &lines {
        let haystack = format!("{} {}", line.name, line.type_line.as_deref().unwrap_or_default()).to_lowercase();
        let row = card_row(line);
        body.push_str(&if search.split_whitespace().all(|term| haystack.contains(term)) {
            row
        } else {
            row.replacen("<li ", "<li hidden ", 1)
        });
    }
    body.push_str("</ul><p class=\"want-no-results\" hidden>No cards match your search.</p><p class=\"want-prices dim\">TCGplayer market prices via Scryfall, dated per card. These are reference prices, not offers.</p><section class=\"want-pending\" hidden><h2>Upgrades awaiting your approval</h2><p class=\"dim\">Only you can see these. Turn on pending upgrades above to share these cards without approving the plans.</p><ul class=\"want-list\"></ul></section></div><script defer src=\"/want-list-v1.js\"></script>");
    let description = format!("The Magic cards @{h} is looking for, shared on Yama.");
    Ok(html::response(
        &headers,
        html::page(&st, &format!("/u/{h}/wants"), &format!("@{h}'s want list"), &description, None, &body),
    ))
}

#[derive(Serialize)]
struct OwnedLine {
    name: String,
    copies: i64,
    in_decks: i64,
    proxies: i64,
}
#[derive(Serialize)]
struct OwnedView {
    owner: bool,
    include_pending: bool,
    cards: Vec<OwnedLine>,
    pending: Vec<WantLine>,
}

/// A separate private response: the public HTML and its ETag never contain a viewer's copies
/// or unapproved plans. Every visitor can see only their own inventory, including deck boxes.
pub(super) async fn owned_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(handle): Path<String>) -> AppResult<Response> {
    st.limits.people.check_user(&user)?;
    let (sharer, public) = shared_wants(&st.pool, &handle).await?;
    let owner = sharer.id == user.id;
    let pending: Vec<WantLine> = if owner {
        load_lines(&st.pool, &user.id, true)
            .await?
            .into_iter()
            .filter_map(|mut l| {
                let already_public = public.iter().find(|p| p.name == l.name).map_or(0, |p| p.pending_qty);
                l.qty = l.pending_qty - already_public;
                l.pending = true;
                l.pending_qty = l.qty;
                (l.qty > 0).then_some(l)
            })
            .collect()
    } else {
        vec![]
    };
    let mut all = public;
    all.extend(pending.iter().cloned());
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT c.name, SUM(CASE WHEN i.proxy = 0 THEN i.qty ELSE 0 END),
                SUM(CASE WHEN i.proxy = 0 AND box.kind = 'deck' THEN i.qty ELSE 0 END),
                SUM(CASE WHEN i.proxy = 1 THEN i.qty ELSE 0 END)
         FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id JOIN cards c ON c.oracle_id = p.oracle_id
         LEFT JOIN containers box ON box.id = i.container_id AND box.owner_id = i.owner_id
         WHERE i.owner_id = ? AND i.qty > 0 AND p.oracle_id IN (SELECT value FROM json_each(?)) GROUP BY c.oracle_id",
    )
    .bind(&user.id)
    .bind(ids_of(&all)?)
    .fetch_all(&st.pool)
    .await?;
    let cards = rows
        .into_iter()
        .map(|(name, copies, in_decks, proxies)| OwnedLine { name, copies, in_decks, proxies })
        .collect();
    let mut response = Json(OwnedView {
        owner,
        include_pending: sharer.wants_include_pending,
        cards,
        pending,
    })
    .into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(response)
}

#[derive(Deserialize)]
pub(super) struct PendingPreference {
    enabled: bool,
}

/// The handle fences a page left open while the browser signs into a different account.
pub(super) async fn pending_route(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(handle): Path<String>,
    Json(pref): Json<PendingPreference>,
) -> AppResult<Json<serde_json::Value>> {
    let sharer = sharer_by_handle(&st.pool, &handle).await?;
    if sharer.id != user.id {
        return Err(AppError::Forbidden("Only the owner can change this list.".into()));
    }
    sqlx::query("UPDATE users SET wants_include_pending = ? WHERE id = ?")
        .bind(pref.enabled)
        .bind(&user.id)
        .execute(&st.pool)
        .await?;
    Ok(Json(serde_json::json!({"wants_include_pending": pref.enabled})))
}

/// "1 Name" lines, needed first: Moxfield, TCGplayer Mass Entry and most stores read them.
pub(super) async fn download(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = shared_wants(&st.pool, &handle).await?;
    let body: String = lines.iter().map(|l| format!("{} {}\n", l.qty, l.name)).collect();
    let res = fresh(&headers, body, "text/plain; charset=utf-8");
    Ok(attachment(res, &format!("{}-wants.txt", sharer.handle.unwrap_or_default())))
}

// ── comparing with a friend ─────────────────────────────────────────────────

/// One of a printing's copies in a shared collection, as its public page lists them.
#[derive(Serialize, sqlx::FromRow, Debug)]
pub(crate) struct Copies {
    #[serde(skip)]
    oracle_id: String,
    pub(crate) set_code: String,
    pub(crate) set_name: Option<String>,
    pub(crate) collector_number: String,
    pub(crate) finish: String,
    pub(crate) lang: String,
    pub(crate) condition: String,
    pub(crate) qty: i64,
}

#[derive(Serialize, Debug)]
pub(crate) struct Match {
    #[serde(flatten)]
    pub(crate) want: WantLine,
    /// Real copies (no proxies) the one who has it owns.
    pub(crate) copies: i64,
    /// Of those, the copies filed in a deck box: yours only, since where theirs are is private.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) in_decks: Option<i64>,
    /// Their printings, finishes and conditions, as their collection page lists them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) printings: Vec<Copies>,
}

#[derive(Serialize, Debug)]
pub(crate) struct Compare {
    pub(crate) handle: String,
    /// It's your own profile.
    pub(crate) yourself: bool,
    pub(crate) wants_public: bool,
    pub(crate) collection_public: bool,
    /// Cards on their list (0 when it isn't shared).
    pub(crate) their_wants: usize,
    /// Cards on their list you have real copies of.
    pub(crate) you_have: Vec<Match>,
    /// Cards on your shopping list.
    pub(crate) your_wants: usize,
    /// Cards on your list in their shared collection (none when it isn't shared).
    pub(crate) they_have: Vec<Match>,
}

fn ids_of(lines: &[WantLine]) -> AppResult<String> {
    Ok(serde_json::to_string(&lines.iter().filter_map(|l| l.oracle_id.as_deref()).collect::<Vec<_>>()).map_err(anyhow::Error::from)?)
}

/// What a signed-in person and the profile `handle` could trade: only through what that profile
/// shares (its list and its collection, each when turned on), against the viewer's own data.
pub(crate) async fn compare(pool: &SqlitePool, viewer: &str, handle: &str) -> AppResult<Compare> {
    let sharer = sharer_by_handle(pool, handle).await?;
    let theirs = if sharer.wants_public { want_lines(pool, &sharer.id).await? } else { vec![] };
    let mine = want_lines(pool, viewer).await?;

    // Your real copies of the cards on their list, and how many are in a deck box.
    let owned: HashMap<String, (i64, i64)> = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT p.oracle_id, SUM(i.qty), SUM(CASE WHEN c.kind = 'deck' THEN i.qty ELSE 0 END)
         FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id LEFT JOIN containers c ON c.id = i.container_id
         WHERE i.owner_id = ? AND i.proxy = 0 AND i.qty > 0 AND p.oracle_id IN (SELECT value FROM json_each(?))
         GROUP BY p.oracle_id",
    )
    .bind(viewer)
    .bind(ids_of(&theirs)?)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, n, d)| (id, (n, d)))
    .collect();
    let you_have: Vec<Match> = theirs
        .iter()
        .filter_map(|w| {
            let &(copies, in_decks) = owned.get(w.oracle_id.as_deref()?)?;
            Some(Match {
                want: w.clone(),
                copies,
                in_decks: Some(in_decks),
                printings: vec![],
            })
        })
        .collect();

    // Their shared collection's copies of the cards on your list: the same projection as their
    // collection page (real copies by printing, finish, language and condition).
    let mut printings: HashMap<String, Vec<Copies>> = HashMap::new();
    if sharer.collection_public {
        let rows: Vec<Copies> = sqlx::query_as(
            "SELECT p.oracle_id, p.set_code, p.set_name, p.collector_number, i.finish, i.lang, i.condition, SUM(i.qty) AS qty
             FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
             WHERE i.owner_id = ? AND i.proxy = 0 AND i.qty > 0 AND p.oracle_id IN (SELECT value FROM json_each(?))
             GROUP BY p.oracle_id, p.set_code, p.collector_number, i.finish, i.lang, i.condition
             ORDER BY p.set_code, p.collector_number, i.finish",
        )
        .bind(&sharer.id)
        .bind(ids_of(&mine)?)
        .fetch_all(pool)
        .await?;
        for r in rows {
            printings.entry(r.oracle_id.clone()).or_default().push(r);
        }
    }
    let they_have: Vec<Match> = mine
        .iter()
        .filter_map(|w| {
            let p = printings.remove(w.oracle_id.as_deref()?)?;
            Some(Match {
                want: w.clone(),
                copies: p.iter().map(|c| c.qty).sum(),
                in_decks: None,
                printings: p,
            })
        })
        .collect();
    Ok(Compare {
        handle: sharer.handle.clone().unwrap_or_default(),
        yourself: sharer.id == viewer,
        wants_public: sharer.wants_public,
        collection_public: sharer.collection_public,
        their_wants: theirs.len(),
        you_have,
        your_wants: mine.len(),
        they_have,
    })
}

pub(super) async fn compare_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(handle): Path<String>) -> AppResult<Json<Compare>> {
    // Each comparison reads two lists: counted with the other lookups by handle.
    st.limits.people.check_user(&user)?;
    Ok(Json(compare(&st.pool, &user.id, &handle).await?))
}

/// The comparison as text, for Claude's `compare_with_friend`.
pub(crate) fn text(c: &Compare) -> String {
    let mut out = String::new();
    let h = &c.handle;
    if c.yourself {
        let _ = writeln!(out, "@{h} is their own profile; comparing it with themselves.");
    }
    let price = |w: &WantLine| match (w.market, &w.market_date) {
        (Some(p), Some(d)) => format!("{} market on {d}", usd(Some(p))),
        _ => "no market price".into(),
    };
    let wants = |w: &WantLine| {
        format!(
            "{} wanted{}{}",
            w.qty,
            if w.needed { "" } else { ", along the way or wishlist" },
            if w.pending_qty > 0 { format!(", {} pending", w.pending_qty) } else { String::new() }
        )
    };
    if c.wants_public {
        let _ = writeln!(out, "@{h}'s want list: {} cards. This account owns real copies of {}:", c.their_wants, c.you_have.len());
        for m in &c.you_have {
            let decks = m.in_decks.filter(|d| *d > 0).map(|d| format!(", {d} in deck boxes")).unwrap_or_default();
            let _ = writeln!(out, "- {} ({}; {}): owns {}{decks}", m.want.name, wants(&m.want), price(&m.want), m.copies);
        }
    } else {
        let _ = writeln!(out, "@{h} doesn't share a want list.");
    }
    if c.collection_public {
        let _ = writeln!(
            out,
            "\nThis account's shopping list: {} cards. @{h}'s shared collection has {} of them:",
            c.your_wants,
            c.they_have.len()
        );
        for m in &c.they_have {
            let prints: Vec<String> = m
                .printings
                .iter()
                .map(|p| {
                    let finish = if p.finish == "nonfoil" { String::new() } else { format!(" {}", p.finish) };
                    format!("{} {} {}{finish} {}", p.qty, p.set_code.to_uppercase(), p.collector_number, p.condition)
                })
                .collect();
            let _ = writeln!(
                out,
                "- {} ({}; {}): @{h} has {} ({})",
                m.want.name,
                wants(&m.want),
                price(&m.want),
                m.copies,
                prints.join(", ")
            );
        }
    } else {
        let _ = writeln!(out, "\n@{h} doesn't share a collection, so this account's shopping list can't be matched against it.");
    }
    let _ = writeln!(
        out,
        "\nMarket prices are dated TCGplayer market via Scryfall, not offers. Copies are real cards; proxies aren't counted."
    );
    out
}
