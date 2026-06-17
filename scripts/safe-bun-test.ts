#!/usr/bin/env bun
// Safe wrapper for running `bun test` in CI/cron to prevent runaway watch loops
// and enforce a single-shot, timeout-limited execution with a small retry budget.
// Generated/installed by gjc (coding-agent) as a non-invasive safety shim.

import { spawnSync } from 'node:child_process';
import fs from 'fs';

const MAX_RETRIES = 2;
const TIMEOUT_MS = 10000; // default single-run timeout for bun test

function runOnce(): { code: number; stdout: string; stderr: string; timedOut: boolean } {
  // Disallow watch-style flags in env/args to avoid accidental watchers
  const forbidden = ['--watch', '-w'];
  for (const f of forbidden) {
    if (process.argv.includes(f) || (process.env['JEO_TEST_FLAGS'] || '').includes(f)) {
      console.error(`Refusing to run with forbidden flag: ${f}`);
      return { code: 2, stdout: '', stderr: `forbidden flag ${f}`, timedOut: false };
    }
  }

  const args = ['test', '--timeout', String(TIMEOUT_MS)];
  // Allow additional safe flags via JEO_TEST_FLAGS env var (space-separated)
  if (process.env['JEO_TEST_FLAGS']) {
    args.push(...process.env['JEO_TEST_FLAGS'].split(' '));
  }

  const res = spawnSync('bun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS + 2000 });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: (res.signal === 'SIGTERM' || res.signal === 'SIGKILL') };
}

function main() {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    console.log(`safe-bun-test: attempt ${attempt}/${MAX_RETRIES}`);
    const r = runOnce();
    console.log(r.stdout);
    if (r.timedOut) {
      console.error('safe-bun-test: run timed out');
    }
    if (r.code === 0) {
      console.log('safe-bun-test: tests passed');
      process.exit(0);
    }
    console.error(`safe-bun-test: run failed (code=${r.code}); stderr:\n${r.stderr}`);
    if (attempt >= MAX_RETRIES) break;
    console.log('safe-bun-test: retrying once more (short backoff)');
  }
  process.exit(1);
}

if (import.meta.main) main();
