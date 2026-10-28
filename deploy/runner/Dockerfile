# Official GitHub runner 2.338.2, pinned to the inspected image digest.
FROM ghcr.io/actions/actions-runner:2.338.2@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY start.sh /usr/local/bin/yama-runner
RUN chmod 755 /usr/local/bin/yama-runner
USER runner
WORKDIR /runner-state
ENTRYPOINT ["/usr/local/bin/yama-runner"]
