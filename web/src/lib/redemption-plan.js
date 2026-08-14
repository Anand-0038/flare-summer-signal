import {
  encodeFunctionData,
  getAddress,
  zeroAddress,
} from 'viem'
import { base58xrp } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  ASSET_MANAGER_ABI,
  COSTON2_CHAIN_ID,
  createFassetPublicClient,
} from './fassets.js'
import { normalizeRedemptionLots } from './redemption.js'

export const EXECUTOR_ZERO_ADDRESS = zeroAddress
export const MAX_DESTINATION_TAG = 4_294_967_295n
const XRPL_CLASSIC_ADDRESS_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/

export function parseRedemptionPlanParams(searchParams) {
  const lots = String(searchParams.get('lots') || '').trim()
  if (normalizeRedemptionLots(lots) === null) {
    return {
      error: 'INVALID_LOTS',
      message: 'lots must be a positive whole number no larger than 1e18.',
    }
  }

  const underlyingAddress = normalizeUnderlyingAddress(searchParams.get('underlying'))
  if (!underlyingAddress) {
    return {
      error: 'INVALID_UNDERLYING_ADDRESS',
      message: 'underlying must be a checksum-valid XRPL classic address. Full contract validation occurs during simulation.',
    }
  }

  const accountInput = searchParams.get('account')?.trim() || ''
  const account = accountInput ? normalizeEvmAccount(accountInput) : null
  if (accountInput && !account) {
    return {
      error: 'INVALID_ACCOUNT',
      message: 'account must be a valid EVM address.',
    }
  }

  const tagInput = searchParams.get('tag')?.trim() || ''
  const destinationTag = tagInput ? normalizeDestinationTag(tagInput) : null
  if (tagInput && destinationTag === null) {
    return {
      error: 'INVALID_DESTINATION_TAG',
      message: 'tag must be an integer from 0 through 4294967295.',
    }
  }

  return {
    lots: String(lots),
    account,
    underlyingAddress,
    destinationTag: destinationTag?.toString() || null,
  }
}

export function normalizeUnderlyingAddress(value) {
  const address = String(value || '').trim()
  if (!XRPL_CLASSIC_ADDRESS_PATTERN.test(address)) return null
  if (/\s|[\u0000-\u001f\u007f]/.test(address)) return null
  return isValidXrplClassicAddress(address) ? address : null
}

export function isValidXrplClassicAddress(address) {
  try {
    const decoded = base58xrp.decode(address)
    if (decoded.length !== 25 || decoded[0] !== 0) return false
    if (base58xrp.encode(decoded) !== address) return false

    const payload = decoded.subarray(0, 21)
    const checksum = decoded.subarray(21)
    const expected = sha256(sha256(payload)).subarray(0, 4)
    let mismatch = 0
    for (let index = 0; index < checksum.length; index += 1) {
      mismatch |= checksum[index] ^ expected[index]
    }
    return mismatch === 0
  } catch {
    return false
  }
}

export function normalizeEvmAccount(value) {
  try {
    return getAddress(String(value || '').trim())
  } catch {
    return null
  }
}

export function normalizeDestinationTag(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null

  try {
    const tag = BigInt(text)
    return tag <= MAX_DESTINATION_TAG ? tag : null
  } catch {
    return null
  }
}

export function buildRedemptionPlan(
  snapshot,
  {
    lots,
    account = null,
    underlyingAddress,
    destinationTag = null,
    preview = null,
  } = {},
) {
  const normalizedLots = normalizeRedemptionLots(lots)
  const normalizedUnderlyingAddress = normalizeUnderlyingAddress(underlyingAddress)
  const normalizedAccount = account ? normalizeEvmAccount(account) : null
  const assetManager = normalizeEvmAccount(snapshot?.source?.assetManager)
  const hasDestinationTag = destinationTag !== null && destinationTag !== undefined && destinationTag !== ''
  const normalizedTag = !hasDestinationTag
    ? null
    : normalizeDestinationTag(destinationTag)
  const reasons = []

  if (normalizedLots === null) {
    addReason(
      reasons,
      'INVALID_LOTS',
      'critical',
      'The requested amount is invalid',
      'Enter a positive whole number of FXRP lots before preparing a transaction.',
    )
  }
  if (!normalizedUnderlyingAddress) {
    addReason(
      reasons,
      'INVALID_UNDERLYING_ADDRESS',
      'critical',
      'The XRPL payout address is incomplete',
      'Guardian needs the exact underlying address that the agents will pay.',
    )
  }
  if (account && !normalizedAccount) {
    addReason(
      reasons,
      'INVALID_ACCOUNT',
      'critical',
      'The Flare account is invalid',
      'Guardian cannot simulate a transaction from an invalid EVM address.',
    )
  }
  if (hasDestinationTag && normalizedTag === null) {
    addReason(
      reasons,
      'INVALID_DESTINATION_TAG',
      'critical',
      'The destination tag is invalid',
      'An XRP destination tag must be an integer that fits in 32 bits.',
    )
  }
  if (!assetManager) {
    addReason(
      reasons,
      'ASSET_MANAGER_UNVERIFIED',
      'critical',
      'The Asset Manager target is unavailable',
      'Guardian will not prepare calldata without a valid registry-resolved Asset Manager address.',
    )
  }

  const lotSizeUBA = toBigInt(snapshot?.asset?.lotSizeUBA)
  const minimumRedeemAmountUBA = toBigInt(snapshot?.asset?.minimumRedeemAmountUBA)
  const requestedAmountUBA = normalizedLots !== null && lotSizeUBA !== null
    ? normalizedLots * lotSizeUBA
    : null

  if (lotSizeUBA === null || lotSizeUBA <= 0n) {
    addReason(
      reasons,
      'LOT_SIZE_UNVERIFIED',
      'critical',
      'The live lot size is unavailable',
      'Guardian cannot encode the requested FXRP amount without the pinned Asset Manager read.',
    )
  }
  if (minimumRedeemAmountUBA === null) {
    addReason(
      reasons,
      'MINIMUM_REDEEM_UNVERIFIED',
      'critical',
      'The minimum redemption amount is unavailable',
      'Guardian will not prepare a transaction until the Asset Manager exposes its live minimum.',
    )
  } else if (requestedAmountUBA !== null && requestedAmountUBA < minimumRedeemAmountUBA) {
    addReason(
      reasons,
      'BELOW_MINIMUM_REDEEM',
      'critical',
      'The requested amount is below the protocol minimum',
      `${requestedAmountUBA.toString()} UBA is below the live minimum of ${minimumRedeemAmountUBA.toString()} UBA.`,
    )
  }

  const previewDecision = preview?.decision || 'BLOCK'
  if (preview?.outcome === 'PARTIAL') {
    addReason(
      reasons,
      'PREFLIGHT_PARTIAL',
      'critical',
      'The live FIFO path is only partially covered',
      `The current FIFO prefix covers ${preview?.result?.coveredLots || '0'} of ${preview?.requestedLots || normalizedLots?.toString() || 'the requested'} lots. Guardian will not encode the uncovered request.`,
    )
  }
  if (previewDecision === 'BLOCK') {
    addReason(
      reasons,
      'PREFLIGHT_BLOCK',
      'critical',
      'The live redemption preflight is blocked',
      'The transaction handoff inherits the queue, protocol, agent, and evidence checks above.',
    )
  } else if (previewDecision === 'WATCH') {
    addReason(
      reasons,
      'PREFLIGHT_WATCH',
      'warning',
      'The live redemption path needs review',
      'Simulation can validate contract arguments, but it cannot turn a partial or warning path into a clear one.',
    )
  }

  const canEncode = !reasons.some((reason) => reason.severity === 'critical')
    && requestedAmountUBA !== null
    && normalizedUnderlyingAddress
    && (!hasDestinationTag || normalizedTag !== null)
    && assetManager

  const functionName = normalizedTag === null ? 'redeemAmount' : 'redeemWithTag'
  const args = normalizedTag === null
    ? [requestedAmountUBA, normalizedUnderlyingAddress, EXECUTOR_ZERO_ADDRESS]
    : [requestedAmountUBA, normalizedUnderlyingAddress, EXECUTOR_ZERO_ADDRESS, normalizedTag]
  const calldata = canEncode
    ? encodeFunctionData({
      abi: ASSET_MANAGER_ABI,
      functionName,
      args,
    })
    : null

  const policyDecision = reasons.some((reason) => reason.severity === 'critical')
    ? 'BLOCK'
    : previewDecision === 'WATCH'
      ? 'WATCH'
      : 'ALLOW'
  if (!normalizedAccount && policyDecision !== 'BLOCK') {
    addReason(
      reasons,
      'SIMULATION_NOT_RUN',
      'warning',
      'No Flare account was supplied for simulation',
      'The handoff is encoded, but Guardian will not call it safe until a wallet account passes eth_call simulation.',
    )
  }
  const decision = !normalizedAccount && policyDecision !== 'BLOCK'
    ? 'WATCH'
    : policyDecision

  return {
    schemaVersion: 1,
    operation: 'redemption_transaction',
    network: {
      name: 'Coston2',
      chainId: COSTON2_CHAIN_ID,
      blockNumber: snapshot?.network?.blockNumber || null,
    },
    asset: {
      symbol: snapshot?.asset?.symbol || 'FXRP',
      address: snapshot?.source?.fAsset || null,
      lotSizeUBA: lotSizeUBA?.toString() || null,
      minimumRedeemAmountUBA: minimumRedeemAmountUBA?.toString() || null,
    },
    request: {
      lots: normalizedLots?.toString() || null,
      amountUBA: requestedAmountUBA?.toString() || null,
      underlyingAddress: normalizedUnderlyingAddress,
      destinationTag: normalizedTag?.toString() || null,
    },
    policy: {
      previewDecision,
      previewOutcome: preview?.outcome || null,
      decision: policyDecision,
    },
    transaction: canEncode
      ? {
        to: assetManager,
        data: calldata,
        value: '0x0',
        functionName,
        args: args.map((arg) => typeof arg === 'bigint' ? arg.toString() : arg),
        account: normalizedAccount,
      }
      : null,
    simulation: {
      status: 'NOT_RUN',
      returnedAmountUBA: null,
      error: null,
    },
    decision,
    status: decision === 'BLOCK' ? 'BLOCKED' : 'NOT_SIMULATED',
    reasonCodes: reasons.map((reason) => reason.code),
    reasons,
    evidence: {
      blockNumber: snapshot?.network?.blockNumber || null,
      previewReasonCodes: preview?.reasonCodes || [],
    },
  }
}

export async function simulateRedemptionPlan({ rpcUrl, plan, account }) {
  if (!plan?.transaction || plan.decision === 'BLOCK') return plan

  const normalizedAccount = normalizeEvmAccount(account || plan.transaction.account)
  if (!normalizedAccount) {
    return withSimulation(plan, {
      status: 'REVERTED',
      error: 'A valid Flare account is required for simulation.',
    })
  }

  const amountUBA = toBigInt(plan.request.amountUBA)
  const tag = plan.request.destinationTag === null
    ? null
    : normalizeDestinationTag(plan.request.destinationTag)
  if (amountUBA === null || !plan.request.underlyingAddress || (plan.request.destinationTag !== null && tag === null)) {
    return withSimulation(plan, {
      status: 'REVERTED',
      error: 'The encoded transaction request is incomplete.',
    })
  }

  const args = tag === null
    ? [amountUBA, plan.request.underlyingAddress, EXECUTOR_ZERO_ADDRESS]
    : [amountUBA, plan.request.underlyingAddress, EXECUTOR_ZERO_ADDRESS, tag]

  try {
    const client = createFassetPublicClient(rpcUrl)
    const simulation = await client.simulateContract({
      account: normalizedAccount,
      address: plan.transaction.to,
      abi: ASSET_MANAGER_ABI,
      functionName: plan.transaction.functionName,
      args,
      value: 0n,
    })

    return withSimulation(plan, {
      status: 'PASSED',
      returnedAmountUBA: toBigInt(simulation.result)?.toString() || null,
      gasEstimate: simulation.request?.gas?.toString() || null,
      error: null,
    })
  } catch (error) {
    return withSimulation(plan, {
      status: 'REVERTED',
      returnedAmountUBA: null,
      error: readableSimulationError(error),
    })
  }
}

function withSimulation(plan, simulation) {
  const remainingReasons = plan.reasons.filter((reason) => reason.code !== 'SIMULATION_NOT_RUN')
  const reasons = simulation.status === 'PASSED'
    ? remainingReasons
    : [
      ...remainingReasons,
      {
        code: 'SIMULATION_REVERTED',
        severity: 'critical',
        title: 'The Asset Manager rejected this call in simulation',
        detail: simulation.error || 'The request was not accepted by the current Coston2 contract state.',
      },
    ]
  const decision = simulation.status === 'PASSED'
    ? plan.policy.decision
    : 'BLOCK'

  return {
    ...plan,
    transaction: plan.transaction
      ? { ...plan.transaction, account: plan.transaction.account || null }
      : null,
    simulation,
    decision,
    status: decision === 'BLOCK'
      ? 'BLOCKED'
      : simulation.status === 'PASSED'
        ? 'SIMULATED'
        : 'BLOCKED',
    reasonCodes: reasons.map((reason) => reason.code),
    reasons,
  }
}

function addReason(reasons, code, severity, title, detail) {
  if (reasons.some((reason) => reason.code === code)) return
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

function readableSimulationError(error) {
  const message = error?.shortMessage || error?.details || error?.message || 'The simulation failed without a provider explanation.'
  return String(message).replace(/\s+/g, ' ').slice(0, 260)
}
