# Spec: "If an opponent / that player has more ... than you" conditions never come out true

Root cause (observed behaviour): conditions that compare an opponent's life, creature count or hand size with the controller's never come out true in phase, so the conditional effect never happens, even when the opponent clearly has more.

Merged from two specs written in parallel: `opponent-comparison-conditions.md` (Part A) and `hand-size-difference-draw.md` (Part B).

Cards: Sunset Revelry (Part A); Sandstone Oracle (Part B).

Related: `back-references-resolve-to-wrong-object.md` (Part E: counts over another player's things read from the wrong player).

Standard sweep board (referred to below as "the sweep board"): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines. (`referee/sweep.py`; see `referee/README.md`.)

## Part A: "If an opponent has/controls more ... than you" conditions never come out true

(Formerly `opponent-comparison-conditions.md`.)

Scenario: `card-sunset-revelry` (card sweep, batch 2).

### 1. Card

- **Sunset Revelry** {1}{W}, Sorcery. "If an opponent has more life than you, you gain 4 life. / If an opponent controls more creatures than you, create two 1/1 white Human creature tokens. / If an opponent has more cards in hand than you, draw a card."

### 2. Board and actions

Board: the sweep board (top of this file).

Lands Plains + Wastes. Seat 0 casts Sunset Revelry; it resolves.

### 3. Correct result

Checked in order as the spell resolves:

1. Life: seat 1 has 20, seat 0 has 20. Not more: no life gain.
2. Creatures: seat 1 controls 2 (Grizzly Bears, Serra Angel), seat 0 controls 1 (Grizzly Bears). More: seat 0 creates two 1/1 white Human creature tokens.
3. Cards in hand: seat 1 has 2 (two Wastes); seat 0 has 1 (its Wastes; Sunset Revelry is on the stack, not in hand). More: seat 0 draws a card.

Final for seat 0: life 20; battlefield adds two Human tokens; hand two Wastes; library 7. (Forge matches.)

### 4. Why

1. 608.2c: instructions are followed in order. Each sentence is its own condition, checked when that sentence is applied (608.2h), so a change made by an earlier sentence counts for a later one (here it doesn't change the outcome).
2. "An opponent has more X than you" is true when at least one opponent's count is greater than the spell's controller's count. Ties don't qualify.
3. The spell is on the stack while it resolves (608.2n moves it to the graveyard only at the end), so it isn't counted in its controller's hand.

### 5. What phase did

Nothing: no tokens, no draw, no life gain. The spell went to the graveyard.

### 6. Variations to test

- Seat 1 at 25 life, seat 0 at 20: seat 0 gains 4.
- Equal creature counts (each controls one creature): no tokens.
- Three-player game where only one opponent has more creatures: tokens are created.
- Seat 0 with three cards in hand after casting, seat 1 with two: no draw.
- A board where the tokens from the second sentence change nothing for the third, and one where an earlier sentence could matter (e.g. a "whenever a creature enters, draw a card" effect): the hand comparison uses the state at that point.

### 7. Acceptance checks

- On this board, after Sunset Revelry resolves, seat 0 controls two 1/1 white Human tokens, has two Wastes in hand and 7 cards in library, and is at 20 life.

## Part B: Sandstone Oracle draws the difference in hand sizes

(Formerly `hand-size-difference-draw.md`.)

Scenario: `card-sandstone-oracle`. Observed: Forge's seat 0 draws one card; phase's draws none.

### 1. Card

- **Sandstone Oracle** {7}, Artifact Creature — Sphinx, 4/4. "Flying. When this creature enters, choose an opponent. If that player has more cards in hand than you, draw cards equal to the difference."

Rulings (2020-11-10):
- "You choose an opponent while Sandstone Oracle's ability is resolving. No player may take actions between the time you make this choice and the time you draw cards."
- "To draw cards equal to the difference, first determine how many cards you'll draw, then draw that many cards..."

### 2. Board and actions

Sweep board: seat 0 has 7 Wastes and Grizzly Bears; hand: Sandstone Oracle and a Wastes. Seat 1's hand: two Wastes. Seat 0 casts Sandstone Oracle; it resolves; the enters trigger resolves.

### 3. Correct result

When the trigger resolves, seat 0's hand is 1 card (the Wastes) and seat 1's is 2. Seat 0 chooses seat 1 (the only opponent), the difference is 1, and seat 0 draws 1 card. Final: seat 0 hand two Wastes, library 7.

### 4. Why

1. The enters trigger triggers (603.6a) and resolves after the creature spell.
2. Hand sizes are counted once, when the effect is applied (608.2h): 2 versus 1.
3. Since the opponent has more, seat 0 draws 2 - 1 = 1 (121.1).

### 5. What phase did

Resolved the trigger and drew nothing.

### 6. Variations to test

- Equal hand sizes: no draw.
- Opponent has fewer cards: no draw (never a negative draw).
- Opponent has five, you have two: draw three.
- Multiplayer: the controller picks which opponent; picking the one with the most cards gives the most draws.
- Replacement effects on draws apply per card drawn (e.g. a "draw twice that many" effect doubles the count).

### 7. Acceptance checks

- With an opponent holding 2 cards and its controller holding 1, Sandstone Oracle's trigger draws exactly 1 card.
- The counts are taken as the trigger resolves, not as the creature was cast.
