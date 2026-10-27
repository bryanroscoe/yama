//! Public stock reference, rendered without loading the private application.
use super::*;
use axum::response::Html;
use std::fmt::Write;

fn e(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn pct(n: Option<f64>) -> String {
    n.map(|n| format!("{:.1}%", n * 100.))
        .unwrap_or_else(|| "—".into())
}
fn usd(n: Option<f64>) -> String {
    n.map(|n| format!("${n:.2}"))
        .unwrap_or_else(|| "No price".into())
}
fn when(s: &str) -> String {
    s.get(..10)
        .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .map(|d| d.format("%-d %b %Y").to_string())
        .unwrap_or_else(|| "Date unavailable".into())
}
fn count(n: i64) -> String {
    let s = n.to_string();
    s.chars()
        .enumerate()
        .map(|(i, c)| {
            if i > 0 && (s.len() - i).is_multiple_of(3) {
                format!(",{c}")
            } else {
                c.to_string()
            }
        })
        .collect()
}
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
    // Same geometry as components/Wordmark.tsx and design/logo/yama-wordmark.svg.
    let wordmark = r#"<svg viewBox="0 -8 280 110" aria-hidden="true"><g fill="currentColor"><path d="M0 0H20L32 30L44 0H64L42 56V100H22V56Z"/><path d="M60 100L92 -6L124 100H104L92 60L80 100Z"/><path d="M134 100V0H152L170 44L188 0H206V100H186V40L170 79L154 40V100Z"/><path d="M216 100L248 -6L280 100H260L248 60L236 100Z"/></g></svg>"#;
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b0c0e"><title>{title} | Yama</title><meta name="description" content="{description}"><meta property="og:title" content="{title} | Yama"><meta property="og:description" content="{description}"><meta property="og:type" content="website">{canonical}<link rel="icon" href="/icon.svg"><link rel="preload" href="/precon-fonts/big-shoulders-display-latin-800-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/precons/style.css"></head><body class="public-precons"><a class="skip" href="#content">Skip to content</a><header class="public-header"><a class="public-wordmark" href="/precons" aria-label="Yama precons">{wordmark}</a><nav aria-label="Public reference"><a href="/precons"{index_current}>Precons</a><a href="/precons/methodology"{method_current}>How we rank</a><a class="button" href="/">Open Yama <span aria-hidden="true">↗</span></a></nav></header><main id="content">{body}</main><footer class="public-footer"><div class="footer-top"><span>Free to explore. Built for Commander.</span><nav aria-label="About Yama"><a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/tos/">Terms</a></nav></div>{NOTICE}</footer></body></html>"##,
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
    res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; style-src 'self'; img-src 'self' https://cards.scryfall.io; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"));
    res.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    res
}
fn colors(p: &Precon) -> String {
    let mut s = "<span class=\"identity\" aria-label=\"Color identity: ".to_string();
    let letters = if p.color_identity.is_empty() {
        "C"
    } else {
        &p.color_identity
    };
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
    s.push_str(&names.join(", "));
    s.push_str("\">");
    for c in letters.chars().filter(|c| "WUBRGC".contains(*c)) {
        write!(
            s,
            "<span class=\"color color-{c}\" aria-hidden=\"true\">{c}</span>"
        )
        .unwrap();
    }
    s.push_str("</span>");
    s
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
fn meta(p: &Precon, detailed: bool) -> String {
    let Some(m) = &p.meta else {
        return "<span class=\"dim\">Not ranked</span><small>Needs shared evidence</small>".into();
    };
    let components = if detailed {
        format!(
            "<p>Real-game percentile <strong>{:.1}</strong>. Simulation percentile <strong>{:.1}</strong>.</p><p class=\"dim\">{} precons have at least 20 games in real results and each published engine. Higher scores mean stronger ordering across those sources.</p>",
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
fn real(p: &Precon, detailed: bool) -> String {
    p.real_games.as_ref().map(|r|format!("<a class=\"result-value\" href=\"{}\">{:.1}%</a><small>{} stock games</small>{}",e(&r.url),r.win_rate_4p,count(r.games),if detailed{format!("<p class=\"dim\">Playgroup.gg, fetched {}. Normalised to four players; pilots and opponents differ from the simulation. This is observed evidence, not a personal win-rate forecast.</p>",when(r.fetched_at.as_deref().unwrap_or("")))}else{String::new()})).unwrap_or_else(||"<span class=\"dim\">No real-game data</span>".into())
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
        "<section class=\"public-panel\"><p class=\"eyebrow\">Market references</p><h2>What it costs</h2><div class=\"price-pair\"><div><h3>Sealed deck</h3>{sealed}</div><div><h3>Singles replacement</h3><span class=\"result-value\">{}</span><small>TCGplayer / Scryfall</small><small>{dates}</small></div></div><p class=\"dim\">{} priced copies; {} without a price{}. Market references are not store quotes, proof of availability or resale offers.</p></section>",
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
        "<section class=\"public-hero\"><div class=\"hero-copy\"><p class=\"eyebrow\">The precon field guide</p><h1>Know your<br>next precon.</h1><p class=\"lede\">Stock lists. Real tables. Simulated games.<br> Find a deck you’ll want to bring to the table.</p><p class=\"dim\">{total} Commander precons. Free to explore.</p></div>"
    );
    if let Some(p) = data
        .precons
        .iter()
        .filter(|p| p.meta.is_some())
        .min_by_key(|p| p.meta.as_ref().unwrap().rank)
    {
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
        write!(body,"<div class=\"featured-copy\"><span class=\"source-chip\">Experimental meta #{}</span><h2>{}</h2><p>{}</p>{}<span class=\"featured-link\">Explore this deck <span aria-hidden=\"true\">↗</span></span><small class=\"feature-credit\">{}</small></div></a>",p.meta.as_ref().unwrap().rank,e(&p.name),e(&p.commanders.join(" and ")),if p.meta.as_ref().is_some_and(|m|m.flagged){"<small class=\"featured-caution\">Simulation limitations apply</small>"}else{""},credit(p)).unwrap();
    } else {
        body.push_str("<div class=\"hero-note\"><h2>A clearer view of the field.</h2><p>Compare simulation results, real-game evidence and dated market prices. Every stock list stays browsable, even when evidence is missing.</p><a href=\"/precons/methodology\">How we rank ↗</a></div>");
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
    write!(body,"<span class=\"source-chip\">Playgroup.gg</span>{}</div><div class=\"rank-intro\"><div><h2>The rankings</h2><span class=\"source-chip\">Experimental meta</span></div><p>",run_line(data.publication.as_ref())).unwrap();
    if data.meta_cohort >= 4 {
        write!(
            body,
            "Half real-game ordering, half simulation ordering across {} shared decks. ",
            data.meta_cohort
        )
        .unwrap();
    } else {
        body.push_str(
            "Meta ranks await enough shared evidence. Browse the available source results. ",
        );
    }
    body.push_str("<a href=\"/precons/methodology#meta\">See the formula</a>.</p></div>");
    write!(body,"<form class=\"public-filters\" method=\"get\" action=\"/precons\" aria-label=\"Filter precons\"><label class=\"search\"><span class=\"sr-only\">Search</span><input type=\"search\" name=\"q\" value=\"{}\" maxlength=\"200\" placeholder=\"Search deck, commander or set\"></label><label><span class=\"sr-only\">Sort</span><select name=\"s\">",e(&filters.q)).unwrap();
    for (value, label) in [
        ("meta", "Meta rank"),
        ("rank", "Primary sim rank"),
        ("real", "Real-game win rate"),
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
    write!(body,"<p class=\"table-note\">{} of {total} decks<span>Win rates describe different fields. Dashed mark: 25% equal-deck baseline.</span></p>",matched).unwrap();
    if matched == 0 {
        body.push_str("<div class=\"empty-state\"><h2>No matching precons</h2><p>Try a commander, a different color or <a href=\"/precons\">clear the filters</a>.</p></div>");
    } else {
        body.push_str("<div class=\"public-table-wrap\"><table class=\"public-table\"><caption class=\"sr-only\">Stock precon comparison</caption><thead><tr><th scope=\"col\">Stock deck</th><th scope=\"col\">Meta rank</th>");
        for source in &sources {
            write!(
                body,
                "<th scope=\"col\">{} model</th>",
                consensus::engine_family(&source.engine)
            )
            .unwrap();
        }
        body.push_str("<th scope=\"col\">Real games</th><th scope=\"col\">Sealed market</th></tr></thead><tbody>");
        for p in data.precons.iter().skip(start).take(24) {
            let thumb=p.art.as_ref().map(|a|format!("<img class=\"deck-thumb\" src=\"{}\" alt=\"\" loading=\"lazy\" width=\"64\" height=\"76\">",e(&a.url))).unwrap_or_default();
            write!(body,"<tr><th scope=\"row\"><a class=\"deck-link\" href=\"/precons/{}\">{thumb}<span><strong>{}</strong><small>{}</small><span class=\"deck-meta\">{}<span>{} / {}</span></span></span></a><small class=\"thumb-credit\">{}</small></th><td class=\"meta-cell\" data-label=\"Meta rank\">{}</td>",e(&p.id),e(&p.name),e(&p.commanders.join(" and ")),colors(p),e(&p.set_code),e(p.released.as_deref().and_then(|s|s.get(..4)).unwrap_or("—")),credit(p),meta(p,false)).unwrap();
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
            write!(body,"<td data-label=\"Real games\">{}</td><td class=\"price-cell\" data-label=\"Sealed market\">{}</td></tr>",real(p,false),price(p,false)).unwrap();
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
    body.push_str("<aside class=\"reading-note\"><h3>A rank is a starting point.</h3><p>Meta scores summarise source orderings, not a chance of winning. Engine cautions remain part of the evidence. Decks missing shared data stay unranked. Open a deck for source dates, intervals, limitations and its complete stock list.</p><a href=\"/precons/methodology\">Read the methodology ↗</a></aside>");
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
    write!(body,"<div class=\"art-heading\"><p class=\"eyebrow\">Stock Commander precon</p><h1>{}</h1><p>{}</p><div class=\"deck-meta\">{}<span>{} / {} / {} cards</span></div></div><p class=\"art-credit\">{}</p></section><div class=\"public-actions\"><a class=\"button primary\" href=\"/precons/{}/decklist.txt\">Download stock list</a><a class=\"button\" href=\"/decks/lab/p/{}\">Sign in to save this deck</a><a class=\"text-action\" href=\"/decks/lab/try?precon={}\">Sign in to try a change ↗</a></div>",e(&p.name),e(&p.commanders.join(" and ")),colors(p),e(p.set_name.as_deref().unwrap_or(&p.set_code)),when(p.released.as_deref().unwrap_or("")),p.card_count,credit(p),e(&p.id),e(&p.id),e(&p.id)).unwrap();
    body.push_str("<section class=\"evidence-heading\"><div><p class=\"eyebrow\">Read the evidence</p><h2>How it compares</h2></div><a href=\"/precons/methodology\">Sources &amp; method ↗</a></section><div class=\"public-evidence\"><section class=\"public-panel meta-panel\"><span class=\"source-chip\">Experimental</span><h3>Meta rank</h3>");
    body.push_str(&meta(p, true));
    body.push_str("<p class=\"dim\">50% real-game percentile + 50% mean simulation percentile. This score is an ordering, not a win rate.</p></section><section class=\"public-panel\"><p class=\"eyebrow\">Human tables</p><h3>Real-game win rate</h3>");
    body.push_str(&real(p, true));
    body.push_str("</section>");
    for source in data.publication.iter().chain(data.comparisons.iter()) {
        let r = p
            .simulations
            .iter()
            .find(|s| s.publication_id == source.id)
            .map(|s| &s.rating);
        write!(body,"<section class=\"public-panel\"><p class=\"eyebrow\">{} simulation</p><h3>Model win rate</h3>{}<p class=\"dim\">Published interval coverage: {}% (game bootstrap). Versus {} stock precons, four-player pods. Analysed {}.</p>",consensus::engine_family(&source.engine),sim(r),source.interval_level*100.,source.field_size,when(&source.analysed_at)).unwrap();
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
                body.push_str("<details><summary>Simulation limitations</summary><ul>");
                for reason in &r.reasons {
                    write!(body, "<li>{}</li>", e(reason)).unwrap();
                }
                body.push_str("</ul></details>");
            }
        } else if p.rating_status == "stock_list_changed" {
            body.push_str(
                "<p>Stock list changed. The published result describes an older list.</p>",
            );
        }
        body.push_str("</section>");
    }
    body.push_str("</div>");
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
            let image = c
                .image
                .as_ref()
                .map(|u| {
                    format!(
                        "<img src=\"{}\" alt=\"{}\" loading=\"lazy\" width=\"48\" height=\"67\">",
                        e(u),
                        e(&c.name)
                    )
                })
                .unwrap_or_default();
            write!(body,"<li><a href=\"{}\">{image}<span><span class=\"card-qty\">{}</span> {}<small>{}</small></span></a></li>",e(&c.scryfall_url),c.qty,e(&c.name),e(c.type_line.as_deref().unwrap_or("Card details on Scryfall"))).unwrap();
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
    let mut body = String::from(
        "<div class=\"public-intro\"><p class=\"eyebrow\">Evidence you can inspect</p><h1>Behind the rankings.</h1><p class=\"lede\">Several views of a deck. One transparent starting point.</p></div><nav class=\"method-nav\" aria-label=\"Methodology sections\"><a class=\"button\" href=\"#meta\">Meta rank</a><a class=\"button\" href=\"#simulation\">Simulation</a><a class=\"button\" href=\"#real\">Real games</a><a class=\"button\" href=\"#sources\">Sources</a></nav><div class=\"public-prose\"><section id=\"meta\"><p class=\"eyebrow\">Experimental / v1</p><h2>What the meta rank means</h2><p>Meta means agreement across evidence sources, rather than a forecast for your local playgroup. We use only stock lists with at least 20 real games and 20 simulated appearances in every published engine. At least four decks must qualify. Unranked decks remain browsable.</p><div class=\"formula\">Meta score = ½ real-game percentile<br>+ ½ mean simulation percentile</div><p>We re-rank each source within that same shared cohort. Higher is better: the lowest value scores 0, the highest 100, with tied values given their average rank. For n decks, percentile = 100 × (number below + (number equal − 1) / 2) / (n − 1). Real games use the reported four-player-normalised win rate; each engine uses its fitted strength. The score’s descending order gives the meta rank; tied scores share a rank. Filtering this page never changes the cohort or rank.</p><p>The two evidence groups have equal editorial weight. Phase and Forge, when both published, share the simulation half; extra runs from one engine cannot add votes. These weights have not been optimised or validated as a win prediction. Prices, popularity and reviewer opinion have no weight. Sources are dated but not age-weighted, so older results need care.</p><p>Engine confidence warnings remain visible and do not change the score or select the cohort: some warnings already use disagreement with real games, so filtering by those warnings would favour agreement by construction. The meta score has no probability interpretation or confidence interval. Large source disagreements and wide simulation intervals remain reasons to inspect a deck.</p><h3>Why there is no blended win-rate forecast yet</h3><p>A simulation’s opponents are a closed precon field; real games have different opponents, pilots and selection effects. Averaging those percentages would hide those differences. We show the separate model and observed win rates. A future forecast needs a declared target field, validation against held-out real results, and an interval that includes calibration error. More simulated games alone cannot establish real-world accuracy.</p></section><section id=\"simulation\"><p class=\"eyebrow\">The lab</p><h2>What simulation measures</h2><p>Four-player stock-precon pods are fitted with a Plackett–Luce finishing-order model, including turn-position effects. The model win rate estimates a deck’s chance against three random opponents from that run’s field. A 25% baseline represents four equally strong decks. Observed wins are the raw fraction of scored appearances won; they can differ because opponents and seats differ.</p><p>Intervals use the published game-cluster bootstrap and their stated coverage level. They describe sampling uncertainty within this simulation, not AI or rules accuracy. Rank ranges can be wide and overlapping. Known engine/AI limitations remain attached to their deck. An unreliable simulation is evidence to investigate, not a reliable power judgment.</p><p>Failures and timeouts are excluded, not counted as losses. Turn/action-cap finishes retained by the analysis have no winner. Legacy imports may carry a generic difficulty label without recording the Forge profile; that profile remains unverified unless the reviewed source notes document it. Each engine keeps its own field, scoring, build and dates; percentiles on a shared subset make orderings comparable, but cannot remove differences in their original opponent fields.</p>",
    );
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

pub(super) async fn style(headers: HeaderMap) -> Response {
    let all = include_str!("../../../web/src/styles.css");
    let tokens = all
        .split_once(":root {")
        .and_then(|(_, rest)| rest.split_once("\n}"))
        .map(|(tokens, _)| format!(":root {{{tokens}\n}}"))
        .unwrap_or_default();
    cached(
        &headers,
        format!(
            "{tokens}\n{}",
            include_str!("../../../web/public/precons.css")
        ),
        "text/css; charset=utf-8",
    )
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
    for path in ["/precons".to_string(), "/precons/methodology".to_string(), "/docs/mcp/".to_string()]
        .into_iter()
        .chain(
            ids.into_iter()
                .filter(|s| valid_slug(s))
                .map(|s| format!("/precons/{s}")),
        )
    {
        write!(body, "<url><loc>{}{}</loc></url>", e(base), e(&path)).unwrap();
    }
    body.push_str("</urlset>");
    Ok(cached(&headers, body, "application/xml; charset=utf-8"))
}
