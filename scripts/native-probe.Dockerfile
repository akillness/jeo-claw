ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
# Qualification images must inherit an immutable, separately approved base.
RUN /usr/local/bin/bun -e 'if (!/^(?:sha256:[0-9a-f]{64}|.+@sha256:[0-9a-f]{64})$/.test(process.env.BASE_IMAGE ?? "")) throw new Error("BASE_IMAGE must be digest-pinned")'
COPY scripts/native-probe-fixture.ts /qualification/native-probe-fixture.ts
COPY scripts/native-probe-evidence.ts /qualification/native-probe-evidence.ts
HEALTHCHECK NONE
ENTRYPOINT ["bun", "run", "/qualification/native-probe-fixture.ts"]
