//! Pieces shared by the public pages (precons, shared decks, profiles, collections): escaping and
//! formatting, the security headers, color identity, a card's list line and stacked image, and the
//! deck sections that mirror the app's deck page (legality, bracket, simulated results, stats and
//! market value). Rendered on the server; the pages load no part of the private application.

use crate::deck_checks::{CheckResult, Combo};
use crate::deck_prices::SinglesValue;
use crate::deck_stats::DeckStats;
use crate::decks::Validation;
use crate::lab::RunListItem;
use crate::analysis::DeckAnalysis;
use axum::http::{HeaderValue, header};
use axum::response::Response;
use std::fmt::Write;

pub(crate) fn e(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub(crate) fn pct(n: Option<f64>) -> String {
    n.map(|n| format!("{:.1}%", n * 100.)).unwrap_or_else(|| "—".into())
}

/// "$1,653.09": dollars and cents with a comma at the thousands, as the app writes them.
pub(crate) fn usd(n: Option<f64>) -> String {
    n.map(|n| {
        let s = format!("{n:.2}");
        let (whole, cents) = s.split_once('.').unwrap_or((s.as_str(), "00"));
        let (sign, digits) = whole.strip_prefix('-').map_or(("", whole), |d| ("-", d));
        match digits.parse::<i64>() {
            Ok(d) => format!("{sign}${}.{cents}", count(d)),
            // Not a number: say what it is, as before.
            Err(_) => format!("${s}"),
        }
    })
    .unwrap_or_else(|| "No price".into())
}

/// "Oct 28, 2026" from a date or a timestamp, the date style the app uses.
pub(crate) fn when(s: &str) -> String {
    s.get(..10)
        .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .map(|d| d.format("%b %-d, %Y").to_string())
        .unwrap_or_else(|| "Date unavailable".into())
}

/// "12,345".
pub(crate) fn count(n: i64) -> String {
    let s = n.to_string();
    s.chars()
        .enumerate()
        .map(|(i, c)| if i > 0 && (s.len() - i).is_multiple_of(3) { format!(",{c}") } else { c.to_string() })
        .collect()
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Same geometry as components/Wordmark.tsx and design/logo/yama-wordmark.svg.
pub(crate) const WORDMARK: &str = r#"<svg viewBox="0 -8 280 110" aria-hidden="true"><g fill="currentColor"><path d="M0 0H20L32 30L44 0H64L42 56V100H22V56Z"/><path d="M60 100L92 -6L124 100H104L92 60L80 100Z"/><path d="M134 100V0H152L170 44L188 0H206V100H186V40L170 79L154 40V100Z"/><path d="M216 100L248 -6L280 100H260L248 60L236 100Z"/></g></svg>"#;

/// A tab's icon: the same drawing as web/src/components/icons.tsx (a test there holds the paths
/// to these). It shows in the phone's bottom bar; a laptop's header has the words alone.
macro_rules! icon {
    ($paths:literal) => {
        concat!(
            r#"<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
            $paths,
            "</svg>"
        )
    };
}

/// The five tabs of Yama's frame, the same names and places as the app's (web/src/nav.tsx,
/// MAIN_TABS; web/src/nav.test.tsx reads this table). Each is the app's page: a visitor who isn't
/// signed in is asked to where the page needs an account.
pub(crate) const SITE_TABS: [(&str, &str, &str); 5] = [
    ("/play/table", "Play", icon!(r#"<rect x="3" y="6" width="8" height="12" rx="1.5" transform="rotate(-8 7 12)"/><rect x="13" y="6" width="8" height="12" rx="1.5" transform="rotate(8 17 12)"/>"#)),
    ("/decks", "Decks", icon!(r#"<rect x="6" y="3" width="12" height="16" rx="1.5"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>"#)),
    ("/cards", "Cards", icon!(r#"<rect x="5.5" y="3" width="13" height="18" rx="1.5"/><path d="M9 7h6M9 13.5h6v3.5H9z"/>"#)),
    ("/collection", "Collection", icon!(r#"<rect x="4" y="5" width="10" height="14" rx="1.5"/><path d="M17 7v12M20 9v8"/>"#)),
    ("/group", "Playgroup", icon!(r#"<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>"#)),
];

/// Search, in the phone's top bar (the Cards tab on a laptop).
const SEARCH_ICON: &str = icon!(r#"<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>"#);

/// The Decks tab's pages, as the app lists them for someone not signed in (nav.tsx): the strip
/// under the header of every public page that belongs to Decks.
pub(crate) const DECKS_PAGES: [(&str, &str); 5] =
    [("/decks", "My decks"), ("/decks/browse", "Browse"), ("/precons", "Precons"), ("/commanders", "Commanders"), ("/check", "Check a deck")];

/// The public pages that belong to the Decks tab: the precon and commander reference and a
/// shared deck. A profile, a shared plan and the text pages belong to no tab.
const DECKS_PUBLIC: [&str; 3] = ["/precons", "/commanders", "/d"];

/// The footer's links, the same on every public page.
pub(crate) const SITE_FOOT: [(&str, &str); 6] = [
    ("/about/", "About"),
    ("/docs/mcp/", "Connect an assistant"),
    ("/precons/methodology", "How we rank"),
    ("/about/#contact", "Help and contact"),
    ("/privacy/", "Privacy"),
    ("/tos/", "Terms"),
];

/// How the page at `path` relates to the place `href`, as an `aria-current` attribute:
/// "page" for the place itself, "true" for a page under it (`/precons/veloci-ramp-tor` under
/// `/precons`), nothing otherwise.
fn in_place(path: &str, href: &str) -> &'static str {
    let place = href.trim_end_matches('/');
    let path = path.trim_end_matches('/');
    if path == place {
        " aria-current=\"page\""
    } else if path.strip_prefix(place).is_some_and(|rest| rest.starts_with('/')) {
        " aria-current=\"true\""
    } else {
        ""
    }
}

/// Whether a public page belongs to the Decks tab.
fn in_decks(path: &str) -> bool {
    DECKS_PUBLIC.iter().any(|place| !in_place(path, place).is_empty())
}

/// The header of every public page (styled by web/public/site-frame-v1.css): Yama's frame, as
/// the app draws it. The wordmark goes home; the five tabs are a row of words on a laptop and
/// the bottom bar on a phone; then search (phones) and You, which opens the account's own page.
/// A page that belongs to the Decks tab lights it and gets the strip of the tab's pages under
/// the header. The static pages under web/public carry this exact markup; a test below holds
/// them to it.
pub(crate) fn site_header(path: &str) -> String {
    let decks = in_decks(path);
    let mut s = format!("<a class=\"site-frame-skip\" href=\"#content\">Skip to content</a><header class=\"site-frame-header\"><a class=\"site-frame-wordmark\" href=\"/\" aria-label=\"Yama home\">{WORDMARK}</a><nav aria-label=\"Yama\">");
    for (href, label, icon) in SITE_TABS {
        let current = if decks && href == "/decks" { " aria-current=\"true\"" } else { "" };
        write!(s, "<a href=\"{href}\"{current}>{icon}<span>{label}</span></a>").unwrap();
    }
    write!(s, "</nav><a class=\"site-frame-search\" href=\"/cards\" aria-label=\"Search cards\">{SEARCH_ICON}</a><a class=\"site-frame-open\" href=\"/profile\">You</a></header>").unwrap();
    if decks {
        s.push_str("<nav class=\"site-frame-sections\" aria-label=\"Decks pages\">");
        for (href, label) in DECKS_PAGES {
            write!(s, "<a href=\"{href}\"{}>{label}</a>", in_place(path, href)).unwrap();
        }
        s.push_str("</nav>");
    }
    s
}

/// The footer of every public page: the same links, then the rights and sources notice.
pub(crate) fn site_footer(path: &str) -> String {
    let mut s = String::from("<footer class=\"site-frame-footer\"><nav aria-label=\"About Yama\">");
    for (href, label) in SITE_FOOT {
        let current = if path == href { " aria-current=\"page\"" } else { "" };
        write!(s, "<a href=\"{href}\"{current}>{label}</a>").unwrap();
    }
    write!(s, "</nav>{}</footer>", crate::public_precons::NOTICE.trim()).unwrap();
    s
}

/// The public pages' Content-Security-Policy and referrer policy: no inline script or style,
/// images only from Yama and Scryfall, and fetches (public-list-v1.js's live filters) only to Yama.
pub(crate) fn secure(res: &mut Response) {
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cards.scryfall.io; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
    );
    res.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
}

/// Color identity as pips, WUBRG order; colorless when empty.
pub(crate) fn identity(letters: &str) -> String {
    let letters = if letters.is_empty() { "C" } else { letters };
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

/// A card's line in a public list: thumbnail, quantity, name and a small line under it. The
/// preview script shows the card image on hover.
pub(crate) fn card_item(name: &str, image: Option<&str>, href: &str, qty: i64, small: &str) -> String {
    let img = image
        .map(|u| format!("<img src=\"{}\" alt=\"{}\" loading=\"lazy\" width=\"48\" height=\"67\">", e(u), e(name)))
        .unwrap_or_default();
    format!(
        "<li><a class=\"public-card-ref\" data-card-name=\"{0}\" data-card-image=\"{1}\" href=\"{2}\">{img}<span><span class=\"card-qty\">{qty}</span> {0}<small>{small}</small></span></a></li>",
        e(name),
        e(image.unwrap_or("")),
        e(href),
    )
}

/// A card in a stack: the full card image, overlapping the one above so its name shows.
pub(crate) fn stack_card(name: &str, image: Option<&str>, href: &str, qty: i64) -> String {
    let label = if qty > 1 { format!("{qty} {name}") } else { name.to_string() };
    let face = match image {
        Some(u) => format!("<img src=\"{}\" alt=\"{}\" loading=\"lazy\" width=\"488\" height=\"680\">", e(u), e(&label)),
        None => format!("<span class=\"stack-fallback\">{}</span>", e(&label)),
    };
    let badge = if qty > 1 { format!("<span class=\"qty-badge\" aria-hidden=\"true\">×{qty}</span>") } else { String::new() };
    format!(
        "<a class=\"public-stack-card public-card-ref\" data-card-name=\"{}\" data-card-image=\"{}\" href=\"{}\">{face}{badge}</a>",
        e(name),
        e(image.unwrap_or("")),
        e(href)
    )
}

// ── deck sections, mirroring the app's deck page ────────────────────────────

/// "Commander-legal", or what stands in the way, by the checks in our card data.
pub(crate) fn legality(v: &Validation) -> String {
    let mut s = if v.ok {
        "<span class=\"pill good\">Commander-legal</span>".to_string()
    } else {
        "<span class=\"pill bad\">Not legal yet</span>".to_string()
    };
    if !v.errors.is_empty() || !v.warnings.is_empty() || !v.prerelease.is_empty() {
        s.push_str("<ul class=\"public-deck-errors\">");
        for x in v.errors.iter().chain(&v.warnings).chain(&v.prerelease) {
            write!(s, "<li>{}</li>", e(x)).unwrap();
        }
        s.push_str("</ul>");
    }
    s
}

/// The Commander brackets, as Wizards names them (components/Bracket.tsx).
pub(crate) fn bracket_name(n: i64) -> &'static str {
    match n {
        1 => "Exhibition",
        2 => "Core",
        3 => "Upgraded",
        4 => "Optimized",
        5 => "cEDH",
        _ => "",
    }
}

/// Yama's starting suggestion from a Spellbook tag (components/deckCheck.ts, estimateValue and
/// estimateExplanation; keep them in step): the value, the line under it, and why.
pub(crate) fn suggestion(r: &CheckResult) -> (String, String, &'static str) {
    let checked = ["C", "O", "P", "S", "R"].contains(&r.bracket_tag.as_str());
    match (r.bracket_tag.as_str(), r.bracket) {
        ("E", _) => (
            "2".into(),
            "Core starting point, confirm speed and intent".into(),
            "Start with Core (2): the card-list check found no signals that suggest a higher bracket among the cards it recognized. This doesn't prove the deck's power or speed. Exhibition (1) is for decks deliberately built around theme over power, so Yama never assigns it automatically. A highly tuned deck may still belong above Core without any Game Changers.",
        ),
        (_, Some(b)) if checked && (2..=4).contains(&b) => (
            b.to_string(),
            format!("From Commander Spellbook's \"{}\" signals", r.bracket_label),
            "This starting suggestion uses the Game Changers, mass land denial, extra turns and known combos found by Commander Spellbook. Confirm how early and consistently the deck can win before choosing a bracket. Yama never assigns Exhibition (1) or cEDH (5) automatically: those depend on how and why the deck was built.",
        ),
        ("B", _) => (
            "Banned".into(),
            "A card is banned in Commander".into(),
            "The card-list check found a card banned in Commander. A bracket doesn't override card legality.",
        ),
        (tag, _) => (
            "Unknown".into(),
            format!("Commander Spellbook answered with a tag Yama doesn't know yet (\"{tag}\")"),
            "The card-list check returned a result Yama can't interpret yet, so there's no starting bracket from it.",
        ),
    }
}

/// The ordinary deck-building limits, not a complete assessment (deckCheck.ts, gameChangerFloor).
pub(crate) fn game_changer_floor(n: usize) -> String {
    match n {
        0 => "No Game Changers. That alone doesn't establish a bracket: speed, consistency and combos still matter.".into(),
        1..=3 => format!("{n} Game {}: within bracket 3's limit, but the deck may belong higher.", if n == 1 { "Changer" } else { "Changers" }),
        _ => format!("{n} Game Changers: above bracket 3's limit of three, so bracket 4 or 5 under the usual guidelines."),
    }
}

fn names(list: &[String]) -> String {
    if list.is_empty() { "none".into() } else { e(&list.join(", ")) }
}

const SPELLBOOK: &str = "https://commanderspellbook.com/";

fn combos(list: &[&Combo]) -> String {
    let mut s = "<ul class=\"public-combos\">".to_string();
    for c in list {
        let plus = if c.templates.is_empty() { String::new() } else { format!(", plus {}", e(&c.templates.join(", ").to_lowercase())) };
        let more = if c.results.len() > 4 { ", and more" } else { "" };
        write!(
            s,
            "<li><b>{}</b>{plus}<span>{}{more}</span><a href=\"{SPELLBOOK}combo/{}/\">How it works ↗</a></li>",
            e(&c.cards.join(", ")),
            e(&c.results.iter().take(4).cloned().collect::<Vec<_>>().join(", ")),
            url::form_urlencoded::byte_serialize(c.id.as_bytes()).collect::<String>(),
        )
        .unwrap();
    }
    s.push_str("</ul>");
    s
}

/// How many of the list's cards are on Wizards' Reserve List, and which (the deck page's
/// "Reserve List" line in `pages/Decks.tsx`). `None`: the flags aren't loaded yet.
pub(crate) fn reserved_panel(reserved: Option<&[String]>) -> String {
    let body = match reserved {
        None => "<p class=\"dim\">Reserve List flags aren't loaded on this server yet.</p>".to_string(),
        Some([]) => "<p>None of this deck's cards are on the Reserve List.</p>".to_string(),
        Some(r) => format!("<p><b>{}</b>: {}</p>", plural(r.len() as i64, "card", "cards"), e(&r.join(", "))),
    };
    format!(
        "<section class=\"public-panel public-reserved\" aria-labelledby=\"reserved-head\"><h2 id=\"reserved-head\">Reserve List</h2>{body}<p class=\"dim\">{}</p></section>",
        e(RESERVED_NOTE)
    )
}

/// What the Reserve List is, under every count of it.
pub(crate) const RESERVED_NOTE: &str = "Cards Wizards has promised never to reprint, from Scryfall's card data. Being on the list says a card is scarce, not that it's strong.";

/// Whose list a bracket panel is for: a person's deck, which its owner may have given a bracket,
/// or a stock precon, which nobody declares one for.
#[derive(Clone, Copy)]
pub(crate) enum Declared {
    Owner(Option<i64>),
    Stock,
}

/// The bracket the owner declares beside Yama's starting suggestion, the reason for it, and the
/// cards and combos behind it (components/Bracket.tsx, BracketPanel). `game_changers` is the
/// count from our own card data, for when there's no check result. `analysis` gives the power
/// level shown beside the brackets (analysis/mod.rs); its breakdown is [`analysis_panel`].
pub(crate) fn bracket_panel(declared: Declared, result: Option<&CheckResult>, game_changers: Option<&[String]>, analysis: Option<&DeckAnalysis>) -> String {
    let mut s = "<section class=\"public-panel public-bracket\" aria-labelledby=\"bracket-head\"><h2 id=\"bracket-head\">Bracket</h2><div class=\"bracket-pair\">".to_string();
    match declared {
        Declared::Owner(Some(b)) => write!(s, "<div><span class=\"label\">Declared by its owner</span><span class=\"result-value\">{b}</span><small>{}</small></div>", bracket_name(b)).unwrap(),
        Declared::Owner(None) => s.push_str("<div><span class=\"label\">Declared by its owner</span><span class=\"result-value dim\">Not declared</span></div>"),
        Declared::Stock => {}
    }
    match result {
        Some(r) => {
            let (value, sub, _) = suggestion(r);
            write!(s, "<div class=\"estimate\"><span class=\"label\">Yama's starting suggestion, checked {}</span><span class=\"result-value\">{}</span><small>{}</small></div>", when(&r.checked_at), e(&value), e(&sub)).unwrap();
        }
        None => s.push_str("<div class=\"estimate\"><span class=\"label\">Yama's starting suggestion</span><span class=\"result-value dim\">Not checked yet</span></div>"),
    }
    if let Some(a) = analysis {
        write!(s, "<div class=\"estimate\"><span class=\"label\">Power level</span><span class=\"result-value\">{:.1} <small>±{:.1}</small></span><small>{}, unofficial Yama estimate</small></div>", a.power, a.margin, e(a.label)).unwrap();
    }
    s.push_str("</div>");
    let Some(r) = result else {
        match game_changers {
            Some(gc) => write!(s, "<p class=\"dim\">From our card data: {}</p>", e(&game_changer_floor(gc.len()))).unwrap(),
            None => s.push_str("<p class=\"dim\">Game Changer flags aren't loaded on this server yet.</p>"),
        }
        s.push_str("</section>");
        return s;
    };
    let (_, _, why) = suggestion(r);
    write!(s, "<h3>Why this suggestion?</h3><p class=\"dim\">{}</p>", e(why)).unwrap();
    write!(
        s,
        "<ul class=\"public-flags\"><li><b>Game Changers: {}</b>{}<p class=\"dim\">{}</p></li><li><b>Mass land denial:</b> {}</li><li><b>Extra turns:</b> {}</li>",
        r.game_changers.len(),
        if r.game_changers.is_empty() { String::new() } else { format!(". {}", e(&r.game_changers.join(", "))) },
        e(&game_changer_floor(r.game_changers.len())),
        names(&r.mld),
        names(&r.extra_turns),
    )
    .unwrap();
    if !r.unrecognized.is_empty() {
        write!(s, "<li>Commander Spellbook didn't know {}, so the suggestion leaves them out: {}</li>", plural(r.unrecognized.len() as i64, "card", "cards"), e(&r.unrecognized.join(", "))).unwrap();
    }
    s.push_str("</ul>");
    let two: Vec<&Combo> = r.combos.iter().filter(|c| c.definitely_two_card).collect();
    let arguably: Vec<&Combo> = r.combos.iter().filter(|c| !c.definitely_two_card && c.arguably_two_card).collect();
    let longer: Vec<&Combo> = r.combos.iter().filter(|c| !c.definitely_two_card && !c.arguably_two_card).collect();
    write!(s, "<h3>Two-card combos: {}</h3>", two.len()).unwrap();
    s.push_str(&if two.is_empty() { "<p class=\"dim\">Commander Spellbook found none in this list.</p>".into() } else { combos(&two) });
    if !arguably.is_empty() {
        write!(s, "<h3>Arguably two-card: {}</h3><p class=\"dim\">Two cards, plus one more thing that has to be in place first.</p>{}", arguably.len(), combos(&arguably)).unwrap();
    }
    if !longer.is_empty() {
        write!(s, "<details><summary>Combos with more pieces: {}</summary>{}</details>", longer.len(), combos(&longer)).unwrap();
    }
    let closing = match declared {
        Declared::Owner(_) => "The declared bracket is what the owner tells the table, from the deck's speed, consistency and intended play experience. A suggestion never changes it.",
        Declared::Stock => "Wizards doesn't give its preconstructed decks a bracket: it says they have a range of power levels. Whoever plays the list tells the table its bracket.",
    };
    write!(s, "<p class=\"dim\">Card-list signals and combos from <a href=\"{SPELLBOOK}\">Commander Spellbook</a>. {closing}</p></section>").unwrap();
    s
}

/// How the commander has done over every list recorded under it (public_commanders::Record),
/// beside the deck's own analysis. It is the commander's record, not this list's. `also` is a
/// sentence a page adds when it shows other commander figures too; empty for none.
pub(crate) fn commander_panel(r: &crate::public_commanders::Record, also: &str) -> String {
    let place = match (r.place, r.typical) {
        (Some(n), typical) => format!(
            "#{} of {} {} with {} or more games.{}",
            count(n as i64),
            count(r.placed as i64),
            if r.placed == 1 { "commander" } else { "commanders" },
            r.min_games,
            typical.map(|t| format!(" The middle one wins {}.", pct(Some(t)))).unwrap_or_default()
        ),
        // /commanders leaves these out by default for the same reason.
        (None, _) => format!("Too few games to place it among commanders: that takes {} games. A rate from this few can be far off.", r.min_games),
    };
    format!(
        "<section class=\"public-panel public-commander-record\" aria-labelledby=\"commander-record-head\"><h2 id=\"commander-record-head\">Commander's record</h2><p class=\"analysis-power\"><span class=\"result-value\">{}</span> <span class=\"dim\">of {} recorded {} won, any list</span></p><p>{}: {}</p><p class=\"dim\">It counts every game recorded under {} on {}: stock and tuned lists, pods of any size. It says how the commander does, not how this list does, and 25% isn't the even share here.{} <a href=\"/commanders\">All commanders ↗</a></p></section>",
        pct(Some(r.win_rate)),
        count(i64::try_from(r.games).unwrap_or(i64::MAX)),
        if r.games == 1 { "game" } else { "games" },
        e(&r.name),
        e(&place),
        e(&r.name),
        e(&list_and(&r.sources)),
        if also.is_empty() { String::new() } else { format!(" {}", e(also)) },
    )
}

/// "A", "A and B", "A, B and C".
fn list_and(items: &[String]) -> String {
    match items {
        [] => "the public sources Yama reads".into(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The power level and its five vectors, the themes, and every card's points in a fold
/// (components/DeckAnalysis.tsx).
pub(crate) fn analysis_panel(a: &DeckAnalysis) -> String {
    let mut s = String::from("<section class=\"public-panel public-analysis\" aria-labelledby=\"analysis-head\"><h2 id=\"analysis-head\">Power level</h2>");
    write!(
        s,
        "<p class=\"analysis-power\"><span class=\"result-value\">{:.1}</span> <span class=\"dim\">±{:.1}, {}</span></p><p>Plays like {}. <b>{}</b>. {}</p>",
        a.power, a.margin, crate::analysis::inputs_note(a.confidence), a.bracket.plays(), e(a.label), e(a.description)
    )
    .unwrap();
    s.push_str("<ul class=\"analysis-vectors\">");
    for v in &a.vectors {
        write!(
            s,
            // An SVG bar: public pages allow no inline styles (Content-Security-Policy).
            "<li><span class=\"vector-label\">{}</span><svg class=\"vector-bar\" viewBox=\"0 0 100 8\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><rect class=\"track\" width=\"100\" height=\"8\"/><rect class=\"fill\" width=\"{:.0}\" height=\"8\"/></svg><span class=\"num\">{:.0}</span><small class=\"dim\">{}</small></li>",
            e(v.label),
            v.score.clamp(0.0, 100.0),
            v.score,
            e(v.band)
        )
        .unwrap();
    }
    s.push_str("</ul>");
    for c in &a.caps {
        write!(s, "<p class=\"dim\">{}</p>", e(c.note)).unwrap();
    }
    if !a.themes.is_empty() {
        s.push_str("<h3>Themes</h3><ul class=\"analysis-themes\">");
        for t in &a.themes {
            write!(s, "<li><b>{}</b> <span class=\"dim\">{} cards</span><small>{}</small></li>", e(&t.label), t.count, e(&t.description)).unwrap();
        }
        s.push_str("</ul>");
    }
    s.push_str("<details class=\"analysis-detail\"><summary>How it adds up</summary><p class=\"dim\">Each card earns points for what its text does, cheaper cards more. A vector adds its cards up and compares the total with Yama's reference lists: about 40 is a typical stock precon, 75 a typical Bracket 4 build. Commander Spellbook's combos add to Threats. This reads card text, not how the deck plays; other sites' numbers aren't directly comparable.</p>");
    for v in &a.vectors {
        write!(s, "<h3>{} {:.0}</h3>", e(v.label), v.score).unwrap();
        if v.groups.is_empty() {
            s.push_str("<p class=\"dim\">Nothing counted.</p>");
        }
        for g in &v.groups {
            let cards: Vec<String> = g
                .cards
                .iter()
                .map(|c| if c.copies > 1 { format!("{} {} {:.1}", c.copies, e(&c.name), c.points) } else { format!("{} {:.1}", e(&c.name), c.points) })
                .collect();
            write!(s, "<p><b>{}</b> <span class=\"dim\">{}</span><br><small class=\"names\">{}</small></p>", e(g.label), g.cards.len(), cards.join(", ")).unwrap();
        }
    }
    if !a.unknown_cards.is_empty() {
        write!(s, "<p class=\"dim\">Not in Yama's card data, so not counted: {}</p>", e(&a.unknown_cards.join(", "))).unwrap();
    }
    s.push_str("</details></section>");
    s
}

/// "Stock", "Now", "After prints" (web/src/lab/paired.ts, stateLabel).
pub(crate) fn state_label(state: &str) -> String {
    match state {
        "stock" => "Stock".into(),
        "now" => "Now".into(),
        "after" => "After prints".into(),
        other => {
            let words = other.replace('-', " ");
            let mut c = words.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

/// The plan's newest paired lab run: each list's raw simulated win rate with its interval, and
/// the paired differences. Only the lists in `shown` (plan states whose deck's cards are the
/// plan's list now) appear; with `matches`, the first is this page's list, "this list".
pub(crate) fn sim_panel(run: &RunListItem, key: &str, shown: &[String], matches: bool) -> String {
    let current = shown.first().map(String::as_str).filter(|_| matches);
    let Some(paired) = &run.paired else { return String::new() };
    let r = &run.run;
    let level = r.level.unwrap_or(0.9) * 100.;
    let mut s = format!(
        "<section class=\"public-panel public-sim\" aria-labelledby=\"sim-head\"><h2 id=\"sim-head\">Simulated games</h2><p class=\"dim\">AI against AI in a rules engine: {}, {} AI, analyzed {}. Raw win rates in {}-player pods, with {level:.0}% intervals; every list played the same pods.</p><div class=\"sim-rows\">",
        e(r.engine.as_deref().unwrap_or("an unrecorded engine")),
        e(&r.difficulty.as_deref().unwrap_or("unrecorded").to_lowercase()),
        when(r.analysed_at.as_deref().unwrap_or(&r.created_at)),
        r.pod.unwrap_or(4),
    );
    // The simulator's own warnings about a list (web/src/lab: ConfidenceNote), and the worse of
    // two lists' on a comparison: a known misjudgement never reads as a precise estimate.
    let caution = |id: &str| -> Option<(u8, String)> {
        let c = paired.variants.iter().find(|v| v.id == id)?.confidence.as_ref()?;
        let (rank, label) = match c.level {
            crate::lab::ConfidenceLevel::Ok => return None,
            crate::lab::ConfidenceLevel::Doubtful => (1, "Check limitations"),
            crate::lab::ConfidenceLevel::Unreliable => (2, "Engine caution"),
        };
        let why = if c.reasons.is_empty() { String::new() } else { format!(": {}", c.reasons.join("; ")) };
        Some((rank, format!("<span class=\"caution\">{label}{}</span>", e(&why))))
    };
    for v in &paired.variants {
        let Some(state) = crate::lab::variant_state(&v.id, key).filter(|s| shown.contains(s)) else { continue };
        let range = v.wilson.map(|[lo, hi]| format!("{:.0} to {:.0}%", lo * 100., hi * 100.)).unwrap_or_else(|| "no interval".into());
        let this = if current == Some(state.as_str()) { " aria-current=\"true\"" } else { "" };
        write!(
            s,
            "<div class=\"sim-row\"{this}><span class=\"label\">{}{}</span><span class=\"result-value\">{}</span><small>{} of {} games won, interval {range}</small>{}</div>",
            e(&state_label(&state)),
            if this.is_empty() { "" } else { ", this list" },
            pct(v.win_rate),
            v.wins,
            v.games,
            caution(&v.id).map(|c| c.1).unwrap_or_default(),
        )
        .unwrap();
    }
    s.push_str("</div>");
    let lines: Vec<String> = paired
        .comparisons
        .iter()
        .filter_map(|c| {
            let (b, v) = (crate::lab::variant_state(&c.base, key)?, crate::lab::variant_state(&c.variant, key)?);
            if !shown.contains(&b) || !shown.contains(&v) {
                return None;
            }
            let delta = c.delta_win_rate.map(|d| format!("{:+.0} points", d * 100.)).unwrap_or_else(|| "no difference measured".into());
            let ci = c.delta_ci.map(|[lo, hi]| format!(" ({:+.0} to {:+.0})", lo * 100., hi * 100.)).unwrap_or_default();
            let worst = [caution(&c.base), caution(&c.variant)].into_iter().flatten().max_by_key(|x| x.0).map(|x| format!(" {}", x.1)).unwrap_or_default();
            Some(format!("<li>{} to {}: {delta}{ci} over {}. {}{worst}</li>", e(&state_label(&b)), e(&state_label(&v)), plural(c.pods, "pod", "pods"), e(&c.verdict.text)))
        })
        .collect();
    if !lines.is_empty() {
        write!(s, "<h3>Paired differences</h3><ul class=\"public-flags\">{}</ul>", lines.concat()).unwrap();
    }
    if !matches {
        s.push_str("<p class=\"dim\">This deck's own cards differ from its plan list, so it has no result here; the lists shown are configurations whose cards match theirs.</p>");
    }
    write!(
        s,
        "<details><summary>Run details</summary><p class=\"dim\">Engine {}. Runner {}. Card data {}. {} games, analysed {}.</p></details>",
        e(r.engine.as_deref().unwrap_or("not recorded")),
        e(r.runner.as_deref().unwrap_or("not recorded")),
        e(r.card_data.as_deref().unwrap_or("not recorded")),
        count(r.games),
        when(r.analysed_at.as_deref().unwrap_or(&r.created_at)),
    )
    .unwrap();
    s.push_str("<p class=\"dim\">AI results for these plan lists on that date, not a real-table forecast.</p></section>");
    s
}

/// The list's market value: each card's cheapest eligible nonfoil paper printing.
pub(crate) fn singles_panel(v: &SinglesValue) -> String {
    let dates = match (&v.oldest_date, &v.newest_date) {
        (Some(a), Some(b)) if a != b => format!("{} to {}", when(a), when(b)),
        (_, Some(b)) => when(b),
        _ => "date unavailable".into(),
    };
    format!(
        "<section class=\"public-panel\" aria-labelledby=\"value-head\"><h2 id=\"value-head\">Market value</h2><span class=\"result-value\">{}</span><small>in singles{}. {}, {dates}</small><p class=\"dim\">Cheapest eligible nonfoil printings; commanders and basics included, sideboard excluded. Replacement market value, not a store quote or resale offer.</p></section>",
        usd(v.usd),
        if v.unpriced_copies > 0 { format!(" (partial: {} without a price)", plural(v.unpriced_copies, "copy", "copies")) } else { String::new() },
        e(v.source),
    )
}

const MANA: [(char, &str); 5] = [('W', "White"), ('U', "Blue"), ('B', "Black"), ('R', "Red"), ('G', "Green")];

/// Deck stats (components/DeckStats.tsx): lands, average mana value, creatures, the curve and
/// colored pips against land access.
pub(crate) fn stats_panel(st: &DeckStats) -> String {
    if st.cards == 0 {
        return String::new();
    }
    let mut s = format!(
        "<section class=\"public-panel public-stats\" aria-labelledby=\"stats-head\"><h2 id=\"stats-head\">Deck stats</h2><div class=\"dstat-row\"><div><span class=\"label\">Lands</span><span class=\"result-value\">{}</span><small>{}% of the deck</small></div><div><span class=\"label\">Average mana value</span><span class=\"result-value\">{}</span><small>Without lands{}</small></div><div><span class=\"label\">Creatures</span><span class=\"result-value\">{}</span><small>{} other spells</small></div></div>",
        st.lands,
        (st.lands as f64 / st.cards as f64 * 100.).round(),
        st.average_nonland_mana_value().map_or("—".into(), |v| format!("{v:.2}")),
        st.average_mana_value().map_or(String::new(), |v| format!(" ({v:.2} with lands)")),
        st.creatures,
        st.nonlands - st.creatures,
    );
    // The curve: one column per mana value, creatures at the base, other spells above.
    let (slot, bar, plot, top) = (45.0, 22.0, 110.0, 18.0);
    let max = st.curve.iter().map(|(c, o)| c + o).max().unwrap_or(0).max(1) as f64;
    let width = slot * 8.0;
    let base = top + plot;
    let label = |mv: usize| if mv == 7 { "7+".to_string() } else { mv.to_string() };
    let describe: Vec<String> = st
        .curve
        .iter()
        .enumerate()
        .map(|(mv, (c, o))| format!("{} mana: {}, {} and {} other", if mv == 7 { "7 or more".into() } else { mv.to_string() }, plural(c + o, "card", "cards"), plural(*c, "creature", "creatures"), plural(*o, "spell", "spells")))
        .collect();
    write!(
        s,
        "<div class=\"dstat-charts\"><div><h3>Mana curve</h3><ul class=\"curve-legend\" aria-hidden=\"true\"><li><span class=\"curve-swatch creatures\"></span>Creatures</li><li><span class=\"curve-swatch others\"></span>Other spells</li></ul><svg class=\"curve\" viewBox=\"0 0 {width} {}\" role=\"img\" aria-label=\"Mana curve. {}.\">",
        base + 22.0,
        e(&describe.join(". "))
    )
    .unwrap();
    for (mv, (c, o)) in st.curve.iter().enumerate() {
        let x = mv as f64 * slot + (slot - bar) / 2.0;
        let (hc, ho) = (*c as f64 / max * plot, *o as f64 / max * plot);
        let gap = if *c > 0 && *o > 0 { 2.0 } else { 0.0 };
        write!(s, "<g><title>{}</title>", e(&describe[mv])).unwrap();
        if *c > 0 {
            write!(s, "<rect class=\"creatures\" x=\"{x}\" y=\"{:.1}\" width=\"{bar}\" height=\"{hc:.1}\" rx=\"3\"/>", base - hc).unwrap();
        }
        if *o > 0 {
            write!(s, "<rect class=\"others\" x=\"{x}\" y=\"{:.1}\" width=\"{bar}\" height=\"{ho:.1}\" rx=\"3\"/>", base - hc - gap - ho).unwrap();
        }
        if c + o > 0 {
            write!(s, "<text class=\"cap\" x=\"{}\" y=\"{:.1}\" text-anchor=\"middle\">{}</text>", x + bar / 2.0, base - hc - ho - gap - 5.0, c + o).unwrap();
        }
        write!(s, "<text class=\"tick\" x=\"{}\" y=\"{}\" text-anchor=\"middle\">{}</text></g>", x + bar / 2.0, base + 16.0, label(mv)).unwrap();
    }
    write!(s, "<line class=\"baseline\" x1=\"0\" x2=\"{width}\" y1=\"{0}\" y2=\"{0}\"/></svg></div>", base + 0.5).unwrap();
    // Pips and land access, each column on its own scale.
    // Only colors the spells ask for, as packages/core does: a land's extra colors aren't a row.
    let colors: Vec<_> = MANA.iter().filter(|(c, _)| st.pips.get(c).is_some_and(|n| *n > 0)).collect();
    if !colors.is_empty() {
        let max_pips = colors.iter().map(|(c, _)| st.pips.get(c).copied().unwrap_or(0)).max().unwrap_or(0).max(1);
        let max_sources = colors.iter().map(|(c, _)| st.sources.as_ref().and_then(|x| x.get(c)).copied().unwrap_or(0)).max().unwrap_or(0).max(1);
        s.push_str("<div><h3>Mana colors</h3><table class=\"pip-table\"><thead><tr><th scope=\"col\">Color</th><th scope=\"col\">Pips</th><th scope=\"col\">Land access</th></tr></thead><tbody>");
        for (c, name) in colors {
            let pips = st.pips.get(c).copied().unwrap_or(0);
            let access = match &st.sources {
                Some(x) => {
                    let n = x.get(c).copied().unwrap_or(0);
                    format!("<span class=\"mana-count\">{n}</span><meter min=\"0\" max=\"{max_sources}\" value=\"{n}\" aria-hidden=\"true\"></meter>")
                }
                None => "<span class=\"dim\">Not counted</span>".into(),
            };
            write!(s, "<tr><th scope=\"row\"><span class=\"color color-{c}\" aria-hidden=\"true\">{c}</span> {name}</th><td><span class=\"mana-count\">{pips}</span><meter min=\"0\" max=\"{max_pips}\" value=\"{pips}\" aria-hidden=\"true\"></meter></td><td>{access}</td></tr>").unwrap();
        }
        s.push_str("</tbody></table><p class=\"dim\">Pips in spell costs and lands that can make each color, fetch lands with matching targets in this list included. Counts, not a verdict on how many sources to run.</p></div>");
    }
    s.push_str("</div>");
    if !st.unknown.is_empty() {
        write!(s, "<p class=\"dim\">Not in the card data, so left out: {}.</p>", e(&st.unknown.join(", "))).unwrap();
    }
    s.push_str("</section>");
    s
}

#[cfg(test)]
mod format_tests {
    use super::*;

    #[test]
    fn a_commanders_record_reads_as_the_commanders_not_the_lists() {
        let mut r = crate::public_commanders::Record {
            name: "Atraxa, Praetors' Voice".into(),
            win_rate: 0.4142,
            games: 12_480,
            sources: vec!["Playgroup.gg".into(), "Mythic Tools".into()],
            place: Some(12),
            placed: 1640,
            typical: Some(0.351),
            min_games: 100,
        };
        let html = commander_panel(&r, "");
        assert!(html.contains("<span class=\"result-value\">41.4%</span>"), "{html}");
        assert!(html.contains("of 12,480 recorded games won, any list"), "{html}");
        assert!(html.contains("Atraxa, Praetors&#39; Voice: #12 of 1,640 commanders with 100 or more games. The middle one wins 35.1%."), "{html}");
        assert!(html.contains("every game recorded under Atraxa, Praetors&#39; Voice on Playgroup.gg and Mythic Tools: stock and tuned lists"), "{html}");
        assert!(html.contains("not how this list does, and 25% isn't the even share here. <a href"), "{html}");
        assert!(!html.contains("far off"), "{html}");
        // Too few games: the rate still shows, without a place.
        r.place = None;
        r.games = 1;
        r.sources.truncate(1);
        let html = commander_panel(&r, "Another sentence.");
        assert!(html.contains("of 1 recorded game won"), "{html}");
        assert!(html.contains("Too few games to place it among commanders: that takes 100 games. A rate from this few can be far off."), "{html}");
        assert!(html.contains("on Playgroup.gg: stock"), "{html}");
        assert!(html.contains("even share here. Another sentence. <a href"), "{html}");
    }

    #[test]
    fn dollars_get_a_comma_at_the_thousands() {
        assert_eq!(usd(Some(1653.09)), "$1,653.09");
        assert_eq!(usd(Some(1000.0)), "$1,000.00");
        assert_eq!(usd(Some(1_234_567.5)), "$1,234,567.50");
        assert_eq!(usd(Some(999.99)), "$999.99");
        assert_eq!(usd(Some(0.59)), "$0.59");
        assert_eq!(usd(Some(0.0)), "$0.00");
        assert_eq!(usd(None), "No price");
    }

    #[test]
    fn counts_and_dates_read_as_the_app_writes_them() {
        assert_eq!(count(11364), "11,364");
        assert_eq!(count(999), "999");
        assert_eq!(when("2026-10-30"), "Oct 30, 2026");
        assert_eq!(when("2026-11-11T08:15:00Z"), "Nov 11, 2026");
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    /// Markup compared without whitespace, so a static page may wrap its lines.
    fn squash(s: &str) -> String {
        s.chars().filter(|c| !c.is_whitespace()).collect()
    }

    #[test]
    fn the_header_marks_the_tab_and_the_page_a_page_belongs_to() {
        let tab = |path: &str| site_header(path).contains("<a href=\"/decks\" aria-current=\"true\">");
        let strip = |path: &str| -> Vec<(&str, &str)> {
            let html = site_header(path);
            DECKS_PAGES
                .iter()
                .filter_map(|(href, _)| {
                    let at = html.find(&format!("<a href=\"{href}\" aria-current=\""))?;
                    Some((*href, if html[at..].starts_with(&format!("<a href=\"{href}\" aria-current=\"page\"")) { "page" } else { "true" }))
                })
                .filter(|(href, _)| *href != "/decks")
                .collect()
        };
        // The precon and commander reference and a shared deck are Decks pages: the tab is lit and
        // the strip of its pages is there, with the page's own entry marked.
        for path in ["/precons", "/precons/methodology", "/precons/veloci-ramp-tor", "/commanders", "/commanders/atraxa", "/d/abc"] {
            assert!(tab(path), "{path}: Decks isn't lit");
            assert!(site_header(path).contains("<nav class=\"site-frame-sections\" aria-label=\"Decks pages\">"), "{path}: no strip");
        }
        assert_eq!(strip("/precons"), [("/precons", "page")]);
        // Only the place itself is the current page; a page under it marks the place, so one
        // document never claims two current pages (the methodology page is in the footer too).
        assert_eq!(strip("/precons/methodology"), [("/precons", "true")]);
        assert_eq!(strip("/precons/veloci-ramp-tor"), [("/precons", "true")]);
        assert_eq!(strip("/commanders"), [("/commanders", "page")]);
        assert!(strip("/d/abc").is_empty());
        assert!(site_footer("/precons/methodology").contains("<a href=\"/precons/methodology\" aria-current=\"page\">How we rank</a>"));
        // A profile, a shared plan and the text pages belong to no tab: nothing lit, no strip.
        for path in ["/u/pat", "/u/pat/collection", "/r/abc", "/about/", "/privacy/", "/docs/mcp/", "/preconsx", "/decks-of-mine"] {
            let html = site_header(path);
            assert!(!html.contains("aria-current"), "{path}: something is marked current");
            assert!(!html.contains("site-frame-sections"), "{path}: a strip");
        }
        assert!(site_footer("/privacy/").contains("<a href=\"/privacy/\" aria-current=\"page\">Privacy</a>"));
        assert!(site_footer("/docs/mcp/").contains("<a href=\"/docs/mcp/\" aria-current=\"page\">Connect an assistant</a>"));
    }

    /// The frame's names and places: the app's five tabs, the wordmark going home, and You.
    #[test]
    fn the_header_is_the_apps_frame() {
        let html = site_header("/about/");
        let tabs: Vec<(&str, &str)> = SITE_TABS.iter().map(|(href, label, _)| (*href, *label)).collect();
        assert_eq!(tabs, [("/play/table", "Play"), ("/decks", "Decks"), ("/cards", "Cards"), ("/collection", "Collection"), ("/group", "Playgroup")]);
        let mut at = 0;
        for (href, label, icon) in SITE_TABS {
            let link = format!("<a href=\"{href}\">{icon}<span>{label}</span></a>");
            let found = html[at..].find(&link).unwrap_or_else(|| panic!("{label} is missing or out of order"));
            at += found + link.len();
            assert!(icon.starts_with("<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\""), "{label}: the icon would be read out");
        }
        assert!(html.contains("<a class=\"site-frame-wordmark\" href=\"/\" aria-label=\"Yama home\">"));
        assert!(html.contains("<a class=\"site-frame-search\" href=\"/cards\" aria-label=\"Search cards\">"));
        assert!(html.ends_with("<a class=\"site-frame-open\" href=\"/profile\">You</a></header>"));
        // The old header's places: precons and commanders are under Decks, the guide in the footer.
        for gone in ["Open Yama", "MCP guide", ">About<"] {
            assert!(!html.contains(gone), "{gone} is still in the header");
        }
        assert_eq!(DECKS_PAGES, [("/decks", "My decks"), ("/decks/browse", "Browse"), ("/precons", "Precons"), ("/commanders", "Commanders"), ("/check", "Check a deck")]);
    }

    /// One header and footer everywhere: each static page under web/public carries exactly what
    /// the server renders, and links the stylesheet that draws it.
    #[test]
    fn static_pages_carry_the_same_header_and_footer() {
        let pages = [
            ("/about/", include_str!("../../web/public/about/index.html")),
            ("/privacy/", include_str!("../../web/public/privacy/index.html")),
            ("/tos/", include_str!("../../web/public/tos/index.html")),
            ("/delete-account/", include_str!("../../web/public/delete-account/index.html")),
            ("/docs/mcp/", include_str!("../../web/public/docs/mcp/index.html")),
        ];
        for (path, html) in pages {
            let page = squash(html);
            assert!(page.contains(&squash(&site_header(path))), "{path}: the header differs from public_page::site_header");
            assert!(page.contains(&squash(&site_footer(path))), "{path}: the footer differs from public_page::site_footer");
            assert!(html.contains("<link rel=\"stylesheet\" href=\"/site-frame-v1.css\""), "{path}: no frame stylesheet");
            assert!(html.contains("id=\"content\""), "{path}: nothing for Skip to content to land on");
            assert_eq!(html.matches("<header class=\"site-frame-header\">").count(), 1, "{path}");
            assert_eq!(html.matches("<footer class=\"site-frame-footer\">").count(), 1, "{path}");
            assert!(html.contains("not affiliated with, endorsed by, or sponsored by Wizards of the Coast"), "{path}: the unofficial notice is gone");
        }
    }

    /// The server's own pages get the frame's styles inside their one stylesheet.
    #[test]
    fn the_compiled_stylesheet_includes_the_frame() {
        let css = &crate::public_precons::html::stylesheet().0;
        assert!(css.contains(".site-frame-header") && css.contains(".site-frame-footer") && css.contains(".site-frame-open"));
        assert!(css.contains(".site-frame-sections") && css.contains(".site-frame-search"), "the tabs' strip or the phone's search has no styles");
        assert!(!css.contains(".public-header") && !css.contains(".footer-top"), "the old frame's rules are still in precons.css");
    }
}

#[cfg(test)]
mod prerelease_tests {
    use super::*;

    #[test]
    fn legality_lists_prerelease_cards_on_a_legal_deck() {
        let v = Validation { ok: true, total: 100, prerelease: vec!["Spock is new in a set dated 2026-11-13".into()], ..Default::default() };
        let html = legality(&v);
        assert!(html.contains("Commander-legal"), "{html}");
        assert!(html.contains("<li>Spock is new in a set dated 2026-11-13</li>"), "{html}");
    }
}
