import type { MetricSample, Runtime, RuntimeMetricSummary } from "../glue/contract.ts";
import { summarize } from "./metrics.ts";

export type RunFn = (runtime: Runtime, run: number) => Promise<MetricSample>;

export async function runComparison(opts: {
  runtimes: Runtime[];
  runs: number;
  run: RunFn;
}): Promise<MetricSample[]> {
  const { runtimes, runs, run } = opts;
  const samples: MetricSample[] = [];

  for (const runtime of runtimes) {
    for (let r = 1; r <= runs; r++) {
      const sample = await run(runtime, r);
      samples.push(sample);
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
