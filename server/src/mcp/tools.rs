//! The tools (docs/mcp-design.md), one `registry::Tool` each. Each takes the caller and its JSON arguments and returns text for
//! Claude, built only from the caller's own rows (or shared card and precon data). The read tools
//! are here; the write tools only stage a change for the person to review (`changes.rs`).
//!
//! The longer summaries reuse the advisor's context builders (`advisor::context::build`), so a
//! plan or a lab run reads the same to Ask Claude and to an outside client.

use super::args as arg;
use super::registry::{self, Ctx, Kind, Offer, Tool, run};
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

/// Names one `get_cards` call may ask about.
const MAX_NAMES: usize = 20;
/// Lines one `check_deck_list` call may send.
const MAX_LIST_LINES: usize = 300;

/// A staging tool's handler from one of `changes`' `async fn(st, user, via, args)`.
macro_rules! stage {
    ($f:path) => {
        |c, args| Box::pin($f(c.st, c.user, c.via, args))
    };
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

pub(super) const TOOLS: &[Tool] = &[
    Tool {
        name: "list_datasets",
        aliases: &["datasets"],
        title: "Your evidence datasets",
        description: "List your private imported evidence datasets, active revisions, sources and record counts. Imported aggregates, overlapping windows and ELO points are not independent game records. Use get_dataset to inspect dated evidence.",
        schema: no_args,
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_datasets),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_dataset",
        aliases: &["dataset"],
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
            "half_life_days":{"type":"integer","minimum":1,"maximum":3650},
            "cursor": {"type": "string", "maxLength": 200, "description": "next_cursor from the answer before, with the same other arguments."}},"required":["id"],"additionalProperties":false}),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_dataset),
        stages: None,
        output: Some(registry::paged),
        untrusted: None,
        renamed: &[("search", "query")],
    },
    Tool {
        name: "get_research",
        aliases: &["research"],
        title: "Your saved deck research and review choices",
        description: "Read private research and review choices. No id lists reports; id alone gives a compact overview with build power and scenario totals. deck retrieves one full deck audit, optionally narrowed by build; scenario retrieves one exact global shopping/print allocation. full=true returns the complete potentially large document. Research is advice, not installed decks or approved purchases.",
        schema: || obj(&[("id", "string", "Report id; omit to list reports."), ("deck", "string", "Optional deck key within the report."), ("build", "string", "Optional build id, with deck."), ("scenario", "string", "One global acquisition scenario, instead of deck."), ("full", "boolean", "Return the complete document instead of a compact overview; can be large."), ("detail", "string", "summary (default) or full: full is the same as full=true.")], &[]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_research),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "save_research",
        aliases: &[],
        title: "Save private research for review in Yama",
        description: "Store or refresh a yama-research/1 document: a deck plan's content (builds, swaps with reasons, acquisition evidence), private to the caller. This saves directly and idempotently, replacing the note's earlier revision; review choices survive refreshes and changed targets are flagged. A plan already tracking one of the note's builds follows the refreshed note (its swaps, store offers and lists are derived again). A document that drops a deck or build a plan tracks would stop that plan, so it is refused and nothing is saved unless stop_plans is true. It never installs or saves a playable deck, changes inventory, approves a purchase, orders prints or starts games. To make a build the deck's plan, stage track_build afterwards. Use when asked to store research or a plan in Yama. Owner comes from sign-in, never the document.",
        schema: || json!({"type":"object","properties":{
            "document":{"type":"object","description":"A yama-research/1 report (up to 4 MiB), with id, title, generated_at, decks and exact proposed builds."},
            "stop_plans":{"type":"boolean","description":"Only when they asked to drop the plan: also archive each plan tracking a deck or build this document no longer has, and retire its swaps (default false: such a save is refused and names those plans)."}
        },"required":["document"],"additionalProperties":false}),
        kind: Kind::Write { destroys: true },
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_save_research),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "review_research",
        aliases: &[],
        title: "Record their research choice or note",
        description: "Save a research preference only when the person states that choice or asks to save the note. Read research first for the exact target, target_hash and review version. This records a preferred build or want/unsure/no, not an installed deck, purchase approval or planner promotion. Use a fresh UUID op_id for each new answer; reuse it unchanged to retry a failed request.",
        schema: || json!({"type":"object","properties":{"id":{"type":"string"},"op_id":{"type":"string"},"target":{"type":"string"},"decision":{"type":["string","null"]},"note":{"type":["string","null"]},"expected_version":{"type":"integer","minimum":0},"target_hash":{"type":"string"}},"required":["id","op_id","target","decision","note","expected_version","target_hash"],"additionalProperties":false}),
        kind: Kind::Write { destroys: false },
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_review_research),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_overview",
        aliases: &["overview"],
        title: "Your decks and deck plans",
        description: "Start here. This person's Yama account at a glance: how many decks, deck plans and saved notes they have, and the \
                      first few of each, with which note build each plan tracks and its plan key. A deck's configurations (other builds of \
                      it) are listed under that deck, not as decks of their own. The answer stays small on a large account: to list one \
                      kind in full, call again with section decks, plans or notes, limit rows at a time; the answer ends with \
                      next_cursor for the page after.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "section": {"type": "string", "enum": ["decks", "plans", "notes"], "description": "List this kind in full instead of the summary: decks (with ids and each configuration), plans (archived ones included) or notes (every note deck and its builds)."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "With section: how many rows to list. A row is a deck or one of its configurations, a plan, or a note's deck. Default 40 (15 for notes); at most 100 (40 for notes)."},
                    "cursor": {"type": "string", "maxLength": 200, "description": "With section: next_cursor from the page before, to continue it."},
                },
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_overview),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_deck",
        aliases: &["deck"],
        title: "One deck",
        description: "One of their Yama decks: the current list, the bracket they declared, Commander legality problems \
                      (size, singleton, color identity, banned cards), Game Changers and real game results. \
                      Give the deck's name (as `get_overview` lists it) or its id.",
        schema: || obj(&[("deck", "string", "The deck's name or id.")], &["deck"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_deck),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_plan",
        aliases: &["plan_deck"],
        title: "One deck plan",
        description: "One deck plan: the stock list and the now and after lists as differences, every planned and \
                      proposed swap with its reasons and their review answers, whether each planned swap is installed \
                      (read from their Yama deck's current list when the plan has one), their shopping rules, the newest \
                      paired lab run, and real games. Give the plan key from `get_overview`. A note deck that has no \
                      tracked build yet answers with its builds and how to track one.",
        schema: || obj(&[("key", "string", "The plan key, for example \"riders-of-rohan\".")], &["key"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_plan_deck),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("key", "plan")],
    },
    Tool {
        name: "get_shopping_trip",
        aliases: &["shopping_trip"],
        title: "Which stores to visit",
        description: "Plan a trip to their stores for the cards they want to buy: the fewest stores that cover the most \
                      cards under their local buy rule (the rule set in force that day), honoring their store preferences \
                      (a favourite to support is on every trip it has a card for; fine; maybe; won't go) and their order of how easy stores are to get to. Needed cards are the buys in their approved plans with no order \
                      yet (a plan waiting for their OK adds nothing); their real-card wishlist only comes along from stores \
                      already on the trip. Gives each store's cards, listed total and cart link (or card search links on a TCGplayer Pro store), the best choice with fewer stores, \
                      what to print instead and why, and the wishlist by price tier. Listings are dated quotes, not \
                      purchases; a missing price is unknown, never $0. Read yama://shopping/workflow before using research \
                      as a shopping list: arbitrary research builds and archived evidence are not automatically trip inputs. \
                      Compare exact build revisions and stock dates; provide listing/search links for an unapproved build preview without approving it.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "today": {"type": "string", "description": "Optional YYYY-MM-DD the trip is for; picks the rule set. Default: today (UTC)."},
                    "stores": {"type": "array", "items": {"type": "string"}, "description": "Optional store keys they're going to this time (see get_shopping_settings); the rest are left off. Default: every store they'll go to."},
                },
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_shopping_trip),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("today", "as_of")],
    },
    Tool {
        name: "get_shopping_settings",
        aliases: &["shopping_settings"],
        title: "Shopping rules and stores",
        description: "Their shopping rules and stores: the local buy rule in force today (and the dated rule set it comes from, \
                      made in Yama or imported), every dated rule set, the most they'll pay for a sealed precon, and each store's \
                      level (favourite to support, fine, maybe, won't go), its place in their order of how easy stores are to get \
                      to, and a favourite's premium. Use the store keys with get_shopping_trip and set_store_preference.",
        schema: || obj(&[], &[]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_shopping_settings),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "set_shopping_rules",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::set_shopping_rules),
        stages: Some(changes::staging::SET_SHOPPING_RULES),
        output: None,
        untrusted: None,
        renamed: &[("note", "reason")],
    },
    Tool {
        name: "set_store_preference",
        aliases: &[],
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
                    "store": {"type": "string", "description": "The store's key or name, from get_shopping_settings."},
                    "preference": {"type": "string", "enum": ["favorite", "ok", "maybe", "never"]},
                    "hassle": {"type": ["integer", "null"], "description": "Place in their order, 1 = easiest to get to; null clears it."},
                    "premium_usd": {"type": ["number", "null"], "description": "How much more a card may cost at a favourite, $0 to $10; null clears it."},
                    "note": {"type": "string"},
                },
                "required": ["store"],
                "additionalProperties": false,
            })
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::set_store_preference),
        stages: Some(changes::staging::SET_STORE_PREFERENCE),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_store_stock",
        aliases: &["store_stock"],
        title: "A store's stock",
        description: "One of their stores' newest stock answers for cards: each listing's price, condition, finish and \
                      quantity where the store gives them, or not in stock, with the time it was read. Default cards: every card \
                      the trip plans for. Listings are dated quotes from a snapshot (read when they asked, or imported), not \
                      proof the card is still there; a missing price is unknown.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "store": {"type": "string", "description": "The store's key or name, from get_shopping_settings."},
                    "cards": {"type": "array", "items": {"type": "string"}, "description": "Card names; default every card the trip plans for."},
                },
                "required": ["store"],
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_store_stock),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "check_stores",
        aliases: &[],
        title: "Read stores' stock",
        description: staged!(
            "Read their stores' stock now, when they apply it: Shopify stores Yama knows (Pat's Games, Mothership) card by \
             card, TCGplayer Pro storefronts (Black Castle, Multiverse) as a whole catalog with each product's lowest \
             price, and with yestcg true also YesTCG's Austin search (condition and quantity) for the stores it covers. \
             Each store's answer is a dated snapshot the trip and get_store_stock read. Default stores: every store they'll \
             go to that Yama can read; default cards: every card the trip plans for. For an unapproved research build, \
             supply its exact cards explicitly (at most 300 per check); saving research does not fetch live stock. \
             See yama://shopping/workflow."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "stores": {"type": "array", "items": {"type": "string"}, "description": "Store keys or names, from get_shopping_settings."},
                    "cards": {"type": "array", "items": {"type": "string"}, "description": "Card names, at most 300."},
                    "yestcg": {"type": "boolean", "description": "Also ask YesTCG (Austin) about the stores it covers."},
                },
                "additionalProperties": false,
            })
        },
        kind: Kind::StageOutside,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::check_stores),
        stages: Some(changes::staging::CHECK_STORES),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_shopping_list",
        aliases: &["shopping_list"],
        title: "Their shopping list",
        description: "Everything on their one shopping list and where the store trip puts each card: planned buys with no \
                      order yet, proposals they want or haven't decided on, cards and sealed products they added (add_wish), \
                      and a count of their real-card wishlist. Each card says the store and price the trip picks, or why it \
                      isn't on the trip (print it, ask the store, no check). Sealed products show each store's newest price \
                      against their sealed cap, the sealed market and the singles inside at market. Listings are dated quotes, \
                      not purchases.",
        schema: || obj(&[("today", "string", "Optional YYYY-MM-DD; picks the rule set. Default: today (UTC).")], &[]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_shopping_list),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("today", "as_of")],
    },
    Tool {
        name: "compare_with_friend",
        aliases: &[],
        title: "Compare with a friend's profile",
        description: "What they could trade with a friend on Yama, by the friend's profile handle: the cards on the friend's \
                      shared want list (\"looking for\") they own real copies of, with how many are in deck boxes, and the \
                      cards on their own shopping list in the friend's shared collection, with its printings and conditions. \
                      Only what the friend shares is read: a list or collection they haven't shared is reported as not \
                      shared. Market prices are dated, not offers.",
        schema: || obj(&[("handle", "string", "The friend's profile handle, with or without @ (yama.ing/u/<handle>).")], &["handle"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_compare_with_friend),
        stages: None,
        output: None,
        untrusted: Some("another person's shared profile"),
        renamed: &[],
    },
    Tool {
        name: "add_wish",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::add_wish),
        stages: Some(changes::staging::ADD_WISH),
        output: None,
        untrusted: None,
        renamed: &[("why", "reason")],
    },
    Tool {
        name: "get_review_queue",
        aliases: &["review_queue"],
        title: "Proposals to review",
        description: "Proposed swaps waiting for their answer: every plan deck's count of waiting and answered proposals, then the \
                      waiting ones with their reasons, 15 at a time, deck by deck. plan narrows it to one deck; answered true also \
                      lists the ones they answered, with their answers. The answer ends with next_cursor when there are more. A \
                      cursor counts from the start of the list: after a proposal is answered, start again without one.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "plan": {"type": "string", "maxLength": 300, "description": "Only this plan: its key or deck name from `get_overview`."},
                    "answered": {"type": "boolean", "description": "Also list the proposals they already answered (default false: only counted)."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Swaps to list (default 15)."},
                    "cursor": {"type": "string", "maxLength": 600, "description": "next_cursor from the page before, with the same plan and answered."},
                },
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_review_queue),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "search_cards",
        aliases: &["find_cards"],
        title: "Search cards",
        description: "Search Magic cards with Yama's Scryfall-style syntax: o:\"draw a card\", t:artifact, id<=rw \
                      (fits a Boros commander), mv<=3, f:commander (legal), is:gamechanger, -t:creature, or, \
                      parentheses, !\"Exact Name\". 60 cards at a time (next_cursor continues), each with cost, type, color \
                      identity, Commander legality, Game Changer, a dated market price (null when none is recorded) and how \
                      many copies they own.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "maxLength": 1000, "description": "The search, for example: id<=rw t:artifact o:treasure f:commander"},
                    "order": {"type": "string", "enum": ["name", "mv", "edhrec", "color"], "description": "name (default), mv (mana value), edhrec (most played first) or color."},
                    "page": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "The older way to continue: page number, from 1. cursor is preferred."},
                    "cursor": {"type": "string", "maxLength": 200, "description": "next_cursor from the answer before, with the same other arguments."},
                },
                "required": ["query"],
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: true,
        handler: run!(run_find_cards),
        stages: None,
        output: Some(registry::paged),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_cards",
        aliases: &["card"],
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
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: true,
        handler: run!(run_card),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("names", "cards")],
    },
    Tool {
        name: "get_price_history",
        aliases: &["price_history"],
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
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: true,
        handler: run!(run_price_history),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "check_deck_list",
        aliases: &["check_list"],
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
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_check_list),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "list_games",
        aliases: &["games"],
        title: "Your game history",
        description: "Games they played in person with Yama's life counter or online, newest first, as the Game history page lists \
                      them: 10 at a time (limit, up to 50), each with its seats (player, commander, final life, knockout turn), winner seat, \
                      turns, status and note; next_cursor continues the list. detail summary gives one short row a game. search matches a player's or commander's name; filter unfinished or unnamed finds games \
                      to tidy up. These are real games, unlike lab results. Use `get_game` for one game's events.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "A player's or commander's name, or part of one."},
                    "filter": {"type": "string", "enum": ["all", "unfinished", "unnamed"], "description": "unfinished: not finished; unnamed: a seat still called Player 2 or similar (default all)."},
                    "order": {"type": "string", "enum": ["newest", "oldest"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Games to list (default 10)."},
                    "offset": {"type": "integer", "minimum": 0, "description": "The older way to continue: games to skip. cursor is preferred."},
                    "cursor": {"type": "string", "maxLength": 200, "description": "next_cursor from the answer before, with the same other arguments."},
                    "detail": {"type": "string", "enum": ["summary", "full"], "description": "summary: fewer fields a row, for a shorter answer. full (default): every field."}
                },
                "additionalProperties": false
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_games),
        stages: None,
        output: Some(registry::paged),
        untrusted: Some("other players as well as the account owner (names, deck labels and notes)"),
        renamed: &[("search", "query")],
    },
    Tool {
        name: "get_game",
        aliases: &["game"],
        title: "One game",
        description: "One game from their history by id (from `list_games`): its seats, winner, turns and note, and with events=true its \
                      event log (life changes, knockouts and the like, up to 500 events). Someone else's game is not found.",
        schema: || obj(&[("id", "string", "The game's id."), ("events", "boolean", "Include the event log (default false).")], &["id"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_game),
        stages: None,
        output: Some(registry::object),
        untrusted: Some("other players as well as the account owner (names, deck labels and notes)"),
        renamed: &[],
    },
    Tool {
        name: "get_collection_summary",
        aliases: &["collection_summary"],
        title: "Collection totals and containers",
        description: "Their collection as the Collection page totals it: copies, proxies, distinct printings, market value of the \
                      copies with a price (with the newest price date), how many have none, and what they paid; then each binder, \
                      deck box and list with its copies and market value. Proxies have no market value. A missing price is \
                      unknown, never zero, and a market value isn't what a store would pay. Use list_collection_cards for the cards.",
        schema: no_args,
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_collection_summary),
        stages: None,
        output: Some(registry::object),
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "list_playgroups",
        aliases: &["playgroups"],
        title: "Your playgroups and their stats",
        description: "The playgroups they own or are in, with each one's members, as the Playgroup page lists them. With id, that \
                      group's stats from its finished games: games played, each player's and commander's record, average turns and \
                      minutes, wins by seat, win conditions and head-to-head. Small samples are marked provisional; these are real \
                      games, not simulations.",
        schema: || obj(&[("id", "string", "A playgroup's id, for its stats; omit to list playgroups.")], &[]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_playgroups),
        stages: None,
        output: Some(registry::object),
        untrusted: Some("other players as well as the account owner (names)"),
        renamed: &[],
    },
    Tool {
        name: "list_lab_runs",
        aliases: &["lab_runs"],
        title: "Your lab experiments",
        description: "Their simulation experiments (\"Try a change\"), newest first, with ids for `get_lab_run`.",
        schema: no_args,
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_lab_runs),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "get_lab_run",
        aliases: &["lab_run"],
        title: "One lab experiment",
        description: "One simulation experiment: its lists, opponents, engines and limits, live progress, and each engine's result: the \
                      paired difference with its interval and verdict, the games that weren't scored and why, and how many \
                      pods would likely settle an unclear answer. Admins also see the number of earlier Phase games ahead \
                      in the shared queue. For runs using both engines, the ETA and queue position are Phase-only; Forge \
                      is queued separately. Other accounts' run and deck details stay private.",
        schema: || obj(&[("id", "string", "The experiment id from `list_lab_runs`.")], &["id"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_lab_run),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("id", "run_id")],
    },
    Tool {
        name: "list_lab_games",
        aliases: &["lab_games"],
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
                    "id": {"type": "string", "description": "The experiment id from `list_lab_runs`."},
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
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_lab_games),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[("id", "run_id")],
    },
    Tool {
        name: "get_precon",
        aliases: &["precon"],
        title: "A precon",
        description: "A Commander precon from Yama's catalog: list, real results from playgroup.gg with their dated history (all-time rate, approximate recent rate between snapshots and trend, or the commander's own figure when the list isn't rated; evidence.all_lists adds Mythic Tools' wins over every list under the exact commanders, which count toward rating v2 only for a precon without stock games that passed the leave-one-out test), the simulated rating and matchups, and source-backed upgradeability assessments with the 1–5 rubric, concrete card examples, named reviews and separately scoped raw commander wins/game counts. Commander configurations have separate grades and comparison-list URLs. On-theme swaps are eligible; replacing the strategy is a separate build. Use each prepared list separately when comparing commanders. Unsupported grades are null. Commander rates mix stock and modified lists; do not infer upgrade gains from them. \
                      Give its name (or part of it) or id.",
        schema: || obj(&[("precon", "string", "The precon's name, part of it, or its id.")], &["precon"]),
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_precon),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "list_changes",
        aliases: &["changes"],
        title: "Changes waiting for review",
        description: "The changes you (or another Claude) staged that they haven't applied or discarded yet, with ids, newest first, \
                      25 at a time (next_cursor continues; after a change is applied or discarded, start again without a cursor). A \
                      long summary is cut in the list: id gives one change whole, with its details and status, which is the way to \
                      check exactly what apply_change would apply. Check here before staging the same change twice.",
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "maxLength": 300, "description": "One change's id, for that change whole instead of the list."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Changes to list (default 25)."},
                    "cursor": {"type": "string", "maxLength": 200, "description": "next_cursor from the page before."},
                },
                "additionalProperties": false,
            })
        },
        kind: Kind::Read,
        offer: Offer::Everyone,
        search: false,
        handler: run!(run_changes),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "edit_deck",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::edit_deck),
        stages: Some(changes::staging::EDIT_DECK),
        output: None,
        untrusted: None,
        renamed: &[("note", "reason")],
    },
    Tool {
        name: "delete_deck",
        aliases: &[],
        title: "Delete a deck or configuration",
        description: staged!(
            "Delete one of their Yama decks, or one configuration of a deck (name the configuration's own deck). \
             It leaves their decks and its share link stops working; games already played with it keep their record. \
             A main deck's configurations become decks of their own unless configurations is true, which deletes them too. \
             It can't be undone from Yama, so only stage it when they asked to delete that deck."
        ),
        schema: || {
            json!({
                "type": "object",
                "properties": {
                    "deck": {"type": "string", "description": "The deck's (or configuration's) name or id."},
                    "configurations": {"type": "boolean", "description": "For a main deck: delete its configurations too (default false: they become decks of their own)."},
                },
                "required": ["deck"],
                "additionalProperties": false,
            })
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::delete_deck),
        stages: Some(changes::staging::DELETE_DECK),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "track_build",
        aliases: &[],
        title: "Make a note's build the deck's plan",
        description: staged!(
            "Use one build of a deck in one of their saved notes as that deck's plan: its swaps become a plan version \
             waiting for their OK (\"Use a deck from it\" on the plan pages). Once they approve it (in Yama, or \
             `approve_plan`), Buy, prints, installed and bought marks and the plan tools (get_plan, mark_bought, \
             mark_installed, swap_in_prints) work on it, and it replaces any other plan for the same deck. Another build \
             of the same deck switches to it; build null stops it. Give the note id and deck key from `get_overview` or `get_research`."
        ),
        schema: || {
            json!({"type":"object","properties":{
                "note":{"type":"string","description":"The note's id."},
                "deck":{"type":"string","description":"The deck's key in the note."},
                "build":{"type":["string","null"],"description":"The build's id; null to stop tracking this deck."},
                "yama_deck":{"type":"string","description":"Optional: the Yama deck (name or id) the plan is for. Default: the one already linked, else their only deck with the note deck's name."}
            },"required":["note","deck","build"],"additionalProperties":false})
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::track_build),
        stages: Some(changes::staging::TRACK_BUILD),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "approve_plan",
        aliases: &[],
        title: "Approve a deck's plan",
        description: staged!(
            "Approve a deck's plan version whole, as the plan page's Approve plan does: every change waiting in it goes into \
             the plan except the ones in skip, and the open questions get_plan lists need their answers first. Only stage \
             it when they have said to. action keep instead keeps the version before it (for a new version of a plan in \
             progress). Nothing is bought or printed by approving: buys go on their shopping list and prints on the next \
             print order."
        ),
        schema: || {
            json!({"type":"object","properties":{
                "plan":{"type":"string","description":"The plan key or deck name from `get_overview`."},
                "action":{"type":"string","enum":["approve","keep"],"description":"approve (default) or keep the version before it."},
                "skip":{"type":"array","items":{"type":"string"},"description":"Changes to leave out: a card name skips every change putting that card in; a swap key skips just that one."},
                "answers":{"type":"array","items":{"type":"object","properties":{"question":{"type":"string","maxLength":2000},"answer":{"type":"string","maxLength":2000}},"required":["question","answer"],"additionalProperties":false},
                           "description":"Their answer to each open question, the question exactly as get_plan lists it."}
            },"required":["plan"],"additionalProperties":false})
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::approve_plan),
        stages: Some(changes::staging::APPROVE_PLAN),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "propose_swap",
        aliases: &[],
        title: "Suggest a swap for a plan",
        description: staged!(
            "Suggest a swap for one of their upgrade plans: a card to put in and, usually, the card it replaces. \
             Applying saves it as an idea in the plan, where it goes through their usual review."
        ),
        schema: || {
            obj(
                &[
                    ("plan", "string", "The plan key or deck name from `get_overview`."),
                    ("card_in", "string", "The card to put in."),
                    ("card_out", "string", "The card it replaces, if any."),
                    ("why", "string", "Why, in a sentence or two."),
                ],
                &["plan", "card_in"],
            )
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::propose_swap),
        stages: Some(changes::staging::PROPOSE_SWAP),
        output: None,
        untrusted: None,
        renamed: &[("why", "reason")],
    },
    Tool {
        name: "answer_review",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::answer_review),
        stages: Some(changes::staging::ANSWER_REVIEW),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "mark_bought",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::mark_bought),
        stages: Some(changes::staging::MARK_BOUGHT),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "swap_in_prints",
        aliases: &[],
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
                "properties": {"plan": {"type": "string", "description": "The plan key or deck name from `get_overview`."}},
                "required": ["plan"],
                "additionalProperties": false,
            })
        },
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::swap_in_prints),
        stages: Some(changes::staging::SWAP_IN_PRINTS),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "mark_installed",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::mark_installed),
        stages: Some(changes::staging::MARK_INSTALLED),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "start_lab_run",
        aliases: &[],
        title: "Start a lab run",
        description: staged!(
            "Simulate in the lab, under their lab allowance; results come in over the next while (see get_lab_run). Modes: \
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
        kind: Kind::Stage,
        offer: Offer::Power,
        search: false,
        handler: stage!(changes::start_lab_run),
        stages: Some(changes::staging::START_LAB_RUN),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "add_lab_games",
        aliases: &["more_lab_games"],
        title: "Add games to a lab run",
        description: staged!(
            "Add games to one of their finished runs (not versus) so its answer gets clearer: the new pods continue the \
             run's schedule and pool with the results so far, on each of its engines. Without `games`, enough to reach \
             the run's estimate of the pods that would settle it, where it has one. A run whose engine has changed since \
             can't take more games; use rerun_lab_run."
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
        kind: Kind::Stage,
        offer: Offer::Power,
        search: false,
        handler: stage!(changes::more_lab_games),
        stages: Some(changes::staging::MORE_LAB_GAMES),
        output: None,
        untrusted: None,
        renamed: &[("id", "run_id")],
    },
    Tool {
        name: "rerun_lab_run",
        aliases: &["run_lab_again"],
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
        kind: Kind::Stage,
        offer: Offer::Power,
        search: false,
        handler: stage!(changes::run_lab_again),
        stages: Some(changes::staging::RUN_LAB_AGAIN),
        output: None,
        untrusted: None,
        renamed: &[("id", "run_id")],
    },
    Tool {
        name: "cancel_lab_run",
        aliases: &[],
        title: "Cancel a lab run",
        description: staged!("Stop one of their queued or running experiments: games already playing finish and count, no new ones start."),
        schema: || obj(&[("id", "string", "The experiment id.")], &["id"]),
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::cancel_lab_run),
        stages: Some(changes::staging::CANCEL_LAB_RUN),
        output: None,
        untrusted: None,
        renamed: &[("id", "run_id")],
    },
    Tool {
        name: "add_to_collection",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::add_to_collection),
        stages: Some(changes::staging::ADD_TO_COLLECTION),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "move_cards",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::move_cards),
        stages: Some(changes::staging::MOVE_CARDS),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "set_condition",
        aliases: &[],
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
        kind: Kind::Stage,
        offer: Offer::Everyone,
        search: false,
        handler: stage!(changes::set_condition),
        stages: Some(changes::staging::SET_CONDITION),
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "apply_change",
        aliases: &[],
        title: "Apply a staged change",
        description: "Apply one staged change. Call it only after they have said yes to that exact change in this conversation; \
                      otherwise let them apply it in Yama. If the deck or plan moved on, it fails with the reason and stays waiting.",
        schema: || obj(&[("id", "string", "The change id from staging or `list_changes`.")], &["id"]),
        kind: Kind::Write { destroys: true },
        offer: Offer::Appliers,
        search: false,
        handler: run!(run_apply_change),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
    },
    Tool {
        name: "discard_change",
        aliases: &[],
        title: "Discard a staged change",
        description: "Discard one staged change, when they say no to it or you staged it by mistake.",
        schema: || obj(&[("id", "string", "The change id.")], &["id"]),
        kind: Kind::Write { destroys: true },
        offer: Offer::Appliers,
        search: false,
        handler: run!(run_discard_change),
        stages: None,
        output: None,
        untrusted: None,
        renamed: &[],
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

/// `tools/list` for this caller (`registry::list`).
pub fn list(user: &User, via: &Via) -> Vec<Value> {
    registry::list(user, via)
}

/// Whether this caller may call the tool, by its name or an older name.
pub fn offered(name: &str, user: &User, via: &Via) -> bool {
    registry::find(name).is_some_and(|t| registry::offered_to(t, user, via))
}

/// `tools/call` (`registry::call`).
pub async fn call(st: &AppState, user: &User, via: &Via, name: &str, args: &Value) -> AppResult<String> {
    registry::call(st, user, via, name, args).await
}

// ── handlers: one per tool that isn't a staged write (those are in `changes.rs`) ─────────────

#[allow(unused_variables)]
async fn run_datasets(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    Ok(serde_json::to_string(&crate::datasets::list(pool,&user.id).await?).map_err(anyhow::Error::from)?)
}

#[allow(unused_variables)]
async fn run_dataset(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let mut query=args.as_object().cloned().ok_or_else(||AppError::bad("arguments must be an object"))?;
            let id=query.remove("id").and_then(|v|v.as_str().map(str::to_owned)).filter(|s|!s.is_empty()).ok_or_else(||AppError::bad("id is required"))?;
            // A cursor continues one read; the older offset argument still works.
            let part = |k: &str| query.get(k).map(|v| v.to_string()).unwrap_or_default();
            let scope = super::page::scope("dataset", &[&id, &part("revision"), &part("section"), &part("kind"), &part("entity"), &part("search")]);
            let older = query.get("offset").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
            let offset = super::page::start(args, &scope, older)?;
            query.remove("cursor");
            query.insert("offset".into(), json!(offset));
            let q:crate::datasets::ReadQuery=serde_json::from_value(Value::Object(query)).map_err(|e|AppError::bad(format!("invalid dataset query: {e}")))?;
            let mut out = crate::datasets::read(pool,&user.id,&id,q).await?;
            if let Some(next) = out["next_offset"].as_u64().and_then(|n| usize::try_from(n).ok()) {
                out["next_cursor"] = json!(super::page::cursor(&scope, next));
            }
            Ok(out.to_string())
        }
}

#[allow(unused_variables)]
async fn run_save_research(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let document = args.get("document").ok_or_else(|| AppError::bad("Missing document."))?;
            let stop_plans = match args.get("stop_plans") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return Err(AppError::bad("stop_plans must be true or false")),
            };
            // Ask Claude can't apply a change, so it can't archive a plan this way either.
            if stop_plans && !via.may_apply() {
                return Err(AppError::bad("stop_plans isn't available here: they can archive a plan on its page in Yama. Nothing was saved."));
            }
            Ok(crate::deck_research::save_guarded(pool, &user.id, document, stop_plans).await?.to_string())
        }
}

#[allow(unused_variables)]
async fn run_review_research(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let id=arg::text(args,"id")?;
            let op:crate::deck_research::ReviewOp=serde_json::from_value(args.clone()).map_err(|e|AppError::bad(format!("Invalid research review: {e}")))?;
            Ok(serde_json::to_string(&crate::deck_research::review(pool,&user.id,id,&op).await?).map_err(anyhow::Error::from)?)
        }
}

#[allow(unused_variables)]
async fn run_research(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
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
            } else if args.get("full").and_then(Value::as_bool)!=Some(true) && !matches!(arg::opt_text(args, "detail", 20)?, Some("full")) {
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
}

#[allow(unused_variables)]
async fn run_changes(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    changes_text(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_apply_change(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let c = changes::apply(st, user, arg::text(args, "id")?).await?;
            match (c.status.as_str(), c.error) {
                ("applied", _) => Ok(format!("Applied: {}. {}", c.summary, c.result.and_then(|r| r["label"].as_str().map(String::from)).unwrap_or_default())),
                (_, Some(e)) => Err(AppError::Conflict(format!("Not applied: {e}"))),
                (status, None) => Err(AppError::Conflict(format!("Not applied; the change is {status}."))),
            }
        }
}

#[allow(unused_variables)]
async fn run_discard_change(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let c = changes::discard(pool, &user.id, arg::text(args, "id")?).await?;
            Ok(format!("Discarded: {}", c.summary))
        }
}

#[allow(unused_variables)]
async fn run_overview(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    super::overview::overview(pool, &user.id, args).await
}

#[allow(unused_variables)]
async fn run_deck(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    deck(pool, user, arg::text(args, "deck")?).await
}

#[allow(unused_variables)]
async fn run_plan_deck(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let key = arg::text(args, "key")?;
            match context::build(pool, user, "plan_deck", Some(key)).await {
                // A note deck with no tracked build yet is still a deck plan: say what it has.
                Err(AppError::NotFound(_)) => {
                    let text = super::overview::untracked_note_deck(pool, &user.id, key).await?;
                    if text.is_empty() { Err(AppError::NotFound("plan deck")) } else { Ok(text) }
                }
                other => other,
            }
        }
}

#[allow(unused_variables)]
async fn run_review_queue(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    review_queue(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_shopping_trip(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
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
}

#[allow(unused_variables)]
async fn run_shopping_settings(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let bundle = crate::plan::bundle::load_bundle(pool, &user.id).await?;
            Ok(crate::plan::shopping::settings_text(&bundle, &chrono::Utc::now().format("%Y-%m-%d").to_string()))
        }
}

#[allow(unused_variables)]
async fn run_shopping_list(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
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
}

#[allow(unused_variables)]
async fn run_compare_with_friend(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let handle = arg::text(args, "handle")?;
            Ok(crate::sharing::wants::text(&crate::sharing::wants::compare(pool, &user.id, &handle).await?))
        }
}

#[allow(unused_variables)]
async fn run_store_stock(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            let (key, name) = changes::their_store(pool, &user.id, arg::text(args, "store")?).await?;
            let cards: Vec<String> = match args.get("cards").filter(|v| !v.is_null()) {
                Some(v) => v
                    .as_array()
                    .and_then(|a| a.iter().map(|x| x.as_str().map(|s| s.trim().to_string())).collect::<Option<Vec<_>>>())
                    .filter(|c| c.len() <= crate::plan::stock::MAX_CARDS)
                    .ok_or_else(|| AppError::bad("cards must be a list of at most 300 card names"))?,
                None => crate::plan::stock::trip_cards(&crate::plan::bundle::load_bundle(pool, &user.id).await?),
            };
            crate::plan::stock::stock_text(pool, &user.id, &key, &name, &cards).await
        }
}

#[allow(unused_variables)]
async fn run_find_cards(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            find_cards(pool, user, args).await
        }
}

#[allow(unused_variables)]
async fn run_card(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            card(pool, user, args).await
        }
}

#[allow(unused_variables)]
async fn run_price_history(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    {
            price_history(pool, args).await
        }
}

#[allow(unused_variables)]
async fn run_check_list(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    check_list(pool, args).await
}

#[allow(unused_variables)]
async fn run_collection_summary(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    collection_summary(pool, user).await
}

#[allow(unused_variables)]
async fn run_playgroups(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    playgroups(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_games(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    games(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_game(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    game(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_lab_runs(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    lab_runs(pool, user).await
}

#[allow(unused_variables)]
async fn run_lab_run(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    context::build(pool, user, "experiment", Some(arg::text(args, "id")?)).await
}

#[allow(unused_variables)]
async fn run_lab_games(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    lab_games(pool, user, args).await
}

#[allow(unused_variables)]
async fn run_precon(c: Ctx<'_>, args: &Value) -> AppResult<String> {
    let Ctx { st, user, via } = c;
    let pool = &st.pool;
    let _ = via;
    precon(pool, user, arg::text(args, "precon")?).await
}

/// The printing a `get_price_history` call names: (Scryfall id, name, set code, collector number).
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
            // As `get_cards` picks it: playable printings only.
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

/// A printing's market price over time (the `get_price_history` tool): change points, not every day.
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
    Ok(serde_json::to_string(&out).map_err(anyhow::Error::from)?)
}

fn price(usd: Option<f64>, date: Option<&str>) -> String {
    match (usd, date) {
        (Some(p), Some(d)) => format!("${p:.2} market ({d})"),
        (Some(p), None) => format!("${p:.2} market"),
        _ => "price unknown".into(),
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

/// Legality, Game Changers and Reserve List cards for a list, as lines.
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
    for p in &v.prerelease {
        let _ = writeln!(out, "Prerelease: {p}");
    }
    match crate::decks::game_changers(cards, info) {
        Some(g) if g.is_empty() => out.push_str("Game Changers: none.\n"),
        Some(g) => {
            let _ = writeln!(out, "Game Changers ({}): {}", g.len(), g.join(", "));
        }
        None => out.push_str("Game Changers: unknown (the list isn't loaded for every card).\n"),
    }
    match crate::decks::reserved_list(cards, info) {
        Some(r) if r.is_empty() => out.push_str("Reserve List cards: none.\n"),
        Some(r) => {
            let _ = writeln!(out, "Reserve List cards ({}): {}", r.len(), r.join(", "));
        }
        None => out.push_str("Reserve List cards: unknown (the flag isn't loaded for every card).\n"),
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

/// One card of a search as data. A price that isn't recorded is null, never 0, beside the date
/// Yama read it and found none (null too when the printing was never read).
fn search_row(c: &SearchCard) -> Value {
    let card = &c.card;
    json!({
        "name": card.name,
        "mana_cost": card.mana_cost,
        "type_line": card.type_line,
        "color_identity": card.color_identity,
        "commander": card.legalities.get("commander"),
        "game_changer": card.game_changer,
        "price_usd": c.usd,
        "price_date": c.price_date,
        "owned": c.owned,
        "owned_in": c.owned_in,
    })
}

async fn find_cards(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let query = arg::text_max(args, "query", 1000)?;
    let order = arg::opt_text(args, "order", 20)?;
    // "cmc" is Scryfall's word for mv and has always been taken.
    if let Some(o) = order.filter(|o| !["name", "mv", "cmc", "edhrec", "color"].contains(o)) {
        return Err(AppError::bad(format!("order: \"{o}\" isn't name, mv, edhrec or color")));
    }
    // The search pages by sixty. A cursor continues one search; the older page argument still
    // works, and out of range it is the nearest page, as it always was (a page 0 is an easy slip).
    const PAGE: usize = 60;
    let scope = super::page::scope("find_cards", &[query, order.unwrap_or("name")]);
    let older = (args.get("page").and_then(Value::as_u64).unwrap_or(1).clamp(1, 1000) as usize - 1) * PAGE;
    let page = u32::try_from(super::page::start(args, &scope, older)? / PAGE + 1).ok().filter(|p| *p <= 1000).ok_or_else(|| AppError::bad("cursor is out of range"))?;
    let r = crate::cards::search(pool, &user.id, query, order, page).await?;
    let shown = (r.page as usize - 1) * r.page_size as usize + r.cards.len();
    let more = usize::try_from(r.total).is_ok_and(|total| shown < total) && !r.cards.is_empty();
    let out = json!({
        "query": query,
        "total": r.total,
        "cards": r.cards.iter().map(search_row).collect::<Vec<_>>(),
        "next_cursor": more.then(|| super::page::cursor(&scope, shown)),
        "note": "price_usd is a market reference dated by price_date, not a store quote. A null price is unknown, never zero; a date beside it is the day Yama read the price and found none. commander is Scryfall's Commander legality as of Yama's last card import. owned counts their copies.",
    });
    Ok(out.to_string())
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
            None => out.push_str("Price: unknown (none recorded)\n"),
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
        let _ = writeln!(out, "- {} ({status}, {done} of {total} games, made {}) id {id}", clip(&name, 120), created.get(..10).unwrap_or(&created));
    }
    Ok(out)
}

/// The Collection page's totals and container tiles, without the tiles' art.
async fn collection_summary(pool: &SqlitePool, user: &User) -> AppResult<String> {
    let summary = crate::collection::summary_for(pool, &user.id).await?;
    let mut containers = serde_json::to_value(crate::collection::containers_for(pool, &user.id).await?).map_err(anyhow::Error::from)?;
    for c in containers.as_array_mut().into_iter().flatten() {
        if let Some(o) = c.as_object_mut() {
            o.remove("art");
            o.remove("artist");
        }
    }
    let out = json!({
        "totals": summary,
        "containers": containers,
        "note": "Market values are dated market references, not store or buylist offers. Loose copies are in no container.",
    });
    Ok(out.to_string())
}

/// Takes account and member ids out of a games or stats answer before it goes to an assistant: it
/// gets names, never the ids behind other people. Stats keys (`u:<account>`, `m:<member>`) become
/// `you` or `player-N`, the same alias everywhere in one answer, so head-to-head still lines up.
fn without_people_ids(v: &mut Value, me: &str) {
    fn walk(v: &mut Value, me: &str, aliases: &mut HashMap<String, String>) {
        match v {
            Value::Object(o) => {
                for k in ["user_id", "member_id", "owner_id", "created_by", "deck_version_id"] {
                    o.remove(k);
                }
                for (k, x) in o.iter_mut() {
                    if let ("key" | "a" | "b", Value::String(id)) = (k.as_str(), &*x) {
                        if id.starts_with("u:") || id.starts_with("m:") {
                            let alias = if id.strip_prefix("u:") == Some(me) {
                                "you".to_string()
                            } else {
                                let n = aliases.len() + 1;
                                aliases.entry(id.clone()).or_insert_with(|| format!("player-{n}")).clone()
                            };
                            *x = Value::String(alias);
                            continue;
                        }
                    }
                    walk(x, me, aliases);
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, me, aliases)),
            _ => {}
        }
    }
    walk(v, me, &mut HashMap::new());
}

/// Drops every null field, for a list whose rows are mostly empty optional fields.
fn without_nulls(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.retain(|_, x| !x.is_null());
            o.values_mut().for_each(without_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(without_nulls),
        _ => {}
    }
}

/// The Playgroup page: the groups, or one group's stats. Join codes and account ids stay out: an
/// assistant has no use for them, and a join code lets anyone in.
async fn playgroups(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let id = args.get("id").and_then(Value::as_str).map(str::trim).filter(|i| !i.is_empty());
    let out = match id {
        Some(id) => {
            let mut stats = serde_json::to_value(crate::playgroups::stats_for(pool, &user.id, id).await?).map_err(anyhow::Error::from)?;
            without_people_ids(&mut stats, &user.id);
            stats
        }
        None => {
            let mut groups = serde_json::to_value(crate::playgroups::groups_for(pool, &user.id).await?).map_err(anyhow::Error::from)?;
            for g in groups.as_array_mut().into_iter().flatten() {
                let Some(o) = g.as_object_mut() else { continue };
                o.remove("join_code");
                let owner = o.remove("owner_id");
                o.insert("yours".into(), json!(owner.as_ref().and_then(Value::as_str) == Some(user.id.as_str())));
                for m in o.get_mut("members").and_then(Value::as_array_mut).into_iter().flatten() {
                    if let Some(m) = m.as_object_mut() {
                        let is_you = m.get("user_id").and_then(Value::as_str) == Some(user.id.as_str());
                        let guest = m.get("user_id").is_none_or(Value::is_null);
                        m.remove("id");
                        m.remove("user_id");
                        m.remove("guest_name");
                        m.insert("guest".into(), json!(guest));
                        if is_you {
                            m.insert("you".into(), json!(true));
                        }
                    }
                }
            }
            groups
        }
    };
    Ok(serde_json::to_string(&out).map_err(anyhow::Error::from)?)
}

/// Games one `list_games` answer lists unless `limit` asks for more (the page itself holds 50).
const GAMES_PAGE: usize = 10;

/// The Game history page's list (`games::history_page`), same search and filter.
async fn games(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    use crate::games::{HistoryFilter, HistoryOrder, HistoryParams};
    let word = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty());
    let filter = match word("filter") {
        None | Some("all") => HistoryFilter::All,
        Some("unfinished") => HistoryFilter::Unfinished,
        Some("unnamed") => HistoryFilter::Unnamed,
        Some(_) => return Err(AppError::bad("filter is all, unfinished or unnamed")),
    };
    let order = match word("order") {
        None | Some("newest") => HistoryOrder::Newest,
        Some("oldest") => HistoryOrder::Oldest,
        Some(_) => return Err(AppError::bad("order is newest or oldest")),
    };
    let offset = match args.get("offset") {
        None | Some(Value::Null) => 0,
        Some(v) => v.as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(|| AppError::bad("offset is a whole number"))?,
    };
    let limit = match args.get("limit") {
        None | Some(Value::Null) => GAMES_PAGE,
        Some(v) => v.as_u64().filter(|n| (1..=50).contains(n)).ok_or_else(|| AppError::bad("limit is a whole number from 1 to 50"))? as usize,
    };
    let q = word("search").unwrap_or("").to_string();
    // A cursor continues one search; the older offset argument still works.
    let scope = super::page::scope("games", &[word("filter").unwrap_or("all"), word("order").unwrap_or("newest"), &q]);
    let offset = u32::try_from(super::page::start(args, &scope, offset as usize)?).map_err(|_| AppError::bad("cursor is out of range"))?;
    let summary = arg::summary(args)?;
    let page = crate::games::history_page(pool, &user.id, HistoryParams { filter, order, q, offset }).await?;
    // The page holds up to 50 games; a smaller limit hands out part of it and says where to go on.
    let more = page.has_more || page.games.len() > limit;
    let mut out = serde_json::to_value(&page).map_err(anyhow::Error::from)?;
    without_people_ids(&mut out, &user.id);
    if let Some(games) = out["games"].as_array_mut() {
        games.truncate(limit);
    }
    // A seat or a game says only what was recorded: an absent field is one nobody filled in.
    without_nulls(&mut out);
    // A guest's name is already the seat's display name.
    for game in out["games"].as_array_mut().into_iter().flatten() {
        for seat in game["seats"].as_array_mut().into_iter().flatten() {
            if let Some(seat) = seat.as_object_mut() {
                if seat.get("guest_name").is_some() && seat.get("guest_name") == seat.get("display_name") {
                    seat.remove("guest_name");
                }
            }
        }
    }
    if summary {
        // One short row a game: when, how it ended, who won and who played what.
        for game in out["games"].as_array_mut().into_iter().flatten() {
            let seats = game["seats"].as_array().cloned().unwrap_or_default();
            let name = |seat: &Value| seat["display_name"].as_str().unwrap_or("?").to_string();
            let winner = game["winner_seat"].as_i64().and_then(|w| seats.iter().find(|s| s["seat"].as_i64() == Some(w))).map(name);
            let players: Vec<String> = seats.iter().map(|s| match s["commander_name"].as_str() {
                Some(commander) => format!("{} ({commander})", name(s)),
                None => name(s),
            }).collect();
            *game = json!({"id": game["id"], "started_at": game["started_at"], "status": game["status"], "turns": game["turns"], "winner": winner, "players": players});
        }
        without_nulls(&mut out);
    }
    // A page of full rows that would be too long is a shorter page; the cursor says where it stopped.
    let mut rows = out["games"].take().as_array().cloned().unwrap_or_default();
    let more = super::page::fit(&mut rows, super::page::PAGE_BUDGET) || more;
    let listed = rows.len();
    out["games"] = Value::Array(rows);
    out["has_more"] = json!(more);
    if more {
        out["next_offset"] = json!(u64::from(offset) + listed as u64);
        out["next_cursor"] = json!(super::page::cursor(&scope, offset as usize + listed));
    }
    if page.games.is_empty() {
        out["note"] = json!("No games match. Games logged on a phone that hasn't synced yet aren't here.");
    }
    Ok(out.to_string())
}

/// One game as its page shows it (`games::game_detail`); the event log only when asked.
async fn game(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    const MAX_EVENTS: usize = 500;
    let id = arg::text(args, "id")?;
    let detail = crate::games::game_detail(pool, &user.id, id).await?;
    let mut out = serde_json::to_value(&detail).map_err(anyhow::Error::from)?;
    without_people_ids(&mut out, &user.id);
    if let Some(o) = out.as_object_mut() {
        let events = o.remove("events").and_then(|e| if let Value::Array(a) = e { Some(a) } else { None }).unwrap_or_default();
        o.insert("event_count".into(), json!(events.len()));
        if args.get("events").and_then(Value::as_bool).unwrap_or(false) {
            if events.len() > MAX_EVENTS {
                o.insert("events_note".into(), json!(format!("Only the first {MAX_EVENTS} of {} events.", events.len())));
            }
            o.insert("events".into(), Value::Array(events.into_iter().take(MAX_EVENTS).collect()));
        }
    }
    Ok(serde_json::to_string(&out).map_err(anyhow::Error::from)?)
}

/// An experiment's games pod by pod on one engine, or one game in full (`game`).
async fn lab_games(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    use crate::lab::experiments::{GameView, pods_for};
    let id = arg::text(args, "id")?;
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

/// Changes one `list_changes` answer lists unless `limit` asks for more.
const CHANGES_PAGE: usize = 25;

/// The longest a change's summary is in the list, and its details when it is read whole.
const CHANGE_SUMMARY: usize = 400;
const CHANGE_DETAIL: usize = 12_000;

async fn changes_text(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    if args.get("id").is_some_and(|id| !id.is_null()) {
        // One change whole: the list cuts a long summary, and applying needs the exact change.
        let c = changes::one(pool, &user.id, arg::text(args, "id")?).await?;
        let mut out = format!("Change {} ({}, staged {}): {}\n", c.id, c.status, c.created_at.get(..10).unwrap_or(&c.created_at), c.summary);
        if let Some(d) = c.detail.as_deref().filter(|d| !d.trim().is_empty()) {
            let _ = writeln!(out, "{}", clip(d.trim(), CHANGE_DETAIL));
        }
        if let Some(e) = &c.error {
            let _ = writeln!(out, "The last try to apply it failed: {e}");
        }
        return Ok(out);
    }
    let page = super::page::page(args, "changes", CHANGES_PAGE, changes::MAX_PENDING as usize)?;
    let waiting = changes::list(pool, &user.id, true, None).await?;
    if waiting.is_empty() {
        return Ok("No changes are waiting for their review.".into());
    }
    let mut out = format!("{} change{} waiting for their review, newest first:\n", waiting.len(), if waiting.len() == 1 { " is" } else { "s are" });
    for c in waiting.iter().skip(page.offset).take(page.limit) {
        let cut = if c.summary.chars().count() > CHANGE_SUMMARY { "; cut here, `list_changes` with this id shows it whole" } else { "" };
        let _ = write!(out, "- {} (id {}, staged {}{cut}", clip(&c.summary, CHANGE_SUMMARY), c.id, c.created_at.get(..10).unwrap_or(&c.created_at));
        if let Some(e) = &c.error {
            let _ = write!(out, "; the last try to apply it failed: {}", clip(e, 240));
        }
        out.push_str(")\n");
    }
    if let Some(next) = page.next("changes", waiting.len()) {
        let _ = writeln!(out, "next_cursor: {next}");
    }
    Ok(out)
}

/// The Review queue (`advisor::context::review_page`): counts for every plan deck, then a page of
/// the swaps waiting for an answer.
async fn review_queue(pool: &SqlitePool, user: &User, args: &Value) -> AppResult<String> {
    let key = match args.get("plan").filter(|v| !v.is_null()) {
        None => None,
        Some(_) => Some(changes::plan_deck(pool, &user.id, arg::text(args, "plan")?).await?.0),
    };
    let answered = match args.get("answered") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(AppError::bad("answered must be true or false")),
    };
    // A cursor belongs to one listing: the same plan, with or without the answered ones.
    let scope = format!("review_queue.{}.{answered}", key.as_deref().unwrap_or(""));
    let page = super::page::page(args, &scope, REVIEW_PAGE, 100)?;
    let (mut out, total) = context::review_page(pool, &user.id, key.as_deref(), answered, page.offset, page.limit).await?;
    if let Some(next) = page.next(&scope, total) {
        let _ = writeln!(out, "\nnext_cursor: {next}");
    }
    Ok(out)
}

/// Swaps one `get_review_queue` answer lists unless `limit` asks for more.
const REVIEW_PAGE: usize = 15;

/// Text people typed, cut to `max` characters for a list line.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}
