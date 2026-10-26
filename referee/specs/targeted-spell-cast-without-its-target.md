# Spec: a targeted spell is cast without its target

Root cause (observed behaviour): for some spells whose text requires a target, phase casts the spell without choosing one (or, for Psionic Ritual, chooses it but then acts as if it had none). The spell then goes to the graveyard without its effect (Zenith Flare, Immortal Obligation, Psionic Ritual), an Aura enters attached to nothing and dies (Minimus Containment), the "target" is picked on resolution (Whirlpool Whelm), or a spell with no legal target at all is cast anyway (Refuse). Forge, given phase's empty target list, refused: "phase chose no targets, but Forge's ability needs one".

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-zenith-flare`, `card-minimus-containment`, `card-immortal-obligation`, `card-whirlpool-whelm`, `card-refuse`, `card-psionic-ritual`.

## 1. Cards

Oracle text and rulings from Scryfall.

- **Zenith Flare** ({2}{R}{W} instant): "Zenith Flare deals X damage to any target and you gain X life, where X is the number of cards with a cycling ability in your graveyard." Ruling (2020-04-17): "If the chosen target is an illegal target by the time Zenith Flare tries to resolve, the spell won't resolve. You won't gain X life."
- **Minimus Containment** ({2}{W} Enchantment — Aura): "Enchant nonland permanent. Enchanted permanent is a Treasure artifact with '{T}, Sacrifice this artifact: Add one mana of any color,' and it loses all other abilities. (If it was a creature, it's no longer a creature.)" Rulings: the enchanted creature stops being a creature; it keeps its name, colors, mana cost and mana value.
- **Immortal Obligation** ({1}{W} instant): "Return target creature card from an opponent's graveyard to the battlefield under their control with a duty counter on it. For as long as that creature has a duty counter on it, it is goaded, can't attack you or a permanent you control, and can't block creatures you control."
- **Whirlpool Whelm** ({1}{U} instant): "Clash with an opponent, then return target creature to its owner's hand. If you win, you may put that creature on top of its owner's library instead." Ruling (2007-10-01): "You choose the target when you play Whirlpool Whelm, not when you clash."
- **Refuse** ({3}{R} instant, the first half of Refuse // Cooperate): "Refuse deals damage to target spell's controller equal to that spell's mana value."
- **Psionic Ritual** ({4}{U}{U} sorcery): "Replicate—Tap an untapped Horror you control. (When you cast this spell, copy it for each time you paid its replicate cost. You may choose new targets for the copies.) Exile target instant or sorcery card from a graveyard and copy it. You may cast the copy without paying its mana cost. Exile Psionic Ritual."
- Board cards: Divination ({2}{U} sorcery, "Draw two cards."; no cycling), Hill Giant (creature card, 3/3, mana value 4).

## 2. Board and actions

Standard sweep board: seat 0 (active, precombat main, empty stack) controls exactly the lands for the card's mana cost plus Grizzly Bears; hand: the card and a Wastes; graveyard Hill Giant, Divination; library 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel, Millstone, Seal of Fire; hand 2 Wastes; graveyard Hill Giant; library 8 Wastes. Seat 0 casts the card for its mana cost (no alternative or additional costs). No other spell is on the stack. Seat 0 controls no Horror.

## 3. Correct result

**Zenith Flare.** "Any target" is required (115.4): seat 0 must choose a creature, player or planeswalker (either Grizzly Bears, Serra Angel, or either player). X = 0 (no card with a cycling ability in seat 0's graveyard), so it deals 0 damage and seat 0 gains 0 life. Final state: unchanged apart from tapped lands and Zenith Flare in seat 0's graveyard. (The board result equals phase's; the difference is that a target must be chosen, and the spell resolves rather than being removed.)

**Minimus Containment.** An Aura spell is targeted; its target is a nonland permanent (303.4a, 115.1b, 702.5a). Legal: either Grizzly Bears, Serra Angel, Millstone, Seal of Fire. On resolution it enters attached to that permanent, which becomes an artifact with subtype Treasure, loses all other abilities and card types (a creature stops being a creature, so it has no power/toughness), and gains the Treasure mana ability. With the runner's preference (an opponent's creature first): seat 1's Grizzly Bears or Serra Angel becomes a noncreature Treasure artifact with Minimus Containment attached.

**Immortal Obligation.** The only creature card in an opponent's graveyard is seat 1's Hill Giant, so it must be the target. On resolution Hill Giant enters the battlefield under seat 1's control with a duty counter (goaded, can't attack seat 0 or its permanents, can't block seat 0's creatures). Final: seat 1 controls Hill Giant (3/3, counters {duty: 1}); seat 1's graveyard is empty; Immortal Obligation in seat 0's graveyard.

**Whirlpool Whelm.** The target creature is chosen as the spell is cast (115.1a, 601.2c, ruling). On resolution seat 0 clashes with seat 1: both reveal a Wastes (mana value 0), neither wins (701.30), each may put the revealed card on the bottom. The targeted creature returns to its owner's hand. With the runner's preference, seat 1's Grizzly Bears (or Serra Angel) goes to seat 1's hand.

**Refuse.** The target is a spell. While Refuse is being cast, the only spell on the stack is Refuse itself, and a spell is an illegal target for itself (115.5). There is no legal target, so Refuse can't be cast (601.2, 601.2c): the game returns to before the cast. Final: Refuse still in seat 0's hand, lands untapped, nothing else changes.

**Psionic Ritual.** Replicate can't be paid (no Horror), so there are no copies. The target must be an instant or sorcery card in a graveyard: Divination (seat 0's) is the only one. On resolution Divination is exiled and copied; seat 0 may cast the copy without paying its mana cost (if it does, it draws two Wastes); then Psionic Ritual is exiled. Final (copy cast): seat 0 exile [Divination, Psionic Ritual], graveyard [Hill Giant], hand [Wastes, Wastes, Wastes], library 6. (Copy not cast: hand [Wastes], library 8, the same exile.)

## 4. Why

1. 115.1a: an instant or sorcery that says "target [something]" is targeted, and the targets are chosen as it's cast (601.2c). 115.1b / 303.4a: an Aura spell always targets, as its enchant ability says.
2. 601.2: if a step of casting can't be completed (no legal target for a required target), the cast is illegal and is undone. Refuse has no legal target (115.5).
3. 608.2b: a spell is removed without resolving only if **all** its targets are illegal on resolution. A spell whose target is still legal resolves fully: Psionic Ritual's Divination is still in the graveyard, so it resolves (exile, copy, may cast) and then exiles itself.
4. 608.2c: "Exile Psionic Ritual" is part of its resolution; it doesn't go to the graveyard.
5. 704.5m: an Aura not attached to anything is put into its owner's graveyard, which happens to an Aura that entered without being attached; a correctly targeted Aura spell enters attached to its target (608.3c).
6. Whirlpool Whelm ruling: the target is fixed at cast, so it can't be picked during resolution (and a creature with hexproof/shroud couldn't be chosen).

## 5. What phase did

- Zenith Flare: no target logged or recorded; the spell went from the stack to the graveyard without an "effect resolves" line.
- Minimus Containment: no target; it entered the battlefield and was immediately put into the graveyard; no permanent became a Treasure.
- Immortal Obligation: no target; went to the graveyard without resolving; Hill Giant stayed in seat 1's graveyard.
- Whirlpool Whelm: no target at cast; on resolution it clashed and returned **seat 0's own** Grizzly Bears to seat 0's hand (picked during resolution, never targeted).
- Refuse: cast with no target; resolved doing nothing (should not have been castable).
- Psionic Ritual: logged "Divination is targeted by Psionic Ritual" (the referee runner recorded no target), then went from the stack to **the graveyard** without resolving; Divination stayed in the graveyard; nothing was copied or cast.

## 6. Variations to test

- Zenith Flare with two cycling cards in seat 0's graveyard (e.g. two copies of a card with cycling): X = 2; 2 damage to the target, seat 0 gains 2. With the target gone before resolution: no damage and no life gain (ruling).
- Zenith Flare / Whirlpool Whelm / Minimus Containment when the only creatures have hexproof (from the caster's opponent) or shroud: those can't be chosen.
- Minimus Containment on Millstone: Millstone becomes a Treasure artifact without its mill ability; on seat 1's Grizzly Bears: no longer a creature (no P/T), can be sacrificed for one mana of any color.
- Immortal Obligation with no creature card in any opponent's graveyard: it can't be cast. With a creature card only in seat 0's own graveyard: still can't be cast (must be an opponent's graveyard).
- Whirlpool Whelm where seat 0's top card has a higher mana value (win the clash): seat 0 may put the creature on top of its owner's library.
- Refuse with seat 1's Lightning Bolt on the stack: target the Bolt; Refuse deals 1 damage to seat 1 (Bolt's controller); the Bolt still resolves.
- Psionic Ritual with a Horror (replicate paid once): one copy, which may target another instant or sorcery card in a graveyard (e.g. seat 1's, if it has one).
- Psionic Ritual with no instant or sorcery card in any graveyard: it can't be cast.

## 7. Acceptance checks

- Every one of these spells asks for its target while it's being cast, and can't be cast without one.
- Refuse can't be cast when no other spell is on the stack.
- On the sweep board, Immortal Obligation returns seat 1's Hill Giant under seat 1's control with a duty counter.
- Minimus Containment ends attached to the chosen nonland permanent, which is a noncreature Treasure artifact.
- Psionic Ritual exiles Divination, offers its copy for free, and ends in exile, not the graveyard.
- Whirlpool Whelm returns the creature chosen at cast, not one picked as it resolves.

---

## Part B (sweep v6, batch 6): more targeted spells cast without their target, or with part of it missing

Same root cause: the spell's text requires a target (a player, or an Aura's enchant target), phase casts it without one, and the effect that depends on it doesn't happen. Scenarios (standard sweep board): `card-death-by-dragons`, `card-teferi-s-reproach`, `card-release-to-memory`, `card-become-the-pilot` (all "phase chose no targets, but Forge's ability needs one"), `card-domineering-will` (player target missing; Forge refused the creature as the first target), `card-exterminate` (the Psionic Ritual pattern: a target is logged but the spell does nothing).

### B.1 Cards (Oracle text and rulings, Scryfall)

- **Death by Dragons** ({4}{R}{R} sorcery): "Each player other than target player creates a 5/5 red Dragon creature token with flying." Rulings (2011-09-22): if the player is an illegal target on resolution, nothing happens; "If Death by Dragons resolves, the player who's targeted is the only one who won't put a Dragon token onto the battlefield."
- **Teferi's Reproach** ({2}{W} instant): "Choose target opponent. Until that player's next turn, they gain protection from everything and their life total can't change. All nonland permanents they control phase out. (...) Exile Teferi's Reproach."
- **Release to Memory** ({3}{W} instant): "Exile target opponent's graveyard. For each creature card exiled this way, create a 1/1 colorless Spirit creature token."
- **Domineering Will** ({3}{U} instant): "Target player gains control of up to three target nonattacking creatures until end of turn. Untap those creatures. They block this turn if able." Rulings: the creatures don't gain haste; they block only if able as blockers are declared.
- **Become the Pilot** ({3}{U}{U} Enchantment — Aura): "Enchant noncommander creature. You control enchanted creature. Enchanted creature gets +2/+2 and can't be blocked unless it's attacking its owner or a permanent its owner controls."
- **Exterminate!** ({2}{B} sorcery): "Replicate—Tap an untapped Dalek you control. (When you cast this spell, copy it for each time you paid its replicate cost. You may choose new targets for the copies.) Destroy target creature. Its controller loses 3 life."

### B.2 Correct result (sweep board; seat 0 casts for the mana cost; seat 0 controls no Dalek)

- **Death by Dragons**: one target player is required. If seat 1 is targeted, seat 0 creates one 5/5 red flying Dragon token; if seat 0 is targeted, seat 1 does. Exactly one Dragon either way.
- **Teferi's Reproach**: the only opponent, seat 1, must be the target. Seat 1's Grizzly Bears, Serra Angel, Millstone and Seal of Fire phase out (treated as not existing; the referee state omits phased-out permanents); seat 1 has protection from everything and its life total can't change until its next turn; Teferi's Reproach is exiled.
- **Release to Memory**: seat 1 is the target; its Hill Giant is exiled and seat 0 creates one 1/1 colorless Spirit. (phase's board already matches; only the missing target is wrong.)
- **Domineering Will**: two target instances: one target player and up to three target nonattacking creatures (any creatures here; none is attacking). With seat 0 as the player and seat 1's Grizzly Bears (the runner's pick): seat 0 controls the Bears until end of turn, untapped. With [seat 0; seat 1's Bears, seat 1's Serra Angel, seat 0's Bears], seat 0 controls all three.
- **Become the Pilot**: the Aura spell targets a creature that isn't a commander (none is, in this non-Commander game). With seat 1's Serra Angel (the runner's pick): Become the Pilot enters attached to it, seat 0 controls Serra Angel, which is 6/6.
- **Exterminate!**: replicate can't be paid, so there are no copies. The target creature is destroyed and its controller loses 3 life. With seat 1's Grizzly Bears (phase's pick in the sweep): Bears in seat 1's graveyard, seat 1 at 17 life.

### B.3 Why

1. 115.1a: "target player" / "target opponent" (including "target opponent's graveyard", "each player other than target player") make the spell targeted; 601.2c: the target is chosen during casting, and the spell can't be cast without it.
2. 115.3: Domineering Will has two instances of "target"; the player slot and the creature slots are separate and both are chosen at cast.
3. 115.1b, 303.4a, 702.5a: an Aura spell always targets what its enchant ability allows ("noncommander creature" = a creature that isn't a commander, 903.3); 608.3c: it enters attached to that target. Without a target, an Aura that enters is put into the graveyard (704.5m), which is what phase did.
4. 702.56a: replicate is an optional additional cost; when it isn't paid the spell is simply cast once with its normal target and resolves normally.
5. 702.26b, 702.16j: phased-out permanents are treated as though they don't exist; protection from everything.

### B.4 What phase did

- Death by Dragons: no target; resolved with no Dragon for anyone. Given seat 1 explicitly, phase didn't ask for a target ("phase chose [] without asking").
- Teferi's Reproach: no target; exiled itself, but nothing phased out (all four seat 1 permanents still listed).
- Release to Memory: no target; still exiled seat 1's Hill Giant and made a Spirit.
- Domineering Will: no player slot at all. Given [seat 0, ...] explicitly, phase refused seat 0 ("3 legal": only creatures). With one, or three, creature targets the spell "resolved" twice in the log and no control changed.
- Become the Pilot: no target; it entered the battlefield and went straight to the graveyard; no control change.
- Exterminate!: logged "Grizzly Bears is targeted by Exterminate!" (the runner recorded no target); then went from the stack to the graveyard with no destroy and no life loss. With seat 1's Serra Angel scripted explicitly: the same, nothing happened. For comparison, Sip of Hemlock ("Destroy target creature. Its controller loses 2 life.", no replicate) and Shattering Spree (replicate {R}, a mana cost) both work in phase, so the failure goes with "Replicate—tap an untapped [creature type] you control", like Psionic Ritual in Part A.

### B.5 Variations to test

- Death by Dragons targeting the caster: only the opponent gets a Dragon. Three players: two Dragons. Target player gains hexproof in response: nothing happens (ruling).
- Teferi's Reproach on seat 1 followed by seat 0's Lightning Bolt at seat 1: can't target seat 1 (protection); seat 1's permanents phase in at seat 1's next untap step.
- Release to Memory with two creature cards and a land in seat 1's graveyard: all three exiled, two Spirits. Target opponent with hexproof: can't be cast at them.
- Domineering Will with seat 1 as the target player and seat 0's Grizzly Bears: seat 1 controls seat 0's Bears until end of turn. Zero creature targets: legal, nothing changes control.
- Become the Pilot in a Commander game: an opponent's commander on the battlefield is not a legal target; other creatures are.
- Exterminate! with an untapped Dalek (e.g. Dalek Drone) and replicate paid once: two instances, each destroying a creature and making its controller lose 3.

### B.6 Acceptance checks

- Death by Dragons, Teferi's Reproach, Release to Memory and Become the Pilot can't be cast without choosing their target, and on the sweep board give: one Dragon; seat 1's nonland permanents phased out; one Spirit with Hill Giant exiled; Become the Pilot attached to the chosen creature, which seat 0 controls.
- Domineering Will asks for a target player and up to three target creatures; the chosen player controls those creatures afterwards.
- Exterminate! with no Dalek destroys its target creature and that creature's controller loses 3 life.
