export const DEFAULT_GUARDIAN_OPERATION = 'redeem_fxrp'
export const DEFAULT_GUARDIAN_LOTS = '100'

export const GUARDIAN_OPERATIONS = Object.freeze([
  {
    id: 'mint_fxrp',
    label: 'Mint FXRP (legacy)',
    description: 'Assess the older agent-backed mint route on Coston2.',
    requiresAgentRoute: true,
  },
  {
    id: 'accept_fxrp',
    label: 'Accept FXRP',
    description: 'Decide whether a protocol should accept an FXRP deposit.',
    requiresAgentRoute: false,
  },
  {
    id: 'redeem_fxrp',
    label: 'Redeem FXRP',
    description: 'Check whether current redemption pressure is acceptable.',
    requiresAgentRoute: false,
  },
  {
    id: 'lend_against_fxrp',
    label: 'Lend against FXRP',
    description: 'Gate a lending position against live FXRP conditions.',
    requiresAgentRoute: false,
  },
])

const DEFAULT_POLICY = Object.freeze({
  oracleWarningAgeSeconds: 120,
  oracleCriticalAgeSeconds: 600,
  underlyingWarningAgeSeconds: 120,
  underlyingCriticalAgeSeconds: 600,
  queueWarningLots: 500,
  queueCriticalLots: 1000,
  capacityWarningLots: 100,
})

const SIGNAL_LABELS = Object.freeze({
  oracle: 'FTSO freshness',
  collateral: 'Collateral cover',
  underlying: 'Underlying sync',
  queue: 'Redemption queue',
  capacity: 'Agent capacity',
})

export function evaluateGuardian(
  snapshot,
  inputThresholds = {},
  signals = snapshot?.signals,
) {
  const thresholds = normalizePolicy(inputThresholds)
  const decisions = GUARDIAN_OPERATIONS.map((operation) =>
    evaluateOperation(snapshot, thresholds, operation.id, DEFAULT_GUARDIAN_LOTS, signals),
  )

  return {
    schemaVersion: 1,
    defaultOperation: DEFAULT_GUARDIAN_OPERATION,
    defaultLots: DEFAULT_GUARDIAN_LOTS,
    policy: thresholds,
    decisions,
  }
}

export function evaluateOperation(
  snapshot,
  inputThresholds = {},
  operationId = DEFAULT_GUARDIAN_OPERATION,
  requestedLots = DEFAULT_GUARDIAN_LOTS,
  signals = snapshot?.signals,
) {
  const thresholds = normalizePolicy(inputThresholds)
  const operation = GUARDIAN_OPERATIONS.find((item) => item.id === operationId)
  const lots = normalizeRequestedLots(requestedLots)

  if (!operation) {
    return invalidDecision(
      operationId,
      requestedLots,
      'Choose a supported FXRP operation before routing the request.',
    )
  }

  if (lots === null) {
    return invalidDecision(
      operation.id,
      requestedLots,
      'Requested size must be a positive whole number of FAsset lots.',
    )
  }

  const signalMap = new Map((signals?.items || []).map((item) => [item.id, item]))
  const reasons = []
  let hasUnverifiedEvidence = false
  let route = null

  if (
    !snapshot?.protocol ||
    typeof snapshot.protocol.emergencyPaused !== 'boolean' ||
    typeof snapshot.protocol.mintingPaused !== 'boolean'
  ) {
    addReason(
      reasons,
      'PROTOCOL_STATE_UNAVAILABLE',
      'critical',
      'Protocol state unavailable',
      'The Asset Manager pause state was not returned. Guardian fails closed when it cannot verify protocol state.',
    )
    hasUnverifiedEvidence = true
  } else if (snapshot.protocol.emergencyPaused) {
    addReason(
      reasons,
      'EMERGENCY_PAUSE',
      'critical',
      'Emergency pause is active',
      'The FXRP Asset Manager reports an emergency pause. Do not route a new operation through this deployment.',
    )
  }

  for (const signalId of ['oracle', 'collateral', 'underlying']) {
    const signal = signalMap.get(signalId)
    const issue = signalIssue(signalId, signal)
    if (issue) {
      reasons.push(issue)
      if (signal?.status === 'unknown') hasUnverifiedEvidence = true
    }
  }

  const queueSignal = signalMap.get('queue')
  const queueIssue = signalIssue('queue', queueSignal)
  if (queueIssue) {
    reasons.push({
      ...queueIssue,
      title:
        queueSignal?.status === 'warning'
          ? operation.id === 'redeem_fxrp'
            ? 'Redemption queue needs review before adding pressure'
            : 'Redemption pressure is elevated'
          : queueIssue.title,
      detail:
        queueSignal?.status === 'warning'
          ? `${queueIssue.detail} Guardian marks ${operation.label.toLowerCase()} WATCH so an integrator can apply its own queue policy.`
          : queueIssue.detail,
    })
    if (queueSignal?.status === 'unknown') hasUnverifiedEvidence = true
  }

  if (operation.id === 'lend_against_fxrp') {
    const collateralSignal = signalMap.get('collateral')
    if (collateralSignal?.status === 'warning') {
      addReason(
        reasons,
        'LENDING_COLLATERAL_WATCH',
        'critical',
        'Collateral is not lending-grade',
        'A lending policy cannot accept an agent collateral warning as a normal route; require a fresh healthy collateral read first.',
      )
    }

    const oracleSignal = signalMap.get('oracle')
    if (oracleSignal?.status === 'warning') {
      addReason(
        reasons,
        'LENDING_ORACLE_WATCH',
        'critical',
        'Price freshness is not lending-grade',
        'Lending against FXRP requires a fresh XRP/USD read; a warning-band oracle is treated as a block by this default policy.',
      )
    }

    const underlyingSignal = signalMap.get('underlying')
    if (underlyingSignal?.status === 'warning') {
      addReason(
        reasons,
        'LENDING_UNDERLYING_WATCH',
        'critical',
        'Underlying sync is not lending-grade',
        'Lending policy requires the Asset Manager underlying synchronization to remain inside the healthy band.',
      )
    }
  }

  if (operation.id === 'mint_fxrp') {
    if (snapshot?.protocol?.mintingPaused) {
      addReason(
        reasons,
        'MINTING_PAUSED',
        'critical',
        'Minting is paused',
        'The Asset Manager reports that new FXRP minting is paused.',
      )
    }

    const capacitySignal = signalMap.get('capacity')
    if (!capacitySignal || capacitySignal.status === 'unknown') {
      addReason(
        reasons,
        'CAPACITY_UNVERIFIED',
        'critical',
        'Minting capacity is unverified',
        'Guardian could not verify a current public agent capacity read.',
      )
      hasUnverifiedEvidence = true
    } else if (capacitySignal.status === 'warning') {
      addReason(
        reasons,
        'CAPACITY_LOW',
        'warning',
        'Remaining capacity is in the watch band',
        `${capacitySignal.value}; verify the route again immediately before submitting a mint.`,
      )
    }

    route = selectAgentRoute(snapshot?.agents, lots)
    if (!route) {
      const totalFreeLots = toBigInt(snapshot?.agents?.freeCollateralLots)
      const reason =
        totalFreeLots === null
          ? {
              code: 'NO_ROUTE_UNVERIFIED',
              title: 'No agent route could be verified',
              detail: 'Public agent capacity is unavailable, so Guardian will not claim that this mint can be routed.',
            }
          : totalFreeLots < lots
            ? {
                code: 'CAPACITY_SHORTFALL',
                title: 'No public agent can cover this size',
                detail: `The requested ${formatInteger(lots)} lots exceeds the ${formatInteger(totalFreeLots)} free lots observed across public agents.`,
              }
            : {
                code: 'NO_HEALTHY_ROUTE',
                title: 'No healthy public agent can cover this size',
                detail: 'Capacity exists in aggregate, but no NORMAL agent with healthy collateral cover can accept the requested size.',
              }
      addReason(reasons, reason.code, 'critical', reason.title, reason.detail)
      if (totalFreeLots === null) hasUnverifiedEvidence = true
    } else if (route.freeCollateralLots === lots) {
      addReason(
        reasons,
        'ROUTE_AT_LIMIT',
        'warning',
        'Selected route has no size headroom',
        'The selected public agent has exactly the requested free lots. Recheck before signing because capacity can change.',
      )
    }
  }

  const decision = reasons.some((reason) => reason.severity === 'critical')
    ? 'BLOCK'
    : reasons.some((reason) => reason.severity === 'warning')
      ? 'WATCH'
      : 'ALLOW'

  return {
    schemaVersion: 1,
    operation: operation.id,
    operationLabel: operation.label,
    operationDescription: operation.description,
    requestedLots: lots.toString(),
    assetSymbol: snapshot?.asset?.symbol || 'FXRP',
    decision,
    status: decision === 'ALLOW' ? 'healthy' : decision === 'WATCH' ? 'warning' : 'critical',
    certainty: hasUnverifiedEvidence ? 'unverified' : 'observed',
    headline: headlineFor(decision, operation),
    summary: summaryFor(decision, operation, reasons),
    reasonCodes: reasons.map((reason) => reason.code),
    reasons,
    route,
    evidence: evidenceFor(snapshot, signalMap, thresholds),
    policy: thresholds,
  }
}

export function selectAgentRoute(agents, requestedLots) {
  const lots = normalizeRequestedLots(requestedLots)
  if (!agents || lots === null || !Array.isArray(agents.items)) return null

  const eligible = agents.items
    .filter((agent) => agent.status === 'NORMAL' && agent.healthStatus === 'healthy')
    .filter((agent) => {
      const freeLots = toBigInt(agent.freeCollateralLots)
      return freeLots !== null && freeLots >= lots
    })
    .sort((left, right) => {
      const feeDifference = compareBigInt(left.feeBIPS, right.feeBIPS)
      if (feeDifference !== 0) return feeDifference
      const capacityDifference = compareBigInt(right.freeCollateralLots, left.freeCollateralLots)
      if (capacityDifference !== 0) return capacityDifference
      return String(left.agentVault).localeCompare(String(right.agentVault))
    })

  const selected = eligible[0]
  if (!selected) return null

  return {
    agentVault: selected.agentVault,
    status: selected.status,
    healthStatus: selected.healthStatus,
    feeBIPS: selected.feeBIPS,
    freeCollateralLots: selected.freeCollateralLots,
    selectionBasis: 'NORMAL agent, healthy collateral, lowest fee, then highest free capacity',
  }
}

export function normalizeRequestedLots(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (!/^[1-9]\d*$/.test(text)) return null

  try {
    const lots = BigInt(text)
    return lots > 0n && lots <= 1_000_000_000_000_000_000n ? lots : null
  } catch {
    return null
  }
}

export function isGuardianOperation(value) {
  return GUARDIAN_OPERATIONS.some((operation) => operation.id === value)
}

function signalIssue(signalId, signal) {
  const label = SIGNAL_LABELS[signalId] || signalId
  if (!signal || signal.status === 'unknown') {
    return {
      code: `${signalId.toUpperCase()}_UNVERIFIED`,
      severity: 'critical',
      title: `${label} is unverified`,
      detail: signal?.detail || `Guardian did not receive a usable ${label.toLowerCase()} read.`,
    }
  }
  if (signal.status === 'critical') {
    return {
      code: `${signalId.toUpperCase()}_CRITICAL`,
      severity: 'critical',
      title: `${label} is outside policy`,
      detail: `${signal.value}. ${signal.detail}`,
    }
  }
  if (signal.status === 'warning') {
    return {
      code: `${signalId.toUpperCase()}_WATCH`,
      severity: 'warning',
      title: `${label} needs review`,
      detail: `${signal.value}. ${signal.detail}`,
    }
  }
  return null
}

function evidenceFor(snapshot, signalMap, thresholds) {
  return {
    network: snapshot?.network?.name || null,
    chainId: snapshot?.network?.chainId ?? null,
    blockNumber: snapshot?.network?.blockNumber || null,
    generatedAt: snapshot?.generatedAt || null,
    assetManager: snapshot?.source?.assetManager || null,
    fAsset: snapshot?.source?.fAsset || null,
    oracleAgeSeconds: snapshot?.oracle?.ageSeconds ?? null,
    queueLots: snapshot?.queue?.totalLots ?? null,
    publicAgents: snapshot?.agents?.totalAvailable ?? null,
    freeCollateralLots: snapshot?.agents?.freeCollateralLots ?? null,
    underlyingBlockAgeSeconds: snapshot?.protocol?.currentUnderlyingBlock?.ageSeconds ?? null,
    protocol: snapshot?.protocol
      ? {
          emergencyPaused: Boolean(snapshot.protocol.emergencyPaused),
          mintingPaused: Boolean(snapshot.protocol.mintingPaused),
        }
      : null,
    signalStatuses: Object.fromEntries(
      ['oracle', 'collateral', 'underlying', 'queue', 'capacity'].map((id) => [
        id,
        signalMap.get(id)?.status || 'unknown',
      ]),
    ),
    policy: thresholds,
  }
}

function invalidDecision(operationId, requestedLots, detail) {
  return {
    schemaVersion: 1,
    operation: operationId,
    operationLabel: 'FXRP operation',
    operationDescription: 'Guardian request validation',
    requestedLots: String(requestedLots ?? ''),
    assetSymbol: 'FXRP',
    decision: 'BLOCK',
    status: 'critical',
    certainty: 'observed',
    headline: 'Fix the request before routing it.',
    summary: detail,
    reasonCodes: ['INVALID_REQUEST'],
    reasons: [
      {
        code: 'INVALID_REQUEST',
        severity: 'critical',
        title: 'Invalid Guardian request',
        detail,
      },
    ],
    route: null,
    evidence: null,
    policy: normalizePolicy(),
  }
}

function headlineFor(decision, operation) {
  if (decision === 'ALLOW') return `${operation.label} has an observed path.`
  if (decision === 'WATCH') return `${operation.label} needs an operator check.`
  return `Do not route ${operation.label.toLowerCase()} on this snapshot.`
}

function summaryFor(decision, operation, reasons) {
  if (decision === 'ALLOW') {
    return `The live evidence is inside Guardian's configured policy for ${operation.label.toLowerCase()}.`
  }
  if (decision === 'WATCH') {
    return `${reasons.length} policy signal${reasons.length === 1 ? '' : 's'} is in the watch band. This is a policy result, not a transaction simulation.`
  }
  return `${reasons.length} blocker${reasons.length === 1 ? '' : 's'} prevent Guardian from approving this operation. No transaction was submitted.`
}

function normalizePolicy(input) {
  const policy = {}
  for (const [key, fallback] of Object.entries(DEFAULT_POLICY)) {
    const value = Number(input?.[key])
    policy[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback
  }

  policy.oracleCriticalAgeSeconds = Math.max(
    policy.oracleCriticalAgeSeconds,
    policy.oracleWarningAgeSeconds + 1,
  )
  policy.underlyingCriticalAgeSeconds = Math.max(
    policy.underlyingCriticalAgeSeconds,
    policy.underlyingWarningAgeSeconds + 1,
  )

  return policy
}

function addReason(reasons, code, severity, title, detail) {
  reasons.push({ code, severity, title, detail })
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function compareBigInt(left, right) {
  const leftValue = toBigInt(left)
  const rightValue = toBigInt(right)
  if (leftValue === null && rightValue === null) return 0
  if (leftValue === null) return 1
  if (rightValue === null) return -1
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function formatInteger(value) {
  return value.toLocaleString('en-US')
}
