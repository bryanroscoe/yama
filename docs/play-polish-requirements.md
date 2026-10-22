# Online play polish: requirements

Drafted 2026-10-18 for Yama's online Commander board, then checked the same day against Yama's code, the phase v0.113.0 fork and the web. The goal is for a 4-player game in Yama to feel as close to MTG Arena as possible. That applies on a desktop browser and on an Android phone running the installed web app. The lobby also allows 2, 3, 5 and 6 seats, so the layout must not break for those counts.

**Based on:**
- Three research notes from today: board layout, interaction, and feel and feedback.
- A code audit of `web/src/play/*`, `play/src/lib.rs` and `server/src/play.rs`.
- A read of the phase v0.113.0 fork in `../yama-phase`: the engine, `phase-server`, `server-core` and the phase client.
- A web check on Arena's multiplayer plans, Arena's controls and Scryfall's image rules.

**How sure the details are.**
- Anything marked "(check in Arena)" is from memory, from old guides, or isn't documented anywhere. The MTG Arena Zone guides used here date from August 2022. Bryan can confirm these in his own install.
- Engine and Yama claims were checked in the source. File and line references are as of 2026-10-18.
- Nothing was changed in either repo.

---

## 1. Summary and principles

### Where Yama is today
- Full Commander games already work online on the phase engine, with 2 to 6 seats. They include AI seats, reconnect and recovery after a restart. Members of the game's playgroup can watch.
- But it plays like a form. Each decision is a list of buttons, and a tap on a card only filters that list.
- Three things block Arena-level polish. Fix them first:
  1. **The option list is the AI's trimmed sample, not every legal play.** Yama sends humans the `AiDecisionContract` candidates and accepts only an index into that list. So some legal plays can't be made at all:
     - attacking with 2 of your 3 creatures (the sample holds no attack, each single attacker, and every creature at one defender);
     - splitting attackers between opponents;
     - making two separate blocks;
     - keeping 2 of 3 cards on top with scry, or reordering them (the sample is none, all or one card);
     - reaching every card in a search for 2 or more cards (the pool is capped at 12 cards);
     - ordering 5 or more triggers in any order other than the two defaults;
     - tapping or untapping mana by hand, spending floating mana, or cancelling during payment (those actions aren't in the sample).

     phase has a complete human contract for this (`derive_viewer_interaction`, `submit_interaction`). It covers every `WaitingFor` variant and fails closed only on oversized payloads. Yama doesn't use it yet.
  2. **No event stream.** The server keeps only the newest view (a tokio `watch` channel) and drops `ActionResult.events`. It publishes only after each batch of up to 40 AI actions, so the states in between are lost. There is nothing to animate from.
  3. **The view is thin.**
     - It has no combat state, no stack targets, no keywords and no attachment list. `attached_to` is sent but never used.
     - Options don't carry a target id.
     - It hides your own face-down cards from you.
     - It shows a transformed card's front face.

     So there can be no arrows, no combat display and no badges.
- **Arena has no 4-player board to copy.** On 2026-08-28 Draftsim reported what Dave Finseth, a senior digital product manager at Wizards, said about four-player Commander. He said it is "being worked on", with no date, and "When we built Arena we weren't thinking this was going to be a four-play game". A search on 2026-10-18 found nothing newer. So:
  - take Arena's 1v1 look and feel: rows, small art-forward cards, the big contextual button, stops, the hand;
  - take the 4-player arrangement from MTGO, Forge, XMage and phase's own client.

### What makes Arena feel good
1. **One obvious next step.** A big button always says what it will do: "Resolve", "Attack (3)", "End turn".
2. **You act on cards, not lists.** You drag or double-click to cast, click creatures to attack, and arrows show targets and attacks.
3. **Every touch gets an answer at once.** Something visibly changes in the same frame, before the server replies.
4. **It doesn't ask what doesn't matter.** It passes when you can't act, picks a lone legal target, and taps mana for you. But it stops where it matters, and you can override it with stops and full control.
5. **Every change is shown briefly.** Cards move to where they went and life totals tick. Then the animation gets out of the way.
6. **Detail on demand.** The board shows small cards. The full card appears on hover or long-press.
7. **One visual language.** A spell and its arrows share a colour. A glow means "you can do something". The commander has its own border.

### Where Yama can beat Arena
- **A real game log.** Arena's client has none, so players rely on third-party trackers.
- **Animation speed and skip controls.** Players keep asking Wizards for these. A feedback-board post on 2026-09-07 asks for an option to speed up or skip long trigger animations.
- **4-player clarity:** who is attacking whom, commander damage, and what happened since your last turn.
- **Watching.** Playgroup members can already watch a live Yama game. Arena friend games can't be watched (check in Arena).
- **Accessibility:** text size, colour plus shape cues, reduced motion.

### Rules every requirement follows
- **Hidden information.**
  - Each seat sees only what it may see. Never send raw engine state or raw engine events (ARCHITECTURE.md).
  - Filter each action's labels and events for each seat at the moment the action happens.
- **Scryfall image rules** (read from scryfall.com/docs/api on 2026-10-18):
  - Don't blur, sharpen, desaturate, colour-shift, distort, skew or stretch card images.
  - Don't cover, crop or clip off the artist name or copyright on a full card image.
  - When showing an art crop, list the artist and the copyright in the same interface, or show the full card image elsewhere in that interface.

  In practice:
  - no CSS `filter` on card images (today `.tile.tapped img` darkens tapped cards);
  - no grey-out or fading for unplayable or eliminated cards (today `.opp.out` fades an eliminated seat to 50%);
  - no badge over a full card image's bottom text line (today the P/T and count badges sit there);
  - no shatter or burn shaders on the card image itself.
- **Yama's design rules (AGENTS.md).**
  - No all-caps labels. No decorative gradients. Mana colours only mean whose.
  - No middle-dot meta strings. The phone prompt uses one today (`Board.tsx:581`).
  - Ship no card images. Hidden cards use a plain Yama card back, or Scryfall's card back loaded at runtime.
  - The "felt green" rule is out of date: Bryan dislikes felt and wants commander art behind each player. AGENTS.md needs updating once he picks a direction on the design canvas (see PP-09).
- **Animations never block input.** They never cover life totals, counters or zones, and they can always be skipped.
- **Keep the index buttons as a fallback.** They work for every engine decision.

### What the design canvas must make room for
For Board.dc.html and BoardPhone.dc.html:
- a right-hand stack rail on desktop;
- a primary button plus a secondary button, and a pass-mode chip;
- a stop ladder beside my portrait and beside the active opponent;
- opponent headers on commander art that can be clicked, or dropped on, for targets and attacks;
- an "Incoming" combat lane;
- a full-screen arrow overlay;
- a banner area at top centre;
- a mana payment panel above the hand;
- a revealed-cards overlay;
- compact opponent strips for 5- and 6-player games;
- a spectator version (no hand and no decision area, with a choice of which seat sits at the bottom);
- on phones: an opponent tab rail, a stack chip, a hand drawer, and docked versions of all of the above.

---

## 2. Gap table

Gap sizes are Large, Medium or Small. "Can't make legal plays" means the gap is a correctness problem, not just polish.

| Area | Arena | Yama today | Gap |
|---|---|---|---|
| 4-player layout | None. 1v1 only; four-player mode "being worked on", no date | Opponents as a list (phone) or a grid capped at 45% of the height (desktop), in seat order, not turn order. No seat geometry | Large. Borrow from MTGO and phase |
| 5 and 6 players | Not applicable | Allowed by the lobby (2 to 6 seats); no layout planned for them | Medium |
| Look and identity | Playmats, avatars, card styles | Felt green; opponent border in the deck's first colour; tapped cards darkened with a CSS filter; badges over the artist and copyright line | Medium. Bryan wants commander art per seat |
| Battlefield cards | Small art-forward tiles in rows: name, art, P/T, keyword icons, status badges (check in Arena) | Shrunken full card images; creatures first, then the rest by name; no keywords, summoning sickness or attachments | Large |
| Stacking | Identical cards stack; clicking a pile's count selects the whole pile | Only plain lands stack. Same-name lands with no counters share one pile, tapped and untapped together, with an "n tapped" label. The pile turns sideways only when every copy is tapped. An enchanted land (Utopia Sprawl) still folds into the pile. Tokens never stack | Medium |
| Hand | Fanned, half off-screen, hover lifts a card, outline on playable cards (check in Arena) | Flat scrolling row of full cards (150 px wide on desktop); a dot on playable cards | Medium |
| Commander | Castable card beside the hand, tax included in the cost (Brawl; check in Arena) | "Commander" tag in the command zone; no tax shown | Medium |
| Graveyard and exile | Open in a panel | Sent to the client but never shown; only your own graveyard count | Large |
| Revealed cards | Shown in an overlay (check in Arena) | Not in the view at all | Medium |
| Face-down and double-faced cards | You can see your own face-down cards; a transformed card shows the face that's up | Your own face-down permanents and foretold cards show as "Face-down card", even to you. Transformed cards show the front image, because card data is looked up by name with the front face first | Medium (bug) |
| Reading cards | Hover; right-click or long-press for details and keyword reminders | Hover image on wide screens only. No Oracle text by mouse at any width. With a mouse below 1000 px, a card can be read only while you have a decision (select it, then "Read card") | Medium (bug) |
| Casting | Drag up, double-click, or click then click | Tap the card, then a button | Medium |
| Targeting | Arrow to the target; legal targets clickable; a lone legal target picked automatically for triggers (spells: check in Arena) | "Target X" text buttons; nothing highlighted on the board; two targets with the same name collapse into one button | Large |
| Modes and X | Mode tiles; an X picker (check in Arena) | One chip per mode combination; one chip per X value; total cost not shown | Small |
| Mana payment | Auto tap, manual taps, undo, AutoTap preview | Auto only; every cast uses the engine's Auto mode. When the engine does ask, labels are machine text, and the auto-pay button reads "Pass (move on)" or "Pass (let it resolve)". Manual untaps, pool spending and cancel aren't offered | Large when it comes up |
| Main button and passing | Big contextual button; Space, Enter, Shift+Enter, Ctrl | One Pass button; server-side smart stops; full control hidden in the log sheet; no hotkeys | Large |
| Phase stops | Click step icons beside either portrait; orange for your turn, blue for the opponent's | Phase track is display only | Large |
| Priority in combat | Given when you have a play (check in Arena) | Never given with an empty stack after attackers or blockers are declared, unless full control is on. A defender can't remove an attacker before blocks | Large |
| Attacking | Click to toggle; a target per attacker; clicking a pile's count assigns the pile | AI sample: one creature, or every creature at one defender | Large (can't make legal plays) |
| Blocking | Click blockers, then the attacker; clicking a pile's number assigns several | One block per declaration, plus gang blocks against menace | Large (can't make legal plays) |
| Damage assignment | Auto or manual | Default split only, from the AI sample | Medium |
| Combat display | Attackers move forward; arrows; lethal cue in the damage step (check in Arena) | None. Defenders read "Block: X blocks Y" | Large |
| Stack | Large cards on the right; hover shows targets; arrows colour-matched to the spell | Names only; triggers look like spells; no targets | Large |
| Trigger order | Ordering screen (criticised for unclear rows) | Every order for up to 4 triggers; only two orders above that; rows name only the source card | Medium |
| Scry and surveil | Divider or two boxes; drag cards between them | None, all, or one card; no images; doesn't say top or bottom | Large (can't make legal plays) |
| Library search | Card browser | Text chips; searches for 2 or more cards see only 12 cards | Large (can't make legal plays) |
| Mulligan | Keep / Mulligan, then choose bottom cards | Text buttons; the free mulligan isn't shown; the bottom step is one button per combination (35 buttons for 3 cards out of 7) | Small |
| Animation | Polished, but sometimes slow or covers information | None. No events reach the client | Large |
| Speed controls | None; players ask for them | None | Chance to beat Arena |
| Sound | Full sound and music | None | Medium |
| Playable highlights | Outline (check in Arena) | Dot and brighter border | Small |
| Combat math | Lethal damage shown in the damage step (check in Arena) | None | Medium; chance to beat Arena |
| Log | None in the client | 6 recent lines plus a sheet. Essential public lines only, flattened to plain text and trimmed to the last 60. Some lines appear twice | Yama ahead; make it rich |
| End of game | Victory/Defeat banner, rewards | "You won" text | Medium |
| Timers and idle players | Rope, extensions, forced pass | None. An absent player stalls the game forever | Medium |
| Emotes | A few stock phrases; mute (check in Arena) | None | Small |
| Watching | Not for friend games (check in Arena) | Playgroup members can watch a live game with the spectator view | Yama ahead; design for it |
| Performance | Mostly smooth; some lag and phone heat | Every message re-sends the whole board and the text of every card on it. States in between are dropped (one publish per batch of up to 40 AI actions). AI takes up to 1.5 s per decision. The game thread waits while the whole replay is saved after every change. A spectator view is built on every publish, even with no one watching | Medium |
| Accessibility | Few options (check in Arena) | Reduced-motion CSS block only | Chance to beat Arena |
| Phone | Long-press zoom; hand drawer that tucks itself away; orientation: check in Arena | Portrait dock with a chip row; tap opens a card sheet | Medium |

---

## 3. Requirements

**Priority:**
- **P0:** must have for "feels like a real client".
- **P1:** expected polish.
- **P2:** nice to have.

**Effort:**
- **S:** a small change in one area.
- **M:** several components, or a new server field.
- **L:** a new subsystem across the server and the web app.

Engine paths are relative to `../yama-phase/crates/engine/src/` unless shown otherwise.

### 3.1 Foundations (server and protocol)

#### PP-01 Every legal play can be made
**P0. Effort L (the combat-only first step is M).**

**Story:** As a player, I can make any legal play, not only the ones the AI's search happened to sample.

**Acceptance:**
- I can attack with any subset of my creatures, each at its own defender (player, planeswalker or battle).
- I can declare several separate blocks at once, and gang-block a menace creature.
- With scry N, I can keep any subset on top, in any order.
- In a search for 2 or more cards, every matching card in my library can be chosen.
- I can order 5 or more triggers in any order.
- I can divide combat damage, and "divide as you choose" effects, freely within the rules.
- During mana payment I can tap, untap, spend floating mana and cancel.
- Under a control effect (Mindslaver), the controlling player gets the decision. Today `Match::decision` checks `acting_players()`, so the controlled seat would get the options.
- An illegal submission is rejected with a plain reason, and the board stays as it was.
- The index buttons still appear for any decision the new path doesn't cover.
- Replays still reproduce: the soak test passes with human-style submissions.

**Engine/server:**
- **Target:** phase's human interaction contract.
  - `derive_viewer_interaction(authoritative, filtered, viewer)` (`game/interaction.rs:8898`) returns opportunities.
  - Each opportunity has either exact choices or a response schema: `Select`, `Sequence`, `GroupedSequence`, `Relations`, `AssignDamage`, `AssignAmounts`, `Number`, `ManaGroups` or `Text`. `Shortcut` and `DeckPartition` exist but aren't needed here.
  - For finite decisions such as priority, the contract reuses the AI candidate list, which is complete for those decisions.
  - Each opportunity also has `surfaces` (object refs with role, name, zone and controller) and `progress {selected, minimum, maximum, confirmable}`.
  - Answer with `submit_interaction_with_rejection` (`:11613`), which returns a viewer-safe `ActionRejection` for PP-06. `submit_interaction` is at `:11591`.
  - Call `bind_interaction_authority` (`:841`) on new games, and again after a resumed game has replayed its log.
  - The binding lives in `GameState`, but the replay records only the resulting `GameAction`, so replays stay valid.
  - phase's own client uses this contract only in places (phase-server sends it; some modals read it). Expect rough edges, and add soak coverage that drives seats through `submit_interaction`.
- **Cheap first step:** a client message `{type:"act", revision, action}` for `DeclareAttackers` and `DeclareBlockers` only.
  - `AiDecisionContract::contains_action` already accepts any declaration that passes `validate_attack_declaration` or `validate_blockers_for_player` (`ai_support/context.rs`).
  - Submit through `apply_ai_action_proposal`, and record with `log.push_action`, as `choose` does.
- Whitelist action types at the transport. Never accept `Debug`, `GrantDebugPermission` or `RevokeDebugPermission` from a client.
- Decide which seat owns a decision with `turn_control::is_authorized_submitter`, not `acting_players()`.
- For the rare decisions the contract fails closed on, keep the index options.

**Web:**
- One generic widget per response shape: toggle-select with a counter, a drag-to-order list, source-to-target pairing, amount steppers, and a number stepper.
- Each widget shows progress ("2 of 3"). Its confirm button enables only when `confirmable` is true.

#### PP-02 Event feed per seat
**P0. Effort L.**

**Story:** As a player, I see each thing that happened, in order, even when an AI made five moves at once.

**Acceptance:**
- Each seat, and each spectator, receives every event since its last update, in order, each with a sequence number.
- No event reveals hidden information to a viewer who shouldn't see it: face-down cards, opponents' draws, library contents.
- On reconnect, or after a gap in sequence numbers, the client shows the current board at once. It doesn't replay the backlog as animation.
- AI batches and auto-pass batches include the events of every action in the batch.

**Engine/server:**
- Keep `ActionResult.events: Vec<GameEvent>` (`types/game_state.rs:19509`) in `Match::accepted`. Today `accepted` keeps only log entries (`play/src/lib.rs:541-553`).
- Filter each action's events right after that action, inside `accepted`, so it also covers every step of `run_ai` and `auto_pass`.
  - Use `filter_events_for_viewer(events, state, viewer)` (`game/visibility.rs:3245`), once per human seat.
  - Call it once more for spectators: a viewer id that isn't a seat is treated as a spectator.
- Map the filtered events into Yama's own small `AnimEvent` type through a whitelist. The variant names come from `types/events.rs`:
  - `ZoneChanged`, `SpellCast`, `StackResolved`, `SpellCountered`;
  - `DamageDealt`, `LifeChanged` (it carries `new_total` when reported), `TokenCreated`, `CounterAdded`, `CounterRemoved`;
  - `PermanentTapped`, `PermanentUntapped`, `CreatureDestroyed`, `PermanentSacrificed`;
  - `AttackersDeclared`, `BlockersDeclared`, `BecomesTarget`, `CardsRevealed`;
  - `TurnStarted`, `PhaseChanged`, `PlayerEliminated`, `GameOver`.
- Keep a ring buffer per match of `{seq, revision, events}` (about 1,000 entries). The `watch` channel (`server/src/play.rs:53,140`) keeps only the newest value, so events can't travel on it alone.
- **Object ids:** phase keeps the same `ObjectId` when a card changes zone. It bumps an `incarnation` number instead (`game/zones.rs:196`, `game/game_object.rs:1082`). So a card can be followed from hand to stack to battlefield by its id.
  - Check that no seat can follow an id through a hidden zone, for example a card shuffled into a library or returned to an opponent's hand.
  - If a seat can, the mapping must break the link for that seat.

**Web:** an event queue keyed by `seq`, which feeds PP-53. The View stays the source of truth.

#### PP-03 A richer view of the board
**P0. Effort M.**

**Story:** The board shows the real game: who is attacking whom, what a spell targets, and what a creature can do.

**Acceptance:** `View` and `CardView` gain these fields.
- **Combat:** attackers with their defender, and blockers with the attacker they block.
- **Stack items:** id, kind (spell, activated or triggered), source id, controller, ability text for abilities and triggers, chosen modes, and targets.
- **Each card:**
  - keywords, summoning sickness, token, commander;
  - attached-to and attachments;
  - face-down, transformed or face shown;
  - colours, "exiled with" links, copy status, and current versus printed P/T.
- **Face-down objects** show their real card to the seats allowed to see it, marked face-down. That means the controller of a morph or manifest, and the owner of a foretold card.
  - phase's filter already reveals them to the controller.
  - Yama's `view()` blanks the name for everyone.
- **Transformed cards:** a transformed or back-face permanent names its current face, and its image follows (PP-05).
- **Revealed cards:** the cards revealed to this seat, with who revealed them.
- **Each player:**
  - mana pool, and commander tax for each commander;
  - commander damage keyed by the commander's object id, not by name;
  - auras attached to the player (curses);
  - energy, experience, monarch, initiative and day/night where the engine tracks them.
- **Effective costs** for cards in hand, while this seat holds the decision. phase computes `spell_costs` only for the seat that may act. At other times, show the printed cost, plus the tax for a commander.
- Everything is built from the seat's filtered state. Face-down exiled cards show no name to other seats.

**Engine/server:**
- Combat comes from `state.combat` (`game/combat.rs:319`): `attackers`, `blocker_assignments` and `blocker_to_attacker`.
- Most of the rest is already computed by `derive_filtered_views(authoritative, filtered, viewer)` (`game/derived_views.rs:2110`; the `DerivedViews` struct is at `:615`). phase-server sends it with every update. It covers:
  - `stack_entry_details`: targets with labels, ability text, mode labels, paid facts and the live controller;
  - `stack_display_groups`, `battlefield_keyword_badges`, `counter_display`;
  - `linked_exile_ids`, `blocker_assignment_pairs`, `commander_damage_by_attacker`;
  - `auras_attached_to_player`, `copied_permanents`, `cant_be_blocked`, `current_target_kind`;
  - a turn-order row.

  Use it, rather than walking `sub_ability` in Yama the way phase's client does in `stack/stackTargets.ts`.
- Object fields: `summoning_sick`, `is_token`, `is_commander`, `attachments`, `attached_to`, `face_down`, `transformed`, `color`, `base_power`, `printed_ref`.
- Commander tax comes from `commander_tax(state, commander_id)` (`game/commander.rs:11`).
- `state.commander_damage` is keyed by the commander's `ObjectId`, which stays the same all game.
- Effective costs come from `spell_costs` in `legal_actions_for_viewer` (`ai_support/mod.rs:2608`).

**Web:** extend `types.ts`.

#### PP-04 Options tied to objects, with unique labels
**P0. Effort M.**

**Story:** Every choice is reachable, and I can pick it by touching the card it's about.

**Acceptance:**
- A planeswalker's three loyalty abilities appear as three options, each with its cost and text. Today the client merges them into one "Use X" button, so only the first can be reached.
- Two tokens with the same name can each be targeted, attack, or block. Today their identical "Target Goblin" labels merge too.
- Each option carries:
  - `kind`: pass, land, spell, ability, attack, block, target, mana, and so on;
  - `source`: an object id;
  - for target options, `target`: an object id or a seat.
- The client never merges options that point at different objects.
- Fallback labels use the seat's filtered state and seat names, never "Player 0".

**Engine/server:**
- Label abilities from `abilities[ability_index].description` plus the cost. `ability_index` indexes `obj.abilities` (`game/casting.rs:636`). `description` is optional, so fall back to the cost and the effect.
- Take the option kind from `ActionMetadata.tactical_class`.
- Add a `by_object` map from `legal_actions_for_viewer` (seat-scoped; it includes mana abilities).
  - Mana abilities aren't in the AI contract.
  - So they can't be submitted through the index path until PP-01, or until they're added to the `act` whitelist.
- `source_object()` returns `None` for `ChooseTarget`, `SelectTargets`, `SelectCards` and the combat declarations (`types/actions.rs:2324`). That is why target and card-choice options never filter by card today.
  - Read the target ref from the action.
  - Read the source from `TargetSelection.pending_cast.object_id`.
- Resolve fallback labels against the filtered state (`vs`), not the full state (`play/src/lib.rs:431`).

**Web:** remove `dedupe` (`Board.tsx:556`, `:671`).

#### PP-05 Card data sent once, with the right face, art and credit
**P0. Effort M.**

**Acceptance:**
- Card metadata (image URLs, cost, type line, Oracle text) is sent once per card per connection. After that, only new cards are sent. Today every message re-sends the whole map.
- Metadata is keyed by what the engine says the object is, not by its display name:
  - for cards, the engine's `printed_ref` (oracle id plus face name);
  - for tokens, `token_image_ref.scryfall_id`.

  Today a token named "Soldier" gets whichever Soldier token the query finds first, and a transformed card gets its front image.
- The image shown is the face that is up: transformed, modal double-faced played as its back face, or flipped.
- Each entry includes the small, normal, art-crop and back-face images, plus the artist and the copyright line. Scryfall wants both with an art crop.
- Where Yama's deck stores a printing, use that printing. The `printings` table has the same image columns.
- Library cards in the current decision (scry, dig, search) are sent to the deciding seat only.
- Graveyard and exile cards have metadata, so they can show thumbnails.
- Battlefield tiles load the small or art-crop image, not the normal one.
- Scryfall now also lists WebP formats (`thumb`, `grid`, `display`, `crop`, `art`) that replace the JPGs. Check whether the bulk data carries them, and use them for tiles if it does. Today's import keeps only small, normal and art crop (`server/src/cards/import.rs`).

**Engine/server:**
- The `cards` table already has `image_small`, `image_art_crop` and `artist` (`server/migrations/0001_init.sql:47-51`).
- Change `view_names` (`server/src/play.rs:740-754`), which today leaves library cards out, and `card_meta` (`:757-775`), which looks up by name.

#### PP-06 Pending state, a token per decision, plain errors
**P0. Effort S.**

**Acceptance:**
- Within 50 ms of a tap, the chosen control shows that it is sending. The other decision controls lock until the next view or an error arrives.
- A double tap never sends two messages.
- When two humans decide at once (mulligans), neither gets "the game moved on" because of the other's choice.
- A choice I'm still putting together (attackers, blocks, scry piles, a selected card) survives view updates that don't change my decision. Today any new revision clears the selection (`Board.tsx:244`).
- A rejection shows as a plain sentence, for example "That creature can't attack this turn", not Debug text. It clears on the next view.

**Engine/server:**
- Use a token per decision:
  - Once PP-01 lands, use the engine's interaction id. Each seat in a simultaneous decision keeps its own slot (`game/interaction.rs:949`).
  - Until then, keep a revision per seat, and check the submitted option's action as well as its index. That way an index can never land on a different action after the list changes.
- Map rejections to text instead of `{rejection:?}` (`play/src/lib.rs:335`). `apply_with_rejection` and `submit_interaction_with_rejection` give viewer-safe codes.

#### PP-07 Engine-owned passing and stops
**P0. Effort M.**

**Story:** Yama passes for me the way Arena does, and stops when I could act, including in combat.

**Acceptance:**
- My own spell on top of the stack resolves without asking me, unless full control is on.
- On an opponent's turn I get priority:
  - when they put something on the stack I could respond to;
  - at a stop I set;
  - in combat when I'm attacked.

  I am not stopped at every empty step just because I hold an instant, unless Arena does that (check in Arena).
- After attackers are declared, defending players with an instant-speed play get priority. After blockers, everyone with a play does.
- I get a stop at my upkeep when my library is empty. Arena players have asked for this.
- My stops and passing mode are saved per user and apply in every game.
- Preference changes are written to the replay log, and replays still reproduce.
- **Measure first.** In a scripted 4-player game, count the stops a human gets per round under today's rules and under the engine's. The new rules must not stop me more often on opponents' turns than today, unless I set a stop.

**Engine/server:**
- **Today's first step (M0):** change `should_auto_pass` (`play/src/lib.rs:457-497`) to stop:
  - in the declare-attackers step, for defending players with an instant-speed play;
  - in the declare-blockers step, for anyone with an instant-speed play.
- **The replacement:** `auto_pass_recommended_for_viewer` (`ai_support/mod.rs:2234`), fed with the flat priority actions. Its rules, in order:
  1. A phase stop holds.
  2. Full control holds.
  3. My own object on top of the stack, or a trigger I yielded to, passes.
  4. On an opponent's turn it holds whenever I have any castable spell. phase added this rule in issue #4388.
  5. On my own turn it holds in every window where I have a castable spell, except upkeep and draw.
- In Commander, rules 4 and 5 hold at nearly every window. So Yama needs its own layer on top:
  - pass empty-stack windows on opponents' turns, unless a stop is set or I'm attacked;
  - pass my own beginning-of-combat and end steps, unless a stop is set.
- **Preference actions:**
  - `SetPriorityPassingMode {Standard | SkipLowUseWindows | FullControl}`;
  - `SetPhaseStops {stops: Vec<PhaseStop {phase, scope}>}`, which replaces the whole list;
  - `SetAutoPass {UntilStackEmpty | UntilTurnBoundary {EndOfCurrentTurn | MyNextTurnStart}}` and `CancelAutoPass`.

  All of them are legal in any `WaitingFor` state and leave the open decision alone.
- **How the engine uses them:**
  - The engine runs `SetAutoPass` sessions itself, inside `apply` (`run_auto_pass_loop`, `game/engine.rs:10010`). Passes taken there never reach Yama.
  - Phase stops are checked only for empty-stack windows.
  - A phase stop also keeps the engine from auto-submitting an empty block when no blocker is possible.
- Add a client message `{type:"prefs", action}` with a whitelist.
- Keep `full_control` as a wrapper over `SetPriorityPassingMode`. Full control lives in engine state, so engine-run sessions respect it.
- The empty-library stop is a Yama rule on top of the engine.

#### PP-08 Reconnect and presence
**P0. Effort S.**

**Acceptance:**
- After a refresh or a network drop, the same board is back within 1 s on a warm cache, with no animations replayed.
- After 2 s without a socket, a chip says "Reconnecting".
- Other players see a "disconnected" mark on a seat whose socket closed.
- "Leave" asks whether to concede or just step away. Stepping away keeps the seat.
- Spectators reconnect the same way.

### 3.2 Look and board layout

#### PP-09 Visual system: no felt, commander art for each seat
**P0. Effort S.**

**Story:** Each player's area shows their commander's art, on a calm base.

**Acceptance:**
- No `--felt*` colours remain in the board. The installed app's theme and background colours (`web/public/manifest.webmanifest`) follow the new base.
  - The base comes from the direction Bryan picks on the design canvas: A near-black, B warm leather and brass, or C cool ink.
  - Use the shared tokens in `web/src/styles.css`, not hard-coded colours.
- Each seat's header band is filled with its commander's art crop. The pane body is a solid surface.
- No CSS `filter`, blur, desaturation, colour shift, stretch or fade on any card image.
  - Remove `.tile.tapped img { filter: brightness(0.8) }` and the 50% opacity on `.opp.out`.
- No badge sits over a full card image's bottom text line.
- Text over art sits on a solid band so it stays readable (see the open questions).
- The artist and copyright appear with the art ("Art: Name, © Wizards of the Coast"), or the full commander card is shown in the same screen.
- The "unofficial, not endorsed by Wizards" notice stays.
- The phone prompt's middle dot goes (`Board.tsx:581`).
- Once Bryan picks a direction, AGENTS.md's "felt green" line is replaced with the new rule, so other agents stop reintroducing felt.

**Engine/server:**
- The art crop, artist and copyright come from PP-05.
- The commander comes from the seat's lobby entry (`SeatCfg.commander`) or the command zone.

**Web:** tokens in `board.css`, and a new seat-pane component.

#### PP-10 Desktop layout
**P0. Effort L.**

**Story:** On a laptop I see all three opponents, my board, my hand, the stack and my choices, without scrolling.

**Acceptance (1280×800 and larger):**
- Opponents run across the top in turn order after me, as on MTGO: the next player on the left, then the one across, then the previous player on the right. phase's derived turn-order row gives the order.
- My battlefield sits below the opponents, and my hand runs along the bottom.
- A right rail of about 340 px holds the stack, the decision area and the recent log.
- A centre strip shows the phase track, the combat summary and banners.
- The page itself never scrolls. A zone scrolls inside itself only past the crowding limits (PP-15).
- The hover preview never covers the decision area or a life total.
- 3- and 2-player games use the same layout with fewer opponent panes. In 5- and 6-player games, the opponents beyond three become compact strips (header, mana summary, creature count) that widen on click (PP-17).
- The seat count, not the number of players still alive, decides the layout.
- Spectators see the same layout with no hand and no decision area, and choose which seat sits at the bottom.

```
rows: minmax(0,38fr) auto minmax(0,40fr) auto     cols: minmax(0,1fr) 340px
| Opp LEFT (next) | Opp ACROSS | Opp RIGHT (prev) | STACK   |
| phase track, combat summary, banners            | OPTIONS |
| my creatures                    | planeswalkers | + Pass  |
| my lands (left) ....... artifacts/enchantments  | log     |
| piles | commander | hand fan | portrait + life | primary  |
```

#### PP-11 Opponent seat header
**P0. Effort M.**

**Acceptance:** each opponent header shows:
- name and commander art (PP-09);
- life as the largest number (28-32 px on desktop);
- poison when it is above 0;
- hand count, with an eye mark and the cards when some of the hand has been revealed to me;
- library count;
- a graveyard chip with the count and a top-card thumbnail, and an exile chip when exile isn't empty. Tapping either opens PP-22;
- a commander chip with a thumbnail, the tax ("Tax +2"), and the commander damage it has dealt to me;
- auras attached to the player (curses);
- monarch, initiative, energy and experience when present;
- state: a turn ring, a priority marker, the "deciding" pulse, and a disconnected mark.

Clicking the header targets that player when a player is a legal target. Otherwise it focuses the pane (PP-17).

#### PP-12 Battlefield rows
**P0. Effort M.**

**Acceptance:**
- **My side:** creatures in the row nearest the centre. In the back row, lands on the left and other non-creature permanents on the right. Planeswalkers sit in their own area on the far right, which pages instead of shrinking.
- Battles sit on the protector's side, as Wizards chose for Arena ("Combat felt better when Sieges were on the protector's side").
- **Opponents:** the same rows mirrored, so their creatures face the centre.
- Order within a row is stable, so cards don't jump when one taps.
- Every permanent has a stable DOM anchor keyed by object id. Arrows and card flights need this.

#### PP-13 Condensed battlefield tiles
**P0. Effort M.**

**Acceptance:**
- **Shape:** a near-square, art-forward tile using the art crop.
  - The full card is one hover or long-press away. That meets Scryfall's credit rule for art crops.
  - The inspector also shows the artist and copyright.
- **Name bar** at the top: live text, at least 11 px, cut off with an ellipsis.
- **P/T box** bottom-right in bold.
  - Damage shows as lowered toughness in red (this exists today).
  - A P/T above or below the printed value shows a colour plus an arrow. Whether Arena colours buffs: check in Arena.
- **Loyalty** in a shield shape. **Counters** as pills ("+1/+1 ×3"), from the engine's `counter_display`.
- **Keyword icons:** up to 3, then "+N", from `battlefield_keyword_badges`.
- **Summoning sickness:** a small badge overlay, not a filter.
- **Tapped:** rotated 90 degrees inside a square slot, so the row height doesn't change.
- **Commander:** a distinct border.
- **Status badges:** token, copy, attacking, blocking, goaded, can't block, can't be blocked, face-down.
- **Playable:** the outline from PP-28.

#### PP-14 Stacking identical permanents
**P0. Effort M.** Commander boards fill up with tokens.

**Acceptance:**
- Two permanents share a stack only if all of these match: name, tapped, flipped, transformed, P/T, loyalty, damage, summoning sickness, class level, colours, keywords, counters as displayed, token or not, a token's rules text and art, and commander or not.
- These never stack: permanents with attachments, face-down permanents, the ring-bearer, and melded permanents. This follows phase's `canGroup` and `groupKey` in `client/src/viewmodel/battlefieldProps.ts`.
- Tapped and untapped copies are separate stacks, so the rotation itself shows which are tapped.
- **Rendering:** 1 card shows singly. 2-4 are staggered. 5 or more collapse to one card with a "×7" badge.
- Clicking the count selects the whole stack, for example to attack with every token.
- Any single member can still be reached. A stack auto-expands during targeting and blocking; with 5 or more members, a picker opens.
- Applies to creatures, tokens and other permanents, not only lands.

#### PP-15 Crowding
**P0. Effort M.**

**Acceptance:**
- Count distinct stacks, not cards.
- **Lands** collapse into a summary tile past 8 stacks on desktop, or 4 on a phone or in an opponent pane. The tile shows untapped mana by colour and counts by type. Tapping it opens a drawer.
- **Creatures** become a scrolling row past 12 stacks on desktop, or 6 on a phone. Creatures in combat sort to the front. A fade and a chevron show there is more.
- **Minimum tile heights:** 80 px at full width, 56 px on short screens, 44 px in an opponent pane.

These numbers come from phase's `BattlefieldZoneOverflow.tsx` and `BattlefieldRow.tsx`.

#### PP-16 Attachments and "exiled with" cards
**P1. Effort M.**

**Acceptance:**
- Auras and Equipment fan out behind their host, peeking about 13% of its height (XMage's offset).
- Auras attached to a player (curses) sit at that player's header.
- Cards exiled "until this leaves" show as small ghost cards under their source. MTGO and Forge do this.
- The inspector lists both.
- Face-down exiled cards show no name to other seats.

**Engine/server:**
- `attachments` and `attached_to` from PP-03.
- From derived views: `linked_exile_ids` and `auras_attached_to_player`.
- The interaction contract also offers `attachment_fans`.

#### PP-17 Focus and view modes
**P2. Effort M.**

**Acceptance:**
- Clicking an opponent's pane body widens it to about 60%. The others become compact strips showing header, mana summary and creature count.
- Number keys 1-5 focus an opponent and 0 returns to the overview. Tab cycles focus.
- Focus never changes while I'm choosing targets or blockers.

#### PP-18 Eliminated seats
**P1. Effort S.**

**Acceptance:**
- An eliminated seat collapses to a thin strip showing name, how they lost and on which turn. The other panes get the space.
- They stay in the log and on the end screen.

### 3.3 Hand and zones

#### PP-19 Hand fan (desktop)
**P0. Effort M.**

**Acceptance:**
- The hand is an overlapping fan at bottom centre, with about 60% of each card visible. Hovering lifts a card to full size.
- Playable cards glow (PP-28). Unplayable cards look normal, with no grey-out.
- I can drag cards to reorder them, and the order is kept.
- 7 cards fit comfortably at 1280 px, and up to 15 fit by tightening the fan.
- Changed costs (tax, reductions) show the effective cost while I hold the decision (PP-03).

**Engine/server:** `ReorderHand`, and `spell_costs` from PP-03.

#### PP-20 Commander beside the hand
**P0. Effort S.**

**Acceptance:**
- While a commander is in the command zone, it shows to the left of my hand as a castable card. Its cost includes the tax, as in Arena's Brawl (check in Arena).
- Partner commanders show both cards.
- Opponents' commanders appear in their header chip.

**Engine/server:** `is_commander` and `commander_tax()`.

#### PP-21 Cards playable from other zones
**P1. Effort S.**

**Acceptance:**
- Cards I can cast from the graveyard, from exile, or from the top of my library appear to the right of my hand after a gap. Each is labelled with its zone.
- They are built from `by_object` options whose source isn't in my hand.

#### PP-22 Zone browsers
**P0. Effort M.**

**Acceptance:**
- Every player's graveyard and exile open from their header or pile chip.
- The browser is a grid, newest first, with a name and type filter. Tapping a card opens the inspector.
- The command zone shows commanders and emblems.
- Opponents' graveyard counts appear in their header; they are missing today.
- On a phone, the browser is a bottom sheet.

**Engine/server:** the zones are already in the view. They need metadata (PP-05).

### 3.4 Reading cards

#### PP-23 Inspector
**P0. Effort M.**

**Acceptance:**
- **Opening it:** right-click or a "Read" button on desktop, long-press on touch, at any window width.
- **Contents:**
  - a large image, with a flip button for double-faced cards;
  - the artist and copyright;
  - Oracle text as real text that follows the text-size setting;
  - current versus printed P/T, counters, and keywords with short reminder text;
  - attachments, "exiled with" cards, controller and owner;
  - this card's options as buttons.
- **Closing it:** Esc, the Android back gesture, or a tap outside.
- Reminder text is Yama's own short, plain wording, because AGENTS.md ships no rules documents. phase's client has a reminder list to borrow from (`viewmodel/keywordProps.ts`, MIT/Apache), if its wording isn't Wizards'.

This fixes today's bugs:
- With a mouse below 1000 px, a card can be read only while I have a decision.
- On wide screens, Oracle text can't be reached by mouse at all.

#### PP-24 Hover preview and keyword reminders
**P1. Effort S.**

**Acceptance:**
- The preview appears after 150 ms, on the side away from the pointer, 300-360 px wide.
- It never covers the decision area.
- A keyword panel sits beside it, one line per keyword.
- Card names in the log and on the stack show the same preview.

### 3.5 Casting, targeting and highlights

#### PP-25 Casting gestures
**P0. Effort M.**

**Acceptance:**
- **Desktop:**
  - Drag a hand card up past a line about 64 px above the hand, then release, to play it. phase uses this threshold (`HAND_DRAG_PLAY_THRESHOLD`).
  - Double-click does the same.
  - A single click selects the card and filters the options, as today.
- **More than one way to play** (adventure, modal double-faced face, flashback, alternative cost): a small popover opens at the drop point.
- **Backing out:** releasing below the line, or pressing Esc, returns the card.
- **Phone:** flick a card up 64 px to play it. Tap selects; long-press inspects.
- **Activating a permanent:** click it. If it has several abilities, a popover lists them with their costs.

**Engine/server:** one option per way to play (PP-04).

#### PP-26 Targeting on the board
**P0. Effort L.**

**Acceptance:**
- A banner at top centre says what to do, for example "Choose a target for Lightning Bolt (1 of 2)", plus the mode label for modal spells.
- Legal targets get an amber ring and a crosshair badge, and can be clicked directly. A player is targeted by clicking their header.
- **Arrows:**
  - While I aim, an arrow runs from the source (the card being cast, or the stack item) to the pointer.
  - After I choose, it runs to each chosen target.
  - Arrows use the controller's seat colour.
- Chosen targets get numbered badges. "Done (2/3)" enables once the minimum is met.
- **A lone legal target:**
  - phase already picks it automatically whenever exactly one legal assignment exists, for spells and abilities alike, unless an opponent chooses the target (`auto_select_targets`, `game/ability_utils.rs:1653`).
  - Arena may still ask for spells (check in Arena). Asking would need a phase patch (open question 17).
  - The stack item always shows the auto-picked target, so it's never a surprise.
- Esc, right-click or "Cancel" backs out, when the engine allows it.
- Non-targets are not dimmed or filtered.

**Engine/server:**
- `WaitingFor::TargetSelection {target_slots, mode_labels, selection {current_slot, current_legal_targets}}`, `TriggerTargetSelection`, and `pending_cast.object_id`.
- `current_target_kind` from derived views, for the banner wording.
- `allows_cancel_cast()` together with `CancelCast`.
- The target id on each option (PP-04).

**Web:**
- One fixed SVG overlay with `pointer-events: none`.
- The arrow is a quadratic curve. Its control point is offset perpendicular to the line by min(80, 0.3 × distance), as in phase's `arcPath.ts`.

#### PP-27 Modes and X
**P1. Effort S.**

**Acceptance:**
- **Modes:** each mode is a tile with its full text. "Choose two" is multi-select with a counter.
- **X:** a stepper with minus, value, plus and "Max", plus digit keys.
  - It defaults to the largest X I can afford.
  - It shows the total cost, for example "X=4: {4}{R}{R}". When the engine leaves out the previews (an empty or very large range), the cost is shown without X filled in.

**Engine/server:**
- Modes: `ModeChoice` / `AbilityModeChoice.mode_descriptions`, answered with `SelectModes`.
- X: `ChooseXValue {min, max, x_cost_previews}`, answered with `ChooseX`.

#### PP-28 Playable and activatable highlights
**P0. Effort S.**

**Acceptance:**
- **Hand cards with options:** a blue outline and a soft glow.
- **Battlefield permanents with options:** a thinner outline plus a small icon, so colour isn't the only cue.
- **When a decision arrives:** the outline breathes once, then stays steady. No looping pulse.
- Lands with only mana abilities don't glow all the time.
- The image itself is never filtered.

**Engine/server:** `by_object` (PP-04).

### 3.6 Mana

#### PP-29 Mana payment panel
**P0. Effort M. Needs PP-01.**

**Acceptance:**
- When the engine asks for payment, a panel above the hand shows the cost as pips that fill in as I pay.
- Usable sources glow. Clicking a land taps it. Clicking it again untaps it, as long as that mana is unspent.
- Pool chips ("2 green from Forest") let me choose which mana to spend.
- The panel has "Auto-pay the rest" and "Cancel" buttons.
  - Today the auto-pay button reads "Pass (move on)", or "Pass (let it resolve)" when the stack isn't empty. Fix that label first (M0).
- Sacrificing a mana source, such as a Treasure, always asks first.
  - Every cast today uses the engine's Auto mode.
  - Check whether Auto mode sacrifices a Treasure without asking.
- Labels use plain words, never "Tap Land For Mana (Selection: …)".

**Engine/server:**
- The `ManaPayment` WaitingFor. The engine asks only when auto-pay isn't choice-free (`game/casting_costs.rs:15858-15880`).
- Actions: `TapLandForMana`, `ActivateManaSource`, `UntapLandForMana`, `SpendPoolMana`, `UnspendPoolMana`, `PassPriority` (pays the rest), `CancelCast` and `ManaSourceSelection`.
- Untapping, pool spending and cancelling are in the interaction contract's payment choices (`game/interaction.rs:2106`). They are not in the AI sample, which has only tapping and pay-the-rest. So this needs PP-01, or those actions on the `act` whitelist.

#### PP-30 Auto-tap setting and preview
**P1. Effort M. Needs PP-01 or `act`.**

**Acceptance:**
- A "Tap mana for me" setting with three choices:
  - "Auto, but ask before sacrificing" (the default);
  - "Always auto";
  - "I'll tap".
- Full control switches to manual, as in Arena.
- Hovering or dragging a hand card lights up the lands auto-pay would tap.

**Engine/server:**
- `CastSpell {payment_mode: Auto | AutoExceptSacrificialMana | Manual}`.
  - The AI sample casts only in `Auto` mode.
  - So the other two modes need PP-01 or the `act` whitelist.
- A rate-limited server call that runs `preview_auto_payment_sources` (`game/preview.rs:204`) and returns source ids. It accepts only an exact engine-offered Auto cast.

#### PP-31 Mana shortcuts and floating mana
**P2. Effort M. Needs PP-01 or `act`.**

**Acceptance:**
- I can tap mana sources during normal priority to float mana. Mana abilities come through `by_object`.
- Z untaps.
- QQ floats all non-creature mana.
- Holding Q and clicking a land taps every land with that name.

### 3.7 Priority, stops and timers

#### PP-32 Primary and secondary buttons
**P0. Effort M.**

**Acceptance:**
- One large primary button. On desktop it sits bottom-right above the hand; on a phone, at the right end of the dock. Space presses it.
- Its label always says what will happen:

  | State | Label |
  |---|---|
  | Stack not empty | "Resolve" |
  | My main phase 1, with possible attackers | "To combat" |
  | Otherwise in my main phase 1 | "Next" |
  | Main phase 2 or end step | "End turn" |
  | Opponent's turn | "Pass" |
  | Declaring attackers | "Attack (3)" / "No attacks" |
  | Declaring blockers | "Block (2)" / "No blocks" |
  | Choosing a variable number of targets | "Done (2/3)" |
  | Mulligan | "Keep 7" |
  | Waiting | Disabled "Waiting for Ana", with her commander art |

- A secondary button covers the context: "Attack with all", "Reset blocks", "Resolve all" or "Mulligan".
- Full control, pass-the-turn and concede are in the main controls, not hidden in the log sheet.
- Spectators have no primary button.

**Engine/server:** the label comes from `WaitingFor`, the phase, the stack and combat (PP-03).

#### PP-33 Phase stop ladder
**P0. Effort M.**

**Acceptance:**
- The steps on the phase track can be clicked: upkeep, draw, main 1, beginning of combat, attackers, blockers, damage, main 2, end. Untap and cleanup are hidden.
- **Two ladders:**
  - The ladder beside my portrait sets stops for my turns.
  - The ladder beside the active opponent sets stops for opponents' turns. It applies to all opponents.
  - A click on a step toggles that ladder's stop on or off.
  - Yama combines the two ladders into one engine stop per step: my turns is `OwnTurn`, opponents' turns is `OpponentsTurns`, both is `AllTurns`.
  - phase's single control cycles off, then all turns, then own turn, then opponents' turns (`PhaseStopBar.tsx:157`). Its amber, emerald and rose colours include a red/green pair, so Yama doesn't copy them.
- The two kinds of stop differ in hue and in shape (filled or outlined), so colourblind players can tell them apart. Arena uses orange for my turn and blue for the opponent's.
- Standing stops are saved per user.
- "This turn only" stops are a Yama layer and clear at the end of the turn. Whether Arena's stops persist across turns: check in Arena.
- L shows or hides the ladder.
- On a phone, the phase chip opens a sheet with scope pills for each step.

**Engine/server:**
- `SetPhaseStops {stops}`, where each `PhaseStop` is `{phase, scope: AllTurns | OwnTurn | OpponentsTurns}` (`types/phase.rs`). Each call replaces the whole list.
- Per-opponent stops aren't in the engine; leave them out.

#### PP-34 Pass modes and full control
**P0. Effort M.**

**Acceptance:**
- **Enter:** pass until something happens that I could respond to. Opponents' spells and my stops interrupt it.
- **Shift+Enter:** pass the rest of this turn. Only blocks and my own stops interrupt it, as in Arena.
- **Pass to my turn:** a 4-player mode on its own button. It passes through every opponent's turn and is interrupted like Enter.
- **Feedback:**
  - While any pass mode is on, a chip says so ("Passing this turn", "Passing to your turn"), with a Stop button.
  - For 2 s after Shift+Enter, the chip is a larger toast, because Arena players hit Shift+Enter by accident.
  - Stopping cancels the mode. Passes already made stay made.
- **Ctrl:** full control until I pass. **Ctrl+Shift:** full control stays on. **Phone:** long-press my portrait. A chip says "Full control", with a Stop button.

**Engine/server:**
- Enter maps to `SetAutoPass {UntilTurnBoundary {EndOfCurrentTurn}}`. The engine interrupts that session when an opponent puts something on the stack or a stop hits.
- "Pass to my turn" maps to `UntilTurnBoundary {MyNextTurnStart}`.
- Shift+Enter has no engine equivalent, because every engine session stops for opponents' spells. Yama needs a per-seat flag that keeps passing through stack windows until the turn ends. Blocks still stop it, because declaring blockers isn't a priority window.
- `CancelAutoPass` and `SetPriorityPassingMode` cover the rest.

#### PP-35 Yields, remembered choices, Resolve all
**P1. Effort M.**

**Acceptance:**
- Each stack item offers "Auto-pass this trigger", for this copy or for all copies.
- "May" triggers and replacement choices offer "Always for this card this game".
- "Resolve all" resolves my items until a stop or a required choice comes up.

**Engine/server:**
- `SetPriorityYield {op: Add {source_id, scope} | Remove | ClearAll}`.
- `SetMayTriggerAutoChoice` and `DecideOptionalEffectAndRemember`.
- `SetReplacementAutoChoice` and `ChooseReplacementAndRemember`.
- `BeginResolveAll {scope: Own}`. Use `Shared` only for loop shortcuts, where every player must agree.

#### PP-36 Turn, priority and waiting indicators
**P0. Effort S.**

**Acceptance:**
- The active player's pane has a ring and a "Turn 7" label.
- The seat holding priority gets its own mark. MTGO highlights priority rather than the active player.
- Seats the game is waiting on show "deciding", as today. In combat, the defending player who is declaring blockers is named ("Ben is declaring blockers").
- My own area says "Your turn" or "Your priority" when either applies.

#### PP-37 Undo and gameplay warnings
**P1. Effort S.**

**Acceptance:**
- Anything still being put together can be undone with Z or Reset before I confirm: attackers, blocks, a damage split, scry piles, targets. Nothing is sent until I confirm.
- Mana taps can be undone until the mana is spent (`UntapLandForMana`, after PP-01).
- A cast can be backed out with `CancelCast` where the engine allows it.
- Once I pass priority, nothing can be undone, as in Arena.
- **Optional warnings** (a setting, on by default):
  - a harmful spell I aim at my own permanent;
  - "No attacks" when I have creatures that could attack. A second tap confirms.
- A lone target auto-picked by the engine can't be warned about before the cast. The stack item shows it instead (PP-26).

#### PP-38 Idle and disconnected seats
**P1. Effort S.**

**Acceptance:**
- When a human hasn't acted for a few minutes (a host setting), other players get a "Nudge" button.
- The host can choose "Let AI play this seat" until the player returns.
- A required decision is never made for a human any other way.

**Engine/server:** Yama already has AI seats. Presence comes from PP-08.

#### PP-39 Optional table timer
**P2. Effort M.**

**Acceptance:**
- Off by default; it can be turned on in the lobby.
- The server holds the deadline (`deadline_ms`). In the last 30 s a rope burns around the deciding player's portrait and primary button.
- When time runs out:
  - in a priority window, the player auto-passes;
  - for a required decision, the host is offered the AI handoff.
- The timer pauses during animations and during other players' decisions.

### 3.8 Combat

#### PP-40 Declaring attackers on the board
**P0. Effort L.**

**Acceptance:**
- Clicking (or tapping) a creature toggles it as an attacker. It slides forward about 12 px and shows a chip with its defender's commander art.
- **Choosing a defender:**
  - If only one defender is legal, it is assigned automatically.
  - Otherwise the last defender I picked is reused.
  - If I haven't picked one, the possible defenders pulse, and I click an opponent's header, a planeswalker or a battle.
- Dragging an attacker onto a defender selects it and assigns the defender in one move.
- Any subset of creatures can attack, split across any defenders.
- "Attack with all" offers "All at Ana", "All at Ben", "All at Cat" and "Split".
- Clicking a stack's count toggles the whole stack.
- Creatures that must attack show a badge. The confirm button stays disabled until the declaration is legal, and says why ("Goblin must attack").
- Attack taxes (Propaganda effects) come as the next step.

**Engine/server:**
- Data: `DeclareAttackers {valid_attacker_ids, valid_attack_targets, valid_attack_targets_by_attacker, attacker_constraints}`.
- Submit `GameAction::DeclareAttackers` through `act` (PP-01). `validate_attack_declaration` checks it.
- `CombatTaxPayment` follows when a tax applies.

#### PP-41 Declaring blockers on the board
**P0. Effort L.**

**Acceptance:**
- Attackers coming at me appear in an "Incoming" lane with their art and power. Attacks aimed at other players are shown smaller.
- I drag a blocker onto an attacker, or click the blocker and then the attacker. A connector line appears. Clicking an assigned blocker removes it.
- Several blockers can be assigned at once. One blocker can block several attackers when the rules allow it.
- Menace and other block requirements show a chip, for example "Needs 2 blockers". Must-block and can't-block creatures show badges.
- Defending players declare one at a time. The others see who is declaring.
- Primary button: "Block (2)" / "No blocks". Secondary button: "Reset".

**Engine/server:**
- Data: `DeclareBlockers {valid_blocker_ids, valid_block_targets, block_requirements, blocker_constraints, must_be_blocked_targets, block_capacities}`.
- Submit through `act`. `validate_blockers_for_player` checks it.

#### PP-42 Combat shown to everyone
**P0. Effort M.**

**Acceptance:**
- During combat, every player and spectator sees which creatures attack, at whom, and which creatures block which.
- My area shows "Attacking you: 3 creatures, 9 damage". Each opponent's pane shows the same for them.
- Arrows to a player end at their header. Arrows to a planeswalker end at its tile.
- Colours follow the attacking seat.

**Engine/server:** `state.combat` and derived `blocker_assignment_pairs` (PP-03).

#### PP-43 Combat damage assignment
**P1. Effort M. Needs PP-01.**

**Acceptance:**
- The engine decides when to ask (`needs_interactive_assignment`, `game/combat_damage.rs:1057`). It asks when there are two or more blockers, trample with damage to spare, or an "assign as though unblocked" effect. Otherwise it assigns the damage itself.
- When it asks, a panel opens, filled in with the default split, so one "Done" accepts it. The panel shows:
  - the total, as in "5 to assign, 0 left";
  - one row per blocker with a "lethal 3" hint and steppers;
  - a trample row with the defending player's art.
- Damage is divided freely, with no damage assignment order. This has been the rule since Foundations (November 2024).

**Engine/server:**
- `AssignCombatDamage {total_damage, blockers [{blocker_id, lethal_minimum}], trample, …}`.
- `AssignBlockerDamage` and `DistributeAmong` use the same widget.
- Submit through PP-01. The AI sample has only the greedy split.

#### PP-44 Combat math and threat warnings
**P1. Effort M.**

**Acceptance:**
- An incoming summary adds "Lethal" when the unblocked damage is at least my life. The word is written in normal case, not capitals.
- Commander damage shows per commander, for example "18 of 21". It turns amber at 15 and red at 18, with an icon as well as the colour.
- Poison shows the same way, for example "7 of 10".
- While I block, creatures that would die from combat damage alone get a skull badge.

**Engine/server:**
- `commander_lethal_headroom()` (`game/commander.rs:102`).
- `lethal_damage_needed()` (`game/combat_damage.rs:1469`, accounts for deathtouch).
- `derived.commander_damage_by_attacker`.

#### PP-45 "If no one responds" preview
**P2. Effort M.**

**Acceptance:**
- When I hover a planned attack or block (desktop), or after I choose it (phone), ghost results appear: skulls on creatures that would die, and "-5" on players.
- Block previews are labelled "If no one responds". Attack previews are labelled "If unblocked and no one responds".
- The preview shows only life changes and creatures dying from combat damage. It never shows library, hand or revealed-card changes.

**Engine/server:**
- `preview_action` (`game/preview.rs:158`) simulates a single action only. This preview needs a Yama loop:
  1. clone the state;
  2. apply the declaration;
  3. assume no responses, plus the blocks shown (or no blocks, for an attack);
  4. pass through combat damage;
  5. diff the result.
- Diffing filtered states is not enough on its own. A simulated draw ("whenever this deals combat damage to a player, draw a card") would show me my next card. Stop before triggers resolve, and report only life totals and deaths.
- Limit it to about 5 calls per second per seat.

### 3.9 The stack and triggers

#### PP-46 Stack rail
**P0. Effort M.**

**Acceptance:**
- On desktop, the stack sits in the right rail. The top item is the largest and says "Resolves next".
- Each item shows:
  - the controller's seat colour and commander art chip;
  - the name;
  - for abilities and triggers, the ability's own text and any chosen modes;
  - target chips.
- Hovering an item:
  - draws arrows to its targets, in the same colour as the item's text (as Arena does);
  - highlights its source permanent.

  Clicking opens the inspector.
- Identical adjacent items show as one row with "×3", using the engine's grouping. When they're split, they're numbered #1, #2.
- The rail shows who has priority.
- Older items fold into "+6 more".
- On a phone, a strip above the dock shows the count. Tapping it opens the list in a sheet.

**Engine/server:** `stack_entry_details` and `stack_display_groups` from derived views (PP-03).

#### PP-47 Spotlight for opponents' spells, and minimum reading time
**P0. Effort S.**

**Acceptance:**
- When another player casts a spell, the card shows large in the centre for 600-900 ms, then flies to the stack. My own spells skip this.
- An opponent's or AI's stack item stays visible for at least 400 ms. If it targets me or my permanents, the minimum is 800-1,000 ms. These are starting values: Arena's own figure isn't documented (check in Arena).
- None of this blocks input, and skip works.

**Engine/server:** per-action events from PP-02.

#### PP-48 Trigger ordering
**P1. Effort M.**

**Acceptance:**
- A list runs from "Resolves first" to "Resolves last".
- Each row shows the source art, the card name and the trigger's own text. Duplicates are numbered #1, #2.
- Reorder with drag handles, or with up and down buttons on a phone.
- **Saved orders:**
  - phase saves every non-default order I submit, and reuses it the next time the same cards trigger together (`record_submitted_trigger_order`, `game/triggers.rs:7846`).
  - So there's no "Remember" toggle. A custom order shows "Saved for next time", and settings offer "Forget saved trigger orders".
- Identical triggers from the same card are ordered automatically (a Yama rule). With full control on, I'm always asked.

**Engine/server:**
- `OrderTriggers {triggers [{source_id, source_name, description}]}`.
- `SetTriggerOrderTemplate {op: ClearAll}` is the only template operation.
- Free ordering of 5 or more triggers needs PP-01.

### 3.10 Library choices, mulligan, other choices

#### PP-49 Scry, surveil, dig
**P0. Effort M.**

**Acceptance:**
- **Scry:** two zones, "Top" and "Bottom", with card images. Drag cards between them, and reorder within Top. The next card I'll draw is labelled.
- **Surveil:** two zones, "Library" and "Graveyard".
- **Dig and reveal:** pick from images. "Put the rest on the bottom in any order" uses the same ordering list.
- **Phone:** a toggle chip on each card, plus up and down buttons.

**Engine/server:**
- The `ScryChoice`, `SurveilChoice`, `DigChoice`, `DigRestSplitChoice` and `RevealUntilBottomOrder` variants, answered with `SelectCards`.
- Partial splits need PP-01.
- Card data goes to the deciding seat only (PP-05).

#### PP-50 Library search browser
**P0. Effort M.**

**Acceptance:**
- A grid with a name filter and sorting by name, mana value or type.
- Selected cards lift and get a check mark.
- "Find nothing" appears when allowed. The confirm button reads "Done (1/2)".
- Every legal card can be chosen.
- A split search (Cultivate) asks where each found card goes next.
- Other players see "Ana is searching their library".

**Engine/server:**
- `SearchChoice {cards, count, up_to, allows_partial_find, constraint, split}`, answered with `SelectCards` through PP-01.
- "Find nothing" is allowed when `up_to` or `allows_partial_find` is set.
- A split continues as `SearchPartitionChoice`.
- Today `ENGINE_CANDIDATE_CAP` (12) limits the option list.

#### PP-51 Mulligan
**P0. Effort S.**

**Acceptance:**
- A large overlay shows my hand, and who goes first (the d20 roll).
- Primary button "Keep 7". Secondary button "Mulligan (free)" or "Mulligan to 6".
- Each opponent's status is shown: "Thinking", "Kept", "Mulliganed once".
- **Bottom step:** "Put 1 card on the bottom".
  - Clicking a card moves it to a Bottom tray; clicking it there brings it back.
  - The confirm button reads "Done (1/1)".
- All players decide at the same time, with no stale errors (PP-06).

**Engine/server:**
- `MulliganDecision {pending, free_first_mulligan}`, then the bottom-cards step in the same variant.
- The bottom step already offers every combination of the whole hand, with no cap, but as one button each: 7 buttons for one card, 21 for two, 35 for three. The tray needs PP-01's `Select` response.
- phase emits the starting-player contest as an event at game start.

#### PP-52 Other choices
**P1. Effort M.**

**Acceptance:**
- "May" prompts say what the effect does, for example "Draw a card?" (from `OptionalEffectChoice.description`). Today they only say "Yes" / "No".
- Replacement choices name the effect.
- The commander zone choice shows the card: "Put Atraxa into the command zone?" (`CommanderZoneChoice`).
- Discarding to hand size picks from card images.
- **Naming a card:** a search box with autocomplete.
- **Choosing a colour:** five pip buttons.
- **Choosing a number:** the X stepper.
- **Votes, crew, ring-bearer and similar:** tiles with card images.
- Cards revealed to me (by any player or effect) show in an overlay until I dismiss it, and stay in the log.
- The generic fallback uses plain words and seat names.

### 3.11 Animation and sound

#### PP-53 Animation queue
**P0. Effort L.**

**Acceptance:**
- Events from PP-02 play in order. Timings at 1x, ported from phase's client:

  | Event | Duration |
  |---|---|
  | Zone change | 400 ms |
  | Cast | 500 ms |
  | Combat damage exchange | 900 ms |
  | Life change | 300 ms |
  | Destroyed | 400 ms |
  | Token | 400 ms |
  | Counter | 200 ms |
  | Tap or untap | 200 ms |
  | Turn banner | 900 ms (phase uses 1,500 ms, which is too long with four turns per round) |

- **Batching:** a run of more than 8 similar events plays as one beat. 12 or more combat damage events play as one 900 ms flurry.
- **Card movement:**
  - A card moves as one piece from where it was to where it went.
  - It uses FLIP with the Web Animations API, keyed by object id. phase keeps a card's id when it changes zone.
- **Draws:**
  - My draws fly from the library to my hand in 300 ms, staggered by 80 ms.
  - An opponent's draw is a card back flying into their pane, and their hand count ticks up.
  - The card back is a plain Yama back, or Scryfall's back loaded at runtime, never a shipped Wizards image.
- **Death and exile:** the card lifts, particles play around it, and it flies to the pile. No shader is applied to the card image.
- The board always settles on the latest View. If I act while animations are queued, they finish at once.
- Only `transform` and `opacity` are animated.

**Web:**
- No new dependency.
- Port the durations and grouping rules from phase's `client/src/animation/types.ts` and `eventNormalizer.ts` (MIT/Apache), keeping the attribution.

#### PP-54 Speed, skip, catch-up, reduced motion
**P0. Effort M.**

**Acceptance:**
- An animation speed setting from Instant to 2x (default 1x), with separate multipliers for effects, combat and banners.
- **Skipping:** Space, Esc, or a tap on the board skips the queue. A "Skip" chip shows while more than about 1 s is queued.
- **Catch-up:**
  - With more than 2.5 s queued, the rest plays at 2x.
  - With more than 6 s queued, the board jumps to the end.
  - While the tab is hidden, events apply without animating.
- Actions between other players that don't involve me play at about 0.6× their normal duration.
- `prefers-reduced-motion`, or the matching setting, turns flights into 120 ms crossfades and turns off shake, particles and pulses.

#### PP-55 Life and damage feedback
**P0. Effort S.**

**Acceptance:**
- A floating number appears at the target: "-3" in red with a down arrow, or "+2" in green with an up arrow. It rises 60 px over 0.8 s.
- Life totals tick through each total the engine reports, 300 ms per change, landing with the hit. `LifeChanged` carries `new_total` when reported. Otherwise sum the amounts.
- When I take 5 or more damage, the screen edge flashes light red and shakes 4 px for 150 ms. Reduced motion turns this off.
- Lifelink sends particles from the source to its controller's life total.
- Effects never cover a life total.

#### PP-56 Turn banner and decision alerts
**P1. Effort S.**

**Acceptance:**
- A "Your turn" banner shows for 900 ms. Other players' turns get a small toast.
- A new decision plays a soft ping.
- If the tab is hidden, a new decision also:
  - changes the page title to "(!) Your move";
  - sets an app badge where supported (desktop; Android shows badges only through notifications);
  - shows a notification (permission is asked once);
  - vibrates on Android.

#### PP-57 Sound
**P1. Effort M.**

**Acceptance:**
- One Web Audio context, unlocked on the first tap.
- Separate volumes for master, effects, music and alerts, saved locally. A mute button on the board.
- About 18 sounds: draw, land, cast, resolve, counterspell, token, counter added, attack, block, creature hit, player hit, life gain, death, exile, your turn, decision ping, victory and defeat.
- Each sound has 2-3 variants, with pitch varied by ±3% so repeats don't grate.
- Sounds of the same type within 60 ms merge, and at most 4 play at once.
- Defaults: effects on, music off.
- No information is given by sound alone.

**Assets:** CC0 or clearly licensed sounds. phase ships `client/public/audio/sfx` and `music` with no licence file beside them. Check their licences before reusing any.

### 3.12 Log, end of game, social

#### PP-58 Rich game log
**P1. Effort M.**

**Acceptance:**
- Card names are chips that show the card on hover or long-press. Player names appear in seat colours.
- Turn dividers read "Turn 7, Ana". Per the AGENTS.md rule, they don't use a middle dot.
- Filters: combat, stack, life, zones, tokens, triggers.
- Essential lines show by default, with a "Details" toggle for the rest.
- Lines include targets, for example "Ben casts Swords to Plowshares targeting Ana's Atraxa".
- No duplicate lines. One game shows "plays Sacred Foundry" twice.
- The whole game is kept. Today the log is trimmed back to 60 lines once it passes 240.

**Engine/server:**
- Send `GameLogEntry.segments` (`Text`, `CardName {name, object_id}`, `PlayerName {name, player_id}`, `Number`, `Mana`, `Zone`, `Keyword`), `category` and `presentation.importance`.
- Stop flattening entries with `segments_text()`. The saved log format changes; old games keep their text lines.
- Find where the duplicates come from: lands with an enter-the-battlefield replacement choice.

#### PP-59 "Since your last turn" and a recent-plays strip
**P1. Effort M.**

**Acceptance:**
- At the start of my turn, a dismissible summary per opponent, for example "Ben: cast Cultivate, attacked you for 5".
- A strip shows the last 5 resolved spells and abilities as thumbnails. Tapping one shows the card and its targets.

#### PP-60 Replay viewer
**P2. Effort L.**

**Acceptance:**
- Built from the saved replay log, with a turn scrubber, play/pause and speed control.
- The viewer picks one seat's view, which shows only that seat's information.
- `final_view` already rebuilds a finished game's board from its replay; the viewer extends that.

#### PP-61 End of game and elimination
**P1. Effort M.**

**Acceptance:**
- **Mid-game elimination:** a banner such as "You were knocked out by Ben's Atraxa (commander damage) on turn 9", with "Keep watching" and "Leave".
- **End of game:**
  - The winner's commander art at full size, unfiltered and credited.
  - A headline such as "Ana wins on turn 11".
  - For each player: final life, how and when they were eliminated, damage dealt, biggest hit, and commander casts.
  - Buttons: Rematch (same seats and decks), Watch replay, Copy log, Back to lobby.

**Engine/server:** `PlayerEliminated`, `GameOver`, and the event feed for the stats.

#### PP-62 Quick phrases
**P2. Effort S.**

**Acceptance:**
- Phrases: "Hello", "Good game", "Nice", "Thinking", "Hold on, responding", "Go ahead", "Your go", "Be right back", "Oops", "Thanks".
- A phrase shows as a bubble on the sender's pane for 2.5 s, plus a faint log line.
- Limits: 1 every 3 s and 6 per minute.
- Mute per player, plus a global off switch.
- Cosmetic effects run only on the local client and are capped. This stops the lag attacks Arena saw with pets.

### 3.13 Performance

#### PP-63 Performance budgets
**P0. Effort M.**

| Measure | Budget |
|---|---|
| Touch to visible response (pending state, selection, drag) | 50 ms or less; aim for one frame |
| Server: message in to view out, 4 seats, excluding AI thinking | 100 ms or less at p95 |
| Replay save | Off the critical path: after publishing, or append-only |
| Each view update after the first | 25 KB median, uncompressed. A starting target: measure first |
| Client render of one update | 8 ms on desktop; 16 ms on a mid-range Android phone |
| Animations | 60 fps on a mid-range Android phone; at most 96 particles |
| Board usable after the socket opens | 1 s with a warm cache; 3 s cold |
| AI seat passing priority with nothing to do | 100 ms or less per seat |
| Images | Small or art crop (WebP where available) on tiles; normal only in the preview and inspector; `img.decode()` before a flight; service-worker cache (already caches up to 1,500 images) |

**Acceptance:**
- A developer overlay or log shows these numbers.
- A bench run reports server timings.
- A regression of more than 20% is flagged in review.

**Server notes (measure first, then cache per revision):**
- Each view calls `filter_state_for_viewer` twice and issues the AI contract again for each seat.
- Each auto-pass issues the contract three times: in `should_auto_pass`, in `auto_pass` and in `choose`.
- A spectator view is built on every publish, even with no one watching.
- Every message re-sends the full card-text map for the board.
- `save` makes the game thread wait while it rewrites the whole replay JSON (size not measured), and only then does the AI run.

#### PP-64 Faster AI turns
**P1. Effort M.**

**Acceptance:**
- An AI seat with no castable response passes at once.
- Priority windows get a capped search budget, for example 300 ms. Main-phase decisions keep 1.5 s (`AI_SEARCH_TIME_BUDGET_MS`, `phase-ai/src/config.rs:26`).
- If an AI seat thinks for more than 500 ms, a "thinking" chip shows on it.
- In a 4-player game where none of the three AIs can respond, a spell I cast resolves within 1 s. Measure today's time first.

### 3.14 Accessibility

#### PP-65 Accessibility settings
**P1. Effort M.**

**Acceptance:**
- Text size from 90% to 150%, which also applies to Oracle text.
- A colourblind-safe seat palette (Okabe-Ito, with no red/green pair). See open question 5.
- Every highlight pairs its colour with an icon or a shape.
- Reduced motion (PP-54), and effects quality: full, reduced or minimal.
- Volume controls.
- Quick phrases on or off.
- On phones, the dock can sit on the left or the right.

#### PP-66 Keyboard play and screen reader
**P1. Effort M.**

**Acceptance:**
- **Hotkeys:** Space, Enter, Shift+Enter, Ctrl, Ctrl+Shift, Z, Esc, L, 0-5, Tab, and "?" for a help sheet that lists them all.
- No hotkey fires while typing in a text field.
- **Focus order:** decision, hand, my board, then opponents. Arrow keys move between cards, and Enter activates.
- An `aria-live="polite"` region announces essential log lines, for example "Ben cast Lightning Bolt targeting you".

### 3.15 Phone

#### PP-67 Phone portrait layout
**P0. Effort L.**

**Acceptance:** the baseline is an Android phone about 412×915 CSS px, and the layout also works at 360 px wide. From top to bottom:
- **Opponent tab rail** (about 56 px, one tab per opponent; it scrolls with 4 or 5 opponents).
  - Each tab shows round commander art, name, life, a turn ring, an incoming-attack badge and a target crosshair.
  - Tapping a tab focuses that opponent. While targeting, tapping the avatar targets them.
- **The focused opponent's board:** mirrored, two rows, about 30% of the height.
- **A centre strip** (about 32 px): phase chip, stack chip, combat summary.
- **My board:** about 30% of the height.
- **A decision bar:** prompt, chips and the primary button.
- **The hand drawer** (PP-68).

Behaviour:
- The view follows the active opponent by default. It never switches during targeting or blocking, and a pin stops it following.
- Rows don't wrap. Lands collapse past 4 stacks; creatures scroll sideways past 6.
- Safe-area insets are respected.
- Drags don't trigger pull-to-refresh or page scrolling.
- The browser's long-press menu is suppressed on cards.
- Spectators get the same layout with a seat picker in place of the hand and decision bar.

#### PP-68 Hand drawer
**P0. Effort M.**

**Acceptance:**
- The hand peeks at about 40% of its height, and a tap fans it out.
- It tucks itself away when nothing is playable, as Arena does.
- The playable glow shows even in the peek.
- The commander and cards playable from other zones are inside the drawer.

#### PP-69 Phone gestures
**P0. Effort M.**

| Gesture | Action |
|---|---|
| Tap | Select and filter options (as today) |
| Long-press for 350 ms | Inspector, with `navigator.vibrate(10)` |
| Flick a hand card up | Play it |
| Tap a creature, then a defender or attacker | Attack or block |
| Long-press my portrait | Full control |

Also:
- The Android back gesture closes the topmost sheet. It never leaves the game without asking first.
- The primary button sits within thumb reach.
- Touch targets are at least 44 px.

#### PP-70 Installed-app behaviour
**P1. Effort S.**

**Acceptance:**
- The screen stays awake during a game (Wake Lock API).
- Haptics fire on my turn, when I'm attacked, and when a decision arrives.
- A "Your move" notification shows while the app is open in the background. This is best effort: Chrome on Android may freeze a background page after a few minutes, which closes the socket.
- Reliable notifications while the app is in the background or closed need Web Push; see the open questions.

#### PP-71 Phone landscape
**P2. Effort M.**

**Acceptance:**
- An optional landscape layout: one opponent at a time beside my board, as playgroup.gg does.
- The short-screen minimum tile height of 56 px applies.
- Whether Arena on phones is landscape-only: check in Arena.

---

## 4. Build order

Each milestone can ship on its own and leaves the game playable.

Several items depend on others:
- Manual mana (PP-29 to PP-31), the scry, search and mulligan widgets, free trigger order and damage assignment all need PP-01's interaction contract.
- Arrows need stable anchors (PP-12) and the overlay (PP-26).
- Felt removal waits for Bryan's pick on the design canvas.

The order below follows those dependencies.

| Milestone | Requirements | Done when |
|---|---|---|
| **M0 Fix what's broken today** (current board) | PP-04, PP-05, PP-06, PP-23. Plus first steps of other requirements:<br>- PP-09: no image filter or fade, no badges over the artist line, no middle dot<br>- PP-03: my own face-down cards visible to me; transformed cards on their current face<br>- PP-29: the payment button label<br>- PP-32: full control and concede out of the log sheet<br>- PP-07: stops after attackers and after blockers when I have an instant play<br>- PP-11: opponent graveyard counts<br>- PP-63: timing instrumentation, including AI pass time and stops per round | All planeswalker abilities and same-name targets are reachable. Double taps do no harm. Cards can be read at any width with a mouse. No CSS filter on card images. A defender can respond before blocks. Server timings are logged |
| **M1 Real combat, real state** (current board, simple controls) | PP-03, PP-01 step 1 (`act` for attacks and blocks), PP-08, PP-36. Click-to-toggle versions of PP-40 and PP-41, with a text combat summary (PP-42 without arrows) | I can attack Ana with two creatures and Ben with one, and block two attackers with two creatures. Everyone sees who attacks whom. Reconnect is clean |
| **M2 The new board** (from Board.dc.html and BoardPhone.dc.html, once Bryan picks a direction) | PP-09, PP-10 to PP-15, PP-18, PP-19, PP-20, PP-22, PP-24, PP-28, PP-67, PP-68, PP-69, PP-70. The arrow overlay and anchors (from PP-26), used for combat arrows (PP-42) and drag-to-attack and drag-to-block (PP-40, PP-41) | A 4-player game plays start to finish on a laptop and on Bryan's Android phone without page scrolling. A 20-token board stays readable. Combat shows arrows. A 5-player game still fits |
| **M3 Turn controls** | PP-07, PP-32, PP-33, PP-34, PP-35, PP-64 | Stops and pass modes work from the keyboard and by touch. Opponents' turns don't stop me more often than in M0 unless I set a stop. With no AI able to respond, my spell resolves within 1 s |
| **M4 Casting, targeting, stack** | PP-25, PP-26, PP-27, PP-46, PP-21, PP-37 (except mana undo) | Lightning Bolt is dragged out and aimed with an arrow. The stack shows trigger text and targets |
| **M5 Every choice answerable** | PP-01 complete (interaction contract), PP-29, PP-30, PP-49, PP-50, PP-51, PP-52, PP-48, PP-43 | Scry 3 keeps 2 cards in the chosen order. A 2-card tutor sees the whole library. 5 triggers can be ordered freely. Mana can be paid by hand, with undo. Index buttons appear only for rare decisions. Soak tests pass |
| **M6 Motion and sound** | PP-02, PP-53, PP-54, PP-55, PP-47, PP-56, PP-57 | An AI's turn reads as a sequence at 1x and can be skipped. Life totals tick with floating numbers. 60 fps on Bryan's phone. Sound has a mute button |
| **M7 Information and endings** | PP-58, PP-59, PP-44, PP-61, PP-16, PP-38, PP-65, PP-66 | The log shows targets and card chips. "Since your last turn" works. Commander-damage and lethal warnings show. The end screen offers Rematch |
| **M8 Extras** | PP-17, PP-31, PP-39, PP-45, PP-60, PP-62, PP-71 | Each item ships on its own |

PP-63's budgets apply as a gate from M2 onwards.

M2 is the largest milestone. Desktop and phone can ship one after the other, because they share the same tiles, rows and hand components.

PP-02 can move ahead of M4 if the spotlight (PP-47) is wanted sooner.

---

## 5. Open questions for Bryan

Each has a recommendation, so a yes or no is enough.

1. **Ten-minute Arena check.** Confirm these in your install:
   - the primary-button labels through one whole turn;
   - whether Arena stops at every step of an opponent's turn when you hold an instant (this decides PP-07);
   - whether a spell with only one legal target still asks you to click it;
   - that Shift+Enter is interrupted only by blocks and stops;
   - whether stops persist across turns;
   - how summoning sickness, buffed P/T and keyword icons look;
   - the mulligan bottom-card screen and the X picker;
   - the trigger-order and manual damage screens;
   - the emote list, and whether friend games can be watched;
   - whether phone Arena is landscape-only.
2. **Cropping commander art.** ARCHITECTURE.md section 11 says "no cropping or recoloring", which is stricter than Scryfall. Scryfall allows the art crop if the artist and the copyright appear in the same interface. Recommendation: allow `object-fit: cover` on the art crop with "Art: Name, © Wizards of the Coast" in the header, and update ARCHITECTURE.md.
3. **Text over art.** A solid band, or a dark gradient over the art? AGENTS.md bans decorative gradients. Recommendation: a solid band.
4. **Partner or Background commanders.** Split the header art between both cards, or show only the first? Recommendation: split.
5. **Seat colours.** Keep the deck's first identity colour, or use a fixed colourblind-safe palette per seat? Today two mono-green decks look the same. A fixed palette changes AGENTS.md's "mana colours only mean whose" rule. Recommendation: a fixed palette, plus colour-identity pips, and update the rule.
6. **Replace the "felt green" rule in AGENTS.md?** Recommendation: yes, as soon as you pick direction A, B or C on the design canvas, using that direction's tokens.
7. **Mana and keyword symbols.** AGENTS.md says to ship no mana symbol art, so the `mana-font` icon font that phase uses is out. Recommendation: load mana symbols from Scryfall at runtime (it serves symbol SVGs), and draw our own simple keyword icons.
8. **Phone orientation.** Portrait first and landscape later (recommended), or landscape too from the start?
9. **Idle players and timers.** May the host hand an idle player's seat to the AI? Should a table timer exist at all? Recommendation: AI handoff yes; timer off by default.
10. **Take-backs.** Add "Ask to take back", which needs every player's consent?
    - phase's `server-core` has a takeback module: every human seat approves, and the game rewinds to a turn boundary.
    - Yama could do the same by cutting the replay log.
    - But a rewound game replays the same shuffles, so anyone who saw a later draw knows what's coming.

    Recommendation: later (P2), and only back to the start of the current turn.
11. **Talking.** Quick phrases only, or text chat as well? Your group probably talks on voice already. Recommendation: phrases only.
12. **Sounds.** May Yama ship CC0 sound files? AGENTS.md bans card images, mana art and rules documents, but says nothing about sounds. Recommendation: yes, CC0 only.
13. **Borrowing from phase.** May Yama borrow code from phase's MIT/Apache client (timings, arrow maths, layout rules, reminder text) with attribution? And may the phase fork carry more patches if an engine field must be exposed? Recommendation: yes to both, keeping the patches in `patches/phase/`.
14. **AI speed versus strength.** Cap AI thinking in priority windows at about 300 ms so turns move faster? Recommendation: yes.
15. **Defaults.** Animation speed 1x, sound effects on, music off?
16. **Push notifications.** Do you want "your move" notifications when the app is in the background or closed? That needs Web Push keys on the server. Recommendation: later.
17. **Lone targets.** phase picks a spell's target automatically when only one is legal; Arena may ask. Keep phase's behaviour and show the pick on the stack (recommended), or patch phase to always ask for spells?
18. **5- and 6-player games.** Keep allowing them online, with compact opponent strips (recommended)? Or cap online games at 4 until the new board is done?
19. **Watching.** Design the spectator view in M2? Recommendation: yes, kept minimal: the same board with no hand, plus a seat picker.
20. **Where to start.** Recommendation: M0, then M1, while the design canvas settles M2.

---

## Sources

**Web (checked 2026-10-18):**
- Arena's four-player plans:
  - [Draftsim, 2026-08-28](https://draftsim.com/mtg-wizards-confirms-commander-coming-to-arena/) (Dave Finseth interview recap)
  - [Draftsim, 2025-08-22](https://draftsim.com/mtg-designer-confirms-multiplayer-incoming/)
  - [GGRecon](https://ggrecon.com/guides/will-commander-come-to-mtg-arena/)
- Arena interface, hotkeys and settings:
  - [MTG Arena Zone hotkeys, 2022-08-24](https://mtgazone.com/arena-hot-keys-and-interface-guide-simplify-your-game-with-these-easy-tricks/) (Enter, Shift+Enter, Ctrl, Z, QQ; orange and blue stops)
  - [MTG Arena Zone: playing a match, 2022-08-24](https://mtgazone.com/playing-a-match/) (stops beside the portraits; stops apply even during Pass Turn; clicking a pile's number assigns the pile)
  - [Hipsters of the Coast](https://www.hipstersofthecoast.com/2018/03/how-to-play-mtg-arena-the-in-match-screen/)
  - [Draftsim settings](https://draftsim.com/mtg-arena-settings/)
  - [Draftsim mobile](https://draftsim.com/mtg-arena-mobile/)
  - [Wizards mobile FAQ](https://magic.wizards.com/en/news/mtg-arena/mtg-arena-mobile-faqs-2021-01-28)
  - [Wizards on Battles](https://magic.wizards.com/en/news/mtg-arena/we-put-battles-on-mtg-arena-what-was-that-like) (battles on the protector's side)
  - [Patch 0.9.0](https://devtrackers.gg/magic-arena/p/b545ab55-0-09-00-patch-notes)
- Player feedback:
  - [skip long trigger animations, 2026-09-07](https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/51677341-option-to-speed-up-or-entirely-skip-long-sets-of-t)
  - [upkeep pause after milling out](https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/51555212-upkeep-pause-after-milling-out)
  - [full control](https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44453517-full-control)
  - [no match history](https://draftsim.com/mtg-arena-match-history/)
- Other clients:
  - [MTGO multiplayer guide](https://www.mtgo.com/getting-started/getting-started-multiplayer)
  - [TableCommander controls](https://beta.tablecommander.com/docs/gameplay/controls)
  - [Forge PlayArea.java](https://raw.githubusercontent.com/Card-Forge/forge/master/forge-gui-desktop/src/main/java/forge/view/arcane/PlayArea.java)
  - [XMage GamePanel.java](https://raw.githubusercontent.com/magefree/mage/master/Mage.Client/src/main/java/mage/client/game/GamePanel.java)
- Scryfall image rules:
  - [Scryfall API overview](https://scryfall.com/docs/api) ("Use of Scryfall Data and Images"; WebFetch got a 403, curl worked)
  - [Scryfall card imagery](https://scryfall.com/docs/api/images) (image formats, including the new WebP set)
- Accessibility: [Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/full-list/)

**Local:**
- Yama:
  - `/Users/bryanroscoe/Developer/yama/ARCHITECTURE.md` (sections 10 and 11)
  - `/Users/bryanroscoe/Developer/yama/AGENTS.md`
  - `/Users/bryanroscoe/Developer/yama/docs/mobile.md`, `docs/engine-integration.md`
  - `/Users/bryanroscoe/Developer/yama/web/src/play/Board.tsx`, `board.css` and `types.ts`
  - `/Users/bryanroscoe/Developer/yama/web/public/manifest.webmanifest`, `sw.js`
  - `/Users/bryanroscoe/Developer/yama/play/src/lib.rs`
  - `/Users/bryanroscoe/Developer/yama/server/src/play.rs`, `server/src/cards/import.rs`, `server/migrations/0001_init.sql`
- phase engine (`/Users/bryanroscoe/Developer/yama-phase/crates/engine/src/`):
  - `game/interaction.rs`, `game/derived_views.rs`, `game/preview.rs`, `game/visibility.rs`
  - `game/ability_utils.rs`, `game/triggers.rs`, `game/zones.rs`, `game/combat.rs`, `game/combat_damage.rs`
  - `game/casting.rs`, `game/casting_costs.rs`, `game/casting_targets.rs`, `game/commander.rs`, `game/engine.rs`
  - `ai_support/mod.rs`, `ai_support/candidates.rs`, `ai_support/context.rs`
  - `types/actions.rs`, `types/game_state.rs`, `types/events.rs`, `types/interaction.rs`, `types/phase.rs`, `types/log.rs`
- phase server (`/Users/bryanroscoe/Developer/yama-phase/crates/`):
  - `phase-server/src/main.rs` (per-seat payload)
  - `server-core/src/takeback.rs`
  - `phase-ai/src/config.rs`
- phase client (`/Users/bryanroscoe/Developer/yama-phase/client/src/`):
  - `animation/`, `viewmodel/battlefieldProps.ts`, `viewmodel/keywordProps.ts`
  - `components/controls/PhaseStopBar.tsx`, `components/board/BattlefieldZoneOverflow.tsx`, `components/board/BattlefieldRow.tsx`
  - `components/targeting/arcPath.ts`, `hooks/useDragToCast.ts`
