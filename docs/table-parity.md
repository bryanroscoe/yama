# Life counter parity: Lifetap, then Mythic Tools

Bryan, 2026-10-31: get the table to feature parity with Lifetap, then Mythic Tools. Our edge is
the shared table, where everyone scans in and keeps their own totals. Neither app documents a live
multi-phone table: Lifetap is single-device with no account; Mythic Tools tracks on one device and
syncs results to profiles. Whose turn it is doesn't need tracking.

Sources checked 2026-10-31: getlifetap.com, the Lifetap and Mythic Tools App Store listings and
changelogs, mythic.tools, Draftsim's life counter roundup (updated 2026-10-07).

## Lifetap

| Feature | Yama |
|---|---|
| 1 to 6 players, layout picker | Done 2026-10-31: named layouts per count, picked at setup |
| Card art behind each player, two arts for partners | Done (partners share the panel since 2026-10-31) |
| Commander damage per source, partners, off life, KO prompt | Done; taken Lifetap's way (shield, then tap the source) since 2026-11-01, or dealt from the attacker |
| Commander tax | Done |
| Poison, energy, experience, rad, storm, treasure | Done (storm and treasure 2026-10-31) |
| Mana pool counters | Missing |
| Monarch, initiative, day/night, city's blessing | Done (blessing 2026-10-31) |
| Dice d4 to d20 and custom, coin, random player | Done 2026-10-31 |
| Random seating, first player | Done (Shuffle the seats; "Who goes first?" as each game opens, 2026-11-01) |
| Quick reset / rematch | Done: Save and play again |
| Turn-by-turn log in the game | Done: "What's happened" in the menu; the full log on the game's page |
| Game history, win rates, CSV/JSON export | Done: Game history, Playgroup stats, and Export games on the Playgroup page (JSON shaped for commander-decks' games.json, or CSV with one row per seat) |
| Chess clock, timers | Skipped for now: turn counting is an opt-in setting (off by default since 2026-11-01) |
| Rename a player or swap their deck mid-game | Done 2026-11-01 (Change player or deck on the player sheet) |
| Install, full screen | Done 2026-11-01 (Install Yama where the browser offers it; Full screen in the menu) |
| Planechase, Archenemy, Bounty | Missing. Plane and scheme cards come from the Scryfall import |
| Drag to reorder seats mid-game | Missing |
| One-player mode tracking incoming commander damage | Missing |
| OLED black, font size, background crop | Missing |
| Commander damage not taken off life (setting) | Missing |

## Mythic Tools (next)

| Feature | Yama |
|---|---|
| Up to 8 players | Missing (we stop at 6) |
| Type a life total; ±10 | Done (tap the total on the player sheet; ±5 and ±10 buttons) |
| ±100 | Missing |
| OpenDyslexic font, +/- hint opacity | Missing |
| Low-life effects, KO and win animations | Partial (life pop, out label) |
| Monarch as a drag-and-drop token, the Ring | Missing |
| Two-Headed Giant, Kingdoms/Shogun, Treachery roles | Missing; hidden roles fit the shared table well |
| Best of three | Missing |
| Recreate the last game's setup | Done (seats come back from last time) |
| Games land on every player's profile | Done for playgroup members with accounts |
| Stats by seat, archnemesis, first and last out | Partial: see docs/research/mtg-apps-2026-10-18.md |
| Card scanner from inside a game | Missing; the scanner exists on its own page |
| OBS overlay | Missing |

## Our own next steps

- Guests join a shared table without a Yama account (server change; needs Bryan's decision). Counting a game without an account already works on one phone (`web/src/table/GuestTable.tsx`).
- Show the host who has joined, per seat.
- Phone apps: docs/mobile.md. The Android project (`web/android`) is built; the upload key and Google Cloud's Android OAuth clients are still to do.

## The four ways to play, side by side (updated 2026-11-11)

What each kind of game asks and saves. "Table" is the life counter; "Logged" is Log a game; "Online" is Play online on the rules engine; "Watch" is the computer playing every seat.

| | Table | Logged | Online | Watch |
|---|---|---|---|---|
| Guests | yes | yes | no | n/a |
| Choose first player | yes | yes | yes, or roll | yes |
| Starting life | 40/30/25/20 | 40/30/25/20 | 40 only (the engine wrapper has no option) | 40 |
| Knockout order and by whom | yes | yes (turn and "by" each optional) | yes, where the engine says | live only |
| Win condition | yes | yes | from the engine where it can tell, or asked at the end | no |
| Fun rating | yes | yes | yes, each player their own | no |
| Notes | finish sheet | yes | the host, at the end | no |
| Edit a finished game | script only (docs/history-corrections.md) | in app | win condition, fun and note only | n/a |
| Delete | whoever recorded it | whoever logged it | the host, once it's over; a waiting table can be closed | yes |
| Offline | yes | yes (waits on the device and uploads on its own) | no | no |
| Precon opponents | n/a | n/a | yes | yes |
| Saved to history | yes | yes | yes | no |

One name for each thing, wherever it shows (`GAME_WORDS` in packages/core): a game that isn't over is "Still going", a game nobody won is "A draw", a result is told in the past ("Sam won"), the opponent the server plays is "the computer", the table's verbs are "Start the game" and "Finish the game", and a game type goes by its `FORMATS` label on the picker and everywhere else.
