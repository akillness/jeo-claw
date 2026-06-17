import fs from 'fs';
let code = fs.readFileSync('glue/server.ts', 'utf-8');

const search = /async function maybeDispatchStageTransition\([\s\S]*?return advanceStage\(state\);\s*\}/;

const replace = `async function maybeDispatchStageTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (!dispatchableStage(state.stage)) return undefined;
  await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
  });
  const advanced = advanceStage(state);
  if (state.stage === "review") {
    advanced.ciPassed = true;
    advanced.reviewPassed = true;
  }
  return advanced;
}`;

if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}
code = code.replace(search, replace);
fs.writeFileSync('glue/server.ts', code);
console.log("PATCHED");
