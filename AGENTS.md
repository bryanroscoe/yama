# Project instructions

- Read README.md and ARCHITECTURE.md before changing plans. ARCHITECTURE.md is the plan of record; update it when a decision changes.
- Yama is free. Anyone with a verified Google account may sign up (Bryan, 22 Oct 2026: open sign-up, Google only, no username/password sign-in on the server); invited accounts get the larger allowance. Keep every user's data private to them. Ship no card images, mana symbol art, or rules documents; images load from Scryfall at runtime. Keep the "unofficial, not endorsed by Wizards" notice.
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
- Web: React 19 + Vite, plain CSS with the tokens in `web/src/styles.css`. The design is "Night table" (`design/tokens.md`, chosen 2026-10-19; felt green is retired): near-black neutral ground, commander art behind players and decks under a dark wash, white as the only accent, mana colors only to mean whose. Never filter, blur or fade a card image, and credit the artist wherever an art crop shows. Gradients only as washes over art, no all-caps labels, no middle-dot meta strings.
