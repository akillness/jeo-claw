FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    docker.io curl \
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

# Install Docker Compose Plugin
RUN mkdir -p ~/.docker/cli-plugins/ && curl -SL https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-linux-x86_64 -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose

# Install standalone docker CLI
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-25.0.3.tgz -o docker.tgz && \
    tar xzvf docker.tgz && \
    cp docker/docker /usr/local/bin/ && \
    rm -rf docker docker.tgz
