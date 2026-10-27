# Releasing Yama

Fetch GitHub before merging, integrate the completed work into `main`, verify and publish `main`, then deploy that exact commit. Production deploys require a clean `main` matching freshly fetched `origin/main`.

This guide records Bryan's release process (2026-10-25) and default PR completion workflow
(2026-10-27). Requested repository changes have standing authorization for scoped feature pushes,
PRs, reviews, fixes and merge. Deployment, new accounts and spending remain separately authorized.
Do not stop at a local commit or leave a pending PR unmonitored.

## Default PR completion

1. Fetch current GitHub main, preserve unrelated work, implement the scoped change and run the
   required checks. Push its feature branch and open a PR with honest validation evidence.
2. Keep automatic Codex reviews enabled for Yama in
   [Codex review settings](https://chatgpt.com/codex/settings/code-review), preferably for all PRs
   and updates. Request `@codex review` explicitly when needed. A repository instruction is not
   proof that the external setting is enabled: verify the setting and a review of the actual head.
3. Resolve actionable findings, rerun affected checks and request review of material fixes.
   Obtain a subsequent independent agent review for substantive changes. If cloud review is
   unavailable, disclose why and obtain an independent Codex agent review; record the reviewed SHA.
4. Reconcile current main and verify the combined head. Merge through GitHub after checks and
   reviews are satisfied; do not bypass branch protections or force-push main. A self-authored
   agent review comment is review evidence, not a second human's GitHub approval.
5. Use event-driven PR watching while required checks or reviews are pending, with a continuation
   that handles failures/findings and carries the PR through merge. Waiting is a tracked state,
   not completion. Report the merged SHA and the independent deployment state.

The local main integration/export procedure below still governs deployments. Feature PRs normally
merge on GitHub; fetch and fast-forward the clean main checkout to that reviewed merge before
running the deployment readiness check.

## 1. Identify the changes for this release

```sh
git status --short
git worktree list
git branch -vv
```

Agree which completed branches and commits belong in the release. “Merge everything” means the intended completed changes, not every old branch or another thread's unfinished edits. Finish the work and required checks, then commit only the files belonging to that change. Keep unrelated edits in their own branch or worktree; do not use `git add -A`, stash everyone else's work, reset a shared checkout, or force-push main to make a release pass.

Use the checkout that owns `main` for integration (`git worktree list` identifies it). A feature worktree can stay on its own branch. If uncommitted work is already on main, preserve it and finish separating or committing the intended changes before merging.

## 2. Refresh GitHub before integrating

From the clean main checkout:

```sh
git fetch --prune origin
git log --left-right --oneline main...origin/main
git merge --ff-only origin/main
```

This fast-forwards main when GitHub is ahead, and leaves local commits intact when main is already ahead. If main and GitHub both have new commits, `--ff-only` stops: inspect both sides, merge `origin/main` into main explicitly, resolve the conflicts, and verify the combined result. Do not discard either side or rebase other people's shared work.

Repeat the fetch and integrate any new GitHub main commits before each feature merge. If fetching fails, stop integration until GitHub can be checked.

## 3. Merge the intended completed work

For each branch, inspect what it contributes before merging it. For example, replace the branch below with the actual completed local branch or fetched `origin/...` branch:

```sh
release_branch=feature/card-swaps
git log --oneline main.."$release_branch"
git diff main..."$release_branch"
git merge --no-ff "$release_branch"
```

Resolve conflicts deliberately and review the result, including migrations, `ARCHITECTURE.md`, generated files, and the Phase repository and commit pin when they changed. Never deploy a feature branch to check whether it works in production. A merge conflict or a failing check must be resolved before release.

## 4. Verify the merged main

Run the project's required checks on the final combined code, not only on the individual branches:

```sh
CARGO_BUILD_JOBS=4 cargo test
npm test
npm run typecheck
npm run build
```

When release scripts change, also run `python3 deploy/test_release.py`. Verify the changed behavior locally (for example, inspect an actual exported PDF when changing print behavior). A failure is not a passing release check; fix it and rerun the affected checks. If integrating another change changes the tested code, check that result again.

## 5. Publish the verified main

Refresh GitHub once more before publishing:

```sh
git fetch --prune origin
git merge --ff-only origin/main
```

If GitHub advanced since the previous fetch, integrate its changes and repeat verification before pushing. Once the combined code is verified and Bryan has requested publishing the release:

```sh
git push origin main
```

A rejected push is a reason to fetch, reconcile and verify again, never to force-push. Publishing main and deploying are separate steps.

## 6. Check readiness, then deploy from main

```sh
./deploy/deploy.sh --check
```

This requires all of the following before any saget call:

- The current branch is `main`, with no tracked edits or untracked files. Detached HEAD and feature branches are refused.
- A fresh fetch of GitHub main succeeds, and the local commit equals `origin/main` exactly. Ahead, behind and diverged main checkouts are refused.
- A fresh fetch of the repository in `deploy/phase-repo` succeeds, and `deploy/phase-rev` is a full commit SHA reachable from its published `main`. The engine checkout defaults to `../yama-phase`; `YAMA_PHASE_DIR` can select another checkout without changing its remotes or working files.

The check does not merge, push, contact saget, build images or restart anything. Once it passes and deployment is requested:

```sh
./deploy/deploy.sh
```

The script repeats the checks, then exports the verified commit and pinned engine. Source, compose configuration and build labels all use that same commit. It builds on saget, backs up the database before restarting, and recreates only Yama's containers. Server configuration and secrets remain on saget.

Record the deployed revision, check `curl -fsS http://<saget-lan-address>:8099/api/health`, confirm the revision in Admin, Server, and smoke-test the changed feature on the live site. See [the deployment notes](README.md) for logs and rollback. A rollback of an existing production image is a separate recovery action, not permission to deploy a feature branch.
