# Project instructions

- Read README.md and ARCHITECTURE.md before changing plans. ARCHITECTURE.md is the plan of record; update it when a decision changes.
- Yama is private and free. Keep it invite-only. Ship no card images, mana symbol art, or rules documents; images load from Scryfall at runtime. Keep the "unofficial, not endorsed by Wizards" notice.
- Don't push, deploy, open accounts, or spend money without Bryan asking. The repo lives at github.com/bryanroscoe/yama (private, created 2026-10-18 at Bryan's request); keep it private.
- The phase fork's local change is kept as `patches/phase/*.patch`. If you change ../yama-phase, export the commit there again (`git format-patch`) so this repo can rebuild it.
- Prices: a missing price stays missing (never 0). Every price carries its date and source. A Scryfall/TCGplayer market price is not a store quote or proof of availability.
- Don't copy AGPL code (e.g. CollectorVision) into this repo while it's private.
- The disk is nearly full. Keep Rust debug info low (already set in Cargo.toml), use `CARGO_BUILD_JOBS=4`, and delete large downloads after use.
- Before committing: `cargo test`, `npm test`, `npm run typecheck`.

## Code

- Server: Rust 2024, Axum 0.8, sqlx 0.9 on SQLite. sqlx 0.9 requires `sqlx::AssertSqlSafe(..)` around SQL built at runtime; only ever interpolate constants or compiled search clauses, and bind every value.
- Offline-first writes are ops with client-generated IDs, applied idempotently (`applied_ops`, game event `seq`). Keep that property for any new sync path.
- The search grammar lives in `server/src/cards/search.rs`. If an offline copy is added to `packages/core`, keep them in step.
- Web: React 19 + Vite, plain CSS with the tokens in `web/src/styles.css`. The design is "the playmat": felt green, paper text, mana colors only to mean whose. No gradients as decoration, no all-caps labels, no middle-dot meta strings.
