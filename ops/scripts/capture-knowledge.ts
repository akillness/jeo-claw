// ops/scripts/capture-knowledge.ts
// WORKFLOW.md 9-CAPTURE: 완료 작업을 vault에 적재한다.
//   1) raw/sources/<slug>.md  불변 원천 (write-if-absent)
//   2) wiki/sources/<slug>.md  LLM 요약 stub (write-if-absent)
//   3) log.md append + index.md 링크 추가 (없을 때만)
// 순수 빌더(buildArtifacts) + 주입식 FS(CaptureFs)로 테스트 가능하게 분리한다.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path/posix";

export interface CaptureInput {
  title: string;
  slug: string;
  summary: string;
  tags: readonly string[];
  runtime: string;
  evidence: readonly string[];
}

export interface CaptureArtifacts {
  rawPath: string;
  rawContent: string;
  wikiPath: string;
  wikiContent: string;
  logPath: string;
  logLine: string;
  indexPath: string;
  indexLink: string;
}

export interface CaptureResult {
  ok: boolean;
  written: string[];
  skipped: string[];
  reasons: string[];
}

// 파일 시스템을 주입해 단위 테스트에서 실제 디스크를 건드리지 않는다.
export interface CaptureFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

const SOURCES_MARKER = "<!-- SOURCES -->";
const LOG_MARKER = "<!-- LOG -->";

export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isoDate(now: Date): string {
  const iso = now.toISOString();
  return iso.slice(0, 10);
}

function renderTags(tags: readonly string[]): string {
  return `[${tags.join(", ")}]`;
}

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}

export function validateInput(input: CaptureInput): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.title.trim() === "") reasons.push("--title 필수");
  if (input.slug.trim() === "") reasons.push("--slug 필수");
  if (input.summary.trim() === "") reasons.push("--summary 필수");
  return { ok: reasons.length === 0, reasons };
}

// 순수 함수: 입력 → 적재할 모든 파일 콘텐츠.
export function buildArtifacts(
  input: CaptureInput,
  now: Date,
  vaultRoot = join("ops", "vault"),
): CaptureArtifacts {
  const date = isoDate(now);
  const tags = renderTags(input.tags);
  const evidenceLines =
    input.evidence.length > 0
      ? input.evidence.map((e) => `- ${e}`).join("\n")
      : "- (없음)";

  const rawContent = [
    frontmatter({
      title: input.title,
      slug: input.slug,
      type: "source",
      tags,
      created: date,
      runtime: input.runtime,
    }),
    "",
    `# ${input.title} (원천 기록 · 불변)`,
    "",
    "## 요약",
    input.summary,
    "",
    "## 증거 / 경로",
    evidenceLines,
    "",
    `> 이 파일은 raw 원천이다. 정정·종합은 [[wiki/sources/${input.slug}]]에서 한다.`,
    "",
  ].join("\n");

  const wikiContent = [
    frontmatter({
      title: input.title,
      slug: input.slug,
      type: "source-summary",
      tags,
      created: date,
      runtime: input.runtime,
    }),
    "",
    `# ${input.title}`,
    "",
    `> 원천: [[raw/sources/${input.slug}]]`,
    "",
    "## 무엇을·왜·결과",
    input.summary,
    "",
    "## 연결 (wikilink)",
    "- 관련 개념: <!-- [[wiki/concepts/...]] -->",
    "- 관련 개체: <!-- [[wiki/entities/...]] -->",
    "",
    "## 후속 / 진화 후보",
    "- <!-- 반복 패턴이면 RULES.md / CONSTITUTION.md 승격 검토 -->",
    "",
  ].join("\n");

  const tagLabel = input.tags.length > 0 ? ` (${input.tags.join(", ")})` : "";

  return {
    rawPath: join(vaultRoot, "raw", "sources", `${input.slug}.md`),
    rawContent,
    wikiPath: join(vaultRoot, "wiki", "sources", `${input.slug}.md`),
    wikiContent,
    logPath: join(vaultRoot, "log.md"),
    logLine: `- ${date} · [[wiki/sources/${input.slug}]] — ${input.title}${tagLabel}`,
    indexPath: join(vaultRoot, "index.md"),
    indexLink: `- [[wiki/sources/${input.slug}]] — ${input.title}`,
  };
}

// 마커 다음 줄에 한 줄을 삽입(이미 있으면 그대로 반환).
function insertAfterMarker(content: string, marker: string, line: string): string {
  if (content.includes(line)) return content;
  const idx = content.indexOf(marker);
  if (idx === -1) {
    // 마커가 없으면 끝에 append (정상 vault라면 마커가 있다).
    return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
  }
  const insertAt = idx + marker.length;
  return `${content.slice(0, insertAt)}\n${line}${content.slice(insertAt)}`;
}

// 효과 함수: 빌드한 산출물을 FS에 적용한다. raw/wiki는 immutable → write-if-absent.
export async function applyCapture(
  artifacts: CaptureArtifacts,
  fs: CaptureFs,
): Promise<CaptureResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const reasons: string[] = [];

  // 1) raw (불변): 존재하면 절대 덮어쓰지 않는다.
  if (await fs.exists(artifacts.rawPath)) {
    skipped.push(artifacts.rawPath);
    reasons.push("raw 원천이 이미 존재 — 불변 원칙으로 보존(CONSTITUTION V)");
  } else {
    await fs.mkdirp(dirname(artifacts.rawPath));
    await fs.write(artifacts.rawPath, artifacts.rawContent);
    written.push(artifacts.rawPath);
  }

  // 2) wiki stub: 존재하면 LLM 큐레이션 보존.
  if (await fs.exists(artifacts.wikiPath)) {
    skipped.push(artifacts.wikiPath);
    reasons.push("wiki 페이지가 이미 존재 — LLM 소유 보존");
  } else {
    await fs.mkdirp(dirname(artifacts.wikiPath));
    await fs.write(artifacts.wikiPath, artifacts.wikiContent);
    written.push(artifacts.wikiPath);
  }

  // 3) log append (항상)
  if (await fs.exists(artifacts.logPath)) {
    const log = await fs.read(artifacts.logPath);
    if (!log.includes(artifacts.logLine)) {
      await fs.append(artifacts.logPath, `${artifacts.logLine}\n`);
      written.push(artifacts.logPath);
    } else {
      skipped.push(artifacts.logPath);
    }
  } else {
    reasons.push(`log.md 없음(${artifacts.logPath}) — vault 부트스트랩 필요`);
  }

  // 4) index 링크 추가(없을 때만)
  if (await fs.exists(artifacts.indexPath)) {
    const index = await fs.read(artifacts.indexPath);
    const next = insertAfterMarker(index, SOURCES_MARKER, artifacts.indexLink);
    if (next !== index) {
      await fs.write(artifacts.indexPath, next);
      written.push(artifacts.indexPath);
    } else {
      skipped.push(artifacts.indexPath);
    }
  } else {
    reasons.push(`index.md 없음(${artifacts.indexPath}) — vault 부트스트랩 필요`);
  }

  return { ok: written.length > 0, written, skipped, reasons };
}

export function parseArgs(argv: readonly string[]): CaptureInput {
  let title = "";
  let slugArg = "";
  let summary = "";
  let runtime = "n/a";
  const tags: string[] = [];
  const evidence: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    switch (flag) {
      case "--title":
        title = value;
        i += 1;
        break;
      case "--slug":
        slugArg = value;
        i += 1;
        break;
      case "--summary":
        summary = value;
        i += 1;
        break;
      case "--runtime":
        runtime = value;
        i += 1;
        break;
      case "--tags":
        for (const t of value.split(",")) {
          const trimmed = t.trim();
          if (trimmed !== "") tags.push(trimmed);
        }
        i += 1;
        break;
      case "--evidence":
        for (const e of value.split(",")) {
          const trimmed = e.trim();
          if (trimmed !== "") evidence.push(trimmed);
        }
        i += 1;
        break;
      default:
        break;
    }
  }

  const slug = slugArg.trim() !== "" ? slugify(slugArg) : slugify(title);
  return { title, slug, summary, runtime, tags, evidence };
}

class NodeCaptureFs implements CaptureFs {
  async exists(path: string): Promise<boolean> {
    return await Bun.file(path).exists();
  }
  async read(path: string): Promise<string> {
    return await readFile(path, "utf8");
  }
  async write(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }
  async append(path: string, content: string): Promise<void> {
    await appendFile(path, content, "utf8");
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}

export async function runCapture(
  input: CaptureInput,
  fs: CaptureFs = new NodeCaptureFs(),
  now: Date = new Date(),
  vaultRoot = join("ops", "vault"),
): Promise<CaptureResult> {
  const valid = validateInput(input);
  if (!valid.ok) {
    return { ok: false, written: [], skipped: [], reasons: valid.reasons };
  }
  const artifacts = buildArtifacts(input, now, vaultRoot);
  return await applyCapture(artifacts, fs);
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const input = parseArgs(argv);
  const result = await runCapture(input);
  if (!result.ok && result.written.length === 0) {
    console.error("[capture] 실패:", result.reasons.join("; "));
    return 1;
  }
  for (const p of result.written) console.log(`[capture] 적재: ${p}`);
  for (const p of result.skipped) console.log(`[capture] 보존(skip): ${p}`);
  for (const r of result.reasons) console.log(`[capture] note: ${r}`);
  return 0;
}

if (import.meta.main) {
  main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
