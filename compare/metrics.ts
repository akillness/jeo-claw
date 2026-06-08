import type { MetricSample, Runtime, RuntimeMetricSummary } from "../glue/contract.ts";

export function summarize(samples: MetricSample[]): RuntimeMetricSummary[] {
  if (!samples || samples.length === 0) {
    return [];
  }

  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const summaries: RuntimeMetricSummary[] = [];

  for (const runtime of runtimes) {
    const runtimeSamples = samples.filter((s) => s.runtime === runtime);
    const count = runtimeSamples.length;

    if (count === 0) {
      summaries.push({
        runtime,
        runs: 0,
        latencyMs: 0,
        ramMb: 0,
        cpuPct: 0,
        ciPassRate: 0,
        tokenCost: 0,
        failureRate: 0,
      });
      continue;
    }

    let totalLatency = 0;
    let totalRam = 0;
    let totalCpu = 0;
    let totalTokenCost = 0;
    let ciPassedCount = 0;
    let failedCount = 0;

    for (const sample of runtimeSamples) {
      totalLatency += sample.latencyMs;
      totalRam += sample.ramMb;
      totalCpu += sample.cpuPct;
      totalTokenCost += sample.tokenCost;
      if (sample.ciPassed) {
        ciPassedCount++;
      }
      if (sample.failed) {
        failedCount++;
      }
    }

    summaries.push({
      runtime,
      runs: count,
      latencyMs: totalLatency / count,
      ramMb: totalRam / count,
      cpuPct: totalCpu / count,
      ciPassRate: ciPassedCount / count,
      tokenCost: totalTokenCost / count,
      failureRate: failedCount / count,
    });
  }

  return summaries;
}
