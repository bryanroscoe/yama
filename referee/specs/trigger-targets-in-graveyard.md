# Spec: triggered abilities that target cards in a graveyard

Root cause (observed behaviour): three enters-the-battlefield triggers whose target is a card in a graveyard never went through target selection in phase (no "is targeted by" line, and the referee runner was never asked for a trigger target). Two did nothing at all although legal targets existed; the third returned a card that wasn't a legal target.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-necromancy`, `card-mysterious-stranger`, `card-spellpyre-phoenix`.

## 1. Cards

Oracle text and rulings from Scryfall.

- **Necromancy** ({2}{B} enchantment): "You may cast this spell as though it had flash. If you cast it any time a sorcery couldn't have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step. When this enchantment enters, if it's on the battlefield, it becomes an Aura with 'enchant creature put onto the battlefield with Necromancy.' Put target creature card from a graveyard onto the battlefield under your control and attach this enchantment to it. When this enchantment leaves the battlefield, that creature's controller sacrifices it."
  - "The sacrifice occurs only if you cast it using its own ability."
  - "Necromancy enters as an enchantment and then becomes an Enchant Creature Aura as a triggered ability upon entering. It follows all the rules for Auras from then on."
  - "The bringing of the creature onto the battlefield and then putting Necromancy on it is all done as part of the resolution."
- **Mysterious Stranger** ({2}{R}{R} creature — Human Rogue 3/2): "Flash. When this creature enters, for each graveyard with an instant or sorcery card in it, exile target instant or sorcery card from that graveyard. If two or more cards are exiled this way, choose one of them at random and copy it. You may cast the copy without paying its mana cost."
- **Spellpyre Phoenix** ({3}{R}{R} creature — Phoenix 4/2): "Flying. When this creature enters, you may return target instant or sorcery card with a cycling ability from your graveyard to your hand. At the beginning of each end step, if you cycled two or more cards this turn, return this card from your graveyard to your hand."
- **Divination** (sorcery, {2}{U}): "Draw two cards." It has no cycling ability.
- **Hill Giant**: creature card, 3/3.

## 2. Board and actions

Standard sweep board: game turn 2, seat 0 active in precombat main, stack empty. Seat 0 has the lands for the card plus Grizzly Bears; graveyard Hill Giant and Divination. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire; graveyard Hill Giant only. Seat 0 casts the card (sorcery timing, no targets); it resolves; its enters trigger goes on the stack.

## 3. Correct result

**Necromancy.** Legal targets: either Hill Giant (seat 0's or seat 1's). The runner's preference, and Forge's pick, is seat 1's Hill Giant.
1. Necromancy enters; the trigger's intervening "if" (it's on the battlefield) is true when it triggers and when it resolves (603.4).
2. Putting it on the stack, seat 0 targets a creature card in a graveyard (115.1d, 603.3d).
3. On resolution Necromancy becomes an Aura with that enchant ability, the targeted Hill Giant enters under seat 0's control, and Necromancy is attached to it.
4. It was cast at sorcery timing, so there is no cleanup-step sacrifice.

Final (target = seat 1's Hill Giant): seat 0 controls Hill Giant (owner seat 1, 3/3) with Necromancy attached to it; seat 1's graveyard is empty. (Forge: exactly this.)

**Mysterious Stranger.** Only seat 0's graveyard has an instant or sorcery card (Divination); seat 1's has only Hill Giant. So the trigger has exactly one target, Divination (the number of targets is set by the text, 601.2c). On resolution Divination is exiled. Only one card was exiled, so nothing is copied. Final: seat 0 exile [Divination], graveyard [Hill Giant]. (Forge: exactly this.)

**Spellpyre Phoenix.** The only instant or sorcery card in seat 0's graveyard is Divination, which has no cycling ability, so the trigger has no legal target. A targeted trigger with no legal target is removed from the stack (603.3d). Nothing happens: Divination stays in the graveyard, seat 0's hand is [Wastes]. (Forge: exactly this.)

## 4. Why

1. A triggered ability that says "target" is targeted; the targets are chosen as it's put on the stack (115.1d, 603.3d, using 601.2c).
2. A target must meet every part of the description: "creature card", "instant or sorcery card from that graveyard", "instant or sorcery card with a cycling ability from your graveyard" (601.2c, 115.1d). Divination isn't a legal target for Spellpyre Phoenix.
3. If a required target can't be chosen the ability is removed from the stack (603.3d); if it can, the ability must take it and then do what it says on resolution (608.2b, 608.2c).
4. Mysterious Stranger's number of targets is defined by the game state (one per graveyard with an instant or sorcery card in it), fixed when the ability goes on the stack (601.2c).
5. Necromancy's intervening "if" is checked on trigger and on resolution (603.4); it's on the battlefield both times.

## 5. What phase did

- Necromancy: entered, and nothing else happened (no target, no creature returned; Necromancy stays as a non-Aura enchantment).
- Mysterious Stranger: entered, and nothing else happened (Divination stays in the graveyard).
- Spellpyre Phoenix: returned **Divination** to seat 0's hand, with no target step.

## 6. Variations to test

- **Necromancy targeting your own graveyard:** remove seat 1's Hill Giant; it must return seat 0's Hill Giant.
- **Necromancy with no creature cards in any graveyard:** the trigger is removed from the stack; Necromancy stays on the battlefield as an enchantment (not an Aura) and nothing is sacrificed.
- **Necromancy cast at instant speed** (e.g. on seat 1's turn, or in response with something on the stack): the creature returns, and at the next cleanup step Necromancy is sacrificed, so the creature is sacrificed too.
- **Necromancy leaves the battlefield** (e.g. Disenchant it): the creature's controller sacrifices the creature.
- **Mysterious Stranger with an instant or sorcery in both graveyards** (put a Lightning Bolt in seat 1's graveyard): two targets, one per graveyard; both are exiled; one is chosen at random and copied; seat 0 may cast the copy for free (a Bolt copy then needs its own target).
- **Mysterious Stranger with none in any graveyard:** no targets, the trigger is removed, nothing happens.
- **Spellpyre Phoenix with a legal target:** put Censor ({1}{U} instant, "Counter target spell unless its controller pays {1}. Cycling {U}") in seat 0's graveyard next to Divination. Only Censor can be targeted; seat 0 may return it (the "may" is chosen on resolution).
- Check that the runner sees a trigger target step for each of these (the scenario's `trigger_targets` gets filled), so Forge replays the same target.

## 7. Acceptance checks

- Necromancy on the sweep board: one Hill Giant is on the battlefield under seat 0's control with Necromancy attached to it.
- Mysterious Stranger on the sweep board: Divination is in seat 0's exile; nothing is copied or cast.
- Spellpyre Phoenix on the sweep board: Divination stays in seat 0's graveyard; seat 0's hand is just the Wastes.
- Each of these triggers asks for (or skips, when there's none) a target as it's put on the stack, and the log shows the targeting.

## Added from triage batch 1: Goblin Dark-Dwellers

Scenario: `card-goblin-dark-dwellers`. Same symptom: phase's log has no "is targeted by" line for the trigger and the scenario's `trigger_targets` stayed empty, though Divination (sorcery, mana value 3) is a legal target in seat 0's graveyard. Forge targeted Divination, cast it free (seat 0 drew two) and exiled it.

- **Goblin Dark-Dwellers** ({3}{R}{R} creature — Goblin 4/4): "Menace. When this creature enters, you may cast target instant or sorcery card with mana value 3 or less from your graveyard without paying its mana cost. If that spell would be put into your graveyard, exile it instead."
  - Rulings 2016-01-22: "You cast the card during the resolution of the enters-the-battlefield ability, not later in the turn. If it's a sorcery card, ignore the timing restrictions based on it being a sorcery card." "If you can't cast the target instant or sorcery card ... or if you choose not to cast it, it will remain in your graveyard."

Correct result: the trigger goes on the stack targeting Divination (603.3d; the "may" doesn't keep it off the stack, 603.5). On resolution seat 0 may cast Divination free (608.2g); if it does, it draws two (hand three Wastes, library 6) and Divination is exiled instead of going to the graveyard. Declining leaves Divination in the graveyard; that end state is legal, but the trigger must still have been put on the stack with its target.

Acceptance: Goblin Dark-Dwellers' trigger targets Divination when it's put on the stack; casting it draws two and exiles Divination.
