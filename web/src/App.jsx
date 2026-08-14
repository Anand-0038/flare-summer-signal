import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_THRESHOLDS,
  evaluateSnapshot,
} from './lib/signals.js'
import {
  DEFAULT_REDEMPTION_LOTS,
  previewRedemption,
} from './lib/redemption.js'
import { buildStatusLookupParams } from './lib/status-lookup.js'

const REFRESH_TIMEOUT_MS = 20_000
const HANDOFF_TIMEOUT_MS = 20_000
const STATUS_TIMEOUT_MS = 20_000

export default function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [queueWarningInput, setQueueWarningInput] = useState(
    String(DEFAULT_THRESHOLDS.queueWarningLots),
  )
  const [redemptionLotsInput, setRedemptionLotsInput] = useState(DEFAULT_REDEMPTION_LOTS)
  const [copyState, setCopyState] = useState('')
  const [redemptionAccount, setRedemptionAccount] = useState('')
  const [underlyingAddress, setUnderlyingAddress] = useState('')
  const [destinationTag, setDestinationTag] = useState('')
  const [redemptionPlan, setRedemptionPlan] = useState(null)
  const [redemptionPlanLoading, setRedemptionPlanLoading] = useState(false)
  const [redemptionPlanError, setRedemptionPlanError] = useState('')
  const [statusLookupMode, setStatusLookupMode] = useState('tx')
  const [statusTxInput, setStatusTxInput] = useState('')
  const [statusRequestIdInput, setStatusRequestIdInput] = useState('')
  const [statusFromBlockInput, setStatusFromBlockInput] = useState('')
  const [statusToBlockInput, setStatusToBlockInput] = useState('')
  const [statusLookupResult, setStatusLookupResult] = useState(null)
  const [statusLookupLoading, setStatusLookupLoading] = useState(false)
  const [statusLookupError, setStatusLookupError] = useState('')
  const [statusLookupApiPath, setStatusLookupApiPath] = useState('')

  const invalidateTransactionPlan = useCallback(() => {
    setRedemptionPlan(null)
    setRedemptionPlanError('')
  }, [])

  const invalidateStatusLookup = useCallback(() => {
    setStatusLookupResult(null)
    setStatusLookupError('')
    setStatusLookupApiPath('')
  }, [])

  const refresh = useCallback(async () => {
    invalidateTransactionPlan()
    setLoading(true)
    setError('')

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)

    try {
      const response = await fetch('/api/signals.json', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(
          payload?.message || `Live read failed with HTTP ${response.status}`,
        )
      }

      setSnapshot(payload)
      setQueueWarningInput(
        String(payload.thresholds?.queueWarningLots ?? DEFAULT_THRESHOLDS.queueWarningLots),
      )
    } catch (caught) {
      setError(
        caught?.name === 'AbortError'
          ? 'Coston2 did not respond before the 20 second timeout.'
          : caught?.message || 'The live Coston2 read failed.',
      )
    } finally {
      window.clearTimeout(timeout)
      setLoading(false)
    }
  }, [invalidateTransactionPlan])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const queueWarningLots = useMemo(() => {
    const parsed = Number(queueWarningInput)
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_THRESHOLDS.queueWarningLots
  }, [queueWarningInput])

  const view = useMemo(() => {
    if (!snapshot) return null
    return evaluateSnapshot(snapshot, {
      ...snapshot.thresholds,
      queueWarningLots,
      queueCriticalLots: Math.max(queueWarningLots + 1, queueWarningLots * 2),
    })
  }, [queueWarningLots, snapshot])

  const redemptionPreview = useMemo(() => {
    if (!view) return null
    return previewRedemption(view, redemptionLotsInput)
  }, [redemptionLotsInput, view])

  const displayRedemptionPreview = useMemo(() => {
    if (!redemptionPreview || (!error && !loading)) return redemptionPreview
    return {
      ...redemptionPreview,
      decision: 'BLOCK',
      status: 'unknown',
      certainty: loading ? 'reading' : 'stale',
      headline: 'Recheck required before signing.',
      summary: loading
        ? 'A fresh Coston2 read is in progress. Guardian will not approve a redemption against the previous snapshot.'
        : 'The last successful Coston2 snapshot is stale. Guardian will not approve a redemption until a fresh read succeeds.',
    }
  }, [error, loading, redemptionPreview])

  const attentionCount = view?.signals.items.filter(
    (item) => item.status === 'warning' || item.status === 'critical',
  ).length || 0
  const agentHealth = view?.agents?.healthSummary || { healthy: 0, total: 0 }

  const copyJson = async () => {
    if (!view) return

    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ ...view, redemptionPreview: displayRedemptionPreview }, null, 2),
      )
      setCopyState('Copied')
    } catch {
      setCopyState('Clipboard blocked')
    }
    window.setTimeout(() => setCopyState(''), 2_000)
  }

  const connectWallet = async () => {
    if (!window.ethereum?.request) {
      setRedemptionPlanError('No injected Flare wallet was detected. Paste an EVM account to prepare calldata without connecting.')
      return
    }

    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
      const account = Array.isArray(accounts) ? accounts[0] : ''
      if (!account) throw new Error('The wallet returned no account.')
      setRedemptionAccount(account)
      setRedemptionPlan(null)
      setRedemptionPlanError('')
    } catch (caught) {
      setRedemptionPlanError(caught?.message || 'Wallet connection was not approved.')
    }
  }

  const prepareRedemptionPlan = async () => {
    setRedemptionPlanLoading(true)
    setRedemptionPlanError('')
    setRedemptionPlan(null)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS)

    try {
      const params = new URLSearchParams({
        lots: redemptionLotsInput,
        underlying: underlyingAddress.trim(),
      })
      if (redemptionAccount.trim()) params.set('account', redemptionAccount.trim())
      if (destinationTag.trim()) params.set('tag', destinationTag.trim())

      const response = await fetch(`/api/redemption-plan.json?${params.toString()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.message || `Transaction handoff failed with HTTP ${response.status}`)
      }
      setRedemptionPlan(payload?.redemptionPlan || null)
      if (!payload?.redemptionPlan) throw new Error('The live API returned no transaction plan.')
    } catch (caught) {
      setRedemptionPlanError(
        caught?.name === 'AbortError'
          ? 'Coston2 did not respond before the 20 second transaction-handoff timeout.'
          : caught?.message || 'The live transaction handoff failed.',
      )
    } finally {
      window.clearTimeout(timeout)
      setRedemptionPlanLoading(false)
    }
  }

  const lookupRedemptionStatus = async () => {
    setStatusLookupLoading(true)
    setStatusLookupError('')
    setStatusLookupResult(null)

    const preparedLookup = buildStatusLookupParams({
      mode: statusLookupMode,
      tx: statusTxInput,
      requestId: statusRequestIdInput,
      fromBlock: statusFromBlockInput,
      toBlock: statusToBlockInput,
    })
    if (preparedLookup.error) {
      setStatusLookupError(preparedLookup.message)
      setStatusLookupApiPath('')
      setStatusLookupLoading(false)
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
    const apiPath = `/api/redemption-status.json?${preparedLookup.query}`
    setStatusLookupApiPath(apiPath)

    try {
      const response = await fetch(apiPath, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.message || `Request status failed with HTTP ${response.status}`)
      }
      setStatusLookupResult(payload)
    } catch (caught) {
      setStatusLookupError(
        caught?.name === 'AbortError'
          ? 'Coston2 did not respond before the 20 second status-check timeout.'
          : caught?.message || 'The request status lookup failed.',
      )
    } finally {
      window.clearTimeout(timeout)
      setStatusLookupLoading(false)
    }
  }

  const changeStatusMode = (mode) => {
    if (mode !== 'tx' && mode !== 'requestId') {
      return
    }
    if (mode === statusLookupMode) {
      return
    }

    if (mode === 'tx') {
      setStatusTxInput('')
      setStatusFromBlockInput('')
      setStatusToBlockInput('')
    } else {
      setStatusTxInput('')
    }

    setStatusLookupMode(mode)
    invalidateStatusLookup()
  }

  const changeStatusTxInput = (value) => {
    setStatusTxInput(value)
    invalidateStatusLookup()
  }

  const changeStatusRequestIdInput = (value) => {
    setStatusRequestIdInput(value)
    invalidateStatusLookup()
  }

  const changeStatusFromBlockInput = (value) => {
    setStatusFromBlockInput(value)
    invalidateStatusLookup()
  }

  const changeStatusToBlockInput = (value) => {
    setStatusToBlockInput(value)
    invalidateStatusLookup()
  }

  const changeQueueWarningInput = (value) => {
    setQueueWarningInput(value)
    invalidateTransactionPlan()
  }

  const changeRedemptionLots = (value) => {
    setRedemptionLotsInput(value)
    invalidateTransactionPlan()
  }

  const changeRedemptionAccount = (value) => {
    setRedemptionAccount(value)
    invalidateTransactionPlan()
  }

  const changeUnderlyingAddress = (value) => {
    setUnderlyingAddress(value)
    invalidateTransactionPlan()
  }

  const changeDestinationTag = (value) => {
    setDestinationTag(value)
    invalidateTransactionPlan()
  }

  const connectionState = loading ? 'CONNECTING' : snapshot && !error ? 'LIVE' : 'UNAVAILABLE'

  return (
    <div className="app-shell">
      <div className="topline" aria-hidden="true" />
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="FAsset Guardian — Flare Summer Signal home">
          <span className="wordmark__mark">FG</span>
          <span>FAsset Guardian</span>
        </a>
        <div className="header-meta">
          <span
            className={`connection connection--${connectionState.toLowerCase()}`}
            role="status"
            aria-live="polite"
          >
            <span className="connection__dot" aria-hidden="true" />
            {connectionState}
          </span>
          <span className="network-chip">COSTON2 <b>114</b></span>
        </div>
      </header>

      <main className="content">
        {view ? (
          <RedemptionConsole
            preview={displayRedemptionPreview}
            lotsInput={redemptionLotsInput}
            onLotsChange={changeRedemptionLots}
            snapshot={view}
            account={redemptionAccount}
            onAccountChange={changeRedemptionAccount}
            onConnectWallet={connectWallet}
            underlyingAddress={underlyingAddress}
            onUnderlyingAddressChange={changeUnderlyingAddress}
            destinationTag={destinationTag}
            onDestinationTagChange={changeDestinationTag}
            transactionPlan={redemptionPlan}
            transactionPlanLoading={redemptionPlanLoading}
            transactionPlanError={redemptionPlanError}
            onPreparePlan={prepareRedemptionPlan}
          />
        ) : null}

        <section className="hero" aria-labelledby="page-title">
          <div className="eyebrow eyebrow--with-rule">
            <span>FASSET EVIDENCE LAYER / 02</span>
            <span className="eyebrow__state">SERVER-SIDE · NON-CUSTODIAL</span>
          </div>
          <div className="hero__row">
            <div className="hero__copy">
              <h1 id="page-title">See the exact exit path before you sign.</h1>
              <p className="hero__lede">
                A redemption decision is only useful when the path is inspectable. This layer exposes
                the same pinned Coston2 read—queue tickets, agents, oracle, sync, collateral, and
                protocol state—so an integrator can verify what the request will touch.
              </p>
              <div className="hero__factline" aria-label="Current read details">
                <span><span className="hero__fact-dot" aria-hidden="true" /> Registry resolved on every refresh</span>
                <span>Block <strong>{view ? formatInteger(view.network.blockNumber) : '—'}</strong></span>
              </div>
            </div>
            <div className="hero__side">
              {view ? <HeroReadout view={view} stale={Boolean(error)} refreshing={loading} /> : <HeroReadoutLoading loading={loading} />}
              <div className="hero__actions">
                <button type="button" className="button button--dark" onClick={refresh} disabled={loading}>
                  {loading ? 'Reading live state…' : 'Refresh live state'}
                </button>
                <a className="button button--outline" href="/api/signals.json" target="_blank" rel="noreferrer">
                  Agent JSON ↗
                </a>
              </div>
            </div>
          </div>
        </section>

        {error && snapshot ? (
          <div className="notice notice--warning" role="alert">
            <strong>Refresh failed.</strong> The dashboard below is the last successful read and
            must not be treated as current until the next live refresh succeeds. {error}
          </div>
        ) : null}

        {!snapshot && loading ? (
          <section className="empty-state" aria-live="polite">
            <span className="loader" aria-hidden="true" />
            <h2>Reading Coston2…</h2>
            <p>Resolving the Flare registry and reading the FXRP system. No fixture data is shown.</p>
          </section>
        ) : null}

        {!snapshot && !loading ? (
          <section className="empty-state empty-state--error" role="alert">
            <div className="empty-state__icon" aria-hidden="true">!</div>
            <h2>Live data unavailable</h2>
            <p>{error || 'The Coston2 read layer did not return a valid snapshot.'}</p>
            <p className="muted">The app is fail-closed: it does not replace a failed provider read with demo values.</p>
            <button type="button" className="button button--dark" onClick={refresh}>
              Try again
            </button>
          </section>
        ) : null}

        {view ? (
          <nav className="section-index" aria-label="Dashboard sections">
            <span className="section-index__label">JUMP TO EVIDENCE</span>
            <a href="#redemption-title"><span>01</span> Exit path <b>preflight</b></a>
            <a href="#signals-title"><span>02</span> Signals <b>{view.signals.items.length}</b></a>
            <a href="#agents-title"><span>03</span> Agents <b>{formatInteger(view.agents.totalAvailable)}</b></a>
            <a href="#protocol-title"><span>04</span> Protocol <b>read only</b></a>
            <a href="#collateral-title"><span>05</span> Collateral <b>{view.collateralTypes?.length || 0}</b></a>
            <a href="#status-title"><span>06</span> Request status <b>lookup</b></a>
          </nav>
        ) : null}

        {view ? (
          <>
            <section className="overview-grid" aria-label="Live overview">
              <article className={`posture-card posture-card--${view.signals.overall.status}`}>
                <div className="card-kicker">CURRENT POSTURE</div>
                <div className="posture-card__value">{statusLabel(view.signals.overall.status)}</div>
                <p>{view.signals.overall.detail}</p>
                <span className="posture-card__stamp" title={view.generatedAt}>
                  Snapshot {formatRelativeAge(view.generatedAt)}
                </span>
              </article>
              <MetricCard
                label="XRP / USD"
                value={view.oracle.price}
                detail={`FTSO update ${view.oracle.ageSeconds}s ago`}
                tone={view.signals.items.find((item) => item.id === 'oracle')?.status}
              />
              <MetricCard
                label="REDEMPTION QUEUE"
                value={`${formatInteger(view.queue.totalLots)} lots`}
                detail={`${formatInteger(view.queue.ticketCount)} live tickets`}
                tone={view.signals.items.find((item) => item.id === 'queue')?.status}
              />
              <MetricCard
                label="PUBLIC AGENTS"
                value={formatInteger(view.agents.totalAvailable)}
                detail={`${formatInteger(view.agents.freeCollateralLots)} free lots`}
                tone={view.signals.items.find((item) => item.id === 'capacity')?.status}
              />
            </section>

          <section className="section-block" aria-labelledby="signals-title">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">WHY THE PATH LOOKS LIKE THAT</div>
                  <h2 id="signals-title">Evidence to act on</h2>
                </div>
                <p>
                  <strong>{attentionCount ? `${attentionCount} needs attention.` : 'All signals are clear.'}</strong>{' '}
                  Every card is derived from the same Coston2 read used by the redemption preflight.
                </p>
              </div>
              <div className="signals-grid">
                {view.signals.items.map((item) => (
                  <SignalCard key={item.id} item={item} />
                ))}
              </div>
            </section>

            <section className="section-block section-block--split" aria-labelledby="agents-title">
              <div className="section-heading section-heading--compact">
                <div>
                  <div className="eyebrow">COLLATERAL COVER</div>
                  <h2 id="agents-title">Public agent health</h2>
                </div>
                <p>
                  <strong>{formatInteger(agentHealth.healthy)}/{formatInteger(agentHealth.total)} healthy.</strong>{' '}
                  Vault and pool ratios from <code>getAgentInfo</code>.
                </p>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Agent vault</th>
                      <th scope="col">State</th>
                      <th scope="col">Vault CR</th>
                      <th scope="col">Pool CR</th>
                      <th scope="col">Free lots</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.agents.items.map((agent) => (
                      <tr key={agent.agentVault}>
                        <td>
                          <a
                            className="address-link"
                            href={`${view.network.explorerUrl}/address/${agent.agentVault}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortAddress(agent.agentVault)} ↗
                          </a>
                        </td>
                        <td><StatusPill status={agent.healthStatus} label={agent.status} /></td>
                        <td><RatioCell value={agent.vaultCollateral} /></td>
                        <td><RatioCell value={agent.poolCollateral} /></td>
                        <td className="numeric">{formatInteger(agent.freeCollateralLots)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="lower-grid" aria-label="Queue and protocol details">
              <article className="panel">
                <div className="panel__heading">
                  <div>
                    <div className="eyebrow">OPERATOR CONTROL</div>
                    <h2>Queue warning threshold</h2>
                  </div>
                  <span className="panel__tag">LOCAL FILTER</span>
                </div>
                <p className="panel__copy">
                  Change the warning band without changing the chain read. The critical band is set at
                  twice this value.
                </p>
                <label className="threshold-field">
                  <span>Warn after lots</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={queueWarningInput}
                    onChange={(event) => changeQueueWarningInput(event.target.value)}
                  />
                </label>
                <div className="threshold-result">
                  <span>Current queue</span>
                  <strong>{formatInteger(view.queue.totalLots)} lots</strong>
                </div>
              </article>

              <article className="panel" aria-labelledby="protocol-title">
                <div className="panel__heading">
                  <div>
                    <div className="eyebrow">PROTOCOL STATE</div>
                    <h2 id="protocol-title">What the contracts say now</h2>
                  </div>
                  <span className="panel__tag">READ ONLY</span>
                </div>
                <dl className="facts-list">
                  <Fact label="Asset" value={view.asset.symbol} />
                  <Fact label="FAsset contract" value={shortAddress(view.source.fAsset)} mono link={explorerAddress(view.network.explorerUrl, view.source.fAsset)} />
                  <Fact label="Asset Manager" value={shortAddress(view.source.assetManager)} mono link={explorerAddress(view.network.explorerUrl, view.source.assetManager)} />
                  <Fact label="FTSO / feed" value={`${shortAddress(view.source.ftsoV2)} · XRP/USD`} mono link={explorerAddress(view.network.explorerUrl, view.source.ftsoV2)} />
                  <Fact label="Read at block" value={formatInteger(view.network.blockNumber)} mono />
                  <Fact label="Ticket cap" value={`${formatInteger(view.settings?.maxRedeemedTickets)} per redemption`} />
                  <Fact label="Payment window" value={`${formatInteger(view.settings?.underlyingSecondsForPayment)}s · ${formatInteger(view.settings?.underlyingBlocksForPayment)} blocks`} />
                  <Fact label="Pause state" value={view.protocol.emergencyPaused ? 'Emergency pause' : view.protocol.mintingPaused ? 'Minting paused' : 'Operating'} />
                </dl>
              </article>
            </section>

            <section className="section-block section-block--compact-bottom" aria-labelledby="collateral-title">
              <div className="section-heading section-heading--compact">
                <div>
                  <div className="eyebrow">SYSTEM CONFIGURATION</div>
                  <h2 id="collateral-title">Collateral accepted by this FXRP deployment</h2>
                </div>
                <p>Thresholds come from the Asset Manager&apos;s live <code>getCollateralTypes</code> response.</p>
              </div>
              <div className="collateral-grid">
                {view.collateralTypes.map((type) => (
                  <article className="collateral-card" key={`${type.collateralClass}-${type.token}`}>
                    <div className="collateral-card__top">
                      <span className="panel__tag">{type.collateralClass}</span>
                      <a className="address-link" href={explorerAddress(view.network.explorerUrl, type.token)} target="_blank" rel="noreferrer">
                        {shortAddress(type.token)} ↗
                      </a>
                    </div>
                    <strong>{type.tokenFtsoSymbol || 'No token feed'}</strong>
                    <span>{type.assetFtsoSymbol} price pair</span>
                    <div className="ratio-pair">
                      <span>Minimum <b>{ratioText(type.minCollateralRatioBIPS)}</b></span>
                      <span>Safety <b>{ratioText(type.safetyMinCollateralRatioBIPS)}</b></span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="section-block" aria-labelledby="status-title">
              <div className="section-heading section-heading--compact">
                <div>
                  <div className="eyebrow">POST-REQUEST VERIFIABILITY</div>
                  <h2 id="status-title">Track redemption request status</h2>
                </div>
                <p>
                  Check a request hash directly, or lookup by requestId and block range. This reads redemption
                  request and completion events from the same live chain evidence Guardian already uses.
                </p>
              </div>
              <RedemptionStatusTracker
                explorerUrl={view.network.explorerUrl}
                lookupMode={statusLookupMode}
                txInput={statusTxInput}
                requestIdInput={statusRequestIdInput}
                fromBlockInput={statusFromBlockInput}
                toBlockInput={statusToBlockInput}
                onModeChange={changeStatusMode}
                onTxChange={changeStatusTxInput}
                onRequestIdChange={changeStatusRequestIdInput}
                onFromBlockChange={changeStatusFromBlockInput}
                onToBlockChange={changeStatusToBlockInput}
                onLookup={lookupRedemptionStatus}
                lookupLoading={statusLookupLoading}
                lookupError={statusLookupError}
                lookupResult={statusLookupResult}
                lookupApiPath={statusLookupApiPath}
              />
            </section>

            <section className="proof-strip" aria-label="Proof and usage notes">
              <div>
                <div className="eyebrow">FOR KEEPERS / AGENTS</div>
                <h2>One endpoint, no dashboard scraping.</h2>
                <p>
                  Consume <code>/api/redemption.json?lots=100</code> for a FIFO path, affected agents,
                  payment-window evidence, and a policy result in one response. Use <code>/api/redemption-plan.json</code> for exact <code>redeemAmount</code> or
                  <code>redeemWithTag</code> calldata plus an optional live Coston2 simulation. Both
                  endpoints resolve Flare&apos;s registry on every read and return 503 when live data is unavailable.
                </p>
              </div>
              <div className="proof-strip__actions">
                <button type="button" className="button button--light" onClick={copyJson}>
                  {copyState || 'Copy current JSON'}
                </button>
                <span className="sr-only" role="status" aria-live="polite">{copyState}</span>
                <a
                  className="button button--light-outline"
                  href={`/api/redemption.json?lots=${encodeURIComponent(redemptionPreview?.requestedLots || DEFAULT_REDEMPTION_LOTS)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open redemption API ↗
                </a>
              </div>
            </section>
          </>
        ) : null}
      </main>

      <footer className="site-footer">
        <span>Flare Summer Signal · FAsset Guardian · Bounty 1</span>
        <span>Live Coston2 reads · preflight + unsigned handoff</span>
      </footer>
    </div>
  )
}

function RedemptionConsole({
  preview,
  lotsInput,
  onLotsChange,
  snapshot,
  account,
  onAccountChange,
  onConnectWallet,
  underlyingAddress,
  onUnderlyingAddressChange,
  destinationTag,
  onDestinationTagChange,
  transactionPlan,
  transactionPlanLoading,
  transactionPlanError,
  onPreparePlan,
}) {
  const apiHref = preview
    ? `/api/redemption.json?lots=${encodeURIComponent(preview.requestedLots)}`
    : '/api/redemption.json'
  const evidence = preview?.evidence
  const result = preview?.result
  const decisionTone = preview?.decision === 'ALLOW'
    ? 'allow'
    : preview?.decision === 'WATCH'
      ? 'watch'
      : preview?.status === 'unknown'
        ? 'unknown'
        : 'block'

  return (
    <section className="guardian-console redemption-console" aria-labelledby="redemption-title">
      <div className="guardian-console__header">
        <div>
          <div className="eyebrow">FASSET EXIT / FIFO PREFLIGHT</div>
          <h2 id="redemption-title">Can this FXRP exit be fulfilled?</h2>
          <p>
            Enter a redemption size. Guardian replays the live FIFO queue, caps the preview at the protocol&apos;s max ticket count, and checks every agent that inherits the payment obligation.
          </p>
        </div>
        <div className="guardian-console__promise" aria-label="Redemption preflight result vocabulary">
            <span>OUTPUT</span>
            <strong>ALLOW / WATCH / BLOCK</strong>
            <small>Unsigned handoff · no signing or broadcast</small>
        </div>
      </div>

      <div className="guardian-console__grid">
        <div className="guardian-controls">
          <label className="guardian-amount-field">
            <span>1 / Requested exit in lots</span>
            <input
              id="redemption-lots"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={lotsInput}
              onChange={(event) => onLotsChange(event.target.value)}
              aria-describedby="redemption-lots-help"
            />
            <small id="redemption-lots-help">
              1 lot = {snapshot.asset.lotSize || '—'} {snapshot.asset.symbol}; this preview does not submit or reserve a redemption.
            </small>
          </label>

          <div className="guardian-handoff">
            <div className="guardian-fieldset__label">3 / Transaction handoff</div>
            <p>
              Prepare the exact Asset Manager call for a wallet or protocol. Guardian only reads and simulates; it never signs or broadcasts.
            </p>
            <label className="guardian-input-field">
              <span>Flare account for simulation <em>optional</em></span>
              <input
                id="redemption-account"
                type="text"
                inputMode="text"
                spellCheck="false"
                autoComplete="off"
                placeholder="0x…"
                value={account}
                onChange={(event) => onAccountChange(event.target.value)}
              />
            </label>
            <button type="button" className="button button--small button--light-dark" onClick={onConnectWallet}>
              Connect injected wallet
            </button>
            <label className="guardian-input-field">
              <span>XRPL payout address <em>required</em></span>
              <input
                id="underlying-address"
                type="text"
                inputMode="text"
                spellCheck="false"
                autoComplete="off"
                placeholder="r…"
                required
                value={underlyingAddress}
                onChange={(event) => onUnderlyingAddressChange(event.target.value)}
              />
            </label>
            <label className="guardian-input-field">
              <span>Destination tag <em>optional · XRP only</em></span>
              <input
                id="destination-tag"
                type="text"
                inputMode="numeric"
                spellCheck="false"
                autoComplete="off"
                placeholder="e.g. 123456"
                maxLength={10}
                value={destinationTag}
                onChange={(event) => onDestinationTagChange(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button button--mint"
              onClick={onPreparePlan}
              disabled={transactionPlanLoading || !underlyingAddress.trim()}
            >
              {transactionPlanLoading ? 'Reading + simulating…' : 'Prepare transaction handoff'}
            </button>
            <small className="guardian-handoff__note">
              <>With an account, the server performs a Coston2 <code>eth_call</code> simulation. Without one, it returns calldata marked <b>NOT SIMULATED</b>.</>
            </small>
          </div>

          <div className="guardian-controls__footer">
              <span>Observed at block <b>{formatInteger(snapshot.network.blockNumber)}</b></span>
              <span>FIFO queue · agents do not get selected by the redeemer</span>
            <a className="guardian-api-link" href={apiHref} target="_blank" rel="noreferrer">
              Open this preflight as JSON ↗
            </a>
          </div>
        </div>

        <article className={`guardian-decision guardian-decision--${decisionTone}`} aria-live="polite">
          <div className="guardian-decision__top">
            <span>2 / Redemption preflight</span>
            <span className="guardian-decision__certainty">
              {preview?.certainty === 'unverified' || preview?.certainty === 'stale' || preview?.certainty === 'reading' ? 'RECHECK' : 'LIVE READ'}
            </span>
          </div>
          <div className="guardian-decision__value">
            <strong>{preview?.decision || '—'}</strong>
            <span>{preview?.requestedLots || '—'} lots · {preview?.assetSymbol || 'FXRP'}</span>
          </div>
          <h3>{preview?.headline || 'Waiting for a live preflight.'}</h3>
          <p>{preview?.summary || 'Resolve a live Coston2 snapshot to preview the redemption path.'}</p>

          {result?.selectedTickets?.length ? (
            <div className="redemption-path">
              <div className="guardian-route__top">
                <span>FIFO TICKETS SELECTED</span>
                <StatusPill status={preview?.outcome === 'FULL' ? 'healthy' : 'warning'} label={`${result.selectedTicketCount} ticket${result.selectedTicketCount === 1 ? '' : 's'}`} />
              </div>
              <div className="redemption-path__list">
                {result.selectedTickets.slice(0, 5).map((ticket) => (
                  <div className="redemption-path__item" key={ticket.redemptionTicketId}>
                    <span className="redemption-path__step">{ticket.position}</span>
                    <div>
                      <strong>Ticket #{ticket.redemptionTicketId || '—'}</strong>
                      <small>{shortAddress(ticket.agentVault)} · {formatInteger(ticket.selectedLots)} of {formatInteger(ticket.ticketLots)} lots</small>
                    </div>
                    <b>{formatInteger(ticket.selectedValueUBA)} UBA</b>
                  </div>
                ))}
              </div>
              {result.selectedTickets.length > 5 ? <small className="redemption-path__more">+ {result.selectedTickets.length - 5} more FIFO tickets</small> : null}
            </div>
          ) : null}

          {result?.obligations?.length ? (
            <div className="redemption-obligations">
              <div className="guardian-route__top">
                <span>AGENT OBLIGATIONS</span>
                <span>{result.obligations.length} affected</span>
              </div>
              {result.obligations.map((obligation) => (
                <div className="redemption-obligation" key={obligation.agentVault}>
                  <div>
                    <a
                      className="redemption-obligation__agent"
                      href={explorerAddress(snapshot.network.explorerUrl, obligation.agentVault)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(obligation.agentVault)} ↗
                    </a>
                    <small>{formatInteger(obligation.selectedLots)} lots · {obligation.ticketCount} ticket{obligation.ticketCount === 1 ? '' : 's'} · free balance {formatInteger(obligation.freeUnderlyingBalanceUBA)} UBA</small>
                  </div>
                  <StatusPill status={obligation.status} label={obligation.agentStatus} />
                </div>
              ))}
            </div>
          ) : null}

          <div className="guardian-reasons">
            <span className="guardian-reasons__label">WHY</span>
            {preview?.reasons?.length ? (
              <ul>
                {preview.reasons.slice(0, 4).map((reason) => (
                  <li key={reason.code}>
                    <strong>{reason.title}</strong>
                    <span>{reason.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No policy exceptions observed in this path.</p>
            )}
          </div>

          {evidence ? (
            <div className="guardian-evidence">
              <span>Evidence</span>
              <b>block {formatInteger(evidence.blockNumber)}</b>
              <b>queue {formatInteger(evidence.queueLots)} lots</b>
              <b>cap {formatInteger(evidence.maxRedeemedTickets)} tickets</b>
              <b>pay {formatInteger(evidence.paymentWindow?.seconds)}s</b>
            </div>
          ) : null}

          {evidence ? (
            <div className="redemption-next">
              <span>AFTER A REAL REQUEST</span>
              <p>
                Each affected agent must pay on the underlying chain within the observed window. If
                payment misses both deadlines, the redeemer can use an FDC payment-nonexistence proof
                to start the default path. Guardian stops before signing either action.
              </p>
            </div>
          ) : null}

          {transactionPlanError ? (
            <div className="transaction-plan-error" role="alert">
              <strong>Transaction handoff failed.</strong> {transactionPlanError}
            </div>
          ) : null}

          {transactionPlan ? <TransactionPlanCard plan={transactionPlan} snapshot={snapshot} /> : null}
        </article>
      </div>
    </section>
  )
}

function RedemptionStatusTracker({
  explorerUrl,
  lookupMode,
  txInput,
  requestIdInput,
  fromBlockInput,
  toBlockInput,
  onModeChange,
  onTxChange,
  onRequestIdChange,
  onFromBlockChange,
  onToBlockChange,
  onLookup,
  lookupLoading,
  lookupError,
  lookupResult,
  lookupApiPath,
}) {
  const statusCode = lookupResult?.status?.code || ''
  const statusTone = statusCodeTone(statusCode)
  const request = lookupResult?.request || {}
  const completion = lookupResult?.completion || {}
  const evidence = lookupResult?.evidence || {}

  return (
    <article className="status-tracker panel">
      <div className="status-tracker__input">
        <fieldset className="status-mode">
          <legend className="status-mode__legend">Lookup mode</legend>
          <label className="status-mode__option">
            <input
              type="radio"
              name="status-mode"
              value="tx"
              checked={lookupMode === 'tx'}
              onChange={() => onModeChange('tx')}
            />
            <span>By tx hash</span>
          </label>
          <label className="status-mode__option">
            <input
              type="radio"
              name="status-mode"
              value="requestId"
              checked={lookupMode === 'requestId'}
              onChange={() => onModeChange('requestId')}
            />
            <span>By requestId + block bounds</span>
          </label>
        </fieldset>

        {lookupMode === 'tx' ? (
          <label className="guardian-input-field">
            <span>Transaction hash</span>
            <input
              id="status-tx"
              type="text"
              inputMode="text"
              spellCheck="false"
              autoComplete="off"
              placeholder="0x..."
              value={txInput}
              onChange={(event) => onTxChange(event.target.value)}
            />
            <small>Optional requestId can reduce ambiguity when one tx emits multiple request IDs.</small>
            <input
              id="status-requestIdForTx"
              type="text"
              inputMode="text"
              pattern="[0-9]+|0[xX][0-9a-fA-F]+"
              spellCheck="false"
              autoComplete="off"
              placeholder="Optional requestId"
              value={requestIdInput}
              onChange={(event) => onRequestIdChange(event.target.value)}
            />
          </label>
        ) : (
          <div className="status-mode-inputs">
            <label className="guardian-input-field status-mode-inputs__field">
              <span>RequestId</span>
              <input
                id="status-requestId"
                type="text"
                inputMode="text"
                pattern="[0-9]+|0[xX][0-9a-fA-F]+"
                spellCheck="false"
                autoComplete="off"
                placeholder="12345"
                value={requestIdInput}
                onChange={(event) => onRequestIdChange(event.target.value)}
              />
            </label>
            <div className="status-range-grid">
              <label className="guardian-input-field status-mode-inputs__field">
                <span>From block (required)</span>
                <input
                  id="status-fromBlock"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]+"
                  spellCheck="false"
                  autoComplete="off"
                  value={fromBlockInput}
                  onChange={(event) => onFromBlockChange(event.target.value)}
                />
              </label>
              <label className="guardian-input-field status-mode-inputs__field">
                <span>To block (optional)</span>
                <input
                  id="status-toBlock"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]+"
                  spellCheck="false"
                  autoComplete="off"
                  value={toBlockInput}
                  onChange={(event) => onToBlockChange(event.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        <div className="status-tracker__actions">
          <button
            type="button"
            className="button button--mint"
            onClick={onLookup}
            disabled={lookupLoading || (lookupMode === 'tx' ? !txInput.trim() : !requestIdInput.trim() || !fromBlockInput.trim())}
          >
            {lookupLoading ? 'Checking status…' : 'Check request status'}
          </button>
          {lookupApiPath ? (
            <a className="button button--light-outline" href={lookupApiPath} target="_blank" rel="noreferrer">
              Open status API ↗
            </a>
          ) : null}
        </div>
      </div>

      {lookupError ? (
        <div className="status-error" role="alert">
          {lookupError}
        </div>
      ) : null}

      {lookupResult ? (
        <article className={`status-result status-result--${statusTone}`}>
          <div className="status-result__top">
            <div>
              <span className="status-result__eyebrow">REQUEST STATUS</span>
              <h3>
                {request.requestId || 'request'}
                {' '}
                ·
                {' '}
                {lookupResult.operationLabel || 'Redemption request status'}
              </h3>
            </div>
            <StatusPill status={statusTone} label={lookupResult.status?.label || 'No status'} />
          </div>
          <p>{lookupResult.status?.summary || 'No status summary available.'}</p>

          {lookupResult.request ? (
            <dl className="facts-list status-result__facts">
              <Fact
                label="Request tx"
                value={request.txHash}
                mono
                link={request.txHash ? explorerTransaction(explorerUrl, request.txHash) : ''}
              />
              <Fact label="Request block" value={request.txBlockNumber} mono />
              <Fact label="Redeemer" value={request.redeemer} mono link={request.redeemer ? addressExplorerLink(explorerUrl, request.redeemer) : ''} />
              <Fact label="Payment address" value={request.paymentAddress} mono />
              <Fact label="Payment reference" value={request.paymentReference || '—'} mono />
            </dl>
          ) : null}

          <dl className="facts-list status-result__facts">
            <Fact label="Total value" value={`${request.totalValueUBA || '—'} UBA`} mono />
            <Fact label="Total fee" value={`${request.totalFeeUBA || '—'} UBA`} mono />
            <Fact label="Executor fee" value={`${request.executorFeeNatWei || '—'} wei`} mono />
            <Fact label="Request count" value={request.requestCount || 0} />
            <Fact label="Destination tag" value={request.destinationTag || '—'} mono />
          </dl>

          <dl className="facts-list status-result__facts">
            <Fact label="Completion tx" value={completion.txHash || '—'} mono link={completion.txHash ? explorerTransaction(explorerUrl, completion.txHash) : ''} />
            <Fact label="Completion state" value={completion.performed ? 'Payment observed' : completion.defaulted ? 'Defaulted' : 'Pending'} />
            <Fact label="Redemption amount" value={completion.redemptionAmountUBA || '—'} mono />
            <Fact label="Vault redeemed" value={completion.redeemedVaultCollateralWei || '—'} mono />
            <Fact label="Pool redeemed" value={completion.redeemedPoolCollateralWei || '—'} mono />
          </dl>

          {evidence?.requestScope ? (
            <dl className="facts-list status-result__facts">
              <Fact label="Scan window" value={`${evidence.requestScope.scanFromBlock} - ${evidence.requestScope.scanToBlock}`} mono />
              <Fact label="Request logs" value={evidence.requestScope.requestLogsInspected} />
              <Fact label="Completion logs" value={evidence.requestScope.completionLogsInspected} />
              <Fact label="Last underlying deadline" value={evidence.deadline?.lastUnderlyingTimestamp || '—'} />
              <Fact label="Deadline remaining" value={formatRemainingSeconds(evidence.deadline?.timestampRemainingSeconds)} />
            </dl>
          ) : null}

          {lookupResult.status?.reasonCodes?.length ? (
            <p className="status-result__reasons">
              <strong>Reason codes:</strong>
              {` ${lookupResult.status.reasonCodes.join(', ')}`}
            </p>
          ) : null}

          <div className="guardian-evidence">
            <span>Generated</span>
            <b>{formatRelativeAge(lookupResult.evidence?.generatedAt || '')}</b>
          </div>
        </article>
      ) : null}
    </article>
  )
}

function TransactionPlanCard({ plan, snapshot }) {
  const tone = plan.decision === 'ALLOW'
    ? 'allow'
    : plan.decision === 'WATCH'
      ? 'watch'
      : 'block'
  const handoffBlocked = plan.decision === 'BLOCK' && !plan.transaction
  const simulationLabel = handoffBlocked
    ? 'HANDOFF BLOCKED'
    : plan.simulation?.status === 'PASSED'
    ? 'SIMULATION PASSED'
    : plan.simulation?.status === 'REVERTED'
      ? 'SIMULATION REVERTED'
      : 'NOT SIMULATED'

  return (
    <section className={`transaction-plan transaction-plan--${tone}`} aria-label="Transaction handoff result" aria-live="polite">
      <div className="transaction-plan__top">
        <span>TRANSACTION HANDOFF</span>
        <StatusPill status={tone === 'allow' ? 'healthy' : tone === 'watch' ? 'warning' : 'critical'} label={simulationLabel} />
      </div>
      <div className="transaction-plan__headline">
        <strong>{plan.decision}</strong>
        <span>{plan.transaction?.functionName || 'No call encoded'}</span>
      </div>
      <p>
        {handoffBlocked
          ? 'Guardian did not encode calldata because the live redemption preflight or request validation blocked this handoff. No transaction was sent.'
          : plan.simulation?.status === 'PASSED'
          ? 'The current Asset Manager accepted these arguments in a read-only Coston2 simulation. A wallet still must review and sign the transaction.'
          : plan.simulation?.status === 'REVERTED'
            ? 'The current Asset Manager rejected these arguments in a read-only simulation. No transaction was sent.'
            : 'Calldata is ready for an integrator, but Guardian has not approved it because no wallet simulation was performed.'}
      </p>
      <dl className="transaction-plan__facts">
        <Fact label="Contract" value={plan.transaction ? shortAddress(plan.transaction.to) : '—'} mono link={plan.transaction ? explorerAddress(snapshot.network.explorerUrl, plan.transaction.to) : ''} />
        <Fact label="Amount" value={`${formatInteger(plan.request.amountUBA)} UBA`} mono />
        <Fact label="Minimum" value={`${formatInteger(plan.asset.minimumRedeemAmountUBA)} UBA`} mono />
        <Fact label="Block" value={formatInteger(plan.network.blockNumber)} mono />
      </dl>
      {plan.transaction ? (
        <div className="transaction-plan__data">
          <span>UNSIGNED CALLDATA</span>
          <code>{plan.transaction.data}</code>
        </div>
      ) : null}
      {plan.simulation?.error ? <p className="transaction-plan__error">{plan.simulation.error}</p> : null}
    </section>
  )
}

function MetricCard({ label, value, detail, tone = 'unknown' }) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="card-kicker">{label}</div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  )
}

function HeroReadout({ view, stale = false, refreshing = false }) {
  const queueSignal = view.signals.items.find((item) => item.id === 'queue')
  const queueLots = Number(view.queue.totalLots)
  const criticalLots = Number(view.thresholds.queueCriticalLots)
  const warningLots = Number(view.thresholds.queueWarningLots)
  const meterPercent = Number.isFinite(queueLots) && Number.isFinite(criticalLots) && criticalLots > 0
    ? Math.min(100, Math.max(2, (queueLots / criticalLots) * 100))
    : 0
  const warningPercent = Number.isFinite(warningLots) && Number.isFinite(criticalLots) && criticalLots > 0
    ? Math.min(100, (warningLots / criticalLots) * 100)
    : 50

  return (
    <article className={`hero-readout hero-readout--${queueSignal?.status || 'unknown'}${stale ? ' hero-readout--stale' : ''}`} aria-live="polite">
      <div className="hero-readout__top">
        <span className="hero-readout__label">
          {stale ? 'LAST SUCCESSFUL READ' : refreshing ? 'REFRESH IN PROGRESS' : 'LIVE OPERATING PICTURE'}
        </span>
        <StatusPill
          status={stale ? 'unknown' : queueSignal?.status || 'unknown'}
          label={stale ? 'stale' : refreshing ? 'reading' : undefined}
        />
      </div>
      <div className="hero-readout__value">
        <strong>{formatInteger(view.queue.totalLots)}</strong>
        <span>queue lots</span>
      </div>
      <p>{stale ? 'Refresh failed. Values below are the last successful Coston2 read.' : queueSignal?.detail || 'Redemption queue pressure is unavailable.'}</p>
      <div
        className="queue-meter"
        role="progressbar"
        aria-label="Redemption queue pressure against the critical threshold"
        aria-valuemin="0"
        aria-valuemax={criticalLots > 0 ? criticalLots : undefined}
        aria-valuenow={Number.isFinite(queueLots) ? queueLots : undefined}
      >
        <span className="queue-meter__track" />
        <span className="queue-meter__warning" style={{ left: `${warningPercent}%` }} />
        <span className={`queue-meter__fill queue-meter__fill--${queueSignal?.status || 'unknown'}`} style={{ width: `${meterPercent}%` }} />
      </div>
      <div className="queue-meter__scale" aria-hidden="true">
        <span>0</span>
        <span>watch {formatInteger(view.thresholds.queueWarningLots)}</span>
        <span>critical {formatInteger(view.thresholds.queueCriticalLots)}</span>
      </div>
      <div className="hero-readout__footer">
        <span>Block <b>{formatInteger(view.network.blockNumber)}</b></span>
        <span>{stale ? 'Last good' : 'Read'} <b>{formatRelativeAge(view.generatedAt)}</b></span>
      </div>
    </article>
  )
}

function RatioCell({ value }) {
  const ratio = Number(value?.ratioBIPS)
  const safety = Number(value?.safetyRatioBIPS)
  const percent = Number.isFinite(ratio) && Number.isFinite(safety) && safety > 0
    ? Math.min(100, Math.max(4, (ratio / (safety * 2)) * 100))
    : 0

  return (
    <div className="ratio-cell">
      <strong>{ratioText(value?.ratioBIPS)}</strong>
      <span className={`ratio-bar ratio-bar--${value?.status || 'unknown'}`} aria-hidden="true">
        <span className="ratio-bar__track" />
        <span className="ratio-bar__safety" />
        <span className="ratio-bar__fill" style={{ width: `${percent}%` }} />
      </span>
      <small>{ratioBand(value)}</small>
    </div>
  )
}

function HeroReadoutLoading({ loading }) {
  return (
    <article className="hero-readout hero-readout--loading" aria-live="polite">
      <div className="hero-readout__top">
        <span className="hero-readout__label">LIVE OPERATING PICTURE</span>
        <StatusPill status={loading ? 'unknown' : 'critical'} label={loading ? 'reading' : 'offline'} />
      </div>
      <div className="hero-readout__loading-value">{loading ? 'Reading Coston2…' : 'No live read'}</div>
      <p>{loading ? 'Resolving registry, settings, queue, oracle, and agents.' : 'Try a live refresh to populate the operating picture.'}</p>
      <div className="queue-meter queue-meter--loading" aria-hidden="true">
        <span className="queue-meter__track" />
      </div>
    </article>
  )
}

function SignalCard({ item }) {
  return (
    <article className={`signal-card signal-card--${item.status}`}>
      <div className="signal-card__top">
        <span className="signal-card__label"><span className="status-dot" aria-hidden="true" />{item.label}</span>
        <StatusPill status={item.status} />
      </div>
      <strong>{item.value}</strong>
      <p>{item.detail}</p>
    </article>
  )
}

function StatusPill({ status, label }) {
  return <span className={`status-pill status-pill--${status}`}>{label || statusLabel(status)}</span>
}

function Fact({ label, value, mono = false, link = '' }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>
        {link ? <a className="address-link" href={link} target="_blank" rel="noreferrer">{value} ↗</a> : value}
      </dd>
    </div>
  )
}

function statusLabel(status) {
  return {
    healthy: 'HEALTHY',
    warning: 'WATCH',
    critical: 'ACTION',
    unknown: 'UNVERIFIED',
  }[status] || 'UNVERIFIED'
}

function statusCodeTone(statusCode) {
  return {
    COMPLETED: 'healthy',
    PAYMENT_PERFORMED: 'healthy',
    DEFAULTED: 'critical',
    PAYMENT_DEFAULTED: 'critical',
    DEADLINE_OPEN: 'warning',
    DEADLINE_ELAPSED: 'critical',
  }[statusCode] || 'unknown'
}

function ratioText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number / 10_000).toFixed(2)}×` : '—'
}

function ratioBand(value) {
  if (!value?.minimumRatioBIPS || !value?.safetyRatioBIPS) return 'threshold unavailable'
  return `min ${ratioText(value.minimumRatioBIPS)} · safety ${ratioText(value.safetyRatioBIPS)}`
}

function formatInteger(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '—'
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || '—'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function explorerAddress(explorer, address) {
  return `${explorer}/address/${address}`
}

function addressExplorerLink(explorer, address) {
  if (!explorer || !address) return ''
  return `${explorer}/address/${address}`
}

function explorerTransaction(explorer, txHash) {
  if (!explorer || !txHash) return ''
  return `${explorer}/tx/${txHash}`
}

function formatRemainingSeconds(value) {
  if (value === null || value === undefined) return '—'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return numeric <= 0 ? '0s' : `${numeric}s`
}

function formatRelativeAge(iso) {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`
}
