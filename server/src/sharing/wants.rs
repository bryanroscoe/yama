//! "Looking for": the cards on someone's shopping list, shared on their profile when they turn it
//! on (`users.wants_public`), at `/u/<handle>/wants`, and the signed-in comparison with a friend
//! (`/api/sharing/compare/<handle>`): the cards on their list you have, and the cards on your list
//! in their shared collection.
//!
//! The list is the store trip's (`plan::trip::trip_wants`): planned buys with no order, proposals
//! they said they want, cards added by hand and the real-card wishlist (never a proposal they
//! haven't decided on), one line a card. The public sees only each card's name, how many
//! copies, whether it's a reason to go to a store, and the card's dated market price. Never which
//! deck it's for, what it replaces, why, the store, rule or price limits, or anything else from
//! the plan.
use super::html;
use super::*;
use crate::public_page::{card_item, e, usd, when};
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
    pub(crate) image: Option<String>,
    pub(crate) type_line: Option<String>,
    /// The card's cheapest non-foil market price and its date; none is unknown, never $0.
    pub(crate) market: Option<f64>,
    pub(crate) market_date: Option<String>,
}

/// The most cards a list reads: a public page mustn't do work in proportion to a huge wishlist.
const MAX_CARDS: usize = 1000;

/// The most distinct names read from a list before they're matched to cards.
const MAX_NAMES: usize = 5000;

/// Each owner's list with the plan bundle's cache key it was made from (`bundle::rev`, which
/// changes with their plan, decks, wants, research and every card or price import). Reading a
/// list loads the whole bundle, so a public page mustn't do it on every visit.
type Cached = HashMap<String, (String, Vec<WantLine>)>;
static CACHE: std::sync::OnceLock<std::sync::Mutex<Cached>> = std::sync::OnceLock::new();
const CACHE_OWNERS: usize = 256;

/// Someone's shopping list as cards (needed first, then by name).
pub(crate) async fn want_lines(pool: &SqlitePool, owner: &str) -> AppResult<Vec<WantLine>> {
    let rev = crate::plan::bundle::rev(pool, owner).await?;
    let cache = CACHE.get_or_init(Default::default);
    if let Some((r, lines)) = cache.lock().expect("want list cache").get(owner)
        && *r == rev
    {
        return Ok(lines.clone());
    }
    let lines = load_lines(pool, owner).await?;
    let mut c = cache.lock().expect("want list cache");
    if c.len() >= CACHE_OWNERS && !c.contains_key(owner) {
        c.clear();
    }
    c.insert(owner.to_string(), (rev, lines.clone()));
    Ok(lines)
}

async fn load_lines(pool: &SqlitePool, owner: &str) -> AppResult<Vec<WantLine>> {
    let bundle = crate::plan::bundle::load_bundle(pool, owner).await?;
    // By name as written first: (name, copies, needed).
    let mut named: Vec<(String, i64, bool)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for w in crate::plan::trip::trip_wants(&bundle) {
        // A proposal they haven't said they want isn't something they're looking for.
        if w.source == "proposal" && !w.needed {
            continue;
        }
        let name = w.card.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        match at.get(&key) {
            Some(&i) => {
                named[i].1 += 1;
                named[i].2 |= w.needed;
            }
            None if named.len() < MAX_NAMES => {
                at.insert(key, named.len());
                named.push((name.to_string(), 1, w.needed));
            }
            None => {}
        }
    }
    // Then by card: one card written two ways ("Delver of Secrets" and its full double-faced
    // name, or "sol ring") is one line under the card's own name.
    let found = super::research::lookup(pool, named.iter().map(|l| l.0.as_str())).await?;
    let ids: Vec<&str> = named.iter().filter_map(|l| super::research::found(&found, &l.0).map(|f| f.5.as_str())).collect();
    let canonical: HashMap<String, String> = sqlx::query_as("SELECT oracle_id, name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let mut out: Vec<WantLine> = Vec::new();
    let mut by_card: HashMap<String, usize> = HashMap::new();
    for (name, qty, needed) in named {
        let f = super::research::found(&found, &name);
        let key = f.map_or_else(|| format!("name:{}", name.to_lowercase()), |f| f.5.clone());
        if let Some(&i) = by_card.get(&key) {
            out[i].qty += qty;
            out[i].needed |= needed;
            continue;
        }
        by_card.insert(key, out.len());
        out.push(WantLine {
            name: f.and_then(|f| canonical.get(&f.5).cloned()).unwrap_or(name),
            oracle_id: f.map(|f| f.5.clone()),
            qty,
            needed,
            image: f.and_then(|f| f.4.clone()).filter(|u| u.starts_with("https://cards.scryfall.io/")),
            type_line: f.and_then(|f| f.1.clone()),
            market: None,
            market_date: None,
        });
    }
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

fn small(l: &WantLine) -> String {
    let price = match (l.market, &l.market_date) {
        (Some(p), Some(d)) => format!("{} market, {}", usd(Some(p)), when(d)),
        _ => "No market price".into(),
    };
    match &l.type_line {
        Some(t) => format!("{}. {}", e(t), e(&price)),
        None => e(&price),
    }
}

pub(super) async fn page(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = match shared_wants(&st.pool, &handle).await {
        Ok(x) => x,
        Err(AppError::NotFound(_)) => return Ok(html::not_found(&st, "List")),
        Err(err) => return Err(err),
    };
    let h = sharer.handle.clone().unwrap_or_default();
    let copies: i64 = lines.iter().map(|l| l.qty).sum();
    let mut body = format!(
        "<a class=\"back-link\" href=\"/u/{0}\">← @{0}</a><section class=\"share-profile-head\"><p class=\"eyebrow\">Looking for</p><h1>@{0}'s want list</h1><p class=\"dim\">{1}. Market prices are dated TCGplayer market prices from Scryfall, not offers.</p></section>",
        e(&h),
        match (lines.len(), copies) {
            (0, _) => "Nothing on the list right now".to_string(),
            (1, 1) => "1 card".to_string(),
            (1, c) => format!("1 card, {c} copies"),
            (n, c) if c as usize == n => format!("{n} cards"),
            (n, c) => format!("{n} cards, {c} copies"),
        }
    );
    let download = if lines.is_empty() { String::new() } else { format!("<a class=\"button primary\" href=\"/u/{}/wants.txt\" download>Download as a list</a>", e(&h)) };
    write!(
        body,
        "<div class=\"public-actions\">{download}<a class=\"button{class}\" href=\"/sharing/compare/{h}\">Compare with your collection ↗</a></div>",
        class = if lines.is_empty() { " primary" } else { "" },
        h = e(&h),
    )
    .unwrap();
    for (title, needed) in [("Looking for", true), ("Also on the list", false)] {
        let group: Vec<&WantLine> = lines.iter().filter(|l| l.needed == needed).collect();
        if group.is_empty() {
            continue;
        }
        let priced: Vec<f64> = group.iter().filter_map(|l| l.market.map(|m| m * l.qty as f64)).collect();
        let unpriced = group.iter().filter(|l| l.market.is_none()).count();
        let total = if priced.is_empty() {
            String::new()
        } else {
            format!(
                " {} at market{}.",
                usd(Some(priced.iter().sum())),
                if unpriced > 0 { format!(", {unpriced} without a price") } else { String::new() }
            )
        };
        write!(
            body,
            "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} {}.{}</p><h2>{title}</h2></div></div><ul class=\"public-card-list\">",
            group.len(),
            if group.len() == 1 { "card" } else { "cards" },
            e(&total),
        )
        .unwrap();
        for l in group {
            body.push_str(&card_item(&l.name, l.image.as_deref(), &html::scryfall(&l.name), l.qty, &small(l)));
        }
        body.push_str("</ul></section>");
    }
    if !lines.is_empty() {
        body.push_str("<p class=\"dim\">Images and card details from Scryfall.</p>");
    }
    let description = format!("The Magic cards @{h} is looking for, shared on Yama.");
    Ok(html::response(&headers, html::page(&st, &format!("/u/{h}/wants"), &format!("@{h}'s want list"), &description, None, &body)))
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
            Some(Match { want: w.clone(), copies, in_decks: Some(in_decks), printings: vec![] })
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
            Some(Match { want: w.clone(), copies: p.iter().map(|c| c.qty).sum(), in_decks: None, printings: p })
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
    let wants = |w: &WantLine| format!("{} wanted{}", w.qty, if w.needed { "" } else { ", along the way or wishlist" });
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
        let _ = writeln!(out, "\nThis account's shopping list: {} cards. @{h}'s shared collection has {} of them:", c.your_wants, c.they_have.len());
        for m in &c.they_have {
            let prints: Vec<String> = m
                .printings
                .iter()
                .map(|p| {
                    let finish = if p.finish == "nonfoil" { String::new() } else { format!(" {}", p.finish) };
                    format!("{} {} {}{finish} {}", p.qty, p.set_code.to_uppercase(), p.collector_number, p.condition)
                })
                .collect();
            let _ = writeln!(out, "- {} ({}; {}): @{h} has {} ({})", m.want.name, wants(&m.want), price(&m.want), m.copies, prints.join(", "));
        }
    } else {
        let _ = writeln!(out, "\n@{h} doesn't share a collection, so this account's shopping list can't be matched against it.");
    }
    let _ = writeln!(out, "\nMarket prices are dated TCGplayer market via Scryfall, not offers. Copies are real cards; proxies aren't counted.");
    out
}
