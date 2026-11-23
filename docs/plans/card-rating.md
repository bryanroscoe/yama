# A rating for every card: how good it is, not how many decks list it

Status: proposed, 23 Nov 2026. A prototype exists outside the repository and is measured below;
nothing is built in Yama. Five decisions wait on Bryan ("Decisions for Bryan").

Asked for by Bryan, 23 Nov 2026: "We need to come up with a good way to rank cards because there
are a lot of cards that might be good but they're not in the cEDH meta. The meta is kind of hard
to understand and grok but there's definitely a somewhat formulaic way to know how good a card
is. I don't know if any sites do this or if we can do this but it'd be super handy for the
scanner for sure ... and this would be really helpful for the commander decks repo as well."

The prototype's scripts, inputs and outputs are in
`~/Developer/.agent-tasks/yama-card-power-20261123/` (`work/rating.py` is the formula,
`work/eval*.py` the checks). A page to look cards up, with the 13 Nov collection marked:
https://claude.ai/artifact/5m7PMAAdNw8gkQyQa8Kuot (private to Bryan).

## What Yama says about a card today

The scanner's strip and `commander-decks`' sorting bar (`scripts/collection/piles.py`) both read
Scryfall's `edhrec_rank`: Staple or Playables in the top 1,000, Played or Viable to 5,000, and a
Game Changer mark. The rank counts decklists, so it has three known faults:

- **It ignores who can play the card.** A colorless card can go in every deck and a two-color
  card in about a quarter of them, so Sol Ring and Command Tower lead and gold cards sink.
- **Precons inflate it.** Every logged precon lists its whole 99. Path of Ancestry is #15 and
  Commander's Sphere #57 (the reason the sorting bar moved on 16 Nov).
- **It is blind to cost.** Rampant Growth (#28) outranks Demonic Tutor (#66), Mana Drain (#120)
  and Gaea's Cradle (#442), because most decks can't afford them or their bracket rules them out.

## Does any site do this

No site publishes one sortable power rating for every Commander card (checked 23 Nov 2026).

| Source | What it has | Why it isn't the answer |
|---|---|---|
| EDHREC | Deck count, inclusion among "potential decks", lift, salt | Popularity; no export, and its terms forbid automated queries |
| Scryfall `edhrec_rank` | The rank above, in bulk data | The three faults above |
| ScryCheck card index | An Overall score for its top 10,000 cards | Method unpublished; reuse prohibited |
| Playgroup.gg staples | Win-rate lift with and without a card, same commander, 244,155 casual games, CC BY 4.0 | Only 175 cards shown; no file |
| EDHTop16 staples | cEDH play rate for about 1,300 cards | cEDH only, the meta Bryan wants to see past; page only |
| Cube Cobra | A draft-pick Elo for 39,000 cards, public file | Cube drafting, two players; no data licence |
| Arena Brawl weights | Datamined matchmaking weights | Two players, frozen at May 2024 |
| Draftsim, ScrollVault, edhpowerlevel | Deck scores | No card table, or EDHREC-rank tiers |

Research on scoring cards from their text alone (the SPELLS thesis, 2025; DraftFM, 2026) trains on
subjective labels or draft picks. Yama's own text rules (`server/src/analysis/classify.rs`) were
tried as an input here and added nothing ("What was tried and left out").

## The rating

The idea is the one EDHREC itself uses for a card's page and doesn't publish in bulk, plus what
people pay: **how much do players want this card in the decks that can run it?**

1. **Play share.** Turn the rank back into a rough deck count (a curve through five public EDHREC
   figures: Sol Ring, Swords to Plowshares, Assassin's Trophy, Narset, Parter of Veils and
   Batterskull). Divide by the decks that could run the card: those whose color identity holds
   the card's, from Yama's own commander records (4,082 commanders, 5.1 million reported games:
   one color is in about half of decks, a pair in a quarter, three colors in an eighth), and
   fewer for a card under 18 months old. For a card that can be a commander, take off the decks
   it leads.
2. **Price.** The cheapest printing's market price, counted from $0.50 to $60. At the same play
   share, the card people pay more for is the one they want more. Below $0.50 a price says
   nothing; above $60 it is mostly scarcity (Reserved List, old print runs).
3. **Two small corrections.** Up a little for each two-card combo the card is half of (Commander
   Spellbook), down a little for each printing in a Commander precon.

```
index  = log10(play share) + 0.75 × log10(price) + 0.2 × log10(1 + two-card combos)
         − 0.2 × log10(1 + precon printings)        (lands: − 0.25)
rating = 94 + 20 × index, held to 0–100
```

Top is 80 and up (457 cards), Strong 68 (1,100), Playable 55 (2,812). A missing price stays
missing: the card is rated on play share with a neutral price and marked "no price". A card under
six months old is marked provisional. Banned cards and basic lands get no rating.

Every input is already in Yama's database: `cards.edhrec_rank`, color identity, prices,
`printings.set_type`, `spellbook_combos` and the commander evidence. No new source, licence or
request is needed for this version.

What it does to familiar cards (rating, with EDHREC rank):

| Card | Rank | Rating | New tag | Why |
|---|---|---|---|---|
| Rhystic Study | 46 | 100 | Top | In about a quarter of blue decks at $63 |
| Eladamri's Call | 788 | 89 | Top | About 9% of green-white decks, $10: gold cards get their due |
| Sol Ring | 1 | 88 | Top | No longer first, because it is $1 |
| Assassin's Trophy | 121 | 85 | Top | A third of black-green decks |
| Culling the Weak | 489 | 83 | Top | 6% of black decks at $8, and a cEDH staple |
| Cultivate | 20 | 78 | Strong | Cheap and everywhere |
| Command Tower | 2 | 75 | Strong | |
| Path of Ancestry | 15 | 67.8 | Playable | Precon filler, 33 precon printings |
| Commander's Sphere | 57 | 67 | Playable | The same |
| Murder | 906 | 62 | Playable | |
| The Tabernacle at Pendrell Vale | 8,784 | 58 | Playable | $3,620 doesn't buy a top rating |
| Batterskull | 5,092 | 54 | None | Just under Playable |

## Measured

Each check takes two groups of cards where one is plainly better, and asks how often the score
puts a card from the better group above one from the other (0.5 is a coin flip).

| Check | Cards | EDHREC rank | Rating |
|---|---|---|---|
| Cards Bryan's plans add against the cards they cut (`commander-decks/decks/compare`, 20 decks) | 386 / 609 | 0.76 | 0.87 |
| Added only for Bracket 4 against added only for Bracket 2, none from the stock list | 104 / 84 | 0.69 | 0.87 |
| Stock precon cards the plans keep against stock cards they cut, nonland | 336 / 267 | 0.59 | 0.62 |
| Game Changers against the rest of EDHREC's top 5,000 | 53 / 4,941 | 0.76 | 0.89 |
| cEDH staples (10% of tournament decks or more) against other played cards | 230 | 0.91 | 0.93 |
| Wider cEDH pool (3% or more) against other played cards | 512 | 0.81 | 0.84 |

Read them with their weaknesses:

- The first two sets come from lists agents built for Bryan, and cut cards are precon cards,
  which are cheap because they were just reprinted. Price alone scores 0.92 and 0.90 on them,
  so they flatter anything with price in it.
- The cEDH sets are the honest test of price, because tournaments allow proxies: there price
  alone scores 0.81, play share alone 0.91 and the two together 0.93. That is why price is one
  term at weight 0.75 and not the whole rating.
- The third set is decided mostly by the deck, so every score is weak on it.
- The weights were set by hand to round numbers that hold on all six sets, not fitted. Taking
  any one term out moves a check by 0.02 or less, except price (0.87 to 0.73 on the Bracket set).
  The color-identity division is close to neutral on these sets; it is kept because the sets
  hold few gold cards and it is the same division EDHREC makes.

On the 13 Nov collection export (1,233 rated cards): of the 276 cards the rank calls Playables,
155 stay Strong or Top, 110 drop to Playable and 11 to bulk, ten of those lands (Escape Tunnel,
Nesting Grounds, the Urza lands). Of 322 Viable cards, 25 rise to Strong or Top
and 155 drop to bulk. Of 635 bulk cards, 36 rise to Playable or better.

## What it can't see

- **A cheap card few people play.** Both main terms are demand, so an underrated card scores low.
  Only game results can find those ("Later inputs").
- **The deck.** Sliver Legion rates 90 because Sliver players pay for it; the rating doesn't know
  the commander in front of you. Deck analysis and the plans do that.
- **New cards.** Launch prices and a deck count still filling in; marked provisional.
- **The rank itself.** The deck-count curve is rebuilt from five public figures and guessed past
  rank 5,000. Play share is "about", and the anchors need a look once or twice a year.
- **Commanders as commanders.** The rating is for the 99; `/commanders` ranks commanders.

## What was tried and left out

- **Yama's text points** (role and efficiency from Oracle text): 0.53 to 0.68 alone, no gain when
  added. They stay useful for naming a card's role.
- **Cube Cobra Elo:** 0.51 to 0.77 alone, no gain when added, and no data licence.
- **Mana value:** helps the cEDH sets, hurts the others.
- **Fitting a model:** no trustworthy labels to fit to; a hand-set formula can be explained on a
  card's page.

## Building it

1. **Server.** A derived `card_ratings` table (oracle id, rating, play share, the terms, method,
   computed-at), recomputed after each card import and price update, with `rating::METHOD`
   bumped whenever a number changes. `yama-server card-rating-eval --lists DIR` prints the table
   above, as `power-eval` does for deck scoring; a change to the formula ships with its before
   and after.
2. **Everywhere a card shows.** The offline card list carries the rating, so the scanner's tag
   needs no request. The card page and the scanned card's sheet say why in one sentence ("In
   about a third of black-green decks; $1.17"). `get_cards`, `search_cards` and
   `list_collection_cards` return it and sort by it.
3. **Roles.** Scryfall publishes its community role tags in bulk since 2026 (`oracle_tags`: ramp,
   removal, sweeper, draw, tutor, counterspell, protection, recursion). With them, "the best
   removal I own and am not using" is one query, which is what `commander-decks` needs for
   spares ("Use the spares and leftovers").
4. **commander-decks.** `piles.py` reads the rating in place of the rank, and candidate lists for
   a slot sort by it within the role.

## Later inputs

- **cEDH play rate**, as a boost and a mark of its own ("in 60% of cEDH decks"). TopDeck.gg's API
  is free with a key and asks for a visible credit; that needs an account.
- **Win rates from real games.** Playgroup.gg computes each card's win-rate lift within the same
  commander from 244,155 casual games and licenses the figures CC BY 4.0, but shows only 175
  cards. A file from them would be the one input that can find a good card nobody plays.
- **Yama's own lab.** The Forge runs log every game; a win rate for games where a card was drawn
  is possible for precon cards, as far as the computer's play can be trusted.

## Decisions for Bryan

1. **Does price belong in the rating?** Recommended: yes, at this weight. Without it the rating
   is fairer than the rank but can't tell Rampant Growth from Demonic Tutor. The other way to go
   is two figures, a play share and the price, with no combined number.
2. **The words and the bars.** Recommended: Top (80), Strong (68) and Playable (55) in place of
   Staple and Played, with Game Changer still a separate mark. For the boxes: Playables takes
   Strong and up, Viable takes Playable, and "a land that makes two or more colors" stays a
   rule of its own. That moves about 120 cards out of the Playables box and 25 in.
3. **cEDH data.** Make a TopDeck.gg account and key (free), or leave cEDH out for now.
4. **Ask Playgroup.gg for a per-card file.** A short email from Bryan; they invite the request.
5. **Go.** Build stages 1 and 2, then 3 and 4.
