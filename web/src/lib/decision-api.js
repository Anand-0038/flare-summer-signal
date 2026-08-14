import { fetchFassetSnapshot } from './fassets.js'
import {
  DEFAULT_GUARDIAN_OPERATION,
  DEFAULT_GUARDIAN_LOTS,
  evaluateOperation,
  isGuardianOperation,
  normalizeRequestedLots,
} from './guardian.js'

export function parseDecisionParams(searchParams) {
  const operation = String(searchParams.get('operation') || '').trim() || DEFAULT_GUARDIAN_OPERATION
  const lotsInput = String(searchParams.get('lots') || '').trim() || DEFAULT_GUARDIAN_LOTS

  if (!isGuardianOperation(operation)) {
    return {
      error: 'INVALID_OPERATION',
      message: `Unsupported Guardian operation: ${operation}`,
    }
  }

  if (normalizeRequestedLots(lotsInput) === null) {
    return {
      error: 'INVALID_LOTS',
      message: 'lots must be a positive whole number no larger than 1e18.',
    }
  }

  return { operation, lots: String(lotsInput) }
}

export async function fetchDecisionPayload({ rpcUrl, operation, lots }) {
  const snapshot = await fetchFassetSnapshot({ rpcUrl })
  const decision = evaluateOperation(
    snapshot,
    snapshot.thresholds,
    operation,
    lots,
    snapshot.signals,
  )

  return {
    ...snapshot,
    decision,
  }
}
