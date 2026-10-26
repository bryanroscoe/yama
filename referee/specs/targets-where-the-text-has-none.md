# Spec: targets chosen for spells whose text has no "target"

Root cause (observed behaviour): phase asks for, and logs ("X is targeted by ..."), a target while casting spells whose Oracle text never says "target": spells with no choice at all (Genesis Storm, Warp World, Reverse the Polarity), spells whose choice is made on resolution ("choose a creature you control", "you may put a land card from your hand"), and an alternative cost's "an opponent" (Invigorate). In three of them the effect then also goes wrong: Genesis Storm sends the "targeted" creature into its owner's library, Warp World puts nothing back onto the battlefield, and Invigorate gives no +4/+4. Forge, given phase's target list, refused: "step has targets but Forge's ability takes none".

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-genesis-storm`, `card-warp-world`, `card-reverse-the-polarity`, `card-gideon-s-sacrifice`, `card-riveteers-confluence`, `card-invigorate`.

Related: `choices-on-resolution-not-acted-on.md` (choices made on resolution that phase ignores, some also treated as targets). Here the choice, when there is one, *is* acted on (Riveteers Confluence); the bug is the target.

## 1. Cards

Oracle text and rulings from Scryfall.

- **Genesis Storm** ({4}{G}{G} sorcery): "When you cast this spell, copy it for each time you've cast your commander from the command zone this game. Reveal cards from the top of your library until you reveal a nonland permanent card. You may put that card onto the battlefield. Then put all cards revealed this way that weren't put onto the battlefield on the bottom of your library in a random order." Ruling (2018-07-13): "If your library no longer has any nonland permanent cards, you'll reveal your library and then put it back in a random order."
- **Warp World** ({5}{R}{R}{R} sorcery): "Each player shuffles all permanents they own into their library, then reveals that many cards from the top of their library. Each player puts all artifact, creature, and land cards revealed this way onto the battlefield, then does the same for enchantment cards, then puts all cards revealed this way that weren't put onto the battlefield on the bottom of their library." Rulings (2009-10-01): each player counts the permanents they own, shuffles them in, reveals that many, puts all artifact, land and creature cards onto the battlefield at the same time, then enchantment cards, then the rest on the bottom.
- **Reverse the Polarity** ({1}{U}{U} instant): "Choose one — • Counter all other spells. • Switch each creature's power and toughness until end of turn. • Creatures can't be blocked this turn."
- **Gideon's Sacrifice** ({W} instant): "Choose a creature or planeswalker you control. All damage that would be dealt this turn to you and permanents you control is dealt to the chosen permanent instead (if it's still on the battlefield)." Ruling (2019-05-03): "If you control no creatures or planeswalkers as Gideon's Sacrifice resolves, nothing happens."
- **Riveteers Confluence** ({2}{B}{R}{G} instant): "Choose three. You may choose the same mode more than once. • You draw a card and you lose 1 life. • Riveteers Confluence deals 1 damage to each creature and planeswalker you don't control. • You may put a land card from your hand or graveyard onto the battlefield tapped."
- **Invigorate** ({2}{G} instant): "If you control a Forest, rather than pay this spell's mana cost, you may have an opponent gain 3 life. Target creature gets +4/+4 until end of turn."

## 2. Board and actions

Standard sweep board: seat 0 (active, precombat main, empty stack) controls exactly the lands for the card's mana cost (basic lands for colored symbols, Wastes for generic) plus Grizzly Bears; hand: the card and a Wastes; graveyard Hill Giant, Divination; library 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel, Millstone, Seal of Fire (no lands); hand 2 Wastes; graveyard Hill Giant; library 8 Wastes. It's not a Commander game (no commander has been cast). Seat 0 casts the card paying its mana cost. Modes phase chose (and Forge was given): Reverse the Polarity mode 2 (switch); Riveteers Confluence modes 1, 2, 3 once each.

## 3. Correct result

None of these spells has a target, so no target is chosen and no "becomes the target" event happens (115.10a).

**Genesis Storm.** Cast trigger: 0 commander casts, so no copies. Resolution: seat 0 reveals cards until a nonland permanent card; the library is 8 Wastes, so all 8 are revealed and none is found; they all go back on the bottom in a random order. Final: nothing changes except Genesis Storm in seat 0's graveyard; seat 1's Grizzly Bears stays on the battlefield; both libraries 8.

**Warp World.** Seat 0 owns 9 permanents (3 Mountains, 5 Wastes, Grizzly Bears); seat 1 owns 4 (Grizzly Bears, Serra Angel, Millstone, Seal of Fire). Each shuffles them into their library (seat 0: 17 cards, seat 1: 12), then reveals that many: seat 0 reveals 9, seat 1 reveals 4. Every card in both libraries is a land, creature, artifact or enchantment card, so **every revealed card goes onto the battlefield**: first all artifact, creature and land cards at once, then seat 1's enchantment cards (if Seal of Fire was revealed). Which cards come back is random, but the counts aren't: seat 0 ends with 9 permanents and a library of 8; seat 1 ends with 4 permanents and a library of 8. Warp World ends in seat 0's graveyard.

**Reverse the Polarity (mode 2).** Each creature's power and toughness are switched until end of turn (613.4d). On this board every creature has equal power and toughness (2/2, 4/4), so nothing visible changes. No target.

**Gideon's Sacrifice.** On resolution seat 0 chooses a creature or planeswalker it controls (its Grizzly Bears, the only one). For the rest of the turn, damage that would be dealt to seat 0 or its permanents is dealt to that Bears instead. Nothing visible on this board (no damage is dealt). The Bears is chosen, not targeted.

**Riveteers Confluence (modes 1, 2, 3).** In order: seat 0 draws a card (a Wastes) and loses 1 life (19); 1 damage to each creature seat 1 controls (Grizzly Bears and Serra Angel each have 1 damage); seat 0 may put a land card from its hand or graveyard onto the battlefield tapped (a Wastes from hand, which may be the one just drawn). Final: seat 0 life 19, a tapped Wastes added to its battlefield, hand [Wastes], library 7. Phase reached exactly this result; the only error is that the land was "targeted" while the spell was being cast, before the draw of mode 1 happened.

**Invigorate.** Paid with mana ({2}{G}), so the alternative cost isn't used and no opponent gains life (and even when it is used, the opponent is chosen as a cost, not targeted). Target creature gets +4/+4 until end of turn: with the runner's preference, seat 1's Grizzly Bears (or Serra Angel) is 6/6 (8/8) in the final state, which is still in the same turn.

## 4. Why

1. 115.10 / 115.10a: an object or player is a target only if the text identifies it with the word "target" (or a keyword's rules say so). None of these texts does, apart from Invigorate's "target creature".
2. 115.1a: an instant or sorcery is targeted only by "target [something]" in its spell ability. Invigorate's one target is the creature.
3. 608.2d: choices in the effect ("choose a creature or planeswalker you control", "you may put a land card from your hand or graveyard") are made while the spell resolves, after earlier parts of it have happened (608.2c), so Riveteers Confluence's third mode can pick a land drawn by its first mode (700.2d: repeated modes happen in sequence).
4. 118.9, 601.2b, 601.2f: an alternative cost is chosen and paid as a cost; "have an opponent gain 3 life" is a cost, it doesn't target, and it isn't paid at all when the mana cost is paid.
5. Genesis Storm and Warp World instructions follow 608.2c in order; Genesis Storm never moves a permanent; Warp World must put the revealed artifact, creature, land and then enchantment cards onto the battlefield.

## 5. What phase did

- Genesis Storm: logged "Grizzly Bears is targeted by Genesis Storm" (seat 1's Bears) while casting; on resolution revealed the 8 Wastes, then **moved seat 1's Grizzly Bears from the battlefield into seat 1's library** (seat 1 library 9, no Bears). No cast trigger was logged (harmless here, with 0 commander casts).
- Warp World: logged "Grizzly Bears is targeted by Warp World" (seat 1's); shuffled all 13 permanents into the libraries, then **put nothing onto the battlefield**: both battlefields empty, libraries 17 and 12.
- Reverse the Polarity: logged "Grizzly Bears is targeted by Reverse the Polarity" (seat 1's); otherwise no visible difference.
- Gideon's Sacrifice: logged "Grizzly Bears is targeted by Gideon's Sacrifice" (seat 0's) while casting.
- Riveteers Confluence: logged "Wastes is targeted by Riveteers Confluence" (the Wastes in seat 0's hand) while casting; the resolution was otherwise right.
- Invigorate: logged "Player 2 is targeted by Invigorate" and "Grizzly Bears is targeted by Invigorate" while casting (with the mana cost paid; the referee runner recorded no targets); the spell then went to the graveyard without resolving: no creature got +4/+4, no one gained life.

## 6. Variations to test

- Genesis Storm with a nonland permanent card in the library (e.g. a Grizzly Bears 3rd from the top): reveal 3, may put the Bears onto the battlefield, the 2 Wastes go on the bottom in a random order; no permanent already on the battlefield moves.
- Genesis Storm in a Commander game after casting the commander twice from the command zone: two copies, each resolving separately.
- Warp World with tokens: a token counts toward "that many" but isn't put into the library (ruling); with an instant in the library: a revealed instant goes to the bottom.
- Warp World with an Aura revealed: it enters after the artifacts/creatures/lands and may enchant one of them.
- Reverse the Polarity mode 2 with a 2/3 creature: it's 3/2 until end of turn. Mode 1 with a spell on the stack: counters all other spells, no targets (works on a spell that can't be targeted).
- Gideon's Sacrifice choosing a creature with shroud: allowed. Then seat 1's Lightning Bolt aimed at seat 0: the 3 damage is dealt to the chosen creature instead.
- Riveteers Confluence with mode 3 chosen and no land in hand at cast but a land drawn by mode 1: the drawn land can be put onto the battlefield.
- Invigorate with the alternative cost: seat 1 gains 3 life, seat 0 pays no mana, the target still gets +4/+4; seat 1 having hexproof doesn't stop the alternative cost.

## 7. Acceptance checks

- None of Genesis Storm, Warp World, Reverse the Polarity, Gideon's Sacrifice or Riveteers Confluence asks for a target while being cast; nothing is logged as "targeted" by them.
- Genesis Storm on the sweep board leaves seat 1's Grizzly Bears on the battlefield.
- Warp World on the sweep board leaves seat 0 with 9 permanents and seat 1 with 4, each library 8.
- Invigorate's only target is a creature; when it resolves that creature gets +4/+4; paying the mana cost makes no opponent gain life.
- Riveteers Confluence's land choice is made as the third mode resolves.

---

## Part B (sweep v6, batch 6): more targets where the text has none

Same root cause: phase asks for and logs a target the text doesn't have. Scenarios (standard sweep board; all `forge-error`, "step has targets but Forge's ability takes none" or, for the trigger, "not a legal target"): `card-aether-snap`, `card-golgari-charm` (mode 3), `card-ripples-of-potential`, `card-divine-reckoning`, `card-fortunate-few`, `card-mantle-of-the-ancients`. In the last four the choice or the effect then also goes wrong.

### B.1 Cards (Oracle text and rulings, Scryfall)

- **Aether Snap** ({3}{B}{B} sorcery): "Remove all counters from all permanents and exile all tokens."
- **Golgari Charm** ({B}{G} instant): "Choose one — • All creatures get -1/-1 until end of turn. • Destroy target enchantment. • Regenerate each creature you control." (The sweep chose the third mode.)
- **Ripples of Potential** ({1}{U} instant): "Proliferate, then choose any number of permanents you control that had a counter put on them this way. Those permanents phase out. (...)" Rulings (2023-11-10): proliferate chooses any number of permanents and/or players that have a counter (zero is fine); phased-out permanents are treated as though they don't exist until their controller's next untap step.
- **Divine Reckoning** ({2}{W}{W} sorcery): "Each player chooses a creature they control. Destroy the rest. Flashback {5}{W}{W}."
- **Fortunate Few** ({3}{W}{W} sorcery): "Choose a nonland permanent you don't control, then each other player chooses a nonland permanent they don't control that hasn't been chosen this way. Destroy all other nonland permanents."
- **Mantle of the Ancients** ({3}{W}{W} Enchantment — Aura): "Enchant creature you control. When this Aura enters, return any number of target Aura and/or Equipment cards from your graveyard to the battlefield attached to enchanted creature. Enchanted creature gets +1/+1 for each Aura and Equipment attached to it." Rulings (2021-07-23): "If Mantle of the Ancients becomes attached to a different creature in response to its enters-the-battlefield ability, the creature it's attached to as that ability is resolving is the 'enchanted creature' ... some of those targets may become illegal." Targets that can't legally be attached stay in the graveyard.

### B.2 Correct result (sweep board: no counters and no tokens anywhere; seat 0 controls only its Grizzly Bears besides lands; seat 1 controls Grizzly Bears, Serra Angel, Millstone, Seal of Fire)

- **Aether Snap**: no target. Nothing to remove or exile on this board; the board is unchanged apart from the spell in the graveyard. No "becomes the target" event, no crime (700.13).
- **Golgari Charm, mode 3**: no target. Each creature seat 0 controls (its Grizzly Bears) gets a regeneration shield for the turn (701.19a). Nothing visible on the board.
- **Ripples of Potential**: no target. Proliferate: no permanent or player has a counter, so nothing gets one. Then seat 0 chooses among permanents it controls that had a counter put on them this way: there are none, so **nothing phases out**. Final: seat 0's Grizzly Bears still on the battlefield.
- **Divine Reckoning**: no target. On resolution seat 0 chooses its Grizzly Bears (its only creature); seat 1 chooses one of its Grizzly Bears or Serra Angel (its own choice; an AI would keep Serra Angel). The other seat 1 creature is destroyed. Final with that choice: seat 1's Grizzly Bears in its graveyard, Serra Angel and seat 0's Bears still on the battlefield.
- **Fortunate Few**: no target. Seat 0 chooses a nonland permanent it doesn't control (phase's pick: seat 1's Grizzly Bears). Seat 1 then chooses a nonland permanent it doesn't control that wasn't chosen: the only one is **seat 0's Grizzly Bears**. Destroy all other nonland permanents: Serra Angel, Millstone, Seal of Fire. Final: both Grizzly Bears on the battlefield; Serra Angel, Millstone and Seal of Fire in seat 1's graveyard; Fortunate Few in seat 0's.
- **Mantle of the Ancients**: the Aura spell targets seat 0's Grizzly Bears (right). The enters trigger's only targets are Aura/Equipment cards in seat 0's graveyard (none here, so zero targets); "enchanted creature" is **not** a target. Final: Mantle attached to the Bears, Bears 3/3 (phase's board already matches).

### B.3 Why

1. 115.10a: only what the text calls "target" is a target. "All permanents", "each creature you control", "choose a creature they control", "choose a nonland permanent you don't control" and "enchanted creature" are not.
2. 608.2d: choices in the effect are made on resolution, in the order written (Fortunate Few: seat 0 first, then each other player, each excluding what was already chosen).
3. 701.34a: proliferate gives counters only to permanents/players that already have one. Ripples' second choice is restricted to permanents seat 0 controls "that had a counter put on them this way", so with no counters nothing can be chosen.
4. 701.8a: "Destroy the rest" / "destroy all other nonland permanents" destroys exactly the ones not chosen.
5. Mantle ruling: "enchanted creature" is whatever Mantle is attached to as the trigger resolves, which only works if it isn't fixed as a target when the trigger is put on the stack.

### B.4 What phase did

- Aether Snap: logged "Grizzly Bears is targeted by Aether Snap" (seat 1's Bears; "Player 1 commits a crime"). Board otherwise right.
- Golgari Charm: logged "Grizzly Bears is targeted by Golgari Charm" (seat 0's Bears).
- Ripples of Potential: logged "Grizzly Bears is targeted by Ripples of Potential" (seat 0's), proliferated (nothing to add), then **phased out seat 0's Grizzly Bears**, which got no counter.
- Divine Reckoning: logged "Grizzly Bears is targeted by Divine Reckoning" (seat 0's); **destroyed nothing** (seat 1 kept both creatures).
- Fortunate Few: logged "Grizzly Bears is targeted by Fortunate Few" (seat 1's), then **destroyed all five nonland permanents**, both Grizzly Bears included.
- Mantle of the Ancients: the enters trigger's target list held seat 0's Grizzly Bears (the enchanted creature). Probe with Rancor and Bonesplitter in seat 0's graveyard: the trigger logged "Bonesplitter is targeted" and "Grizzly Bears is targeted"; Bonesplitter returned attached to the Bears (6/4), which is right for that choice; the Bears shouldn't have been a target.

### B.5 Variations to test

- Aether Snap with a +1/+1 counter on seat 1's Grizzly Bears and a Spirit token under seat 0: the counter is removed and the token exiled. Bounce seat 1's Bears in response: Aether Snap still resolves (it has no target to become illegal).
- Golgari Charm mode 3 with two creatures, then destroy both: both regenerate (tapped, removed from combat, damage removed).
- Ripples of Potential with a +1/+1 counter on seat 0's Bears and a loyalty counter on seat 0's planeswalker: both get another counter; seat 0 may phase out either, both or neither; a permanent with no counter can't be chosen; an opponent's permanent that got a counter can't be phased out ("you control").
- Divine Reckoning with three players; with a hexproof or shrouded creature (it can still be chosen); seat 1 with no creatures (nothing to choose; seat 0 keeps its chosen one).
- Fortunate Few with three players, where a later player's only option was already chosen (they choose nothing).
- Mantle with Rancor and Bonesplitter in the graveyard, both chosen: Bears gets Rancor (+2/+0, trample), Bonesplitter (+2/+0) and +3/+3 from Mantle: 9/5. In response to the trigger, the Bears gains shroud: the Auras/Equipment still return attached (they aren't targeting it). In response, Mantle moves to another creature you control: the cards return attached to that creature (ruling).

### B.6 Acceptance checks

- None of these spells or the Mantle trigger logs a target other than (for Mantle) the graveyard cards; no "commits a crime" from Aether Snap.
- Ripples of Potential on the sweep board phases nothing out.
- Divine Reckoning on the sweep board destroys exactly one of seat 1's two creatures and none of seat 0's.
- Fortunate Few on the sweep board leaves both Grizzly Bears and destroys Serra Angel, Millstone and Seal of Fire.
