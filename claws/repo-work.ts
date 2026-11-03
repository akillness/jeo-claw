import { access, open, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { WorkflowArtifact } from "../glue/contract.ts";

export interface RepoAnalysis {
  repo: string;
  defaultBranch: string;
  description: string | null;
  languages: Record<string, number>;
  recentCommits: {
    sha7: string;
    message: string;
    author: string;
    date: string;
  }[];
  openIssues: number;
  fileTree: string[];
  readmeExcerpt?: string;
}

function sanitizePath(path: string): { ok: boolean; reason?: string } {
  if (typeof path !== "string") {
    return { ok: false, reason: "path is not a string" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(path)) {
    return { ok: false, reason: "invalid characters or starts with invalid char" };
  }
  const segments = path.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return { ok: false, reason: "contains path traversal segments" };
  }
  if (path.startsWith("/")) {
    return { ok: false, reason: "starts with slash" };
  }
  if (segments.includes(".git")) {
    return { ok: false, reason: "under .git" };
  }
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === ".github" && segments[i + 1] === "workflows") {
      return { ok: false, reason: "under .github/workflows" };
    }
  }
  return { ok: true };
}

const MAX_ARTIFACT_BYTES = 1024 * 1024;

export async function readArtifact(
  root: string,
  path: string,
  openFile: typeof open = open,
): Promise<{ content: string } | { reason: string }> {
  if (process.platform !== "linux") throw new Error("Secure artifact collection requires Linux descriptor-relative access");
  const validation = sanitizePath(path);
  if (!validation.ok) return { reason: validation.reason ?? "invalid or protected path" };
  const parts = path.split("/");
  if (isAbsolute(path) || parts.some((part) => !part || part === "." || part === ".." || part === ".git" || part.includes("\0"))) {
    return { reason: "invalid or protected path" };
  }
  const directories = [];
  let directory = await openFile(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  directories.push(directory);
  let file;
  try {
    for (const part of parts.slice(0, -1)) {
      directory = await openFile(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(directory);
    }
    file = await openFile(`/proc/self/fd/${directory.fd}/${parts[parts.length - 1]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return { reason: "not a regular file" };
    if (stat.nlink > 1) return { reason: "hard-linked file" };
    if (stat.size > MAX_ARTIFACT_BYTES) return { reason: "exceeds 1MB" };
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) return { reason: "file grew during read" };
    return { content: buffer.toString("utf8", 0, length) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { reason: "deleted or missing" };
    throw error;
  } finally {
    try {
      if (file) await file.close();
    } finally {
      for (const handle of directories.reverse()) await handle.close();
    }
  }
}

export async function analyzeRepository(
  repo: string,
  opts: {
    token: string;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
  }
): Promise<RepoAnalysis> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBaseUrl = opts.apiBaseUrl ?? "https://api.github.com";
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}`);
  }

  const headers = {
    "Authorization": `Bearer ${opts.token}`,
    "User-Agent": "jeo-claw-hive",
    "Accept": "application/vnd.github.v3+json",
  };

  const repoRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}`, { headers });
  if (!repoRes.ok) {
    throw new Error(`Failed to fetch repo info: HTTP ${repoRes.status} ${repoRes.statusText}`);
  }
  const repoData = await repoRes.json() as any;
  const defaultBranch = repoData.default_branch || "main";

  const langRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/languages`, { headers });
  let languages: Record<string, number> = {};
  if (langRes.ok) {
    languages = await langRes.json() as any;
  }

  const commitsRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/commits?per_page=30`, { headers });
  let recentCommits: RepoAnalysis["recentCommits"] = [];
  if (commitsRes.ok) {
    const commitsData = await commitsRes.json() as any;
    if (Array.isArray(commitsData)) {
      recentCommits = commitsData.map((c: any) => ({
        sha7: c.sha ? c.sha.substring(0, 7) : "",
        message: c.commit?.message ? c.commit.message.split("\n")[0] : "",
        author: c.commit?.author?.name || c.author?.login || "Unknown",
        date: c.commit?.author?.date || "",
      }));
    }
  }

  let fileTree: string[] = [];
  try {
    const treeRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/git/trees/${defaultBranch}?recursive=1`, { headers });
    if (treeRes.ok) {
      const treeData = await treeRes.json() as any;
      if (treeData && Array.isArray(treeData.tree)) {
        fileTree = treeData.tree
          .map((t: any) => t.path)
          .filter((p: any) => typeof p === "string")
          .slice(0, 50);
      }
    }
  } catch (e: any) {
    // Ignore failures for fileTree
  }

  let readmeExcerpt: string | undefined = undefined;
  try {
    const readmeRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/readme`, { headers });
    if (readmeRes.ok) {
      const readmeData = await readmeRes.json() as any;
      if (readmeData && typeof readmeData.content === "string") {
        const rawText = Buffer.from(readmeData.content.replace(/\s/g, ""), "base64").toString("utf8");
        readmeExcerpt = rawText.substring(0, 1500);
      }
    }
  } catch (e: any) {
    // Ignore failures for readme
  }

  return {
    repo,
    defaultBranch,
    description: repoData.description || null,
    languages,
    recentCommits,
    openIssues: repoData.open_issues_count ?? repoData.open_issues ?? 0,
    fileTree,
    readmeExcerpt,
  };
}

function parseLLMFileBlocks(text: string): { path: string; content: string }[] {
  const blocks: { path: string; content: string }[] = [];
  const regex = /```file:([^\n\r]+)\r?\n([\s\S]*?)\r?\n?```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1] ? match[1].trim() : "";
    const fileContent = match[2] || "";
    if (filePath) {
      blocks.push({ path: filePath, content: fileContent });
    }
  }
  return blocks;
}

function generateDeterministicPlan(analysis: RepoAnalysis, request: string): string {
  const fileTree = analysis.fileTree || [];
  const hasTests = fileTree.some(p => p.toLowerCase().includes("test") || p.toLowerCase().includes("spec"));
  const hasCI = fileTree.some(p => p.toLowerCase().includes(".github/workflows") || p.toLowerCase().includes("gitlab-ci"));
  const hasDocs = fileTree.some(p => p.toLowerCase().includes("readme") || p.toLowerCase().includes("doc"));

  const recommendations: string[] = [];
  if (!hasTests) {
    recommendations.push("- **테스트 코드 추가**: 프로젝트 내에 테스트나 스펙 파일이 탐지되지 않았습니다. 품질 향상을 위해 bun:test 또는 jest 등의 테스트 도입을 권장합니다.");
  }
  if (!hasCI) {
    recommendations.push("- **CI/CD 파이프라인 구성**: Github Workflows나 GitLab CI 등의 지속적 통합 파이프라인이 보이지 않습니다. 자동화된 빌드 및 테스트 패스를 위한 워크플로우 구성을 권장합니다.");
  }
  if (!hasDocs) {
    recommendations.push("- **문서 보완**: README 파일 또는 핵심 설계 문서(docs/)가 보이지 않거나 부족합니다. 프로젝트 이해를 돕기 위한 기본 문서 작성을 권장합니다.");
  }

  if (recommendations.length === 0) {
    recommendations.push("- **구조 검증**: 기본적인 테스트, CI, 문서 구조가 이미 탐지되었습니다. 코드 구현체의 리팩토링 및 모듈성 강화를 권장합니다.");
  }

  let staleRecommendation = "";
  if (analysis.recentCommits.length > 0) {
    const latestDateStr = analysis.recentCommits[0]?.date;
    if (latestDateStr) {
      try {
        const latestDate = new Date(latestDateStr);
        const currentDate = new Date("2026-06-11");
        const diffDays = (currentDate.getTime() - latestDate.getTime()) / (1000 * 3600 * 24);
        if (diffDays > 30) {
          staleRecommendation = `- **저장소 비활성 상태 감지**: 마지막 커밋이 약 ${Math.floor(diffDays)}일 전으로 확인되어 최근 업데이트가 뜸합니다. 최신 의존성 및 감수해야 할 기술 부채(Technical Debt)를 검토하세요.`;
        } else {
          staleRecommendation = `- **저장소 활성 상태**: 최근 커밋이 ${Math.floor(diffDays)}일 전에 이루어졌으므로 활발하게 관리되는 저장소입니다. 변경 사항 충돌 방지에 유의하세요.`;
        }
      } catch {
        staleRecommendation = `- **업데이트 주기 분석**: 커밋 날짜 형식이 올바르지 않아 정확한 경과 분석이 어렵습니다. 이력을 주기적으로 체크하세요.`;
      }
    }
  } else {
    staleRecommendation = "- **커밋 이력 없음**: 최근 커밋 이력이 없어 신규 저장소로 추정되거나 분석 데이터가 부족합니다.";
  }

  return `# 개선안 (Improvement Plan)

## 사용자 요구사항 범위 (Scope of Request)
재진술된 요구사항: "${request}"

## 자동 감지된 추천 사항 (Recommendations)
${recommendations.join("\n")}
${staleRecommendation}
`;
}


// Failure markers that mean the coding agent never produced a healthy run even
// when the process exits with code 0 — e.g. provider 404 model-not-found, rate
// limiting (429), auth (401) failures, or jeo-code's provider/model resolution
// rejection. A run that trips any of these MUST NOT be treated as success,
// otherwise the workflow falsely auto-approves and merges empty/garbage work.
export const AGENT_FAILURE_MARKERS: readonly string[] = [
  "Rate limited",
  "Provider returned HTTP 429",
  "Provider returned HTTP 404",
  "No endpoints",
  "resolves to",
  "model not found",
  "Provider error",
  "authentication failed",
  "401 Unauthorized",
];

export const CODING_AGENT = {
  binary: "jeopi",
  provider: "openai-codex",
  model: "openai-codex/gpt-6.1-terra",
  sessionMode: "--no-session",
} as const;

// Pure decision: did a single coding-agent invocation produce a healthy run?
// Healthy requires exit code 0 AND no failure marker in combined stdout/stderr.
export function evaluateAgentRun(
  exitCode: number,
  output: string
): { healthy: boolean; marker: string | null } {
  const marker = AGENT_FAILURE_MARKERS.find((m) => output.includes(m)) ?? null;
  return { healthy: exitCode === 0 && marker === null, marker };
}

export interface CodingAgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  marker: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

export async function runCodingAgent(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number },
): Promise<CodingAgentResult> {
  const limit = options.maxOutputBytes ?? 65536;
  const binary = command[0];
  if (binary === undefined || !Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid coding agent process options");
  if (options.signal?.aborted) return { exitCode: -1, stdout: "", stderr: "", marker: null, timedOut: false, cancelled: true };
  const child = spawn(binary, command.slice(1), { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let marker: string | null = null;
  let timedOut = false;
  let cancelled = false;
  let terminating = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pipeTimer: ReturnType<typeof setTimeout> | undefined;
  const tailLength = Math.max(...AGENT_FAILURE_MARKERS.map((item) => item.length)) - 1;
  const collect = (stream: NodeJS.ReadableStream) => {
    const decoder = new StringDecoder("utf8");
    let output = Buffer.alloc(0);
    let scanTail = "";
    const scan = (text: string) => {
      const scanText = scanTail + text;
      marker ??= AGENT_FAILURE_MARKERS.find((item) => scanText.includes(item)) ?? null;
      scanTail = scanText.slice(-tailLength);
    };
    stream.on("data", (chunk: Buffer) => {
      scan(decoder.write(chunk));
      output = chunk.length >= limit ? Buffer.from(chunk.subarray(chunk.length - limit)) : Buffer.concat([output.subarray(Math.max(0, output.length + chunk.length - limit)), chunk]);
    });
    stream.on("end", () => scan(decoder.end()));
    return () => output.toString("utf8");
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    const send = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { child.kill(signal); }
    };
    send("SIGTERM");
    killTimer = setTimeout(() => {
      send("SIGKILL");
      pipeTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
      pipeTimer.unref();
    }, 1000);
    killTimer.unref();
  };
  const onAbort = () => { cancelled = true; terminate(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  child.once("exit", () => {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group already exited. */ }
    }
  });
  const exitCode = await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? -1)));
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (pipeTimer) clearTimeout(pipeTimer);
  options.signal?.removeEventListener("abort", onAbort);
  if (spawnError) throw spawnError;
  return { exitCode, stdout: stdout(), stderr: stderr(), marker, timedOut, cancelled };
}

export async function generateImprovement(
  runtime: string,
  analysis: RepoAnalysis,
  request: string,
  workflowId: string,
  llm?: {
    url: string;
    model: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
  signal?: AbortSignal,
): Promise<{
  files: WorkflowArtifact[];
  summary: string;
  notes: string[];
}> {
  signal?.throwIfAborted();
  if (process.platform !== "linux") throw new Error("Secure artifact collection requires Linux descriptor-relative access");
  await access("/proc/self/fd");
  const notes: string[] = [];
  const finalArtifacts: WorkflowArtifact[] = [];
  let summary = "";

  const tempDir = await mkdtemp(join(tmpdir(), "jeoclaw-repo-"));
  notes.push(`Created temp dir: ${tempDir}`);

  try {
    const cloneUrl = `https://github.com/${analysis.repo}.git`;
    notes.push(`Cloning ${cloneUrl}...`);
    const clone = await runCodingAgent(["git", "clone", "--", cloneUrl, tempDir], {
      cwd: process.cwd(), timeoutMs: 5 * 60 * 1000, signal,
    });
    signal?.throwIfAborted();
    if (clone.timedOut || clone.exitCode !== 0) throw new Error("Repository clone failed or timed out");
    const base = await runCodingAgent(["git", "rev-parse", "--verify", "HEAD"], {
      cwd: tempDir, timeoutMs: 30_000, signal,
    });
    signal?.throwIfAborted();
    const baseCommit = base.stdout.trim();
    if (base.timedOut || base.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("Repository clone baseline unavailable");

    notes.push(`Running coding agent for request: ${request}`);
    const agentBinary = CODING_AGENT.binary;
    const strictRule = "\n\n[CRITICAL RULE] Do not use git commit or git stash to clean up your changes. Leave modified files unstaged or staged so they can be collected.";
    // The authenticated jeopi catalog identifies the ChatGPT OAuth adapter as
    // `openai-codex`; use the fully-qualified selector to avoid fuzzy routing.
    const models: { provider: string; model: string }[] = [
        { provider: CODING_AGENT.provider, model: CODING_AGENT.model },
    ];
    let agentResult: CodingAgentResult | undefined;
    let agentSucceeded = false;
    for (const { provider: prov, model: modelName } of models) {
        notes.push(`Running coding agent with provider: ${prov}, model: ${modelName}`);
        const xdgDir = await mkdtemp(join(tmpdir(), "jeoclaw-xdg-"));
        try {
          agentResult = await runCodingAgent(
            [agentBinary, CODING_AGENT.sessionMode, "--provider", prov, "--model", modelName, "-p", `$ooo $ralph ${request}${strictRule}`],
            { cwd: tempDir, env: { ...process.env, XDG_DATA_HOME: join(xdgDir, "data"), XDG_STATE_HOME: join(xdgDir, "state") }, timeoutMs: 30 * 60 * 1000, signal },
          );
        } finally {
          await rm(xdgDir, { recursive: true, force: true });
        }
        signal?.throwIfAborted();
        notes.push(`model ${modelName} exit code: ${agentResult.exitCode}`);

        const { marker } = agentResult;
        const healthy = agentResult.exitCode === 0 && !marker && !agentResult.timedOut && !agentResult.cancelled;
        if (healthy) {
            agentSucceeded = true;
            notes.push(`[Model Pooling] Healthy run with provider ${prov}, model ${modelName}.`);
            break;
        }

        notes.push(`[Model Pooling] Agent failed (exitCode: ${agentResult.exitCode}, failureMarker: ${marker ?? "none"}).`);
    }
    if (!agentResult) throw new Error("No coding agent was invoked");


    
    // PREVENT DATA LOSS: Save agent stdout/stderr
    try {
        const fs = await import("node:fs/promises");
        const logPath = join(process.cwd(), ".jeo/artifacts/tool-results", `${Date.now()}-agent-execution.log`);
        await fs.mkdir(join(process.cwd(), ".jeo/artifacts/tool-results"), { recursive: true });
        const logData = `EXIT CODE: ${agentResult.exitCode} (output limited to last 65536 bytes per stream; timedOut=${agentResult.timedOut})

STDOUT:
${agentResult.stdout.toString()}

STDERR:
${agentResult.stderr.toString()}`;
        await fs.writeFile(logPath, logData, "utf8");
        notes.push(`Agent logs saved to ${logPath}`);
    } catch(e: any) {
        notes.push(`Failed to save agent logs: ${e.message}`);
    }

    // FALSE-SUCCESS GUARD: if every model fallback failed (429/404/auth/resolution
    // errors) the agent never produced a healthy run. Hard-stop the workflow (NO-OP)
    // instead of letting an empty/garbage result advance to auto-approve and merge.
    if (!agentSucceeded) {
      throw new Error(
        `All model fallbacks failed; coding agent never produced a healthy run (last exit code ${agentResult?.exitCode ?? "n/a"}). Aborting workflow (NO-OP). Recent notes: ${notes.slice(-6).join(" | ")}`
      );
    }

    if (agentResult.exitCode !== 0) throw new Error(`Agent execution aborted or failed with exit code ${agentResult.exitCode}. See logs for details.`);


    // Get unstaged/uncommitted and STAGED changes
    const gitNames = async (args: string[], allowFailure = false): Promise<string | null> => {
      const result = await runCodingAgent(["git", ...args], { cwd: tempDir, timeoutMs: 30_000, signal, maxOutputBytes: 1024 * 1024 });
      signal?.throwIfAborted();
      if (result.timedOut) throw new Error("Repository status timed out");
      if (result.exitCode !== 0) {
        if (allowFailure) return null;
        throw new Error("Repository status failed");
      }
      if (Buffer.byteLength(result.stdout) >= 1024 * 1024) throw new Error("Repository status exceeds output limit");
      return result.stdout;
    };
    const gitDiffUnstaged = await gitNames(["diff", "HEAD", "--name-only"]);
    const gitDiffCommitted = await gitNames(["diff", `${baseCommit}...HEAD`, "--name-only"]);
    if (gitDiffCommitted === null) throw new Error("Repository comparison baseline unavailable");
    const modifiedFiles = [...(gitDiffUnstaged ?? "").split("\n"), ...gitDiffCommitted.split("\n")].map(f => f.trim()).filter(f => f.length > 0);
    const gitUntracked = await gitNames(["ls-files", "--others", "--exclude-standard"]);
    const untrackedFiles = (gitUntracked ?? "").split("\n").map(f => f.trim()).filter(f => f.length > 0);

    const allChanged = [...new Set([...modifiedFiles, ...untrackedFiles])];
    if (allChanged.length > 30) throw new Error("Agent changed more than 30 files; refusing partial artifacts");

    if (allChanged.length === 0) {
      summary = "코딩 에이전트가 실행되었으나 변경된 파일이 없습니다. (목업 데이터 아님, 실제 실행 결과)";
      notes.push("No files modified by agent.");
    } else {
      summary = `실제 코딩 에이전트(jeopi)가 코드를 수정했습니다. 변경된 파일: ${allChanged.join(', ')}`;
      for (const file of allChanged) {
        signal?.throwIfAborted();
        const artifact = await readArtifact(tempDir, file);
        if ("reason" in artifact) {
          throw new Error(`Cannot collect artifact ${file}: ${artifact.reason}`);
        }

        finalArtifacts.push({
          path: file,
          content: artifact.content,
        });
      }
    }
    
    if (finalArtifacts.length === 0) {
      throw new Error("Agent finished but made zero valid code changes (finalArtifacts is empty). Aborting workflow.");
    }
  } catch (err: any) {
    notes.push(`Error during real agent execution: ${err.message}`);
    throw err;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    files: finalArtifacts,
    summary,
    notes,
  };
}

export function reviewArtifacts(
  artifacts: WorkflowArtifact[]
): {
  reviewPassed: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  let reviewPassed = true;

  if (!artifacts || artifacts.length === 0) {
    reviewPassed = false;
    notes.push("fail: no artifacts provided");
    return { reviewPassed, notes };
  }

  notes.push(`count: ${artifacts.length} artifacts`);

  let totalSize = 0;
  let pathsValid = true;
  let contentsNonEmpty = true;
  let sizesValid = true;

  for (const art of artifacts) {
    const sanity = sanitizePath(art.path);
    if (!sanity.ok) {
      pathsValid = false;
      notes.push(`fail: path "${art.path}" is invalid: ${sanity.reason}`);
    }

    if (!art.content || art.content.length === 0) {
      contentsNonEmpty = false;
      notes.push(`fail: content of "${art.path}" is empty`);
    }

    const size = Buffer.byteLength(art.content || "", "utf8");
    if (size > 64 * 1024) {
      sizesValid = false;
      notes.push(`fail: size of "${art.path}" exceeds 64KB (${size} bytes)`);
    }
    totalSize += size;
  }

  if (totalSize > 192 * 1024) {
    sizesValid = false;
    notes.push(`fail: total size of artifacts exceeds 192KB (${totalSize} bytes)`);
  }

  if (!pathsValid || !contentsNonEmpty || !sizesValid) {
    reviewPassed = false;
  }

  if (reviewPassed) {
    notes.push("pass: all checks passed");
  }

  return { reviewPassed, notes };
}

export async function checkPullRequestStatus(
  repo: string,
  prNumber: number,
  opts: {
    token: string;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
  }
): Promise<{
  ciPassed: boolean;
  reviewPassed: boolean;
  notes: string[];
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBaseUrl = opts.apiBaseUrl ?? "https://api.github.com";
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    return { ciPassed: false, reviewPassed: false, notes: [`Invalid repo format: ${repo}`] };
  }

  const headers = {
    "Authorization": `Bearer ${opts.token}`,
    "User-Agent": "jeo-claw-hive",
    "Accept": "application/vnd.github.v3+json",
  };

  try {
    const prRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/pulls/${prNumber}`, { headers });
    if (!prRes.ok) {
      return {
        ciPassed: false,
        reviewPassed: false,
        notes: [`Failed to fetch PR info: HTTP ${prRes.status}`],
      };
    }
    const prData = await prRes.json() as any;
    const headSha = prData.head?.sha;
    if (!headSha) {
      return {
        ciPassed: false,
        reviewPassed: false,
        notes: ["Could not determine head SHA from PR response"],
      };
    }

    const checkRunsRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/commits/${headSha}/check-runs`, { headers });
    if (!checkRunsRes.ok) {
      return {
        ciPassed: false,
        reviewPassed: false,
        notes: [`Failed to fetch check runs: HTTP ${checkRunsRes.status}`],
      };
    }
    const checkRunsData = await checkRunsRes.json() as any;
    const checkRuns = checkRunsData.check_runs || [];

    const statusRes = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repoName}/commits/${headSha}/status`, { headers });
    if (!statusRes.ok) {
      return {
        ciPassed: false,
        reviewPassed: false,
        notes: [`Failed to fetch combined status: HTTP ${statusRes.status}`],
      };
    }
    const statusData = await statusRes.json() as any;
    const combinedStatusState = statusData.state;
    const statuses = statusData.statuses || [];

    const notes: string[] = [];
    let reviewPassed = false;
    if (prData.state === "open") {
      if (prData.mergeable_state === "dirty") {
        notes.push("pr-state: open, mergeable_state: dirty");
        reviewPassed = false;
      } else {
        notes.push(`pr-state: open, mergeable_state: ${prData.mergeable_state || "unknown"}`);
        reviewPassed = true;
      }
    } else {
      notes.push(`pr-state: ${prData.state || "unknown"}`);
      reviewPassed = false;
    }

    let ciPassed = false;
    const hasCheckRuns = checkRuns.length > 0;
    const hasStatuses = statuses.length > 0;

    if (hasCheckRuns) {
      const allPassed = checkRuns.every((cr: any) =>
        cr.status === "completed" &&
        (cr.conclusion === "success" || cr.conclusion === "skipped" || cr.conclusion === "neutral")
      );
      ciPassed = allPassed;
      notes.push(`check-runs: ${checkRuns.length} found, ciPassed: ${ciPassed}`);
    } else if (hasStatuses) {
      ciPassed = combinedStatusState === "success";
      notes.push(`statuses: ${statuses.length} found, combinedStatusState: ${combinedStatusState}, ciPassed: ${ciPassed}`);
    } else {
      ciPassed = combinedStatusState === "success" || combinedStatusState === "pending" || !combinedStatusState;
      notes.push("no-ci-configured");
    }

    return { ciPassed, reviewPassed, notes };
  } catch (err: any) {
    return {
      ciPassed: false,
      reviewPassed: false,
      notes: [err.message || "Unknown error"],
    };
  }
}
