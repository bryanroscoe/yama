//! Public stock reference, rendered without loading the private application.
use super::*;
use axum::response::Html;
use std::fmt::Write;

pub(crate) use crate::public_page::{WORDMARK, e, when};
use crate::public_page::{card_item, count, identity, pct, secure, usd};

fn page(st: &AppState, path: &str, title: &str, description: &str, body: &str) -> String {
    let canonical = st
        .cfg
        .public_url
        .as_deref()
        .map(|base| {
            format!(
                "<link rel=\"canonical\" href=\"{}{}\"><meta property=\"og:url\" content=\"{}{}\">",
                e(base.trim_end_matches('/')),
                e(path),
                e(base.trim_end_matches('/')),
                e(path)
            )
        })
        .unwrap_or_default();
    let wordmark = WORDMARK;
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b0c0e"><title>{title} | Yama</title><meta name="description" content="{description}"><meta property="og:title" content="{title} | Yama"><meta property="og:description" content="{description}"><meta property="og:type" content="website">{canonical}<link rel="icon" href="/icon.svg"><link rel="preload" href="/precon-fonts/big-shoulders-display-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="{stylesheet_path}"><script defer src="/card-preview-v1.js"></script></head><body class="public-precons"><a class="skip" href="#content">Skip to content</a><header class="public-header"><a class="public-wordmark" href="/precons" aria-label="Yama precons">{wordmark}</a><nav aria-label="Public reference"><a href="/precons"{index_current}>Precons</a><a href="/precons/methodology"{method_current}>How we rank</a><a class="button" href="/">Open Yama <span aria-hidden="true">↗</span></a></nav></header><main id="content">{body}</main><footer class="public-footer"><div class="footer-top"><span>Free to explore. Built for Commander.</span><nav aria-label="About Yama"><a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/tos/">Terms</a></nav></div>{NOTICE}</footer></body></html>"##,
        stylesheet_path = stylesheet().1,
        title = e(title),
        description = e(description),
        index_current = if path == "/precons" {
            " aria-current=\"page\""
        } else {
            ""
        },
        method_current = if path.ends_with("/methodology") {
            " aria-current=\"page\""
        } else {
            ""
        }
    )
}
fn response(headers: &HeaderMap, body: String) -> Response {
    let mut res = cached(headers, body, "text/html; charset=utf-8");
    secure(&mut res);
    res
}
fn colors(p: &Precon) -> String {
    identity(&p.color_identity)
}
fn credit(p: &Precon) -> String {
    p.art
        .as_ref()
        .map(|a| {
            format!(
                "Art by {}, © Wizards of the Coast.",
                e(a.artist.as_deref().unwrap_or(""))
            )
        })
        .unwrap_or_default()
}
fn badge(r: &Rating) -> &'static str {
    match r.confidence.as_str() {
        "ok" => "",
        "unreliable" => "Engine caution",
        "doubtful" => "Check limitations",
        _ => "Not assessed",
    }
}
fn interval(r: &Rating) -> String {
    let Some(rate) = r.model_win_rate else {
        return String::new();
    };
    let Some(range) = r.model_interval else {
        return "<small>Interval unavailable</small>".into();
    };
    format!(
        "<svg class=\"interval\" viewBox=\"0 0 160 14\" role=\"img\" aria-label=\"Model interval {:.1} to {:.1} percent; 25 percent equal-deck baseline\"><path class=\"interval-track\" d=\"M0 7H160\"/><path class=\"interval-baseline\" d=\"M40 0V14\"/><path class=\"interval-range\" d=\"M{:.2} 7H{:.2}\"/><circle cx=\"{:.2}\" cy=\"7\" r=\"3\"/></svg>",
        range[0] * 100.,
        range[1] * 100.,
        range[0] * 160.,
        range[1] * 160.,
        rate * 160.
    )
}
fn sim(r: Option<&Rating>) -> String {
    let Some(r) = r else {
        return "<span class=\"dim\">Not rated</span>".into();
    };
    let caution = badge(r);
    format!(
        "<span class=\"result-value\">{}</span>{}<small>{} games{}</small>{}",
        pct(r.model_win_rate),
        interval(r),
        count(r.games),
        r.rank.map(|r| format!(" / #{r}")).unwrap_or_default(),
        if caution.is_empty() {
            String::new()
        } else {
            format!("<span class=\"caution\">{caution}</span>")
        }
    )
}
fn simulation_panel(source: &Publication, r: Option<&Rating>, rating_status: &str) -> String {
    let result = if r.is_none() && rating_status == "stock_list_changed" {
        "<span class=\"dim\">Not rated</span><small>Stock list changed</small>".into()
    } else {
        sim(r)
    };
    let mut body = String::new();
    write!(body,"<section class=\"public-panel\"><p class=\"eyebrow\">{} simulation</p><h3>Model win rate</h3>{}<small>Analysed {}</small><details><summary>Result details &amp; limitations</summary><p>{:.0}% bootstrap interval. Field: {} stock precons in four-player pods.</p>",consensus::engine_family(&source.engine),result,when(&source.analysed_at),source.interval_level*100.,source.field_size).unwrap();
    if let Some(r) = r {
        if let Some([lo, hi]) = r.model_interval {
            write!(
                body,
                "<p>{:.0}% interval: {:.1}%–{:.1}%.</p>",
                source.interval_level * 100.,
                lo * 100.,
                hi * 100.
            )
            .unwrap();
        }
        if let Some([lo, hi]) = r.rank_interval {
            write!(
                body,
                "<p>Rank range {lo}–{hi}. Observed wins: {}.</p>",
                pct(r.observed_win_rate)
            )
            .unwrap();
        }
        if !r.reasons.is_empty() {
            body.push_str("<h4>Simulation limitations</h4><ul>");
            for reason in &r.reasons {
                write!(body, "<li>{}</li>", e(reason)).unwrap();
            }
            body.push_str("</ul>");
        }
    }
    body.push_str("</details></section>");
    body
}

fn trend_words(points: f64) -> String {
    if points.abs() < 0.5 {
        "steady".into()
    } else if points > 0.0 {
        format!("rising {points:.1} points a month")
    } else {
        format!("falling {:.1} points a month", -points)
    }
}

fn rating_v2(v: &v2::Row, detailed: bool) -> String {
    let mut out = format!(
        "<span class=\"meta-rank\">#{}</span><small>{:.1}% est. ({:.1}–{:.1}%)</small>",
        v.rank, v.rate, v.lo, v.hi
    );
    if detailed {
        write!(
            out,
            "<details><summary>How this rank is made</summary><p>Estimated four-player win rate {:.1}%, 90% interval {:.1}–{:.1}%. Rank range {}–{}.</p><p>{:.0}% of the estimate’s weight is real games; the rest is the simulation.</p>",
            v.rate, v.lo, v.hi, v.rank_lo, v.rank_hi, 100.0 * v.real_share
        )
        .unwrap();
        if let Some(r) = &v.real {
            write!(out, "<p>{}: all-time {:.1}% over {} games", e(&r.source), r.all_time, count(r.games as i64)).unwrap();
            if let (Some(recent), Some(games)) = (r.recent, r.recent_games) {
                write!(out, "; recent {:.1}% over {} newer games", recent, count(games as i64)).unwrap();
            }
            if let Some(t) = r.trend_points_per_30_days {
                write!(out, "; {}", trend_words(t)).unwrap();
            }
            write!(out, ". Snapshot of {}.</p>", when(&r.as_of.format("%Y-%m-%d").to_string())).unwrap();
        }
        out.push_str("<p><a href=\"/precons/methodology#v2\">How rating v2 works ↗</a></p></details>");
    }
    out
}

/// Each real-game source with its attribution and licence, as its licence asks.
fn sources_line(info: &v2::Info) -> String {
    info.sources
        .iter()
        .map(|s| format!("{} ({}; {})", e(&s.name), e(&s.attribution), e(&s.license)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn meta(p: &Precon, detailed: bool) -> String {
    if let Some(v) = &p.v2 {
        return rating_v2(v, detailed);
    }
    let Some(m) = &p.meta else {
        return "<span class=\"dim\">Not ranked</span><small>Needs shared evidence</small>".into();
    };
    let components = if detailed {
        format!(
            "<details><summary>Score breakdown</summary><p>Real-game percentile <strong>{:.1}</strong>. Simulation percentile <strong>{:.1}</strong>.</p><p>{} precons have at least 20 games in real results and each published engine.</p><p>50% real-game percentile + 50% mean simulation percentile. This score is an ordering, not a win rate.</p></details>",
            m.real_percentile, m.simulation_percentile, m.cohort
        )
    } else {
        String::new()
    };
    format!(
        "<span class=\"meta-rank\">#{}</span><small>{:.1} / 100</small>{components}",
        m.rank, m.score
    )
}
fn upgradeability_rubric() -> String {
    let mut out =
        String::from("<table><thead><tr><th>Grade</th><th>Meaning</th></tr></thead><tbody>");
    for l in crate::upgradeability::levels() {
        write!(
            out,
            "<tr><th>{}: {}</th><td>{}</td></tr>",
            l.score,
            e(l.label),
            e(l.meaning)
        )
        .unwrap();
    }
    out.push_str("</tbody></table><p>These are Yama’s ordinal judgments, with no measured win-rate gain attached. A grade belongs to the stated commander configuration and retained main theme. Assess on-theme commander swaps separately; a replacement strategy is a separate deck build. Missing evidence means ungraded. Targeted changes refine the main package; Moderate replaces several packages; Substantial removes much of the shell. Effort describes work, not a budget or Commander bracket.</p>");
    out
}
fn assessment_html(
    u: &crate::upgradeability::Assessment,
    full: bool,
    include_rubric: bool,
) -> String {
    let mut out = match u.score {
        Some(score) => format!(
            "<strong>{score}/5 {}</strong><small>Yama assessment. {} changes.</small>",
            e(u.label),
            e(u.effort.as_deref().unwrap_or(""))
        ),
        None => format!("<span class=\"dim\">{}</span>", e(u.label)),
    };
    if !full {
        return out;
    }
    if let Some(r) = &u.rationale {
        write!(out,"<p>{}</p><dl><dt>Card support</dt><dd>{}</dd><dt>Commander payoff</dt><dd>{}</dd><dt>Restrictions</dt><dd>{}</dd></dl><p><strong>Limit:</strong> {}</p><h3>Upgrade examples</h3><ul>",e(u.path.as_deref().unwrap_or("")),e(&r.support),e(&r.payoff),e(&r.constraints),e(u.limitation.as_deref().unwrap_or(""))).unwrap();
        for c in &u.examples {
            write!(
                out,
                "<li><a href=\"{}\">{}</a>: {}.{}</li>",
                e(&c.url),
                e(&c.name),
                e(&c.role),
                if c.basis == "Yama rules analysis" {
                    format!(
                        " <small>Yama example; rules checked {}.</small>",
                        e(&c.legal_checked_on)
                    )
                } else {
                    String::new()
                }
            )
            .unwrap();
        }
        out.push_str("</ul>");
    } else {
        write!(
            out,
            "<p>{}</p>",
            e(u.gap
                .as_deref()
                .unwrap_or("No source-backed upgrade assessment is recorded for this list."))
        )
        .unwrap();
    }
    write!(out, "<p class=\"dim\">{}", e(u.basis)).unwrap();
    if let Some(date) = &u.assessed_on {
        let label = if matches!(u.status, "stock_list_changed" | "list_needs_validation") {
            "Prior audit"
        } else {
            "Audited"
        };
        write!(out, " {label} {}.", e(date)).unwrap();
    }
    if let Some(url) = &u.source_url {
        write!(out, " <a href=\"{}\">Catalog list</a>.", e(url)).unwrap();
    }
    out.push_str("</p>");
    if !u.commander_cards.is_empty() {
        out.push_str("<p>Commander rules: ");
        for (i, c) in u.commander_cards.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            write!(out, "<a href=\"{}\">{}</a>", e(&c.url), e(&c.name)).unwrap();
        }
        out.push_str(".</p>");
    }
    if include_rubric {
        write!(
            out,
            "<details><summary>What 1–5 means</summary>{}</details>",
            upgradeability_rubric()
        )
        .unwrap();
    }
    out.push_str("<h3>Reviews and upgrade guides</h3>");
    if u.sources.is_empty() {
        out.push_str(
            "<p class=\"dim\">No review or upgrade guide has been assessed for this list.</p>",
        );
    } else {
        out.push_str("<ul>");
        for s in &u.sources {
            write!(
                out,
                "<li><a href=\"{}\">{}</a> — {}, {}, {}.",
                e(&s.url),
                e(&s.title),
                e(&s.author),
                e(&s.publisher),
                e(s.published_on
                    .as_deref()
                    .unwrap_or("publication date unavailable"))
            )
            .unwrap();
            if let Some(r) = &s.rating {
                write!(
                    out,
                    "<p>Publisher’s overall review grade: <strong>{}</strong>.</p>",
                    e(r)
                )
                .unwrap();
            }
            write!(
                out,
                "<p>{}</p><small>Reviewed {}; source captured {}.</small></li>",
                e(&s.summary),
                e(&s.checked_on),
                e(&s.accessed_on)
            )
            .unwrap();
        }
        out.push_str("</ul>");
    }
    out.push_str("<h3>Commander results</h3>");
    // Each commander disclosure can be opened on its own. Its observations must
    // carry their own scope and provenance even while the reference stays closed.
    write!(out, "<p>{}</p>", e(u.commander_caveat)).unwrap();
    if u.commander_results.is_empty() {
        out.push_str("<p class=\"dim\">No commander observation is available.</p>");
    } else {
        out.push_str("<ul>");
        for c in &u.commander_results {
            let rate = c
                .raw_win_rate_percent
                .map(|r| {
                    format!(
                        "{r:.1}% raw wins ({} / {} games)",
                        count(c.wins as i64),
                        count(c.games as i64)
                    )
                })
                .unwrap_or_else(|| "No recorded games".into());
            write!(out,"<li><a href=\"{}\">{}</a>: {}{}. <small>Fetched {}. <a href=\"{}\">API observation</a>.</small></li>",e(&c.url),e(&c.name),rate,if c.games>0&&c.games<20 {" — small sample"}else{""},when(&c.fetched_at),e(&c.api_url)).unwrap();
        }
        out.push_str("</ul>");
    }
    out.push_str("<p class=\"dim\"><a href=\"https://playgroup.gg\">Playgroup.gg / Arcane Digital B.V.</a>, aggregate statistics under <a href=\"https://playgroup.gg/legal\">CC BY 4.0</a>. Source refresh dates are not provided by this endpoint.</p>");
    out
}

fn prepared_list(u: &crate::upgradeability::Assessment) -> String {
    match &u.list_url {
        Some(url) => format!(
            "<p><a href=\"{}\">Download {} comparison list</a>. {}/100 card copies retained. Legality and colours checked {}. {}</p>",
            e(url),
            e(&u.commanders.join(" + ")),
            u.retained_cards.unwrap_or(0),
            e(u.list_checked_on.as_deref().unwrap_or("")),
            e(u.simulation_note)
        ),
        None => String::new(),
    }
}
fn package_summary(u: &crate::upgradeability::Assessment, full: bool) -> String {
    let Some(p) = &u.package else {
        return String::new();
    };
    let mut out = match p.best_supported_score {
        Some(n) => format!(
            "<strong>{}{n}/5 {}</strong>",
            if full {
                "Highest supported in-box upgrade grade: "
            } else {
                ""
            },
            e(p.best_supported_label)
        ),
        None => "<strong>Package ungraded</strong>".into(),
    };
    for names in &p.best_supported_commanders {
        write!(out, "<small>{}</small>", e(&names.join(" + "))).unwrap();
    }
    write!(
        out,
        "<small>{}/{} configurations graded{}</small>",
        p.graded_configurations,
        p.configurations,
        if full {
            ". Unassessed options may be stronger."
        } else {
            ""
        }
    )
    .unwrap();
    if full {
        out.push_str("<details><summary>Package coverage</summary>");
        write!(
            out,
            "<p>{} colour-compatible in-box commander configurations inventoried {}. {} have validated simulation lists. {}</p>",
            p.configurations,
            e(&p.checked_on),
            p.validated_configurations,
            if p.roster_complete {
                "Inventory complete for the checked stock list."
            } else {
                "Inventory incomplete."
            }
        )
        .unwrap();
        if !p.featured_commanders.is_empty() {
            write!(
                out,
                "<p>Featured commanders: {}.</p>",
                e(&p.featured_commanders
                    .iter()
                    .map(|c| c.join(" + "))
                    .collect::<Vec<_>>()
                    .join(", "))
            )
            .unwrap();
        }
        write!(out, "<p>{}</p>", e(p.note)).unwrap();
        if !p.other_legends.is_empty() {
            write!(out,"<details><summary>Other included legends</summary><p>These cannot lead the complete unchanged stock pool with a checked configuration: {}.</p></details>",e(&p.other_legends.join(", "))).unwrap();
        }
        out.push_str("</details>");
    }
    out
}
fn upgradeability(p: &Precon, full: bool) -> String {
    let u = &p.upgradeability;
    if !full && u.package.is_some() {
        return package_summary(u, false);
    }
    let mut out = if full {
        format!(
            "{}<details><summary>{}: {}</summary>{}",
            package_summary(u, true),
            e(&u.commanders.join(" + ")),
            u.score
                .map(|n| format!("{n}/5 {}", e(u.label)))
                .unwrap_or_else(|| e(u.label)),
            prepared_list(u)
        )
    } else {
        String::new()
    };
    out.push_str(&assessment_html(u, full, true));
    if full {
        out.push_str("</details>");
    }
    if full && !u.alternatives.is_empty() {
        out.push_str("<h3>Other commander options</h3>");
        for a in &u.alternatives {
            let grade = a
                .score
                .map(|n| format!("{n}/5 {}", a.label))
                .unwrap_or_else(|| a.label.into());
            write!(
                out,
                "<details id=\"commander-{}\"><summary>{}: {}</summary><p>{}. Stock results elsewhere on this page do not describe this alternative list.</p>",
                e(&a.variant_key),
                e(&a.commanders.join(" + ")),
                e(&grade),
                match a.scope {
                    crate::upgradeability::PathScope::Catalog =>
                        "Reference commander configuration",
                    crate::upgradeability::PathScope::InBox => "Alternative commander from the box",
                    crate::upgradeability::PathScope::OnThemeSwap => "On-theme commander swap",
                    crate::upgradeability::PathScope::SeparateBuild => "Separate deck build",
                }
            )
            .unwrap();
            if let Some(c) = &a.continuity {
                write!(
                    out,
                    "<p><strong>Theme:</strong> {}</p><p>{} {}</p>",
                    e(&c.theme),
                    e(&c.retains),
                    e(&c.changes)
                )
                .unwrap();
            }
            out.push_str(&prepared_list(a));
            out.push_str(&assessment_html(a, true, false));
            out.push_str("</details>");
        }
    } else if !full {
        for a in u.alternatives.iter().filter(|a| a.score.is_some()) {
            write!(
                out,
                "<small>{}: {}/5 {}</small>",
                e(&a.commanders.join(" + ")),
                a.score.unwrap(),
                e(a.label)
            )
            .unwrap();
        }
        let ungraded = u.alternatives.iter().filter(|a| a.score.is_none()).count();
        if ungraded > 0 {
            write!(
                out,
                "<small>{ungraded} other commander option(s) ungraded</small>"
            )
            .unwrap();
        }
    }
    out
}

fn real(p: &Precon, detailed: bool) -> String {
    p.real_games.as_ref().map(|r|format!("<a class=\"result-value\" href=\"{}\">{:.1}%</a><small>{} stock games</small>{}",e(&r.url),r.win_rate_4p,count(r.games),if detailed{format!("<p class=\"dim\">Playgroup.gg, fetched {}.</p><details><summary>About real-game results</summary><p>Normalised to four players; pilots and opponents differ from the simulation. This is observed evidence, not a personal win-rate forecast.</p></details>",when(r.fetched_at.as_deref().unwrap_or("")))}else{String::new()})).unwrap_or_else(||"<span class=\"dim\">No real-game data</span>".into())
}
fn price(p: &Precon, detailed: bool) -> String {
    let singles = &p.singles_value;
    let dates = match (&singles.oldest_date, &singles.newest_date) {
        (Some(a), Some(b)) if a != b => format!("{}–{}", when(a), when(b)),
        (_, Some(b)) => when(b),
        _ => "Date unavailable".into(),
    };
    let sealed=p.sealed_price.as_ref().map(|s|format!("<a class=\"result-value\" href=\"{}\">{}</a><small>TCGplayer / TCGCSV</small><small>{}</small>",e(&s.url),usd(s.usd),when(&s.price_date))).unwrap_or_else(||"<span class=\"dim\">No sealed price</span>".into());
    if !detailed {
        return sealed;
    }
    format!(
        "<section class=\"public-panel\"><p class=\"eyebrow\">Market references</p><h2>What it costs</h2><div class=\"price-pair\"><div><h3>Sealed deck</h3>{sealed}</div><div><h3>Singles replacement</h3><span class=\"result-value\">{}</span><small>TCGplayer / Scryfall</small><small>{dates}</small></div></div><p class=\"dim\">{} priced copies; {} without a price{}.</p><details><summary>About market prices</summary><p>Market references are not store quotes, proof of availability or resale offers. Singles estimate the cost of replacing the list, rather than what you could sell it for.</p></details></section>",
        usd(singles.usd),
        singles.priced_copies,
        singles.unpriced_copies,
        if singles.unpriced_copies > 0 {
            "; total is partial"
        } else {
            ""
        }
    )
}
fn run_line(publication: Option<&Publication>) -> String {
    match publication {
        Some(p) => format!(
            "<span class=\"source-chip\">{} {} games</span><span class=\"source-chip\">Analysed {}</span><a href=\"/precons/methodology\">Sources &amp; method ↗</a>",
            count(p.scored_games),
            consensus::engine_family(&p.engine),
            when(&p.analysed_at)
        ),
        None => {
            "<span class=\"dim\">Simulation results await a reviewed publication.</span>".into()
        }
    }
}
fn selected(value: &str, actual: &str) -> &'static str {
    if value == actual { " selected" } else { "" }
}
fn query(filters: &Filters, page: usize) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in [
        ("q", &filters.q),
        ("c", &filters.c),
        ("m", &filters.m),
        ("y", &filters.y),
        ("set", &filters.set),
        ("s", &filters.s),
    ] {
        if !value.is_empty() {
            q.append_pair(key, value);
        }
    }
    q.append_pair("page", &page.to_string());
    format!("/precons?{}", e(&q.finish()))
}

pub(super) async fn index(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Query(filters): Query<Filters>,
) -> AppResult<Response> {
    limit(&st, address)?;
    let mut data = catalog(&st.pool).await?;
    let total = data.precons.len();
    let years: BTreeSet<_> = data
        .precons
        .iter()
        .filter_map(|p| p.released.as_deref().and_then(|d| d.get(..4)))
        .map(str::to_string)
        .collect();
    let sets: BTreeSet<_> = data.precons.iter().map(|p| p.set_code.clone()).collect();
    let sources: Vec<_> = data
        .publication
        .iter()
        .chain(data.comparisons.iter())
        .collect();
    filters.apply(&mut data.precons)?;
    let mut body = format!(
        "<section class=\"public-hero\"><div class=\"hero-copy\"><p class=\"eyebrow\">Commander precons</p><h1>Compare Commander<br>precons.</h1><p class=\"lede\">Stock lists, recorded games, simulation results and upgrade evidence.</p><p class=\"dim\">{total} Commander precons. Free to explore.</p></div>"
    );
    let featured_rank = |p: &Precon| p.v2.as_ref().map(|v| v.rank).or(p.meta.as_ref().map(|m| m.rank));
    let featured = if data.rating_v2.is_some() {
        data.precons.iter().filter(|p| p.v2.is_some()).min_by_key(|p| p.v2.as_ref().unwrap().rank)
    } else {
        data.precons.iter().filter(|p| p.meta.is_some()).min_by_key(|p| p.meta.as_ref().unwrap().rank)
    };
    if let Some(p) = featured {
        write!(
            body,
            "<a class=\"featured\" href=\"/precons/{}\">",
            e(&p.id)
        )
        .unwrap();
        if let Some(a) = &p.art {
            write!(
                body,
                "<img src=\"{}\" alt=\"\" fetchpriority=\"high\"><span class=\"art-wash\"></span>",
                e(&a.url)
            )
            .unwrap();
        }
        write!(body,"<div class=\"featured-copy\"><span class=\"source-chip\">Experimental rank #{}</span><h2>{}</h2><p>{}</p>{}<span class=\"featured-link\">Explore this deck <span aria-hidden=\"true\">↗</span></span><small class=\"feature-credit\">{}</small></div></a>",featured_rank(p).unwrap_or_default(),e(&p.name),e(&p.commanders.join(" and ")),if p.meta.as_ref().is_some_and(|m|m.flagged)||p.v2.as_ref().is_some_and(|v|v.real_share==0.0){"<small class=\"featured-caution\">Simulation limitations apply</small>"}else{""},credit(p)).unwrap();
    } else {
        body.push_str("<div class=\"hero-note\"><h2>Compare the available results.</h2><p>Compare simulation results, real-game evidence and dated market prices. Every stock list stays browsable, even when evidence is missing.</p><a href=\"/precons/methodology\">How we rank ↗</a></div>");
    }
    body.push_str("</section><div class=\"source-strip\">");
    for p in &sources {
        write!(
            body,
            "<span class=\"source-chip\">{} / {} decks</span>",
            consensus::engine_family(&p.engine),
            p.field_size
        )
        .unwrap();
    }
    write!(body,"<span class=\"source-chip\">Playgroup.gg</span>{}</div><div class=\"rank-intro\"><div><h2>The rankings</h2><span class=\"source-chip\">Experimental</span></div><details class=\"ranking-help\"><summary>About these results</summary><div class=\"details-body\">",run_line(data.publication.as_ref())).unwrap();
    if let Some(info) = &data.rating_v2 {
        write!(
            body,
            "<p>Rating v2 ranks {} precons by estimated four-player win rate, from recent real games ({}){}. {}</p>",
            info.ranked,
            sources_line(info),
            info.simulation.as_deref().map(|n| format!(" and the simulation: {}", e(n))).unwrap_or_default(),
            simulation_test(info)
        )
        .unwrap();
    } else if data.meta_cohort >= 4 {
        write!(
            body,
            "<p>Half real-game ordering, half simulation ordering across {} shared decks.</p>",
            data.meta_cohort
        )
        .unwrap();
    } else {
        body.push_str(
            "<p>Meta ranks await enough shared evidence. Browse the available source results.</p>",
        );
    }
    body.push_str("<p>Ranks summarise evidence, not a forecast for your table. Decks missing evidence stay unranked. Win rates describe different fields; the dashed mark shows the 25% equal-deck baseline.</p><p>Upgradeability shows the highest supported in-box grade and the configurations assessed. Unassessed commanders may be stronger. Open a deck for its reasoning, source dates and the 1–5 rubric.</p><a href=\"/precons/methodology\">Sources and methodology ↗</a></div></details></div>");
    write!(body,"<form class=\"public-filters\" method=\"get\" action=\"/precons\" aria-label=\"Filter precons\"><label class=\"search\"><span class=\"sr-only\">Search</span><input type=\"search\" name=\"q\" value=\"{}\" maxlength=\"200\" placeholder=\"Search deck, commander or set\"></label><label><span class=\"sr-only\">Sort</span><select name=\"s\">",e(&filters.q)).unwrap();
    for (value, label) in [
        ("meta", "Rank"),
        ("rank", "Primary sim rank"),
        ("real", "Real-game win rate"),
        ("upgradeability", "Upgradeability"),
        ("name", "Deck name"),
        ("year", "Newest first"),
        ("sealed", "Sealed market price"),
    ] {
        write!(
            body,
            "<option value=\"{value}\"{}>{label}</option>",
            selected(
                value,
                if filters.s.is_empty() {
                    "meta"
                } else {
                    &filters.s
                }
            )
        )
        .unwrap();
    }
    body.push_str("</select></label><button type=\"submit\" class=\"primary\">Apply</button><details class=\"more-filters\"");
    if !filters.c.is_empty() || !filters.y.is_empty() || !filters.set.is_empty() {
        body.push_str(" open");
    }
    write!(body,"><summary>More filters</summary><div class=\"filter-fields\"><label>Colors<input name=\"c\" value=\"{}\" maxlength=\"5\" placeholder=\"WUBRG or C\" aria-describedby=\"color-help\"></label><label>Color match<select name=\"m\">",e(&filters.c)).unwrap();
    for (value, label) in [
        ("includes", "Includes"),
        ("exact", "Exactly"),
        ("within", "Within"),
    ] {
        write!(
            body,
            "<option value=\"{value}\"{}>{label}</option>",
            selected(
                value,
                if filters.m.is_empty() {
                    "includes"
                } else {
                    &filters.m
                }
            )
        )
        .unwrap();
    }
    body.push_str(
        "</select></label><label>Year<select name=\"y\"><option value=\"\">Any year</option>",
    );
    for y in years.iter().rev() {
        write!(body, "<option{}>{}</option>", selected(y, &filters.y), e(y)).unwrap();
    }
    body.push_str(
        "</select></label><label>Set<select name=\"set\"><option value=\"\">Any set</option>",
    );
    for set in sets {
        write!(
            body,
            "<option{}>{}</option>",
            selected(&set, &filters.set),
            e(&set)
        )
        .unwrap();
    }
    body.push_str("</select></label><a href=\"/precons\">Clear filters</a><p id=\"color-help\">W white, U blue, B black, R red, G green, C colorless. Combine letters.</p></div></details></form>");
    let matched = data.precons.len();
    let pages = matched.div_ceil(24).max(1);
    let current = filters.page.max(1).min(pages);
    let start = (current - 1) * 24;
    write!(
        body,
        "<p class=\"table-note\">{} of {total} decks</p>",
        matched
    )
    .unwrap();
    if matched == 0 {
        body.push_str("<div class=\"empty-state\"><h2>No matching precons</h2><p>Try a commander, a different color or <a href=\"/precons\">clear the filters</a>.</p></div>");
    } else {
        body.push_str("<div class=\"public-table-wrap\"><table class=\"public-table\"><caption class=\"sr-only\">Stock precon comparison</caption><thead><tr><th scope=\"col\">Stock deck</th><th scope=\"col\">Rank</th>");
        for source in &sources {
            write!(
                body,
                "<th scope=\"col\">{} model</th>",
                consensus::engine_family(&source.engine)
            )
            .unwrap();
        }
        body.push_str("<th scope=\"col\">Real games</th><th scope=\"col\"><a href=\"/precons/methodology#upgradeability\">Upgradeability</a></th><th scope=\"col\">Sealed market</th></tr></thead><tbody>");
        for p in data.precons.iter().skip(start).take(24) {
            let thumb=p.art.as_ref().map(|a|format!("<img class=\"deck-thumb\" src=\"{}\" alt=\"\" loading=\"lazy\" width=\"64\" height=\"76\">",e(&a.url))).unwrap_or_default();
            write!(body,"<tr><th scope=\"row\"><a class=\"deck-link\" href=\"/precons/{}\">{thumb}<span><strong>{}</strong><small>{}</small><span class=\"deck-meta\">{}<span>{} / {}</span></span></span></a><small class=\"thumb-credit\">{}</small></th><td class=\"meta-cell\" data-label=\"Rank\">{}</td>",e(&p.id),e(&p.name),e(&p.commanders.join(" and ")),colors(p),e(&p.set_code),e(p.released.as_deref().and_then(|s|s.get(..4)).unwrap_or("—")),credit(p),meta(p,false)).unwrap();
            for source in &sources {
                let r = p
                    .simulations
                    .iter()
                    .find(|s| s.publication_id == source.id)
                    .map(|s| &s.rating);
                write!(
                    body,
                    "<td data-label=\"{} model\">{}</td>",
                    consensus::engine_family(&source.engine),
                    sim(r)
                )
                .unwrap();
            }
            write!(body,"<td data-label=\"Real games\">{}</td><td data-label=\"Upgradeability\">{}</td><td class=\"price-cell\" data-label=\"Sealed market\">{}</td></tr>",real(p,false),upgradeability(p,false),price(p,false)).unwrap();
        }
        body.push_str("</tbody></table></div>");
        write!(body,"<nav class=\"pagination\" aria-label=\"Precon pages\"><span>Page {current} of {pages}</span><div>").unwrap();
        if current > 1 {
            write!(
                body,
                "<a class=\"button\" rel=\"prev\" href=\"{}\">← Previous</a>",
                query(&filters, current - 1)
            )
            .unwrap();
        }
        if current < pages {
            write!(
                body,
                "<a class=\"button\" rel=\"next\" href=\"{}\">Next →</a>",
                query(&filters, current + 1)
            )
            .unwrap();
        }
        body.push_str("</div></nav>");
    }
    Ok(response(
        &headers,
        page(
            &st,
            "/precons",
            "Commander precon rankings and stock decklists",
            "Explore stock Commander precons with experimental meta rankings, simulation results, real-game evidence and dated market prices.",
            &body,
        ),
    ))
}

pub(super) async fn detail(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    limit(&st, address)?;
    let data =
        match detail_data(&st.pool, &slug).await {
            Ok(data) => data,
            Err(AppError::NotFound(_)) => return Ok((
                StatusCode::NOT_FOUND,
                Html(page(
                    &st,
                    "/precons",
                    "Precon not found",
                    "Find stock Commander precons on Yama.",
                    "<h1>Precon not found</h1><p><a href=\"/precons\">Browse the precons</a>.</p>",
                )),
            )
                .into_response()),
            Err(e) => return Err(e),
        };
    let p = &data.precon;
    let mut body =
        "<a class=\"back-link\" href=\"/precons\">← All precons</a><section class=\"public-art\">"
            .to_string();
    if let Some(a) = &p.art {
        write!(
            body,
            "<img src=\"{}\" alt=\"\" fetchpriority=\"high\"><div class=\"art-wash\"></div>",
            e(&a.url)
        )
        .unwrap();
    }
    write!(body,"<div class=\"art-heading\"><h1>{}</h1><p>{}</p><div class=\"deck-meta\">{}<span>{} / {} / {} cards</span></div></div><p class=\"art-credit\">{}</p></section><div class=\"public-actions\"><a class=\"button primary\" href=\"/precons/{}/decklist.txt\">Download stock list</a><a class=\"button\" href=\"/lab/p/{}\">Save to my decks</a><a class=\"text-action\" href=\"/lab/try?precon={}\">Try a change ↗</a></div>",e(&p.name),e(&p.commanders.join(" and ")),colors(p),e(p.set_name.as_deref().unwrap_or(&p.set_code)),when(p.released.as_deref().unwrap_or("")),p.card_count,credit(p),e(&p.id),e(&p.id),e(&p.id)).unwrap();
    body.push_str("<section class=\"evidence-heading\"><div><h2>How it compares</h2></div><a href=\"/precons/methodology\">Sources &amp; method ↗</a></section><div class=\"public-evidence\"><section class=\"public-panel meta-panel\"><span class=\"source-chip\">Experimental</span><h3>Rank</h3>");
    body.push_str(&meta(p, true));
    body.push_str("</section><section class=\"public-panel\"><p class=\"eyebrow\">Human tables</p><h3>Real-game win rate</h3>");
    body.push_str(&real(p, true));
    body.push_str("</section>");
    for source in data.publication.iter().chain(data.comparisons.iter()) {
        let r = p
            .simulations
            .iter()
            .find(|s| s.publication_id == source.id)
            .map(|s| &s.rating);
        body.push_str(&simulation_panel(source, r, &p.rating_status));
    }
    body.push_str("</div>");
    body.push_str("<section class=\"public-panel\"><h3>Upgradeability</h3>");
    body.push_str(&upgradeability(p, true));
    body.push_str("</section>");
    body.push_str(&price(p, true));
    if !p.partly_supported.is_empty() {
        write!(body,"<details class=\"support-note\"><summary>Known Phase card support gaps ({})</summary><p>{}. Catalog coverage is separate from published run confidence.</p></details>",p.partly_supported.len(),e(&p.partly_supported.join(", "))).unwrap();
    }
    write!(body,"<section class=\"list-section\"><div class=\"section-heading\"><div><p class=\"eyebrow\">The original {} cards</p><h2>Stock decklist</h2></div><a href=\"https://edhrec.com/precons/{}\">Reviews &amp; upgrades on EDHREC ↗</a></div><p class=\"dim\">Catalog updated {}. {} Images and card details from Scryfall.</p>",p.card_count,e(&p.id),when(p.catalog_updated_at.as_deref().unwrap_or("")),p.source_url.as_ref().map(|u|format!("<a href=\"{}\">MTGJSON source</a>.",e(u))).unwrap_or_default()).unwrap();
    for (board, label) in [
        ("commander", "Commander"),
        ("main", "Main deck"),
        ("side", "Sideboard"),
    ] {
        let cards: Vec<_> = data.cards.iter().filter(|c| c.board == board).collect();
        if cards.is_empty() {
            continue;
        }
        write!(
            body,
            "<h3>{label} <span class=\"dim\">{}</span></h3><ul class=\"public-card-list\">",
            cards.iter().map(|c| c.qty).sum::<i64>()
        )
        .unwrap();
        for c in cards {
            body.push_str(&card_item(
                &c.name,
                c.image.as_deref(),
                &c.scryfall_url,
                c.qty,
                &e(c.type_line.as_deref().unwrap_or("Card details on Scryfall")),
            ));
        }
        body.push_str("</ul>");
    }
    write!(body,"<details><summary>Select the list to copy</summary><textarea readonly rows=\"14\" aria-label=\"Stock decklist\">{}</textarea></details></section>",e(&deck_text(&data))).unwrap();
    Ok(response(
        &headers,
        page(
            &st,
            &format!("/precons/{slug}"),
            &format!("{}: stock list and results", p.name),
            &format!(
                "{} stock Commander precon: meta ranking, simulation evidence, real-game results and dated market references.",
                p.name
            ),
            &body,
        ),
    ))
}

pub(super) async fn methodology(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
) -> AppResult<Response> {
    limit(&st, address)?;
    let snapshot = snapshot(&st.pool).await?;
    let rating = catalog(&st.pool).await?.rating_v2;
    let mut body = String::from(
        "<div class=\"public-intro\"><p class=\"eyebrow\">Sources and methods</p><h1>Precon methodology</h1><p class=\"lede\">How results, upgrade assessments and market references are collected.</p></div><nav class=\"method-nav\" aria-label=\"Methodology sections\"><a class=\"button\" href=\"#upgradeability\">Upgradeability</a><a class=\"button\" href=\"#v2\">Rating v2</a><a class=\"button\" href=\"#meta\">Meta rank v1</a><a class=\"button\" href=\"#simulation\">Simulation</a><a class=\"button\" href=\"#real\">Real games</a><a class=\"button\" href=\"#sources\">Sources</a></nav><div class=\"public-prose\"><section id=\"upgradeability\"><h2>Upgradeability</h2><p>Upgradeability is Yama’s judgment of improvements that retain the precon’s main theme. Each commander configuration has its own assessment, including in-box alternatives and supported on-theme commander swaps. A replacement strategy is a separate deck build. Each grade needs a published guide covering that commander, at least two checked nonstock card examples, and written reasons covering card support, commander payoff and restrictions. The guide supplies evidence; Yama assigns the grade. Reviewer grades remain in their original scales. The old unsupported estimates were withdrawn on 27 October 2026.</p></section><section id=\"meta\"><p class=\"eyebrow\">Experimental / v1</p><h2>What the meta rank means</h2><p>Meta means agreement across evidence sources, rather than a forecast for your local playgroup. We use only stock lists with at least 20 real games and 20 simulated appearances in every published engine. At least four decks must qualify. Unranked decks remain browsable.</p><div class=\"formula\">Meta score = ½ real-game percentile<br>+ ½ mean simulation percentile</div><p>We re-rank each source within that same shared cohort. Higher is better: the lowest value scores 0, the highest 100, with tied values given their average rank. For n decks, percentile = 100 × (number below + (number equal − 1) / 2) / (n − 1). Real games use the reported four-player-normalised win rate; each engine uses its fitted strength. The score’s descending order gives the meta rank; tied scores share a rank. Filtering this page never changes the cohort or rank.</p><p>The two evidence groups have equal editorial weight. Phase and Forge, when both published, share the simulation half; extra runs from one engine cannot add votes. These weights have not been optimised or validated as a win prediction. Prices, popularity and reviewer opinion have no weight. Sources are dated but not age-weighted, so older results need care.</p><p>Engine confidence warnings remain visible and do not change the score or select the cohort: some warnings already use disagreement with real games, so filtering by those warnings would favour agreement by construction. The meta score has no probability interpretation or confidence interval. Large source disagreements and wide simulation intervals remain reasons to inspect a deck.</p><h3>Why there is no blended win-rate forecast yet</h3><p>A simulation’s opponents are a closed precon field; real games have different opponents, pilots and selection effects. Averaging those percentages would hide those differences. We show the separate model and observed win rates. A future forecast needs a declared target field, validation against held-out real results, and an interval that includes calibration error. More simulated games alone cannot establish real-world accuracy.</p></section><section id=\"simulation\"><p class=\"eyebrow\">The lab</p><h2>What simulation measures</h2><p>Four-player stock-precon pods are fitted with a Plackett–Luce finishing-order model, including turn-position effects. The model win rate estimates a deck’s chance against three random opponents from that run’s field. A 25% baseline represents four equally strong decks. Observed wins are the raw fraction of scored appearances won; they can differ because opponents and seats differ.</p><p>Intervals use the published game-cluster bootstrap and their stated coverage level. They describe sampling uncertainty within this simulation, not AI or rules accuracy. Rank ranges can be wide and overlapping. Known engine/AI limitations remain attached to their deck. An unreliable simulation is evidence to investigate, not a reliable power judgment.</p><p>Failures and timeouts are excluded, not counted as losses. Turn/action-cap finishes retained by the analysis have no winner. Legacy imports may carry a generic difficulty label without recording the Forge profile; that profile remains unverified unless the reviewed source notes document it. Each engine keeps its own field, scoring, build and dates; percentiles on a shared subset make orderings comparable, but cannot remove differences in their original opponent fields.</p>",
    );
    let v2_section = format!(
        "<section id=\"v2\"><p class=\"eyebrow\">Experimental / v2</p><h2>Rating v2: the default rank</h2><p>Rating v2 estimates each stock precon’s four-player win rate from real games, read over time. A real-game source reports cumulative snapshots; the games played between two snapshots give that period’s rate. Periods are pooled to at least 40 games and weighted towards recent play with a 180-day half-life, and a precon’s trend is the change in those rates per month. Uploading a new dataset revision updates every rank within minutes.</p><p>The simulation joins in only on merit. It is Forge’s games from a tournament of every stock precon in balanced four-player pods; Phase results, which have tracked real games less closely, are left out. Every few minutes the rating rebuilds a test: freeze everything known six weeks ago, predict each precon’s real games since, and compare. The simulation gets weight beside real games only when that combined prediction beats real games alone, with a 90% interval clear of zero. Until then it ranks only precons with no real games, mapped onto the real-game scale. Each estimated win rate shows a 90% interval, and each rank a range drawn from that uncertainty; the share of weight from real games is on each deck’s page.</p><p>{}</p><p>Real-game results come from different pilots, opponents and selection effects than our simulation, and none of this is a forecast for your table. Decks with neither real games nor a simulated result stay unranked.</p></section>",
        match &rating {
            Some(info) => format!(
                "Currently {} precons, as of {}. Real-game sources: {}. {}",
                info.ranked,
                when(&info.as_of.format("%Y-%m-%d").to_string()),
                sources_line(info),
                info.simulation.as_deref().map(|n| format!("Simulation: {}. ", e(n))).unwrap_or_default() + simulation_test(info)
            ),
            None => "No real-game source is enabled, so the pages fall back to meta rank v1 below.".into(),
        }
    );
    let rubric = upgradeability_rubric();
    body=body.replacen("</p></section><section id=\"meta\">", &format!("</p>{rubric}<h3>Commander results and other sources</h3><p>{}</p><p>Commander counts come from each Playgroup API endpoint, fetched and attributed separately from stock-precon results. We never mix bulk and individual endpoint counts. Zero games has no rate. Samples below 20 games are marked small. No attempt is made to correct these commander rates for pilot skill or selection effects.</p><p><a href=\"https://edhtop16.com\">EDHTop16</a> reports competitive tournament entries and conversion rates. Conversion measures advancement, not game wins, and does not describe a stock precon. <a href=\"https://edhrec.com/faq\">EDHREC</a> deck inclusion measures card choices, not outcomes. Those measures are not pooled with Playgroup win rates or used as automatic upgrade scores. Dated reviews from named authors provide qualitative evidence. Upgraded-versus-stock trials for these assessments have not been run.</p><p>Coverage: 174 packages with 619 stock-compatible commander configurations inventoried. Eighteen configurations have supported upgrade grades; unassessed options may be stronger. Six configurations need banned stock cards replaced, and three require pregame colour-choice input not yet supported by the simulation list format. There are 611 prepared lists including Koma’s outside-commander option, and 575 separately scoped commander observations. The package summary names the highest supported in-box upgrade grade and shows assessed/total coverage; outside commanders cannot supply that grade. A guide using another commander supports that configuration, not the original commander’s grade. New or changed lists need their own matching assessment. Prepared commander lists use separate command zones and identities; they do not inherit the reference list’s simulation results. Upgradeability and commander observations have no weight in the stock meta rank.</p></section><section id=\"meta\">", e(crate::upgradeability::COMMANDER_CAVEAT)),1);
    body = body.replacen("<section id=\"meta\">", &format!("{v2_section}<section id=\"meta\">"), 1);
    if let Some(s) = &snapshot {
        for source in std::iter::once(s).chain(s.comparisons.iter()) {
            let p = &source.publication;
            write!(body,"<details class=\"publication\"><summary>{} / {} / {} scored games</summary><h3>{}</h3><dl><dt>Engine</dt><dd>{}</dd><dt>Recorded AI label</dt><dd>{}</dd><dt>Card data</dt><dd>{}</dd><dt>Runner</dt><dd>{}</dd><dt>Field</dt><dd>{} stock precons</dd><dt>Analysed</dt><dd>{}</dd><dt>Published</dt><dd>{}</dd><dt>Interval coverage</dt><dd>{:.0}%</dd><dt>Failures excluded</dt><dd>{}</dd><dt>Time caps excluded</dt><dd>{}</dd><dt>Retained no-winner finishes</dt><dd>{}</dd><dt>Method</dt><dd>{}</dd></dl>",consensus::engine_family(&p.engine),when(&p.analysed_at),count(p.scored_games),e(&p.title),e(&p.engine),e(&p.difficulty),e(&p.card_data),e(&p.runner),p.field_size,when(&p.analysed_at),when(&p.published_at),p.interval_level*100.,p.failed_games,p.time_caps,p.no_winner,e(&p.method)).unwrap();
            for n in &p.notes {
                write!(body, "<p>{}</p>", e(n)).unwrap();
            }
            body.push_str(
                "<details><summary>Frozen benchmark field</summary><ul class=\"field-list\">",
            );
            for slug in source.ratings.keys() {
                write!(
                    body,
                    "<li><a href=\"/precons/{}\">{}</a></li>",
                    e(slug),
                    e(slug)
                )
                .unwrap();
            }
            body.push_str("</ul></details></details>");
        }
    } else {
        body.push_str("<p>No simulation ranking has been published yet.</p>");
    }
    body.push_str("</section><section id=\"real\"><p class=\"eyebrow\">Human tables</p><h2>Real-game evidence</h2><p><a href=\"https://playgroup.gg/commander/precons\">Playgroup.gg</a> supplies attributed aggregate stock-precon results, normalised to a four-player baseline. These are not raw binomial win counts. Its source rules describe stock matching and pilot eligibility; the opponents and pilots differ from our simulation. Yama’s catalog rank is among mapped precons and may differ from the source’s full ranking. Open any deck for its game count and fetch date.</p><p>The same real results may already inform simulation confidence labels. They are not an independent validation set for those labels, the meta score or a future calibrated forecast.</p></section><section id=\"sources\"><p class=\"eyebrow\">Provenance</p><h2>Lists, prices and publication</h2><p><a href=\"https://mtgjson.com/data-models/deck/\">MTGJSON</a> supplies stock-list data. Each published simulation is checked against its original index and stock lists. Changed lists lose the old result; missing results remain missing.</p><p>Singles replacement estimates use TCGplayer market data via <a href=\"https://scryfall.com\">Scryfall</a>. Sealed references use TCGplayer product data via <a href=\"https://tcgcsv.com\">TCGCSV</a>. Each price carries its cached date. Missing copies make a singles total partial; neither estimate proves store availability, a checkout price or resale proceeds. <a href=\"https://edhrec.com/precons\">EDHREC</a> links offer upgrade ideas and guides, not measured win-rate improvements.</p><p>Publication is deliberate. Imports do not automatically replace the reviewed public snapshots. Only stock catalog data and explicitly reviewed benchmark projections are public. Personal decks, collections, games, experiments and account information remain private. Reading these pages never starts simulations.</p><h3>Content rights</h3><p>All rights reserved in Yama’s original software, written analysis and presentation. Third-party material remains with its owners. This notice does not claim exclusive rights in facts, game rules, card lists or ideas. See <a href=\"/tos/#rights\">content rights and reuse</a>.</p></section></div>");
    Ok(response(
        &headers,
        page(
            &st,
            "/precons/methodology",
            "Precon ranking methodology",
            "How Yama combines source orderings and explains stock Commander simulation results, real-game evidence and uncertainty.",
            &body,
        ),
    ))
}

// HTML and CSS can have different browser/CDN lifetimes. Couple the markup to the
// complete compiled stylesheet (including shared tokens), rather than a mutable URL.
pub(crate) fn stylesheet() -> &'static (String, String) {
    static CSS: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    CSS.get_or_init(|| {
        let all = include_str!("../../../web/src/styles.css");
        let tokens = all
            .split_once(":root {")
            .and_then(|(_, rest)| rest.split_once("\n}"))
            .map(|(tokens, _)| format!(":root {{{tokens}\n}}"))
            .unwrap_or_default();
        let body = format!(
            "{tokens}\n{}\n{}\n{}",
            include_str!("../../../web/public/precons.css"),
            include_str!("../../../web/src/controls.css"),
            include_str!("../../../web/src/art-framing.css")
        );
        let path = format!("/precons/assets/style-{}.css", sha256_hex(&body));
        (body, path)
    })
}

// Keep old links readable, but new documents always use the content-addressed URL.
pub(super) async fn style(headers: HeaderMap) -> Response {
    cached(&headers, stylesheet().0.clone(), "text/css; charset=utf-8")
}

pub(super) async fn versioned_style(
    Path(filename): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let css = stylesheet();
    if css.1.rsplit('/').next() != Some(filename.as_str()) {
        return Err(AppError::NotFound("stylesheet"));
    }
    let mut response = cached(&headers, css.0.clone(), "text/css; charset=utf-8");
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(response)
}

pub(super) async fn sitemap(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
) -> AppResult<Response> {
    limit(&st, address)?;
    let base = st
        .cfg
        .public_url
        .as_deref()
        .ok_or(AppError::NotFound("sitemap"))?
        .trim_end_matches('/');
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM precons ORDER BY id")
        .fetch_all(&st.pool)
        .await?;
    let mut body="<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">".to_string();
    for path in [
        "/precons".to_string(),
        "/precons/methodology".to_string(),
        "/docs/mcp/".to_string(),
    ]
    .into_iter()
    .chain(
        ids.into_iter()
            .filter(|s| valid_slug(s))
            .map(|s| format!("/precons/{s}")),
    ) {
        write!(body, "<url><loc>{}{}</loc></url>", e(base), e(&path)).unwrap();
    }
    body.push_str("</urlset>");
    Ok(cached(&headers, body, "application/xml; charset=utf-8"))
}

/// Whether the simulation counts beside real games, in a sentence.
fn simulation_test(info: &v2::Info) -> &'static str {
    match (&info.simulation, info.gate_passed) {
        (None, _) => "No simulation is chosen, so only precons with real games are ranked.",
        (Some(_), true) => "The simulation passed the time-split test against later real games, so it is weighed beside them.",
        (Some(_), false) => "The simulation has not passed the time-split test against later real games, so it only ranks precons without real games.",
    }
}
