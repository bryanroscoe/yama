//! Server HTML keeps the public reference independent of the authenticated React app.
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
    n.map(|n| format!("{:.1}%", n * 100.0))
        .unwrap_or_else(|| "Not available".into())
}
fn usd(n: Option<f64>) -> String {
    n.map(|n| format!("${n:.2}"))
        .unwrap_or_else(|| "No price".into())
}
fn range(v: Option<[f64; 2]>) -> String {
    v.map(|v| format!("{:.1}% to {:.1}%", v[0] * 100.0, v[1] * 100.0))
        .unwrap_or_else(|| "Interval not available".into())
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
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b0c0e"><title>{title} | Yama</title><meta name="description" content="{description}"><meta property="og:title" content="{title} | Yama"><meta property="og:description" content="{description}"><meta property="og:type" content="website">{canonical}<link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/precons/style.css"></head><body class="public-precons"><a class="skip" href="#content">Skip to content</a><header class="public-header"><a class="public-wordmark" href="/precons" aria-label="Yama precons">Yama</a><nav aria-label="Public reference"><a href="/precons">Precons</a><a href="/precons/methodology">Methodology</a><a href="/">Open Yama</a></nav></header><main id="content">{body}</main><div class="public-footer"><nav aria-label="About Yama"><a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/tos/">Terms</a></nav>{NOTICE}</div></body></html>"##,
        title = e(title),
        description = e(description)
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

fn run_line(publication: Option<&Publication>) -> String {
    match publication {
        Some(p) => format!("<div class=\"public-run\"><strong>{}</strong><p>Simulated with {}, {} AI. {} scored games across {} stock precons. Analysed {}. Published {}.</p><p>AI results describe this simulation. Engine limitations and the opponent field can change the ranking. <a href=\"/precons/methodology\">How the results work</a>.</p></div>", e(&p.title), e(&p.engine), e(&p.difficulty), p.scored_games, p.field_size, e(&p.analysed_at), e(&p.published_at)),
        None => "<div class=\"public-run\"><strong>No simulation ranking has been published yet.</strong><p>Browse the stock lists and available real-game evidence below. Imported Lab runs stay unpublished until a stock benchmark has been reviewed.</p></div>".into(),
    }
}

fn price(p: &Precon, detailed: bool) -> String {
    let singles = &p.singles_value;
    let dates = match (&singles.oldest_date, &singles.newest_date) {
        (Some(a), Some(b)) if a != b => format!("{} to {}", e(a), e(b)),
        (_, Some(b)) => e(b),
        _ => "No price date".into(),
    };
    let sealed = p
        .sealed_price
        .as_ref()
        .map(|s| {
            format!(
                "<a href=\"{}\">{}</a><small>TCGplayer market via TCGCSV, {}</small>",
                e(&s.url),
                usd(s.usd),
                e(&s.price_date)
            )
        })
        .unwrap_or_else(|| "No sealed market price".into());
    let missing = if singles.unpriced_copies > 0 {
        format!(
            "<small>{} copies without a price; total is partial</small>",
            singles.unpriced_copies
        )
    } else {
        String::new()
    };
    if detailed {
        format!(
            "<section class=\"public-panel\"><h2>Market references</h2><dl><dt>Sealed deck</dt><dd>{sealed}</dd><dt>Singles replacement estimate</dt><dd>{}{missing}<small>TCGplayer market via Scryfall, {dates}. {} priced copies.</small></dd></dl><p class=\"dim\">Singles use eligible nonfoil printings, including commanders and basics. Market references are not store quotes, availability or resale offers.</p></section>",
            usd(singles.usd),
            singles.priced_copies
        )
    } else {
        format!(
            "{sealed}<small>Singles: {}{missing}</small><small>Scryfall/TCGplayer, {dates}</small>",
            usd(singles.usd)
        )
    }
}

fn sim(p: &Precon) -> String {
    let Some(r) = &p.rating else {
        return if p.rating_status == "stock_list_changed" {
            "Stock list changed<small>The published result describes an older list.</small>".into()
        } else {
            "Not rated".into()
        };
    };
    let label = if r.confidence == "unreliable" {
        "Simulation unreliable".into()
    } else {
        r.rank
            .map(|r| format!("Rank {r}"))
            .unwrap_or_else(|| "Not ranked".into())
    };
    let note = match r.confidence.as_str() {
        "doubtful" => "<small>Simulation doubtful</small>",
        "unreviewed" => "<small>Confidence not assessed</small>",
        _ => "",
    };
    format!(
        "<strong>{label}</strong>{note}<small>Model win rate: {}</small><small>{}; {} games{}</small>",
        pct(r.model_win_rate),
        range(r.model_interval),
        r.games,
        if r.games < 10 { ", few games" } else { "" }
    )
}

fn real(p: &Precon) -> String {
    p.real_games.as_ref().map(|r| {
        let rank = match (r.rank_in_catalog, r.rated_catalog_decks) { (Some(n), Some(total)) => format!("<small>Rank {n} of {total} mapped precons</small>"), _ => String::new() };
        format!("<a href=\"{}\">{:.1}%</a><small>{} stock games, four-player baseline</small>{rank}<small>Playgroup.gg, fetched {}</small>", e(&r.url), r.win_rate_4p, r.games, e(r.fetched_at.as_deref().unwrap_or("date unavailable")))
    }).unwrap_or_else(|| "No real-game data".into())
}

fn selected(value: &str, actual: &str) -> &'static str {
    if value == actual { " selected" } else { "" }
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
    filters.apply(&mut data.precons)?;
    let mut body = format!(
        "<div class=\"public-intro\"><p class=\"eyebrow\">Stock Commander decks</p><h1>Find your next precon.</h1><p>Compare the lists, the evidence and the cost. Free to browse, with no account needed.</p></div>{}",
        run_line(data.publication.as_ref())
    );
    write!(body, "<form class=\"public-filters\" method=\"get\" action=\"/precons\" aria-label=\"Filter precons\"><label class=\"search\">Search<input type=\"search\" name=\"q\" value=\"{}\" maxlength=\"200\" placeholder=\"Deck, commander or set\"></label><label>Colors<input name=\"c\" value=\"{}\" maxlength=\"5\" placeholder=\"WUBRG or C\" aria-describedby=\"color-help\"></label><label>Color match<select name=\"m\">", e(&filters.q), e(&filters.c)).unwrap();
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
    body.push_str("</select></label><label>Sort<select name=\"s\">");
    for (value, label) in [
        ("rank", "Simulated rank"),
        ("real", "Real-game win rate"),
        ("name", "Name"),
        ("year", "Newest release"),
        ("sealed", "Sealed market price"),
    ] {
        write!(
            body,
            "<option value=\"{value}\"{}>{label}</option>",
            selected(
                value,
                if filters.s.is_empty() {
                    "rank"
                } else {
                    &filters.s
                }
            )
        )
        .unwrap();
    }
    write!(body, "</select></label><button type=\"submit\">Apply filters</button><a href=\"/precons\">Clear</a></form><p class=\"dim\" id=\"color-help\">Colors: W white, U blue, B black, R red, G green, C colorless. Combine letters to filter.</p><p>{} of {total} precons. Simulated and real-game results use different fields and are shown separately.</p>", data.precons.len()).unwrap();
    if data.precons.is_empty() {
        body.push_str(if total == 0 {
            "<p>No stock lists have been imported yet.</p>"
        } else {
            "<p>No precons match these filters. <a href=\"/precons\">Clear the filters</a>.</p>"
        });
    } else {
        body.push_str("<div class=\"public-table-wrap\"><table class=\"public-table\"><caption>Stock precon comparison</caption><thead><tr><th scope=\"col\">Deck</th><th scope=\"col\">Simulated results</th><th scope=\"col\">Real games</th><th scope=\"col\">Market references</th></tr></thead><tbody>");
        for p in &data.precons {
            write!(body, "<tr><th scope=\"row\"><a href=\"/precons/{}\">{}</a><small>{}</small><small>{}, {}. Colors: {}</small></th><td>{}</td><td>{}</td><td>{}</td></tr>", e(&p.id), e(&p.name), e(&p.commanders.join(" and ")), e(p.set_name.as_deref().unwrap_or(&p.set_code)), e(p.released.as_deref().unwrap_or("release date unavailable")), e(if p.color_identity.is_empty() { "C" } else { &p.color_identity }), sim(p), real(p), price(p, false)).unwrap();
        }
        body.push_str("</tbody></table></div>");
    }
    Ok(response(
        &headers,
        page(
            &st,
            "/precons",
            "Commander precon rankings and stock decklists",
            "Compare stock Commander precons with published simulation results, real-game evidence, decklists and dated market prices. No account needed.",
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
    let mut body = "<p><a href=\"/precons\">Back to precons</a></p>".to_string();
    if let Some(art) = &p.art {
        write!(body, "<div class=\"public-art\"><img src=\"{}\" alt=\"\" fetchpriority=\"high\"><div class=\"art-wash\"></div><div class=\"art-heading\"><p>Stock Commander precon</p><h1>{}</h1><p>{}</p></div><p class=\"art-credit\">Art by {}, © Wizards of the Coast.</p></div>", e(&art.url), e(&p.name), e(&p.commanders.join(" and ")), e(art.artist.as_deref().unwrap_or(""))).unwrap();
    } else {
        write!(
            body,
            "<h1>{}</h1><p>{}</p>",
            e(&p.name),
            e(&p.commanders.join(" and "))
        )
        .unwrap();
    }
    write!(body, "<p class=\"dim\">{}, {}. Colors: {}. {} cards.</p><div class=\"public-actions\"><a class=\"button primary\" href=\"/precons/{}/decklist.txt\">Download stock list</a><a class=\"button\" href=\"/decks/lab/p/{}\">Sign in to save this deck</a><a class=\"button\" href=\"/decks/lab/try?precon={}\">Sign in to try a change</a></div>", e(p.set_name.as_deref().unwrap_or(&p.set_code)), e(p.released.as_deref().unwrap_or("release date unavailable")), e(if p.color_identity.is_empty() { "C" } else { &p.color_identity }), p.card_count, e(&p.id), e(&p.id), e(&p.id)).unwrap();
    body.push_str(&run_line(data.publication.as_ref()));
    body.push_str(
        "<div class=\"public-evidence\"><section class=\"public-panel\"><h2>Simulated results</h2>",
    );
    body.push_str(&sim(p));
    if let Some(r) = &p.rating {
        if let (Some([lo, hi]), Some(pubn)) = (r.rank_interval, data.publication.as_ref()) {
            write!(
                body,
                "<p>Rank range {lo} to {hi}, out of {} precons ({:.0}% interval).</p>",
                pubn.field_size,
                pubn.interval_level * 100.0
            )
            .unwrap();
        }
        write!(body, "<p>Observed simulation win rate: {} ({}). Model win rate estimates a four-player pod against this benchmark’s field.</p>", pct(r.observed_win_rate), range(r.observed_interval)).unwrap();
        if let Some(strength) = r.strength {
            write!(
                body,
                "<p>Model strength: {strength:.2} × the field’s geometric mean{}.</p>",
                r.strength_interval
                    .map(|v| format!(", interval {:.2} to {:.2}", v[0], v[1]))
                    .unwrap_or_default()
            )
            .unwrap();
        }
        for reason in &r.reasons {
            write!(body, "<p class=\"public-note\">{}</p>", e(reason)).unwrap();
        }
    }
    body.push_str("</section><section class=\"public-panel\"><h2>Real games</h2>");
    body.push_str(&real(p));
    body.push_str("<p class=\"dim\">Playgroup.gg reports stock-deck games on a four-player baseline. Its opponents and pilots differ from the simulation. See the source for stock-matching and eligibility rules.</p></section>");
    body.push_str(&price(p, true));
    body.push_str("</div>");
    if !p.partly_supported.is_empty() {
        write!(body, "<section class=\"public-panel\"><h2>Known card support gaps</h2><p>The catalog flags these stock cards as partly implemented in Phase: {}. Coverage is a separate signal from the published run’s confidence.</p></section>", e(&p.partly_supported.join(", "))).unwrap();
    }
    write!(body, "<section><h2>Reviews and upgrades</h2><p><a href=\"https://edhrec.com/precons/{}\">Open this precon on EDHREC</a> for popular additions/cuts and guide links. Popularity does not establish improved win rates; upgraded lists are separate from this stock benchmark.</p></section><section><h2>Stock decklist</h2><p>Catalog updated {}. {} Card images and details are served by Scryfall.</p>", e(&p.id), e(p.catalog_updated_at.as_deref().unwrap_or("date unavailable")), p.source_url.as_ref().map(|u| format!("<a href=\"{}\">MTGJSON source</a>.", e(u))).unwrap_or_default()).unwrap();
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
            "<h3>{label} ({})</h3><ul class=\"public-card-list\">",
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
            write!(
                body,
                "<li><a href=\"{}\">{image}<span>{} {}<small>{}</small></span></a></li>",
                e(&c.scryfall_url),
                c.qty,
                e(&c.name),
                e(c.type_line.as_deref().unwrap_or("Card details on Scryfall"))
            )
            .unwrap();
        }
        body.push_str("</ul>");
    }
    write!(body, "<details><summary>Select the list to copy</summary><textarea readonly rows=\"14\" aria-label=\"Stock decklist\">{}</textarea></details></section>", e(&deck_text(&data))).unwrap();
    Ok(response(
        &headers,
        page(
            &st,
            &format!("/precons/{slug}"),
            &format!("{}: stock list and results", p.name),
            &format!(
                "{} stock Commander precon: decklist, published simulation evidence, real-game results and dated market references.",
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
    let mut body = "<div class=\"public-intro\"><p class=\"eyebrow\">Evidence you can inspect</p><h1>How the rankings work.</h1><p>Stock lists, explicit sources and uncertainty beside the numbers.</p></div>".to_string();
    body.push_str(&run_line(snapshot.as_ref().map(|s| &s.publication)));
    body.push_str("<section class=\"public-prose\"><h2>What the simulation measures</h2><p>AI pilots play every seat in four-player Commander games. A Plackett-Luce model estimates each stock list’s strength and chance of winning against that run’s field. Model win rate and observed simulation win rate are different measures. Neither promises the same result at your table.</p><p>The intervals use the published analysis’s level. A rank range shows uncertainty in ordering. Few games mean less precision; more games do not remove an engine or AI mistake. A deck marked unreliable remains browsable but is kept out of the trusted simulated ordering. Confidence not assessed means the run has no deck-specific assessment, not that the deck has been validated.</p><h2>Which games count</h2><p>Failures, panics and time caps are excluded from scored simulation results. Draws and turn/action caps count as games with no winner under the existing Lab method. A failed game is not a deck loss. Results from different engine, card-data or runner versions are not pooled in a public publication.</p><h2>The opponent field matters</h2><p>Every public benchmark is a reviewed stock-precon field. Results from personal upgrades and mixed private tournaments are not published by filtering out their private rows. Engine and AI limitations can favor some strategies. Phase and Forge results are published separately when an appropriate benchmark exists.</p>");
    if let Some(snapshot) = &snapshot {
        let p = &snapshot.publication;
        write!(body, "<h2>Current publication</h2><dl><dt>Publication</dt><dd>{}</dd><dt>Analysis date</dt><dd>{}</dd><dt>Published</dt><dd>{}</dd><dt>Field</dt><dd>{} stock precons</dd><dt>Scored games</dt><dd>{}</dd><dt>Failures excluded</dt><dd>{}</dd><dt>Time caps excluded</dt><dd>{}</dd><dt>Games with no winner</dt><dd>{}</dd><dt>Interval level</dt><dd>{:.0}%</dd></dl>", e(&p.id), e(&p.analysed_at), e(&p.published_at), p.field_size, p.scored_games, p.failed_games, p.time_caps, p.no_winner, p.interval_level * 100.0).unwrap();
        for note in &p.notes {
            write!(body, "<p>{}</p>", e(note)).unwrap();
        }
        write!(body, "<details><summary>Engine and method details</summary><dl><dt>Engine</dt><dd>{}</dd><dt>AI</dt><dd>{}</dd><dt>Card data</dt><dd>{}</dd><dt>Runner</dt><dd>{}</dd><dt>Public method</dt><dd>{}</dd></dl></details><details><summary>Stock precons in this benchmark</summary><ul>", e(&p.engine), e(&p.difficulty), e(&p.card_data), e(&p.runner), e(&p.method)).unwrap();
        for slug in snapshot.ratings.keys() {
            write!(
                body,
                "<li><a href=\"/precons/{}\">{}</a></li>",
                e(slug),
                e(slug)
            )
            .unwrap();
        }
        body.push_str("</ul></details>");
    }
    body.push_str("<h2>Real-game evidence</h2><p><a href=\"https://playgroup.gg/commander/precons\">Playgroup.gg</a> supplies separately attributed aggregate stock-precon results. Its win rates use a four-player baseline, and its pilots and opponents differ from our simulation. Catalog ranks are among the mapped precons, not necessarily the source’s full ranking. Each result carries its own fetch date; a missing date is shown as unavailable. See the source for its current eligibility and stock-matching rules.</p><h2>Lists, prices and guides</h2><p><a href=\"https://mtgjson.com/data-models/deck/\">MTGJSON</a> supplies stock-list data through Yama’s catalog import. A publication is tied to the stock list that was checked when it was published. A changed list loses its old rating until reviewed again; new decks remain unrated.</p><p>Singles replacement estimates use TCGplayer market data via <a href=\"https://scryfall.com\">Scryfall</a>. Sealed references use TCGplayer product data via <a href=\"https://tcgcsv.com\">TCGCSV</a>. Missing prices stay missing. Sources refresh independently of published simulations, and each price shows its own date. Neither estimate proves store stock, a checkout quote or resale proceeds.</p><p><a href=\"https://edhrec.com/precons\">EDHREC</a> links provide upgrade ideas and guides. Deckbuilding popularity, reviewer opinion and price are not mixed into a performance score. Yama does not currently publish a combined consensus ranking.</p><h2>Publication and privacy</h2><p>Publishing is deliberate. A new imported Lab run does not automatically replace the public ranking. Only the stock catalog and reviewed results are public; personal decks, collections, plans, games, experiments and account information remain private. Reading these pages does not start simulations or require sign-in.</p><h2>Content rights</h2><p>All rights reserved in Yama’s original software, written analysis and presentation. Third-party material remains with its respective owners. This notice does not claim exclusive rights in underlying facts, game rules or ideas. See <a href=\"/tos/#rights\">content rights and reuse</a>.</p></section>");
    Ok(response(
        &headers,
        page(
            &st,
            "/precons/methodology",
            "Precon ranking methodology",
            "How Yama publishes stock Commander precon simulation results, uncertainty, real-game sources, prices and content rights.",
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
    let mut body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">".to_string();
    for path in ["/precons".to_string(), "/precons/methodology".to_string()]
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
