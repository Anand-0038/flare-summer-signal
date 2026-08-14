#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PM="corepack pnpm"

echo "==> forge format check"
cd "$ROOT/contracts"
forge fmt --check

echo "==> forge test"
cd "$ROOT/contracts"
forge test -q

echo "==> web build"
cd "$ROOT/web"
if [[ -f package-lock.json ]]; then $PM install --frozen-lockfile; else $PM install; fi
$PM run test
$PM audit --audit-level=high
$PM run build

echo "==> fail-closed smoke"
cd "$ROOT"
./scripts/verify-fail-closed.sh

echo "==> verify-local OK"
echo "Next: cd web && corepack pnpm run dev  → http://127.0.0.1:5178"
echo "Live provider check: cd web && corepack pnpm run smoke:live"
