//! The filter on text people type that shows on public pages: a deck's name, its description
//! and its configuration labels, and a handle.
//!
//! It does two things and no more, so that it almost never touches honest text:
//!
//! - **Masks a short list of slurs and threats** ([`WORDS`], [`PHRASES`]) as `***`. A word is
//!   matched whole, never inside another word, after folding case, a few accents and the usual
//!   digit-for-letter spellings. Ordinary swearing is left alone: it is not what makes a public
//!   page hostile, and Commander decks are named with plenty of it.
//! - **Takes links out of public descriptions and names** ([`unlink`]): a link is what makes
//!   spam worth posting, and nothing a deck needs. `[link removed]` stands where one was.
//!
//! This is the floor, not the moderation: every public deck and profile has a Report link and
//! an admin can take a deck down (`moderation.rs`). The owner's stored text is never changed;
//! the filter runs when a public page is drawn.

/// Slurs, masked when they stand as a whole word (with or without a plural s). Kept short and
/// unambiguous on purpose. A word that is also an ordinary word, a name or a number somewhere
/// is not here: "chink" (in the armor), "spic" (and span), "fag" and "pedo" (other languages),
/// "Kike" (a Spanish nickname) and "1488" (a price) all stay as typed.
const WORDS: &[&str] = &[
    "nigger", "nigga", "niggah", "gook", "wetback", "beaner", "towelhead", "raghead", "sandnigger", "jigaboo", "faggot", "tranny", "shemale", "retard",
    "retarded", "rape", "raping", "rapist", "pedophile",
];

/// The same for runs of words.
const PHRASES: &[&str] = &["heil hitler", "sieg heil", "gas the jews", "kill yourself", "kill urself"];

/// The ones looked for inside a handle, where words run together: only those that are not part
/// of an honest word ("rapist" is in "therapist" and "retard" in "retardant", so those are
/// matched as a whole part only).
const IN_HANDLES: &[&str] = &["nigger", "nigga", "faggot", "tranny", "wetback", "pedophile", "heilhitler", "siegheil"];

/// One letter as the filter compares it: lower case, without the common accents, and with the
/// digits and signs people write letters with.
fn fold(c: char) -> char {
    match c.to_lowercase().next().unwrap_or(c) {
        '0' => 'o',
        '1' => 'i',
        '3' => 'e',
        '4' | '@' => 'a',
        '5' | '$' => 's',
        '7' => 't',
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        c => c,
    }
}

/// A word of the text: where it is, as typed in lower case, and folded.
struct Token {
    start: usize,
    end: usize,
    plain: String,
    folded: String,
}

/// Characters that take no room on the page: put inside a word, they would split it for the
/// filter and show nothing to a reader.
fn invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}')
}

/// The words of `text`: runs of letters and digits. `@` and `$` count inside a word, where
/// they stand for a letter, and an invisible character inside a word is part of it.
fn tokens(text: &str) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    let mut open = false;
    for (i, c) in text.char_indices() {
        if open && invisible(c) {
            continue;
        }
        let inside = c.is_alphanumeric() || (open && matches!(c, '@' | '$'));
        if !inside {
            open = false;
            continue;
        }
        if !open {
            out.push(Token { start: i, end: i, plain: String::new(), folded: String::new() });
            open = true;
        }
        let t = out.last_mut().expect("just pushed");
        t.end = i + c.len_utf8();
        t.plain.extend(c.to_lowercase());
        t.folded.push(fold(c));
    }
    out
}

fn is_word(t: &str) -> bool {
    WORDS.contains(&t) || t.strip_suffix('s').is_some_and(|stem| WORDS.contains(&stem))
}

/// The byte ranges of `text` the filter masks, in order, not overlapping.
fn blocked(text: &str) -> Vec<(usize, usize)> {
    let tokens = tokens(text);
    let mut spans: Vec<(usize, usize)> = tokens.iter().filter(|t| is_word(&t.plain) || is_word(&t.folded)).map(|t| (t.start, t.end)).collect();
    for phrase in PHRASES {
        let words: Vec<&str> = phrase.split(' ').collect();
        for run in tokens.windows(words.len()) {
            if run.iter().zip(&words).all(|(t, w)| t.folded == *w || t.plain == *w) {
                spans.push((run[0].start, run[words.len() - 1].end));
            }
        }
    }
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// `text` with every blocked word or phrase written as `***`.
pub(crate) fn mask(text: &str) -> String {
    let spans = blocked(text);
    if spans.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end) in spans {
        out.push_str(&text[at..start]);
        out.push_str("***");
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

/// Endings that make a bare `name.ending` a web address. Only ones that are not also everyday
/// words, so a full stop without a space after it ("Great deck.Top end is weak", "Good
/// game.GG") is not a link.
const ENDINGS: &[&str] = &["com", "net", "org", "io", "xyz", "info", "biz", "ru", "cn", "tv", "cc", "ly", "tk"];

/// Whether a run of text without spaces is a link: it has a scheme, starts with `www.`, or is a
/// host name that either has one of [`ENDINGS`] or is followed by a path (`t.me/x`,
/// `discord.gg/abc`).
fn is_link(chunk: &str) -> bool {
    let lower = chunk.to_lowercase();
    if lower.contains("://") || lower.starts_with("www.") {
        return true;
    }
    let (host, path) = match lower.find(['/', '?', '#']) {
        Some(at) => (&lower[..at], &lower[at..]),
        None => (lower.as_str(), ""),
    };
    let labels: Vec<&str> = host.split('.').collect();
    let Some(ending) = labels.last() else { return false };
    labels.len() >= 2
        && labels.iter().all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && (ENDINGS.contains(ending) || (path.len() > 1 && path.starts_with('/') && ending.len() >= 2 && ending.chars().all(|c| c.is_ascii_alphabetic())))
}

/// `text` with each link replaced by `[link removed]`. Spaces, line breaks and the punctuation
/// around a link stay as typed.
pub(crate) fn unlink(text: &str) -> String {
    const OPENERS: &[char] = &['(', '[', '<', '"', '\'', '“', '‘'];
    const CLOSERS: &[char] = &[')', ']', '>', '"', '\'', '”', '’', '.', ',', ';', ':', '!', '?'];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let space = rest.find(|c: char| !c.is_whitespace()).unwrap_or(rest.len());
        out.push_str(&rest[..space]);
        rest = &rest[space..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (chunk, after) = rest.split_at(end);
        rest = after;
        let core = chunk.trim_start_matches(OPENERS);
        let lead = &chunk[..chunk.len() - core.len()];
        let trimmed = core.trim_end_matches(CLOSERS);
        let tail = &core[trimmed.len()..];
        if !trimmed.is_empty() && is_link(trimmed) {
            out.push_str(lead);
            out.push_str("[link removed]");
            out.push_str(tail);
        } else {
            out.push_str(chunk);
        }
    }
    out
}

/// Owner-typed text as a public page shows it: blocked words masked, and links taken out when
/// `links` says so (a public deck; a deck shared by link keeps its links for the friends it was
/// sent to).
pub(crate) fn public(text: &str, links: bool) -> String {
    // Links first: a masked word inside an address would stop it reading as one.
    if links { mask(&unlink(text)) } else { mask(text) }
}

/// Whether a handle (already lower case letters, digits, - and _) is free of the filter's
/// words: none as one of its parts, and none of the longer ones run together inside it.
pub(crate) fn handle_ok(handle: &str) -> bool {
    if handle.split(['-', '_']).any(|part| is_word(part) || is_word(&part.chars().map(fold).collect::<String>())) {
        return false;
    }
    let joined: String = handle.chars().filter(|c| !matches!(c, '-' | '_')).map(fold).collect();
    !IN_HANDLES.iter().any(|w| joined.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slurs_are_masked_as_whole_words_however_they_are_spelled() {
        assert_eq!(mask("My faggot deck"), "My *** deck");
        assert_eq!(mask("F4GG0T tribal"), "*** tribal");
        assert_eq!(mask("two retards walk in"), "two *** walk in");
        assert_eq!(mask("Heil  Hitler, friends"), "***, friends");
        assert_eq!(mask("go kill yourself"), "go ***");
        assert_eq!(mask("rétard"), "***");
        // More than one, and next to each other.
        assert_eq!(mask("rape rape"), "*** ***");
        // A character that shows nothing can't split a word out of the filter's sight.
        assert_eq!(mask("fag\u{200B}got deck"), "*** deck");
        assert_eq!(mask("re\u{AD}tard"), "***");
    }

    /// The point of a short list matched on whole words: card names, Magic terms and ordinary
    /// deck names come through untouched, swearing included.
    #[test]
    fn honest_names_are_left_alone() {
        for name in [
            "Grape Shot Storm",
            "Scrape the Barrel",
            "Therapist Tribal",
            "Niger Delta Landfall",
            "Raccoon City (Coon Rapids)",
            "Spice Rack",
            "Fire Retardant Foam",
            "Pakistani Food Tokens",
            "Kiki-Jiki, Mirror Breaker",
            "Fuck You, Pay Me",
            "Damn Fine Dragons",
            "Hitler did nothing right: a history deck",
            "Assassin's Trophy",
            "Chinkara Herd",
            "Dyke March Pride",
            "Chink in the Armor",
            "Spic and Span",
            "Kike's Dragons",
            "$1488 budget",
            "Pedo de dragón",
            "White Power Rangers (mono-white)",
            "Cockatrice Classic",
            "Élan Vital",
            "100% Budget $50",
        ] {
            assert_eq!(mask(name), name, "{name}");
        }
    }

    #[test]
    fn links_are_taken_out_and_the_rest_stays_as_typed() {
        assert_eq!(unlink("Buy cards at https://spam.example/x?y=1 today"), "Buy cards at [link removed] today");
        assert_eq!(unlink("see www.spam.com."), "see [link removed].");
        assert_eq!(unlink("list (moxfield.com/decks/abc) here"), "list ([link removed]) here");
        assert_eq!(unlink("first line\n\nHTTP://X.RU second"), "first line\n\n[link removed] second");
        assert_eq!(unlink("discord.gg/abc, t.me/x and youtu.be/abc"), "[link removed], [link removed] and [link removed]");
        // Not links: a missing space after a full stop, versions, prices, ratios, card text.
        for plain in [
            "Great deck.Top end is weak",
            "Good game.GG",
            "ramp and/or draw, 1/2.5 odds, w/o lands",
            "v2.0 of the list",
            "Costs $12.50 on Nov 3",
            "Wins 2.5 games in 10",
            "Mr.Mime and Dr.Who",
            "{T}: Add {G}. Activate only as a sorcery.",
            "e.g. ramp, i.e. lands",
            "  leading and trailing  ",
            "",
        ] {
            assert_eq!(unlink(plain), plain, "{plain}");
        }
    }

    #[test]
    fn public_text_keeps_links_only_when_told_to() {
        assert_eq!(public("my list: moxfield.com/decks/abc", false), "my list: moxfield.com/decks/abc");
        assert_eq!(public("my list: moxfield.com/decks/abc", true), "my list: [link removed]");
        assert_eq!(public("retard.com", true), "[link removed]");
    }

    #[test]
    fn handles_with_a_slur_in_them_are_refused() {
        for bad in ["faggot", "x-faggot-x", "thefaggotking", "n1gger", "r3tard_99", "heil-hitler"] {
            assert!(!handle_ok(bad), "{bad}");
        }
        for good in ["saget", "grape-shot", "therapist", "fire-retardant", "retardant", "scrapeyard", "spice", "fagin", "retro-dan", "kikijiki", "niger-fan"] {
            assert!(handle_ok(good), "{good}");
        }
    }
}
