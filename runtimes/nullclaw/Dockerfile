# NullClaw runtime image (Zig) with role-scoped Secret Manager bootstrap.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
FROM debian:bookworm-slim AS build

ARG ZIG_VERSION=0.16.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates xz-utils git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
      -o /tmp/zig.tar.xz \
    && mkdir -p /opt \
    && tar -xJf /tmp/zig.tar.xz -C /opt \
    && mv /opt/zig-x86_64-linux-${ZIG_VERSION} /opt/zig \
    && ln -s /opt/zig/zig /usr/local/bin/zig

RUN git clone --depth 1 https://github.com/nullclaw/nullclaw.git /src
WORKDIR /src
RUN zig build -Doptimize=ReleaseSmall -p /usr/local

FROM oven/bun:1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d -m 0755 /usr/share/keyrings \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/nullclaw /usr/local/bin/nullclaw

WORKDIR /app
COPY runtimes ./runtimes
COPY secrets ./secrets
COPY glue ./glue
COPY tsconfig.json ./tsconfig.json

ENTRYPOINT ["bun", "run", "runtimes/start.ts", "nullclaw"]
