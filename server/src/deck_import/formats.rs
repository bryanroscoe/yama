//! Deck list formats: everything a deck site, app or file hands over, read into one shape.
//!
//! Text dialects (one parser, since they overlap): plain `1 Sol Ring` / `1x Sol Ring` / `Sol Ring`;
//! Moxfield and MTG Arena `1 Name (SET) 123 *F*` with `Commander` / `Deck` / `SIDEBOARD:` sections
//! (Arena adds `About` / `Name …` and `Companion`); Archidekt `1x Name (set) 123 [Commander{top}]
//! ^label^` with categories in brackets; TappedOut `1x Name *CMDR*`; Deckstats `1 [SET#123] Name
//! #!Commander` under `//Main`; MTGO `.txt` (a blank line, then the sideboard, where Commander decks
//! keep the commander). Files: MTGO `.dek` XML, CSV exports (Moxfield, Archidekt, ManaBox, Mythic
//! Tools, Deckbox, Dragon Shield…, by column names), and Archidekt's deck JSON.
//!
//! Nothing here touches the card database: names are matched later (`names.rs`).

use crate::decks::Board;
use serde::Serialize;

/// One card line, as the source wrote it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportLine {
    pub qty: i64,
    pub name: String,
    pub board: Board,
    /// Lower-case set code, if the source named a printing.
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    /// "foil" or "etched"; `None` for nonfoil or unknown.
    pub finish: Option<String>,
    /// A maybe-board card (kept apart from the deck, like the sideboard).
    pub maybe: bool,
    /// The source marked this card as a commander (section, category or tag).
    pub marked_commander: bool,
}

impl ImportLine {
    fn new(qty: i64, name: &str, board: Board) -> Self {
        ImportLine {
            qty,
            name: name.to_string(),
            board,
            set_code: None,
            collector_number: None,
            finish: None,
            maybe: false,
            marked_commander: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Text,
    Arena,
    Moxfield,
    Archidekt,
    TappedOut,
    Deckstats,
    MtgoText,
    MtgoDek,
    Csv,
    ArchidektJson,
}

impl Format {
    /// How the preview names the source ("Looks like a Moxfield export").
    pub fn label(self) -> &'static str {
        match self {
            Format::Text => "a plain list",
            Format::Arena => "an MTG Arena export",
            Format::Moxfield => "a Moxfield-style export",
            Format::Archidekt => "an Archidekt export",
            Format::TappedOut => "a TappedOut export",
            Format::Deckstats => "a Deckstats export",
            Format::MtgoText => "an MTGO-style list",
            Format::MtgoDek => "an MTGO .dek file",
            Format::Csv => "a CSV export",
            Format::ArchidektJson => "an Archidekt deck",
        }
    }
}

/// A deck read from a source.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedDeck {
    /// The deck's name if the source gave one (Arena's `Name`, a CSV container, a file name).
    pub name: Option<String>,
    pub lines: Vec<ImportLine>,
    /// Whether the source said who the commander is (a section, category or tag). If not, the
    /// commander is a guess or the person picks one.
    pub commander_marked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Parsed {
    pub format: Format,
    /// Usually one deck; a CSV with several deck containers (Mythic Tools) gives one per container.
    pub decks: Vec<ParsedDeck>,
    /// Lines that weren't cards and weren't understood (shown, never silently dropped).
    pub skipped: Vec<String>,
}

/// Read any supported text. `file_name` helps tell CSV and .dek apart and names the deck.
pub fn parse_any(text: &str, file_name: Option<&str>) -> Parsed {
    let text = text.trim_start_matches('\u{feff}');
    let trimmed = text.trim_start();
    let lower_name = file_name.map(|f| f.to_lowercase()).unwrap_or_default();
    let stem = file_name.map(file_stem);
    let mut parsed = if trimmed.starts_with("<?xml") || (trimmed.starts_with('<') && trimmed.contains("<Cards")) || lower_name.ends_with(".dek") {
        parse_dek(text)
    } else if (trimmed.starts_with('{') || trimmed.starts_with('[')) && let Some(p) = parse_json(trimmed) {
        p
    } else if lower_name.ends_with(".csv") || looks_like_csv(text) {
        parse_csv(text)
    } else {
        parse_text(text)
    };
    if let Some(stem) = stem
        && parsed.decks.len() == 1
        && parsed.decks[0].name.is_none()
        && !stem.is_empty()
    {
        parsed.decks[0].name = Some(stem);
    }
    parsed
}

/// "Atraxa Superfriends.txt" → "Atraxa Superfriends"; underscores and dashes read as spaces.
fn file_stem(f: &str) -> String {
    let base = f.rsplit(['/', '\\']).next().unwrap_or(f);
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
    stem.replace(['_'], " ").trim().to_string()
}

// ── text ───────────────────────────────────────────────────────────────────

/// What a header line switches to.
#[derive(Clone, Copy, PartialEq)]
enum Section {
    Commander,
    Main,
    Side,
    Maybe,
    About,
}

fn header(line: &str) -> Option<Section> {
    // "// Commander", "# Sideboard", "SIDEBOARD:", "Commander (1)", "Creatures (32)", "[Lands]".
    let s = line.trim().trim_start_matches("//").trim_start_matches('#').trim();
    let s = s.trim_start_matches('[').trim_end_matches(']').trim().trim_end_matches(':').trim();
    let word = s.split(['(', ':']).next().unwrap_or("").trim().to_lowercase();
    // A header is a word or two, never a quantity line.
    if word.is_empty() || word.chars().next().is_some_and(|c| c.is_ascii_digit()) || word.split_whitespace().count() > 2 {
        return None;
    }
    let rest = s[s.find(['(', ':']).unwrap_or(s.len())..].trim();
    // "Commander (1)" and "Creatures (32)" are headers; "Commander's Sphere (CMR) 1" isn't.
    if !rest.is_empty() && !(rest.starts_with('(') && rest.trim_end_matches(')').trim_start_matches('(').trim().chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    Some(match word.as_str() {
        "commander" | "commanders" | "command zone" => Section::Commander,
        "deck" | "main" | "mainboard" | "main deck" | "maindeck" | "library" => Section::Main,
        "creature" | "creatures" | "instant" | "instants" | "sorcery" | "sorceries" | "artifact" | "artifacts" | "enchantment"
        | "enchantments" | "planeswalker" | "planeswalkers" | "land" | "lands" | "battle" | "battles" | "spells" | "other" | "ramp"
        | "removal" | "draw" | "card draw" => Section::Main,
        "sideboard" | "side" | "side board" | "companion" => Section::Side,
        "maybeboard" | "maybe" | "considering" | "maybe board" => Section::Maybe,
        "about" => Section::About,
        _ => return None,
    })
}

/// Pull `(SET) 123` or `[SET]` / `[SET#123]` / `[SET:123]` out of a name. Returns the name without it.
fn take_printing(s: &str) -> (String, Option<String>, Option<String>) {
    let s = s.trim();
    // Deckstats puts the printing first: "[C21#263] Sol Ring".
    if s.starts_with('[')
        && let Some(end) = s.find(']')
    {
        let inner = &s[1..end];
        let (set, num) = split_set_num(inner);
        if set.as_ref().is_some_and(|x| is_set_code(x)) {
            return (s[end + 1..].trim().to_string(), set, num);
        }
    }
    // "(SET) 123" or "(SET)" at the end (Moxfield, Arena, Archidekt, ManaBox).
    if let Some(open) = s.rfind(" (") {
        let after = &s[open + 2..];
        if let Some(close) = after.find(')') {
            let set = &after[..close];
            let tail = after[close + 1..].trim();
            let num_ok = tail.is_empty() || (tail.split_whitespace().count() == 1 && tail.len() <= 12);
            if is_set_code(set) && num_ok {
                let num = (!tail.is_empty()).then(|| tail.to_string());
                return (s[..open].trim().to_string(), Some(set.to_lowercase()), num);
            }
        }
    }
    // "Sol Ring [C21]" at the end.
    if s.ends_with(']')
        && let Some(open) = s.rfind(" [")
    {
        let inner = &s[open + 2..s.len() - 1];
        let (set, num) = split_set_num(inner);
        if set.as_ref().is_some_and(|x| is_set_code(x)) {
            return (s[..open].trim().to_string(), set, num);
        }
    }
    (s.to_string(), None, None)
}

fn split_set_num(inner: &str) -> (Option<String>, Option<String>) {
    let mut parts = inner.splitn(2, ['#', ':', ' ']);
    let set = parts.next().map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty());
    let num = parts.next().map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    (set, num)
}

/// Set codes are 2 to 6 letters or digits (plus Scryfall's few with a leading "p" or digits).
fn is_set_code(s: &str) -> bool {
    (2..=6).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric()) && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// Leading quantity: "1 ", "1x ", "x1 ", "1\t", "1x\t". Returns (qty, rest).
fn take_qty(line: &str) -> (Option<i64>, &str) {
    let l = line.trim();
    let digits_end = l.find(|c: char| !c.is_ascii_digit()).unwrap_or(l.len());
    if digits_end > 0 {
        let n: Option<i64> = l[..digits_end].parse().ok();
        let rest = &l[digits_end..];
        let rest = rest.strip_prefix(['x', 'X']).unwrap_or(rest);
        if rest.starts_with([' ', '\t']) && n.is_some() {
            return (n, rest.trim());
        }
    }
    if let Some(rest) = l.strip_prefix(['x', 'X']) {
        let d = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        if d > 0 && rest[d..].starts_with([' ', '\t']) {
            return (rest[..d].parse().ok(), rest[d..].trim());
        }
    }
    (None, l)
}

/// Markers inside a line: TappedOut `*CMDR*`, foil `*F*`, etched `*E*`, Deckstats `#!Commander`,
/// Archidekt `[Commander{top}]` categories and `^label^` labels. Returns the cleaned rest and what
/// the markers said.
struct Markers {
    commander: bool,
    foil: Option<String>,
    side: bool,
    maybe: bool,
    /// Archidekt categories in brackets were read.
    categories: bool,
}

fn take_markers(s: &str) -> (String, Markers) {
    let mut m = Markers { commander: false, foil: None, side: false, maybe: false, categories: false };
    let mut s = s.to_string();
    // Archidekt labels: ^Have,#37d67a^
    while let (Some(a), true) = (s.find('^'), s.matches('^').count() >= 2) {
        let b = s[a + 1..].find('^').map(|i| i + a + 1).unwrap_or(s.len() - 1);
        s.replace_range(a..=b, " ");
    }
    // Archidekt categories at the end: "[Commander{top}]" or "[Maybeboard{noDeck}{noPrice},Ramp]".
    if s.trim_end().ends_with(']')
        && let Some(open) = s.rfind('[')
    {
        let inner = s[open + 1..s.trim_end().len() - 1].to_string();
        // "[C21]" or "[LEA#123]" after a bare name is a printing (leave it for take_printing);
        // after "(set) 123", or in Title Case ("[Ramp]"), it's Archidekt categories.
        let (set, _) = split_set_num(&inner);
        let had_printing = s[..open].contains(" (") && s[..open].trim_end().ends_with(|c: char| c.is_ascii_alphanumeric() || c == ')');
        let code_like = set.as_ref().is_some_and(|x| is_set_code(x))
            && !inner.contains(['{', ',', ' '])
            && inner.len() <= 12
            && (inner.chars().any(|c| c.is_ascii_digit()) || inner.chars().filter(|c| c.is_ascii_alphabetic()).all(|c| c.is_ascii_uppercase()));
        let printing = code_like && !had_printing;
        if !printing {
            m.categories = true;
            for cat in inner.split(',') {
                let name = cat.split('{').next().unwrap_or("").trim().to_lowercase();
                let no_deck = cat.contains("{noDeck}");
                match name.as_str() {
                    "commander" | "commanders" => m.commander = true,
                    "sideboard" | "side" => m.side = true,
                    "maybeboard" | "maybe" | "considering" => m.maybe = true,
                    _ if no_deck => m.maybe = true,
                    _ => {}
                }
            }
            s.truncate(open);
        }
    }
    // Deckstats / tag comments: "#!Commander", "# !Commander", "#Card Advantage".
    if let Some(i) = s.find(" #") {
        let tags = s[i..].to_lowercase();
        if tags.contains("!commander") {
            m.commander = true;
        }
        s.truncate(i);
    }
    // Star markers: *CMDR*, *F*, *E*, *A* (altered), *f-etch*.
    loop {
        let Some(a) = s.find('*') else { break };
        let Some(len) = s[a + 1..].find('*') else { break };
        let tag = s[a + 1..a + 1 + len].to_lowercase();
        match tag.as_str() {
            "cmdr" | "commander" => m.commander = true,
            "f" | "foil" => m.foil = Some("foil".into()),
            "e" | "etched" | "f-etch" => m.foil = Some("etched".into()),
            _ => {}
        }
        s.replace_range(a..a + len + 2, " ");
    }
    (s.split_whitespace().collect::<Vec<_>>().join(" "), m)
}

/// Read a pasted or uploaded text list (every text dialect above).
pub fn parse_text(text: &str) -> Parsed {
    let mut format_votes: Vec<Format> = Vec::new();
    let mut lines: Vec<ImportLine> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut name: Option<String> = None;
    let mut section = Section::Main;
    let mut saw_section = false;
    let mut commander_marked = false;
    // MTGO .txt: cards after the first blank line (with no header) are the sideboard.
    let mut blocks: Vec<Vec<usize>> = vec![vec![]];
    let mut blank_since_card = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            blank_since_card = !lines.is_empty();
            continue;
        }
        if let Some(h) = header(line) {
            section = h;
            saw_section = true;
            if h == Section::Commander {
                commander_marked = true;
            }
            if line.contains("SIDEBOARD:") || line.contains("COMMANDER:") {
                format_votes.push(Format::Moxfield);
            }
            if line.starts_with("//") {
                format_votes.push(Format::Deckstats);
            }
            if matches!(line, "Deck" | "Commander" | "Sideboard" | "Companion" | "About") {
                format_votes.push(Format::Arena);
            }
            blank_since_card = false;
            continue;
        }
        if section == Section::About {
            if let Some(n) = line.strip_prefix("Name ").or_else(|| line.strip_prefix("Name:")) {
                name = Some(n.trim().to_string());
            }
            continue;
        }
        if line.starts_with("//") || line.starts_with('#') {
            continue;
        }
        let (qty, rest) = take_qty(line);
        let (rest, markers) = take_markers(rest);
        let (card, set_code, collector_number) = take_printing(&rest);
        let card = card.trim().trim_end_matches(['*']).trim().to_string();
        if card.is_empty() || qty == Some(0) {
            skipped.push(raw.trim().to_string());
            continue;
        }
        // A line with no quantity that isn't a plausible name (a URL, a sentence) is skipped.
        if qty.is_none() && (card.contains("://") || card.split_whitespace().count() > 12) {
            skipped.push(raw.trim().to_string());
            continue;
        }
        if markers.commander {
            commander_marked = true;
            if line.contains("*CMDR*") {
                format_votes.push(Format::TappedOut);
            } else if line.contains("!Commander") {
                format_votes.push(Format::Deckstats);
            } else {
                format_votes.push(Format::Archidekt);
            }
        }
        if markers.categories || line.contains('^') || line.contains("{top}") || line.contains("{noDeck}") {
            format_votes.push(Format::Archidekt);
        } else if set_code.is_some() && line.starts_with(|c: char| c.is_ascii_digit()) && line.contains(" (") {
            format_votes.push(Format::Moxfield);
        }
        if line.contains("] ") && line.contains('#') && line.contains('[') {
            format_votes.push(Format::Deckstats);
        }
        if blank_since_card && !saw_section {
            blocks.push(vec![]);
        }
        blank_since_card = false;
        let board = if markers.commander || section == Section::Commander {
            Board::Commander
        } else if markers.side || markers.maybe || matches!(section, Section::Side | Section::Maybe) {
            Board::Side
        } else {
            Board::Main
        };
        let mut l = ImportLine::new(qty.unwrap_or(1), &card, board);
        l.set_code = set_code;
        l.collector_number = collector_number;
        l.finish = markers.foil;
        l.maybe = markers.maybe || section == Section::Maybe;
        l.marked_commander = l.board == Board::Commander;
        blocks.last_mut().unwrap().push(lines.len());
        lines.push(l);
    }
    let mut format = most_common(&format_votes).unwrap_or(Format::Text);
    // Two blocks split by a blank line and no headers. MTGO .txt keeps the sideboard after the
    // blank line, and Commander decks keep the commander there; EDHREC and others put the
    // commander alone first. A commander found this way is a guess (not marked), checked against
    // the card once names are matched. More than two blocks is a hand-grouped list: all main.
    if !saw_section && !commander_marked && blocks.len() == 2 {
        let total = |b: &Vec<usize>| b.iter().map(|&i| lines[i].qty).sum::<i64>();
        let (a, b) = (total(&blocks[0]), total(&blocks[1]));
        let singles = |b: &Vec<usize>| b.iter().all(|&i| lines[i].qty == 1);
        if b <= 2 && a >= 90 && singles(&blocks[1]) {
            format = Format::MtgoText;
            for &i in &blocks[1] {
                lines[i].board = Board::Commander;
            }
        } else if a <= 2 && b >= 90 && singles(&blocks[0]) {
            for &i in &blocks[0] {
                lines[i].board = Board::Commander;
            }
        } else if b <= 15 && a >= 40 {
            format = Format::MtgoText;
            for &i in &blocks[1] {
                lines[i].board = Board::Side;
            }
        }
    }
    Parsed { format, decks: vec![ParsedDeck { name, lines, commander_marked }], skipped }
}

fn most_common(v: &[Format]) -> Option<Format> {
    let mut best: Option<(Format, usize)> = None;
    for f in v {
        let n = v.iter().filter(|x| *x == f).count();
        if best.is_none_or(|(_, m)| n > m) {
            best = Some((*f, n));
        }
    }
    best.map(|(f, _)| f)
}

// ── MTGO .dek ──────────────────────────────────────────────────────────────

/// `<Cards CatID="…" Quantity="1" Sideboard="false" Name="Sol Ring" />` elements.
pub fn parse_dek(text: &str) -> Parsed {
    let mut lines = Vec::new();
    let mut skipped = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("<Cards") {
        let after = &rest[i..];
        let end = after.find('>').unwrap_or(after.len());
        let el = &after[..end];
        let qty = attr(el, "Quantity").and_then(|q| q.parse::<i64>().ok()).unwrap_or(1);
        let side = attr(el, "Sideboard").is_some_and(|s| s.eq_ignore_ascii_case("true"));
        match attr(el, "Name") {
            Some(name) if !name.trim().is_empty() && qty > 0 => {
                lines.push(ImportLine::new(qty, name.trim(), if side { Board::Side } else { Board::Main }));
            }
            _ => skipped.push(el.to_string()),
        }
        rest = &after[end.min(after.len())..];
    }
    // Commander decks keep the commander in the sideboard: one or two single cards there, with a
    // full deck in the main, are a guess checked once names are matched.
    let main: i64 = lines.iter().filter(|l| l.board == Board::Main).map(|l| l.qty).sum();
    let side: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].board == Board::Side).collect();
    if main >= 90 && (1..=2).contains(&side.len()) && side.iter().all(|&i| lines[i].qty == 1) {
        for i in side {
            lines[i].board = Board::Commander;
        }
    }
    let name = attr_tag(text, "Name");
    Parsed { format: Format::MtgoDek, decks: vec![ParsedDeck { name, lines, commander_marked: false }], skipped }
}

fn attr(el: &str, key: &str) -> Option<String> {
    let pat = format!(" {key}=\"");
    let i = el.find(&pat)? + pat.len();
    let j = el[i..].find('"')? + i;
    Some(xml_unescape(&el[i..j]))
}

/// The text of a simple `<Tag>…</Tag>` element, if present.
fn attr_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let i = text.find(&open)? + open.len();
    let j = text[i..].find(&close)? + i;
    let v = xml_unescape(text[i..j].trim());
    (!v.is_empty()).then_some(v)
}

fn xml_unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

// ── CSV ────────────────────────────────────────────────────────────────────

fn looks_like_csv(text: &str) -> bool {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_lowercase();
    first.contains(',') && (first.contains("name") || first.contains("card")) && (first.contains("quantity") || first.contains("count") || first.contains("qty"))
}

fn col(headers: &[String], names: &[&str]) -> Option<usize> {
    names.iter().find_map(|n| headers.iter().position(|h| h == n))
}

/// CSV exports, by column names: a quantity, a name (English name first), and if present the set,
/// collector number, finish or foil flag, a board/section/category column, and Mythic Tools'
/// container columns (one deck per "deck" container).
pub fn parse_csv(text: &str) -> Parsed {
    let mut rdr = csv::ReaderBuilder::new().flexible(true).trim(csv::Trim::All).from_reader(text.as_bytes());
    let headers: Vec<String> = match rdr.headers() {
        Ok(h) => h.iter().map(|x| x.trim().trim_start_matches('\u{feff}').to_lowercase()).collect(),
        Err(_) => return Parsed { format: Format::Csv, decks: vec![], skipped: vec!["The file couldn't be read as CSV.".into()] },
    };
    let qty_c = col(&headers, &["quantity", "qty", "count", "amount", "total qty"]);
    let name_c = col(&headers, &["english name", "name", "card name", "card", "card_name"]);
    let set_c = col(&headers, &["set code", "edition code", "set", "edition", "set_code", "expansion code"]);
    let num_c = col(&headers, &["collector number", "collector #", "collector_number", "card number", "cn"]);
    let finish_c = col(&headers, &["finish", "foil", "printing", "foil/etched"]);
    let board_c = col(&headers, &["board", "section", "zone", "categories", "category", "deck section"]);
    let cmdr_c = col(&headers, &["commander", "is commander"]);
    let ctype_c = col(&headers, &["container type"]);
    let cname_c = col(&headers, &["container name"]);
    let Some(name_c) = name_c else {
        return Parsed { format: Format::Csv, decks: vec![], skipped: vec!["The CSV has no card name column.".into()] };
    };
    let mut decks: Vec<ParsedDeck> = Vec::new();
    let mut by_container = false;
    let mut skipped = Vec::new();
    for rec in rdr.records() {
        let Ok(rec) = rec else {
            skipped.push("A row couldn't be read.".into());
            continue;
        };
        let get = |c: Option<usize>| c.and_then(|i| rec.get(i)).map(str::trim).filter(|v| !v.is_empty());
        let Some(name) = get(Some(name_c)) else { continue };
        let qty = get(qty_c).and_then(|q| q.parse::<i64>().ok()).unwrap_or(1);
        if qty <= 0 {
            continue;
        }
        let mut l = ImportLine::new(qty, name, Board::Main);
        l.set_code = get(set_c).map(|s| s.to_lowercase()).filter(|s| is_set_code(s));
        l.collector_number = get(num_c).map(str::to_string);
        l.finish = get(finish_c).and_then(|f| {
            let f = f.to_lowercase();
            if f.contains("etch") {
                Some("etched".to_string())
            } else if f == "foil" || f == "true" || f == "yes" || f == "1" || f.contains("foil") && !f.contains("non") {
                Some("foil".to_string())
            } else {
                None
            }
        });
        if let Some(b) = get(board_c) {
            let b = b.to_lowercase();
            if b.contains("commander") {
                l.board = Board::Commander;
                l.marked_commander = true;
            } else if b.contains("side") {
                l.board = Board::Side;
            } else if b.contains("maybe") || b.contains("consider") {
                l.board = Board::Side;
                l.maybe = true;
            }
        }
        if get(cmdr_c).is_some_and(|v| matches!(v.to_lowercase().as_str(), "true" | "yes" | "1")) {
            l.board = Board::Commander;
            l.marked_commander = true;
        }
        // Mythic Tools: one deck per container whose type is "deck"; other containers (boxes,
        // binders, lists) aren't decks and are left out.
        let deck_name = match (get(ctype_c), get(cname_c)) {
            (Some(t), Some(n)) if t.eq_ignore_ascii_case("deck") => {
                by_container = true;
                Some(n.to_string())
            }
            (Some(_), _) if ctype_c.is_some() => None,
            _ => Some(String::new()),
        };
        let Some(deck_name) = deck_name else { continue };
        let i = match decks.iter().position(|d| d.name.as_deref().unwrap_or("") == deck_name) {
            Some(i) => i,
            None => {
                decks.push(ParsedDeck { name: (!deck_name.is_empty()).then(|| deck_name.clone()), lines: vec![], commander_marked: false });
                decks.len() - 1
            }
        };
        if l.marked_commander {
            decks[i].commander_marked = true;
        }
        decks[i].lines.push(l);
    }
    if decks.is_empty() && ctype_c.is_some() && !by_container {
        skipped.push("This CSV has no deck containers. A collection export (boxes and binders) isn't a deck: import it on the Collection page.".into());
    }
    Parsed { format: Format::Csv, decks, skipped }
}

// ── JSON ───────────────────────────────────────────────────────────────────

/// Archidekt's deck JSON (what its deck API returns), or a plain `[{"name","quantity"}]` list.
pub fn parse_json(text: &str) -> Option<Parsed> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("cards").is_some_and(|c| c.is_array()) && v["cards"].as_array()?.iter().any(|c| c.get("card").is_some()) {
        return Some(parse_archidekt_json(&v));
    }
    let arr = v.as_array().or_else(|| v.get("cards").and_then(|c| c.as_array()))?;
    let mut lines = Vec::new();
    for c in arr {
        let name = c.get("name").and_then(|n| n.as_str())?;
        let qty = c.get("quantity").or_else(|| c.get("qty")).or_else(|| c.get("count")).and_then(|q| q.as_i64()).unwrap_or(1);
        let board = match c.get("board").and_then(|b| b.as_str()).unwrap_or("") {
            "commander" | "commanders" => Board::Commander,
            "side" | "sideboard" | "maybe" | "maybeboard" => Board::Side,
            _ => Board::Main,
        };
        let mut l = ImportLine::new(qty, name, board);
        l.marked_commander = l.board == Board::Commander;
        lines.push(l);
    }
    let marked = lines.iter().any(|l| l.marked_commander);
    Some(Parsed { format: Format::Text, decks: vec![ParsedDeck { name: v.get("name").and_then(|n| n.as_str()).map(str::to_string), lines, commander_marked: marked }], skipped: vec![] })
}

/// Archidekt's deck JSON: `{"name", "categories": [{"name","includedInDeck"}], "cards":
/// [{"quantity", "modifier", "categories": [...], "card": {"collectorNumber", "edition":
/// {"editioncode"}, "oracleCard": {"name"}}}]}`.
pub fn parse_archidekt_json(v: &serde_json::Value) -> Parsed {
    let excluded: Vec<String> = v["categories"]
        .as_array()
        .map(|cats| {
            cats.iter()
                .filter(|c| c.get("includedInDeck").and_then(|b| b.as_bool()) == Some(false))
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_lowercase()))
                .collect()
        })
        .unwrap_or_default();
    let mut lines = Vec::new();
    let mut skipped = Vec::new();
    for c in v["cards"].as_array().into_iter().flatten() {
        let card = &c["card"];
        let name = card["oracleCard"]["name"].as_str().or_else(|| card["name"].as_str());
        let Some(name) = name else {
            skipped.push("A card without a name.".into());
            continue;
        };
        let qty = c["quantity"].as_i64().unwrap_or(1);
        if qty <= 0 {
            continue;
        }
        let cats: Vec<String> = c["categories"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(|s| s.to_lowercase())).collect();
        let mut l = ImportLine::new(qty, name, Board::Main);
        if cats.iter().any(|x| x == "commander" || x == "commanders") {
            l.board = Board::Commander;
            l.marked_commander = true;
        } else if cats.iter().any(|x| x == "sideboard") {
            l.board = Board::Side;
        } else if cats.iter().any(|x| x == "maybeboard" || excluded.contains(x)) {
            l.board = Board::Side;
            l.maybe = true;
        }
        l.set_code = card["edition"]["editioncode"].as_str().map(|s| s.to_lowercase()).filter(|s| is_set_code(s));
        l.collector_number = card["collectorNumber"].as_str().map(str::to_string).filter(|s| !s.is_empty());
        l.finish = match c["modifier"].as_str().unwrap_or("").to_lowercase().as_str() {
            "foil" => Some("foil".into()),
            "etched" => Some("etched".into()),
            _ => None,
        };
        lines.push(l);
    }
    let marked = lines.iter().any(|l| l.marked_commander);
    Parsed {
        format: Format::ArchidektJson,
        decks: vec![ParsedDeck { name: v["name"].as_str().map(str::to_string), lines, commander_marked: marked }],
        skipped,
    }
}
