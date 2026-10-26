# Spec: cards chosen from among revealed or exiled cards, and "the rest", end up in the wrong place

Root cause (observed behaviour): when an effect reveals, looks at or exiles a set of cards and then has a player choose some of them (an opponent picks a card or a pile, "a card with each of those keywords", "a land card from among them") and moves "the rest" somewhere, phase loses track of the set. Chosen cards aren't moved (or every matching card is, or a card from outside the set is), and "the rest" stay where they were (library or exile) or go to the wrong zone (graveyard instead of the bottom of the library).

Merged from six specs written in parallel: `revealed-cards-opponent-chooses.md` (Part A), `abstract-performance-piles.md` (Part B), `reveal-choose-by-keyword.md` (Part C), `put-a-land-card-means-one.md` (Part D), `exile-top-then-rest-on-bottom.md` (Part E), `reveal-rest-to-bottom.md` (Part F). They may need more than one fix (the choice step and the "rest" step), but they share the reveal-choose-move pipeline, so test them together.

Cards: Steam Augury, Murmurs from Beyond (Part A); Abstract Performance (Part B); Selective Adaptation (Part C); Aminatou's Augury (Part D); Herald of Amity (Part E); Aethermage's Touch (Part F).

Related: `exile-until-land-put-onto-battlefield.md` (Venture Forth: the found land goes back to the library), `collision-of-realms.md` (a reveal that never happens), `back-references-resolve-to-wrong-object.md` (Part A, Creative Technique: a reveal that finds nothing).

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: revealed cards where an opponent picks never leave the library

(Formerly `revealed-cards-opponent-chooses.md`.)

Root cause (observed behaviour): for "reveal the top N cards ... an opponent chooses ... put [some] into your hand and the rest into your graveyard", phase reveals the cards and then leaves all of them on top of the library. Hand and graveyard don't change.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-steam-augury`, `card-murmurs-from-beyond`.

### 1. Cards

Oracle text from Scryfall.

- **Steam Augury** ({2}{U}{R} instant): "Reveal the top five cards of your library and separate them into two piles. An opponent chooses one of those piles. Put that pile into your hand and the other into your graveyard."
  - Rulings 2013-09-15: "Steam Augury doesn't target any opponent. In a multiplayer game, you choose the opponent as the spell resolves." "If one of the piles is empty, the opponent will choose whether to put the cards from the other pile into your hand or into your graveyard."
- **Murmurs from Beyond** ({2}{U} instant — Arcane): "Reveal the top three cards of your library. An opponent chooses one of them. Put that card into your graveyard and the rest into your hand."

### 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears; hand: the card, Wastes; library: 8 Wastes. Seat 1 is the only opponent. Seat 0 casts the card.

### 3. Correct result

**Steam Augury.** The top five Wastes are revealed. Seat 0 splits them into two piles (any split, including 5/0). Seat 1 picks a pile: it goes to seat 0's hand, the other to seat 0's graveyard. Library **3**. Hand gains k Wastes and graveyard gains 5 − k Wastes for some k between 0 and 5 (Forge: 3 to hand, 2 to graveyard).

**Murmurs from Beyond.** The top three Wastes are revealed. Seat 1 picks one: it goes to seat 0's graveyard; the other two go to seat 0's hand. Library **5**, hand Wastes ×3 (the original plus two), graveyard gains one Wastes.

### 4. Why

1. 701.20b: revealing doesn't move a card; the following instructions do, and they are mandatory (608.2c).
2. The opponent's pick is a choice made on resolution (608.2d). Every revealed card ends in hand or graveyard; none stays in the library.

### 5. What phase did

Both: "Player 1 reveals: Wastes ×N", the spell resolved, library still 8, hand and graveyard unchanged (apart from the spell itself in the graveyard).

### 6. Variations to test

- Library smaller than N (e.g. 2 cards): reveal what's there, and every revealed card still ends in hand or graveyard.
- Steam Augury with a 5/0 split: opponent chooses whether all five go to hand or all to graveyard.
- Different cards in the library (so the opponent's choice is visible): Murmurs from Beyond with a land and two spells; the opponent's chosen card ends in the graveyard.
- Related wording to check: Fact or Fiction ("an opponent separates ... you choose"), Mystic Confluence-style reveals.

### 7. Acceptance checks

- After Steam Augury, the library has five fewer cards and those five are split between hand and graveyard.
- After Murmurs from Beyond, the library has three fewer cards: one in the graveyard, two in hand.

## Part B: Abstract Performance puts one pile into the graveyard and the other into hand

(Formerly `abstract-performance-piles.md`.)

Scenario: `card-abstract-performance`. Observed: both engines exile eight cards. Forge ends with four Wastes added to seat 0's graveyard and four Wastes added to seat 0's hand, exile empty. Phase ends with one Wastes in the graveyard, seven Wastes still in exile, and no cards added to hand.

### 1. Card

- **Abstract Performance** {5}{U}, Sorcery. "Exile the top four cards of your library in a face-down pile, then exile the top four cards of your library in a face-up pile. An opponent chooses one of those piles. Put that pile into your graveyard. Look at the cards in the other pile. You may cast a spell from among them without paying its mana cost. Put the rest into your hand."

Rulings (2026-03-20):
- "You choose which opponent chooses the pile while resolving Abstract Performance."
- "You cast the spell while Abstract Performance is resolving and still on the stack."
- "If you have fewer than eight cards in your library, the second pile will be smaller than the first..."

### 2. Board and actions

Sweep board: seat 0's library is 8 Wastes; hand after casting: one Wastes. Seat 0 casts Abstract Performance; it resolves.

### 3. Correct result

- Pile A: top four Wastes, exiled face down. Pile B: next four Wastes, exiled face up. Library is empty.
- Seat 1 chooses a pile; those four cards go to seat 0's graveyard.
- Seat 0 looks at the other four. All are lands, which can't be cast (305.9, lands are played, not cast), so no spell is cast. "The rest" (all four) go to seat 0's hand.
- Final: seat 0 graveyard: Abstract Performance, Divination, Hill Giant, 4 Wastes; hand: 5 Wastes; exile: empty; library 0. (Either pile choice gives this final state.)

### 4. Why

1. Instructions in order (608.2c). Face-down exile (406.3) only limits who may look at the cards.
2. The chosen pile, all four cards, goes to the graveyard.
3. The other pile: optionally cast one spell from it free; every remaining card of that pile goes to hand.
4. Every one of the eight cards ends up in the graveyard or the hand (or cast). None stays in exile.

### 5. What phase did

Exiled eight cards, then moved one card to the graveyard and left seven in exile; nothing went to hand.

### 6. Variations to test

- The non-chosen pile contains an instant or sorcery: it may be cast free during resolution; the others go to hand.
- The non-chosen pile contains a creature card: it may be cast free; it ends on the battlefield after resolving.
- The opponent chooses the face-down pile vs the face-up pile: both work symmetrically.
- Library of only five cards: pile A has four, pile B one.
- Library of three cards: pile A has three, pile B is empty; whichever pile is chosen, the rest go to hand.

### 7. Acceptance checks

- After Abstract Performance resolves, none of the eight cards it exiled remains in exile: each is in the graveyard, in hand, or was cast.
- The opponent's chosen pile is entirely in the graveyard; the other pile is in hand except for at most one spell cast from it.

## Part C: Selective Adaptation chooses only among the revealed cards, and the rest go to the graveyard

(Formerly `reveal-choose-by-keyword.md`.)

Scenario: `card-selective-adaptation` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: both engines reveal seven Wastes. Forge puts all seven into seat 0's graveyard (library 8 → 1). Phase leaves them in the library (library 8) and puts **Hill Giant from seat 0's graveyard** onto the battlefield.

### 1. Card

- **Selective Adaptation** ({4}{G}{G} sorcery): "Reveal the top seven cards of your library. Choose from among them a card with flying, a card with first strike, and so on for double strike, deathtouch, haste, hexproof, indestructible, lifelink, menace, reach, trample, and vigilance. Put one of the chosen cards onto the battlefield, the other chosen cards into your hand, and the rest into your graveyard."

Ruling (Scryfall): "If a card has more than one of the listed keywords, you pick which keyword you're choosing it for. For example, if you choose a card with flying and first strike, you may choose it as the card with flying and choose another card with first strike, or you may choose it as the card with first strike and choose another card with flying."

### 2. Board and actions

Standard sweep board: seat 0 active in precombat main with 2 Forests, 4 Wastes and Grizzly Bears; graveyard Hill Giant and Divination; library 8 Wastes. Seat 0 casts Selective Adaptation.

### 3. Correct result

1. Reveal the top seven cards: seven Wastes (701.20a).
2. Choose from among **those seven** a card with each listed keyword. A Wastes has none of them, so nothing can be chosen (609.3: do as much as possible).
3. No chosen card, so nothing goes onto the battlefield or into the hand.
4. "The rest" — all seven revealed cards — go into seat 0's graveyard.

Final: seat 0's library has 1 card; graveyard [Divination, Hill Giant, Selective Adaptation, Wastes ×7]; battlefield unchanged; Hill Giant stays in the graveyard. (Forge: exactly this.)

### 4. Why

- "Choose from among them" restricts every choice to the revealed cards (608.2c). Cards in the graveyard, hand or elsewhere are never candidates.
- The last sentence is mandatory for the unchosen revealed cards: they're put into the graveyard (608.2c).

### 5. What phase did

Revealed the seven Wastes, then put Hill Giant (from the graveyard, not among the revealed cards) onto the battlefield, and left the seven Wastes in the library.

### 6. Variations to test

- **One keyword card among the seven:** library top is Serra Angel (flying, vigilance) then Wastes. Serra Angel is chosen (for flying or vigilance, not both) and, being the only chosen card, must be the one put onto the battlefield; six Wastes to the graveyard.
- **Several keyword cards:** Serra Angel (flying, vigilance), a creature with trample and a creature with haste among the seven: up to three chosen; one onto the battlefield, the other two into hand, rest into the graveyard. One card counts for only one keyword (ruling).
- **Two cards with the same single keyword** (two fliers without other keywords): only one of them can be chosen for flying; the other goes to the graveyard.
- **Fewer than seven cards in library:** reveal all of them; the same rules apply.
- **Keyword card in graveyard or hand:** it's never chosen.

### 7. Acceptance checks

- On the sweep board, after Selective Adaptation resolves, seat 0's library is 1 card, its graveyard has the seven revealed Wastes, and Hill Giant is still in the graveyard.
- Only revealed cards can be put onto the battlefield or into the hand by this spell.

## Part D: "You may put a land card from among them onto the battlefield" puts every land

(Formerly `put-a-land-card-means-one.md`.)

Scenario: `card-aminatou-s-augury` (card sweep, batch 2).

### 1. Card

- **Aminatou's Augury** {6}{U}{U}, Sorcery. "Exile the top eight cards of your library. You may put a land card from among them onto the battlefield. Until end of turn, for each nonland card type, you may cast a spell of that type from among the exiled cards without paying its mana cost."
  - Ruling 2018-07-13: "If you wish to put a land card onto the battlefield, you do so while Aminatou's Augury is resolving, before you're allowed to cast any of the other cards. You may do this even if you've already played a land this turn."

### 2. Board and actions

Board: the sweep board (top of this file).

Lands Island, Island + 6 Wastes. Seat 0 casts Aminatou's Augury; it resolves.

### 3. Correct result

Seat 0 exiles its whole library (8 Wastes). It may put **one** of them onto the battlefield (both engines chose to). The other seven stay in exile. No nonland cards were exiled, so there's nothing to cast. Final: seat 0's battlefield has its 8 original lands (tapped), Grizzly Bears and one new untapped Wastes; exile 7 Wastes; library 0. (Forge matches.)

### 4. Why

1. 608.2c: follow the text as written. "A land card" is singular: at most one land card is put onto the battlefield.
2. The other exiled cards stay in exile; the land cards among them can't be played later (ruling: a land can only be put onto the battlefield at the moment the spell says).

### 5. What phase did

Put all eight exiled Wastes onto the battlefield; exile empty.

### 6. Variations to test

- Exiled cards with three lands and some nonland cards: one land onto the battlefield at most; up to one spell per nonland card type castable free until end of turn.
- Choosing not to put a land: all eight stay in exile.
- Already played a land this turn: still allowed to put one (it's not a land play).
- Watch for the same "a card" → "all cards" pattern in similar text ("You may put a creature card from among them onto the battlefield").

### 7. Acceptance checks

- On this board, after Aminatou's Augury resolves, exactly one Wastes from the library is on seat 0's battlefield and seven are in seat 0's exile.

## Part E: "exile the top eight cards ... Then put the rest on the bottom of your library"

(Formerly `exile-top-then-rest-on-bottom.md`.)

Root cause (observed behaviour): phase exiled the cards but never did the final "put the rest on the bottom of your library in a random order", so the cards stayed in exile and the library was left empty.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-herald-of-amity`.

### 1. Card

Oracle text and rulings from Scryfall.

- **Herald of Amity** ({3}{W} Creature — Griffin 2/2): "Flying. When this creature enters, exile the top eight cards of your library. You may cast an Aura spell from among them without paying its mana cost. Then put the rest on the bottom of your library in a random order. Whenever this creature attacks, it gets +X/+X until end of turn, where X is the number of Auras you control."
  - 2026-03-20: "You cast the spell while Herald of Amity's second ability is resolving and still on the stack. You can't wait to cast it later in the turn. Timing restrictions based on the card's types are ignored."

### 2. Board and actions

Seat 0 (active, main phase 1): library 8 Wastes. Seat 0 casts Herald of Amity; it resolves; its enters trigger resolves.

### 3. Correct result

The trigger exiles all 8 Wastes. None is an Aura, so nothing can be cast. "The rest" (all 8) go to the bottom of seat 0's library in a random order. **Final: seat 0's library 8 cards, exile empty.** (Forge: library 8, exile empty.)

### 4. Why

1. Instructions in order (608.2c): exile eight, optionally cast an Aura among them, then put the rest on the bottom.
2. "The rest" means every card exiled this way that wasn't cast. The optional cast not happening doesn't cancel the last instruction.
3. "In a random order" randomises the order of those cards only; the rest of the library is not shuffled.

### 5. What phase did

Logged eight "Wastes moves from library to exile" and two "effect resolves". Final: library 0, exile 8 Wastes.

### 6. Variations to test

- **An Aura among them:** library top 8 includes an Aura that can enchant a creature on the battlefield. Seat 0 may cast it for free during the resolution; it goes on the stack (targets chosen then); the other 7 go to the bottom. If seat 0 declines, all 8 go to the bottom.
- **Fewer than eight cards in library:** exile all; then all un-cast cards go back to the (now empty) library.
- **Aura with an illegal target only** (no creature to enchant): it can't be cast; it goes to the bottom with the rest.
- **Attack trigger:** with two Auras under seat 0's control, Herald of Amity attacks as a 4/4 until end of turn.

### 7. Acceptance checks

- After the enters trigger, no card it exiled is still in exile: every card not cast is on the bottom of the library.
- Seat 0's library size after the trigger equals its size before minus the number of Auras cast from among the exiled cards.

## Part F: Revealed cards that should go to the bottom of the library go to the graveyard

(Formerly `reveal-rest-to-bottom.md`.)

Scenario: `card-aethermage-s-touch` (card sweep, batch 2).

### 1. Card

- **Aethermage's Touch** {2}{W}{U}, Instant. "Reveal the top four cards of your library. You may put a creature card from among them onto the battlefield. It gains 'At the beginning of your end step, return this creature to its owner's hand.' Then put the rest of the cards revealed this way on the bottom of your library in any order."
  - Ruling 2017-03-14: "If you don't reveal any creature cards, or if you choose not to put a revealed creature card onto the battlefield, all the revealed cards go on the bottom of your library."

### 2. Board and actions

Board: the sweep board (top of this file).

Lands Plains, Island, Wastes, Wastes. Seat 0 casts Aethermage's Touch; it resolves.

### 3. Correct result

Seat 0 reveals four Wastes. None is a creature card, so nothing enters. All four go on the bottom of seat 0's library. Final: library 8 cards; graveyard Aethermage's Touch, Divination, Hill Giant. (Forge matches.)

### 4. Why

1. 608.2c: "put the rest of the cards revealed this way on the bottom of your library in any order" — the destination is the library's bottom, never the graveyard.
2. The ruling covers this case directly: with no creature revealed, all revealed cards go to the bottom.

### 5. What phase did

Put all four revealed Wastes into seat 0's graveyard (library 4).

### 6. Variations to test

- Library with a creature card among the top four: put it onto the battlefield (it gains the end-step return trigger); the other three go to the bottom.
- A creature is revealed but the player declines: all four to the bottom.
- Library with fewer than four cards: reveal them all; same rules.
- At seat 0's next end step the creature put onto the battlefield returns to its owner's hand.

### 7. Acceptance checks

- On this board, after Aethermage's Touch resolves, seat 0's library has 8 cards and seat 0's graveyard is exactly Aethermage's Touch, Divination and Hill Giant.
