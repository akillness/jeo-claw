import { test, expect } from "bun:test";
import { renderDashboard, renderDashboardEmbed } from "./dashboard.ts";
import { compareAndSummarize } from "./runner.ts";
import type { Runtime, MetricSample } from "../glue/contract.ts";

test("dashboard renders both runtime names and all 5 metric families and is non-empty with static data", () => {
  const summaries = [
    {
      runtime: "zeroclaw" as Runtime,
      runs: 5,
      latencyMs: 120.45,
      ramMb: 256.1,
      cpuPct: 12.5,
      ciPassRate: 0.8,
      tokenCost: 0.0456,
      failureRate: 0.1,
    },
    {
      runtime: "nullclaw" as Runtime,
      runs: 5,
      latencyMs: 145.2,
      ramMb: 512.4,
      cpuPct: 24.1,
      ciPassRate: 0.9,
      tokenCost: 0.0512,
      failureRate: 0.0,
    },
  ];

  const tableText = renderDashboard(summaries);
  expect(tableText).not.toBe("");
  expect(tableText.startsWith("```")).toBe(true);
  expect(tableText.endsWith("```")).toBe(true);

  expect(tableText).toContain("zeroclaw");
  expect(tableText).toContain("nullclaw");

  // Assert presence of all 5 metric families
  expect(tableText.toLowerCase()).toContain("latency");
  expect(tableText.toLowerCase()).toContain("ram");
  expect(tableText.toLowerCase()).toContain("cpu");
  expect(tableText.toLowerCase()).toContain("ci pass");
  expect(tableText.toLowerCase()).toContain("token cost");
  expect(tableText.toLowerCase()).toContain("failure");

  const embed = renderDashboardEmbed(summaries);
  expect(embed.title).toContain("Dashboard");
  expect(embed.fields.length).toBe(2);

  const names = embed.fields.map(f => f.name.toLowerCase());
  expect(names).toContain("zeroclaw");
  expect(names).toContain("nullclaw");

  const f0 = embed.fields[0];
  expect(f0).toBeDefined();
  const firstValue = f0!.value.toLowerCase();
  expect(firstValue).toContain("latency");
  expect(firstValue).toContain("ram/cpu");
  expect(firstValue).toContain("ci pass rate");
  expect(firstValue).toContain("token cost");
  expect(firstValue).toContain("failure rate");
});

test("dashboard rendering with summaries generated from a deterministic mock RunFn", async () => {
  const runtimes: Runtime[] = ["zeroclaw", "nullclaw"];
  const runs = 2;

  const mockRun = async (runtime: Runtime, run: number): Promise<MetricSample> => {
    return {
      runtime,
      run,
      latencyMs: 100 * run,
      ramMb: 200 * run,
      cpuPct: 10 * run,
      ciPassed: run % 2 === 0, // runs: 1 -> false, 2 -> true. So ciPassRate = 0.5
      tokenCost: 0.05 * run,
      failed: run === 1, // run: 1 -> true, 2 -> false. So failureRate = 0.5
    };
  };

  const { summaries } = await compareAndSummarize({
    runtimes,
    runs,
    run: mockRun,
  });

  const tableText = renderDashboard(summaries);
  expect(tableText).not.toBe("");
  expect(tableText).toContain("zeroclaw");
  expect(tableText).toContain("nullclaw");
  expect(tableText.toLowerCase()).toContain("latency");

  const embed = renderDashboardEmbed(summaries);
  expect(embed.fields.length).toBe(2);
});
