//! Deck import: read a pasted list, an uploaded file or (where the site allows it) a link, and
//! show what it would make before anything is saved. Saving goes through the deck routes
//! (`POST /api/decks`, `PUT /api/decks/{id}`) with the resolved cards and their printings.
//!
//! The import screen's guides (how to get a list out of Moxfield, Archidekt, Arena…) live in the
//! web app (web/src/decks/guides.ts); docs/deck-import.md records what each site allows.

pub mod formats;
pub mod links;
pub mod names;

use crate::auth::CurrentUser;
use crate::decks::Board;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use formats::{Format, ImportLine, Parsed};
use links::Site;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/decks/import/preview", post(preview))
}

/// The most text one preview reads (a 100-card list is ~3 KB; a big collection CSV ~1 MB).
const MAX_TEXT: usize = 2 << 20;
/// The most card lines one preview matches.
const MAX_LINES: usize = 2_000;

#[derive(Deserialize)]
struct PreviewRequest {
    text: String,
    /// The uploaded file's name, if any: tells CSV and .dek apart and names the deck.
    file_name: Option<String>,
}

/// A card as the import screen shows and checks it.
#[derive(Serialize, Clone, Debug, sqlx::FromRow)]
pub struct CardInfo {
    pub oracle_id: String,
    pub name: String,
    pub type_line: String,
    pub mana_cost: Option<String>,
    pub cmc: f64,
    pub color_identity: String,
    pub image_small: Option<String>,
    pub image_normal: Option<String>,
    pub artist: Option<String>,
    #[sqlx(skip)]
    pub can_be_commander: bool,
    /// A basic land, or a card whose text lets a deck run any number (or many) of it.
    #[sqlx(skip)]
    pub any_number: bool,
    #[sqlx(skip)]
    pub partner: bool,
    #[serde(skip)]
    pub oracle_text: String,
    #[serde(skip)]
    pub keywords: String,
    #[serde(skip)]
    pub layout: Option<String>,
}

impl CardInfo {
    /// Tokens, emblems and art cards aren't deck cards (an exact name match can find a token).
    pub fn is_deck_card(&self) -> bool {
        !matches!(self.layout.as_deref(), Some("token" | "double_faced_token" | "art_series" | "emblem")) && !self.type_line.starts_with("Token")
    }

    fn finish(mut self) -> Self {
        let t = &self.type_line;
        let text = self.oracle_text.to_lowercase();
        let front = t.split(" // ").next().unwrap_or(t);
        self.can_be_commander = (front.contains("Legendary") && (front.contains("Creature") || front.contains("Background")))
            || text.contains("can be your commander");
        self.any_number = t.contains("Basic") && t.contains("Land") || text.contains("a deck can have any number of cards named") || text.contains("a deck can have up to");
        self.partner = text.contains("partner") || text.contains("choose a background") || self.keywords.to_lowercase().contains("partner") || front.contains("Background");
        self
    }
}

pub async fn card_info(pool: &SqlitePool, oracle_id: &str) -> AppResult<Option<CardInfo>> {
    let row: Option<CardInfo> = sqlx::query_as(
        "SELECT oracle_id, name, type_line, mana_cost, cmc, color_identity, image_small, image_normal, artist, oracle_text, keywords, layout
         FROM cards WHERE oracle_id = ?",
    )
    .bind(oracle_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(CardInfo::finish))
}

#[derive(Serialize, Debug)]
struct PreviewCard {
    #[serde(flatten)]
    card: CardInfo,
    qty: i64,
    board: Board,
    maybe: bool,
    set_code: Option<String>,
    collector_number: Option<String>,
    finish: Option<String>,
    /// The named printing exists in Yama's card data (`None` when no printing was named).
    print_found: Option<bool>,
    /// That printing's image, to show the art the person picked.
    print_image: Option<String>,
    /// The name as the source wrote it, when it was matched loosely ("Lim-Dul's Vault").
    written_as: Option<String>,
    /// The source marked this copy as a proxy.
    proxy: bool,
}

#[derive(Serialize, Debug)]
struct UnknownLine {
    name: String,
    qty: i64,
    board: Board,
    maybe: bool,
    set_code: Option<String>,
    collector_number: Option<String>,
    finish: Option<String>,
    suggestions: Vec<CardInfo>,
}

#[derive(Serialize, Debug)]
struct PreviewDeck {
    name: Option<String>,
    cards: Vec<PreviewCard>,
    unknown: Vec<UnknownLine>,
    /// The source said who the commander is.
    commander_marked: bool,
    /// Yama guessed the commander (first card, or the block a blank line set apart); the screen
    /// asks the person to confirm.
    commander_guessed: bool,
}

#[derive(Serialize, Debug)]
struct LinkInfo {
    site: Site,
    site_name: &'static str,
    url: String,
    /// Yama read the deck from the link.
    fetched: bool,
    /// Why not, and what to do instead.
    message: Option<String>,
}

#[derive(Serialize, Debug)]
struct Preview {
    format: Option<Format>,
    format_label: Option<&'static str>,
    link: Option<LinkInfo>,
    decks: Vec<PreviewDeck>,
    skipped: Vec<String>,
}

async fn preview(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<PreviewRequest>) -> AppResult<Json<Preview>> {
    st.limits.deck_writes.check_user(&user)?;
    if req.text.len() > MAX_TEXT {
        return Err(AppError::bad("that's too much text for one deck (2 MB at most)"));
    }
    if req.text.trim().is_empty() {
        return Err(AppError::bad("paste a deck list, a link, or choose a file"));
    }
    let mut link = None;
    let parsed: Parsed = match links::find_link(&req.text) {
        Some(l) => {
            if l.site == Site::Archidekt
                && links::enabled(Site::Archidekt)
                && let Some(id) = &l.id
            {
                st.limits.imports.check_user(&user)?;
                match links::fetch_archidekt(&st.http, id).await {
                    Ok(body) => {
                        let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| AppError::bad("Archidekt sent something Yama couldn't read. Copy the list instead."))?;
                        link = Some(LinkInfo { site: l.site, site_name: l.site.name(), url: l.url.clone(), fetched: true, message: None });
                        formats::parse_archidekt_json(&v)
                    }
                    Err(message) => {
                        return Ok(Json(Preview {
                            format: None,
                            format_label: None,
                            link: Some(LinkInfo { site: l.site, site_name: l.site.name(), url: l.url, fetched: false, message: Some(message) }),
                            decks: vec![],
                            skipped: vec![],
                        }));
                    }
                }
            } else {
                return Ok(Json(Preview {
                    format: None,
                    format_label: None,
                    link: Some(LinkInfo { site: l.site, site_name: l.site.name(), url: l.url, fetched: false, message: Some(link_message(l.site)) }),
                    decks: vec![],
                    skipped: vec![],
                }));
            }
        }
        None => formats::parse_any(&req.text, req.file_name.as_deref()),
    };
    if parsed.decks.iter().map(|d| d.lines.len()).sum::<usize>() > MAX_LINES {
        return Err(AppError::bad("that's more cards than Yama reads at once (2,000 lines)"));
    }
    let mut index: Option<names::NameIndex> = None;
    let mut decks = Vec::new();
    for d in parsed.decks {
        decks.push(build_deck(&st.pool, &mut index, d).await?);
    }
    Ok(Json(Preview { format: Some(parsed.format), format_label: Some(parsed.format.label()), link, decks, skipped: parsed.skipped }))
}

/// What a pasted link gets instead of a deck.
fn link_message(site: Site) -> String {
    match site {
        Site::Moxfield => "Moxfield doesn't let other apps read its decks, so Yama can't open the link. Copy the list from Moxfield instead (steps below); it takes a few seconds.".into(),
        Site::Archidekt => "Yama can't read Archidekt links yet: Archidekt's terms need its permission first. Copy the list from Archidekt instead (steps below).".into(),
        Site::Other => "Yama can't read decks from links. Copy the list from the deck's page and paste it here.".into(),
        s => format!("Yama can't read {} links. Copy the list from {} instead (steps below).", s.name(), s.name()),
    }
}

async fn build_deck(pool: &SqlitePool, index: &mut Option<names::NameIndex>, d: formats::ParsedDeck) -> AppResult<PreviewDeck> {
    let mut cards: Vec<PreviewCard> = Vec::new();
    let mut unknown: Vec<UnknownLine> = Vec::new();
    let names: Vec<String> = d.lines.iter().map(|l| l.name.clone()).collect();
    let exact = crate::cards::resolve_names(pool, &names).await?;
    let mut info_cache: HashMap<String, Option<CardInfo>> = HashMap::new();
    for l in d.lines {
        let mut exact_hit = exact.get(&l.name).cloned();
        if let Some(oid) = &exact_hit {
            if !info_cache.contains_key(oid) {
                let i = card_info(pool, oid).await?;
                info_cache.insert(oid.clone(), i);
            }
            if !info_cache.get(oid).cloned().flatten().is_some_and(|i| i.is_deck_card()) {
                exact_hit = None;
            }
        }
        let (oid, written_as) = match exact_hit {
            Some(oid) => (Some(oid), None),
            None => {
                if index.is_none() {
                    *index = Some(names::NameIndex::load(pool).await?);
                }
                match index.as_ref().unwrap().forgiving(&l.name) {
                    Some((_, oid)) => (Some(oid), Some(l.name.clone())),
                    None => (None, None),
                }
            }
        };
        let Some(oid) = oid else {
            let suggestions = {
                let idx = index.as_ref().unwrap();
                let mut out = Vec::new();
                for (_, soid) in idx.suggest(&l.name, 3) {
                    if let Some(i) = card_info(pool, &soid).await? {
                        out.push(i);
                    }
                }
                out
            };
            unknown.push(UnknownLine {
                name: l.name,
                qty: l.qty,
                board: l.board,
                maybe: l.maybe,
                set_code: l.set_code,
                collector_number: l.collector_number,
                finish: l.finish,
                suggestions,
            });
            continue;
        };
        if !info_cache.contains_key(&oid) {
            let i = card_info(pool, &oid).await?;
            info_cache.insert(oid.clone(), i);
        }
        let Some(info) = info_cache.get(&oid).cloned().flatten() else { continue };
        let (print_found, print_image) = printing(pool, &oid, &l).await?;
        // The same card twice (on the same board, same printing) is one row.
        if let Some(existing) = cards.iter_mut().find(|c| {
            c.card.oracle_id == oid && c.board == l.board && c.maybe == l.maybe && c.set_code == l.set_code && c.collector_number == l.collector_number && c.finish == l.finish && c.proxy == l.proxy
        }) {
            existing.qty += l.qty;
            continue;
        }
        cards.push(PreviewCard {
            card: info,
            qty: l.qty,
            board: l.board.clone(),
            maybe: l.maybe,
            set_code: l.set_code.clone(),
            collector_number: l.collector_number.clone(),
            finish: l.finish.clone(),
            print_found,
            print_image,
            written_as,
            proxy: l.proxy,
        });
    }
    // A guessed commander (a block the blank line set apart) that can't lead a deck goes back to
    // the main deck.
    let mut commander_guessed = false;
    if !d.commander_marked {
        for c in cards.iter_mut().filter(|c| c.board == Board::Commander) {
            if c.card.can_be_commander && c.qty == 1 {
                commander_guessed = true;
            } else {
                c.board = Board::Main;
            }
        }
        // No commander at all: the first card, if it can lead a deck (the convention in
        // commander-decks lists, EDHREC and many hand-written lists).
        if !cards.iter().any(|c| c.board == Board::Commander)
            && let Some(first) = cards.iter_mut().find(|c| c.board == Board::Main)
            && first.card.can_be_commander
            && first.qty == 1
        {
            first.board = Board::Commander;
            commander_guessed = true;
        }
        // Still none, and only one card could lead the deck (a CSV or a container list): that one.
        if !cards.iter().any(|c| c.board == Board::Commander) {
            let eligible: Vec<usize> = (0..cards.len()).filter(|&i| cards[i].board == Board::Main && cards[i].card.can_be_commander && cards[i].qty == 1).collect();
            if let [only] = eligible[..] {
                cards[only].board = Board::Commander;
                commander_guessed = true;
            }
        }
    }
    Ok(PreviewDeck { name: d.name, cards, unknown, commander_marked: d.commander_marked, commander_guessed })
}

/// A list read the way the import screen reads it, as the deck routes would save it. The
/// `import-decks` command uses it, so a file keeps the same cards and printings as the same list
/// imported on the web (`toSave` in web/src/decks/importLogic.ts does the same conversion).
pub struct ReadList {
    pub cards: Vec<crate::decks::DeckCard>,
    pub prints: Vec<DeckPrint>,
    /// Lines that matched no card, as written.
    pub unknown: Vec<String>,
}

/// Read a list (any format the import screen reads) and match its names. Unknown lines are left
/// out and named; the web import makes the person fix them first.
pub async fn read_list(pool: &SqlitePool, text: &str, file_name: Option<&str>) -> AppResult<Vec<ReadList>> {
    let parsed = formats::parse_any(text, file_name);
    let mut index = None;
    let mut out = Vec::new();
    for d in parsed.decks {
        let deck = build_deck(pool, &mut index, d).await?;
        let mut cards: Vec<crate::decks::DeckCard> = Vec::new();
        let mut prints: Vec<DeckPrint> = Vec::new();
        for c in &deck.cards {
            match cards.iter_mut().find(|x| x.oracle_id == c.card.oracle_id && x.board == c.board) {
                Some(hit) => hit.qty += c.qty,
                None => cards.push(crate::decks::DeckCard { oracle_id: c.card.oracle_id.clone(), name: c.card.name.clone(), qty: c.qty, board: c.board.clone() }),
            }
            if prints.iter().any(|p| p.oracle_id == c.card.oracle_id) {
                continue;
            }
            let named = c.set_code.is_some() && c.print_found != Some(false);
            if !named && !c.proxy {
                continue;
            }
            prints.push(DeckPrint {
                oracle_id: c.card.oracle_id.clone(),
                set_code: if named { c.set_code.clone().unwrap_or_default() } else { String::new() },
                collector_number: if named { c.collector_number.clone() } else { None },
                finish: c.finish.clone().unwrap_or_else(|| "nonfoil".into()),
                proxy: c.proxy,
            });
        }
        out.push(ReadList { cards, prints, unknown: deck.unknown.into_iter().map(|u| u.name).collect() });
    }
    Ok(out)
}

/// Whether the named printing exists, and its image.
async fn printing(pool: &SqlitePool, oracle_id: &str, l: &ImportLine) -> AppResult<(Option<bool>, Option<String>)> {
    let Some(set) = &l.set_code else { return Ok((None, None)) };
    let row: Option<(Option<String>,)> = match &l.collector_number {
        Some(num) => {
            sqlx::query_as(
                "SELECT image_normal FROM printings WHERE oracle_id = ? AND lower(set_code) = ? AND collector_number = ?
                 ORDER BY lang = 'en' DESC LIMIT 1",
            )
            .bind(oracle_id)
            .bind(set)
            .bind(num)
            .fetch_optional(pool)
            .await?
        }
        None => {
            sqlx::query_as("SELECT image_normal FROM printings WHERE oracle_id = ? AND lower(set_code) = ? ORDER BY lang = 'en' DESC, collector_number LIMIT 1")
                .bind(oracle_id)
                .bind(set)
                .fetch_optional(pool)
                .await?
        }
    };
    Ok(match row {
        Some((img,)) => (Some(true), img),
        None => (Some(false), None),
    })
}

// ── printings kept with a deck ─────────────────────────────────────────────

/// The printing a deck names for a card: what an import said (set, number, finish), and whether
/// the deck's copy is a proxy. A proxy with no printing named has an empty `set_code`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct DeckPrint {
    pub oracle_id: String,
    pub set_code: String,
    pub collector_number: Option<String>,
    /// nonfoil | foil | etched
    pub finish: String,
    #[serde(default)]
    pub proxy: bool,
}

/// Keep these printings for the deck (replacing what it had for the same cards). Called by the
/// deck routes after a save, so it's always the owner's deck.
pub async fn save_prints(pool: &SqlitePool, deck_id: &str, prints: &[DeckPrint]) -> AppResult<()> {
    if prints.is_empty() {
        return Ok(());
    }
    if prints.len() > MAX_LINES {
        return Err(AppError::bad("too many printings"));
    }
    let mut tx = pool.begin().await?;
    for p in prints {
        let set = p.set_code.trim().to_lowercase();
        // No printing is only worth keeping to say the copy is a proxy.
        if (set.is_empty() && !p.proxy) || set.len() > 8 {
            continue;
        }
        let finish = match p.finish.as_str() {
            "foil" | "etched" => p.finish.as_str(),
            _ => "nonfoil",
        };
        sqlx::query(
            "INSERT INTO deck_prints (deck_id, oracle_id, set_code, collector_number, finish, proxy) VALUES (?,?,?,?,?,?)
             ON CONFLICT(deck_id, oracle_id) DO UPDATE SET set_code = excluded.set_code,
               collector_number = excluded.collector_number, finish = excluded.finish, proxy = excluded.proxy",
        )
        .bind(deck_id)
        .bind(&p.oracle_id)
        .bind(&set)
        .bind(p.collector_number.as_deref().map(str::trim).filter(|n| !set.is_empty() && !n.is_empty() && n.len() <= 16))
        .bind(finish)
        .bind(p.proxy)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn deck_prints(pool: &SqlitePool, deck_id: &str) -> AppResult<HashMap<String, DeckPrint>> {
    let rows: Vec<DeckPrint> = sqlx::query_as("SELECT oracle_id, set_code, collector_number, finish, proxy FROM deck_prints WHERE deck_id = ?")
        .bind(deck_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|p| (p.oracle_id.clone(), p)).collect())
}

#[cfg(test)]
mod tests;
