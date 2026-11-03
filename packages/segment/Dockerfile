# MicroVM image for work segments (ARM64). The bundled segment server is copied in by the infra build.
FROM public.ecr.aws/docker/library/node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates bash curl python3 make g++ iproute2 bubblewrap socat \
      fontconfig fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji chromium \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# OpenSpec CLI, used by the repo's openspec-propose and openspec-apply-change skills. Pinned to the version the skills were generated with.
RUN npm install -g @fission-ai/openspec@1.3.1 \
 && npm cache clean --force
ENV DO_NOT_TRACK=1 OPENSPEC_TELEMETRY=0

# swamp CLI (ARM64), for repositories that have a swamp software factory. Verified against the release's published checksum.
ARG SWAMP_TAG=v20261102.201118.0-sha.83886373
RUN curl -fsSL -o /tmp/swamp "https://github.com/swamp-club/swamp/releases/download/${SWAMP_TAG}/swamp-linux-aarch64" \
 && curl -fsSL -o /tmp/checksums.txt "https://github.com/swamp-club/swamp/releases/download/${SWAMP_TAG}/checksums.txt" \
 && (cd /tmp && grep ' swamp-linux-aarch64$' checksums.txt | sed 's/swamp-linux-aarch64$/swamp/' | sha256sum -c -) \
 && install -m 755 /tmp/swamp /usr/local/bin/swamp \
 && rm -f /tmp/swamp /tmp/checksums.txt \
 && swamp --version

# Claude Code CLI, for the optional Claude Code backend (a Claude subscription instead of Amazon Bedrock). Pinned.
RUN npm install -g @anthropic-ai/claude-code@2.1.317 \
 && npm cache clean --force \
 && claude --version \
 && mkdir -p /work && chmod 755 /work
ENV DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1

# Agent commands run as this unprivileged user; the metadata service is firewalled off for it.
RUN useradd -m -u 1001 -s /bin/bash agent

WORKDIR /app
COPY segment.mjs /app/segment.mjs
EXPOSE 8080
CMD ["node", "/app/segment.mjs"]
