//! Deck links. Yama reads a deck from a link only where the site allows it (docs/deck-import.md
//! has what each site's robots.txt and terms said on 22 Oct 2026). For every other site a pasted
//! link gets the steps to copy the list instead.
//!
//! Fetching is opt-in per site with YAMA_DECK_LINK_SOURCES (comma-separated, e.g. "archidekt"),
//! empty by default: Archidekt's terms don't allow automated requests without permission, so it
//! stays off until Bryan has it. Fetches run on the server only, with a descriptive User-Agent, a
//! short timeout and a size cap, under the per-account import limit.

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Site {
    Moxfield,
    Archidekt,
    TappedOut,
    Deckstats,
    Edhrec,
    MtgGoldfish,
    Scryfall,
    ManaBox,
    Aetherhub,
    Other,
}

impl Site {
    pub fn key(self) -> &'static str {
        match self {
            Site::Moxfield => "moxfield",
            Site::Archidekt => "archidekt",
            Site::TappedOut => "tappedout",
            Site::Deckstats => "deckstats",
            Site::Edhrec => "edhrec",
            Site::MtgGoldfish => "mtggoldfish",
            Site::Scryfall => "scryfall",
            Site::ManaBox => "manabox",
            Site::Aetherhub => "aetherhub",
            Site::Other => "other",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Site::Moxfield => "Moxfield",
            Site::Archidekt => "Archidekt",
            Site::TappedOut => "TappedOut",
            Site::Deckstats => "Deckstats",
            Site::Edhrec => "EDHREC",
            Site::MtgGoldfish => "MTGGoldfish",
            Site::Scryfall => "Scryfall",
            Site::ManaBox => "ManaBox",
            Site::Aetherhub => "Aetherhub",
            Site::Other => "that site",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeckLink {
    pub site: Site,
    pub url: String,
    /// The site's deck id, where the link has one.
    pub id: Option<String>,
}

/// The pasted text as a deck link, if it is just a link (or a link with a title around it, as
/// phones share it: "Atraxa Superfriends https://moxfield.com/decks/abc").
pub fn find_link(text: &str) -> Option<DeckLink> {
    let t = text.trim();
    // A real list has many lines; a link share has one or two.
    if t.lines().filter(|l| !l.trim().is_empty()).count() > 3 {
        return None;
    }
    let start = t.find("https://").or_else(|| t.find("http://"))?;
    let url: String = t[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    let url = url.trim_end_matches(['.', ',', ')', '>', '"', '\'']).to_string();
    let after_scheme = url.split_once("://")?.1;
    let (host, path) = after_scheme.split_once('/').unwrap_or((after_scheme, ""));
    let host = host.to_lowercase();
    let host = host.trim_start_matches("www.").trim_start_matches("m.");
    let segs: Vec<&str> = path.split(['?', '#']).next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let (site, id) = match host {
        "moxfield.com" => (Site::Moxfield, (segs.first() == Some(&"decks")).then(|| segs.get(1).map(|s| s.to_string())).flatten()),
        "archidekt.com" => (
            Site::Archidekt,
            (segs.first() == Some(&"decks")).then(|| segs.get(1).filter(|s| s.chars().all(|c| c.is_ascii_digit())).map(|s| s.to_string())).flatten(),
        ),
        "tappedout.net" => (Site::TappedOut, (segs.first() == Some(&"mtg-decks")).then(|| segs.get(1).map(|s| s.to_string())).flatten()),
        "deckstats.net" => (Site::Deckstats, None),
        "edhrec.com" => (Site::Edhrec, None),
        "mtggoldfish.com" => (Site::MtgGoldfish, None),
        "scryfall.com" => (Site::Scryfall, None),
        "manabox.app" => (Site::ManaBox, None),
        "aetherhub.com" => (Site::Aetherhub, None),
        _ => (Site::Other, None),
    };
    Some(DeckLink { site, url, id })
}

/// Sites the server may fetch from (YAMA_DECK_LINK_SOURCES).
pub fn enabled(site: Site) -> bool {
    std::env::var("YAMA_DECK_LINK_SOURCES")
        .unwrap_or_default()
        .split(',')
        .any(|s| s.trim().eq_ignore_ascii_case(site.key()))
}

/// The most a fetched deck may weigh (Archidekt's JSON for a 100-card deck is ~200 KB).
pub const MAX_BYTES: usize = 3 << 20;

/// Fetch an Archidekt deck's JSON. Only called when `enabled(Site::Archidekt)`.
pub async fn fetch_archidekt(http: &reqwest::Client, id: &str) -> Result<String, String> {
    let url = format!("https://archidekt.com/api/decks/{id}/");
    let resp = http
        .get(&url)
        .header(reqwest::header::USER_AGENT, concat!("Yama/", env!("CARGO_PKG_VERSION"), " (+https://yama.ing/about/; imports one deck a signed-in person asked for)"))
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Archidekt didn't answer ({e})."))?;
    match resp.status().as_u16() {
        200 => {}
        404 => return Err("Archidekt says that deck doesn't exist. Check the link.".into()),
        401 | 403 => return Err("That Archidekt deck is private. Make it public or unlisted, or copy the list instead.".into()),
        429 => return Err("Archidekt asked Yama to slow down. Try again in a minute, or copy the list instead.".into()),
        s => return Err(format!("Archidekt answered with an error ({s}). Copy the list instead.")),
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("That deck is too big to import by link.".into());
    }
    let mut body = Vec::new();
    let mut stream = resp;
    while let Some(chunk) = stream.chunk().await.map_err(|e| format!("Archidekt's answer broke off ({e})."))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("That deck is too big to import by link.".into());
        }
    }
    String::from_utf8(body).map_err(|_| "Archidekt sent something that isn't text.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_recognized_with_their_ids() {
        let l = find_link("https://www.moxfield.com/decks/AbC-12_xyz").unwrap();
        assert_eq!((l.site, l.id.as_deref()), (Site::Moxfield, Some("AbC-12_xyz")));
        let l = find_link("Check my deck: https://archidekt.com/decks/1234567/atraxa_superfriends?tab=list").unwrap();
        assert_eq!((l.site, l.id.as_deref()), (Site::Archidekt, Some("1234567")));
        let l = find_link("https://tappedout.net/mtg-decks/atraxa-counters/").unwrap();
        assert_eq!((l.site, l.id.as_deref()), (Site::TappedOut, Some("atraxa-counters")));
        assert_eq!(find_link("https://edhrec.com/average-decks/atraxa-praetors-voice").unwrap().site, Site::Edhrec);
        assert_eq!(find_link("https://example.com/my-list").unwrap().site, Site::Other);
        // Archidekt deck ids are numbers.
        assert_eq!(find_link("https://archidekt.com/decks/folder").unwrap().id, None);
    }

    #[test]
    fn a_list_is_not_a_link() {
        assert!(find_link("1 Sol Ring\n1 Arcane Signet\n1 Command Tower\n1 Island").is_none());
        assert!(find_link("1 Sol Ring").is_none());
    }

    #[test]
    fn fetching_is_off_unless_turned_on() {
        // The test environment never sets YAMA_DECK_LINK_SOURCES.
        if std::env::var("YAMA_DECK_LINK_SOURCES").is_err() {
            assert!(!enabled(Site::Archidekt));
            assert!(!enabled(Site::Moxfield));
        }
    }
}
