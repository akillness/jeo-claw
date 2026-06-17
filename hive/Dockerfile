FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN (curl -fsSL https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/master/install.sh | bash -s -- --prebuilt --skip-quickstart) || echo 'zeroclaw install skipped'

ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY glue ./glue
COPY discord ./discord
COPY claws ./claws
COPY hive ./hive
COPY secrets ./secrets
COPY runtimes ./runtimes
COPY config ./config
COPY scripts ./scripts
COPY compare ./compare
COPY control ./control
COPY tsconfig.json ./tsconfig.json

CMD ["bun", "run", "hive/start.ts"]
