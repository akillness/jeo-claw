import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readArtifact } from "./repo-work.ts";

test.skipIf(process.platform === "linux")("unsupported platforms reject artifact generation before starting git", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "worker-artifacts-"));
  try {
    const bin = join(fixture, "bin");
    const marker = join(fixture, "git-invoked");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\nprintf invoked > "$GIT_MARKER"\nexit 1\n');
    await chmod(join(bin, "git"), 0o755);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "repo-work.ts")).href;
    const script = `
      import { generateImprovement } from ${JSON.stringify(moduleUrl)};
      try {
        await generateImprovement("nullclaw", { repo: "example/repo" }, "request", "wf-test");
        console.log("unexpected success");
      } catch (error) {
        console.log(error.message);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: fixture,
      env: { ...process.env, PATH: bin, GIT_MARKER: marker, TMPDIR: fixture, TEMP: fixture, TMP: fixture },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({
      exitCode: 0,
      stdout: "Secure artifact collection requires Linux descriptor-relative access",
      stderr: "",
    });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("oversized artifacts are rejected before their contents are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-artifacts-"));
  try {
    const file = await open(join(root, "large"), "w");
    try { await file.truncate(1024 * 1024 + 1); } finally { await file.close(); }
    let reads = 0;
    const guardedOpen: typeof open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "read" || prop === "readFile") return () => { reads++; throw new Error("oversized content read"); };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    expect(await readArtifact(root, "large", guardedOpen)).toEqual({ reason: "exceeds 1MB" });
    expect(reads).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("rejects symlinks and nonregular or hard-linked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-artifacts-"));
  try {
    await writeFile(join(root, "file"), "secret");
    await symlink("file", join(root, "link"));
    await symlink("/tmp", join(root, "parent"));
    await mkdir(join(root, "directory"));
    await link(join(root, "file"), join(root, "hardlink"));
    await expect(readArtifact(root, "link")).rejects.toMatchObject({ code: "ELOOP" });
    await expect(readArtifact(root, "parent/file")).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readArtifact(root, "directory")).toEqual({ reason: "not a regular file" });
    expect(await readArtifact(root, "hardlink")).toEqual({ reason: "hard-linked file" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("protected git and workflow files never become artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-artifacts-"));
  try {
    await mkdir(join(root, "project", ".git"), { recursive: true });
    await mkdir(join(root, "project", ".github", "workflows"), { recursive: true });
    await writeFile(join(root, "project", ".git", "config"), "credential");
    await writeFile(join(root, "project", ".github", "workflows", "ci.yml"), "protected workflow");
    expect(await readArtifact(root, "project/.git/config")).toEqual({ reason: "under .git" });
    expect(await readArtifact(root, "project/.github/workflows/ci.yml")).toEqual({ reason: "under .github/workflows" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("returns regular file content and closes descriptors on success and failed traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-artifacts-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "file"), "actual change\n");
    const handles: FileHandle[] = [];
    const trackingOpen: typeof open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    };
    expect(await readArtifact(root, "nested/file", trackingOpen)).toEqual({ content: "actual change\n" });
    for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    handles.length = 0;
    expect(await readArtifact(root, "nested/missing/file", trackingOpen)).toEqual({ reason: "deleted or missing" });
    for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await readArtifact(root, "nested/deleted", trackingOpen)).toEqual({ reason: "deleted or missing" });
    await expect(readArtifact(join(root, "missing-root"), "file")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
