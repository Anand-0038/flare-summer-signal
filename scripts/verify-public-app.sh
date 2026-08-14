#!/usr/bin/env bash
set -euo pipefail

APP_URL="${1:-${APP_URL:-}}"
if [[ -z "$APP_URL" ]]; then
  echo "Usage: APP_URL=https://your-app.example.com $0" >&2
  exit 2
fi

if [[ "$APP_URL" != https://* ]]; then
  echo "Refusing to verify a non-HTTPS public URL: $APP_URL" >&2
  exit 2
fi

APP_URL="${APP_URL%/}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

echo "==> fetch public dashboard"
curl --fail --silent --show-error --location --max-time 45 \
  "$APP_URL/" >"$TMP_DIR/index.html"
rg -q 'Flare Summer Signal' "$TMP_DIR/index.html"

echo "==> fetch public live API"
curl --fail --silent --show-error --location --max-time 45 \
  --dump-header "$TMP_DIR/api.headers" \
  "$APP_URL/api/signals.json" >"$TMP_DIR/signals.json"

rg -qi '^content-type: application/json' "$TMP_DIR/api.headers"
rg -qi '^cache-control:.*no-store' "$TMP_DIR/api.headers"
rg -qi '^access-control-allow-origin: \*' "$TMP_DIR/api.headers"
rg -q '"schemaVersion":1' "$TMP_DIR/signals.json"
rg -q '"chainId":114' "$TMP_DIR/signals.json"
rg -q '"assetManager":"0x' "$TMP_DIR/signals.json"
rg -q '"fAsset":"0x' "$TMP_DIR/signals.json"
if rg -q '"rpcUrl"' "$TMP_DIR/signals.json"; then
  echo "Public API exposes an RPC URL" >&2
  exit 1
fi
if rg -q 'LIVE_DATA_UNAVAILABLE|No fallback snapshot' "$TMP_DIR/signals.json"; then
  echo "Public API returned a fail-closed error instead of a live snapshot" >&2
  exit 1
fi

echo "==> fetch public redemption preflight API"
curl --fail --silent --show-error --location --max-time 45 \
  "$APP_URL/api/redemption.json?lots=100" >"$TMP_DIR/redemption.json"
rg -q '"redemptionPreview"' "$TMP_DIR/redemption.json"
rg -q '"operation":"redeem_fxrp"' "$TMP_DIR/redemption.json"
rg -q '"requestedLots":"100"' "$TMP_DIR/redemption.json"
rg -q '"decision":"(ALLOW|WATCH|BLOCK)"' "$TMP_DIR/redemption.json"
if rg -q '"rpcUrl"' "$TMP_DIR/redemption.json"; then
  echo "Public redemption API exposes an RPC URL" >&2
  exit 1
fi

BROWSER_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [[ -z "$BROWSER_BIN" ]]; then
  echo "Public API passed, but Chromium is required for the rendered-app check" >&2
  exit 1
fi

echo "==> render public dashboard"
"$BROWSER_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --virtual-time-budget=30000 \
  --dump-dom "$APP_URL/" >"$TMP_DIR/dom.html"

for required_text in \
  "Flare Summer Signal" \
  "LIVE" \
  "COSTON2" \
  "Redemption preflight" \
  "ALLOW / WATCH / BLOCK" \
  "Public agent health" \
  "Agent JSON"; do
  if ! rg -q "$required_text" "$TMP_DIR/dom.html"; then
    echo "Public dashboard missing rendered text: $required_text" >&2
    exit 1
  fi
done

echo "verify-public-app OK: HTTPS app, live Coston2 API, no RPC disclosure, and rendered dashboard verified"
