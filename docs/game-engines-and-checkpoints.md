# Play engines and saved game points

Bryan, 30 October 2026: players must be able to choose Forge or Phase, resume
either engine from an earlier point without replaying the game, and eventually
switch the engine of an ongoing game. Start with engine choice at game creation;
direct restoration is a core requirement, rather than a replay optimisation.

This is the implementation contract. Engine selection and checkpoints are not
implemented by the Phase board integration. Play owns a current Phase `Match`
and a preserved worker for recognised older Phase saves; both recovery paths
reconstruct action logs. Forge is a separate, authenticated, batch-only Lab worker. Reconnecting a browser
reattaches to a running game; restarting Yama currently reconstructs from its
seed and action log. Neither is a durable saved point with direct restoration.

## Engine choice

Keep the presentation independent of the rules and AI engine. “Phase board”
currently names a presentation, not a choice of game engine. At creation, the
host chooses the engine; all seats at that table use it. Show each engine's card
coverage and available AI settings. Preserve the engine on rematches unless the
host changes it. Existing games retain Phase as their explicit engine.

Introduce one runtime boundary for creation, authorised actions, per-viewer
projection, public timeline metadata, checkpoint capture and checkpoint restore.
Engine-specific action tokens and decision shapes remain opaque to Yama. A
generic interface must not reduce Forge's choices to Phase's legal-action list.
Adapters must cover combat declarations, costs, targets, modes, optional and
ordered choices, concessions and all other offered decisions before advertising
interactive play as available. Capability discovery distinguishes interactive
play, direct restore and cross-engine import; batch support implies none of them.

Forge remains its own program and source repository. Add an interactive worker
driver beside the batch driver, using Yama-owned game/session identifiers and a
bounded command channel. An engine process receives no account credentials.
Yama continues to enforce account membership and seat authority, quotas, command
idempotency and stale-action rejection. Cancelled or disconnected requests must
not cause a submitted command to execute twice.

## Timeline and restoration

Capture a complete initial position and every accepted engine transition,
including AI decisions and automatic passes within a published batch. Rejected
commands add no position. A timestamp points to the last committed position at
or before it; reducers' private intermediate instructions are not playable
positions. Each entry has a stable sequence, wall time, turn/step, acting seat,
engine build, card-data build and checkpoint-format version. Timeline metadata
uses public facts only. User controls and remembered answers that affect future
play belong to the position as well.

The authoritative snapshot is private server data. It includes hidden zones in
their exact order, object identities, continuous/delayed effects, pending
triggers and replacements, stack and suspended resolution, partial payment and
undo information, combat, player/commander state, the random stream and its
cursor. Restore through the engine's checked native restore boundary after
rehydrating runtime card data. A viewer projection, board dump or seed is not a
checkpoint. Phase's state codec transports exact JSON but explicitly does not
provide trusted restore authority; use the engine's `PersistedGameState` API
for that boundary. Its restore rotates opaque capabilities, so continuation
history must root at the restored checkpoint, rather than append new actions to
a replay that still assumes only the original seed.

Store immutable compressed payloads with integrity hashes, independently from
the public timeline. A new format/build needs a tested migration or an available
matching runtime; refuse incompatible data with a clear error. Never silently
substitute the current build or restart from the opening hand. The ordinary
restore path must apply **zero historical actions**. Old seed/action recordings
may be converted once by a separate, explicit migration that labels the work;
they must not be advertised as direct-restorable before conversion succeeds.

Keep checkpoint writes and their timeline/revision in one transaction. Record
the command ID atomically with its resulting position. Bound payload sizes and
account storage; do not silently discard promised restore points. Measure
compression, write cost and growth on full Commander games before choosing
retention or enabling every-action capture on large Lab tournaments. Play,
watching and offline sessions use the same checkpoint format and guarantees;
Lab checkpoint retention needs an explicit policy rather than unbounded output.

“Resume from here” creates a continuation with its parent game and checkpoint
recorded, preserving the original game and subsequent history. A host may fork
their own solo game with AI. For a multiplayer table, obtain consent from every
affected human seat before restoring or changing engines. A practice fork must
not impersonate another person or count a duplicate result in playgroup stats.
The new session has new command/revision authority; queued commands from the
original session cannot apply to it. Each viewer still receives only their own
filtered state. Account deletion removes payloads and continuation links as well
as ordinary online-game records. No public replay endpoint exposes raw snapshots.

## Engine work

- **Phase:** wrap checked `PersistedGameState` capture/restore with Yama's
  controls, remembered answers, log, feed/statistics, AI configuration and
  continuation provenance. Rebuild disposable caches, and explicitly preserve
  any AI memory or certified continuation needed after a suspended choice.
  Audit every skipped serialized field against the restore API before claiming
  complete capture. Do not alter Phase's random cursor on resume.
- **Forge:** inspect its native snapshot and game-state APIs in the separate
  Forge repository. The current Yama batch worker exports final results only.
  An in-memory `GameSnapshot` and a board-import text format do not establish
  disk-restorable coverage of an arbitrary suspended decision. Add explicit
  persistence for any missing state/continuations in Forge itself, and expose
  yield/capture/restore through its interactive driver. Keep the actual source
  patch and tests with the pinned Forge distribution.
- **Cross-engine switching:** export a versioned semantic position from the
  source engine and validate it against the destination's import capabilities.
  Match cards by stable identity, preserve ordering and hidden information, and
  account for every pending rule obligation. Engine-specific resolution frames,
  effects and choice tokens cannot be relabelled as the other engine's state.
  Refuse unsupported positions without changing the source game. At minimum
  support validated agreed decision boundaries first; expand coverage with
  fixtures until nonempty stacks and suspended choices are supported too.

## Acceptance evidence

For each engine, persist to bytes, destroy the original runtime, start a fresh
runtime and restore with historical action application instrumented to fail.
Compare all seats' projections, hidden-state invariants and legal decisions.
Continue both the uninterrupted and restored games through identical submitted
choices, checking random outcomes and final results. Exercise restart recovery
and a continuation from the middle of a finished game's timeline.

Cover opening/mulligan, priority, nonempty stack, target/mode/number decisions,
payment/cancel, replacement ordering, optional and delayed triggers, combat
declarations/damage, copied objects, elimination/concession and terminal states.
Include corrupted snapshots, wrong engine/card versions, duplicate commands,
write failure, unauthorised viewers, deletion and stale commands from the parent.
For cross-engine imports, compare semantically equivalent positions and future
outcomes under scripted choices, including explicit refusal fixtures. A successful
import of life totals and visible permanents alone is not acceptance evidence.

## Delivery order

1. Complete and validate the Phase board integration against the engine upgrade.
2. Add the interactive engine boundary and Forge driver; expose creation and
   rematch selection only once both adapters pass the decision/privacy tests.
3. Add engine-native durable checkpoint capture, timeline/continuation APIs and
   UI, restart recovery, then offline-session integration. Build and validate the
   native capture/restore primitives alongside each adapter, not as an afterthought.
4. Add validated cross-engine export/import and the ongoing-game switch control.
   Show availability for the selected position, not a promise that every opaque
   engine continuation already translates.
