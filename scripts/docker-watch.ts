import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const WATCH_DIRS = [
  "glue",
  "discord",
  "compare",
  "runtimes",
  "secrets",
  "config",
  "claws",
  "hive",
  "scripts",
];

const DEBOUNCE_MS = 1500;
let rebuildTimeout: Timer | null = null;
let isRebuilding = false;

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Docker Watch] Running: ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

async function triggerRebuild() {
  if (isRebuilding) {
    console.log("[Docker Watch] Rebuild already in progress, queuing...");
    return;
  }
  isRebuilding = true;
  console.log("[Docker Watch] Change detected! Rebuilding Docker containers...");

  try {
    // Rebuild the images
    await runCommand("docker", ["compose", "build"]);
    // Restart the containers with the new build
    await runCommand("docker", ["compose", "up", "-d"]);
    console.log("[Docker Watch] Rebuild and restart completed successfully!");
  } catch (err) {
    console.error("[Docker Watch] Rebuild failed:", err);
  } finally {
    isRebuilding = false;
  }
}

function handleWatchEvent(event: string, filename: string | null) {
  if (!filename) return;
  // Ignore temporary files, test files, and hidden files
  if (filename.endsWith(".test.ts") || filename.startsWith(".") || filename.endsWith("~")) {
    return;
  }

  console.log(`[Docker Watch] File changed: ${filename} (${event})`);

  if (rebuildTimeout) {
    clearTimeout(rebuildTimeout);
  }

  rebuildTimeout = setTimeout(() => {
    triggerRebuild();
  }, DEBOUNCE_MS);
}

function main() {
  console.log("[Docker Watch] Starting file watcher for Docker auto-rebuild...");
  console.log(`Watching directories: ${WATCH_DIRS.join(", ")}`);

  const watchers = WATCH_DIRS.map((dir) => {
    const path = join(process.cwd(), dir);
    try {
      return watch(path, { recursive: true }, handleWatchEvent);
    } catch (err) {
      console.error(`[Docker Watch] Failed to watch directory ${dir}:`, err);
      return null;
    }
  }).filter(Boolean);

  const cleanup = () => {
    console.log("\n[Docker Watch] Stopping file watcher...");
    for (const w of watchers) {
      w?.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (import.meta.main) {
  main();
}
