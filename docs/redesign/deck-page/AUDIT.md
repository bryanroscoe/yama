# Deck page audit (area 2), 8 Nov 2026

Read from main at 9bd24457 (PR 166 merged). Paths are under `web/src/`. Nothing in the app or Yama data was changed.
Bryan, 8 Nov: the deck page "needs a teeny bit of work"; menus and dropdowns are "weirdly formed or weirdly spaced", with "way too many things", and pages are "missing a lot of tasks and features".

## 1. Menus, dropdowns, selects, popovers, sheets and tabs

### Deck page (`/decks/:id`, pages/Decks.tsx DeckPage)

| # | Control | Where, what opens it | Items | What's wrong |
|---|---|---|---|---|
| 1 | Hero action row | Decks.tsx:301-307, laptop only (styles.css ~1998, hidden under 900 px) | Play (primary), Sample hand, Update from a list, Share, More | Five pills plus a disclosure in one wrapping row; fine count, but More is a `<details>` that opens in place and takes `flex-basis: 100%` (pages/decks.css:403), so the row reflows and the menu pushes the hero taller. |
| 2 | More (laptop) | `<details class="deck-actions-more">`, Decks.tsx:306; items Decks.tsx:289-300 | Deck settings, Scan cards, Check cards, Add to collection, Export, Send to Mythic Tools (bridge only), History, New configuration, Ask Claude (power users only), Delete deck | 10 items of four kinds: navigation to pages (Scan, Check), sheets (settings, export, history, new configuration, collection), outside tools (Mythic, Ask Claude) and a destructive action. No grouping; they render as a wrapping row of on-art pills (decks.css:404) with no alignment grid; Delete is a red pill in the same row (decks.css:407), not separated. Items appear and disappear by account (Mythic, Ask Claude), so the row's shape changes. "Deck settings" opens a sheet titled "Edit deck" (Decks.tsx:766). "Scan cards"/"Check cards" lead to pages titled "Scan Revival Trance"/"Check Revival Trance" (DeckScanPage.tsx:57, DeckCheckPage.tsx:115); ARCHITECTURE calls them "Scan this deck"/"Check this deck". |
| 3 | Phone action row | Decks.tsx:427-431 | Update from a list, Share, More | Same 10-item More again, now a 2-column grid stretched under the row with negative margins (decks.css:244-248, overridden to three columns at decks.css:424-425). The open menu covers the cards below; spacing changes between the two rules. |
| 4 | Phone action bar | Decks.tsx:628-631 | Sample hand, Play this deck (primary) | Fine on its own, but Play is labelled "Play" in the hero and "Play this deck" here, and Update/Share/More sit in a third place (row 3). Three action areas on one phone page. |
| 5 | Configuration switcher | Decks.tsx:354-388, links styled as on-art pills in the hero | Each configuration (Current, Stock, named builds), plus an "Older snapshots" `<details>` with now/after-prints | A list of links in the hero, not a control: the selected one is only `aria-current`. Older snapshots open inline inside the hero. Choosing which list is in the box is somewhere else (row 7). |
| 6 | Status row | Decks.tsx:434-438 | Legal pill, "Plan: …" link, simulated win-rate sentence | Three facts with three looks; the plan link only exists for a tracked plan deck (useDeckPlan, Decks.tsx:640-676), and the simulation sentence is plain text with no link to the Lab. |
| 7 | Lists panel | decks/DeckLists.tsx:69-88 | Main deck: "Print swap cards between this deck and a build". A configuration: "Saved configuration. Current deck: …", "Use this as the current list" then a confirm with "Put it in"/Cancel | Only shows when the deck has two or more configurations (DeckLists.tsx:20); a deck with none has no way to print swap cards from its page. |
| 8 | Playgroup variants | decks/PlaygroupBuilds.tsx:107-112 | Research builds whose label matches `lower.friction|asshole|optimized` | A `<details>` chosen by a regex on labels; appears for some decks only, between the status and the cards. |
| 9 | Show filter | Decks.tsx:454-457, `role="tablist"` | Whole deck, Still need N | A filter marked up as tabs. Hidden in the Text and Prices layouts (Decks.tsx:454), where Prices brings its own copy (row 11). No "Proxies" filter here although proxies are a headline number. |
| 10 | Layout | Decks.tsx:458-463, `aria-pressed` group | Stacks, List, Prices, Text | Two different kinds in one control: three ways to look at the list, and Text, which is an editor (DeckTextList.tsx:263-272: a textarea, Review changes, Copy list, Reset). Remembered per device (Decks.tsx:176-185). |
| 11 | Prices view controls | decks/DeckPriceList.tsx:64-103 | Leave out chips (one per group), a tablist Whole deck / Proxies / Real cards / Still need with a price on each, Sort (Priciest first, A to Z), Copy as text | A second filter with the same labels as row 9, each tab hiding when empty (DeckPriceList.tsx:76) so the row changes shape; three control rows before the first card. |
| 12 | Card preview aside | Decks.tsx:518-531 | Picture, where your copies are, cheapest price, plan line | Hover-driven on laptop (onMouseEnter, Decks.tsx:489). Fine, keep. |
| 13 | More about this deck | Decks.tsx:565-622 | Market value disclosure, legality sentence, Game Changers, Reserve List, Online support, Bracket panel, Results, Deck stats | Eight sections in one column at the bottom, each with its own folds; the declared bracket, the suggestion and the power estimate live here, a long scroll from the hero that shows "bracket 4" in its subtitle. |
| 14 | Bracket panel | components/Bracket.tsx:107-160 | Check again, Declare a bracket, Why this suggestion?, power breakdown, Choose or change your bracket, How Commander brackets work | Both "Declare a bracket" and "Choose or change your bracket" open the whole Edit deck sheet (Decks.tsx:618) to change one number. |
| 15 | Art credits and price source | Decks.tsx:623 | A `<details>` | The art credit is also in the hero (Decks.tsx:335-340); fine, but the price source belongs beside prices. |
| 16 | Edit deck sheet ("Deck settings") | Decks.tsx:709-832 | Name; Deck ownership select (Not recorded, Owned, Planned, 773-778); Bracket select (Not declared + 5, 779-785); Configuration of select (every main deck, 787-799); Configuration name; Collection box select (every container, "Name (kind)", 804-809); Deck list textarea (810-817); What changed; Save changes; Delete | Eight fields mixing deck facts with the whole card list. Three short choices are selects (ownership 3, bracket 6). "Configuration of" and "Collection box" are unsearchable selects that list everything you own. The list textarea duplicates Text (row 10) and Update from a list. Delete sits beside Save (826-829). |
| 17 | Share sheet | decks/ShareDeck.tsx:165-215 | Who can see it (Private, Anyone with the link, Public on your profile), what's shared, Link + Copy link (primary) / Open / Reset link, profile line | Good shape. Reset uses the browser's `confirm()` (ShareDeck.tsx:195). It doesn't say which configurations are shared with it, and the "Show simulated win rates on shared decks" setting lives only on /sharing. |
| 18 | New configuration sheet | ShareDeck.tsx:218-255 | Name, Make it | Lives in ShareDeck.tsx; "configuration" is an internal word for what the page calls lists. |
| 19 | Delete sheet | decks/DeleteDeck.tsx:62-90 | What goes; for a main deck with configurations, Keep them / Delete them too; Delete / Cancel | Good. Reached two ways (More and the Edit deck footer). |
| 20 | Export sheet | components/DeckExport.tsx:51-85 | Format radios (names, Moxfield, Arena), list, Copy (primary), Download .txt | Fine. Copying the list for a chat is also in Text (DeckTextList.tsx:268) and Prices (DeckPriceList.tsx:102): three copy buttons. |
| 21 | History sheet | components/DeckHistory.tsx:48-92 | Two radio columns (from, to) per version, Restore this list, the diff | Two unlabeled radio columns per row are hard to read; restore and compare share one row. |
| 22 | Add to my collection sheet | decks/CollectSheet.tsx:129-222 | Summary, one checkbox per missing card ("Which cards are printed proxies?"), same-printing radios (3), Which cards fold, Add / Not now | For a new deck this is up to 99 checkboxes in a sheet. |
| 23 | Send to Mythic Tools sheet | bridges/mythic/MythicDeck.tsx:57-107 | Privacy select (4: Private, Shared, Unlisted, Public, lines 10-15, 72-73), Make the snippet, Unlink, Copy the snippet | A 4-option choice as a select. |
| 24 | Ask Claude sheet | advisor/AskClaude.tsx:42-61 | The advisor panel | Power users only; fine as a sheet. |
| 25 | Sample hand | Decks.tsx:834-881 | Full-screen dialog: Done (primary), Draw (primary), Mulligan, New hand | Two primary buttons in one view (Done in the head, Draw in the bar). |

### Update from a list (`/decks/import?deck=:id`, decks/ImportPage.tsx)

| # | Control | Where | Items | What's wrong |
|---|---|---|---|---|
| 26 | Start from | ImportPage.tsx:262-264, a `<select>` | Every build family choice: Current, Stock, each older snapshot, each plan bracket build, each research build, written "label — source" | The "dropdown with way too many things": a long native select whose options are full source sentences joined with an em dash. |
| 27 | Import from a file or another site | ImportPage.tsx:270-297 | A `<details>` holding a tablist of 11 sources (guides.ts) and the chosen guide's steps | Tabs inside a fold inside the edit column; for an update it's rarely needed and pushes the textarea down. |
| 28 | New deck / Update one of your decks | ImportPage.tsx:683-690, `role="tablist"` segmented | 2 | Fine as a segmented control; marked up as tabs. |
| 29 | Which deck | ImportPage.tsx:697-704 | Every deck, unsearchable | Long select; fine only for a few decks. |
| 30 | The diff | ImportPage.tsx:706-717 | In and Out lists of names | No card pictures, and in/out aren't paired (Bryan, 8 Nov: show both card pictures on every change). |

### Scan and Check (`/decks/:id/scan`, `/decks/:id/check`)

| # | Control | Where | Items | What's wrong |
|---|---|---|---|---|
| 31 | Check against | DeckCheckPage.tsx:121-130, `<select>` with `<optgroup>`s | This deck (current, each configuration), Earlier versions (every saved version, checkTargets.ts:38), Plan (stock/now/after/bracket builds), Plan: <title> per research note | The second over-long dropdown: every version of the deck plus every plan list. Most checks are against the current list or one bracket. |
| 32 | Mute sounds and vibration | DeckCheckPage.tsx:154 | Checkbox | Fine. |
| 33 | Scan/check review | DeckScanPage.tsx:57-77, 321-378; DeckCheckPage.tsx:163-166 | Scan more, Check the changes / Save as a deck scan, Start over (`confirm()`) | Browser confirms for Start over; two primaries on the scan step (Scan with the camera and Check the changes, DeckScanPage.tsx:65 and 70). |

## 2. Tasks people come to the deck page for

Steps count taps or clicks from the deck page on a laptop, then the phone where it differs.

| Task | Today | Steps | What's missing or wrong |
|---|---|---|---|
| See the list | Stacks (laptop) or List (phone) | 0 | Stacks show 6 cards per group, then "Show all" per group (Decks.tsx:476, 497-511). Fine. |
| See what's missing | Still need N | 1 | Hidden in Prices/Text. No next step from it: nothing links the missing cards to the plan's shopping list or to buy. |
| See what's a proxy | Prices, then Proxies | 2 | Not in the main filter, though the hero leads with real and proxy counts. |
| Play | Play | 1 | Fine. Labelled differently on phone. |
| Sample hand | Sample hand | 1 | Two primaries inside (row 25). |
| Switch configuration (list) | Hero link | 1 (older snapshots 2) | Not a control; no sense of which list is in the box. |
| Put another list in the box | Open the configuration, Use this as the current list, Put it in | 3 | Only from the configuration's own page. |
| Play at another bracket tonight | Plan link, then the plan's bracket picker, or Decks › Swap cards | 3+, another page | The deck page has no bracket switch and doesn't show the swap bag (the plan's bags: Revival Trance takes 2 out for Bracket 3, 5 for Bracket 2). |
| Declare a bracket | More, Deck settings, Bracket select, Save; or scroll to Bracket, Declare | 4 | One number behind a whole sheet. |
| Edit the list | Text layout + Review changes; Update from a list; Edit deck textarea; Scan | 2-4 | Four ways in, three textareas. |
| Update from a list (paste or file) | Update from a list, paste, Save as a new version | 3 | Start from select (row 26); diff without pictures (row 30). |
| Scan the box | More, Scan cards | 2 | Buried in More although it's a main way to update a real deck. |
| Check the box | More, Check cards | 2 | Same; the Check against select (row 31). |
| Prices and value | Prices layout; Market value fold at the bottom; hero "to finish" | 1-2 | Three places. Buylist references (Decks.tsx:403) sit above the stats on phones. |
| Share | Share, choose, Copy link | 3 | Fine. Which configurations show isn't said. |
| Export a list | More, Export, Copy | 3 | Fine; three copy buttons around the page. |
| Print swap cards | Lists panel link (only with configurations), then Swap cards | 2+, another page | Missing for decks without configurations; not in More. |
| Open its plan | Status row link | 1 | Only for a tracked plan deck; an untracked plan note isn't linked. |
| Open it in the Lab | none | none | Missing. The sim sentence is text. Try a change takes `?deck=` (lab/Try.tsx:87) for power users. |
| History, restore | More, History, Restore this list | 3 | Hard-to-read radio columns (row 21). |
| Add to collection | More, Add to collection, Add | 3 | Up to 99 checkboxes (row 22). |
| Deck settings | More, Deck settings, Save | 3 | Mixed sheet (row 16). |
| New configuration | More, New configuration, name, Make it | 4 | Word "configuration". |
| Ask Claude | More, Ask Claude | 2 | Power users only. |
| Send to Mythic Tools | More, Send to Mythic Tools | 2 | Bridge on only. |
| Delete | More, Delete deck, confirm | 3 | Also in the Edit deck footer. |
| Bracket facts, Game Changers, Reserve List, stats, results | Scroll to the bottom | 0, long scroll | Eight stacked sections; the bracket facts deserve the side column. |

## Top problems
1. More holds 10 mixed actions, opens in place and reflows the hero; on phones the page has three action areas.
2. Two filters with the same labels (Show, and Prices' tabs); Text is an editor hiding in a view switch.
3. No bracket switch on the deck page, no Lab link, no swap cards for decks without configurations, the plan link only for tracked decks.
4. The two long selects: Update's "Start from" and Check's "Check against". Short choices as selects in Deck settings and Mythic.
5. Four ways to edit the list; diffs without card pictures.
6. Bracket, Game Changers and stats are a long scroll away at the bottom.
