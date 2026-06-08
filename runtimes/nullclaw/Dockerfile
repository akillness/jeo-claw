# NullClaw runtime image (Zig). Built from upstream source with the pinned Zig version.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
FROM debian:bookworm-slim AS build

ARG ZIG_VERSION=0.16.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils git \
    && rm -rf /var/lib/apt/lists/*

# Install the exact Zig version nullclaw requires.
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz" \
      -o /tmp/zig.tar.xz \
    && mkdir -p /opt/zig \
    && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
    && ln -s /opt/zig/zig /usr/local/bin/zig

RUN git clone --depth 1 https://github.com/nullclaw/nullclaw.git /src
WORKDIR /src
RUN zig build -Doptimize=ReleaseSmall -p /usr/local

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/nullclaw /usr/local/bin/nullclaw

# Config is mounted at /root/.config/nullclaw/config.json (read-only) by docker-compose.
ENTRYPOINT ["nullclaw"]
CMD ["serve"]
