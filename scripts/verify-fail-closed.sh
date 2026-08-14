#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/web"
PORT="${FAIL_CLOSED_PORT:-5197}"
BASE_URL="http://127.0.0.1:${PORT}"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

echo "==> start Vite with an invalid RPC endpoint"
VITE_BIN="$WEB_DIR/node_modules/.bin/vite"
if [[ ! -x "$VITE_BIN" ]]; then
  echo "Fail-closed smoke requires installed web dependencies: $VITE_BIN" >&2
  exit 1
fi
cd "$WEB_DIR"
FLARE_RPC_URL=http://127.0.0.1:1 "$VITE_BIN" --host 127.0.0.1 --port "$PORT" --strictPort >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl --fail --silent "$BASE_URL/" >"$TMP_DIR/index.html"; then
    break
  fi
  sleep 0.5
done

if [[ ! -s "$TMP_DIR/index.html" ]]; then
  echo "Fail-closed smoke could not start the Vite server:" >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi

STATUS="$(curl --silent --show-error --output "$TMP_DIR/body.json" --write-out '%{http_code}' --max-time 20 "$BASE_URL/api/signals.json")"
test "$STATUS" = "503"
rg -q '"error":"LIVE_DATA_UNAVAILABLE"' "$TMP_DIR/body.json"
rg -q 'No fallback snapshot is served' "$TMP_DIR/body.json"

REDEMPTION_STATUS="$(curl --silent --show-error --output "$TMP_DIR/redemption.json" --write-out '%{http_code}' --max-time 20 "$BASE_URL/api/redemption.json?lots=100")"
test "$REDEMPTION_STATUS" = "503"
rg -q '"error":"LIVE_DATA_UNAVAILABLE"' "$TMP_DIR/redemption.json"
rg -q 'No fallback redemption preview is served' "$TMP_DIR/redemption.json"

PLAN_STATUS="$(curl --silent --show-error --output "$TMP_DIR/redemption-plan.json" --write-out '%{http_code}' --max-time 20 "$BASE_URL/api/redemption-plan.json?lots=100&underlying=rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm")"
test "$PLAN_STATUS" = "503"
rg -q '"error":"LIVE_DATA_UNAVAILABLE"' "$TMP_DIR/redemption-plan.json"
rg -q 'No fallback transaction plan is served' "$TMP_DIR/redemption-plan.json"

echo "==> verify redemption status fail-closed behavior under invalid RPC"
STATUS_CODE="$(curl --silent --show-error --output "$TMP_DIR/redemption-status.json" --write-out '%{http_code}' --max-time 20 "$BASE_URL/api/redemption-status.json?tx=0xabababababababababababababababababababababababababababababababab")"
test "$STATUS_CODE" = "503"
rg -q '"error":"LIVE_DATA_UNAVAILABLE"' "$TMP_DIR/redemption-status.json"
rg -q 'Coston2 data could not be read' "$TMP_DIR/redemption-status.json"

echo "verify-fail-closed OK: invalid RPC produced HTTP 503 without fallback snapshot, preview, plan, or status"
