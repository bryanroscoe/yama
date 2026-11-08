# Yama design handoff (Night table)

- The visual system is in [tokens.md](tokens.md).
- The live canvas is https://claude.ai/artifact/A54Pqc1rPe5U8c4ipARc1q: page "Night table" for the screens, page "Game interactions" for play. It's private to Bryan.
- `screens/` holds each artboard's `.dc.html` source. They're HTML with inline styles: read them for layout, spacing and copy. They can't run outside the canvas.

## Screens

Each screen has a laptop artboard and a phone artboard.

| Area | Laptop | Phone |
|---|---|---|
| Sign in | SignIn | (same page, stacks) |
| Table: new game | Table | TablePhone |
| Life counter | n/a | Life, LifeMenu (table menu), LifePlayer (commander damage and counters), LifeGuest (a guest's phone) |
| Play online | Play | PlayPhone |
| Lobby | PlayLobby | LobbyPhone |
| Online board | PlayBoard | PlayBoardPhone |
| Cards | Search | SearchPhone |
| Card | CardPage | CardPhone |
| Collection | Collection | CollectionPhone |
| Scanner | n/a | Scan |
| Decks | DeckList | DeckListPhone |
| Deck | DeckView | DeckPhone |
| Sample hand | n/a | Hand |
| Group | Group | GroupPhone |
| Plans overview | (DeckList's Plans tab) | PlanOverview |
| Plan deck | PlanDeckWide | PlanDeck |
| Review | ReviewWide | Review |
| Buy list | (phone layout scales up) | Buy |
| Prints | (phone layout scales up) | Prints |
| Spares | (phone layout scales up) | Spares |
| Lab: precons | Lab | LabPhone |
| Try a change | LabTry | LabTryPhone |
| My runs | (phone layout scales up) | LabRuns |

## Redesign (November 2026)

Bryan asked for a better design for the whole site (8 Nov 2026). The work is on one canvas,
**Yama redesign** (https://claude.ai/artifact/2ekfB9CSeU3VLLf9GwAM91), with three pages; its
`.dc.html` sources are mirrored in [screens/redesign-2026-11](screens/redesign-2026-11/) (with the
canvas index, `canvas.json`). The rules are in [tokens.md](tokens.md), "Density, actions and page
structure". The reusable pieces are the design system **Yama Night table**
(https://claude.ai/artifact/KATy3ZHwCt9ikAJnHMBSha), mirrored in [system/](system/) (README, tokens,
component previews). Specs and the plan for the rest of the site are in
[docs/redesign](../docs/redesign/). Where a mirror and `tokens.md` differ, `tokens.md` is the
source of truth.

| Page | Boards |
|---|---|
| Design language | Language: the nine rules, drawn |
| Plans (built 6 Nov as "Plans: one plan per deck" in ARCHITECTURE.md; the boards now also carry the 8 Nov rules) | Main (Plans), ProposedPlan, InProgress, GetCards, NewVersion, Archived; phone: PhonePlans, PhoneProposed, PhoneInProgress, PhoneGetCards |
| Deck page | Deck (tabs Cards, Stats, Plan, History), DeckControls (every menu and control, today against new), DeckEditList, DeckShare; phone: PhoneDeck, PhoneDeckMore |

Card art and card pictures on these boards are labelled placeholders; the app loads them from
Scryfall at runtime. Numbers marked [n] weren't available to the design agent.

## Game interactions

The canvas page "Game interactions" designs every decision in an online game, in the same Night table style. The requirements are in [play-polish-requirements.md](../docs/play-polish-requirements.md); the PP column names the requirement each board answers. Most boards are clickable on the canvas.

The rules every board follows (updated 2026-10-23 with Bryan's answers in [the design backlog](../docs/game-interactions-design-backlog.md)):
- **One main button confirms.** It sits in the rail on a laptop and in the dock on a phone, and always says what happens next (GButtons lists every state). A dialog never has its own confirm button; it may have Cancel. Space presses the main button and does nothing else.
- **Choices happen on the board:** rings on what you can pick, arrows to what you picked. A dialog or sheet opens only when the choice isn't about something on the board.
- **Amber means you can pick or play it**, everywhere on the board (`--pick` in [tokens.md](tokens.md)). Something you've picked turns white, with a number when order or count matters. Warnings use red with a word. Green only reports a result that's good for you.
- **Seat colours** come from a fixed colour-blind-safe palette (`--seat-1` to `--seat-6`). You're always blue. Arrows and attack rings use the colour of the player who made them.
- **Nothing commits until the main button.** Esc backs out. Right-click, or a long-press on a phone, reads a card.
- **Only the engine's words.** Card text is the card's Oracle text; prompts, mode descriptions and trigger descriptions are the engine's; the log is a list of events. No summaries, advice or invented titles.
- **Remembered answers are fine** ("Always pay for Rhystic Study", "Always send my commander to the command zone"). Yama answers for you, logs each automatic answer, and the log line turns it off.
- **Your own spell resolves without asking** unless another player can respond (PP-07).
- **Playing a card on a phone:** tap it in your hand, then Play. Dragging it up past the play line also works.
- **Every art crop credits its artist** in the same view: a line under each battlefield, and your portrait's artist under your life.

The Engine column names the phase decision (`WaitingFor` variant, or `GameAction` for priority actions) each board answers. Line numbers are in [the review](../docs/game-interactions-review-2026-10-23.md).

| Interaction | Laptop | Phone | PP | Engine decision |
|---|---|---|---|---|
| Mulligan | GMulligan | GMulliganPhone | 51 | `MulliganDecision`; the bottom step answers `SelectCards` |
| Priority, passing, stops | GPriority | (dock on every phone board) | 7, 33, 34, 36 | `Priority`; `PassPriority`, `SetAutoPass`, `SetPhaseStops` |
| The main button, every state | GButtons |  | 32 | label from `WaitingFor`, phase, stack and combat |
| Playing a card, using a permanent | GCast | GPlayPhone | 25, 28, 68 | `CastSpell`, `PlayLand`, `ActivateAbility` at `Priority` |
| Paying mana | GPay | GPayPhone | 29, 30, 31 | `ManaPayment`, `ManaSourceSelection` |
| Choosing targets | GTarget | GTargetPhone | 26 | `TargetSelection`, `TriggerTargetSelection` |
| Modes and X | GModes |  | 27 | `ModeChoice`, `AbilityModeChoice`, `ChooseXValue` |
| Responding to an opponent's spell | GRespond | GRespondPhone | 46, 47 | `Priority` with a non-empty stack |
| Ordering triggers | GTriggers |  | 48 | `OrderTriggers` |
| Reading a card | GInspector | GInspectorPhone | 23, 24 | none (read-only) |
| Declaring attackers | GAttack | GAttackPhone | 40, 44 | `DeclareAttackers` |
| Declaring blockers | GBlock | GBlockPhone | 41, 44 | `DeclareBlockers` |
| Combat damage assignment | GDamage |  | 43 | `AssignCombatDamage` |
| Watching other players' combat | GCombatView |  | 42 | none (`state.combat`) |
| Scry | GScry | GScryPhone | 49 | `ScryChoice` |
| Library search | GSearch |  | 50 | `SearchChoice` |
| Other choices: pay or not, name a card, a colour, discard, command zone | GChoices | GChoicesPhone | 35, 52 | `UnlessPayment`, `NamedChoice`, `DiscardToHandSize`, `CommanderZoneChoice` |
| Graveyard, exile and reveals | GZones |  | 22 | none (zones, `revealed_cards`) |
| A player knocked out | GKnockout |  | 18, 61 | none (`PlayerEliminated` event) |
| Game over | GGameOver | GGameOverPhone | 61 | `GameOver` |
| Game log | GLog |  | 58, 59 | none (`GameLogEntry`) |
| **Widget:** yes or no strip | GYesNo | GYesNoPhone | 35, 52 | `OptionalEffectChoice` (+ `DecideOptionalEffectAndRemember`), `OpponentMayChoice`, `ResolutionOptionalPaymentChoice`, `TributeChoice` |
| **Widget:** pick N, on the board or in a zone | GPickN | GPickNPhone | 52 | `ChooseObjectsSelection`, `EffectZoneChoice`, `ChooseFromZoneChoice`, `MultiTargetSelection`, `DiscardChoice` (all answered with `SelectCards`) |
| **Widget:** put in order | GOrder | GOrderPhone | 49, 51, 52 | `SelectCards` order: bottom-of-library order, cards put back on top, `RevealUntilBottomOrder` |
| **Widget:** pair up | GPairUp | GPairUpPhone | 52 | `PairChoice`, and relation-shaped choices |
| **Widget:** split a number | GSplit | GSplitPhone | 43 | `DistributeAmong`, `AssignBlockerDamage`, `MoveCountersDistribution` |
| **Widget:** number | GNumber | GNumberPhone | 27 | number-style `NamedChoice`, `PayAmountChoice` |
| **Widget:** name or text | GName | GNamePhone | 52 | `NamedChoice { choice_type, options, free_entry }` |
| More ways to pay: colour of mana, Phyrexian mana, convoke, delve | GMana | GManaPhone (colour, Phyrexian) | 29, 31 | `ChooseManaColor`, `PhyrexianPayment { shards }`, `TapForConvoke`, delve |
| Extra costs: kicker, discard as a cost, ward | GCosts | GCostsPhone (ward) | 29, 52 | `OptionalCostChoice { cost, times_kicked }`, `PayCost { kind, choices, count }`, `WardDiscardChoice` |
| Replacement effects: which applies first | GReplace | GReplacePhone | 52 | `ReplacementChoice { candidates, kind, last_applied_decides, remember_identity }`, `ChooseReplacementAndRemember` |
| Looking at the library: surveil, take one, reveal until, top or bottom, Cultivate split | GLibrary | GLibraryPhone | 49, 50, 52 | `SurveilChoice`; `DigChoice` then `DigRestSplitChoice`; `RevealUntilKeptChoice`, `RevealUntilBottomOrder`; `TopOrBottomChoice`; `SearchPartitionChoice` |
| Counters: proliferate, moving counters, removing counters as a cost | GCounters | GCountersPhone (proliferate) | 52 | `ProliferateChoice`; `MoveCountersDistribution`; `ChooseRemoveCounterCostDistribution`, `RemoveCountersChoice` |
| More targets: any number, divided damage, new targets for a copy, change a target | GTargetsMore | GTargetsMorePhone | 26 | `MultiTargetSelection`, `DistributeAmong`, `CopyRetarget`, `RetargetChoice` |
| Choosing a permanent: legend rule, clone, equip, Ring-bearer, empower Jace | GPermanents | GPermanentsPhone | 52 | `ChooseLegend`, `CopyTargetChoice`, `EquipTarget`, `ChooseRingBearer`, `EmpowerJaceChoice` |
| Ways to cast: cascade, discover, adventure, madness, miracle, two-faced cards, alternative costs, mutate | GCastWays | GCastWaysPhone | 21, 25 | `CastOffer`, `CascadeChoice`, `DiscoverChoice`, `ModalFaceChoice`, `AlternativeCastChoice`, `MutateMergeChoice` |
| Combat extras: attack taxes, must and can't attack, planeswalker defenders, exert, enlist, crew, saddle | GCombatMore | GCombatMorePhone | 40, 44 | `CombatTaxPayment`, `DeclareAttackers` (`attacker_constraints`), `ExertChoice`, `EnlistChoice`, `CrewVehicle`, `SaddleMount` |
| Everyone takes part: votes, piles, villainous choice, coin and die, Resolve-all consent | GTogether | GTogetherPhone (vote, Resolve all) | 35, 52 | `VoteChoice`, `SeparatePilesPartition`, `SeparatePilesChoice`, `ChooseOneOfBranch`, `CoinFlipKeepChoice`, `DieKeepChoice`, `ResolveAllConsent` |
| Game settings: trigger yields, automatic answers, hand order, concede | GSettings | GSettingsPhone | 35 | `SetPriorityYield`, `SetMayTriggerAutoChoice` plus Yama's remembered answers, `ReorderHand`, `Concede` |
| Rarer cards: morph, manifest dread, foretell, ninjutsu, companion, meld, cipher | GRareCards | GRareCardsPhone (face down, ninjutsu) | 21, 25, 52 | `PlayFaceDown`, `TurnFaceUp`, `ManifestDreadChoice`, foretell, `ActivateNinjutsu`, `CompanionReveal`, `DeclareCompanion`, `CompanionToHand`, `MeldPairChoice`, `CipherEncodeChoice` |
| Rarer rules: dungeons, time travel, clash, choosing a player, loop shortcuts, Serum Powder, your knockout, a draw | GRareRules | GRareRulesPhone (loop, player) | 51, 52, 61 | `ChooseDungeon`, `ChooseDungeonRoom`, `TimeTravelChoice`, `ClashChooseOpponent`, `ClashCardPlacement`, `ChooseGiftRecipient`, `EntryControllerChoice`, `ChooseFromZoneOpponentChooser`, `LoopShortcut`, `RespondToShortcut`, `RepeatDecision`, `UseSerumPowder`, `PlayerEliminated`, `GameOver { winner: None }` |

Not designed, because Commander doesn't use them: between-games choices, Alchemy, Planechase and Tiny Leaders.

### Generic decision widgets

Most engine decisions fit seven shapes, the ones phase's interaction contract uses (`InteractionResponseSpec`). Each widget board is driven by one `decision` object at the top of its script, shaped like the builder's `pending` payload, so the payload can be wired straight in:

```js
const decision = {
  kind,          // 'yesno' | 'pick' | 'order' | 'pair' | 'split' | 'number' | 'text'
  source,        // { name, controller, art, image, artist }: the card asking
  prompt,        // the engine's question, never invented
  oracle,        // the source's Oracle text
  options,       // [{ id, name, img or art, zone, controller, eligible, toughness }]
  min, max, upTo,
  defaultAnswer, // the engine's default: ids, an order, amounts or a number
  // per kind: yesLabel, noLabel, remember ('engine' or 'yama'), zone, filter,
  // destination ('top' or 'bottom'), total, perOptionMin, freeEntry
};
```

Every widget shows the source card with its art credit, the question and a counter ("1 of up to 2 chosen", "0 left"). The rail (or the dock on a phone) confirms.

BoardBase and BoardBasePhone are the boards drawn behind the dialogs. The boards where rings and arrows must land on exact cards (GTarget, GPay, GRespond, GAttack, GBlock) draw their own board at fixed positions instead.

## Images in the artboards

The artboards point at `/_blob/<id>` images uploaded to the private canvas for the mockups. In the app, load the same cards from Scryfall at runtime: `art_crop` for art, `normal` for full cards. Never store them.

The table maps each image id prefix to its Scryfall card. a = art_crop, n = normal.

| id prefix | Card |
|---|---|
| c19490e7 | a Éowyn, Shieldmaiden (Craig Elliott) |
| 042e4cb2 | a Quintorius, History Chaser (Darren Tan) |
| 383d04a0 | a Mister Fantastic (Gintas Galvanauskas) |
| 7678674b | a Terra, Herald of Hope (Marta Nael) |
| 81164bc6 | a Rootha, Mastering the Moment (Lie Setiawan) |
| 93443cca | a Adeline, Resplendent Cathar (Bryan Sola) |
| d9cb8751 | a Jace, Multiverse Architect (Volkan Baǵa) |
| 987c210d | a Agent of Treachery |
| 39ddc54e | a Anointed Procession |
| c2a67f4f | a Aragorn, King of Gondor |
| af66cc45 | a Arcane Signet |
| 9e5b458e | a Archangel of Tithes |
| 7360d4a1 | a Archivist of Gondor |
| 083677b5 | a Ardyn, the Usurper |
| ec89776a | a Ashen Rider |
| 35996246 | a Battlefield Forge |
| f279aaa7 | a Boros Charm |
| f42c34fc | a Command Tower |
| 9a6ae397 | a Counterspell |
| e9cdfcd4 | a Cyclonic Rift |
| 62e4a477 | a Faramir, Steward of Gondor |
| 1dccd462 | a Grave Titan |
| ecd5c2f2 | a Hearthhull, the Worldseed |
| 7a66b1e9 | a Island |
| 96ca254f | a Karmic Guide |
| 3bf02968 | a Mountain |
| b0695b04 | a Omo, Queen of Vesuva |
| 30df84ae | a Plains |
| a3e58275 | a Rhystic Study |
| 1f21e929 | a Settle the Wreckage |
| c4b9626b | a Smothering Tithe |
| 6eb69741 | a Sol Ring |
| a5c78b51 | a Swamp |
| 7c226842 | n Adeline, Resplendent Cathar |
| 55daf9f7 | n Agent of Treachery |
| d2df35f8 | n Akroma's Will |
| 03e78afa | n Arcane Signet |
| dc22f2e3 | n Ashen Rider |
| 2d80527e | n Boros Charm |
| dec1c1cc | n Brimaz, King of Oreskos |
| 0145ecf8 | n Chaos Warp |
| 4b6f8a8c | n Clifftop Retreat |
| 4e274a0a | n Cyclonic Rift |
| 2512b388 | n Elsha of the Infinite |
| c45912d7 | n Emeria Angel |
| 880ea875 | n Éowyn, Shieldmaiden |
| f91dfa78 | n Esper Sentinel |
| c858d7cf | n Fierce Guardianship |
| 2b7584e3 | n Flawless Maneuver |
| e25b0374 | n Glacial Fortress |
| 457b4872 | n Goblin Rabblemaster |
| 830427c5 | n Hanged Executioner |
| acc701ac | n Jace, Multiverse Architect |
| d8c70b88 | n Jhoira, Weatherlight Corsair |
| 0f5e5aef | n Legion Warboss |
| c8765d27 | n Monastery Mentor |
| 7a4f5ae8 | n Murmuring Mystic |
| f6234aee | n Siege-Gang Commander |
| 93aeaa2a | n Sol Ring |
| 4f17f1f9 | n Sunfall |
| e09d58de | n Third Path Iconoclast |
| a68bb9fa | n Venser, Fervent Forger |
| 83f67844 | n Young Pyromancer |
| 8c3b536b | a Aetherize |
| 3689b6bc | a Angel of the Ruins |
| fdc2fadc | a Arcane Denial |
| 75b6404c | a Archfiend of Depravity |
| 83f1e789 | a Ark of Hunger |
| 6759048d | a Chaos Warp |
| 7ecbc1d3 | a Deification |
| 13b9f5d4 | a Frontier Warmonger |
| 79124919 | a Horn of the Mark |
| feec51bb | a Identity Echo |
| 86ba0e49 | a Jace's Machinations |
| 9c6055e7 | a Jhoira, Weatherlight Corsair |
| ed33ce9a | a Levitation |
| de637fa1 | a Mount Doom |
| 30001914 | a Polymorph |
| c420d1ed | a Port Town |
| de20645e | a Rakdos Signet |
| a6012446 | a Sepulchral Primordial |
| d25fde81 | a Sunfall |
| fb99bcf5 | a Talisman of Progress |
| dfe2ebb6 | a Thought Vessel |
| e4c32638 | a Transmogrify |
| e03284c9 | a Venser, Fervent Forger |
| 1ebe33f8 | a Volcanic Island |
| eb17e450 | a Fireball (Xavier Ribeiro) |
| 2914c341 | a Goblin Rabblemaster (Svetlin Velinov) |
| d8a19374 | a Legion Warboss (Alex Konstad) |
| 639302e4 | a Pithing Needle (Anthony Palumbo) |
| ddbc9031 | a Preordain (Svetlin Velinov) |
| d4281310 | a Recruiter of the Guard (Eric Wilkerson) |
| aef381f1 | a Swords to Plowshares (Jesper Ejsing) |
| a08c9161 | n Fireball |
| 24d589e6 | n Pithing Needle |
| 25c9e8e2 | n Preordain |
| 1c9f97f5 | n Recruiter of the Guard |
| 25cc15a4 | n Swords to Plowshares |
| ed088f5c | n Goblin Rabblemaster (a second upload of 457b4872) |
| b2dc590a | n Legion Warboss (a second upload of 0f5e5aef) |
| 7f6452cb | a Treasure token (Raluca Marinescu) |
| 0a45a736 | a Foresee (Ron Spears) |
| 6f792d5b | a Cultivate (Darius Zablockis) |
| f39761ca | n Foresee |
| 146958f3 | n Cultivate |
| e7d636d9 | n Forest (Samuele Bandini) |
| ebcbd90f | n Plains (Shahab Alizadeh) |
| e4f3b606 | n Island (Eren Arik) |
| 58f2586f | n Mountain (VEN) |
| 9187cacb | a Arc Lightning (Seb McKinnon) |
| 8dc15a98 | n Arc Lightning |
| 96db74e7 | a Barter in Blood (Eric Deschamps) |
| be21cc78 | n Barter in Blood |
| 2d435a47 | a Brainstorm (Daarken) |
| c7a6fabf | n Brainstorm |
| 0a230e7b | a Deification (Maxime Minard) |
| c73f6cc6 | n Deification |
| e7310e0a | a Faithless Looting (Gabor Szikszai) |
| e6f30a76 | n Faithless Looting |
| c6bd483e | a Silverblade Paladin (Jason Chan) |
| 983fc8b6 | n Silverblade Paladin |
| b6ab5f8f | a Smothering Tithe (Mark Behm) |
| befb1683 | n Smothering Tithe |
| db581344 | a Talion, the Kindly Lord (Justyna Dura) |
| 26786bca | n Talion, the Kindly Lord |
| a1ffa6fd | a Reveillark (Jim Murray) |
| b4dbc6f1 | n Reveillark |
| 5d10e4ac | a Apostle's Blessing (Brad Rigney) |
| 3803d7c7 | n Apostle's Blessing |
| 4bf0e4d6 | a Doubling Season (Chuck Lukacs) |
| c0f1da1f | n Doubling Season |
| 684d98ae | a Fight with Fire (Yongjae Choi) |
| d63f877c | n Fight with Fire |
| 05df504a | a Hardened Scales (Mark Winters) |
| 8f8d0ea5 | n Hardened Scales |
| 94ce56a7 | a Maha, Its Feathers Night (Alessandra Pisano) |
| aa79ee0c | n Maha, Its Feathers Night |
| f97d9312 | a Stoke the Flames (Liiga Smilshkalne) |
| c3b2a282 | n Stoke the Flames |
| 29f3f8f3 | a Thrill of Possibility (Steve Argyle) |
| 30f751fb | n Thrill of Possibility |
| 3c089dbc | a Treasure Cruise (Cynthia Sheppard) |
| 713cee99 | n Treasure Cruise |
| db483639 | a Curate (Ryan Valle) |
| a850a265 | n Curate |
| 4fd285bb | a Impulse (Sam Guay) |
| 9d870ce5 | n Impulse |
| a50b5832 | a Not Forgotten (Darek Zabrocki) |
| ca2dbbe1 | n Not Forgotten |
| 9013dd26 | a Tezzeret's Gambit (Bryan Sola) |
| d225c5e0 | n Tezzeret's Gambit |
| d0aac68c | a Resourceful Defense (Francis Tneh) |
| a21db891 | n Resourceful Defense |
| 5c65d32b | a Hopeful Initiate (Dan Murayama Scott) |
| 744a9ab4 | n Hopeful Initiate |
| d23941e6 | a Eerie Interlude (Svetlin Velinov) |
| ebfbc96e | n Eerie Interlude |
| b294a287 | a Inferno Titan (Olivier Bernard) |
| d576a30c | n Inferno Titan |
| d7fc9a90 | a Reverberate (jD) |
| 2fd3a62b | n Reverberate |
| d4b908e0 | a Deflecting Swat (Izzy) |
| 823ef100 | n Deflecting Swat |
| e3b79e7a | a Clone (Kev Walker) |
| 563d6557 | n Clone |
| abf760cd | a Swiftfoot Boots (Svetlin Velinov) |
| 2c2ed51f | n Swiftfoot Boots |
| 661f981a | a Birthday Escape (David Álvarez) |
| 82f873ee | n Birthday Escape |
| 79094847 | a Fatehold Charm (Rovina Cai) |
| db171747 | n Fatehold Charm |
| 12f540af | a Jace token, Reality Fracture tokens (Manuel Castañón) |
| f5ebdcb9 | n Jace token |
| 02af1cd1 | a Ardent Plea (Chippy) |
| d55d2ca9 | n Ardent Plea |
| 2f8ef912 | a Geological Appraiser (Alix Branwyn) |
| a43ea7d6 | n Geological Appraiser |
| 00577565 | a Bonecrusher Giant (Victor Adame Minguez) |
| 331ccdb4 | n Bonecrusher Giant |
| aeab142c | a Fiery Temper (Johannes Voss) |
| 639db1ac | n Fiery Temper |
| b507bd6e | a Temporal Mastery (Franz Vohwinkel) |
| f02dc849 | n Temporal Mastery |
| a29b98de | a Halvar, God of Battle (Lie Setiawan) |
| 009e3dee | n Halvar, God of Battle |
| b0740419 | n Sword of the Realms (Halvar back face) |
| 1c820332 | a Vulpikeet (Leesha Hannigan) |
| abd7b1c1 | n Vulpikeet |
| dd63e02b | a Propaganda (Borja Pindado) |
| a35720bf | n Propaganda |
| ac325a8f | a Glorybringer (Sam Burley) |
| 1032c1f0 | n Glorybringer |
| 8dca4185 | a Coalition Skyknight (Aaron Miller) |
| 51dd60e5 | n Coalition Skyknight |
| be98cd80 | a Skysovereign, Consul Flagship (Jung Park) |
| 8fbf98e4 | n Skysovereign, Consul Flagship |
| 5a389edc | a Council's Judgment (Kev Walker) |
| 9b01b9ee | n Council's Judgment |
| b4f421c9 | a Fact or Fiction (Matt Cavotta) |
| f204e075 | n Fact or Fiction |
| 13bcf58e | a Ensnared by the Mara (Andrey Kuzinskiy) |
| eb163a3c | n Ensnared by the Mara |
| e37dbeb7 | a Krark's Thumb (Ron Spencer) |
| a5d76678 | n Krark's Thumb |
| 706046b4 | a Krark's Other Thumb (Jeff Miracola) |
| e3346d21 | n Krark's Other Thumb |
| 305da8d1 | a Exalted Angel (Michael Sutfin) |
| 56080e6b | n Exalted Angel |
| 49e34a11 | a Abhorrent Oculus (Bryan Sola) |
| e3b996e4 | n Abhorrent Oculus |
| f33f5c5c | a Saw It Coming (Randy Vargas) |
| e1c8bf89 | n Saw It Coming |
| a6bfbfac | a Ninja of the Deep Hours (Dan Murayama Scott) |
| 06a45f75 | n Ninja of the Deep Hours |
| 550b138f | a Yorion, Sky Nomad (Steven Belledin) |
| acff23d9 | n Yorion, Sky Nomad |
| 9f59d38a | a Bruna, the Fading Light (Clint Cearley) |
| 4de99ba9 | n Bruna, the Fading Light |
| 871a8783 | a Gisela, the Broken Blade (Clint Cearley) |
| 0a623ef9 | n Gisela, the Broken Blade |
| f0bcaf31 | a Brisela, Voice of Nightmares (Clint Cearley) |
| 6e6d12a7 | n Brisela, Voice of Nightmares |
| dbb9e580 | a Hidden Strings (Daarken) |
| 6035c296 | n Hidden Strings |
| d0bbf20c | a Acererak the Archlich (Andrey Kuzinskiy) |
| 2bbab5fd | a Ancestral Vision (John Avon) |
| cad189d1 | n Ancestral Vision |
| 5188d0e9 | a Dewdrop Cure (Chris Rallis) |
| 10eba2b4 | n Dewdrop Cure |
| 294ee810 | a Kiki-Jiki, Mirror Breaker (Steven Belledin) |
| 794cd8e9 | n Kiki-Jiki, Mirror Breaker |
| f2a8c5e5 | a Lash Out (Scott Hampton) |
| 899cba8b | n Lash Out |
| e7df9c75 | a Pestermite (Christopher Moeller) |
| 8e872830 | n Pestermite |
| cc437f7a | a Rotating Fireplace (Daniel Correia) |
| be67ea6e | n Rotating Fireplace |
| 092df66e | a Serum Powder (Matt Thompson) |
| 08e74730 | n Serum Powder |
| 3008414c | a Wibbly-wobbly, Timey-wimey (Skinnyelbows) |
| ae9e4b3a | n Dungeon of the Mad Mage |
| afefc7c9 | n Lost Mine of Phandelver |
| 59b49c5d | n Tomb of Annihilation |

## Sample data

Names (Sam, Priya, Jules, Alex), records, counts and most prices in the artboards are illustrative. The real data used:
- Bryan's decks and commanders;
- the commander-decks plans (the Riders swaps, the Mount Doom question, the MakePlayingCards order, spares, the Multiverse Reforged proposals);
- the Pat's Games and Mothership buy list;
- the Oct 19 lab run:
  - Riders of Rohan raw win rates: stock 35.1%, now 37.9%, after 50.0%, with intervals;
  - model win rates: 33.1%, 34.3%, 37.9%;
  - the precon table, with simulated rates, game counts and playgroup.gg ranks;
- Scryfall prices from Oct 19.

The two lab measures are different and are labelled as such: plan screens show raw win rates, and the Lab table shows model win rates.
