# Deck analysis: power level and vectors

Bryan, 8 Nov 2026, after looking at ScryCheck (scrycheck.com): "Scrycheck's doing a lot of what
we want ... we can copy their methodology best we can." Yama's version lives in
`server/src/analysis/` and shows on the deck page, the shared deck page and the MCP
`deck_analysis` tool. It replaced the older bracket-band estimate (`power_level.rs`,
`packages/core/src/powerLevel.ts`).

## Where it comes from

ScryCheck isn't open source. Its terms reserve its scoring logic and forbid scraping,
reverse-engineering and automated bulk submissions without its written consent. So Yama doesn't
copy its code, its per-card points or its results, and doesn't run decks through it to fit a
model to its numbers. What Yama takes is the shape of the method its public docs page
describes (scrycheck.com/docs, read 2026-11-08): cards earn points in categories, categories add
up to five vectors (Speed, Consistency, Interaction, Mana base, Threats), Commander Spellbook's
combos add to Threats, and a weak mana base or a strategy without compact wins caps the score.
Every rule, point and threshold is Yama's own. The deck page has "Check it on ScryCheck": it
copies the list and opens Scrycheck in a new tab to paste it into. Nothing goes to ScryCheck
until the person pastes it and presses Analyze there.

## How it works

1. **Card points** (`classify.rs`). Each nonland card's Oracle text earns 0-10 points in
   categories, cheaper cards more:
   - Speed: fast mana, rocks, mana creatures, land ramp, Treasure, cost reducers, haste.
   - Consistency: tutors, draw engines, card draw, cantrips, wheels, selection, recursion.
   - Interaction: counterspells, spot removal, artifact and enchantment removal, wipes,
     graveyard hate, taxes and locks, protection.
   - Threats: finishers, engines and payoffs, big threats, token makers, reanimation, group
     damage.

   Text is read with the card's self-references as one token. Current Oracle text says "this
   artifact" rather than the name. Reminder text and ability words ("Landfall —") are dropped,
   and an Adventure's spell counts. A short curated list fixes cards whose text misreads their
   strength (Sol Ring, Rhystic Study, Thassa's Oracle...). The commander's points count half
   again, because it's always available.
2. **Vectors.** A card's best category in a vector counts in full, any others 30%. A vector
   adds its cards up, each next-best card at 0.965 of the one before. The total is then mapped
   piecewise onto 0-100, anchored on the reference lists: about 40 is a typical stock precon,
   75 a typical Bracket 4 build, 95 cEDH.
3. **Combos** come from the version's stored Commander Spellbook check, if any. Each line's
   weight is its size times its outcome:
   - size: definitely two-card 1, arguably two-card 0.8, three pieces 0.55, more 0.35;
   - outcome: ends the game 1, infinite resources 0.6, a lock 0.45, other loops 0.3.

   Lines that share a card form a family, scored as its best line plus a quarter of each
   other line, capped at 1.5 times the best. The best four families add up to the combo score,
   which adds 14 points per unit (up to 3) to Threats and 0.5 per unit (up to 2.5) to the power
   level.
4. **Mana base** (`lands.rs`). Each land gets a quality from 0 to 1 for the deck's color count:
   - original duals 1, shocks and battlebond lands 0.95, fetches 0.96;
   - check, fast and pain lands about 0.86-0.9;
   - a basic is 0.92 in one color, 0.6 in two, 0.45 in three or more;
   - an unconditional tapland is 0.2-0.5.

   The vector is the average quality scaled from 0.38 (0) to 0.9 (100). It's lowered when
   lands plus half the ramp come to under 36.
5. **Power level.** The weighted vector score is Speed 0.30, Consistency 0.30, Interaction
   0.28, Threats 0.12. It maps piecewise onto 1-10: 42 → 3.4, 53 → 4.8, 60 → 5.8, 72 → 7.2,
   86 → 9.0. Combos are added after that. A mana base under 60 takes up to 0.6 off. Caps:
   - mana base under 25: 6.5; under 45: 8;
   - average nonland mana value over 4: 6;
   - 8.5 without a compact combo, three good tutors and three fast mana;
   - 9.4 without two compact families, five tutors, five fast mana and four counterspells.
6. **Margin and confidence.** The margin starts at ±0.3. It widens by 0.1 per card missing
   from the card data (up to 0.5), by 0.2 with no Spellbook check, and by the share of nonland
   cards that earned no points beyond 35%. Confidence is high up to 0.4, medium up to 0.6, low
   beyond.
7. **Themes** (`themes.rs`). A theme counts the cards whose text joins in: 15 or more is core,
   10 major, 6 minor. Themes include tokens, counters, graveyard, artifacts, enchantments,
   spells, lands, equipment, sacrifice, life gain, flicker, energy, draw and go-wide. The two
   biggest creature types are added when 10 or more cards share one.
8. **Bracket reading.** The score sits in a bracket's usual range: Bracket 2 up to 5, Bracket 3
   up to 7, Bracket 4 above. That reading never says 1 or 5, which depend on intent and the cEDH
   metagame. The owner's declared bracket stays theirs, and Spellbook's starting suggestion
   stays beside it.

`GET /api/decks/{id}/analysis` returns three things:
- the current list's full analysis;
- a summary (power, margin, vectors) for each saved version, the newest 60;
- the same summary for each configuration's current list.

It's computed on request, with card scores cached across the lists in one request. The deck
page draws power over time and the configurations side by side from it. `analysis::METHOD`
names the rule set; bump it when a number changes.

## Calibration (2026-11-08)

Calibrated with a Python prototype on Scryfall's oracle bulk file. The lists came from
commander-decks:
- 174 stock precons (MTGJSON);
- Bryan's proposed Bracket 2, 3 and 4 builds (`decks/compare`);
- his stock, now and after-prints lists (`data/sim/decks/bryan`);
- two Kraum and Tymna cEDH lists.

Commander Spellbook checked each list once, 4.5 s apart. The prototype's numbers became the
Rust tests' fixture (`server/src/analysis/cases.json`: 490 cards and six decks), so a change to
a rule shows up as a changed expectation.

| Lists | n | Median | 10th-90th percentile | Speed | Consistency | Interaction | Threats | Mana base |
|---|---|---|---|---|---|---|---|---|
| Stock precons | 174 | 3.3 | 2.5-4.5 | 40 | 40 | 40 | 55 | 34 |
| Bracket 2 builds | 11 | 5.1 | 4.0-5.6 | 47 | 60 | 51 | 52 | 62 |
| Bracket 3 builds | 12 | 5.5 | 4.5-6.1 | 53 | 66 | 59 | 53 | 61 |
| Bracket 4 builds | 11 | 7.5 | 6.5-8.2 | 75 | 75 | 75 | 62 | 65 |
| cEDH | 2 | 9.4 | | 94 | 95 | 94 | 43 | 85 |

Bryan's Lorehold Spirit (Quintorius) scores 6.2 ±0.3 with these vectors: Speed 51,
Consistency 62, Interaction 74, Mana base 62, Threats 76. ScryCheck showed 5.4 ±0.4 for the
same list, and the older Yama estimate showed 6.1. ScryCheck's docs give two reasons it runs
lower:
- it reports a systematic −0.29 bias against independent judgment;
- it calls its engine "recalibrated to a more conservative baseline".

Its scale also puts 5 at "focused casual" and 7 at the Bracket 4 line, as this one does. Its
vectors for that deck are higher than Yama's (Consistency 88, Mana base 89, Threats 89),
because its 0-100 is a ceiling only optimized decks approach, not anchored on precons.

## Limits

- It reads card text. Synergy beyond the commander bonus and themes, play order, the pilot
  and the table aren't modeled.
- The text rules miss some cards. They're counted in `unscored`, which widens the margin.
- The reference builds are Bryan's own bracket labels.
- Scryfall's community function tags (`otag:ramp`, `otag:removal`...) could supply roles the
  rules miss. That's a possible next step, not done yet.
- Not yet built: a win-turn estimate (ScryCheck anchors it on Playgroup.gg), "popular in
  similar decks" suggestions, and an upgrade path tied to the weakest vector.

## Measuring the method (2026-11-11)

Bryan, 11 Nov 2026: "we should measure before changing the score. Ideally we could do this
programmatically." `yama-server power-eval [--lists DIR] [--json]` (`analysis/eval.rs`) does
that. It reads the card data and the public precon catalog in the database, and a folder of
text lists if one is given. It calls no outside service and no model, and writes nothing.
Run it on a copy of production's data (`deploy/pull-db.sh`), before and after any change to a
rule, point, weight, curve, cap or margin, and put both outputs in the PR.

It prints:

- **Stock precons.** How many land in Brackets 2, 3 and 4 under each way of reading a bracket:
  the power band, Wizards' Game Changer rule (none in Bracket 2, up to three in Bracket 3), the
  higher of the two and the lower.
- **Stock precons against real games.** The rank correlation, with a 95% interval, between the
  stock list's real win rate and power, each vector, the Game Changer count and the
  commander's record over every list. A scoring change should raise power's figure, or at
  least not lower it. The win rates are noisy (about half of the spread between precons is
  sampling), so no score can reach 1.
- **Reference lists** (`--lists`). Files are named `<deck>-<step>-<kind>.txt`, as in
  commander-decks' `decks/compare`; a kind ending `bracket-N` is a list built for Bracket N.
  Reported: power by label, each rule against the labels, how often power ± margin reaches
  the label, and whether the same deck built for a higher bracket scores higher. Bryan's
  builds are labelled by Game Changer count, so the Game Changer rule's agreement with them
  is circular; lists whose author stated a bracket for other reasons are the ones that test it.

`--json` gives every scored list with its inputs, for a closer look (set `RUST_LOG=off`, or
the server's log lines share the output). A reference list that is also saved as a deck reads
that deck's stored Commander Spellbook answer, matched by its cards; nothing is asked of
Spellbook.

```sh
deploy/pull-db.sh    # a copy of production's data: real people's data, delete it afterwards
DATABASE_URL=sqlite://data/yama.db YAMA_OFFLINE=1 target/debug/yama-server power-eval \
  --lists ../commander-decks/decks/compare
```

First run, 11 Nov 2026, method 2026-11-08, 178 stock precons and Bryan's 78 lists (34 built for
a named bracket):

- Power against the stock list's real win rate: +0.06 (−0.17 to +0.28) over the 85 precons
  with 40 or more games, +0.30 (−0.01 to +0.58) over the 47 with 200 or more. The commander's
  record over every list gets +0.44 and +0.59 on the same decks. Of the vectors, Threats
  (+0.28) and Speed (+0.19) lean the right way; Consistency (−0.11) and Mana base (−0.18) lean
  the wrong way.
- A Game Changer in a stock precon does not show in its results: the 8 such precons with 40 or
  more games won 21.6% of 2,248 games, the 77 without won 20.8% of 23,550, and the count's rank
  correlation with win rate is +0.02.
- Bryan's builds (32 of the 78 lists read a stored combo check): the same deck built for the
  next bracket up always scores higher (2 to 3 by 0.5, 3 to 4 by 1.8), but decks differ more
  than brackets do (Bracket 3 builds run from 4.4 to 6.3), so the band alone names the bracket
  a list was built for 56% of the time.
- Power ± margin reaches that bracket for 71% of them at today's margins, 91% at ±0.7 and 94%
  at ±1.0.

## Precon comparison (2026-11-09)

The public `/precons` table and stock detail pages show computed power (1–10), its
margin and the estimated bracket from the same Rust analysis. The public API's `power`
object includes the method date, level, margin, bracket and unknown-card count. This
is card-text scoring, not game simulation or an official bracket assignment. It does
not replace a bracket legality check. Public stock lists have no stored Spellbook
check; the estimate uses no combo bonus and widens its margin accordingly. No private
checks or saved versions are read. Completely missing card data stays unassessed.

The page compares power with each published engine's model win rate and with stock-list
real games separately. Charts use the full catalog before filtering/pagination,
exclude incomplete card data, and require at least 20 appearances/games per source.
Each point opens its precon. Spearman rank correlation averages ties and is unavailable
with fewer than four pairs or no variation. Commander-only aggregates are excluded.
This is descriptive evidence: the stock cohort already helped set the power scale,
engine results have model limitations, and real games involve different opponents and
pilots. Neither chart nor score changes meta rankings. Changing vector weights needs
held-out validation; more simulation games alone do not establish real-world accuracy.
