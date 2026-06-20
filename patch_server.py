import re

with open('/d/clawWorld/jeo-claw/glue/server.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace maybeDispatchStageTransition
old_str = """async function maybeDispatchStageTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (!dispatchableStage(state.stage)) return undefined;
  await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
  });
  const advanced = advanceStage(state);
  return advanced;
}"""

new_str = """async function maybeDispatchStageTransition(
  state: WorkflowState,
  opts: WorkflowExecutionOpts,
): Promise<WorkflowState | undefined> {
  if (!dispatchableStage(state.stage)) return undefined;
  const res = await dispatchStageWork(state, {
    runtimeDispatchSecret: opts.runtimeDispatchSecret,
    fetchImpl: opts.dispatchFetchImpl,
  });
  const advanced = advanceStage(state);
  if ((res as any).artifacts) {
    advanced.artifacts = (res as any).artifacts;
  }
  return advanced;
}"""

if old_str in content:
    content = content.replace(old_str, new_str)
    with open('/d/clawWorld/jeo-claw/glue/server.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Patched server.ts successfully")
else:
    print("Could not find the target string in server.ts")
