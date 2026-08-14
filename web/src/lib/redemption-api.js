import { fetchFassetSnapshot } from './fassets.js'
import {
  DEFAULT_REDEMPTION_LOTS,
  normalizeRedemptionLots,
  previewRedemption,
} from './redemption.js'
import {
  buildRedemptionPlan,
  parseRedemptionPlanParams,
  simulateRedemptionPlan,
} from './redemption-plan.js'

export function parseRedemptionParams(searchParams) {
  const lots = String(searchParams.get('lots') || '').trim() || DEFAULT_REDEMPTION_LOTS
  if (normalizeRedemptionLots(lots) === null) {
    return {
      error: 'INVALID_LOTS',
      message: 'lots must be a positive whole number no larger than 1e18.',
    }
  }

  return { lots: String(lots) }
}

export async function fetchRedemptionPayload({ rpcUrl, lots }) {
  const snapshot = await fetchFassetSnapshot({ rpcUrl })
  const redemptionPreview = previewRedemption(snapshot, lots)

  return {
    ...snapshot,
    redemptionPreview,
  }
}

export { parseRedemptionPlanParams }

export async function fetchRedemptionPlanPayload({
  rpcUrl,
  lots,
  account,
  underlyingAddress,
  destinationTag,
}) {
  const snapshot = await fetchFassetSnapshot({ rpcUrl })
  const redemptionPreview = previewRedemption(snapshot, lots)
  let redemptionPlan = buildRedemptionPlan(snapshot, {
    lots,
    account,
    underlyingAddress,
    destinationTag,
    preview: redemptionPreview,
  })

  if (account && redemptionPlan.decision !== 'BLOCK') {
    redemptionPlan = await simulateRedemptionPlan({
      rpcUrl,
      plan: redemptionPlan,
      account,
    })
  }

  return {
    ...snapshot,
    redemptionPreview,
    redemptionPlan,
  }
}
