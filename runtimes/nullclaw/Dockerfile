# NullClaw runtime image (Zig) with role-scoped Secret Manager bootstrap.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
FROM debian:bookworm-slim AS build

ARG TARGETARCH
ARG ZIG_VERSION=0.16.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils git \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) arch=x86_64; sha=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;; \
      arm64) arch=aarch64; sha=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && test "$ZIG_VERSION" = 0.16.0 \
    && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
    && echo "$sha  /tmp/zig.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/zig \
    && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
    && ln -s /opt/zig/zig /usr/local/bin/zig

RUN git init /src \
    && git -C /src fetch --depth 1 https://github.com/nullclaw/nullclaw.git 5f1cade05c19b6ecdfb9565ae3305e892e484da9 \
    && git -C /src checkout --detach FETCH_HEAD
WORKDIR /src
RUN zig build -Doptimize=ReleaseSmall -p /usr/local

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
COPY --from=build /usr/local/bin/nullclaw /usr/local/bin/nullclaw

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

ENTRYPOINT ["bun", "run", "runtimes/start.ts", "nullclaw"]
