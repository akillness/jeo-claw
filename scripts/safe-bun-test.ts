#!/usr/bin/env bun
// Safe wrapper for running `bun test` in CI/cron to prevent runaway watch loops
// and enforce a single-shot, timeout-limited execution with a small retry budget.
// Generated/installed by jeopi (coding-agent) as a non-invasive safety shim.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'fs';

const MAX_RETRIES = 2;
// Default single-run timeout for bun test (ms). Keep bounded to avoid runaway CI.
const TIMEOUT_MS = 300000; // 5 minutes

// Deny-list to prevent fork-bomb / watcher flags or suspicious env from being passed.
const FORBIDDEN_SUBSTRINGS = ['--watch', '-w', 'watch', '--watchAll', '--watch-all', '--w', '--watchAll=true'];
// Deny-list for environment variables that enable persistent/watch behaviors
const FORBIDDEN_ENV_VARS = ['BUN_WATCH', 'JEO_WATCH', 'WATCH', 'JEST_WATCH', 'BUN_TEST_WATCH'];

// Allow-list for JEO_TEST_FLAGS: if present, only flags matching this regex are
// permitted. This prevents unexpected flags from being injected via the environment.
const ALLOWED_JEO_TEST_FLAGS = [/^--filter$/, /^--parallel$/, /^--timeout$/, /^--reporter$/];

async function runOnce(): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  // Disallow watch-style flags in argv/env to avoid accidental watchers or fork-bombs.
  const joinedEnvFlags = (process.env['JEO_TEST_FLAGS'] || '');
  // Refuse to run if known watch env vars are present to avoid accidental watchers
  for (const e of FORBIDDEN_ENV_VARS) {
    if (process.env[e] !== undefined) {
      console.error(`Refusing to run because forbidden env var detected: ${e}`);
      return { code: 2, stdout: '', stderr: `forbidden env ${e}`, timedOut: false };
    }
  }
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
      const p = parts[i]!;
      // Defensive block: any flag containing 'watch' is rejected.
      if (p.toLowerCase().includes('watch')) {
        console.error(`Refusing to pass unsafe JEO_TEST_FLAGS entry (contains watch): ${p}`);
        return { code: 2, stdout: '', stderr: `unsafe JEO_TEST_FLAGS ${p}`, timedOut: false };
      }
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

  const res = await runTestProcess('bun', args, TIMEOUT_MS + 2000);

  // Persist the raw output for artifact inspection.
  try {
    fs.writeFileSync('./bun-output.log', `${res.stdout}\n---STDERR---\n${res.stderr}`, { encoding: 'utf8' });
  } catch (_e) {
    // best-effort only; do not fail the run for logging errors
  }

  return res;
}

export function runTestProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string; timedOut: boolean }>();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  let spawnError: string | undefined;
  let interruptedCode: number | undefined;
  let cleaned = false;
  const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const maxOutputBytes = 1024 * 1024;
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const size = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const accepted = chunk.subarray(0, Math.max(0, maxOutputBytes - size));
    (stream === 'stdout' ? stdout : stderr).push(accepted);
    if (stream === 'stdout') stdoutBytes += accepted.length;
    else stderrBytes += accepted.length;
    if (accepted.length < chunk.length && !outputExceeded) {
      outputExceeded = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));

  const cleanup = () => {
    if (cleaned || !child.pid) return;
    cleaned = true;
    try {
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        console.error(`safe-bun-test: child cleanup failed: ${String(error)}`);
      }
    }
  };
  const interrupt = (code: number) => { if (interruptedCode === undefined) { interruptedCode = code; cleanup(); } };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const timer = setTimeout(() => { timedOut = true; cleanup(); child.stdout.destroy(); child.stderr.destroy(); }, timeoutMs);
  child.once('error', error => { spawnError = String(error); });
  child.once('exit', cleanup);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    removeSignalHandlers();
    if (interruptedCode !== undefined) process.exit(interruptedCode);
    const stdoutText = Buffer.concat(stdout, stdoutBytes).toString('utf8');
    let stderrText = Buffer.concat(stderr, stderrBytes).toString('utf8');
    if (spawnError) stderrText += `spawn failed: ${spawnError}`;
    if (outputExceeded) stderrText += '\nsafe-bun-test: output exceeded buffer limit';
    resolve({ code: spawnError ? 3 : outputExceeded || timedOut ? 1 : code ?? 1, stdout: stdoutText, stderr: stderrText, timedOut: timedOut || (!outputExceeded && (signal === 'SIGTERM' || signal === 'SIGKILL')) });
  });
  return promise;
}

function summarizeCounts(output: string) {
  // Parse lines like: '1489 pass' and '400 fail' and '11 skip'
  const res: { pass: number; fail: number; skip: number } = { pass: 0, fail: 0, skip: 0 };
  const mPass = output.match(/(\d+)\s+pass/);
  const mFail = output.match(/(\d+)\s+fail/);
  const mSkip = output.match(/(\d+)\s+skip/);
  if (mPass) res.pass = Number(mPass[1]);
  if (mFail) res.fail = Number(mFail[1]);
  if (mSkip) res.skip = Number(mSkip[1]);
  return res;
}

function recordEvolutionLog(entry: any) {
  try {
    const dir = './.joc/state';
    fs.mkdirSync(dir, { recursive: true });
    const path = `${dir}/evolution-log.json`;
    let arr: any[] = [];
    if (fs.existsSync(path)) {
      try { arr = JSON.parse(fs.readFileSync(path, 'utf8') || '[]'); } catch (_) { arr = []; }
    }
    arr.push(entry);
    fs.writeFileSync(path, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    try { fs.appendFileSync('./bun-output.log', `\n[EVOLUTION-LOG-ERROR] ${String(e)}`); } catch (_) {}
  }
}

async function main() {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    console.log(`safe-bun-test: attempt ${attempt}/${MAX_RETRIES}`);
    const r = await runOnce();
    // Echo bun output for visibility in CI logs
    if (r.stdout) console.log(r.stdout);
    if (r.stderr) console.error(r.stderr);

    const counts = summarizeCounts(r.stdout + '\n' + r.stderr);
    console.log(`safe-bun-test: summary => pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);

    if (r.timedOut) {
      console.error('safe-bun-test: run timed out');
    }
    if (r.code === 0) {
      console.log('safe-bun-test: tests passed');
      // Record successful evolution state for the Sovereign loop
      recordEvolutionLog({
        timestamp: new Date().toISOString(),
        attempt,
        result: 'pass',
        code: r.code,
        timedOut: r.timedOut,
        counts,
        artifact: './bun-output.log'
      });
      process.exit(0);
    }
    console.error(`safe-bun-test: run failed (code=${r.code}); stderr:\n${r.stderr}`);
    // Record failed attempt
    recordEvolutionLog({
      timestamp: new Date().toISOString(),
      attempt,
      result: 'fail',
      code: r.code,
      timedOut: r.timedOut,
      counts: (() => { try { return summarizeCounts(r.stdout + '\n' + r.stderr); } catch { return {}; } })(),
      artifact: './bun-output.log'
    });
    if (attempt >= MAX_RETRIES) break;
    console.log('safe-bun-test: retrying once more (short backoff)');
  }
  process.exit(1);
}

if (import.meta.main) main();
