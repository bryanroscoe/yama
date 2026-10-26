# Spec: "choose a card name" has no answer

Root cause (observed behaviour): whenever a card makes its controller choose a card name, phase stops with "phase's AI found no answer to NamedChoice". Both cards are castable on this board; phase can't finish casting/resolving them. This is a failure to offer or make a legal choice, not a disagreement about the result.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-phyrexian-revoker`, `card-predict` (both verdict `phase-error`).

## 1. Cards

Oracle text and rulings from Scryfall.

- **Phyrexian Revoker** ({2} Artifact Creature — Phyrexian Horror 2/1): "As this creature enters, choose a nonland card name. Activated abilities of sources with the chosen name can't be activated."
  - 2020-08-07: "Static and triggered abilities of sources with the chosen name are unaffected." "Phyrexian Revoker's ability affects sources with the chosen name no matter what zone they are in."
- **Predict** ({1}{U} instant): "Choose a card name, then target player mills a card. If a card with the chosen name was milled this way, you draw two cards. Otherwise, you draw a card."

## 2. Board and actions

- `card-phyrexian-revoker`: seat 0 casts Phyrexian Revoker with two Wastes. As it enters, seat 0 must choose a nonland card name.
- `card-predict`: seat 0 casts Predict targeting seat 1 (Island + Wastes). On resolution seat 0 chooses a card name, then seat 1 mills one card.

## 3. Correct result

- **Phyrexian Revoker:** it enters as a 2/1 with a chosen nonland card name (any nonland card in the Oracle card reference; a sensible choice on this board is Millstone or Seal of Fire, both with activated abilities). Final state otherwise: Revoker on the battlefield, Wastes tapped. (Forge: Revoker on the battlefield after choosing a name.)
- **Predict:** seat 1 mills its top card (a Wastes: seat 1 graveyard Hill Giant + Wastes, library 7). If seat 0 named "Wastes", seat 0 draws two (hand 3, library 6); otherwise draws one (hand 2, library 7). (Forge: drew one.)

## 4. Why

1. 201.4: "If an effect instructs a player to choose a card name, the player must choose the name of a card in the Oracle card reference." 201.4a: if the name must have certain characteristics (here "nonland"), choose the name of a card whose Oracle text matches.
2. The choice is always possible: there are many legal names. A token-only name is not allowed (201.4).
3. Phyrexian Revoker's choice is made as it enters (614.1c / 614.12: "As [this] enters" is a replacement effect); Predict's is made on resolution, before the mill (608.2c).

## 5. What phase did

Both runs ended with `phase's AI found no answer to NamedChoice`; the card never finished entering/resolving.

## 6. Variations to test

- **Revoker naming a card on the board:** name Millstone; seat 1 can't activate Millstone's ability; naming Seal of Fire stops its sacrifice ability; static and triggered abilities are unaffected (ruling). Naming a planeswalker stops its loyalty abilities.
- **Revoker can't name a land:** a land name is not a legal choice (201.4a "nonland").
- **Predict naming correctly:** seat 1's top card is Wastes and seat 0 names Wastes: draw two.
- **Predict with an empty library** for the target player: nothing is milled; draw one.
- **Split/adventure/DFC names:** 201.4b–f: a split card's half name, an adventurer's alternative name, a DFC's back-face name are legal; a split card's combined name isn't.
- **Other "choose a card name" cards** (e.g. Pithing Needle, Meddling Mage, Demonic Consultation) should all get an answer.

## 7. Acceptance checks

- Casting Phyrexian Revoker completes; it's on the battlefield with a chosen nonland card name, and activated abilities of sources with that name can't be activated.
- Casting Predict completes; the target player mills one card and the caster draws one or two cards depending on the name chosen.
- The AI (and any player interface) is always offered at least one legal name.


---

## Added from triage batch 2: Day of the Moon

Scenario: `card-day-of-the-moon` (verdict `phase-error`: "phase's AI found no answer to NamedChoice"). Standard sweep board; seat 0's lands are Mountain + 2 Wastes.

- **Day of the Moon** {2}{R}, Enchantment — Saga. "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.) / I, II, III — Choose a creature card name, then goad all creatures with a name chosen for this enchantment. (Until your next turn, they attack each combat if able and attack a player other than you if able.)"

The card is castable on this board (Forge cast it; the Saga entered with a lore counter and chapter I triggered). Chapter I asks seat 0 to choose a creature card name; any creature card name is legal, including one not on the battlefield (e.g. Grizzly Bears or Serra Angel). After the choice, every creature with a chosen name is goaded until seat 0's next turn (701.15a). With "Grizzly Bears" chosen, both Grizzly Bears are goaded; with "Serra Angel", seat 1's Serra Angel is. phase stopped at the name choice instead.

Acceptance check: on this board, chapter I resolves with a creature card name chosen, the Saga stays on the battlefield with 1 lore counter, and the creatures with that name are goaded.
