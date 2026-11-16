//! What makes a printing special: Scryfall's promo types, frame effects, border color and full
//! art (migration 0093), and the plain words for them ("Surge foil, Showcase").
//!
//! The web names printings with `treatmentLabel` in packages/core/src/printingTreatment.ts; this
//! is the same table for what the server writes itself (the collection CSV). Keep them in step:
//! both test suites check packages/core/src/printingTreatment.fixtures.json.

use serde::Serialize;

/// A printing's special treatment as Scryfall lists it. Every field is `None` until the printings
/// import that reads them (importer version 5) has run; an empty list means Scryfall lists none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, sqlx::FromRow)]
pub struct Treatment {
    #[sqlx(json(nullable))]
    #[serde(skip_serializing_if = "empty")]
    pub promo_types: Option<Vec<String>>,
    #[sqlx(json(nullable))]
    #[serde(skip_serializing_if = "empty")]
    pub frame_effects: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
    #[serde(skip_serializing_if = "not_true")]
    pub full_art: Option<bool>,
}

fn empty(v: &Option<Vec<String>>) -> bool {
    v.as_ref().is_none_or(Vec::is_empty)
}

fn not_true(v: &Option<bool>) -> bool {
    *v != Some(true)
}

/// Scryfall promo types that are a kind of foil: they only describe a foil copy, so a regular
/// copy of a printing that also comes in surge foil isn't called one.
const FOILS: &[(&str, &str)] = &[
    ("surgefoil", "Surge foil"),
    ("galaxyfoil", "Galaxy foil"),
    ("textured", "Textured foil"),
    ("doublerainbow", "Double rainbow"),
    ("halofoil", "Halo foil"),
    ("stepandcompleat", "Step-and-compleat"),
    ("oilslick", "Oil slick"),
    ("confettifoil", "Confetti foil"),
    ("raisedfoil", "Raised foil"),
    ("gilded", "Gilded foil"),
    ("fracturefoil", "Fracture foil"),
    ("rainbowfoil", "Rainbow foil"),
    ("manafoil", "Mana foil"),
    ("neonink", "Neon ink"),
    ("chocobotrackfoil", "Chocobo track foil"),
    ("silverfoil", "Silver foil"),
    ("ripplefoil", "Ripple foil"),
    ("dragonscalefoil", "Dragon scale foil"),
    ("singularityfoil", "Singularity foil"),
    ("cosmicfoil", "Cosmic foil"),
    ("firstplacefoil", "First place foil"),
];

/// Promo types that describe every copy of the printing.
const ALWAYS: &[(&str, &str)] = &[("serialized", "Serialized")];

impl Treatment {
    /// "Surge foil, Showcase": what sets this printing apart, in plain words, for a copy in
    /// `finish` (nonfoil, foil, etched), or for the printing itself with `None`. `None` for an
    /// ordinary printing. Promo types Yama has no words for are left out, never shown raw.
    pub fn label(&self, finish: Option<&str>) -> Option<String> {
        let promos = self.promo_types.as_deref().unwrap_or_default();
        let frames = self.frame_effects.as_deref().unwrap_or_default();
        let has = |list: &[String], id: &str| list.iter().any(|x| x == id);
        let mut words: Vec<&str> = Vec::new();
        if finish != Some("nonfoil") {
            words.extend(FOILS.iter().filter(|(id, _)| has(promos, id)).map(|(_, w)| *w));
        }
        words.extend(ALWAYS.iter().filter(|(id, _)| has(promos, id)).map(|(_, w)| *w));
        if has(frames, "showcase") {
            words.push("Showcase");
        }
        if has(frames, "extendedart") {
            words.push("Extended art");
        }
        if self.border_color.as_deref() == Some("borderless") {
            words.push("Borderless");
        }
        if self.full_art == Some(true) {
            words.push("Full art");
        }
        (!words.is_empty()).then(|| words.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(promos: &[&str], frames: &[&str], border: &str, full_art: bool) -> Treatment {
        let list = |v: &[&str]| Some(v.iter().map(|s| s.to_string()).collect());
        Treatment { promo_types: list(promos), frame_effects: list(frames), border_color: Some(border.into()), full_art: Some(full_art) }
    }

    /// The labels the web gives too, from the file both test suites read: words in the table's
    /// order, whatever order Scryfall lists promo types in.
    #[test]
    fn gives_the_shared_fixtures_labels() {
        #[derive(serde::Deserialize)]
        struct Case {
            #[serde(default)]
            promo_types: Option<Vec<String>>,
            #[serde(default)]
            frame_effects: Option<Vec<String>>,
            #[serde(default)]
            border_color: Option<String>,
            #[serde(default)]
            full_art: Option<bool>,
            #[serde(default)]
            finish: Option<String>,
            label: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Fixtures {
            cases: Vec<Case>,
        }
        let f: Fixtures = serde_json::from_str(include_str!("../../../packages/core/src/printingTreatment.fixtures.json")).unwrap();
        assert!(f.cases.len() >= 10);
        for c in f.cases {
            let t = Treatment { promo_types: c.promo_types, frame_effects: c.frame_effects, border_color: c.border_color, full_art: c.full_art };
            assert_eq!(t.label(c.finish.as_deref()), c.label, "{t:?} {:?}", c.finish);
        }
    }

    #[test]
    fn names_special_printings_in_plain_words() {
        // West Coast Expansion, MSC 40 (Bryan's store order): comes regular and in surge foil.
        let wce = t(&["surgefoil", "universesbeyond"], &[], "black", false);
        assert_eq!(wce.label(Some("foil")).as_deref(), Some("Surge foil"));
        assert_eq!(wce.label(None).as_deref(), Some("Surge foil"));
        assert_eq!(wce.label(Some("nonfoil")), None);
        // Blood Crypt, TRK 489: surge foil showcase, full art.
        let crypt = t(&["surgefoil", "universesbeyond"], &["showcase"], "black", true);
        assert_eq!(crypt.label(Some("foil")).as_deref(), Some("Surge foil, Showcase, Full art"));
        // Serialized double rainbow, BRR 64z.
        assert_eq!(t(&["serialized", "doublerainbow"], &[], "black", false).label(None).as_deref(), Some("Double rainbow, Serialized"));
        // Frame effects Yama doesn't name (inverted, legendary) and unknown promo types stay out.
        assert_eq!(t(&["boosterfun", "somethingnew"], &["inverted", "legendary"], "black", false).label(None), None);
        assert_eq!(t(&["galaxyfoil"], &["extendedart"], "borderless", false).label(Some("foil")).as_deref(), Some("Galaxy foil, Extended art, Borderless"));
        // Before the import that reads them, nothing is known: no label.
        assert_eq!(Treatment::default().label(None), None);
    }
}
