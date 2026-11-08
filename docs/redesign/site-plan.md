# Yama site design pass: plan

Bryan, 8 Nov 2026: "I think the whole site needs another pass ... we need a better design in general for this site."
Design only. No agent edits the app or Yama data in this pass; each area ends in a canvas Bryan approves and a short spec.

## Shared rules for every design agent
- Read yama AGENTS.md, ARCHITECTURE.md "Interface copy", design/tokens.md, design/README.md, and the screens in design/screens/ for the area.
- Design system: "Yama Night table", https://claude.ai/artifact/KATy3ZHwCt9ikAJnHMBSha (Design System artifact, private to Bryan).
  Use it as is. Proposed token or component changes go in this folder's TOKENS-PROPOSALS.md; only the coordinating agent edits the system.
- One canvas per area, owned by one agent (no two agents write the same canvas). Laptop (1440, expand fill) and phone (390) boards.
- Shared patterns already settled on the plans canvas (https://claude.ai/artifact/2ekfB9CSeU3VLLf9GwAM91):
  art hero with bottom wash and credit; one status pill per thing; version/date/source as a plain line;
  a change shows both cards (in, arrow, out; tap for the full card); one primary button per view;
  segmented control for a filter of the same content, never tabs that hide unrelated content.
- Real data only, read-only (commander-decks files, the live site in a browser if Bryan is signed in). [n] where unknown.
  Never commit, upload or paste real people's data.
- Write status to <area>/STATUS.md in this folder; read the other areas' STATUS.md before starting and when finishing.

## Existing design files (read before designing)
- "Yama app screens" canvas, https://claude.ai/artifact/A54Pqc1rPe5U8c4ipARc1q: page "Night table" (every screen, laptop and phone, 19-24 Oct) and page "Game interactions". Sources mirrored in yama design/screens/*.dc.html.
- "Yama name and logo", https://claude.ai/artifact/RQsQsstMR1vQA6vrBtA11Y (design/logo/).
- "Yama redesign" (first called "Yama plans redesign"; the deck page joined it), https://claude.ai/artifact/2ekfB9CSeU3VLLf9GwAM91 (this pass, areas 1 and 2).
- "Yama Night table" design system, https://claude.ai/artifact/KATy3ZHwCt9ikAJnHMBSha.
The live app has drifted from the Oct screens; design from the live app's code and features, using the screens for the visual language.

## Controls audit, first step in every area (Bryan, 8 Nov)
"A lot of the menus and dropdowns are either kind of weirdly formed or weirdly spaced. They have weird dropdowns that have
way too many things pop up. They're missing a lot of tasks and features."
Before drawing, list for the area, from the code (and the live site when Bryan is signed in to the browser):
1. Every menu, dropdown, select, popover and sheet: where it is, what opens it, every item in it, and what is wrong
   (too many items, mixed kinds of action, odd spacing or alignment, a select used where a button or segmented control belongs).
2. Every task a person comes to the area to do, and whether the page lets them do it, how many steps, and what is missing.
Write it to <area>/AUDIT.md. The design must answer each line, and the canvas gets a board "Menus and controls" showing the
new version of each one. House rules for controls: a menu holds at most about 7 actions of one kind; destructive actions last
and separated; a choice of 2-5 visible options is a segmented control or buttons, not a dropdown; long pickers search;
items align on one 44 px grid with 12-16 px padding.

## Laptop density and page structure (Bryan, 8 Nov; now in the design system README, "Density, actions and page structure")
Bryan: the bubble buttons are "too big and too hard to use", the inline More expander "sucks", things touch the element
before them with "no padding", there are "so many expandable areas" you scroll all around, and it "performs very poorly on desktop".
- Two densities: laptop controls 36 px (primary 40, row actions 32, 10 px corners on secondaries); phones keep 44 px pills.
- Actions: one primary, at most three secondaries, then More as a floating menu (popover on a laptop, sheet on a phone), never inline.
- Nothing touches: flex/grid gap only; 16 px above any row of actions; 32 px between sections.
- Section tabs (a sticky strip of 3-5) instead of stacked disclosures; content under a tab is open; at most one disclosure per section.
- Laptop heroes about 220 px with a 56-64 px title; stat tiles on the right.
- Reference: ScryCheck's deck page (scrycheck-notes.md in this folder).

## Areas and order
| # | Area | Today | Owner | State |
|---|---|---|---|---|
| 1 | Plans (Plans, a plan, Get the cards, versions, archive) | web/src/plan, web/src/research | coordinating agent | first pass up, Bryan reviewing |
| 2 | Deck page (a deck, its lists, check, scan, price list, share, edit) | web/src/pages/Decks.tsx DeckPage, web/src/decks/* | deck-page agent | started 8 Nov |
| 3 | Decks list and the Decks tab sections (Decks, Sharing, Swap cards, Plans) | Decks.tsx DecksPage, components/DeckTabs.tsx, decks/BuildChoices.tsx | after 2 | not started |
| 4 | Cards: search and a card's page | pages/Cards.tsx, CardView.tsx | wave 2 | not started |
| 5 | Collection, sell lists, buylist offers, containers | pages/Collection*, Sell* | wave 2 | not started |
| 6 | Lab: precons, try a change, runs, datasets | web/src/lab | wave 2 | not started |
| 7 | Table (life counter) and Group | pages/Group.tsx, table | wave 3 | not started |
| 8 | Play: lobby and online board | play/ (the "Game interactions" canvas already covers decisions) | wave 3, light | not started |
| 9 | Shell: rail, tab bar, landing, sign-in, settings, What's new, public /r/ and shared pages | App.tsx, Landing.tsx, Sharing.tsx | last, once the areas agree | not started |

Waves keep it to 2 or 3 design agents at a time so Bryan can review each canvas.

## What "better" means here (from Bryan's complaints so far)
- One obvious place for each thing, one way to reach it; fewer pages and tabs.
- Every page says what to do next; current state in plain words.
- Pictures of cards wherever cards are named in a decision.
- Consistent page anatomy: art hero or plain title, one status line, main column plus one side column on laptop, the same order on a phone.
