# ZeroClaw runtime image (Rust) with role-scoped Secret Manager bootstrap.
# No host Docker socket is ever mounted; egress is forced through the allowlist proxy.
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

RUN curl -fsSL https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/master/install.sh \
      | bash -s -- --prebuilt --skip-quickstart

ENV PATH="/root/.cargo/bin:${PATH}"
RUN command -v zeroclaw

WORKDIR /app
COPY runtimes ./runtimes
COPY secrets ./secrets
COPY glue ./glue
COPY tsconfig.json ./tsconfig.json

ENTRYPOINT ["bun", "run", "runtimes/start.ts", "zeroclaw"]
