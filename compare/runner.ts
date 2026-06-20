import type { MetricSample, Runtime, RuntimeMetricSummary } from "../glue/contract.ts";
import { summarize } from "./metrics.ts";

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
    const promises = runtimes.map(runtime => run(runtime, r));
    const results = await Promise.all(promises);
    samples.push(...results);
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

if (import.meta.main) {
  console.error("compare/runner.ts is a library module. Wire a real sample collector before exposing a live `bun run compare` operator command.");
  process.exit(1);
}
