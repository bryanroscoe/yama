# Game interactions: design backlog

Bryan, 2026-10-23: design every remaining game decision, as a list the design session works through; the builder implements the boards in order as they land.

- The review is in `docs/game-interactions-review-2026-10-23.md`; the engine names below (`WaitingFor` variants, `game_state.rs` line numbers in yama-phase) come from it.
- The boards go on the canvas page "Game interactions", built and named like the first 33 (`G<Name>.dc.html` and `G<Name>Phone.dc.html`), and are copied into `design/screens/`.
- Each new board gets a row in the README's table naming the engine decision it answers.
- Work in the batch order below, and tell the builder when a batch is published.

## Bryan's decisions (2026-10-23)

These change the five rules in `design/README.md`.

1. **Amber means "you can pick this", everywhere on the board.** Warnings during play use red. `tokens.md` currently says amber is a warning and green is playable; change it to match.
2. **Seats use a fixed colour-blind-safe palette.** No seat colour may sit near the red or green status colours.
3. **No invented card text.** The engine gives no plain-language summaries or advice, so show the card's real Oracle text and the engine's own descriptions. This covers advice such as "Good against a board wipe", made-up mode titles, and the "since your last turn" digest written as prose; the log stays a list of events. Drop anything the engine can't supply.
4. **Remembered answers are fine.** Examples are "Always pay for Rhystic Study" and "Always send my commander to the command zone". Yama answers for you, and every automatic answer shows in the log, where it can be turned off.
5. **Playing a card on a phone:** tap the card in hand, then Play, as Yama does today. Dragging it up past the play line also works.
6. **Dialogs confirm only from the main button in the rail or dock**, never from a second button inside the dialog. A dialog may have Cancel.
7. **Right-click (or long-press) reads a card. Esc backs out.**
8. **Your own spell resolves without asking** unless another player can respond. This is PP-07. Remove the "Your spell on the stack: Resolve" state.

## Batch 1: fix the existing boards

From the review's consistency check:
- **Dialogs with two main buttons:** GPay, GModes, GDamage, GChoices and GScry. Keep only the rail's.
- **Credits:** add the artist credit on battlefield tiles and your own portrait.
- **Amber:** "Survives" in GDamage and the "Will tap" preview in GCast should not be amber, since neither is a choice.
- **Main button labels:** separate "Resolve" (nothing to do) from "Let it resolve" (you could respond). During manual payment it must not say Resolve.
- **GPay's payment flow:**
  - add the Treasure prompt ("ask before sacrificing" is the default);
  - drop the life refund on untapping a painland, which the engine can't do;
  - the phone button must not say "Cast" after casting.
- **Search:** "Find nothing" only when the search allows it. Pick several cards with "Done (1/2)". Show what other players see ("Sam is searching").
- **Scry:** on a 390 px phone, three or more cards must fit.

## Batch 2: generic widgets

Most of the remaining decisions fit a few shapes, the ones phase's interaction contract uses (`InteractionResponseSpec`, `types/interaction.rs:958`). Design each once, on laptop and phone. Every widget shows:
- the source card;
- a plain question, built from the engine's prompt, not invented;
- a counter ("2 of 3 chosen").

The widgets:
- **Yes or no strip:** "may" prompts (`OptionalEffectChoice`, `OpponentMayChoice`, `ResolutionOptionalPaymentChoice`, `TributeChoice`), with "Always" for the remembering forms.
- **Pick N:** cards or objects, on the board or in a zone view. It needs minimum and maximum counts, and a filter line.
- **Put in order:** cards, triggers or bottom-of-library order.
- **Pair up:** one thing matched to another.
- **Split a number:** damage, counters, life or mana, with the engine's default split filled in.
- **Number:** X, energy or a paid amount.
- **Name or text:** naming a card, with autocomplete from Yama's card names.

## Batch 3: what comes up in Bryan's decks

Specific boards, or a widget from batch 2 shown in context:
- **Choosing among replacement effects** (`ReplacementChoice`), for token and counter doublers.
- **Paying mana:**
  - Treasures and other sacrificial mana (`ManaSourceSelection`);
  - Phyrexian mana;
  - convoke and delve;
  - choosing a colour of mana.
- **Extra costs:** kicker and optional costs, sacrifice or discard as a cost, ward.
- **Looking at the library:** surveil, "look at the top N, take some" (dig), reveal-until, top or bottom, and the Cultivate split.
- **Counters:** proliferate, and dividing or removing counters.
- **Targets:**
  - any number of targets;
  - dividing damage among targets (`DistributeAmong`);
  - new targets for copies;
  - changing targets.
- **Permanents:**
  - the legend rule (`ChooseLegend`);
  - a clone's choice (`CopyTargetChoice`);
  - equip;
  - the ring-bearer, for the Riders of Rohan deck.
- **Jace, Multiverse Architect:** `EmpowerJaceChoice`, for the Multiverse Reforged deck.
- **Ways to cast:** cascade and discover (`CastOffer`), adventure, madness, miracle, modal faces, alternative costs and mutate.
- **Combat:**
  - attack taxes (Propaganda, Ghostly Prison: `CombatTaxPayment`);
  - must-attack and can't-attack badges;
  - planeswalker and battle defenders;
  - exert and enlist;
  - crew and saddle.
- **Everyone takes part:**
  - votes (`VoteChoice`; Council's dilemma cards are Commander staples);
  - piles;
  - villainous choice;
  - coin flips and dice;
  - the prompt other players see after someone asks to "Resolve all" (`ResolveAllConsent`).
- **Mulligan:** the order of the bottom cards.
- **Settings and actions:**
  - trigger yields and "may" auto-answers (PP-35);
  - concede;
  - reordering your hand.

## Batch 4: rarer decisions

Morph and face-down cards, foretell, ninjutsu, companion, the dungeon and its rooms, meld, cipher, time travel, clash, choosing a player for an effect, loop shortcuts (`LoopShortcut`, `RepeatDecision`), Serum Powder, and the remaining ones in the review's list.

## Not needed

Between-games choices, Alchemy, Planechase and Tiny Leaders (listed at the end of the review's "Engine decisions with no design").

## Status, 2026-10-24

All four batches are designed, and everything is built and live on yama.saget.org (yama:a0dc9b8). In merge order:
- the fix pass and the `act` path;
- the decision widgets;
- turn controls;
- stack, targets and combat;
- paying by hand;
- the inspector, zones, log and endings;
- ways to cast, permanents and counters;
- table-wide, library and player choices;
- rare cards and rules, with Yama's own remembered answers.

`ARCHITECTURE.md`'s play section describes each part. The index buttons still answer anything not listed here.

Still open:
- **Bryan's call: loop detection.** Loop shortcuts are built but never come up, because the engine raises them only with its loop detection on. Turning it on also makes mandatory lethal loops win automatically and declares some draws.
- **Bryan's call: clash.** The two revealed cards are named from the full game while they're placed, since the rules make them public, though phase's per-seat view doesn't name them.
- **Engine gaps in phase:**
  - Krark's Other Thumb and Not Forgotten aren't implemented;
  - turning a card face up when its cost has an X isn't offered;
  - the engine names no source card for coins, dice, clash, scry, surveil and search.
- **Still on the index buttons:**
  - paradigm, free-cast windows and paid casts from a graveyard;
  - a modal card with a land face;
  - changing several targets at once, and a forced target change;
  - choosing which opponent announces a target;
  - physical contests;
  - Room doors, Muldrotha's permanent-type slot, and assist;
  - tapping for mana at priority to float it, and `SpendPoolMana`.
- **Not built:**
  - "Dies" and "Survives" marks on blocks, and one creature blocking several attackers;
  - per-seat "passed" state;
  - the encoded card shown on its creature;
  - highlighting the cards a log line names;
  - event-driven board animation (`BoardMotion.tsx` still compares boards).
- **Checked only in tests, not in a browser:** miracle, ripple, explore, populate, equip by `EquipTarget`, meld, the command-zone answer, the entering-attacker choice, "repeat this process", the drawn game, the die keep, guesses, sharing out life, and the combat-damage split.
