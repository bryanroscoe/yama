# Spec: Empower Jace N (Jace's Machinations)

Root cause (observed behaviour): phase resolves Jace's Machinations without creating a Jace token or putting loyalty counters on anything.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-jace-s-machinations`.

## 1. Card

- **Jace's Machinations** ({2}{U} instant): "Until end of turn, you may activate loyalty abilities of Jace planeswalkers you control on any player's turn any time you could cast an instant. Empower Jace 8. (Put eight loyalty counters on a Jace token you control. If you don't control one, first create a blue Jace planeswalker token with "[−1]: Surveil 1" and "[−3]: Draw a card.")"
  - Ruling 2026-08-21: "To empower Jace N, if you don't control a Jace planeswalker token, create a blue Jace planeswalker token with 0 loyalty, "[−1]: Surveil 1," and "[−3]: Draw a card." Choose a Jace planeswalker token you control. Put N loyalty counters on it."
  - Ruling 2026-08-21: "If you control a Jace planeswalker token, you can't choose to create a new one when you empower Jace." "Empower Jace won't let you put loyalty counters on nontoken Jace planeswalkers."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Island, Wastes ×2, Grizzly Bears. Seat 0 controls no planeswalkers. Seat 0 casts Jace's Machinations.

## 3. Correct result

Seat 0 creates a blue Jace planeswalker token (Planeswalker — Jace, abilities [−1]: Surveil 1 and [−3]: Draw a card) with 0 loyalty, then puts 8 loyalty counters on it. It ends with **8 loyalty** and stays on the battlefield. Until end of turn seat 0 may activate its loyalty abilities at instant speed (still once per turn per permanent).

## 4. Why

1. 701.71a defines Empower Jace N exactly as in the ruling above.
2. State-based actions are not checked during resolution; by the time they are (704.3), the token has 8 loyalty, so 704.5i (planeswalker with 0 loyalty goes to the graveyard) does not apply.
3. The token isn't given a starting loyalty by 306.5b (it has no printed loyalty); its loyalty comes only from the counters.

## 5. What phase did

Jace's Machinations went to the graveyard; no token, nothing else changed. Forge: a Jace token with 8 loyalty counters.

## 6. Variations to test

- Seat 0 already controls a Jace planeswalker token with 3 loyalty: no new token; it goes to 11.
- Seat 0 controls a nontoken Jace planeswalker only: a token is created and gets the counters (the nontoken Jace gets none).
- The instant-speed permission: on the opponent's turn after Machinations, seat 0 may activate the token's −1 in response to a spell, once that turn.
- Other "empower Jace" cards with targets: if all targets are illegal on resolution, no token is created.

## 7. Acceptance checks

- With no Jace token, Jace's Machinations leaves its caster with a blue Jace planeswalker token with 8 loyalty.
- With an existing Jace token, that token gains 8 loyalty and no new token appears.
