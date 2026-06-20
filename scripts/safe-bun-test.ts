#!/usr/bin/env bun
// Safe wrapper for running `bun test` in CI/cron to prevent runaway watch loops
// and enforce a single-shot, timeout-limited execution with a small retry budget.
// Generated/installed by gjc (coding-agent) as a non-invasive safety shim.

import { spawnSync, execSync } from 'node:child_process';
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

function runOnce(): { code: number; stdout: string; stderr: string; timedOut: boolean } {
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
      const p = parts[i];
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

  let res;
  try {
    res = spawnSync('bun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS + 2000 });
  } catch (err: any) {
    return { code: 3, stdout: '', stderr: `spawn failed: ${String(err)}`, timedOut: false };
  }
  const timedOut = (res && (res.signal === 'SIGTERM' || res.signal === 'SIGKILL')) || false;

  // Persist the raw output for artifact inspection.
  try {
    fs.writeFileSync('./bun-output.log', `${res?.stdout ?? ''}\n---STDERR---\n${res?.stderr ?? ''}`, { encoding: 'utf8' });
  } catch (_e) {
    // best-effort only; do not fail the run for logging errors
  }

  return { code: res?.status ?? 1, stdout: res?.stdout ?? '', stderr: res?.stderr ?? '', timedOut };
}

function detectBunProcesses(): string {
  try {
    if (process.platform === 'win32') {
      // On Windows, list all processes in CSV and return raw output for parsing by
      // killBunProcesses. This avoids missing bunx.exe or alternate image names.
      const out = execSync('tasklist /FO CSV', { encoding: 'utf8' });
      return out;
    } else {
      // POSIX: look specifically for bun and bunx command endings to reduce false
      // positives. Use grep -E to match both binaries.
      const out = execSync('ps -eo pid,comm | grep -E "bun$|bunx$|/bun$|/bunx$" || true', { encoding: 'utf8' });
      return out;
    }
  } catch (e: any) {
    return (e && e.stdout) ? String(e.stdout) : '';
  }
}

function killBunProcesses(): { killed: number; failures: number; details: string[] } {
  const details: string[] = [];
  let killed = 0;
  let failures = 0;
  const list = detectBunProcesses();
  if (!list || !list.trim()) return { killed, failures, details };

  try {
    if (process.platform === 'win32') {
      // parse CSV lines like "Image Name","PID","Session Name","Session#","Mem Usage"
      const lines = list.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        // match either bun.exe or bunx.exe rows
        const ll = l.toLowerCase();
        if (!ll.includes('bun.exe') && !ll.includes('bunx.exe')) continue;
        // simple CSV split
        const cols = l.split(',').map(c => c.replace(/^"|"$/g, ''));
        const pid = cols[1];
        try {
          // Try taskkill first (preferred on Windows)
          const tk = spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { encoding: 'utf8' });
          details.push(`taskkill(${pid}) => code=${tk.status} stdout=${tk.stdout?.trim()} stderr=${tk.stderr?.trim()}`);
          if (tk.status === 0) {
            killed++;
            continue;
          }
          // fallback to process.kill via node
          try {
            process.kill(Number(pid), 'SIGKILL');
            details.push(`process.kill(${pid}) succeeded`);
            killed++;
            continue;
          } catch (e2) {
            details.push(`process.kill(${pid}) failed: ${String(e2)}`);
            failures++;
          }
        } catch (e) {
          details.push(`taskkill exception for ${pid}: ${String(e)}`);
          failures++;
        }
      }
    } else {
      // POSIX: parse lines like " 12345 bun" and match bun or bunx
      const lines = list.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        const parts = l.split(/\s+/);
        const pid = parts[0];
        const cmd = parts.slice(1).join(' ');
        if (!pid) continue;
        if (!/\b(bun|bunx)\b/.test(cmd)) continue;
        try {
          const tk = spawnSync('kill', ['-9', pid], { encoding: 'utf8' });
          details.push(`kill(${pid}) => code=${tk.status} stderr=${tk.stderr?.trim()}`);
          if (tk.status === 0) {
            killed++;
            continue;
          }
          try { process.kill(Number(pid), 'SIGKILL'); killed++; details.push(`process.kill(${pid}) succeeded`); } catch (e2) { details.push(`process.kill(${pid}) failed: ${String(e2)}`); failures++; }
        } catch (e) { details.push(`kill exception ${pid}: ${String(e)}`); failures++; }
      }
    }
  } catch (e:any) {
    details.push(`killBunProcesses outer failure: ${String(e)}`);
  }

  // Append details to bun-output.log for diagnostics
  try { fs.appendFileSync('./bun-output.log', '\n\n[PROCESS-CLEANUP]\n' + details.join('\n'), { encoding: 'utf8' }); } catch (_) {}
  return { killed, failures, details };
}

function postRunProcessCheck() {
  try {
    const ps = detectBunProcesses();
    if (ps && ps.trim()) {
      console.warn('safe-bun-test: WARNING - bun processes detected after run:\n' + ps);
      try { fs.appendFileSync('./bun-output.log', '\n\n[POST-RUN PROCESS CHECK]\n' + ps, { encoding: 'utf8' }); } catch (_) {}
      const cleanup = killBunProcesses();
      console.log(`safe-bun-test: cleanup attempted: killed=${cleanup.killed} failures=${cleanup.failures}`);
    }
  } catch (_e) {
    // ignore on systems without ps/tasklist
  }
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

function main() {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    console.log(`safe-bun-test: attempt ${attempt}/${MAX_RETRIES}`);
    const r = runOnce();
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
      postRunProcessCheck();
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
    postRunProcessCheck();
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
