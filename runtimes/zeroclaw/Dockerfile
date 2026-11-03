# ZeroClaw runtime image (Rust) with role-scoped Secret Manager bootstrap.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
FROM oven/bun:1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg git \
    && install -d -m 0755 /usr/share/keyrings \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) arch=x86_64; sha=3cc7f1c859a67524d5496260d29806190bc7127d2877a479a5496ce34b9b401a ;; \
      arm64) arch=aarch64; sha=eab013d82ed333689698a328b104ecaf5f5a76b046af30ab25482f0181518f3d ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/zeroclaw-labs/zeroclaw/releases/download/v0.8.7/zeroclaw-${arch}-unknown-linux-musl.tar.gz" -o /tmp/zeroclaw.tar.gz \
    && echo "$sha  /tmp/zeroclaw.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/zeroclaw.tar.gz -C /tmp zeroclaw \
    && install -m 0755 /tmp/zeroclaw /usr/local/bin/zeroclaw \
    && rm /tmp/zeroclaw /tmp/zeroclaw.tar.gz \
    && zeroclaw --version

ENV PATH="/root/.bun/bin:${PATH}"
RUN bun install --global jeopi-cli@16.6.14 && jeopi --version \
    && git init /tmp/jeo-skills \
    && git -C /tmp/jeo-skills fetch --depth 1 https://github.com/akillness/jeo-skills.git 08fe9ed5d1e7d801c77ac944c0015b1d92709688 \
    && git -C /tmp/jeo-skills checkout --detach FETCH_HEAD \
    && mkdir -p /opt/jeo-skills \
    && cp -a /tmp/jeo-skills/.agent-skills/. /opt/jeo-skills/ \
    && test -r /opt/jeo-skills/debugging/SKILL.md \
    && rm -rf /tmp/jeo-skills

WORKDIR /app
COPY runtimes ./runtimes
COPY secrets ./secrets
COPY glue ./glue
COPY tsconfig.json ./tsconfig.json

ENTRYPOINT ["bun", "--smol", "run", "runtimes/start.ts", "zeroclaw"]
