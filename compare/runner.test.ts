import { test, expect } from "bun:test";
import { runComparison, compareAndSummarize } from "./runner.ts";
import type { Runtime, MetricSample } from "../glue/contract.ts";

test("runComparison invokes RunFn correct number of times and with correct run indices", async () => {
  const calls: { runtime: Runtime; run: number }[] = [];
  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const runs = 3;

  const mockRun = async (runtime: Runtime, run: number): Promise<MetricSample> => {
    calls.push({ runtime, run });
    return {
      runtime,
      run,
      latencyMs: 100 * run,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.05,
      failed: false,
    };
  };

  const samples = await runComparison({
    runtimes,
    runs,
    run: mockRun,
  });

  // Verify total calls count
  expect(calls.length).toBe(runtimes.length * runs);
  expect(samples.length).toBe(runtimes.length * runs);

  // Verify indices and runtimes
  expect(calls[0]).toEqual({ runtime: "zeroclaw", run: 1 });
  expect(calls[1]).toEqual({ runtime: "zeroclaw", run: 2 });
  expect(calls[2]).toEqual({ runtime: "zeroclaw", run: 3 });
  expect(calls[3]).toEqual({ runtime: "nullclaw", run: 1 });
  expect(calls[4]).toEqual({ runtime: "nullclaw", run: 2 });
  expect(calls[5]).toEqual({ runtime: "nullclaw", run: 3 });

  // Verify returned samples
  const firstSample = samples[0];
  expect(firstSample).toBeDefined();
  expect(firstSample!.runtime).toBe("zeroclaw");
  expect(firstSample!.run).toBe(1);
  expect(firstSample!.latencyMs).toBe(100);
});

test("compareAndSummarize returns both samples and summaries correctly", async () => {
  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const runs = 2;

  const mockRun = async (runtime: Runtime, run: number): Promise<MetricSample> => {
    return {
      runtime,
      run,
      latencyMs: 100 * run,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.05,
      failed: false,
    };
  };

  const { samples, summaries } = await compareAndSummarize({
    runtimes,
    runs,
    run: mockRun,
  });

  expect(samples.length).toBe(4);
  expect(summaries.length).toBe(2);

  const zeroclawSummary = summaries.find((s) => s.runtime === "zeroclaw");
  expect(zeroclawSummary).toBeDefined();
  expect(zeroclawSummary!.runs).toBe(2);
  expect(zeroclawSummary!.latencyMs).toBe(150);
});
