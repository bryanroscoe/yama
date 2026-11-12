# Future plans

Bryan, 11 Nov 2026: "Maybe we should have some sort of plans folder, a future plans folder,
something somewhere."

This folder holds plans for work that hasn't been built yet: what it would look like, how
we'd build it, what it costs and what still needs Bryan's decision. It's where an idea goes
once it's worth writing down properly but before anyone starts on it.

- **ARCHITECTURE.md is still the plan of record.** It records what has been decided and
  built. A plan here is a proposal until Bryan approves it; when he does, record the decision
  in ARCHITECTURE.md (dated, with his words) and link the plan from there.
- **One file per plan.** Start it with a status line: Proposed, Approved, In progress or
  Done, with the date and who asked for it. Name its open decisions in their own section,
  so Bryan can answer them without reading the whole thing.
- **Contracts stay where they are.** Some features already have a detailed contract in
  `docs/` (for example [game engines and saved points](../game-engines-and-checkpoints.md)).
  A plan here says how to build it and in what order; it links the contract rather than
  repeating it.
- **When it ships,** move what's still true into ARCHITECTURE.md and the relevant `docs/`
  page, mark the plan Done and leave it as history, or delete it if nothing in it is still
  useful.

## Plans

| Plan | Status | Asked for |
|---|---|---|
| [Forge in multiplayer, and switching engines](forge-in-multiplayer.md) | Proposed, 11 Nov 2026 | Bryan, 30 Oct and 11 Nov 2026 |
