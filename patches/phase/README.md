# Phase source moved

The maintained source is now <https://github.com/bryanroscoe/yama-phase> (public since 31 October 2026;
the earlier private repository is `bryanroscoe/yama-phase-archive`).
Yama records its repository and full commit in `deploy/phase-repo` and `deploy/phase-rev`.
Clone the engine beside Yama as `../yama-phase`. Releases fetch the published pin;
they do not apply this directory as a patch series.

`0001-private-ci-backend.patch` exports the private CI-only changes for repository
provenance, as required by the agent instructions. It does not change the engine
source or Yama's pinned revision, and is not a release input.

The initial private fork preserves the source of all 37 former patches at
`9b2073b0986fe580d495fce2fa58b5762e24e3eb`, with upstream history and licenses.
Historical patch files remain available in Yama's Git history at
`2ecdd08e0e3d878396d034a87054dc72cb7aed09`; they are not release inputs.
