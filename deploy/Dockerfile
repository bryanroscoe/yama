# syntax=docker/dockerfile:1.7
# Yama server + web app in one image. Build from the repo root with the phase fork as a
# named context:
#   See runtime/README.md for the required historical-source context as well.

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY web web
# Shared tables meet on Yama's Cloudflare relay (relay/README.md), so they work while saget is down.
ARG VITE_RELAY_URL=wss://relay.yama.ing
RUN VITE_RELAY_URL="$VITE_RELAY_URL" npm run build -w web

# Compile the pinned client's WASM roots with their own enlarged stack config.
# The cache remains in BuildKit; neither native tools nor source enter the final image.
FROM rust:1-bookworm AS board-wasm
COPY --from=web /usr/local/bin/node /usr/local/bin/node
ENV RUSTUP_TOOLCHAIN=stable CARGO_BUILD_JOBS=1
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src/yama-phase
COPY --from=phase . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/phase-target,sharing=locked \
    version="$(awk '/^name = "wasm-bindgen"$/ { found=1; next } found && /^version/ { gsub(/"/,"",$3); print $3; exit }' Cargo.lock)" \
 && test -n "$version" \
 && CARGO_TARGET_DIR=/phase-target cargo install --locked --jobs 1 --root /opt/wasm-tools wasm-bindgen-cli --version "$version" \
 && PATH="/opt/wasm-tools/bin:$PATH" CARGO_TARGET_DIR=/phase-target ./scripts/build-wasm.sh release

FROM node:22-bookworm-slim AS board
WORKDIR /src/yama-phase
COPY --from=board-wasm /src/yama-phase .
WORKDIR /src/yama-phase/client
RUN corepack enable \
 && corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate \
 && pnpm install --frozen-lockfile
COPY deploy/build-board-client.sh /build-board-client.sh
COPY deploy/phase-rev /phase-rev
RUN bash /build-board-client.sh /src/yama-phase /board "$(cat /phase-rev)"

# Historical sources are exported from exact pinned Git revisions,
# together with runtime/worker.rs by runtime/build-historical.py --prepare-only.
FROM rust:1-bookworm AS historical
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/yama
COPY runtime/verify-source.py runtime/historical-source.json /verification/
COPY --from=historical-source yama /src/yama
COPY --from=historical-source yama-phase /src/yama-phase
RUN python3 /verification/verify-source.py /src /verification/historical-source.json
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/yama/target,sharing=locked \
    CARGO_BUILD_JOBS=1 cargo build --locked --release -p yama-play-historical --bin historical-runtime \
 && cp target/release/historical-runtime /usr/local/bin/historical-runtime \
 && mkdir -p /usr/local/share/yama \
 && sha256sum /usr/local/bin/historical-runtime > /usr/local/share/yama/historical-runtime.sha256

# The v0.119 adapter keeps its native controls and replay format unchanged.
FROM historical AS historical-v0119
WORKDIR /src/v0119/yama
COPY runtime/verify-source.py runtime/v0119/historical-source.json /verification-v0119/
COPY --from=historical-v0119-source yama /src/v0119/yama
COPY --from=historical-v0119-source yama-phase /src/v0119/yama-phase
RUN python3 /verification-v0119/verify-source.py /src/v0119 /verification-v0119/historical-source.json
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=/src/yama/target,target=/src/v0119/yama/target,sharing=locked \
    YAMA_PHASE_SOURCE_REV="$(cat deploy/phase-rev)" CARGO_BUILD_JOBS=1 \
    cargo build --locked --release -p yama-play-historical-v0119 --bin historical-runtime-v0119 \
 && cp target/release/historical-runtime-v0119 /usr/local/bin/historical-runtime-v0119 \
 && sha256sum /usr/local/bin/historical-runtime-v0119 > /usr/local/share/yama/historical-runtime-v0119.sha256

FROM rust:1-bookworm AS server
# This dependency also serializes the two engine builds sharing the Cargo cache.
COPY --from=historical-v0119 /usr/local/bin/historical-runtime /usr/local/bin/historical-runtime
WORKDIR /src/yama
# The rules engine and the protocol registry used by its build scripts.
COPY --from=phase Cargo.toml /src/yama-phase/Cargo.toml
COPY --from=phase crates /src/yama-phase/crates
COPY --from=phase protocol /src/yama-phase/protocol
COPY Cargo.toml Cargo.lock ./
COPY server server
COPY play play
# The server validates a hosted board's build marker against this compiled pin.
COPY deploy/phase-rev deploy/phase-rev
COPY runtime/historical.json runtime/historical-source.json runtime/
COPY runtime/v0119/historical.json runtime/v0119/historical-source.json runtime/v0119/
# MCP documentation resources are embedded by the server at compile time.
COPY docs/research-format.md docs/research-format.md
COPY docs/local-shopping-workflow.md docs/local-shopping-workflow.md
COPY docs/mcp-tool-notes.md docs/mcp-tool-notes.md
# The public Rust renderer embeds these shared web inputs at compile time.
COPY web/src/styles.css web/src/controls.css web/src/art-framing.css web/src/
COPY web/public/precons.css web/public/site-frame-v1.css web/public/site-notice.html web/public/public-list-v1.js web/public/
# The commit this image is built from (the build context has no .git); server/build.rs stamps it.
ARG YAMA_GIT_SHA=
ARG YAMA_GIT_DIRTY=
# The target cache is shared by every build on this host, including other branches'. Cargo
# judges path crates fresh by file timestamps, so a source this tree shares with an older or
# other-branch build can look already compiled and its stale artifact (or build script) ships.
# Touch this tree's Yama and Phase sources so they always compile from what was copied in;
# crates.io dependencies stay cached. The cache is locked: one build writes it at a time.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/yama/target,sharing=locked \
    find /src/yama-phase/crates server play \( -name '*.rs' -o -name Cargo.toml \) -exec touch {} + \
 && YAMA_GIT_SHA=$YAMA_GIT_SHA YAMA_GIT_DIRTY=$YAMA_GIT_DIRTY \
    YAMA_LAB_GIT_SHA=$YAMA_GIT_SHA YAMA_LAB_GIT_DIRTY=$YAMA_GIT_DIRTY \
    YAMA_PHASE_SOURCE_REV="$(cat deploy/phase-rev)" \
    CARGO_BUILD_JOBS=4 cargo build --release -p yama-server \
 && cp target/release/yama-server /usr/local/bin/yama-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=server /usr/local/bin/yama-server /usr/local/bin/yama-server
COPY --from=server /usr/local/bin/historical-runtime /usr/local/bin/historical-runtime
COPY --from=historical /usr/local/share/yama/historical-runtime.sha256 /usr/local/share/yama/historical-runtime.sha256
COPY --from=historical-v0119 /usr/local/bin/historical-runtime-v0119 /usr/local/bin/historical-runtime-v0119
COPY --from=historical-v0119 /usr/local/share/yama/historical-runtime-v0119.sha256 /usr/local/share/yama/historical-runtime-v0119.sha256
COPY --from=web /src/web/dist /app/web
COPY --from=board /board /app/board
ENV YAMA_BIND=0.0.0.0:8787 \
    YAMA_DATA_DIR=/data \
    YAMA_WEB_DIST=/app/web \
    YAMA_BOARD_DIST=/app/board \
    YAMA_AUTO_IMPORT=1 \
    RUST_LOG=info
EXPOSE 8787
USER 99:100
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["yama-server"]
CMD ["serve"]
