import { readFile, writeFile } from "fs/promises";
async function run() {
  const f1 = "D:/clawWorld/jeo-claw/glue/server.ts";
  let c1 = await readFile(f1, "utf8");
  c1 = c1.replace(/return Bun\.serve\(\{/g, "return Bun.serve({ idleTimeout: 0,");
  await writeFile(f1, c1, "utf8");

  const f2 = "D:/clawWorld/jeo-claw/claws/worker.ts";
  let c2 = await readFile(f2, "utf8");
  c2 = c2.replace(/serve\(\{/g, "serve({ idleTimeout: 0,");
  await writeFile(f2, c2, "utf8");
  console.log("Patched idleTimeout!");
}
run();
