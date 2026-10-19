//! A subset of Scryfall's search syntax, compiled to a SQL `WHERE` clause over `cards`.
//!
//! Supported: bare words and "quoted phrases" (name), `!"exact name"`, `o:` `t:` `kw:`,
//! `c:` / `id:` with `= != < <= > >=` (colors as letters, names, guilds, shards, wedges,
//! `c`/colorless, `m`/multicolor), `mv`/`cmc`, `pow`, `tou`, `loy`, `r:`, `f:`/`legal:`,
//! `banned:`, `is:commander`, `is:legendary`, `is:gamechanger` (or `is:gc`), negation `-`, `or`,
//! and parentheses.
//! The same grammar runs offline in the app (`packages/core`), so keep them in step.


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
}

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
    let mut p = Parser { toks, pos: 0, binds: Vec::new(), uses_game_changer: false };
    if p.toks.is_empty() {
        return Ok(Compiled { sql: "1".into(), binds: vec![], uses_game_changer: false });
    }
    let sql = p.expr()?;
    if p.pos < p.toks.len() {
        return Err("unexpected ')'".into());
    }
    Ok(Compiled { sql, binds: p.binds, uses_game_changer: p.uses_game_changer })
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
        let mut parts = Vec::new();
        while let Some(t) = self.peek() {
            if matches!(t, Tok::Or | Tok::RParen) {
                break;
            }
            parts.push(self.unary()?);
        }
        if parts.is_empty() {
            return Err("empty expression".into());
        }
        Ok(if parts.len() == 1 { parts.pop().unwrap() } else { format!("({})", parts.join(" AND ")) })
    }

    fn unary(&mut self) -> Result<String, String> {
        if self.peek() == Some(&Tok::Neg) {
            self.pos += 1;
            return Ok(format!("NOT {}", self.atom()?));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<String, String> {
        match self.toks.get(self.pos).cloned() {
            Some(Tok::LParen) => {
                self.pos += 1;
                let inner = self.expr()?;
                if self.peek() != Some(&Tok::RParen) {
                    return Err("missing ')'".into());
                }
                self.pos += 1;
                Ok(format!("({inner})"))
            }
            Some(Tok::Term { key, op, value, exact }) => {
                self.pos += 1;
                self.term(key.as_deref(), &op, &value, exact)
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
                other => Err(format!("unsupported is:{other}")),
            },
            "name" => Ok(self.like("cards.name", value)),
            other => Err(format!("unsupported keyword {other}:")),
        }
    }

    fn numeric(&mut self, column: &str, op: &str, value: &str) -> Result<String, String> {
        let n: f64 = value.parse().map_err(|_| format!("{value} isn't a number"))?;
        let op = match op {
            ":" | "=" => "=",
            "!=" => "!=",
            o => o,
        };
        self.binds.push(Bind::Num(n));
        Ok(format!("{column} {op} ?"))
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
    fn hyphenated_names_are_words() {
        // A '-' inside a word is not negation.
        let c = compile("mirror-breaker").unwrap();
        assert_eq!(c.binds, vec![Bind::Text("%mirror-breaker%".into())]);
    }
}
