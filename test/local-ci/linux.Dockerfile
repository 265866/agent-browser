# Linux image for the local CI runner (test/local-ci/run.mjs).
# Mirrors the ubuntu-latest jobs in .github/workflows/ci.yml. sudo is installed
# because hosted runners have it and `agent-browser install --with-deps` calls it.
FROM rust:1.99-bookworm

ARG NODE_MAJOR=24

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils ffmpeg jq sudo \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add rustfmt clippy

RUN set -eux; \
    version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r "[.[] | select(.version | startswith(\"v${NODE_MAJOR}.\"))][0].version")"; \
    curl -fsSL "https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1; \
    node --version; \
    corepack enable

# Chrome for Testing runtime libraries. The native-e2e job still runs
# `agent-browser install --with-deps`; preinstalling only keeps that step fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/work/target \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /work/src
