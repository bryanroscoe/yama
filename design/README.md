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

## Game interactions

The canvas page "Game interactions" designs every decision in an online game, in the same Night table style. The requirements are in [play-polish-requirements.md](../docs/play-polish-requirements.md); the PP column names the requirement each board answers. Most boards are clickable on the canvas.

Five rules run through all of them:
- One main button in the rail always says what happens next (GButtons lists every state).
- Choices happen on the board: rings on what you can pick, arrows to what you picked. A dialog opens only when the choice isn't about something on the board.
- Amber means you can pick it. Your own arrows are blue (#6cb0f5); everyone else's use their seat color.
- Nothing is committed until you press the button. Esc, or right-click, backs out.
- Every image of a card shows the card's own art and credits the artist.

| Interaction | Laptop | Phone | PP |
|---|---|---|---|
| Mulligan | GMulligan | GMulliganPhone | 51 |
| Priority, passing, stops | GPriority | (dock on every phone board) | 33, 34, 36 |
| The main button, every state | GButtons | | 32 |
| Playing a card, using a permanent | GCast | | 25, 28 |
| Paying mana | GPay | GPayPhone | 29, 30, 31 |
| Choosing targets | GTarget | GTargetPhone | 26 |
| Modes and X | GModes | | 27 |
| Responding to an opponent's spell | GRespond | GRespondPhone | 45, 46, 47 |
| Ordering triggers | GTriggers | | 48 |
| Reading a card | GInspector | GInspectorPhone | 23, 24 |
| Declaring attackers | GAttack | GAttackPhone | 40, 44 |
| Declaring blockers | GBlock | GBlockPhone | 41, 44 |
| Combat damage assignment | GDamage | | 43 |
| Watching other players' combat | GCombatView | | 42 |
| Scry | GScry | GScryPhone | 49 |
| Library search | GSearch | | 50 |
| Other choices: pay or not, name a card, a color, discard, command zone | GChoices | GChoicesPhone | 35, 52 |
| Graveyard, exile and reveals | GZones | | 22 |
| A player knocked out | GKnockout | | 18, 61 |
| Game over | GGameOver | GGameOverPhone | 61 |
| Game log, since your last turn | GLog | | 58, 59 |

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
