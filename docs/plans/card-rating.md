# A rating for every card: how good it is, not how many decks list it

Status: proposed, 23 Nov 2026. A prototype exists outside the repository and is measured below;
nothing is built in Yama. Five decisions wait on Bryan ("Decisions for Bryan").

Asked for by Bryan, 23 Nov 2026: "We need to come up with a good way to rank cards because there
are a lot of cards that might be good but they're not in the cEDH meta. The meta is kind of hard
to understand and grok but there's definitely a somewhat formulaic way to know how good a card
is. I don't know if any sites do this or if we can do this but it'd be super handy for the
scanner for sure ... and this would be really helpful for the commander decks repo as well."

The prototype's scripts, inputs and outputs are in a work directory outside the repository
(`~/Developer/.agent-tasks/yama-card-power-20261123/`: `work/rating.py` is the formula,
`work/final.py` prints every figure quoted here). Card data is Scryfall's bulk files of
23 Nov 2026, and every price on this page is Scryfall's market price (USD) of that day for the
card's cheapest printing: a dated market price, not a store quote.

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
| Playgroup.gg staples | Win-rate lift with and without a card, same commander, 244,155 casual games, CC BY 4.0 with a link back | Only 175 cards shown; no file |
| EDHTop16 staples | cEDH play rate for about 1,300 cards | cEDH only, the meta Bryan wants to see past; page only, no licence stated |
| Cube Cobra | A draft-pick Elo for 39,000 cards, public file | Cube drafting, two players; no data licence |
| Arena Brawl weights | Datamined matchmaking weights | Two players, frozen at May 2024 |
| Draftsim, ScrollVault, edhpowerlevel | Deck scores | No card table, or EDHREC-rank tiers |

Research on scoring cards from their text alone (the SPELLS thesis, 2025; DraftFM, 2026) trains on
subjective labels or draft picks. Yama's own text rules (`server/src/analysis/classify.rs`) were
tried as an input here and added nothing ("What was tried and left out").

## The rating

The idea is the one EDHREC itself shows on a card's page and doesn't publish in bulk, plus what
people pay: **how much do players want this card in the decks that can run it?**

```
play share = decks(rank) / (7.8 million × color share × age share), at most 1
index      = log10(play share)
           + 0.75 × log10(price + 0.25)        price held between $0.50 and $60
           + 0.2  × log10(1 + two-card combos)
           − 0.2  × log10(1 + precon printings)
           − 0.25 for a land
rating     = 94 + 20 × index, held to 0–100
```

1. **Play share is a modeled estimate, not EDHREC's figure.**
   - `decks(rank)` is a curve, straight between points on log scales, through five figures read
     by hand from public EDHREC pages on 23 Nov 2026 (Sol Ring, Swords to Plowshares, Assassin's
     Trophy, Narset, Parter of Veils and Batterskull, the last two from older snapshots) and
     guessed past rank 5,000. The 7.8 million is Sol Ring's page: 6.54 million decks, 83.8%.
   - Color share is the share of reported games played by commanders whose color identity holds
     the card's, from Yama's public commander records (4,082 commanders, 5.1 million reported
     games on `/commanders`): about half for one color, a quarter for a pair, an eighth for
     three. It is weighted by games, not by decks.
   - Age share is months since the first printing over 18, between 25% and 100%: a newer card
     has had fewer decks to be in.
   - Whether the rank counts a card's own command-zone decks isn't documented. The prototype
     first took off the decks a commander leads; the rank doesn't look as if it holds them (for
     many popular commanders the decks they lead outnumber the rank's whole count), so the
     subtraction is out. A legendary creature's rating is for its place in the 99.
2. **Price.** At the same play share, the card people pay more for is the one they want more.
   Below $0.50 a price says nothing; above $60 it is mostly scarcity (Reserved List, old print
   runs). A missing price stays missing: the card is rated as if at the $0.50 floor (about three
   points under a $1 card) and marked "no price". Eleven rated cards have none.
3. **Two small corrections.** Up for each two-card combo the card is half of (Commander
   Spellbook's export: variants marked OK and legal in Commander, made of named cards only).
   Down for each printing in a set Scryfall types as `commander`.

Top is 80 and up (479 cards), Strong 68 (1,141), Playable 55 (2,873), of 32,575 rated. A card
under six months old is marked provisional (1,674 cards). Banned cards, basic lands and cards
without a rank get no rating.

The inputs are in Yama's database already (`cards.edhrec_rank`, color identity, prices,
`printings.set_type`, `spellbook_combos`, the commander evidence), with two differences from the
prototype to settle and remeasure when it is built: Yama's Spellbook import leaves out combos
that need a card as the commander, which the prototype counted; and the commander evidence comes
from datasets with their own attribution (Playgroup.gg, Mythic Tools), which a page showing a
figure derived from them has to carry.

What it does to familiar cards:

| Card | EDHREC rank | Price | Rating | New tag | Why |
|---|---|---|---|---|---|
| Rhystic Study | 46 | $63.18 | 100 | Top | In about a quarter of blue decks |
| Eladamri's Call | 788 | $10.45 | 89 | Top | About 9% of green-white decks: gold cards get their due |
| Sol Ring | 1 | $1.16 | 89 | Top | No longer first, because it is cheap |
| Assassin's Trophy | 121 | $1.17 | 85 | Top | A third of black-green decks |
| Culling the Weak | 489 | $8.03 | 83 | Top | 6% of black decks, and a cEDH staple |
| Cultivate | 20 | $0.32 | 78 | Strong | Cheap and everywhere |
| Command Tower | 2 | $0.20 | 75 | Strong | |
| Path of Ancestry | 15 | $0.22 | 67.8 | Playable | 33 precon printings |
| Commander's Sphere | 57 | $0.15 | 67 | Playable | 36 precon printings |
| Murder | 906 | $0.11 | 62 | Playable | |
| The Tabernacle at Pendrell Vale | 8,784 | $3,619.50 | 58 | Playable | The price counts as $60 |
| Batterskull | 5,092 | $3.42 | 54 | None | Just under Playable |

## Measured

Each check takes two groups of cards where one should be better, and asks how often the score
puts a card from the better group above one from the other (0.5 is a coin flip). The groups
stand in for real strength; none of them is a measurement of it.

| Check | Cards | EDHREC rank | Rating |
|---|---|---|---|
| Cards Bryan's plans add against the cards they cut (`commander-decks/decks/compare`, 20 decks) | 386 / 609 | 0.76 | 0.88 |
| Added only for Bracket 4 against added only for Bracket 2, none from the stock list | 104 / 84 | 0.69 | 0.87 |
| Stock precon cards the plans keep against stock cards they cut, nonland | 336 / 267 | 0.59 | 0.63 |
| Game Changers against the rest of EDHREC's top 5,000 | 53 / 4,941 | 0.76 | 0.89 |
| Cards EDHTop16 shows in 10% or more of cEDH decks, against nonland cards in EDHREC's top 8,000 it shows under 1% or not at all | 230 / 6,218 | 0.91 | 0.93 |
| The same at 3% or more | 512 / 6,218 | 0.81 | 0.83 |

Read them with their weaknesses:

- **The same six checks guided the choice of weights.** The weights are round numbers set by
  hand, not fitted, but this is agreement with the checks, not a held-out test.
- The first two sets come from lists agents built for Bryan, and cut cards are precon cards,
  which are cheap because they were just reprinted. Price alone scores 0.92 and 0.90 on them,
  and 0.93 on Game Changers, so those three flatter anything with price in it.
- The cEDH sets are where price can't cheat, because tournaments allow proxies. There price
  alone scores 0.81 and 0.73, the rating without its price term 0.93 and 0.82, and the whole
  rating 0.93 and 0.83. So price is what lifts the first, second and fourth checks (without it:
  0.81, 0.74 and 0.76) and it costs nothing where it shouldn't help. That is why it is one term
  at weight 0.75 and not the whole rating.
- The third set is decided mostly by the deck, so every score is weak on it. It is the one check
  the color share plainly helps (0.60 without it).
- Taking out the combo term, the precon term, the age share or the land offset moves each check
  by 0.02 or less.

Sorting the 13 Nov 2026 collection export (1,233 rated cards) into the boxes, with the existing
rule that a land making two or more colors is a playable on both sides: of 328 cards in
Playables, 86 leave (75 to Viable, 11 to bulk, ten of the 11 lands such as Escape Tunnel and the
Urza lands), and 27 come in. Of 290 Viable cards, 140 drop to bulk; 32 bulk cards rise to Viable.

## What it can't see

- **A cheap card few people play.** Both main terms are demand, so an underrated card scores low.
  Only game results can find those ("Later inputs").
- **The deck.** Sliver Legion rates 91 because Sliver players pay for it; the rating doesn't know
  the commander in front of you. Deck analysis and the plans do that.
- **New cards.** Launch prices and a deck count still filling in; marked provisional.
- **The rank itself.** The deck-count curve is rebuilt from five public figures of mixed dates
  and guessed past rank 5,000, so play share is "about". The anchors would be read again by
  hand once or twice a year; EDHREC's terms rule out fetching them by script.
- **Commanders as commanders.** The rating is for the 99; `/commanders` ranks commanders.
- **Price as cause.** A card can be dear for its art or its scarcity under the $60 cap, and a
  reprint moves a rating without the card changing.

## What was tried and left out

- **Yama's text points** (role and efficiency from Oracle text): 0.53 to 0.68 alone, no gain when
  added. They stay useful for naming a card's role.
- **Cube Cobra Elo:** 0.51 to 0.77 alone, no gain when added, and no data licence.
- **Mana value:** helps the cEDH sets, hurts the others.
- **Taking off the decks a commander leads:** see "The rating"; no check improved.
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
   about a third of the decks that can run it"), beside the price with its date and source as
   everywhere else. `get_cards`, `search_cards` and `list_collection_cards` return it and sort
   by it. Pages that show it credit Scryfall and Commander Spellbook with a link, as the combo
   pages do.
3. **Roles.** Scryfall now publishes its community role tags in bulk (`oracle_tags`, read
   23 Nov 2026: ramp, removal, sweeper, draw, tutor, counterspell, protection, recursion). With
   them, "the best removal I own and am not using" is one query, which is what `commander-decks`
   needs for spares ("Use the spares and leftovers").
4. **commander-decks.** `piles.py` reads the rating in place of the rank, and candidate lists for
   a slot sort by it within the role.

## Later inputs

Each needs its terms read and its credit shown before any of its data is stored or displayed.

- **cEDH play rate**, as a boost and a mark of its own. TopDeck.gg's API is free with a key; its
  developer terms ask for a visible credit with a link and forbid selling the data. That needs
  an account.
- **Win rates from real games.** Playgroup.gg computes each card's win-rate lift within the same
  commander from 244,155 casual games and publishes the aggregate figures under CC BY 4.0 with a
  link back, but shows only 175 cards. A file from them, with their say on how to credit it,
  would be the one input that can find a good card nobody plays.
- **Yama's own lab.** The Forge runs log every game; a win rate for games where a card was drawn
  is possible for precon cards, as far as the computer's play can be trusted.

## Decisions for Bryan

1. **Does price belong in the rating?** Recommended: yes, at this weight. Without it Demonic
   Tutor rates 81 and Rampant Growth 79; with it, 100 and 77. The other way to go is two
   figures, a play share and the price, with no combined number.
2. **The words and the bars.** Recommended: Top (80), Strong (68) and Playable (55) in place of
   Staple and Played, with Game Changer still a separate mark. For the boxes: Playables takes
   Strong and up, Viable takes Playable, and "a land that makes two or more colors" stays a
   rule of its own. On the 13 Nov export that moves 86 cards out of the Playables box and 27 in,
   before the exceptions for cards a plan counts on or that are being sold.
3. **cEDH data.** Make a TopDeck.gg account and key (free), or leave cEDH out for now.
4. **Ask Playgroup.gg for a per-card file.** A short email from Bryan; they invite the request.
5. **Go.** Build stages 1 and 2, then 3 and 4.
