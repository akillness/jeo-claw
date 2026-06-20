import type { MetricSample, Runtime, RuntimeMetricSummary } from "../glue/contract.ts";

export function summarize(samples: MetricSample[]): RuntimeMetricSummary[] {
  if (!samples || samples.length === 0) {
    return [];
  }

  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const summaries: RuntimeMetricSummary[] = [];

  const stats: Record<Runtime, { count: number; latency: number; ram: number; cpu: number; tokenCost: number; ciPassed: number; failed: number }> = {
    zeroclaw: { count: 0, latency: 0, ram: 0, cpu: 0, tokenCost: 0, ciPassed: 0, failed: 0 },
    nullclaw: { count: 0, latency: 0, ram: 0, cpu: 0, tokenCost: 0, ciPassed: 0, failed: 0 },
  };

  for (const sample of samples) {
    const s = stats[sample.runtime];
    if (s) {
      s.count++;
      s.latency += sample.latencyMs;
      s.ram += sample.ramMb;
      s.cpu += sample.cpuPct;
      s.tokenCost += sample.tokenCost;
      if (sample.ciPassed) s.ciPassed++;
      if (sample.failed) s.failed++;
    }
  }

  for (const runtime of runtimes) {
    const s = stats[runtime];
    if (s.count === 0) {
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
    } else {
      summaries.push({
        runtime,
        runs: s.count,
        latencyMs: s.latency / s.count,
        ramMb: s.ram / s.count,
        cpuPct: s.cpu / s.count,
        ciPassRate: s.ciPassed / s.count,
        tokenCost: s.tokenCost / s.count,
        failureRate: s.failed / s.count,
      });
    }
  }

  return summaries;
}
