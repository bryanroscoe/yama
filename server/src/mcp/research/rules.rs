//! An independently written index of official rules fetched at runtime. No rules are bundled.

use super::client::{Provider, Research, trusted_rules_url};
use crate::error::{AppError, AppResult};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use url::Url;

#[derive(Default)]
pub struct Rules {
    pub entries: BTreeMap<String, String>,
    pub glossary: BTreeMap<String, String>,
    pub effective: Option<String>,
}

pub fn rule_number(s: &str) -> bool {
    let Some((section, tail)) = s.split_once('.') else {
        return false;
    };
    section.len() == 3
        && section.bytes().all(|c| c.is_ascii_digit())
        && !tail.is_empty()
        && tail.as_bytes()[0].is_ascii_digit()
        && tail
            .bytes()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

pub fn parse(text: &str) -> Rules {
    let mut out = Rules::default();
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let glossary = lines
        .iter()
        .rposition(|l| l.trim() == "Glossary")
        .unwrap_or(lines.len());
    let mut number = String::new();
    for line in &lines[..glossary] {
        if line.to_lowercase().contains("rules are effective") {
            out.effective = Some(line.trim().to_string());
        }
        let first = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('.');
        if rule_number(first) {
            number = first.into();
            out.entries.insert(number.clone(), line.trim().to_string());
        } else if first.len() == 3 && first.bytes().all(|b| b.is_ascii_digit()) {
            number.clear();
        } else if !number.is_empty() && !line.trim().is_empty() {
            let text = out.entries.get_mut(&number).expect("current rule");
            text.push('\n');
            text.push_str(line.trim());
        }
    }
    let mut block: Vec<&str> = Vec::new();
    for line in lines
        .iter()
        .skip(glossary + usize::from(glossary < lines.len()))
        .copied()
        .chain(std::iter::once(""))
    {
        if line.trim() == "Credits" {
            break;
        }
        if line.trim().is_empty() {
            if block.len() >= 2 {
                out.glossary
                    .insert(block[0].trim().to_string(), block[1..].join("\n"));
            }
            block.clear();
        } else {
            block.push(line);
        }
    }
    out
}

pub fn discover(html: &str) -> AppResult<Url> {
    // Read URLs from ordinary attributes; an escaped copy in a hydration script is not a URL.
    html.split(['"', '\'', '<', '>']).filter(|s| s.starts_with("https://") && s.contains("MagicCompRules") && s.ends_with(".txt"))
        .filter_map(|s| Url::parse(&s.replace("&amp;", "&")).ok())
        .filter(trusted_rules_url).max_by(|a,b| a.path().cmp(b.path()))
        .ok_or_else(|| AppError::Unavailable("Wizards' rules page did not expose an official rules text link; no older edition was substituted.".into()))
}

/// The current edition, parsed once and kept by its dated URL with its provenance. The rules
/// page that names the edition is rechecked about daily (the research cache's time for it).
static PARSED: std::sync::Mutex<Option<(String, Arc<Rules>, Value)>> = std::sync::Mutex::new(None);

async fn current(client: &Research, who: Option<&str>) -> AppResult<(Arc<Rules>, Value)> {
    let page = client.get(who, Provider::Rules, "/en/rules", &[]).await?;
    let url = discover(page.text()?)?;
    if let Some((kept, rules, provenance)) = PARSED.lock().expect("rules").as_ref()
        && kept == url.as_str()
    {
        let mut provenance = provenance.clone();
        provenance["cached"] = true.into();
        return Ok((rules.clone(), provenance));
    }
    let doc = client.rules_document(who, url.clone()).await?;
    let rules = parse(doc.text()?);
    if rules.entries.len() < 100 {
        return Err(AppError::Unavailable(
            "The official rules document could not be indexed; no rule text was guessed.".into(),
        ));
    }
    let rules = Arc::new(rules);
    *PARSED.lock().expect("rules") = Some((url.to_string(), rules.clone(), doc.provenance()));
    Ok((rules, doc.provenance()))
}

pub async fn lookup(client: &Research, who: Option<&str>, query: &str, limit: usize) -> AppResult<Value> {
    let (rules, provenance) = current(client, who).await?;
    let query = query.trim().trim_end_matches('.');
    let matches: Vec<Value> = if rule_number(query) {
        rules
            .entries
            .iter()
            .filter(|(n, _)| {
                *n == query
                    || n.strip_prefix(query).is_some_and(|tail| {
                        !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_alphabetic())
                    })
            })
            .map(|(n, t)| json!({"number": n,"text": t}))
            .collect()
    } else {
        let lower = query.to_lowercase();
        let mut hits: Vec<Value> = rules
            .glossary
            .iter()
            .filter(|(term, _)| term.to_lowercase() == lower)
            .map(|(term, text)| json!({"term": term,"text": text}))
            .collect();
        hits.extend(
            rules
                .entries
                .iter()
                .filter(|(_, t)| t.to_lowercase().contains(&lower))
                .map(|(n, t)| json!({"number": n,"text": t})),
        );
        hits
    };
    Ok(
        json!({"provenance": provenance, "effective": rules.effective, "query": query,
        "total_matches": matches.len(), "truncated": matches.len() > limit, "matches": matches.into_iter().take(limit).collect::<Vec<_>>(),
        "note": "Official rules evidence. Apply the cited rules to the actual scenario; an absent number is unknown, never a fabricated rule."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexes_rule_boundaries_and_glossary_without_guessing() {
        let r = parse(
            "Magic\nThese rules are effective as of September 25, 2026.\n702.19. Trample\n702.19a First paragraph.\nExample: A test.\n702.190a Another ability.\n703. Other section\nNot part of the previous rule.\nGlossary\n\nTrample\nA keyword.\n\nCredits\nPeople\n",
        );
        assert_eq!(
            r.entries["702.19a"],
            "702.19a First paragraph.\nExample: A test."
        );
        assert_eq!(r.entries["702.190a"], "702.190a Another ability.");
        assert_eq!(r.glossary["Trample"], "A keyword.");
        assert!(r.effective.unwrap().contains("2026"));
        assert!(!rule_number("702.19/../../"));
    }
    #[test]
    fn rules_discovery_rejects_other_hosts_and_credentials() {
        assert!(discover("href=\"https://wizards.com.evil.test/MagicCompRules.txt\"").is_err());
        assert!(discover("href=\"https://user@media.wizards.com/MagicCompRules.txt\"").is_err());
        assert_eq!(
            discover("href=\"https://media.wizards.com/2026/MagicCompRules 20260925.txt\"")
                .unwrap()
                .path(),
            "/2026/MagicCompRules%2020260925.txt"
        );
    }
}
