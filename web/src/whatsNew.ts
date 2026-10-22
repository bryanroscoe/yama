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
