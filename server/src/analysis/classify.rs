//! What a nonland card does for the deck: points (0-10, cheaper is better) in categories, each
//! under one of four vectors. Read from Oracle text, with a short list of cards whose text
//! undersells or oversells them. Yama's own rules; the categories follow what players count
//! (ramp, draw, tutors, removal, protection, finishers).

use super::Facts;
use super::text::{by_mv, caps, clean, cost_symbols, count, front, front_text, has, is_land, keyword_lines, lines, mana_in, number, round2, rx, spell_text};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Vector {
    Speed,
    Consistency,
    Interaction,
    Mana,
    Threats,
}

impl Vector {
    pub fn label(self) -> &'static str {
        match self {
            Vector::Speed => "Speed",
            Vector::Consistency => "Consistency",
            Vector::Interaction => "Interaction",
            Vector::Mana => "Mana base",
            Vector::Threats => "Threats",
        }
    }
}

macro_rules! categories {
    ($($v:ident => $key:literal, $label:literal, $vec:ident;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Cat { $($v),* }
        impl Cat {
            pub const ALL: &'static [Cat] = &[$(Cat::$v),*];
            pub fn key(self) -> &'static str { match self { $(Cat::$v => $key),* } }
            pub fn label(self) -> &'static str { match self { $(Cat::$v => $label),* } }
            pub fn vector(self) -> Vector { match self { $(Cat::$v => Vector::$vec),* } }
            pub fn from_key(k: &str) -> Option<Cat> { match k { $($key => Some(Cat::$v),)* _ => None } }
        }
    };
}

categories! {
    FastMana => "fast_mana", "Fast mana", Speed;
    Rocks => "rocks", "Mana rocks", Speed;
    Dorks => "dorks", "Mana creatures", Speed;
    LandRamp => "land_ramp", "Land ramp", Speed;
    Treasure => "treasure", "Treasure makers", Speed;
    Reducers => "reducers", "Cost reducers", Speed;
    Haste => "haste", "Haste", Speed;
    Tutors => "tutors", "Tutors", Consistency;
    DrawEngines => "draw_engines", "Draw engines", Consistency;
    BurstDraw => "burst_draw", "Card draw", Consistency;
    Cantrips => "cantrips", "Cantrips", Consistency;
    Wheels => "wheels", "Wheels", Consistency;
    Selection => "selection", "Card selection", Consistency;
    Recursion => "recursion", "Recursion", Consistency;
    Counters => "counters", "Counterspells", Interaction;
    Removal => "removal", "Spot removal", Interaction;
    ArtEnch => "art_ench", "Artifact and enchantment removal", Interaction;
    Wipes => "wipes", "Board wipes", Interaction;
    GyHate => "gy_hate", "Graveyard hate", Interaction;
    Stax => "stax", "Taxes and locks", Interaction;
    Protection => "protection", "Protection", Interaction;
    Wincons => "wincons", "Finishers", Threats;
    Payoffs => "payoffs", "Engines and payoffs", Threats;
    Beaters => "beaters", "Big threats", Threats;
    Tokens => "tokens", "Token makers", Threats;
    Reanimation => "reanimation", "Reanimation", Threats;
    Drain => "drain", "Group damage", Threats;
}

/// A card's points by category, in category order.
pub type Points = Vec<(Cat, f64)>;

fn set(out: &mut Points, cat: Cat, v: f64) {
    match out.iter_mut().find(|(c, _)| *c == cat) {
        Some(e) => e.1 = v,
        None => out.push((cat, v)),
    }
}
fn get(out: &Points, cat: Cat) -> Option<f64> {
    out.iter().find(|(c, _)| *c == cat).map(|(_, v)| *v)
}
fn remove(out: &mut Points, cat: Cat) {
    out.retain(|(c, _)| *c != cat);
}

/// Best (mana out, mana in, one-shot) over the card's mana abilities. A sacrifice outlet
/// (Ashnod's Altar) and a filter that eats cards aren't ramp.
fn mana_ability(text: &str) -> Option<(f64, f64, bool)> {
    let text = rx!(r#""[^"]*""#).replace_all(text, "");
    let mut best: Option<(f64, f64, bool)> = None;
    for line in text.split('\n') {
        let Some(m) = caps(rx!(r"(?i)^(.*?):\s*(?:[^.]*?\s)?adds? (.*)$"), line) else { continue };
        let cost_part = &m[1];
        let made = m[2].split('.').next().unwrap_or("");
        if has(rx!(r"(?i)\bsacrifice (?:a|an|another|two|x)\b"), cost_part) {
            continue;
        }
        if has(rx!(r"(?i)\bdiscard\b|\bexile\b.*\bgraveyard\b|\bremove\b"), cost_part) && !cost_part.contains("CARDNAME from your hand") {
            continue;
        }
        let cost = mana_in(cost_part);
        let syms = split(rx!(r"\bor\b|,"), made).iter().map(|alt| count(rx!(r"(?i)\{[WUBRGC]\}"), alt)).max().unwrap_or(0) as f64;
        let words = caps(rx!(r"(?i)\b(one|two|three|x) mana\b"), made).map(|w| number(&w[1])).unwrap_or(0.0);
        let mut out = if syms > 0.0 { syms } else { words };
        if has(rx!(r"(?i)\bfor each\b|\bequal to\b"), made) {
            out = out.max(2.0);
        }
        if out == 0.0 {
            continue;
        }
        let sac = has(rx!(r"(?i)\bsacrifice CARDNAME\b|exile CARDNAME from your hand"), cost_part);
        if best.is_none_or(|(o, c, _)| out - cost > o - c) {
            best = Some((out, cost, sac));
        }
    }
    best
}

fn split<'a>(r: &fancy_regex::Regex, s: &'a str) -> Vec<&'a str> {
    let mut out = vec![];
    let mut last = 0;
    for m in r.find_iter(s).filter_map(|m| m.ok()) {
        out.push(&s[last..m.start()]);
        last = m.end();
    }
    out.push(&s[last..]);
    out
}

/// A line that can happen again: a "whenever" or "at the beginning" trigger, or an activated
/// ability that doesn't use the card up.
pub(crate) fn repeatable(line: &str) -> bool {
    let l = line.trim();
    if has(rx!(r"(?i)^when CARDNAME (?:enters|dies|leaves)"), l) {
        return false;
    }
    if has(rx!(r"(?i)^(?:whenever|at the beginning)"), l) {
        return true;
    }
    if let Some(m) = caps(rx!(r#"^([^"]*?):"#), l) {
        let cost = &m[1];
        return !has(rx!(r"(?i)\bsacrifice CARDNAME\b|exile CARDNAME\b|discard CARDNAME\b"), cost)
            && cost.chars().count() < 60
            && (cost.contains('{') || has(rx!(r"(?i)\b(?:tap|untap|pay|sacrifice|discard|exile|remove)\b"), cost));
    }
    false
}

/// Things a "Xs you control have ..." sentence can be about that aren't the player's creatures.
const NOT_A_TEAM: &[&str] = &[
    "lands", "artifacts", "enchantments", "permanents", "spells", "cards", "players", "opponents", "planeswalkers", "abilities", "counters", "auras", "vehicles", "sagas",
    "instants", "sorceries", "sources", "battles", "controls", "treasures", "foods", "clues", "gates", "forests", "islands", "mountains", "swamps", "plains",
    "equipment", "they", "them", "that", "those", "these", "which", "who", "each", "and", "you", "player", "opponent",
];

/// What a card does for the player's whole team for as long as it stays: a lord or anthem's
/// power bonus and the keywords it hands out ("Sliver creatures you control get +2/+0", "All
/// Slivers have shroud", "Other Zombies you control get +1/+1", "Creatures you control of the
/// chosen type get +1/+1"). Lowercased text in; (payoff points, gives protection, gives mana).
/// One-turn pumps aren't counted here: the finisher rules read those.
fn team_boost(tl: &str) -> (f64, bool, bool) {
    let (mut pump, mut grant, mut protects, mut mana): (f64, f64, bool, bool) = (0.0, 0.0, false, false);
    let team = |noun: &str| !NOT_A_TEAM.contains(&noun);
    let size = |bonus: &str| match bonus {
        "0" => 1.0,
        "1" => 2.5,
        "2" => 3.5,
        _ => 4.5,
    };
    for s in split(rx!(r"(?<=[.])\s+|\n"), tl) {
        if has(rx!(r"until end of turn|this turn|until your next turn"), s) {
            continue;
        }
        // The team is a plural ("sliver creatures", "zombies you control"), or a creature type
        // whose plural has no "s", which only reads as a team right after "other" or "all" or
        // right before "you control" ("other merfolk", "myr you control").
        let bonus = caps(rx!(r"\b(?:[a-z'-]+ )?(creatures|tokens|[a-z'-]{3,}s)(?: you control)?(?: of the chosen type)? get \+([\dx])/\+[\dx]"), s)
            .or_else(|| caps(rx!(r"\b(?:other|all) ([a-z'-]{3,})(?: you control)? get \+([\dx])/\+[\dx]"), s))
            .or_else(|| caps(rx!(r"\b([a-z'-]{3,}) you control get \+([\dx])/\+[\dx]"), s));
        if let Some(m) = bonus
            && team(&m[1])
        {
            pump = pump.max(size(&m[2]));
        } else if let Some(m) = caps(rx!(r"\beach other (?:[a-z'-]+ )?creature you control[^.]*? gets \+([\dx])/\+[\dx]"), s) {
            pump = pump.max(size(&m[1]));
        }
        let given = caps(rx!(r"\b(?:[a-z'-]+ )?(creatures|tokens|[a-z'-]{3,}s)(?: you control)?(?: of the chosen type)? (?:get \+[\dx]/\+[\dx] and )?have (.*)$"), s)
            .or_else(|| caps(rx!(r"\b(?:other|all) ([a-z'-]{3,})(?: you control)? (?:get \+[\dx]/\+[\dx] and )?have (.*)$"), s))
            .or_else(|| caps(rx!(r"\b([a-z'-]{3,}) you control (?:get \+[\dx]/\+[\dx] and )?have (.*)$"), s));
        if let Some(m) = given
            && team(&m[1])
        {
            let what = &m[2];
            // Beside whatever else it hands out.
            let protective = has(rx!(r"\b(?:hexproof|shroud|indestructible|ward|protection from)\b"), what);
            protects |= protective;
            if has(rx!(r#"^"\{t\}: add"#), what) {
                mana = true;
            } else if has(rx!(r"\bdouble strike\b"), what) {
                grant = grant.max(4.0);
            } else if has(rx!(r"\b(?:flying|trample|menace|deathtouch|first strike|intimidate|fear|shadow|skulk|[a-z]+walk)\b|can't be blocked"), what) {
                grant = grant.max(2.5);
            } else if has(rx!(r"\b(?:lifelink|vigilance|reach)\b"), what) || (what.starts_with('"') && !protective) {
                grant = grant.max(1.5);
            }
        } else if has(rx!(r"\b[a-z'-]{3,}s can't be blocked\b"), s) && !has(rx!(r"\b(?:creatures|tokens) (?:your opponents|you don't) control"), s) {
            grant = grant.max(2.5);
        }
    }
    let both = if pump > 0.0 && grant > 0.0 { 0.5 } else { 0.0 };
    ((pump.max(grant) + both).min(5.0), protects, mana)
}

/// Points for one nonland card. The commander's count half again: it's always available.
pub fn card_points(c: &Facts, commander: bool) -> Points {
    let mut out = rule_points(c);
    if let Some(cur) = curated(&c.name).or_else(|| curated(front(&c.name))) {
        for (cat, v) in cur {
            set(&mut out, *cat, *v);
        }
    }
    if commander {
        for e in &mut out {
            e.1 *= 1.5;
        }
    }
    out.sort_by_key(|(c, _)| *c);
    out
}

fn rule_points(c: &Facts) -> Points {
    let mut out: Points = vec![];
    if is_land(c) {
        return out;
    }
    let mut t = clean(c, front_text(c));
    let ta = clean(c, &spell_text(c));
    let mut tl = t.to_lowercase();
    let mut m = c.cmc;
    if c.mana_cost.contains("{X}") || has(rx!(r"\bmultikicker\b"), &tl) {
        m += 2.0;
    }
    let ty = front(&c.type_line).to_string();
    let creature = ty.contains("Creature");
    let kws = keyword_lines(c);
    let instant = ty.contains("Instant") || kws.iter().any(|k| k == "flash");
    let spell = ty.starts_with("Instant") || ty.starts_with("Sorcery");

    // ── Speed (the front face, whose mana value this is)
    let ls: Vec<String> = lines(&t).into_iter().map(String::from).collect();
    let ab = mana_ability(&t);
    let enters_tapped = has(rx!(r"CARDNAME enters (?:the battlefield )?tapped"), &t);
    let from_hand = t.contains("exile CARDNAME from your hand");
    if let Some((made, cost, sac)) = ab
        && !creature
        && !ty.contains("Land")
    {
        let mut cast_net = made - cost - if from_hand { 0.0 } else { m };
        if enters_tapped {
            cast_net -= made;
        }
        if (cast_net >= 0.0 && m <= 2.0) || from_hand {
            let mut pts = 7.0 + 1.5 * cast_net.clamp(0.0, 2.0);
            if sac || spell {
                pts -= 3.5;
            }
            set(&mut out, Cat::FastMana, pts);
        } else if !sac && !spell {
            let mut pts = by_mv(&[(1, 6.0), (2, 5.0), (3, 3.0), (4, 2.0)], m, 1.0);
            if made - cost >= 2.0 {
                pts += 1.0;
            }
            if enters_tapped {
                pts -= 1.0;
            }
            set(&mut out, Cat::Rocks, pts.max(0.5));
        }
    }
    if let Some((made, cost, _)) = ab
        && creature
    {
        let mut pts = by_mv(&[(0, 5.0), (1, 5.0), (2, 3.5), (3, 2.5)], m, 1.5);
        if made - cost >= 2.0 {
            pts += 1.0;
        }
        set(&mut out, Cat::Dorks, pts);
    }
    // "Sliver creatures you control have '{T}: Add one mana of any color.'": every creature a dork.
    if get(&out, Cat::Dorks).is_none() && team_boost(&tl).2 {
        set(&mut out, Cat::Dorks, by_mv(&[(1, 5.0), (2, 4.0), (3, 3.0)], m, 2.0));
    }
    if has(rx!(r"whenever enchanted land is tapped for mana, its controller adds an additional"), &tl) {
        set(&mut out, Cat::Rocks, by_mv(&[(1, 4.0), (2, 3.5), (3, 2.5)], m, 1.5));
    }
    if has(rx!(r"(?i)search your library for [^.]*\b(?:land|plains|island|swamp|mountain|forest)s? cards?\b[^.]*onto the battlefield"), &t)
        || has(
            rx!(r"(?i)\bput (?:a|an|all|up to \w+) (?:basic )?lands? cards? from [^.]*?onto the battlefield|\bplay (?:an|two|three|up to \w+) additional lands?\b"),
            &t,
        )
    {
        let mut eff = m;
        for l in &ls {
            if let Some(cm) = caps(rx!(r#"^([^"]*?):"#), l.trim())
                && has(rx!(r"(?i)search your library"), l)
            {
                eff = m + cost_symbols(&cm[1]);
            }
        }
        let mut pts = by_mv(&[(1, 5.0), (2, 4.5), (3, 3.0), (4, 2.0)], eff, 1.5);
        if has(rx!(r"(?i)\b(?:two|three|up to two) basic land cards[^.]*onto the battlefield"), &t) {
            pts += 1.0;
        }
        set(&mut out, Cat::LandRamp, pts);
    }
    if let Some(tre) = caps(rx!(r"\bcreates? (a|one|two|three|four|x|that many) (?:treasure|gold) tokens?"), &tl) {
        let rep = ls.iter().any(|l| repeatable(l) && l.to_lowercase().contains("treasure"));
        let v = if rep { 4.0 } else { (1.5 + 0.5 * (number(&tre[1]) - 1.0)).min(3.5) };
        set(&mut out, Cat::Treasure, v);
    }
    if let Some(red) = caps(rx!(r"(?:^|\. |\n)(?:([A-Za-z]+) )?(?:and [a-z]+ )?spells you cast cost \{\d\} less"), &t) {
        let word = red.get(1).map(|w| w.as_str().to_lowercase()).unwrap_or_default();
        let broad = ["", "noncreature", "creature", "artifact", "enchantment", "instant", "sorcery", "legendary", "historic", "multicolored"].contains(&word.as_str());
        set(&mut out, Cat::Reducers, if broad { 3.0 } else { 2.0 });
    }
    if has(
        rx!(r"creatures you control (?:have|gain) haste|equipped creature has haste|(?:target creature|creatures) you control gains? haste|other creatures you control have haste"),
        &tl,
    ) || has(rx!(r"\b(?:creatures|[a-z'-]{3,}s)(?: you control)? have (?:[a-z ,]+ )?haste\b"), &tl)
    {
        // The second form is a kind of creature's haste: "Goblins you control have haste",
        // "Sliver creatures you control have flying and haste".
        set(&mut out, Cat::Haste, 2.0);
    }

    // ── Consistency (every nonland face counts from here on)
    t = ta;
    tl = t.to_lowercase();
    let ls: Vec<String> = lines(&t).into_iter().map(String::from).collect();
    let tutor_re = rx!(r"(?i)search(?:es)? (?:your|their) (?:library|graveyard and/or library|library and/or graveyard) for ([^.]*?)\bcards?\b");
    if let Some(what) = tutor_re.captures_iter(t.as_str()).filter_map(|c| c.ok()).map(|c| c[1].to_string()).find(|what| {
        let w = what.to_lowercase();
        !(has(rx!(r"\b(?:land|plains|island|swamp|mountain|forest|wastes)\b"), &w)
            && !has(rx!(r"\b(?:creature|artifact|enchantment|instant|sorcery|planeswalker|battle|equipment|aura)\b"), &w))
    })
    {
        let w = what.to_lowercase();
        let mut restricted = has(
            rx!(r"\b(?:creature|artifact|enchantment|instant|sorcery|planeswalker|equipment|aura|legendary|basic|with|named|mana value|power|toughness|[A-Z][a-z]+)\b"),
            &what,
        ) && !has(rx!(r"^\s*(?:a|an|up to one|any number of)?\s*$"), &w);
        if has(rx!(r"^\s*(?:a|an|up to one|one)\s*$"), &w) {
            restricted = false;
        }
        let mut pts = by_mv(&[(0, 9.0), (1, 9.0), (2, 8.0), (3, 6.0), (4, 5.0)], m, 4.0);
        if restricted {
            pts *= 0.65;
        }
        if has(rx!(r"on top of (?:your|their) library|put (?:it|that card) on top"), &tl) {
            pts *= 0.85;
        }
        if has(rx!(r"put (?:it|that card|them|those cards) into your graveyard"), &tl) {
            pts *= 0.6;
        }
        set(&mut out, Cat::Tutors, round2(pts));
    }

    let mut draws: Vec<&str> = vec![];
    for l in &ls {
        let ll = l.to_lowercase();
        if has(rx!(r"(?<!opponent )(?<!each player )\bdraws? (?:a|an|one|two|three|four|five|x|that many|cards equal|seven|additional)"), &ll)
            || has(rx!(r"\byou may draw\b|\bdraw a card\b"), &ll)
        {
            let head: String = ll.chars().take(20).collect();
            if has(rx!(r"(?:an|each) opponent draws|target player draws a card\b(?! for)"), &ll) && !head.contains("you") {
                continue;
            }
            draws.push(l);
        }
    }
    let mut engine: Option<f64> = None;
    for l in &draws {
        if !repeatable(l) {
            continue;
        }
        let mut pts = by_mv(&[(0, 7.5), (1, 7.5), (2, 7.0), (3, 6.0), (4, 5.0), (5, 4.0)], m, 3.0);
        if has(rx!(r"(?i)\beach player draws\b|\bthat player draws\b"), l) {
            pts *= 0.5;
        }
        let lt = l.trim();
        if let Some(cost) = caps(rx!(r#"^([^"]*?):"#), lt)
            && !has(rx!(r"(?i)^(?:whenever|at the beginning)"), lt)
        {
            if cost_symbols(&cost[1]) >= 2.0 {
                pts *= 0.7;
            }
            if has(rx!(r"(?i)remove (?:a|an|one) [^:]*counter"), &cost[1]) {
                pts *= 0.6;
            }
        }
        if has(rx!(r"(?i)draw (?:a|one|two) cards?, then discard"), l) {
            pts *= 0.6;
        }
        if has(rx!(r"(?i)activate only if|activate only once"), l) {
            pts *= 0.75;
        }
        engine = Some(engine.unwrap_or(0.0).max(pts));
    }
    let impulse: Vec<&str> = ls
        .iter()
        .map(|l| l.as_str())
        .filter(|l| has(rx!(r"(?i)exile the top (?:card|\w+ cards) of your library[^.]*\.[^.]*you may (?:play|cast)"), l))
        .collect();
    for l in &impulse {
        if repeatable(l) {
            engine = Some(engine.unwrap_or(0.0).max(0.85 * by_mv(&[(1, 7.0), (2, 7.0), (3, 6.0), (4, 5.0)], m, 3.5)));
        }
    }
    if let Some(e) = engine.filter(|e| *e != 0.0) {
        set(&mut out, Cat::DrawEngines, e);
    } else {
        let mut burst: f64 = 0.0;
        for l in draws.iter().chain(impulse.iter()) {
            let Some(n) = caps(rx!(r"(?i)\bdraws? (two|three|four|five|seven|x|that many) cards|\bdraws? cards equal|\bexile the top (two|three|four|five|x) cards"), l) else {
                continue;
            };
            let word = n.get(1).or(n.get(2)).map(|w| w.as_str().to_string());
            let mut k = word.map(|w| number(&w)).unwrap_or(3.0);
            if let Some(back) = caps(rx!(r"(?i)then (?:put|discard) (a|one|two|three|x) cards?"), l) {
                k -= number(&back[1]);
            }
            if k <= 1.0 {
                let v = get(&out, Cat::Selection).unwrap_or(0.0).max(2.0);
                set(&mut out, Cat::Selection, v);
                continue;
            }
            let eff = by_mv(&[(0, 1.1), (1, 1.1), (2, 1.0), (3, 0.85), (4, 0.7), (5, 0.6)], m, 0.5);
            burst = burst.max((1.6 * k).min(6.0) * eff);
        }
        if burst != 0.0 {
            set(&mut out, Cat::BurstDraw, round2(burst));
        } else if !draws.is_empty() {
            set(&mut out, Cat::Cantrips, if m <= 2.0 { 1.5 } else { 1.0 });
        }
    }
    if has(
        rx!(r"discards? (?:their|your) hands?,? (?:and |then )?(?:each player )?draws? (?:seven|that many|cards equal)|shuffles? (?:their|your) hands? and graveyards? into (?:their|your) librar(?:y|ies), then draws? seven"),
        &tl,
    ) {
        set(&mut out, Cat::Wheels, 5.0);
        remove(&mut out, Cat::BurstDraw);
    }
    if ![Cat::DrawEngines, Cat::BurstDraw, Cat::Wheels].iter().any(|k| get(&out, *k).is_some()) {
        if has(
            rx!(r"\blook at the top (?:two|three|four|five|six|seven|x) cards of your library[^.]*\.[^.]*put (?:one|up to one|two|a|that|those|any number)[^.]*into your hand"),
            &tl,
        ) {
            set(&mut out, Cat::Selection, 2.0);
        } else if has(rx!(r"\b(?:scry|surveil) \d"), &tl) {
            set(&mut out, Cat::Selection, 1.0);
        }
    }
    let self_rec = has(rx!(r"(?:cast|return|put) CARDNAME from your graveyard"), &t);
    let rec = if self_rec {
        None
    } else {
        caps(
            rx!(r"return (?:target|up to \w+ target|all|each|another target|a|up to \w+)? ?[^.]*?\bcards? from your graveyard to (?:your hand|the battlefield)|\breturn (?:target|up to \w+ target) [^.]*?cards? from (?:a|your) graveyard to (?:the battlefield|your hand)|(?:card|cards) in your graveyard (?:gains?|has|have) flashback|you may (?:cast|play) [^.]*?from your graveyard"),
            &tl,
        )
        .map(|c| c[0].to_string())
    };
    if let Some(rec) = rec {
        let mut pts = 2.0;
        if has(rx!(r"\breturn all|\breturn up to (?:two|three|x)|\beach\b"), &rec) {
            pts = 3.0;
        }
        if ls.iter().any(|l| repeatable(l) && has(rx!(r"(?i)graveyard"), l)) {
            pts += 1.5;
        }
        set(&mut out, Cat::Recursion, pts);
    }

    // ── Interaction
    if has(rx!(r"\bcounter target (?:[a-z ]*?)?spell\b"), &tl) {
        let free = has(rx!(r"rather than pay this spell's mana cost|without paying its mana cost|exile a [a-z ]*card from your hand"), &tl) && m > 0.0;
        let mut pts = if free { 10.0 } else { by_mv(&[(0, 9.0), (1, 8.0), (2, 7.0), (3, 5.0), (4, 4.0)], m, 3.0) };
        if has(rx!(r"counter target (?:noncreature|creature|instant|sorcery|instant or sorcery|artifact|enchantment|activated|[a-z]+ )+spell"), &tl) && !tl.contains("counter target spell") {
            pts *= 0.85;
        }
        if has(rx!(r"counter target [^.]*unless its controller pays"), &tl) {
            pts *= 0.75;
        }
        if has(rx!(r"counter target spell(?: or ability)? (?:that targets|with)"), &tl) {
            pts *= 0.5;
        }
        set(&mut out, Cat::Counters, pts);
    } else if has(rx!(r"\bcounter target (?:activated|triggered)"), &tl) {
        set(&mut out, Cat::Counters, 3.0);
    }

    let mut rem: f64 = 0.0;
    let mut ae: f64 = 0.0;
    for s in split(rx!(r"[.\n]"), &t).into_iter().filter(|s| !s.trim().is_empty()) {
        let sl = s.to_lowercase();
        let own = count(rx!(r"\btarget (?:[\w'-]+,? ){0,4}?you (?:control|own)\b"), &sl);
        if own > 0 && own >= count(rx!(r"\btarget\b"), &sl) {
            continue;
        }
        let mut mult = 1.0;
        let no_noncreature = sl.replace("noncreature", "");
        if has(
            rx!(r"\b(?:destroy|exile) (?:up to (?:one|two|three|x) )?(?:another )?target (?:artifact|enchantment|artifact or enchantment|artifact, enchantment|noncreature, nonland permanent|nonland, noncreature)"),
            &sl,
        ) && !has(rx!(r"\b(?:destroy|exile) (?:up to (?:one|two|three|x) )?(?:another )?target (?:[^.]*?)(?:creature|nonland permanent|permanent)\b"), &no_noncreature)
        {
            ae = ae.max(by_mv(&[(0, 4.0), (1, 4.0), (2, 4.0), (3, 3.0)], m, 2.0) * if instant { 1.1 } else { 1.0 });
            continue;
        }
        let hit = if has(rx!(r"\b(?:destroy|exile) (?:up to (?:one|two|three|x) )?(?:another )?target\b(?! card)"), &sl) && !sl.contains("graveyard") {
            if sl.contains("exile") {
                mult *= 1.1;
            }
            if has(rx!(r"target (?:nonland )?permanent"), &sl) {
                mult *= 1.1;
            }
            true
        } else if has(
            rx!(r"\bdeals? (?:\d+|x) damage to (?:any target|(?:up to (?:one|two|three|x) )?(?:another )?target (?:creature|planeswalker|attacking|blocking))"),
            &sl,
        ) || has(rx!(r"\bdeals? damage equal to [^.]*? to (?:any target|(?:up to (?:one|two|three|x) )?(?:another )?target\b)"), &sl)
        {
            mult *= 0.85;
            true
        } else if has(rx!(r"\btarget (?:[^.]*?)\bgets? -(?:\d+|x)/-(?:\d+|x)"), &sl) {
            mult *= 0.9;
            true
        } else if has(rx!(r"\bfights? (?:up to (?:one|two|three|x) )?(?:another )?target\b|\bfights? (?:another )?target"), &sl) {
            mult *= 0.75;
            true
        } else if has(rx!(r"\breturn (?:up to (?:one|two|three|x) )?(?:another )?target (?:[^.]*?) to (?:its|their) owner'?s'? hands?\b"), &sl) {
            mult *= 0.6;
            true
        } else if has(
            rx!(r"\bput (?:up to (?:one|two|three|x) )?(?:another )?target (?:[^.]*?) (?:into|on (?:the )?(?:top|bottom) of) (?:its|their) owner'?s'? library"),
            &sl,
        ) || has(rx!(r"owner of target [^.]*?shuffles it into"), &sl)
        {
            true
        } else if has(rx!(r"\b(?:target (?:player|opponent)|each opponent) sacrifices (?:a|an|one|two)\b"), &sl) {
            mult *= 0.85;
            true
        } else {
            false
        };
        if hit {
            if instant {
                mult *= 1.15;
            }
            if repeatable(s.trim()) || has(rx!(r"^\{[^}]+\}.*:"), s.trim()) {
                mult *= 1.3;
            }
            rem = rem.max(by_mv(&[(0, 7.0), (1, 7.0), (2, 6.0), (3, 4.5), (4, 3.5), (5, 2.5)], m, 2.0) * mult);
        }
    }
    if ty.contains("Aura") && has(rx!(r"\benchanted (?:creature|permanent)\b[^.]*?(?:loses all (?:other )?abilities|can't attack or block|can't block|doesn't untap)"), &tl) {
        rem = rem.max(by_mv(&[(1, 5.0), (2, 5.0), (3, 4.0)], m, 2.5));
    }
    if rem != 0.0 {
        set(&mut out, Cat::Removal, round2(rem));
    }
    if ae != 0.0 {
        set(&mut out, Cat::ArtEnch, round2(ae));
    }

    if let Some(w) = rx!(r"\b(?:destroy|exile) all (?:other )?(?:nonland permanents|creatures|nontoken creatures|artifacts|enchantments|permanents|planeswalkers|attacking creatures|nonland, nontoken permanents|creatures and planeswalkers|artifacts and enchantments|artifacts, creatures)|\ball (?:other )?creatures get -(?:\d+|x)/-(?:\d+|x)|\beach creature gets -(?:\d+|x)/-(?:\d+|x)|deals? (?:\d+|x) damage to each (?:other )?creature\b|\breturn all (?:other )?(?:nonland permanents|creatures|artifacts)[^.]*to (?:their|its) owners'? hands|\beach player sacrifices all|return all attacking creatures|sacrifices all other nonland permanents|\beach (?:other )?creature (?:you don't control )?(?:deals damage|gets)|choose a number[^.]*destroy all|destroy each (?:creature|nonland permanent|artifact)")
        .find(tl.as_str())
        .ok()
        .flatten()
    {
        let mut pts = if m <= 4.0 { 5.0 } else if m <= 5.0 { 3.5 } else { 2.5 };
        let after: String = tl[w.end()..].chars().take(40).collect();
        if has(rx!(r"you don't control|your opponents control|each opponent|creatures? (?:target player|an opponent) controls|nontoken creatures your opponents"), &format!("{}{}", w.as_str(), after)) {
            pts *= 1.6;
        }
        set(&mut out, Cat::Wipes, round2(pts));
    }
    if has(
        rx!(r"exile (?:target player's|each opponent's|all cards from all|all|each player's|target card from a|up to \w+ target cards? from (?:a|an opponent's|target player's)|all cards from target player's) graveyards?|if a (?:card|nontoken permanent)[^.]*would be put into an opponent's graveyard|cards in graveyards (?:lose|can't)|exile target card from a graveyard|exile all graveyards"),
        &tl,
    ) {
        set(&mut out, Cat::GyHate, if has(rx!(r"\ball\b|each|would be put"), &tl) { 3.0 } else { 1.5 });
    }
    if has(
        rx!(r"\bcosts? \{\d\} more to cast|spells your opponents cast cost|can't cast more than one spell|players can't search|can't cast spells during your turn|don't untap during (?:their|its) controllers'? untap steps|activated abilities of (?:artifacts|creatures|nonland permanents)[^.]*can't be activated|nonbasic lands are mountains|can't attack you[^.]*unless|each player can't|your opponents can't (?:cast|gain|draw|search|block)|creatures entering the battlefield don't cause abilities|skips? (?:their|your|his or her) untap step"),
        &tl,
    ) {
        set(&mut out, Cat::Stax, if m <= 3.0 { 3.5 } else { 2.5 });
    }

    let mut prot: f64 = 0.0;
    if has(
        rx!(r"(?:creatures|permanents|other creatures|other permanents|you and permanents) you control (?:gain|have|get) [^.]*?(?:indestructible|hexproof|protection|shroud)|you and (?:other )?permanents you control gain|protection from everything|phase out|phases out"),
        &tl,
    ) && !has(rx!(r"^(?:creatures|other creatures) you control have (?:hexproof|indestructible)\.?$"), tl.trim())
    {
        prot = by_mv(&[(0, 7.0), (1, 6.0), (2, 5.5), (3, 5.0), (4, 4.0)], m, 3.5);
        if !has(rx!(r"until end of turn|this turn|until your next turn"), &tl) && has(rx!(r"have (?:hexproof|indestructible|shroud)"), &tl) {
            prot = prot.max(3.5);
        }
    }
    if has(
        rx!(r"target (?:creature|permanent|artifact|nonland permanent)s? you control (?:gains?|has|get) [^.]*?(?:indestructible|hexproof|protection|shroud)|target creature you control phases out|equipped creature has (?:shroud|hexproof|protection|indestructible)|your commander[^.]*(?:hexproof|indestructible)"),
        &tl,
    ) {
        prot = prot.max(by_mv(&[(0, 4.5), (1, 4.5), (2, 3.5), (3, 2.5)], m, 2.0));
    }
    let head: String = tl.chars().take(30).collect();
    if has(rx!(r"change the target of target spell or ability|you may choose new targets for (?:the copy|target)"), &tl) && !head.contains("copy") {
        prot = prot.max(if m <= 2.0 { 5.0 } else { 3.0 });
    }
    if has(rx!(r"if you control a commander, you may cast this spell without paying"), &tl) && prot != 0.0 {
        prot *= 1.3;
    }
    let (boost, team_protection, _) = team_boost(&tl);
    if team_protection {
        prot = prot.max(3.5);
    }
    if prot != 0.0 {
        set(&mut out, Cat::Protection, round2(prot));
    }

    // ── Threats
    if has(rx!(r"\byou win the game\b|\beach opponent loses the game\b|\btarget (?:player|opponent) loses the game\b"), &tl) {
        set(&mut out, Cat::Wincons, 7.0);
    } else if has(
        rx!(r"creatures you control (?:get|gain) \+(?:[3-9]|x)/\+(?:\d|x)[^.]*?(?:until end of turn|this turn)|creatures you control gain [^.]*double strike|creatures you control get \+x/\+x|creatures you control get \+[2-9]/\+\d and gain trample until end of turn"),
        &tl,
    ) {
        set(&mut out, Cat::Wincons, 5.0);
    } else if has(rx!(r"\badditional combat phase\b"), &tl) {
        set(&mut out, Cat::Wincons, 4.0);
    } else if has(rx!(r"each opponent loses (?:x|life equal)|deals? (?:x|damage equal to [^.]*) damage to each opponent|each opponent loses \d+ life for each"), &tl) {
        set(&mut out, Cat::Wincons, 4.0);
    }

    let mut pay: f64 = 0.0;
    if has(rx!(r"create twice that many|twice that many (?:of those )?tokens|twice that many \+1/\+1 counters|deals? double that damage|triggers an additional time|that many plus one"), &tl) {
        pay = 6.0;
    }
    if has(
        rx!(r"whenever (?:another |a |one or more )?(?:nontoken )?(?:creatures?|permanents?|artifacts?|tokens?)[^.]*(?:you control )?(?:enters|enter|dies|die|is put into a graveyard)[^.]*(?:each opponent loses \d|deals? \d damage to each opponent|deals \d damage to any target|each opponent loses)"),
        &tl,
    ) {
        pay = pay.max(5.0);
    }
    if has(rx!(r"(?m)^(?:other )?creatures you control get \+\d/\+\d"), &tl) && !has(rx!(r"until end of turn"), &tl) {
        pay = pay.max(2.5);
    }
    // Lords and anthems of every kind, and the keywords they hand out.
    pay = pay.max(boost);
    // Counters and planeswalkers: proliferate, and cards that work loyalty abilities harder.
    if has(rx!(r"\bproliferate\b"), &tl) {
        pay = pay.max(if ls.iter().any(|l| repeatable(l) && has(rx!(r"(?i)\bproliferate\b"), l)) { 3.0 } else { 2.0 });
    }
    if !ty.contains("Planeswalker") {
        if has(rx!(r"planeswalker cards? [^.]*onto the battlefield"), &tl) {
            pay = pay.max(4.0);
        } else if has(rx!(r"loyalty abilit(?:y|ies)"), &tl) && !has(rx!(r"can't activate [^.]*loyalty abilit"), &tl) {
            // Working them harder, not shutting them off.
            pay = pay.max(3.0);
        }
    }
    if has(rx!(r"whenever you cast (?:an? )?(?:instant or sorcery|noncreature|creature)? ?spell, (?:create|copy|draw|deal|put)"), &tl) && creature {
        pay = pay.max(3.0);
    }
    if pay != 0.0 {
        set(&mut out, Cat::Payoffs, pay);
    }

    if creature || ty.contains("Vehicle") {
        let pv = match c.power.as_deref() {
            None | Some("*" | "1+*" | "*+1" | "2+*" | "X") => 3.0,
            Some(p) => p.parse::<f64>().unwrap_or(3.0),
        };
        let evasive = kws.iter().any(|k| ["flying", "trample", "menace", "shadow", "fear", "intimidate", "skulk"].contains(&k.as_str())) || tl.contains("can't be blocked");
        if pv >= 4.0 || (evasive && pv >= 3.0) {
            let eff = (pv / m.max(1.0)).clamp(0.5, 1.3);
            let mut pts = (0.8 * pv).min(5.0) * eff;
            if evasive {
                pts *= 1.25;
            }
            if kws.iter().any(|k| k == "double strike") {
                pts *= 1.4;
            }
            if ty.contains("Vehicle") {
                pts *= 0.6;
            }
            if pts >= 1.5 {
                set(&mut out, Cat::Beaters, round2(pts.min(6.0)));
            }
        }
    }
    if ty.contains("Planeswalker") {
        let v = get(&out, Cat::Beaters).unwrap_or(0.0).max(2.5);
        set(&mut out, Cat::Beaters, v);
    }

    let mine = split(rx!(r"(?<=[.])\s+|\n"), &t)
        .into_iter()
        .filter(|s| !has(rx!(r"(?i)(?:its controller|that player|its owner|their controller|target opponent|each opponent|an opponent) creates?|for each opponent, create"), s))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if let Some(tok) = caps(rx!(r"\bcreates? (a|an|one|two|three|four|five|x|that many|a number of)? ?(?:tapped )?(?:\d+/\d+ )?(?:[a-z ]+? )?(?:creature )?tokens?\b"), &mine)
        && !has(rx!(r"\bcreates? (?:a|one|two|three|x|that many) (?:tapped )?(?:treasure|clue|food|blood|gold|map|powerstone|junk|incubator)"), &tok[0])
        && has(
            rx!(r"creature token|\d+/\d+|token that's a copy|tokens? that are copies|spirit|soldier|zombie|goblin|elf|warrior|thopter|servo|saproling|human|angel|dragon|beast|cat|knight|faerie|bird|insect|vampire|wolf|elemental|construct|illusion|squirrel|rat|ox|horse|hero|monk|citizen|myr|golem|ape|demon|wurm"),
            &tl,
        )
    {
        let rep = ls.iter().any(|l| repeatable(l) && has(rx!(r"(?i)\bcreates?\b"), l));
        let mut n = number(tok.get(1).map(|g| g.as_str()).unwrap_or("a"));
        if tl.contains("for each") || tl.contains("number of") {
            n = 3.0;
        }
        let v = if rep {
            3.5
        } else if n <= 1.0 {
            1.0
        } else if n == 2.0 {
            1.5
        } else {
            2.5
        };
        set(&mut out, Cat::Tokens, v);
    }
    if has(
        rx!(r"return (?:target|up to \w+ target|all|each)? ?[^.]*?creature cards? from (?:your|a|all) graveyards? to the battlefield|put (?:target|up to \w+ target)? ?[^.]*?creature cards? from (?:a|your|all) graveyards? onto the battlefield|return [^.]*?from your graveyard to the battlefield"),
        &tl,
    ) {
        let mut pts = by_mv(&[(1, 5.0), (2, 4.5), (3, 3.5), (4, 3.0)], m, 2.0);
        if has(rx!(r"\breturn all|\beach\b"), &tl) {
            pts = pts.max(4.0);
        }
        set(&mut out, Cat::Reanimation, pts);
    }
    if get(&out, Cat::Wincons).is_none() && has(rx!(r"each opponent loses \d+ life|deals? \d+ damage to each opponent|each opponent loses life"), &tl) {
        let rep = ls.iter().any(|l| repeatable(l) && has(rx!(r"(?i)each opponent"), l));
        set(&mut out, Cat::Drain, if rep { 3.0 } else { 1.0 });
    }
    out
}

/// Yama's judgement of cards whose text misreads their strength. Points replace the rule's.
fn curated(name: &str) -> Option<&'static [(Cat, f64)]> {
    use Cat::*;
    Some(match name {
        "Sol Ring" => &[(FastMana, 9.0)],
        "Mana Crypt" => &[(FastMana, 10.0)],
        "Mana Vault" => &[(FastMana, 9.0)],
        "Grim Monolith" => &[(FastMana, 8.0)],
        "Chrome Mox" | "Mox Diamond" | "Jeweled Lotus" => &[(FastMana, 8.0)],
        "Mox Opal" | "Lotus Petal" | "Lion's Eye Diamond" => &[(FastMana, 6.0)],
        "Mox Amber" | "Dark Ritual" | "Simian Spirit Guide" | "Elvish Spirit Guide" => &[(FastMana, 5.0)],
        "Arcane Signet" => &[(Rocks, 5.5)],
        "Fellwar Stone" | "Everflowing Chalice" => &[(Rocks, 5.0)],
        "Dockside Extortionist" => &[(Treasure, 9.0)],
        "Smothering Tithe" => &[(Treasure, 7.0)],
        "Rhystic Study" | "Skullclamp" => &[(DrawEngines, 9.0)],
        "Mystic Remora" | "Sylvan Library" | "Bolas's Citadel" => &[(DrawEngines, 8.0)],
        "Esper Sentinel" => &[(DrawEngines, 6.5)],
        "Necropotence" => &[(DrawEngines, 10.0)],
        "The One Ring" => &[(DrawEngines, 9.0), (Protection, 3.0)],
        "Phyrexian Arena" => &[(DrawEngines, 6.0)],
        "Ad Nauseam" => &[(BurstDraw, 8.0)],
        "Fact or Fiction" => &[(BurstDraw, 4.5)],
        "Jeska's Will" => &[(FastMana, 6.0), (BurstDraw, 4.0)],
        "Demonic Tutor" | "Vampiric Tutor" => &[(Tutors, 9.0)],
        "Imperial Seal" => &[(Tutors, 8.0)],
        "Enlightened Tutor" | "Worldly Tutor" | "Mystical Tutor" => &[(Tutors, 7.0)],
        "Gamble" => &[(Tutors, 6.0)],
        "Force of Will" | "Fierce Guardianship" => &[(Counters, 10.0)],
        "Mana Drain" | "Pact of Negation" => &[(Counters, 9.0)],
        "Teferi's Protection" => &[(Protection, 9.0)],
        "Deflecting Swat" | "Heroic Intervention" | "Flawless Maneuver" => &[(Protection, 7.0)],
        "Thassa's Oracle" => &[(Wincons, 10.0)],
        "Craterhoof Behemoth" => &[(Wincons, 9.0)],
        "Laboratory Maniac" | "Jace, Wielder of Mysteries" => &[(Wincons, 8.0)],
        "Akroma's Will" => &[(Wincons, 5.0), (Protection, 4.0)],
        "Swords to Plowshares" => &[(Removal, 8.0)],
        "Path to Exile" => &[(Removal, 7.5)],
        "Cyclonic Rift" => &[(Wipes, 8.0), (Removal, 3.0)],
        "Blasphemous Act" => &[(Wipes, 6.0)],
        "Lightning Greaves" => &[(Protection, 4.0), (Haste, 2.5)],
        "Swiftfoot Boots" => &[(Protection, 3.5), (Haste, 2.0)],
        _ => return None,
    })
}
