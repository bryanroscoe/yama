# Spec: Blood Moon and Urborg, Tomb of Yawgmoth

Scenario: `referee/scenarios/blood-moon-urborg.json`. One player controls, in this timestamp order, Urborg, Tomb of Yawgmoth (t1), Blood Moon (t2), Island (t3). No actions are taken.

Observed: both engines make Urborg a Mountain. Forge reports the Island as [Island, Land]; phase reports it as [Island, Land, Swamp].

## 1. Cards

Oracle text from Scryfall.

- **Urborg, Tomb of Yawgmoth**: Legendary Land. "Each land is a Swamp in addition to its other land types."
- **Blood Moon**: Enchantment. "Nonbasic lands are Mountains."
- **Island**: Basic Land — Island. "({T}: Add {U}.)"

Rulings that bear on this:

- Urborg, 2021-03-19: "Urborg's ability causes each land on the battlefield to have the land type Swamp. Any land that's a Swamp has the ability "{T}: Add {B}." Nothing else changes about those lands, including their names, other subtypes, other abilities, and whether they're legendary, basic, or snow."
- Urborg, 2021-03-19: "If an effect such as that of Magus of the Moon causes Urborg to lose its abilities by setting it to a basic land type not in addition to its other types, it won't turn lands into Swamps, no matter in what order those effects started to apply." (Magus of the Moon's Oracle text is identical to Blood Moon's: "Nonbasic lands are Mountains.")
- Blood Moon, 2020-08-07: "Nonbasic lands will lose any other land types and abilities they had. They will gain the land type Mountain and gain the ability "{T}: Add {R}.""
- Blood Moon, 2020-08-07: "This effect doesn't affect names or supertypes. It won't turn any land into a basic land or remove the legendary supertype from a legendary land, and the lands won't be named "Mountain.""

## 2. Correct result

| Permanent | Type line | Mana abilities |
|---|---|---|
| Urborg, Tomb of Yawgmoth | Legendary Land — Mountain | {T}: Add {R}. (only) |
| Blood Moon | Enchantment | none |
| Island | Basic Land — Island | {T}: Add {U}. (only) |

Urborg has no rules-text abilities left. Nothing on this board is a Swamp, and no land can produce {B}. Urborg keeps its name and its legendary supertype.

## 3. Why

1. Both effects come from static abilities (611.3). Neither is a characteristic-defining ability: Urborg's affects other objects and Blood Moon's isn't on the objects it affects (604.3a). Both are type-changing effects that change subtypes, so both apply in layer 4 (613.1d).
2. Within a layer, effects normally apply in timestamp order (613.3, 613.7). A static ability's effect has its object's timestamp (613.7a), and an object gets its timestamp when it enters the zone (613.7d). Here Urborg (t1) is earlier than Blood Moon (t2).
3. Dependency overrides timestamp order (613.8). Under 613.8a, Urborg's effect **depends on** Blood Moon's:
   - (a) both apply in layer 4;
   - (b) applying Blood Moon's effect changes the *existence* of Urborg's effect. Blood Moon sets Urborg's subtype to a basic land type (Mountain), and under 305.7 a land whose subtype is set that way "loses all abilities generated from its rules text". Urborg's only ability is in its rules text, so after Blood Moon applies, Urborg's effect no longer exists;
   - (c) neither is from a characteristic-defining ability.
4. Blood Moon's effect does **not** depend on Urborg's. Applying Urborg's effect only adds the Swamp subtype. It doesn't change Blood Moon's text or existence, it doesn't change which lands are nonbasic (supertypes are untouched; 305.7, 305.8), and it doesn't change what Blood Moon does to them (they become Mountains either way). So there is no dependency loop.
5. Under 613.8b the dependent effect (Urborg's) waits until Blood Moon's has applied. Apply Blood Moon: each nonbasic land (only Urborg) loses its old land types and rules-text abilities and becomes a Mountain with "{T}: Add {R}" (305.7, 305.6). The Island is basic, so Blood Moon doesn't apply to it.
6. Re-evaluate (613.8c). Urborg's effect no longer exists, so nothing more applies in layer 4. The Island never becomes a Swamp.
7. Mana abilities come from basic land types (305.6): Urborg is a Mountain only, so {R}; the Island is an Island only, so {U}.

The Urborg ruling of 2021-03-19 states this result outright: with a Blood Moon-style effect on the battlefield, Urborg "won't turn lands into Swamps, no matter in what order those effects started to apply."

## 4. Verdict

**Forge is right; phase is wrong.** The Island should be [Island, Land] only (Basic Land — Island), not a Swamp. phase's result is what you get by applying the two layer-4 effects in timestamp order (Urborg first) and ignoring the dependency in 613.8a/b. Both engines are already right that Urborg is a Mountain.

## 5. Variations to test

Timestamps are given in placement order. "Lands" means every land on the board.

**(a) Reversed timestamps: Blood Moon (t1), Urborg (t2), Island (t3).**
Expected: same as the main result. Urborg is Legendary Land — Mountain with {R} only; Island is Basic Land — Island with {U} only. Decided by 613.8b and the 2021-03-19 Urborg ruling ("no matter in what order"). Here plain timestamp order also gives the right answer, so this case guards against a fix that only works when Urborg is earlier.

**(b) The Swamp grant comes from a non-land card: Blanket of Night.**
Blanket of Night: Enchantment. "Each land is a Swamp in addition to its other land types." Rulings (2004-10-04): "The ability is a land type change effect so it is ordered along with other land type change effects in the order they entered the battlefield." and "Whether the land is a basic land or not is unchanged by this effect."

Blood Moon doesn't remove Blanket's ability (Blanket isn't a land), and neither effect changes what the other applies to or does, so they're independent and apply in timestamp order (613.7, 613.8a). Urborg's own effect still depends on Blood Moon and never applies.

- (b1) Urborg (t1), Blood Moon (t2), Island (t3), Blanket of Night (t4). Blood Moon applies, then Blanket. Urborg: Legendary Land — Mountain Swamp, with {T}: Add {R} and {T}: Add {B}. Island: Basic Land — Island Swamp, with {U} and {B}. Rules: 613.7 (Blanket is later), 305.7 last sentence ("in addition" keeps existing types and adds the new mana abilities).
- (b2) Urborg (t1), Blanket of Night (t2), Blood Moon (t3), Island (t4). Blanket applies, then Blood Moon overwrites Urborg's land types. Urborg: Legendary Land — Mountain, {R} only. Island: Basic Land — Island Swamp, with {U} and {B} (Blood Moon doesn't touch basics). Rules: 613.7, 305.7 (setting the subtype removes the earlier-added Swamp type).

This pair is the control for the main case: with a non-land source, the Island *should* be a Swamp, and the order of Blanket and Blood Moon decides Urborg's types.

**(c1) Urborg (t1), Island (t2), no Blood Moon.**
Expected: Urborg is Legendary Land — Swamp with {B}. Urborg's ability says "each land", so it applies to Urborg itself. Island is Basic Land — Island Swamp with both {U} and {B}. Rules: 305.7 last sentence, 305.6, and the 2021-03-19 ruling ("Nothing else changes about those lands"). This guards against a fix that stops Urborg from working at all.

**(c2) Urborg (t1), Island (t2), Evil Presence (t3) attached to Urborg; no Blood Moon.**
Evil Presence: Enchantment — Aura. "Enchant land / Enchanted land is a Swamp." Ruling (2009-10-01): "The enchanted land loses its existing land types and any abilities printed on it. It now has the land type Swamp and has the ability "{T}: Add {B}." Evil Presence doesn't change the enchanted land's name or whether it's legendary, basic, or snow."
Expected: Urborg is Legendary Land — Swamp with {B} only. The Island is Basic Land — Island with {U} only: Urborg lost its ability, so the Island is **not** a Swamp. Rules: 305.7, 613.8a/b (Urborg's effect depends on Evil Presence's, just as on Blood Moon's), and the 2021-03-19 Urborg ruling's general wording ("an effect such as..."). This catches a fix that special-cases Blood Moon instead of applying the dependency rule to any effect that sets a land's subtype. It's easy to get wrong because Urborg ends up a Swamp anyway.

**(c3) Urborg (t1), Blood Moon (t2), Evil Presence (t3) attached to Urborg, Island (t4).**
Blood Moon and Evil Presence are independent of each other (neither changes whether Urborg is nonbasic or what the other does), so the later one wins (613.7; an Aura's timestamp is when it became attached, 613.7e). Urborg's effect depends on both and never applies. Expected: Urborg is Legendary Land — Swamp with {B} only; Island is Basic Land — Island with {U} only. With Evil Presence attached *before* Blood Moon entered, Urborg would instead be a Mountain with {R} only; the Island is the same either way.

**(c4) Main board, then Blood Moon leaves the battlefield.**
Static effects aren't locked in (611.3a, 611.3b). Once Blood Moon is gone, Urborg has its ability again. Expected afterwards: Urborg is Legendary Land — Swamp with {B}; Island is Basic Land — Island Swamp with {U} and {B}. This catches an implementation that strips Urborg's ability permanently instead of recomputing it.

**(c5) Supertypes and names under Blood Moon** (check in the main scenario). Urborg stays legendary and nonbasic and keeps its name; it isn't named "Mountain". The Island stays basic. Rules: 305.7 ("doesn't add or remove ... supertypes"), 305.8, and the Blood Moon ruling of 2020-08-07.

## 6. Acceptance tests

Main scenario (Urborg, then Blood Moon, then Island):
- Urborg's card types are exactly Land, its supertypes are exactly Legendary, and its subtypes are exactly Mountain. Its name is still Urborg, Tomb of Yawgmoth.
- Urborg has exactly one mana ability, which adds {R}, and no other abilities.
- The Island's supertypes are exactly Basic, its card types exactly Land, and its subtypes exactly Island. It is not a Swamp.
- The Island has exactly one mana ability, which adds {U}.
- Blood Moon is an Enchantment with no subtypes.
- No permanent can produce {B}.

(a) Blood Moon, then Urborg, then Island: the same assertions as the main scenario.

(b1) Urborg, Blood Moon, Island, Blanket of Night: Urborg's subtypes are exactly Mountain and Swamp, and it has mana abilities for {R} and {B}. The Island's subtypes are exactly Island and Swamp, it has mana abilities for {U} and {B}, and it is still basic.

(b2) Urborg, Blanket of Night, Blood Moon, Island: Urborg's subtypes are exactly Mountain, with a single {R} mana ability. The Island's subtypes are exactly Island and Swamp, with {U} and {B} mana abilities.

(c1) Urborg, Island: Urborg's subtypes are exactly Swamp, with a {B} mana ability. The Island's subtypes are exactly Island and Swamp, with {U} and {B} mana abilities.

(c2) Urborg, Island, Evil Presence on Urborg: Urborg's subtypes are exactly Swamp, with a single {B} mana ability, and it is still legendary. The Island's subtypes are exactly Island, with a single {U} mana ability.

(c3) Urborg, Blood Moon, Evil Presence on Urborg, Island: Urborg's subtypes are exactly Swamp, with a single {B} mana ability. The Island's subtypes are exactly Island, with a single {U} mana ability. With Evil Presence attached before Blood Moon entered, Urborg's subtypes are exactly Mountain with a single {R} mana ability, and the Island is unchanged.

(c4) Start from the main scenario, check the main assertions, then remove Blood Moon from the battlefield. Urborg's subtypes become exactly Swamp, with a {B} mana ability. The Island's subtypes become exactly Island and Swamp, with {U} and {B} mana abilities.

(c5) Covered by the main scenario's supertype and name assertions.
