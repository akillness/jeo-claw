import { readFile, writeFile } from "fs/promises";
async function run() {
  const file = "D:/clawWorld/jeo-claw/glue/runtime-dispatch.ts";
  let content = await readFile(file, "utf8");
  // Change fetch to have no timeout, or just wrap it in a custom bun fetch if needed?
  // Actually, there is an undocumented `timeout` option in some fetch implementations, or we can use Bun.spawn directly if fetch fails, but it's an HTTP server.
  // Wait, Bun fetch has NO default timeout for the connection, but maybe the server (glue/server.ts) timed out?
  // Let's check where the TimeoutError came from.
  content = content.replace(
    /const res = await fetchImpl\(\`http\:\/\/\$\{service\}\:\$\{port\}\/dispatch\`, \{/m,
    "const res = await fetchImpl(`http://${service}:${port}/dispatch`, {\n      timeout: 1000 * 60 * 30, // 30 mins\n"
  );
  await writeFile(file, content, "utf8");
  console.log("Patched timeout!");
}
run();
