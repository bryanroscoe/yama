//! Matching imported names to cards: exact first (any face, any case), then a forgiving match
//! that ignores accents, curly quotes and how split and double-faced names are written, then
//! "did you mean" suggestions by edit distance for what's left.

use crate::error::AppResult;
use sqlx::SqlitePool;
use std::collections::HashMap;

/// "Lim-Dûl's Vault" → "lim-dul's vault"; "Fire/Ice" and "Fire // Ice" → "fire // ice";
/// "Æther Vial" → "aether vial"; curly quotes become straight; spaces collapse.
pub fn normalize(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '’' | '‘' | '`' | '´' | 'ʼ' => s.push('\''),
            '“' | '”' => s.push('"'),
            'æ' | 'Æ' => s.push_str("ae"),
            'œ' | 'Œ' => s.push_str("oe"),
            _ => match fold(c) {
                Some(f) => s.push(f),
                None => s.extend(c.to_lowercase()),
            },
        }
    }
    // Split and double-faced names: any slash form reads as " // ".
    let s = s.replace(" // ", "/").replace("//", "/").replace(" / ", "/").replace('/', " // ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Accented Latin letters to plain ones (lower case), for the handful card names use.
fn fold(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
        'ç' | 'Ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
        'ñ' | 'Ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
        'ý' | 'ÿ' | 'Ý' => 'y',
        _ => return None,
    })
}

/// Levenshtein distance, giving up (returning `max + 1`) once it can't stay within `max`.
pub fn distance(a: &str, b: &str, max: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            row_min = row_min.min(cur[j]);
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Every card name Yama knows (faces included, tokens and art cards left out), normalized.
pub struct NameIndex {
    /// normalized name → (canonical card name, oracle id); several oracle ids can share one.
    entries: Vec<(String, String, String)>,
    exact: HashMap<String, Vec<usize>>,
}

impl NameIndex {
    pub async fn load(pool: &SqlitePool) -> AppResult<Self> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT n.name, c.name, c.oracle_id FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
             WHERE IFNULL(c.layout, '') NOT IN ('token', 'double_faced_token', 'art_series', 'emblem')",
        )
        .fetch_all(pool)
        .await?;
        let mut entries = Vec::with_capacity(rows.len());
        let mut exact: HashMap<String, Vec<usize>> = HashMap::new();
        for (alias, canonical, oid) in rows {
            let key = normalize(&alias);
            exact.entry(key.clone()).or_default().push(entries.len());
            entries.push((key, canonical, oid));
        }
        Ok(NameIndex { entries, exact })
    }

    /// One card whose normalized name (or a face's) is exactly this; `None` if none or several
    /// different cards.
    pub fn forgiving(&self, name: &str) -> Option<(String, String)> {
        let key = normalize(name);
        let hits = self.exact.get(&key)?;
        let first = &self.entries[hits[0]];
        if hits.iter().all(|&i| self.entries[i].2 == first.2) {
            return Some((first.1.clone(), first.2.clone()));
        }
        // Several cards: the one whose own name this is beats one with it as a face.
        let own: Vec<&(String, String, String)> = hits.iter().map(|&i| &self.entries[i]).filter(|e| normalize(&e.1) == key).collect();
        (own.len() == 1).then(|| (own[0].1.clone(), own[0].2.clone()))
    }

    /// Up to `n` likely cards: names this one starts (at a word break), then the closest by edit
    /// distance. Each card once.
    pub fn suggest(&self, name: &str, n: usize) -> Vec<(String, String)> {
        let q = normalize(name);
        if q.len() < 3 {
            return vec![];
        }
        let max = match q.chars().count() {
            0..=5 => 1,
            6..=11 => 2,
            12..=19 => 3,
            k => k / 6,
        };
        let mut scored: Vec<(usize, usize, &String, &String)> = Vec::new();
        for (key, canonical, oid) in &self.entries {
            let prefix = key.len() > q.len() && key.starts_with(&q) && key[q.len()..].starts_with([',', ' ']);
            let d = if prefix { 0 } else { distance(&q, key, max) };
            if prefix || d <= max {
                // Prefix hits first, then by distance, then shorter names.
                scored.push((usize::from(!prefix), d, canonical, oid));
            }
        }
        scored.sort_by(|a, b| (a.0, a.1, a.2.len(), a.2).cmp(&(b.0, b.1, b.2.len(), b.2)));
        let mut out: Vec<(String, String)> = Vec::new();
        for (_, _, canonical, oid) in scored {
            if out.iter().all(|(_, o)| o != oid) {
                out.push((canonical.clone(), oid.clone()));
            }
            if out.len() == n {
                break;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizing_forgives_accents_quotes_and_split_names() {
        assert_eq!(normalize("Lim-Dûl's Vault"), normalize("Lim-Dul’s Vault"));
        assert_eq!(normalize("Fire/Ice"), "fire // ice");
        assert_eq!(normalize("Fire // Ice"), "fire // ice");
        assert_eq!(normalize("Fire / Ice"), "fire // ice");
        assert_eq!(normalize("Æther Vial"), "aether vial");
        assert_eq!(normalize("  Sol   Ring "), "sol ring");
        assert_eq!(normalize("Jötun Grunt"), "jotun grunt");
    }

    #[test]
    fn distance_is_bounded() {
        assert_eq!(distance("sol ring", "sol ring", 2), 0);
        assert_eq!(distance("sol rnig", "sol ring", 2), 2);
        assert_eq!(distance("atraxa", "atraxa, praetors' voice", 2), 3);
        assert_eq!(distance("a", "abcdef", 2), 3);
    }
}
