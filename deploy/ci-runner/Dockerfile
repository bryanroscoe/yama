# Toolchains are preinstalled; jobs need no root, Docker access, or hosted caches.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node
FROM rust:1.98.1-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730 AS rust
FROM ghcr.io/actions/actions-runner:2.338.2@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev libsqlite3-dev python3 procps time openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=rust /usr/local/rustup /opt/rustup
COPY --from=rust /usr/local/cargo/bin /usr/local/cargo/bin
ENV PATH="/usr/local/cargo/bin:${PATH}" \
    RUSTUP_HOME=/opt/rustup RUSTUP_TOOLCHAIN=1.98.1 \
    CARGO_HOME=/ci-cache/cargo CARGO_TARGET_DIR=/ci-cache/target \
    NPM_CONFIG_CACHE=/ci-cache/npm \
    ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/bin/yama-ci-cleanup.sh
COPY start.sh /usr/local/bin/yama-ci-runner
COPY cleanup.py /usr/local/lib/yama-ci-cleanup.py
COPY cleanup.sh /usr/local/bin/yama-ci-cleanup.sh
RUN chmod 755 /usr/local/bin/yama-ci-runner /usr/local/bin/yama-ci-cleanup.sh \
 && rustc --version && node --version && npm --version
USER runner
WORKDIR /runner-state
ENTRYPOINT ["/usr/local/bin/yama-ci-runner"]
