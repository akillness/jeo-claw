#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "==> 1. Type-checking (tsc --noEmit)..."
bunx tsc --noEmit

echo "==> 2. Validating Docker Compose posture..."
bun run check:compose

echo "==> 3. Validating runtime A/B fairness & config security..."
bun run config/validate.ts

echo "==> 4. Running Glue E2E smoke test..."
bun run smoke:glue

echo "==> 5. Running full test suite..."
bun test

echo "==> 6. Cleaning temporary test logs and staging changes..."
rm -f bun-output.log
git checkout -- .jeo/input-history 2>/dev/null || true

# Stage all tracked modifications/deletions and new implementation/test/spec/vault files
git add -A \
  .env.example \
  .gitignore \
  .dockerignore \
  AGENTS.md \
  README.md \
  package.json \
  tsconfig.json \
  claws/ \
  compose/ \
  config/ \
  control/ \
  discord/ \
  docker-compose.yml \
  docker-compose.live.yml \
  glue/ \
  hive/ \
  ops/ \
  qa/ \
  runtimes/ \
  scripts/ \
  secrets/ \
  artifacts/native-qualification/summary.json \
  artifacts/native-qualification/zeroclaw.offline.sanitized.json \
  artifacts/native-qualification/nullclaw.offline.sanitized.json

# Stage tracked deletions of obsolete root scratch files and .jeo tool-results
git add -u

echo "==> 7. Committing and pushing to origin/main..."
git status -s
git commit -m "feat(lifecycle): migrate operational path to jeopi/gpt-6.1-terra, harden lifecycle & clean root scratch files"
git push origin main

echo "==> Complete! All verification gates passed and pushed to origin/main."
