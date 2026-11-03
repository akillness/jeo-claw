import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function git(cwd: string, ...args: string[]) {
  const process = Bun.spawn(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: cwd } });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`fixture git failed: ${stderr}`);
}

test.skipIf(process.platform !== "linux").each([
  { mode: "committed", expected: { files: [{ path: "tracked.txt", content: "committed change\n" }] } },
  { mode: "too-many", expected: { error: "Agent changed more than 30 files; refusing partial artifacts" } },
  { mode: "deleted", expected: { error: "Cannot collect artifact tracked.txt: deleted or missing" } },
  { mode: "protected", expected: { error: "Cannot collect artifact project/.github/workflows/ci.yml: under .github/workflows" } },
])("repository collection: $mode", async ({ mode, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "repo-collection-"));
  try {
    const repo = join(root, "source");
    const bin = join(root, "bin");
    const home = join(root, "home");
    await mkdir(repo);
    await mkdir(bin);
    await mkdir(home);
    await git(repo, "init", "-b", "fixture-branch");
    await writeFile(join(repo, "tracked.txt"), "base\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
    await writeFile(join(bin, "git"), '#!/bin/sh\nif [ "$1" = clone ]; then exec /usr/bin/git clone -- "$FIXTURE_REPO" "$4"; fi\nexec /usr/bin/git "$@"\n');
    await chmod(join(bin, "git"), 0o755);
    const fakeAgent = `#!/usr/local/bin/bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
switch (process.env.FIXTURE_MODE) {
  case "committed":
    writeFileSync("tracked.txt", "committed change\\n");
    if (Bun.spawnSync(["/usr/bin/git", "add", "tracked.txt"]).exitCode !== 0) process.exit(2);
    if (Bun.spawnSync(["/usr/bin/git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "agent"]).exitCode !== 0) process.exit(3);
    break;
  case "too-many":
    for (let i = 0; i < 31; i++) writeFileSync("change-" + i + ".txt", String(i));
    break;
  case "deleted": rmSync("tracked.txt"); break;
  case "protected":
    writeFileSync("tracked.txt", "safe change");
    mkdirSync("project/.github/workflows", { recursive: true });
    writeFileSync("project/.github/workflows/ci.yml", "protected");
    break;
}
`;
    await writeFile(join(bin, "jeopi"), fakeAgent);
    await chmod(join(bin, "jeopi"), 0o755);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "repo-work.ts")).href;
    const script = `
      const { generateImprovement } = await import(${JSON.stringify(moduleUrl)});
      try {
        const result = await generateImprovement("nullclaw", { repo: "example/repo" }, "fixture", "wf-test");
        console.log(JSON.stringify({ files: result.files }));
      } catch (error) { console.log(JSON.stringify({ error: error.message })); }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: home,
      env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root, TEMP: root, TMP: root, FIXTURE_REPO: repo, FIXTURE_MODE: mode },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr: stderr.trim() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout.trim())).toEqual(expected);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
