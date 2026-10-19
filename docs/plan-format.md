# The plan file: `yama-plan/1`

A plan file carries one person's deck plans into Yama: their plan decks and the lists for each, swaps and proposals, orders, store checks, stores, shopping rules and review answers. Two programs write it:

- Bryan's commander-decks repo, through `scripts/planner/export.py` (slice 2). Decks from it are **imported**: the repo owns them and Yama shows them read-only.
- Yama itself, through `GET /api/plan/export` (slice 6), as a backup and a way out for every user.

Yama reads it at `POST /api/plan/import` (signed in from the browser, and from slice 4 with a script key) and with `yama-server import-plan FILE --owner EMAIL` for local development. The owner always comes from who is signed in. The file has no owner field, and Yama never looks a user up by email from it.

This is the contract between the exporter and the importer. The reasoning is in `docs/planner-design.md` (sections 2, 3 and 6) and `docs/planner-design-critique.md`. Written 2026-10-18 for slice 0. Slice 1 (the importer, 2026-10-19) filled in the checks, warnings and report it settled.

## The file

- **Name.** commander-decks writes `data/planner/yama-plan.json`. It is gitignored because it is derived output that can be rebuilt at any time. (`data/shopping/plan.json` is an unrelated older file in that repo.)
- **Encoding.** UTF-8 JSON, at most 8 MB. A larger body gets 413.
- **Upload it untouched.** The browser sends the picked `File` as the request body with `Content-Type: application/json`, and `publish.py` sends the file's bytes. Neither parses and re-serializes it: Python writes `124.0` where JavaScript would write `124`, and the hash below would change.

## The envelope

```json
{
  "format": "yama-plan/1",
  "meta": {"app": "commander-decks", "guide_version": 6, "guide_date": "2026-10-18",
           "git_sha": "6dc79d6", "dirty": false, "generated_at": "2026-10-18T21:30:00Z"},
  "plan": { ... }
}
```

| Field | Meaning |
|---|---|
| `format` | Always `"yama-plan/1"`. Any other value is a 400. |
| `meta.app` | Who wrote it: `"commander-decks"` or `"yama"`. It sets each deck's default `source` (below). |
| `meta.guide_version`, `meta.guide_date` | commander-decks only: the guide version `build.sh` stamped (`data/shopping/guide-version.json`). Shown in the source banner. |
| `meta.git_sha` | The commit the file was built from. `publish.py` checks that Yama's head is an ancestor of it. |
| `meta.dirty` | `true` if exporter inputs had uncommitted changes. The banner says so. |
| `meta.generated_at` | When the file was written, RFC 3339 UTC. |

Unknown `meta` fields are kept with the import record and otherwise ignored.

### The content hash

The server reads `plan` as raw JSON (`serde_json::value::RawValue`) and takes the SHA-256 of **the exact bytes of the `plan` value** as they appear in the upload. `format` and `meta` are outside it, so a rebuild that only changes `generated_at` or `git_sha` is unchanged content.

- If the hash equals the owner's current head, the import is `unchanged` and writes nothing: no rows, no revision bump.
- Otherwise it applies, even if that hash was imported once before. Re-uploading an older file is never silently skipped; the browser warns when the file's guide version is lower than the head's, and `publish.py` refuses unless `--force`.
- Pages show the first 12 hex digits of the hash next to the guide version, because changes that touch only the plan file (aliases, inbox outcomes, notes) don't change the guide version.

Writers should make `plan` byte-deterministic so that unchanged content hashes the same. commander-decks writes it with `json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` and puts no wall-clock time inside `plan`.

### Compatibility within `yama-plan/1`

- Readers ignore fields they don't know.
- New fields are optional, and a missing optional field means what it meant before the field existed.
- Removing a field, renaming one or changing what a value means needs `yama-plan/2`.

commander-decks' exporter also writes fields this format doesn't define. Yama accepts and ignores them; they are listed here so nobody reads them as part of the contract: a top-level `upgrades` array (every `data/upgrades.json` row with its matched swap key, the source of each swap's `upgrade`); `got_text` and `standin` on swaps; `stock_source` on decks; `game_changers` and `game_changers_checked` inside `bracket`; `aliases` on stores; `source` on settings; `item_count` on orders and a per-copy `scan` array on order items; and inside `library`, `scanned` and `arrived` on `bought` entries, `finish` on `extra` entries, and `precon_lists_fetched`. The first integration (2026-10-19) lined the exporter up with this file: slots write `swap` (not `swap_key`) and no `oracle_id`, `got.deck` is a deck key plus `deck_name`, and the collection views arrive as `library`.

## Conventions

- **Dates** are `YYYY-MM-DD`. **Times** are RFC 3339 in UTC, whole seconds (`2026-10-19T01:00:00Z`).
- **Money** is a number ≥ 0, or `null` when unknown. `null` never means 0, and 0 is never written for "unknown". Currency is USD unless a `currency` field says otherwise.
- **Every price says when and where it came from.** A quote has `checked` and `source`. An order item's price is dated by its order and comes from that order. Daily market prices are not in the file: Yama reads them from its own `price_snapshots`, with their dates. A market price is not a store quote and doesn't show a store has the card.
- **Card names** are Scryfall English names. Double-faced cards may use the front face or the full `A // B` name. Yama resolves names to cards when it builds the bundle, not at import, so a card Scryfall adds later (the Star Trek decks, around 2026-11-13) resolves without a new import. Unknown names are kept and reported, never dropped.
- **Printings** are `set` (Scryfall set code, any case) plus `num` (collector number as a string), or `scryfall_id`. Unknown printings are kept and reported.
- **Color identity** is written in WUBRG order: `"WUR"`.
- **Booleans that can be unknown** are `true`, `false` or `null`.
- **Strings that can be absent** are `null`, not `""`, except free-text notes where `""` is accepted and means the same as `null`.

### Keys

Keys are how review answers, installed ticks and aliases find their rows, so they never depend on database ids. Each is unique within its section.

| Row | Key |
|---|---|
| Deck | Slug of the display name, as commander-decks names its compare files: `riders-of-rohan` |
| Plan swap (commander-decks) | `plan\|<deck display name>\|<in>\|<out>`, the review site's id |
| Stand-in | `standin\|<deck display name>\|<in>` |
| Optional extra | `opt\|<deck display name>\|<in>` |
| Proposal (commander-decks) | The candidate's `id` in `candidates.json`: `rohan-flyers-banishing-light` |
| Row made in Yama | `y\|<id>` |
| Order | The order id: `pats-games-55912` (made in Yama: `y\|<id>`) |
| Store | Short slug: `pats` |

When an agent renames a swap's in or out, or promotes a proposal, the old key becomes an **alias** (see `aliases` and the `was` and `from_candidate` fields), so answers and ticks follow the row.

### Private fields

Some fields can name stores, order dates or prices paid. A shared view (slice 10) never includes them: all of `orders`, `quotes`, `stores`, `settings` and `reviews`; and on swaps and slots, `listing`, `note`, `store_label`, `source`, `order_item` and the state `log`; and on bracket bag entries, `from`. Shared pages build their sentences from the structured fields that remain (`got`, `kind`, `from_deck`) instead.

## `plan`

```json
{
  "settings": [...], "stores": [...], "decks": [...], "swaps": [...], "aliases": [...],
  "orders": [...], "quotes": [...], "reviews": {...}, "inbox_resolved": [...],
  "game_changers": {...}, "library": {...}, "notes": [...], "warnings": [...]
}
```

Every section is optional; a missing section is empty. For an imported plan, a missing section means "none": an import that drops a section retires its imported rows.

### `settings`: dated shopping rules

```json
[{"effective_from": "2026-10-08", "note": "Shopping decisions, 2026-10-08 to 10-09",
  "rules": {"currency": "USD", "max_over_market_pct": 25, "always_print_over_usd": 10.0}}]
```

- One entry per date, sorted by `effective_from`, dates unique. Each entry is the **complete** rule set from that date until the next one, so a purchase is judged by the rules of its own day.
- `rules` keys are in `docs/planner-design.md` section 9. All are optional, an unset rule raises no flag, and unknown rule keys are ignored. Rules only produce flags; they never block or hide anything.
- For owners with imported decks, settings are managed by the export, and editing them in Yama returns 409.

### `stores`

```json
[{"key": "example", "name": "Example Games", "short": "Example", "kind": "local",
  "cart_url_template": "https://example.com/cart/{items}", "homepage": "https://example.com",
  "location": "Austin", "note": "In store only; no online stock", "print_tiers": null, "sort": 1}]
```

- `kind`: `local`, `online` or `printer`.
- `cart_url_template`: `null`, or an `https://` URL containing `{items}`, which becomes `variant:qty` pairs joined by `,`. Anything else is a 400.
- `print_tiers`: printers only, the order sizes the printer prices by, `[162, 180]`; `null` when not checked.
- `short` is the store as written in swap rows (`"Pat's"`), so buy rows can be matched to a store.

### `decks`

```json
{"key": "example-deck", "name": "Example Deck", "was": [], "source": "import", "status": "active", "sort": 1,
 "product": "Example Deck (ABC)", "commander": ["Example Commander"], "color_identity": "WUR",
 "owner_changes": [{"out": "Card A", "in": "Card B", "note": "The owner's change before the plans"}],
 "notes": [{"kind": "open_question", "text": "Where did this Card B come from?"}],
 "bracket": null, "groups": [],
 "states": {"stock": {"cards": [...]}, "now": {"cards": [...], "log": [...]}, "after": {"cards": [...], "log": [...]}}}
```

| Field | Meaning |
|---|---|
| `key`, `name` | Slug key and display name. The display name is the one inside legacy swap keys. |
| `was` | Old display names. Renaming a deck changes every key that contains its name, so each old name turns those keys into aliases. |
| `source` | `"import"` (managed by an outside export; read-only in Yama) or `"yama"` (made in Yama; editable). Defaults to `"import"` when `meta.app` is `"commander-decks"` and `"yama"` when it is `"yama"`, so restoring a Yama backup keeps Yama-made plans editable. |
| `status` | `active`, or `proposals_only` for a deck with proposals but no approved swaps yet (stock = now = after). A deck missing from a later import is archived, not deleted. |
| `commander` | The plan's commander, which may differ from the box's face commander. One name, or two for partners. |
| `owner_changes` | Changes the owner made before any plan. |
| `notes` | `open_question`, `warning` or `note`. commander-decks takes these from a hand-kept structured file, never by parsing markdown. Open questions show first on the deck page. |
| `bracket` | Optional. `{target, keep_note, callouts: [text], bags: {"3": [Bag], "2": [Bag]}}`, where a bag entry is `{out, in, from, got}`. `from` is the writer's own sentence for where the swapped-back card comes from; it can name a store and an order date, so it is private. `got` (optional) says the same in a swap's `got` shapes, checked the same way: a card from this deck's own precon names this deck with `"origin": "precon"`; leave it out for a basic land. Bags are swaps applied to the after list, so basic counts survive. |
| `groups` | Optional. Proposal groups in order, `[{label, bracket, note}]`, where `bracket` is a number or `null`. Groups are cumulative: the proposed build for a group includes every group before it. That lets a deck whose proposals go **up** in bracket (adding Game Changers) show each step. |
| `computed_by` | Optional. Who computed the lists, when they all share it: `"commander-decks library.py, guide v6"`. A state's own `computed_by` wins; without either, Yama writes `"<meta.app>, guide v<meta.guide_version>"`. |
| `states` | The lists. See below. |

#### States and slots

`states` holds `stock`, `now` and `after`, and optionally `proposal`, `bracket3` and `bracket2` when the writer computes them. For an imported plan, Yama shows these lists as they are; it doesn't recompute them. A Yama-made plan's backup may leave `states` out, because Yama computes its lists on the device.

- `stock`: the product as it came out of the box, with the plan's commander.
- `now`: every swap whose card is in hand. It is the plan, not a record of what's in the deck box.
- `after`: the full plan once prints arrive.

A state is `{"cards": [Slot], "log": [{"swap": <key>, "status": ...}], "computed_by": ...}` (`computed_by` optional). Log status is one of `done`, `standin`, `fill`, `waiting`, `print`, `moved`, `waiting-move` or `spare`.

A **slot** is one card in a list:

```json
{"name": "Card B", "qty": 1, "board": "main", "kind": "owner", "set": "abc", "num": "123", "scryfall_id": null,
 "replaces": "Card A", "swap": null, "from_deck": null, "got": null, "order_item": null, "print_order": null,
 "note": null, "source": "The owner's own card"}
```

| Field | Meaning |
|---|---|
| `name`, `qty`, `board` | `board` is `commander` or `main`. Basics may have `qty` above 1. |
| `kind` | `stock`, `owner`, `bought`, `standin`, `fill`, `print`, `moved` or `optional`. |
| `set`, `num`, `scryfall_id` | The printing, when known (from a scan, the listing bought, or the precon). |
| `replaces` | The card this slot took the place of. |
| `swap` | The key of the swap that put it here. Yama also reads `swap_key`, which commander-decks' first exporter wrote. |
| `from_deck` | For `moved`: the deck key it came from. |
| `got`, `order_item`, `print_order` | Structured source, as on swaps. Pages build "where it came from" sentences from these. |
| `note` | Private free text. |
| `source` | Private. The writer's own sentence ("Bought at Example Games, ordered 8 Oct 2026, $0.50"). A fallback for owner-only pages; shared pages never show it. |

**A list's identity** is the SHA-256 of its cards reduced to `[board, name, qty]`, with repeated names summed, sorted, as compact JSON. Printings, sources and card ids are not part of it. So a list with the same 100 names is the same list, even after Yama learns a card's id or a scan changes a printing. A list with different cards is stored as a new row, and old rows are kept for the lab and for Yama decks made from them. A newer file with the same cards refreshes the stored list's printings, sources and log in place.

### `swaps`: plan swaps, stand-ins, optional extras and proposals

```json
{"key": "plan|Example Deck|Card C|Card D", "deck": "example-deck", "stage": "planned", "role": "swap",
 "parent": null, "src": "print", "src_declared": null, "store_label": null,
 "out": "Card D", "in": "Card C", "plan_card": "Card C", "later_out": null, "after_print": false,
 "tier": "T1", "band": null, "group": null, "sort": 7, "game_changer": null,
 "got": null, "order_item": null, "print_order": "mpc-placed", "listing": null,
 "when": null, "advice": null, "why": "...", "why_out": "...", "note": null,
 "was": [], "from_candidate": null, "upgrade": {"id": "upgrade-012", "status": "planned"}}
```

| Field | Meaning |
|---|---|
| `deck` | The deck's key. Must exist in `decks`. |
| `stage` | `planned` (in the plan) or `proposed` (waiting for the owner's answer). A proposal is never part of stock, now or after. |
| `role` | `swap`; `standin`, a card bought to hold a print's slot until the print arrives; or `optional`, an extra that may have no slot. |
| `parent` | Stand-ins only: the key of the print swap they hold. It must be in the same deck, with `src: "print"` and the same `out`. |
| `src` | `buy`, `print` or `owned`. `owned` requires `got`. |
| `src_declared` | When the writer changed `src` from what its source data said, the original value. For example, commander-decks turns an unbought Tricky Terrain `buy` into `print`. The import report lists these. |
| `store_label` | Buy rows: the store as written (`"Pat's"`). |
| `out` | The card it takes out. `null` for an optional extra with no slot, or a proposal with no cut yet. |
| `in`, `plan_card` | The card going in, and the card the plan really wants when `in` is a budget substitute. |
| `later_out` | Advice as recorded: the cut to use if `out` has already left. It isn't applied to any list. Until the owner decides what it means for stand-ins, pages show it as "suggested, not in the plan". |
| `after_print` | The move waits for prints to arrive. |
| `tier`, `band`, `group`, `sort` | The owner's gameplay priority label (`T1`, `Core`), the bracket band (`B2`, `B3`, `B4`) where the plan has one, the proposal group label, and the order within the deck. Tiers are gameplay priority, not price or bracket. |
| `game_changer` | Whether `in` is on the Game Changer list, as the writer recorded it. |
| `got` | Where an owned card comes from: `{"how": "bought", "order": <order key>}`, `{"how": "pulled", "product": "...", "date": "YYYY-MM-DD" or null}`, or `{"how": "deck", "deck": <deck key or null>, "deck_name": "...", "origin": "precon" or <order key>}`. Any other shape is a 400. A deck that isn't in the file (Yama also accepts its display name in `deck`) or an `origin` that is neither `"precon"` nor an order in the file is a warning, because the card can come from a deck outside the plan. |
| `order_item` | Buy rows, stand-ins and optional extras: `{"order": <order key>, "line": n}`, the copy bought for this use. |
| `print_order` | Print rows: the key of a proxy order **whose items list this card**. `null` means the print is for the next order. |
| `listing`, `note` | Private free text: the listing as recorded, and a note. |
| `when`, `advice`, `why`, `why_out` | Text for the owner. |
| `was` | Old keys of this row, which become aliases. |
| `from_candidate` | The proposal id this swap was promoted from, which also becomes an alias, so the owner's "want" follows it. |
| `upgrade` | commander-decks only: the matching row in `data/upgrades.json`, matched on deck, card in and card out, as `{"id", "status"}` with status `planned`, `ordered`, `installed` or `skipped`; `null` when no row matches. Which record holds installs (that file or Yama's ticks) is an open question for Bryan. Until he answers, Yama shows this status read-only beside its own tick and doesn't merge the two. |

### `aliases`

`[{"old": <key>, "new": <key>}]`. Yama builds its alias table from this list, from each swap's `was` and `from_candidate`, and from each deck's `was` (each key containing an old deck name maps to the same key with the current name). An alias is followed to a live key, at most 10 hops. An `old` that is also a live key, or a cycle, is a 400. An answer or tick whose key matches no live key, even through aliases, is kept and listed as an orphan. It is never dropped.

### `orders`: real purchases and print orders

```json
{"key": "example-1001", "kind": "real", "status": "received", "vendor": "Example Games", "store": "example",
 "order_number": null, "date_ordered": "2026-10-08", "placed_by": null, "date_fulfilled": null,
 "fulfillment": "in-store pickup", "currency": "USD",
 "subtotal": 124.0, "subtotal_note": null, "shipping": 0.0, "tax": 10.49, "total": 134.49,
 "card_stock": null, "evidence": "Receipt kept privately", "issues": [], "note": null,
 "items": [{"line": 1, "card": "Card E", "qty": 1, "listing": "Card E [ABC - 171] Near Mint",
            "set": "abc", "num": "171", "finish": "nonfoil", "scryfall_id": null,
            "received": null, "arrived": true, "deck": "example-deck", "replaces": "Card F",
            "role": "plan card", "unit_price": 0.5}]}
```

- `kind`: `real` (cards bought) or `proxy` (a print order). `status`: `draft`, `placed`, `received` or `cancelled`.
- `placed_by`: the latest date it was placed, when the exact date isn't recorded.
- `subtotal_note` says what `subtotal` is (for example, a sum of cart prices rather than a receipt figure).
- Money fields and `unit_price` are `null` when not recorded. `tax: null` means unknown, not "no tax".
- `card_stock`: print orders only (`"S30"`, `"S33"`), `null` when not recorded.
- `evidence` is a pointer ("Receipt kept privately"), never the receipt itself.
- Items: `set` and `num` are the printing listed; `scryfall_id` is set when the writer pinned the printing (commander-decks does this when every scanned copy of the line matches the listing, and not when the store sent another printing). A store's own numbering is not a collector number: Pat's lists The List as `[LIST - 20]`, so commander-decks writes `plst` with the scanned number, or no number. `received` is `{set, num, note}` when the store sent a different printing, else `null`. `arrived` is `false` for a card that never arrived and `null` when unknown. `deck` is the deck key the card was bought for, and `role` is `plan card`, `budget substitute for X` or `temporary stand-in for X`. `unit_price` is the price paid, or for a print order the cost per card.
- **A print order's items are the exact list that was ordered.** A print swap counts as on that order only if the order's items include its card (counted as a multiset). Counting rows alone isn't enough, because a one-for-one print swap would keep the count and silently label the new card as already ordered. commander-decks freezes the placed MakePlayingCards list in a dated file for this.

### `quotes`: dated price evidence that isn't Scryfall history

```json
{"swap": "example-proposal", "card": "Card G", "kind": "stock_check", "store": "example",
 "store_label": "Example Games (Austin)", "checked": "2026-10-18",
 "result": "In stock: ABC #173 Near Mint $0.75 (2)", "in_stock": true,
 "price": 0.75, "price_from_text": true, "currency": "USD",
 "printing": "ABC #173", "set": "abc", "num": "173", "printing_from_text": true,
 "scryfall_id": null, "variant": "42427719221416", "url": null, "source": "Store website"}
```

- `kind`: `stock_check` (a store's stock as checked on a date) or `market_benchmark` (a market price recorded on a date, for example "TCGplayer market via Scryfall, cheapest non-foil").
- `checked` and `source` are required, and a quote without them is a 400. Writers leave an undated price out rather than guess a date.
- `price` is `null` when the check found no price. `price_from_text: true` means the writer read the price out of `result`, and pages say "from the stock note".
- `printing_from_text: true` means the same for `set` and `num`.
- `variant` is the store's cart line id (a Shopify variant), **always a string**; writers convert numbers. A quote with `variant` and `price` can go in a cart.
- `store` is a store key when the writer matched one; `store_label` is the store as recorded.
- `swap` may be `null` for a quote about a card no swap uses yet. When it is set, it must be a swap in the file.

### `reviews`

```json
{"<swap key>": {"decision": "want", "note": "", "cut": null, "deck": "Example Deck", "card": "Card C",
                "at": "2026-10-19T01:00:00Z"}}
```

- `decision`: `want`, `unsure`, `no` or `null`. `cut`: the owner's chosen cut, or `null`.
- `at` is UTC. commander-decks converts the review site's local, timezone-less times with the Mac's time zone. An offset such as `-05:00` is accepted and stored as UTC; a time with no zone is a 400.
- An entry with `decision`, `note` and `cut` all empty is a **tombstone**: the owner cleared the answer at `at`.
- A key missing from the file is not a clear: Yama keeps whatever answer it has. A writer whose owner clears an answer keeps the key as a tombstone (commander-decks' review site does since 2026-10-19).
- Yama merges answers by key, and the later `at` wins on either side. A tombstone beats any older answer, so a stale file can't bring a cleared answer back. Ties go to the answer made in Yama. Nothing is deleted.
- `deck` and `card` are kept as text so an orphaned answer stays readable.

### `inbox_resolved`

`[{"op_id": "...", "outcome": "Recorded as order example-2026-10-21", "at": "2026-10-21T18:00:00Z"}]`: what the owner's planner did with items from Yama's inbox ("bought it" marks and ideas). Yama shows the outcome next to the tap. A "bought it" mark is a claim and never becomes an order by itself.

### `game_changers`

`{"checked_on": "2026-10-09", "source": "...", "names": ["..."]}`: the Game Changer list the writer used, with the date it was checked. Pages show that date beside every Game Changer count.

### `library`: views the writer computed from the owner's collection

Optional, read-only, shown as given:

- `bought`: every card bought, as `[{order, line, card, deck, replaces, set, num, scan}]`, where `scan` is `"ok"`, `"diff"` (a different printing was scanned), `"missing"` or `null` (no scan yet). This feeds "Sort a delivery".
- `scan`: the latest collection scan check, as `{file, date, to_check: [...], missing: [...], fine: [...]}`. Each entry is `{card, deck, replaces, order, line, listed: {set, num}, scanned: {set, num} or null, note}`. A mismatch is something to check, not proof the scan is wrong.
- `extra`: scanned cards that match no purchase, as `[{card, set, num, qty, container}]`.

### `notes`: plan-wide notes

`[{"kind": "open_question", "text": "...", "deck": <deck key or null>}]`, with `kind` as for deck notes: questions and warnings that belong to no one deck (where installed status lives, for example). Yama shows them with the plan.

### `warnings`: the writer's own warnings

`[{"deck": <deck key or null>, "swap": <key or null>, "text": "..."}]`. Yama shows them in the import report as given, apart from its own warnings.

## What the importer checks

**Errors (400, nothing written).** The message starts with the JSON path, for example `plan.swaps[12].got: unknown how "found"`.

- `format` isn't `yama-plan/1`, or the body isn't JSON.
- Deck, swap, order and store keys aren't unique, or an order repeats a `line`.
- A swap's `deck` doesn't exist.
- A stand-in's `parent` isn't a print swap in the same deck with the same `out`.
- `src: "owned"` without `got`, or `got` isn't one of its three shapes.
- `order_item`, `print_order`, `got.order`, an order's or a quote's `store`, or a quote's `swap` points at something that isn't in the file.
- A value outside its list (a `stage`, `role`, `src`, `kind`, `status`, `board`, `band` or decision Yama doesn't know), a state other than the six, or a slot or item `qty` below 1.
- A cart template isn't `https://` or lacks `{items}`.
- Money is negative or not a number. A date isn't `YYYY-MM-DD`, or a quote lacks `checked` or `source`.
- Settings dates repeat, or a review's `at` has no zone.
- An alias `old` is a live key, or aliases form a cycle.

**Conflicts (409).** A deck key in the file matches one of the owner's Yama-made decks (`source: "yama"`) while the file would import it.

**Warnings (in the report; the import goes ahead).**

- A state that doesn't have 100 cards including the commander, or has more than one copy of a non-basic card.
- What Yama's deck check finds on the resolved lists: color identity and current Commander legality. The repo's own checker can't check either.
- Card names and printings Yama doesn't know yet (kept).
- `src_declared` conversions.
- Two planned rows in one deck naming the same card as their cut (`out`, or a stand-in's `later_out`).
- More print swaps naming a print order for a card than the order lists copies of it.
- A `got` naming a deck or origin that isn't in the file.
- A file whose guide version is lower than the plan Yama already has.
- Answers and ticks that match no live swap (listed in `orphan_answers`, not as warnings).

## What an import does

The design's section 6.5 has the steps. In short: it runs entirely as the signed-in owner, and every row it writes carries that owner's id. Rows keep their ids across imports when their keys stay the same, and a row whose content hasn't changed isn't rewritten. A row missing from the new file is retired (decks archived) rather than deleted, and comes back if a later file brings it back. Lists are stored once per distinct list. Review answers merge newest-wins. Aliases are kept when a later file drops them, so an answer never loses its row. With `?dry_run=1` it does all of this, returns the report and rolls back; `?force=1` applies a file even when its hash equals the head.

Rows store card names, not card ids. Yama resolves names when it builds the bundle the pages read, so the report's `unknown_cards` is a snapshot: a card Scryfall adds later shows up resolved without a new import.

### The report

```json
{"import_id": "...", "unchanged": false, "dry_run": false, "forced": false, "content_hash": "<sha256 of plan>",
 "app": "commander-decks", "guide_version": 6, "guide_date": "2026-10-18", "git_sha": "...", "dirty": false,
 "head_before": {"content_hash": "...", "guide_version": 6, "git_sha": "...", "imported_at": "...", "revision": 3},
 "counts": {"decks": {"added": 0, "changed": 0, "unchanged": 0, "retired": 0, "restored": 0},
            "swaps": {...}, "orders": {...}, "stores": {...},
            "settings": 2, "quotes": 100, "aliases": 0, "states_new": 1, "states_refreshed": 0},
 "unknown_cards": [{"name": "...", "where": ["Example Deck: now list"]}],
 "unknown_printings": [{"card": "...", "set": "plst", "num": "20", "scryfall_id": null, "where": ["order example-1001 line 10"]}],
 "orphan_answers": [{"swap_key": "...", "deck": "...", "card": "...", "decision": "want", "marks": ["installed"]}],
 "reviews": {"from_document_applied": 0, "yama_newer_kept": 0},
 "existing_decks": [{"id": "...", "name": "...", "folder": "commander-decks"}],
 "warnings": ["..."], "export_warnings": [{"deck": "...", "swap": null, "text": "..."}]}
```

`import_id` is `null` for a dry run. An unchanged upload returns the head's own report with `unchanged: true`. `head_before` is what Yama held before the upload, so a page can show the file next to it. `existing_decks` lists the owner's Yama decks in the folder "commander-decks", which an import never touches.
