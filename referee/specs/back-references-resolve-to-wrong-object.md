# Spec: back-references ("it", "that creature", "that player", the card's own name) resolve to the wrong object or player

Root cause (observed behaviour): a word in a later instruction that points back at something ("it", "that creature", "that card", "its owner", "that player", "their graveyard", "those opponents", or the card's own name) is resolved to the wrong object or player. Three shapes were seen:

1. A pronoun whose antecedent is a target, or that has no antecedent at all (no target chosen, a search or reveal that found nothing), is applied to the **source** (the spell, Saga, creature or enchantment) instead: Parts A and B.
2. The card's **own name** ("Exile Charnel Serenade", "Shuffle Beacon of Unrest into its owner's library") is applied to the card the spell just moved instead of the spell; or, with nothing moved, to nothing, and the spell goes to the graveyard: Parts C and D.
3. "That player" / "target player" / "those opponents" is read as the spell's controller, or counts nothing: Parts E and F.

Merged from six specs written in parallel: `that-creature-refers-to-spell-itself.md` (Part A), `put-counter-on-it-means-the-target.md` (Part B), `self-name-exile-hits-returned-card.md` (Part C), `shuffle-self-into-library.md` (Part D), `target-player-reference-wrong-player.md` (Part E), `count-target-opponents-creatures.md` (Part F). They may turn out to need more than one fix, but each is a reference in a later instruction resolving to the wrong thing, so test them together.

Cards: Decoy Gambit, Tempt with Reflections, Creative Technique, Blink, Nazahn, Revered Bladesmith (Part A); Fear of Sleep Paralysis (Part B); Charnel Serenade, Reunion of the House, Revival Experiment (Part C); Beacon of Unrest (Part D); Curious Herd, Biomantic Mastery, Obscura Confluence, Dalek Drone, The Mouth of Sauron (Part E); Call the Coppercoats (Part F).

Related: `attach-to-object-made-by-same-effect.md` ("it" / "that creature" meaning the permanent the same effect just made), `when-you-do-after-copy-choice.md` ("the copied creature"), `fame-or-fortune-draw.md` (a "you draw" went to the opponent who chose), `opponent-comparison-conditions.md` (Sandstone Oracle's "that player"), `collision-of-realms.md` (the spell itself shuffled into a library).

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: "that creature" resolving to the spell itself

(Formerly `that-creature-refers-to-spell-itself.md`.)

Root cause (observed behaviour): when a later instruction in a spell refers back to a targeted creature with "that creature", phase sometimes applies the instruction to the spell itself instead. Decoy Gambit (with no target chosen) returned *Decoy Gambit* to its owner's hand. Tempt with Reflections created a token copy of *Tempt with Reflections* (a sorcery token on the battlefield) instead of a copy of the targeted creature.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-decoy-gambit`, `card-tempt-with-reflections`.

### 1. Cards

Oracle text and rulings from Scryfall.

- **Decoy Gambit** ({2}{U} instant): "For each opponent, choose up to one target creature that player controls, then return that creature to its owner's hand unless its controller has you draw a card."
  - 2020-04-17: "As the Decoy Gambit resolves, first the next opponent in turn order ... chooses whether you'll draw a card or return their creature that was targeted to its owner's hand ... After all choices are made, you draw the appropriate number of cards. After you've drawn, the appropriate creatures are all simultaneously returned to their owners' hands."
  - 2020-04-17: "For each opponent, if you didn't choose a target creature they control or if that creature has become an illegal target, that player can't choose for you to draw a card."
- **Tempt with Reflections** ({3}{U} sorcery): "Tempting offer — Choose target creature you control. Create a token that's a copy of that creature. Each opponent may create a token that's a copy of that creature. For each opponent who does, create a token that's a copy of that creature."
  - 2013-10-17: "After each opponent has decided, the effect happens simultaneously for each one who accepted the offer. Then, the effect happens again for you a number of times equal to the number of opponents who accepted."

### 2. Board and actions

Seat 0 (active, main phase 1): lands for the card, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire.

- `card-decoy-gambit`: seat 0 casts Decoy Gambit choosing **no** target (the runner gave none; "up to one" allows zero). Forge got the same: "targeting []".
- `card-tempt-with-reflections`: seat 0 casts Tempt with Reflections targeting its own Grizzly Bears.

### 3. Correct result

- **Decoy Gambit, no target:** the spell resolves and does nothing (no creature to return, and seat 1 can't make seat 0 draw). **Decoy Gambit goes to seat 0's graveyard.** Seat 0's hand is just the Wastes.
- **Tempt with Reflections:** seat 0 creates one Grizzly Bears token. Seat 1 may create a Grizzly Bears token (under seat 1's control). If seat 1 does, seat 0 creates one more Grizzly Bears token. The spell goes to the graveyard. No token copy of Tempt with Reflections exists.
  - If seat 1 accepts: seat 0 has its original Bears + **2** Bears tokens; seat 1 has 1 Bears token (Forge's result).
  - If seat 1 declines: seat 0 has its original Bears + **1** Bears token; seat 1 has none.

### 4. Why

1. "That creature" in each later sentence refers to the creature chosen as the target (608.2c: read the whole text and apply normal English). It never refers to the spell, which isn't a creature.
2. Decoy Gambit: with zero targets chosen there is no "that creature" for seat 1; per the ruling, seat 1 can't choose the draw, and nothing is returned. A spell that has no targets at all resolves normally (608.2b only removes a spell whose targets have *all* become illegal; a spell that chose zero targets for "up to one" doesn't fizzle). As the last step of resolution an instant goes to its owner's graveyard (608.2n).
3. Tempt with Reflections: every "create a token that's a copy of that creature" copies the targeted Grizzly Bears (707.2: the token gets the copiable values of that creature). A sorcery can't be a permanent at all: sorceries can't enter the battlefield (307.4, 110.4), so a token copy of a sorcery could never be on the battlefield even if something tried to make one.

### 5. What phase did

- Decoy Gambit: "Decoy Gambit moves from stack to hand", then "effect resolves". Final: Decoy Gambit in seat 0's hand, not in the graveyard. Forge: graveyard.
- Tempt with Reflections: created a Bears token for seat 0, a Bears token for seat 1 (seat 1 accepted), then created a token "Tempt with Reflections" (types [Sorcery]) on seat 0's battlefield instead of a second Bears token. Forge: two Bears tokens for seat 0.

### 6. Variations to test

- **Decoy Gambit with a target:** target seat 1's Grizzly Bears. Seat 1 chooses: either seat 0 draws a card, or Grizzly Bears returns to seat 1's hand. In both cases Decoy Gambit ends in the graveyard.
- **Decoy Gambit, target became illegal** (Bears left the battlefield before resolution): the spell's only target is illegal, so it doesn't resolve (608.2b) and goes to the graveyard; nothing returns, no draw.
- **Decoy Gambit, two opponents, one targeted:** only the targeted opponent's creature can be returned or replaced by a draw; the other opponent has no choice.
- **Tempt with Reflections, target illegal on resolution:** no tokens at all (ruling).
- **Tempt with Reflections with an ETB creature** (e.g. target Knight of Autumn): each token's enters ability triggers; seat 1's token's trigger is controlled by seat 1.
- **Tempt with Reflections, two opponents both accept:** each opponent gets 1 token; seat 0 gets 1 + 2 = 3 tokens.
- **Similar wording to check:** any spell that says "target creature ... then [do X to] that creature" or "copy of that creature" after other instructions.

### 7. Acceptance checks

- Decoy Gambit cast with no targets ends in its owner's graveyard and changes nothing else.
- Tempt with Reflections never creates a token copy of itself; every token it creates is a copy of the targeted creature.
- With seat 1 accepting, seat 0 ends with two new Grizzly Bears tokens and seat 1 with one.

### Added from triage batch 1: Creative Technique ("exile that card" when no card was found)

Scenario: `card-creative-technique`. Likely the same root cause: a back-reference with no referent ends up pointing at the spell. Observed: both engines make both demonstrate copies (seat 0's and seat 1's) and resolve all three. Forge ends with Creative Technique in seat 0's graveyard and nothing exiled. Phase ends with the Creative Technique card in seat 0's exile (its log shows "Creative Technique moves from stack to exile" for the original as well as the copies).

- **Creative Technique** ({4}{R} sorcery): "Demonstrate (When you cast this spell, you may copy it. If you do, choose an opponent to also copy it.) Shuffle your library, then reveal cards from the top of it until you reveal a nonland card. Exile that card and put the rest on the bottom of your library in a random order. You may cast the exiled card without paying its mana cost."
  - Ruling 2021-04-16: if both you and an opponent copy it, the opponent's copy resolves first, then yours, then the original.

Board: the sweep board; both libraries are 8 Wastes, so no nonland card can be found.

Correct result: each of the three resolutions shuffles the controller's library and reveals every card (701.20a) without finding a nonland card (609.3: do as much as possible). "Exile that card" has no card to exile, so nothing is exiled; the revealed cards go to the bottom in a random order; nothing is cast. The copies cease to exist (707.10a, 704.5e). The original goes to seat 0's graveyard (608.2n). Final: seat 0's graveyard Creative Technique, Divination, Hill Giant; both exiles empty; libraries 8.

What phase did: exiled the original Creative Technique card instead of putting it into the graveyard.

Variations: a library with a single nonland card at the bottom (all others revealed and bottomed, that card exiled and castable for free, spell to graveyard); empty library (nothing revealed, spell to graveyard); a lone copy with no hit (nothing exiled).

Acceptance: when the reveal finds no nonland card, nothing is exiled and the original Creative Technique ends in its owner's graveyard.

---

### Added from triage batch 2: Blink, Nazahn, Revered Bladesmith

Two more cards where a later clause's "it" / "that card" was applied to the source object itself. In Nazahn's case, as with Decoy Gambit, the referred-to object doesn't exist (the search found nothing), and phase used the source instead.

Scenarios: `card-blink` (trigger target: seat 1's Grizzly Bears), `card-nazahn-revered-bladesmith`. Standard sweep board (`referee/sweep.py`): seat 0 active in main phase 1 with exactly the lands for the card plus Grizzly Bears, hand = the card + Wastes, graveyard Hill Giant + Divination, library 8 Wastes; seat 1 with Grizzly Bears, Serra Angel, Millstone, Seal of Fire, 2 Wastes in hand, Hill Giant in graveyard, library 8 Wastes.

#### Cards

- **Blink** {2}{U}{B}, Enchantment — Saga. "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after IV.) / I, III — Choose target creature. Its owner shuffles it into their library, then investigates. (They create a Clue token.) / II, IV — Create a 2/2 black Alien Angel artifact creature token with first strike, vigilance, and 'Whenever an opponent casts a creature spell, this token isn't a creature until end of turn.'" Lands: Island, Swamp, Wastes, Wastes.
- **Nazahn, Revered Bladesmith** {4}{G}{W}, Legendary Creature — Cat Artificer, 5/4. "When Nazahn enters, search your library for an Equipment card and reveal it. If you reveal a card named Hammer of Nazahn this way, put it onto the battlefield. Otherwise, put that card into your hand. Then shuffle. / Whenever an equipped creature you control attacks, you may tap target creature defending player controls." Lands: Forest, Plains + 4 Wastes. Seat 0's library is all Wastes, so it has no Equipment.

#### Correct result

- **Blink**: chapter I resolves targeting seat 1's Grizzly Bears. That Bears is shuffled into **seat 1's** library (9 cards); **seat 1** investigates and controls a Clue token. Blink stays on the battlefield with 1 lore counter. Seat 0's library stays 8; seat 0 gets no Clue. (Forge matches.)
- **Nazahn**: the search finds no Equipment, so nothing is revealed and nothing goes to hand or battlefield; seat 0 shuffles. Nazahn stays on the battlefield as a 5/4; seat 0's hand is one Wastes. (Forge matches.)

#### Why

1. 608.2c: instructions are followed in order and read by the rules of English; "it", "its owner", "they" and "that card" refer back to their antecedents in the same text.
2. Blink: "it" is the target creature; "its owner" and "they" are that creature's owner, who investigates (701.16a: create a Clue token). The Saga isn't mentioned and stays; it's sacrificed only after its final chapter (714.4).
3. Nazahn: a search for a card with a stated quality may find nothing (701.23b), and here there's nothing to find. "Put that card into your hand" then has no object and does nothing (101.3, 609.3). Nazahn isn't "that card".

#### What phase did

- Blink: Blink itself moved from the battlefield into **seat 0's** library (9 cards), and **seat 0** got the Clue. Seat 1's Grizzly Bears stayed on the battlefield.
- Nazahn: after the empty search, **Nazahn** moved from the battlefield to seat 0's hand.

#### Variations to test

- Blink targeting seat 0's own Grizzly Bears: Bears into seat 0's library, seat 0 investigates, Blink stays.
- Blink targeting a creature seat 1 controls but seat 0 owns: it goes into seat 0's library and seat 0 investigates (owner, not controller).
- Blink when its target has become illegal: chapter I does nothing (608.2b); Blink stays.
- Nazahn with Hammer of Nazahn in the library: it goes onto the battlefield; with another Equipment: to hand; choosing not to find one: nothing moves. Nazahn never leaves the battlefield.

#### Acceptance checks

- Blink on this board: seat 1's library has 9 cards and seat 1 controls a Clue; Blink is on the battlefield with 1 lore counter; seat 0's library has 8 cards and seat 0 controls no Clue.
- Nazahn on this board: Nazahn is on the battlefield, seat 0's hand is one Wastes, seat 0's library still has 8 cards.

## Part B: "Tap up to one target creature and put a stun counter on it" — "it" is the target

(Formerly `put-counter-on-it-means-the-target.md`.)

Scenario: `card-fear-of-sleep-paralysis` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: the trigger targets seat 1's Grizzly Bears in both engines (scripted trigger target). Both tap the Bears. Forge puts the stun counter on the Bears; phase puts it on **Fear of Sleep Paralysis** (the source).

### 1. Card

- **Fear of Sleep Paralysis** ({5}{U} enchantment creature — Nightmare 6/6): "Flying. Eerie — Whenever this creature or another enchantment you control enters and whenever you fully unlock a Room, tap up to one target creature and put a stun counter on it. Stun counters can't be removed from permanents your opponents control. (They won't untap if they have stun counters.)"

Rulings (Scryfall):
- "While you control Fear of Sleep Paralysis, if a permanent an opponent controls with a stun counter would untap, it doesn't untap and the stun counter isn't removed."
- "If a permanent with an eerie ability enters at the same time as one or more enchantments, its ability will trigger for each of those enchantments."

### 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Island, 5 Wastes and Grizzly Bears; seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Fear of Sleep Paralysis; it enters (it's an enchantment, so its own eerie ability triggers); the trigger targets seat 1's Grizzly Bears (the scenario's `trigger_targets`).

### 3. Correct result

1. Tap the target (seat 1's Bears).
2. Put a stun counter on "it": the same target creature (608.2c; "it" refers back to the target in the same sentence).
3. Fear of Sleep Paralysis gets no counter.

Final: seat 1's Grizzly Bears tapped with one stun counter; Fear of Sleep Paralysis 6/6, untapped, no counters. (Forge: exactly this.)

### 4. Why

The ability's only object reference is "up to one target creature"; "it" in the same sentence refers to that creature (608.2c). The source is never mentioned by this instruction. With no target chosen ("up to one" allows zero), nothing is tapped and no counter is placed.

### 5. What phase did

Tapped the Bears but put the stun counter on Fear of Sleep Paralysis.

### 6. Variations to test

- **Zero targets:** the trigger does nothing; no counter anywhere.
- **Stun counter holds:** on seat 1's next untap step, its Bears doesn't untap and keeps the counter (Fear's static ability, ruling).
- **Target becomes illegal:** the Bears leaves before resolution: the trigger does nothing (608.2b); in particular no counter on the source.
- **Same wording elsewhere:** Summon: Valefor chapters II–IV ("Tap up to one target creature and put a stun counter on it"; see `choices-on-resolution-not-acted-on.md` for that card's chapter I) should put the counter on the target too.
- **Another enchantment enters** while Fear is on the battlefield: the trigger targets as above.

### 7. Acceptance checks

- After the trigger resolves on the sweep board, seat 1's Bears is tapped with a stun counter and Fear of Sleep Paralysis has no counters.

## Part C: "Exile [this card's name]" exiles the spell itself, not the card it just returned

(Formerly `self-name-exile-hits-returned-card.md`.)

Root cause (observed behaviour): a sorcery that first returns a creature card from a graveyard to the battlefield and then says "Exile [its own name]" makes phase exile the returned creature instead of the spell. The spell then goes to the graveyard as usual.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-charnel-serenade`, `card-reunion-of-the-house`.

### 1. Cards

Oracle text and rulings from Scryfall.

- **Charnel Serenade** ({4}{B}{B} sorcery): "Surveil 3, then return a creature card from your graveyard to the battlefield with a finality counter on it. Exile Charnel Serenade with three time counters on it. Suspend 3—{2}{B} (Rather than cast this card from your hand, you may pay {2}{B} and exile it with three time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)"
  - "The creature card you choose doesn't need to be a card you put in your graveyard with surveil. You may choose a creature card that was already in your graveyard before you surveilled."
  - "Finality counters work on any permanent ... If a permanent with a finality counter on it would go to a graveyard from the battlefield, exile it instead."
  - "If an effect refers to a 'suspended card,' that means a card that (1) has suspend, (2) is in exile, and (3) has one or more time counters on it."
- **Reunion of the House** ({5}{W}{W} sorcery): "Return any number of target creature cards with total power 10 or less from your graveyard to the battlefield. Exile Reunion of the House."

### 2. Board and actions

Standard sweep board: game turn 2, seat 0 active in precombat main. Seat 0 has exactly the lands for the card plus Grizzly Bears; hand is the card and a Wastes; graveyard Hill Giant (3/3 creature card) and Divination; library 8 Wastes. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire; graveyard Hill Giant; library 8 Wastes.

- `card-charnel-serenade`: seat 0 casts Charnel Serenade (no targets).
- `card-reunion-of-the-house`: seat 0 casts Reunion of the House targeting Hill Giant in its own graveyard.

### 3. Correct result

**Charnel Serenade.**
1. Surveil 3 (701.25a): seat 0 looks at three Wastes and puts any number into its graveyard (the AI's choice; Forge kept all three, phase binned two; either is fine).
2. Return a creature card from seat 0's graveyard: Hill Giant is the only creature card there (Wastes and Divination aren't creatures), so Hill Giant enters the battlefield under seat 0's control with one finality counter.
3. Exile Charnel Serenade with three time counters on it. The spell is still on the stack (it's resolving), so it goes from the stack to exile instead of the graveyard. It has suspend and time counters, so it's now a suspended card.

Final for seat 0: battlefield includes Hill Giant (3/3, finality counter 1); exile is exactly [Charnel Serenade] with three time counters; graveyard is Divination plus whatever Wastes were surveilled into it; Charnel Serenade is **not** in the graveyard. (Forge: exactly this, with no Wastes binned.)

**Reunion of the House.** Hill Giant (power 3, within the 10 limit) returns to the battlefield; then Reunion of the House is exiled. Final for seat 0: battlefield includes Hill Giant 3/3; exile [Reunion of the House]; graveyard [Divination]. (Forge: exactly this.)

### 4. Why

1. 201.5: text that refers to the object it's on by name means that object. "Charnel Serenade" and "Reunion of the House" in their own text mean the spell itself, never the creature the spell just moved.
2. 608.2c: instructions are followed in order; the second sentence is a separate instruction about a different object.
3. 608.2n: putting an instant or sorcery into its owner's graveyard is the final part of resolution. Here the spell's own instruction already moved it to exile, so it isn't on the stack to go to the graveyard.
4. The returned creature is a new object on the battlefield (400.7) and is not mentioned by the exile instruction at all.

### 5. What phase did

- Charnel Serenade: returned Hill Giant with a finality counter, then moved **Hill Giant** from the battlefield to exile and put three time counters on it; Charnel Serenade went to the graveyard. Final: exile [Hill Giant], graveyard has Charnel Serenade.
- Reunion of the House: returned Hill Giant, then moved **Hill Giant** to exile; Reunion went to the graveyard.

### 6. Variations to test

- **Nothing to return.** Charnel Serenade with no creature card in seat 0's graveyard (remove Hill Giant): surveil happens, nothing returns, and Charnel Serenade is still exiled with three time counters.
- **Creature put there by the surveil.** Library top is a creature card (e.g. Grizzly Bears) and Hill Giant is not in the graveyard: surveil it into the graveyard, return it; the spell, not the creature, is exiled.
- **Several returned cards.** Reunion of the House targeting two creature cards with total power ≤ 10 (e.g. Hill Giant and Grizzly Bears): both return and stay on the battlefield; only Reunion is exiled.
- **Same pattern with a different final zone.** Beacon of Unrest ({3}{B}{B} sorcery: "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle Beacon of Unrest into its owner's library."): the returned creature stays on the battlefield and Beacon of Unrest goes into seat 0's library (library 8 → 9).
- **Suspended afterwards.** On seat 0's next upkeep a time counter comes off Charnel Serenade (three → two), which only works if the card itself is the one in exile.

### 7. Acceptance checks

- After Charnel Serenade resolves, Hill Giant is on the battlefield with a finality counter, and Charnel Serenade is in exile with three time counters; it's not in the graveyard.
- After Reunion of the House resolves, Hill Giant is on the battlefield and Reunion of the House is in exile.
- No creature returned by either spell is exiled or gets time counters.

### 8. Added from batch 4: Revival Experiment

Scenario: `card-revival-experiment` (card sweep, standard sweep board).

- **Revival Experiment** ({4}{B}{G} sorcery): "For each permanent type, return up to one card of that type from your graveyard to the battlefield. You lose 3 life for each card returned this way. Exile Revival Experiment."
  - Rulings 2021-04-16: "The permanent types are artifact, creature, enchantment, land, and planeswalker." "The cards you return are chosen as Revival Experiment resolves."

Board: seat 0's graveyard is Hill Giant (creature) and Divination (sorcery, not a permanent card). Seat 0 casts Revival Experiment.

Correct result: seat 0 may return Hill Giant (the only permanent card) and lose 3 life, or return nothing ("up to one" per type is a choice). **Either way Revival Experiment ends in exile, not in the graveyard** (same reasoning as section 4: the spell's own name means the spell, 201.5; its instruction moves it from the stack to exile, so 608.2n's move to the graveyard doesn't happen). Forge: returned Hill Giant, life 17, Revival Experiment in exile.

What phase did: nothing returned (no choice was logged), life 20, and Revival Experiment went to the **graveyard**. That matches the "nothing to return" case above going wrong: with no returned card, phase's exile instruction found nothing to exile and the spell went to the graveyard.

Extra checks:
- Revival Experiment returning nothing: still exiled, life unchanged.
- Returning Hill Giant: Hill Giant on the battlefield, seat 0 at 17, Revival Experiment in exile, Hill Giant **not** exiled.
- Graveyard with an artifact, a creature and a land card: up to three return (one per type), 3 life each; a card with two permanent types (artifact creature) counts as the card for only one of the types it has.

## Part D: Beacon of Unrest shuffles itself, not the returned card, into its owner's library

(Formerly `shuffle-self-into-library.md`.)

Scenario: `card-beacon-of-unrest`. Observed: Forge ends with seat 1's Hill Giant on seat 0's battlefield and Beacon of Unrest shuffled into seat 0's library (9 cards). Phase put Hill Giant onto the battlefield, then moved Hill Giant from the battlefield into seat 1's library (shuffled), and put Beacon of Unrest into seat 0's graveyard.

### 1. Card

- **Beacon of Unrest** {3}{B}{B}, Sorcery. "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle Beacon of Unrest into its owner's library."

Rulings (2020-08-07): "If the target card is an illegal target by the time Beacon of Unrest tries to resolve, the spell won't resolve. You won't shuffle it into your library."

### 2. Board and actions

Sweep board: seat 1's graveyard has Hill Giant. Seat 0 casts Beacon of Unrest targeting that Hill Giant (scripted, zone graveyard); it resolves.

### 3. Correct result

- Hill Giant (owner seat 1) is on the battlefield under seat 0's control, 3/3.
- Beacon of Unrest is in seat 0's library, which is shuffled: library 9 cards.
- Seat 0's graveyard: Divination, Hill Giant (its own, untouched). Seat 1's graveyard: empty. Seat 1's library: 8.

### 4. Why

1. 608.2c: put the target onto the battlefield under the caster's control.
2. "Shuffle Beacon of Unrest into its owner's library": text that refers to the object by its name means that object itself (201.5), here the resolving Beacon of Unrest spell, owned by seat 0. It goes into seat 0's library and that library is shuffled (701.24a).
3. Because the spell is no longer on the stack at the end of resolution, it doesn't go to the graveyard (608.2n applies only to a spell still on the stack).

### 5. What phase did

Shuffled the card Beacon returned (Hill Giant) into its owner's library instead of shuffling Beacon of Unrest, and Beacon went to the graveyard.

### 6. Variations to test

- Target an artifact or creature card in the caster's own graveyard: same result; Beacon goes to the caster's library.
- Target illegal on resolution (card left the graveyard): nothing happens, Beacon goes to the graveyard (ruling).
- Other self-shuffling Beacons with the same wording: Beacon of Destruction ("Beacon of Destruction deals 5 damage to any target. Shuffle Beacon of Destruction into its owner's library."), Beacon of Immortality, Beacon of Tomorrows.
- A copy of Beacon of Unrest: the copy can't go to a library (it ceases to exist), but the owner's library is still shuffled (701.24c).

### 7. Acceptance checks

- After Beacon of Unrest resolves, the returned card is on the battlefield under the caster's control and Beacon of Unrest is in its owner's library.
- The returned card is never moved again by this spell.

## Part E: effects about "target player" / "that player" read the wrong player

(Formerly `target-player-reference-wrong-player.md`.)

Root cause (observed behaviour): when an effect counts or acts on things belonging to a *targeted* player, phase uses the wrong player (apparently the spell's controller) or the wrong count. Curious Herd counted 0 artifacts for an opponent who controls one; Biomantic Mastery drew 1 card where the two targeted players control 3 creatures between them; Obscura Confluence's third mode returned a creature card from the *caster's* graveyard instead of the targeted player's.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-curious-herd`, `card-biomantic-mastery`, `card-obscura-confluence`.

### 1. Cards

Oracle text and rulings from Scryfall.

- **Curious Herd** ({3}{G} instant): "Choose target opponent. You create X 3/3 green Beast creature tokens, where X is the number of artifacts that player controls."
- **Biomantic Mastery** ({4}{G/U}{G/U}{G/U} sorcery): "Draw a card for each creature target player controls, then draw a card for each creature another target player controls."
  - 2006-05-01: "You choose both targets before you draw any cards. The targets must be different. One of them may be you."
- **Obscura Confluence** ({1}{W}{U}{B} instant): "Choose three. You may choose the same mode more than once. • Until end of turn, target creature loses all abilities and has base power and toughness 1/1. • Target creature connives. ... • Target player returns a creature card from their graveyard to their hand."

### 2. Board and actions

Seat 0 (active, main phase 1): lands for the card, Grizzly Bears; graveyard Hill Giant, Divination; hand the card and a Wastes; library 8 Wastes. Seat 1: Grizzly Bears, Serra Angel, Millstone (artifact), Seal of Fire (enchantment); hand two Wastes; graveyard Hill Giant; library 8 Wastes.

- `card-curious-herd`: seat 0 casts Curious Herd targeting seat 1.
- `card-biomantic-mastery`: seat 0 casts Biomantic Mastery; first target seat 1, second target seat 0.
- `card-obscura-confluence`: seat 0 casts Obscura Confluence choosing modes 1, 2, 3 once each: mode 1 targets seat 1's Grizzly Bears, mode 2 targets seat 1's Serra Angel, mode 3 targets seat 1.

### 3. Correct result

- **Curious Herd:** seat 1 controls one artifact (Millstone), so X = 1: **seat 0 creates one 3/3 green Beast token.**
- **Biomantic Mastery:** seat 1 controls 2 creatures (Grizzly Bears, Serra Angel) → draw 2; seat 0 controls 1 creature (Grizzly Bears; Biomantic Mastery is on the stack, not a creature) → draw 1. **Seat 0 draws 3: hand 1 → 4 Wastes, library 8 → 5.**
- **Obscura Confluence:** in order: seat 1's Grizzly Bears loses all abilities and is 1/1 until end of turn; Serra Angel connives (seat 1 draws a card, then discards a card; if the discard is a nonland card, Serra Angel gets a +1/+1 counter; here seat 1 holds only Wastes, so no counter); then **seat 1 returns Hill Giant from seat 1's graveyard to seat 1's hand.** Seat 0's Hill Giant stays in seat 0's graveyard. Forge's final: seat 1 hand Hill Giant + 2 Wastes, seat 1 graveyard Wastes; seat 0 graveyard Divination, Hill Giant, Obscura Confluence.

### 4. Why

1. "That player" (Curious Herd) is the target opponent; "target player controls" / "another target player controls" (Biomantic Mastery) are the chosen target players; "their graveyard" (Obscura Confluence) is the target player's graveyard (608.2c: read the text in plain English).
2. Counts are taken on resolution (608.2h): Curious Herd counts artifacts seat 1 controls at that moment (Millstone); Biomantic Mastery counts creatures each target player controls when that part of the effect is applied.
3. Biomantic Mastery has two separate draw instructions, both carried out (608.2c). The ruling says one of the targets may be the caster.
4. Obscura Confluence's third mode tells the *target player* to return a card; that player chooses a creature card from their own graveyard (seat 1's Hill Giant is the only one).

### 5. What phase did

- Curious Herd: no Beast token (Forge: one).
- Biomantic Mastery: seat 0 drew 1 card (hand 2, library 7). Forge: drew 3 (hand 4, library 5).
- Obscura Confluence: the first two modes were right, but "Hill Giant moves from graveyard to hand" moved **seat 0's** Hill Giant into **seat 0's** hand; seat 1's Hill Giant stayed in its graveyard.

### 6. Variations to test

- **Curious Herd with zero / several artifacts:** seat 1 controls no artifacts → no tokens; seat 1 controls 3 artifacts → 3 Beasts. Seat 0's own artifacts never count.
- **Biomantic Mastery, reversed targets:** first seat 0, second seat 1 → draws 1 then 2, total 3.
- **Biomantic Mastery, one target illegal on resolution** (e.g. a player gained hexproof): only the legal target's part happens (608.2b); the illegal target's creatures aren't counted.
- **Obscura Confluence, mode 3 targeting the caster:** seat 0 returns its own Hill Giant.
- **Obscura Confluence, mode 3 chosen twice targeting seat 1 both times** (allowed: each instance of "target" may pick the same player): seat 1 returns two creature cards if it has two, otherwise one.
- **Target player has no creature card in graveyard:** nothing returns; nothing is taken from anyone else's graveyard.
- Other "target player"/"that player" counting effects worth a regression check: Mind Spring-style "target player draws X", "for each creature target opponent controls" wording.

### 7. Acceptance checks

- Curious Herd targeting an opponent who controls exactly one artifact creates exactly one Beast token for the caster.
- Biomantic Mastery targeting the opponent (2 creatures) and the caster (1 creature) draws exactly 3 cards.
- Obscura Confluence's "Target player returns a creature card from their graveyard to their hand" moves a card from the targeted player's graveyard to that player's hand, never from the caster's graveyard.

---

### Added from triage batch 2: Dalek Drone, The Mouth of Sauron

Two more cards where "that player" (the targeted player, or the controller of a targeted creature) was read as the spell's controller.

Scenarios: `card-dalek-drone` (trigger target: seat 1's Grizzly Bears), `card-the-mouth-of-sauron` (trigger target: seat 1). Standard sweep board (`referee/sweep.py`): seat 0 active in main phase 1 with exactly the lands for the card plus Grizzly Bears, hand = the card + Wastes, graveyard Hill Giant + Divination (a sorcery), library 8 Wastes; seat 1 with Grizzly Bears, Serra Angel, Millstone, Seal of Fire, 2 Wastes in hand, Hill Giant in graveyard, library 8 Wastes; both at 20 life.

#### Cards

- **Dalek Drone** {3}{B}{B}, Artifact Creature — Dalek, 3/3. "Flying, menace / Exterminate! — When this creature enters, destroy target creature an opponent controls. That player loses 3 life." Lands: Swamp, Swamp + 3 Wastes.
- **The Mouth of Sauron** {3}{U}{B}, Legendary Creature — Human Advisor, 3/4. "When The Mouth of Sauron enters, target player mills three cards. Then amass Orcs X, where X is the number of instant and sorcery cards in that player's graveyard. (Put X +1/+1 counters on an Army you control. It's also an Orc. If you don't control an Army, create a 0/0 black Orc Army creature token first.)" Lands: Island, Swamp + 3 Wastes.
  - Ruling 2023-06-16: "To amass Orcs N, if you don't control an Army creature, create a 0/0 black Orc Army creature token. Then you choose an Army creature you control and put N +1/+1 counters on it."

#### Correct result

- **Dalek Drone**: seat 1's Grizzly Bears is destroyed and **seat 1** loses 3 life (17). Seat 0 stays at 20. (Forge matches.)
- **The Mouth of Sauron**: seat 1 mills three Wastes. Seat 1's graveyard is Hill Giant + 3 Wastes: no instants or sorceries, so X = 0. Seat 0 has no Army, so it creates a 0/0 black Orc Army token and puts no counters on it; the token is put into the graveyard as a state-based action (704.5f) and ceases to exist (704.5d). No Army remains. (Forge matches; its log shows the Orc Army token going to the graveyard.)

#### Why

1. Dalek Drone: "That player" refers to "an opponent" in "target creature an opponent controls", i.e. the target creature's controller. The creature has been destroyed by then, so its controller comes from last known information (608.2h). The Drone's controller isn't "that player".
2. The Mouth of Sauron: "that player's graveyard" is the targeted player's. The count is taken once, after the mill (608.2h). Seat 0's Divination isn't in that graveyard. Amass with X = 0 still creates the token when you have no Army (701.47a; ruling).

#### What phase did

- Dalek Drone: destroyed seat 1's Bears, then **seat 0** lost 3 life (seat 0 at 17, seat 1 at 20).
- The Mouth of Sauron: X came out as 1, matching the one sorcery in **seat 0's** graveyard; a 1/1 Orc Army with one +1/+1 counter stayed on the battlefield.

#### Variations to test

- Dalek Drone targeting an indestructible creature: it survives, but its controller still loses 3 life.
- The Mouth of Sauron targeting seat 0 itself: X counts Divination plus any instant/sorcery milled; the Army is at least 1/1.
- The Mouth of Sauron targeting seat 1 with an instant already in seat 1's graveyard: X = 1.

#### Acceptance checks

- Dalek Drone on this board: seat 1 at 17 life, seat 0 at 20.
- The Mouth of Sauron targeting seat 1 on this board: seat 1's graveyard is Hill Giant + 3 Wastes, and at the end seat 0 controls no Orc Army.

## Part F: Call the Coppercoats creates a token per creature its target opponents control

(Formerly `count-target-opponents-creatures.md`.)

Scenario: `card-call-the-coppercoats`. Observed: Forge gives seat 0 two 1/1 Human Soldier tokens. Phase moves the spell to the graveyard with no tokens and no effect logged.

### 1. Card

- **Call the Coppercoats** {2}{W}, Instant. "Strive — This spell costs {1}{W} more to cast for each target beyond the first. Choose any number of target opponents. Create X 1/1 white Human Soldier creature tokens, where X is the number of creatures those opponents control."

Rulings (2020-04-17):
- "Any target opponents that are no longer legal targets by the time Call the Coppercoats resolves won't have their creatures counted when determining how many tokens you create."
- "It's legal to cast such a spell with no targets, although this is rarely a good idea. You can't choose the same target more than once for a single strive spell."

### 2. Board and actions

Sweep board: seat 0 has Plains + 2 Wastes and Grizzly Bears. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Call the Coppercoats with one target, seat 1 (scripted; one target, so no strive cost). It resolves.

### 3. Correct result

X = 2 (seat 1 controls Grizzly Bears and Serra Angel). Seat 0 creates two 1/1 white Human Soldier creature tokens.

### 4. Why

1. The target, seat 1, is still legal on resolution (608.2b), so the spell resolves.
2. X is computed once, as the effect is applied (608.2h): the number of creatures controlled by the target opponents, 2. Seat 0's own Grizzly Bears doesn't count.
3. Seat 0 creates that many tokens with the given characteristics (111.1).
4. "Strive" is an ability word (207.2c) and only affects the cost.

### 5. What phase did

The spell left the stack for the graveyard without creating any tokens (no resolution effect in the log), as though it had no effect or no legal target.

### 6. Variations to test

- Two opponents targeted (multiplayer): cost is {2}{W} + {1}{W}; X counts both opponents' creatures.
- Zero targets: legal, X = 0, no tokens.
- The target opponent controls no creatures: no tokens.
- One of two targets becomes illegal (e.g. gains hexproof) before resolution: only the legal one's creatures are counted.
- Opponent's creatures change between casting and resolution: count at resolution.

### 7. Acceptance checks

- Call the Coppercoats targeting one opponent with two creatures gives its caster exactly two 1/1 white Human Soldier tokens.
- Only the targeted opponents' creatures are counted.
