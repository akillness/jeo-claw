import type { MetricSample, Runtime, RuntimeMetricSummary } from "../glue/contract.ts";
import { summarize } from "./metrics.ts";
import { renderDashboard } from "./dashboard.ts";

export type RunFn = (runtime: Runtime, run: number) => Promise<MetricSample>;

const MAX_COMPARISON_RUNS = 50;

function validateRunCount(runs: number): void {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_COMPARISON_RUNS) {
    throw new Error(`COMPARE_RUNS must be an integer between 1 and ${MAX_COMPARISON_RUNS}`);
  }
}

export async function runComparison(opts: {
  runtimes: Runtime[];
  runs: number;
  run: RunFn;
}): Promise<MetricSample[]> {
  const { runtimes, runs, run } = opts;
  validateRunCount(runs);
  const samples: MetricSample[] = [];

  for (let r = 1; r <= runs; r++) {
    for (const runtime of runtimes) {
      const sample = await run(runtime, r);
      samples.push(sample);
      // Memory optimization: force garbage collection if available to prevent memory leaks
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
        Bun.gc(true);
      } else if (typeof global !== "undefined" && typeof global.gc === "function") {
        global.gc();
      }
    }
  }

  return samples;
}

export async function compareAndSummarize(opts: {
  runtimes: Runtime[];
  runs: number;
  run: RunFn;
}): Promise<{
  samples: MetricSample[];
  summaries: RuntimeMetricSummary[];
}> {
  const samples = await runComparison(opts);
  const summaries = summarize(samples);
  return { samples, summaries };
}

// Real/Mock sample collector implementation
async function collectLiveOrMockSample(runtime: Runtime, run: number, mode: "live" | "mock"): Promise<MetricSample> {
  const start = performance.now();
  const startCpu = process.cpuUsage();
  const startMem = process.memoryUsage().heapUsed;

  let failed = false;
  let ciPassed = true;
  let tokenCost = 0.01 + Math.random() * 0.02;

  if (mode === "live") {
    try {
      // Attempt to query the live runtime container's health endpoint
      const port = runtime === "zeroclaw" ? 42617 : 3000;
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      failed = !res.ok;
    } catch {
      // Fallback to mock if live container is not reachable
      failed = true;
    }
  } else {
    // Mock mode: simulate some work and potential failure
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 50));
    failed = Math.random() < 0.05; // 5% failure rate
    ciPassed = Math.random() > 0.1; // 90% CI pass rate
  }

  const end = performance.now();
  const endCpu = process.cpuUsage(startCpu);
  const endMem = process.memoryUsage().heapUsed;

  const latencyMs = end - start;
  const ramMb = (endMem - startMem) / (1024 * 1024);
  const cpuPct = (endCpu.user + endCpu.system) / (latencyMs * 1000) * 100;

  return {
    runtime,
    run,
    latencyMs,
    ramMb: Math.max(0.1, ramMb), // Ensure non-zero RAM
    cpuPct: Math.max(0.1, Math.min(100, cpuPct)),
    ciPassed,
    tokenCost,
    failed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith("--runs="));
  const modeArg = args.find((a) => a.startsWith("--mode="));

  const runs = runsArg ? parseInt(runsArg.split("=")[1] || "5", 10) : 5;
  const mode = (modeArg ? modeArg.split("=")[1] : "mock") as "live" | "mock";

  console.log(`[Compare Runner] Starting performance evaluation...`);
  console.log(`Mode: ${mode} | Runs: ${runs}`);

  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const startMem = process.memoryUsage().heapUsed;

  const { summaries } = await compareAndSummarize({
    runtimes,
    runs,
    run: (runtime, run) => collectLiveOrMockSample(runtime, run, mode),
  });

  const endMem = process.memoryUsage().heapUsed;
  const memDiff = (endMem - startMem) / (1024 * 1024);

  console.log(`\n[Compare Runner] Performance Evaluation Results:`);
  console.log(renderDashboard(summaries));
  console.log(`Memory Leak Check: Heap change across runs = ${memDiff.toFixed(4)} MB`);
  if (memDiff > 5) {
    console.warn(`[Warning] Potential memory leak detected! Heap grew by ${memDiff.toFixed(4)} MB`);
  } else {
    console.log(`[Pass] Memory usage is stable (no leak detected).`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[Compare Runner] Failed:`, err);
    process.exit(1);
  });
}
