# Spec: spells that roll dice and use the result do nothing

Root cause (observed behaviour): four spells whose whole effect is built on a die roll resolved in phase with no roll logged and no effect at all; the spell just went to the graveyard. Two shapes are involved: "roll two dice and choose one result ... the other result" (the Endeavor cycle) and "roll a d20 and add [a number]" with a results table (Song of Inspiration). Every possible roll produces an effect on these boards, so "nothing happened" is wrong whatever was rolled.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-valiant-endeavor`, `card-arcane-endeavor`, `card-grave-endeavor`, `card-song-of-inspiration`.

## 1. Cards

Oracle text from Scryfall.

- **Valiant Endeavor** ({4}{W}{W}): "Roll two d6 and choose one result. Destroy each creature with power greater than or equal to that result. Then create a number of 2/2 white Knight creature tokens with vigilance equal to the other result."
- **Arcane Endeavor** ({5}{U}{U}): "Roll two d8 and choose one result. Draw cards equal to that result. Then you may cast an instant or sorcery spell with mana value less than or equal to the other result from your hand without paying its mana cost."
- **Grave Endeavor** ({4}{B}{B}): "Roll two d10 and choose one result. Return a creature card from your graveyard to the battlefield with a number of +1/+1 counters on it equal to that result. Then each opponent loses X life and you gain X life, where X is the other result."
- **Song of Inspiration** ({3}{G}{G} instant): "Choose up to two target permanent cards in your graveyard. Roll a d20 and add the total mana value of those cards. 1—14 | Return those cards to your hand. 15+ | Return those cards to your hand. You gain life equal to their total mana value."

Rulings (all four, 2021-07-23): "The instruction to roll a die and the effect that occurs because of the result are all part of the same ability." "An ability that tells you to roll a die will also specify what to do with the result of that roll." "An effect that says 'choose a target, then roll a d20' or similar still uses the normal process ... rolling the d20 happens later, as the ability resolves."

## 2. Board and actions

Seat 0 (active, main phase 1): the lands for the card, Grizzly Bears (2/2) on the battlefield; hand is the card and a Wastes; graveyard Hill Giant (creature, MV 4, 3/3) and Divination; library 8 Wastes. Seat 1: Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire; library 8 Wastes; life 20 each.

- `card-valiant-endeavor`, `card-arcane-endeavor`, `card-grave-endeavor`: seat 0 casts the card (no targets).
- `card-song-of-inspiration`: seat 0 casts Song of Inspiration targeting Hill Giant in its own graveyard (one target).

## 3. Correct result

Call the two natural results a and b; the caster chooses which is "that result" (r) and the other is o.

- **Valiant Endeavor** (a, b in 1–6): destroy each creature with power ≥ r, then create o Knight tokens (2/2 white, vigilance) for seat 0. Since o ≥ 1, **at least one Knight token is always created**. Creatures destroyed depend on r: r ≤ 2 destroys all three Bears/Angel (and the new Knights don't exist yet), r = 3 or 4 destroys Serra Angel only, r ≥ 5 destroys nothing. Forge's run: Serra Angel destroyed, 5 Knights (r = 4, o = 5).
- **Arcane Endeavor** (a, b in 1–8): seat 0 draws r cards, **at least 1**. Then may cast an instant or sorcery with MV ≤ o from hand for free (it has none here, its hand is Wastes only). Library 8 → 8 − r. Forge drew 1.
- **Grave Endeavor** (a, b in 1–10): seat 0 returns Hill Giant (its only creature card in graveyard) to the battlefield with r +1/+1 counters (**at least one**), then seat 1 loses o and seat 0 gains o (**at least 1 each**). Forge's run: Hill Giant with six counters (9/9), seat 1 at 11, seat 0 at 29.
- **Song of Inspiration**: roll d20 + 4 (Hill Giant's MV). Both rows return the targeted card, so **Hill Giant always goes to seat 0's hand**. If the total is 15+ (natural 11–20), seat 0 also gains 4 life. Forge returned Hill Giant (total under 15).

## 4. Why

1. 706.1–706.3: the effect tells the player what dice to roll; 706.2 defines the result (natural result plus modifiers). Song of Inspiration's "add the total mana value of those cards" is a modifier written into the instruction (706.2).
2. 706.3 (results table) for Song of Inspiration: the row matching the result applies. Both rows say "Return those cards to your hand," so the return happens on every roll.
3. 706.4 for the Endeavors: no table; the text says how to use the results. The caster rolls both dice, chooses which one is "that result," and the other is "the other result." Both are integers ≥ 1, so every instruction that uses them does something on this board (draw ≥ 1, ≥ 1 token, ≥ 1 counter, ≥ 1 life).
4. The instructions are followed in order (608.2c). Nothing in these cards makes them do nothing on resolution; the only way they do nothing is if all targets are illegal (608.2b), which applies only to Song of Inspiration and isn't the case (Hill Giant is still in the graveyard).

## 5. What phase did

In all four scenarios phase's log shows the spell moving from stack to graveyard and nothing else: no roll, no destruction, no tokens, no draw, no return, no life change. Forge rolled and applied the results.

## 6. Variations to test

- Use a seeded or forced roll so the result is fixed, then check exact outcomes:
  - Valiant Endeavor, rolls 4 and 5: choose r = 4 → Serra Angel destroyed, five Knights; choose r = 5 → nothing destroyed, four Knights.
  - Valiant Endeavor, rolls 1 and 1: r = 1 destroys every creature with power ≥ 1 (all three) then one Knight is created and survives (it's created after the destruction).
  - Arcane Endeavor, rolls 3 and 2, with a Divination (MV 3) in hand: draw 3; Divination can't be cast for free (MV 3 > 2). Rolls 2 and 3: draw 2, and seat 0 may cast Divination without paying its mana cost.
  - Grave Endeavor with no creature card in seat 0's graveyard: nothing returns, but the life drain/gain of the other result still happens.
  - Grave Endeavor with two opponents: each opponent loses o; the caster gains o once.
  - Song of Inspiration with two targets (Hill Giant MV 4 and a Grizzly Bears card MV 2 in seat 0's graveyard): add 6 to the roll; both cards return; on 15+ (natural 9 or more) gain 6 life. Divination is not a permanent card and can't be targeted.
  - Song of Inspiration with zero targets: roll d20 + 0; nothing returns, no life gain (total MV 0) whichever row.
  - Song of Inspiration whose target left the graveyard before resolution: all targets illegal, the spell doesn't resolve (608.2b), no roll.
- "Whenever you roll one or more dice" triggers (e.g. Pixie Guide's or Brazen Dwarf's ability) should trigger once per roll instruction.
- Effects that modify rolls (Pixie Guide: roll an extra die and ignore the lowest) should apply to each d20 roll.

## 7. Acceptance checks

- Casting Valiant Endeavor always creates at least one Knight token.
- Casting Arcane Endeavor always draws at least one card (library permitting).
- Casting Grave Endeavor with a creature card in the graveyard always returns it with at least one +1/+1 counter, and always moves at least 1 life from each opponent to the caster.
- Casting Song of Inspiration on Hill Giant always returns Hill Giant to hand, and gains 4 life when the d20 natural result is 11 or more.
- The game log records each die roll and the chosen result.

## Added from triage batch 3: Reckless Endeavor and Danse Macabre

Scenarios: `card-reckless-endeavor`, `card-danse-macabre` (standard sweep board). Same symptom: phase logs no die roll ("Player 1 rolls a d20: N" is how phase logs a roll elsewhere in the sweep).

**Reckless Endeavor** ({5}{R}{R} sorcery): "Roll two d12 and choose one result. Reckless Endeavor deals damage equal to that result to each creature. Then create a number of Treasure tokens equal to the other result."
- Board: seat 0 has 2 Mountains, 5 Wastes, Grizzly Bears; seat 1 has Grizzly Bears, Serra Angel. Seat 0 casts it.
- Correct (706.1, 706.4, 608.2c): roll two d12 (each 1-12); seat 0 picks r and the other is o. Each creature (both Bears, Serra Angel) is dealt r damage: r ≥ 2 kills both Bears, r ≥ 4 also kills Serra Angel; r = 1 kills nothing. Then seat 0 creates o Treasures (o ≥ 1, untapped). So **at least one Treasure and at least 1 damage to each creature, always**. Forge: r = 5 (all three creatures died), 10 Treasures.
- Phase: spell went to the graveyard with no roll, no damage, no Treasures.

**Danse Macabre** ({3}{B}{B} sorcery): "Each player sacrifices a nontoken creature of their choice. Roll a d20 and add the toughness of the creature you sacrificed this way. 1—14 | Return a creature card put into a graveyard this way to the battlefield under your control. 15+ | Return up to two creature cards put into graveyards this way to the battlefield under your control."
- Rulings: "Starting with you and continuing in turn order, each player will choose which creature they will sacrifice ... The creatures are all sacrificed at the same time." "All creatures are chosen and sacrificed before the die is rolled." "You add only the toughness of the creature you sacrificed this way ... If you didn't sacrifice a creature this way, you will still roll a d20, but you will not add anything to the roll."
- Board: seat 0 has 2 Swamps, 3 Wastes, Grizzly Bears (its only creature); seat 1 has Grizzly Bears and Serra Angel. Seat 0 casts it.
- Correct: seat 0 sacrifices its Bears; seat 1 sacrifices Bears or Serra Angel (its choice; both engines picked Bears). Roll a d20 and add 2 (the toughness of seat 0's sacrificed Bears, last known information, 608.2h). Natural 1-12 → total 3-14 → seat 0 **must** return exactly one of the two sacrificed cards to the battlefield under its control (the row says "a creature card", not "up to"). Natural 13-20 → 15+ → seat 0 returns up to two of them. Only cards put into a graveyard by this sacrifice qualify; the Hill Giants already in the graveyards don't. Forge: returned seat 1's Bears under seat 0's control.
- Phase: both Bears were sacrificed, then no roll and nothing returned.

Extra variations: Danse Macabre where seat 0 controls no nontoken creature (it still rolls, adds nothing); Danse Macabre with a natural 13+ where seat 0 returns two cards (both under seat 0's control); Reckless Endeavor with r large enough to kill everything (the Treasures are created after the damage, so they don't matter for it).

Acceptance: both spells log their rolls; Reckless Endeavor always deals damage to each creature and creates at least one Treasure; Danse Macabre with a total of 14 or less always returns exactly one creature card sacrificed this way under its caster's control.

## Added from triage batch 5: Wild Endeavor

Scenario: `card-wild-endeavor`. **Wild Endeavor** ({4}{G}{G} sorcery): "Roll two d4 and choose one result. Create a number of 3/3 green Beast creature tokens equal to that result. Then search your library for a number of basic land cards equal to the other result, put them onto the battlefield tapped, then shuffle."

Board: seat 0 has Forest ×2, Wastes ×4, Grizzly Bears; library 8 Wastes (basic lands). Observed: phase put Wild Endeavor into the graveyard with no roll logged, no tokens, no search (library 8). Forge: 1 Beast token, 3 tapped Wastes, library 5.

Correct: two d4 results a, b (1–4); seat 0 picks r for Beasts and o for lands. Create r 3/3 green Beast tokens (**at least one**, mandatory). Search for o basic land cards, put them onto the battlefield tapped, shuffle. The search is for cards with a stated quality, so the searcher may find fewer (701.23b), but the search and shuffle happen. Rules as above (706.1a, 706.4, 608.2c).

Variations: doubles (2 and 2 → two Beasts, two lands); a library with fewer basics than o (find what's there); a library with no basics (still search and shuffle, no lands).

Acceptance: Wild Endeavor logs two d4 rolls, always creates 1–4 Beast tokens, and searches for up to the other result's number of basic lands, putting those found onto the battlefield tapped.
