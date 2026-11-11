//! A subset of Scryfall's search syntax, compiled to a SQL `WHERE` clause over `cards`.
//!
//! Supported: bare words and "quoted phrases" (name), `!"exact name"`, `o:` `t:` `kw:`,
//! `c:` / `id:` with `= != < <= > >=` (colors as letters, names, guilds, shards, wedges,
//! `c`/colorless, `m`/multicolor), `mv`/`cmc`, `pow`, `tou`, `loy`, `r:`, `f:`/`legal:`,
//! `banned:`, `set:` / `s:` / `e:` (a set code), `a:` (artist), `year` (release year), `usd` (the
//! price the results show; a card with no price never matches a price comparison, negated or
//! not), `is:` (`commander`, `legendary`, `gamechanger` or `gc`, `reserved`, `partner`,
//! `companion`, `dfc`, `mdfc`, `transform`, `split`, `flip`, `meld`, `adventure`, `saga`,
//! `leveler`, `vanilla`, `historic`, `party`, `outlaw`, `hybrid`, `phyrexian`, `permanent`,
//! `spell`, `multicolor`), negation `-`, `or`, and parentheses.
//!
//! `set:`, `a:` and `year` are about a printing. The ones side by side in one group are about
//! the same printing: `set:lea year<1995` is a card with a 1993 Alpha printing, and
//! `year>=2000 year<=2005` a card printed in those years, not one printed before and after.
//! Negated, a printing term means the card has no such printing at all (`-set:cmm`: never
//! printed in CMM).
//!
//! The same grammar runs offline in the app (`packages/core/src/search.ts`), so keep them in
//! step. The device keeps no printings or prices, so there `set:`, `a:`, `year`, `usd` and
//! `is:reserved` are read and then refused with a reason.

#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    Text(String),
    Num(f64),
}

#[derive(Debug, PartialEq)]
pub struct Compiled {
    pub sql: String,
    pub binds: Vec<Bind>,
    /// The query reads the Game Changer flag (`is:gamechanger`), which may not be loaded yet.
    pub uses_game_changer: bool,
    /// The query reads the Reserve List flag (`is:reserved`), which may not be loaded yet.
    pub uses_reserved: bool,
}

/// The price a search compares, sorts by and shows (`cards::with_price_and_ownership` shows the
/// same): the default printing's latest market price, regular, else foil, else etched; when that
/// printing has none (a set not out yet), the lowest price among the card's other printings.
/// NULL when no printing has one, so a comparison with it is never true (and neither is its
/// negation): a missing price is unknown, not 0.
pub const PRICE_SQL: &str = "COALESCE(\
    (SELECT COALESCE(ps.usd, ps.usd_foil, ps.usd_etched) FROM price_latest ps WHERE ps.scryfall_id = cards.default_printing), \
    (SELECT MIN(COALESCE(ps.usd, ps.usd_foil, ps.usd_etched)) FROM printings p JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id WHERE p.oracle_id = cards.oracle_id))";

/// When a card first came out: its earliest dated printing (YYYY-MM-DD), for sorting. Read from
/// the `printings_oracle_released` index.
pub const FIRST_RELEASE_SQL: &str = "(SELECT MIN(p.released_at) FROM printings p WHERE p.oracle_id = cards.oracle_id)";

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    LParen,
    RParen,
    Or,
    Neg,
    Term { key: Option<String>, op: String, value: String, exact: bool },
}

pub fn compile(query: &str) -> Result<Compiled, String> {
    let toks = lex(query)?;
    let mut p = Parser { toks, pos: 0, binds: Vec::new(), uses_game_changer: false, uses_reserved: false };
    if p.toks.is_empty() {
        return Ok(Compiled { sql: "1".into(), binds: vec![], uses_game_changer: false, uses_reserved: false });
    }
    let sql = p.expr()?;
    if p.pos < p.toks.len() {
        return Err("unexpected ')'".into());
    }
    Ok(Compiled { sql, binds: p.binds, uses_game_changer: p.uses_game_changer, uses_reserved: p.uses_reserved })
}

/// The name a query types, for ordering: its bare words and quoted phrases joined by spaces,
/// lowercased ("sol ring t:artifact" gives "sol ring"). Words that are negated (alone or inside a
/// negated group, `-(sol ring) lotus`) or exact (`!`), and keyed terms, aren't part of it. `None`
/// when the query names nothing, or can't be read.
/// The default order puts the card with exactly this name first, then names that start with it
/// (`name_rank`); the offline copy in `packages/core/src/search.ts` (`namePhrase`) does the same.
pub fn name_phrase(query: &str) -> Option<String> {
    let toks = lex(query).ok()?;
    let mut words = Vec::new();
    // Whether each open group is excluded (itself negated, or inside one that is), and whether a
    // `-` is waiting for the term or group it negates.
    let mut groups: Vec<bool> = Vec::new();
    let mut negated = false;
    for t in &toks {
        let excluded = negated || groups.last().copied().unwrap_or(false);
        negated = false;
        match t {
            Tok::Neg => negated = true,
            Tok::LParen => groups.push(excluded),
            Tok::RParen => {
                groups.pop();
            }
            Tok::Term { key: None, exact: false, value, .. } if !excluded => words.push(value.trim().to_lowercase()),
            _ => {}
        }
    }
    let phrase = words.join(" ");
    (!phrase.is_empty()).then_some(phrase)
}

/// `ORDER BY` rank for a typed name, with its two binds: 0 for the card of exactly that name, 1 for
/// names that start with it, 2 for the rest. A name search matches its words anywhere in the name,
/// so "sol ring" also finds Searing Soloist; alphabetically that came first.
pub fn name_rank(phrase: &str) -> (&'static str, [Bind; 2]) {
    (
        "CASE WHEN cards.name = ? COLLATE NOCASE THEN 0 WHEN cards.name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END",
        [Bind::Text(phrase.to_string()), Bind::Text(format!("{}%", escape_like(phrase)))],
    )
}

/// Whether the query asks for tokens or other non-deck cards explicitly.
pub fn wants_extras(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("t:token") || q.contains("type:token") || q.contains("t:emblem") || q.contains("include:extras")
}

fn lex(s: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '(' {
            out.push(Tok::LParen);
            i += 1;
            continue;
        }
        if c == ')' {
            out.push(Tok::RParen);
            i += 1;
            continue;
        }
        if c == '-' && i + 1 < chars.len() && !chars[i + 1].is_whitespace() {
            out.push(Tok::Neg);
            i += 1;
            continue;
        }
        let exact = c == '!';
        if exact {
            i += 1;
        }
        // key (letters) followed by an operator, otherwise a bare word
        let start = i;
        while i < chars.len() && chars[i].is_ascii_alphabetic() {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        let op = ["<=", ">=", "!=", ":", "=", "<", ">"]
            .into_iter()
            .find(|op| chars[i..].starts_with(&op.chars().collect::<Vec<_>>()));
        let (key, op) = match (op, word.is_empty() || exact) {
            (Some(op), false) => {
                i += op.chars().count();
                (Some(word.to_lowercase()), op.to_string())
            }
            _ => {
                i = start;
                (None, ":".to_string())
            }
        };
        let value = if i < chars.len() && chars[i] == '"' {
            i += 1;
            let vstart = i;
            while i < chars.len() && chars[i] != '"' {
                i += 1;
            }
            if i >= chars.len() {
                return Err("unclosed quote".into());
            }
            let v: String = chars[vstart..i].iter().collect();
            i += 1;
            v
        } else {
            let vstart = i;
            while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '(' && chars[i] != ')' {
                i += 1;
            }
            chars[vstart..i].iter().collect()
        };
        if key.is_none() && !exact && value.eq_ignore_ascii_case("or") {
            out.push(Tok::Or);
            continue;
        }
        if key.is_none() && !exact && value.eq_ignore_ascii_case("and") {
            continue;
        }
        if value.is_empty() && key.is_some() {
            return Err(format!("{}{} needs a value", key.unwrap(), op));
        }
        if !value.is_empty() {
            out.push(Tok::Term { key, op, value, exact });
        }
    }
    Ok(out)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    binds: Vec<Bind>,
    uses_game_changer: bool,
    uses_reserved: bool,
}

/// `is:` values that are a card layout (Scryfall's `layout`), by the layout they name.
const IS_LAYOUTS: [(&str, &str); 6] = [("mdfc", "modal_dfc"), ("transform", "transform"), ("split", "split"), ("flip", "flip"), ("meld", "meld"), ("leveler", "leveler")];

/// One term of a search: a condition on the card, or on one of its printings (`p`).
enum Part {
    Card(String),
    Printing(String),
}

/// A card that has a printing these conditions are all true of.
fn has_printing(conditions: &str) -> String {
    format!("cards.oracle_id IN (SELECT p.oracle_id FROM printings p WHERE {conditions})")
}

impl Part {
    fn sql(self) -> String {
        match self {
            Part::Card(sql) => sql,
            Part::Printing(condition) => has_printing(&condition),
        }
    }
}

/// Keywords that let two cards share the command zone (`is:partner`), lowercased.
const PARTNER_KEYWORDS: &str = "('partner','partner with','friends forever','choose a background','doctor''s companion')";

/// `cards.type_line LIKE '%A%' OR …` for each of these words.
fn any_type(words: &[&str]) -> String {
    let parts: Vec<String> = words.iter().map(|w| format!("cards.type_line LIKE '%{w}%'")).collect();
    format!("({})", parts.join(" OR "))
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn expr(&mut self) -> Result<String, String> {
        let mut parts = vec![self.and_expr()?];
        while self.peek() == Some(&Tok::Or) {
            self.pos += 1;
            parts.push(self.and_expr()?);
        }
        Ok(if parts.len() == 1 { parts.pop().unwrap() } else { format!("({})", parts.join(" OR ")) })
    }

    fn and_expr(&mut self) -> Result<String, String> {
        // Each term with the binds it pushed (a slice of `self.binds`, in order).
        let first_bind = self.binds.len();
        let mut terms: Vec<(Part, usize)> = Vec::new();
        while let Some(t) = self.peek() {
            if matches!(t, Tok::Or | Tok::RParen) {
                break;
            }
            let part = self.unary()?;
            terms.push((part, self.binds.len()));
        }
        if terms.is_empty() {
            return Err("empty expression".into());
        }
        // The printing terms of one group are about one printing: they go into one subquery,
        // after the card terms. The binds move with them, so each `?` still gets its own value.
        let mut binds = self.binds.split_off(first_bind).into_iter();
        let (mut parts, mut conditions, mut later) = (Vec::new(), Vec::new(), Vec::new());
        let mut from = first_bind;
        for (part, to) in terms {
            let own: Vec<Bind> = binds.by_ref().take(to - from).collect();
            from = to;
            match part {
                Part::Card(sql) => {
                    parts.push(sql);
                    self.binds.extend(own);
                }
                Part::Printing(condition) => {
                    conditions.push(condition);
                    later.extend(own);
                }
            }
        }
        if !conditions.is_empty() {
            parts.push(has_printing(&conditions.join(" AND ")));
            self.binds.extend(later);
        }
        Ok(if parts.len() == 1 { parts.pop().unwrap() } else { format!("({})", parts.join(" AND ")) })
    }

    fn unary(&mut self) -> Result<Part, String> {
        if self.peek() == Some(&Tok::Neg) {
            self.pos += 1;
            // Negated, a printing term is "no printing like this at all".
            return Ok(Part::Card(format!("NOT {}", self.atom()?.sql())));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Part, String> {
        match self.toks.get(self.pos).cloned() {
            Some(Tok::LParen) => {
                self.pos += 1;
                let inner = self.expr()?;
                if self.peek() != Some(&Tok::RParen) {
                    return Err("missing ')'".into());
                }
                self.pos += 1;
                Ok(Part::Card(format!("({inner})")))
            }
            Some(Tok::Term { key, op, value, exact }) => {
                self.pos += 1;
                match self.printing_term(key.as_deref(), &op, &value)? {
                    Some(condition) => Ok(Part::Printing(condition)),
                    None => self.term(key.as_deref(), &op, &value, exact).map(Part::Card),
                }
            }
            _ => Err("unexpected token".into()),
        }
    }

    fn text(&mut self, v: impl Into<String>) -> &'static str {
        self.binds.push(Bind::Text(v.into()));
        "?"
    }

    fn like(&mut self, column: &str, v: &str) -> String {
        self.binds.push(Bind::Text(format!("%{}%", escape_like(v))));
        format!("{column} LIKE ? ESCAPE '\\'")
    }

    /// A term about a printing, as a condition on `p` (a row of `printings`): a set, an artist
    /// or a release year. `None` for any other term.
    fn printing_term(&mut self, key: Option<&str>, op: &str, value: &str) -> Result<Option<String>, String> {
        let is = |op: &str, key: &str| if matches!(op, ":" | "=") { Ok(()) } else { Err(format!("{key} takes : or =, not {op}")) };
        Ok(Some(match key {
            Some(key @ ("set" | "s" | "e" | "edition")) => {
                is(op, key)?;
                let p = self.text(value.to_lowercase());
                format!("p.set_code = {p}")
            }
            Some(key @ ("a" | "artist")) => {
                is(op, key)?;
                self.like("p.artist", value)
            }
            Some("year") => {
                let n: f64 = value.parse().map_err(|_| format!("{value} isn't a year"))?;
                if !(1990.0..=2200.0).contains(&n) || n.fract() != 0.0 {
                    return Err(format!("{value} isn't a year"));
                }
                self.binds.push(Bind::Num(n));
                format!("CAST(substr(p.released_at, 1, 4) AS INTEGER) {} ?", compare(op))
            }
            _ => return Ok(None),
        }))
    }

    fn term(&mut self, key: Option<&str>, op: &str, value: &str, exact: bool) -> Result<String, String> {
        let Some(key) = key else {
            if exact {
                let p = self.text(value);
                return Ok(format!("cards.oracle_id IN (SELECT oracle_id FROM card_names WHERE name = {p})"));
            }
            return Ok(self.like("cards.name", value));
        };
        match key {
            "o" | "oracle" | "text" => {
                // "~" stands for the card's own name, as on Scryfall.
                if value.contains('~') {
                    let mut pieces = vec!["'%'"];
                    for (i, part) in value.split('~').enumerate() {
                        if i > 0 {
                            pieces.push("cards.name");
                        }
                        pieces.push(self.text(escape_like(part)));
                    }
                    pieces.push("'%'");
                    return Ok(format!("cards.oracle_text LIKE {} ESCAPE '\\'", pieces.join(" || ")));
                }
                Ok(self.like("cards.oracle_text", value))
            }
            "t" | "type" => Ok(self.like("cards.type_line", value)),
            "kw" | "keyword" => {
                let p = self.text(value.to_lowercase());
                Ok(format!("EXISTS (SELECT 1 FROM json_each(cards.keywords) WHERE lower(json_each.value) = {p})"))
            }
            "c" | "color" | "colors" => color_clause("cards.colors", op, value, ">="),
            "id" | "identity" | "ci" => color_clause("cards.color_identity", op, value, "<="),
            "mv" | "cmc" | "manavalue" => self.numeric("cards.cmc", op, value),
            "pow" | "power" => self.numeric("CAST(cards.power AS REAL)", op, value),
            "tou" | "toughness" => self.numeric("CAST(cards.toughness AS REAL)", op, value),
            "loy" | "loyalty" => self.numeric("CAST(cards.loyalty AS REAL)", op, value),
            "r" | "rarity" => {
                let r = match value.to_lowercase().as_str() {
                    "c" | "common" => "common",
                    "u" | "uncommon" => "uncommon",
                    "r" | "rare" => "rare",
                    "m" | "mythic" => "mythic",
                    "s" | "special" => "special",
                    other => return Err(format!("unknown rarity {other}")),
                };
                let p = self.text(r);
                Ok(format!("cards.rarity = {p}"))
            }
            "f" | "format" | "legal" => {
                let p = self.text(format!("$.{}", value.to_lowercase()));
                Ok(format!("json_extract(cards.legalities, {p}) IN ('legal','restricted')"))
            }
            "banned" => {
                let p = self.text(format!("$.{}", value.to_lowercase()));
                Ok(format!("json_extract(cards.legalities, {p}) = 'banned'"))
            }
            "is" => match value.to_lowercase().as_str() {
                "commander" => Ok("((cards.type_line LIKE '%Legendary%' AND (cards.type_line LIKE '%Creature%' \
                     OR cards.type_line LIKE '%Vehicle%' OR cards.type_line LIKE '%Spacecraft%')) \
                     OR cards.oracle_text LIKE '%can be your commander%')"
                    .into()),
                "legendary" => Ok("cards.type_line LIKE '%Legendary%'".into()),
                "permanent" => Ok("(cards.type_line NOT LIKE '%Instant%' AND cards.type_line NOT LIKE '%Sorcery%')".into()),
                "spell" => Ok("cards.type_line NOT LIKE '%Land%'".into()),
                "multicolor" | "multicolored" => Ok("length(cards.colors) >= 2".into()),
                "gamechanger" | "gc" => {
                    self.uses_game_changer = true;
                    Ok("cards.game_changer = 1".into())
                }
                "reserved" => {
                    self.uses_reserved = true;
                    Ok("cards.reserved = 1".into())
                }
                "partner" => Ok(format!("EXISTS (SELECT 1 FROM json_each(cards.keywords) WHERE lower(json_each.value) IN {PARTNER_KEYWORDS})")),
                "companion" => Ok("EXISTS (SELECT 1 FROM json_each(cards.keywords) WHERE lower(json_each.value) = 'companion')".into()),
                "dfc" => Ok("IFNULL(cards.layout, '') IN ('transform','modal_dfc','meld','reversible_card')".into()),
                "vanilla" => Ok("(cards.type_line LIKE '%Creature%' AND cards.oracle_text = '')".into()),
                "historic" => Ok(any_type(&["Legendary", "Artifact", "Saga"])),
                // A party is made of creatures: a Wizard's staff isn't one.
                "party" => Ok(format!("(cards.type_line LIKE '%Creature%' AND {})", any_type(&["Cleric", "Rogue", "Warrior", "Wizard"]))),
                // By the type line, not the layout: a Saga that transforms is still a Saga, and an
                // Omen shares the Adventure layout without being one.
                "saga" => Ok("cards.type_line LIKE '%Saga%'".into()),
                "adventure" => Ok("(IFNULL(cards.layout, '') = 'adventure' AND cards.type_line LIKE '%Adventure%')".into()),
                "outlaw" => Ok(any_type(&["Assassin", "Mercenary", "Pirate", "Rogue", "Warlock"])),
                // A hybrid symbol is two halves that aren't Phyrexian: {W/U}, {2/W}, not {W/P}.
                "hybrid" => Ok("IFNULL(cards.mana_cost, '') GLOB '*{[WUBRGC2]/[WUBRGC]*'".into()),
                // Phyrexian mana in the cost or in the text (Spellskite's ability).
                "phyrexian" => Ok("(IFNULL(cards.mana_cost, '') LIKE '%/P}%' OR cards.oracle_text LIKE '%/P}%')".into()),
                other => match IS_LAYOUTS.iter().find(|(name, _)| *name == other) {
                    Some((_, layout)) => Ok(format!("IFNULL(cards.layout, '') = '{layout}'")),
                    None => Err(format!("unsupported is:{other}")),
                },
            },
            "usd" => {
                let n: f64 = value.trim_start_matches('$').parse().map_err(|_| format!("{value} isn't a price"))?;
                if !n.is_finite() {
                    return Err(format!("{value} isn't a price"));
                }
                self.binds.push(Bind::Num(n));
                Ok(format!("{PRICE_SQL} {} ?", compare(op)))
            }
            "name" => Ok(self.like("cards.name", value)),
            other => Err(format!("unsupported keyword {other}:")),
        }
    }

    fn numeric(&mut self, column: &str, op: &str, value: &str) -> Result<String, String> {
        let n: f64 = value.parse().map_err(|_| format!("{value} isn't a number"))?;
        self.binds.push(Bind::Num(n));
        Ok(format!("{column} {} ?", compare(op)))
    }
}

/// A term's operator as SQL: `:` reads as `=`. The lexer only ever gives one of these.
fn compare(op: &str) -> &'static str {
    match op {
        "!=" => "!=",
        "<" => "<",
        "<=" => "<=",
        ">" => ">",
        ">=" => ">=",
        _ => "=",
    }
}

fn escape_like(v: &str) -> String {
    v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Parse a color expression into a WUBRG subset. `None` means "multicolor".
fn parse_colors(v: &str) -> Result<Option<String>, String> {
    let v = v.to_lowercase();
    let named = match v.as_str() {
        "white" => "w",
        "blue" => "u",
        "black" => "b",
        "red" => "r",
        "green" => "g",
        "c" | "colorless" => "",
        "m" | "multicolor" | "multicolored" => return Ok(None),
        "azorius" => "wu",
        "dimir" => "ub",
        "rakdos" => "br",
        "gruul" => "rg",
        "selesnya" => "gw",
        "orzhov" => "wb",
        "izzet" => "ur",
        "golgari" => "bg",
        "boros" => "rw",
        "simic" => "gu",
        "bant" => "gwu",
        "esper" => "wub",
        "grixis" => "ubr",
        "jund" => "brg",
        "naya" => "rgw",
        "abzan" => "wbg",
        "jeskai" => "urw",
        "sultai" => "bgu",
        "mardu" => "rwb",
        "temur" => "gur",
        "wubrg" | "fivecolor" | "5c" => "wubrg",
        other => other,
    };
    if let Some(bad) = named.chars().find(|c| !"wubrg".contains(*c)) {
        return Err(format!("unknown color '{bad}'"));
    }
    Ok(Some("WUBRG".chars().filter(|c| named.contains(c.to_ascii_lowercase())).collect()))
}

fn color_clause(column: &str, op: &str, value: &str, default_op: &str) -> Result<String, String> {
    let Some(set) = parse_colors(value)? else {
        return Ok(format!("length({column}) >= 2"));
    };
    let op = if op == ":" { default_op } else { op };
    let has = |c: char| format!("instr({column}, '{c}') > 0");
    let lacks = |c: char| format!("instr({column}, '{c}') = 0");
    let includes = set.chars().map(has).collect::<Vec<_>>();
    let within = "WUBRG".chars().filter(|c| !set.contains(*c)).map(lacks).collect::<Vec<_>>();
    let all = |v: Vec<String>| if v.is_empty() { "1".to_string() } else { format!("({})", v.join(" AND ")) };
    let n = set.len();
    Ok(match op {
        ">=" => all(includes),
        "<=" => all(within),
        "=" => format!("({} AND {})", all(includes), all(within)),
        "!=" => format!("NOT ({} AND {})", all(includes), all(within)),
        ">" => format!("({} AND length({column}) > {n})", all(includes)),
        "<" => format!("({} AND length({column}) < {n})", all(within)),
        other => return Err(format!("unsupported operator {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_words_and_keys() {
        let c = compile("sol ring t:artifact").unwrap();
        assert_eq!(c.sql, "(cards.name LIKE ? ESCAPE '\\' AND cards.name LIKE ? ESCAPE '\\' AND cards.type_line LIKE ? ESCAPE '\\')");
        assert_eq!(c.binds[2], Bind::Text("%artifact%".into()));
    }

    #[test]
    fn identity_defaults_to_within() {
        let c = compile("id:gw").unwrap();
        assert!(c.sql.contains("instr(cards.color_identity, 'U') = 0"));
        assert!(!c.sql.contains("'G') = 0"));
    }

    #[test]
    fn or_negation_parens() {
        let c = compile("(t:elf or t:goblin) -c:r mv<=2").unwrap();
        assert!(c.sql.starts_with("(((cards.type_line LIKE"));
        assert!(c.sql.contains(" OR "));
        assert!(c.sql.contains("NOT (instr(cards.colors, 'R') > 0)"));
        assert!(c.sql.contains("cards.cmc <= ?"));
    }

    #[test]
    fn exact_and_quoted() {
        let c = compile(r#"!"Sol Ring" o:"draw a card""#).unwrap();
        assert!(c.sql.contains("card_names WHERE name = ?"));
        assert_eq!(c.binds[0], Bind::Text("Sol Ring".into()));
        assert_eq!(c.binds[1], Bind::Text("%draw a card%".into()));
    }

    #[test]
    fn errors_are_reported() {
        assert!(compile("c:xyz").is_err());
        assert!(compile("mv>=abc").is_err());
        assert!(compile("(t:elf").is_err());
        assert!(compile("o:\"open").is_err());
    }

    #[test]
    fn game_changers() {
        assert_eq!(compile("is:gamechanger").unwrap().sql, "cards.game_changer = 1");
        assert_eq!(compile("is:gc").unwrap().sql, "cards.game_changer = 1");
        assert_eq!(compile("-is:GameChanger t:artifact").unwrap().sql, "(NOT cards.game_changer = 1 AND cards.type_line LIKE ? ESCAPE '\\')");
        // The route checks the flags are loaded before running these.
        assert!(compile("t:artifact (is:gc or mv<1)").unwrap().uses_game_changer);
        assert!(!compile("t:artifact").unwrap().uses_game_changer);
    }

    #[test]
    fn sets_artists_years_and_prices() {
        // A set is matched by its code, in lower case, over every printing.
        let c = compile("set:CMM").unwrap();
        assert_eq!(c.sql, "cards.oracle_id IN (SELECT p.oracle_id FROM printings p WHERE p.set_code = ?)");
        assert_eq!(c.binds, vec![Bind::Text("cmm".into())]);
        for alias in ["s:cmm", "e:cmm", "edition:cmm"] {
            assert_eq!(compile(alias).unwrap().sql, c.sql, "{alias}");
        }
        let c = compile(r#"a:"rebecca guay""#).unwrap();
        assert!(c.sql.contains("p.artist LIKE ? ESCAPE '\\'"), "{}", c.sql);
        assert_eq!(c.binds, vec![Bind::Text("%rebecca guay%".into())]);
        assert_eq!(compile("artist:guay").unwrap().sql, c.sql);
        let c = compile("year>=2020").unwrap();
        assert!(c.sql.ends_with("CAST(substr(p.released_at, 1, 4) AS INTEGER) >= ?)"), "{}", c.sql);
        assert_eq!(c.binds, vec![Bind::Num(2020.0)]);
        assert!(compile("year:1994").unwrap().sql.contains("AS INTEGER) = ?"));
        for bad in ["year:soon", "year:94", "year>2020.5"] {
            assert!(compile(bad).is_err(), "{bad}");
        }
        // The price compared is the one the results show; NULL (no price) is never under or over.
        let c = compile("usd<5").unwrap();
        assert_eq!(c.sql, format!("{PRICE_SQL} < ?"));
        assert_eq!(c.binds, vec![Bind::Num(5.0)]);
        assert_eq!(compile("usd>=$2.50").unwrap().binds, vec![Bind::Num(2.5)]);
        assert_eq!(compile("-usd>5").unwrap().sql, format!("NOT {PRICE_SQL} > ?"));
        assert!(compile("usd<cheap").is_err());
        assert!(compile("usd<inf").is_err());
    }

    #[test]
    fn printing_terms_side_by_side_are_about_one_printing() {
        // Both years and the set are asked of the same printing, after the card term, and every
        // `?` still gets its own value.
        let c = compile("year>=2000 t:artifact year<=2005 set:MRD").unwrap();
        assert_eq!(
            c.sql,
            "(cards.type_line LIKE ? ESCAPE '\\' AND cards.oracle_id IN (SELECT p.oracle_id FROM printings p WHERE \
             CAST(substr(p.released_at, 1, 4) AS INTEGER) >= ? AND CAST(substr(p.released_at, 1, 4) AS INTEGER) <= ? AND p.set_code = ?))"
        );
        assert_eq!(c.binds, vec![Bind::Text("%artifact%".into()), Bind::Num(2000.0), Bind::Num(2005.0), Bind::Text("mrd".into())]);
        // Each side of an "or", and each group in parentheses, is about a printing of its own.
        let c = compile("set:lea or (set:leb sol) year<1995").unwrap();
        assert_eq!(c.sql.matches("FROM printings p").count(), 3, "{}", c.sql);
        assert_eq!(c.binds, vec![Bind::Text("lea".into()), Bind::Text("%sol%".into()), Bind::Text("leb".into()), Bind::Num(1995.0)]);
        // Negated: the card has no such printing at all.
        assert_eq!(compile("-set:cmm").unwrap().sql, "NOT cards.oracle_id IN (SELECT p.oracle_id FROM printings p WHERE p.set_code = ?)");
        let c = compile("-year<2000 a:guay").unwrap();
        assert_eq!(c.sql.matches("FROM printings p").count(), 2, "{}", c.sql);
        assert_eq!(c.binds, vec![Bind::Num(2000.0), Bind::Text("%guay%".into())]);
        // A printing is or isn't from a set or by an artist: no other comparison is read.
        for bad in ["set!=cmm", "set>cmm", "e<lea", "a!=guay", "artist>=guay"] {
            assert!(compile(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn more_is_values() {
        let c = compile("is:reserved").unwrap();
        assert_eq!(c.sql, "cards.reserved = 1");
        // The route checks the list is loaded before running these.
        assert!(c.uses_reserved && !c.uses_game_changer);
        assert!(!compile("is:gc").unwrap().uses_reserved);
        assert_eq!(compile("is:mdfc").unwrap().sql, "IFNULL(cards.layout, '') = 'modal_dfc'");
        assert_eq!(compile("is:Split").unwrap().sql, "IFNULL(cards.layout, '') = 'split'");
        // By the type line: a Saga that transforms is still one, and an Omen isn't an Adventure.
        assert_eq!(compile("is:saga").unwrap().sql, "cards.type_line LIKE '%Saga%'");
        assert_eq!(compile("is:adventure").unwrap().sql, "(IFNULL(cards.layout, '') = 'adventure' AND cards.type_line LIKE '%Adventure%')");
        assert!(compile("is:dfc").unwrap().sql.contains("'transform','modal_dfc','meld','reversible_card'"));
        assert!(compile("is:partner").unwrap().sql.contains("'choose a background'"));
        assert!(compile("is:companion").unwrap().sql.contains("= 'companion'"));
        assert_eq!(compile("is:vanilla").unwrap().sql, "(cards.type_line LIKE '%Creature%' AND cards.oracle_text = '')");
        assert_eq!(compile("is:historic").unwrap().sql, "(cards.type_line LIKE '%Legendary%' OR cards.type_line LIKE '%Artifact%' OR cards.type_line LIKE '%Saga%')");
        assert!(compile("is:party").unwrap().sql.starts_with("(cards.type_line LIKE '%Creature%' AND (cards.type_line LIKE '%Cleric%' OR"));
        assert!(compile("is:outlaw").unwrap().sql.contains("'%Warlock%'"));
        assert_eq!(compile("is:hybrid").unwrap().sql, "IFNULL(cards.mana_cost, '') GLOB '*{[WUBRGC2]/[WUBRGC]*'");
        assert_eq!(compile("is:phyrexian").unwrap().sql, "(IFNULL(cards.mana_cost, '') LIKE '%/P}%' OR cards.oracle_text LIKE '%/P}%')");
        // None of them binds anything, so none can carry what was typed into the SQL.
        assert!(compile("is:reserved is:partner is:hybrid is:historic").unwrap().binds.is_empty());
        assert!(compile("is:nonsense").is_err());
    }

    #[test]
    fn the_typed_name_is_the_bare_words() {
        assert_eq!(name_phrase("sol ring").as_deref(), Some("sol ring"));
        assert_eq!(name_phrase("Sol  Ring t:artifact").as_deref(), Some("sol ring"));
        assert_eq!(name_phrase(r#""Sol Ring" mv<=1"#).as_deref(), Some("sol ring"));
        // Negated and exact words, and keyed terms, aren't the name being typed.
        assert_eq!(name_phrase("ring -sol").as_deref(), Some("ring"));
        // A negated group excludes everything in it, however deep; the words after it count.
        assert_eq!(name_phrase("-(sol ring) lotus").as_deref(), Some("lotus"));
        assert_eq!(name_phrase("-(sol (ring or petal)) black lotus").as_deref(), Some("black lotus"));
        assert_eq!(name_phrase("(sol ring) -(t:artifact bloom)").as_deref(), Some("sol ring"));
        assert_eq!(name_phrase("-(sol ring)"), None);
        assert_eq!(name_phrase(r#"!"Sol Ring""#), None);
        assert_eq!(name_phrase("t:artifact id<=w"), None);
        assert_eq!(name_phrase(""), None);
        // A query that doesn't parse has no name to order by; the search itself reports the error.
        assert_eq!(name_phrase("o:\"open"), None);
        let (sql, binds) = name_rank("100%_sol");
        assert!(sql.starts_with("CASE WHEN cards.name = ? COLLATE NOCASE THEN 0"));
        assert_eq!(binds, [Bind::Text("100%_sol".into()), Bind::Text("100\\%\\_sol%".into())]);
    }

    #[test]
    fn hyphenated_names_are_words() {
        // A '-' inside a word is not negation.
        let c = compile("mirror-breaker").unwrap();
        assert_eq!(c.binds, vec![Bind::Text("%mirror-breaker%".into())]);
    }
}
