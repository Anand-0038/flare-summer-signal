import { evaluateGuardian } from './guardian.js'

export const DEFAULT_THRESHOLDS = Object.freeze({
  oracleWarningAgeSeconds: 120,
  oracleCriticalAgeSeconds: 600,
  underlyingWarningAgeSeconds: 120,
  underlyingCriticalAgeSeconds: 600,
  queueWarningLots: 500,
  queueCriticalLots: 1000,
  capacityWarningLots: 100,
})

const STATUS_ORDER = Object.freeze({
  healthy: 0,
  warning: 1,
  critical: 2,
  unknown: 3,
})

export function normalizeThresholds(input = {}) {
  const queueWarningLots = positiveInteger(
    input.queueWarningLots,
    DEFAULT_THRESHOLDS.queueWarningLots,
  )
  const queueCriticalLotsInput = positiveInteger(
    input.queueCriticalLots,
    Math.max(queueWarningLots + 1, queueWarningLots * 2),
  )
  const oracleWarningAgeSeconds = positiveInteger(
    input.oracleWarningAgeSeconds,
    DEFAULT_THRESHOLDS.oracleWarningAgeSeconds,
  )
  const underlyingWarningAgeSeconds = positiveInteger(
    input.underlyingWarningAgeSeconds,
    DEFAULT_THRESHOLDS.underlyingWarningAgeSeconds,
  )

  return {
    oracleWarningAgeSeconds,
    oracleCriticalAgeSeconds: Math.max(
      positiveInteger(input.oracleCriticalAgeSeconds, DEFAULT_THRESHOLDS.oracleCriticalAgeSeconds),
      oracleWarningAgeSeconds + 1,
    ),
    underlyingWarningAgeSeconds,
    underlyingCriticalAgeSeconds: Math.max(
      positiveInteger(
        input.underlyingCriticalAgeSeconds,
        DEFAULT_THRESHOLDS.underlyingCriticalAgeSeconds,
      ),
      underlyingWarningAgeSeconds + 1,
    ),
    queueWarningLots,
    queueCriticalLots: Math.max(queueCriticalLotsInput, queueWarningLots + 1),
    capacityWarningLots: positiveInteger(
      input.capacityWarningLots,
      DEFAULT_THRESHOLDS.capacityWarningLots,
    ),
  }
}

export function evaluateSnapshot(snapshot, inputThresholds = {}) {
  const thresholds = normalizeThresholds(inputThresholds)
  const signals = evaluateSignals(snapshot, thresholds)
  const guardian = evaluateGuardian(snapshot, thresholds, signals)

  return {
    ...snapshot,
    thresholds,
    signals,
    guardian,
  }
}

export function evaluateSignals(snapshot, thresholds = DEFAULT_THRESHOLDS) {
  const normalized = normalizeThresholds(thresholds)
  const oracle = evaluateOracle(snapshot.oracle, normalized)
  const queue = evaluateQueue(snapshot.queue, normalized)
  const collateral = evaluateCollateral(snapshot.agents)
  const capacity = evaluateCapacity(snapshot.agents, normalized)
  const protocol = evaluateProtocol(snapshot.protocol)
  const underlying = evaluateUnderlying(snapshot.protocol, normalized)
  const items = [collateral, queue, oracle, capacity, protocol, underlying]

  return {
    overall: {
      status: worstStatus(items.map((item) => item.status)),
      label: 'System posture',
      detail: overallDetail(items),
    },
    items,
  }
}

export function statusFromRatio(currentBips, minimumBips, safetyBips) {
  const current = toBigInt(currentBips)
  const minimum = toBigInt(minimumBips)
  const safety = toBigInt(safetyBips)

  if (current === null || minimum === null || safety === null) {
    return 'unknown'
  }
  if (current < minimum) return 'critical'
  if (current < safety) return 'warning'
  return 'healthy'
}

function evaluateOracle(oracle, thresholds) {
  if (!oracle || oracle.timestamp === undefined) {
    return signal(
      'oracle',
      'Oracle freshness',
      'unknown',
      'No feed read',
      'The latest XRP/USD FTSO value is unavailable.',
    )
  }

  const age = nonNegativeInteger(oracle.ageSeconds)
  if (age === null) {
    return signal(
      'oracle',
      'Oracle freshness',
      'unknown',
      'Age unavailable',
      'The feed timestamp could not be converted into an age.',
    )
  }

  const status =
    age > thresholds.oracleCriticalAgeSeconds
      ? 'critical'
      : age > thresholds.oracleWarningAgeSeconds
        ? 'warning'
        : 'healthy'

  return signal(
    'oracle',
    'Oracle freshness',
    status,
    `${age}s old`,
    `XRP/USD update age; warning after ${thresholds.oracleWarningAgeSeconds}s.`,
  )
}

function evaluateQueue(queue, thresholds) {
  const lots = toBigInt(queue?.totalLots)
  if (lots === null) {
    return signal(
      'queue',
      'Redemption queue',
      'unknown',
      'Queue unavailable',
      'The on-chain redemption queue could not be read.',
    )
  }

  const warning = BigInt(thresholds.queueWarningLots)
  const critical = BigInt(thresholds.queueCriticalLots)
  const status = lots >= critical ? 'critical' : lots >= warning ? 'warning' : 'healthy'

  return signal(
    'queue',
    'Redemption queue',
    status,
    `${formatInteger(lots)} lots`,
    `Operator warning at ${formatInteger(warning)} lots; this is a live queue snapshot, not a historical trend.`,
  )
}

function evaluateCollateral(agents) {
  const summary = agents?.healthSummary
  if (!summary || summary.total === undefined) {
    return signal(
      'collateral',
      'Collateral cover',
      'unknown',
      'Coverage unavailable',
      'Agent collateral ratios could not be read.',
    )
  }

  const critical = Number(summary.critical ?? 0)
  const warning = Number(summary.warning ?? 0)
  const unknown = Number(summary.unknown ?? 0)
  const total = Number(summary.total ?? 0)
  const status =
    total === 0
      ? 'unknown'
      : critical > 0
        ? 'critical'
        : warning > 0
          ? 'warning'
          : unknown > 0
            ? 'unknown'
            : 'healthy'

  return signal(
    'collateral',
    'Collateral cover',
    status,
    total === 0
      ? 'No public agents'
      : unknown > 0
        ? `${unknown}/${total} unavailable`
        : `${total - critical - warning}/${total} healthy`,
    total === 0
      ? 'No publicly available FAsset agents were returned by the Asset Manager.'
      : unknown > 0
        ? `${unknown} agent${unknown === 1 ? '' : 's'} could not be compared with a complete collateral threshold set.`
      : `${critical} below minimum, ${warning} below safety band. Ratios are read from agent state.`,
  )
}

function evaluateCapacity(agents, thresholds) {
  const total = Number(agents?.healthSummary?.total ?? 0)
  const lots = toBigInt(agents?.freeCollateralLots)
  if (lots === null) {
    return signal(
      'capacity',
      'Minting capacity',
      'unknown',
      'Capacity unavailable',
      'Available agent capacity could not be read.',
    )
  }

  const status =
    total === 0 || lots === 0n
      ? 'critical'
      : lots < BigInt(thresholds.capacityWarningLots)
        ? 'warning'
        : 'healthy'

  return signal(
    'capacity',
    'Public agent capacity',
    status,
    `${formatInteger(lots)} free lots`,
    `${total} public agent${total === 1 ? '' : 's'}; warning below ${thresholds.capacityWarningLots} free lots.`,
  )
}

function evaluateProtocol(protocol) {
  if (
    !protocol ||
    typeof protocol.emergencyPaused !== 'boolean' ||
    typeof protocol.mintingPaused !== 'boolean'
  ) {
    return signal(
      'protocol',
      'Protocol operations',
      'unknown',
      'State unavailable',
      'FAssets pause state could not be read.',
    )
  }

  const status = protocol.emergencyPaused
    ? 'critical'
    : protocol.mintingPaused
      ? 'warning'
      : 'healthy'

  return signal(
    'protocol',
    'Protocol operations',
    status,
    protocol.emergencyPaused
      ? 'Emergency pause'
      : protocol.mintingPaused
        ? 'Minting paused'
        : 'Operating',
    'Read from the live FXRP Asset Manager pause state.',
  )
}

function evaluateUnderlying(protocol, thresholds) {
  const age = nonNegativeInteger(protocol?.currentUnderlyingBlock?.ageSeconds)
  if (age === null) {
    return signal(
      'underlying',
      'Underlying sync',
      'unknown',
      'Sync unavailable',
      'The Asset Manager underlying-chain synchronization timestamp could not be read.',
    )
  }

  const status =
    age > thresholds.underlyingCriticalAgeSeconds
      ? 'critical'
      : age > thresholds.underlyingWarningAgeSeconds
        ? 'warning'
        : 'healthy'

  return signal(
    'underlying',
    'Underlying sync',
    status,
    `${age}s since update`,
    `Asset Manager sync age; warning after ${thresholds.underlyingWarningAgeSeconds}s.`,
  )
}

function signal(id, label, status, value, detail) {
  return { id, label, status, value, detail }
}

function overallDetail(items) {
  const critical = items.filter((item) => item.status === 'critical').length
  const warning = items.filter((item) => item.status === 'warning').length
  const unknown = items.filter((item) => item.status === 'unknown').length

  if (critical > 0) return `${critical} critical signal${critical === 1 ? '' : 's'} require attention.`
  if (warning > 0) return `${warning} signal${warning === 1 ? ' is' : 's are'} outside the configured comfort band.`
  if (unknown > 0) return 'One or more signals are unavailable; do not treat the snapshot as complete.'
  return 'All configured live signals are inside their current comfort bands.'
}

function worstStatus(statuses) {
  return statuses.reduce((worst, current) =>
    STATUS_ORDER[current] > STATUS_ORDER[worst] ? current : worst,
  'healthy')
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function formatInteger(value) {
  return value.toLocaleString('en-US')
}
