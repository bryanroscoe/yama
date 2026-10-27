# syntax=docker/dockerfile:1.7
# Yama server + web app in one image. Build from the repo root with the phase fork as a
# named context:
#   docker build -f deploy/Dockerfile --build-context phase=../yama-phase -t yama:latest .

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY web web
RUN npm run build -w web

FROM rust:1-bookworm AS server
WORKDIR /src/yama
# The rules engine (local fork of phase-rs; only its manifest and crates are needed).
COPY --from=phase Cargo.toml /src/yama-phase/Cargo.toml
COPY --from=phase crates /src/yama-phase/crates
COPY Cargo.toml Cargo.lock ./
COPY server server
COPY play play
# The public Rust renderer embeds these shared web inputs at compile time.
COPY web/src/styles.css web/src/styles.css
COPY web/public/precons.css web/public/site-notice.html web/public/
# The commit this image is built from (the build context has no .git); server/build.rs stamps it.
ARG YAMA_GIT_SHA=
ARG YAMA_GIT_DIRTY=
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/yama/target \
    YAMA_LAB_GIT_SHA=$YAMA_GIT_SHA YAMA_LAB_GIT_DIRTY=$YAMA_GIT_DIRTY \
    CARGO_BUILD_JOBS=4 cargo build --release -p yama-server \
 && cp target/release/yama-server /usr/local/bin/yama-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=server /usr/local/bin/yama-server /usr/local/bin/yama-server
COPY --from=web /src/web/dist /app/web
ENV YAMA_BIND=0.0.0.0:8787 \
    YAMA_DATA_DIR=/data \
    YAMA_WEB_DIST=/app/web \
    YAMA_AUTO_IMPORT=1 \
    RUST_LOG=info
EXPOSE 8787
USER 99:100
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["yama-server"]
CMD ["serve"]
