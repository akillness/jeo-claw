import { test, expect } from "bun:test";
import { startRuntime } from "./start.ts";

test("uncertified probe runtime and malformed mode fail before any credential source is opened", async () => {
  for (const runtime of ["zeroclaw", "nullclaw"] as const) {
    for (const [mode, reason] of [["probe-only", "native probe runtime is unavailable until native tool denial is verified"], ["unexpected", "invalid JEO_CONTROL_MODE"], ["", "invalid JEO_CONTROL_MODE"]] as const) {
      let sourceOpened = false;
      await expect(startRuntime(runtime, { JEO_CONTROL_MODE: mode, GCLOUD_PROJECT: "test" }, () => {
        sourceOpened = true;
        throw new Error("credential source must not open");
      })).rejects.toThrow(reason);
      expect(sourceOpened).toBe(false);
    }
  }
});
