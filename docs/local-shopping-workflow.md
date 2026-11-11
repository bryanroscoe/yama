# Buy cards locally from a deck configuration

## Source every deck together

Open **Decks → Plans → Get the cards → Source cards across all decks**
(`/decks/plans/get/sourcing`). Choose a saved sourcing report, then all decks or
a subset and either one bracket or the union of alternatives. The page groups
names while retaining one wish per physical copy and recipient; the same deck's
B2/B3/B4 alternatives are not three copies. Filter unresolved sources separately
from optional real replacements for proxies and reserved prints. Orphaned target
rows are excluded even in the all-brackets view. Explicit permanent real-card
wishes and packet bonuses remain separately labelled optional wishes outside
those builds; choosing a specific bracket filters those out.

For MCP clients, `research(id, full=true)` reads the same private `local_sources`
evidence used by this page. Preserve each use's stable id and recipient; do not
sum overlapping research reports or alternative scenarios. The report's lists,
copy allocations and quote dates remain a snapshot, not a live ownership claim.

The page defaults to Near Mint, with store, condition, deck, bracket and card-name filters. Each row labels its recipient as a deck and shows the brackets containing that card. Add all matching cards prepares requested quantities in one click, including listings that omit their stock count; those copies are visibly marked stock unconfirmed. Add confirmed quantities only excludes unknown quantities. Both respect known stock and selected recipients, and can split copies across stores. Search and condition filters apply to bulk selection. A requested cart quantity is not verified availability. Printing market references show their matching evidence; market values are not condition-specific. Lowest saved condition prices compare only the positively identified printing, finish and condition, not the whole market. Missing references stay unavailable. Shopify cart links combine variant quantities;
TCGplayer Pro listings are added on the store pages. This preview does not activate
plans or change inventory, orders, review answers or the active trip.

Refreshing live store snapshots does not regenerate this saved preview. When asked
to refresh a portfolio source report, verify its current targets and allocations,
refresh explicit card names through the staged store check, then save the updated
research evidence and read it back. Keep failed checks unknown and label stale lists.

## Start with the right list

Read `overview`, then `plan_deck` for the plan key and `research` for the exact
deck/build or acquisition scenario. Compare its counted-card list with the latest
saved configuration (`deck` or `deck_analysis`) and report the research revision
and list date. An archived note may retain useful evidence, but its date or title
does not establish that it matches today's list. A bracket label or power estimate
alone does not identify a deck version.

Read `collection_cards` and plan allocations before counting purchases. Separate
real copies, arrived proxies, ordered prints, reserved but unordered prints,
installed cards and unresolved sources. Check copies outside deck containers with
`outside_decks=true` and paginate; they may already be reserved. Each physical copy
can cover only one deck at a time. A real replacement for a proxy is optional, not
a missing gameplay copy. A single-sided DFC placeholder still needs its separate
playable double-faced card. Do not infer installation or order contents from advice.

## Read the active shopping list and its limits

Read `shopping_settings`, `shopping_list`, `shopping_trip` and `store_stock`.
The trip uses approved, active plan buys without orders, plus explicit shopping
wishes. Unapproved builds and archived plans do not become required purchases.
Real-card wishlist entries only come along from stores already selected for the
trip. An empty trip does not mean no local store sells the cards.

Saving research does not itself activate a plan or refresh the trip's stock
snapshots. Research can contain acquisition evidence the active trip is not using.
Compare the trip's check dates with the research's dates and disclose a mismatch.
For an already tracked build, recognized acquisition offers and lists are rederived
when its research is refreshed. That can update recorded plan quotes, but does not
fetch fresh store stock. State which path was updated; do not claim a live refresh.

To make a build the active plan, use `track_build` and the normal staged review,
then the person's whole-plan approval with `approve_plan`. A shopping question is
not permission to approve a plan. To price an unapproved alternative, read its
exact research build and show its dated listings/searches as a separate preview;
do not activate the plan merely to produce shopping links. There is currently no
`shopping_trip` argument for an arbitrary research build.

## Check stores and show how to order

For a requested refresh, stage `check_stores` with explicit store keys and exact
card names (at most 300 per check; split larger lists). The check runs only when
the staged change is applied. Show its review link and scope; call `apply_change`
only after approval of that exact change. A refresh request alone does not approve
the staged payload. Read `store_stock` and `shopping_trip` after completion.

Use every applicable store from `shopping_settings`, including TCGplayer Pro
stores as well as Shopify. Austin examples include Black Castle
Gamez in Cedar Park, Multiverse Hobbies in Hutto, Mothership and Pat's Games. Store
preferences and buy rules belong to the account; do not impose these stores on
other people. Read the account's artwork preferences alongside its current price,
language, finish and condition rules; do not silently impose cosmetic restrictions.

Return clickable exact listing URLs, card name, quantity needed, known quantity
available, condition/finish, price, currency and check time. For an unknown or
blocked result, return the store search link and say what still needs confirming.
A catalog minimum is a lead until its exact variant qualifies; missing quantity
does not prove multiple copies exist. Rate limits and failed searches mean unknown,
not out of stock. Call-only stores need a phone check; pickup terms need verifying
for other regional sellers. Keep market references separate from retail quotes.

Shopify stores such as Mothership and Pat's support `/cart/VARIANT:QTY` links;
combine quantities for the same variant and say that the link replaces the
existing cart. Black Castle and Multiverse use TCGplayer Pro: link each listing
or `/search/products?q=CARD&productLineName=Magic%3A%20The%20Gathering&sort=price-asc`,
then add the confirmed variant on that store's page. Do not pretend their cart
link preloads cards. The person selects in-store pickup and completes checkout.
No link or quote establishes a purchase, and unknown stock prevents a completion
cost claim. Keep each alternative scenario separate rather than adding its copies.

## Keep selling separate

Buying from a store and selling cards to its buylist are separate actions.
Use Yama's Sell list and dated offer history where available. For these Austin
sources, the public entry points are https://buylist.mothershipatx.com/ and
https://patsgames.com/pages/buylist. Quote cash separately from credit and retail;
verify exact printing, finish, condition and accepted quantity. A market price is
not buylist demand. Never sell, buy, mark bought or move inventory to finish research.

## Handoff

Return the exact build/revision checked, the remaining copies by deck, separate
optional proxy replacements, each store's actionable links and freshness limits.
Link the current plan and shopping page, not only an archived note. If the active
trip does not represent the selected build, state that explicitly and provide the
preview links without claiming the integration has been updated. Refreshing saved
research does not by itself update an external HTML artifact; regenerate it from
the same verified source and stamp its list revision and stock date.
