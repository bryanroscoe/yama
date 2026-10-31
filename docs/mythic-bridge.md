# Mythic Tools bridge: API notes

What Yama knows about Mythic Tools' private API, from exporting Bryan's own account on 2026-10-31. The plan is in ARCHITECTURE.md ("Mythic Tools bridge"). Nothing here is documented by Mythic; it's read from their web app and can change without notice. Recheck before relying on any of it.

## Who and what

- Mythic Tools ("MTG Life Counter: Mythic Tools"), by Studio Laganne SAS, France (contact@studiolaganne.com). Android package `com.studiolaganne.lengendarylens`; full web app at https://mythic.tools.
- Its iubenda terms and privacy pages have said "no longer active" since January 2025; no other terms were found. No public API or developer docs.
- The site's own collection export (Mythic, Moxfield and ManaBox CSVs) exists; games, playgroups and deck history have no export.

## Requests

- API base `https://api.mythic.tools` (`MYTHIC_API_URL` in the page's Nuxt runtime config).
- Sign-in is Firebase Auth (project `mythic-tools`; Google, Apple or email). The API takes the Firebase ID token as `authorization: Bearer …`.
- Every request also carries headers the web client computes:
  - `x-api-key`: the public `MYTHIC_API_KEY` from the page config.
  - `x-mythic-timestamp`: milliseconds since the epoch.
  - `x-mythic-signature`: hex SHA-256 of `` `${SLUG_1}+/${timestamp}.${MYTHIC_WEB_KEY}/+${SLUG_2}!` ``, all three values from the page config.
  - `x-mythic-device: web`, `x-app-locale`.
  - `x-mythic-id`: the Mythic user id. Without it signed-in calls answer 401 `{"code":1,"message":"Missing x-mythic-id user."}`. The web app gets the id from `POST /auth/signin` (`{fcmToken:null, locale, firstname:null}`), which it calls on every sign-in; the answer's `user.id` is the id and it also carries friends, playgroups, decks, stats and lists.
- Read the config values from https://mythic.tools/login at run time rather than copying them; they're public but may rotate. Without the signature the API answers 401.
- In a browser the bridge runs on mythic.tools itself and reuses the page's signed-in session (the Firebase user in IndexedDB `firebaseLocalStorageDb`). Calls from another origin aren't expected to pass CORS.

## Reads used for import

| What | Request | Notes |
|---|---|---|
| Account | `GET /user`, `/user/stats`, `/user/friends`, `/user/playgroups` | |
| Own games | `GET /games?timestamp=…` | Newest first. Page backwards with `timestamp` = the oldest `started_at` seen; an empty page ends it. |
| Playgroup | `GET /playgroup/{id}`, `/playgroup/{id}/highlights`, `/playgroup/{id}/games?timestamp=…` | Same cursor. Includes games of the group the user didn't play in. |
| One game | `GET /game/{id}` | `{game:{…}}`: `started_at`, `ended_at`, `active`, `entry_mode`, `formatid`, `playgroup`, `winner`, `winners[]`, `players[]` (id, names, `position`, `lifetotal` (looks like starting life), `resultid`, `startingplayer`, `deck{…}`), `tags`, `note`, `events[]` (life and timer events with dates). |
| Decks | `GET /user/decks`, `/user/decks/archived`, `/decks/folders`, `GET /deck/{id}` | A deck answer includes `lists.main` with every card (`pagination.has_next` false at the default limit). Mythic's own precon decks are system-owned (`created_by` 1000000). |
| Collection | `GET /user/collection`, `/user/lists`, `/user/lists/{id}` | `lists` is `{lists:{global:[…], user:[…]}}`. |
| Exports | `GET /user/collection/export?format=…`, `GET /user/lists/{id}/export?format=…` | `format` is `mythictools`, `moxfield` or `manabox`. Answers `{url}`: a signed Google Cloud Storage link to the CSV. |
| Collection rows | `GET /user/collection/search?page=&limit=` | Card-level JSON with `pagination`; quantities summed to the collection's card count. |
| Commander aggregate | `GET /deck/{id}/platform-meta` | `{platformMeta:{totalDecks, stats:{games,wins,draws,losses,rate}}}` for that deck's commander across Mythic. Keyed by deck, not commander. |

## Writes the export side would use (untested)

From the web client, not yet called: `POST /game` (create), `PUT /game/{id}/participation`, `POST /game/{id}/note`, `PUT /game/{id}/note`, `POST /game/{id}/tag`; `POST /deck`, `PUT /deck/{id}`, `PUT /deck/{id}/commander`; `POST /user/lists/{id}/cards`, `bulk-edit`, `bulk-move`, `bulk-remove`; deck import by Moxfield or Archidekt link. Games name other Mythic users, who may be asked to confirm their seat (`/user/pending-seats`). Try each on one test record first.

## Prototype

`~/Developer/.agent-tasks/mythic-export-20261031/scripts/mythic_export.py` on Bryan's Mac: read-only, standard-library Python, takes the Firebase refresh token from 1Password and writes raw JSON plus `games.csv`, `game_players.csv` and `decks.csv`. Two account exports and a 278-request aggregate collection, at about one request a second, met no rate limiting.
