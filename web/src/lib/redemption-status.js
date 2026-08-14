import { decodeEventLog, parseAbi } from 'viem'
import {
  ASSET_MANAGER_ABI,
  COSTON2_CHAIN_ID,
  FLARE_CONTRACT_REGISTRY,
  createFassetPublicClient,
} from './fassets.js'
import { parseStatusLookupParams } from './status-lookup.js'

const REGISTRY_ABI = parseAbi([
  'function getContractAddressByName(string _name) view returns (address)',
])
const MAX_LOOKBACK_BLOCKS = 1_000_000n

export function parseRedemptionStatusParams(searchParams) {
  const fromBlockText = String(searchParams.get('fromBlock') || '').trim()
  const toBlockText = String(searchParams.get('toBlock') || '').trim()
  const requestIdText = String(searchParams.get('requestId') || '').trim()
  const txText = String(searchParams.get('tx') || '').trim()
  const txProvided = txText !== ''

  if (!txProvided && !requestIdText) {
    return {
      error: 'INVALID_INPUT',
      message:
        'Provide a transaction hash (`tx`) for a bounded request read, or a `requestId` plus `fromBlock`.',
    }
  }

  const parsed = parseStatusLookupParams({
    mode: txProvided ? 'tx' : 'requestId',
    tx: txProvided ? txText : null,
    requestId: requestIdText,
    fromBlock: fromBlockText,
    toBlock: toBlockText,
  })
  if (parsed.error) {
    if (!txProvided && requestIdText && !fromBlockText && parsed.error === 'INVALID_FROM_BLOCK') {
      return {
        error: 'REQUEST_ID_REQUIRES_FROM_BLOCK',
        message: 'requestId lookup requires a lower bound block in fromBlock.',
      }
    }

    return {
      error: parsed.error,
      message: parsed.message,
    }
  }

  return {
    tx: parsed.tx,
    requestId: parsed.requestId,
    fromBlock: parsed.fromBlock,
    toBlock: parsed.toBlock,
  }
}

export async function fetchRedemptionStatusPayload({
  rpcUrl,
  tx,
  requestId,
  fromBlock,
  toBlock,
}) {
  const client = createFassetPublicClient(rpcUrl)
  const chainId = await client.getChainId()
  if (chainId !== COSTON2_CHAIN_ID) {
    throw new Error(`Unsupported network: expected Coston2 chain ${COSTON2_CHAIN_ID}, got ${chainId}`)
  }

  const assetManager = await client.readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'getContractAddressByName',
    args: ['AssetManagerFXRP'],
  })

  if (!assetManager || /^0x0{40}$/i.test(assetManager)) {
    throw new Error('Flare registry did not return AssetManagerFXRP')
  }

  const latestBlock = await client.getBlockNumber()

  const requestLookup = tx
    ? await findRedemptionRequestByTransactionHash(
      client,
      assetManager,
      tx,
      requestId,
    )
    : await findRedemptionRequestById(client, assetManager, requestId, fromBlock, toBlock)

  if (requestLookup.error) return requestLookup

  const requestEvents = requestLookup.events
  const selectedRequestId = requestLookup.selectedRequestId
  const requestTx = requestLookup.requestTx
  const requestTxBlock = requestLookup.requestBlock

  if (requestTxBlock === null) {
    return {
      error: 'REQUEST_BLOCK_UNAVAILABLE',
      message: 'The redemption request was found without a confirmed block, cannot monitor completion safely.',
    }
  }

  const completionLogs = await client.getLogs({
    address: assetManager,
    fromBlock: requestTxBlock,
    toBlock: latestBlock,
  })
  const completionEvents = requestIdAwareEvents(completionLogs, assetManager, selectedRequestId)
    .filter((event) => event.eventName === 'RedemptionPerformed' || event.eventName === 'RedemptionDefault')

  const nowUnixSeconds = Math.floor(Date.now() / 1000)
  const request = summarizeRequest(selectedRequestId, requestEvents)
  const completion = summarizeCompletion(selectedRequestId, completionEvents)
  const status = summarizeRequestStatus(request, completion, nowUnixSeconds)
  const deadlineAssessment = summarizeDeadline(request.lastUnderlyingTimestamp, nowUnixSeconds)

  return {
    schemaVersion: 1,
    operation: 'redemption_status',
    operationLabel: 'Redemption request status',
    operationDescription: 'Decode RedemptionRequested/RedemptionWithTagRequested and track completion state.',
    assetManager,
    requestId: selectedRequestId,
    request: {
      txHash: requestTx,
      txBlockNumber: String(requestTxBlock),
      requestCount: request.events.length,
      redeemer: request.redeemer,
      paymentAddress: request.paymentAddress,
      paymentReference: request.paymentReference,
      totalValueUBA: request.totalValueUBA,
      totalFeeUBA: request.totalFeeUBA,
      executor: request.executor,
      executorFeeNatWei: request.executorFeeNatWei,
      destinationTag: request.destinationTag || null,
      firstUnderlyingBlock: request.firstUnderlyingBlock,
      lastUnderlyingBlock: request.lastUnderlyingBlock,
      lastUnderlyingTimestamp: request.lastUnderlyingTimestamp,
      obligations: request.obligations,
    },
    completion: {
      performed: completion.performed,
      defaulted: completion.defaulted,
      txHash: completion.transactionHash || null,
      redemptionAmountUBA: completion.redemptionAmountUBA || null,
      redeemedVaultCollateralWei: completion.redeemedVaultCollateralWei || null,
      redeemedPoolCollateralWei: completion.redeemedPoolCollateralWei || null,
      occurredAtBlock: completion.blockNumber || null,
    },
    status: {
      code: status.code,
      label: status.label,
      summary: status.summary,
      reasonCodes: status.reasonCodes,
    },
    evidence: {
      generatedAt: new Date(Date.now()).toISOString(),
      chainId,
      requestScope: {
        scanFromBlock: String(requestTxBlock),
        scanToBlock: String(latestBlock),
        requestLogsInspected: requestEvents.length,
        completionLogsInspected: completionEvents.length,
      },
      deadline: {
        lastUnderlyingTimestamp: request.lastUnderlyingTimestamp,
        deadlineNowUnix: String(nowUnixSeconds),
        timestampDeadlinePassed: request.lastUnderlyingTimestamp === null
          ? null
          : deadlineAssessment.valid
            ? deadlineAssessment.passed
            : null,
        timestampRemainingSeconds: request.lastUnderlyingTimestamp === null
          ? null
          : deadlineAssessment.valid
            ? deadlineAssessment.remainingSeconds
            : null,
      },
      underlyingBlocksForPayment: {
        firstBlock: request.firstUnderlyingBlock,
        lastBlock: request.lastUnderlyingBlock,
      },
      verificationLimits: {
        underlyingBlockDeadline: request.lastUnderlyingBlock
          ? 'Observed from request event; this read cannot verify current XRP chain block height.'
          : 'Unavailable.',
      },
    },
  }
}

async function findRedemptionRequestByTransactionHash(
  client,
  assetManager,
  txHash,
  requestIdFilter,
) {
  const receipt = await getTransactionReceiptWithLookupGuard(client, txHash)
  if (!receipt) {
    return {
      error: 'REQUEST_TX_NOT_FOUND',
      message: 'The transaction hash was not found on Coston2.',
    }
  }

  const requestEvents = requestIdAwareEvents(receipt.logs, assetManager, null)
    .filter((event) => event.eventName === 'RedemptionRequested' || event.eventName === 'RedemptionWithTagRequested')
  const selectedEvents = requestIdFilter
    ? requestEvents.filter((event) => event.args?.requestId?.toString() === requestIdFilter)
    : requestEvents

  if (selectedEvents.length === 0) {
    return {
      error: 'NO_REDEMPTION_REQUEST',
      message: 'No matching RedemptionRequested event was found in the provided tx.',
    }
  }

  if (selectedEvents.length > 1 && requestIdFilter === null) {
    const requestIds = [...new Set(
      selectedEvents.map((event) => event.args?.requestId?.toString()).filter(Boolean),
    )]
    if (requestIds.length > 1) {
      return {
        error: 'AMBIGUOUS_REQUEST_ID',
        message: 'The transaction emitted multiple redemption request IDs. Provide requestId to disambiguate.',
      }
    }
  }

  return {
    events: selectedEvents,
    selectedRequestId: selectedEvents[0].requestId.toString(),
    requestTx: txHash,
    requestBlock: receipt.blockNumber,
  }
}

export async function findRedemptionRequestById(
  client,
  assetManager,
  requestId,
  fromBlock,
  toBlock,
) {
  const latestBlock = await client.getBlockNumber()
  const lowerBound = fromBlock ?? 0n
  const scanTo = toBlock === null || toBlock > latestBlock ? latestBlock : toBlock

  if (scanTo < lowerBound) {
    return {
      error: 'INVALID_SCAN_RANGE',
      message: 'The requestId scan range is invalid because fromBlock is after the latest readable block.',
    }
  }

  const distance = scanTo - lowerBound
  if (distance > MAX_LOOKBACK_BLOCKS) {
    return {
      error: 'SCAN_RANGE_TOO_LARGE',
      message: 'requestId lookup span is capped; use a narrower fromBlock or provide the request transaction hash.',
    }
  }

  const logs = await client.getLogs({
    address: assetManager,
    fromBlock: lowerBound,
    toBlock: scanTo,
  })
  const requestEvents = requestIdAwareEvents(logs, assetManager, requestId)
    .filter((event) => event.eventName === 'RedemptionRequested' || event.eventName === 'RedemptionWithTagRequested')

  if (requestEvents.length === 0) {
    return {
      error: 'NO_REDEMPTION_REQUEST',
      message: 'No matching RedemptionRequested event was found in the provided requestId scan range.',
    }
  }

  const uniqueTx = new Set(requestEvents.map((event) => event.transactionHash))
  if (uniqueTx.size > 1) {
    return {
      error: 'MULTIPLE_REQUEST_TRANSACTIONS',
      message: 'The same requestId appears in multiple transactions within scan range. Narrow the range.',
    }
  }

  const tx = requestEvents[0].transactionHash
  const txBlock = requestEvents[0].blockNumber

  if (!tx || txBlock == null) {
    return {
      error: 'REQUEST_BLOCK_UNAVAILABLE',
      message: 'A matching request was found without transaction context, cannot monitor completion.',
    }
  }

  return {
    events: requestEvents,
    selectedRequestId: requestEvents[0].requestId.toString(),
    requestTx: tx,
    requestBlock: requestEvents[0].blockNumber,
  }
}

function requestIdAwareEvents(logs, assetManager, requestIdFilter) {
  const targetRequest = requestIdFilter ? BigInt(requestIdFilter) : null
  return logs
    .map((log) => {
      if (!log.address) return null
      if (log.address.toLowerCase() !== assetManager.toLowerCase()) return null
      if (log.topics.length === 0) return null

      try {
        const decoded = decodeEventLog({
          abi: ASSET_MANAGER_ABI,
          data: log.data,
          topics: log.topics,
        })
        return {
          eventName: decoded.eventName,
          args: decoded.args,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash || null,
          logIndex: log.logIndex,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .filter((event) => {
      const id = event.args?.requestId
      if (targetRequest === null) return true
      const normalizedId = toBigInt(id)
      return normalizedId !== null && normalizedId > 0n && normalizedId === targetRequest
    })
    .map((event) => {
      const requestId = toBigInt(event.args?.requestId)
      if (requestId === null || requestId <= 0n) {
        return {
          ...event,
          requestId: null,
        }
      }
      return {
        ...event,
        requestId,
      }
    })
    .filter((event) => event.requestId !== null)
}

function summarizeRequest(selectedRequestId, events) {
  const obligationsByAgent = new Map()
  let totalValueUBA = 0n
  let totalFeeUBA = 0n
  let totalExecutorFee = 0n
  let firstUnderlyingBlock = null
  let lastUnderlyingBlock = null
  let lastUnderlyingTimestamp = null
  let paymentAddress = null
  let paymentReference = null
  let redeemer = null
  let executor = null
  let destinationTag = null

  for (const event of events) {
    const args = event.args || {}
    const agentVault = String(args.agentVault || '')
    const value = toBigInt(args.valueUBA) || 0n
    const fee = toBigInt(args.feeUBA) || 0n
    const executorFee = toBigInt(args.executorFeeNatWei) || 0n

    if (agentVault) {
      const existing = obligationsByAgent.get(agentVault.toLowerCase()) || {
        agentVault,
        valueUBA: 0n,
        feeUBA: 0n,
        ticketCount: 0,
        requestIds: new Set(),
      }
      existing.valueUBA += value
      existing.feeUBA += fee
      existing.ticketCount += 1
      existing.requestIds.add(String(args.requestId))
      obligationsByAgent.set(agentVault.toLowerCase(), existing)
    }

    if (value !== null) totalValueUBA += value
    if (fee !== null) totalFeeUBA += fee
    if (executorFee !== null) totalExecutorFee += executorFee
    firstUnderlyingBlock = minBigInt(
      firstUnderlyingBlock,
      toBigInt(args.firstUnderlyingBlock),
    ) ?? toBigInt(args.firstUnderlyingBlock)
    lastUnderlyingBlock = maxBigInt(
      lastUnderlyingBlock,
      toBigInt(args.lastUnderlyingBlock),
    ) ?? toBigInt(args.lastUnderlyingBlock)
    lastUnderlyingTimestamp = maxBigInt(
      lastUnderlyingTimestamp,
      toBigInt(args.lastUnderlyingTimestamp),
    ) ?? toBigInt(args.lastUnderlyingTimestamp)
    paymentAddress = paymentAddress || args.paymentAddress || null
    paymentReference = paymentReference || args.paymentReference || null
    redeemer = redeemer || args.redeemer || null
    executor = executor || args.executor || null
    if (typeof args.destinationTag !== 'undefined') {
      destinationTag = String(args.destinationTag)
    }
  }

  const obligations = [...obligationsByAgent.values()].map((obligation) => ({
    agentVault: obligation.agentVault,
    selectedValueUBA: obligation.valueUBA.toString(),
    selectedFeeUBA: obligation.feeUBA.toString(),
    ticketCount: String(obligation.ticketCount),
    requestIds: [...obligation.requestIds],
  }))

  return {
    events,
    requestId: selectedRequestId,
    redeemer,
    paymentAddress,
    paymentReference,
    executor,
    destinationTag,
    totalValueUBA: totalValueUBA.toString(),
    totalFeeUBA: totalFeeUBA.toString(),
    executorFeeNatWei: totalExecutorFee.toString(),
    obligations,
    firstUnderlyingBlock: firstUnderlyingBlock?.toString() || null,
    lastUnderlyingBlock: lastUnderlyingBlock?.toString() || null,
    lastUnderlyingTimestamp: lastUnderlyingTimestamp?.toString() || null,
  }
}

function summarizeCompletion(requestId, completionEvents) {
  const performed = completionEvents.find(
    (event) => event.eventName === 'RedemptionPerformed' && event.args?.requestId?.toString() === requestId,
  )
  const defaulted = completionEvents.find(
    (event) => event.eventName === 'RedemptionDefault' && event.args?.requestId?.toString() === requestId,
  )

  if (performed) {
    return {
      performed: true,
      defaulted: false,
      transactionHash: performed.args?.transactionHash || null,
      redemptionAmountUBA: performed.args?.redemptionAmountUBA?.toString() || null,
      redeemedVaultCollateralWei: null,
      redeemedPoolCollateralWei: null,
      blockNumber: performed.blockNumber ? performed.blockNumber.toString() : null,
    }
  }

  if (defaulted) {
    return {
      performed: false,
      defaulted: true,
      transactionHash: null,
      redemptionAmountUBA: defaulted.args?.redemptionAmountUBA?.toString() || null,
      redeemedVaultCollateralWei: defaulted.args?.redeemedVaultCollateralWei?.toString() || null,
      redeemedPoolCollateralWei: defaulted.args?.redeemedPoolCollateralWei?.toString() || null,
      blockNumber: defaulted.blockNumber ? defaulted.blockNumber.toString() : null,
    }
  }

  return {
    performed: false,
    defaulted: false,
    transactionHash: null,
    redemptionAmountUBA: null,
    redeemedVaultCollateralWei: null,
    redeemedPoolCollateralWei: null,
    blockNumber: null,
  }
}

export function summarizeRequestStatus(request, completion, nowUnixSeconds) {
  if (completion.performed) {
    return {
      code: 'COMPLETED',
      label: 'Payment observed',
      summary: 'A RedemptionPerformed event was observed for this request.',
      reasonCodes: ['PAYMENT_PERFORMED'],
    }
  }

  if (completion.defaulted) {
    return {
      code: 'DEFAULTED',
      label: 'Default executed',
      summary: 'A RedemptionDefault event was observed for this request.',
      reasonCodes: ['PAYMENT_DEFAULTED'],
    }
  }

  if (request.lastUnderlyingTimestamp === null) {
    return {
      code: 'UNKNOWN',
      label: 'Deadline unknown',
      summary: 'The request was found, but the payment deadline timestamp is not available.',
      reasonCodes: ['PAYMENT_DEADLINE_UNKNOWN'],
    }
  }

  const deadlineAssessment = summarizeDeadline(request.lastUnderlyingTimestamp, nowUnixSeconds)
  if (!deadlineAssessment.valid) {
    return {
      code: 'UNKNOWN',
      label: 'Deadline invalid',
      summary: 'The request was found, but the payment deadline timestamp could not be parsed safely.',
      reasonCodes: ['PAYMENT_DEADLINE_INVALID'],
    }
  }

  if (deadlineAssessment.passed) {
    return {
      code: 'DEADLINE_ELAPSED',
      label: 'Deadline elapsed',
      summary: 'The request deadline timestamp has passed without a RedemptionPerformed event.',
      reasonCodes: ['PAYMENT_DEADLINE_ELAPSED'],
    }
  }

  const remaining = deadlineAssessment.remainingSeconds
  return {
    code: 'DEADLINE_OPEN',
    label: 'Awaiting payment',
    summary: `Payment window is open (${remaining} seconds remaining by timestamp).`,
    reasonCodes: ['PAYMENT_DEADLINE_OPEN'],
  }
}

function toBigInt(value) {
  try {
    return value === null || value === undefined ? null : BigInt(value)
  } catch {
    return null
  }
}

function summarizeDeadline(lastUnderlyingTimestamp, nowUnixSeconds) {
  const deadline = toBigInt(lastUnderlyingTimestamp)
  const safeNow = Math.floor(nowUnixSeconds)
  const now = Number.isFinite(safeNow) ? BigInt(safeNow) : null
  if (deadline === null || now === null || deadline <= 0n) {
    return {
      valid: deadline !== null && now !== null && deadline > 0n,
      passed: deadline !== null && now !== null && deadline <= now,
      remainingSeconds: 0,
    }
  }

  if (deadline <= now) {
    return {
      valid: true,
      passed: true,
      remainingSeconds: 0,
    }
  }

  const remaining = deadline - now
  if (!Number.isSafeInteger(Number(remaining))) {
    return {
      valid: false,
      passed: false,
      remainingSeconds: 0,
    }
  }

  return {
    valid: true,
    passed: false,
    remainingSeconds: Number(remaining),
  }
}

function minBigInt(left, right) {
  if (left === null) return right
  if (right === null) return left
  return left < right ? left : right
}

function maxBigInt(left, right) {
  if (left === null) return right
  if (right === null) return left
  return left > right ? left : right
}

async function getTransactionReceiptWithLookupGuard(client, txHash) {
  try {
    return await client.getTransactionReceipt({ hash: txHash })
  } catch (error) {
    if (isTxNotFoundError(error)) {
      return null
    }
    throw error
  }
}

function isTxNotFoundError(error) {
  const message = String(
    error?.message || error?.shortMessage || error?.cause?.message || error?.cause?.shortMessage || '',
  ).toLowerCase()
  return (
    error?.name === 'TransactionReceiptNotFoundError'
    || error?.name === 'TransactionNotFoundError'
    || message.includes('not found')
    || message.includes('does not exist')
    || message.includes('unknown transaction')
    || message.includes('invalid transaction hash')
    || error?.code === 'TRANSACTION_NOT_FOUND'
    || error?.code === 3_200_000
  )
}
