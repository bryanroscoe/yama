# Release trains: one gate and one deploy for many PRs

Bryan, 11 Nov 2026: "we get stuck behind other builds too often… Can we land multiple changes at
once and release multiple to prod at once with some coordination".

A Rust `scripts/local-ci.sh` run rebuilds Yama's crates under a lock on the shared Cargo target and
needs the machine's one compiler slot. With several threads each running it per PR, a run took
about an hour, nearly all of it waiting, and every merge was its own deploy. A release train runs
the full gate once on the combined tree and lands it as one merge.

## When this applies

Only while GitHub CI tests are off (`gh variable get CI_TESTS` says `off`; docs/ci.md). With tests
on, the per-PR rules in AGENTS.md and the `Local-CI` trailer apply and there are no trains.

`~/Developer/.agent-tasks/yama-release-trains/COORDINATOR.json` names the coordinating thread and
its lease:

```json
{ "active": true, "coordinator_thread": "<thread id>", "since": "<UTC time>", "lease_until": "<UTC time>" }
```

The lease is read and changed only through `scripts/ci/train_lease.py`, which does every
read-decide-write under one exclusive file lock, so two threads can't both take it and a thread
whose lease lapsed can't merge after another took over:

```sh
python3 scripts/ci/train_lease.py status                       # exit 0: someone coordinates; 3: nobody
python3 scripts/ci/train_lease.py acquire --thread ID --title "who"   # exit 1 if another thread holds it
python3 scripts/ci/train_lease.py renew --thread ID            # the holder, when it cuts or lands a train
python3 scripts/ci/train_lease.py release --thread ID          # when it stops coordinating
python3 scripts/ci/train_lease.py run --thread ID -- COMMAND   # COMMAND runs only while ID holds the lease
```

- **A coordinator is active** when `status` exits 0: the file exists, `active` is true and
  `lease_until` is in the future. Then **only that thread merges to main** and nobody else starts
  a full `scripts/local-ci.sh`. A lease lasts at most a day and nothing but `renew` extends it:
  not a receipt, not an open train.
- **No coordinator** (`status` exits 3): follow the per-PR rule in AGENTS.md. A receipt still
  saying `testing` under a lapsed lease is stale and blocks nothing.
- **Becoming coordinator**, when several threads are queueing and there is none: `acquire`. Only
  one caller wins.
- **Merging** is done through `run`, which checks the lease and holds the lock while the merge
  command runs, so the lease can't change hands in the middle. A thread whose lease lapsed has
  lost main: `run` refuses, it stops, and it leaves its receipt saying so.

A train changes who runs the final gate and who merges. It does not change the gate: reviews,
every local CI check, the compiler guard, owner-only decisions and host installs on saget
(deploy/RUNNER.md) all apply as before.

## For a PR owner

Everything lives in `~/Developer/.agent-tasks/yama-release-trains/`: `admit/` for admissions,
`trains/train-N.json` for receipts.

1. Get the PR, or a stack of your PRs, **ready**: reviews done (Codex, plus an independent review
   for a substantive change) and every finding resolved; rebased on current `origin/main`; the
   cheap checks passing on the exact head:
   - web or core touched: `npm test`, `npm run typecheck`, `npm run build`;
   - Rust touched: `CARGO_BUILD_JOBS=1 cargo check -p yama-server` and the tests of the modules you
     touched, in the shared target under its lock as `scripts/local-ci.sh` does. Not while a train
     is `testing` (below). If nothing compiled your head, say so: it can be admitted, marked
     unverified, and is the first thing ejected if the train fails there;
   - the Python suites you touched.

   These replace AGENTS.md's "before committing" full `cargo test` while a coordinator is active:
   the whole Rust suite runs once, on the train.
2. Write one admission file per PR or stack, `admit/<short-name>.json`:

   ```json
   {
     "owner": "who you are",
     "thread": "your thread id, if you know it",
     "prs": [206, 207, 209],
     "head": "full SHA to merge: the PR head, or the top of the stack",
     "rebased_on": "the origin/main SHA your head contains",
     "reviews": "which reviews ran and that every finding is resolved",
     "checks": "what passed on this exact head, and what did not run",
     "rust_compiled": true,
     "touches": ["server", "web", "migrations"],
     "migrations": ["0081_example.sql"],
     "live_check": "what to look at on yama.ing after the deploy",
     "notes": "expected conflicts, order, anything the coordinator should know"
   }
   ```

   A stack is one file: list its PRs bottom to top and give the top head. Mark the PRs ready.
3. **Freeze** what you admitted. Before the cut you may withdraw: delete the admission file, push,
   and write a new one. A member listed in a receipt has been cut: do not push to it or withdraw it
   on your own. Write `withdraw/<short-name>.json` (a separate folder, so it is never read as an
   admission) with the PR numbers and the reason, and wait for the receipt to show it ejected. Build your next work on new branches.
4. Stop your own full local CI run if it is still waiting for the Cargo target lock; let it finish
   if it is already compiling or testing and put the result in `checks`. Never stop another
   owner's job or touch the lock file.
5. **While a receipt says `testing`, do not hold or queue for the Cargo target lock.** The train's
   run is on the critical path for everyone; start focused Rust runs when no train is testing.
6. Wait on the receipt with one bounded wait (at most two hours). Its `status` moves through
   `testing`, `merged` and `deployed`; an ejected member is listed with the reason. After
   `deployed`, do your live check, run `scripts/sync-main.sh`, and clean up as AGENTS.md says.
7. An **ejected** member is fixed on top of the new main and admitted again.

## For the coordinator

1. **Cut.** Renew the lease. Read `withdraw/*.json` first and drop those members, then `admit/*.json`. For each, confirm the head on GitHub is the admitted head, the PRs
   are ready and the reviews are recorded. Create `release/train-N` from freshly fetched
   `origin/main` and merge each head with `git merge --no-ff`, never squash, so each PR's exact
   head stays in main's ancestry and GitHub marks it merged. Small independent members first, wide
   mechanical ones last. Resolve a conflict only when the right answer is obvious and say what you
   did in the merge commit; otherwise eject the member. Renumber colliding migrations on the train
   branch, with every reference to the old name. Check that every commit is authored and committed
   as `bryanroscoe@gmail.com`. The receipt listing a member is the acknowledgment that it was cut.
2. **Test.** Write the receipt with `status: testing`, then run
   `CARGO_BUILD_JOBS=1 scripts/local-ci.sh --no-amend` once on the train head, and the Android
   build if a member touched the paths AGENTS.md names. Fix an integration failure on the train
   branch; eject a member whose own code fails; run again on the new head.
3. **Review what the train added.** Members were reviewed before the cut; the coordinator's own
   changes were not, and taking one side of a conflict can drop behaviour both reviews assumed.
   Every conflict resolution (`git show --cc <merge>` for each merge that conflicted), every
   renumbered migration with its references and every integration fix commit gets a Codex review
   before the merge, and an independent review too if it is more than choosing between the two
   sides. A train with no conflicts and no fixes needs no further review.
4. **Merge.** Open one PR from `release/train-N` listing the members, the ejected and the evidence.
   Immediately before merging:
   - fetch, and confirm `origin/main` is still the train's base. If main moved, merge it into the
     train and run the whole of `scripts/local-ci.sh` again on the new head. A partial rerun is not
     enough;
   - confirm each member's head on GitHub is still the admitted head and no withdrawal names it;
     otherwise rebuild the train without that member and test again.

   Merge with a merge commit through the lease:
   `python3 scripts/ci/train_lease.py run --thread ID -- gh pr merge N --merge --match-head-commit <tested commit>`.
   `--match-head-commit` pins the train's head, not main, so check the result: fetch again, take
   the merge commit from `gh pr view N --json mergeCommit`, and confirm that its first parent is
   the train's base, its second parent is the tested commit and its tree is the tested tree
   (`git rev-parse <merge>^{tree}`). If any of those differ, main holds a tree nobody tested: run
   local CI on it at once and fix forward. Never force-push main.
5. **Deploy.** One push to main is one deploy (deploy/RELEASING.md). Follow it, and confirm the
   revision production verified is the merge commit: read the deploy log's "Production verified
   at" line, not the run's head, since a run can deploy an older queued revision.
6. **Receipt.** `trains/train-N.json` records the base, each member's PRs and head, the ejected
   and why, the tested commit and tree, the aggregate PR, the merge commit, and the deployed
   revision and time. Comment it on each member PR.

Never in a train: PR 29 (the historic engine switch), drafts nobody admitted, and anything that
needs an owner-only decision or a host install.

Sequential single-PR merges do not give one deploy: the runner only coalesces requests that are
still pending. One merge commit does.
