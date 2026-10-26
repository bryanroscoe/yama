# Spec: Ethereal Valkyrie exiles the card face down and foretold

Scenario: `card-ethereal-valkyrie` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: both engines draw a Wastes and exile one. Forge's exile shows "(face down)"; phase's shows "Wastes" (the referee runner prints "(face down)" for any face-down object, so phase exiled it face up).

## 1. Card

- **Ethereal Valkyrie** ({4}{W}{U} creature — Spirit Angel 4/4): "Flying. Whenever this creature enters or attacks, draw a card, then exile a card from your hand face down. It becomes foretold. Its foretell cost is its mana cost reduced by {2}. (On a later turn, you may cast it for its foretell cost, even if this creature has left the battlefield.)"

Rulings (Scryfall):
- "Because the card in exile becomes foretold, you can look at it in exile. (Most effects that have you exile a card face down don't allow you to look at the card in exile.)"
- "The reduction of the foretell cost applies only to generic mana in the foretell cost. It can't reduce requirements of specific colors of mana."
- "If the card you exile has foretell, it will have two foretell costs ... You may cast that card for either of its foretell costs."
- "Although the card you exile becomes foretold, you did not foretell it. An ability that triggers whenever you foretell a card will not trigger."
- "Casting a foretold card from exile follows the timing rules for that card."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with the lands for the card and Grizzly Bears; hand Ethereal Valkyrie and a Wastes; library 8 Wastes. Seat 0 casts Ethereal Valkyrie; it resolves; its enters trigger resolves.

## 3. Correct result

1. Seat 0 draws a Wastes (hand: two Wastes; library 7).
2. Seat 0 exiles one card from its hand **face down** (406.3). That card becomes foretold (702.143d); its foretell cost is its mana cost reduced by {2} (a Wastes has no mana cost, so it can't be cast anyway, as a land).
3. Seat 0 may look at the card; other players can't (406.3, ruling).

Final: seat 0 hand [Wastes], library 7, exile holds one face-down card; any view of the state that isn't seat 0's shows it as face down, not as "Wastes". (Forge: exactly this.)

## 4. Why

- "Exile ... face down" (406.3): a card exiled face down can't be examined by any player except when instructions allow; here the foretold status lets its owner look (702.143d).
- 702.143d: a card that "becomes foretold" may be cast for its foretell cost after the turn it became foretold.

## 5. What phase did

Exiled the Wastes face up: the referee's state shows its name in exile.

## 6. Variations to test

- **A spell with a mana cost.** Hand is Lightning Bolt instead of the Wastes, and the drawn card is a Wastes; seat 0 exiles Lightning Bolt face down. On seat 1's next turn (after this turn ends), seat 0 may cast it from exile for {R} (generic reduction can't go below the coloured part, ruling). It can't be cast from exile this turn.
- **Generic reduction.** Exile Hill Giant ({3}{R}): foretell cost {1}{R}; castable on a later turn.
- **Card with its own foretell.** Exile a card that has foretell: it can be cast for either foretell cost.
- **Attack trigger.** The same trigger on attack exiles face down too.
- **Hidden from the opponent.** The opponent's view of the game (and any event or log visible to the opponent) must not reveal the exiled card's name.
- **"Whenever you foretell" doesn't trigger.** With a card that triggers when you foretell, this exile doesn't trigger it (ruling).

## 7. Acceptance checks

- After the trigger, the exiled card is face down; the referee state prints "(face down)" for it.
- Its owner can still identify it, and it's marked as foretold with a foretell cost of its mana cost minus up to {2} generic.
