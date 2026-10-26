# Spec: Venture Forth puts the land it finds onto the battlefield

Root cause (observed behaviour): phase exiles cards until it exiles a land, then puts that land back into the library instead of onto the battlefield.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-venture-forth`.

## 1. Card

- **Venture Forth** ({3}{G} sorcery): "Exile cards from the top of your library until you exile a land card. Put that card onto the battlefield and the rest on the bottom of your library in a random order. Exile Venture Forth with three time counters on it. Suspend 3—{1}{G}"

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Forest, Wastes ×3, Grizzly Bears; library: 8 Wastes. Seat 0 casts Venture Forth from hand.

## 3. Correct result

1. The top card (Wastes) is a land: exile it and stop.
2. Put that Wastes onto the battlefield under seat 0's control, **untapped** (nothing says tapped). No other cards were exiled.
3. Venture Forth is exiled with three time counters (it becomes suspended, since it has suspend).
Final: seat 0 battlefield has one more (untapped) Wastes, library **7**, exile [Venture Forth with 3 time counters].

## 4. Why

608.2c: instructions in order. "Put that card onto the battlefield" refers to the land card found; "the rest" are the nonland cards exiled before it (none here). The last sentence moves the spell to exile instead of the graveyard (608.2n applies only to a spell still on the stack). 702.62a: an exiled card with suspend and time counters is suspended.

## 5. What phase did

Log: "Wastes moves from library to exile", then "Wastes moves from exile to library"; library stayed at 8; no new land on the battlefield. Venture Forth was exiled with three time counters (correct).

## 6. Variations to test

- Library with nonland cards on top (e.g. Hill Giant, Divination, then Forest): Forest onto the battlefield, Hill Giant and Divination on the bottom in random order.
- Library with no land: all cards are exiled, then put on the bottom in a random order; nothing enters.
- Cast later from suspend (the suspend cast trigger): same result, and the card is exiled again with three time counters.
- Land played this way doesn't count as the turn's land play.

## 7. Acceptance checks

- After Venture Forth with a land on top of the library, that land is on the battlefield untapped, the library is one smaller, and Venture Forth is in exile with three time counters.
