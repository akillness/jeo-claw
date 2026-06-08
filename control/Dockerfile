FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY glue ./glue
COPY discord ./discord
COPY compare ./compare
COPY secrets ./secrets
COPY config ./config
COPY tsconfig.json ./tsconfig.json

USER bun
