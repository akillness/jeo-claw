import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child isolates the gateway's process-wide WebSocket replacement and CA configuration.
test("Discord REST and gateway use CONNECT on initial connection and resume, and fail closed when the proxy stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jeo-discord-proxy-"));
  try {
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdout: "pipe", stderr: "pipe" });
    const [opensslError, opensslCode] = await Promise.all([new Response(openssl.stderr).text(), openssl.exited]);
    expect({ code: opensslCode, error: opensslCode ? opensslError : "" }).toEqual({ code: 0, error: "" });
    const child = Bun.spawn([process.execPath, "--smol", "run", "discord/proxy-transport-fixture.ts"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_EXTRA_CA_CERTS: cert, TEST_KEY: key, TEST_CERT: cert },
      stdout: "pipe", stderr: "pipe",
    });
    // Hard kill bounds a stuck real-network child; it is not used to synchronize assertions.
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "proxy fixture passed\n", stderr: "" });
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
