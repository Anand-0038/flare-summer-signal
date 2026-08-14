#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT/web"
PORT="${SMOKE_PORT:-5190}"
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

BROWSER_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [[ -z "$BROWSER_BIN" ]]; then
  echo "SKIP: no Chromium-compatible browser is installed"
  exit 0
fi

echo "==> start live Vite server on ${BASE_URL}"
VITE_BIN="$WEB_DIR/node_modules/.bin/vite"
if [[ ! -x "$VITE_BIN" ]]; then
  echo "Browser smoke requires installed web dependencies: $VITE_BIN" >&2
  exit 1
fi
cd "$WEB_DIR"
"$VITE_BIN" --host 127.0.0.1 --port "$PORT" --strictPort >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl --fail --silent "$BASE_URL/" >"$TMP_DIR/index.html"; then
    break
  fi
  sleep 0.5
done

if [[ ! -s "$TMP_DIR/index.html" ]]; then
  echo "Browser smoke could not start the Vite server:" >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi

echo "==> fetch live API"
if ! curl --fail --silent --show-error --max-time 30 "$BASE_URL/api/signals.json" >"$TMP_DIR/signals.json"; then
  echo "Browser smoke API request failed:" >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi
rg -q '"chainId":114' "$TMP_DIR/signals.json"
rg -q '"assetManager":"0x' "$TMP_DIR/signals.json"
rg -q '"fAsset":"0x' "$TMP_DIR/signals.json"
if rg -q '"rpcUrl"' "$TMP_DIR/signals.json"; then
  echo "Browser smoke found an RPC URL in the public snapshot" >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 30 \
  "$BASE_URL/api/redemption.json?lots=100" >"$TMP_DIR/redemption.json"; then
  echo "Browser smoke redemption API request failed:" >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi
rg -q '"redemptionPreview"' "$TMP_DIR/redemption.json"
rg -q '"operation":"redeem_fxrp"' "$TMP_DIR/redemption.json"
rg -q '"requestedLots":"100"' "$TMP_DIR/redemption.json"
rg -q '"decision":"(ALLOW|WATCH|BLOCK)"' "$TMP_DIR/redemption.json"
if rg -q '"rpcUrl"' "$TMP_DIR/redemption.json"; then
  echo "Browser smoke found an RPC URL in the public redemption payload" >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 30 \
  "$BASE_URL/api/redemption-plan.json?lots=100&underlying=rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm" >"$TMP_DIR/redemption-plan.json"; then
  echo "Browser smoke transaction-plan API request failed:" >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi
rg -q '"redemptionPlan"' "$TMP_DIR/redemption-plan.json"
rg -q '"functionName":"redeemAmount"' "$TMP_DIR/redemption-plan.json"
rg -q '"status":"NOT_SIMULATED"' "$TMP_DIR/redemption-plan.json"
rg -q '"data":"0x' "$TMP_DIR/redemption-plan.json"
if rg -q '"rpcUrl"' "$TMP_DIR/redemption-plan.json"; then
  echo "Browser smoke found an RPC URL in the public transaction-plan payload" >&2
  exit 1
fi

status_code_missing_input=$(curl --silent --write-out "%{http_code}" --output "$TMP_DIR/redemption-status-missing.json" --max-time 30 "$BASE_URL/api/redemption-status.json")
if [[ "$status_code_missing_input" != "400" ]]; then
  echo "Browser smoke expected status endpoint validation error for empty input (HTTP 400), got $status_code_missing_input" >&2
  exit 1
fi
rg -q '"error":"INVALID_INPUT"' "$TMP_DIR/redemption-status-missing.json"

status_code_missing_tx=$(curl --silent --write-out "%{http_code}" --output "$TMP_DIR/redemption-status-tx.json" --max-time 30 "$BASE_URL/api/redemption-status.json?tx=0x0000000000000000000000000000000000000000000000000000000000000000")
if [[ "$status_code_missing_tx" != "400" ]]; then
  echo "Browser smoke expected request lookup failure for zero tx hash (HTTP 400), got $status_code_missing_tx" >&2
  exit 1
fi
rg -q '"error"' "$TMP_DIR/redemption-status-tx.json"

echo "==> render dashboard in headless browser"
"$BROWSER_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --virtual-time-budget=30000 \
  --dump-dom "$BASE_URL/" >"$TMP_DIR/dom.html"

for required_text in \
  "Flare Summer Signal" \
  "LIVE" \
  "COSTON2" \
  "Redemption preflight" \
  "Transaction handoff" \
  "ALLOW / WATCH / BLOCK" \
  "Public agent health" \
  "Agent JSON"; do
  if ! rg -q "$required_text" "$TMP_DIR/dom.html"; then
    echo "Browser smoke missing rendered text: $required_text" >&2
    exit 1
  fi
done

echo "==> exercise transaction handoff interactions"
BROWSER_BIN="$BROWSER_BIN" node "$ROOT/scripts/verify-interactions.mjs" "$BASE_URL"

echo "verify-browser OK: live API and rendered Coston2 dashboard verified"
