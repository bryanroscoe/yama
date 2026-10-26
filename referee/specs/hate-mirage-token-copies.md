# Spec: Hate Mirage creates a token copy of each target creature

Scenario: `card-hate-mirage`. Observed: Forge gives seat 0 a Grizzly Bears token and a Serra Angel token. Phase creates no tokens.

## 1. Card

- **Hate Mirage** {3}{R}, Sorcery. "Choose up to two target creatures you don't control. For each of those creatures, create a token that's a copy of that creature. Those tokens gain haste. Exile them at the beginning of the next end step."

Rulings (2019-08-23):
- "If one of the two target creatures become illegal, you create one token that's a copy of the one that's still a legal target. You don't create two tokens."
- "Each token copies exactly what was printed on the original creature and nothing else (unless that creature is copying something else or is a token...). It doesn't copy whether that creature is tapped or untapped, whether it has any counters on it or Auras and Equipment attached to it, or any non-copy effects..."
- "Each token gains haste after it has been created. If something copies one of these tokens, the copy won't have haste, and you won't exile it at the beginning of the next end step."
- "Any enters-the-battlefield abilities of the copied creature will trigger when the token enters the battlefield."

## 2. Board and actions

Sweep board: seat 0 has Mountain + 3 Wastes and Grizzly Bears. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts Hate Mirage targeting seat 1's Grizzly Bears and Serra Angel (scripted); it resolves in seat 0's precombat main phase. The run stops before the end step.

## 3. Correct result

- Seat 0 controls two new tokens: "Grizzly Bears" (Creature — Bear, 2/2) and "Serra Angel" (Creature — Angel, 4/4, flying, vigilance), both with haste, both owned by seat 0.
- Seat 1's originals are unchanged.
- A delayed trigger will exile both tokens at the beginning of the next end step (not reached in this scenario).

## 4. Why

1. Both targets are legal on resolution (608.2b).
2. For each, a token is created that copies the creature's copiable values (707.2, 707.1): name, types, P/T, abilities as printed.
3. "Those tokens gain haste" is a separate effect on the tokens (layer 6, 613.1f).
4. "Exile them at the beginning of the next end step" creates a delayed triggered ability (603.7).

## 5. What phase did

Targeted both creatures and resolved, but created no tokens.

## 6. Variations to test

- One target becomes illegal before resolution: one token only.
- Zero targets ("up to two"): legal, nothing happens.
- Target has +1/+1 counters or an Aura: the token has neither.
- Target is itself a token (e.g. a 3/3 Elephant token): the copy is the original token definition.
- Target is copying something else: the token is that copied thing.
- At the next end step both tokens are exiled; a copy of one of the tokens made by another effect isn't.
- A copied creature with an enters trigger triggers for the token, controlled by seat 0.

## 7. Acceptance checks

- Hate Mirage with two legal targets gives its caster two token copies with haste.
- The tokens are exiled at the beginning of the next end step.
