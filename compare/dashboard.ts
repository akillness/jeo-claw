import type { RuntimeMetricSummary } from "../glue/contract.ts";

export function renderDashboard(summaries: RuntimeMetricSummary[]): string {
  const header = `| Runtime   | Latency(ms) | RAM(MB)/CPU(%) | CI Pass Rate | Token Cost | Failure Rate |`;
  const separator = `|-----------|-------------|----------------|--------------|------------|--------------|`;
  const rows = summaries.map((s) => {
    const runtime = s.runtime.padEnd(9);
    const latency = s.latencyMs.toFixed(2).padStart(11);
    const ramCpu = `${s.ramMb.toFixed(1)} / ${s.cpuPct.toFixed(1)}%`.padStart(14);
    const ciPass = `${(s.ciPassRate * 100).toFixed(1)}%`.padStart(12);
    const cost = s.tokenCost.toFixed(4).padStart(10);
    const failure = `${(s.failureRate * 100).toFixed(1)}%`.padStart(12);
    return `| ${runtime} | ${latency} | ${ramCpu} | ${ciPass} | ${cost} | ${failure} |`;
  });
  return "```\n" + [header, separator, ...rows].join("\n") + "\n```";
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  fields: EmbedField[];
}

export function renderDashboardEmbed(summaries: RuntimeMetricSummary[]): DiscordEmbed {
  const fields = summaries.map((s) => {
    const value = [
      `Runs: ${s.runs}`,
      `Latency: ${s.latencyMs.toFixed(2)} ms`,
      `RAM/CPU: ${s.ramMb.toFixed(1)} MB / ${s.cpuPct.toFixed(1)}%`,
      `CI Pass Rate: ${(s.ciPassRate * 100).toFixed(1)}%`,
      `Token Cost: $${s.tokenCost.toFixed(4)}`,
      `Failure Rate: ${(s.failureRate * 100).toFixed(1)}%`,
    ].join("\n");

    return {
      name: s.runtime === "zeroclaw" ? "ZeroClaw" : s.runtime === "nullclaw" ? "NullClaw" : s.runtime,
      value,
      inline: true,
    };
  });

  return {
    title: "A/B Runtime Comparison Dashboard",
    fields,
  };
}
