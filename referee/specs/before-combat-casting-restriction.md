# Spec: "Cast this spell only before combat or during combat before blockers are declared"

Root cause (observed behaviour): phase refuses to cast Berserker's Frenzy in the precombat main phase ("Casting restriction not satisfied: DuringCombat"). The card explicitly allows casting before combat.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-berserker-s-frenzy` (verdict phase-error).

## 1. Card

- **Berserker's Frenzy** ({2}{R} instant): "Cast this spell only before combat or during combat before blockers are declared. Roll two d20 and ignore the lower roll. 1—14 | Choose any number of creatures. They block this turn if able. 15—20 | You choose which creatures block this turn and how those creatures block."
  - Ruling 2021-07-23: "If you roll doubles, ignore one of the rolls and use the result of the other."

## 2. Board and actions

Standard sweep board. Seat 0 (active, turn 2, **precombat main phase**, empty stack): Mountain, Wastes ×2, Grizzly Bears; hand: Berserker's Frenzy, Wastes. Seat 0 casts Berserker's Frenzy.

## 3. Correct result

The cast is legal. Berserker's Frenzy resolves: seat 0 rolls two d20, ignores the lower, and applies the matching row:
- 1–14: seat 0 chooses any number of creatures (possibly none); they must block this turn if able.
- 15–20: seat 0 will choose which creatures block this turn and how.
No combat happens in the sweep, so the board doesn't change apart from the spell going to the graveyard and the lands tapped. (Forge cast it without error; the verdict is phase-error because only phase refused.)

## 4. Why

1. 500.1: a turn is beginning, precombat main, combat, postcombat main, ending. The precombat main phase comes before the combat phase (505.1: the two main phases "are separated by the combat phase"), so it is "before combat".
2. The restriction allows "before combat" OR "during combat before blockers are declared", i.e. the beginning phase, the precombat main phase, and the beginning of combat and declare attackers steps (506.1, 509.1: blockers are declared in the declare blockers step). It forbids the declare blockers step onward, the postcombat main phase and the ending phase.
3. 601.3: a spell can be cast only if no rule or effect prohibits it; the card's own restriction is satisfied here, and it is an instant (117.1a).

## 5. What phase did

Refused the cast: "Action not allowed: Casting restriction not satisfied: DuringCombat". The restriction appears to be read as "during combat" only.

## 6. Variations to test

- Upkeep and draw step (beginning phase): castable.
- Opponent's turn, precombat main or upkeep: castable ("before combat" isn't limited to your turn).
- Beginning of combat step and declare attackers step: castable.
- Declare blockers step, combat damage step, end of combat step: not castable.
- Postcombat main phase and end step: not castable (combat already happened this turn).
- Take the Bait ("Cast this spell only during combat on an opponent's turn") must stay refused in a main phase (negative control; see `card-take-the-bait`).

## 7. Acceptance checks

- Berserker's Frenzy can be cast in the precombat main phase and in combat up to the declare attackers step.
- It can't be cast once blockers have been declared, or after combat.
