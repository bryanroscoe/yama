// "How to get your deck out of…": one short guide per place people keep decks. Steps name the
// buttons as each site labels them (checked 22 Oct 2026; docs/deck-import.md lists the sources).
// Where a site doesn't let other apps read its decks, its guide says so and shows copy and paste.

export interface Guide {
  key: string;
  name: string;
  /** Numbered steps, short enough for a phone. */
  steps: string[];
  /** One line on what the export keeps or what Yama does with it. */
  note?: string;
}

export const GUIDES: Guide[] = [
  {
    key: "moxfield",
    name: "Moxfield",
    steps: [
      "Open your deck on Moxfield.",
      "Tap More, then Export.",
      "Choose Copy for Moxfield. It keeps your printings and foils. Copy for MTGA works too.",
      "Come back here and paste the list.",
    ],
    note: "Moxfield links can't be opened by other apps (Moxfield doesn't allow it), so copy the list. A downloaded .txt file works too.",
  },
  {
    key: "archidekt",
    name: "Archidekt",
    steps: [
      "Open your deck on Archidekt.",
      "Open the deck's menu (⋯) and choose Export.",
      "Pick the text format (plain text or MTG Arena) and copy it. If you can include categories, leave them on.",
      "Come back here and paste the list.",
    ],
    note: "Yama reads Archidekt's Commander, Sideboard and Maybeboard categories, set codes and foils.",
  },
  {
    key: "arena",
    name: "MTG Arena",
    steps: ["Open Decks and select your deck.", "Choose Export. Arena copies the list.", "Paste it here."],
    note: "Arena's Commander, Deck, Sideboard and Companion sections all come through.",
  },
  {
    key: "mtgo",
    name: "MTGO",
    steps: [
      "In your Collection, find the deck in the deck list.",
      "Right-click it and choose Export. Save it as a .dek or .txt file.",
      "Choose that file here (Choose a file).",
    ],
    note: "MTGO keeps a Commander deck's commander in the sideboard. Yama spots it and asks you to confirm.",
  },
  {
    key: "manabox",
    name: "ManaBox",
    steps: [
      "Open the deck and tap ⋯ at the top right.",
      "Choose Export for a text file, or Share, then Custom text file.",
      "On Android, share it straight to Yama. On iPhone, save it to Files and choose it here, or copy the text and paste.",
    ],
  },
  {
    key: "mythic",
    name: "Mythic Tools",
    steps: [
      "Export your cards from Mythic Tools as a CSV file.",
      "Choose that file here.",
      "Every deck in it becomes a deck you can add. Boxes and binders are your collection: bring those in on the Collection page.",
    ],
    note: "Mythic Tools' CSV doesn't say which card is the commander, so Yama asks.",
  },
  {
    key: "tappedout",
    name: "TappedOut",
    steps: ["Open the deck on TappedOut.", "Choose Export, then MTGO (or plain text).", "Copy the list and paste it here."],
    note: "If the commander isn't marked with *CMDR*, Yama asks who leads the deck.",
  },
  {
    key: "deckstats",
    name: "Deckstats",
    steps: ["Open the deck on Deckstats.", "Choose Export and the text format.", "Copy the list and paste it here."],
    note: "Yama reads Deckstats' set codes and its !Commander tag.",
  },
  {
    key: "edhrec",
    name: "EDHREC",
    steps: ["Open an average deck (or any deck page).", "Tap Export and copy the list.", "Paste it here."],
    note: "The commander comes first. Yama takes it as the commander and asks you to confirm.",
  },
  {
    key: "mtggoldfish",
    name: "MTGGoldfish",
    steps: ["Open the deck on MTGGoldfish.", "Use the copy or download buttons (any text format).", "Paste the list here, or choose the downloaded file."],
  },
  {
    key: "text",
    name: "Typed or other",
    steps: [
      "One card per line: 1 Sol Ring, 1x Sol Ring or just Sol Ring.",
      "Put Commander on its own line above your commander. Without it, Yama asks who leads the deck.",
      "Set codes like (C21) 263 and foil marks like *F* are kept.",
    ],
  },
];

/** The guide for a site a pasted link pointed at. */
export function guideFor(site: string | null | undefined): Guide | undefined {
  return GUIDES.find((g) => g.key === site);
}
