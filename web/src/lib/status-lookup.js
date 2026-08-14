const MAX_REQUEST_ID = (1n << 256n) - 1n

export function normalizeTransactionLookupHash(value) {
  const text = String(value || '').trim()
  const normalized = /^0x[0-9a-fA-F]{64}$/i.test(text) ? text.toLowerCase() : ''
  return normalized && !/^0x0+$/.test(normalized) ? normalized : ''
}

export function normalizeRequestIdLookup(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^0x[0-9a-fA-F]+$/i.test(text) && !/^[0-9]+$/.test(text)) return ''
  try {
    const parsed = BigInt(text)
    if (parsed <= 0n || parsed > MAX_REQUEST_ID) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

export function parseLookupBlock(value) {
  const text = String(value || '').trim()
  if (!text) return null
  try {
    const parsed = BigInt(text)
    return parsed >= 0n ? parsed : null
  } catch {
    return null
  }
}

export function parseStatusLookupParams({
  mode,
  tx,
  requestId,
  fromBlock,
  toBlock,
}) {
  const normalizedFromBlock = String(fromBlock || '').trim()
  const normalizedToBlock = String(toBlock || '').trim()

  if (mode === 'tx') {
    const normalizedTx = normalizeTransactionLookupHash(tx)
    if (!normalizedTx) {
      return {
        error: 'INVALID_TX_HASH',
        message: 'Provide a valid 0x transaction hash when using tx lookup.',
      }
    }

    const requestIdValue = normalizeRequestIdLookup(requestId)
    const hasRequestId = String(requestId || '').trim() !== ''
    if (hasRequestId && !requestIdValue) {
      return {
        error: 'INVALID_REQUEST_ID',
        message: 'requestId must be a valid decimal or hex number when provided for tx lookup.',
      }
    }

    return {
      tx: normalizedTx,
      requestId: requestIdValue,
      fromBlock: null,
      toBlock: null,
    }
  }

  if (mode !== 'requestId') {
    return {
      error: 'INVALID_LOOKUP_MODE',
      message: 'Use tx or requestId lookup mode.',
    }
  }

  const requestIdValue = normalizeRequestIdLookup(requestId)
  if (!requestIdValue) {
    return {
      error: 'INVALID_REQUEST_ID',
      message: 'Enter a valid decimal or hex requestId when using requestId lookup.',
    }
  }

  const fromBlockValue = parseLookupBlock(normalizedFromBlock)
  if (fromBlockValue === null) {
    return {
      error: 'INVALID_FROM_BLOCK',
      message: 'fromBlock is required for requestId lookup and must be a non-negative integer.',
    }
  }

  const toBlockValue = parseLookupBlock(normalizedToBlock)
  if (normalizedToBlock !== '' && toBlockValue === null) {
    return {
      error: 'INVALID_TO_BLOCK',
      message: 'toBlock must be empty or a non-negative integer.',
    }
  }

  if (toBlockValue !== null && toBlockValue < fromBlockValue) {
    return {
      error: 'INVALID_BLOCK_RANGE',
      message: 'fromBlock must be less than or equal to toBlock.',
    }
  }

  return {
    requestId: requestIdValue,
    fromBlock: fromBlockValue,
    toBlock: toBlockValue,
    tx: null,
  }
}

export function buildStatusLookupParams({
  mode,
  tx,
  requestId,
  fromBlock,
  toBlock,
}) {
  const parsed = parseStatusLookupParams({
    mode,
    tx,
    requestId,
    fromBlock,
    toBlock,
  })
  if (parsed.error) {
    return parsed
  }

  const params = new URLSearchParams()
  if (parsed.tx) {
    params.set('tx', parsed.tx)
    if (parsed.requestId) {
      params.set('requestId', parsed.requestId)
    }
  } else {
    params.set('requestId', parsed.requestId)
    params.set('fromBlock', parsed.fromBlock.toString())
    if (parsed.toBlock !== null) {
      params.set('toBlock', parsed.toBlock.toString())
    }
  }

  return { query: params.toString() }
}
