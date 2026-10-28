//! Shared decks, profiles and collections, rendered without loading the private application.
//! Same stylesheet, notice and Content-Security-Policy as the public precon reference.
use super::*;
use crate::public_precons::NOTICE;
use crate::public_precons::html::{WORDMARK, e, stylesheet, when};
use axum::extract::Query;
use std::fmt::Write;

fn page(st: &AppState, path: &str, title: &str, description: &str, image: Option<&str>, body: &str) -> String {
    let base = st.cfg.public_url.as_deref().map(|b| b.trim_end_matches('/'));
    let url = base.map(|b| format!("<meta property=\"og:url\" content=\"{}{}\">", e(b), e(path))).unwrap_or_default();
    let og_image = image.map(|i| format!("<meta property=\"og:image\" content=\"{}\">", e(i))).unwrap_or_default();
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b0c0e"><meta name="robots" content="noindex"><title>{title} | Yama</title><meta name="description" content="{description}"><meta property="og:title" content="{title}"><meta property="og:description" content="{description}"><meta property="og:type" content="website">{url}{og_image}<link rel="icon" href="/icon.svg"><link rel="preload" href="/precon-fonts/big-shoulders-display-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="{css}"><script defer src="/card-preview-v1.js"></script></head><body class="public-precons public-shared"><a class="skip" href="#content">Skip to content</a><header class="public-header"><a class="public-wordmark" href="/" aria-label="Yama home">{WORDMARK}</a><nav aria-label="Public pages"><a href="/precons">Precons</a><a class="button" href="/">Open Yama <span aria-hidden="true">↗</span></a></nav></header><main id="content">{body}</main><footer class="public-footer"><div class="footer-top"><span>Shared from Yama, a free Commander app.</span><nav aria-label="About Yama"><a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/tos/">Terms</a></nav></div>{NOTICE}</footer></body></html>"##,
        title = e(title),
        description = e(description),
        css = stylesheet().1,
    )
}

fn response(headers: &HeaderMap, body: String) -> Response {
    let mut res = fresh(headers, body, "text/html; charset=utf-8");
    res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cards.scryfall.io; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"));
    res.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    res
}

fn not_found(st: &AppState, what: &str) -> Response {
    let body = format!(
        "<section class=\"empty-state\"><h1>{what} not found</h1><p>It may be private now, or the link was reset. Ask whoever sent it for a new one.</p><p><a href=\"/\">Go to Yama</a></p></section>"
    );
    let mut res = (StatusCode::NOT_FOUND, axum::response::Html(page(st, "/", &format!("{what} not found"), "Nothing is shared here.", None, &body))).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex"));
    res
}

fn pips(identity: &str) -> String {
    let letters = if identity.is_empty() { "C" } else { identity };
    let names: Vec<_> = letters
        .chars()
        .filter_map(|c| match c {
            'W' => Some("white"),
            'U' => Some("blue"),
            'B' => Some("black"),
            'R' => Some("red"),
            'G' => Some("green"),
            'C' => Some("colorless"),
            _ => None,
        })
        .collect();
    let mut s = format!("<span class=\"identity\" aria-label=\"Color identity: {}\">", names.join(", "));
    for c in letters.chars().filter(|c| "WUBRGC".contains(*c)) {
        write!(s, "<span class=\"color color-{c}\" aria-hidden=\"true\">{c}</span>").unwrap();
    }
    s.push_str("</span>");
    s
}

fn credit(art: &Option<(String, Option<String>, String)>) -> String {
    art.as_ref()
        .map(|(_, artist, card)| format!("{}. Art by {}, © Wizards of the Coast.", e(card), e(artist.as_deref().unwrap_or("unknown"))))
        .unwrap_or_default()
}

/// The groups the deck page uses (packages/core/src/decklist.ts): the first matching type wins,
/// lands that are creatures read as lands, the front face decides.
fn group(c: &SharedCard) -> &'static str {
    match c.board {
        Board::Commander => return "Commander",
        Board::Side => return "Sideboard",
        Board::Main => {}
    }
    let t = c.type_line.as_deref().unwrap_or("").split(" // ").next().unwrap_or("");
    if t.contains("Land") {
        return "Lands";
    }
    for (g, word) in [
        ("Creatures", "Creature"),
        ("Planeswalkers", "Planeswalker"),
        ("Instants", "Instant"),
        ("Sorceries", "Sorcery"),
        ("Artifacts", "Artifact"),
        ("Enchantments", "Enchantment"),
        ("Battles", "Battle"),
    ] {
        if t.contains(word) {
            return g;
        }
    }
    "Other"
}
const GROUP_ORDER: [&str; 11] =
    ["Commander", "Creatures", "Planeswalkers", "Instants", "Sorceries", "Artifacts", "Enchantments", "Battles", "Lands", "Other", "Sideboard"];

fn scryfall(name: &str) -> String {
    let mut u = url::Url::parse("https://scryfall.com/search").expect("constant URL");
    u.query_pairs_mut().append_pair("q", &format!("!\"{}\"", name.replace('"', "")));
    u.into()
}

fn by(sharer: &Sharer) -> String {
    match &sharer.handle {
        Some(h) => format!("Shared by <a href=\"/u/{0}\">@{0}</a>", e(h)),
        None => "Shared on Yama".into(),
    }
}

pub(super) async fn deck(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(token): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let d = match shared_deck(&st.pool, &token).await {
        Ok(d) => d,
        Err(AppError::NotFound(_)) => return Ok(not_found(&st, "Deck")),
        Err(err) => return Err(err),
    };
    let size: i64 = d.cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();
    let mut body = String::new();
    if let Some(h) = &d.sharer.handle {
        write!(body, "<a class=\"back-link\" href=\"/u/{0}\">← @{0}'s decks</a>", e(h)).unwrap();
    }
    body.push_str("<section class=\"public-art\">");
    if let Some((url, _, _)) = &d.art {
        write!(body, "<img src=\"{}\" alt=\"\" fetchpriority=\"high\"><div class=\"art-wash\"></div>", e(url)).unwrap();
    }
    write!(
        body,
        "<div class=\"art-heading\"><p class=\"eyebrow\">{}</p><h1>{}</h1><p>{}</p><div class=\"deck-meta\">{}<span>{size} cards</span>{}<span>Updated {}</span></div></div><p class=\"art-credit\">{}</p></section>",
        by(&d.sharer),
        e(&d.name),
        e(&if d.commanders.is_empty() { "No commander set".to_string() } else { d.commanders.join(" and ") }),
        pips(&d.color_identity),
        d.bracket.map(|b| format!("<span>Bracket {b}, as its owner declares it</span>")).unwrap_or_default(),
        when(&d.updated_at),
        credit(&d.art),
    )
    .unwrap();
    if d.configurations.len() > 1 {
        body.push_str("<nav class=\"share-configs\" aria-label=\"Configurations of this deck\"><span class=\"dim\">Configurations</span><ul>");
        for c in &d.configurations {
            if c.current {
                write!(body, "<li><a aria-current=\"page\" href=\"/d/{}\">{}</a></li>", e(&c.token), e(&c.label)).unwrap();
            } else {
                write!(body, "<li><a href=\"/d/{}\">{}</a></li>", e(&c.token), e(&c.label)).unwrap();
            }
        }
        body.push_str("</ul></nav>");
    }
    body.push_str("<div class=\"public-actions\">");
    for (i, (format, label)) in FORMATS.iter().enumerate() {
        write!(
            body,
            "<a class=\"button{}\" href=\"/d/{}/{format}.txt\" download>{}</a>",
            if i == 1 { " primary" } else { "" },
            e(&d.token),
            if *format == "names" { "Download names only".to_string() } else { format!("Download for {label}") }
        )
        .unwrap();
    }
    write!(body, "<a class=\"text-action\" href=\"/decks/import?shared={}\">Save a copy in Yama ↗</a></div>", e(&d.token)).unwrap();

    write!(body, "<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">{size} cards</p><h2>Decklist</h2></div></div><p class=\"dim\">Images and card details from Scryfall.</p>").unwrap();
    for g in GROUP_ORDER {
        let mut cards: Vec<&SharedCard> = d.cards.iter().filter(|c| group(c) == g).collect();
        if cards.is_empty() {
            continue;
        }
        cards.sort_by(|a, b| a.cmc.total_cmp(&b.cmc).then_with(|| a.name.cmp(&b.name)));
        write!(body, "<h3>{g} <span class=\"dim\">{}</span></h3><ul class=\"public-card-list\">", cards.iter().map(|c| c.qty).sum::<i64>()).unwrap();
        for c in cards {
            let image = c
                .image
                .as_ref()
                .map(|u| format!("<img src=\"{}\" alt=\"{}\" loading=\"lazy\" width=\"48\" height=\"67\">", e(u), e(&c.name)))
                .unwrap_or_default();
            let printing = c
                .printing
                .as_ref()
                .map(|p| {
                    let finish = match p.finish.as_str() {
                        "foil" => ", foil",
                        "etched" => ", etched",
                        _ => "",
                    };
                    format!("{} {}{finish}", p.set_code.to_uppercase(), p.collector_number)
                })
                .unwrap_or_default();
            let small = match (c.type_line.as_deref(), printing.is_empty()) {
                (Some(t), false) => format!("{}. {}", e(t), e(&printing)),
                (Some(t), true) => e(t),
                (None, false) => e(&printing),
                (None, true) => "Card details on Scryfall".into(),
            };
            write!(
                body,
                "<li><a class=\"public-card-ref\" data-card-name=\"{}\" data-card-image=\"{}\" href=\"{}\">{image}<span><span class=\"card-qty\">{}</span> {}<small>{small}</small></span></a></li>",
                e(&c.name),
                e(c.image.as_deref().unwrap_or("")),
                e(&scryfall(&c.name)),
                c.qty,
                e(&c.name),
            )
            .unwrap();
        }
        body.push_str("</ul>");
    }
    write!(
        body,
        "<details><summary>Select the list to copy</summary><textarea readonly rows=\"14\" aria-label=\"Decklist, Moxfield format\">{}</textarea></details></section>",
        e(&export(&d.cards, "moxfield"))
    )
    .unwrap();
    let description = format!("{}{}, a Commander deck shared on Yama.", d.name, if d.commanders.is_empty() { String::new() } else { format!(" ({})", d.commanders.join(" and ")) });
    Ok(response(&headers, page(&st, &format!("/d/{token}"), &d.name, &description, d.art.as_ref().map(|a| a.0.as_str()), &body)))
}

pub(super) async fn profile(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let sharer = match sharer_by_handle(&st.pool, &handle).await {
        Ok(s) => s,
        Err(AppError::NotFound(_)) => return Ok(not_found(&st, "Profile")),
        Err(err) => return Err(err),
    };
    let h = sharer.handle.clone().unwrap_or_default();
    let decks = profile_decks(&st.pool, &sharer.id).await?;
    let mut body = format!(
        "<section class=\"share-profile-head\"><p class=\"eyebrow\">Commander decks on Yama</p><h1>@{}</h1><p class=\"dim\">{}</p></section>",
        e(&h),
        match decks.len() {
            0 => "No public decks yet.".to_string(),
            1 => "1 public deck.".to_string(),
            n => format!("{n} public decks."),
        }
    );
    if sharer.collection_public {
        write!(body, "<div class=\"public-actions\"><a class=\"button\" href=\"/u/{}/collection\">Browse @{}'s collection</a></div>", e(&h), e(&h)).unwrap();
    }
    if !decks.is_empty() {
        body.push_str("<ul class=\"share-decks\">");
        for d in &decks {
            body.push_str("<li class=\"share-deck\">");
            write!(body, "<a class=\"share-deck-main\" href=\"/d/{}\">", e(&d.token)).unwrap();
            if let Some((url, _, _)) = &d.art {
                write!(body, "<img src=\"{}\" alt=\"\" loading=\"lazy\"><div class=\"art-wash\"></div>", e(url)).unwrap();
            }
            write!(
                body,
                "<span class=\"share-deck-copy\">{}<b>{}</b><span>{}</span><small>{} cards</small></span></a>",
                pips(&d.color_identity),
                e(&d.name),
                e(&if d.commanders.is_empty() { "No commander set".to_string() } else { d.commanders.join(" and ") }),
                d.card_count
            )
            .unwrap();
            if !d.configurations.is_empty() {
                body.push_str("<details class=\"share-deck-configs\"><summary>");
                write!(body, "{} more {}", d.configurations.len(), if d.configurations.len() == 1 { "configuration" } else { "configurations" }).unwrap();
                body.push_str("</summary><ul>");
                for (token, label) in &d.configurations {
                    write!(body, "<li><a href=\"/d/{}\">{}</a></li>", e(token), e(label)).unwrap();
                }
                body.push_str("</ul></details>");
            }
            body.push_str("</li>");
        }
        body.push_str("</ul>");
        let credits: Vec<String> = decks.iter().filter(|d| d.art.is_some()).map(|d| credit(&d.art)).collect();
        if !credits.is_empty() {
            write!(body, "<p class=\"art-credits dim\">{}</p>", credits.join(" ")).unwrap();
        }
    }
    let description = format!("@{h}'s Commander decks on Yama.");
    let image = decks.iter().find_map(|d| d.art.as_ref().map(|a| a.0.clone()));
    Ok(response(&headers, page(&st, &format!("/u/{h}"), &format!("@{h}"), &description, image.as_deref(), &body)))
}

#[derive(Deserialize, Default)]
pub(super) struct CollectionQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    page: usize,
}

const PAGE: usize = 200;

pub(super) async fn collection(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(handle): Path<String>,
    Query(query): Query<CollectionQuery>,
) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = match shared_collection(&st.pool, &handle).await {
        Ok(x) => x,
        Err(AppError::NotFound(_)) => return Ok(not_found(&st, "Collection")),
        Err(err) => return Err(err),
    };
    let h = sharer.handle.clone().unwrap_or_default();
    let needle = query.q.trim().to_lowercase();
    let hits: Vec<&CollectionLine> = lines.iter().filter(|l| needle.is_empty() || l.name.to_lowercase().contains(&needle)).collect();
    let copies: i64 = lines.iter().map(|l| l.qty).sum();
    let pages = hits.len().div_ceil(PAGE).max(1);
    let at = query.page.min(pages - 1);
    let mut body = format!(
        "<a class=\"back-link\" href=\"/u/{0}\">← @{0}</a><section class=\"share-profile-head\"><p class=\"eyebrow\">Collection</p><h1>@{0}'s cards</h1><p class=\"dim\">{1} copies. Real cards only; proxies aren't listed.</p></section><div class=\"public-actions\"><a class=\"button primary\" href=\"/u/{0}/collection.txt\" download>Download as a list</a><a class=\"button\" href=\"/u/{0}/collection.csv\" download>Download CSV</a></div>",
        e(&h),
        copies
    );
    write!(
        body,
        "<form class=\"public-filters\" method=\"get\" action=\"/u/{}/collection\" aria-label=\"Search the collection\"><label class=\"search\"><span class=\"sr-only\">Search</span><input type=\"search\" name=\"q\" value=\"{}\" maxlength=\"200\" placeholder=\"Search card names\"></label><button type=\"submit\" class=\"primary\">Search</button></form>",
        e(&h),
        e(&query.q)
    )
    .unwrap();
    if hits.is_empty() {
        body.push_str("<p class=\"dim\">No cards match.</p>");
    } else {
        body.push_str("<table class=\"share-collection\"><thead><tr><th scope=\"col\">Card</th><th scope=\"col\">Printing</th><th scope=\"col\">Finish</th><th scope=\"col\">Condition</th><th scope=\"col\" class=\"num\">Copies</th></tr></thead><tbody>");
        for l in hits.iter().skip(at * PAGE).take(PAGE) {
            let finish = match l.finish.as_str() {
                "foil" => "Foil",
                "etched" => "Etched",
                _ => "Nonfoil",
            };
            let lang = if l.lang == "en" { String::new() } else { format!(", {}", e(&l.lang)) };
            write!(
                body,
                "<tr><td><a class=\"public-card-ref\" data-card-name=\"{0}\" data-card-image=\"{1}\" href=\"{2}\">{0}</a></td><td>{3} {4}<small class=\"dim\"> {5}</small></td><td>{finish}{lang}</td><td>{6}</td><td class=\"num\">{7}</td></tr>",
                e(&l.name),
                e(l.image.as_deref().filter(|u| u.starts_with("https://cards.scryfall.io/")).unwrap_or("")),
                e(&scryfall(&l.name)),
                e(&l.set_code.to_uppercase()),
                e(&l.collector_number),
                e(l.set_name.as_deref().unwrap_or("")),
                e(&l.condition),
                l.qty
            )
            .unwrap();
        }
        body.push_str("</tbody></table>");
        if pages > 1 {
            let link = |p: usize| {
                let mut u = format!("/u/{}/collection?page={p}", e(&h));
                if !query.q.is_empty() {
                    let enc: String = url::form_urlencoded::byte_serialize(query.q.as_bytes()).collect();
                    u.push_str(&format!("&amp;q={enc}"));
                }
                u
            };
            body.push_str("<nav class=\"pager\" aria-label=\"Pages\">");
            if at > 0 {
                write!(body, "<a href=\"{}\">Previous</a>", link(at - 1)).unwrap();
            }
            write!(body, "<span>Page {} of {pages}</span>", at + 1).unwrap();
            if at + 1 < pages {
                write!(body, "<a href=\"{}\">Next</a>", link(at + 1)).unwrap();
            }
            body.push_str("</nav>");
        }
    }
    let description = format!("@{h}'s Magic collection on Yama.");
    Ok(response(&headers, page(&st, &format!("/u/{h}/collection"), &format!("@{h}'s collection"), &description, None, &body)))
}
