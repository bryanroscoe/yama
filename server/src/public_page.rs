//! Pieces shared by the public pages (precons, shared decks, profiles, collections): escaping and
//! formatting, the security headers, color identity, a card's list line and stacked image, and the
//! deck sections that mirror the app's deck page (legality, bracket, simulated results, stats and
//! market value). Rendered on the server; the pages load no part of the private application.

use crate::deck_checks::{CheckResult, Combo};
use crate::deck_prices::SinglesValue;
use crate::deck_stats::DeckStats;
use crate::decks::Validation;
use crate::lab::RunListItem;
use axum::http::{HeaderValue, header};
use axum::response::Response;
use std::fmt::Write;

pub(crate) fn e(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub(crate) fn pct(n: Option<f64>) -> String {
    n.map(|n| format!("{:.1}%", n * 100.)).unwrap_or_else(|| "—".into())
}

pub(crate) fn usd(n: Option<f64>) -> String {
    n.map(|n| format!("${n:.2}")).unwrap_or_else(|| "No price".into())
}

/// "28 Oct 2026" from a date or a timestamp.
pub(crate) fn when(s: &str) -> String {
    s.get(..10)
        .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .map(|d| d.format("%-d %b %Y").to_string())
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

/// The public pages' Content-Security-Policy and referrer policy: no inline script or style,
/// images only from Yama and Scryfall.
pub(crate) fn secure(res: &mut Response) {
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cards.scryfall.io; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
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
    if !v.errors.is_empty() || !v.warnings.is_empty() {
        s.push_str("<ul class=\"public-deck-errors\">");
        for x in v.errors.iter().chain(&v.warnings) {
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

/// The bracket the owner declares beside Yama's starting suggestion, the reason for it, and the
/// cards and combos behind it (components/Bracket.tsx, BracketPanel). `game_changers` is the
/// count from our own card data, for when there's no check result.
pub(crate) fn bracket_panel(declared: Option<i64>, result: Option<&CheckResult>, game_changers: Option<&[String]>) -> String {
    let mut s = "<section class=\"public-panel public-bracket\" aria-labelledby=\"bracket-head\"><h2 id=\"bracket-head\">Bracket</h2><div class=\"bracket-pair\">".to_string();
    match declared {
        Some(b) => write!(s, "<div><span class=\"label\">Declared by its owner</span><span class=\"result-value\">{b}</span><small>{}</small></div>", bracket_name(b)).unwrap(),
        None => s.push_str("<div><span class=\"label\">Declared by its owner</span><span class=\"result-value dim\">Not declared</span></div>"),
    }
    match result {
        Some(r) => {
            let (value, sub, _) = suggestion(r);
            write!(s, "<div class=\"estimate\"><span class=\"label\">Yama's starting suggestion, checked {}</span><span class=\"result-value\">{}</span><small>{}</small></div>", when(&r.checked_at), e(&value), e(&sub)).unwrap();
        }
        None => s.push_str("<div class=\"estimate\"><span class=\"label\">Yama's starting suggestion</span><span class=\"result-value dim\">Not checked yet</span></div>"),
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
    write!(s, "<p class=\"dim\">Card-list signals and combos from <a href=\"{SPELLBOOK}\">Commander Spellbook</a>. The declared bracket is what the owner tells the table, from the deck's speed, consistency and intended play experience. A suggestion never changes it.</p></section>").unwrap();
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
/// the paired differences. Only the lists in `shown` (plan states) appear; the first is the one
/// this page shows, called "this list" only when `matches` (its cards are the plan's list now).
pub(crate) fn sim_panel(run: &RunListItem, key: &str, shown: &[String], matches: bool) -> String {
    let current = shown.first().map(String::as_str).filter(|_| matches);
    let Some(paired) = &run.paired else { return String::new() };
    let r = &run.run;
    let level = r.level.unwrap_or(0.9) * 100.;
    let mut s = format!(
        "<section class=\"public-panel public-sim\" aria-labelledby=\"sim-head\"><h2 id=\"sim-head\">Simulated games</h2><p class=\"dim\">AI against AI in a rules engine: {}, {} AI, analysed {}. Raw win rates in {}-player pods, with {level:.0}% intervals; every list played the same pods.</p><div class=\"sim-rows\">",
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
        s.push_str("<p class=\"dim\">This deck's cards have changed since, or differ from its plan list, so these results describe the plan's lists as simulated, not necessarily this list.</p>");
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
    s.push_str("<p class=\"dim\">Lists from the owner's upgrade plan, as simulated on that date. A simulated rate is evidence about these AI pods, not a forecast for a real table; read differences with their intervals.</p></section>");
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
        "<section class=\"public-panel\" aria-labelledby=\"value-head\"><h2 id=\"value-head\">Market value</h2><span class=\"result-value\">{}</span><small>in singles{}. {}, {dates}</small><p class=\"dim\">Each card's cheapest eligible nonfoil paper printing, commander and basics included, sideboard excluded. Actual printings, finishes and condition change the value. A market reference isn't a store quote or a sale price.</p></section>",
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
    let colors: Vec<_> = MANA.iter().filter(|(c, _)| st.pips.contains_key(c) || st.sources.as_ref().is_some_and(|x| x.contains_key(c))).collect();
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
