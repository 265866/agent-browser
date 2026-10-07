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

# actionlint and the shellcheck it calls, for the extra-actionlint job
# (actionlint.mjs). Pinned releases, checked against their SHA-256; they live
# outside PATH so the ci.yml jobs see the same tools as before.
ARG ACTIONLINT_VERSION=1.7.12
ARG ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ARG SHELLCHECK_VERSION=v0.11.0
ARG SHELLCHECK_SHA256=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198
RUN set -eux; \
    dir=/opt/local-ci-lint; mkdir -p "$dir"; cd /tmp; \
    curl -fsSLo actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"; \
    echo "${ACTIONLINT_SHA256}  actionlint.tar.gz" | sha256sum -c -; \
    tar -xzf actionlint.tar.gz -C "$dir" actionlint; \
    curl -fsSLo shellcheck.tar.xz "https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.x86_64.tar.xz"; \
    echo "${SHELLCHECK_SHA256}  shellcheck.tar.xz" | sha256sum -c -; \
    tar -xJf shellcheck.tar.xz -C "$dir" --strip-components=1 "shellcheck-${SHELLCHECK_VERSION}/shellcheck"; \
    rm actionlint.tar.gz shellcheck.tar.xz; \
    "$dir/actionlint" -version; "$dir/shellcheck" --version

ENV CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/work/target \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /work/src
