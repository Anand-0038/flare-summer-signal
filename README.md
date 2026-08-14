# Flare Summer Signal

Flare Summer Signal is **FAsset Guardian**, a live redemption preflight and non-custodial transaction handoff for FXRP integrators. A wallet or protocol asks whether a concrete exit should proceed. Guardian replays the global FIFO redemption queue, shows the exact tickets and agents that would be touched, checks the live agent obligations, and can prepare `redeemAmount` or XRP-only `redeemWithTag` calldata for an optional Coston2 simulation. It returns `ALLOW`, `WATCH`, or `BLOCK` with the Flare evidence behind it.

The project is prepared for **Bounty 1 — Interoperable Asset Products** in the [Flare Summer Signal hackathon](https://dorahacks.io/hackathon/flaresummersignal/detail). It uses Flare as the source of truth; it does not serve simulated chain data when an RPC read fails.

## The judge-verifiable flow

```text
redemption request: lots
        ↓
same-origin redemption API
        ↓
Flare Contract Registry on Coston2
        ↓
FXRP Asset Manager + FTSO v2 + FAsset token
        ↓
FIFO path + agent obligations + evidence
        ↓
dashboard + unsigned transaction handoff + API
```

1. Open the dashboard and enter a whole-lot FXRP exit size.
2. The server resolves `AssetManagerFXRP` and `FtsoV2` through Flare's registry.
3. It pins the downstream reads to one Coston2 block and reads `getAgentInfo`, `redemptionQueue`, `getSettings`, `getCollateralTypes`, pause state, FTestXRP metadata, underlying sync, and XRP/USD from FTSO.
4. Guardian replays the FIFO prefix up to the live `maxRedeemedTickets` cap, groups the selected lots by agent, checks each agent's state, collateral health, and observed underlying balance, and returns the result with payment-window evidence.
5. `/api/redemption.json?lots=100` exposes the same machine-readable preflight to a wallet, keeper, or protocol integration.
6. Enter an XRPL payout address to prepare an exact unsigned `redeemAmount` call, or add a destination tag for `redeemWithTag`. Add a Flare account to run a server-side Coston2 `eth_call` simulation; Guardian never signs or broadcasts.
7. Track a specific request afterwards with `/api/redemption-status.json` using:
   - `tx=<redemption_tx>` to decode `RedemptionRequested`/`RedemptionWithTagRequested` from a specific tx.
   - optional `requestId=<decimal-or-hex>` to disambiguate one tx.
   - or `requestId=<decimal-or-hex>&fromBlock=<block>` (plus optional `toBlock`) to scan bounded history.
8. If any required read fails, the API returns HTTP 503 and the UI says live data is unavailable. There is no mock fallback.

## What is live

- **Collateral cover:** actual vault and pool collateral ratios from each available agent, compared with the system's minimum and safety ratios.
- **Redemption path:** every queue page is read, summed into ticket count/UBA/lots, and replayed in FIFO order for the requested size.
- **Redemption constraints:** the live `maxRedeemedTickets` cap, payment window, and redemption fee are included in the preflight evidence.
- **Transaction handoff:** the live `minimumRedeemAmountUBA` is checked before encoding `redeemAmount` or `redeemWithTag`; an optional account simulation reports a real contract pass or revert.
- **Oracle freshness:** current XRP/USD value and the age of its FTSO timestamp.
- **Public agent state:** status, vault/pool collateral ratios, observed underlying balance, free underlying balance, and current redeeming amount.
- **Protocol state:** emergency pause, minting pause, underlying-chain timekeeping, and the block used for the snapshot.
- **Guardian policy:** `ALLOW`, `WATCH`, or `BLOCK` for the requested exit, with stable reason codes, selected FIFO tickets, affected agents, and same-block evidence.
- **Fail-closed semantics:** emergency pause, critical freshness, missing agent evidence, unhealthy FIFO agents, and observed balance shortfall block the preflight; queue pressure, warning-band collateral, and partial coverage produce `WATCH`.
- **Agent JSON:** `/api/signals.json` exposes the raw normalized snapshot; `/api/redemption.json` adds a concrete redemption path; `/api/redemption-plan.json` adds unsigned calldata and optional simulation without requiring UI scraping; `/api/redemption-status.json` reports request completion state from redemption-request/completion events. The older `/api/decision.json` remains available for compatibility with the policy primitives.

The queue warning threshold is an operator setting in the UI. It changes signal classification only; it never changes the chain data.

## Run locally

Requirements: Node.js `^20.19.0` or `>=22.12.0`, `corepack pnpm`, and Foundry (`forge`).

```bash
./scripts/verify-local.sh
./scripts/verify-browser.sh
./scripts/verify-fail-closed.sh
node scripts/capture-demo.mjs

cd web
corepack pnpm run dev
```

Open <http://127.0.0.1:5178>. The dev server exposes the live API at <http://127.0.0.1:5178/api/signals.json>.

The local gate runs:

- `forge fmt --check` — Solidity formatting gate.
- `forge test` — Solidity alert primitive tests.
- `corepack pnpm --dir web test` — signal classification tests through the repository's Node test runner.
- `corepack pnpm --dir web audit --audit-level=high` — dependency vulnerability gate.
- `corepack pnpm --dir web run build` — production frontend build.
- `./scripts/verify-fail-closed.sh` — invalid-provider test proving the API returns 503 without fallback data.
- `node scripts/capture-demo.mjs` — local evidence reel from the FIFO preflight, agent health, operator threshold, redemption JSON, transaction-plan JSON, and invalid-provider states; it writes to `/tmp` and requires Chromium plus `ffmpeg`.
- `APP_URL=https://your-app.example.com ./scripts/verify-public-app.sh` — owner-handoff check for the eventual HTTPS deployment; it verifies live Coston2 JSON, headers, no RPC disclosure, and rendered browser text without publishing anything.

The browser/live-render gate is separate because it requires Chromium and the public Coston2 RPC:

- `./scripts/verify-browser.sh` — live API, rendered-dashboard, transaction-handoff, stale-plan invalidation, checksum rejection, and recovery test.

The real provider smoke test is separate because it depends on the public Coston2 RPC:

```bash
cd web
corepack pnpm run smoke:live
```

## Project layout

| Path | Purpose |
| --- | --- |
| `web/src/lib/fassets.js` | Registry-resolved Coston2 read layer and normalization |
| `web/src/lib/signals.js` | Pure signal rules and threshold handling |
| `web/src/lib/guardian.js` | Shared policy primitives and compatibility decision API |
| `web/src/lib/redemption.js` | Deterministic FIFO preview, ticket cap, agent obligations, and reason codes |
| `web/src/lib/redemption-api.js` | Redemption request parsing and preflight payload assembly |
| `web/src/lib/redemption-plan.js` | Exact `redeemAmount`/`redeemWithTag` calldata, minimum check, and optional simulation |
| `web/src/lib/decision-api.js` | Shared request parsing and decision payload assembly |
| `web/scripts/run-tests.mjs` | Version-neutral Node test runner |
| `web/src/App.jsx` | Redemption preflight, evidence dashboard, error states, and JSON export |
| `web/api/signals.js` | Vercel/serverless JSON endpoint |
| `web/api/decision.js` | Vercel/serverless operation-decision endpoint |
| `web/api/redemption.js` | Vercel/serverless FIFO redemption-preflight endpoint |
| `web/api/redemption-plan.js` | Vercel/serverless unsigned transaction-plan and simulation endpoint |
| `web/api/redemption-status.js` | Vercel/serverless redemption request status endpoint |
| `web/vite.config.js` | Local/preview API middleware for the same live path |
| `scripts/verify-browser.sh` | Headless browser and live API smoke gate |
| `scripts/verify-interactions.mjs` | CDP interaction checks for handoff, invalidation, checksum rejection, and recovery |
| `scripts/capture-demo.mjs` | Reproducible local evidence-reel capture; no publication |
| `scripts/verify-public-app.sh` | Verifies an owner-supplied public HTTPS deployment |
| `contracts/src/PriceSignalAlert.sol` | Optional on-chain FTSO deviation alert primitive |
| `contracts/src/FtsoV2Adapter.sol` | Payable FTSO v2 compatibility adapter |

## How this uses Flare

The read layer follows Flare's documented integration boundary:

- The [Flare Contract Registry](https://dev.flare.network/network/guides/flare-contracts-registry) resolves protocol addresses rather than trusting hardcoded manager or FTSO addresses.
- The [FAssets reference](https://dev.flare.network/fassets/reference) supplies the FXRP Asset Manager and FAsset system interfaces.
- The [FAssets redemption queue guide](https://dev.flare.network/fassets/developer-guides/fassets-redemption-queue) defines the paginated queue read and UBA-to-lot calculation. The [redemption overview](https://dev.flare.network/fassets/redemption) defines FIFO selection and partial-redemption behavior, while the [redemption-default guide](https://dev.flare.network/fassets/developer-guides/fassets-redemption-default) defines the underlying payment window and FDC default path.
- The official [redeem-with-tag guide](https://dev.flare.network/fassets/developer-guides/fassets-redeem-with-tag) defines the `minimumRedeemAmountUBA` guard, `simulateContract` boundary, and event-oriented transaction handoff used here. The [Asset Manager reference](https://dev.flare.network/fassets/reference/IAssetManager) defines `redeemAmount` and `redeemWithTag`.
- The [FTSO off-chain guide](https://dev.flare.network/ftso/guides/read-feeds-offchain) defines the Coston2 FTSOv2 feed read and XRP/USD feed ID.

The app is currently scoped to Coston2. It does not claim Flare mainnet, Songbird, a public deployment, or an owned smart-contract address.

## Optional Solidity alert primitive

The Foundry package keeps the original small on-chain extension: a user can subscribe with a baseline and bps threshold, and anyone can call `checkSignal` against an FTSO-compatible feed. It is tested locally with `MockFtsoV2Feed`, but the mock is never presented as live data.

Live deployment is deliberately explicit:

```bash
cd contracts
export FTSO_ADDRESS=0x...       # live Coston2 FtsoV2 address
export PRIVATE_KEY=0x...        # use a secret manager or wallet flow; never commit this
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc \
  --broadcast -vvvv
```

If a local mock deployment is genuinely needed, opt into it explicitly with `DEPLOY_MOCK=true`. An unset `FTSO_ADDRESS` now fails closed.

## Deployment

The frontend is compatible with a Vercel project whose **Root Directory is `web`**. The serverless `/api/signals.json`, `/api/decision.json`, and `/api/redemption.json` functions use the same `src/lib/fassets.js` read layer. `FLARE_RPC_URL` is optional; when unset, the documented public Coston2 endpoint is used.

No API key is required by the default endpoint. A production operator should provide a reliable RPC endpoint through `FLARE_RPC_URL` and monitor 503 responses.
The reader batches same-cycle JSON-RPC calls and retries transient transport failures with bounded backoff. If the public endpoint still times out, configure a reachable managed Coston2 RPC before starting Vite:

```bash
export FLARE_RPC_URL="https://your-coston2-rpc.example/rpc"
export COSTON2_RPC_URL="https://your-coston2-rpc.example/rpc" # optional legacy alias
cd web
corepack pnpm run dev -- --host 127.0.0.1 --port 5178 --strictPort
```

The URL is consumed server-side only and is never returned in `/api/signals.json`.
The configured RPC URL is used server-side and is deliberately omitted from public JSON responses, so a keyed provider URL is not exposed to agents or browsers.

## Troubleshooting live data

If the dashboard shows `UNAVAILABLE`, inspect the API response and provider directly:

```bash
curl --max-time 30 http://127.0.0.1:5178/api/signals.json
curl --max-time 30 'http://127.0.0.1:5178/api/redemption.json?lots=100'
curl --max-time 30 'http://127.0.0.1:5178/api/redemption-status.json?tx=0x...'
curl --max-time 30 'http://127.0.0.1:5178/api/redemption-status.json?requestId=123&fromBlock=1000'
curl --max-time 30 'http://127.0.0.1:5178/api/redemption-status.json?tx=0x...&requestId=123'
curl --max-time 30 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  https://coston2-api.flare.network/ext/C/rpc
```

The expected provider result is chain `0x72` (decimal 114). A temporary provider timeout is exposed as HTTP 503; refresh after the provider recovers or restart with `FLARE_RPC_URL`. No fixture snapshot is used.

## Honest limits and roadmap

Current version is non-custodial and intentionally does not sign or broadcast redemptions, promise an XRP payment, accept XRPL X-addresses, execute FDC proof flows, execute defaults, or send notifications. Classic XRPL payout addresses are Base58Check validated locally. The new request-status endpoint reads `RedemptionRequested`/`RedemptionWithTagRequested` from the tx and updates status from `RedemptionPerformed` or `RedemptionDefault`; it does not fetch XRPL chain payment proof. Without a supplied account, the transaction handoff is explicitly `NOT_SIMULATED`; with an account, a passing `eth_call` only validates the current contract arguments and state. It is not a reservation, payment guarantee, or wait-time prediction. The observed agent balance is a point-in-time read, not proof that a later XRP payment has occurred.

Next steps:

1. Add bounded FDC `ReferencedPaymentNonexistence` preparation and an explicit, user-authorized default workflow for failed XRP payments.
2. Add a versioned SDK and webhook delivery so wallets and protocols can fail closed on `BLOCK` without scraping.
3. Validate the read layer against Songbird and Flare mainnet registry deployments before expanding network support.

Submission-specific notes and recording assets are kept outside the final source package.
