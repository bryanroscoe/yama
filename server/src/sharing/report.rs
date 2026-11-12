//! The Report link's page for a shared deck (`/d/<token>/report`) and a profile
//! (`/u/<handle>/report`): one short form drawn by the server, no script, no account. It posts
//! to `/report`, which stores the report (`moderation.rs`) and sends the browser back to the
//! form's address with a thank-you. The deck's token travels in the form's body, never in the
//! address of the write, so it stays out of the write log (`request_log.rs`).
use super::html::{not_found, page, response};
use super::*;
use crate::moderation::{MAX_DETAILS, REASONS, Target, file_report};
use crate::public_page::e;
use axum::extract::Query;
use axum::response::Redirect;
use std::fmt::Write;

#[derive(Deserialize, Default)]
pub(super) struct Shown {
    /// Set on the way back from a stored report.
    #[serde(default)]
    sent: Option<String>,
    /// Set on the way back from a form sent without a reason.
    #[serde(default)]
    missing: Option<String>,
}

/// What a report page is about: the page's own address, what to call it, and what the form sends.
struct Subject {
    back: String,
    title: String,
    line: String,
    kind: &'static str,
    target: String,
}

fn form(st: &AppState, headers: &HeaderMap, subject: &Subject, shown: &Shown) -> Response {
    let mut body = String::from("<section class=\"report-form\">");
    write!(body, "<a class=\"back-link\" href=\"{}\">← Back</a>", e(&subject.back)).unwrap();
    if shown.sent.is_some() {
        write!(
            body,
            "<h1>Thanks, the report was sent</h1><p class=\"dim\">A moderator will look at it. Yama keeps what you wrote and nothing about who you are, so you won't get a reply.</p><p><a class=\"button\" href=\"{}\">Go back</a></p></section>",
            e(&subject.back)
        )
        .unwrap();
        return response(headers, page(st, &format!("{}/report", subject.back), "Report sent", "Thanks for the report.", None, &body));
    }
    write!(
        body,
        "<h1>{}</h1><p class=\"dim\">This goes to Yama's moderator, not to {}. No account is needed and nothing about you is kept with the report.</p>",
        e(&subject.title),
        e(&subject.line)
    )
    .unwrap();
    if shown.missing.is_some() {
        body.push_str("<p class=\"report-error\" role=\"alert\">Pick what's wrong with it, then send.</p>");
    }
    write!(
        body,
        "<form method=\"post\" action=\"/report\"><input type=\"hidden\" name=\"kind\" value=\"{}\"><input type=\"hidden\" name=\"target\" value=\"{}\"><fieldset><legend>What's wrong with it?</legend>",
        subject.kind,
        e(&subject.target)
    )
    .unwrap();
    for (value, label) in REASONS {
        write!(body, "<label class=\"choice\"><input type=\"radio\" name=\"reason\" value=\"{value}\" required> {}</label>", e(label)).unwrap();
    }
    write!(
        body,
        "</fieldset><label for=\"report-details\">Anything the moderator should know (optional)</label><textarea id=\"report-details\" name=\"details\" rows=\"4\" maxlength=\"{MAX_DETAILS}\"></textarea><div class=\"report-actions\"><button class=\"button primary\" type=\"submit\">Send report</button><a class=\"text-action\" href=\"{}\">Cancel</a></div></form></section>",
        e(&subject.back)
    )
    .unwrap();
    response(headers, page(st, &format!("{}/report", subject.back), &subject.title, "Report a page to Yama's moderator.", None, &body))
}

/// A shared deck as a report needs it: its id, its owner and what its page calls it.
struct DeckRef {
    id: String,
    owner_id: String,
    name: String,
    public: bool,
}

/// By its token, with the same "not found" as the deck's page for anything not shared.
async fn deck_ref(pool: &SqlitePool, token: &str) -> AppResult<DeckRef> {
    if !valid_token(token) {
        return Err(AppError::NotFound("deck"));
    }
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT d.id, d.owner_id, d.name, d.visibility FROM decks d JOIN users u ON u.id = d.owner_id
          WHERE d.share_token = ? AND d.visibility IN ('link', 'public') AND d.archived = 0 AND d.taken_down_at IS NULL AND u.disabled_at IS NULL",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    let (id, owner_id, name, visibility) = row.ok_or(AppError::NotFound("deck"))?;
    Ok(DeckRef { id, owner_id, name, public: visibility == "public" })
}

fn deck_subject(token: &str, d: &DeckRef) -> Subject {
    let name = crate::moderation::text::public(&d.name, d.public);
    Subject { back: format!("/d/{token}"), title: "Report this deck".into(), line: format!("the owner of \u{201c}{name}\u{201d}"), kind: "deck", target: token.to_string() }
}

fn profile_subject(handle: &str) -> Subject {
    Subject { back: format!("/u/{handle}"), title: "Report this profile".into(), line: format!("@{handle}"), kind: "profile", target: handle.to_string() }
}

pub(super) async fn deck_form(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(token): Path<String>, Query(shown): Query<Shown>) -> AppResult<Response> {
    limit(&st, &address)?;
    match deck_ref(&st.pool, &token).await {
        Ok(d) => Ok(form(&st, &headers, &deck_subject(&token, &d), &shown)),
        Err(AppError::NotFound(_)) => Ok(not_found(&st, "Deck")),
        Err(err) => Err(err),
    }
}

pub(super) async fn profile_form(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>, Query(shown): Query<Shown>) -> AppResult<Response> {
    limit(&st, &address)?;
    match sharer_by_handle(&st.pool, &handle).await {
        Ok(s) => Ok(form(&st, &headers, &profile_subject(&s.handle.unwrap_or_default()), &shown)),
        Err(AppError::NotFound(_)) => Ok(not_found(&st, "Profile")),
        Err(err) => Err(err),
    }
}

#[derive(Deserialize)]
pub(super) struct Sent {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    details: String,
}

/// A page that says why a report wasn't taken, in the site's frame (a form post gets a page
/// back, not the API's JSON).
fn refused(st: &AppState, status: StatusCode, title: &str, message: &str) -> Response {
    let body = format!("<section class=\"empty-state\"><h1>{}</h1><p>{}</p><p><a href=\"/\">Go to Yama</a></p></section>", e(title), e(message));
    let mut res = (status, axum::response::Html(page(st, "/", title, message, None, &body))).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex"));
    crate::public_page::secure(&mut res);
    res
}

/// One report at a time from the limits' check to their count (reports are rare), so reports
/// arriving together can't all pass a limit before any is counted.
static ADMISSION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Store a report and send the browser back to the form's page. Limited per address and for
/// the whole server; both are checked before either is counted. An address's own allowance
/// counts every report it is thanked for, stored or not, so the limit never tells a sender
/// whether someone else already reported the page. The server's allowance counts only stored
/// reports, so repeating an open report can't use it up for everyone else. Every request also
/// counts against the public pages' own limit.
pub(super) async fn submit(State(st): State<AppState>, address: ClientAddress, axum::Form(sent): axum::Form<Sent>) -> AppResult<Response> {
    if let Err(AppError::TooManyRequests { message, .. }) = limit(&st, &address) {
        return Ok(refused(&st, StatusCode::TOO_MANY_REQUESTS, "Too many requests", &message));
    }
    let key = address_key(address.0);
    let _admitted = ADMISSION.lock().await;
    if let Err(AppError::TooManyRequests { message, .. }) = st.limits.reports_address.allows(&key).and_then(|()| st.limits.reports.allows("all")) {
        return Ok(refused(&st, StatusCode::TOO_MANY_REQUESTS, "Too many reports", &message));
    }
    let (back, target_deck, owner) = match sent.kind.as_str() {
        "deck" => match deck_ref(&st.pool, &sent.target).await {
            Ok(d) => (format!("/d/{}/report", sent.target), Some(d.id), d.owner_id),
            Err(AppError::NotFound(_)) => return Ok(not_found(&st, "Deck")),
            Err(err) => return Err(err),
        },
        "profile" => match sharer_by_handle(&st.pool, &sent.target).await {
            Ok(s) => (format!("/u/{}/report", s.handle.clone().unwrap_or_default()), None, s.id),
            Err(AppError::NotFound(_)) => return Ok(not_found(&st, "Profile")),
            Err(err) => return Err(err),
        },
        _ => return Ok(not_found(&st, "Page")),
    };
    if !REASONS.iter().any(|(r, _)| *r == sent.reason) {
        return Ok(Redirect::to(&format!("{back}?missing=1")).into_response());
    }
    let target = match &target_deck {
        Some(id) => Target::Deck { id, owner: &owner },
        None => Target::Profile { owner: &owner },
    };
    let stored = file_report(&st.pool, target, &sent.reason, &sent.details).await?;
    st.limits.reports_address.record(&key);
    if stored {
        st.limits.reports.record("all");
    }
    Ok(Redirect::to(&format!("{back}?sent=1")).into_response())
}
