import { test, expect } from "bun:test";
import { summarize } from "./metrics.ts";
import type { MetricSample } from "../glue/contract.ts";

test("summarize - empty input returns empty array", () => {
  expect(summarize([])).toEqual([]);
});

test("summarize - math correct with known samples", () => {
  const samples: MetricSample[] = [
    {
      runtime: "zeroclaw",
      run: 1,
      latencyMs: 100,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.1,
      failed: false,
    },
    {
      runtime: "zeroclaw",
      run: 2,
      latencyMs: 200,
      ramMb: 300,
      cpuPct: 20,
      ciPassed: false,
      tokenCost: 0.2,
      failed: true,
    },
    {
      runtime: "nullclaw",
      run: 1,
      latencyMs: 150,
      ramMb: 250,
      cpuPct: 15,
      ciPassed: true,
      tokenCost: 0.15,
      failed: false,
    },
  ];

  const summaries = summarize(samples);

  expect(summaries.length).toBe(2);

  const zeroclaw = summaries.find((s) => s.runtime === "zeroclaw");
  const nullclaw = summaries.find((s) => s.runtime === "nullclaw");

  expect(zeroclaw).toBeDefined();
  expect(zeroclaw!.runs).toBe(2);
  expect(zeroclaw!.latencyMs).toBe(150); // (100 + 200) / 2
  expect(zeroclaw!.ramMb).toBe(250); // (200 + 300) / 2
  expect(zeroclaw!.cpuPct).toBe(15); // (10 + 20) / 2
  expect(zeroclaw!.ciPassRate).toBe(0.5); // 1 passed, 1 failed
  expect(zeroclaw!.tokenCost).toBeCloseTo(0.15); // (0.1 + 0.2) / 2
  expect(zeroclaw!.failureRate).toBe(0.5); // 1 failed, 1 not failed

  expect(nullclaw).toBeDefined();
  expect(nullclaw!.runs).toBe(1);
  expect(nullclaw!.latencyMs).toBe(150);
  expect(nullclaw!.ramMb).toBe(250);
  expect(nullclaw!.cpuPct).toBe(15);
  expect(nullclaw!.ciPassRate).toBe(1.0);
  expect(nullclaw!.tokenCost).toBeCloseTo(0.15);
  expect(nullclaw!.failureRate).toBe(0.0);
});

test("summarize - a runtime with zero samples handled gracefully", () => {
  const samples: MetricSample[] = [
    {
      runtime: "zeroclaw",
      run: 1,
      latencyMs: 100,
      ramMb: 200,
      cpuPct: 10,
      ciPassed: true,
      tokenCost: 0.1,
      failed: false,
    },
  ];

  const summaries = summarize(samples);
  expect(summaries.length).toBe(2);

  const nullclaw = summaries.find((s) => s.runtime === "nullclaw");
  expect(nullclaw).toBeDefined();
  expect(nullclaw!.runs).toBe(0);
  expect(nullclaw!.latencyMs).toBe(0);
  expect(nullclaw!.ramMb).toBe(0);
  expect(nullclaw!.cpuPct).toBe(0);
  expect(nullclaw!.ciPassRate).toBe(0);
  expect(nullclaw!.tokenCost).toBe(0);
  expect(nullclaw!.failureRate).toBe(0);
});
