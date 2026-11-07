//! The tools (docs/mcp-design.md). Each takes the caller and its JSON arguments and returns text for
//! Claude, built only from the caller's own rows (or shared card and precon data). The read tools
//! are here; the write tools only stage a change for the person to review (`changes.rs`).
//!
//! The longer summaries reuse the advisor's context builders (`advisor::context::build`), so a
//! plan or a lab run reads the same to Ask Claude and to an outside client.

use super::{Via, changes};
use crate::advisor::context;
use crate::auth::User;
use crate::cards::{CARD_COLUMNS, Card, SearchCard};
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Names one `card` call may ask about.
const MAX_NAMES: usize = 20;
/// Lines one `check_list` call may send.
const MAX_LIST_LINES: usize = 300;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Does {
    Read,
    /// Saves research notes only, never decks, inventory, orders, plans or game state.
    Research,
    /// Stores a pending change and changes nothing else.
    Stage,
    /// Applies or discards a staged change: outside clients only, never Ask Claude.
    Decide,
}

struct Tool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    does: Does,
}

/// Said by every write tool: what staging means.
macro_rules! staged {
    ($what:literal) => {
        concat!(
            $what,
            " This only stages the change for their review: it shows in Yama with Apply and Discard, and nothing changes until they apply it. \
              Stage a change when they ask for it or agree to it, not as a guess."
        )
    };
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "datasets",
        title: "Your evidence datasets",
        description: "List your private imported evidence datasets, active revisions, sources and record counts. Imported aggregates, overlapping windows and ELO points are not independent game records. Use dataset to inspect dated evidence.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "dataset",
        title: "Read dated dataset evidence",
        description: "Read one private evidence dataset by id. Filter records by kind, entity id or name search; use section=sources for source provenance. Pages are bounded. An exact entity also gets descriptive monthly source-rate averages with a default 180-day exponential half-life; cumulative snapshots, overlapping rolling windows, flagged and undated data are excluded from that average. ELO sequence indices are not dates. This never imports, publishes or changes decks/games.",
        schema: || json!({"type":"object","properties":{
            "id":{"type":"string"},"revision":{"type":"integer","minimum":1},
            "section":{"type":"string","enum":["records","sources"]},
            "kind":{"type":"string","enum":["performance","weekly_activity","commander","commander_history","archetype","source_table"]},
            "entity":{"type":"string","description":"Exact source entity id from a dataset record."},
            "search":{"type":"string","description":"Case-insensitive name search."},
            "offset":{"type":"integer","minimum":0,"maximum":200000},"limit":{"type":"integer","minimum":1,"maximum":50},
            "as_of":{"type":"string","description":"Optional YYYY-MM-DD evaluation date."},
            "half_life_days":{"type":"integer","minimum":1,"maximum":3650}},"required":["id"],"additionalProperties":false}),
        does: Does::Read,
    },
    Tool {
        name: "research",
        title: "Your saved deck research and review choices",
        description: "Read private research and review choices. No id lists reports; id alone gives a compact overview with build power and scenario totals. deck retrieves one full deck audit, optionally narrowed by build; scenario retrieves one exact global shopping/print allocation. full=true returns the complete potentially large document. Research is advice, not installed decks or approved purchases.",
        schema: || obj(&[("id", "string", "Report id; omit to list reports."), ("deck", "string", "Optional deck key within the report."), ("build", "string", "Optional build id, with deck."), ("scenario", "string", "One global acquisition scenario, instead of deck."), ("full", "boolean", "Return the complete document instead of a compact overview; can be large.")], &[]),
        does: Does::Read,
    },
    Tool {
        name: "save_research",
        title: "Save private research for review in Yama",
        description: "Store or refresh a yama-research/1 document: a deck plan's content (builds, swaps with reasons, acquisition evidence), private to the caller. This saves directly and idempotently; review choices survive refreshes and changed targets are flagged. A plan already tracking one of the note's builds follows the refreshed note (its swaps, store offers and lists are derived again). It never installs or saves a playable deck, changes inventory, approves a purchase, orders prints or starts games. To make a build the deck's plan, stage track_build afterwards. Use when asked to store research or a plan in Yama. Owner comes from sign-in, never the document.",
        schema: || json!({"type":"object","properties":{"document":{"type":"object","description":"A yama-research/1 report (up to 4 MiB), with id, title, generated_at, decks and exact proposed builds."}},"required":["document"],"additionalProperties":false}),
        does: Does::Research,
    },
    Tool {
        name: "review_research",
        title: "Record their research choice or note",
        description: "Save a research preference only when the person states that choice or asks to save the note. Read research first for the exact target, target_hash and review version. This records a preferred build or want/unsure/no, not an installed deck, purchase approval or planner promotion. Use a fresh UUID op_id for each new answer; reuse it unchanged to retry a failed request.",
        schema: || json!({"type":"object","properties":{"id":{"type":"string"},"op_id":{"type":"string"},"target":{"type":"string"},"decision":{"type":["string","null"]},"note":{"type":["string","null"]},"expected_version":{"type":"integer","minimum":0},"target_hash":{"type":"string"}},"required":["id","op_id","target","decision","note","expected_version","target_hash"],"additionalProperties":false}),
        does: Does::Research,
    },
    Tool {
        name: "overview",
        title: "Your decks and deck plans",
        description: "List this person's decks in Yama (with commanders) and their deck plans: each saved note's decks and builds, which build is tracked as that deck's plan (with its plan key), and plans imported from a plan file. Start here.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "deck",
        title: "One deck",
        description: "One of their Yama decks: the current list, the bracket they declared, Commander legality problems \
                      (size, singleton, color identity, banned cards), Game Changers and real game results. \
                      Give the deck's name (as `overview` lists it) or its id.",
        schema: || obj(&[("deck", "string", "The deck's name or id.")], &["deck"]),
        does: Does::Read,
    },
    Tool {
        name: "plan_deck",
        title: "One deck plan",
        description: "One deck plan: the stock list and the now and after lists as differences, every planned and \
                      proposed swap with its reasons and their review answers, whether each planned swap is installed \
                      (read from their Yama deck's current list when the plan has one), their shopping rules, the newest \
                      paired lab run, and real games. Give the plan key from `overview`. A note deck that has no \
                      tracked build yet answers with its builds and how to track one.",
        schema: || obj(&[("key", "string", "The plan key, for example \"riders-of-rohan\".")], &["key"]),
        does: Does::Read,
    },
    Tool {
        name: "shopping_trip",
        title: "Which stores to visit",
        description: "Plan a trip to their stores for the cards they want to buy: the fewest stores that cover the most \
                      cards under their local buy rule (the rule set in force that day), honoring their store preferences \
                      (a favourite to support is on every trip it has a card for; fine; maybe; won't go) and their order of how easy stores are to get to. Needed cards are the buys in their approved plans with no order \
                      yet (a plan waiting for their OK adds nothing); their real-card wishlist only comes along from stores \
                      already on the trip. Gives each store's cards, listed total and cart link (or card search links on a TCGplayer Pro store), the best choice with fewer stores, \
                      what to print instead and why, and the wishlist by price tier. Listings are dated quotes, not \
                      purchases; a missing price is unknown, never $0.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "today": {"type": "string", "description": "Optional YYYY-MM-DD the trip is for; picks the rule set. Default: today (UTC)."},
                    "stores": {"type": "array", "items": {"type": "string"}, "description": "Optional store keys they're going to this time (see shopping_settings); the rest are left off. Default: every store they'll go to."},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "shopping_settings",
        title: "Shopping rules and stores",
        description: "Their shopping rules and stores: the local buy rule in force today (and the dated rule set it comes from, \
                      made in Yama or imported), every dated rule set, the most they'll pay for a sealed precon, and each store's \
                      level (favourite to support, fine, maybe, won't go), its place in their order of how easy stores are to get \
                      to, and a favourite's premium. Use the store keys with shopping_trip and set_store_preference.",
        schema: || obj(&[], &[]),
        does: Does::Read,
    },
    Tool {
        name: "set_shopping_rules",
        title: "Change the buy rule",
        description: staged!(
            "Change their local buy rule and sealed precon limit. It becomes a new rule set from the day they apply it, \
             so older checks keep the rules of their own day. Parts left out keep the rule in force. A listing qualifies at \
             or under always_ok_usd whatever the market; otherwise at most max_usd and at most max_multiple times market for \
             the first tier whose market_under is above the market (null: any market); with tiers, an unknown market \
             qualifies only at or under always_ok_usd."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "max_usd": {"type": ["number", "null"], "description": "The most a card may cost; null: no limit."},
                    "always_ok_usd": {"type": ["number", "null"], "description": "At or under this, fine whatever the market; null: none."},
                    "tiers": {"type": "array", "description": "Market ranges, lowest first; only the last may have market_under null.",
                              "items": {"type": "object", "properties": {"market_under": {"type": ["number", "null"]}, "max_multiple": {"type": "number"}},
                                        "required": ["market_under", "max_multiple"], "additionalProperties": false}},
                    "sealed_max_usd": {"type": ["number", "null"], "description": "The most for a sealed precon, per deck, before tax; null: no limit."},
                    "note": {"type": "string", "description": "Why it changed."},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "set_store_preference",
        title: "Set how they feel about a store",
        description: staged!(
            "Set one of their stores' level: favorite (a store they want to support: on every trip it has a card for, and it \
             gets a card when it's at most premium_usd above the cheapest), ok, maybe (only for cards no other store has) or \
             never; its place in their order of how easy stores are to get to (hassle, 1 is the easiest); and a note. Parts \
             left out stay as they are."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "store": {"type": "string", "description": "The store's key or name, from shopping_settings."},
                    "preference": {"type": "string", "enum": ["favorite", "ok", "maybe", "never"]},
                    "hassle": {"type": ["integer", "null"], "description": "Place in their order, 1 = easiest to get to; null clears it."},
                    "premium_usd": {"type": ["number", "null"], "description": "How much more a card may cost at a favourite, $0 to $10; null clears it."},
                    "note": {"type": "string"},
                },
                "required": ["store"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "store_stock",
        title: "A store's stock",
        description: "One of their stores' newest stock answers for cards: each listing's price, condition, finish and \
                      quantity where the store gives them, or not in stock, with the time it was read. Default cards: every card \
                      the trip plans for. Listings are dated quotes from a snapshot (read when they asked, or imported), not \
                      proof the card is still there; a missing price is unknown.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "store": {"type": "string", "description": "The store's key or name, from shopping_settings."},
                    "cards": {"type": "array", "items": {"type": "string"}, "description": "Card names; default every card the trip plans for."},
                },
                "required": ["store"],
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "check_stores",
        title: "Read stores' stock",
        description: staged!(
            "Read their stores' stock now, when they apply it: Shopify stores Yama knows (Pat's Games, Mothership) card by \
             card, TCGplayer Pro storefronts (Black Castle, Multiverse) as a whole catalog with each product's lowest \
             price, and with yestcg true also YesTCG's Austin search (condition and quantity) for the stores it covers. \
             Each store's answer is a dated snapshot the trip and store_stock read. Default stores: every store they'll \
             go to that Yama can read; default cards: every card the trip plans for."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "stores": {"type": "array", "items": {"type": "string"}, "description": "Store keys or names, from shopping_settings."},
                    "cards": {"type": "array", "items": {"type": "string"}, "description": "Card names, at most 300."},
                    "yestcg": {"type": "boolean", "description": "Also ask YesTCG (Austin) about the stores it covers."},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "shopping_list",
        title: "Their shopping list",
        description: "Everything on their one shopping list and where the store trip puts each card: planned buys with no \
                      order yet, proposals they want or haven't decided on, cards and sealed products they added (add_wish), \
                      and a count of their real-card wishlist. Each card says the store and price the trip picks, or why it \
                      isn't on the trip (print it, ask the store, no check). Sealed products show each store's newest price \
                      against their sealed cap, the sealed market and the singles inside at market. Listings are dated quotes, \
                      not purchases.",
        schema: || obj(&[("today", "string", "Optional YYYY-MM-DD; picks the rule set. Default: today (UTC).")], &[]),
        does: Does::Read,
    },
    Tool {
        name: "add_wish",
        title: "Add to their shopping list",
        description: staged!(
            "Add a card (or a sealed product) to their shopping list. priority need (default): a reason to go to a \
             store; along: only from a store already on the trip. deck: one of their Yama decks by name, or a label for \
             a deck not in Yama yet. Each copy is its own want, also when a plan already buys the card for another deck."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "The card's name (Yama must know it), or a sealed product's name."},
                    "kind": {"type": "string", "enum": ["card", "sealed"]},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 99},
                    "priority": {"type": "string", "enum": ["need", "along"]},
                    "deck": {"type": "string", "description": "A Yama deck's name, or a label for a deck not in Yama."},
                    "why": {"type": "string"},
                },
                "required": ["name"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "review_queue",
        title: "Proposals to review",
        description: "Every proposed swap, deck by deck: the ones still waiting for their answer first, then the ones they answered.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "find_cards",
        title: "Search cards",
        description: "Search Magic cards with Yama's Scryfall-style syntax: o:\"draw a card\", t:artifact, id<=rw \
                      (fits a Boros commander), mv<=3, f:commander (legal), is:gamechanger, -t:creature, or, \
                      parentheses, !\"Exact Name\". 60 results a page, each with cost, type, color identity, Commander \
                      legality, Game Changer, a dated market price and how many copies they own.",
        schema: || {
            obj(
                &[
                    ("query", "string", "The search, for example: id<=rw t:artifact o:treasure f:commander"),
                    ("order", "string", "name (default), mv, edhrec (most played first) or color."),
                    ("page", "integer", "Page number, from 1."),
                ],
                &["query"],
            )
        },
        does: Does::Read,
    },
    Tool {
        name: "card",
        title: "Card details",
        description: "Full details for up to 20 cards by name: Oracle text, cost, type, color identity, Commander legality, \
                      Game Changer, EDHREC rank, the latest market price with its date, and the copies they own (where, \
                      and which are proxies). Optionally the official rulings.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string"}, "description": "Card names (any face).", "maxItems": MAX_NAMES},
                    "rulings": {"type": "boolean", "description": "Include the official rulings."},
                },
                "required": ["names"],
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "price_history",
        title: "Price history",
        description: "One printing's price over time from one source, on the days Yama read it: the first and last price, \
                      the low and high, and each change, each with its date. Give a card name (its default printing, or with \
                      cheapest the cheapest playable printing), or a printing by Scryfall id, or set and collector number. \
                      Sources: TCGplayer market via Scryfall (default), Card Kingdom retail or buylist, Mana Pool's lowest \
                      listing (via MTGJSON), in USD; none is a store quote, and a buylist price is what Card Kingdom was paying \
                      for near-mint copies, not what you'll get. A missing price is null, and days Yama didn't read are gaps.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "card": {"type": "string", "description": "A card name (any face)."},
                    "source": {"type": "string", "enum": ["tcgplayer", "cardkingdom_retail", "cardkingdom_buylist", "manapool"], "description": "Whose price: TCGplayer market via Scryfall (default), Card Kingdom retail or buylist, or Mana Pool's lowest listing (via MTGJSON). One source at a time; they're never combined."},
                    "cheapest": {"type": "boolean", "description": "With card: the cheapest playable printing instead of the default one."},
                    "printing": {"type": "string", "description": "A Scryfall printing id."},
                    "set": {"type": "string", "description": "A set code, with number."},
                    "number": {"type": "string", "description": "A collector number, with set."},
                    "finish": {"type": "string", "enum": ["nonfoil", "foil", "etched"], "description": "nonfoil (default), foil or etched."},
                    "days": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "How far back, in days (default 90)."},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "check_list",
        title: "Check a deck list",
        description: "Check a proposed Commander list without saving it: the 100-card count, singleton, color identity, \
                      commander eligibility, cards banned in Commander, Game Changers, and names Yama doesn't know. \
                      One card per line (\"1 Sol Ring\"); a \"Commander\" header, or else the first card is the commander. \
                      Legality is Scryfall's as of Yama's last card import.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "list": {"type": "string", "description": "The list, one card per line."},
                    "first_is_commander": {"type": "boolean", "description": "With no Commander header, treat the first card as the commander (default true)."},
                },
                "required": ["list"],
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "lab_runs",
        title: "Your lab experiments",
        description: "Their simulation experiments (\"Try a change\"), newest first, with ids for `lab_run`.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "lab_run",
        title: "One lab experiment",
        description: "One simulation experiment: its lists, opponents, engines and limits, live progress, and each engine's result: the \
                      paired difference with its interval and verdict, the games that weren't scored and why, and how many \
                      pods would likely settle an unclear answer. Admins also see the number of earlier Phase games ahead \
                      in the shared queue. For runs using both engines, the ETA and queue position are Phase-only; Forge \
                      is queued separately. Other accounts' run and deck details stay private.",
        schema: || obj(&[("id", "string", "The experiment id from `lab_runs`.")], &["id"]),
        does: Does::Read,
    },
    Tool {
        name: "lab_games",
        title: "A lab experiment's games",
        description: "An experiment's games pod by pod on one engine: each game's end, turns, CPU seconds, place and \
                      error. With `game`, that one game's schedule line, result line and every seat's list, enough to \
                      replay it with the lab runner (games replay move for move from their schedule line on the same \
                      engine build). Head-to-head and tournament runs: with `deck` (a deck's name or entrant id) or \
                      `table`, those tables game by game, as the run's deck and table pages show them: who went first, \
                      the finish order, each seat's knockout turn or final life.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The experiment id from `lab_runs`."},
                    "engine": {"type": "string", "enum": ["phase", "forge"], "description": "Which engine's games (default: the run's first)."},
                    "only": {"type": "string", "enum": ["all", "unscored"], "description": "unscored: only pods with a game that wasn't scored (default all)."},
                    "game": {"type": "string", "description": "One game id (from this list) for its schedule line, result line and lists."},
                    "deck": {"type": "string", "description": "Head to head and tournaments: only the tables this deck sat at (its name as the run shows it, or its entrant id e0, e1, ...)."},
                    "table": {"type": "integer", "minimum": 1, "description": "Head to head and tournaments: only this table (1-based, as the run's pages number them)."},
                },
                "required": ["id"],
                "additionalProperties": false,
            })
        },
        does: Does::Read,
    },
    Tool {
        name: "precon",
        title: "A precon",
        description: "A Commander precon from Yama's catalog: list, real results from playgroup.gg with their dated history (all-time rate, approximate recent rate between snapshots and trend, or the commander's own figure when the list isn't rated), the simulated rating and matchups, and source-backed upgradeability assessments with the 1–5 rubric, concrete card examples, named reviews and separately scoped raw commander wins/game counts. Commander configurations have separate grades and comparison-list URLs. On-theme swaps are eligible; replacing the strategy is a separate build. Use each prepared list separately when comparing commanders. Unsupported grades are null. Commander rates mix stock and modified lists; do not infer upgrade gains from them. \
                      Give its name (or part of it) or id.",
        schema: || obj(&[("precon", "string", "The precon's name, part of it, or its id.")], &["precon"]),
        does: Does::Read,
    },
    Tool {
        name: "changes",
        title: "Changes waiting for review",
        description: "The changes you (or another Claude) staged that they haven't applied or discarded yet, with ids. \
                      Check here before staging the same change twice.",
        schema: no_args,
        does: Does::Read,
    },
    Tool {
        name: "edit_deck",
        title: "Change a deck's list",
        description: staged!(
            "Change one of their Yama decks: add cards to the main deck and remove cards from it, one copy per name \
             (name a card twice for two copies). Applying saves a new version of the deck, with your note; the old \
             version stays in its history. If the deck changes before they apply it, it won't apply."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "deck": {"type": "string", "description": "The deck's name or id."},
                    "add": {"type": "array", "items": {"type": "string"}, "description": "Card names to add."},
                    "remove": {"type": "array", "items": {"type": "string"}, "description": "Card names to remove."},
                    "note": {"type": "string", "description": "Why, in a sentence; saved with the version."},
                },
                "required": ["deck"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "track_build",
        title: "Make a note's build the deck's plan",
        description: staged!(
            "Use one build of a deck in one of their saved notes as that deck's plan: its swaps become a plan version \
             waiting for their OK (\"Use a deck from it\" on the plan pages). Once they approve it (in Yama, or \
             `approve_plan`), Buy, prints, installed and bought marks and the plan tools (plan_deck, mark_bought, \
             mark_installed, swap_in_prints) work on it, and it replaces any other plan for the same deck. Another build \
             of the same deck switches to it; build null stops it. Give the note id and deck key from `overview` or `research`."
        ),
        schema: || {
            json!({"type":"object","properties":{
                "note":{"type":"string","description":"The note's id."},
                "deck":{"type":"string","description":"The deck's key in the note."},
                "build":{"type":["string","null"],"description":"The build's id; null to stop tracking this deck."},
                "yama_deck":{"type":"string","description":"Optional: the Yama deck (name or id) the plan is for. Default: the one already linked, else their only deck with the note deck's name."}
            },"required":["note","deck","build"],"additionalProperties":false})
        },
        does: Does::Stage,
    },
    Tool {
        name: "approve_plan",
        title: "Approve a deck's plan",
        description: staged!(
            "Approve a deck's plan version whole, as the plan page's Approve plan does: every change waiting in it goes into \
             the plan except the ones in skip, and the open questions plan_deck lists need their answers first. Only stage \
             it when they have said to. action keep instead keeps the version before it (for a new version of a plan in \
             progress). Nothing is bought or printed by approving: buys go on their shopping list and prints on the next \
             print order."
        ),
        schema: || {
            json!({"type":"object","properties":{
                "plan":{"type":"string","description":"The plan key or deck name from `overview`."},
                "action":{"type":"string","enum":["approve","keep"],"description":"approve (default) or keep the version before it."},
                "skip":{"type":"array","items":{"type":"string"},"description":"Changes to leave out: a card name skips every change putting that card in; a swap key skips just that one."},
                "answers":{"type":"array","items":{"type":"object","properties":{"question":{"type":"string"},"answer":{"type":"string"}},"required":["question","answer"],"additionalProperties":false},
                           "description":"Their answer to each open question, the question exactly as plan_deck lists it."}
            },"required":["plan"],"additionalProperties":false})
        },
        does: Does::Stage,
    },
    Tool {
        name: "propose_swap",
        title: "Suggest a swap for a plan",
        description: staged!(
            "Suggest a swap for one of their upgrade plans: a card to put in and, usually, the card it replaces. \
             Applying saves it as an idea in the plan, where it goes through their usual review."
        ),
        schema: || {
            obj(
                &[
                    ("plan", "string", "The plan key or deck name from `overview`."),
                    ("card_in", "string", "The card to put in."),
                    ("card_out", "string", "The card it replaces, if any."),
                    ("why", "string", "Why, in a sentence or two."),
                ],
                &["plan", "card_in"],
            )
        },
        does: Does::Stage,
    },
    Tool {
        name: "answer_review",
        title: "Answer a proposal in Review",
        description: staged!(
            "Answer a swap in one of their plans the way they would on the Review page: want, unsure or no, with an \
             optional note and a different card to cut. Only when they've told you their answer."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string", "description": "The plan key or deck name."},
                    "card_in": {"type": "string", "description": "The card the swap puts in."},
                    "card_out": {"type": "string", "description": "The card it takes out, when several swaps put in the same card."},
                    "decision": {"type": "string", "enum": ["want", "unsure", "no"]},
                    "note": {"type": "string"},
                    "cut": {"type": "string", "description": "A different card to cut instead."},
                },
                "required": ["plan", "card_in", "decision"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "mark_bought",
        title: "Mark a plan card bought",
        description: staged!(
            "Mark a swap's card as bought in one of their plans, as \"Bought it\" does: when, how many, the price and \
             the store. It's their claim, not an order. value false clears the mark."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string"},
                    "card_in": {"type": "string"},
                    "card_out": {"type": "string"},
                    "value": {"type": "boolean", "description": "true (the default) marks it, false clears it."},
                    "on": {"type": "string", "description": "YYYY-MM-DD; today if left out."},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "price_paid": {"type": "number", "minimum": 0},
                    "store": {"type": "string"},
                },
                "required": ["plan", "card_in"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "swap_in_prints",
        title: "Swap a plan deck's prints in",
        description: staged!(
            "When their printed proxies have arrived and they have sleeved them into a deck: take that plan deck from its now list to its \
             after-prints list in Yama. The linked Yama deck gets the after list as a new version; the prints go into the deck's box as \
             proxies; cards moving in from another deck come out of that deck's box; each card leaving goes to the deck that takes it next, \
             the deck's swap bag box (cards that go back in at a lower bracket) or a box called Spares; and the swaps are ticked installed. \
             The reply previews exactly what applying does."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {"plan": {"type": "string", "description": "The plan key or deck name from `overview`."}},
                "required": ["plan"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "mark_installed",
        title: "Mark a plan swap installed",
        description: staged!("Mark a swap in one of their plans as installed in the real deck (value false clears it). This only decides for a plan deck with no Yama deck: with one, installed is read from that deck's current list, so change the deck instead."),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string"},
                    "card_in": {"type": "string"},
                    "card_out": {"type": "string"},
                    "value": {"type": "boolean"},
                },
                "required": ["plan", "card_in"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "start_lab_run",
        title: "Start a lab run",
        description: staged!(
            "Simulate in the lab, under their lab allowance; results come in over the next while (see lab_run). Modes: \
             change (the default: a list against the same list with cards added and cut, in paired games), compare (two \
             lists in the same pods), solo (one list's win rate as it is), versus (2 to 4 lists head to head), and tournament (one large field in balanced randomized four-player pods). Lists \
             are their decks or precons by name, or a pasted list. Applying runs every check the lab's pages run."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["change", "compare", "solo", "versus", "tournament"]},
                    "deck": {"type": "string", "description": "change, solo: the list to start from; compare: the first list. One of their decks or a precon, by name or id."},
                    "list": {"type": "string", "description": "Or a whole list instead of deck, one card per line, commander first."},
                    "label": {"type": "string", "description": "A name for a pasted list."},
                    "other": {"type": "string", "description": "compare: the second list, one of their decks or a precon."},
                    "other_list": {"type": "string", "description": "compare: or a whole second list."},
                    "other_label": {"type": "string", "description": "A name for the second pasted list."},
                    "entrants": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 256, "description": "versus: 2 to 4 decks; tournament: a large shared field, up to 256 distinct lists including optional benchmark opponents."},
                    "entrant_lists": {"type": "array", "maxItems": 256, "items": {"type": "object", "required": ["label", "list"], "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 120}, "list": {"type": "string", "minLength": 1, "maxLength": 65536}}, "additionalProperties": false}, "description": "versus/tournament: labelled pasted lists, including distinct commander configurations. Combined with named entrants; never creates saved decks."},
                    "pod": {"type": "integer", "enum": [4, 2], "description": "versus: 4 players (the default; precons fill empty seats) or 2 (1v1, two lists)."},
                    "add": {"type": "array", "items": {"type": "string"}, "description": "change: cards to add."},
                    "cut": {"type": "array", "items": {"type": "string"}, "description": "change: cards to cut."},
                    "games": {"type": "integer", "description": "Games per engine, or appearances per deck per engine for tournament: 100 (default), 200 or 400 (admins up to 2,000). Tournament total games scale with field size and are charged in full."},
                    "opponents": {
                        "type": "string",
                        "enum": ["strongest", "similar", "all_precons", "my_decks"],
                        "description": "strongest (the default): the 20 strongest precons; similar: the 20 precons nearest in strength to `near` (or to the list, when it's a precon); all_precons; my_decks: their other decks.",
                    },
                    "near": {"type": "string", "description": "similar: the precon whose power level to match."},
                    "engine": {"type": "string", "enum": ["phase", "forge", "both"], "description": "phase (the default), forge, or both side by side (each engine plays every pod; costs both)."},
                    "ai": {"type": "string", "enum": ["Easy", "Medium"], "description": "phase's AI level (default Easy)."},
                    "forge_ai": {"type": "string", "enum": crate::lab::forge::FORGE_PROFILES, "description": "Forge's AI profile (default Default)."},
                },
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "more_lab_games",
        title: "Add games to a lab run",
        description: staged!(
            "Add games to one of their finished runs (not versus) so its answer gets clearer: the new pods continue the \
             run's schedule and pool with the results so far, on each of its engines. Without `games`, enough to reach \
             the run's estimate of the pods that would settle it, where it has one. A run whose engine has changed since \
             can't take more games; use run_lab_again."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The experiment id."},
                    "games": {"type": "integer", "description": "Games per engine to add: 100, 200 or 400 (admins up to 2,000)."},
                },
                "required": ["id"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "run_lab_again",
        title: "Run a lab experiment again",
        description: staged!(
            "Run one of their experiments again as a new run: the same frozen lists, opponents, engines and AI, a new seed. \
             Use it when the engine has changed since, or for a fresh sample."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The experiment id."},
                    "games": {"type": "integer", "description": "Games per engine (default: as many as the run had)."},
                },
                "required": ["id"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "cancel_lab_run",
        title: "Cancel a lab run",
        description: staged!("Stop one of their queued or running experiments: games already playing finish and count, no new ones start."),
        schema: || obj(&[("id", "string", "The experiment id.")], &["id"]),
        does: Does::Stage,
    },
    Tool {
        name: "add_to_collection",
        title: "Add cards to the collection",
        description: staged!(
            "Add copies of a card to their collection, in a binder, deck box or list they already have (or loose). \
             Without a set, Yama's default printing."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "card": {"type": "string"},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "set": {"type": "string", "description": "Set code, such as \"cmm\"."},
                    "number": {"type": "string", "description": "Collector number in that set."},
                    "container": {"type": "string", "description": "Their binder, deck box or list, by name."},
                    "proxy": {"type": "boolean"},
                    "finish": {"type": "string", "enum": ["nonfoil", "foil", "etched"]},
                },
                "required": ["card"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "move_cards",
        title: "Move cards between binders and boxes",
        description: staged!("Move copies of a card from one of their binders, deck boxes or lists to another."),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "card": {"type": "string"},
                    "qty": {"type": "integer", "minimum": 1, "maximum": 100},
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                },
                "required": ["card", "from", "to"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "set_condition",
        title: "Set the condition of cards",
        description: staged!(
            "Set the condition of every copy in one of their binders, deck boxes or lists, or only the copies of one card there: \
             NM (near mint), LP (lightly played), MP (moderately played), HP (heavily played) or DMG (damaged)."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "container": {"type": "string", "description": "Their binder, deck box or list, by name."},
                    "card": {"type": "string", "description": "Only this card's copies; every card there if left out."},
                    "condition": {"type": "string", "enum": ["NM", "LP", "MP", "HP", "DMG"]},
                },
                "required": ["container", "condition"],
                "additionalProperties": false,
            })
        },
        does: Does::Stage,
    },
    Tool {
        name: "apply_change",
        title: "Apply a staged change",
        description: "Apply one staged change. Call it only after they have said yes to that exact change in this conversation; \
                      otherwise let them apply it in Yama. If the deck or plan moved on, it fails with the reason and stays waiting.",
        schema: || obj(&[("id", "string", "The change id from staging or `changes`.")], &["id"]),
        does: Does::Decide,
    },
    Tool {
        name: "discard_change",
        title: "Discard a staged change",
        description: "Discard one staged change, when they say no to it or you staged it by mistake.",
        schema: || obj(&[("id", "string", "The change id.")], &["id"]),
        does: Does::Decide,
    },
];

fn no_args() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": false})
}

fn obj(props: &[(&str, &str, &str)], required: &[&str]) -> Value {
    let mut p = serde_json::Map::new();
    for (name, ty, description) in props {
        p.insert((*name).into(), json!({"type": ty, "description": description}));
    }
    json!({"type": "object", "properties": p, "required": required, "additionalProperties": false})
}

/// Tools that start simulations: admins and power users only (`User::power`, 2026-10-31).
/// Everyone else can still read their runs and cancel one.
const SIMULATIONS: [&str; 3] = ["start_lab_run", "more_lab_games", "run_lab_again"];

/// The tools this caller gets: Ask Claude can stage changes but not apply them, and only power
/// users get the tools that start simulations.
fn for_caller(user: &User, via: &Via) -> impl Iterator<Item = &'static Tool> {
    let decide = via.may_apply();
    let power = user.power;
    TOOLS.iter().filter(move |t| (decide || t.does != Does::Decide) && (power || !SIMULATIONS.contains(&t.name)))
}

pub fn list(user: &User, via: &Via) -> Vec<Value> {
    for_caller(user, via)
        .map(|t| {
            let annotations = match t.does {
                Does::Read => json!({"readOnlyHint": true, "openWorldHint": false}),
                Does::Research => json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}),
                // Staging adds a pending row and nothing else: harmless to repeat, never destructive.
                Does::Stage => json!({"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}),
                Does::Decide => json!({"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}),
            };
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": annotations,
            })
        })
        .chain(super::research::catalog())
        .collect()
}

pub fn offered(name: &str, user: &User, via: &Via) -> bool {
    for_caller(user, via).any(|t| t.name == name) || super::research::offered(name)
}

pub async fn call(st: &AppState, user: &User, via: &Via, name: &str, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    match name {
        "datasets" => Ok(serde_json::to_string_pretty(&crate::datasets::list(pool,&user.id).await?).map_err(anyhow::Error::from)?),
        "dataset" => {
            let mut query=args.as_object().cloned().ok_or_else(||AppError::bad("arguments must be an object"))?;
            let id=query.remove("id").and_then(|v|v.as_str().map(str::to_owned)).filter(|s|!s.is_empty()).ok_or_else(||AppError::bad("id is required"))?;
            let q:crate::datasets::ReadQuery=serde_json::from_value(Value::Object(query)).map_err(|e|AppError::bad(format!("invalid dataset query: {e}")))?;
            Ok(serde_json::to_string_pretty(&crate::datasets::read(pool,&user.id,&id,q).await?).map_err(anyhow::Error::from)?)
        },
        "save_research" => {
            let document = args.get("document").ok_or_else(|| AppError::bad("Missing document."))?;
            Ok(crate::deck_research::save(pool, &user.id, document).await?.to_string())
        }
        "review_research" => {
            let id=text_arg(args,"id")?;
            let op:crate::deck_research::ReviewOp=serde_json::from_value(args.clone()).map_err(|e|AppError::bad(format!("Invalid research review: {e}")))?;
            Ok(serde_json::to_string(&crate::deck_research::review(pool,&user.id,id,&op).await?).map_err(anyhow::Error::from)?)
        }
        "research" => {
            let Some(id) = args.get("id").and_then(Value::as_str) else { return Ok(crate::deck_research::list(pool, &user.id).await?.to_string()); };
            if args.get("build").is_some() && args.get("deck").is_none() { return Err(AppError::bad("build requires deck.")); }
            if args.get("scenario").is_some() && args.get("deck").is_some() { return Err(AppError::bad("Choose a deck or a global scenario.")); }
            let mut report = crate::deck_research::load(pool, &user.id, id).await?;
            if let Some(key) = args.get("deck").and_then(Value::as_str) {
                let decks = report["document"]["decks"].as_array_mut().unwrap();
                decks.retain(|d| d["key"] == key);
                if decks.is_empty() { return Err(AppError::NotFound("research deck")); }
                if let Some(build) = args.get("build").and_then(Value::as_str) {
                    let builds = decks[0]["builds"].as_array_mut().unwrap();
                    builds.retain(|b| b["id"] == build);
                    if builds.is_empty() { return Err(AppError::NotFound("research build")); }
                }
                // A focused read should not carry every other deck's print orders and store
                // searches. The exact chosen acquisition rows remain on the selected builds.
                let names: std::collections::HashSet<String> = report["document"]["decks"][0]["builds"].as_array().unwrap().iter()
                    .flat_map(|b| b["list"].as_str().unwrap_or_default().lines())
                    .filter_map(|line| line.split_once(' ').map(|(_, name)| name.to_string())).collect();
                report["document"]["scenarios"] = json!([]);
                if let Some(checks) = report["document"]["local_checks"].as_object_mut() { checks.retain(|name,_| names.contains(name)); }
                let prefix = format!("swap:{key}:");
                let preferred = format!("deck:{key}");
                if let Some(reviews) = report["reviews"].as_array_mut() { reviews.retain(|r| r["target"].as_str().is_some_and(|t| t==preferred || t.starts_with(&prefix))); }
                if let Some(hashes) = report["target_hashes"].as_object_mut() { hashes.retain(|t,_| t==&preferred || t.starts_with(&prefix)); }
            } else if let Some(scenario) = args.get("scenario").and_then(Value::as_str) {
                let scenarios=report["document"]["scenarios"].as_array_mut().ok_or_else(||AppError::bad("No acquisition scenarios in this report."))?;
                scenarios.retain(|s|s["id"]==scenario);
                if scenarios.is_empty(){return Err(AppError::NotFound("research scenario"));}
                report["document"]["decks"]=json!([]);
                report["document"]["local_checks"]=json!({});
                report["target_hashes"]=json!({});report["reviews"]=json!([]);
            } else if args.get("full").and_then(Value::as_bool)!=Some(true) {
                for deck in report["document"]["decks"].as_array_mut().unwrap() {
                    if let Some(o)=deck.as_object_mut(){o.retain(|k,_|["key","name","commander","ownership","installed_state","recommended_build","summary","builds"].contains(&k.as_str()));}
                    for build in deck["builds"].as_array_mut().unwrap(){if let Some(o)=build.as_object_mut(){o.retain(|k,_|["id","label","bracket","gameplay_profile","accounting","why","game_changers","prospective"].contains(&k.as_str()));}}
                }
                for deck in report["document"]["decks"].as_array_mut().unwrap(){for build in deck["builds"].as_array_mut().unwrap(){if let Some(profile)=build["gameplay_profile"].as_object_mut(){profile.retain(|key,_|["plan","pace"].contains(&key.as_str()));}}}
                if let Some(scenarios)=report["document"]["scenarios"].as_array_mut(){for scenario in scenarios{if let Some(o)=scenario.as_object_mut(){o.remove("prints");o.remove("buys");}}}
                report["document"]["local_checks"]=json!({});
                // Overview reads need deck preference hashes and any reviewed swaps, not
                // thousands of unrelated swap fingerprints. Focused reads retain exact hashes.
                let reviewed:std::collections::HashSet<String>=report["reviews"].as_array().unwrap().iter().filter_map(|r|r["target"].as_str().map(String::from)).collect();
                if let Some(hashes)=report["target_hashes"].as_object_mut(){hashes.retain(|key,_|key.starts_with("deck:")||reviewed.contains(key));}
                report["view"]=json!("Overview only. Read deck/build or scenario for exact cards; full=true for the complete document.");
            }
            Ok(report.to_string())
        }
        "changes" => changes_text(pool, user).await,
        "edit_deck" => changes::edit_deck(st, user, via, args).await,
        "propose_swap" => changes::propose_swap(st, user, via, args).await,
        "track_build" => changes::track_build(st, user, via, args).await,
        "approve_plan" => changes::approve_plan(st, user, via, args).await,
        "answer_review" => changes::answer_review(st, user, via, args).await,
        "mark_bought" => changes::mark_bought(st, user, via, args).await,
        "mark_installed" => changes::mark_installed(st, user, via, args).await,
        "swap_in_prints" => changes::swap_in_prints(st, user, via, args).await,
        "start_lab_run" => changes::start_lab_run(st, user, via, args).await,
        "more_lab_games" => changes::more_lab_games(st, user, via, args).await,
        "run_lab_again" => changes::run_lab_again(st, user, via, args).await,
        "cancel_lab_run" => changes::cancel_lab_run(st, user, via, args).await,
        "add_to_collection" => changes::add_to_collection(st, user, via, args).await,
        "move_cards" => changes::move_cards(st, user, via, args).await,
        "set_condition" => changes::set_condition(st, user, via, args).await,
        "set_shopping_rules" => changes::set_shopping_rules(st, user, via, args).await,
        "set_store_preference" => changes::set_store_preference(st, user, via, args).await,
        "check_stores" => changes::check_stores(st, user, via, args).await,
        "add_wish" => changes::add_wish(st, user, via, args).await,
        "apply_change" => {
            let c = changes::apply(st, user, text_arg(args, "id")?).await?;
            match (c.status.as_str(), c.error) {
                ("applied", _) => Ok(format!("Applied: {}. {}", c.summary, c.result.and_then(|r| r["label"].as_str().map(String::from)).unwrap_or_default())),
                (_, Some(e)) => Err(AppError::Conflict(format!("Not applied: {e}"))),
                (status, None) => Err(AppError::Conflict(format!("Not applied; the change is {status}."))),
            }
        }
        "discard_change" => {
            let c = changes::discard(pool, &user.id, text_arg(args, "id")?).await?;
            Ok(format!("Discarded: {}", c.summary))
        }
        "overview" => {
            let mut text = context::build(pool, user, "general", None).await?;
            text.push_str(&note_plans(pool, &user.id, None).await?);
            Ok(text)
        }
        "deck" => deck(pool, user, text_arg(args, "deck")?).await,
        "plan_deck" => {
            let key = text_arg(args, "key")?;
            match context::build(pool, user, "plan_deck", Some(key)).await {
                // A note deck with no tracked build yet is still a deck plan: say what it has.
                Err(AppError::NotFound(_)) => {
                    let text = note_plans(pool, &user.id, Some(key)).await?;
                    if text.is_empty() { Err(AppError::NotFound("plan deck")) } else { Ok(text) }
                }
                other => other,
            }
        }
        "review_queue" => context::build(pool, user, "review", None).await,
        "shopping_trip" => {
            let today = match args.get("today").and_then(Value::as_str) {
                Some(d) if crate::plan::model::is_date(d) => d.to_string(),
                Some(d) => return Err(AppError::bad(format!("today: \"{d}\" isn't a YYYY-MM-DD date"))),
                None => chrono::Utc::now().format("%Y-%m-%d").to_string(),
            };
            let going: Option<Vec<String>> = match args.get("stores").filter(|v| !v.is_null()) {
                None => None,
                Some(v) => Some(
                    v.as_array()
                        .and_then(|a| a.iter().map(|x| x.as_str().map(String::from)).collect::<Option<Vec<_>>>())
                        .ok_or_else(|| AppError::bad("stores must be a list of store keys"))?,
                ),
            };
            let bundle = crate::plan::bundle::load_bundle(pool, &user.id).await?;
            if let Some(g) = &going {
                let known: Vec<&str> = bundle["stores"]
                    .as_array()
                    .map(|a| a.iter().filter(|s| s["retired"] != true && s["kind"] != "printer").filter_map(|s| s["key"].as_str()).collect())
                    .unwrap_or_default();
                if let Some(bad) = g.iter().find(|k| !known.contains(&k.as_str())) {
                    return Err(AppError::bad(format!("No store with key \"{bad}\". Their store keys: {}.", known.join(", "))));
                }
            }
            Ok(crate::plan::trip::text(&crate::plan::trip::plan(&bundle, &today, going.as_deref())))
        }
        "shopping_settings" => {
            let bundle = crate::plan::bundle::load_bundle(pool, &user.id).await?;
            Ok(crate::plan::shopping::settings_text(&bundle, &chrono::Utc::now().format("%Y-%m-%d").to_string()))
        }
        "shopping_list" => {
            let today = match args.get("today").and_then(Value::as_str) {
                Some(d) if crate::plan::model::is_date(d) => d.to_string(),
                Some(d) => return Err(AppError::bad(format!("today: \"{d}\" isn't a YYYY-MM-DD date"))),
                None => chrono::Utc::now().format("%Y-%m-%d").to_string(),
            };
            let bundle = crate::plan::bundle::load_bundle(pool, &user.id).await?;
            let mut text = crate::plan::trip::list_text(&bundle, &today);
            // Sealed products along the way only from stores the card trip visits.
            let trip = crate::plan::trip::plan(&bundle, &today, None);
            let on_trip = trip.stops.iter().filter_map(|st| st.store["key"].as_str().map(String::from)).collect();
            let scope = crate::plan::sealed::Scope { going: None, trip: Some(on_trip) };
            text.push_str(&crate::plan::sealed::text(&crate::plan::sealed::view(pool, &user.id, &today, &scope).await?));
            Ok(text)
        }
        "store_stock" => {
            let wanted = text_arg(args, "store")?;
            let w = wanted.trim().to_lowercase();
            let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, name FROM plan_stores WHERE owner_id = ? AND kind != 'printer' ORDER BY sort, key").bind(&user.id).fetch_all(pool).await?;
            let Some((key, name)) = rows.iter().find(|(k, n)| k.to_lowercase() == w || n.to_lowercase() == w).or_else(|| {
                let hits: Vec<&(String, String)> = rows.iter().filter(|(_, n)| n.to_lowercase().contains(&w)).collect();
                (hits.len() == 1).then(|| hits[0])
            }) else {
                return Err(AppError::bad(format!("No store \"{wanted}\". Their stores: {}.", rows.iter().map(|(k, n)| format!("{n} ({k})")).collect::<Vec<_>>().join(", "))));
            };
            let cards: Vec<String> = match args.get("cards").filter(|v| !v.is_null()) {
                Some(v) => v
                    .as_array()
                    .and_then(|a| a.iter().map(|x| x.as_str().map(|s| s.trim().to_string())).collect::<Option<Vec<_>>>())
                    .filter(|c| c.len() <= crate::plan::stock::MAX_CARDS)
                    .ok_or_else(|| AppError::bad("cards must be a list of at most 300 card names"))?,
                None => crate::plan::stock::trip_cards(&crate::plan::bundle::load_bundle(pool, &user.id).await?),
            };
            crate::plan::stock::stock_text(pool, &user.id, key, name, &cards).await
        }
        "find_cards" => {
            st.limits.search.check_user(user)?;
            find_cards(pool, user, args).await
        }
        "card" => {
            st.limits.search.check_user(user)?;
            card(pool, user, args).await
        }
        "price_history" => {
            st.limits.search.check_user(user)?;
            price_history(pool, args).await
        }
        "check_list" => check_list(pool, args).await,
        "lab_runs" => lab_runs(pool, user).await,
        "lab_run" => context::build(pool, user, "experiment", Some(text_arg(args, "id")?)).await,
        "lab_games" => lab_games(pool, user, args).await,
        "precon" => precon(pool, user, text_arg(args, "precon")?).await,
        other if super::research::offered(other) => {
            st.limits.search.check_user(user)?;
            super::research::call(st, user, via, other, args).await
        }
        other => Err(AppError::bad(format!("unknown tool \"{other}\""))),
    }
}

pub(super) fn text_arg<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.len() <= 300).ok_or_else(|| AppError::bad(format!("{key} is missing")))
}

/// The printing a `price_history` call names: (Scryfall id, name, set code, collector number).
async fn history_printing(pool: &SqlitePool, args: &Value) -> AppResult<(String, String, String, String)> {
    const COLUMNS: &str = "p.scryfall_id, p.name, p.set_code, p.collector_number";
    let arg = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let found: Option<(String, String, String, String)> = if let Some(id) = arg("printing") {
        sqlx::query_as(AssertSqlSafe(format!("SELECT {COLUMNS} FROM printings p WHERE p.scryfall_id = ?"))).bind(id).fetch_optional(pool).await?
    } else if let (Some(set), Some(number)) = (arg("set"), arg("number")) {
        sqlx::query_as(AssertSqlSafe(format!("SELECT {COLUMNS} FROM printings p WHERE p.set_code = lower(?) AND p.collector_number = ? ORDER BY p.lang = 'en' DESC LIMIT 1")))
            .bind(set)
            .bind(number)
            .fetch_optional(pool)
            .await?
    } else if let Some(name) = arg("card") {
        let ids = crate::cards::resolve_names(pool, &[name.to_string()]).await?;
        let Some(oid) = ids.values().next() else { return Err(AppError::bad(format!("Yama doesn't know a card called {name:?}"))) };
        if args.get("cheapest").and_then(Value::as_bool).unwrap_or(false) {
            // As `card` picks it: playable printings only.
            sqlx::query_as(AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM printings p JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
                  WHERE p.oracle_id = ? AND ps.usd IS NOT NULL AND IFNULL(p.digital, 0) = 0
                    AND IFNULL(p.set_type, '') NOT IN ('memorabilia', 'funny', 'token', 'minigame')
                  ORDER BY ps.usd LIMIT 1"
            )))
            .bind(oid)
            .fetch_optional(pool)
            .await?
        } else {
            sqlx::query_as(AssertSqlSafe(format!("SELECT {COLUMNS} FROM printings p JOIN cards c ON c.default_printing = p.scryfall_id WHERE c.oracle_id = ?")))
                .bind(oid)
                .fetch_optional(pool)
                .await?
        }
    } else {
        return Err(AppError::bad("name a card, a printing (Scryfall id), or a set and number"));
    };
    found.ok_or(AppError::NotFound("printing"))
}

/// A printing's market price over time (the `price_history` tool): change points, not every day.
async fn price_history(pool: &SqlitePool, args: &Value) -> AppResult<String> {
    let finish = args.get("finish").and_then(Value::as_str).unwrap_or("nonfoil");
    let offset = match finish {
        "nonfoil" => 0,
        "foil" => 1,
        "etched" => 2,
        other => return Err(AppError::bad(format!("finish: {other:?} isn't nonfoil, foil or etched"))),
    };
    // Each source is its own series (migrations 0060, 0065); never a number from two of them.
    let source = args.get("source").and_then(Value::as_str).unwrap_or("tcgplayer");
    let (series, feed, note) = match source {
        "tcgplayer" => (1, crate::prices::SCRYFALL, "Daily market reference prices on the days Yama read them. Not a store quote. A null price means none was listed; gaps are days Yama didn't read. This product uses TCGplayer data but is not endorsed or certified by TCGplayer."),
        "cardkingdom_retail" => (20, crate::prices::mtgjson::CARDKINGDOM, "Card Kingdom's retail price on each day Yama read it, via MTGJSON. Not proof it's in stock today, and not a quote from your stores. A null price means none was listed; gaps are days Yama didn't read."),
        "cardkingdom_buylist" => (23, crate::prices::mtgjson::CARDKINGDOM, "What Card Kingdom was buying near-mint copies for on each day Yama read its buylist, via MTGJSON: what it was paying, not what you'll get. Worse condition pays less. A null price means it wasn't buying; gaps are days Yama didn't read."),
        "manapool" => (26, crate::prices::mtgjson::MANAPOOL, "Mana Pool's lowest listing on each day Yama read it, via MTGJSON. Not a store quote. A null price means nothing was listed; gaps are days Yama didn't read."),
        other => return Err(AppError::bad(format!("source: {other:?} isn't tcgplayer, cardkingdom_retail, cardkingdom_buylist or manapool"))),
    };
    let series = series + offset;
    let days = args.get("days").and_then(Value::as_i64).unwrap_or(90);
    if !(1..=1000).contains(&days) {
        return Err(AppError::bad("days: 1 to 1000"));
    }
    let (id, name, set, number) = history_printing(pool, args).await?;
    let Some(to) = crate::prices::newest_observation(pool, feed).await? else {
        return Ok("No prices from that source have been read yet.".into());
    };
    let label: String = sqlx::query_scalar("SELECT label FROM price_series WHERE id = ?").bind(series).fetch_one(pool).await?;
    let from = to - days + 1;
    let h = crate::prices::history::changes(pool, &id, series, from, to).await?;
    let point = |p: &Option<(String, Option<f64>)>| p.as_ref().map(|(d, v)| json!({"date": d, "price": v}));
    let extreme = |p: &Option<(String, f64)>| p.as_ref().map(|(d, v)| json!({"date": d, "price": v}));
    let out = json!({
        "printing": format!("{name} ({}) #{number}", set.to_uppercase()),
        "scryfall_id": id,
        "series": label,
        "source": source,
        "currency": "USD",
        "finish": finish,
        "from": crate::prices::date_of(from),
        "to": crate::prices::date_of(to),
        "observed_days": h.observed_days,
        "first": point(&h.first),
        "last": point(&h.last),
        "low": extreme(&h.low),
        "high": extreme(&h.high),
        "changes": h.changes.iter().map(|(d, v)| json!({"date": d, "price": v})).collect::<Vec<_>>(),
        "note": note,
    });
    Ok(serde_json::to_string_pretty(&out).map_err(anyhow::Error::from)?)
}

fn price(usd: Option<f64>, date: Option<&str>) -> String {
    match (usd, date) {
        (Some(p), Some(d)) => format!("${p:.2} market ({d})"),
        (Some(p), None) => format!("${p:.2} market"),
        _ => "no price".into(),
    }
}

fn legality(card: &Card) -> String {
    match card.legalities.get("commander").map(String::as_str) {
        Some("legal") => "legal in Commander".into(),
        Some("banned") => "BANNED in Commander".into(),
        Some(other) => format!("{} in Commander", other.replace('_', " ")),
        None => "Commander legality unknown".into(),
    }
}

fn game_changer(card: &Card) -> &'static str {
    match card.game_changer {
        Some(true) => ", Game Changer",
        _ => "",
    }
}

fn identity(ci: &str) -> String {
    if ci.is_empty() { "colorless".into() } else { ci.to_string() }
}

// ── decks ───────────────────────────────────────────────────────────────────

/// The caller's deck by id or (case-insensitive) name. Several matches is a 400 naming them.
/// Their notes' decks and builds as deck plans, with which build each deck tracks. With `only`,
/// just the note decks with that key that aren't tracked (`plan_deck` on such a key); empty when
/// there are none.
async fn note_plans(pool: &SqlitePool, owner: &str, only: Option<&str>) -> AppResult<String> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT r.id, r.title, r.revision, json_extract(d.value, '$.key'), json_extract(d.value, '$.name'),
           (SELECT json_group_array(json_object('id', json_extract(b.value, '$.id'), 'label', json_extract(b.value, '$.label'),
                                                'bracket', json_extract(b.value, '$.bracket')))
            FROM json_each(d.value, '$.builds') b)
         FROM research_reports r, json_each(r.document, '$.decks') d
         WHERE r.owner_id = ? AND json_type(d.value, '$.key') = 'text'
         ORDER BY r.updated_at DESC, r.id, d.key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let tracked: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT note_id, note_deck_key, note_build_id, key, status FROM plan_decks WHERE owner_id = ? AND note_id IS NOT NULL",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let tracked: HashMap<(String, String), (String, String, String)> =
        tracked.into_iter().map(|(n, d, b, k, s)| ((n, d), (b, k, s))).collect();
    let mut out = String::new();
    let mut note_seen = String::new();
    for (id, title, revision, deck_key, deck_name, builds) in rows {
        let track = tracked.get(&(id.clone(), deck_key.clone())).filter(|t| t.2 != "archived");
        if only.is_some_and(|k| k != deck_key || track.is_some()) {
            continue;
        }
        if out.is_empty() {
            out.push_str(match only {
                None => "\nTheir notes, archived plans kept for reference (`research` reads one; `track_build` makes one build a deck's next plan version, waiting for their OK):\n",
                Some(_) => "Not a plan yet. This deck is in their notes; `research` reads its builds and `track_build` makes one a plan version waiting for their OK:\n",
            });
        }
        if note_seen != id {
            let _ = writeln!(out, "- {title} (note id {id}, revision {revision}): /decks/plans/archived/{id}");
            note_seen.clone_from(&id);
        }
        let builds: Vec<Value> = serde_json::from_str(&builds).unwrap_or_default();
        let builds: Vec<String> = builds
            .iter()
            .map(|b| {
                let bracket = b["bracket"].as_i64().map(|n| format!(", bracket {n}")).unwrap_or_default();
                format!("{} ({}{bracket})", b["id"].as_str().unwrap_or("?"), b["label"].as_str().unwrap_or(""))
            })
            .collect();
        let state = match track {
            Some((build, key, _)) => format!("tracking build {build} as plan key {key}"),
            None => "no build tracked".into(),
        };
        let _ = writeln!(out, "  - {} (deck key {deck_key}): {state}. Builds: {}", deck_name.as_deref().unwrap_or(&deck_key), builds.join("; "));
    }
    Ok(out)
}

pub(super) async fn deck_id(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<String> {
    let by_id: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE id = ? AND owner_id = ? AND archived = 0").bind(wanted).bind(owner).fetch_optional(pool).await?;
    if let Some(id) = by_id {
        return Ok(id);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM decks WHERE owner_id = ? AND archived = 0 AND (lower(name) = lower(?1) OR instr(lower(name), lower(?2)) > 0)
         ORDER BY lower(name) = lower(?2) DESC, name LIMIT 10",
    )
    .bind(owner)
    .bind(wanted)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [] => Err(AppError::NotFound("deck")),
        [(id, _)] => Ok(id.clone()),
        [(id, name), ..] if name.eq_ignore_ascii_case(wanted) => Ok(id.clone()),
        many => Err(AppError::bad(format!("Several decks match \"{wanted}\": {}. Say which.", many.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")))),
    }
}

pub(super) use crate::decks::card_info;

/// Legality and Game Changers for a list, as lines.
pub(super) fn checks(cards: &[DeckCard], info: &HashMap<String, Card>) -> String {
    let v = crate::decks::validate(cards, info);
    let mut out = String::new();
    let _ = writeln!(out, "Cards (commander and main): {}. Color identity: {}.", v.total, identity(&v.color_identity));
    if v.errors.is_empty() {
        out.push_str("Commander checks: no problems found.\n");
    }
    for e in &v.errors {
        let _ = writeln!(out, "Problem: {e}");
    }
    for w in &v.warnings {
        let _ = writeln!(out, "Warning: {w}");
    }
    match crate::decks::game_changers(cards, info) {
        Some(g) if g.is_empty() => out.push_str("Game Changers: none.\n"),
        Some(g) => {
            let _ = writeln!(out, "Game Changers ({}): {}", g.len(), g.join(", "));
        }
        None => out.push_str("Game Changers: unknown (the list isn't loaded for every card).\n"),
    }
    out
}

async fn deck(pool: &SqlitePool, user: &User, wanted: &str) -> AppResult<String> {
    let id = deck_id(pool, &user.id, wanted).await?;
    let mut out = context::build(pool, user, "deck", Some(&id)).await?;
    let version: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(pool).await?;
    if let Some(v) = version {
        let cards = crate::decks::load_version_cards(pool, &v).await?;
        let info = card_info(pool, &cards).await?;
        out.push('\n');
        out.push_str(&checks(&cards, &info));
    }
    let _ = writeln!(out, "Deck id: {id}");
    Ok(out)
}

async fn check_list(pool: &SqlitePool, args: &Value) -> AppResult<String> {
    let text = args.get("list").and_then(Value::as_str).ok_or_else(|| AppError::bad("list is missing"))?;
    if text.lines().count() > MAX_LIST_LINES {
        return Err(AppError::bad(format!("a list can be at most {MAX_LIST_LINES} lines")));
    }
    let first = args.get("first_is_commander").and_then(Value::as_bool).unwrap_or(true);
    let parsed = crate::decks::resolve(pool, crate::decks::parse_list(text, first)).await?;
    let info = card_info(pool, &parsed.cards).await?;
    let mut out = String::new();
    let commanders: Vec<&str> = parsed.cards.iter().filter(|c| c.board == Board::Commander).map(|c| c.name.as_str()).collect();
    let _ = writeln!(out, "Commander: {}", if commanders.is_empty() { "none found".into() } else { commanders.join(" and ") });
    out.push_str(&checks(&parsed.cards, &info));
    if !parsed.unknown.is_empty() {
        let _ = writeln!(out, "Names Yama doesn't know (not counted): {}", parsed.unknown.join(", "));
    }
    Ok(out)
}

// ── cards ───────────────────────────────────────────────────────────────────

fn search_line(c: &SearchCard) -> String {
    let card = &c.card;
    let owned = match (c.owned, &c.owned_in) {
        (0, _) => String::new(),
        (n, Some(place)) => format!(", they own {n} (in {place})"),
        (n, None) => format!(", they own {n}"),
    };
    format!(
        "- {} {} | {} | {} | {}{} | {}{}",
        card.name,
        card.mana_cost.as_deref().unwrap_or(""),
        card.type_line,
        identity(&card.color_identity),
        legality(card),
        game_changer(card),
        price(c.usd, c.price_date.as_deref()),
        owned
    )
}

async fn find_cards(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let query = args.get("query").and_then(Value::as_str).map(str::trim).filter(|q| !q.is_empty()).ok_or_else(|| AppError::bad("query is missing"))?;
    let order = args.get("order").and_then(Value::as_str);
    let page = args.get("page").and_then(Value::as_u64).unwrap_or(1).clamp(1, 1000) as u32;
    let r = crate::cards::search(pool, &user.id, query, order, page).await?;
    let mut out = format!("{} cards match `{query}`", r.total);
    let first = (r.page - 1) * r.page_size;
    if r.total > r.page_size as i64 {
        let _ = write!(out, "; this is page {} ({} to {})", r.page, first + 1, first + r.cards.len() as u32);
    }
    out.push_str(":\n");
    for c in &r.cards {
        out.push_str(&search_line(c));
        out.push('\n');
    }
    Ok(out)
}

/// Close names for one Yama doesn't know, for "did you mean": the whole name inside a longer one,
/// else cards sharing one of its longer words (so a typo in one word still finds it).
pub(super) async fn near_names(pool: &SqlitePool, name: &str) -> AppResult<Vec<String>> {
    let clean = name.trim().replace(['%', '_'], "");
    let mut out: Vec<String> = sqlx::query_scalar("SELECT name FROM cards WHERE name LIKE ? ORDER BY length(name) LIMIT 5").bind(format!("%{clean}%")).fetch_all(pool).await?;
    for word in clean.split_whitespace().filter(|w| w.chars().count() >= 4).take(4) {
        if out.len() >= 5 {
            break;
        }
        let more: Vec<String> = sqlx::query_scalar("SELECT name FROM cards WHERE name LIKE ? ORDER BY edhrec_rank IS NULL, edhrec_rank LIMIT 5").bind(format!("%{word}%")).fetch_all(pool).await?;
        for n in more {
            if out.len() < 5 && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    Ok(out)
}

async fn card(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let names: Vec<String> = args
        .get("names")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() <= 200).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return Err(AppError::bad("names is missing"));
    }
    if names.len() > MAX_NAMES {
        return Err(AppError::bad(format!("at most {MAX_NAMES} names at a time")));
    }
    let with_rulings = args.get("rulings").and_then(Value::as_bool).unwrap_or(false);
    let ids = crate::cards::resolve_names(pool, &names).await?;
    let items = crate::collection::items_for_owner(pool, &user.id).await?;
    let mut out = String::new();
    for name in &names {
        let Some(oid) = ids.get(name) else {
            let near = near_names(pool, name).await?;
            let _ = writeln!(
                out,
                "## {name}\nYama doesn't know this name.{}\n",
                if near.is_empty() { String::new() } else { format!(" Close: {}.", near.join(", ")) }
            );
            continue;
        };
        let Some(card) = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id = ?"))).bind(oid).fetch_optional(pool).await? else {
            continue;
        };
        let _ = writeln!(out, "## {} {}", card.name, card.mana_cost.as_deref().unwrap_or(""));
        let _ = writeln!(out, "{} (mana value {})", card.type_line, card.cmc);
        if !card.oracle_text.is_empty() {
            let _ = writeln!(out, "{}", card.oracle_text);
        }
        if let (Some(p), Some(t)) = (&card.power, &card.toughness) {
            let _ = writeln!(out, "{p}/{t}");
        }
        if let Some(l) = &card.loyalty {
            let _ = writeln!(out, "Loyalty {l}");
        }
        let rank = card.edhrec_rank.map(|r| format!(", EDHREC rank {r}")).unwrap_or_default();
        let _ = writeln!(out, "Color identity {}; {}{}{}", identity(&card.color_identity), legality(&card), game_changer(&card), rank);
        let latest: Option<(Option<f64>, String, String, String)> = sqlx::query_as(
            "SELECT COALESCE(ps.usd, ps.usd_foil, ps.usd_etched), ps.date, p.set_name, p.collector_number
             FROM printings p JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
             WHERE p.scryfall_id = ?",
        )
        .bind(card.default_printing.as_deref().unwrap_or(""))
        .fetch_optional(pool)
        .await?;
        // Gold-bordered, digital and novelty printings aren't playable in a sanctioned game.
        let cheapest: Option<(f64, String, String, String)> = sqlx::query_as(
            "SELECT ps.usd, ps.date, p.set_name, p.collector_number FROM printings p JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
             WHERE p.oracle_id = ? AND ps.usd IS NOT NULL
               AND IFNULL(p.digital, 0) = 0 AND IFNULL(p.set_type, '') NOT IN ('memorabilia', 'funny', 'token', 'minigame')
             ORDER BY ps.usd LIMIT 1",
        )
        .bind(oid)
        .fetch_optional(pool)
        .await?;
        match latest {
            Some((usd, date, set, num)) => {
                let _ = writeln!(out, "Price (Scryfall market, default printing: {set} #{num}): {}", price(usd, Some(&date)));
                if let Some(day) = crate::prices::day_of(&date) {
                    let then = crate::prices::history::history(pool, card.default_printing.as_deref().unwrap_or(""), day - 30, day - 30).await?;
                    if let Some(p) = then.first().filter(|p| p.usd.is_some() || p.usd_foil.is_some() || p.usd_etched.is_some()) {
                        let _ = writeln!(out, "30 days ago: {}", price(p.usd.or(p.usd_foil).or(p.usd_etched), Some(&p.date)));
                    }
                }
            }
            None => out.push_str("Price: none known\n"),
        }
        if let Some((usd, date, set, num)) = cheapest {
            let _ = writeln!(out, "Cheapest printing: {set} #{num}, {}", price(Some(usd), Some(&date)));
        }
        let mine: Vec<_> = items.iter().filter(|i| i.oracle_id.as_deref() == Some(oid.as_str()) && i.qty > 0).collect();
        if mine.is_empty() {
            out.push_str("They own: none\n");
        } else {
            let places: Vec<String> = mine
                .iter()
                .map(|i| {
                    format!(
                        "{} from {} #{}{}{}",
                        i.qty,
                        i.set_name.as_deref().unwrap_or("an unknown set"),
                        i.collector_number.as_deref().unwrap_or("?"),
                        if i.proxy { " (proxy)" } else { "" },
                        i.container_name.as_deref().map(|n| format!(" in {n}")).unwrap_or_else(|| " (not in a binder or deck box)".into())
                    )
                })
                .collect();
            let _ = writeln!(out, "They own: {}", places.join("; "));
        }
        if with_rulings {
            let rulings: Vec<(String, String)> =
                sqlx::query_as("SELECT published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at, rowid").bind(oid).fetch_all(pool).await?;
            for (date, text) in rulings {
                let _ = writeln!(out, "Ruling ({date}): {text}");
            }
        }
        out.push('\n');
    }
    Ok(out)
}

// ── lab and precons ─────────────────────────────────────────────────────────

async fn lab_runs(pool: &SqlitePool, user: &User) -> AppResult<String> {
    let rows: Vec<(String, String, String, i64, i64, String)> = sqlx::query_as(
        "SELECT id, name, status, games_done, games_total, created_at FROM lab_experiments WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30",
    )
    .bind(&user.id)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok("No lab experiments yet.".into());
    }
    let mut out = String::from("Their lab experiments, newest first:\n");
    for (id, name, status, done, total, created) in rows {
        let _ = writeln!(out, "- {name} ({status}, {done} of {total} games, made {}) id {id}", created.get(..10).unwrap_or(&created));
    }
    Ok(out)
}

/// An experiment's games pod by pod on one engine, or one game in full (`game`).
async fn lab_games(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    use crate::lab::experiments::{GameView, pods_for};
    let id = text_arg(args, "id")?;
    let engine = args.get("engine").and_then(Value::as_str).map(str::trim).filter(|e| !e.is_empty());
    if let Some(game) = args.get("game").and_then(Value::as_str).map(str::trim).filter(|g| !g.is_empty()) {
        return lab_game(pool, user, id, game).await;
    }
    let deck = args.get("deck").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty());
    let table = args.get("table").and_then(Value::as_u64);
    if deck.is_some() || table.is_some() {
        return lab_tables(pool, user, id, engine, deck, table).await;
    }
    let unscored_only = match args.get("only").and_then(Value::as_str) {
        None | Some("all") => false,
        Some("unscored") => true,
        Some(other) => return Err(AppError::bad(format!("only: \"{other}\" isn't all or unscored"))),
    };
    let pods = pods_for(pool, &user.id, id, engine).await?;
    let (base, variant): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT json_extract(spec, '$.base.label'), json_extract(spec, '$.variant.label') FROM lab_experiments WHERE id = ? AND owner_id = ?")
            .bind(id)
            .bind(&user.id)
            .fetch_one(pool)
            .await?;
    let engine_name = match engine {
        Some(e) => e.to_string(),
        None => sqlx::query_scalar("SELECT engine FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord LIMIT 1").bind(id).fetch_optional(pool).await?.unwrap_or_else(|| "phase".into()),
    };
    let unscored = |g: &Option<GameView>| g.as_ref().is_some_and(|g| !g.scored);
    let shown: Vec<_> = pods.iter().filter(|p| !unscored_only || unscored(&p.base) || unscored(&p.variant) || p.game.as_ref().is_some_and(|g| !g.scored)).collect();
    let mut out = format!(
        "{} pod{} on {engine_name}{}. Seat 1 takes the first turn. A game that ran out of CPU time, crashed or failed isn't scored. \
         Ask for one game's id with `game` to get what's needed to replay it.\n",
        shown.len(),
        if shown.len() == 1 { "" } else { "s" },
        if unscored_only { format!(" with a game that wasn't scored (of {})", pods.len()) } else { String::new() },
    );
    let (base, variant) = (base.unwrap_or_else(|| "base".into()), variant.unwrap_or_else(|| "changed".into()));
    for p in shown {
        if let Some(g) = &p.game {
            let seats: Vec<String> = p.seats.iter().map(|s| s.clone().unwrap_or_default()).collect();
            let result = if !g.scored {
                end_words(&g.end, g.error.as_deref())
            } else if let Some(w) = &g.winner {
                format!("{w} won")
            } else {
                end_words(&g.end, None)
            };
            let _ = writeln!(out, "- Game {} ({}): {result}, {} turns, {:.0} s CPU [{}]", p.pod, seats.join(", "), g.turns, g.seconds, g.game);
            continue;
        }
        let others: Vec<&str> = p.seats.iter().flatten().map(String::as_str).collect();
        let _ = writeln!(
            out,
            "- Pod {} (tested seat {}; others {}): {}: {}; {}: {}",
            p.pod,
            p.seat + 1,
            others.join(", "),
            base,
            game_words(p.base.as_ref()),
            variant,
            game_words(p.variant.as_ref())
        );
    }
    Ok(out)
}

/// A head-to-head or tournament run's tables for one deck, or one table, game by game.
async fn lab_tables(pool: &SqlitePool, user: &User, id: &str, engine: Option<&str>, deck: Option<&str>, table: Option<u64>) -> AppResult<String> {
    use crate::lab::experiments::tables_for;
    let table = table.map(|t| usize::try_from(t).unwrap_or(usize::MAX));
    // A deck by entrant id, or by its name (exact first, then the only one containing it).
    let entrant = match deck {
        None => None,
        Some(d) => {
            let own: Option<i64> = sqlx::query_scalar("SELECT 1 FROM lab_experiments WHERE id = ? AND owner_id = ?").bind(id).bind(&user.id).fetch_optional(pool).await?;
            if own.is_none() {
                return Err(AppError::NotFound("experiment"));
            }
            let names: Vec<(String, String)> = sqlx::query_as(
                "SELECT json_extract(o.value, '$.id'), json_extract(o.value, '$.label') FROM lab_experiments e, json_each(e.spec, '$.entrants') o WHERE e.id = ? AND e.owner_id = ?",
            )
            .bind(id)
            .bind(&user.id)
            .fetch_all(pool)
            .await?;
            let low = d.to_lowercase();
            let listed = |m: &[&(String, String)]| m.iter().take(8).map(|(i, l)| format!("{l} ({i})")).collect::<Vec<_>>().join(", ");
            // An entrant id wins; then a name only when exactly one deck has it, or contains it.
            if let Some((i, _)) = names.iter().find(|(i, _)| i.eq_ignore_ascii_case(d)) {
                Some(i.clone())
            } else {
                let exact: Vec<&(String, String)> = names.iter().filter(|(_, l)| l.to_lowercase() == low).collect();
                let partial: Vec<&(String, String)> = names.iter().filter(|(_, l)| l.to_lowercase().contains(&low)).collect();
                let pick = if exact.is_empty() { &partial } else { &exact };
                match pick.as_slice() {
                    [one] => Some(one.0.clone()),
                    [] => return Err(AppError::bad(format!("No deck in this run is called \"{d}\""))),
                    many => return Err(AppError::bad(format!("\"{d}\" matches {} decks: {}; give its entrant id", many.len(), listed(many)))),
                }
            }
        }
    };
    let t = tables_for(pool, &user.id, id, engine, entrant.as_deref(), table).await?;
    let label = |d: &str| t.decks.iter().find(|x| x.id == d).map_or_else(|| d.to_string(), |x| x.label.clone());
    let mut out = format!(
        "{} table{} on {}{}. A table is the same decks for a block of games, a seat apart. Turns count every player's turn. \
         Each seat is listed best first with its place (1 is the winner; \"tied 2\" when several shared it).\n",
        t.tables.len(),
        if t.tables.len() == 1 { "" } else { "s" },
        t.engine,
        entrant.as_deref().map(|e| format!(" where {} sat", label(e))).unwrap_or_default(),
    );
    for tv in &t.tables {
        let names: Vec<String> = tv.decks.iter().map(|d| label(d)).collect();
        let _ = writeln!(out, "Table {} ({}):", tv.table, names.join(", "));
        for g in &tv.games {
            if !g.played {
                let _ = writeln!(out, "- {}: not played yet", g.game);
                continue;
            }
            let n = g.seats.len();
            let first = usize::from(g.first_seat.unwrap_or(0));
            let mut order: Vec<usize> = (0..n).map(|i| (first + i) % n).collect();
            if g.scored {
                order.sort_by(|a, b| g.places[*a].unwrap_or(99.0).total_cmp(&g.places[*b].unwrap_or(99.0)));
            }
            let seats: Vec<String> = order
                .iter()
                .map(|&s| {
                    // Tied players share the mean of their places: name the place the tie starts at.
                    let place = g.places[s].map(|p| {
                        let better = g.places.iter().flatten().filter(|o| **o < p).count();
                        let tied = g.places.iter().flatten().filter(|o| **o == p).count() > 1;
                        format!("{}{}", if tied { "tied " } else { "" }, better + 1)
                    });
                    let went = (s + n - first) % n + 1;
                    let how = if g.winner == Some(s as u8) && g.end.as_deref() == Some("win") {
                        "won".to_string()
                    } else if let Some(turn) = g.out_turn[s] {
                        format!("out on turn {turn}")
                    } else {
                        g.final_life[s].map_or_else(|| "lasted".to_string(), |l| format!("lasted, {l} life"))
                    };
                    let went = ["first", "second", "third", "fourth", "fifth", "sixth"].get(went - 1).map_or_else(|| format!("{went}th"), |w| (*w).to_string());
                    format!("{}{} (went {went}, {how})", place.map(|p| format!("{p}. ")).unwrap_or_default(), label(&g.seats[s]))
                })
                .collect();
            let end = end_words(g.end.as_deref().unwrap_or("error"), g.error.as_deref());
            let _ = writeln!(out, "- {} ({end}, {} turns, {:.0} s CPU): {}", g.game, g.turns, g.seconds, seats.join("; "));
        }
    }
    Ok(out)
}

fn game_words(g: Option<&crate::lab::experiments::GameView>) -> String {
    let Some(g) = g else { return "not played yet".into() };
    let what = if !g.scored {
        end_words(&g.end, g.error.as_deref())
    } else if g.won {
        "won".into()
    } else {
        match (g.end.as_str(), g.place) {
            ("win", Some(p)) => format!("lost (place {})", fmt_place(p)),
            (end, _) => end_words(end, None),
        }
    };
    format!("{what}, {} turns, {:.0} s CPU [{}]", g.turns, g.seconds, g.game)
}

fn fmt_place(p: f64) -> String {
    if p.fract() == 0.0 { format!("{p:.0}") } else { format!("{p:.1}") }
}

/// A game's end in words; `error` adds the reason a failed game gave.
fn end_words(end: &str, error: Option<&str>) -> String {
    let why = error.map(|e| format!(": {}", e.chars().take(300).collect::<String>())).unwrap_or_default();
    match end {
        "win" => "won".into(),
        "draw" => "a draw".into(),
        "turn_cap" => "nobody won by the turn cap".into(),
        "action_cap" => "nobody won by the action cap".into(),
        "time_cap" => "ran out of CPU time (not scored)".into(),
        "panic" => format!("crashed (not scored){why}"),
        "error" => format!("failed (not scored){why}"),
        other => format!("{other}{why}"),
    }
}

/// One game of the owner's experiment in full: schedule line, result line, and each seat's list
/// in the lab runner's deck format.
async fn lab_game(pool: &SqlitePool, user: &User, id: &str, game: &str) -> AppResult<String> {
    let row: Option<(String, Option<String>, String, i64, i64, String)> = sqlx::query_as(
        "SELECT g.spec, g.result, g.engine, g.attempts, g.retried, e.spec FROM lab_experiment_games g JOIN lab_experiments e ON e.id = g.experiment_id
         WHERE g.experiment_id = ? AND e.owner_id = ? AND g.game = ?",
    )
    .bind(id)
    .bind(&user.id)
    .bind(game)
    .fetch_optional(pool)
    .await?;
    let Some((line, result, engine, attempts, retried, spec)) = row else { return Err(AppError::NotFound("game")) };
    let spec: crate::lab::experiments::ExperimentSpec = serde_json::from_str(&spec).map_err(anyhow::Error::from)?;
    let game_spec: yama_play::lab::GameSpec = serde_json::from_str(&line).map_err(anyhow::Error::from)?;
    let lists: HashMap<&str, &crate::lab::experiments::LabList> = std::iter::once(&spec.base)
        .chain(spec.variant.iter())
        .chain(spec.entrants.iter())
        .chain(spec.opponents.iter().map(|o| &o.list))
        .map(|l| (l.id.as_str(), l))
        .collect();
    let mut out = format!("Game {game} on {engine}, started {attempts} time{}", if attempts == 1 { "" } else { "s" });
    if retried != 0 {
        out.push_str(", played a second time after the machine cut its first try short");
    }
    out.push_str(".\n");
    let _ = writeln!(out, "Schedule line:\n{line}");
    let _ = writeln!(out, "Result line:\n{}", result.as_deref().unwrap_or("(not played yet)"));
    if engine == "forge" {
        out.push_str("Forge games are played by the Forge worker and don't replay with the lab runner.\n");
    } else {
        out.push_str(
            "To replay: save each list below as <decks-root>/<deck id>.txt and the schedule line as a one-line file, then \
             `lab --card-data <card-data-HASH.json> --decks-root <dir> --schedule <file> --out <results.jsonl>`, or \
             `labtrace ... --game <id>` for a turn-by-turn trace. It replays move for move on the build the result line names \
             (engine and card_data).\n",
        );
    }
    for (seat, deck) in game_spec.decks.iter().enumerate() {
        match lists.get(deck.as_str()) {
            Some(l) => {
                let _ = writeln!(out, "\nSeat {}: {} ({deck}.txt)\n{}", seat + 1, l.label, crate::lab::experiments::list_text(&l.cards));
            }
            None => {
                let _ = writeln!(out, "\nSeat {}: {deck} (its list isn't in the experiment)", seat + 1);
            }
        }
    }
    Ok(out)
}

async fn precon(pool: &SqlitePool, user: &User, wanted: &str) -> AppResult<String> {
    let (id, _) = precon_id(pool, wanted).await?;
    context::build(pool, user, "precon", Some(&id)).await
}

/// A precon by slug or name (or part of one): (slug, name).
pub(super) async fn precon_id(pool: &SqlitePool, wanted: &str) -> AppResult<(String, String)> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM precons WHERE id = ?1 OR lower(name) = lower(?1) OR instr(lower(name), lower(?1)) > 0
         ORDER BY id = ?1 DESC, lower(name) = lower(?1) DESC, released DESC LIMIT 10",
    )
    .bind(wanted)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [] => Err(AppError::NotFound("precon")),
        [one] => Ok(one.clone()),
        [first, ..] if first.0 == wanted || first.1.eq_ignore_ascii_case(wanted) => Ok(first.clone()),
        many => Err(AppError::bad(format!(
            "Several precons match \"{wanted}\": {}. Say which.",
            many.iter().map(|(id, n)| format!("{n} ({id})")).collect::<Vec<_>>().join(", ")
        ))),
    }
}

// ── staged changes ──────────────────────────────────────────────────────────

async fn changes_text(pool: &SqlitePool, user: &User) -> AppResult<String> {
    let waiting = changes::list(pool, &user.id, true, None).await?;
    if waiting.is_empty() {
        return Ok("No changes are waiting for their review.".into());
    }
    let mut out = format!("{} change{} waiting for their review, newest first:\n", waiting.len(), if waiting.len() == 1 { " is" } else { "s are" });
    for c in waiting {
        let _ = write!(out, "- {} (id {}, staged {}", c.summary, c.id, c.created_at.get(..10).unwrap_or(&c.created_at));
        if let Some(e) = &c.error {
            let _ = write!(out, "; the last try to apply it failed: {e}");
        }
        out.push_str(")\n");
    }
    Ok(out)
}
