# Referee specs: index

Clean-room specs for phase rules bugs found by the referee card sweep (`referee/sweep.py`), triaged against the Comprehensive Rules. Verdicts: `/tmp/yama-referee/triage/verdicts-{1..5}.json`.

## Verdict totals

All five verdict files, 367 cases:

| Class | Cases |
|---|---|
| phase-bug | 155 |
| choice | 146 |
| harness | 36 |
| forge-bug | 19 |
| unclear | 6 |
| random | 5 |

### forge-bug cases (19)

Forge is wrong and phase is right in these; nothing to fix in phase.

- **Spirit of Resilience** (`card-spirit-of-resilience`, high): The Oracle type line is Creature - Spirit Warrior; phase has Spirit Warrior, Forge only Spirit (Forge's card data).
- **Omo, Queen of Vesuva** (`card-omo-queen-of-vesuva`, high): The Island with an everything counter: Forge adds 'Omenpath', which isn't a land type in the CR (205.3i, 25 Sept 2026); phase's list matches the CR.
- **Mirror Match** (`card-mirror-match`, high): Mirror Match can only be cast during the declare blockers step; phase rightly refused it in main phase 1, Forge cast it anyway (also a sweep artefact: no combat in the harness).
- **Requisition Raid** (`card-requisition-raid`, high): Spree needs at least one mode and its {1}, which the single Plains can't pay, so the card can't be cast here; Forge cast it with no mode for {W}. phase didn't cast it, but its runner reported no error and an empty log for a step that never ran.
- **Disaster Radius** (`card-disaster-radius`, high): The additional cost (reveal a creature card from hand) can't be paid with only a Wastes in hand, so phase rightly refused the cast; Forge cast it without revealing (dealt 0).
- **Truth or Consequences** (`card-truth-or-consequences`, medium): Votes differ (phase: two truth, draw two), but Forge's tally is impossible: one draw plus two lots of 3 damage is three votes from two players.
- **Transforming Flourish** (`card-transforming-flourish`, high): Copy targets differ (choice), and Forge then cast each destroyed permanent from the graveyard although only Wastes were exiled; with no nonland card exiled nothing may be cast, as phase did.
- **Surtland Elementalist** (`card-surtland-elementalist`, high): Seat 0 has only the mana for {5}{U}{U} and no other Giant in hand (the Elementalist is on the stack while costs are paid), so the additional cost can't be paid; phase rightly refused, Forge cast it anyway.
- **Thunderherd Migration** (`card-thunderherd-migration`, high): Seat 0 has only the mana for {1}{G} and no Dinosaur in hand, so the additional cost can't be paid; phase rightly refused, Forge cast it anyway.
- **Serra Avenger** (`card-serra-avenger`, medium): The game is on turn 2, so seat 0 is within its first three turns and can't cast it; phase refused, Forge cast it (possibly Forge's runner doesn't count the generated turn history; the sweep's early turn makes such cards untestable as is).
- **Rakdos, Lord of Riots** (`card-rakdos-lord-of-riots`, high): Rakdos can't be cast unless an opponent lost life this turn (nobody has); phase correctly refused, Forge cast it anyway.
- **Bitter Triumph** (`card-bitter-triumph`, high): The additional cost (discard a card or pay 3 life) is mandatory; phase paid 3 life, Forge paid neither (hand, graveyard and life unchanged).
- **Cathartic Reunion** (`card-cathartic-reunion`, high): Discarding two cards is a mandatory additional cost and seat 0 has only one other card, so it can't be cast; phase refused correctly, Forge discarded one and cast it.
- **Dusk Mangler** (`card-dusk-mangler`, high): The additional cost (sacrifice a creature, discard or pay 4 life) is mandatory; phase paid 4 life, Forge paid nothing.
- **Cloud's Limit Break** (`card-cloud-s-limit-break`, high): Tiered: a mode must be chosen and paid; Cross-Slash needs a tapped creature (none) and the other tiers cost more than the 2 lands, so it isn't castable. Phase didn't cast it; Forge cast it for just {1}{W}.
- **Mandate of Peace** (`card-mandate-of-peace`, high): 'Cast this spell only during combat': it's main phase, so phase correctly refused; Forge cast it.
- **Great Train Heist** (`card-great-train-heist`, medium): With only a Mountain no spree mode is affordable, so the spell can't be cast; phase didn't cast it, Forge cast it with no modes (empty resolution).
- **Genestealer Patriarch** (`card-genestealer-patriarch`, high): Genestealer Patriarch is 4/4 per Oracle; Forge shows it as 4/3 (card data), phase is right.
- **Wedding Ring** (`card-wedding-ring`, medium): Wedding Ring was cast, so its enters trigger gives seat 1 a token copy; phase did, Forge never triggered.

## How to read the table

- **Cards**: the swept cards whose `phase-bug` verdict points at the spec (each card once). Specs also name other cards as variations; those aren't counted.
- **Deck weight**: for each card, the number of lines `1 <card name>` across the 198 corpus decks (`~/Developer/commander-decks/data/sim/decks/precons/*.txt` and `bryan/*.txt`; each card appears at most once per deck), summed over the spec's cards. **Decks** is the number of distinct decks playing at least one of them.
- **Size**: my estimate of the fix, S (one rule or one clause), M (a mechanic or a few interacting pieces), L (several shapes, may need more than one fix).
- **Kind**, judged from behaviour only: *parser* when the effect looks like Oracle text read wrongly or not at all (a clause dropped, a condition bound to the wrong sentence, nothing happens); *engine* when the effect is recognised but misbehaves at runtime; *both* when the spec shows both.
- **Score** = deck weight × cards / size (S = 1, M = 2, L = 3). Rows are ordered by score, best first.
- **Confidence**: no spec has a `low`-confidence case (the 5 `low` verdicts are all `unclear`/`choice` rows with no spec). Cases with `medium` confidence are listed in the last column; every other case is `high`.

## Specs (70)

| # | Spec | Root cause | Cards | Deck weight | Decks | Size | Kind | Score | Medium confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | [`creature-type-setting-keeps-old-types.md`](creature-type-setting-keeps-old-types.md) | Setting or removing creature types ("becomes a Frog", "loses all other creature types") keeps the old types | Darksteel Mutation, Kenrith's Transformation, Lignify, Hunted by The Family, Curse of Conformity, Polymorphist's Jest, Snakeform, Eye of Nidhogg, Turn to Frog (9) | 18 | 17 | S | engine | 162 | - |
| 2 | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) | "It" / "that creature" / "that player" / the card's own name resolve to the source, the moved card or the controller | Call the Coppercoats, Creative Technique, Beacon of Unrest, Blink, Dalek Drone, The Mouth of Sauron, Nazahn, Revered Bladesmith, Charnel Serenade, Reunion of the House, Fear of Sleep Paralysis, Curious Herd, Decoy Gambit, Biomantic Mastery, Tempt with Reflections, Revival Experiment, Obscura Confluence (16) | 22 | 20 | L | both | 117.3 | - |
| 3 | [`choices-on-resolution-not-acted-on.md`](choices-on-resolution-not-acted-on.md) | Choices made on resolution (objects, one per opponent, or options like war/peace) are never acted on; some are wrongly targeted | Dredge the Mire, Stick Together, Celestial Judgment, Foreboding Steamboat, Armed and Armored, Colonel Autumn, The Nipton Lottery, Sadistic Shell Game, Chaos Defiler, Eye of Doom, Summon: Valefor, Desecrator Hag, Archangel of Strife, Benthic Anomaly, Selective Obliteration, Prisoner's Dilemma, Highcliff Felidar (17) | 19 | 17 | L | both | 107.7 | Colonel Autumn |
| 4 | [`amounts-from-objects-affected-this-way.md`](amounts-from-objects-affected-this-way.md) | Counts and amounts from objects the ability just sacrificed/goaded/exiled ("this way", linked exile) come out 0 | Duplicant, Syphon Flesh, Reign of the Pit, Voracious Fell Beast, Unexplained Absence, Phyrexian Ingester, Shadowgrange Archfiend, Havoc Eater (8) | 19 | 19 | M | engine | 76 | - |
| 5 | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) | After reveal/look/exile N, the chosen cards and "the rest" aren't moved, or move to the wrong zone | Abstract Performance, Aminatou's Augury, Aethermage's Touch, Selective Adaptation, Herald of Amity, Steam Augury, Murmurs from Beyond (7) | 11 | 10 | L | engine | 25.7 | - |
| 6 | [`dice-roll-spells-do-nothing.md`](dice-roll-spells-do-nothing.md) | "Roll two dice and choose one result" and "roll a d20 and add N" spells resolve with no roll and no effect | Danse Macabre, Reckless Endeavor, Song of Inspiration, Valiant Endeavor, Arcane Endeavor, Grave Endeavor, Wild Endeavor (7) | 7 | 4 | M | parser | 24.5 | - |
| 7 | [`votes-produce-no-result.md`](votes-produce-no-result.md) | Secret council / council's dilemma / some will-of-the-council votes: no votes and no results | Fateful Tempest, Selvala's Stampede, Custodi Squire, Mob Verdict, Círdan the Shipwright, Trap the Trespassers, Travel Through Caradhras (7) | 9 | 7 | L | both | 21 | Selvala's Stampede |
| 8 | [`gain-control-of-chosen-or-all-creatures.md`](gain-control-of-chosen-or-all-creatures.md) | Control changes of a set of creatures (all, chosen, swapped) don't happen; single-target ones do | Reins of Power, Order of Succession, Elrond of the White Council, Insurrection (4) | 7 | 6 | M | engine | 14 | - |
| 9 | [`opponent-comparison-conditions.md`](opponent-comparison-conditions.md) | "If an opponent / that player has more ... than you" never comes out true | Sandstone Oracle, Sunset Revelry (2) | 6 | 6 | S | engine | 12 | - |
| 10 | [`trigger-targets-in-graveyard.md`](trigger-targets-in-graveyard.md) | Triggers that target a card in a graveyard skip target selection | Goblin Dark-Dwellers, Necromancy, Mysterious Stranger, Spellpyre Phoenix (4) | 6 | 6 | M | engine | 12 | Goblin Dark-Dwellers |
| 11 | [`addendum-main-phase.md`](addendum-main-phase.md) | Addendum's "if you cast this spell during your main phase" comes out false when it was | Unbreakable Formation (1) | 9 | 9 | S | engine | 9 | - |
| 12 | [`choose-a-card-name.md`](choose-a-card-name.md) | "Choose a card name" has no AI answer, so the card never finishes casting/resolving | Day of the Moon, Phyrexian Revoker, Predict (3) | 3 | 3 | S | engine | 9 | Day of the Moon |
| 13 | [`attach-to-object-made-by-same-effect.md`](attach-to-object-made-by-same-effect.md) | "Create/manifest ... and attach this to it" / "put counters on that creature": the just-made permanent is never acted on | Experimental Lab, Field-Tested Frying Pan, Cloudform, Lightform (4) | 4 | 3 | M | engine | 8 | - |
| 14 | [`destroyed-this-way-return.md`](destroyed-this-way-return.md) | "Return a creature card put into a graveyard this way" picks a card that was already there | Necromantic Selection (1) | 6 | 6 | S | engine | 6 | - |
| 15 | [`creature-damages-itself.md`](creature-damages-itself.md) | Damage whose source is a creature named by the effect (each creature to itself, the chosen creature to others) isn't dealt | Wave of Reckoning, Showstopping Surprise (2) | 5 | 5 | M | engine | 5 | - |
| 16 | [`prepared-copy-in-exile.md`](prepared-copy-in-exile.md) | Becoming / entering prepared makes no copy of the prepare spell in exile | Inspired Skypainter, Sanar, Unfinished Genius (2) | 5 | 4 | M | engine | 5 | Inspired Skypainter, Sanar, Unfinished Genius |
| 17 | [`cost-reduction-per-counter-with-no-counters.md`](cost-reduction-per-counter-with-no-counters.md) | "Costs {1} less for each [counter / energy paid this turn]" takes the full generic reduction when the count is 0 | Blaster Hulk, Lumbering Megasloth (2) | 2 | 2 | S | parser | 4 | - |
| 18 | [`enters-with-counters-for-each.md`](enters-with-counters-for-each.md) | "Enters with a +1/+1 counter for each ..." counts the wrong objects | Ascendant Acolyte, Ulasht, the Hate Seed (2) | 2 | 1 | S | parser | 4 | - |
| 19 | [`every-nonbasic-land-type.md`](every-nonbasic-land-type.md) | "This land is every nonbasic land type" gives no land types | Planar Nexus (1) | 4 | 4 | S | parser | 4 | - |
| 20 | [`gift-targets-only-if-promised.md`](gift-targets-only-if-promised.md) | Gift-only targets are chosen even when the gift isn't promised | Consumed by Greed, Sazacap's Brew (2) | 2 | 2 | S | engine | 4 | Consumed by Greed, Sazacap's Brew |
| 21 | [`hate-mirage-token-copies.md`](hate-mirage-token-copies.md) | "For each target creature, create a token copy" creates no tokens | Hate Mirage (1) | 4 | 4 | S | parser | 4 | - |
| 22 | [`reanimated-cards-lose-stated-modifications.md`](reanimated-cards-lose-stated-modifications.md) | Riders on cards a spell puts onto the battlefield ("they're black Zombies", "an additional -1/-1 counter") are dropped | Ghouls' Night Out, Aberrant Return (2) | 2 | 2 | S | parser | 4 | - |
| 23 | [`vanishing-n-enters-with-time-counters.md`](vanishing-n-enters-with-time-counters.md) | Vanishing from a copy exception or token creation gives no time counters | Flesh Duplicate, The Girl in the Fireplace (2) | 2 | 1 | S | engine | 4 | - |
| 24 | [`monarch-controls-enchanted.md`](monarch-controls-enchanted.md) | "The monarch controls enchanted creature" never changes control | Fealty to the Realm (1) | 3 | 3 | S | engine | 3 | - |
| 25 | [`sages-reverie-draw.md`](sages-reverie-draw.md) | Sage's Reverie's enters trigger (draw per Aura you control on a creature) never happens | Sage's Reverie (1) | 3 | 3 | S | parser | 3 | - |
| 26 | [`as-enters-actions-skipped.md`](as-enters-actions-skipped.md) | "As this enters, [turn face down / exile ...]" actions are skipped, so the CDA counts 0 and the creature dies | Ixidron, Living Lore (2) | 3 | 3 | M | engine | 3 | - |
| 27 | [`ezuris-predation-fight.md`](ezuris-predation-fight.md) | Each new Beast never fights its paired creature | Ezuri's Predation (1) | 5 | 5 | M | engine | 2.5 | - |
| 28 | [`embalm-exception-only-when-embalmed.md`](embalm-exception-only-when-embalmed.md) | Copy exception "if this creature was embalmed" applied to a cast Vizier (adds Zombie) | Vizier of Many Faces (1) | 2 | 2 | S | parser | 2 | - |
| 29 | [`fame-or-fortune-draw.md`](fame-or-fortune-draw.md) | Fortune's "you draw" goes to the opponent who chose it | Seize the Spotlight (1) | 2 | 2 | S | parser | 2 | - |
| 30 | [`if-otherwise-chain.md`](if-otherwise-chain.md) | "If ... If ... Otherwise" runs Otherwise although an earlier If matched | Misfortune Teller (1) | 2 | 2 | S | parser | 2 | - |
| 31 | [`optional-discard-cost-must-be-paid-fully.md`](optional-discard-cost-must-be-paid-fully.md) | "You may discard two cards. If you do" counts a one-card discard as done | Thrilling Discovery (1) | 2 | 2 | S | engine | 2 | - |
| 32 | [`zombies-and-or-tokens-filter.md`](zombies-and-or-tokens-filter.md) | "Zombies and/or tokens" filter also matches nontoken non-Zombies | On Wings of Gold (1) | 2 | 2 | S | parser | 2 | - |
| 33 | [`shared-creature-type-counts.md`](shared-creature-type-counts.md) | Counts of creatures sharing a creature type come out too low (Coat of Arms, Skemfar) | Coat of Arms, Skemfar Shadowsage (2) | 2 | 2 | M | engine | 2 | - |
| 34 | [`villainous-choice-outcomes.md`](villainous-choice-outcomes.md) | Villainous choice: the option hits the caster's library too, or no option happens | Ensnared by the Mara, This Is How It Ends (2) | 2 | 1 | M | engine | 2 | - |
| 35 | [`alternative-cost-condition-gates-only-its-sentence.md`](alternative-cost-condition-gates-only-its-sentence.md) | "If the alternative cost was paid" gates the whole spell instead of only its own sentence, so nothing happens | Baleful Mastery (1) | 1 | 1 | S | parser | 1 | - |
| 36 | [`before-combat-casting-restriction.md`](before-combat-casting-restriction.md) | "Cast only before combat or during combat before blockers" read as "during combat" only | Berserker's Frenzy (1) | 1 | 1 | S | parser | 1 | - |
| 37 | [`bestow-card-cast-as-creature.md`](bestow-card-cast-as-creature.md) | A bestow card cast for its mana cost is treated as an Aura needing a target | Noble Quarry (1) | 1 | 1 | S | engine | 1 | - |
| 38 | [`creature-types-among-creatures-cost-reduction.md`](creature-types-among-creatures-cost-reduction.md) | "{1} less for each creature type among creatures you control" over-counts (3 instead of 1) | Valiant Changeling (1) | 1 | 1 | S | engine | 1 | - |
| 39 | [`damage-to-each-player-and-their-creatures.md`](damage-to-each-player-and-their-creatures.md) | "Deals X damage to each player and each creature they control" skips the creatures | Incite Rebellion (1) | 1 | 1 | S | parser | 1 | - |
| 40 | [`delayed-trigger-fires-on-resolution.md`](delayed-trigger-fires-on-resolution.md) | Delayed trigger "when that creature dies this turn ... draw" runs immediately on resolution | Heroic Sacrifice (1) | 1 | 1 | S | parser | 1 | - |
| 41 | [`draw-then-amass-x.md`](draw-then-amass-x.md) | Commence the Endgame resolves with no effect (draw two, then amass X = hand size) | Commence the Endgame (1) | 1 | 1 | S | parser | 1 | - |
| 42 | [`energy-paid-power-match.md`](energy-paid-power-match.md) | Indestructible grant ignores "power equal to the energy paid" and protects the caster's creature | Localized Destruction (1) | 1 | 1 | S | parser | 1 | - |
| 43 | [`enters-with-counter-self-trigger-copies-counters.md`](enters-with-counter-self-trigger-copies-counters.md) | Denry Klin's own entry doesn't double its counter (self-trigger on entering) | Denry Klin, Editor in Chief (1) | 1 | 1 | S | engine | 1 | Denry Klin, Editor in Chief |
| 44 | [`equipped-creature-condition-when-unattached.md`](equipped-creature-condition-when-unattached.md) | "As long as equipped creature is untapped" applies with no equipped creature | Sword of the Paruns (1) | 1 | 1 | S | engine | 1 | - |
| 45 | [`etb-you-draw-and-target-opponent-may-draw.md`](etb-you-draw-and-target-opponent-may-draw.md) | Tataru Taru's enters trigger (you draw, target opponent may draw) never goes on the stack | Tataru Taru (1) | 1 | 1 | S | parser | 1 | - |
| 46 | [`excess-damage-amount.md`](excess-damage-amount.md) | Excess damage counts all damage dealt, not only damage beyond lethal | Bottle-Cap Blast (1) | 1 | 1 | S | engine | 1 | - |
| 47 | [`exile-hand-then-draw-that-many.md`](exile-hand-then-draw-that-many.md) | Hex Magic resolves with no effect (exile hand, draw that many, play them) | Hex Magic (1) | 1 | 1 | S | parser | 1 | - |
| 48 | [`exile-until-land-put-onto-battlefield.md`](exile-until-land-put-onto-battlefield.md) | Exile-until-a-land puts the found land back into the library instead of onto the battlefield | Venture Forth (1) | 1 | 1 | S | engine | 1 | - |
| 49 | [`face-down-enters-trigger-each-creature.md`](face-down-enters-trigger-each-creature.md) | "Whenever a face-down creature you control enters" triggers once for two simultaneous entries | They Came from the Pipes (1) | 1 | 1 | S | engine | 1 | - |
| 50 | [`foretell-exile-face-down.md`](foretell-exile-face-down.md) | "Exile a card from your hand face down; it becomes foretold" exiles it face up | Ethereal Valkyrie (1) | 1 | 1 | S | engine | 1 | - |
| 51 | [`lands-you-control-gain-subtype.md`](lands-you-control-gain-subtype.md) | "Lands you control ... are Deserts in addition" doesn't apply | Dune Chanter (1) | 1 | 1 | S | parser | 1 | - |
| 52 | [`life-total-becomes.md`](life-total-becomes.md) | "Your life total becomes N" does nothing | Invincible Hymn (1) | 1 | 1 | S | parser | 1 | - |
| 53 | [`other-enchantments-excludes-self.md`](other-enchantments-excludes-self.md) | "Each other enchantment" counts the source itself | Ancestral Mask (1) | 1 | 1 | S | parser | 1 | - |
| 54 | [`returned-this-way-you-control.md`](returned-this-way-you-control.md) | "Four or more nontoken permanents you control returned this way" counts other players' permanents | Flood of Tears (1) | 1 | 1 | S | engine | 1 | - |
| 55 | [`target-count-from-game-state.md`](target-count-from-game-state.md) | A spell whose target count is a game-state X refuses to cast when X = 0 | Impact Resonance (1) | 1 | 1 | S | engine | 1 | - |
| 56 | [`target-opponent-does-the-same.md`](target-opponent-does-the-same.md) | "Then target opponent does the same": no target and no opponent half | The Wedding of River Song (1) | 1 | 1 | S | parser | 1 | The Wedding of River Song |
| 57 | [`unless-pay-life-still-mills.md`](unless-pay-life-still-mills.md) | "Unless you pay 2 life": the life is paid but the card is still milled | Moonlight Bargain (1) | 1 | 1 | S | engine | 1 | - |
| 58 | [`when-you-do-after-copy-choice.md`](when-you-do-after-copy-choice.md) | "When you do, tap the copied creature" doesn't tap it | Wall of Stolen Identity (1) | 1 | 1 | S | engine | 1 | - |
| 59 | [`aura-etb-become-copy-of-enchanted.md`](aura-etb-become-copy-of-enchanted.md) | Infinite Reflection's "becomes a copy of enchanted creature" puts the creature into the graveyard instead | Infinite Reflection (1) | 1 | 1 | M | engine | 0.5 | - |
| 60 | [`coin-flip-win-lose-outcomes.md`](coin-flip-win-lose-outcomes.md) | A lost flip applies both the win and lose outcomes, and the damage hits the flipper, not "that player" | Mutalith Vortex Beast (1) | 1 | 1 | M | parser | 0.5 | - |
| 61 | [`collision-of-realms.md`](collision-of-realms.md) | Reveal-until step skipped and the spell shuffles itself into its owner's library | Collision of Realms (1) | 1 | 1 | M | parser | 0.5 | - |
| 62 | [`convoked-creature-type-exemption.md`](convoked-creature-type-exemption.md) | Exemption for creatures sharing a type with a creature that convoked the spell is ignored | Everything Comes to Dust (1) | 1 | 1 | M | engine | 0.5 | - |
| 63 | [`damaged-this-way-exile-instead.md`](damaged-this-way-exile-instead.md) | "If a creature dealt damage this way would die this turn, exile it instead" isn't applied | Gallifrey Falls (1) | 1 | 1 | M | engine | 0.5 | - |
| 64 | [`drawn-this-way-reflexive-trigger.md`](drawn-this-way-reflexive-trigger.md) | Reflexive "whenever a card is drawn this way" never triggers | Explosion of Riches (1) | 1 | 1 | M | engine | 0.5 | - |
| 65 | [`empower-jace.md`](empower-jace.md) | Empower Jace N does nothing (no Jace token, no loyalty) | Jace's Machinations (1) | 1 | 1 | M | parser | 0.5 | - |
| 66 | [`friend-or-foe-is-a-choice.md`](friend-or-foe-is-a-choice.md) | Friend-or-foe run as a vote, and the friend/foe actions never happen | Zndrsplt's Judgment (1) | 1 | 1 | M | both | 0.5 | - |
| 67 | [`lose-life-and-draw-then-clash.md`](lose-life-and-draw-then-clash.md) | "Lose 2 life and draw two, then clash; if you win, repeat" stops after the life loss | Hoarder's Greed (1) | 1 | 1 | M | parser | 0.5 | - |
| 68 | [`phase-out-all-creatures-until-leaves.md`](phase-out-all-creatures-until-leaves.md) | Out of Time's trigger does nothing (no phasing, no time counters) | Out of Time (1) | 1 | 1 | M | parser | 0.5 | - |
| 69 | [`target-for-each-player.md`](target-for-each-player.md) | "For each player, target X that player controls" reuses one target for every player | Turf War (1) | 1 | 1 | M | engine | 0.5 | Turf War |
| 70 | [`blood-moon-urborg.md`](blood-moon-urborg.md) | Layer-4 dependency (613.8): Urborg's effect should wait for Blood Moon's. Already fixed | Blood Moon, Urborg, Tomb of Yawgmoth (hand-written scenario) (0) | 0 | 0 | - | engine | fixed | - |

## Merged specs

Five triagers wrote specs in parallel, so some root causes were split across files. The verdict files still name the old files; they map as follows.

| Old spec (named in verdicts) | Now in |
|---|---|
| `amount-from-affected-objects.md` | [`amounts-from-objects-affected-this-way.md`](amounts-from-objects-affected-this-way.md) |
| `duplicant-imprinted-creature.md` | [`amounts-from-objects-affected-this-way.md`](amounts-from-objects-affected-this-way.md) |
| `sacrificed-this-way.md` | [`amounts-from-objects-affected-this-way.md`](amounts-from-objects-affected-this-way.md) |
| `count-target-opponents-creatures.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `put-counter-on-it-means-the-target.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `self-name-exile-hits-returned-card.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `shuffle-self-into-library.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `target-player-reference-wrong-player.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `that-creature-refers-to-spell-itself.md` | [`back-references-resolve-to-wrong-object.md`](back-references-resolve-to-wrong-object.md) |
| `each-player-chooses-produces-no-result.md` | [`choices-on-resolution-not-acted-on.md`](choices-on-resolution-not-acted-on.md) |
| `for-each-opponent-choose-a-creature.md` | [`choices-on-resolution-not-acted-on.md`](choices-on-resolution-not-acted-on.md) |
| `objects-chosen-on-resolution-not-acted-on.md` | [`choices-on-resolution-not-acted-on.md`](choices-on-resolution-not-acted-on.md) |
| `becomes-creature-type-replaces-types.md` | [`creature-type-setting-keeps-old-types.md`](creature-type-setting-keeps-old-types.md) |
| `lose-other-creature-types.md` | [`creature-type-setting-keeps-old-types.md`](creature-type-setting-keeps-old-types.md) |
| `reins-of-power-control-swap.md` | [`gain-control-of-chosen-or-all-creatures.md`](gain-control-of-chosen-or-all-creatures.md) |
| `hand-size-difference-draw.md` | [`opponent-comparison-conditions.md`](opponent-comparison-conditions.md) |
| `added-types-on-reanimated-cards.md` | [`reanimated-cards-lose-stated-modifications.md`](reanimated-cards-lose-stated-modifications.md) |
| `reanimate-enters-with-additional-counter.md` | [`reanimated-cards-lose-stated-modifications.md`](reanimated-cards-lose-stated-modifications.md) |
| `abstract-performance-piles.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
| `exile-top-then-rest-on-bottom.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
| `put-a-land-card-means-one.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
| `reveal-choose-by-keyword.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
| `reveal-rest-to-bottom.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
| `revealed-cards-opponent-chooses.md` | [`revealed-cards-chosen-and-rest-misrouted.md`](revealed-cards-chosen-and-rest-misrouted.md) |
