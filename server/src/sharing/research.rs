//! Research notes shared by link (`/r/<token>`) or on a profile: the guide part of a note only,
//! from `deck_research::public_view` (never review answers, ownership, acquisition evidence or
//! shopping). A note's page lists its decks; each deck's page shows one build at a time
//! (`?build=`), with how to pilot it, its changes from the starting list and the full list.
use super::html::{card_views, credit, not_found, page, response, scryfall};
use super::*;
use crate::public_page::{bracket_name, e, identity as pips, usd, when};
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

/// A commander's art (crop, artist, name) and its color identity as pips, for the page and tile
/// headers. A commander Yama doesn't know gets no pips: an empty identity would read colorless.
async fn commander_art(pool: &SqlitePool, name: &str) -> AppResult<(Option<(String, Option<String>, String)>, String)> {
    let Some((_, _, _, _, ci, crop, artist)) = card_by_name(pool, name).await? else { return Ok((None, String::new())) };
    let art = scryfall_image(crop).filter(|_| artist.is_some()).map(|u| (u, artist, name.to_string()));
    Ok((art, pips(&"WUBRG".chars().filter(|c| ci.contains(*c)).collect::<String>())))
}

/// The most lines of a build's list a shared page reads. A Commander list is about 100 lines;
/// a note can hold far longer text, and a public page mustn't do work in proportion to it.
const MAX_LINES: usize = 300;

/// A looked-up card: (name asked for, type line, mana value, layout, image, oracle id).
type Found = (String, Option<String>, f64, Option<String>, Option<String>, String);

fn front(name: &str) -> &str {
    name.split(" // ").next().unwrap_or(name)
}

/// Each name's card (and its front face's, for double-faced names) in one query, keyed by the
/// name asked for. Real cards before tokens of the same name, Commander-legal ones first.
async fn lookup<'a>(pool: &SqlitePool, names: impl Iterator<Item = &'a str>) -> AppResult<HashMap<String, Found>> {
    // Names as written: SQLite's lower() and NOCASE fold ASCII only, so Rust's Unicode
    // lowercasing ("Éowyn" → "éowyn") would never match. card_names' NOCASE covers ASCII case.
    let mut names: Vec<&str> = names.flat_map(|n| [n, front(n)]).collect();
    names.sort();
    names.dedup();
    let rows: Vec<Found> = sqlx::query_as(
        "SELECT j.value, c.type_line, c.cmc, c.layout, c.image_normal, c.oracle_id
         FROM json_each(?) j JOIN card_names n ON n.name = j.value JOIN cards c ON c.oracle_id = n.oracle_id
         ORDER BY c.type_line LIKE 'Token%', json_extract(c.legalities, '$.commander') IS NOT 'legal'",
    )
    .bind(serde_json::to_string(&names).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let mut found = HashMap::new();
    for row in rows {
        found.entry(row.0.clone()).or_insert(row);
    }
    Ok(found)
}

fn found<'a>(found: &'a HashMap<String, Found>, name: &str) -> Option<&'a Found> {
    found.get(name).or_else(|| found.get(front(name)))
}

/// A build's plain-text list as cards the shared list views can show, and whether it was cut
/// at `MAX_LINES`. Every name is looked up in one query.
async fn cards_of(pool: &SqlitePool, list: &str) -> AppResult<(Vec<SharedCard>, bool)> {
    let mut lines = crate::decks::parse_list(list, true);
    let cut = lines.len() > MAX_LINES;
    lines.truncate(MAX_LINES);
    let rows = lookup(pool, lines.iter().map(|l| l.name.as_str())).await?;
    let out = lines
        .into_iter()
        .map(|line| {
            let (type_line, cmc, layout, image) = match found(&rows, &line.name) {
                Some((_, t, cmc, layout, image, _)) => (t.clone(), *cmc, layout.clone(), scryfall_image(image.clone())),
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

/// The build `?build=` names, else the recommended one, else the first. A named build that isn't
/// there (removed or renamed since the link was sent) is not found, never another build.
fn build_of<'a>(deck: &'a Value, wanted: Option<&str>) -> Option<&'a Value> {
    let builds = deck["builds"].as_array()?;
    match wanted {
        Some(w) => builds.iter().find(|b| text(b, "id") == w),
        None => builds.iter().find(|b| text(b, "id") == text(deck, "recommended_build")).or_else(|| builds.first()),
    }
}

fn deck_href(token: &str, deck: &str, build: Option<&str>) -> String {
    let mut path = format!("/r/{}/{}", e(token), e(deck));
    if let Some(b) = build {
        write!(path, "?build={}", query_value(b)).unwrap();
    }
    path
}

fn query_value(v: &str) -> String {
    url::form_urlencoded::byte_serialize(v.as_bytes()).collect()
}

/// A build's page compared with another build (`&vs=`), else with the starting list.
fn compare_href(token: &str, deck: &str, build: &str, vs: Option<&str>) -> String {
    let mut path = deck_href(token, deck, Some(build));
    if let Some(v) = vs {
        write!(path, "&amp;vs={}", query_value(v)).unwrap();
    }
    path
}

/// A swap's copies: `qty`, else one.
fn qty(s: &Value) -> i64 {
    s.get("qty").and_then(Value::as_i64).filter(|n| *n > 0).unwrap_or(1)
}

/// Copies added and cut by a build's swaps.
fn moved(swaps: &[Value], side: &str) -> i64 {
    swaps.iter().filter(|s| !text(s, side).is_empty()).map(qty).sum()
}

/// One row of the changes table: copies of a card added and of one cut, with the reason and
/// any notes under it.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Change {
    pub add: String,
    pub cut: String,
    pub n: i64,
    pub why: String,
    pub notes: Vec<String>,
}

/// `label` and `t` as one note, or nothing when `t` is empty.
fn labelled(label: &str, t: &str) -> Vec<String> {
    if t.is_empty() { Vec::new() } else { vec![format!("{label}{t}")] }
}

/// A build's changes from the starting list: its swaps as written.
fn from_start(swaps: &[Value]) -> Vec<Change> {
    swaps
        .iter()
        .map(|s| Change {
            add: text(s, "card_in").into(),
            cut: text(s, "card_out").into(),
            n: qty(s),
            why: text(s, "why").into(),
            notes: [labelled("Cut: ", text(s, "why_out")), labelled("", text(s, "pairing_note"))].concat(),
        })
        .collect()
}

/// A card name as builds are compared, matching names as the card lookup does: its front face,
/// ASCII case folded. "Sol Ring" and "sol ring" are one card, and so are "Fire // Ice" and
/// "Fire". Rows keep the spelling as written.
fn same(name: &str) -> String {
    front(name).to_ascii_lowercase()
}

/// Copies of each card a list plays (commander and main deck), keyed by `same`, and the names
/// as first written, in list order. The whole list: comparing only part of it could call two
/// different builds the same.
fn counts(list: &str) -> (Vec<String>, HashMap<String, i64>) {
    let lines = crate::decks::parse_list(list, true);
    let (mut order, mut n) = (Vec::new(), HashMap::new());
    for line in lines.into_iter().filter(|l| l.board != Board::Side) {
        let copies = n.entry(same(&line.name)).or_insert(0);
        if *copies == 0 {
            order.push(line.name);
        }
        *copies += line.qty;
    }
    (order, n)
}

/// Pairs up to `want` copies of `add` with `cut` while both are still unaccounted for.
fn take(adds: &mut HashMap<String, i64>, add: &str, cuts: &mut HashMap<String, i64>, cut: &str, want: i64) -> i64 {
    let (add, cut) = (same(add), same(cut));
    let n = want.min(adds.get(&add).copied().unwrap_or(0)).min(cuts.get(&cut).copied().unwrap_or(0));
    if n > 0 {
        *adds.get_mut(&add).unwrap() -= n;
        *cuts.get_mut(&cut).unwrap() -= n;
    }
    n
}

/// What a build changes from another build of the same deck. The two lists are compared card by
/// card; each build's swaps (its changes from the starting list) pair the cards and give the
/// reasons. Cards no swap explains are listed on their own.
pub(super) fn compare<'a>(list: &str, swaps: &'a [Value], vs_list: &str, vs_swaps: &'a [Value], vs_label: &str) -> Vec<Change> {
    let (order, here) = counts(list);
    let (vs_order, there) = counts(vs_list);
    let extra = |a: &HashMap<String, i64>, b: &HashMap<String, i64>| -> HashMap<String, i64> {
        a.iter().map(|(k, n)| (k.clone(), n - b.get(k).copied().unwrap_or(0))).filter(|(_, n)| *n > 0).collect()
    };
    let (mut adds, mut cuts) = (extra(&here, &there), extra(&there, &here));
    let mut rows = Vec::new();
    // This build's own swap: its reason holds against either list.
    for s in swaps {
        let n = take(&mut adds, text(s, "card_in"), &mut cuts, text(s, "card_out"), qty(s));
        if n > 0 {
            let notes = [labelled("Cut: ", text(s, "why_out")), labelled("", text(s, "pairing_note"))].concat();
            rows.push(Change { add: text(s, "card_in").into(), cut: text(s, "card_out").into(), n, why: text(s, "why").into(), notes });
        }
    }
    // Both builds replace the same starting card, each with a different card. The other build's
    // swaps wait by the card they replace, in order (a stack, so reversed); each is tried once
    // and leaves, so this is one pass over each build's swaps however many replace one card.
    let mut replacing: HashMap<String, Vec<&Value>> = HashMap::new();
    for t in vs_swaps.iter().rev().filter(|t| !text(t, "card_out").is_empty()) {
        replacing.entry(same(text(t, "card_out"))).or_default().push(t);
    }
    let left = |m: &HashMap<String, i64>, name: &str| m.get(&same(name)).copied().unwrap_or(0);
    for s in swaps {
        let Some(waiting) = replacing.get_mut(&same(text(s, "card_out"))).filter(|_| !text(s, "card_out").is_empty()) else { continue };
        while left(&adds, text(s, "card_in")) > 0 {
            let Some(t) = waiting.pop() else { break };
            let n = take(&mut adds, text(s, "card_in"), &mut cuts, text(t, "card_in"), qty(s).min(qty(t)));
            if n > 0 {
                rows.push(Change {
                    add: text(s, "card_in").into(),
                    cut: text(t, "card_in").into(),
                    n,
                    why: text(s, "why").into(),
                    notes: [vec![format!("Both builds cut {} for these.", text(s, "card_out"))], labelled("", text(s, "pairing_note"))].concat(),
                });
            }
        }
    }
    // The other build swapped a starting card out; this one keeps it.
    for t in vs_swaps {
        let n = take(&mut adds, text(t, "card_out"), &mut cuts, text(t, "card_in"), qty(t));
        if n > 0 {
            rows.push(Change {
                add: text(t, "card_out").into(),
                cut: text(t, "card_in").into(),
                n,
                why: format!("Keeps the starting list's card; {vs_label} swaps it for {}.", text(t, "card_in")),
                notes: [labelled(&format!("{}: ", text(t, "card_in")), text(t, "why")), labelled("", text(t, "pairing_note"))].concat(),
            });
        }
    }
    // Each build's first swap per card, so the cards left over cost a lookup each.
    let index = |swaps: &'a [Value], side: &str| {
        let mut by: HashMap<String, &'a Value> = HashMap::new();
        for s in swaps {
            by.entry(same(text(s, side))).or_insert(s);
        }
        by
    };
    let (ins, outs, vs_ins, vs_outs) = (index(swaps, "card_in"), index(swaps, "card_out"), index(vs_swaps, "card_in"), index(vs_swaps, "card_out"));
    for name in &order {
        let n = adds.get(&same(name)).copied().unwrap_or(0);
        if n > 0 {
            let why = match (ins.get(&same(name)), vs_outs.get(&same(name))) {
                (Some(s), _) => text(s, "why").to_string(),
                (None, Some(_)) => format!("Keeps the starting list's card; {vs_label} cuts it."),
                _ => String::new(),
            };
            rows.push(Change { add: name.clone(), n, why, ..Default::default() });
        }
    }
    for name in &vs_order {
        let n = cuts.get(&same(name)).copied().unwrap_or(0);
        if n > 0 {
            let why = match (outs.get(&same(name)), vs_ins.get(&same(name))) {
                (Some(s), _) => text(s, "why_out").to_string(),
                (None, Some(t)) => format!("Only in {vs_label}: {}", text(t, "why")),
                _ => String::new(),
            };
            rows.push(Change { cut: name.clone(), n, why, ..Default::default() });
        }
    }
    rows
}

/// A card at this market price or less is worth buying at a local store; above it, a printed
/// proxy costs less. A card with no price is neither and stays out of the money totals.
const BUY_UP_TO: f64 = 2.0;
/// About what one printed proxy costs.
const PRINT_EACH: f64 = 0.30;

/// Copies to get and what they come to.
#[derive(Default)]
struct Totals {
    cards: i64,
    buy: i64,
    buy_cost: f64,
    print: i64,
    print_cost: f64,
    worth: f64,
    unpriced: i64,
}

impl Totals {
    fn add(&mut self, n: i64, price: Option<f64>) {
        self.cards += n;
        let copies = n as f64;
        match price {
            None => self.unpriced += n,
            Some(p) if p > BUY_UP_TO => {
                self.print += n;
                self.print_cost += PRINT_EACH * copies;
                self.worth += p * copies;
            }
            Some(p) => {
                self.buy += n;
                self.buy_cost += p * copies;
                self.worth += p * copies;
            }
        }
    }
    /// Market worth, unknown (never $0) when no card has a price.
    fn worth(&self) -> Option<f64> {
        (self.buy + self.print > 0).then_some(self.worth)
    }
    /// Buys plus prints, unknown (never $0) when no card has a price.
    fn cost(&self) -> Option<f64> {
        (self.buy + self.print > 0).then_some(self.buy_cost + self.print_cost)
    }
}

/// A card to get: copies, its market price and that price's date (the cheapest paper
/// printing, as the planner prices), its image, and the decks it goes in.
struct ToGet {
    name: String,
    n: i64,
    price: Option<(f64, String)>,
    image: String,
    decks: Vec<String>,
}

impl ToGet {
    fn usd(&self) -> Option<f64> {
        self.price.as_ref().map(|p| p.0)
    }
}

/// Prices the cards to get, given as (name, copies, deck), merging repeats of a name. One
/// lookup for the names and one for the prices.
async fn to_get(pool: &SqlitePool, wanted: impl IntoIterator<Item = (String, i64, Option<String>)>) -> AppResult<Vec<ToGet>> {
    let mut items: Vec<ToGet> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (name, n, deck) in wanted {
        if name.is_empty() || n <= 0 {
            continue;
        }
        let i = *at.entry(name.clone()).or_insert_with(|| {
            items.push(ToGet { name, n: 0, price: None, image: String::new(), decks: Vec::new() });
            items.len() - 1
        });
        items[i].n += n;
        if let Some(d) = deck.filter(|d| !items[i].decks.contains(d)) {
            items[i].decks.push(d);
        }
    }
    let rows = lookup(pool, items.iter().map(|t| t.name.as_str())).await?;
    let ids: Vec<&str> = items.iter().filter_map(|t| found(&rows, &t.name)).map(|f| f.5.as_str()).collect();
    let prices = crate::deck_prices::prices_for(pool, &ids).await?;
    for t in &mut items {
        if let Some(f) = found(&rows, &t.name) {
            t.price = prices.get(&f.5).cloned();
            t.image = scryfall_image(f.4.clone()).unwrap_or_default();
        }
    }
    Ok(items)
}

/// A card's name as a link that previews its image.
fn card_ref(name: &str, image: &str) -> String {
    format!("<a class=\"public-card-ref\" data-card-name=\"{0}\" data-card-image=\"{1}\" href=\"{2}\">{0}</a>", e(name), e(image), e(&scryfall(name)))
}

fn count_cards(n: i64) -> String {
    format!("{n} card{}", if n == 1 { "" } else { "s" })
}

/// The totals as pills, and how they're worked out.
fn shopping_totals(t: &Totals, as_of: Option<&str>) -> String {
    let mut s = format!(
        "<div class=\"share-status\"><span class=\"pill\">{}</span><span class=\"pill\">{} to buy locally: {}</span><span class=\"pill\">{} to print: {}</span><span class=\"pill\">Worth {}</span><span class=\"pill\">Costs {}</span></div>",
        count_cards(t.cards),
        t.buy,
        usd(Some(t.buy_cost)),
        t.print,
        usd(Some(t.print_cost)),
        usd(t.worth()),
        usd(t.cost()),
    );
    write!(
        s,
        "<p class=\"dim share-shop-how\">Market price is each card's cheapest paper printing at TCGplayer market, from Scryfall{}. A card at {} or less is worth buying at a local store; above that, a printed proxy at about {} costs less. Worth is what the cards sell for; cost is the buys plus the prints.",
        as_of.map(|d| format!(", as of {}", when(d))).unwrap_or_default(),
        usd(Some(BUY_UP_TO)),
        usd(Some(PRINT_EACH)),
    )
    .unwrap();
    if t.unpriced > 0 {
        write!(s, " {} without a market price in Yama {} out of the money totals.", count_cards(t.unpriced), if t.unpriced == 1 { "is" } else { "are" }).unwrap();
    }
    s.push_str("</p>");
    s
}

/// Every card to get, cards to buy first, then prints, then cards without a price. `decks` adds
/// a column for the decks each card goes in.
fn shopping_table(items: &[ToGet], decks: bool) -> String {
    let group = |t: &ToGet| match t.usd() {
        Some(p) if p <= BUY_UP_TO => 0,
        Some(_) => 1,
        None => 2,
    };
    let mut sorted: Vec<&ToGet> = items.iter().collect();
    sorted.sort_by(|a, b| group(a).cmp(&group(b)).then_with(|| a.name.cmp(&b.name)));
    let mut s = String::from("<table class=\"share-collection share-shop\"><thead><tr><th scope=\"col\">Card</th>");
    if decks {
        s.push_str("<th scope=\"col\">Decks</th>");
    }
    s.push_str("<th scope=\"col\">Get it</th><th scope=\"col\" class=\"num\">Market</th><th scope=\"col\" class=\"num\">Cost</th></tr></thead><tbody>");
    for t in sorted {
        let count = if t.n > 1 { format!("{} × ", t.n) } else { String::new() };
        write!(s, "<tr><td>{count}{}</td>", card_ref(&t.name, &t.image)).unwrap();
        if decks {
            write!(s, "<td class=\"dim\">{}</td>", e(&t.decks.join(", "))).unwrap();
        }
        let (how, cost) = match t.usd() {
            Some(p) if p <= BUY_UP_TO => ("Buy locally", Some(p * t.n as f64)),
            Some(_) => ("Print", Some(PRINT_EACH * t.n as f64)),
            None => ("No price", None),
        };
        write!(s, "<td>{how}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>", usd(t.usd()), usd(cost)).unwrap();
    }
    s.push_str("</tbody></table>");
    s
}

/// The oldest price date among the cards, so the page never claims fresher prices than it has.
fn as_of(items: &[ToGet]) -> Option<&str> {
    items.iter().filter_map(|t| t.price.as_ref().map(|p| p.1.as_str())).min()
}

/// Signed-in or not, Yama opens the copy; signing in comes first when needed.
fn copy_button(token: &str) -> String {
    format!(
        "<div class=\"public-actions share-copy\"><a class=\"button primary\" href=\"/decks/research?copy={}\">Save a copy in Yama</a><span class=\"dim\">Free with a Google sign-in. Your copy is private and yours to change.</span></div>",
        e(&query_value(token))
    )
}

/// A source link, only for http(s) addresses; anything else is its title as text.
fn source(s: &Value) -> String {
    let title = e(text(s, "title"));
    let accessed = if text(s, "accessed").is_empty() { String::new() } else { format!(" <span class=\"dim\">checked {}</span>", e(text(s, "accessed"))) };
    match url::Url::parse(text(s, "url")).ok().filter(|u| matches!(u.scheme(), "http" | "https")) {
        Some(u) => format!("<li><a href=\"{}\" rel=\"noreferrer\">{title}</a>{accessed}</li>", e(u.as_str())),
        None => format!("<li>{title}{accessed}</li>"),
    }
}

fn bracket_label(b: &Value) -> Option<String> {
    b.get("bracket").and_then(Value::as_i64).filter(|n| (1..=5).contains(n)).map(|n| format!("Bracket {n}, {}", bracket_name(n)))
}

pub(super) async fn note(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(token): Path<String>,
    Query(q): Query<BuildQuery>,
) -> AppResult<Response> {
    let (handle, doc, saved) = match load(&st, &address, &token).await? {
        Ok(x) => x,
        Err(res) => return Ok(res),
    };
    let title = text(&doc, "title");
    let decks = doc["decks"].as_array().cloned().unwrap_or_default();
    // The shopping list prices one build id across the decks (`?build=`), else each deck's
    // recommended build. An id no deck has is not found, like a deck page's `?build=`.
    let mut choices: Vec<(&str, &str)> = Vec::new();
    for b in decks.iter().flat_map(|d| d["builds"].as_array().into_iter().flatten()) {
        if !choices.iter().any(|c| c.0 == text(b, "id")) {
            choices.push((text(b, "id"), text(b, "label")));
        }
    }
    let pick = q.build.as_deref().filter(|b| !b.is_empty());
    if pick.is_some_and(|p| !choices.iter().any(|c| c.0 == p)) {
        return Ok(not_found(&st, "Build"));
    }
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
    body.push_str(&copy_button(&token));
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
            identity,
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
    body.push_str(&note_shopping(&st.pool, &token, &decks, &choices, pick).await?);
    let description = format!("{title}: Commander deck notes shared on Yama.");
    Ok(response(&headers, page(&st, &format!("/r/{token}"), title, &description, None, &body)))
}

/// The note's shopping list: each deck's cards to add to its starting list, totals per deck and
/// overall, and every card in one list.
async fn note_shopping(pool: &SqlitePool, token: &str, decks: &[Value], choices: &[(&str, &str)], pick: Option<&str>) -> AppResult<String> {
    let per_deck: Vec<(&Value, Option<&Value>, Vec<(String, i64)>)> = decks
        .iter()
        .map(|d| {
            let b = build_of(d, pick);
            let adds = b
                .map(|b| from_start(b["swaps"].as_array().map(Vec::as_slice).unwrap_or_default()).into_iter().filter(|c| !c.add.is_empty()).map(|c| (c.add, c.n)).collect())
                .unwrap_or_default();
            (d, b, adds)
        })
        .collect();
    let wanted = per_deck.iter().flat_map(|(d, _, adds)| adds.iter().map(move |(name, n)| (name.clone(), *n, Some(text(d, "name").to_string()))));
    let items = to_get(pool, wanted).await?;
    if items.is_empty() {
        return Ok(String::new());
    }
    let price: HashMap<&str, Option<f64>> = items.iter().map(|t| (t.name.as_str(), t.usd())).collect();
    let mut total = Totals::default();
    for t in &items {
        total.add(t.n, t.usd());
    }
    let mut s = format!(
        "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} to add across {} deck{}</p><h2 id=\"shop-head\">Shopping list</h2></div></div>",
        count_cards(total.cards),
        decks.len(),
        if decks.len() == 1 { "" } else { "s" }
    );
    if choices.len() > 1 {
        s.push_str("<nav class=\"share-configs\" aria-label=\"Builds to price\"><span class=\"dim\">Builds</span><ul>");
        let current = |on: bool| if on { " aria-current=\"page\"" } else { "" };
        write!(s, "<li><a{} href=\"/r/{}#shop-head\">Recommended</a></li>", current(pick.is_none()), e(token)).unwrap();
        for (id, label) in choices {
            write!(s, "<li><a{} href=\"/r/{}?build={}#shop-head\">{}</a></li>", current(pick == Some(*id)), e(token), e(&query_value(id)), e(label)).unwrap();
        }
        s.push_str("</ul></nav>");
    }
    s.push_str(&shopping_totals(&total, as_of(&items)));
    s.push_str("<table class=\"share-collection share-shop-decks\"><thead><tr><th scope=\"col\">Deck</th><th scope=\"col\">Build</th><th scope=\"col\" class=\"num\">Cards</th><th scope=\"col\" class=\"num\">Buy locally</th><th scope=\"col\" class=\"num\">Print</th><th scope=\"col\" class=\"num\">Worth</th><th scope=\"col\" class=\"num\">Cost</th></tr></thead><tbody>");
    let row = |t: &Totals| {
        format!(
            "<td class=\"num\">{}</td><td class=\"num\">{} · {}</td><td class=\"num\">{} · {}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>",
            t.cards,
            t.buy,
            usd(Some(t.buy_cost)),
            t.print,
            usd(Some(t.print_cost)),
            usd(t.worth()),
            usd(t.cost())
        )
    };
    for (d, b, adds) in &per_deck {
        let mut t = Totals::default();
        for (name, n) in adds {
            t.add(*n, price.get(name.as_str()).copied().flatten());
        }
        let build = match b {
            Some(b) => e(text(b, "label")),
            None => "<span class=\"dim\">No such build</span>".into(),
        };
        write!(s, "<tr><td><a href=\"{}\">{}</a></td><td>{build}</td>{}</tr>", deck_href(token, text(d, "key"), b.map(|b| text(b, "id"))), e(text(d, "name")), row(&t)).unwrap();
    }
    write!(s, "</tbody><tfoot><tr><th scope=\"row\" colspan=\"2\">Total</th>{}</tr></tfoot></table>", row(&total)).unwrap();
    write!(s, "<details><summary>Every card to get ({})</summary>{}</details></section>", count_cards(total.cards), shopping_table(&items, true)).unwrap();
    Ok(s)
}

#[derive(Deserialize, Default)]
pub(super) struct BuildQuery {
    #[serde(default)]
    build: Option<String>,
    /// Another build to show the changes from; none means the starting list.
    #[serde(default)]
    vs: Option<String>,
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
    let Some(b) = build_of(d, q.build.as_deref()) else { return Ok(not_found(&st, "Build")) };
    // Like `?build=`: a comparison build that isn't there (or is this one) is not found.
    let vs = match q.vs.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => match build_of(d, Some(v)).filter(|x| text(x, "id") != text(b, "id")) {
            Some(x) => Some(x),
            None => return Ok(not_found(&st, "Build")),
        },
        None => None,
    };
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
        identity,
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
            // Switching builds keeps the comparison, unless it's the build switched to.
            let keep = vs.map(|v| text(v, "id")).filter(|v| *v != id);
            write!(body, "<li><a{current} href=\"{}\">{}{recommended}</a></li>", compare_href(&token, &key, id, keep), e(text(x, "label"))).unwrap();
        }
        body.push_str("</ul></nav>");
    }

    body.push_str("<div class=\"share-status\">");
    if let Some(l) = bracket_label(b) {
        write!(body, "<span class=\"pill\">{}</span>", e(&l)).unwrap();
    }
    // Only when the note lists them: a missing list isn't zero Game Changers.
    let gcs = strings(b, "game_changers");
    if b.get("game_changers").is_some_and(Value::is_array) {
        write!(body, "<span class=\"pill\">{} Game Changer{}</span>", gcs.len(), if gcs.len() == 1 { "" } else { "s" }).unwrap();
    }
    let swaps = b["swaps"].as_array().cloned().unwrap_or_default();
    write!(body, "<a class=\"pill dashed\" href=\"#changes-head\">{} in, {} out from the starting list</a>", moved(&swaps, "card_in"), moved(&swaps, "card_out")).unwrap();
    body.push_str("</div>");
    body.push_str(&copy_button(&token));

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
    let mechanics = strings(d, "mechanics");
    if !mechanics.is_empty() {
        write!(body, "<h3>Mechanics</h3>{}", list_items(&mechanics)).unwrap();
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
    let sources: Vec<String> = d["sources"].as_array().into_iter().flatten().filter(|s| !text(s, "title").is_empty()).map(source).collect();
    if !sources.is_empty() {
        write!(body, "<section class=\"public-panel\" aria-labelledby=\"sources-head\"><h2 id=\"sources-head\">Sources</h2><ul>{}</ul></section>", sources.concat()).unwrap();
    }
    body.push_str("</div>");

    // The changes, as a table a player can work through with the deck box open. From the
    // starting list by default; the heading picks another build to compare with instead.
    const START: &str = "the starting list";
    let vs_label = vs.map(|v| text(v, "label")).filter(|l| !l.is_empty()).unwrap_or(START);
    let changes = match vs {
        Some(v) => compare(text(b, "list"), &swaps, text(v, "list"), v["swaps"].as_array().map(Vec::as_slice).unwrap_or_default(), vs_label),
        None => from_start(&swaps),
    };
    let copies = |add: bool| -> i64 { changes.iter().filter(|c| !(if add { &c.add } else { &c.cut }).is_empty()).map(|c| c.n).sum() };
    write!(body, "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} in, {} out</p>", copies(true), copies(false)).unwrap();
    let others: Vec<&Value> = builds.iter().filter(|x| text(x, "id") != build_id).collect();
    if others.is_empty() {
        body.push_str("<h2 id=\"changes-head\">Changes from the starting list</h2>");
    } else {
        write!(
            body,
            "<div class=\"share-vs\"><h2 id=\"changes-head\">Changes from<span class=\"sr-only\"> {0}</span></h2><details><summary aria-label=\"Compare with: {0}\">{0}</summary><ul>",
            e(vs_label)
        )
        .unwrap();
        let option = |id: Option<&str>, label: &str| {
            let current = if id == vs.map(|v| text(v, "id")) { " aria-current=\"true\"" } else { "" };
            format!("<li><a{current} href=\"{}#changes-head\">{}</a></li>", compare_href(&token, &key, build_id, id), e(label))
        };
        body.push_str(&option(None, START));
        for x in &others {
            body.push_str(&option(Some(text(x, "id")), text(x, "label")));
        }
        body.push_str("</ul></details></div>");
    }
    body.push_str("</div></div>");
    if changes.is_empty() {
        body.push_str(if vs.is_some() { "<p class=\"dim\">These builds play the same cards.</p>" } else { "<p class=\"dim\">This build is the starting list.</p>" });
    } else {
        body.push_str("<table class=\"share-collection share-swaps\"><thead><tr><th scope=\"col\">Add</th><th scope=\"col\">Cut</th><th scope=\"col\">Why</th></tr></thead><tbody>");
        // Cut cards aren't in the build's list, so both sides are looked up for their images.
        let images = lookup(&st.pool, changes.iter().flat_map(|c| [c.add.as_str(), c.cut.as_str()]).filter(|n| !n.is_empty())).await?;
        let link = |name: &str, n: i64| {
            if name.is_empty() {
                "<span class=\"dim\">Nothing</span>".to_string()
            } else {
                let image = found(&images, name).and_then(|f| scryfall_image(f.4.clone())).unwrap_or_default();
                let count = if n > 1 { format!("{n} × ") } else { String::new() };
                format!("{count}{}", card_ref(name, &image))
            }
        };
        for c in &changes {
            let notes: String = c.notes.iter().map(|t| format!("<br><span class=\"dim\">{}</span>", e(t))).collect();
            write!(body, "<tr><td>{}</td><td>{}</td><td>{}{notes}</td></tr>", link(&c.add, c.n), link(&c.cut, c.n), e(&c.why)).unwrap();
        }
        body.push_str("</tbody></table>");
    }
    body.push_str("</section>");

    // What the added cards come to: from the same comparison as the table above.
    if changes.iter().any(|c| !c.add.is_empty()) {
        let items = to_get(&st.pool, changes.iter().map(|c| (c.add.clone(), c.n, None))).await?;
        let mut t = Totals::default();
        for i in &items {
            t.add(i.n, i.usd());
        }
        write!(
            body,
            "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{} to add to {}</p><h2 id=\"shop-head\">Shopping list</h2></div></div>{}{}</section>",
            count_cards(t.cards),
            e(vs_label),
            shopping_totals(&t, as_of(&items)),
            shopping_table(&items, false),
        )
        .unwrap();
    }

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
    // The whole list, with no card lookups: these formats need only names, counts and sections.
    let cards: Vec<SharedCard> = crate::decks::parse_list(text(b, "list"), true)
        .into_iter()
        .map(|l| SharedCard { name: l.name, qty: l.qty, board: l.board, type_line: None, cmc: 0.0, layout: None, image: None, printing: None })
        .collect();
    let res = fresh(&headers, export(&cards, format), "text/plain; charset=utf-8");
    Ok(attachment(res, &file_name(&format!("{} {}", text(d, "name"), text(b, "label")), format)))
}
