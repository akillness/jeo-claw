# ZeroClaw runtime image (Rust). Built from the official upstream installer.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Prebuilt binary install, skip the interactive quickstart (config is mounted read-only).
RUN curl -fsSL https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/master/install.sh \
      | bash -s -- --prebuilt --skip-quickstart

# Config is mounted at /root/.zeroclaw/config.toml (read-only) by docker-compose.
# Runs the always-on agent service across configured channels (incl. Discord).
ENTRYPOINT ["zeroclaw"]
CMD ["service", "start"]
