# Deck import: sources, formats and what each site allows

Checked 22 Oct 2026. The import page is `/decks/import` (`web/src/decks/ImportPage.tsx`, guides in `web/src/decks/guides.ts`); the server side is `server/src/deck_import/`.

## How each source comes in

| Source | How | Why |
|---|---|---|
| Moxfield | Paste (More, Export, Copy for Moxfield or Copy for MTGA) or a downloaded .txt | `api2.moxfield.com/robots.txt` is `Disallow: /`, and Moxfield is known to give API access only by permission (a user agent it grants). A pasted Moxfield link gets the steps instead. |
| Archidekt | Paste (⋯, Export, text or MTG Arena format). Link import is built but off. | robots.txt allows `/api/`, but the terms (effective 7 Sep 2018, section 3.1) bar using automated agents or scripts to generate automated searches, requests or queries to the site. Fetching a deck on someone's behalf is close enough that it needs Archidekt's permission. Turn it on with `YAMA_DECK_LINK_SOURCES=archidekt` once Archidekt says yes. |
| MTG Arena | Paste (Export) | No site to fetch from. |
| MTGO | File (.dek XML or .txt) | No site to fetch from. |
| ManaBox | Paste, file, or Android share (⋯, Export / Share, Custom text file) | ManaBox's own guide (manabox.app/guides/decks/import-export). No public deck API. |
| Mythic Tools | CSV file; every "deck" container becomes a deck | The CSV export is the only way out (no API). Boxes and binders are collection, not decks. |
| TappedOut | Paste (Export, MTGO) | robots.txt blocks only some named bots, but there's no terms page to check against and no documented API, so no fetching. |
| Deckstats | Paste (Export, text) | robots.txt sits behind a Cloudflare challenge, so a server can't read it, let alone the decks. |
| EDHREC | Paste (Export) | robots.txt allows deck pages, but its JSON host (`json.edhrec.com`) refused the robots request (AccessDenied) and there's no public API. |
| MTGGoldfish | Paste or file | robots.txt disallows `/deck/download*`, the text download. |
| Scryfall decks | Paste | No documented deck API. |
| Anything typed | Paste | One card per line; see below. |

Fetching, where it's switched on, runs on the server only: a User-Agent that names Yama and its about page, a 10-second timeout, a 3 MB cap, under each account's import limit (`limits.imports`, 60 an hour).

## Formats the parser reads

`server/src/deck_import/formats.rs`, with fixtures in `server/src/deck_import/fixtures/`.

- **Plain**: `1 Sol Ring`, `1x Sol Ring`, `x1 Sol Ring`, `Sol Ring`, tabs instead of spaces.
- **Moxfield and Arena**: `1 Name (SET) 123 *F*` (`*E*` etched); `Commander`, `Deck`, `Sideboard`, `SIDEBOARD:`, `Companion`, Arena's `About` / `Name …`.
- **Archidekt**: `1x Name (set) 123 *F* [Commander{top}]` and `^label^`; `{noDeck}` categories and Maybeboard are kept apart.
- **TappedOut**: `*CMDR*`, `*f*`. **Deckstats**: `//Main`, `1 [SET#123] Name #!Commander`.
- **MTGO**: `.txt` (a blank line, then the sideboard, where a Commander deck keeps its commander) and `.dek` XML.
- **CSV**: by column names: quantity (`Count`, `Quantity`), name (`English Name` first, then `Name`, `Card Name`), set, collector number, finish or foil, board or category, and Mythic Tools' container columns. Covers Moxfield, Archidekt, ManaBox, Mythic Tools, Deckbox and similar exports.
- **JSON**: Archidekt's deck JSON, or a plain `[{"name","quantity"}]` list.

## Who's the commander

In order: a section, category or tag in the source; for MTGO-style lists, one or two cards set apart by a blank line (after a full deck, or alone before it); the first card, if it can lead a deck; the only card in the list that can. A guess says so on screen. With none, the person picks (one, or two partners). Anything else that can't lead a deck stays in the main deck.

## Matching names

Exact first (any face, any case; a card's own name beats another card's face, then the more played card). Then a forgiving match that ignores accents, curly quotes and how split and double-faced names are written. What's left gets up to three "did you mean" cards: names it starts (Atraxa → Atraxa, Praetors' Voice) and the closest by edit distance. Tokens, emblems and art cards never match.

## Printings

A printing named in the source is kept with the deck (`deck_prints`, migration 0013) and used by exports when you don't own a copy. A printing Yama's card data doesn't know is reported, and the card is kept.

A copy the source marks as a proxy (the Proxy column of a Moxfield or Mythic Tools CSV, or an Archidekt "Proxy" category) is kept the same way (`deck_prints.proxy`, migration 0020), with an empty set code if no printing is named. "Add to my collection" then adds it as a proxy. Plain text lists have no proxy mark.

## Open questions for Bryan

- Ask Moxfield and Archidekt for permission to read public decks by link. Moxfield asks developers to contact it for API access; Archidekt's terms would need a yes. Until then, copy and paste works for both.
