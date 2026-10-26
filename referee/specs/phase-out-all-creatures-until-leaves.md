# Spec: Out of Time phases out all creatures and counts them

Root cause (observed behaviour): Out of Time's enters trigger resolves in phase with no visible effect: no creature phases out and Out of Time gets no time counters.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-out-of-time`.

Note on the evidence: phase's referee state lists phased-out permanents as if they were on the battlefield (Brokers Confluence in the same sweep, where phase's log says "phased out" but the creatures still show). So the board alone can't show whether phase phased the creatures out. Here, though, phase's log has no "phased out" lines at all, and Out of Time has no counters, so the trigger did nothing.

## 1. Card

- **Out of Time** ({1}{W}{W} enchantment): "When this enchantment enters, untap all creatures, then those creatures phase out until this enchantment leaves the battlefield. Put a time counter on this enchantment for each creature that phased out this way. Vanishing (At the beginning of your upkeep, remove a time counter from this enchantment. When the last is removed, sacrifice it.)"
  - Rulings 2021-06-18: "A creature phased out by Out of Time doesn't phase in during its controller's untap step as normal." "If there are no creatures on the battlefield when Out of Time's triggered ability resolves, nothing phases out and Out of Time won't get any time counters."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains, Plains, Wastes, Grizzly Bears. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Out of Time; its enters trigger resolves.

## 3. Correct result

- All creatures untap (none were tapped), then all three creatures phase out: seat 0's Grizzly Bears, seat 1's Grizzly Bears and Serra Angel. They are treated as though they don't exist.
- Out of Time gets **3 time counters**.
- Millstone, Seal of Fire, lands: unaffected.

## 4. Why

1. 608.2c: the instructions are followed in order: untap all creatures, then phase out "those creatures", then count.
2. 702.26b: a phased-out permanent is treated as though it does not exist. 702.26d: it doesn't change zones; counters stay.
3. Phasing out "until this enchantment leaves the battlefield" replaces the normal phase-in during the untap step (ruling).
4. 702.63b: vanishing without a number has only the upkeep counter-removal and sacrifice parts; the counters come from the trigger.

## 5. What phase did

No "phased out" log lines; Out of Time had no counters. Forge: three creatures phased out (absent from its state), Out of Time with 3 time counters.

## 6. Variations to test

- At seat 0's next upkeep, one time counter is removed (2 left); the creatures stay phased out through both players' untap steps.
- When the last counter is removed, Out of Time is sacrificed and the creatures phase in (untapped, keeping counters and Auras).
- Out of Time destroyed early: creatures phase in immediately.
- Auras/Equipment on a creature phase out with it (702.26g).
- No creatures on the battlefield: no counters, Out of Time stays forever (ruling).
- The referee state should mark phased-out permanents (harness side; see the Brokers Confluence note).

## 7. Acceptance checks

- After Out of Time's trigger on this board, all three creatures are phased out and Out of Time has three time counters.
- The phased-out creatures don't phase in during their controllers' untap steps while Out of Time remains.
