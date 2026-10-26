# Spec: Denry Klin's own entry triggers its counter-copying ability

Root cause (observed behaviour): Denry Klin enters with its chosen counter, and its "whenever a nontoken creature you control enters" ability should see Denry itself entering and double that counter. phase ends with one counter.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-denry-klin-editor-in-chief`.

## 1. Card

- **Denry Klin, Editor in Chief** ({2}{W}{U} legendary creature — Cat Advisor 2/2): "Denry Klin enters with your choice of a +1/+1, first strike, or vigilance counter on it. Whenever a nontoken creature you control enters, if Denry Klin has counters on it, put the same number of each kind of counter on that creature."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains, Island, Wastes ×2, Grizzly Bears. Seat 0 casts Denry Klin. The counter kind is seat 0's choice (phase chose vigilance, Forge +1/+1).

## 3. Correct result

1. Denry enters with one counter of the chosen kind (replacement effect, so it is on Denry as it enters).
2. Denry is a nontoken creature seat 0 controls that entered, so its second ability triggers on itself; the "if Denry Klin has counters on it" condition is true at trigger time and at resolution.
3. On resolution: put the same number of each kind of counter Denry has (one of the chosen kind) on "that creature", which is Denry. Denry now has **two** counters of that kind.
- With phase's choice (vigilance): Denry 2/2 with 2 vigilance counters.
- With Forge's choice (+1/+1): Denry 4/4 with 2 +1/+1 counters (Forge's result).

## 4. Why

1. 614.1c: "enters with" is a replacement effect; 122.6: those counters are put on it as it enters.
2. 603.6a: "Each time an event puts one or more permanents onto the battlefield, all permanents on the battlefield (including the newcomers) are checked for any enters-the-battlefield triggers that match the event." Denry checks its own entry.
3. 603.4: intervening "if" is checked when the event happens and on resolution; Denry has a counter both times.
4. 122.1b: a vigilance counter is a keyword counter; a second one is still a counter on the permanent (the keyword is redundant, the counter count is 2).

## 5. What phase did

Denry ended with 1 vigilance counter. The log shows "Denry Klin's effect resolves", "1 vigilance counter on Denry Klin", "Denry Klin's effect resolves": a second effect resolved but added nothing.

## 6. Variations to test

- Each counter choice (+1/+1, first strike, vigilance): Denry ends with 2 of that kind.
- Another nontoken creature entering later (e.g. casting Grizzly Bears): it gets the same number of each kind Denry has (2).
- A token creature entering: no trigger.
- Denry with counters of several kinds (e.g. after proliferate or a +1/+1 counter from elsewhere): the entering creature gets each kind in the same numbers.
- If Denry loses all counters before the trigger resolves: nothing happens (intervening if).

## 7. Acceptance checks

- On an empty-of-modifiers board, Denry Klin ends its entry with two counters of the chosen kind.
- A nontoken creature entering later under the same controller gets copies of all of Denry's counters.
