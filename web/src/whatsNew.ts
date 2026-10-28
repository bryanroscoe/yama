// What's new in Yama, newest first. Add an entry when something people will notice ships; the
// app shows a notice until each person opens the page (remembered per device).

export interface NewsEntry {
  /** Stable id; the notice compares it with the newest one this device has seen. */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  items: string[];
  /** Where to try it. */
  link?: { to: string; label: string };
}

export const NEWS: NewsEntry[] = [
  {
    id: "2026-10-28-shared-deck-pages",
    date: "2026-10-28",
    title: "Shared decks show what your deck page shows",
    items: [
      "A shared deck now has the deck page's legality check, your declared bracket beside Yama's suggestion and why, the Game Changers and combos behind it, deck stats, market value, and stacks of card images.",
      "Under Group, You, Sharing you can also show simulated win rates: a shared deck then shows its own lab win rate and those of its public configurations.",
      "Configurations sit in a row under each deck, and switching between them keeps the page on screen instead of going blank.",
      "Your deck page splits its value: the real cards you own, what the proxies would cost as real cards, and what's left to get.",
    ],
    link: { to: "/decks", label: "Open your decks" },
  },
  {
    id: "2026-10-28-historical-datasets", date: "2026-10-28",
    title: "Explore historical commander and precon evidence",
    items: ["Datasets under Decks lets you search imported performance observations, commander catalogs, weekly activity and source documents. Explore an entity's history and adjust the 180-day recency half-life for compatible complete-month summaries.", "Each observation keeps its source period and provenance. Original datasets remain downloadable; admins can upload prepared JSON or gzip datasets into their own accounts."],
    link: { to: "/decks/datasets", label: "Browse datasets" },
  },
  {
    id: "2026-10-28-site-polish",
    date: "2026-10-28",
    title: "More room, less clutter",
    items: [
      "Dropdowns and expandable sections have more space around their arrows. Optional explanations now sit under named details on precons, deck stats, the Lab and planner pages.",
    ],
    link: { to: "/precons", label: "Browse precons" },
  },
  {
    id: "2026-10-28-scanner-art",
    date: "2026-10-28",
    title: "A faster scanner that gets the printing right",
    items: [
      "The scanner now recognizes cards by their art. Hold a card anywhere in view, at any angle; no lining up. The first scan downloads the card recognizer once (about 40 MB).",
      "Keep adding (a switch under the camera) adds each card as soon as the scanner is sure of its printing and goes straight on to the next. Tap Added, review to see this session's cards and fix the copies, finish or printing, or take one back out; copies you owned before aren't touched.",
      "It never guesses the printing. When several printings share the art, it reads the collector number, and if that's unclear you pick from pictures of each printing; adding a printing it didn't read asks you to check the card's corner first. Choose how many copies before adding, or type a name instead.",
    ],
    link: { to: "/collection", label: "Scan cards" },
  },
  {
    id: "2026-10-28-sharing-and-configurations",
    date: "2026-10-28",
    title: "Share your decks, and keep a deck's builds together",
    items: [
      "Share a deck from its page: send a link, or list it on your profile. Friends can open it without an account, download it for Moxfield, MTG Arena or as names only, or save a copy in their own Yama.",
      "Pick a handle under Group, You for your profile at /u/handle. New decks can start shared, one button shares them all, and you can show your collection too. Everything stays private until you share it.",
      "Configurations: other builds of one deck (stock, after prints, high power) now sit under its main deck, with a switcher on the deck page and New configuration to start another.",
    ],
    link: { to: "/group#sharing", label: "Set up sharing" },
  },
  {
    id: "2026-10-28-complete-precon-commanders", date: "2026-10-28",
    title: "Assess every commander in the box",
    items: ["Precons now inventory all stock-compatible in-box commanders and checked pairs. Package summaries name the highest supported upgrade grade and show the remaining assessment gaps.", "Fantastic Four includes all four featured commanders, plus Crystal and Power Pack. Prepared legal lists can enter one shared tournament through MCP without creating saved decks."],
    link: { to: "/precons/the-fantastic-four", label: "See the complete package" },
  },
  {
    id: "2026-10-28-printed-wishlist",
    date: "2026-10-28",
    title: "Keep printed cards on a real-card wishlist",
    items: [
      "Research can keep a permanent wishlist of genuine cards even when their printed copies are already here. It stays separate from local purchase quotes, quantities to buy and order totals.",
      "Card names on the wishlist have the same hover and tap previews as the deck guides.",
    ],
    link: { to: "/decks/research", label: "Review deck research" },
  },
  {
    id: "2026-10-27-commander-options",
    date: "2026-10-27",
    title: "Compare precon commander options separately",
    items: [
      "Upgradeability now has separate commander configurations. Eleven comparison options retain the precon’s theme, with checked 100-card lists, named commanders and no borrowed simulation results.",
      "Kilo and Mister Fantastic have their own supported assessments. Other options stay ungraded where evidence is missing. On-theme swaps can use an outside commander; a replacement strategy belongs to a separate build.",
    ],
    link: {
      to: "/precons/counter-intelligence",
      label: "See separate commander assessments",
    },
  },
  {
    id: "2026-10-27-card-previews-and-build-profiles",
    date: "2026-10-27",
    title: "Inspect cards and complete bracket builds",
    items: [
      "Hover or focus card names to inspect the card. Tap names to pin a preview, including in research, decks, collection, plans, suggested changes and public stock lists.",
      "Research separates the complete 100-card deck, exact swaps and acquisition requirements. Gameplay profiles explain setup, finishers, interaction, recovery and weaknesses; Game Changer choices have reasons. Planned sealed purchases stay separate from owned cards, singles and prints.",
    ],
    link: { to: "/decks/research", label: "Review builds" },
  },
  {
    id: "2026-10-27-precon-evidence-audit",
    date: "2026-10-27",
    title: "Precon grades now show their evidence",
    items: [
      "The old upgradeability estimates have been withdrawn. Thirteen assessments now include named guides, checked card examples, commander restrictions and an explanation of every level from 1 to 5. Other lists are ungraded until their evidence supports an assessment.",
      "Deck pages also show dated commander wins and game counts from Playgroup, separately from stock-precon results. Reviews retain their authors’ original grades. The comparison and methodology text has been rewritten in plain language.",
    ],
    link: { to: "/precons/methodology#upgradeability", label: "Read the rubric and sources" },
  },
  {
    id: "2026-10-27-landing-discovery",
    date: "2026-10-27",
    title: "See what you can explore before signing in",
    items: [
      "The signed-out home page puts the public precon reference, ranking methodology and MCP setup guide in view, with a short overview of the private tools available after Google sign-in.",
      "Phone layouts show the public browsing options before the sign-in form. OAuth connections and private links keep a focused sign-in page.",
    ],
  },
  {
    id: "2026-10-27-deck-research",
    date: "2026-10-27",
    title: "Review whole deck builds in Yama",
    items: [
      "Decks, Research keeps current lists, bracket alternatives, rough power explanations, combos, local buying evidence and print requirements together.",
      "Choose a preferred build, answer individual swaps and save notes. Your answers survive research updates; changed evidence is flagged. These preferences do not install cards or approve orders.",
    ],
    link: { to: "/decks/research", label: "Open deck research" },
  },
  {
    id: "2026-10-27-mcp-guide",
    date: "2026-10-27",
    title: "A public guide to Yama's MCP",
    items: [
      "Read the complete feature catalog, setup instructions for Claude and Codex, and example requests for building and upgrading Commander decks. The guide is public and linked from About, the site footer and connection settings.",
      "The guide explains research sources, ownership and budget checks, simulation tools, and how to review proposed changes before applying them.",
    ],
    link: { to: "/docs/mcp/", label: "Read the MCP guide" },
  },
  {
    id: "2026-10-27-precon-upgradeability",
    date: "2026-10-27",
    title: "Compare precon upgrade potential",
    items: [
      "The first upgradeability estimates have been superseded by the source-backed assessment audit above. Sort supported grades in the public reference or your Lab.",
      "Current assessments name the commander and retained theme, including separately assessed commander swaps. They are editorial judgments, separate from win rates and price; unmatched changed lists need reassessment. Commander rankings are still future work.",
    ],
    link: { to: "/precons?s=upgradeability", label: "Compare upgradeability" },
  },
  {
    id: "2026-10-27-proposal-review",
    date: "2026-10-27",
    title: "Read suggested deck changes before applying them",
    items: [
      "Deck proposals show the cards to add and remove separately, with quantities, card pictures you can enlarge, and numbered explanations. Deck checks sit below the proposal. Existing suggestions use the same view.",
      "The page is now called Suggested changes. Source labels distinguish Yama’s assistant from external MCP apps without assuming which assistant made the suggestion. Nothing changes until you press Apply.",
    ],
    link: { to: "/decks/changes", label: "Review suggested changes" },
  },
  {
    id: "2026-10-27-public-precons",
    date: "2026-10-27",
    title: "A public precon reference",
    items: [
      "Anyone can browse stock Commander precon lists, dated market references and separately sourced real-game results without signing in. Reviewed simulation rankings appear when a stock benchmark is published, with game counts, uncertainty and engine limitations.",
      "Personal decks, collections, plans and simulation runs stay private. Saving a deck or trying a change still needs sign-in. Yama reserves rights in its original software, written analysis and presentation, with third-party material credited separately.",
    ],
    link: { to: "/precons", label: "Browse public precons" },
  },
  {
    id: "2026-10-27-deck-prices",
    date: "2026-10-27",
    title: "Deck market values",
    items: [
      "Your decks and the precon catalog show the estimated value of their singles, including commanders, quantities and basics. Missing prices are counted separately, with the dates and source beside the estimate.",
      "Precons also show a separate sealed deck market price when the stock product can be identified. Each stock card has a singles price. Values are market references, not store quotes or what you would receive selling a deck.",
    ],
    link: { to: "/decks/lab", label: "Compare precons" },
  },
  {
    id: "2026-10-26-tournaments",
    date: "2026-10-26",
    title: "Compare your whole collection in one tournament",
    items: [
      "Lab, Compare decks has a Tournament option. Choose your current and after-prints deck versions, add stock precon benchmarks, and run one shared experiment.",
      "Choose games per deck. Four-player pods balance appearances, vary opponents and rotate seats. Identical lists count once, and every participant contributes to the results.",
      "Results rank the field with win-share intervals and show shared-game matchups, separately for each engine. These are AI simulations, not predictions for your table.",
    ],
    link: { to: "/decks/lab/compare?mode=tournament", label: "Set up a tournament" },
  },
  {
    id: "2026-10-26-deck-stats-brackets",
    date: "2026-10-26",
    title: "Clearer deck stats and bracket suggestions",
    items: [
      "Deck stats have larger summary numbers, a mana curve and a color-access comparison that fits phones and laptops.",
      "Mana counts no longer label a color short using total pips. The page explains what potential land access includes and what an on-time casting estimate would need. Fetch lands count only colors available from matching targets in the deck.",
      "An unflagged list now starts provisionally at Core (2), including old saved estimates that showed 1. The bracket panel explains the suggestion; your declared bracket stays yours to choose.",
    ],
    link: { to: "/decks", label: "Your decks" },
  },
  {
    id: "2026-10-25-swap-checks",
    date: "2026-10-25",
    title: "Find the cards to swap",
    items: [
      "The swap sheet has alphabetical takeout lists for each deck and across all decks. Pick a deck and print the view you need; every row says what replaces the card and where the removed copy goes.",
      "Choose which sections to print: instructions, sorting checklist, deck swap tables, pictures and add/cut reasons. The page previews your selection.",
      "Printing waits for every card picture to load, including cards farther down the sheet. If a picture can't load, the page names it so you can retry.",
      "Scan either the card coming in or the card coming out to see the swap and its recorded reasons. A photo or typed name works too. It recognizes either face and works across printings, including the stand-in actually in the deck.",
      "Each plan deck links to its takeout sheet and scanner. Scanning leaves your decks, collection and installed ticks as they are.",
    ],
    link: { to: "/decks/plan/prints/swap", label: "Open the swap sheet" },
  },
  {
    id: "2026-10-23-collect-deck",
    date: "2026-10-23",
    title: "Add a deck's cards to your collection",
    items: [
      "Each deck has an Add to my collection button, and adding a deck offers it at the end. Its cards go in a deck box named after the deck, in the printing the list names (or a regular one), so the deck shows them as owned.",
      "You see what happens first: how many are in the box already, how many are added, and which you already own in the same printing in another box or binder. Move those in, leave them and add new copies, or leave them out. Nothing is ever taken from another deck's box.",
      "Adding twice adds nothing, and the deck's list never changes.",
      "Importing a newer Mythic Tools export adds only what's new instead of doubling your collection, and shows the changes before saving. Cards you've moved in Yama stay where you put them; cards the file no longer lists are only removed if you tick the box.",
    ],
    link: { to: "/decks", label: "Your decks" },
  },
  {
    id: "2026-10-23-claude-changes",
    date: "2026-10-23",
    title: "Connected assistants can suggest changes for you to approve",
    items: [
      "Ask Claude or an external MCP app can offer to change things: a deck's list, an idea or answer in a plan, a bought or installed mark, a lab run, or cards in your collection.",
      "Nothing changes until you say so. Each change appears with Apply and Discard, under the assistant’s answer and on Decks, Suggested changes.",
      "A deck edit that would break the deck (a second copy of a card, or a 100-card deck left short) isn't offered, and one made against an older version of the deck won't apply.",
    ],
    link: { to: "/decks/changes", label: "Suggested changes" },
  },
  {
    id: "2026-10-22-connect-claude",
    date: "2026-10-22",
    title: "Connect your own Claude",
    items: [
      "Claude Code and Claude's apps can read your decks, plans, Review, collection and lab runs with Yama's tools. Connect by signing in to Yama and pressing Allow; there's no key to copy.",
      "In Claude Code, add Yama with the command in Decks, Plans, Settings, then type /mcp. In Claude on the web, add a custom connector with the address shown there.",
      "Connections can now read and research cards and stage changes for review. Ask Claude leaves Apply to you; external clients can apply after you approve an exact change. Settings lists each connected app, with Disconnect.",
    ],
    link: { to: "/decks/plan/settings", label: "Connect Claude" },
  },
  {
    id: "2026-10-22-lab-compare",
    date: "2026-10-22",
    title: "Swap cards, and compare decks without changing them",
    items: [
      "Try a change: every card in the list has a Swap button that opens a card search right there, with your plan's ideas and spare cards first. The Changes panel shows each card going out and what replaces it.",
      "With no swaps, Run plays the list as it is against the opponents you chose and gives its win rate.",
      "Compare decks: two decks against the same opponents, or two to four of your decks head to head at one table, each taking every seat in turn.",
      "Against a pick of one or two of your decks, they now sit in every pod and precons of similar power fill the other seats. Finished runs can be run again with more games.",
    ],
    link: { to: "/decks/lab/compare", label: "Compare decks" },
  },
  {
    id: "2026-10-22-deck-import",
    date: "2026-10-22",
    title: "Bring your decks in",
    items: [
      "Add a deck has step-by-step help for Moxfield, Archidekt, MTG Arena, MTGO, ManaBox, Mythic Tools, TappedOut, Deckstats, EDHREC and MTGGoldfish.",
      "Paste a list, choose a file (.txt, .dek, .csv), or on Android share a list straight to Yama. Yama shows the deck before saving: the count, the commander, cards outside its colours, and names it couldn't match, with a likely card to tap.",
      "Set codes and foils from the export are kept, so exports name the printings you chose.",
      "Update from a list (on a deck's page) saves a new version and shows what goes in and out first.",
    ],
    link: { to: "/decks/import", label: "Add a deck" },
  },
  {
    id: "2026-10-22-watch-ais",
    date: "2026-10-22",
    title: "Watch the AIs play",
    items: [
      "Play online has a new Watch AIs play page. Seat 2 to 4 decks, yours or any precon in the lab, give each an easy, medium or hard computer player, choose who goes first, and watch.",
      "Pause, play one move at a time, or speed up to 2x, 4x or straight to the end. You can watch from any seat and turn every hand face up.",
      "Only you can see your watched games, and they don't count in anyone's stats. A game nobody is watching pauses, then stops after ten minutes.",
    ],
    link: { to: "/play/watch", label: "Watch AIs play" },
  },
  {
    id: "2026-10-20-open-signup",
    date: "2026-10-20",
    title: "Signing in, and room for new people",
    items: [
      "The host can open Yama to anyone with a Google account. Until then it stays invite-only, as before.",
      "There is still no sign-up with a username and password. Google checks who you are.",
      "With sign-up open, accounts that join without an invite get a smaller share of the server: 100-game lab runs, one at a time, a few a day, and two online games at once. An invite lifts it.",
      "Nobody can see anyone else's decks, collection, prices paid, plans, games or lab runs. A playgroup still needs its join code.",
      "Too many sign-in attempts, searches or join codes in a row now get a short wait, to stop guessing and floods.",
      "Admins can see every account under Group, You, and disable one: it's signed out at once and can't sign in until it's enabled.",
    ],
    link: { to: "/group", label: "Open Group" },
  },
  {
    id: "2026-10-20-sim-confidence",
    date: "2026-10-20",
    title: "The lab says which decks it can't judge",
    items: [
      "Precons the simulator is known to misjudge carry a sim unreliable mark, and lesser cases a sim doubtful mark. Tap one for why.",
      "Sorted by simulated rank, the decks it can't judge go last under their own heading. A switch can hide them.",
      "A precon's page, your batch runs and a plan's three versions say plainly when the numbers say little about real games.",
      "Try a change warns before you run a deck like Tricky Terrain, and again beside the verdict.",
    ],
    link: { to: "/decks/lab", label: "Open the lab" },
  },
  {
    id: "2026-10-19-online-board",
    date: "2026-10-19",
    title: "A new online board",
    items: [
      "Opponents sit across the top on their commander's art, in turn order, with life, cards in hand and commander damage to you.",
      "One big button says what it will do: To combat, Attack (2), Resolve or End turn. Space presses it on a laptop.",
      "Attack with any of your creatures, at whichever opponents you choose, and make any blocks: click the creatures, then the player or attacker.",
      "Pick targets on the board. Legal targets get an amber ring.",
      "Click the dots on the phase ladder to choose where the game stops for you.",
      "Graveyards and exile open from each player. Double-click a card to play it, or right-click to read it.",
      "Tapped cards turn their art, so their names stay readable.",
      "Play online and the lobby show every seat's commander art, and your games say who won.",
    ],
    link: { to: "/play", label: "Open Play" },
  },
  {
    id: "2026-10-19-calendar",
    date: "2026-10-19",
    title: "Release calendar",
    items: [
      "The Cards page lists upcoming sets, with release dates and how many cards Scryfall has so far.",
      "Tap Watch on a set to follow its Commander precons. Star Trek Commander is on the list.",
      "When a watched set's precon lists are published, the Cards page names each deck and its commander.",
      "Start a deck from any of them. Yama fills in the stock list for you to check and save.",
      "Yama checks Scryfall and MTGJSON for new sets and lists once a day.",
    ],
    link: { to: "/cards", label: "Open Cards" },
  },
  {
    id: "2026-10-19-table-stats",
    date: "2026-10-19",
    title: "Game night and group stats",
    items: [
      "Each player's commander art sits behind their life total. The table menu switches back to mana colors.",
      "Roll for first or pick who goes first. Yama remembers it and counts rounds from that player.",
      "Knocking someone out asks who did it.",
      "The finish sheet asks how the game was won and how fun it was. Both are optional.",
      "The Group page shows rivalries: head to head, archnemesis, first and last out, and streaks.",
      "Win rate by turn order sits beside playgroup.gg's figures until your group has 20 four-player games.",
      "Every rate shows its count, and anything under 5 games is marked provisional.",
      "Deck pages show results for each version, like “This version: 2-4, 6 games”.",
      "Export your games as JSON or CSV from the Group page.",
    ],
    link: { to: "/group", label: "Open Group" },
  },
  {
    id: "2026-10-19-fixes",
    date: "2026-10-19",
    title: "Fixes",
    items: [
      "Guest players' names show in stats and recent games again, instead of Unknown.",
      "Log a game no longer records the wrong winner when a seat is left blank.",
      "Pressing Save twice no longer logs the same game twice.",
      "A game you only watched isn't put on your record.",
    ],
  },
  {
    id: "2026-10-19-decks",
    date: "2026-10-19",
    title: "Deck brackets, stats and exports",
    items: [
      "Declare a bracket from 1 to 5 in Edit deck. It shows on the deck list, at the table and in the online lobby.",
      "Commander Spellbook estimates each saved version's bracket and lists its Game Changers, mass land denial, extra turns and combos.",
      "Deck pages show the mana curve, average mana value, land count, and colored pips against land sources.",
      "Export a deck for EDHbots, Moxfield or MTG Arena.",
      "History lists every saved version and shows what changed between any two.",
    ],
    link: { to: "/decks", label: "Open Decks" },
  },
  {
    id: "2026-10-19-cards",
    date: "2026-10-19",
    title: "Card details",
    items: [
      "The card sheet shows rulings, with their dates and sources.",
      "Game Changers are tagged on the card sheet and counted on deck pages. Search for them with is:gamechanger.",
      "Deck pages say how many cards online play supports, and name the ones it doesn't.",
      "In an online game on a computer, Read card opens the selected card with its rulings.",
      "Card images use Scryfall's new WebP files.",
    ],
    link: { to: "/cards", label: "Open Cards" },
  },
];

export const SEEN_KEY = "yama.whatsNew.seen";

/** Entries newer than the one this device last saw: all of them if it saw none, or saw one
 *  that's no longer listed. */
export function unseen(entries: NewsEntry[], seenId: string | null): NewsEntry[] {
  if (!seenId) return entries;
  const i = entries.findIndex((e) => e.id === seenId);
  return i < 0 ? entries : entries.slice(0, i);
}

/** The notice's line, or null when there's nothing to say. A device that has never opened the
 *  page gets an invitation, not a count of updates "since you last looked". */
export function noticeLine(entries: NewsEntry[], seenId: string | null): string | null {
  const fresh = unseen(entries, seenId);
  if (!fresh.length) return null;
  if (!seenId) return "Yama keeps a list of what's new.";
  return fresh.length === 1 ? `New in Yama: ${fresh[0]!.title}.` : `Yama has ${fresh.length} updates since you last looked.`;
}
