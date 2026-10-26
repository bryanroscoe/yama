# Spec: gift-only targets are chosen only if the gift is promised

Root cause (observed behaviour): for instants and sorceries whose gift-dependent part has a target, phase chooses that target even when the gift isn't promised. The spell then has an extra target (the log shows it as targeted). In this sweep Forge was handed phase's extra target, rejected the cast as illegal ("Couldn't add to stack, failed to target"), and so the Forge side ended with the spell uncast. phase's resolution was otherwise right.

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-consumed-by-greed` (scripted targets: seat 1; Hill Giant in seat 0's graveyard), `card-sazacap-s-brew` (scripted targets: seat 1; seat 0's Grizzly Bears).

## 1. Cards

Oracle text from Scryfall.

- **Consumed by Greed** ({1}{B}{B} instant): "Gift a card (You may promise an opponent a gift as you cast this spell. If you do, they draw a card before its other effects.) Target opponent sacrifices a creature with the greatest power among creatures they control. If the gift was promised, return target creature card from your graveyard to your hand."
- **Sazacap's Brew** ({1}{R} instant): "Gift a tapped Fish (You may promise an opponent a gift as you cast this spell. If you do, they create a tapped 1/1 blue Fish creature token before its other effects.) As an additional cost to cast this spell, discard a card. Target player draws two cards. If the gift was promised, target creature you control gets +2/+0 until end of turn."
- Ruling (both, 2024-07-26): "Some instant or sorcery spells require alternative or additional targets if the gift was promised. You ignore these targeting requirements if the gifts aren't promised for those spells."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): lands for the card, Grizzly Bears; hand: the card, Wastes; graveyard: Hill Giant, Divination. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. Seat 0 casts the card. In phase's run seat 0 did not promise the gift (seat 1 drew nothing / got no Fish).

## 3. Correct result

When the gift is **not** promised:
- Consumed by Greed has exactly one target: seat 1. Hill Giant in the graveyard is not targeted. Resolution: seat 1 sacrifices Serra Angel (greatest power 4). Hill Giant stays in seat 0's graveyard. (phase's final board matched this.)
- Sazacap's Brew has exactly one target: the target player (here seat 1). Seat 0's Grizzly Bears is not targeted. Seat 0 discards Wastes as the additional cost; on resolution seat 1 draws two. Grizzly Bears gets nothing. (phase's final board matched this.)

When the gift **is** promised, both targets are chosen; the gifted opponent draws a card / creates a tapped Fish first, then the rest happens, including the gift-only part.

## 4. Why

1. 702.174m: "If part of a spell's ability has its effect only if its gift was promised, and that part of the ability includes any targets, the spell's controller chooses those targets only if the gift was promised."
2. 601.2c: "A spell may require some targets only if an alternative or additional cost ... was chosen for it; otherwise, the spell is cast as though it did not require those targets."
3. The difference matters: an extra target triggers "becomes the target" abilities (ward, heroic, Valiant), and it changes whether the spell fizzles (608.2b: a spell with all targets illegal doesn't resolve). E.g. Consumed by Greed without the gift and with seat 1 gaining hexproof in response must not resolve at all; with a stray second target still legal it would wrongly resolve.

## 5. What phase did

Logged "Hill Giant is targeted by Consumed by Greed" / "Grizzly Bears is targeted by Sazacap's Brew" with no gift promised, i.e. chose the gift-only target. Resolution itself then ignored that target correctly.

## 6. Variations to test

- Gift promised: both targets chosen; Consumed by Greed: seat 1 draws, sacrifices Serra Angel, Hill Giant returns to seat 0's hand. Sazacap's Brew: seat 1 creates a tapped 1/1 blue Fish, target player draws two, Grizzly Bears gets +2/+0.
- Gift not promised, seat 0's Grizzly Bears has ward {2} (or a heroic creature): no ward/heroic trigger from Sazacap's Brew.
- Gift not promised, the only target becomes illegal before resolution: the spell doesn't resolve.
- Gift not promised and no creature card in the graveyard: Consumed by Greed is still castable (the gift-only target isn't required).
- Permanent spells with gift (enters trigger "if the gift was promised"): the trigger doesn't happen at all when not promised (702.174b).

## 7. Acceptance checks

- Casting a gift spell without promising the gift never asks for, or records, targets of the gift-only part.
- A gift spell without promise is castable even when the gift-only part has no legal target.
- Promising the gift requires choosing those targets.
