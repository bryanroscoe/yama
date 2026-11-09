# Star Trek stock precons

Reviewed 9 November 2026 against MTGJSON 5.3.0+20261109 and
[Wizards' decklists](https://magic.wizards.com/en/news/announcements/star-trek-commander-decklists).

| Deck | Commander | MTGJSON file |
|---|---|---|
| Federation Fleet | Jean-Luc Picard, Luminary | FederationFleet_TRC |
| Landing Party | Commander Spock | LandingParty_TRC |
| Klingon Fury | Worf, Defiant Commander | KlingonFury_TRC |
| We Are the Borg | The Borg Queen | WeAreTheBorg_TRC |

The files are under `https://mtgjson.com/api/v5/decks/<file>.json`. The reviewed
resource contains only names, Oracle IDs, quantities, boards and catalog metadata;
no card art or rules documents. Each deck has 100 cards and one face commander.
Release date is 13 November 2026. Collector's Editions contain the same lists.

The release calendar and public benchmark catalog are separate. Calendar discovery
had these decks, but did not add them to the public stock reference. The server
now seeds these four missing catalog rows at startup. This is insert-only: a later
reviewed import can replace a list, and startup never overwrites an existing row.
No benchmark games, wins or official bracket assignments are invented. Power and
estimated bracket use the existing card-text analysis; missing card data remains
visible and excludes an incomplete estimate from correlations.
