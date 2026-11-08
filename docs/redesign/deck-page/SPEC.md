# Deck page spec (area 2), first pass, 8 Nov 2026

Canvas: https://claude.ai/artifact/2ekfB9CSeU3VLLf9GwAM91 ("Yama redesign", page "Deck page", private to Bryan). Boards: Deck (tabs Cards, Stats, Plan, History), DeckControls, DeckEditList, DeckShare, PhoneDeck, PhoneDeckMore. Sections 0 and 0b are the latest; older sections stand where they don't conflict. AUDIT.md has the problems this answers. Paths are under `web/src/`. **New** marks something that doesn't exist today.

## 0. Fourth pass (8 Nov): one canvas, no micro copy, phone mirrors laptop, new actions
The boards now live on the merged canvas "Yama redesign" (https://claude.ai/artifact/2ekfB9CSeU3VLLf9GwAM91), page "Deck page": Deck, DeckControls, DeckEditList, DeckShare, PhoneDeck, PhoneDeckMore. The first canvas (U3ft...) is retired. Design system README items 7-9.
- **No micro copy.** Remove hint lines under options, fields, headings and buttons, verdict sentences over charts, and footnotes. Labels, headings and buttons do the work; sources stay as a short date beside what they qualify. Anything more goes behind one "?" per section that opens a popover (Why this bracket, Mana curve, Color balance, Themes, and Share's Who can see it). An overwriting action keeps one short consequence line ("The current list stays in History").
- **Actions.** Edit list (primary) opens Edit the list. Check cards (secondary) opens a choice: Check the box against the list (saves nothing), Scan the box as the list (saves a version), Compare with my collection (still need, proxies). Then Share. More: Play, Sample hand | Copy or export, Send to Mythic Tools | Add to collection, History (opens the History tab), Deck settings, Ask Claude | Delete deck. Today's routes: Check is `/decks/:id/check`, Scan is `/decks/:id/scan`; "Compare with my collection" is today's Still need / Proxies filter plus the Add to collection sheet (**New**: as a step of its own).
- **Phone mirrors laptop.** The same tiles, actions, List picker, tabs (Cards, Stats, Plan, History), sections and order. The side column drops below the list. More, Check cards and the List picker open bottom sheets. 44 px targets.
- **The Plan tab is the deck's plan hub.**
  - Current plan: state pill, "n of N in" with a bar, the next step, what's left as card pairs (Karmic Guide replaces Sepulchral Primordial, waiting on your answer; then "[n] more"), and Open the plan (the plans area's in-progress page).
  - Up next: plans for this deck waiting for your OK (a new version, or another build such as a different bracket target), each a row with Review.
  - Ideas: gaps with card pictures, "Ask for it in the plan".
  - Earlier: one line to archived plans.
  - Data: the plan bundle's deck plan (`useDeckPlan`, `deckCounts`) plus **New**: the plans for one deck by state (`GET /api/research-plans` grouped by deck, as on Plans).
- Revival Trance's counts are [n] until question 7 is answered.
- **Power level** (from the builder's note, FROM-BUILDER-power-panel-2026-11-08.md): `GET /api/decks/{id}/analysis` now exists. Its score is the natural number for the Bracket tile ("measures …"), and its vectors, caps, themes and history belong on the Stats tab, replacing my text-read themes. This isn't on the canvas yet: next pass.

## 0b. Third pass (8 Nov): density and page structure
Follows the design system's "Density, actions and page structure" and its ActionBar and SectionTabs components (system version 1794165776-8c8e). Where this differs from sections 1-6, this wins (and section 0 wins over this).
- Laptop density (`pointer: fine`): controls 36 px, the primary a 40 px pill, row actions 32 px, secondaries `raised` with 10 px corners, segmented tracks 36 px. Phones keep 44 px.
- Compact hero, about 220 px: breadcrumb, commander, a 60 px title and one status line on the left over a left wash. The Bracket, Value and Record tiles sit on the right; each opens its detail (the Cards tab's bracket panel, the Table sorted by price, History).
- ActionBar under the hero: the primary, up to three secondaries, then More as a floating popover with 36 px rows in groups and Delete last. Never inline, never pushes the page. Section 0 sets the actions.
- One List picker (36 px) on the same row, e.g. "Current, Bracket 4". Its menu groups: In the box; With the swap bag (Bracket 3, Bracket 2); Saved lists (Stock and named builds); Older snapshots; then Save a copy as a new list. It replaces the hero's configuration pills, Older lists and the separate Play it at switch. Search appears past eight items.
- SectionTabs, sticky under the bar, as real subpages. All four routes are **New**:
  - `/decks/:id`: Cards, with its count.
  - `/decks/:id/stats`: Stats.
  - `/decks/:id/plan`: Plan, "n of N in".
  - `/decks/:id/history`: History, with the number of lists.
- What each tab holds:
  - Cards: the swap preview when a lower bracket is picked; the list controls (Show, View, Group by, Sort, total, Copy), the type bar and the groups; a side panel, Why this bracket (Game Changers, combos, land denial, extra turns, Reserve List, the declared bracket).
  - Stats: curve, color balance, themes, combos and online play, all open.
  - Plan: see section 0.
  - History: earlier lists (one version at a time, each change as a pair, Put this list back) and games.
- No main content in disclosures. Today's folds are removed or opened into a tab: market value, Game Changers, Reserve List, the Bracket panel's three, the stats' two, and art credits.
- Nothing touches. Lay out with `gap`. Every action row sits at least 16 px below what's above it; sections are 32 px apart. On Edit the list, Paste, Choose a file, From another site and Reset sit 16 px under the box.

## 1. The deck page, `/decks/:id`

Anatomy, laptop: rail; art hero (breadcrumb, identity and commander, title, one status pill and line, Play, Sample hand, More); a bar with the list switch and "Play it at"; the swap panel when a lower bracket is picked; then the list (main column) and a side column (Plan, Bracket, Value, Tools). Phone: the same order in one column; Play full width, then Sample hand and More; the side column's panels come before the list as a Plan row, a 2x2 of tools, and one Bracket and value panel.

States
- Current list (main deck): pill "Ready to play" (good) when legal and nothing needed; "Need N cards" (warn) when `ownership.needed > 0`; "Not legal yet" (bad) with the first error in the line and the rest in a fold under the bar; "Planned deck" (dim) when `acquisition_status = planned` (no ownership numbers).
- A saved list (configuration): pill "Saved list"; the bar says "A saved list, not the one in your box" with "Put this list in the box" (confirm inline). No "Play it at".
- Switching lists: today's placeholder behaviour stays (old list on screen, inert, until the next loads).
- Play it at Bracket 3 or 2: the swap panel (pairs: card in, arrow, card out, "replaces"), Print swap cards, a source line, and "Out at Bracket N" on those cards in the list. Hidden when the deck has no swap bag for that bracket; the control shows only brackets that have one.
- No plan: the Plan panel says "No plan for this deck" with one link, "How plans work". No art: a raised block, no credit.
- Filters with nothing in them: one sentence in a dashed box ("Nothing to get. Every card is a real copy or a proxy.").

Data, mapped to today
| Piece | Source today | Gap |
|---|---|---|
| Hero, status, counts | `GET /api/decks/:id` (DeckView: validation, ownership, configurations, bracket) | none |
| List switch | `DeckView.configurations`, `legacyConfiguration` (decks/buildCatalog.ts) | none; at most 3 named lists in the control, the rest under Older lists |
| Put this list in the box | `POST /api/decks/{main}/use` (decks/DeckLists.tsx) | moves from DeckLists into the bar |
| Play it at, swap pairs | plan bundle bags (`usePlan`, `useDeckPlan` in pages/Decks.tsx:640) for tracked plan decks; `buildFamilies` bracket choices + `pairChanges` (decks/buildCatalog.ts:216) otherwise | **New**: one helper `bracketSwaps(deck)` returning {bracket, pairs, source} from either; card images for the "in" cards that aren't in the deck need a lookup (the plan bundle's slots carry names; images by name from `/api/cards` or the research view's images) |
| Print swap cards | `/decks/builds?savedDeck=&from=&to=` (BuildChoices.tsx:34-36, 149-150) | link with `to` set to the bracket build; check the ids match `buildFamilies` choice ids |
| Show filter | `DeckEntry.needed`, `DeckEntry.proxies` | Proxies count is new on the page (sum of entries with proxies covering copies) |
| Pictures / List / Table | today's Stacks, List, `DeckPriceList` | DeckPriceList becomes Table, loses its SHOWS tabs and takes the page filter; Leave out becomes a menu |
| Plan panel | `useDeckPlan` + `deckCounts` (@yama/core/plan) | **New** for untracked plan notes: `GET /api/research-plans` deck mapping (research/PlanTiles.tsx `deckGroups`) so every deck with a plan links to it |
| Declared bracket | `PATCH /api/decks/:id {bracket}` | **New** inline control; no sheet |
| Suggestion, power | BracketPanel's check query, `powerEstimate` (packages/core) | moves the numbers to the side; the panel's explanation and flags go into the "Game Changers and Reserve List" fold |
| Value | `singles_value`, `ownership.needed_cost_usd`, `price_date` | none |
| Tools | `/decks/:id/scan`, `/decks/:id/check`, `/decks/builds?savedDeck=`, `/lab/try?deck=` (lab/Try.tsx:87) | Lab: Try a change is power-users only; others get "My runs" or no row (question 3). The win-rate line comes from `pairedFor` (lab/paired.ts) |

## 1b. Second pass: header tiles, Why this bracket, list controls, ideas (ScryCheck)
- Header tiles: Bracket (declared, big; "the list measures N" from the stored Spellbook check), Value (`singles_value` with its source and date), Record (games and wins from `/api/decks` summary; the Lab line from `pairedFor`). All data exists. Each tile links to its detail (Why this bracket, Table sorted by price, Games fold).
- Why this bracket, beside Play it at: Game Changers named (DeckView.game_changers for the list in the box; for Bracket 3 and 2, the plan bundle's `bracket.game_changers[b]` or the bracket build's list), two-card combos, mass land denial and extra turns (the stored Spellbook check: `combos`, `mld`, `extra_turns`, as BracketPanel reads them), the bracket's rule in a line, and the declared-bracket control. Switching bracket strikes the Game Changers that drop out. **New**: markers for a bracket build that isn't the saved list need a check of that list (the check is keyed by list hash, so a stored answer may already exist; otherwise show "Not checked yet").
- List controls, all visible: Show (Whole deck, Still need, Proxies); View (Pictures, List, Table); Group by (Type, Mana value, None); Sort (Mana value, Name, Price); the total for what's shown; Copy the list. Table has Card, Mana value, Copy (real, proxy, out at a bracket), Cheapest printing, Price; Leave out moves there. Price sort and subtotals use `cheapest_usd` (exists); a group's subtotal counts known prices only and says how many have none.
- Type bar: stacked by count, one link per type to its group (`groupOf`, `GROUP_ORDER`). Group headers: name, count, price subtotal, collapse (kept per device like the layout).
- Ideas (side column): a named gap, one line, a row of card pictures, "Ask for it in the plan". First source: Commander Spellbook's almost-included combos (one card missing). **New**: the deck page doesn't call find-my-combos today (the check uses estimate-bracket); either store `almostIncluded` with the check or let the advisor/MCP write ideas into the plan. Ideas never change the list; they go to the plan as a request for the assistant.

## 1c. Deck stats (section under the list; board "Deck stats")
- Mana curve 1 to 7+ for nonland cards, following Play it at; compare with Stock (exists: the stock configuration's cards) or a typical curve for the bracket (**New**: needs a dataset, e.g. the Lab's precon datasets or EDHREC averages; until then "[n]"). Average mana value, counts at 2 or less, 3 to 4, 5 or more, and a plain one-line comparison. Keeps today's "Curve as a table" fold.
- Color balance: share of colored symbols against share of land sources per color (`deckStats.ts` already counts pips and land access); the line describes, never prescribes a ratio (ARCHITECTURE, Stats presentation).
- Themes: **New** (Yama doesn't tag themes). A theme, its core card count, one sentence and five card pictures. Source to decide: research notes' mechanics sections, or a small text classifier like the power estimate's.
- Combos: card pictures joined by "+", a dashed slot for a missing card, the result in words, from the stored Spellbook data.

## 2. More (menu on laptop, bottom sheet on phone)
Groups and items, in order: The list (Edit the list, Earlier lists, Save a copy as a new list); Send it (Share, Copy or download the list, Send to Mythic Tools when the bridge is on); This deck (Name, box and ownership; Add the cards to my collection; Ask Claude about this deck for power users); then Delete deck, red, after a separator. A popover anchored to the button (Escape and outside click close it; focus returns to the button); never `<details>`. All sheets exist: DeckHistory, NewConfiguration, ShareDeck, DeckExport, MythicSend, EditDeck (trimmed), CollectSheet, AskClaude, DeleteDeck.

## 3. Edit the list, `/decks/:id/edit` (today `/decks/import?deck=:id`)
One page replacing the Text layout, the Edit deck textarea and Update from a list.
- Start from: four buttons (The list in the box, Stock, Bracket 3, Bracket 2, only those that exist) plus Another list (a sheet that searches every `buildFamilies` choice and `/api/decks/:id/versions`). Today's "Start from" select goes.
- The textarea; Paste, Choose a file, From another site (today's guides in a sheet).
- Changes: `POST /api/decks/import/preview`, compared with the current list as today, shown as pairs with both pictures. Added cards' images from the preview (`ImportCardInfo.image_small`), removed cards' from DeckView. Pairing: **New**, reuse `pairChanges` (swaps from the plan pair first, the rest by group and mana value).
- Save it: "The list in the box" (`PUT /api/decks/:id`, a new version) or "A new list" (`POST /api/decks/:id/configurations` then `PUT` its cards: two calls today; **New** optional single call with cards). What changed note. One primary.
- States: no changes, unknown names (block saving, "did you mean" as today), warnings (count, colors, copies), stale source (today's guards stay).

## 4. Name, box and ownership (sheet)
Name; This deck is Owned / Planned / Not recorded (segmented, `acquisition_status`); Deck box (a picker that searches `/api/containers`); Show it as its own deck or as a list of another (a picker that searches main decks; `parent_id`, `configuration`). Save, Cancel. No bracket, no card list, no delete.

## 5. Share (sheet)
Who can see it as three radio cards; link with Copy link (primary), Open it, Make a new link (inline confirm, not `confirm()`); profile line for public; what friends see and never see; its other lists with their own setting (`ConfigurationRef.visibility`, each with Change); the simulated win rates setting (`Sharing.share_lab_results`) shown with a link to Sharing. All data exists.

## 6. Scan and Check
Scan: one primary per step. Check: "Check against" becomes The list in the box / Bracket 3 / Bracket 2 plus Another list (same search sheet as Edit the list); the targets exist in decks/checkTargets.ts; **New**: a `?target=` deep link so the deck page's bracket can open Check at that bracket.

## What gets removed
More as a `<details>` row and its phone copy; the phone action bar (decks.css:213-232) and `deck-actions-phone`; `deck-stats-tiles`; the hero's configuration links and Older snapshots fold; DeckLists panel; PlaygroupBuilds fold (its builds join Older lists or Another list); the Text layout (DeckTextList); the Prices view and its SHOWS tabs (Table replaces it); the bottom Bracket panel (Why this bracket replaces it); Edit deck's bracket select, list textarea, What changed and Delete; the Start from and Check against selects; `confirm()` in Share, Scan and Check; the bottom "Art credits and price source" fold (credit stays in the hero, source beside prices).
