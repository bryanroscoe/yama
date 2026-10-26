# Spec: "put that card into your graveyard unless you pay 2 life"

Root cause (observed behaviour): phase charged the life for some cards but still put those cards into the graveyard. Paying the "unless" cost did not stop the action it was paid to stop.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-moonlight-bargain`.

## 1. Card

Oracle text from Scryfall (no rulings published).

- **Moonlight Bargain** ({3}{B}{B} instant): "Look at the top five cards of your library. For each card, put that card into your graveyard unless you pay 2 life. Then put the rest into your hand."

## 2. Board and actions

Seat 0 (active, main phase 1) at 20 life, library 8 Wastes, hand one Wastes. Seat 0 casts Moonlight Bargain; it resolves. How many times to pay is the AI's choice.

## 3. Correct result

For each of the five cards seat 0 either pays 2 life (the card is kept and goes to hand at the end) or doesn't (the card goes to the graveyard). If seat 0 paid k times:

- life 20 − 2k;
- k Wastes go to seat 0's hand (hand 1 + k);
- 5 − k Wastes go to seat 0's graveyard;
- library 8 → 3.

So the life lost and the cards kept always match: **every 2 life paid keeps one card out of the graveyard.** (Forge: paid 0 times, 5 Wastes to graveyard, life 20.)

## 4. Why

1. 118.12a: "[Do something] unless [a player does something else]" means "[A player may do something else]. If [that player doesn't], [do something]." So for each card: seat 0 may pay 2 life; if seat 0 doesn't, that card goes to the graveyard. If seat 0 pays, it doesn't.
2. 119.4: paying life subtracts it from the life total; a player can pay 2 life only with at least 2 life.
3. "Then put the rest into your hand": the cards that weren't put into the graveyard go to hand (608.2c).

## 5. What phase did

Logged "Player 1 loses 2 life" twice and "Wastes moves from library to graveyard" five times. Final: life 16, all five Wastes in the graveyard, nothing added to hand (hand still one Wastes). That is 4 life paid for nothing.

## 6. Variations to test

- **Pay for all five:** life 10, hand 6, graveyard gets nothing from library.
- **Pay for none:** life 20, five cards to graveyard, nothing to hand.
- **Low life:** at 3 life, seat 0 can pay at most once (119.4); at 1 life it can't pay.
- **Fewer than five cards in library:** look at all of them; same per-card choice.
- **Same "unless pays" pattern on other cards:** e.g. "counter target spell unless its controller pays {3}" (Mana Leak): paying prevents the counter; not paying doesn't.

## 7. Acceptance checks

- After Moonlight Bargain resolves, (20 − life) / 2 equals the number of the five cards that went to the hand, and the others are in the graveyard.
- A card for which 2 life was paid never ends in the graveyard.
