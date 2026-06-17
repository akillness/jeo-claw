#!/usr/bin/env bun
// Safe wrapper for running `bun test` in CI/cron to prevent runaway watch loops
// and enforce a single-shot, timeout-limited execution with a small retry budget.
// Generated/installed by gjc (coding-agent) as a non-invasive safety shim.

import { spawnSync } from 'node:child_process';
import fs from 'fs';

const MAX_RETRIES = 2;
const TIMEOUT_MS = 300000; // default single-run timeout for bun test (300s)

// Deny-list to prevent fork-bomb / watcher flags from being passed in any form.
const FORBIDDEN_SUBSTRINGS = ['--watch', '-w', 'watch', '--watchAll', '--watch-all'];

// Allow-list for JEO_TEST_FLAGS: if present, only flags matching this regex are
// permitted (simple conservative whitelist). This prevents unexpected flags from
// being injected via the environment by other automation.
const ALLOWED_JEO_TEST_FLAGS = [/^--filter$/, /^--parallel$/, /^--timeout$/, /^--reporter$/];

function runOnce(): { code: number; stdout: string; stderr: string; timedOut: boolean } {
  // Disallow watch-style flags in argv/env to avoid accidental watchers or fork-bombs.
  const joinedEnvFlags = (process.env['JEO_TEST_FLAGS'] || '');
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (process.argv.some(a => a.includes(bad)) || joinedEnvFlags.includes(bad)) {
      console.error(`Refusing to run because forbidden substring detected: ${bad}`);
      return { code: 2, stdout: '', stderr: `forbidden substring ${bad}`, timedOut: false };
    }
  }

  const args = ['test', '--timeout', String(TIMEOUT_MS)];
  // Allow additional safe flags via JEO_TEST_FLAGS env var (space-separated) but
  // strictly validate against a small allow-list to avoid surprises.
  if (joinedEnvFlags) {
    const parts = joinedEnvFlags.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // If it's a flag (starts with -), ensure it matches one of the allowed patterns.
      if (p.startsWith('-')) {
        const ok = ALLOWED_JEO_TEST_FLAGS.some(rx => rx.test(p));
        if (!ok) {
          console.error(`Refusing to pass unsafe JEO_TEST_FLAGS entry: ${p}`);
          return { code: 2, stdout: '', stderr: `unsafe JEO_TEST_FLAGS ${p}`, timedOut: false };
        }
      }
      args.push(p);
    }
  }

  let res;
  try {
    res = spawnSync('bun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS + 2000 });
  } catch (err: any) {
    return { code: 3, stdout: '', stderr: `spawn failed: ${String(err)}`, timedOut: false };
  }
  const timedOut = (res && (res.signal === 'SIGTERM' || res.signal === 'SIGKILL')) || false;
  return { code: res?.status ?? 1, stdout: res?.stdout ?? '', stderr: res?.stderr ?? '', timedOut };
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
      // Post-run check: ensure no lingering bun test/watch processes remain.
      try {
        const { execSync } = require('child_process');
        const ps = execSync('ps -ef | grep "bun" | grep -v grep || true', { encoding: 'utf8' });
        if (ps.trim()) {
          console.warn('safe-bun-test: WARNING - bun processes detected after run:\n' + ps);
        }
      } catch (_e) {
        // best-effort only; on Windows 'ps' may not exist, ignore errors
      }
      process.exit(0);
    }
    console.error(`safe-bun-test: run failed (code=${r.code}); stderr:\n${r.stderr}`);
    if (attempt >= MAX_RETRIES) break;
    console.log('safe-bun-test: retrying once more (short backoff)');
  }
  process.exit(1);
}

if (import.meta.main) main();
