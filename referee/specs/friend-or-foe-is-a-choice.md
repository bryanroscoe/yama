# Spec: Zndrsplt's Judgment — the caster chooses friend or foe, then friends copy and foes bounce

Scenario: `card-zndrsplt-s-judgment` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: Forge makes seat 0 a friend (seat 0 gets a Grizzly Bears token) and seat 1 a foe (seat 1's Grizzly Bears returns to its hand). Phase logs a **vote** ("Player 1 voted friend", "Player 2 voted friend", "Vote resolved: friend: 2, foe: 0") and then nothing happens: no token, nothing returned.

## 1. Card

- **Zndrsplt's Judgment** ({4}{U} sorcery): "For each player, choose friend or foe. Each friend creates a token that's a copy of a creature they control. Each foe returns a creature they control to its owner's hand."

Rulings (Scryfall):
- "You make this choice for yourself as well as each other player. In some rare cases, you may wish to call yourself ... a foe. You can do that."
- "When Zndrsplt's Judgment resolves and you choose friend or foe, first the next friend in turn order (or, if it's a friend's turn, that friend) chooses a creature they control, then each other friend in turn order does the same, then each of those players create a token at the same time. ... Repeat this process for foes, who choose a creature one at a time and then return them all to their owners' hands at the same time."
- "Each token copies exactly what is printed on the original creature and nothing else ... It doesn't copy whether that creature is tapped or untapped, whether it has any counters on it ..."
- "You may call a player a friend or a foe even if that player will be instructed to perform an impossible action."
- "Friends perform their specified actions before foes."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Island, 4 Wastes and Grizzly Bears (its only creature). Seat 1 controls Grizzly Bears and Serra Angel (and Millstone, Seal of Fire). Seat 0 casts Zndrsplt's Judgment.

## 3. Correct result

1. Seat 0, the spell's controller, chooses friend or foe for each player, itself included (608.2d; ruling). This is not a vote: seat 1 makes no choice here (701.38a applies only to spells that say "vote").
2. Friends act first: each friend chooses a creature it controls (in turn order, starting with the active player if a friend), then all friends create their token copies at the same time (707.2: copiable values only, no counters or tapped status).
3. Then foes: each foe chooses a creature it controls, and those creatures all return to their owners' hands at the same time.

The designations are seat 0's AI's choice, so any of these four outcomes is correct on this board:

| seat 0 | seat 1 | Result |
|---|---|---|
| friend | foe | seat 0 gets a Grizzly Bears token; seat 1 returns Bears or Serra Angel to hand (Forge: Bears) |
| friend | friend | seat 0 gets a Bears token; seat 1 gets a token copy of Bears or Serra Angel |
| foe | foe | seat 0's Bears returns to hand; seat 1 returns Bears or Serra Angel |
| foe | friend | seat 0's Bears returns to hand; seat 1 gets a copy of Bears or Serra Angel |

In every case each player with a creature ends up with exactly one token more (friend) or one creature fewer on the battlefield (foe).

## 4. Why

- The card says "choose", and the controller of a resolving spell makes its choices (608.2d). Rulings confirm the caster designates every player, including itself.
- Each friend's "creates a token that's a copy of a creature they control" and each foe's "returns a creature they control" are mandatory (608.2c); each player chooses the creature when acting, it isn't targeted (115.10a).

## 5. What phase did

Asked both players to vote (both voted friend), and then created no token for either friend. Two errors: the choice belongs to the caster, and the friend (and foe) actions never happened. The second error matches `choices-on-resolution-not-acted-on.md`.

## 6. Variations to test

- **Seat 0 calls itself a foe** (legal, ruling): its own Bears returns to hand.
- **A friend with no creatures:** no token for that player; the spell still resolves for others.
- **Copy details:** a friend's tapped Bears with a +1/+1 counter gives an untapped 2/2 token with no counters.
- **Enters triggers:** copying a creature with an enters trigger (e.g. a token copy of Aether Channeler) triggers it.
- **Order:** friends' tokens are created before foes return their creatures; triggers from the tokens wait until the spell finishes resolving.
- Other "friend or foe" cards from the same set work the same way (e.g. Regna's Sanction: "For each player, choose friend or foe. Each friend puts a +1/+1 counter on each creature they control. Each foe chooses an untapped creature they control, and you tap the rest.").

## 7. Acceptance checks

- No vote is taken; seat 0 alone designates each player friend or foe.
- On the sweep board, each friend gets one token copy of a creature it controls and each foe returns one creature it controls to its owner's hand.
