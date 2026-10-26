# Spec: votes (secret council, council's dilemma) resolve without doing anything

Root cause (observed behaviour): when a spell or ability tells each player to vote (secret council, council's dilemma), phase resolves it with no votes recorded and none of the vote-dependent effects happen. With Círdan the Shipwright the enters trigger doesn't appear at all. (Will of the council votes on Council's Judgment and Sail into the West did record votes in the same sweep, and Elrond of the White Council's secret council vote was recorded; see `gain-control-of-chosen-or-all-creatures.md` for Elrond.)

Related: `choices-on-resolution-not-acted-on.md` (non-vote choices), `friend-or-foe-is-a-choice.md`, and for Mob Verdict's "that player and each creature that player controls" damage, `damage-to-each-player-and-their-creatures.md` (Incite Rebellion).

Scenarios (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-mob-verdict`, `card-trap-the-trespassers`, `card-travel-through-caradhras`, `card-c-rdan-the-shipwright`.

## 1. Cards

Oracle text from Scryfall.

- **Mob Verdict** ({2}{R}{R} sorcery): "Secret council — Each player secretly votes for another player, then those votes are revealed. For each vote an opponent received, Mob Verdict deals 2 damage to that player and each creature that player controls. For each vote you received, draw a card."
  - Ruling 2024-02-02: "Each player must vote for another player. They can't abstain."
- **Trap the Trespassers** ({2}{U} instant): "Secret council — Each player secretly votes for a creature you don't control, then those votes are revealed. For each creature with one or more votes, put that many stun counters on it, then tap it. (If a permanent with a stun counter would become untapped, remove one from it instead.)"
  - Rulings 2023-06-16: "None of the creatures are targeted." "Each player must vote for one of the available options. They can't abstain."
- **Travel Through Caradhras** ({5}{G} sorcery): "Council's dilemma — Starting with you, each player votes for Redhorn Pass or Mines of Moria. For each Redhorn Pass vote, search your library for a basic land card and put it onto the battlefield tapped. If you search your library this way, shuffle. For each Mines of Moria vote, return a card from your graveyard to your hand. Exile Travel Through Caradhras."
- **Círdan the Shipwright** ({3}{G}{U} legendary creature 3/4): "Vigilance. Secret council — Whenever Círdan enters or attacks, each player secretly votes for a player, then those votes are revealed. Each player draws a card for each vote they received. Each player who received no votes may put a permanent card from their hand onto the battlefield."
  - Ruling 2023-06-16: "After the votes are revealed, first the player whose turn it is draws a card for each vote they received, then each other player in turn order does so. Then, if the first player received no votes, they may put a permanent card from their hand onto the battlefield. Then each other player in turn order does the same."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main, turn 2): the lands for the card, Grizzly Bears; hand: the card, Wastes; graveyard: Hill Giant, Divination; library: 8 Wastes. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire; hand: 2 Wastes; graveyard: Hill Giant; library: 8 Wastes. Seat 0 casts the card (no targets). Two players, so each vote has two voters.

## 3. Correct result

**Mob Verdict.** Each player must vote for another player, so in a two-player game seat 0 votes for seat 1 and seat 1 votes for seat 0. Fully determined:
- Seat 1 (an opponent) received 1 vote: 2 damage to seat 1 (20 → 18) and 2 damage to each creature seat 1 controls. Seat 1's Grizzly Bears dies (graveyard: Grizzly Bears, Hill Giant); Serra Angel has 2 damage.
- Seat 0 received 1 vote: seat 0 draws 1 card (hand Wastes, Wastes; library 7).
- Seat 0's own Grizzly Bears is not damaged.

**Trap the Trespassers.** Each player votes for a creature seat 0 doesn't control: seat 1's Grizzly Bears or Serra Angel. Votes are each player's choice, but two votes are always cast:
- both on one creature: it gets 2 stun counters and is tapped; or
- one each: each gets 1 stun counter and is tapped.
Either way at least one of seat 1's creatures ends tapped with stun counters, and the total number of stun counters is 2.

**Travel Through Caradhras.** Two votes, each for Redhorn Pass or Mines of Moria (players' choice).
- Per Redhorn Pass vote: seat 0 (the caster, "you") searches for a basic land (Wastes) and puts it onto the battlefield tapped; shuffle once if searched.
- Per Mines of Moria vote: seat 0 returns a card from its graveyard to its hand (Hill Giant or Divination).
- Then Travel Through Caradhras goes to **exile**, not the graveyard.
So with two votes seat 0 gets two "rewards": two searches (a basic land each; the searcher may fail to find, 701.23b, but Wastes are available), or one search and one returned card, or two returned cards (returning is mandatory while the graveyard has cards). Travel Through Caradhras ends in exile.

**Círdan the Shipwright.** Círdan enters; its secret council trigger goes on the stack and resolves. Each player votes for a player (any player, including themselves). Two votes total, so two cards are drawn in total, split by who received the votes (seat 0 first, then seat 1). Any player who received no votes may then put a permanent card from their hand onto the battlefield (Wastes are permanent cards). Forge: seat 0 voted seat 1, seat 1 voted seat 0, each drew 1.

## 4. Why

1. 701.38a: "To vote, each player, starting with a specified player and proceeding in turn order, chooses one of those choices." Votes happen as the spell or ability resolves (608.2d: choices made while applying the effect), and every player must vote (rulings above: no abstaining).
2. The effects that follow are instructions in the spell's text and are carried out in order (608.2c). Nothing makes them optional except the explicit "may" in Círdan's last sentence.
3. Travel Through Caradhras's last sentence moves it to exile; it is an instruction executed during resolution, so 608.2n (put into graveyard as the final part of resolution) doesn't apply to a card that has already left the stack.
4. Círdan: "Whenever Círdan enters" is an enters-the-battlefield trigger (603.6a); it triggers and goes on the stack the next time a player would receive priority (603.3).

## 5. What phase did

- Mob Verdict: no votes logged, no damage, no draw (Forge: votes p0→p1, p1→p0; seat 1 at 18, Bears dead, Angel 2 damage, seat 0 drew 1).
- Trap the Trespassers: no votes, no counters, nothing tapped (Forge: both voted Serra Angel; it has 2 stun counters, tapped).
- Travel Through Caradhras: no votes, nothing searched or returned, and the card went to the graveyard instead of exile (Forge: votes Mines of Moria + Redhorn Pass; Hill Giant returned to hand, a tapped Wastes fetched, card exiled).
- Círdan: Círdan entered but its trigger never went on the stack; nobody drew (Forge: each player drew 1).

## 6. Variations to test

- Mob Verdict with three players: each vote for an opponent deals 2 per vote to that player and their creatures; votes for the caster draw cards.
- Trap the Trespassers on a creature that's already tapped (it still gets the stun counters; ruling). Votes may name a creature with hexproof or protection from blue (not targeted).
- Travel Through Caradhras when the caster's graveyard is empty (Mines of Moria votes do nothing) and when the library has no basic land (search finds nothing, still shuffle). It is exiled in every case.
- Círdan attacking: the same trigger on attack.
- Círdan where all votes go to one player: the other player may put a permanent card (e.g. a land) from hand onto the battlefield.
- "Whenever players finish voting" triggers (e.g. Grudge Keeper) trigger once per vote, after the votes.

## 7. Acceptance checks

- Mob Verdict in a two-player game always deals 2 to the opponent and each of their creatures and draws its caster one card.
- Trap the Trespassers always puts a total of two stun counters (two players) on the opponent's creatures and taps each creature that got any.
- Travel Through Caradhras records two votes in a two-player game, carries out one search or one return per vote, and ends in exile.
- Círdan's enters trigger goes on the stack and, in a two-player game, results in exactly two cards drawn.

## Added from triage batch 1: Fateful Tempest (council's dilemma)

Scenario: `card-fateful-tempest`. Observed: Forge holds the vote (seat 0 present, seat 1 past), mills one card and exiles one. Phase moves Fateful Tempest from the stack to the graveyard with no vote and no other effect.

- **Fateful Tempest** ({2}{R} sorcery): "Council's dilemma — Starting with you, each player votes for past or present. You mill a card for each past vote, then Fateful Tempest deals damage to each opponent equal to the total mana value of cards milled this way. Exile the top card of your library for each present vote. Until the end of your next turn, you may play the exiled cards."
  - Rulings 2026-03-20: "Each player must vote for one of the available options. They can't abstain." "Votes are cast in turn order, and each player will know the votes of players who voted beforehand." "You pay all costs and follow all timing rules for cards played this way..."

Board: the sweep board (seat 0's library is 8 Wastes). Seat 0 casts Fateful Tempest; it resolves.

Correct result: seat 0 votes, then seat 1 (701.38a; each AI's own choice). With P past votes and R present votes (P + R = 2), seat 0 mills P cards (701.17a) and deals damage to seat 1 equal to their total mana value (Wastes: 0), then exiles the top R cards, which seat 0 may play until the end of its next turn. Exactly two cards leave seat 0's library (library 6). With Forge's votes: one Wastes in the graveyard, one in exile.

What phase did: no votes, no mill, no exile.

Variations: both vote past with nonland cards on top (e.g. Hill Giant, mana value 4, and Divination, 3: 7 damage to each opponent); both vote present (seat 0 may play an exiled land with its land drop, or cast an exiled spell paying its costs, until the end of its next turn); four players (four votes, damage to each opponent); library smaller than the number of votes (do as much as possible, 609.3).

Acceptance: Fateful Tempest always has every player vote, starting with its controller; cards milled = past votes, cards exiled = present votes; damage to each opponent = total mana value of the milled cards.


---

## Added from triage batch 2: Custodi Squire (will of the council), Selvala's Stampede (council's dilemma)

## Spec: Will of the council / council's dilemma votes don't happen

Scenarios: `card-custodi-squire`, `card-selvala-s-stampede` (card sweep, batch 2).

In both cards every player must vote and the result drives the effect. phase's log shows no vote at all and no effect. In other voting cards in the same batch (Truth or Consequences, Path of the Schemer) phase did log "voted ..." and "Vote resolved", so the gap is specific to these.

### 1. Cards

- **Custodi Squire** {4}{W}, Creature — Spirit Cleric, 3/3. "Flying / Will of the council — When this creature enters, starting with you, each player votes for an artifact, creature, or enchantment card in your graveyard. Return each card with the most votes or tied for most votes to your hand."
  - Ruling 2014-05-29: "You must vote for one of the available options. You can't abstain."
  - Ruling 2017-06-13: "If a choice has no votes, it can't have the most votes. If all choices have zero votes, the voting ability has no effect."
- **Selvala's Stampede** {4}{G}{G}, Sorcery. "Council's dilemma — Starting with you, each player votes for wild or free. Reveal cards from the top of your library until you reveal a creature card for each wild vote. Put those creature cards onto the battlefield, then shuffle the rest into your library. You may put a permanent card from your hand onto the battlefield for each free vote."
  - Ruling 2016-08-23: "You must vote for one of the available options. You can't abstain."
  - Ruling 2016-08-23: "The effects of each council's dilemma ability happen in the stated order. First the vote occurs, then the first effect, and finally the second effect."

### 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

- `card-custodi-squire`: lands Plains + 4 Wastes. Seat 0 casts Custodi Squire; its enters trigger resolves.
- `card-selvala-s-stampede`: lands Forest, Forest + 4 Wastes. Seat 0 casts Selvala's Stampede; it resolves.

### 3. Correct result

**Custodi Squire.** The only artifact, creature or enchantment card in seat 0's graveyard is Hill Giant (Divination is a sorcery). Seat 0 votes, then seat 1; each must vote for Hill Giant. Hill Giant has the most votes and returns to seat 0's hand. Final: seat 0's hand Hill Giant + Wastes; graveyard Divination. (Forge matches: "p0 voted for Hill Giant, p1 voted for Hill Giant".)

**Selvala's Stampede.** Seat 0 votes, then seat 1, each for wild or free (each AI's choice). Then:
- For the wild votes: seat 0 reveals cards from the top of its library until it has revealed a creature card for each wild vote. The library is 8 Wastes, so if there is at least one wild vote, all 8 are revealed, no creature is found, nothing enters, and the revealed cards are shuffled back (library 8).
- For each free vote seat 0 may put a permanent card from its hand onto the battlefield. Wastes is a permanent card (a land), so with one or more free votes seat 0 may put its Wastes onto the battlefield.
- Forge: seat 0 voted free, seat 1 wild; Forge revealed and shuffled, and put the Wastes onto the battlefield.
- The vote itself must take place: two votes are cast, and the log should show them.

### 4. Why

1. 701.38a: to vote, each player, starting with the specified player and going in turn order, chooses one of the options. Voting is mandatory (rulings).
2. Custodi Squire: the options are artifact, creature or enchantment cards in the Squire controller's graveyard. With exactly one such card, both votes go to it, it has the most votes, and it returns to hand. "If all choices have zero votes, the voting ability has no effect" can't apply here, because both players must vote and there is an option to vote for.
3. Selvala's Stampede: the first effect depends on the number of wild votes and the second on the number of free votes; two votes total, so at least one of the two effects has a non-zero count. A wild vote always causes a reveal and a shuffle; a free vote gives an optional put.

### 5. What phase did

- Custodi Squire: entered; nothing else is logged. Hill Giant stayed in the graveyard.
- Selvala's Stampede: resolved and went to the graveyard with no vote, reveal or shuffle logged; the Wastes stayed in hand. Taken alone, that end state could match "both voted free, seat 0 declined both puts", which is legal; but no vote is logged, unlike phase's other voting cards. **Confidence for Selvala's Stampede is medium**; Custodi Squire is definite.

### 6. Variations to test

- Custodi Squire with Hill Giant and an artifact card in the graveyard, players voting differently: tie, both return.
- Custodi Squire with no artifact, creature or enchantment card in the graveyard: no votes possible, no effect.
- Custodi Squire leaves the battlefield before its trigger resolves: the vote still happens and the card still returns (ruling).
- Selvala's Stampede with both votes wild and two creature cards in the library: both creatures enter; the other revealed cards are shuffled in.
- Selvala's Stampede with both votes free and two permanent cards in hand: seat 0 may put up to two onto the battlefield.
- Extra votes (an effect giving a player more votes) are cast at the same time as that player's normal vote (701.38d).

### 7. Acceptance checks

- After Custodi Squire on this board, Hill Giant is in seat 0's hand and Divination is still in seat 0's graveyard; the log shows one vote from each player.
- After Selvala's Stampede on this board, the log shows one vote from each player; if any vote was wild, seat 0's library was revealed and shuffled (still 8 cards); if any vote was free, seat 0 was offered to put its Wastes onto the battlefield.
