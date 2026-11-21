# What Yama does today

The detail behind the short list in the [README](../README.md): every area of the app and what
works in it now. [ARCHITECTURE.md](../ARCHITECTURE.md) explains how it is built and why. When a
feature ships or changes, update its entry here.

Online play is in alpha: expect bugs and slow turns.

- [Navigation](#navigation)
- [Accounts, sign-in and sharing](#accounts-sign-in-and-sharing)
- [Cards and prices](#cards-and-prices)
- [Collection](#collection)
- [Decks and plans](#decks-and-plans)
- [Game night](#game-night)
- [Online play](#online-play)
- [Lab and evidence](#lab-and-evidence)
- [Assistants (MCP)](#assistants-mcp)

## Navigation

Home (`/`, where the wordmark goes) is where Yama opens. Signed out it says what Yama is and
lists what works without an account: checking a deck, the life counter, a game against the
computer, precons, commanders and card search. Signed in it puts a life counter game in progress on top, then
starting a game, your four most recently changed decks and the latest three games you played
in. A table you follow from another device and your playgroup's shared tables show there too.
Until they are done, a Start here list sits on top: add a deck, bring your collection, start or
join a playgroup, play a game. Each is ticked from the account's own data; "Hide this list" is
remembered on the device.
Opening Yama with a life counter game touched in the last 12 hours goes straight to that game.
The life counter's setup is at `/play/table` (it was `/`; `/table` redirects there).

Five tabs: Play (the life counter, online play, watching, game history), Decks (your decks,
precons, commanders), Cards, Collection (your cards, your wish list, trading with a friend) and Playgroup. A
laptop has them in a left rail under the wordmark, which goes home, with you at the foot; a phone
has a top bar (wordmark, search, you) and the five tabs along the bottom. A tab with more than
one page lists them in a strip above the page. You (your avatar) opens your public profile,
Sharing settings, Settings, connecting an assistant, What's new, help and the admin area.
Workshop holds plans, getting the cards, swap sheets, simulations, datasets and Mythic Tools: a
rail tab on a laptop, a row on the You page on a phone. It shows with Advanced on (You,
Settings): on by itself for admins, power users and an account that already has a plan, a lab
run, a Mythic link or a wish, off for everyone else until they turn it on. It hides navigation
only; the pages still open by link. Every older address still opens its page
(`web/src/nav.tsx`). The public pages (precons, commanders, shared decks and profiles, About,
Privacy, Terms, the assistant guide and the sign-in page) carry the same frame: the five tabs
as a row of words on a laptop and along the bottom on a phone, with You where the app has your
avatar, and the Decks pages listed under the header of the precon and commander reference.

## Accounts, sign-in and sharing

### Sign-in

Google ID tokens with an invite list, or open to any verified Google account with `YAMA_OPEN_SIGNUP=1` (an account gets the standard allowance, and an invite gives the larger one; see [deploy/README.md](../deploy/README.md#open-sign-up-anyone-with-a-google-account)). Password accounts only from the command line. Sign-in, searches, join codes, imports and new games are rate-limited; admins can disable or delete an account in the admin area (`/admin`), or disable one with `user disable`. Email-only dev login for local use.

### Signed out

Yama opens on Home with its full navigation: the life counter and card search work without an
account, and pages that keep someone's own data (decks, collection, playgroup, the Lab) ask them
to sign in where the page would be. Check a deck (`/check`) takes a pasted list or a text file
from anyone and shows what the deck page shows about a list: Commander legality, what bracket it
plays like and the least the card rules allow, Game Changers, the power level, stats, sample
hands and dated market value. The list is kept in the browser only and is still there on the
next visit; the server keeps neither the list nor the result and sends it to no other service, so combos (Commander
Spellbook) come once it is saved. Saving makes it an ordinary deck: signed in, the page asks who can see it and saves when Save is pressed; signing in saves nothing by itself. The sign-in page (`/signin`) highlights the public precon
reference and MCP guide, explains what an account adds, and keeps Google sign-in directly
accessible. OAuth and private links use a focused sign-in view.

### Profile and sharing

You (your avatar) opens your public profile, Sharing settings and account settings.

Sharing settings (under You) brings together your public profile, shared decks and alternate
configurations, shared plans (groups of builds), copyable links and the account-wide switches;
each deck and plan has its own Share control. Trading with a friend is under Collection. A shared deck or collection never shows account details, prices paid,
notes, containers, proxies, planner plans or games.

Decks are public by default: an account made on or after November 12, 2026 starts its new decks
Public (on the profile once it has a handle; a public deck can be listed in Browse and found by
search engines). Adding a deck asks who can
see it (Public, Link only or Private) on the save step. The choice starts as the account's
setting and is remembered for the next deck; each deck's Share button says who can see it and
changes it afterwards. Check a deck's save has the same choice. A deck made without that step (copied from a precon, a Mythic Tools deck
import, an assistant's staged deck) says what it starts as first; one Yama makes from a collection
box or a plan's list always starts Private. A first public deck asks for a handle (on the save step and
in the deck's Share sheet). Without one the deck is public by link; it joins the profile once a
handle is chosen.

An account from before public by default is asked once, on its Decks page: "Yama decks are now
public by default. Make yours public?" It chooses what new decks start as (Public, Link only or
Private) and whether its existing decks change; none changes unless it says so, and until it
answers its public decks stay on its profile only.

Every shared deck and profile page has a Report link: anyone can tell Yama's moderator what is
wrong with it, without an account, and nothing about the sender is kept. In Admin, Moderation, an
admin dismisses a report or takes the deck down with a reason; a deck taken down is private, with
its configurations, and cannot be shared again until an admin restores it. Its owner is told why
when they try to share it. Public pages mask a
short list of slurs in deck names and descriptions, refuse them in handles, and show links in a
public deck's name and description as "[link removed]".

A deck that is listed publicly (public, with a handle, on an account that has taken on
public-by-default) may be indexed by search engines: its page drops `noindex`, names its own
address as canonical, and is in `/sitemap.xml`. Decks shared by link, public decks of accounts
that have not answered the question, profiles, collections, want lists, shared plans and every
download still ask not to be indexed. `/robots.txt` points crawlers at the sitemap and disallows
nothing, so a crawler can read each page's own `noindex`.

Yama moved to [yama.ing](https://yama.ing) on 28 October 2026. Anyone still on the old address
should sync pending changes there before signing in at the new one; installed apps and MCP
connectors need the new URL.

### Install

Installable web app (home screen, offline shell). An Android app, installed from GitHub
(`yama.apk` on the `android-app` release), that updates itself after every production deploy and
reads the scanner's text with ML Kit on the phone ([mobile.md](mobile.md)).

Where to get it (since 21 Nov 2026, Bryan: link the APK so people can install either way): on an
Android phone's browser the install card offers both, Install (the home-screen web app, where the
browser has a prompt) and Get the Android app (the APK download), and shows the app link even in
browsers with no prompt, such as Firefox (pointing to the browser's menu for the web app). Settings has an "Install Yama" row in every browser with
the same choices (on a computer, Copy app link and Download for a phone), and the You page links to it as "Get
the app"; it stays after the card is dismissed.

Which build is running (since 15 Nov 2026, `web/src/version.tsx`): one line at the foot of
Settings on the profile page and in Scan settings, such as "Yama app 0.2.100 (100), web 6389543,
built Nov 15, 2026". The app part is the installed APK's version; the web part is the commit the
web build was made from (`VITE_APP_BUILD` for the app, `YAMA_GIT_SHA` from the deploy for the
site, Git for a local build) and the build date.

Updating the Android app from inside it (15 Nov 2026, Bryan: there's no Play Store release soon,
so know about a new APK while the app is open and install it there; nothing checks while Yama is
closed, and there are no system notifications). A new APK brings the banner "A new version of the
Yama app is ready: 0.2.N." with a one-line what's new and Update. In the Android app, Settings has
a "Yama app" row in place of the foot line: the installed app and web build, "Up to date" (with
when it checked), "Update available: 0.2.N" and its what's new, and Update app or Check for
updates. Both share one check and one install (`web/src/appUpdate.ts`). The first update sends the
person to Android's "Install unknown apps" for Yama; coming back with it allowed carries the
install on without another tap.

### Which build each device runs

The app sends its build on API requests (`X-Yama-Client`, 15 Nov 2026): the Android app its
version name and code, the web build's commit and its native code hash; a browser its web build.
For a signed-in request the server keeps the last build per account and sign-in, with a device
name from the browser ("Pixel 10 Pro (Android 16)", "Chrome on Mac"), when that device first
reported that build and when it was last seen, and logs a line when a device reports a new build.
The account's assistant reads its own devices with the MCP tool `list_devices`; Admin, People
shows each account's most recently seen device and build. At most 20 are kept per account, and
they go with it ([ARCHITECTURE.md](../ARCHITECTURE.md#which-build-each-device-runs-15-november-2026)).

### Bug reports

Anyone signed in can report a bug from the little bug on every page head and dialog head (and
Report a bug at the foot of the laptop rail). The form asks what went wrong; Point at it hides
the form so they can drag a box round the problem, or tap it, and the report keeps the box with
the words, controls and card names inside it, the page's address, the dialog it came from, the
window size, the build and the browser. No screenshot is taken. Admins read, resolve and delete
reports in Admin, Bug reports. Reports are limited to 20 per account a day and go with the
account when it is deleted.

### What's new

A page listing what has shipped, in plain sentences, with a notice on each device about what shipped since its first visit, until the page is opened (Account settings links to it too).

## Cards and prices

### Card data

Scryfall bulk import: ~36.5k cards, ~116k printings, daily prices kept by date, rulings, the Game Changer flag. Cards, Commander legality and Game Changer flags refresh daily, so a new set is legal in Yama the day Scryfall marks it; rulings weekly. Images are Scryfall's WebP sizes (JPEG fallback for older files). Mana costs and symbols in rules text ({T}, {2}{G/U}, {W/P}) show as the symbols everywhere a card's cost or text appears, loaded from Scryfall at runtime and kept for offline use once seen; a symbol that can't load shows as its text.

### Card search

Subset of Scryfall syntax (`t:` `o:` `c:` `id<=` `mv` `pow` `f:` `kw:` `is:commander` `is:gamechanger`, `-`, `or`, parentheses; `set:` `a:` `year` `usd<` `is:reserved` and more `is:` values such as `is:partner` and `is:mdfc`; a card with no price never matches a price comparison). The search box suggests card names as you type, and picking one opens the card. Sorts by name, popularity, mana value, color, price or first release. Works offline from a 5 MB card bundle kept on the device, which has no printings or prices: there, searches by set, artist, year, price and the Reserve List say they need a connection.

### Card sheet

Oracle text, Commander legality, Game Changer tag, rulings with dates and sources, printings with market prices and price history. Each printing shows its own picture, which opens full size (as does the card at the top), and adds a copy of that printing in any finish it comes in, the button naming a special foil ("Surge foil"), or a proxy with its art (since 16 Nov 2026; before, +1 and +F buttons with no picture). Which of your decks run the card, and the combos it is part of in them (from each deck's kept Commander Spellbook check; nothing new is sent).

### Release calendar

Upcoming sets on the Cards page (Scryfall's `/sets`: release date, type, cards Scryfall has so far). Watch a set; once MTGJSON publishes a watched set's Commander precon lists, the Cards page names each deck and its commander (Collector's Editions under their deck) and starts a Yama deck from the stock list; four weeks after release the list folds away below the calendar. Refreshed daily with `YAMA_AUTO_IMPORT=1`, or `yama-server import-calendar`.

### Prices

Card Kingdom retail and buylist plus Mana Pool listing history via MTGJSON (90-day initial backfill), with individual dated buylist references for matching real copies, without an unverified resale total. Deck singles replacement estimates (with missing-copy counts and date ranges); precon sealed-deck market references via MTGJSON product IDs and TCGCSV, refreshed daily or with `import-deck-prices`. Daily Scryfall snapshots kept by date (`YAMA_AUTO_IMPORT=1`, which also refreshes the release calendar).

### Scanner

Camera scanning in Collection: the card is found by its art, and its printing and title are read in the browser with PaddleOCR's PP-OCRv5 models (Tesseract as the fallback; since 13 Nov 2026). When several printings share the art, the set code and number are read from the whole card while it's held, frame after frame, before any close-up is asked for (since 15 Nov 2026). Tapping a printing in the list files it, with Undo on the camera, and the top of the list shows the card's own corner with its set code and number, cut from the camera (since 15 Nov 2026). "Scan anyway" adds another copy of the card just added while it's still in view, for real duplicates, and the less used ways in (a photo, reading the name or the collector number up close) are under More (since 15 Nov 2026). Reading the printing from a held card weighs every frame's reads together (a set code from one frame and a number from another add up; a stray frame no longer resets it), skips blurred frames, goes on for seconds rather than a few frames, and says what it has read so far; Keep reading starts a full new try; a card whose art isn't sure has its title read too, and a clear title decides; art that leads every other card by 0.10 (at 0.65 or more) settles the card without waiting on its title, on two frames in a row, in the collection, deck and box scanners alike (since 18 Nov 2026); Wrong printing corrects a printing the scanner read wrong, before or after the card was added (changing the copy filed); and a typed name or a card read as text gets its printing read from the camera too (since 15 Nov 2026). The scanner chimes when a card is added, brighter when it is worth $2 or more (an amount you can set; $5 until 16 Nov 2026), and sounds a low tone when it needs a tap (since 15 Nov 2026). The cards added sit in a strip between the camera and the sheet, newest first and largest, each with its picture, its price in the finish added, Foil and copies marks, a white ring when it's worth the sound's amount, and a tag when it sees play in Commander (Staple in EDHREC's top 1,000, Played in the top 5,000, GC on the Game Changer list, read from the offline card list); the strip's head gives the session's dated total and Review all. Tapping a card opens it large, with its prices by finish, why it's tagged, and its fixes (finish, copies, Wrong printing, Remove). Scan settings open from a gear on the camera, and the sheet shows what cards are filed as, which opens them too; the sheet's lesser choices are buttons rather than underlined words (since 16 Nov 2026). What just happened is said beside the card in the strip, not over the camera: the card just added is named with Undo beside it (and Wrong printing when the scanner read the printing itself), and what Undo did is said there too; the camera says "Added" with the price for a moment after each add, then that the card is still in view (or how many of it in a row) with +1 copy (Scan anyway) for another, and nothing while it's simply waiting for a card. Each printing to pick shows its own price and what's special about it (Showcase, a language). With art recognition there's no frame to line up with, only four faint corners; zoom is one small button showing the level, opening + and −. The sheet asks only for what it needs: printings to pick from are one row of small cards to swipe along (Copies stays beside them, and the tap files that many), the strip steps aside while a card waits on you, how a card was found is behind a "?", and Wrong card, Wrong printing and the close-up are under More beside Skip. Only the newest card in the strip shows its Commander tag (each card's sheet says why). Scan only some sets is under More until it's on. On a laptop or a tablet on its side the camera stands on the left and the strip and sheet in a column on the right (since 16 Nov 2026). Scan settings chooses the camera where a phone lists more than one (the main lens by default) and says which is in use; the scanner zooms the camera in until the card fills the view, asks you to move closer when the set code and number are too small to read, and tries a still photo when reads stall (since 15 Nov 2026). The Finish choice offers the finishes the found printing comes in (Etched included, plus Proxy), taking its only one when it has one and otherwise the finish chosen last if it comes that way, else regular; the price shown is that finish's own (since 15 Nov 2026). "Scanner diagnostics" in Scan settings (off by default, owner-only) keeps what the scanner saw for each card it struggled with, the card's full-resolution bottom edge and every read, for checking and replaying; readable through the owner's own routes and MCP tools (since 15 Nov 2026). It also keeps the set symbol's area at full resolution, and for every card the scanner settles, struggled with or not, a small timing record with no pictures: how long the card took to name and by which rule, then how its printing was settled and how long that took, with the camera and art model; `get_scan_timings` gives the medians and the share settled by each rule (since 20 Nov 2026). Each kept scan photo also keeps two full-resolution crops of the card, its set symbol's area and its collector strip, shared and deleted with the photo, for training a printing model (since 20 Nov 2026). Scan settings names the text reader in use. Cards newer than the art recognizer's bundle are recognised by their art about a day after they reach Scryfall: the server embeds their art itself after each card import, with the bundle's own model, and the scanner searches those next to the bundle's (since 15 Nov 2026; `YAMA_SCAN_SUPPLEMENT=0` turns it off). Phones match the art with Yama's own model, fine-tuned for sleeved cards, glare and deck boxes, in place of the bundle's: on one saved photo per card of Bryan's real sleeved photos, the art scores qualify for the lead rule on 94% of cards instead of 85%, none wrong; live, a card settles on a lead after leading on two frames in a row, not yet timed on a phone (since 18 Nov 2026; `YAMA_SCAN_QUERY_MODEL=0` turns it off). Two faster models can be chosen under Scan settings, Models: Yama's card finder (one look at each window instead of four, and it places a corner a finger covers) and Yama's art model with two cuts first (the rarer frame styles only when needed); together they take a frame from about 125 ms to 39 ms on one processor thread of a laptop; the cascade gives the same answers on the test photos, and the card finder is better on simulated captures and as good on the real photos (since 20 Nov 2026; [scanner.md](scanner.md), "Speed"). "Test scanner speed" in Scan settings times the scanner on the device itself, without the camera, with a few cards' pictures from Scryfall: a frame's time with the device's models, the defaults and the faster ones ("A frame takes 142 ms with your models, 48 ms with the faster ones"), each part's median and 90th percentile, the printing look, the warm-up, and whether the browser offers WebGPU; it runs only when pressed, and the result is kept on the account (the newest 50, owner-only) for `get_scan_speed_tests` (since 21 Nov 2026; [scanner.md](scanner.md), "Speed test"). Scan settings has a Models part: the card finder, the art model, the text reader and the rule that settles a card by its art can each be switched on a device, back to the default or to a named option, and the change takes effect at once without reloading the scanner; the server can withdraw a broken option (`YAMA_SCAN_WITHDRAW`), which puts everyone who chose it back on the default, and kept scan photos and diagnostics name each part's choice (since 20 Nov 2026). When several printings share a card's art, the printing list puts the one that looks closest first, after any the collector line read, by comparing the card with each printing's own picture, and marks it "Looks closest"; on real sleeved photos the right printing comes first 87% of the time instead of 41% (the look model v1, the default; v0, 57%, is an option in Scan settings), and by default it never files a printing by itself (since 20 Nov 2026; `YAMA_SCAN_WITHDRAW=look-v0,look-v1,look-v1-sure` turns it off). Yama's server embeds each printing's picture with the look model ahead of time, decoding it as the phone's browser does so the numbers are the same, and the phone asks it first, so it no longer fetches and embeds every printing's picture itself; offline or when the server is slow it does as before (since 21 Nov 2026; [scanner.md](scanner.md), "Vectors from the server"; `YAMA_SCAN_LOOKS=0` stops the server making them). An opt-in option in Scan settings, Models, "Yama's look model v1, settles when sure", settles the printing by itself once the look has compared every printing with that art and the closest is 0.10 ahead of the next, unless the collector line read something pointing to another printing; it's shown and filed like a printing read from the collector line, with Wrong printing to change it, and Scanner diagnostics' timing records count its settles and corrections apart, so it can be compared with the default. On one tester's 98 sleeved photos it settled 45 alone with none wrong, which still allows about one in 15 wrong, so it isn't the default (since 20 Nov 2026; [scanner.md](scanner.md), "Settling by look"; `YAMA_SCAN_WITHDRAW=look-v1-sure` withdraws it). The collector line settles a printing on its number alone when no other printing sharing the art has a number that reads like it (read exactly on two frames), reads through stray spaces and a set code lost to the bullet or the artist's brush mark, and waits 6 s for the card to come back in view (12 s before the close-up); the printings to pick lead with their number and year, and the close-up says what it read rather than the raw text (since 21 Nov 2026; [scanner.md](scanner.md), "The number that matters"). Every card the camera sees is outlined at once, before it's named, with four corner marks that follow it smoothly and fade in and out; where the browser can pin the lens (Chrome on Android) the camera has a focus button, off for autofocus or a slider that holds the lens where you put it, remembered on the device; the camera is asked for 60 frames a second where it keeps its resolution (a switch in Scan settings), and Scanner diagnostics keep the rate it really delivers; and a card lying face down gets "Card back, turn the card over" (since 21 Nov 2026; [scanner.md](scanner.md), "Outline, focus, frame rate and card backs"). Inside the Android app, Scan settings has "Use the app's own camera" (off unless you turn it on, per device): the app opens the camera itself instead of through its web view, so you can choose the lens (Automatic, Main, Ultra-wide, Telephoto, where the phone has them), ask for 30 or 60 frames a second, and set the flashlight's strength where the phone allows (the focus control on the camera view works with it too); it says which lens and what rate the phone really gives, and Scanner diagnostics' records name the camera so the two can be compared. It's being tried out and hasn't been checked on a phone yet (since 21 Nov 2026; [scanner.md](scanner.md), "The camera source, and the app's own camera"). An option to try in Scan settings, Models, "Art that leads, read when the card is still", reads a card once it has come to rest, from the sharpest frame, rather than on every frame: it says "Hold the card still" while the card moves, tries at most five times and then says "No match, move the card", and doesn't read a card again while it lies there; what settles a card and its printing is unchanged, and Scanner diagnostics' timing records name the option so it can be compared with the default (since 21 Nov 2026; [scanner.md](scanner.md), "The placement gate"; `YAMA_SCAN_WITHDRAW=lead-gate` withdraws it). Swap checks from Plans, Prints, Swap sheet or a plan deck: scan either card for its replacement, reasons and destination, or check a photo or typed name. Uses card identity across printings and either face; scans change nothing. How recognition works, and what is left, is in [scanner.md](scanner.md).

## Collection

- Mothership cash/credit offer checks with private dated history from the Sell list
- Binders, boxes, decks and lists, as small art tiles; one opens on its own (in the address, so Back closes it and it can be linked) with its cards under it. The page head is one line of value (its details behind ?) and the actions, with the search straight under it, above the boxes; past six places the tiles fold into an "Open one of" dropdown, with Show tiles to bring them back (remembered on the device; 16 Nov 2026). The Cards tab has Scan my cards, which opens the collection's scanner (`/collection?scan=1`)
- Sections (since 16 Nov 2026): a box, binder or list can hold sections, and a section sub-sections (up to eight levels), for one big box with dividers. The tiles are the top-level containers with their totals, sections included; an open one shows its path (each step a link), its sections as a tree with each one's own copies and value and those of everything under it, and New section, Rename, Move (to another container or the top level; never into itself or one of its own sections) and Delete (refused while it still has sections; a deleted section's cards go into the box it was in). Its card list can include its sections' cards. Every place you pick a container shows its path ("Big box › Bulk Basic › Plains"). Names are unique among siblings, so two boxes can each have a "Plains" (a section of a deck box is a box, so its cards don't count as in the deck); an import naming a container finds it wherever it was moved, the top-level one first
- Scan a box (since 16 Nov 2026, `/collection/check/:id`, "Scan this box" on an open container): scan the cards physically in a box or section, with or without its sections, and Yama sorts each card by name into here (filed there), filed elsewhere (Move here, one card or all, taking a real copy before a proxy, loose copies first and deck boxes last), not in the collection (Add here, after you pick the printing and finish, since the scan doesn't settle one) and filed here but not scanned (Mark missing, one or all, moves them to a top-level "Missing" box, or leave them). Like Check this deck, the check in progress stays on the device and only the changes you tap are saved, as ordinary collection ops
- Add from card search (a real copy or a proxy)
- Move, condition, proxy
- A copy's language and whether it is signed or altered, for the whole row or one copy split off, shown as tags on the copy
- Proxies kept out of market value, and a Real / Proxies filter
- Filters by set, color, type, rarity and finish, with the market value of what they leave; a list or a grid of card pictures
- Idempotent offline ops
- Import from a pasted list or a file exported by ManaBox, Moxfield, Archidekt, Deckbox, Dragon Shield or TCGplayer: set, number, finish, condition and language where the file has them; a preview of what matches, with lines that match nothing kept listed; into a box you choose; the same list twice adds nothing, and a newer export can add only the copies you don't have yet
- Mythic Tools CSV import (with a preview; a newer export adds only what's new, and cards it no longer lists are removed only if you ask) and export
- Special printings named in plain words wherever a printing is chosen or shown (the scanner, a card's printings, collection rows, the Added list, a deck's "Add to my collection" and the CSV export's "Special Printing" column): "Surge foil, MSC 40", Galaxy foil, Textured foil, Double rainbow, Serialized, Showcase, Extended art, Borderless, Full art, from Scryfall's promo types, frame effects, border and full art (`treatmentLabel` in packages/core; since 15 Nov 2026). A special foil is its own printing, so imports find it by set and number, and a finish column or marker that says "Surge Foil" or "Etched" is kept as foil or etched
- "Add to my collection" on a deck puts its cards in its deck box, in the printings the list names
- A deck's swappable spares (2026-11-15): cards kept in its deck box on top of its 100, such as the bracket bag's cards and ready swaps. They live in a box of their own linked to the deck, shown as "<deck>'s box (swappable)", and count toward nothing in the deck (size, legality, stats, prices, exports). The deck page lists them with what each comes in for (the plan's bracket bags, or your own note), and sets up, changes or stops the box; copies go in and out with Move. The old "<deck> swap bag" boxes became those decks' spares

## Decks and plans

### Decks

- Browse (`/decks/browse`, no account needed): decks people have made public, the most recently saved list first, with a search by deck or commander name and filters for commander, colors, declared bracket and "started from a precon" (worked out from the list: it still holds at least half of a precon's own cards). Open one for its full page, or save a copy to your own decks
- The Decks list has folders (set in a deck's settings; imports set one too), a search by name or commander, filters by folder, color and declared bracket, and a sort by name, most recently changed or record (the Mythic Tools folder stays with the decks that import keeps up to date)
- Paste any common list format
- Edit as text with versions, with a card search on the edit page that adds or removes a card in one press and says whether it fits the commander's colors and whether you own it
- Version history with a diff between any two versions
- Commander validation
- Check cards: compare physical cards with the saved list without changes, scan a new version, or find cards missing from your collection; each menu action has its description on a separate line
- Deck checks, deck scans, box scans and swap checks (since 17 Nov 2026): with Keep going on, a card counts by itself when its art and name agree, even if its art looks like other cards, and a name read short of clear counts when it names one of the art's guesses; a half-legible name no longer leaves the scanner on "Hold still". These scans use a 1080p camera and a smaller cut of the card, since only the name is read. Over the camera, the last card's verdict shows for a moment after it's counted and goes as soon as the scanner reads another card. Scanner diagnostics also keep cards that took over 3 s to find, or were never found, with what each frame read ([scanner.md](scanner.md))
- Owned/needed with cheapest market price
- The Cards tab shows the list as pictures, stacks (each group a column of overlapping cards with their name bars showing; pointing at or focusing one shows it whole), a list or a table, grouped by type or mana value
- Sample hands with mulligans
- Game Changers count
- How many cards online play supports
- Real-game results per version ("This version: 3-2, 5 games")

### Brackets

A declared bracket per deck (chips on the deck list, table setup and online lobby), shown beside a starting suggestion from Commander Spellbook's card-list signals: Game Changers, mass land denial, extra turns and combos. Unflagged lists start provisionally at Core (2); Exhibition (1) and cEDH (5) are chosen by the owner. The deck page explains why beside the cards: the 1 to 10 power level (its dial is on the Stats tab), the Game Changers and the cards in each two-card combo with what the combo does (roll over a chip to see the card). On the Stats tab, the five scores compare with the deck's own stock list, any earlier version or another of your decks, showing how far power moved, as well as with a typical precon, Bracket 4 or cEDH. Checked in the background after a save; turn off with `YAMA_DECK_CHECKS=0`. The power level's text rules read what a card does for the whole team (lords, anthems, and keywords, mana or protection given to every creature of a kind), proliferate and planeswalker support, and the themes it names include planeswalkers, legends matter, and goad and politics ([method and measurements](deck-analysis.md)).

### Deck stats and export

The Stats tab also shows the commander's record: the share of recorded games won under that commander on the public sources (every list, stock or tuned), its place among commanders with 100 or more games and the middle commander's rate, with a link to `/commanders`. It describes the commander, not the list, and is not part of the power level. The shared deck page, precon pages and the MCP deck analysis carry the same figure.

Mana curve (creatures and other spells), average mana value with and without lands, land count, colored pips and potential land access per color, without unsupported shortage verdicts ([method and research](deck-stats.md)). Export as names only (EDHbots), Moxfield (set and number of your copy) or MTG Arena; copy or download.

### Suggested changes

Review suggestions from Yama’s assistant and external MCP apps before applying them. Deck proposals show separate cards in/out with quantities, card previews, readable reasons and deck checks; existing proposals use the same view.

### Plans

Every plan in one place (Decks, Plans): notes agents save, copies of plans others shared, and imported planner plans. A plan's page is the page its shared link (`/r/<token>`) shows, from the same server computations: each deck's builds, how to pilot it, changes with reasons, a shopping list at market prices (buy up to $2, print the rest; buy all; print all) and the lists to copy. Only the owner sees sharing, their answers for the agent (preferred builds, per-swap answers and notes, kept across refreshes and never applying deck changes) and the agent's evidence: allocations, dated local buys, store checks, combos and print lists. A plan can be shared by link (`/r/<token>`) or on your profile, never showing your answers, ownership or shopping evidence ([format](research-format.md)).

Local sourcing shows all filtered cards and allocates recorded quantities across acceptable printings. A listing without a count supplies one copy (in stock means at least one); more need an explicit request and remain unconfirmed. A selected product variant's stock count is separate from a search badge that combines conditions or finishes. For Shopify stores Yama reads card by card, the page shows live stock: each wanted card is reread in the background about every 8 hours (cards in the carts first), the store's newer answer replaces the report's quotes for that store, and a selected listing that sold out leaves the carts with a notice. The sourcing page shows dated public Shopify catalog caches and can refresh them (some stores refuse full-catalog reads; a check then searches each card instead); assistants can request the same refresh with `check_stores(refresh_catalog: true)`. Complete catalogs persist across restarts; failed crawls preserve the last complete cache. A catalog refresh does not rewrite a private saved source report or alter a retailer cart. See the [local shopping workflow](local-shopping-workflow.md).

Nobody approves a plan (since 20 Nov 2026). What an assistant tracks or saves, or a plan file brings, goes straight into the deck's plan and its shopping list; nothing is bought until you mark it. A change whose cut clashes (no card named to cut, a cut the plan already makes, or two changes cutting the same card) is left out, and the plan's page lists it under Left out with the reason. To change a plan, ask your assistant; Archive and Bring it back are on the plan's page.

Local sourcing leaves out copies already ordered: a saved report is a snapshot, so a copy in a real order placed since it was made (or marked bought since) comes off the cards, totals, carts and store rereads, and the page names the order that covers it.

### Deck planner

The planner is in progress ([design](planner-design.md), [plan file format](plan-format.md)).

- Importing a plan file works, from the browser (Decks, then Plans, then "Import a plan file") or with `yama-server import-plan`.
- The pages are built: an overview and a page per plan deck with its changes, stock, now and after-prints lists, bracket builds, copy buttons, "Make this a Yama deck" and a link to your Yama deck
- Answers beside each proposed swap on its deck's page (offline too) and a Review page listing the decks with answers waiting and "Suggest a change"
- Settings with script keys for commander-decks' `publish.py` and `pull.py`
- A Buy page (cards by store with cart links, dated prices and rule flags, "Mark bought", each order A to Z for sorting a delivery), Prints (each print order and the next one, with tiers and double-faced backs; Print with MakePlayingCards picks print-ready images from MPC Autofill and the Yama print helper for Chrome, `extension/mpc`, fills them into an MPC project, or writes MPC Autofill's order.xml; and a printable swap sheet: sort the prints into decks, then each deck's card in, card out and where the cut card goes) and Spares
- "I've put this in the deck" ticks
- "Swap in the prints" per deck, which gives the linked Yama deck its after-prints list, puts the prints in its box as proxies, moves cut cards to the deck that takes them next, the deck's swap bag box, the deck's own spares box ("<deck> spares" under the deck's current or plan name, any case, when there is one; 2026-11-15) or Spares, and ticks the swaps installed

### Swap cards and deck-box inserts

Decks, Swap cards (`/decks/builds`) brings the deck as it is, its saved lists, tracked plans and
plan builds together under plain names ("Bracket 3: Upgraded"). Pick two complete lists to see
each change with its plan's reason, and print them as 2.5 × 3.5 inch duplex cards for the deck
box. Older now/after-prints snapshots stay under Older snapshots.

## Game night

### Life counter

1–6 players, rotated panels with the commander's art behind each life total (artist and copyright credited on each panel; switch to mana colors per device), commander damage and tax, poison and counters, monarch, initiative, day/night, undo, works offline and syncs later. Roll for first or pick who goes first (passing the turn never guesses it); knocking someone out asks who did it; the finish sheet asks how the game was won and how fun it was, and takes a note (all optional). An optional clock (per device, off by default) shows how long the turn and the game have run; it reads the times the game already records, so it works offline and a finished game's page says how long it ran. If people sat down somewhere other than setup put them, Swap places in the table menu trades two players' panels mid-game; turns then go around in the new order, and each player keeps their totals and history.

Game types are Commander, Constructed, Limited and Other (since 17 Nov 2026 Limited: draft and sealed, 20 life, two players). Outside Commander there's no commander to pick: a seat may tap its deck's colors instead, which fill its panel and name it (Azorius), and commander damage, tax and the commander-damage win don't show. Two players can play a best-of-three or best-of-five match (Limited starts on best of three): each panel shows its games won as rings, the table menu says where the match stands, finishing a game offers "Save and start game 2" (or Save and stop the match), and the player who lost picks who plays first in the next game. Each game is saved and counted as its own game; its page lists the match's other games and the score, and Recent games says "Limited, game 2 of 3".

### Shared table

Every phone joins the game by QR code; the host phone stays in charge and works offline.

### Playgroups

Join codes (the owner can make a new one, and removing an account changes it), guests without accounts, a members list where anyone can leave and the owner renames the group, removes people, hands it on or deletes it, game history, logging games played without Yama, offline too (with game type, starting life, first player, knockouts, win condition, fun and a note), win rates by player and commander beside the share they'd win by chance, win rate by turn order (with playgroup.gg's 4-player figures until the group has 20 games), how games were won, head to head, archnemesis, first out and last out, streaks, fun. Every rate shows its count, under 5 games it's marked provisional, and the page says when it was computed. The computer's seats and games against only the computer stay out of players' records, table rounds and online player turns are averaged apart, and the commander table reads Commander games only.

### Game export

Every finished game you played or recorded, or a whole playgroup's, as JSON (shaped for commander-decks' `data/games.json`) or CSV (one row per seat), with each game's format and starting life and whether the computer played a seat. Dates are the local day in your time zone; other people's deck names and notes stay private.

## Online play

Commander on the [Phase](https://github.com/bryanroscoe/yama-phase) rules engine (`play/`), in alpha. It needs the engine card data ([engine integration](engine-integration.md)).

- An account can have 3 games open at a time (10 with an invite, 1 for a guest); the refusal at the limit says so and how to free a place.
- A computer's seat knows the combos Commander Spellbook lists that are made only of cards on the list it plays, from Yama's weekly copy of Spellbook's combos (any list: a saved deck, a precon, a guest's; combos that also need something other than named cards are left out). Once it has every card of one, in its own main phase, it looks for a line that wins with them, on copies of the game, and plays it only if the engine carried it through to a won game; otherwise it plays as before. It also learns the deck before it plays: each list's combos (up to 40) are rehearsed once in a practice game of the list, and the answer is kept, so once that is done its tutors fetch the missing cards of the combos it can win with and it holds back the cards that finish them. The deck analysis (MCP `get_deck_analysis`) lists that plan. In online games, watched games and the lab's runs (each list is frozen with its combos when a run is made). `YAMA_AI_COMBOS=0` turns it off for new online and watched games ([how](../ARCHITECTURE.md#how-online-play-ended-up-working)).
- Lobby, friends join by code (the host can close a table that hasn't started, and delete a game that's over), choose who goes first or roll for it, AI seats (Easy/Medium/Hard) on your decks or stock precons, legal options only, auto-pass, per-seat hidden information, replay log saved after every move, games resume after a restart, final boards rebuilt from replays.
- Games carry over engine upgrades: a game left on an older engine version is replayed on the new one at startup and picks up where it was if everything checks out (the same actions and the same log), with a line in its log saying so. If it doesn't, it is closed without a winner and stays in history. Until a new engine has started, such a game takes no place among the games you may have open, and its host may delete it.
- Readable board on the Night table design: opponents across the top on their commander art, hover a card for a full-size preview (desktop), right-click, long-press or tap for the card with its rules text and your options for it.
- One big button says what it will do ("To combat", "Attack (2)", "Resolve")
- Attack and block by clicking creatures, with any legal declaration (not only the engine's sample)
- Choosing whom each creature attacks: click or tap one of your creatures and a dotted line follows the pointer from it; the players, planeswalkers and battles it may attack get an amber ring, and a click on one (or anywhere on that opponent's side) sends it there. Click more creatures first to send them together. Each attacker keeps a dotted line to whom it attacks until the attack is declared, when the lines turn solid. Click an attacker again to pick it up and send it somewhere else, or click it once more to take it out; Esc or a click on empty table puts it back, and the Attack button waits until every creature picked up has somewhere to go. A creature with only one place to attack (a two-player game with no planeswalker or battle) goes straight there on one click. Dragging still works. A creature that must attack stays in with a warning, and one that must attack a certain player won't go elsewhere. On a phone, tap the creature, then the opponent's tab or their planeswalker or battle (`web/src/play/attackAim.ts`)
- Pick a target on the board
- Pay mana automatically or by hand ("Tap mana for me", saved with your account), with Treasures, painlands, Phyrexian mana, convoke, delve, kicker and ward asked on the board
- Set your own stops on the phase ladder (saved with your account)
- Pass until something happens, pass the rest of the turn or pass to your turn (Enter, Shift+Enter, P), full control (F), hold priority and Resolve all
- Game settings for trigger yields, remembered answers (turned off there or from the log), hand order and conceding
- Read any card with its Oracle text, its state on the battlefield and its rulings, flipping two-faced cards
- Every player's graveyard, exile and command zone, each card saying how it got there
- A "may" question shows the whole card asking, who cast it at what and what it did so far ("Kraum cast Chain of Vapor targeting your Swiftfoot Boots", "Swiftfoot Boots returned to your hand"), then asks only the part that is optional ("Sacrifice a land of your choice?") with what a yes leads to; the card's full text is folded underneath and never repeated as the question
- Reveals shown to the players allowed to see them
- A game log of what happened, as each seat may know it, with filters (since your last turn, about you, spells, combat). A card that leaves the battlefield says what did it and whose it was ("Worf's Vindicate destroyed your Kinsbaile Cavalier", "Your Squire died from damage dealt by Sam's Ragavan"), with both cards' art, each opening the card reader
- Turns are numbered as the table counts them, each player's own turn count ("Worf, turn 4"), in the log, the turn banner, captions, knockouts and the end of the game; the engine's own count of every player's turn (turn 14 in a four-player game) stays in saved game records
- Play speed (Slow, Normal, Fast, Instant, saved on the device) paces the computer: its moves go out one visible step at a time, resting on each (an attack longest, longer still at you, then the blocks, then the damage; anything done to your cards about as long), twice as long on Slow as on Normal, not at all on Instant or while the tab is hidden. Your own choices are never held up, and Rewind or End game still answer at once
- When another player's spell, ability or creature does something to you or your cards (destroys, exiles, returns, steals or sacrifices one of yours, damages you or a creature of yours outside combat, drains you), a callout says who did it and how, with the cards, stays up longer on Slow (9 seconds; at least 2.5 on any speed), waits while you point at it, and can be dismissed. It never blocks the game
- What just happened: a timeline of everything since your last turn, opened from the toolbar, the game log, the recent events or a callout, stepped through with Earlier and Later (or the arrow keys), with the cards involved and an attack's, a block's or damage's arrows drawn again on the board; Rewind or Go back is a button away where the game allows it. Replaying earlier boards themselves is [a plan](plans/play-replay.md)
- Blocks are never skipped for you: the engine declares no blockers for you only when you have no creature that can block
- Knockouts with their cause (saved with the game, with who did it and how the game was won where the engine says, for playgroup stats), keep watching after you're out, and a game-over screen with standings, the game's numbers, the finish sheet's questions (how it was won, how fun it was) and Rematch
- Ways to cast asked as their own choices (what cascade and discover went through and found, an adventure's two halves, madness and miracle, a modal card's two faces, alternative costs, mutate over or under), with cards you can cast from exile or a graveyard beside your hand
- The legend rule, clones, the Ring-bearer, equip and empower Jace picked on the board
- Proliferate, and moving or removing counters with steppers
- Putting things in order (your triggers, cards going to the top or bottom of a library, your hand order) by dragging or with the arrows. With a mouse or trackpad you can drag the whole entry; with a finger, drag the six-dot grip or a card straight away, or hold an entry still for a moment and then drag it (a quick swipe still scrolls). While you drag, the entry follows the pointer, the others slide aside, a dashed slot shows where it will land, and the order changes once, when you let go (`web/src/play/reorder.ts`). Escape puts it back. The arrows stay the keyboard way to reorder, and keep focus as the entry moves
- Decisions everyone takes part in, with each seat seeing the public part (votes cast in turn order with a tally, Fact or Fiction's piles split by one player and chosen by another, a villainous choice, coins and dice kept or ignored, a clash's revealed cards)
- Choosing a player on their commander's art (a gift, an opponent who chooses or separates, who a permanent enters under)
- The library's top or bottom, the Cultivate split, Telling Time's top and bottom, manifest dread, learn, and "Done looking" after your own reveal
- The rarer cards and rules (a morph cast face down, shown as a 2/2 with no name that only its controller can read, and turned face up for its cost; ninjutsu picked from your unblocked attackers; foretell; a companion revealed before the game and put into your hand for {3}; meld, cipher, Serum Powder at the mulligan, a dungeon chosen and its next room picked on the dungeon's map, time travel with remove one, leave or add one for each card, and loop shortcuts proposed and accepted or shortened)
- Answers Yama remembers for you for the rest of a game ("Always pay" for Rhystic Study and other unless-costs in mana, your commander to the command zone), each logged with Turn off
- An art credit under every battlefield
- Phones get opponent tabs, a hand drawer and a docked button
- Watch the computer play (`/play/watch`, `server/src/watch.rs`): 2 to 4 seats on your decks or stock precons, each with its own level, at 1x, 2x, 4x or straight to the end, with pause, single steps and hands face up. Open to every signed-in account: 10 new games a day, one at a time (power users have no daily count and, with an invite, 3 at a time). The page says the limit and what is left of it.

## Lab and evidence

### Simulation lab

Since 13 Nov 2026 lab games play with the engine's loop detection, and each list in a run is frozen with the combos known in it, so the computer seats can play them ([how](../ARCHITECTURE.md#how-online-play-ended-up-working)). Results carry an engine label ending in "+loops": a finished run with earlier games is run again, not added to, and the operator's chosen simulation pools only one kind. A run that was still playing across the change holds both kinds.

One shared-field tournament with 4–256 distinct deck lists, randomized four-player pods, games-per-deck targets, optional precon benchmarks and per-engine rankings/matchups. Batch runner for all-AI games (`play/src/bin/lab.rs`, core in `play/src/lab.rs`); the Commander precon catalog and analysed rating runs imported from commander-decks, with read APIs; "Try a change" experiments played by the server (`/api/lab/experiments`, YAMA_LAB_THREADS isolated game processes, default 1). Pages under Decks, Lab: the precon table and pages (with links to EDHREC's corresponding precon guide and related articles), "Try a change", and your runs, including your imported batch runs. Needs the engine card data ([engine integration](engine-integration.md)).

Every signed-in account can start a simulation: one short run a day (20 games on Phase, one at a time; `YAMA_LAB_SHORT_DAILY_GAMES`). Power users run 100 games (100, 200 or 400 with an invite) and may choose Forge. The Try a change and Compare decks pages say the account's limit and what is left of it, a refusal says the limit, and the daily count is checked in the transaction that stores the run, so requests arriving together can't both pass. The assistant's lab tools are listed for every account.

Phase retry-tail progress shows the experiment's pending/retry counts and hides the normal-pace
ETA when only slow retries remain. A completed Phase half is labeled while Forge continues. This
is reporting, not a fix for engine stalls or changed timeout budgets.

The opt-in [lab worker pilot](lab-workers.md) lets an admin route Phase pods to saget, a laptop
or GitHub-hosted Actions, choose among available workers, and compare matching samples. It
includes owner-scoped worker keys and a manual Actions workflow; activation and deployment are
separate steps.

### Historical datasets

Lab, Datasets browses private imported commander/precon evidence, with name/type search, entity history, adjustable monthly recency summaries, source provenance and original downloads. Admins can upload prepared JSON/gzip datasets ([format](datasets.md)) and switch a source on for the precon pages, which then show each precon's dated real-game history, recent rate and trend, updated by every new upload.

Historical evidence can be imported as private, immutable [datasets](datasets.md) from JSON or
gzip, read through authenticated APIs and the `datasets`/`dataset` MCP tools, and inspected with
180-day-default descriptive monthly weighting. Overlapping snapshots, activity counts and undated
ELO sequences keep their own meanings; imports do not publish rankings or change decks and games.

### Public commander ranking

`/commanders` ranks commanders by real games alone, without sign-in: no simulations and no precon
lists. It combines the dataset sources an admin enables (Playgroup.gg and Mythic Tools), leads
with observed win rates and their game counts, and keeps each source's own rate, sample size and
attribution one click away. Reported games can overlap across services, so nothing claims a
count of unique games.

A commander that leads public decks on Yama says how many under its name, linked to them in
Browse.

### Public precon reference

The public precon reference (`/precons`) serves stock lists, experimental meta rankings,
explicitly published Phase/Forge simulation evidence, attributed real-game results and dated
market references without sign-in. The personal Lab still requires sign-in. Results are published
with `publish-precons MANIFEST`; imports never publish automatically. See
[public precons and publication](public-precons.md).

A precon's page shows what a shared deck's page shows, read from the stock list: the power level with its five scores, themes and every card's points, the commander's record, the bracket panel (Commander Spellbook's suggestion, Game Changers, mass land denial, extra turns and combos), deck stats with the mana curve and colors, and the Reserve List line.

Each precon with enough stock games also has a standing beside its rank: ahead of the pack, in the pack, behind it, or too few games to place. Precons' real win rates sit only a few points apart, so the standing reads a precon's whole record of stock games, pulls its rate toward the average by how few games that is, and names it ahead or behind only when the games show it. The rank beside it leans on recent games. A precon with fewer than 40 new games between snapshots is rated on its all-time record, trusted as 40 games at most.

A precon's page lists the public decks that started from it (the newest six, with a link to the
rest in Browse): decks whose list still holds at least half of the precon's own cards.

Precon comparisons and detail pages show [source-backed upgradeability](precon-upgradeability.md)
for the whole package: all 619 stock-compatible in-box commander configurations across 174
precons are inventoried. Eighteen configurations have supported 1–5 assessments. The table names
the highest supported in-box grade and shows how many options remain ungraded. Fantastic Four
covers all four featured commanders plus Crystal and Power Pack. Legal comparison lists, source
dates, whole-box reviews and raw commander observations remain distinct from measured list
results. Public pages, Lab, APIs and MCP share the data.

## Assistants (MCP)

Yama exposes its own MCP server at `/mcp` for Ask Claude and outside clients: private deck,
collection and planner tools; staged edits; full online card search, community recommendations,
combos, public deck imports and current rules; deck/budget analysis and bounded mana checks. No
other Magic MCP installation is needed for those workflows. Write tools stage a change that waits
in Yama for its owner to apply or discard. `move_cards` takes `proxy` to move only proxies or
only real copies (real copies go first otherwise), and collection tools treat every card with one
exact name as that card, so a token named like others (Soldier, tmsh 3) is found by set and
number (2026-11-15). `move_cards` with `to_deck_spares` puts copies in a deck's swappable spares (with `swaps_for` and `bracket` for what they come in for), `get_deck` lists them and `list_collection_cards` marks them `spares_of_deck` (2026-11-15). See the public
[MCP feature and setup guide](https://yama.ing/docs/mcp/), [capabilities and use](mcp-parity.md)
and [connection design](mcp-design.md). The private [Codex and ChatGPT plugin](codex-plugin.md)
packages this connection with deck-building, collection-planning and research skills; it is not a
public listing.
