import { readFile, writeFile } from "fs/promises";
async function run() {
  const file = "D:/clawWorld/jeo-claw/glue/server.ts";
  let content = await readFile(file, "utf8");
  content = content.replace(
    /await dispatchStageWork\(state, \{([\s\S]*?)\}\);\s+const advanced = advanceStage\(state\);\s+return advanced;/m,
    `const res = await dispatchStageWork(state, {$1});\n  const advanced = advanceStage(state);\n  if ((res as any).artifacts) {\n    advanced.artifacts = (res as any).artifacts;\n  }\n  return advanced;`
  );
  await writeFile(file, content, "utf8");
  console.log("Patched server.ts!");
}
run();
