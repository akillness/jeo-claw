const fs = require('fs');
let content = fs.readFileSync('glue/server.ts', 'utf8');
content = content.replace(
  'export const pendingQueue: string[] = [];\nlet isProcessingQueue = false;\n',
  `export const pendingQueue: string[] = [];\nlet isProcessingQueue = false;\n\nconst workflowLocks = new Map<string, Promise<void>>();\n\nexport async function withWorkflowLock<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {\n  const existingLock = workflowLocks.get(workflowId) || Promise.resolve();\n  let releaseLock: () => void;\n  const newLock = new Promise<void>((resolve) => {\n    releaseLock = resolve;\n  });\n  const nextLock = existingLock.then(() => newLock);\n  workflowLocks.set(workflowId, nextLock);\n  try {\n    await existingLock;\n    return await fn();\n  } finally {\n    releaseLock!();\n    if (workflowLocks.get(workflowId) === nextLock) {\n      workflowLocks.delete(workflowId);\n    }\n  }\n}\n`
);
fs.writeFileSync('glue/server.ts', content);
