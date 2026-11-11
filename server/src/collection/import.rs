//! Import a collection from another app's export or a pasted list.
//!
//! What it reads: CSV exports by their column names (ManaBox, Moxfield, Archidekt, Deckbox, Dragon
//! Shield, TCGplayer, Mythic Tools and anything shaped like them), and every text list the deck
//! importer reads (`1 Sol Ring`, `1 Sol Ring (C21) 263 *F*`, MTGO, Arena…), through its parsers
//! (`deck_import::formats`). The CSV columns are read here and not by the deck importer's CSV
//! reader, because a collection keeps what a deck doesn't: condition, language, the Scryfall id,
//! signed and altered, and what was paid.
//!
//! - **Matching.** A row's Scryfall id wins if Yama has that printing. Otherwise the name finds
//!   the card (exactly, then forgiving accents and punctuation), and the set and collector number
//!   find the printing. A set or number Yama doesn't have for the card falls back to a regular
//!   printing of it (`decks::collection_printing`), and the report says so. A row whose name
//!   matches nothing but whose set and number do is taken by its number. A row that matches
//!   nothing stays in the report (`unmatched`), as written: never dropped.
//! - **Where.** Every copy goes to one place the person picks: a container of theirs, or unfiled.
//! - **Twice adds nothing.** The ops are named after a hash of the rows read, so the same list
//!   again (retried, or chosen a second time) finds its ops applied and adds nothing; the report
//!   says when it was imported. `top_up` is for a newer export of a collection that is partly in
//!   Yama already: of each printing, finish and language it adds only the copies beyond what the
//!   account has anywhere.
//! - `dry_run` plans everything and writes nothing: the web's preview.
//!
//! The Mythic Tools import (`mythic.rs`) stays the way to bring a Mythic Tools export up to date
//! with its boxes and decks.

use super::{CopyKind, LANGS, MAX_OP_QTY, Op, OpKind, apply_op, owned_copies};
use crate::auth::CurrentUser;
use crate::deck_import::formats;
use crate::deck_import::names::NameIndex;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::sha256_hex;
use axum::extract::{DefaultBodyLimit, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;

/// The most text one import reads, as the Mythic Tools import: about 20,000 rows.
pub const IMPORT_MAX_BYTES: usize = super::mythic::MYTHIC_MAX_BYTES;
/// The same for an account that joined without an invite.
pub const OPEN_IMPORT_MAX_BYTES: usize = super::mythic::OPEN_MYTHIC_MAX_BYTES;
/// The most card lines one import matches.
pub const MAX_LINES: usize = 20_000;
/// Unmatched lines that get "did you mean" names (each is a search of every card name).
const MAX_SUGGESTED: usize = 50;

pub fn router() -> Router<AppState> {
    // The text arrives inside JSON, where quotes and line breaks take two bytes each.
    Router::new().route("/api/collection/import", post(import).layer(DefaultBodyLimit::max(2 * IMPORT_MAX_BYTES)))
}

#[derive(Deserialize)]
struct ImportRequest {
    text: String,
    /// The chosen file's name, if any: tells a CSV from a list.
    file_name: Option<String>,
    /// Where the copies go; `None` for unfiled.
    container_id: Option<String>,
    #[serde(default)]
    top_up: bool,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Default, Clone, Debug)]
pub struct ImportOptions {
    pub dry_run: bool,
    /// Add only the copies beyond what the account already has of each printing, finish and
    /// language.
    pub top_up: bool,
    pub container_id: Option<String>,
}

/// A card line that matched, as the preview lists it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Line {
    pub name: String,
    /// The name as the source wrote it, when it isn't the card's own ("Lim-Dul's Vault").
    pub written_as: Option<String>,
    pub set_code: String,
    pub set_name: String,
    pub collector_number: String,
    pub finish: String,
    pub condition: String,
    pub lang: String,
    pub proxy: bool,
    /// Copies added (to add, in a preview).
    pub qty: i64,
    /// How the printing was found: "id" (the row's Scryfall id), "exact" (set and number), "set"
    /// (the set; no number, or one Yama doesn't have), "number" (set and number, the name didn't
    /// match) or "default" (no printing named, or one Yama doesn't have for the card).
    pub printing: &'static str,
}

/// A card line that matched nothing. It is listed, never dropped.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Unmatched {
    /// The line as a list would write it: "2 Sol Rnig (C21) 263".
    pub text: String,
    /// The row of the file it came from (CSV files only).
    pub row: Option<usize>,
    pub qty: i64,
    pub reason: String,
    /// Card names it might have meant.
    pub suggestions: Vec<String>,
}

#[derive(Serialize, Debug, Default)]
pub struct ImportReport {
    /// A preview: nothing was written.
    pub dry_run: bool,
    pub top_up: bool,
    /// What the text looks like: "a ManaBox export", "a plain list".
    pub source: String,
    /// When this exact list was imported before. Nothing is added from it again.
    pub already_imported: Option<String>,
    /// Where the copies go, as people read it: "box: Bulk", or "unfiled".
    pub place: String,
    /// Card lines read, matched or not.
    pub lines: usize,
    /// Copies on the lines that matched.
    pub copies: i64,
    /// Copies added (to add, in a preview).
    pub added: i64,
    pub added_cards: Vec<Line>,
    /// With `top_up`: copies the list names that the account has already, so they aren't added.
    pub already_owned: i64,
    pub unmatched: Vec<Unmatched>,
    pub unmatched_copies: i64,
    /// Lines that weren't cards and weren't understood.
    pub skipped: Vec<String>,
    /// What the import decided for the person: printings it chose, conditions it didn't know.
    pub notes: Vec<String>,
}

async fn import(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<ImportRequest>) -> AppResult<Json<ImportReport>> {
    st.limits.imports.check_user(&user)?;
    if user.limited && req.text.len() > OPEN_IMPORT_MAX_BYTES {
        return Err(AppError::bad(format!(
            "That's {} KB. Your account can import up to {} KB at a time. {}",
            req.text.len() / 1024,
            OPEN_IMPORT_MAX_BYTES / 1024,
            crate::auth::ASK_FOR_MORE
        )));
    }
    if req.text.len() > IMPORT_MAX_BYTES {
        return Err(AppError::bad(format!("That's {} KB. Yama imports up to {} KB at a time: split the file in two.", req.text.len() / 1024, IMPORT_MAX_BYTES / 1024)));
    }
    if req.text.trim().is_empty() {
        return Err(AppError::bad("paste a list of cards or choose a file"));
    }
    let opts = ImportOptions { dry_run: req.dry_run, top_up: req.top_up, container_id: req.container_id.filter(|c| !c.is_empty()) };
    Ok(Json(import_collection(&st.pool, &user.id, &req.text, req.file_name.as_deref(), opts).await?))
}

// ── reading ────────────────────────────────────────────────────────────────

/// One card line of the source, with what it says about the copy.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    /// The file row it came from (CSV only).
    row: Option<usize>,
    name: String,
    qty: i64,
    /// Lower-case set code, if the source named one.
    set_code: Option<String>,
    /// The set's name, where the source has a set column.
    set_name: Option<String>,
    collector_number: Option<String>,
    scryfall_id: Option<String>,
    finish: &'static str,
    condition: &'static str,
    /// Scryfall's language code, if the source named a language Yama knows.
    lang: Option<&'static str>,
    altered: bool,
    signed: bool,
    misprint: bool,
    proxy: bool,
    purchase_price: Option<f64>,
    purchase_currency: Option<String>,
}

impl Row {
    fn named(name: &str, qty: i64) -> Self {
        Row {
            row: None,
            name: name.to_string(),
            qty,
            set_code: None,
            set_name: None,
            collector_number: None,
            scryfall_id: None,
            finish: "nonfoil",
            condition: "NM",
            lang: None,
            altered: false,
            signed: false,
            misprint: false,
            proxy: false,
            purchase_price: None,
            purchase_currency: None,
        }
    }

    /// The line as a list would write it, for the ones that match nothing: "2 Sol Rnig (C21) 263".
    fn as_written(&self) -> String {
        let mut s = format!("{} {}", self.qty, if self.name.is_empty() { "(no name)" } else { &self.name });
        if let Some(set) = &self.set_code {
            s.push_str(&format!(" ({})", set.to_uppercase()));
            if let Some(n) = &self.collector_number {
                s.push_str(&format!(" {n}"));
            }
        }
        s
    }

    /// Everything the import reads from the line, for the hash that names its ops.
    fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}{}{}{}|{}|{}",
            self.qty,
            self.name,
            self.set_code.as_deref().unwrap_or(""),
            self.set_name.as_deref().unwrap_or(""),
            self.collector_number.as_deref().unwrap_or(""),
            self.scryfall_id.as_deref().unwrap_or(""),
            self.finish,
            self.condition,
            self.lang.unwrap_or(""),
            u8::from(self.altered),
            u8::from(self.signed),
            u8::from(self.misprint),
            u8::from(self.proxy),
            self.purchase_price.map(|p| p.to_string()).unwrap_or_default(),
            self.purchase_currency.as_deref().unwrap_or(""),
        )
    }
}

/// What was read from the text, before anything is looked up.
#[derive(Debug, Default)]
struct Source {
    label: String,
    rows: Vec<Row>,
    skipped: Vec<String>,
    /// Conditions and languages the source wrote that Yama doesn't know, each once.
    odd_conditions: Vec<String>,
    odd_langs: Vec<String>,
}

/// Columns that hold a card's name, best first. Mythic Tools has the printed name and the English
/// one; TCGplayer's "Name" carries the treatment ("Sol Ring (Extended Art)") and "Simple Name"
/// doesn't.
const NAME_COLS: [&str; 6] = ["english name", "simple name", "name", "card name", "card", "card_name"];
const ID_COLS: [&str; 3] = ["scryfall id", "scryfall_id", "scryfallid"];

fn read(text: &str, file_name: Option<&str>) -> Source {
    let text = text.trim_start_matches('\u{feff}');
    let named_csv = file_name.is_some_and(|f| {
        let f = f.to_lowercase();
        f.ends_with(".csv") || f.ends_with(".tsv")
    });
    match csv_start(text, named_csv) {
        Some(start) => read_csv(&start),
        None => {
            let parsed = formats::parse_any(text, file_name);
            let mut src = Source { label: parsed.format.label().to_string(), skipped: parsed.skipped, ..Default::default() };
            // A collection has no boards: every card line of the list is a card to add.
            for l in parsed.decks.into_iter().flat_map(|d| d.lines) {
                let mut row = Row::named(l.name.trim(), l.qty);
                row.set_code = l.set_code;
                row.collector_number = l.collector_number;
                row.finish = finish_of(l.finish.as_deref());
                row.proxy = l.proxy;
                src.rows.push(row);
            }
            src
        }
    }
}

/// Where a CSV's header row starts, and what separates its fields.
struct CsvStart<'a> {
    /// The text from the header row on.
    body: &'a str,
    delimiter: u8,
    /// The header's line in the file, from 1.
    header_line: usize,
}

/// The CSV in this text, if it is one: a file named `.csv`, or a first row with several fields
/// one of which is a card name column. Dragon Shield starts its files with a `"sep=,"` line.
fn csv_start(text: &str, named_csv: bool) -> Option<CsvStart<'_>> {
    let mut offset = 0;
    let mut said: Option<u8> = None;
    for (n, line) in text.split_inclusive('\n').enumerate() {
        let t = line.trim().trim_matches('"').trim();
        let lower = t.to_ascii_lowercase();
        if t.is_empty() {
            offset += line.len();
            continue;
        }
        if let Some(sep) = lower.strip_prefix("sep=") {
            said = sep.bytes().next();
            offset += line.len();
            continue;
        }
        // The separator the header uses most; a comma when it uses none.
        let delimiter = said.unwrap_or_else(|| [b'\t', b';', b','].into_iter().max_by_key(|d| t.bytes().filter(|b| b == d).count()).unwrap_or(b','));
        let fields: Vec<String> = lower.split(delimiter as char).map(|h| h.trim().trim_matches('"').trim().to_string()).collect();
        let card_column = fields.iter().any(|h| NAME_COLS.contains(&h.as_str()) || ID_COLS.contains(&h.as_str()));
        return (named_csv || (fields.len() > 1 && card_column)).then_some(CsvStart { body: &text[offset..], delimiter, header_line: n + 1 });
    }
    None
}

/// A CSV export, by its column names.
fn read_csv(start: &CsvStart<'_>) -> Source {
    let mut src = Source { label: "a CSV file".to_string(), ..Default::default() };
    let mut rdr = csv::ReaderBuilder::new().flexible(true).trim(csv::Trim::All).delimiter(start.delimiter).from_reader(start.body.as_bytes());
    let headers: Vec<String> = match rdr.headers() {
        Ok(h) => h.iter().map(|x| x.trim().trim_start_matches('\u{feff}').to_lowercase()).collect(),
        Err(_) => {
            src.skipped.push("The file couldn't be read as CSV.".to_string());
            return src;
        }
    };
    let col = |names: &[&str]| names.iter().find_map(|n| headers.iter().position(|h| h == n));
    let name_c = col(&NAME_COLS);
    let id_c = col(&ID_COLS);
    if name_c.is_none() && id_c.is_none() {
        src.skipped.push("The file has no card name column, so Yama can't tell which cards it lists.".to_string());
        return src;
    }
    src.label = csv_label(&headers).to_string();
    let qty_c = col(&["quantity", "qty", "count", "amount", "total quantity", "total qty"]);
    let set_code_c = col(&["set code", "edition code", "set_code", "expansion code", "setcode"]);
    // Moxfield's "Edition" is a set code; Deckbox's and TCGplayer's "Edition" and "Set" are names.
    let set_c = col(&["set name", "edition name", "set", "edition", "expansion"]);
    let num_c = col(&["collector number", "collector #", "collector_number", "card number", "number", "cn"]);
    let finish_c = col(&["finish", "foil", "printing", "foil/etched"]);
    let cond_c = col(&["condition"]);
    let lang_c = col(&["language", "lang"]);
    let altered_c = col(&["altered", "alter", "altered art"]);
    let signed_c = col(&["signed"]);
    let misprint_c = col(&["misprint"]);
    let proxy_c = col(&["proxy"]);
    let price_c = col(&["purchase price", "purchase price (usd)", "price bought", "my price"]);
    let currency_c = col(&["purchase price currency", "purchase currency"]);
    for (i, rec) in rdr.records().enumerate() {
        let Ok(rec) = rec else {
            src.skipped.push(format!("Row {} couldn't be read.", start.header_line + 1 + i));
            continue;
        };
        let line = rec.position().map_or(i + 2, |p| p.line() as usize) + start.header_line - 1;
        let get = |c: Option<usize>| c.and_then(|i| rec.get(i)).map(str::trim).filter(|v| !v.is_empty());
        let name = get(name_c).unwrap_or("");
        let scryfall_id = get(id_c).map(str::to_lowercase);
        if name.is_empty() && scryfall_id.is_none() {
            continue;
        }
        let qty = match get(qty_c).map(str::parse::<i64>) {
            None => 1,
            Some(Ok(n)) => n,
            Some(Err(_)) => {
                src.skipped.push(format!("Row {line}: \"{}\" isn't a number of copies ({name}).", get(qty_c).unwrap_or("")));
                continue;
            }
        };
        // Deckbox and Moxfield list cards with a count of 0 (a wishlist, a tradelist): not owned.
        if qty <= 0 {
            continue;
        }
        let mut row = Row::named(name, qty);
        row.row = Some(line);
        row.scryfall_id = scryfall_id;
        row.set_code = get(set_code_c).or(get(set_c)).map(str::to_lowercase).filter(|s| is_set_code(s));
        row.set_name = get(set_c).map(str::to_string);
        row.collector_number = get(num_c).map(str::to_string);
        row.finish = finish_of(get(finish_c));
        if let Some(raw) = get(cond_c) {
            match condition_code(raw) {
                Some(c) => row.condition = c,
                None => note_once(&mut src.odd_conditions, raw),
            }
            // TCGplayer writes the finish into the condition: "Near Mint Foil".
            if row.finish == "nonfoil" && raw.to_lowercase().ends_with("foil") {
                row.finish = "foil";
            }
        }
        if let Some(raw) = get(lang_c) {
            row.lang = lang_code(raw);
            if row.lang.is_none() {
                note_once(&mut src.odd_langs, raw);
            }
        }
        row.altered = get(altered_c).is_some_and(flag);
        row.signed = get(signed_c).is_some_and(flag);
        row.misprint = get(misprint_c).is_some_and(flag);
        row.proxy = get(proxy_c).is_some_and(flag);
        // What was paid, in the currency the file names (dollars if it names none). A price of 0
        // is how these apps write "not entered": unknown, not free.
        let currency = match get(currency_c) {
            None => Some("USD".to_string()),
            Some(c) if c.len() == 3 && c.bytes().all(|b| b.is_ascii_alphabetic()) => Some(c.to_ascii_uppercase()),
            Some(_) => None,
        };
        if let Some(currency) = currency
            && let Some(p) = get(price_c).and_then(price)
        {
            row.purchase_price = Some(p);
            row.purchase_currency = Some(currency);
        }
        src.rows.push(row);
    }
    src
}

fn note_once(list: &mut Vec<String>, raw: &str) {
    if list.len() < 5 && !list.iter().any(|x| x == raw) {
        list.push(raw.chars().take(40).collect());
    }
}

/// Which app wrote a CSV, by the columns only it has.
fn csv_label(headers: &[String]) -> &'static str {
    let has = |n: &str| headers.iter().any(|h| h == n);
    if has("manabox id") {
        "a ManaBox export"
    } else if has("container type") && has("container name") {
        "a Mythic Tools export"
    } else if has("folder name") && has("trade quantity") {
        "a Dragon Shield export"
    } else if has("simple name") || has("product id") {
        "a TCGplayer export"
    } else if has("tradelist count") && (has("artist proof") || has("card number")) {
        "a Deckbox export"
    } else if has("tradelist count") {
        "a Moxfield export"
    } else if has("edition name") || has("multiverse id") {
        "an Archidekt export"
    } else {
        "a CSV file"
    }
}

/// Set codes are 2 to 6 letters or digits, with a letter (as `deck_import::formats` reads them).
fn is_set_code(s: &str) -> bool {
    (2..=6).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric()) && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// A finish column: "foil", "etched", "Normal", or a foil flag ("true", "1").
fn finish_of(raw: Option<&str>) -> &'static str {
    let f = raw.unwrap_or("").trim().to_lowercase();
    if f.contains("etch") {
        "etched"
    } else if matches!(f.as_str(), "true" | "yes" | "1") || (f.contains("foil") && !f.contains("non")) {
        "foil"
    } else {
        "nonfoil"
    }
}

/// A yes/no column. Deckbox writes the word itself ("signed", "altered") for yes.
fn flag(v: &str) -> bool {
    !matches!(v.trim().to_lowercase().as_str(), "" | "false" | "no" | "0" | "n")
}

/// "$1,234.50" → 1234.5. Nothing for 0 (not entered), a negative or something that isn't a price.
fn price(raw: &str) -> Option<f64> {
    let cleaned: String = raw.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    if raw.trim_start().starts_with('-') {
        return None;
    }
    cleaned.parse::<f64>().ok().filter(|p| p.is_finite() && *p > 0.0 && *p <= 10_000_000.0)
}

/// A condition as Yama keeps it. Apps use two scales. TCGplayer's (Moxfield, Archidekt, Mythic
/// Tools): near mint, lightly, moderately and heavily played, damaged. Cardmarket's (ManaBox,
/// Dragon Shield, Deckbox's is close): mint, near mint, excellent, good, light played, played,
/// poor, read here as NM, NM, LP, MP, MP, HP, DMG, so a card is never filed as better than its
/// grade.
fn condition_code(raw: &str) -> Option<&'static str> {
    let key: String = raw.chars().filter(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase();
    // TCGplayer: "Near Mint Foil".
    let key = key.strip_suffix("foil").unwrap_or(&key);
    Some(match key {
        "m" | "mint" | "nm" | "nearmint" | "nmm" | "nearmintmint" | "mintnearmint" => "NM",
        "lp" | "lightlyplayed" | "sp" | "slightlyplayed" | "ex" | "excellent" | "goodlightlyplayed" => "LP",
        "mp" | "moderatelyplayed" | "gd" | "good" | "lightplayed" => "MP",
        "hp" | "heavilyplayed" | "pl" | "played" => "HP",
        "d" | "dmg" | "damaged" | "po" | "poor" => "DMG",
        _ => return None,
    })
}

/// A language as Scryfall codes it, from a code or the language's English name.
fn lang_code(raw: &str) -> Option<&'static str> {
    let key = raw.trim().to_lowercase();
    let code = match key.as_str() {
        "english" => "en",
        "spanish" => "es",
        "french" => "fr",
        "german" => "de",
        "italian" => "it",
        "portuguese" | "portuguese (brazil)" | "pt-br" => "pt",
        "japanese" | "jp" => "ja",
        "korean" | "kr" => "ko",
        "russian" => "ru",
        "chinese simplified" | "simplified chinese" | "s-chinese" | "chinese" | "cs" | "zh-cn" | "zh_cn" => "zhs",
        "chinese traditional" | "traditional chinese" | "t-chinese" | "ct" | "zh-tw" | "zh_tw" => "zht",
        "hebrew" => "he",
        "latin" => "la",
        "ancient greek" => "grc",
        "arabic" => "ar",
        "sanskrit" => "sa",
        "phyrexian" => "ph",
        "quenya" => "qya",
        other => other,
    };
    LANGS.iter().copied().find(|l| *l == code)
}

// ── matching ───────────────────────────────────────────────────────────────

/// A printing in Yama's card data.
#[derive(sqlx::FromRow, Debug, Clone)]
struct Found {
    scryfall_id: String,
    name: String,
    set_code: String,
    set_name: String,
    collector_number: String,
    lang: String,
}

/// A row with the printing it means.
struct Matched {
    row: Row,
    found: Found,
    how: &'static str,
    /// The language the copy is filed under.
    lang: String,
}

async fn by_id(pool: &SqlitePool, id: &str) -> AppResult<Option<Found>> {
    Ok(sqlx::query_as("SELECT scryfall_id, name, set_code, set_name, collector_number, lang FROM printings WHERE scryfall_id = ?").bind(id).fetch_optional(pool).await?)
}

/// A card's printing in the set the row names (by code or by name), with the number if given.
/// The row's language first, then English.
async fn in_set(pool: &SqlitePool, oracle_id: &str, row: &Row, number: Option<&str>) -> AppResult<Option<Found>> {
    Ok(sqlx::query_as(
        "SELECT scryfall_id, name, set_code, set_name, collector_number, lang FROM printings
         WHERE oracle_id = ?1 AND (set_code = ?2 OR set_name = ?3 COLLATE NOCASE) AND (?4 IS NULL OR collector_number = ?4)
         ORDER BY (lang = ?5) DESC, (lang = 'en') DESC, length(collector_number), collector_number LIMIT 1",
    )
    .bind(oracle_id)
    .bind(&row.set_code)
    .bind(&row.set_name)
    .bind(number)
    .bind(row.lang.unwrap_or("en"))
    .fetch_optional(pool)
    .await?)
}

/// "263/350" and "0263" as Scryfall numbers them: "263".
fn plain_number(n: &str) -> String {
    let n = n.split('/').next().unwrap_or(n).trim();
    let stripped = n.trim_start_matches('0');
    if stripped.is_empty() { n.to_string() } else { stripped.to_string() }
}

/// Find each row's printing. Lookups run outside any transaction: a big file is thousands of
/// them, and they mustn't be made while holding the database's one writer.
async fn match_rows(pool: &SqlitePool, rows: Vec<Row>, report: &mut ImportReport) -> AppResult<Vec<Matched>> {
    // Scryfall ids first; names only for the rows an id didn't settle.
    let mut by_ids: Vec<Option<Found>> = Vec::with_capacity(rows.len());
    for r in &rows {
        by_ids.push(match &r.scryfall_id {
            Some(id) => by_id(pool, id).await?,
            None => None,
        });
    }
    let mut names: Vec<String> = Vec::new();
    for (r, hit) in rows.iter().zip(&by_ids) {
        if hit.is_none() && !r.name.is_empty() && !names.contains(&r.name) {
            names.push(r.name.clone());
        }
    }
    let exact = crate::cards::resolve_names(pool, &names).await?;
    let mut index: Option<NameIndex> = None;
    // The printing a card gets when the row names none (or one Yama doesn't have), by oracle id.
    let mut defaults: HashMap<String, Option<Found>> = HashMap::new();
    let mut matched = Vec::new();
    let (mut no_printing_named, mut printing_not_found, mut suggested) = (0usize, 0usize, 0usize);
    for (row, id_hit) in rows.into_iter().zip(by_ids) {
        if !(1..=MAX_OP_QTY).contains(&row.qty) {
            report.unmatched_copies += row.qty;
            report.unmatched.push(Unmatched { text: row.as_written(), row: row.row, qty: row.qty, reason: format!("Yama adds at most {MAX_OP_QTY} copies of a card at a time."), suggestions: vec![] });
            continue;
        }
        if let Some(found) = id_hit {
            let lang = row.lang.map(str::to_string).unwrap_or_else(|| found.lang.clone());
            matched.push(Matched { row, found, how: "id", lang });
            continue;
        }
        let mut oracle = exact.get(&row.name).cloned();
        if oracle.is_none() && !row.name.is_empty() {
            if index.is_none() {
                index = Some(NameIndex::load(pool).await?);
            }
            oracle = index.as_ref().and_then(|i| i.forgiving(&row.name)).map(|(_, oid)| oid);
        }
        let named = row.set_code.is_some() || row.set_name.is_some();
        let mut hit: Option<(Found, &'static str)> = None;
        match &oracle {
            Some(oid) => {
                if named {
                    if let Some(n) = &row.collector_number {
                        hit = in_set(pool, oid, &row, Some(n.as_str())).await?.map(|f| (f, "exact"));
                        if hit.is_none() && plain_number(n) != *n {
                            hit = in_set(pool, oid, &row, Some(plain_number(n).as_str())).await?.map(|f| (f, "exact"));
                        }
                    }
                    if hit.is_none() {
                        hit = in_set(pool, oid, &row, None).await?.map(|f| (f, "set"));
                        // A number was named and this set doesn't have it for the card.
                        if hit.is_some() && row.collector_number.is_some() {
                            printing_not_found += 1;
                        }
                    }
                }
                if hit.is_none() {
                    if !defaults.contains_key(oid) {
                        let choices = crate::decks::printing_choices_for(pool, &[oid.as_str()]).await?;
                        let best = choices.get(oid).and_then(|c| crate::decks::collection_printing(c)).map(|p| p.scryfall_id.clone());
                        let found = match best {
                            Some(id) => by_id(pool, &id).await?,
                            None => None,
                        };
                        defaults.insert(oid.clone(), found);
                    }
                    hit = defaults.get(oid).cloned().flatten().map(|f| (f, "default"));
                    if hit.is_some() {
                        if named {
                            printing_not_found += 1;
                        } else {
                            no_printing_named += 1;
                        }
                    }
                }
            }
            // The name matched nothing (a typo, another language), but the set and number say
            // which card it is.
            None => {
                if let (Some(set), Some(n)) = (&row.set_code, &row.collector_number) {
                    for number in [n.clone(), plain_number(n)] {
                        if hit.is_some() {
                            break;
                        }
                        hit = sqlx::query_as(
                            "SELECT scryfall_id, name, set_code, set_name, collector_number, lang FROM printings
                             WHERE set_code = ?1 AND collector_number = ?2 ORDER BY (lang = ?3) DESC, (lang = 'en') DESC LIMIT 1",
                        )
                        .bind(set)
                        .bind(&number)
                        .bind(row.lang.unwrap_or("en"))
                        .fetch_optional(pool)
                        .await?
                        .map(|f| (f, "number"));
                    }
                }
            }
        }
        match hit {
            Some((found, how)) => {
                let lang = row.lang.unwrap_or("en").to_string();
                matched.push(Matched { row, found, how, lang });
            }
            None => {
                let reason = match (&oracle, row.name.is_empty()) {
                    (Some(_), _) => "Yama has no printing of this card yet.",
                    (None, true) => "The row has no card name, and Yama doesn't have its Scryfall id.",
                    (None, false) => "No card has this name.",
                };
                let mut suggestions = Vec::new();
                if oracle.is_none() && !row.name.is_empty() && suggested < MAX_SUGGESTED {
                    suggested += 1;
                    if let Some(i) = &index {
                        suggestions = i.suggest(&row.name, 3).into_iter().map(|(name, _)| name).collect();
                    }
                }
                report.unmatched_copies += row.qty;
                report.unmatched.push(Unmatched { text: row.as_written(), row: row.row, qty: row.qty, reason: reason.to_string(), suggestions });
            }
        }
    }
    if no_printing_named > 0 {
        report.notes.push(format!(
            "{} named no printing, so {} filed under a regular printing of the card. You can change a copy's printing from its row in your collection.",
            lines(no_printing_named),
            if no_printing_named == 1 { "it's" } else { "they're" }
        ));
    }
    if printing_not_found > 0 {
        report.notes.push(format!(
            "{} named a set or number Yama doesn't have for that card, so {} filed under another printing of it.",
            lines(printing_not_found),
            if printing_not_found == 1 { "it's" } else { "they're" }
        ));
    }
    Ok(matched)
}

/// "1 line", "3 lines".
fn lines(n: usize) -> String {
    format!("{n} {}", if n == 1 { "line" } else { "lines" })
}

// ── importing ──────────────────────────────────────────────────────────────

/// What makes copies interchangeable for counting: printing, finish, language, proxy (as the
/// Mythic Tools import counts them).
type Key = (String, String, String, bool);

/// Import (or with `dry_run`, preview) a collection export or a pasted list. See the module notes.
pub async fn import_collection(pool: &SqlitePool, owner: &str, text: &str, file_name: Option<&str>, opts: ImportOptions) -> AppResult<ImportReport> {
    let src = read(text, file_name);
    if src.rows.len() > MAX_LINES {
        return Err(AppError::bad(format!("That's {} card lines. Yama imports up to {MAX_LINES} at a time: split the list in two.", src.rows.len())));
    }
    let mut report = ImportReport { dry_run: opts.dry_run, top_up: opts.top_up, source: src.label, lines: src.rows.len(), skipped: src.skipped, ..Default::default() };
    // Where they go. The container is the owner's own, or it isn't found.
    report.place = match &opts.container_id {
        None => "unfiled".to_string(),
        Some(id) => {
            let found: Option<(String, String)> = sqlx::query_as("SELECT kind, name FROM containers WHERE id = ? AND owner_id = ?").bind(id).bind(owner).fetch_optional(pool).await?;
            let (kind, name) = found.ok_or(AppError::NotFound("container"))?;
            format!("{kind}: {name}")
        }
    };
    // The ops are named after what was read, not the bytes, so the same list with other line
    // endings or a trailing blank line is still the same import.
    let fingerprint: Vec<String> = src.rows.iter().map(Row::fingerprint).collect();
    let hash = sha256_hex(&fingerprint.join("\n"));
    let short = &hash[..16];
    if !src.odd_conditions.is_empty() {
        report.notes.push(format!("Yama doesn't know the condition {}, so those copies are filed as near mint.", quoted(&src.odd_conditions)));
    }
    if !src.odd_langs.is_empty() {
        report.notes.push(format!("Yama doesn't know the language {}, so those copies are filed as English.", quoted(&src.odd_langs)));
    }
    let matched = match_rows(pool, src.rows, &mut report).await?;
    report.copies = matched.iter().map(|m| m.row.qty).sum();

    // From here it reads the collection and then writes it: immediate, so a commit landing in
    // between can't fail it. A preview only reads, and never takes the write lock.
    let mut tx = if opts.dry_run { pool.begin().await? } else { pool.begin_with("BEGIN IMMEDIATE").await? };
    report.already_imported = sqlx::query_scalar("SELECT MIN(applied_at) FROM applied_ops WHERE owner_id = ?1 AND op_id LIKE 'import:' || ?2 || ':%'")
        .bind(owner)
        .bind(short)
        .fetch_one(&mut *tx)
        .await?;

    // How many copies of each line are still to add. Topping up, the account's copies stand for
    // the list's lines of the same condition first, then any; what's left is added.
    let mut open: Vec<i64> = matched.iter().map(|m| if report.already_imported.is_some() { 0 } else { m.row.qty }).collect();
    let key_of = |m: &Matched| -> Key { (m.found.scryfall_id.clone(), m.row.finish.to_string(), m.lang.clone(), m.row.proxy) };
    if opts.top_up && report.already_imported.is_none() {
        let mut same_condition: HashMap<(Key, String), i64> = HashMap::new();
        for c in owned_copies(&mut tx, owner).await? {
            *same_condition.entry(((c.scryfall_id, c.finish, c.lang, c.proxy), c.condition)).or_insert(0) += c.qty;
        }
        for (i, m) in matched.iter().enumerate() {
            if let Some(have) = same_condition.get_mut(&(key_of(m), m.row.condition.to_string())) {
                let take = (*have).min(open[i]);
                *have -= take;
                open[i] -= take;
            }
        }
        let mut any_condition: HashMap<Key, i64> = HashMap::new();
        for ((key, _), left) in same_condition {
            *any_condition.entry(key).or_insert(0) += left;
        }
        for (i, m) in matched.iter().enumerate() {
            if let Some(have) = any_condition.get_mut(&key_of(m)) {
                let take = (*have).min(open[i]);
                *have -= take;
                open[i] -= take;
            }
        }
        report.already_owned = matched.iter().zip(&open).map(|(m, left)| m.row.qty - left).sum();
    }

    let mut ops: Vec<Op> = Vec::new();
    for (i, m) in matched.iter().enumerate() {
        let qty = open[i];
        if qty == 0 {
            continue;
        }
        report.added += qty;
        report.added_cards.push(Line {
            name: m.found.name.clone(),
            written_as: (!m.row.name.is_empty() && !m.row.name.eq_ignore_ascii_case(&m.found.name)).then(|| m.row.name.clone()),
            set_code: m.found.set_code.clone(),
            set_name: m.found.set_name.clone(),
            collector_number: m.found.collector_number.clone(),
            finish: m.row.finish.to_string(),
            condition: m.row.condition.to_string(),
            lang: m.lang.clone(),
            proxy: m.row.proxy,
            qty,
            printing: m.how,
        });
        ops.push(Op {
            // The line's place in the list, so the same list names the same ops.
            op_id: format!("import:{short}:{i}"),
            device_id: Some("collection-import".to_string()),
            op: OpKind::Add {
                scryfall_id: m.found.scryfall_id.clone(),
                qty,
                copy: CopyKind {
                    condition: m.row.condition.to_string(),
                    finish: m.row.finish.to_string(),
                    lang: m.lang.clone(),
                    altered: m.row.altered,
                    signed: m.row.signed,
                    misprint: m.row.misprint,
                    proxy: m.row.proxy,
                },
                container_id: opts.container_id.clone(),
                purchase_price: m.row.purchase_price,
                purchase_currency: m.row.purchase_currency.clone(),
            },
        });
    }
    if opts.dry_run {
        return Ok(report);
    }
    for op in &ops {
        apply_op(&mut tx, owner, op).await?;
    }
    tx.commit().await?;
    Ok(report)
}

/// `"Fair"`, `"Fair" and "Used"`, `"Fair", "Used" and "Worn"`.
fn quoted(list: &[String]) -> String {
    let q: Vec<String> = list.iter().map(|x| format!("\"{x}\"")).collect();
    match q.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => q.join(""),
    }
}

#[cfg(test)]
mod tests;
