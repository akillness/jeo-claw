import { test, expect } from "bun:test";
import {
  applyCapture,
  buildArtifacts,
  parseArgs,
  runCapture,
  slugify,
  validateInput,
  type CaptureFs,
  type CaptureInput,
} from "./capture-knowledge.ts";

// 주입식 in-memory FS — 실제 디스크를 건드리지 않는다.
class MemFs implements CaptureFs {
  files = new Map<string, string>();
  dirs: string[] = [];
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async append(path: string, content: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + content);
  }
  async mkdirp(path: string): Promise<void> {
    this.dirs.push(path);
  }
}

const NOW = new Date("2026-06-08T12:00:00Z");
const VAULT = "ops/vault";

function seededVault(): MemFs {
  const fs = new MemFs();
  fs.files.set(`${VAULT}/index.md`, "# INDEX\n\n## Sources\n<!-- SOURCES -->\n");
  fs.files.set(`${VAULT}/log.md`, "# 적재 이력\n\n<!-- LOG -->\n");
  return fs;
}

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    title: "머지 게이트 strict 비교",
    slug: "merge-gate-strict",
    summary: "truthy 우회를 strict === true로 차단하고 회귀 테스트 추가.",
    tags: ["security", "glue"],
    runtime: "both",
    evidence: ["artifacts/red-team-report.md"],
    ...overrides,
  };
}

// 1. SLUGIFY
test("slugify normalizes to kebab-case and keeps 한글", () => {
  expect(slugify("Merge Gate Strict!!")).toBe("merge-gate-strict");
  expect(slugify("  머지 게이트  ")).toBe("머지-게이트");
});

// 2. VALIDATION (guard object, not throw)
test("validateInput requires title/slug/summary", () => {
  expect(validateInput(input()).ok).toBe(true);
  const bad = validateInput(input({ title: "", summary: "" }));
  expect(bad.ok).toBe(false);
  expect(bad.reasons.length).toBe(2);
});

// 3. BUILD ARTIFACTS (pure)
test("buildArtifacts emits raw + wiki + log + index content", () => {
  const a = buildArtifacts(input(), NOW, VAULT);
  expect(a.rawPath).toBe(`${VAULT}/raw/sources/merge-gate-strict.md`);
  expect(a.wikiPath).toBe(`${VAULT}/wiki/sources/merge-gate-strict.md`);
  expect(a.rawContent).toContain("type: source");
  expect(a.rawContent).toContain("created: 2026-06-08");
  expect(a.rawContent).toContain("artifacts/red-team-report.md");
  expect(a.rawContent).toContain("[[wiki/sources/merge-gate-strict]]");
  expect(a.wikiContent).toContain("[[raw/sources/merge-gate-strict]]");
  expect(a.logLine).toContain("2026-06-08");
  expect(a.logLine).toContain("(security, glue)");
  expect(a.indexLink).toContain("[[wiki/sources/merge-gate-strict]]");
});

// 4. APPLY — fresh vault writes all four targets
test("applyCapture writes raw, wiki, appends log, inserts index link", async () => {
  const fs = seededVault();
  const result = await applyCapture(buildArtifacts(input(), NOW, VAULT), fs);
  expect(result.ok).toBe(true);
  expect(result.written).toContain(`${VAULT}/raw/sources/merge-gate-strict.md`);
  expect(result.written).toContain(`${VAULT}/wiki/sources/merge-gate-strict.md`);
  expect(result.written).toContain(`${VAULT}/log.md`);
  expect(result.written).toContain(`${VAULT}/index.md`);
  // index link inserted right after the marker
  const index = fs.files.get(`${VAULT}/index.md`) ?? "";
  expect(index).toContain("<!-- SOURCES -->\n- [[wiki/sources/merge-gate-strict]]");
  // log appended
  expect(fs.files.get(`${VAULT}/log.md`)).toContain("[[wiki/sources/merge-gate-strict]]");
});

// 5. RAW IMMUTABILITY — never overwrite existing raw source
test("applyCapture preserves existing raw source (immutable)", async () => {
  const fs = seededVault();
  const rawPath = `${VAULT}/raw/sources/merge-gate-strict.md`;
  fs.files.set(rawPath, "ORIGINAL RAW — must not change");
  const result = await applyCapture(buildArtifacts(input(), NOW, VAULT), fs);
  expect(fs.files.get(rawPath)).toBe("ORIGINAL RAW — must not change");
  expect(result.skipped).toContain(rawPath);
  expect(result.reasons.join(" ")).toContain("불변");
});

// 6. WIKI OWNERSHIP — never clobber an existing curated wiki page
test("applyCapture preserves existing wiki page (LLM-owned)", async () => {
  const fs = seededVault();
  const wikiPath = `${VAULT}/wiki/sources/merge-gate-strict.md`;
  fs.files.set(wikiPath, "CURATED WIKI — keep");
  await applyCapture(buildArtifacts(input(), NOW, VAULT), fs);
  expect(fs.files.get(wikiPath)).toBe("CURATED WIKI — keep");
});

// 7. IDEMPOTENT INDEX/LOG — second run does not duplicate links
test("applyCapture is idempotent for index link and log line", async () => {
  const fs = seededVault();
  const artifacts = buildArtifacts(input(), NOW, VAULT);
  await applyCapture(artifacts, fs);
  await applyCapture(artifacts, fs);
  const index = fs.files.get(`${VAULT}/index.md`) ?? "";
  const log = fs.files.get(`${VAULT}/log.md`) ?? "";
  const linkCount = index.split("[[wiki/sources/merge-gate-strict]]").length - 1;
  const logCount = log.split("[[wiki/sources/merge-gate-strict]]").length - 1;
  expect(linkCount).toBe(1);
  expect(logCount).toBe(1);
});

// 8. PARSE ARGS
test("parseArgs reads flags and derives slug from title when omitted", () => {
  const parsed = parseArgs([
    "--title",
    "Fix Flaky Test",
    "--summary",
    "stabilized timing",
    "--tags",
    "glue, test ,",
    "--evidence",
    "a.txt,b.txt",
  ]);
  expect(parsed.title).toBe("Fix Flaky Test");
  expect(parsed.slug).toBe("fix-flaky-test");
  expect(parsed.tags).toEqual(["glue", "test"]);
  expect(parsed.evidence).toEqual(["a.txt", "b.txt"]);
});

// 9. RUNCAPTURE — invalid input returns guard result, no writes
test("runCapture returns failure result on invalid input", async () => {
  const fs = seededVault();
  const result = await runCapture(input({ summary: "" }), fs, NOW, VAULT);
  expect(result.ok).toBe(false);
  expect(result.written.length).toBe(0);
  expect(result.reasons.join(" ")).toContain("--summary");
});
