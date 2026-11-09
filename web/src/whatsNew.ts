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
    id: "2026-11-09-your-profile",
    date: "2026-11-09",
    title: "Your profile, easier to find",
    items: [
      "Click your name or Your profile to find your collection, wish list, decks, plans and account settings.",
      "Open your public profile or copy its link from the same page, with links to your collection and wish list when you share them.",
    ],
    link: { to: "/profile", label: "Your profile" },
  },
  {
    id: "2026-11-09-assistant-games-collection",
    date: "2026-11-09",
    title: "Your assistant can read your games and playgroups",
    items: [
      "A connected assistant can now search your game history as the Game history page does, read one game, list your playgroups and read a group's stats.",
      "It can also read your collection's totals and each binder, deck box and list with its dated market value, as the Collection page shows them.",
    ],
    link: { to: "/docs/mcp/", label: "See every tool" },
  },
  {
    id: "2026-11-08-deck-power-level",
    date: "2026-11-08",
    title: "A deck's power level, vector by vector",
    items: [
      "Every deck's page has a new Power level panel. It shows an unofficial 1 to 10 score with its margin, and five scores out of 100: Speed, Consistency, Interaction, Mana base and Threats. A typical stock precon is about 40 on each and a typical Bracket 4 build about 75.",
      "How it adds up lists every card's points. It also names the deck's themes, and shows how the score moved across your saved versions and between a deck's configurations.",
      "The score now counts your lands by what they do, and it no longer needs a Commander Spellbook check to appear (combos count once there is one).",
      "Check it on ScryCheck copies the list and opens ScryCheck, so you can paste it there and compare.",
    ],
    link: { to: "/decks", label: "Open Decks" },
  },
  {
    id: "2026-11-08-shared-power-estimate",
    date: "2026-11-08",
    title: "Power estimate on shared decks",
    items: [
      "A shared deck's page now shows the power-level estimate beside its brackets, with how it adds up: each factor's points, its rule and the cards behind it, as on your own deck page.",
      "Your assistant's deck analysis includes the same estimate.",
    ],
  },
  {
    id: "2026-11-08-delete-decks",
    date: "2026-11-08",
    title: "Delete a deck or a configuration",
    items: [
      "On a deck's page, More now ends with Delete deck, or Delete configuration when you're on one. Deleting a deck with configurations asks whether to keep them as decks of their own or delete them too.",
      "Your assistant can delete one for you as well; it waits in Suggested changes with a Delete button until you press it.",
    ],
    link: { to: "/decks", label: "Open Decks" },
  },
  {
    id: "2026-11-05-plans-by-deck",
    date: "2026-11-05",
    title: "Plans, deck by deck",
    items: [
      "Plans shows one tile per deck, however many plans cover it. Each deck's page switches between its plans.",
      "Answer proposed changes right beside them on a deck's page, tracked decks included. Review now lists the decks with answers waiting.",
      "Each change on a plan's page shows its cards' pictures, as shared plans do. A note for your assistant says where it's saved.",
      "Checkboxes are back to a normal size on every page.",
    ],
    link: { to: "/decks/plans", label: "Open Plans" },
  },
  {
    id: "2026-11-05-track-this-build",
    date: "2026-11-05",
    title: "Track a plan's build",
    items: [
      "On a plan's deck page, Track this build makes it your plan for that deck: its cards to buy go on your buy list and store trip, its prints on Prints, and each change shows whether its card is in the deck, bought or still to get. Switch builds or stop at any time.",
      "A plan's shopping list now starts at your own shopping rule's buy limit when you've set one.",
      "Your assistant can track a build for you too; it waits in Suggested changes, tagged Plan, until you apply it.",
    ],
    link: { to: "/decks/plans", label: "Open Plans" },
  },
  {
    id: "2026-11-04-steadier-navigation",
    date: "2026-11-04",
    title: "Steadier navigation",
    items: [
      "Sharing keeps the Decks sections at the top, like the rest of Decks. Suggested changes and Add a deck keep Decks chosen there, and the tab bar stays lit on every page inside a tab.",
      "Datasets moved to the Lab, beside the precons their evidence feeds. Old links still work.",
    ],
  },
  {
    id: "2026-11-04-one-plan-page",
    date: "2026-11-04",
    title: "Plans look the same everywhere",
    items: [
      "A plan your agent saved, or a copy of one someone shared, now opens on the same page as its shared link: commander art for each deck, its builds, how to pilot it, the changes with their reasons, a shopping list priced at market and the full lists to copy.",
      "Your own extras stay on your page only: sharing, your answers for the agent and the agent's store checks.",
      "Agent notes are now under Plans, beside the decks you're tracking. Dates now show on your own calendar.",
      "Builds is now Swap cards: builds are named plainly (Bracket 3: Upgraded), and the changes between two lists show with each plan's reason before you print them for the deck box.",
      "Every Plans page, Swap cards and Suggested changes now says what it's for, where its contents come from and what to do there. What only an AI assistant connected to Yama can make (plans, swap proposals, suggested changes) says so, with a button to connect one.",
    ],
    link: { to: "/decks/plans", label: "Open Plans" },
  },
  {
    id: "2026-11-03-buylist-references",
    date: "2026-11-03",
    title: "Buylist prices by printing",
    items: [
      "A deck's page now lists dated Card Kingdom buylist prices for your near-mint real copies, each by its own printing and finish, via MTGJSON.",
      "Missing prices stay unknown; proxies and condition mismatches are excluded. Premium basics and small offers stay visible by printing for individual review. Public references are never added into an unverified resale total, and the market estimate stays separate.",
      "Yama now also keeps Card Kingdom's retail prices and Mana Pool's lowest listings each day, each as its own series.",
    ],
  },
  {
    id: "2026-11-02-local-sell-offers",
    date: "2026-11-02",
    title: "Mothership buylist offers",
    items: [
      "Open Collection, Sell list, Local buylist offers to check Mothership's cash and credit offers for your selected printings.",
      "Checks stay in your private history. Exact matches and shared quantity limits determine the total; unknown printings stay out. A check never submits a sale.",
    ],
    link: { to: "/collection", label: "Open your collection" },
  },
  {
    id: "2026-11-02-sell-list",
    date: "2026-11-02",
    title: "Sell lists for store buylists",
    items: [
      "Collection has a Sell list: the cards you're looking at, as a file or list a store's buylist takes. Pick SortSwift (upload the CSV), Storepass (paste into Bulk Submission) or Card Kingdom.",
      "Narrow it to cards worth at least an amount, untick any card or sell only some copies. Cards in deck boxes and proxies stay out.",
      "To pick cards by hand, put them in a list and open that list first. The store's page shows its offer before you send anything.",
    ],
    link: { to: "/collection", label: "Open your collection" },
  },
  {
    id: "2026-11-02-play-alpha",
    date: "2026-11-02",
    title: "Online play is marked alpha",
    items: [
      "Play now carries an Alpha tag. Online games work, but expect bugs and slow turns while the rules engine and its board are finished. The life counter isn't affected.",
      "Play's pages ask Yama for news less often, and not at all while they're hidden.",
    ],
    link: { to: "/play", label: "Open Play online" },
  },
  {
    id: "2026-11-02-faster",
    date: "2026-11-02",
    title: "Yama opens faster",
    items: [
      "Each part of Yama now loads the first time you open it, so the first screen waits for a fifth of the code it used to. Until a page arrives you see its outline.",
      "Yama opens as the account you last used here, without waiting for the server to say who you are.",
      "Once you've opened Yama online, every page is saved on your device, so pages you haven't visited yet open offline too.",
      "The card list saved on your phone is read only when an offline search or scan needs it, not every time Yama opens.",
      "Collection shows 200 more cards at a time instead of every card at once, and the name filter waits for you to stop typing.",
    ],
  },
  {
    id: "2026-11-02-sharing-navigation",
    date: "2026-11-02",
    title: "Find your shared decks and builds again",
    items: [
      "Open Sharing at the top of the main app pages to find your public profile, shared decks, alternate configurations and shared build notes. Open what your friends see, copy a link or return to edit it.",
      "Sharing settings live there too. Precons, Commanders and the MCP guide are always reachable from the same row.",
    ],
    link: { to: "/sharing", label: "Open Sharing" },
  },
  {
    id: "2026-11-01-delete-account",
    date: "2026-11-01",
    title: "Delete your account yourself",
    items: [
      "Group, You now has Delete account. It deletes your account and everything in it once you type your email to confirm. Games you played with other people stay in their history without your name.",
    ],
    link: { to: "/group#delete-account", label: "Open Group, You" },
  },
  {
    id: "2026-11-01-table-first-spin",
    date: "2026-11-01",
    title: "Picking who goes first, with a spin",
    items: [
      "Pick at random now runs a light round the players and slows onto the one it picked, then shows their art. The pick is made the moment you tap; the spin only shows it.",
      "Who goes first, the dice, and the out-of-the-game and knock-out questions open in the middle of the screen, where everyone round the phone can see them.",
    ],
  },
  {
    id: "2026-11-01-table-danger",
    date: "2026-11-01",
    title: "The life counter warns when someone is close to out",
    items: [
      "A player's panel glows red around the edge when they're close to losing: a quarter of their starting life left (10 in Commander), 7 poison, or 16 damage from one commander. It beats faster once they're one hit from out, and a badge says why.",
    ],
  },
  {
    id: "2026-11-01-table-awake",
    date: "2026-11-01",
    title: "The life counter keeps your screen on",
    items: [
      "Your phone no longer goes to sleep during a game. Yama asks again to keep the screen on each time you come back from another app or unlock the phone, and phones following a shared table stay awake too.",
    ],
  },
  {
    id: "2026-11-01-shopping-settings",
    date: "2026-11-01",
    title: "Your buy rule, your favourite store, and lists to paste",
    items: [
      "Plan settings has your buy rule: the most a card may cost, the price that's always fine, how far over market you'll go, and the most for a sealed precon. A change applies from today, so older checks keep the rules of their day, and a plan import won't replace it.",
      "On the Trip page, mark a favourite store you want to support: it's on every trip it has a card for, and you can let it charge a little more. Put your stores in order of how easy they are to get to, and untick the ones you're not going to this time.",
      "Each store has its list to copy and its cart link where the store has one. Stores on TCGplayer Pro get a search link for each card, and what's left has a TCGplayer Mass Entry link to compare online.",
    ],
    link: { to: "/decks/plans/get/trip", label: "Store trip" },
  },
  {
    id: "2026-11-01-store-trip",
    date: "2026-11-01",
    title: "Plan a trip to your stores",
    items: [
      "Plans has a Trip page: the fewest of your stores that have the cards you're buying under your shopping rule, with each store's cards, total and cart, and what to print instead.",
      "Mark each store as your usual one, fine, maybe or one you won't go to. The trip never sends you to a store you won't go to.",
      "Proposals you haven't decided on and your real-card wishlist come along from stores you're visiting anyway. Listings are the dated checks in your plan, not a promise the card is still there.",
    ],
    link: { to: "/decks/plans/get/trip", label: "Store trip" },
  },
  {
    id: "2026-11-01-lab-tables",
    date: "2026-11-01",
    title: "See what happened at every table of a lab run",
    items: [
      "In a head-to-head or tournament run, every deck's name opens its own page: how it placed, who it sat with and how it did against each, and every table it played at with the commanders' art.",
      "Open a table to see its four games one by one: who went first, the finishing order, the turn each deck was knocked out, and the life left when a game hit the cap.",
      "Head to head now says it in words, such as \"Lorehold Spirit finished higher than Fantastic Four in 3 of 4\", and marks pairs with too few games to tell.",
      "New tournaments keep versions of the same deck (yours, the stock list, a variant) at separate tables while every deck still plays as often as the others. In a big field they never meet; in a very small field with several versions they sometimes have to.",
    ],
    link: { to: "/lab/runs", label: "Open my runs" },
  },
  {
    id: "2026-11-01-no-account-counter",
    date: "2026-11-01",
    title: "Count life without an account",
    items: [
      "Anyone can use the life counter without an account: Yama opens on it, with the usual nav, and the sign-in page links to it. Games counted that way stay on that phone.",
      "If they sign in later, the Table page asks whether to save those games to their account. Sharing a table with everyone's phones still needs an account; joining one by its code doesn't.",
    ],
  },
  {
    id: "2026-11-01-whos-playing",
    date: "2026-11-01",
    title: "New game: tap who's playing",
    items: [
      "Pick Friends or one of your playgroups, then tap the people at the table. Each one takes the next seat; tap again to take them off. Playgroup members' games count for them, and friends from past games sit as guests.",
    ],
    link: { to: "/", label: "Start a game" },
  },
  {
    id: "2026-11-01-table-pass",
    date: "2026-11-01",
    title: "Life counter: finish, edit players, take commander damage",
    items: [
      "Finish the game leads the table menu: tap the winner's picture (or It was a draw), and a player's sheet has \"Sam won\" too. Leave the table keeps the game going; Discard game throws it away.",
      "Tap a player's name to change who's sitting there or what they're playing, mid-game: rename them, pick them from your playgroup so the game counts for them, or switch decks.",
      "Commander damage the Lifetap way: tap the shield on the panel taking damage, then + on whoever's commander hit them. The swords still deal it from the attacker.",
      "Turn counting is off unless you turn it on (Count turns, in the menu). Each game still opens by asking who goes first, or picks someone at random.",
      "Picking one of your decks asks which list next (main, stock, after prints), and a deck that lists several commanders asks which one is playing. Poison reads as 3 / 10, and the other counters stay open.",
      "Install Yama from the Table page to get it full screen, or use Full screen in the menu.",
    ],
    link: { to: "/", label: "Start a game" },
  },
  {
    id: "2026-11-01-fix-a-printing",
    date: "2026-11-01",
    title: "Fix a card's printing in your collection",
    items: [
      "Tap a card on the Collection page and choose Change printing to pick the right one from every printing of that card, with its picture, year and price.",
      "Or choose Rescan this card and hold it up to the camera: the printing you confirm replaces the old one. A different card is refused, so nothing changes by mistake.",
      "With several copies in one row, change all of them or just one. Copies stay where they live, in the same condition.",
      "Delete from collection removes the whole row, after you confirm.",
    ],
    link: { to: "/collection", label: "Open your collection" },
  },
  {
    id: "2026-11-01-table-relay",
    date: "2026-11-01",
    title: "Everyone's phones: no account needed, and it keeps going if Yama's server is down",
    items: [
      "Friends who scan the join code no longer sign in to Yama: the code is all they need.",
      "Shared tables now meet on Cloudflare instead of Yama's own server, so a game everyone follows keeps going even when Yama's server or its internet connection is down. The host's phone still keeps the game and uploads it when it can.",
    ],
    link: { to: "/", label: "Start a game" },
  },
  {
    id: "2026-11-01-check-a-deck",
    date: "2026-11-01",
    title: "Check a deck box card by card",
    items: [
      "On a deck, Check this deck (under More actions on a phone) flips through the physical deck with the camera. Each card shows at once, in green or red with a sound, whether it belongs or has to come out, and warns about a second copy.",
      "Pick what the box should match: the deck's current list, another configuration or saved version, your plan's after-prints list or bracket builds, or a research build.",
      "For a card to take out it says what goes in instead and where that card is, when Yama knows. A running count shows what's left to take out and what's still missing.",
      "Nothing is saved. Mute it from the page; the setting stays on this device. Save as a deck scan turns the check into a normal scan if you want the list saved.",
    ],
    link: { to: "/decks", label: "Open your decks" },
  },
  {
    id: "2026-10-31-table-layouts-join",
    date: "2026-10-31",
    title: "Life counter: panel layouts, join from the start, dice",
    items: [
      "New game asks how the panels sit (two a side, one each side, everyone facing the screen, and more for each player count) and whether everyone keeps their own phone. With everyone's phones on, the join code fills the screen as the game opens; a green dot on the middle button shows the table is shared.",
      "Save and play again starts a rematch with the same seats, and phones that joined follow it without scanning again.",
      "Delete a game you recorded from the bottom of its page, for a test game or one entered by mistake. Discarding a game in progress now removes it from Yama too, instead of leaving it in Recent games as still going.",
      "Turns are only counted if you start passing the turn from the menu, so a game nobody counted doesn't go in the stats as one turn long.",
      "Dice (d4 to d20 or any size, up to three at once), a coin, a random player, and Shuffle the seats at setup. Storm, treasure and the city's blessing join the counters; tap a player's total on their sheet to type a new one. Partner commanders share their panel's art, and a landscape screen turns the whole layout to fit.",
    ],
    link: { to: "/", label: "Start a game" },
  },
  {
    id: "2026-10-31-power-users",
    date: "2026-10-31",
    title: "Simulations and Ask Claude for power users",
    items: [
      "Starting simulations, watching AI games and Ask Claude are open to admins and power users for now, because they take a lot of the server. Ask the host if you'd like to be a power user.",
      "Simulation results stay open to everyone: the Lab's precon rankings and your own earlier runs are where they were.",
    ],
    link: { to: "/lab", label: "Precon rankings" },
  },
  {
    id: "2026-10-31-power-estimate",
    date: "2026-10-31",
    title: "An estimate on the older 1 to 10 power scale",
    items: [
      "A deck's Bracket panel now translates the list into the older power-level scale, for playgroups that still talk in it: the suggested bracket sets the range and cheap mana, draw, interaction, tutors, the curve, Game Changers and combos move it within it.",
      "It's an unofficial Yama estimate from the card list, not how the deck plays. Open How the power estimate adds up to see every factor and the cards behind it.",
    ],
  },
  {
    id: "2026-10-31-scan-closeups-switch",
    date: "2026-10-31",
    title: "Scan with a camera that stays put",
    items: [
      "The scanner's close-up step is now a switch under the camera. Leave Close-ups on to hold the phone near the set code and number when several printings share the art. Turn it off for a stand or card feeder: the scanner reads the whole card and asks you to tap the printing when that isn't enough.",
    ],
    link: { to: "/collection", label: "Scan cards" },
  },
  {
    id: "2026-10-31-seat-search",
    date: "2026-10-31",
    title: "Find players and decks when you seat a game",
    items: [
      "New game and Log a game find anyone on Yama by their @handle, as well as your playgroups and past games. Someone found by handle plays as a guest unless they're in the playgroup you chose.",
      "Each seat's Deck field searches the player's public decks, your own decks (lent, on someone else's seat) and the precons. Picking one fills in its commanders, or just pick a commander as before.",
      "Log a game can remove a player, and Who went first? has a Don't remember answer, here and at the end of a table game.",
      "Games you logged can be edited: open one and choose Edit this game.",
      "Logging a night of games? Save and log another keeps the same players and decks for the next one, and any game's page has Log another like this.",
    ],
    link: { to: "/", label: "Log a game" },
  },
  {
    id: "2026-10-29-precon-real-history",
    date: "2026-10-29",
    title: "Precon pages show real games over time",
    items: [
      "A precon's page now shows its playgroup.gg results over time: the all-time win rate, the rate in the games played since the earliest snapshot, and whether it's rising or falling.",
      "Precons playgroup.gg doesn't rate show their commander's own figure instead, labelled as every list under that commander.",
      "An experimental rating v2 combines real games with the simulation, but only gives the simulation weight if it has proved it predicts later real games. Tournaments in the Lab also show each deck's fitted strength, which accounts for who it sat with.",
    ],
    link: { to: "/lab", label: "Open the precons" },
  },
  {
    id: "2026-10-29-swap-cards",
    date: "2026-10-29",
    title: "Bracket swap cards for your deck boxes",
    items: [
      "Print a card-sized note for each deck box: the bracket it's kept at, what comes out and goes in for each step down, with Game Changers marked. Going up, do the swaps in reverse.",
      "Print all swap cards is under Your plans, nine to a page with cut lines. A deck's own card is on its Brackets tab and in its Bracket bags panel. Print at actual size from a computer; on a phone the cards are easy to read.",
    ],
    link: { to: "/decks/plans/get/swap-cards", label: "See your swap cards" },
  },
  {
    id: "2026-10-29-scan-a-deck",
    date: "2026-10-29",
    title: "Scan a deck into Yama",
    items: [
      "On a deck, Scan this deck (under More actions on a phone) scans the physical deck card after card with the camera. A typed name or a photo works too. It counts toward 100, shows whether the commander is in, and lets you fix a misread card or remove one scanned twice.",
      "Before saving you see the cards going in and out, what stays, and the Commander checks: 100 cards, singleton, colors and legality.",
      "The scan is saved as a new version. Choose whether it becomes the deck's list (which your plan reads installs from); the old list stays in History to switch back to.",
    ],
    link: { to: "/decks", label: "Open your decks" },
  },
  {
    id: "2026-10-29-table-pass",
    date: "2026-10-29",
    title: "A better table: search, partners, a knock-out check and two phone views",
    items: [
      "New game searches for players (you, your playgroups and people from your recent games) and for commanders, with their art in the list. Partners and Backgrounds get their own field, and a deck with two commanders brings both.",
      "Pick the game first: Commander at 40, a 20-life game, or something else. Start says what it starts.",
      "When someone reaches 0 life, 10 poison or 21 damage from one commander, the table asks whether they're out and who did it. A card that keeps them in? Say not out.",
      "Tap the swords on a panel to deal that commander's damage: every other panel turns into its counter. Life comes off too.",
      "A seat can change commanders mid-game from its player sheet. Energy, experience and rad sit under Other counters, with what uses each.",
      "Following on your phone: switch between My seat and Whole table, and tap anyone to see or change their totals.",
      "Recent games open to their details and a turn-by-turn history. A game still going can be followed live or carried on from your laptop. On a laptop the panels face the screen; the table menu switches it.",
    ],
    link: { to: "/", label: "Start a game" },
  },
  {
    id: "2026-10-28-review-installs-lab",
    date: "2026-10-28",
    title: "A clearer Review, installs read from your decks, and a Lab tab",
    items: [
      "Review is one to-do list: proposals still waiting for your answer come first. Answered proposals and swaps already in the plan sit underneath, closed, so nothing looks done when it isn't.",
      "A plan's installed swaps now come from the deck itself: a swap is in when its card is in the deck's current list and the card it replaces is gone. The deck page says which list is in the deck and puts a configuration's list (stock, after prints) in with one tap; History restores any earlier list.",
      "The Lab has its own tab. Old links under Decks still open it.",
      "Research is now called Agent notes: what Claude and other agents save for each other. Nothing there needs you; anything you should decide shows up in Review.",
    ],
    link: { to: "/decks/plans", label: "Open Plans" },
  },
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
    items: ["Datasets in the Lab lets you search imported performance observations, commander catalogs, weekly activity and source documents. Explore an entity's history and adjust the 180-day recency half-life for compatible complete-month summaries.", "Each observation keeps its source period and provenance. Original datasets remain downloadable; admins can upload prepared JSON or gzip datasets into their own accounts."],
    link: { to: "/lab/datasets", label: "Browse datasets" },
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
    link: { to: "/sharing", label: "Set up sharing" },
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
    link: { to: "/decks/research", label: "Open agent notes" },
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
    link: { to: "/decks/research", label: "Open agent notes" },
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
    link: { to: "/decks/research", label: "Open agent notes" },
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
    link: { to: "/lab", label: "Compare precons" },
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
    link: { to: "/lab/compare?mode=tournament", label: "Set up a tournament" },
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
    link: { to: "/decks/plans/get/swap-sheet", label: "Open the swap sheet" },
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
    link: { to: "/decks/plans/settings", label: "Connect Claude" },
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
    link: { to: "/lab/compare", label: "Compare decks" },
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
    link: { to: "/lab", label: "Open the lab" },
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
