#!/usr/bin/env bash
# One authoritative verification gate (review finding P1-6 / round-2 finding 5).
# CI should invoke ONLY `bun run verify`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> frozen install"
bun install --frozen-lockfile

echo "==> typecheck"
npx tsc --noEmit --skipLibCheck

echo "==> vitest (client + importable unit suites)"
npx vitest run

echo "==> bun test:db (PI + DB integration suites)"
bun run test:db

echo "==> production build"
npx vite build

echo "==> eslint (product-intelligence + routes)"
npx eslint src/product-intelligence src/server/routes/product-intelligence-routes.ts --ext .ts

echo "verify: ALL GATES GREEN"
