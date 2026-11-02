//! The public commander ranking page, rendered on the server like the precon pages.
use super::*;
use crate::limits::ClientAddress;
use crate::public_page::{count, e, identity};
use crate::public_precons::html::{page, response};
use axum::extract::Query;
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;
use std::fmt::Write;

const PER_PAGE: usize = 50;
/// The default floor on combined games, so a handful of lucky games doesn't head the list.
const DEFAULT_MIN_GAMES: u64 = 100;
const MIN_GAMES: [(&str, &str); 6] = [
    ("0", "Any number of games"),
    ("20", "20 or more games"),
    ("100", "100 or more games"),
    ("500", "500 or more games"),
    ("1000", "1,000 or more games"),
    ("5000", "5,000 or more games"),
];

#[derive(Deserialize, Default)]
pub struct Filters {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub c: String,
    #[serde(default)]
    pub m: String,
    #[serde(default)]
    pub g: String,
    #[serde(default)]
    pub s: String,
    /// `s:` and a source's name to list only the commanders it covers, or `all` for those every
    /// source has. The prefix keeps a source called "all" apart from that option.
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub page: usize,
}

impl Filters {
    fn min_games(&self) -> u64 {
        self.g.parse().unwrap_or(DEFAULT_MIN_GAMES)
    }

    /// The commanders to list, in order, each with its rank by score among every commander with
    /// at least the chosen number of games. Colors, sources and a search narrow the list but keep
    /// those ranks.
    fn apply<'a>(&self, all: &'a [Commander], sources: &[Source]) -> AppResult<Vec<(usize, &'a Commander)>> {
        if self.q.len() > 200 || self.c.len() > 5 || self.m.len() > 20 || self.g.len() > 6 || self.s.len() > 20 || self.src.len() > 242 {
            return Err(AppError::bad("Commander filters are too long"));
        }
        let colors = self.c.to_ascii_uppercase();
        if !colors.chars().all(|c| "WUBRGC".contains(c)) || (colors.contains('C') && colors != "C") {
            return Err(AppError::bad("Use WUBRG or C for colors"));
        }
        if !self.g.is_empty() && !MIN_GAMES.iter().any(|(v, _)| *v == self.g) {
            return Err(AppError::bad("Choose one of the listed game counts"));
        }
        let named = self.src.strip_prefix("s:");
        if !(self.src.is_empty() || self.src == "all" || named.is_some_and(|n| sources.iter().any(|s| s.name == n))) {
            return Err(AppError::bad("Choose one of the listed sources"));
        }
        let q = self.q.trim().to_lowercase();
        let min = self.min_games();
        let mut rows: Vec<(usize, &Commander)> = all
            .iter()
            .filter(|c| c.games >= min)
            .enumerate()
            .map(|(i, c)| (i + 1, c))
            .filter(|(_, c)| match (self.src.as_str(), named) {
                ("", _) => true,
                ("all", _) => c.sources.len() == sources.len(),
                (_, Some(name)) => c.sources.iter().any(|f| f.source == name),
                _ => false,
            })
            .filter(|(_, c)| {
                let id = &c.color_identity;
                colors.is_empty()
                    || if colors == "C" {
                        id.is_empty()
                    } else {
                        match self.m.as_str() {
                            "exact" => id.chars().all(|c| colors.contains(c)) && colors.chars().all(|c| id.contains(c)),
                            "within" => id.chars().all(|c| colors.contains(c)),
                            _ => colors.chars().all(|c| id.contains(c)),
                        }
                    }
            })
            .filter(|(_, c)| q.is_empty() || c.name.to_lowercase().contains(&q))
            .collect();
        match self.s.as_str() {
            "sure" => rows.sort_by(|a, b| b.1.lo.total_cmp(&a.1.lo).then(a.0.cmp(&b.0))),
            "games" => rows.sort_by(|a, b| b.1.games.cmp(&a.1.games).then(a.0.cmp(&b.0))),
            "name" => rows.sort_by(|a, b| a.1.name.cmp(&b.1.name)),
            _ => {}
        }
        Ok(rows)
    }

    fn query(&self, page: usize) -> String {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in [("q", &self.q), ("c", &self.c), ("m", &self.m), ("g", &self.g), ("s", &self.s), ("src", &self.src)] {
            if !value.is_empty() {
                q.append_pair(key, value);
            }
        }
        q.append_pair("page", &page.to_string());
        format!("/commanders?{}", e(&q.finish()))
    }
}

fn selected(value: &str, actual: &str) -> &'static str {
    if value == actual { " selected" } else { "" }
}

/// The score's 95% interval on a 0–100 track, with the average commander (50) marked.
fn interval(c: &Commander) -> String {
    let x = |s: f64| s.clamp(0.0, 100.0) * 1.6;
    format!(
        "<svg class=\"interval\" viewBox=\"0 0 160 14\" role=\"img\" aria-label=\"95% interval {:.0} to {:.0}; 50 is the average commander\"><path class=\"interval-track\" d=\"M0 7H160\"/><path class=\"interval-baseline\" d=\"M80 0V14\"/><path class=\"interval-range\" d=\"M{:.2} 7H{:.2}\"/><circle cx=\"{:.2}\" cy=\"7\" r=\"3\"/></svg>",
        c.lo,
        c.hi,
        x(c.lo),
        x(c.hi),
        x(c.score)
    )
}

/// What one source says, in its own terms. `alone` adds the source's own score when another
/// source shares the commander, so the two can be compared.
fn figure(f: Option<&Figure>, alone: bool) -> String {
    let Some(f) = f else {
        return "<span class=\"dim\">Not covered</span>".into();
    };
    let mut out = match f.win_rate {
        Some(rate) => format!(
            "<span class=\"result-value\">{:.1}%</span><small>won, of {} games</small>",
            rate * 100.0,
            count(f.games as i64)
        ),
        None => format!(
            "<span class=\"result-value\">{:.0}</span><small>its score, from {} games</small>",
            f.score,
            count(f.games as i64)
        ),
    };
    if let Some(d) = f.decks {
        let noun = if f.win_rate.is_some() { "players" } else { "decks" };
        write!(out, "<small>{} {noun}</small>", count(d as i64)).unwrap();
    }
    if alone && f.win_rate.is_some() {
        write!(out, "<small>Scores {:.0} on its own</small>", f.score).unwrap();
    }
    out
}

/// How much the score rests on: the games behind it and which sources they come from.
fn evidence_cell(c: &Commander, sources: &[Source]) -> String {
    let from = if c.sources.len() > 1 && c.sources.len() == sources.len() {
        if sources.len() == 2 { "Both sources".to_string() } else { format!("All {} sources", sources.len()) }
    } else {
        format!("{} only", c.sources.iter().map(|f| e(&f.source)).collect::<Vec<_>>().join(" and "))
    };
    format!(
        "<span class=\"result-value\">{}</span><small>game records</small><small>{from}</small>",
        count(c.games as i64)
    )
}

fn precon_links(c: &Commander, ranks: &HashMap<String, usize>) -> String {
    if c.precons.is_empty() {
        return "<span class=\"dim\">None</span>".into();
    }
    c.precons
        .iter()
        .map(|p| {
            format!(
                "<a href=\"/precons/{}\">{}</a>{}",
                e(&p.id),
                e(&p.name),
                ranks.get(&p.id).map(|r| format!("<small>Precon rank #{r}</small>")).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn evidence_words(level: &str) -> &'static str {
    match level {
        "moderate" => "Moderate confidence",
        "low" => "Low confidence",
        _ => "Very low confidence",
    }
}

/// How far two sources' scores go together, in words that follow the figure.
pub(super) fn agreement_words(r: f64) -> &'static str {
    match r {
        r if r >= 0.7 => "agree closely",
        r if r >= 0.4 => "broadly agree",
        r if r >= 0.1 => "agree only loosely",
        r if r > -0.1 => "show no clear agreement",
        _ => "disagree",
    }
}

fn method(r: &Ranking) -> String {
    let mut out = String::from(
        "<p>Each source is compared with its own average commander, because the apps' players and pod sizes differ. A commander's wins and games become an estimate of how its odds of winning compare with that average, pulled toward average by 100 games' worth of prior so a short lucky run can't top the list. Game records count as half a game each (four seats and repeat players aren't independent), at most four per pilot and 2,000 in all.</p><p>Where both sources have a commander, their estimates are combined, each weighted by how much evidence it carries. The score puts the result on a 0–100 scale: 50 is the average commander, about 80 is double its odds of winning and about 20 half. The bar shows the 95% interval; the mark in the middle is 50.</p><p>A commander's games are the games it was played in; a four-player game counts once for each commander at the table, so the totals are game records rather than separate games. These are stock and upgraded decks, every power level and pod size, as players logged them. A score says how a commander has done in these apps, not how it will do at your table, and neighbouring ranks are often within each other's intervals.</p>",
    );
    if let Some(a) = &r.agreement {
        write!(
            out,
            "<p>On the {} commanders both {} and {} have, their separate scores {} (correlation {:.2}).</p>",
            count(a.commanders as i64),
            e(&a.a),
            e(&a.b),
            agreement_words(a.correlation),
            a.correlation
        )
        .unwrap();
    }
    if r.sources.len() > 1 {
        for s in &r.sources {
            if s.commanders < r.commanders.len() {
                write!(
                    out,
                    "<p>{} covers {} of the {} commanders; the others are scored from the remaining sources alone and show “Not covered” in its column.</p>",
                    e(&s.name),
                    count(s.commanders as i64),
                    count(r.commanders.len() as i64)
                )
                .unwrap();
            }
        }
    }
    out.push_str("<h3>Sources</h3><ul>");
    for s in &r.sources {
        let name = match &s.url {
            Some(u) => format!("<a href=\"{}\" rel=\"noopener\">{}</a>", e(u), e(&s.name)),
            None => e(&s.name),
        };
        write!(
            out,
            "<li>{name}: {} commanders, {} game records{}. {}. Licence: {}.</li>",
            count(s.commanders as i64),
            count(s.games as i64),
            s.baseline.map(|b| format!("; the average commander wins {:.1}%", b * 100.0)).unwrap_or_default(),
            e(&s.attribution),
            e(&s.license)
        )
        .unwrap();
    }
    write!(out, "</ul><p>Figures derived {} UTC. Yama is not affiliated with these sources.</p>", e(&r.as_of.format("%-d %b %Y %H:%M").to_string())).unwrap();
    out
}

pub(super) async fn index(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Query(filters): Query<Filters>,
) -> AppResult<Response> {
    crate::public_precons::limit(&st, address)?;
    let r = ranking(&st.pool).await?;
    let (ranks, _) = crate::public_precons::v2::ranks(&st.pool).await;
    let rows = filters.apply(&r.commanders, &r.sources)?;
    let games: u64 = r.sources.iter().map(|s| s.games).sum();
    let mut body = format!(
        "<section class=\"public-hero\"><div class=\"hero-copy\"><p class=\"eyebrow\">Commanders</p><h1>Which commanders<br>win the most?</h1><p class=\"lede\">Real games logged by players, combined into one score per commander.</p><p class=\"dim\">{} commanders from {} game records, one per commander per game. Free to explore.</p></div>",
        count(r.commanders.len() as i64),
        count(games as i64)
    );
    let ranked = filters.min_games();
    // The best-ranked commander the filters leave, with enough games to lead.
    let top = rows
        .iter()
        .filter(|(_, c)| c.games >= ranked.max(DEFAULT_MIN_GAMES))
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, c)| *c);
    if let Some(top) = top {
        body.push_str("<div class=\"featured\">");
        if let Some(a) = &top.art {
            write!(body, "<img src=\"{}\" alt=\"\" fetchpriority=\"high\"><span class=\"art-wash\"></span>", e(&a.url)).unwrap();
        }
        write!(
            body,
            "<div class=\"featured-copy\"><span class=\"source-chip\">Top score {:.0}</span><h2>{}</h2><p>{} game records, {}</p><small class=\"feature-credit\">{}</small></div></div>",
            top.score,
            e(&top.name),
            count(top.games as i64),
            evidence_words(top.evidence).to_lowercase(),
            top.art.as_ref().map(|a| format!("Art by {}, © Wizards of the Coast.", e(a.artist.as_deref().unwrap_or("")))).unwrap_or_default()
        )
        .unwrap();
    } else if r.sources.is_empty() {
        body.push_str("<div class=\"hero-note\"><h2>No real-game sources yet.</h2><p>Commander scores appear here once a real-game source is enabled.</p></div>");
    } else {
        write!(body, "<div class=\"hero-note\"><h2>Nothing to feature here.</h2><p>No commander these filters list has {} games yet.</p></div>", DEFAULT_MIN_GAMES).unwrap();
    }
    body.push_str("</section><div class=\"source-strip\">");
    // Each source shows what it covers and lists just those commanders.
    for s in &r.sources {
        let href = Filters { src: format!("s:{}", s.name), g: "0".into(), ..Filters::default() }.query(1);
        write!(body, "<a class=\"source-chip\" href=\"{href}\">{}, {} commanders</a>", e(&s.name), count(s.commanders as i64)).unwrap();
    }
    write!(
        body,
        "</div><div class=\"rank-intro\"><div><h2>The rankings</h2><span class=\"source-chip\">Experimental</span></div><details class=\"ranking-help\" id=\"method\"><summary>How the score works</summary><div class=\"details-body\">{}</div></details></div>",
        method(&r)
    )
    .unwrap();
    write!(
        body,
        "<form class=\"public-filters\" method=\"get\" action=\"/commanders\" data-live aria-label=\"Filter commanders\"><label class=\"search\"><span class=\"sr-only\">Search</span><input type=\"search\" name=\"q\" value=\"{}\" maxlength=\"200\" placeholder=\"Search commanders\"></label><label><span class=\"sr-only\">Sort</span><select name=\"s\">",
        e(&filters.q)
    )
    .unwrap();
    let sort: &str = if filters.s.is_empty() { "score" } else { &filters.s };
    for (value, label) in [("score", "Score"), ("sure", "Surest first"), ("games", "Most games"), ("name", "Name")] {
        write!(body, "<option value=\"{value}\"{}>{label}</option>", selected(value, sort)).unwrap();
    }
    body.push_str("</select></label><label><span class=\"sr-only\">Games</span><select name=\"g\">");
    let floor = if filters.g.is_empty() { DEFAULT_MIN_GAMES.to_string() } else { filters.g.clone() };
    for (value, label) in MIN_GAMES {
        write!(body, "<option value=\"{value}\"{}>{label}</option>", selected(value, &floor)).unwrap();
    }
    body.push_str("</select></label><label><span class=\"sr-only\">Sources</span><select name=\"src\"><option value=\"\">Any source</option>");
    if r.sources.len() > 1 {
        write!(body, "<option value=\"all\"{}>In every source</option>", selected("all", &filters.src)).unwrap();
    }
    for s in &r.sources {
        let value = format!("s:{}", s.name);
        write!(body, "<option value=\"{}\"{}>In {}</option>", e(&value), selected(&value, &filters.src), e(&s.name)).unwrap();
    }
    body.push_str("</select></label><button type=\"submit\" class=\"primary\">Apply</button><details class=\"more-filters\"");
    if !filters.c.is_empty() {
        body.push_str(" open");
    }
    write!(
        body,
        "><summary>More filters</summary><div class=\"filter-fields\"><label>Colors<input name=\"c\" value=\"{}\" maxlength=\"5\" placeholder=\"WUBRG or C\" aria-describedby=\"color-help\"></label><label>Color match<select name=\"m\">",
        e(&filters.c)
    )
    .unwrap();
    let matching: &str = if filters.m.is_empty() { "includes" } else { &filters.m };
    for (value, label) in [("includes", "Includes"), ("exact", "Exactly"), ("within", "Within")] {
        write!(body, "<option value=\"{value}\"{}>{label}</option>", selected(value, matching)).unwrap();
    }
    body.push_str("</select></label><a href=\"/commanders\">Clear filters</a><p id=\"color-help\">W white, U blue, B black, R red, G green, C colorless. Combine letters.</p></div></details></form>");

    let pages = rows.len().div_ceil(PER_PAGE).max(1);
    let current = filters.page.max(1).min(pages);
    write!(body, "<div id=\"results\" data-matched=\"{}\"><p class=\"table-note\">{} of {} commanders</p>", rows.len(), count(rows.len() as i64), count(r.commanders.len() as i64)).unwrap();
    if rows.is_empty() {
        body.push_str("<div class=\"empty-state\"><h2>No matching commanders</h2><p>Try fewer games, a different color or <a href=\"/commanders\">clear the filters</a>.</p></div>");
    } else {
        body.push_str("<div class=\"public-table-wrap\"><table class=\"public-table commander-table\"><caption class=\"sr-only\">Commander ranking from real games</caption><thead><tr><th scope=\"col\">Commander</th><th scope=\"col\">Score<small>0–100, 50 is average</small></th><th scope=\"col\">Evidence<small>Games behind the score</small></th>");
        for s in &r.sources {
            let note = if s.baseline.is_some() { "Win rate in its games" } else { "Its own 0–100 score" };
            write!(body, "<th scope=\"col\">{}<small>{note}</small></th>", e(&s.name)).unwrap();
        }
        body.push_str("<th scope=\"col\">Precon<small>Its precon rank</small></th></tr></thead><tbody>");
        for (rank, c) in rows.iter().skip((current - 1) * PER_PAGE).take(PER_PAGE) {
            let thumb = c
                .art
                .as_ref()
                .map(|a| format!("<img class=\"deck-thumb\" src=\"{}\" alt=\"\" loading=\"lazy\" width=\"64\" height=\"76\">", e(&a.url)))
                .unwrap_or_default();
            let credit = c
                .art
                .as_ref()
                .map(|a| format!("Art by {}, © Wizards of the Coast.", e(a.artist.as_deref().unwrap_or(""))))
                .unwrap_or_default();
            write!(
                body,
                "<tr><th scope=\"row\"><span class=\"deck-link\">{thumb}<span><strong>{}</strong><span class=\"deck-meta\">{}</span></span></span><small class=\"thumb-credit\">{credit}</small></th><td class=\"meta-cell\" data-label=\"Score\"><span class=\"result-value\">{:.0}</span><small>Rank #{rank}</small>{}<small>Likely {:.0}–{:.0}</small><small>{}</small></td><td data-label=\"Evidence\">{}</td>",
                e(&c.name),
                identity(&c.color_identity),
                c.score,
                interval(c),
                c.lo,
                c.hi,
                evidence_words(c.evidence),
                evidence_cell(c, &r.sources)
            )
            .unwrap();
            for s in &r.sources {
                write!(body, "<td data-label=\"{}\">{}</td>", e(&s.name), figure(c.sources.iter().find(|f| f.source == s.name), c.sources.len() > 1)).unwrap();
            }
            write!(body, "<td data-label=\"Precon\">{}</td></tr>", precon_links(c, &ranks)).unwrap();
        }
        body.push_str("</tbody></table></div>");
        write!(body, "<nav class=\"pagination\" aria-label=\"Commander pages\"><span>Page {current} of {pages}</span><div>").unwrap();
        if current > 1 {
            write!(body, "<a class=\"button\" rel=\"prev\" href=\"{}\">← Previous</a>", filters.query(current - 1)).unwrap();
        }
        if current < pages {
            write!(body, "<a class=\"button\" rel=\"next\" href=\"{}\">Next →</a>", filters.query(current + 1)).unwrap();
        }
        body.push_str("</div></nav>");
    }
    body.push_str("</div>");
    Ok(response(
        &headers,
        page(
            &st,
            "/commanders",
            "Commander rankings from real games",
            "Which Commander commanders win the most, from real games logged by players, combined into one score per commander.",
            &body,
        ),
    ))
}
