# Spec: "create/manifest ... and attach this to it"

Root cause (observed behaviour): when one ability creates a permanent (a token, or a manifested card) and then attaches its source to "it", phase creates the permanent but never attaches the source. An Equipment is left unattached; an enchantment that became an Aura is left unattached and goes to the graveyard as a state-based action.

Scenarios (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-field-tested-frying-pan`, `card-cloudform`, `card-lightform`.

## 1. Cards

Oracle text from Scryfall.

- **Field-Tested Frying Pan** ({2}{W} Artifact — Equipment): "When this Equipment enters, create a Food token, then create a 1/1 white Halfling creature token and attach this Equipment to it. Equipped creature has 'Whenever you gain life, this creature gets +X/+X until end of turn, where X is the amount of life you gained.' Equip {2}"
- **Cloudform** ({1}{U}{U} Enchantment): "When this enchantment enters, it becomes an Aura with enchant creature. Manifest the top card of your library and attach this enchantment to it. ... Enchanted creature has flying and hexproof."
- **Lightform** ({1}{W}{W} Enchantment): same as Cloudform, but "Enchanted creature has flying and lifelink."

## 2. Board and actions

Seat 0 (active, main phase 1) has the lands for the card, a Grizzly Bears, the card and a Wastes in hand; its library is 8 Wastes. Seat 0 casts the card; it resolves; its enters trigger resolves.

## 3. Correct result

- **Frying Pan:** seat 0 controls a Food token, a 1/1 white Halfling creature token, and Field-Tested Frying Pan **attached to the Halfling**.
- **Cloudform / Lightform:** the top card of seat 0's library (a Wastes) is on the battlefield face down as a 2/2 creature (library 8 → 7), and Cloudform/Lightform is on the battlefield as an **Aura attached to that face-down creature**. The face-down creature has flying and hexproof (Cloudform) or flying and lifelink (Lightform). Cloudform/Lightform is not in the graveyard.

## 4. Why

1. The trigger's instructions are followed in order (608.2c). "Create ... a 1/1 Halfling ... and attach this Equipment to it": "it" is the token just created. "Manifest the top card ... and attach this enchantment to it": "it" is the manifested permanent (701.40a).
2. Attaching moves the Equipment/Aura onto that object (701.3a). Both targets are legal: the Halfling is a creature an Equipment can equip (301.5); the face-down 2/2 is a creature that an Aura with enchant creature can enchant (303.4). So 701.3b ("doesn't move") does not apply.
3. Cloudform/Lightform: the first sentence makes the enchantment an Aura with enchant creature for as long as it stays on the battlefield. Once attached, it is a legally attached Aura, so the state-based action that puts unattached Auras into the graveyard (704.5m) does not apply.
4. Nothing in either ability targets; no part of it can fail for want of a target.

## 5. What phase did

- Frying Pan: Food and Halfling were created, but the Equipment stayed unattached (`attached_to` missing). Forge: attached to the Halfling.
- Cloudform/Lightform: the card was manifested (library 7, a face-down creature on the battlefield in both engines), but the enchantment was not attached and went to the graveyard. Forge: Aura attached to the face-down creature.

## 6. Variations to test

- **Manifest of a creature card.** Library top is a creature card (e.g. Grizzly Bears): the result is the same, the Aura is attached to the face-down 2/2. If it is later turned face up (701.40b) it stays enchanted.
- **Empty library.** Cloudform with an empty library: nothing is manifested, there is nothing to attach to, and Cloudform (an Aura now) goes to the graveyard as a state-based action (704.5m). Make sure the fix doesn't crash here.
- **Frying Pan leaves first.** If the Frying Pan left the battlefield before its trigger resolves, the Food and Halfling are still created and nothing is attached (the source isn't on the battlefield to attach).
- **Equipped bonus.** After the Frying Pan is attached, seat 0 gains 3 life (e.g. sacrifice the Food: "{2}, {T}, Sacrifice this artifact: You gain 3 life"): the Halfling gets +3/+3 until end of turn.
- **Cloudform's hexproof.** The face-down creature can't be the target of spells or abilities seat 1 controls.
- The general shape to cover is any "create a token ... and attach [this] to it" (living-weapon-like Equipment without the keyword) or "manifest/cloak ... and attach [this] to it". Living weapon itself (702.92: "create a 0/0 black Phyrexian Germ creature token, then attach this to it") is the same instruction and a good regression check.

## 7. Acceptance checks

- After Field-Tested Frying Pan's trigger, the Frying Pan is attached to the new Halfling token.
- After Cloudform's or Lightform's trigger, the enchantment is an Aura on the battlefield attached to the new face-down 2/2, which has flying and hexproof / lifelink; the enchantment is not in the graveyard.

## Added from triage batch 3: Experimental Lab ("manifest dread, then put ... counters on that creature")

Scenario: `card-experimental-lab` (standard sweep board). Same root cause: a later part of the effect refers to the permanent the same effect just made face down, and phase doesn't act on it.

**Experimental Lab** ({3}{G}, Room door of Experimental Lab // Staff Room): "When you unlock this door, manifest dread, then put two +1/+1 counters and a trample counter on that creature."
- Rulings: when the Room spell resolves, the cast door becomes unlocked as the Room enters, and "when you unlock this door" triggers. Manifest dread: "look at the top two cards of your library. Manifest one ... and put the other into your graveyard."
- Board and action: seat 0 has Forest, 3 Wastes, Grizzly Bears; library 8 Wastes. Seat 0 casts the Experimental Lab door.
- Correct (701.62a, 608.2c): the door unlocks, the trigger resolves: one Wastes goes onto the battlefield face down as a 2/2, the other into the graveyard; then "that creature" (the manifested one) gets two +1/+1 counters and a trample counter: a 4/4 face-down creature with trample. Library 6. (Forge: exactly this.)
- Phase: manifested correctly (face-down 2/2, one Wastes to the graveyard) but put no counters on it.
- Variations: library with one card (it's manifested, no graveyard card, still gets the counters); library empty (nothing manifested, no counters anywhere, no crash); the counters stay when the creature is turned face up.
- Acceptance: after the trigger, the face-down creature has two +1/+1 counters and a trample counter and is 4/4 with trample.
